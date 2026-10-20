

import { PHASE, GEO } from "../../../shared/constants.js";

import { boardOrder, pieceDir } from "../board.js";
import { bondList, offBondCounts } from "../bondsMeta.js";

import { cardView } from "../choices.js";
import { bountySpawns, previewOf } from "../waves.js";

import { timelineAt } from "../fields.js";
import { battleProgress, uniteLeft } from "../../sim/spec.js";
import { createRng, deriveSeed } from "../../sim/rng.js";

/** Choose once from the match seed, independently of all gameplay random streams. */
export function battleBgmFor(stageId, seed) {
  const tracks = stageId === 'act2autochess_m01' ? ['siracusa_bgm1']
    : stageId === 'act2autochess_m03' ? ['kashimir_bgm1', 'kashimir_bgm2']
      : /^(?:act1autochess_m0[1-7]|act2autochess_m0[24])$/.test(stageId || '') ? ['sand_bgm1', 'sand_bgm2'] : [];
  return tracks.length ? createRng(deriveSeed(seed, 'map-bgm')).pick(tracks) : null;
}

export class MatchViews {
  statusOf(ps) {
    if (ps.left) return 'left';
    if (!ps.alive) return 'dead';
    switch (this.phase) {
      case PHASE.INFO_CHECK: return ps.infoReady ? 'ready' : 'deciding';
      case PHASE.BAND_DRAFT:
        if (this.draft && this.draft.picks[ps.playerId]) return 'ready';
        return this.draft && this.draftTurn(ps.playerId) === ps.playerId ? 'deciding' : 'acting';
      case PHASE.SP_DRAFT:
        if (this.sp && this.sp.picks[ps.playerId] != null) return 'ready';
        return this.sp && this.spTurn(ps.playerId) === ps.playerId ? 'deciding' : 'acting';
      case PHASE.CYCLOPS_HEX: {
        const st = this.cyclops && this.cyclops.state ? this.cyclops.state.get(ps.playerId) : null;
        return st && st.picked != null ? 'ready' : 'deciding';
      }
      case PHASE.CYCLOPS_DRAFT:
        return this.cyclops && this.cyclops.order[this.cyclops.idx] === ps.playerId ? 'deciding' : 'acting';
      case PHASE.PREP: return ps.ready ? 'ready' : 'acting';
      case PHASE.COMBAT: case PHASE.FINAL_ASSAULT: case PHASE.HIDDEN_CORE: {
        const f = this.fields.find((x) => x.players.includes(ps.playerId));
        return f && f.live ? 'combat' : 'done';
      }
      case PHASE.UNITE: return this.unitePlan && this.unitePlan.helpers.includes(ps) ? 'helping' : 'done';
      case PHASE.ROUND_START: return 'acting';
      default: return 'done';
    }
  }

  fieldOf(ps) {
    const f = this.fields.find((x) => x.players.includes(ps.playerId));
    return f ? f.fieldId : null;
  }

