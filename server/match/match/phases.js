

import { PHASE, ERR, CYCLOPS_HEX_ROUNDS, CYCLOPS_HEX_QUALITIES } from "../../../shared/constants.js";

import { buildNormalWave, buildBossWave } from "../waves.js";
import { buildCyclopsBonusWave, isCyclopsBonusRound, isCyclopsHexRound, isCyclopsDraftRound, rollCyclopsHexSlots, cyclopsHexAvailable, cyclopsHexes, cyclopsHexCard, applyCyclopsHex, rollCyclopsDraftPool, cyclopsDraftOrder } from "../cyclops.js";

import { pairPlayers } from "../finalAssault.js";

import { botPickBand, botPickCard } from "../bot.js";
import { generateDraft, applyCard } from '../choices.js';
import { onPickCard, resetRoundCounters } from '../botEmotes.js';
import { OK, fail, DELAYS, BAND_TURN_SECONDS } from "./common.js";
export class MatchPhases {
  humansFirst(order) {
    if (!this.aiPicksLast) return order;
    const bot = id => !!this.players.get(id)?.isBot;
    return [...order.filter(id => !bot(id)), ...order.filter(bot)];
  }

  draftGroup(playerId = null, stage = this.draft) {
    return playerId == null ? stage?.groups?.[0] : stage?.groups?.find((g) => g.playerIds.includes(playerId));
  }

  spGroup(playerId = null) { return this.draftGroup(playerId, this.sp); }

  draftTargetError(stage, group, { draftId, groupId } = {}) {
    if (draftId != null && draftId !== stage.id) return fail(ERR.WRONG_PHASE);
    if (!group || (groupId != null && groupId !== group.id)) return fail(ERR.BAD_TARGET);
    return null;
  }

  _enterGroupDraft(kind) {
    const band = kind === 'band';
    const groups = this.poolGroups.map(({ id, playerIds }) => {
      const order = playerIds.filter((pid) => { const p = this.players.get(pid); return p.alive && !p.left; });
      this.rngDraft.shuffle(order);
      order.splice(0, order.length, ...this.humansFirst(order));
      const cards = band ? {} : generateDraft(this.gd, this.rngDraft, this.round, {
        stageId: this.stageId, bondAvailable: (id) => this.bondLive(id), itemAvailable: (id) => this.itemPool.canGain(id),
      });
      return { ...cards, id, playerIds: playerIds.slice(), order, idx: 0, picks: {}, taken: {},
        skipsLeft: Object.fromEntries(order.map((pid) => [pid, this.gd.bandDraft.skipsPerPlayer])),
        untimed: this.soloUntimed, turnDeadline: 0, turnSeconds: 0, timer: null, token: 0,
        done: !order.length || (!band && !cards) };
    });
    if (!band && groups.every((g) => g.done)) { this.enterPrep(); return; }
    const stage = { id: `${kind}:${this.battlePrefix}:${this.round}:${++this.draftSeq}`, groups, picks: {}, focus: new Map() };
    if (band) this.draft = stage; else this.sp = stage;
    this.phase = band ? PHASE.BAND_DRAFT : PHASE.SP_DRAFT;
    this.setDeadline(0);
    for (const g of groups) this._startGroupTurn(kind, g);
    this.markPublic();
  }

  _clearGroupTurn(g) {
    this.cancel(g.timer);
    g.timer = null;
    g.turnDeadline = 0;
    g.turnSeconds = 0;
    g.token++;
  }

