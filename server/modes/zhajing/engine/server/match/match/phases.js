// server/match/match/phases.js — Match methods: the round flow up to the prep — INFO_CHECK, the strategy draft
// (BAND_DRAFT: one countdown of BAND_TURN_SECONDS per turn, 队友已选, the highlighted strategy on a timeout, skips),
// BATTLE_CHECK and ROUND_START (the round's enemies — a normal wave or the boss pairing — planned before the players'
// round start).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { buildNormalWave, buildBossWave, weightedPick } from '../waves.js';
import { matchJibianPlan, applyHiddenMatchCards } from '../../sim/content/ejibian.js';
import { jibianCard } from '../choices.js';
import { pairPlayers } from '../finalAssault.js';
import { botPickBand, aiBandPick } from '../bot.js';
import { OK, fail, DELAYS, BAND_TURN_SECONDS, BAND_DRAFT_SECONDS } from './common.js';

export class MatchPhases {
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
    if (this.phase !== PHASE.INFO_CHECK) return;
    // `botControlled`, not just `isBot`: a HUMAN seat under AI 托管 (the player dropped, the server took the seat
    // over) answers nothing, so an `isBot`-only test left the whole room on the 25 s guard — and in a room whose
    // every seat is bot-controlled the phase could not end at all. enterInfoCheck marks exactly these seats ready.
    if (this.order.every((p) => p.isBot || p.botControlled || p.left || p.infoReady)) {
      this.setDeadline(0);
      this.later(0, () => { if (this.phase === PHASE.INFO_CHECK) this.enterBandDraft(); });
    }
  }

  /**
   * The strategy draft (user playtest #4 item 4): ONE countdown — every turn has the same clock, BAND_TURN_SECONDS, and
   * m.public.deadline is the current turn's end (= draft.turnDeadline; the step header and the turn indicator show the
   * same number). No separate step cap: the turns bound the step (≤ (seats + skips) × turn). AI seats pick at once. A
   * turn that runs out takes the strategy the player has highlighted (g.bandFocus) while it is free, else the default
   * (timeoutBand). Solo, and any single-human match (soloUntimed): untimed. Solo also keeps seat order and has no skip.
   */
  /**
   * The co-op room option 「AI 队友最后选择」 (this.aiPicksLast, GitHub #338): every human seat before every AI seat,
   * each group in the order the draft drew (a stable partition applied AFTER the shuffle — no extra random draw:
   * the order with the option off is unchanged). A human is any seat that is not an AI seat (room.addBot): under
   * AI 托管, disconnected or departed it still counts as a human. Used by the strategy draft and the 机变 draft.
   * @param {string[]} order playerIds in drawn order
   * @returns {string[]}
   */
  humansFirst(order) {
    if (!this.aiPicksLast) return order;
    const bot = (pid) => !!this.players.get(pid)?.isBot;
    return [...order.filter((pid) => !bot(pid)), ...order.filter(bot)];
  }

  enterBandDraft() {
    if (this.phase !== PHASE.INFO_CHECK) return;
    this.phase = PHASE.BAND_DRAFT;
    let order = this.order.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    order = this.humansFirst(order);
    const simultaneous = this.bandDraftSimultaneous();
    // No turn order in simultaneous mode, so no skip counter either: a skip only ever meant 「pass my turn on」.
    const skips = (this.isSolo || simultaneous) ? 0 : this.gd.bandDraft.skipsPerPlayer;
    const untimed = this.soloUntimed;
    this.draft = {
      order, idx: 0, picks: {}, skipsLeft: Object.fromEntries(order.map((pid) => [pid, skips])), untimed, turnDeadline: 0,
      simultaneous,
      /** playerId → the strategy highlighted in the draft screen (g.bandFocus) */
      focus: new Map(),
    };
    this.setDeadline(0);
    this.startDraftTurn();
    this.markPublic();
  }

  /** 100-seat variant: everyone decides at once under ONE shared countdown (config.bandDraft.simultaneous). */
  bandDraftSimultaneous() {
    return this.gd.bandDraft.simultaneous === true;
  }

  /**
   * Whose decision the draft is waiting on. In simultaneous mode EVERYONE is deciding at once, so the client's
   * `myTurn` gate (`turn === myId`) has to be true for every seat — otherwise the picker stays locked for 99 of 100
   * players and the mode does nothing. Turn order still decides the auto-assignment sequence when the clock runs out.
   */
  draftTurn() {
    const d = this.draft;
    if (!d) return null;
    if (d.simultaneous) return d.order.find((pid) => !d.picks[pid]) ?? null;
    return d.order[d.idx] ?? null;
  }

  /** Real ms of one strategy-draft turn (BAND_TURN_SECONDS × timerScale). */
  bandTurnMs() { return this.scaled(BAND_TURN_SECONDS * 1000); }

  startDraftTurn() {
    const d = this.draft;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    if (d.simultaneous) { this.startDraftRound(); return; }
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

  /**
   * 100-seat variant: the shared countdown of the simultaneous draft. One deadline for the whole room
   * (BAND_DRAFT_SECONDS — the same 50 s the OLD per-turn timer used, so it is calibrated against the picker UI), and
   * re-entering this method MUST NOT restart it: `_applyBand` calls `startDraftTurn` on every pick, so a restart would
   * push the deadline out for as long as players keep clicking. The absolute deadline lives on the draft record.
   */
  startDraftRound() {
    const d = this.draft;
    const done = d.order.every((pid) => d.picks[pid]);
    if (done) {
      d.turnDeadline = 0;
      this.deadline = 0;
      this.later(0, () => this.finishBandDraft(false));
      return;
    }
    if (d.untimed) {
      d.turnDeadline = 0;
      this.deadline = 0;
    } else {
      if (!(d.turnDeadline > 0)) d.turnDeadline = this.sched.now() + this.scaled(BAND_DRAFT_SECONDS * 1000);
      this.deadline = d.turnDeadline;
      const token = ++this._turnToken;
      const ms = Math.max(0, d.turnDeadline - this.sched.now());
      this._turnTimer = this.later(ms, () => {
        if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
        this.autoAssignDraft(5000);
      });
    }
    // every AI seat picks its OWN strategy now (botPickBand: weighted by starting LP) — it used to take
    // `defaultBand` (the timeout fallback, one fixed strategy) and every AI in the room ended up on the same band
    // (measured: 10 of 10 seats on 华法琳 before this). The room-wide rules below are placeholders: see aiBandPick.
    const aiSeats = this.order.filter((ps) => ps.botControlled);
    const aiTotal = aiSeats.length;
    const aiIndexOf = new Map(aiSeats.map((ps, i) => [ps.playerId, i]));
    for (const bot of aiSeats) {
      if (this.phase !== PHASE.BAND_DRAFT) return;
      if (d.picks[bot.playerId]) continue;
      const i = aiIndexOf.get(bot.playerId);
      const excl = new Set(this.gd.bandIds().filter((id) => this.bandTaken(id, bot.playerId)));
      const id = aiBandPick(this, excl, i, aiTotal, d.picks, aiSeats);
      this._applyBand(bot, id);
    }
    this.markPublic();
  }

  /**
   * The shared clock ran out: hand every player who never picked an automatic strategy — what they highlighted
   * (timeoutBand: the band the detail pane was showing), else the official default (defaultBand). Assignments are
   * staggered (`staggerMs`) so the 100-seat client is not asked to rebuild 100 rows in one frame, and each step is
   * token-guarded so a phase change cancels the rest. Nothing is billed to the players: this is the same automatic
   * assignment a timed-out turn always produced.
   */
  autoAssignDraft(staggerMs = 0) {
    const d = this.draft;
    if (!d) return;
    const pending = d.order.filter((pid) => !d.picks[pid]);
    if (!pending.length) return;
    const token = ++this._turnToken;
    if (!(staggerMs > 0)) {
      for (const pid of pending) {
        if (this.phase !== PHASE.BAND_DRAFT) return;
        const ps = this.players.get(pid);
        if (ps) this._applyBand(ps, this.timeoutBand(pid));
      }
      return;
    }
    pending.forEach((pid, i) => {
      this.later(staggerMs * (i + 1), () => {
        if (token !== this._turnToken) return;
        if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return;
        if (this.draft.picks[pid]) return;
        const ps = this.players.get(pid);
        if (ps) this._applyBand(ps, this.timeoutBand(pid));
      });
    });
  }

  /** An AI seat's (or an AI 托管 seat's) turn: it picks at once (user playtest #4 item 4 — nobody waits on the AI). */
  scheduleBandBot() {
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

  /**
   * Whether `bandId` was already picked by another player of this draft. Research 09 §5 / DESIGN §14 corrections:
   * the strategy draft marks a teammate's pick as 队友已选 and it cannot be chosen again (co-op). The automatic
   * assignments — a turn that runs out and a departing seat — obey the same rule: see timeoutBand / defaultBand.
   */
  bandTaken(bandId, playerId) {
    // 100-seat variant: `config.bandDraft.duplicatesAllowed` (true in data/config.json) lets two players take the SAME
    // strategy. Upstream always enforced 「队友已选」; the data declared the opposite and nothing read it. This is the
    // single decision point — phases.startDraftTurn's bot redraw, timeoutBand and defaultBand all consult it.
    if (this.gd.bandDraft.duplicatesAllowed) return false;
    const picks = this.draft?.picks || {};
    for (const [pid, id] of Object.entries(picks)) if (pid !== playerId && id === bandId) return true;
    return false;
  }

  /**
   * The strategy an automatic assignment gives `playerId` (a departing seat; a timed-out turn without a usable
   * highlight, timeoutBand): the official default 「华法琳」 (bandDraft.timeoutBandId) while no teammate holds it, else the
   * first strategy of the mode (sortId order, gd.bandIds) that nobody else picked — never a duplicate (队友已选; the
   * client shows the same choice: public/js/screens/bandDraft.js timeoutBand). Solo drafts have no teammates, so it is
   * always the default.
   * @param {string} playerId
   */
  defaultBand(playerId) {
    const def = this.gd.bandDraft.timeoutBandId;
    if (!this.bandTaken(def, playerId)) return def;
    return this.gd.bandIds().find((b) => !this.bandTaken(b, playerId)) || def;
  }

  /**
   * What a turn that runs out assigns (user playtest #4 item 4): the strategy the player has highlighted in the draft
   * screen (g.bandFocus — the detail pane's band, the one 确认选择 would take) while it is allowed and no teammate holds
   * it, else defaultBand.
   * @param {string} playerId
   */
  timeoutBand(playerId) {
    const f = this.draft && this.draft.focus instanceof Map ? this.draft.focus.get(playerId) : null;
    if (typeof f === 'string' && this.gd.bandAllowed(f) && !this.bandTaken(f, playerId)) return f;
    return this.defaultBand(playerId);
  }

  /**
   * g.bandFocus { bandId? }: the strategy the player highlights in the draft screen (any time before its pick; also
   * while waiting for its turn). A missing / null bandId clears it. Only a timed-out turn reads it (timeoutBand).
   */
  bandFocus(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (!(d.focus instanceof Map)) d.focus = new Map();
    if (bandId == null) { d.focus.delete(ps.playerId); return OK; }
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    d.focus.set(ps.playerId, bandId);
    return OK;
  }

  pickBand(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    if (this.draft.picks[ps.playerId]) return fail(ERR.ALREADY);
    // Simultaneous mode has no turn order: anyone may pick at any moment. `duplicatesAllowed: true` (which this mode
    // pairs with) makes `bandTaken` always false, so the 「队友已选」 rejection below never fires either.
    if (!this.draft.simultaneous && this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    if (this.bandTaken(bandId, ps.playerId)) return fail(ERR.BAD_TARGET, '队友已选'); // i18n-ignore: developer detail (players see ERR_TEXT)
    this._applyBand(ps, bandId);
    return OK;
  }

  _applyBand(ps, bandId, { dedupe = false } = {}) {
    const d = this.draft;
    if (!d || !ps || d.picks[ps.playerId]) return;
    let id = this.gd.bandAllowed(bandId) ? bandId : this.defaultBand(ps.playerId);
    if (dedupe && this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
    d.picks[ps.playerId] = id;
    ps.bandId = id;
    ps.lp = this.gd.startLp(id);
    this.markPrivate(ps);
    this.markPublic();
    this.startDraftTurn();
  }

  /**
   * 100-seat variant: this is GONE. A skip only ever meant 「pass my turn to the next player」 (it spliced the player out
   * of the order and pushed them to the back), which has no meaning without a turn order — and the owner asked for it to
   * be removed. Nothing is lost: an unpicked seat is covered by the shared countdown's automatic assignment.
   */
  skipBand() {
    return fail(ERR.WRONG_PHASE, 'skip removed: the strategy draft is simultaneous'); // i18n-ignore: developer detail
  }

  finishBandDraft(timeout) {
    if (this.phase !== PHASE.BAND_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    for (const ps of this.order) {
      if (!this.draft.picks[ps.playerId]) {
        // one after another in seat order, so each default sees the ones assigned before it (no duplicates)
        const id = this.defaultBand(ps.playerId);
        this.draft.picks[ps.playerId] = id;
        ps.bandId = id;
        ps.lp = this.gd.startLp(id);
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
    const prevRound = this.round;
    this.phase = PHASE.ROUND_START;
    this.round = r;
    // ★ 惊变「追忆」(传说, owner 2026-10-16):「你和你的队伍在第十三回合结束时不进入第十四回合，变为进入
    //   第十回合整备阶段，之后该惊变失效」。挂点在最前面 —— `this.round` 刚写上、**任何本回合的状态重置与
    //   出怪计划都还没跑**，所以在这里改写它，整轮（波次、onRoundStart、商店…）都会按新回合号走。
    //   判定交给 content 侧的 HOOKS.onRoundWouldStart（handler 返回新的回合号，null/undefined = 不改）。
    //   有这张卡的玩家都算数（"你和你的队伍"）—— 谁先被派发到就由谁改写，结果一致。
    for (const p of this.alivePlayers()) {
      const jump = this.dispatch(p, 'onRoundWouldStart', { round: r });
      const to = jump && Number.isFinite(jump.round) ? Math.trunc(jump.round) : null;
      if (to != null && to !== r && to >= 1) { this.round = to; break; }
    }
    // ★ 2026-10-16 修 bug（玩家反馈「用了追忆回到第十回合不出怪、直接卡死」）：
    //   上面只改了 `this.round`，**局部变量 `r` 还是旧值**，而本函数下面每一处都用 `r` ——
    //   `isBoss`（boss 轮判定）、`buildNormalWave(…, r, …)`（出怪表）、`ps.startRound(r)`（玩家自己的回合号）、
    //   `dispatch(ps, 'onRoundStart', { round: r })`（回合开始效果）—— 于是整轮**按旧回合号 14 出怪与初始化**，
    //   而比赛回合号是 10，两边错位：按回合号取波次取不到 → **不出怪**；`ps.round` 与 `match.round` 不一致 → 卡死。
    //   把 `r` 同步成改写后的回合号，下面每一处都自动跟着走（等价于 startRound 一开始就收到新回合号）。
    //   追忆把 14 改写成 10 之后：不按 boss 轮走、按第 10 回合建波次、玩家回合号也是 10 ✓
    r = this.round;
    // ★ 2026-10-26：追忆/任何回合回退留痕（诊断「追忆后的 R11」这类问题）
    try { if (Number.isFinite(prevRound) && r < prevRound) this.log.info?.(`[match ${this.roomCode}] 回合回退 R${prevRound} → R${r}`); } catch { /* ignore */ }
    this.fields = [];
    this.watchers.clear();
    this.unitePlan = null;
    this.uniteResultView = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    this.jibianPlan = null;
    // ★ 2026-10-26（追忆回到同一回合后联防卡死）：下面这些按「回合号」去重/复用的状态必须每回合重来。
    //   追忆把 14 改写成 10 时，如果第 10 回合此前已经打过联防，`_phase1Driven === 10` 会让新的一轮
    //   `_afterUniteRound` 直接 return —— 第一段联防打完既不进阶段 2 也不结算，玩家看到的就是
    //   「18/18 清空但卡在 UNITE」。同一回合重新进入时同样需要清掉上一轮的 relay 残留。
    this._phase1Driven = null;
    this.uniteRound = 1;
    this.unitePlans = [];
    this._uniteHandoff = null;
    this._phase1Settle = null;
    this._relayToken = 0;
    this._uniteToken = 0;
    this.deadline = 0;
    const alive = this.alivePlayers();
    // the round's enemies (shared composition, generated now so the prep preview is exact). Planned BEFORE the players'
    // round start: its recompute() checks the board on the field the player deploys on this round (deployFieldOf reads
    // the boss pairing), so R14 → R15 never re-checks a boss-field board against the normal field (user playtest #5
    // item 7). rngWaves is used only here, so the order leaves every random stream unchanged.
    const isBoss = r === this.gd.bossRound || r === this.gd.hiddenRound;
    // 炸惊模拟 规则14 敌方惊变 的 Match 侧（出怪量 ×1.4 / ×0.8、强行顶吗的同一时间进场、入职测试的小怪换源石虫）：
    // 每轮算一次，boss 轮的两个半场共用同一份计划；入职测试的 15% 走 rngWaves.state() 派生的独立流，不消耗本轮的
    // 波次随机数（所以本行的位置不影响任何既有随机序列）。
    this.jibianPlan = matchJibianPlan(this.rngWaves, r, this.enemyJibianCards);
    if (isBoss) {
      this._planBossWaves();
    } else {
      // ★ 2026-10-16：把 `jibian`（= 已抽到的敌方惊变卡 id）也传进出怪表 —— 惊变「天堂制造」要按它把
      //   战斗时限 −40s（游戏秒 80），并据此按比例收紧整轮时间轴（否则尾巴上的怪会被新时限切掉）。
      //   `plan` 只带"本轮要怎么改数量/时机"，不含卡 id，所以两者都要给。
      this.wave = buildNormalWave(this.gd, this.rngWaves, this.factions, r, { plan: this.jibianPlan, jibian: this.enemyJibianCards || null });
    }
    for (const ps of alive) ps.startRound(r);
    for (const ps of alive) this.dispatch(ps, 'onRoundStart', { round: r });
    // an eliminated player's pending 信标 gift still goes to its teammate (effects flagged afterElimination; GitHub #86)
    for (const ps of this.order) {
      if (ps.alive) continue;
      try { this.dispatcher.dispatchEliminated(ps, 'onRoundStart', { round: r }); } catch (e) { this.reportError('dispatch onRoundStart (eliminated)', e); }
    }
    for (const ps of alive) ps.recompute();
    this.setDeadline(DELAYS.ROUND_START / 1000, () => this.afterRoundStart(), { silent: this.soloUntimed });
    this.markPublic();
    // eliminated humans and spectator seats scout the board of the player they follow through the round's prep, not
    // their own empty board (community report of 2026-10-06, item 56; MatchWatch._followScout)
    for (const ps of this._viewers()) this._followScout(ps);
  }

  /** The boss round's fields (seat pairs of the alive players) and their templates, generated for the prep preview. */
  _planBossWaves() {
    const r = this.round;
    const bossId = r === this.gd.hiddenRound && r !== this.gd.bossRound ? this.hiddenBossId : this.bossId;
    this.bossWaves = pairPlayers(this.alivePlayers()).map((g) => ({
      players: g.map((p) => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, r, { bossId, solo: this.isSolo || g.length === 1, plan: this.jibianPlan }),
    }));
  }

  afterRoundStart() {
    // 炸惊模拟 规则14: the 敌方惊变 is drawn before the configured rounds begin (config `enemyJibian.rounds`;
    // 用户 2026-10-11「1.6回合抽取敌方惊变」= 第 1 回合开始前 与 第 6 回合 各一次），并在那个回合自己的流程
    // （惊变阶段 / 整备期）继续之前向全场展示。用集合记录「哪些回合已经抽过」，于是可以触发多次。
    const ej = typeof this.gd.enemyJibian === 'function' ? this.gd.enemyJibian() : null;
    const rounds = ej ? (Array.isArray(ej.rounds) && ej.rounds.length ? ej.rounds : [ej.round]) : [];
    if (!(this.enemyJibianRoundsDone instanceof Set)) this.enemyJibianRoundsDone = new Set();
    if (ej && !this.enemyJibianRoundsDone.has(this.round) && rounds.includes(this.round)) { this.enterEnemyJibian(); return; }
    this.afterEnemyJibian();
  }

  /**
   * 炸惊模拟 规则14 — 敌方惊变. ONE card is drawn per configured round (config `enemyJibian.rounds`: 第 1、第 6 回合)
   * for the whole room (never per player) from the mode's own pool: the rarity is rolled first with the 惊变阶段's own
   * weights (普通 45 / 稀有 25 / 史诗 20 / 传说 10) and a card of that rarity is then drawn, skipping the ones already drawn this
   * match (the two cards stack, so a repeat would be a wasted draw); a rarity the pool has nothing left of falls back to
   * the pool as a whole. The draw is announced in a blocking ENEMY_JIBIAN phase — `flickerMs` of rolling cards, then
   * `resultMs` with the drawn one zoomed in — after which the round continues exactly as it would have (spDraft or prep).
   * An empty pool (the card list is supplied separately) skips the reveal entirely.
   */
  enterEnemyJibian() {
    if (!(this.enemyJibianRoundsDone instanceof Set)) this.enemyJibianRoundsDone = new Set();
    this.enemyJibianRoundsDone.add(this.round);
    this.enemyJibianDone = true;
    const ej = typeof this.gd.enemyJibian === 'function' ? this.gd.enemyJibian() : null;
    if (!ej || !ej.pool.length) { this.enemyJibian = null; this.afterEnemyJibian(); return; }
    const rarity = weightedPick(this.rngDraft, ej.rarityWeights);
    // 用户 2026-10-12「两个可叠加」：已经抽到过的敌方惊变不再出现在后面的抽取里，于是两张一定是两张**不同**的卡
    // —— 同一张抽到两次不会叠加（ejibian.js 按 id 判断有没有这张卡），等于白抽一次。池子被抽空时回落到整池。
    const taken = new Set(this.enemyJibianCards || []);
    // ★ 测试便利 (owner 2026-10-16)：开着「外援测试模式」的房间里，敌方惊变优先给这几张刚做的卡
    //   （传说品质靠 pool 里的 10% 权重很难抽到，验卡不能等运气）。口径与 spDraft 的 TEST_CARDS 一致：
    //   只有 testMode === true 的玩家在场才生效，生产 / 分发包默认 false，走不到这里。
    const testing = this.alivePlayers().some((p) => p && p.testMode === true);
    let forced = null;
    if (testing) {
      const modes = this.gd && this.gd.config ? this.gd.config.modes : null;
      const mo = modes ? modes[this.modeId] : null;
      forced = mo && mo.enemyJibian ? mo.enemyJibian.testCards : null;
    }
    if (testing && Array.isArray(forced) && forced.length) {
      const want = forced.filter((id) => !taken.has(id));
      const pickId = want[0] || forced[(this.enemyJibianRoundsDone.size || 1) % forced.length];
      const spec = ej.pool.find((c) => c && (c.effectId || c.id) === pickId) || null;
      if (spec) {
        const card = jibianCard(this.gd, spec, spec.rarity || rarity);
        this.enemyJibian = { rarity: spec.rarity || rarity, card, round: this.round };
        this.enemyJibianCards = [...(this.enemyJibianCards || []), card.id].filter((x) => typeof x === 'string' && x);
        this.phase = PHASE.ENEMY_JIBIAN;
        this.setDeadline((ej.flickerMs + ej.resultMs) / 1000, () => {
          if (this.phase === PHASE.ENEMY_JIBIAN) this.afterEnemyJibian();
        }, { silent: this.soloUntimed });
        this.markPublic();
        for (const ps of this.order) this.markPrivate(ps);
        this.flush(true);
        return;
      }
    }
    let pool = ej.pool.filter((c) => c && !taken.has(c.effectId || c.id));
    if (!pool.length) pool = ej.pool;
    const ofRarity = pool.filter((c) => c && c.rarity === rarity);
    const list = ofRarity.length ? ofRarity : pool;
    const card = jibianCard(this.gd, list[Math.floor(this.rngDraft() * list.length)], rarity);
    this.enemyJibian = { rarity, card, round: this.round };
    // 规则14: the drawn card stays in force for the rest of the match — every later battle spec carries the ids in
    // flags.enemyJibian (server/sim/content/ejibian.js applies them per spawned enemy).
    this.enemyJibianCards = [...(this.enemyJibianCards || []), card.id].filter((x) => typeof x === 'string' && x);
    this.phase = PHASE.ENEMY_JIBIAN;
    // the reveal is untimed only where the whole room is (solo / a single human) — the client still auto-advances on
    // the deadline, so a timed phase is what every seat waits out
    this.setDeadline((ej.flickerMs + ej.resultMs) / 1000, () => {
      if (this.phase === PHASE.ENEMY_JIBIAN) this.afterEnemyJibian();
    }, { silent: this.soloUntimed });
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
  }

  /**
   * ★ 2026-10-24（owner）：「隐秘惊变」—— 隐秘核心战开始前的专属揭示阶段，与普通敌方惊变（ENEMY_JIBIAN）分开。
   * 规则：**保底**先抽一张「隐秘」稀有度的 boss 专属卡（config enemyJibian.hidden.pool），
   *       再按普通权重抽一张普通池的卡；两张都追加进 enemyJibianCards，对隐秘核心战生效。
   * 池子为空时（还没写隐秘卡）只抽普通那张；两张都抽不到就直接进隐秘核心。
   */
  enterHiddenJibian(hidden, opts = {}) {
    // ★ 2026-10-24（owner 修正）：这段揭示应该发生在**隐秘核心那一回合的整备开始时**，不是整备结束时。
    //   opts.then='prep' → 播完回到 enterPrep（带着刚抽到的惊变布阵）；缺省 → 旧行为（进隐秘核心前播）。
    const after = () => (opts.then === 'prep' ? this.enterPrep() : this.startFinalAssault(true));
    const ej = typeof this.gd.enemyJibian === 'function' ? this.gd.enemyJibian() : null;
    if (!ej) { after(); return; }
    const taken = new Set(this.enemyJibianCards || []);
    const picked = [];
    const hiddenPool = hidden && Array.isArray(hidden.pool) ? hidden.pool.filter((c) => c && c.effectId) : [];
    const normalPool = Array.isArray(ej.pool) ? ej.pool.filter((c) => c && c.effectId) : [];
    /** 抽一张（allowHidden: 7.99% 走隐秘池）；结果进 taken，避免同一张重复 */
    const drawOne = (allowHidden, forceHidden = false) => {
      // forceHidden：隐秘阶段开头那张是【保底】隐秘；7.99% 只用于「潘多拉·敌」追加的抽卡
      const useHidden = !!(allowHidden && hiddenPool.length && (forceHidden || this.rngDraft() < 0.0799));
      const source = useHidden ? hiddenPool : normalPool;
      if (!source.length) return null;
      let pool = source.filter((c) => !taken.has(c.effectId || c.id));
      if (!pool.length) pool = source;
      let list = pool;
      let rarity = useHidden ? 'hidden' : null;
      if (!useHidden) {
        rarity = weightedPick(this.rngDraft, ej.rarityWeights);
        const ofRarity = pool.filter((c) => c && c.rarity === rarity);
        if (ofRarity.length) list = ofRarity;
      }
      const spec = list[Math.floor(this.rngDraft() * list.length)];
      if (!spec) return null;
      const card = jibianCard(this.gd, spec, spec.rarity || rarity || 'normal');
      taken.add(card.id);
      return card;
    };
    // ★ 2026-10-25（owner）：隐秘阶段改成**抽两张隐秘惊变**（原来 1 张保底隐秘 + 1 张普通权重）。
    //   隐秘池抽完时退回普通池，避免同一张重复出现。
    const drawHidden = () => {
      if (!hiddenPool.length) return drawOne(false);
      const left = hiddenPool.filter((c) => !taken.has(c.effectId || c.id));
      if (!left.length) return drawOne(false);
      return drawOne(true, true);
    };
    for (let i = 0; i < 2; i++) { const c = drawHidden(); if (!c) break; picked.push(c); }
    // ★ 2026-10-24（owner）：「潘多拉·敌」—— 抽到后再随机 3 张敌方惊变（每张 7.99% 是隐秘惊变）。
    //   展开是递归的（潘多拉自己也可能被抽到），所以用队列 + 次数上限防跑飞。
    const PANDORA = 'ejibian_hidden_pandora';
    const expanded = new Set();
    const queue = picked.slice();
    for (let guard = 0; queue.length && guard < 40; guard++) {
      const c = queue.shift();
      if (!c || c.id !== PANDORA || expanded.has(c.id)) continue;
      expanded.add(c.id);
      for (let i = 0; i < 3; i++) {
        const extra = drawOne(true);
        if (!extra) break;
        picked.push(extra);
        queue.push(extra);
      }
    }
    if (!picked.length) { after(); return; }
    this.enemyJibianCards = [...(this.enemyJibianCards || []), ...picked.map((c) => c.id)]
      .filter((x) => typeof x === 'string' && x);
    // 隐秘惊变里「抽到即改玩家层数」的两张（响指 / 诛伏赐死）在这里结算
    try { applyHiddenMatchCards(this, picked.map((c) => c.id)); } catch { /* 不影响揭示流程 */ }
    this.hiddenJibian = {
      hidden: true,
      label: (hidden && hidden.label) || '隐秘惊变',
      cards: picked,
      round: this.round,
    };
    this.phase = PHASE.HIDDEN_JIBIAN;
    const flickerMs = Number(hidden && hidden.flickerMs) || Number(ej.flickerMs) || 2200;
    const resultMs = Number(hidden && hidden.resultMs) || Number(ej.resultMs) || 1800;
    this.setDeadline((flickerMs + resultMs) / 1000, () => {
      if (this.phase === PHASE.HIDDEN_JIBIAN) after();
    }, { silent: this.soloUntimed });
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
  }

  /** The round flow the 敌方惊变 reveal interrupted (the ordinary spDraft / prep branch). */
  afterEnemyJibian() {
    // ★ 2026-10-16（owner）死亡回归回到惊变回合：只让发动者再选一次，其他人直接进整备。
    //   标记只消费一次（无论这一回合是不是惊变回合都要清掉，免得留到后面的回合）。
    const solo = this._jibianSoloPick || null;
    this._jibianSoloPick = null;
    this._jibianRewindRound = null;   // 回退标记只用这一回合，用完即清
    if (this.gd.spRounds().includes(this.round)) this.enterSpDraft(solo ? { onlyPlayerId: solo } : {});
    else this.enterPrep();
  }
}