  publicView() {
    const v = {
      t: 'm.public',
      phase: this.phase,
      round: this.round,
      lastRound: this.gd.lastRound,
      deadline: this.deadline,
      serverNow: this.sched.now(),
      modeId: this.modeId,
      mode: this.mode,
      variant: this.variant,
      ...(this.isEntertainmentMulti ? { poolGroups: this.poolGroups.map((g) => ({ id: g.id, playerIds: g.playerIds.slice(), size: g.playerIds.length })) } : {}),
      difficulty: this.difficulty,
      ranked: this.ranked,
      stageId: this.stageId,
      battleBgm: battleBgmFor(this.stageId, this.seed),
      setupRevision: this.setupRevision,
      rerollVote: !this.ranked && this.setupVote ? { id: this.setupVote.id, proposerId: this.setupVote.proposerId, voters: this.setupVote.voters.slice(), agreed: [...this.setupVote.agreed] } : null,
      factions: this.factions.slice(),
      disabledBonds: [...new Set([...this.disabledBonds, ...this.staticInactiveBonds])].sort(),
      drawnDisabledBonds: this.disabledBonds.slice(),
      bannedChess: this.bannedChess.slice(),
      bossId: this.endlessBossPlan?.(this.round)?.bossId || this.bossId,
      hiddenBossId: this.hiddenBossId,
      bossRound: this.gd.bossRound,
      hiddenRound: this.gd.hiddenRound,
      spRound: this.gd.spRounds().includes(this.round),
      // DESIGN §14: 'client' = battles are simulated by the browsers (b.start specs), 'server' = legacy streaming
      combatMode: this.clientCombat ? 'client' : 'server',
      // solo pause (g.pause, DESIGN §14): the battle, its field clock and every deadline are frozen while true
      paused: !!this.paused,
      players: this.order.map((ps) => ({
        playerId: ps.playerId,
        seat: ps.seat,
        ...(this.isEntertainmentMulti ? { poolGroupId: ps.poolGroupId } : {}),
        name: ps.name,
        isBot: ps.isBot,
        ...(this.rankSnapshots.has(ps.playerId) ? { rank: { ...this.rankSnapshots.get(ps.playerId) } } : {}),
        connected: ps.isBot || (ps.connected && !ps.left),
        alive: ps.alive,
        lp: Math.max(0, ps.lp),
        bandId: ps.bandId,
        shopLevel: ps.shop.level,
        boardCount: ps.deployCount,
        ready: this.phase === PHASE.INFO_CHECK ? ps.infoReady : ps.ready,
        // the strip of a teammate watching this player (DESIGN §20.15): every bond with members, layers or an active tier
        // (= the player's own m.private list without thresholds / countsHand — the client reads those from bonds.json),
        // this round's in-battle gains included once the COMBAT phase ended (PlayerState.bondsView); [] once eliminated —
        // nobody can watch an eliminated player (g.watch refuses them, they have no field) and the result screen reads
        // m.result's own bonds, so their layers would only cost every m.public bytes for the rest of the match
        // (the mode-off bonds with members included, `off: true`, as in m.private — bondsMeta.offBondCounts)
        bonds: ps.alive ? bondList(this.gd, ps.bondsView(), { off: offBondCounts(ps.gd || this.gd, ps) }) : [],
        fieldId: this.fieldOf(ps),
        status: this.statusOf(ps),
        autoplay: ps.autoplay,
        // the LP this round's own battle will cost at settlement so far (COMBAT / 联防 only, omitted when 0)
        ...this._pendingLpView(ps),
      })),
      fields: this.fields.map((f) => {
        const v = { fieldId: f.fieldId, kind: f.kind, players: f.players.slice(), live: !!f.live };
        const pr = this._fieldProgress(f);
        if (pr) v.progress = pr;
        return v;
      }),
    };
    if (this.teamLp != null) v.teamLp = Math.max(0, Math.round(this.teamLp));
    // 最终攻势 / 隐秘核心: when the overtime drain starts (ms epoch; `deadline` is the level's 120 s countdown)
    if ((this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) && this.overtimeAt) v.overtimeAt = this.overtimeAt;
    if (this.bossPool) v.bossHp = { hp: Math.max(0, Math.round(this.bossPool.hp)), max: Math.round(this.bossPool.maxHp) };
    if (this.phase === PHASE.BAND_DRAFT && this.draft) {
      const d = this.draft;
      // turnSeconds: the length of a turn (the countdown gauge's total; 0 when untimed) — deadline = turnDeadline
      v.draft = this.isEntertainmentMulti ? this._groupDraftView(d, 'band') : {
        order: d.order.slice(), turn: this.draftTurn(), picks: { ...d.picks }, skipsLeft: { ...d.skipsLeft }, turnDeadline: d.turnDeadline || 0,
        turnSeconds: d.untimed ? 0 : this.bandTurnMs() / 1000, untimed: !!d.untimed,
      };
    }
    if (this.phase === PHASE.SP_DRAFT && this.sp) {
      const s = this.sp;
      v.sp = this.isEntertainmentMulti ? this._groupDraftView(s, 'sp') : {
        family: s.family, name: s.name, desc: s.desc, eventId: s.eventId, cards: s.cards.map((c) => ({ ...cardView(c), soldOut: c.kind === 'item' && !this.itemPool.canGain(c.id) })), order: s.order.slice(),
        turn: this.spTurn(), picks: { ...s.picks }, taken: { ...s.taken }, untimed: !!s.untimed,
      };
    }
    if (this.phase === PHASE.UNITE && this.unitePlan) {
      const p = this.unitePlan;
      v.unite = { helpers: p.helpers.map((p) => p.playerId), leakers: p.leakers.map((p) => p.playerId),
        ...(this.isEntertainmentMulti ? { round: p.round, roundsMax: p.roundsMax,
          usedHelpers: p.usedHelpers.map((p) => p.playerId), reserveHelpers: p.reserveHelpers.filter((p) => p.alive && !p.left).map((p) => p.playerId),
          skipVote: this.uniteSkipVoteView() } : {}) };
    }
    if (this.isEntertainmentMulti && this.phase === PHASE.SETTLE && this.uniteResultView) v.uniteResult = this.uniteResultView;
    // 独眼巨人的馈赠：公开视图只带每人的完成状态；3 槽详情走 m.private（每人自己的）
    if (this.isCyclops && this.phase === PHASE.CYCLOPS_HEX && this.cyclops) {
      const c = this.cyclops;
      const state = {};
      for (const [pid, st] of c.state) state[pid] = { picked: st.picked, done: st.picked != null };
      v.cyclops = { round: c.round, quality: c.quality, deadline: c.deadline, turnSeconds: c.turnSeconds, state };
    }
    // 独眼巨人选秀：公开视图带顺序与占用；10 项详情走 m.private
    if (this.isCyclops && this.phase === PHASE.CYCLOPS_DRAFT && this.cyclops) {
      const c = this.cyclops;
      v.cyclops = {
        kind: 'draft', round: c.round, deadline: c.deadline, turnSeconds: c.turnSeconds,
        order: c.order.slice(), idx: c.idx, turn: c.order[c.idx] ?? null,
        taken: { ...c.taken },
      };
    }
    return v;
  }

