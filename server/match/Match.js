// server/match/Match.js — the match & meta engine: state machine, timers, round loop, co-op orchestration,
// broadcasting views (DESIGN §6, §8). Rules are documented in the module headers of ./PlayerState.js, ./pool.js,
// ./board.js, ./bondsMeta.js, ./effectsMeta.js, ./choices.js, ./waves.js, ./unite.js, ./finalAssault.js,
// ./results.js, ./bot.js and in docs/META.md.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// MATCH INTERFACE (platform contract: server/lobby.js ⇄ server/match/Match.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// new Match(opts)
//   opts.roomCode    string                     4-letter room code (logging only)
//   opts.mode        'solo' | 'coop'
//   opts.variant     'entertainment_multi' 可选，仅 coop 启用娱乐多人，实占席位最多 20 人。
//   opts.difficulty  'FUNNY'|'NORMAL'|'HARD'|'ABYSS'
//   opts.modeId      string                     modeIdFor(mode, difficulty), e.g. 'mode_multi_hard'
//   opts.seats       Array<{ seat: 0..3, playerId: string, name: string, isBot: boolean, connected: boolean,
//                            loadout?: { [baseChessId]: { skill: index, module: uniEquipId|'none'|null } } | null }>
//                    sorted by seat, 1–4 entries, ≥ 1 human; solo ⇒ exactly 1 human and no bots.
//                    Bot playerIds start with 'ai_'. Seat indexes may have gaps (e.g. seats 0 and 2).
//                    `loadout` (DESIGN §16, optional): the human's operator loadout, already checked by the lobby
//                    (shared/protocol.js checkLoadout); PlayerState re-checks it against opts.data and ignores it for bots.
//   opts.seed        uint32                     master seed for all match randomness
//   opts.matchNo     integer ≥ 1 (optional)     the room's match number (lobby: room.matchCount + 1); with the seed it
//                                              makes this match's battleIds unique within the room (DESIGN §14)
//   opts.data        frozen game data (server/data.js getData()); may lack keys while data is generated
//   opts.log         { info, warn, error, debug }
//   opts.now         () => ms epoch             injectable clock (Date.now in production)
//   opts.send(playerId, msg) → boolean          unicast; never throws; silently drops for bots, disconnected
//                                              or departed players (they get a full resync on reconnect).
//                                              `b.snap` frames may be dropped under backpressure.
//   opts.broadcast(msg) → void                  to every connected, non-departed human of the room.
//   opts.onEnd(summary) → void                  call EXACTLY ONCE when the match is over, after m.result was
//                                              sent. The platform then (synchronously) returns the room to
//                                              LOBBY and (asynchronously, next macrotask) calls dispose().
//                                              `summary` is free-form JSON (kept as room.lastSummary).
//
// start()                   Called once, right after construction. Must broadcast the first m.public and send
//                           each human its m.private. May call onEnd synchronously (the platform copes).
// handle(playerId, msg)     A validated 'g.*' intent or client-side combat report 'b.progress' / 'b.result'
//                           (msg passed validateC2S; never 'g.leave', which the
//   → { ok: true }          platform turns into onLeave). Return { error: ERR code (shared/constants.js),
//   | { error, detail? }    detail?: string } to reject. Must not throw (if it does, the platform logs and
//                           replies ERR.INTERNAL). Replies ('ok'/'error' with rid) are sent by the platform.
// onDisconnect(playerId)    A human's socket dropped. The seat is kept; apply the auto-play policy.
// onReconnect(playerId)     The human is back (new socket with its token) or re-sent hello on a live socket
//                           (a resync request). May be called without a preceding onDisconnect. Resend full
//                           state: m.public, m.private and, if a battle is on (client-side combat), the
//                           b.start of the field the player is on / watching (server-run mode: m.field + b.snap).
// setLoadout(playerId, loadout) → { ok } | { error, detail? }   (DESIGN §16; optional for the platform) a new checked
//                           operator loadout from room.loadout. Accepted only during INFO_CHECK (the briefing's
//                           干员调配 entry); afterwards the match's loadout is locked (WRONG_PHASE).
// onLeave(playerId)         The human quit permanently (g.leave, room.leave, or the 10-minute reconnect
//                           window expired). They will never return under this playerId in this match;
//                           treat as quit (AI takes over / eliminated per DESIGN). No onDisconnect follows.
// dispose()                 Stop every timer/interval and release resources. Idempotent. After dispose the
//                           platform ignores send/broadcast/onEnd from this instance.
// Emi 外部观众通过 addObserver/watchObserver/removeObserver 复用公开棋盘与只读战斗副本；
// 不进入玩家席位、authority 或个人排位结算链路。
//
// Bot seats never produce intents or hooks: the match drives bots itself (server/match/bot.js).
// Messages the match emits are the S2C 'm.*' / 'b.*' frames of DESIGN §8.2 (room.* frames are platform-owned).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Client-side combat (DESIGN §14; the default): every battle is described by a JSON BattleSpec (server/sim/spec.js).
// A normal field's owner (a connected human) simulates it in the browser and reports b.progress / b.result; a 联防 or
// boss pair field is simulated by its lowest-seat connected human (the other humans run display-only replicas).
// Bots, departed / disconnected players and fields without a connected human are simulated by the server: normal and
// 联防 fields headlessly at once (the result is released at the battle's natural end for the teammates' progress UI),
// boss fields in real time without snapshots (they share the pool). A silent authority (deadline = time limit + 15 s)
// or a disconnected one loses the field to the server, which re-simulates the spec; an implausible b.result is
// replaced by the server's own simulation (fields.js validateClientResult). The shared boss pool, the team LP and the
// overtime drain live here (b.pool ≤ 4 Hz, b.end; m.public follows a boss fight at ~1 Hz); the first end condition the
// server registers decides the Final Assault (pool 0 → victory, team LP 0 → defeat; nothing reported after a defeat is
// credited — _finalEnding, user playtest #6 item 5). No b.snap / b.ev is sent in
// this mode; g.watch hands out specs. battleIds are `<seed36>[-<matchNo36>].<round>.<seq>[.<fieldId>]` (≤ 64 chars):
// unique across the matches of a room, so a report that crossed into the next match is ignored like any stale one; a
// duplicate b.result (a browser re-sending one it believes lost) is answered ok and changes nothing.
// Solo pause (g.pause { on }, setPause): freezes the field clocks, result deadlines, server release timers, the boss
// clock and the server pacers; m.public.paused; resume shifts every clock / deadline by the pause.
// Live LP (user playtest #3 item 2): during COMBAT / 联防 m.public players[].pendingLp = min(lpCapPerRound, the counted
// leaks of the player's own battle so far) (_pendingLpView; omitted when 0) — the teammates' rows of the team panel
// show lp − pendingLp; the settlement lands with the SETTLE view, where it is gone. 联防 (user playtest #6 item 7): a
// leaker's players[].uniteLeft = its enemies still standing on the 联防 field (not spawned yet, alive, or through again;
// uncapped, live: the authority's b.progress `left`, the server-run timeline or battle; exact once the field has its
// result — _uniteLeft) and pendingLp = min(lpCapPerRound, uniteLeft): the counter falls as the helpers kill them (and
// rises when one of them splits or summons — the children are billed to the same leaker).
// User playtest #4: a match with a single human (独立模拟, or a 同盟 room started alone / with AI teammates) times no
// phase outside its battles (soloUntimed); the co-op strategy draft has ONE countdown — BAND_TURN_SECONDS per turn,
// published as m.public.deadline — AI seats pick at once and a turn that runs out takes the highlighted strategy
// (g.bandFocus → timeoutBand); g.unitStats answers m.unitStats: the stats the board's units start their next battle with.
//   opts.clientCombat  default true (env SP_COMBAT=server → false: the legacy server-run + snapshot streaming mode)
//   opts.verify        'off' | 'sample' | 'all' (env SP_VERIFY, default 'off'): re-simulate accepted client results
//                      ('sample': ~1 in 8, in a later callback, mismatches logged; 'all': before accepting — the
//                      server's result wins on a mismatch)
//
// Engine-only extra options (tests / tools; the lobby never passes them):
//   opts.scheduler     RealScheduler (default, uses opts.now) | VirtualScheduler (./scheduler.js)
//   opts.registry      MetaRegistry (default: built-ins + content, ./effectsMeta.js getDefaultRegistry())
//   opts.BattleClass   Battle implementation (default server/sim/Battle.js; tests inject test/match/fakeBattle.js)
//   opts.battleContent 'full' | 'generic' | 'none' (sim content mode, default 'full')
//   opts.timerScale    multiplier on every real-time phase timer (default 1)
//   opts.combatSpeed   game seconds per real second while battles run in real time (default 2, the forced 2×)
//   opts.botRehearsal  candidate layouts a bot simulates per prep before placing (default 3, 0 = heuristic only;
//                      a whole battle per candidate: ~20–300 ms of CPU each, see server/match/bot.js createRehearsal)
//   opts.botSliceMs    wall-clock ms of rehearsal per scheduler callback (default 8 with a real scheduler, unbounded
//                      with a virtual one); the rest runs in later callbacks (scheduleBotPrep)
//   opts.headlessSliceMs  wall-clock ms per callback of a server-run normal / 联防 field (client-side combat: bots,
//                      takeovers; default 8 with a real scheduler, at once with a virtual one)
// Seats may be all bots (tools/matchrun.mjs); the lobby always has ≥ 1 human.
//
// Diagnostics: m.errors / m.errorCount (engine), m.dispatcher.errors / .errorsByKey (meta handlers), m.simErrors
// (count reported by battle results) and m.simErrorLog (Map key → { label, who, message, stack, battles, count }
// of the unique errors each finished battle recorded in battle.errors). tools/matchrun.mjs --errors prints them.
//
// Disconnect / leave policy (research 06 §10.3 + DESIGN §6.6):
//   * disconnected human: the seat keeps playing its last lineup; draft turns and prep auto-resolve at their
//     deadlines (band → 华法琳, 机变 → a random remaining card, prep → auto-ready with temp auto-resolved). Nothing is
//     bought for them unless they toggled "AI 托管" (g.autoplay { on: true }), which lets the bot play the seat.
//   * departed human (onLeave): 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3) — every
//     copy the seat holds returns to the shared pool at once, the seat leaves the round loop, the Final Assault
//     pairing and the boss pool; its own running normal battle is force-ended. The seat shows status 'left'. When no
//     human is left at all the match ends ('abandoned'); when nobody alive is left it ends as 'eliminated'.