  _startGroupTurn(kind, g) {
    const band = kind === 'band';
    const stage = band ? this.draft : this.sp;
    const phase = band ? PHASE.BAND_DRAFT : PHASE.SP_DRAFT;
    if (!stage || !g || this.phase !== phase) return;
    this._clearGroupTurn(g);
    while (g.idx < g.order.length) {
      const ps = this.players.get(g.order[g.idx]);
      if (ps?.alive && !ps.left && stage.picks[ps.playerId] == null) break;
      g.idx++;
    }
    const available = () => (g.cards || []).filter((c) => this.spCardAvailable(c, g)).map((c) => c.idx);
    g.done = g.idx >= g.order.length || (!band && !available().length);
    if (!g.done) {
      const token = g.token;
      const ps = this.players.get(g.order[g.idx]);
      const current = () => this.phase === phase && (band ? this.draft : this.sp) === stage && token === g.token;
      const auto = (bot) => {
        if (!current()) return;
        if (band) {
          const id = bot ? botPickBand(this, ps) : this.timeoutBand(ps.playerId);
          this._applyBand(ps, id, { dedupe: true });
        } else {
          const avail = available();
          if (avail.length) this._applyCard(ps, bot ? botPickCard(this, ps, g.cards, avail) : avail[Math.floor(this.rngDraft() * avail.length)]);
          else this._startGroupTurn('sp', g);
        }
      };
      if (!g.untimed) {
        const ms = band ? this.bandTurnMs() : this.scaled(this.gd.timer(g.idx === 0 ? 'spFirst' : 'spTurn') * 1000);
        g.turnSeconds = ms / 1000;
        g.turnDeadline = this.sched.now() + ms;
        g.timer = this.later(ms, () => auto(false));
      }
      if (ps.botControlled) this.later(band ? 0 : this.scaled(DELAYS.BOT_ACTION), () => { if (ps.botControlled) auto(true); });
    }
    this.deadline = stage.groups.length === 1 ? g.turnDeadline : 0;
    this.markPublic();
    if (stage.groups.every((x) => x.done) && !stage.finishPending) {
      stage.finishPending = true;
      this.later(0, () => {
        if (this.phase !== phase || (band ? this.draft : this.sp) !== stage) return;
        if (band) this.finishBandDraft(false); else this.finishSpDraft();
      });
    }
  }