  _groupDraftView(stage, kind) {
    const groups = stage.groups.map((g) => ({
      id: g.id, groupId: g.id, playerIds: g.playerIds.slice(), order: g.order.slice(),
      turn: g.done ? null : g.order[g.idx] ?? null, picks: { ...g.picks }, done: g.done,
      untimed: g.untimed, turnDeadline: g.turnDeadline, turnSeconds: g.turnSeconds,
      ...(kind === 'band' ? { skipsLeft: { ...g.skipsLeft } } : {
        family: g.family, name: g.name, desc: g.desc, eventId: g.eventId,
        cards: (g.cards || []).map((c) => ({ ...cardView(c), soldOut: c.kind === 'item' && !this.itemPool.canGain(c.id) })), taken: { ...g.taken },
      }),
    }));
    return { ...groups[0], id: stage.id, draftId: stage.id, groups, picks: { ...stage.picks } };
  }

  nextEnemiesFor(ps) {
    if (!ps.alive) return [];
    if (this.bossWaves) {
      const g = this.bossGroupOf(ps);
      if (!g) return [];
      return previewOf([...g.wave.spawns, ...bountySpawns(this.gd, this.round, g.wave, ps.bounties, ps.playerId, { solo: this.isSolo, side: g.side })]);
    }
    if (!this.wave) return [];
    const bounty = bountySpawns(this.gd, this.round, this.wave, ps.bounties, ps.playerId, { solo: this.isSolo });
    return previewOf([...this.wave.spawns, ...bounty]);
  }

