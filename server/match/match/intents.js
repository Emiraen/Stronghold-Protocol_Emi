
import { unitStatsEntry } from "../../../shared/protocol.js";

import { PHASE, ERR, EMOTES, EMOTE_COOLDOWN_MS, GEO } from "../../../shared/constants.js";

import { deriveSeed } from "../../sim/rng.js";

import { OK, fail } from "./common.js";
import { onHumanEmote } from '../botEmotes.js';
import { cyclopsRiskAction } from '../cyclops.js';
export class MatchIntents {
  _handle(ps, msg) {
    switch (msg.t) {
      case 'g.infoReady':
        if (this.phase !== PHASE.INFO_CHECK || this.setupVote) return fail(ERR.WRONG_PHASE);
        if (msg.setupRevision != null && msg.setupRevision !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup revision changed');
        if (!ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
        return OK;
      case 'g.rerollVote': return this.voteSetupReroll(ps, msg.voteId, msg.agree);
      case 'g.band': return this.pickBand(ps, msg.bandId, msg);
      case 'g.bandSkip': return this.skipBand(ps, msg);
      // the strategy highlighted in the draft screen (what a timed-out turn takes, timeoutBand)
      case 'g.bandFocus': return this.bandFocus(ps, msg.bandId ?? null, msg);
      case 'g.buy': return ps.buy(msg.slot);
      case 'g.refresh': return ps.refresh();
      case 'g.freeze': return ps.freeze();
      case 'g.levelUp': return ps.levelUp();
      case 'g.sell': return ps.sell(msg.uid);
      // dir: the deploy wheel's facing (DESIGN §3; absent ⇒ PlayerState reads to.dir, then RIGHT)
      case 'g.move': return ps.move(msg.uid, msg.to, msg.dir);
      case 'g.equip': return ps.equip(msg.itemUid, msg.targetUid, msg.replaceUid ?? null);
      case 'g.art': return ps.useArt(msg.itemUid, msg.row, msg.col, msg.dir);
      case 'g.destroy': return ps.destroy(msg.uid);
      case 'g.reward': return ps.pickReward(msg.idx);
      case 'g.choice': return msg.choiceId !== undefined
        ? this.pickPersonalChoice(ps, msg.idx, msg.choiceId)
        : this.pickCard(ps, msg.idx, msg);
      // 独眼巨人的馈赠（entertainment_cyclops）：三槽位馈赠选择 / 单槽刷新
      case 'g.cyclopsHex': return this.cyclopsHexPick(ps, msg.slot ?? 0, msg.bondId);
      case 'g.cyclopsRisk': return cyclopsRiskAction(this, ps, msg.uid ?? null);
      case 'g.cyclopsHexReroll': return this.cyclopsHexReroll(ps, msg.slot);
      // 独眼巨人选秀（R10）：领走一组「干员+装备」
      case 'g.cyclopsDraft': return this.cyclopsDraftPick(ps, msg.idx);
      case 'g.uniteSkipVote': return this.voteSkipUnite(ps, msg);
      case 'g.ready': return ps.setReady(!!msg.ready);
      case 'g.emote': return this.emote(ps, msg.id);
      case 'g.watch': return this.watch(ps, msg.fieldId, !!msg.viewOnly);
      case 'g.autoplay': return this.setAutoplay(ps, !!msg.on);
      case 'g.pause': return this.setPause(ps, !!msg.on);
      // the stats the board's units start their next battle with (the detail card in prep, user playtest #4 item 7)
      case 'g.unitStats': return this.unitStats(ps, msg.seq ?? null);
      case 'g.leave': this.onLeave(ps.playerId); return OK;
      case 'b.progress': return this._onProgress(ps, msg);
      case 'b.result': return this._onResult(ps, msg);
      case 'b.yield': return this._onYield(ps, msg);
      default: return fail(ERR.BAD_MSG);
    }
  }

  emote(ps, id) {
    if (!EMOTES.includes(id)) return fail(ERR.BAD_MSG, 'unknown emote');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.emote', playerId: ps.playerId, id });
    onHumanEmote(this, ps.playerId, id);
    return OK;
  }

  setAutoplay(ps, on) {
    if (ps.autoplay === on) return OK;
    if (!on) { ps._botWorker?.cancel(); ps._botWorker = null; }
    ps.autoplay = on;
    this.refreshUniteSkipVote();
    this.markPublic();
    if (on) this.kickBot(ps);
    return OK;
  }

  unitStats(ps, seq = null) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.ROUND_START && this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const units = this._unitStatsOf(ps);
    this.sendTo(ps.playerId, { t: 'm.unitStats', seq: Number.isInteger(seq) ? seq : null, round: this.round, units });
    return OK;
  }

  _unitStatsOf(ps) {
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    const ev = { input, kind: 'normal', round: this.round, preview: true };
    this.dispatch(ps, 'onBattleStart', ev);
    const players = [ev.input && typeof ev.input === 'object' ? ev.input : input];
    let key = null;
    try { key = JSON.stringify([this.round, this.stageId, this.battleContent, players]); } catch { key = null; }
    if (!this._unitStatsCache) this._unitStatsCache = new WeakMap(); // PlayerState → { key, units } (the last preview)
    const cached = this._unitStatsCache.get(ps);
    if (key && cached && cached.key === key) return cached.units;
    const units = [];
    // the flags of the battle it previews: a normal round gains IN_BATTLE layers from its start (a <战斗开始时> layer gain
    // raises bond stats at t = 0 there too); the Final Assault / Hidden Core fight without (previewed as a normal field)
    const bossRound = this.isBossRound(this.round) || this.round === this.gd.hiddenRound;
    const b = this.newBattle({
      seed: deriveSeed(this.seed, `preview:${this.round}:${ps.seat}`), kind: 'normal', modeId: this.modeId, round: this.round,
      stageId: this.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players, spawns: [], routes: this.wave ? this.wave.routes : [],
      sharedBoss: null, flags: { layerGainsEnabled: !bossRound, uncappedBondLayers: this.isEndless, uncappedNumericValues: this.isEndless, ...this.gd.dp }, fieldId: `n:${ps.playerId}`, recordEvents: false,
    });
    try {
      if (typeof b.start === 'function') b.start();
      for (const u of Array.isArray(b.allyUnits) ? b.allyUnits : []) {
        if (u && Number.isInteger(u.uid) && (u.kind === 'op' || u.kind === 'token')) units.push(unitStatsEntry(u, u.s));
      }
    } catch (e) { this.reportError('unitStats', e); }
    this._unitStatsCache.set(ps, { key, units });
    return units;
  }

  kickBot(ps) {
    if (!ps.botControlled || this.ended) return;
    if (this.phase === PHASE.INFO_CHECK && !ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
    else if (this.phase === PHASE.BAND_DRAFT && this.draftTurn(ps.playerId) === ps.playerId) this.scheduleBandBot(this.draftGroup(ps.playerId));
    else if (this.phase === PHASE.SP_DRAFT && this.spTurn(ps.playerId) === ps.playerId) this.scheduleSpBot(this.spGroup(ps.playerId));
    else if (this.phase === PHASE.PREP && ps.alive && !ps.ready) this.scheduleBotPrep(ps, 0);
  }
}