  _groupBandIntent(ps, action, bandId, opts = {}) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft, g = this.draftGroup(ps.playerId);
    const error = this.draftTargetError(d, g, opts);
    if (error) return error;
    if (!ps.alive || ps.left) return fail(ERR.ELIMINATED);
    if (d.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (action === 'focus') {
      if (bandId == null) { d.focus.delete(ps.playerId); return OK; }
      if (!this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
      d.focus.set(ps.playerId, bandId);
      return OK;
    }
    if (g.done || g.order[g.idx] !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (action === 'skip') {
      if (!(g.skipsLeft[ps.playerId] > 0)) return fail(ERR.ALREADY);
      if (g.order.length - g.idx <= 1) return fail(ERR.BAD_TARGET);
      g.skipsLeft[ps.playerId]--;
      g.order.splice(g.idx, 1);
      g.order.push(ps.playerId);
      this._startGroupTurn('band', g);
    } else {
      if (!this.gd.bandAllowed(bandId) || this.bandTaken(bandId, ps.playerId)) return fail(ERR.BAD_TARGET);
      this._applyBand(ps, bandId);
    }
    return OK;
  }

  _groupPickCard(ps, idx, opts = {}) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    const s = this.sp, g = this.spGroup(ps.playerId);
    const error = this.draftTargetError(s, g, opts);
    if (error) return error;
    if (!ps.alive || ps.left) return fail(ERR.ELIMINATED);
    if (s.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (g.done || g.order[g.idx] !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || !g.cards[idx]) return fail(ERR.BAD_TARGET);
    if (!this.spCardAvailable(g.cards[idx], g)) return fail(ERR.SOLD_OUT);
    this._applyGroupCard(ps, idx);
    return OK;
  }

  _applyGroupCard(ps, idx) {
    const s = this.sp, g = this.spGroup(ps.playerId);
    if (!g || !ps.alive || ps.left || s.picks[ps.playerId] != null || !this.spCardAvailable(g.cards[idx], g)) return;
    s.picks[ps.playerId] = g.picks[ps.playerId] = idx;
    g.taken[idx] = ps.playerId;
    try { applyCard(this, ps, g.cards[idx]); } catch (e) { this.reportError(`applyCard ${g.cards[idx].id}`, e); }
    this.markPrivate(ps);
    this.markPublic();
    onPickCard(this, ps, g.cards[idx]);
    this._startGroupTurn('sp', g);
    for (const other of s.groups) {
      if (other !== g && !other.done && !other.cards.some((c) => this.spCardAvailable(c, other))) this._startGroupTurn('sp', other);
    }
  }

  enterInfoCheck() {
    this.phase = PHASE.INFO_CHECK;
    for (const ps of this.order) if (ps.botControlled) ps.infoReady = true;
    // solo: no time limit (the player confirms); co-op: the official 25 s guard
    this.setDeadline(this.soloUntimed ? 0 : this.gd.timer('infoCheck'), () => this.enterBandDraft());
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
    this.maybeEndInfo();
  }

  maybeEndInfo() {
    if (this.phase !== PHASE.INFO_CHECK || this.setupVote || this._infoAdvanceTimer) return;
    if (this.order.every((p) => p.isBot || p.left || p.infoReady)) {
      this.setDeadline(0);
      this._infoAdvanceTimer = this.later(0, () => { this._infoAdvanceTimer = null; if (this.phase === PHASE.INFO_CHECK && !this.setupVote) this.enterBandDraft(); });
    }
  }

  enterBandDraft() {
    if (this.phase !== PHASE.INFO_CHECK || this.setupVote) return;
    if (this.isEntertainmentMulti) return this._enterGroupDraft('band');
    this.phase = PHASE.BAND_DRAFT;
    const order = this.order.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    order.splice(0, order.length, ...this.humansFirst(order));
    const skips = this.isSolo ? 0 : this.gd.bandDraft.skipsPerPlayer;
    const untimed = this.soloUntimed;
    this.draft = {
      order, idx: 0, picks: {}, skipsLeft: Object.fromEntries(order.map((pid) => [pid, skips])), untimed, turnDeadline: 0,
      /** playerId → the strategy highlighted in the draft screen (g.bandFocus) */
      focus: new Map(),
    };
    this.setDeadline(0);
    this.startDraftTurn();
    this.markPublic();
  }

  draftTurn(playerId = null) {
    if (this.isEntertainmentMulti) { const g = this.draftGroup(playerId); return g && !g.done ? g.order[g.idx] ?? null : null; }
    const d = this.draft;
    if (!d) return null;
    return d.order[d.idx] ?? null;
  }

  bandTurnMs() { return this.scaled(BAND_TURN_SECONDS * 1000); }

  startDraftTurn(group = this.draftGroup()) {
    if (this.isEntertainmentMulti) return this._startGroupTurn('band', group);
    const d = this.draft;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    while (d.idx < d.order.length && d.picks[d.order[d.idx]]) d.idx++;
    if (d.idx >= d.order.length) {
      d.turnDeadline = 0;
      this.deadline = 0;
      this.later(0, () => this.finishBandDraft(false));
      return;
    }
    const token = ++this._turnToken;
    if (!d.untimed) {
      const ms = this.bandTurnMs();
      d.turnDeadline = this.sched.now() + ms;
      // the step's countdown IS the turn's (one number everywhere)
      this.deadline = d.turnDeadline;
      this._turnTimer = this.later(ms, () => {
        if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
        const pid = this.draftTurn();
        if (pid) this._applyBand(this.players.get(pid), this.timeoutBand(pid));
      });
    } else {
      d.turnDeadline = 0;
      this.deadline = 0;
    }
    const cur = this.players.get(this.draftTurn());
    if (cur && cur.botControlled) this.scheduleBandBot();
    this.markPublic();
  }

  scheduleBandBot(group = this.draftGroup()) {
    if (this.isEntertainmentMulti) return this._startGroupTurn('band', group);
    const token = this._turnToken;
    this.later(0, () => {
      if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
      const ps = this.players.get(this.draftTurn());
      if (!ps || !ps.botControlled) return;
      // a strategy a teammate already took is not selectable (队友已选): the bot re-draws, else the first free one
      let id = botPickBand(this, ps);
      for (let k = 0; k < 8 && this.bandTaken(id, ps.playerId); k++) id = botPickBand(this, ps);
      if (this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
      this._applyBand(ps, id, { dedupe: true });
    });
  }

  bandTaken(bandId, playerId) {
    const picks = (this.isEntertainmentMulti ? this.draftGroup(playerId)?.picks : this.draft?.picks) || {};
    for (const [pid, id] of Object.entries(picks)) if (pid !== playerId && id === bandId) return true;
    return false;
  }

  defaultBand(playerId) {
    const def = this.gd.bandDraft.timeoutBandId;
    if (!this.bandTaken(def, playerId)) return def;
    return this.gd.bandIds().find((b) => !this.bandTaken(b, playerId)) || def;
  }

  timeoutBand(playerId) {
    const f = this.draft && this.draft.focus instanceof Map ? this.draft.focus.get(playerId) : null;
    if (typeof f === 'string' && this.gd.bandAllowed(f) && !this.bandTaken(f, playerId)) return f;
    return this.defaultBand(playerId);
  }

  bandFocus(ps, bandId, opts = {}) {
    if (this.isEntertainmentMulti) return this._groupBandIntent(ps, 'focus', bandId, opts);
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (!(d.focus instanceof Map)) d.focus = new Map();
    if (bandId == null) { d.focus.delete(ps.playerId); return OK; }
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    d.focus.set(ps.playerId, bandId);
    return OK;
  }

  pickBand(ps, bandId, opts = {}) {
    if (this.isEntertainmentMulti) return this._groupBandIntent(ps, 'pick', bandId, opts);
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    if (this.draft.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    if (this.bandTaken(bandId, ps.playerId)) return fail(ERR.BAD_TARGET, '队友已选');
    this._applyBand(ps, bandId);
    return OK;
  }

  _applyBand(ps, bandId, { dedupe = false } = {}) {
    const d = this.draft;
    if (!d || !ps || d.picks[ps.playerId]) return;
    let id = this.gd.bandAllowed(bandId) ? bandId : this.defaultBand(ps.playerId);
    if (dedupe && this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
    d.picks[ps.playerId] = id;
    if (this.isEntertainmentMulti) this.draftGroup(ps.playerId).picks[ps.playerId] = id;
    ps.bandId = id;
    // 独眼巨人冲锋：20 回合长线 + 奖励关无联防，每人 LP +10
    ps.lp = this.gd.startLp(id) + (this.isCyclops ? 10 : 0);
    this.markPrivate(ps);
    this.markPublic();
    this.startDraftTurn(this.draftGroup(ps.playerId));
  }

  skipBand(ps, opts = {}) {
    if (this.isEntertainmentMulti) return this._groupBandIntent(ps, 'skip', null, opts);
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (this.isSolo) return fail(ERR.WRONG_PHASE, 'no skip in solo');
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!(d.skipsLeft[ps.playerId] > 0)) return fail(ERR.ALREADY, 'no skip left');
    if (d.order.length - d.idx <= 1) return fail(ERR.BAD_TARGET, 'nobody to pass to');
    d.skipsLeft[ps.playerId]--;
    d.order.splice(d.idx, 1);
    d.order.push(ps.playerId);
    this.startDraftTurn();
    return OK;
  }

  finishBandDraft(timeout) {
    if (this.phase !== PHASE.BAND_DRAFT) return;
    if (this.isEntertainmentMulti) for (const g of this.draft.groups) this._clearGroupTurn(g);
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    for (const ps of this.order) {
      if (this.isEntertainmentMulti && (!ps.alive || ps.left)) continue;
      if (!this.draft.picks[ps.playerId]) {
        // one after another in seat order, so each default sees the ones assigned before it (no duplicates)
        const id = this.defaultBand(ps.playerId);
        this.draft.picks[ps.playerId] = id;
        if (this.isEntertainmentMulti) this.draftGroup(ps.playerId).picks[ps.playerId] = id;
        ps.bandId = id;
        // 独眼巨人冲锋：每人 LP +10
        ps.lp = this.gd.startLp(id) + (this.isCyclops ? 10 : 0);
      }
      this.markPrivate(ps);
    }
    void timeout;
    this.enterBattleCheck();
  }

  enterBattleCheck() {
    this.phase = PHASE.BATTLE_CHECK;
    this.setDeadline(this.gd.timer('battleCheck'), () => this.startRound(1), { silent: this.soloUntimed });
    this.markPublic();
  }

  startRound(r) {
    this.phase = PHASE.ROUND_START;
    this.round = r;
    resetRoundCounters(this);
    this.fields = [];
    this.watchers.clear();
    this.unitePlan = null;
    this.uniteResultView = null;
    this.sp = null;
    this.cyclops = null;
    this.wave = null;
    this.bossWaves = null;
    const alive = this.alivePlayers();
    // the round's enemies (shared composition, generated now so the prep preview is exact). Planned BEFORE the players'
    // round start: its recompute() checks the board on the field the player deploys on this round (deployFieldOf reads
    // the boss pairing), so R14 → R15 never re-checks a boss-field board against the normal field (user playtest #5
    // item 7). rngWaves is used only here, so the order leaves every random stream unchanged.
    // 独眼巨人冲锋：R21 为 boss 战（最终攻势，无隐藏核心）；奖励关（4/8/12/16）为猎狗波次
    const isBoss = this.isCyclops ? r === this.gd.bossRound : (this.isBossRound(r) || r === this.gd.hiddenRound);
    if (this.isCyclops && isCyclopsBonusRound(r)) {
      // 独眼巨人冲锋奖励关：10 只普通猎狗
      this.wave = buildCyclopsBonusWave(this.gd, r);
    } else if (isBoss) {
      this._planBossWaves();
    } else {
      this.wave = buildNormalWave(this.gd, this.rngWaves, this.factions, r);
    }
    // A player's partially applied income/shop refresh cannot be retried. Do not let it suppress the other
    // players' round hooks, and do not run that player's dependent hooks on an incomplete round start.
    const started = [];
    for (const ps of alive) {
      try { ps.startRound(r); started.push(ps); }
      catch (e) { this.reportError(`startRound R${r} player ${ps.playerId}`, e); }
    }
    const dispatched = [];
    for (const ps of started) {
      try { this.dispatch(ps, 'onRoundStart', { round: r }); dispatched.push(ps); }
      catch (e) { this.reportError(`onRoundStart R${r} player ${ps.playerId}`, e); }
    }
    // an eliminated player's pending 信标 gift still goes to its teammate (effects flagged afterElimination; GitHub #86)
    for (const ps of this.order) {
      if (ps.alive) continue;
      try { this.dispatcher.dispatchEliminated(ps, 'onRoundStart', { round: r }); } catch (e) { this.reportError('dispatch onRoundStart (eliminated)', e); }
    }
    for (const ps of dispatched) {
      try { ps.recompute(); }
      catch (e) { this.reportError(`roundStart recompute R${r} player ${ps.playerId}`, e); }
    }
    this.setDeadline(DELAYS.ROUND_START / 1000, () => this.afterRoundStart(), { silent: this.soloUntimed });
    this.markPublic();
  }

  _planBossWaves() {
    const r = this.round;
    const plan = this.endlessBossPlan(r);
    const bossId = plan?.bossId || (r === this.gd.hiddenRound && r !== this.gd.bossRound ? this.hiddenBossId : this.bossId);
    this.bossWaves = pairPlayers(this.alivePlayers()).map((g) => ({
      players: g.map((p) => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, r, { bossId, solo: this.isSolo || g.length === 1 }),
    }));
  }

  afterRoundStart() {
    if (this.isCyclops && isCyclopsHexRound(this.round)) return this.enterCyclopsHex();
    if (this.isCyclops && isCyclopsDraftRound(this.round)) return this.enterCyclopsDraft();
    if (this.gd.spRounds().includes(this.round)) this.enterSpDraft();
    else this.enterPrep();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 独眼巨人的馈赠（entertainment_cyclops 专用；普通模式不经过这里）
  // ---------------------------------------------------------------------------------------------------------------

  /** 第 5/10/15 回合的馈赠三选一：银→金→彩固定顺序；全员并行（每人独立 3 槽 + 每槽 1 次刷新）。 */
  enterCyclopsHex() {
    if (!this.isCyclops) return;
    const idx = CYCLOPS_HEX_ROUNDS.indexOf(this.round);
    const quality = CYCLOPS_HEX_QUALITIES[idx] || 'silver';
    const alive = this.alivePlayers();
    if (!alive.length) { this.enterPrep(); return; }
    this.phase = PHASE.CYCLOPS_HEX;
    const turnSeconds = 35;
    const deadline = this.scaled(turnSeconds * 1000);
    this.cyclops = {
      round: this.round,
      quality,
      deadline: this.sched.now() + deadline,
      turnSeconds: deadline / 1000,
      // playerId → { slots: [card|null ×3], rerolls: [bool ×3], picked: slotIdx|null }
      state: new Map(alive.map((ps) => [ps.playerId, {
        slots: rollCyclopsHexSlots(this.data, this.rngDraft, quality, this._cyclopsTakenOf(ps), ps),
        rerolls: [true, true, true],
        picked: null,
      }])),
    };
    this.deadline = this.cyclops.deadline;
    // 35 秒到时：每名未选择玩家从自己的有效槽位中随机获得一项。
    this.setDeadline(turnSeconds, () => {
      if (this.phase !== PHASE.CYCLOPS_HEX) return;
      for (const ps of this.alivePlayers()) {
        const st = this.cyclops.state.get(ps.playerId);
        if (!st || st.picked != null) continue;
        this._cyclopsAutoPick(ps);
        if (this.phase !== PHASE.CYCLOPS_HEX) break;
      }
      if (this.phase === PHASE.CYCLOPS_HEX) this.finishCyclopsHex();
    });
    // AI 不等到阶段超时：从其本人可选槽位随机选择。
    for (const ps of alive) if (ps.botControlled) this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.CYCLOPS_HEX) return;
      const st = this.cyclops?.state.get(ps.playerId);
      if (!st || st.picked != null) return;
      this._cyclopsAutoPick(ps);
    });
    this.markPublic();
  }

  /** 本局该玩家已选过的 hex id（避免同一条重复刷出）。 */
  _cyclopsTakenOf(ps) {
    return new Set((ps.cyclopsHexes || []).map((h) => h.id));
  }

  /** Repair restored candidates whose health requirement is no longer met, without selecting a replacement silently. */
  _cyclopsAvailableSlots(ps) {
    const st = this.cyclops?.state.get(ps.playerId);
    if (!st) return [];
    const invalid = st.slots.some(card => !cyclopsHexAvailable(card, ps));
    if (invalid) {
      const fresh = rollCyclopsHexSlots(this.data, this.rngDraft, this.cyclops.quality, this._cyclopsTakenOf(ps), ps);
      const keep = st.slots.filter(card => cyclopsHexAvailable(card, ps));
      st.slots = st.slots.map(card => {
        if (cyclopsHexAvailable(card, ps)) return card;
        const replacement = fresh.find(c => c && !keep.some(k => k.id === c.id)) || fresh.find(Boolean) || null;
        if (replacement) keep.push(replacement);
        return replacement;
      });
      this.markPrivate(ps);
    }
    return st.slots.map((card, slot) => cyclopsHexAvailable(card, ps) ? slot : -1).filter(slot => slot >= 0);
  }

  _cyclopsAutoPick(ps) {
    const st = this.cyclops?.state.get(ps.playerId);
    if (!st || st.picked != null) return;
    const available = this._cyclopsAvailableSlots(ps);
    if (available.length) return this._cyclopsPick(ps, available[Math.floor(this.rngDraft() * available.length)]);
    // Partial/missing data must not leave an AI or a restored room stuck in the choice phase.
    st.picked = -1;
    this.markPrivate(ps);
    if (this.alivePlayers().every(p => this.cyclops.state.get(p.playerId)?.picked != null)) this.finishCyclopsHex();
  }

  /** g.cyclopsHex { slot }：选择一个槽位的馈赠。 */
  cyclopsHexPick(ps, slot, bondId = null) {
    if (!this.isCyclops || this.phase !== PHASE.CYCLOPS_HEX || !this.cyclops) return fail(ERR.WRONG_PHASE);
    if (!ps.alive || ps.left) return fail(ERR.ELIMINATED);
    const st = this.cyclops.state.get(ps.playerId);
    if (!st) return fail(ERR.BAD_TARGET);
    if (st.picked != null) return fail(ERR.ALREADY);
    if (!Number.isInteger(slot) || slot < 0 || slot >= st.slots.length) return fail(ERR.BAD_TARGET);
    if (bondId != null && !ps.gd.bondIds.includes(bondId)) return fail(ERR.BAD_TARGET);
    return this._cyclopsPick(ps, slot, bondId);
  }

  /** g.cyclopsHexReroll { slot }：刷新一个槽位（每槽一次）。 */
  cyclopsHexReroll(ps, slot) {
    if (!this.isCyclops || this.phase !== PHASE.CYCLOPS_HEX || !this.cyclops) return fail(ERR.WRONG_PHASE);
    if (!ps.alive || ps.left) return fail(ERR.ELIMINATED);
    const st = this.cyclops.state.get(ps.playerId);
    if (!st) return fail(ERR.BAD_TARGET);
    if (st.picked != null) return fail(ERR.ALREADY);
    if (!Number.isInteger(slot) || slot < 0 || slot >= st.slots.length) return fail(ERR.BAD_TARGET);
    if (!st.rerolls[slot]) return fail(ERR.ALREADY, '该槽位刷新机会已用完');
    const fresh = rollCyclopsHexSlots(this.data, this.rngDraft, this.cyclops.quality, this._cyclopsTakenOf(ps), ps);
    // 只换被刷的槽，保持其余槽不变；新槽与保留槽不同 id
    const keep = st.slots.filter((c, i) => i !== slot && cyclopsHexAvailable(c, ps));
    const pick = fresh.find((c) => c && !keep.some((k) => k.id === c.id)) || fresh.find(Boolean) || null;
    st.slots[slot] = pick;
    this._cyclopsAvailableSlots(ps);
    st.rerolls[slot] = false;
    this.markPrivate(ps);
    this.markPublic();
    return OK;
  }

  _cyclopsPick(ps, slot, bondId = null) {
    const st = this.cyclops.state.get(ps.playerId);
    const original = st && st.slots[slot];
    if (!cyclopsHexAvailable(original, ps)) {
      this._cyclopsAvailableSlots(ps);
      return fail(ERR.BAD_TARGET, '生命值不满足该馈赠条件，候选已更新');
    }
    const canonical = cyclopsHexCard(cyclopsHexes(this.data).find(h => h.id === original.id), original.quality) || original;
    const card = canonical.id === 'cyc_universal' && bondId ? { ...canonical, bondId } : canonical;
    if (!card) return fail(ERR.BAD_TARGET, '槽位为空');
    st.picked = slot;
    ps.cyclopsHexes = [...(ps.cyclopsHexes || []), card];
    try { applyCyclopsHex(this, ps, card); } catch (e) { this.reportError(`cyclopsHex ${card.id}`, e); }
    this.toast(ps, 'ok', `获得「${card.name}·${card.levelName}」`);
    this.markPrivate(ps);
    this.markPublic();
    if (this.alivePlayers().every((p) => { const s = this.cyclops.state.get(p.playerId); return !s || s.picked != null; })) {
      this.setDeadline(0);
      this.later(0, () => { if (this.phase === PHASE.CYCLOPS_HEX) this.finishCyclopsHex(); });
    }
    return OK;
  }

  finishCyclopsHex() {
    if (this.phase !== PHASE.CYCLOPS_HEX) return;
    this.cyclops = null;
    // R10：馈赠选完接选秀环节
    if (isCyclopsDraftRound(this.round)) return this.enterCyclopsDraft();
    this.enterPrep();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // R10 选秀（entertainment_cyclops 专用）：10 组「干员+装备」捆绑，LP 低者先选，每人一组
  // ---------------------------------------------------------------------------------------------------------------

  enterCyclopsDraft() {
    if (!this.isCyclops) return;
    const alive = this.alivePlayers();
    if (!alive.length) { this.enterPrep(); return; }
    this.phase = PHASE.CYCLOPS_DRAFT;
    // 选秀池以第一组的共享池生成（同组共享；人数≤8 时最多 2 组，池子以组为单位各生成 10 项）
    const pools = this.poolGroups.map((g) => {
      const first = this.players.get(g.playerIds[0]);
      return rollCyclopsDraftPool(this, first);
    });
    const order = cyclopsDraftOrder(alive);
    const deadline = this.scaled((this.gd.timer('spFirst') + this.gd.timer('spTurn') * 4) * 1000);
    this.cyclops = {
      kind: 'draft',
      round: this.round,
      pools, // poolGroupId → 10 项
      order: order.map((p) => p.playerId),
      idx: 0,
      taken: {}, // optionIdx → playerId（全局按组内索引）
      deadline: this.sched.now() + deadline,
      turnSeconds: deadline / 1000,
    };
    this.deadline = this.cyclops.deadline;
    this.setDeadline(deadline / 1000, () => {
      if (this.phase !== PHASE.CYCLOPS_DRAFT) return;
      // 超时：未选的玩家依次补领；人机随机，真人沿用首个剩余项。
      for (let i = this.cyclops.idx; i < this.cyclops.order.length; i++) {
        const pid = this.cyclops.order[i];
        if (this.cyclops.taken[`auto:${pid}`]) continue;
        this._cyclopsDraftTake(this.players.get(pid), null, { auto: true });
      }
    });
    this.markPublic();
    this.scheduleCyclopsDraftBot();
  }

  /** 轮到人机时主动随机征召；回调只处理安排时的这一轮，不能替真人或重复领取。 */
  scheduleCyclopsDraftBot() {
    const c = this.cyclops;
    const pid = c?.order[c.idx];
    if (!this.players.get(pid)?.botControlled) return;
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.CYCLOPS_DRAFT || this.cyclops !== c || c.order[c.idx] !== pid || c.taken[`auto:${pid}`]) return;
      const ps = this.players.get(pid);
      if (ps?.botControlled) this._cyclopsDraftTake(ps, null, { auto: true });
    });
  }