  prepFieldMeta(ps) {
    const units = [];
    const gd = ps.gd || this.gd;
    for (const { r, c, piece } of boardOrder(ps.board)) {
      const rec = piece.kind === 'token' ? gd.token(piece.id) : ps.fieldRecord(gd.chess(piece.id));
      const assets = (rec && rec.assets) || {};
      // DESIGN §16: the skill / module THIS player's operator fights with (the scout's detail card shows it, like the
      // sim's UnitInfo in a shared field); moduleId only for an elite
      const lo = piece.kind === 'chess' && rec ? ps.loadoutFor(rec) : null;
      units.push({
        id: piece.uid, uid: piece.uid, kind: piece.kind === 'token' ? 'token' : 'op', side: 'ally', ownerId: ps.playerId, defId: piece.id,
        standInFor: rec?.standInFor,
        diy: ps.diyPickOf(piece.id) || undefined,
        name: rec ? rec.name : piece.id, tier: rec && Number.isInteger(rec.tier) ? rec.tier : 1, golden: !!(rec && rec.isGolden),
        spine: assets.spine || (rec && rec.charId) || piece.id, avatar: assets.avatar || (rec && rec.charId) || piece.id,
        x: c, y: r, dir: pieceDir(piece), facing: pieceDir(piece) === 'LEFT' ? -1 : 1, maxHp: rec && rec.stats && Number.isFinite(rec.stats.maxHp) ? rec.stats.maxHp : 1,
        skin: piece.kind === 'chess' ? ps.skinFor(piece.id) : null,
        skillIndex: lo && Number.isInteger(lo.skillIndex) ? lo.skillIndex : undefined,
        moduleId: lo && typeof lo.moduleId === 'string' ? lo.moduleId : undefined,
        // the equipped items (like the sim's UnitInfo): a 变形同构体 wearer shows as a member of the bond it grants
        items: piece.kind === 'chess' && Array.isArray(piece.items) && piece.items.length ? piece.items.map((it) => it.id) : undefined,
      });
    }
    // `nextEnemies`: the scouted player's coming enemies — their preview pen shows on the scouting board too (research 09
    // §2.2 "Teammates"; render/app.js enterBattle({ prep: true, nextEnemies }))
    let nextEnemies = [];
    try { nextEnemies = this.nextEnemiesFor(ps); } catch (e) { this.reportError('nextEnemies', e); }
    return { t: 'm.field', fieldId: `n:${ps.playerId}`, kind: 'normal', rect: { ...GEO.NORMAL_RECT }, stageId: this.stageId, units, prep: true, nextEnemies };
  }

  _fieldProgress(f) {
    if (!f) return null;
    if (!f.cc) {
      const b = f.battle;
      if (!b) return null;
      return { killed: Number(b.killed) || 0, total: Number(b.total) || 0, done: !f.live };
    }
    if (f.done && f.result) {
      let killed = 0, total = 0;
      for (const pp of Object.values(f.result.perPlayer || {})) { killed += Number(pp && pp.killed) || 0; total += Number(pp && pp.total) || 0; }
      if (f.result.synthetic) { killed = f.progress.killed; total = f.progress.total; }
      return { killed, total, done: true };
    }
    if (f.mode === 'server' && f.timeline) {
      const [, killed, total] = timelineAt(f.timeline, this._fieldElapsed(f));
      return { killed, total, done: false };
    }
    return { killed: f.progress.killed, total: f.progress.total, done: false };
  }

  _pendingLpView(ps) {
    if (!ps || !ps.alive || (this.phase !== PHASE.COMBAT && this.phase !== PHASE.UNITE)) return {};
    const counted = (r) => (r && Array.isArray(r.leaked) ? r.leaked.filter((l) => l && l.counted !== false).length : 0);
    // 联防: a leaker's enemies still standing on the 联防 field (uncapped), the loss capped like settle()
    const left = this._uniteLeft(ps);
    if (left != null) {
      const loss = Math.min(this.gd.lpCapPerRound, left);
      return loss > 0 ? { uniteLeft: left, pendingLp: loss } : { uniteLeft: left };
    }
    let n = 0;
    if (this.lastResults.has(ps.playerId)) n = counted(this.lastResults.get(ps.playerId));
    else if (this.phase === PHASE.COMBAT) {
      const f = this.fields.find((x) => x && x.kind === 'normal' && Array.isArray(x.players) && x.players.includes(ps.playerId));
      if (f && f.cc) n = f.done && f.result ? counted(f.result.perPlayer && f.result.perPlayer[ps.playerId]) : Number(f.progress && f.progress.leaks) || 0;
      else if (f && f.battle) { try { n = battleProgress(f.battle).leaks; } catch { n = 0; } }
    }
    const loss = Math.min(this.gd.lpCapPerRound, Math.max(0, Math.trunc(Number(n) || 0)));
    return loss > 0 ? { pendingLp: loss } : {};
  }
}