import { randomBytes } from "node:crypto";

import { isRankedMatch } from "../../shared/ranks.js";
import { poolGroupSizes } from '../../shared/playerCapacity.js';
import { cyclopsGroupSizes } from '../../shared/playerCapacity.js';
import { PHASE, modeIdFor, ENDLESS_VARIANT, ENDLESS_MODE_ID } from "../../shared/constants.js";
import { Battle } from "../sim/Battle.js";

import { createRng, deriveSeed } from "../sim/rng.js";
import { GameData, endlessGdView } from "./gamedata.js";
import { RealScheduler } from "./scheduler.js";
import { SharedPool, SharedItemPool, drawDisabledBonds } from "./pool.js";
import { PlayerState } from "./PlayerState.js";

import { EffectDispatcher, getDefaultRegistry } from "./effectsMeta.js";

import { setupMatchWaves } from "./waves.js";

import { GAME_SPEED, HEADLESS_SLICE_MS } from "./fields.js";

import { BOT_REHEARSAL_DEFAULT, BOT_SLICE_MS, FLOW_TICKER_PRIORITY, env, envClientCombat, parseVerify, noopLog, DELAYS, BAND_TURN_SECONDS, dataSourceFor } from "./match/common.js";
export { FLOW_TICKER_PRIORITY, parseVerify, DELAYS, BAND_TURN_SECONDS } from './match/common.js';
import { MatchBoss } from "./match/bossRounds.js";
import { MatchClientCombat } from "./match/clientCombat.js";
import { MatchCombat } from "./match/combat.js";
import { MatchInfra } from "./match/infra.js";
import { MatchIntents } from "./match/intents.js";
import { MatchMessaging } from "./match/messaging.js";
import { MatchPause } from "./match/pause.js";
import { MatchSetupVote } from "./match/setupVote.js";
import { MatchPhases } from "./match/phases.js";
import { MatchPlatform } from "./match/platform.js";
import { MatchPersonalChoice } from "./match/personalChoice.js";
import { MatchPrep } from "./match/prep.js";
import { MatchReports } from "./match/reports.js";
import { MatchSettle } from "./match/settle.js";
import { MatchSpDraft } from "./match/spDraft.js";
import { MatchUnite } from "./match/unitePhase.js";
import { MatchViews } from "./match/views.js";
import { MatchWatch } from "./match/watch.js";
export class Match {
  constructor(opts) {
    if (!opts || !Array.isArray(opts.seats) || opts.seats.length === 0) throw new TypeError('Match: seats required');
    if (typeof opts.send !== 'function' || typeof opts.broadcast !== 'function' || typeof opts.onEnd !== 'function') {
      throw new TypeError('Match: send/broadcast/onEnd callbacks required');
    }
    this.opts = opts;
    this.aiPicksLast = opts.aiPicksLast === true;
    this.setupRevision = 0;
    this.setupVote = null;
    this._setupVoteSeq = 0;
    this._lastSetupVoteAt = -Infinity;
    this._infoAdvanceTimer = null;
    this.roomCode = opts.roomCode ?? '----';
    this.mode = opts.mode === 'solo' ? 'solo' : 'coop';
    this.variant = this.mode === 'coop' && (opts.variant === 'entertainment_multi' || opts.variant === 'entertainment_cyclops' || opts.variant === ENDLESS_VARIANT) ? opts.variant : null;
    this.isEntertainmentMulti = this.variant === 'entertainment_multi';
    /** 独眼巨人冲锋：完全独立的娱乐模式（mode_cyclops），规则与普通模式/娱乐多人互不影响。 */
    this.isCyclops = this.variant === 'entertainment_cyclops';
    // 舟铲铲沿用玩家在大厅选择的难度；模式专属规则与难度解耦，不能覆盖 difficulty。
    this.rankedStore = opts.rankedStore || null;
    this.matchId = opts.matchId || randomBytes(16).toString('hex');
    this.modeId = this.isCyclops ? 'mode_cyclops' : (this.variant === ENDLESS_VARIANT ? ENDLESS_MODE_ID : opts.modeId || modeIdFor(this.mode, opts.difficulty));
    this.seed = (Number(opts.seed) >>> 0) || 1;
    this.log = opts.log || noopLog;
    this.sendFn = opts.send;
    this.broadcastFn = opts.broadcast;
    this.onEndFn = opts.onEnd;
    this.completeMatch = opts.completeMatch || null;
    this.archiveSeats = structuredClone(opts.seats || []);
    this.data = opts.data && typeof opts.data === 'object' ? opts.data : {};
    this.gd = new GameData(this.data, this.modeId);
    this.gd.isEntertainmentMulti = this.isEntertainmentMulti;
    this.gd.isCyclops = this.isCyclops;
    if (this.isCyclops) this.gd.setCyclopsDifficulty(opts.difficulty);
    this.isEndless = this.gd.isEndless;
    if (this.isEndless) this.gd = endlessGdView(this.gd);
    if (!this.difficulty) this.difficulty = this.gd.difficulty;
    // 排位资格依赖已解析的实际难度，必须在难度初始化后判定。
    this.ranked = !this.variant && isRankedMatch(opts.ranked, this.difficulty);
    this.isSolo = this.mode === 'solo' || this.gd.isSolo;
    this.ownsScheduler = !opts.scheduler;
    this.sched = opts.scheduler || new RealScheduler({ now: opts.now || Date.now, onError: (e) => this.reportError('timer', e) });
    this.registry = opts.registry || getDefaultRegistry();
    this.dispatcher = new EffectDispatcher(this, this.registry);
    this.BattleClass = typeof opts.BattleClass === 'function' ? opts.BattleClass : Battle;
    this.battleContent = opts.battleContent || 'full';
    this.cs = typeof opts.cs === 'string' ? opts.cs : null;
    this.vs = typeof opts.vs === 'string' ? opts.vs : null;
    this.requireCs = opts.requireCs === true && !!this.cs;
    this.diyKitted = Array.isArray(opts.diyKitted) ? Object.freeze([...opts.diyKitted]) : null;
    // Workers run the same built-in East engine/data; virtual clocks and injected engines stay local.
    this.workerPool = !this.sched.virtual && this.BattleClass === Battle &&
      ['full', 'generic', 'none'].includes(this.battleContent) ? opts.workerPool || null : null;
    this.workerStats = { submitted: 0, completed: 0, failed: 0, rejected: 0, cancelled: 0 };
    this._workerTasks = new Set();
    this._workerAuditAt = -Infinity;
    this.timerScale = Number.isFinite(opts.timerScale) && opts.timerScale >= 0 ? opts.timerScale : 1;
    this.gameSpeed = Number.isFinite(opts.combatSpeed) && opts.combatSpeed > 0 ? Math.min(opts.combatSpeed, 200) : GAME_SPEED;
    /** layouts a bot rehearses per prep with the real simulation (bot.js; 0 = heuristic placement only) */
    this.botRehearsal = Number.isInteger(opts.botRehearsal) && opts.botRehearsal >= 0 ? Math.min(opts.botRehearsal, 8) : BOT_REHEARSAL_DEFAULT;
    /** wall-clock budget of one rehearsal slice (scheduleBotPrep) */
    this.botSliceMs = Number.isFinite(opts.botSliceMs) && opts.botSliceMs > 0 ? opts.botSliceMs : this.sched.virtual ? Infinity : BOT_SLICE_MS;
    this.ds = dataSourceFor(this.data);
    /** client-side combat (DESIGN §14) — see the header */
    this.clientCombat = opts.clientCombat != null ? !!opts.clientCombat : envClientCombat();
    this.verifyMode = parseVerify(opts.verify ?? env('SP_VERIFY'));
    /** wall-clock ms per slice of a server-run normal / 联防 field (virtual time: at once) */
    this.headlessSliceMs = Number.isFinite(opts.headlessSliceMs) && opts.headlessSliceMs > 0 ? opts.headlessSliceMs : this.sched.virtual ? Infinity : HEADLESS_SLICE_MS;
    this.verifyStats = { checked: 0, mismatches: 0, rejected: 0, takeovers: 0 };
    this._battleSeq = 0;
    /** solo pause (g.pause, DESIGN §14): the field clocks / deadlines are frozen while true (m.public.paused) */
    this.paused = false;
    this._pausedAt = 0;
    /** real ms spent paused this match (diagnostics) */
    this.pausedMs = 0;
    /** boss rounds (client-side combat): the throttled m.public refresh (_bossPublic) */
    this._bossPubTimer = null;
    this._bossPubAt = -Infinity;
    this._bossClockOn = false;
    /**
     * battleId prefix (DESIGN §14): the seed (+ the room's match number) — a b.progress / b.result that crossed into the
     * next match of the room (the same socket, the same field ids) never names a battle of this match.
     */
    this.battlePrefix = `${this.seed.toString(36)}${Number.isInteger(opts.matchNo) && opts.matchNo > 0 ? `-${opts.matchNo.toString(36)}` : ''}`;
    this._progressTimer = null;
    this._bossClock = null;
    this._lastPoolAt = -Infinity;
    this._poolTimer = null;
    this._lastPoolKey = '';
    this.pacer = null;

    const rng = (name) => createRng(deriveSeed(this.seed, name));
    this.rngSetup = rng('setup');
    this.rngShop = rng('shop');
    this.rngWaves = rng('waves');
    this.rngDraft = rng('draft');
    this.rngBots = rng('bots');
    this.rngMeta = rng('meta');

    /** @type {Map<string, PlayerState>} */
    this.players = new Map();
    // 开局段位只保留展示字段，结算或其他对局更新档案不会改变本局快照。
    this.rankSnapshots = new Map();
    const seen = new Set();
    for (const s of opts.seats) {
      if (!s || typeof s.playerId !== 'string' || seen.has(s.playerId)) continue;
      seen.add(s.playerId);
      this.players.set(s.playerId, new PlayerState(this, s));
      if (this.ranked && !s.isBot && this.rankedStore) {
        const { icon, label } = this.rankedStore.summary(s.aid, s.name, s.debugAuthorized === true).rank;
        this.rankSnapshots.set(s.playerId, { icon, label });
      }
    }
    if (!this.players.size) throw new TypeError('Match: seats required');
    this.order = [...this.players.values()].sort((a, b) => a.seat - b.seat);
    /**
     * Exactly one human seat at the start (独立模拟, or a 同盟 room started alone / with AI teammates only): nobody waits
     * on anybody, so no phase outside a battle is timed — soloUntimed (user playtest #4 item 3). The mode's own rules
     * (draft order and skip, 6 机变 cards, 联防 …) stay.
     */
    // 补偿固定开局真人+AI总参赛人数，观众不入order；真人数只用于原单人无计时机制。
    Object.defineProperty(this, 'startingParticipantCount', { value: this.order.length });
    Object.defineProperty(this, 'startingHumanCount', { value: this.order.filter((p) => !p.isBot).length });
    this.loneHuman = this.startingHumanCount === 1;

    // per-match setup (DESIGN §6.5)
    const setup = setupMatchWaves(this.gd, this.rngSetup);
    this.stageId = setup.stageId;
    this.stage = this.stageId ? this.gd.stage(this.stageId) : null;
    this.factions = setup.factions;
    this.bossId = setup.bossId;
    this.hiddenBossId = setup.hiddenBossId;
    const bans = this.isCyclops ? { drawn: [], staticOff: [], banned: [] } : drawDisabledBonds(this.gd, this.rngSetup);
    this.disabledBonds = bans.drawn;
    this.staticInactiveBonds = bans.staticOff;
    this.bannedChess = bans.banned;
    // 独眼巨人冲锋：每 4 人一组共享池（不足 4 人一组）；全干员池（含 hidden、无 kit 干员）由 GameData 提供
    const sizes = this.isEntertainmentMulti ? poolGroupSizes(this.order.length)
      : this.isCyclops ? cyclopsGroupSizes(this.order.length) : [this.order.length];
    let offset = 0;
    this.poolGroups = sizes.map((size, i) => {
      const members = this.order.slice(offset, offset += size);
      const pool = new SharedPool(this.gd, { banned: bans.banned, groupSize: this.isEntertainmentMulti || this.isCyclops ? size : 4, cyclops: this.isCyclops });
      const id = `g${i + 1}`;
      for (const ps of members) { ps.poolGroupId = id; ps.pool = pool; }
      return { id, playerIds: members.map((ps) => ps.playerId), pool };
    });
    this.pool = this.poolGroups[0].pool;
    this.itemPool = new SharedItemPool(this.gd, () => this.order);
    this.draftSeq = 0;
    const diyOff = new Set([...bans.drawn, ...bans.staticOff]);
    for (const ps of this.order) ps.initDiyStock(diyOff);

    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.deadline = 0;
    /** Final Assault / Hidden Core: ms epoch when the overtime drain starts (m.public.overtimeAt) */
    this.overtimeAt = 0;
    this.uidSeq = 0;
    this.ended = false;
    this.disposed = false;
    this.startedAt = this.sched.now();
    /** @type {Set<any>} */
    this._timers = new Set();
    this._phaseTimer = null;
    this._turnTimer = null;
    this._pubDirty = false;
    this._pubTimer = null;
    this._lastPubAt = -Infinity;
    this._lastPubJson = '';
    /** @type {Set<PlayerState>} */
    this._privDirty = new Set();
    this.errors = [];
    this.errorCount = 0;
    this.simErrors = 0;
    /** @type {Map<string, { label: string, who: string, message: string, stack: string|null, battles: number, count: number }>} */
    this.simErrorLog = new Map();
    this._prepEndQueued = false;

    this.draft = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    this.fields = [];
    this.runner = null;
    /** playerId → fieldId */
    this.watchers = new Map();
    this.observers = new Map();
    this.lastResults = new Map();
    this.unitePlan = null;
    /** server-run 联防: the leakers' counts last published (_uniteTick) */
    this._uniteLeftKey = null;
    /** 联防: { plan, bounds } — per leaker the most survivors settlement can bill (_uniteLeft's clamp) */
    this._uniteBounds = null;
    this.teamLp = null;
    this.bossPool = null;
    this.hiddenLayerSum = 0;
    this.hiddenReached = false;
    this.outcome = null;
    this._turnToken = 0;
  }
}
for (const part of [MatchBoss, MatchClientCombat, MatchCombat, MatchInfra, MatchIntents, MatchMessaging, MatchPause, MatchSetupVote, MatchPhases, MatchPlatform, MatchPersonalChoice, MatchPrep, MatchReports, MatchSettle, MatchSpDraft, MatchUnite, MatchViews, MatchWatch]) {
  for (const key of Reflect.ownKeys(part.prototype)) {
    if (key === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Match.prototype, key)) throw new Error(`Match.${String(key)} is defined twice`);
    Object.defineProperty(Match.prototype, key, Object.getOwnPropertyDescriptor(part.prototype, key));
  }
}