  /** 选秀公共池视图（每组的 10 项；已领的标记 taken）。 */
  _cyclopsDraftPoolOf(ps) {
    const g = this.poolGroups.find((x) => x.playerIds.includes(ps.playerId)) || this.poolGroups[0];
    return { groupId: g.id, items: this.cyclops.pools[this.poolGroups.indexOf(g)] || [] };
  }

  /** g.cyclopsDraft { idx }：领走一项（干员+装备）。 */
  cyclopsDraftPick(ps, idx) {
    if (!this.isCyclops || this.phase !== PHASE.CYCLOPS_DRAFT || !this.cyclops) return fail(ERR.WRONG_PHASE);
    if (!ps.alive || ps.left) return fail(ERR.ELIMINATED);
    if (this.cyclops.order[this.cyclops.idx] !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    return this._cyclopsDraftTake(ps, idx);
  }

  _cyclopsDraftTake(ps, idx, { auto = false } = {}) {
    const c = this.cyclops;
    const { items, groupId } = this._cyclopsDraftPoolOf(ps);
    // taken 记录：`g:<groupId>:<optionIdx>` → playerId；`auto:<playerId>` → 该玩家已领
    const used = new Set();
    for (const [k, v] of Object.entries(c.taken)) {
      if (!k.startsWith('g:')) continue;
      const [g, i] = k.slice(2).split(':');
      if (g === groupId) used.add(Number(i));
    }
    // 显式指定被占用项：拒绝（SOLD_OUT）；人机自动领取从有效剩余项中随机选择。
    if (!auto && Number.isInteger(idx)) {
      if (idx < 0 || idx >= items.length) return fail(ERR.BAD_TARGET);
      if (used.has(idx)) return fail(ERR.SOLD_OUT);
    }
    const available = items.map((item, i) => item && !used.has(i) ? i : -1).filter((i) => i >= 0);
    const pick = !auto && Number.isInteger(idx) ? idx
      : ps.botControlled && available.length ? available[Math.floor(this.rngDraft() * available.length)]
      : available[0];
    if (pick == null || pick < 0) { c.taken[`auto:${ps.playerId}`] = true; this._cyclopsDraftAdvance(ps); return OK; }
    const opt = items[pick];
    if (!opt) { c.taken[`auto:${ps.playerId}`] = true; this._cyclopsDraftAdvance(ps); return OK; }
    c.taken[`g:${groupId}:${pick}`] = ps.playerId;
    c.taken[`auto:${ps.playerId}`] = true;
    // 发放：干员 + 装备
    const chessRec = ps.gd.chess(opt.chessId);
    const itemRec = ps.gd.item(opt.itemId);
    if (chessRec) {
      const piece = ps.acquireChess(opt.chessId, { source: 'cyclops' });
      if (piece) this.toast(ps, 'ok', `征召获得干员「${chessRec.name || opt.chessId}」`);
    }
    if (itemRec) {
      const piece = ps.acquireItem(opt.itemId, { source: 'cyclops', deferMerge: true });
      if (piece) this.toast(ps, 'ok', `征召获得装备「${itemRec.name || opt.itemId}」`);
    }
    this.markPrivate(ps);
    this._cyclopsDraftAdvance(ps);
    return OK;
  }

  _cyclopsDraftAdvance(ps) {
    const c = this.cyclops;
    if (!c) return;
    // 前进到下一个未选的玩家
    while (c.idx < c.order.length && c.taken[`auto:${c.order[c.idx]}`]) c.idx++;
    this.markPublic();
    if (c.idx >= c.order.length) {
      this.setDeadline(0);
      this.later(0, () => { if (this.phase === PHASE.CYCLOPS_DRAFT) this.finishCyclopsDraft(); });
    } else {
      this.scheduleCyclopsDraftBot();
    }
  }

  finishCyclopsDraft() {
    if (this.phase !== PHASE.CYCLOPS_DRAFT) return;
    this.cyclops = null;
    this.enterPrep();
  }
}
