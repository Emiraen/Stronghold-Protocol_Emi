// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.addBot, room.removeBot, room.start. ▸ Changing the difficulty
//     un-readies the other humans. ▸ room.start requires every other human to be connected and ready;
//     the host's start counts as the host's ready (the host may still toggle room.ready for display).
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, AI
//     seats, start), leave it, or a new match starts. A human removed by the lobby grace gets them right after
//     `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the lobby drops the
//     match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).

import { installPluginLobby } from './plugins/lobby.js';
import { randomBytes, randomInt } from 'node:crypto';
import { ERR, MAX_SEATS, ENTERTAINMENT_DEFAULT_SEATS, ENTERTAINMENT_CAPACITIES, CYCLOPS_DEFAULT_SEATS, CYCLOPS_CAPACITIES, ENDLESS_VARIANT, ENDLESS_MODE_ID, ROOM_CODE_LEN, DIFFICULTIES, modeIdFor } from '../shared/constants.js';
import { isRankedMatch, RANKED_DIFFICULTIES } from '../shared/ranks.js';
import { isSpecialNameCard, canUseSpecialNameCard } from '../shared/nameCards.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { checkNotOwned, checkDiyPicks, checkLoadout, checkLoadoutOps, cultivationCharIds, loadoutEntriesForWire, checkPresentation, defaultPresentation } from '../shared/protocol.js';
import { encode, sendOptions, clearDeferred, isErrCode, sendRaw, sendSession, terminateSocket } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { RankedStore } from './rankedStore.js';
import { HistoryStore } from './historyStore.js';
import { PlayerStore } from './playerStore.js';
import { ChatHub } from './chat.js';
import { CODE_PREFIXES, SERVER_NAMES, roomServer } from './regions.js';
import { seatEntries, restoreLobbyRooms, restoreLobbyMatch, adoptRestoredMatch } from './matchRestore.js';
import { parseTestModeEnv, testModeGate, unrecognizedTestMode } from './testMode.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
});

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']);

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null }} Seat
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

function checkedOperatorSettings(ops, data) {
  const ids = cultivationCharIds(data?.chess, data?.backups);
  return checkLoadoutOps(ops, (id) => ids.has(id));
}
function freezeOperatorSettings(ops) {
  return Object.freeze(Object.fromEntries(Object.entries(ops || {}).map(([id, entry]) =>
    [id, Object.freeze({ potential: entry.potential, cultivate: entry.cultivate })])));
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now @param {boolean} [ranked] */
  constructor(code, mode, difficulty, now, ranked = false, variant = null, capacity = ENTERTAINMENT_DEFAULT_SEATS) {
    this.code = code;
    this.mode = mode;
    this.variant = mode === 'coop' && (variant === 'entertainment_multi' || variant === 'entertainment_cyclops' || variant === ENDLESS_VARIANT) ? variant : null;
    this.capacity = this.variant === 'entertainment_cyclops' ? (CYCLOPS_CAPACITIES.includes(capacity) ? capacity : CYCLOPS_DEFAULT_SEATS)
      : this.variant ? capacity : MAX_SEATS;
    this.difficulty = difficulty;
    this.aiPicksLast = false;
    /** 排位意愿：跨难度保留；只有险境~终极的实际对局计分。 */
    this.ranked = !this.variant && !!ranked;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(this.capacity).fill(null);
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    this.spectators = new Set();
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    /** Matchmaking queue state, or null outside the queue. */
    this.matchFill = null;
    this.matchCandidate = null;
    this.content = null;
    this.disposed = false;
  }

  get modded() { return this.content?.vanilla === false; }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /** `room.state` frame (DESIGN §8.1) plus `inMatch`. */
  toState(rankedStore = null) {
    return {
      t: 'room.state',
      code: this.code,
      serverId: roomServer(this.code),
      hostId: this.hostId,
      mode: this.mode,
      variant: this.variant,
      capacity: this.capacity,
      difficulty: this.difficulty,
      ranked: !!this.ranked,
      ...(this.test === true ? { test: true } : {}),
      ...(this.content ? { content: this.content } : {}),
      aiPicksLast: this.aiPicksLast,
      inMatch: !!this.match,
      matchCandidate: this.matchCandidate ? {
        id: this.matchCandidate.id, deadline: this.matchCandidate.deadline,
        pool: this.matchCandidate.ranked ? 'ranked' : 'normal',
        allowed: this.matchCandidate.allowed, botCount: this.matchCandidate.botCount,
        humans: this.matchCandidate.teams.flatMap((team) => team.members.map(({ playerId, name }) => ({
          playerId, name, confirmed: this.matchCandidate.confirmed.has(playerId),
          difficulty: this.matchCandidate.votes.get(playerId) || null,
        }))),
        counts: Object.fromEntries(this.matchCandidate.allowed.map((d) => [d,
          [...this.matchCandidate.votes.values()].filter((v) => v === d).length])),
      } : null,
      matchFill: this.matchFill ? { searching: true, id: this.matchFill.id, since: this.matchFill.since,
        available: this.matchFill.available,
        vote: this.matchFill.vote ? { id: this.matchFill.vote.id, yes: this.matchFill.vote.votes.size,
          total: this.activeHumans().length, votes: [...this.matchFill.vote.votes] } : null } : null,
      seats: this.seats.map((s) => {
        if (!s) return null;
        const summary = this.ranked && !s.isBot && rankedStore
          ? rankedStore.summary(s.aid, s.name) : null;
        const rank = summary?.rank;
        return {
          seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot,
          card: s.card || '',
          cardSkin: s.cardSkin || '',
          ready: s.ready, connected: s.connected && !s.left,
          ...(this.modded && !s.isBot ? {content:s.content || 'loading'} : {}),
          // 仅公开展示字段，不传播账号、重连凭据或隐藏分。
          ...(rank ? { rank: { label: rank.label, icon: rank.icon, points: rank.points } } : {}),
          ...(summary?.rankPyramid ? { rankPyramid: summary.rankPyramid } : {}),
        };
      }),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, options = {}, ranked = null, history = null, players = null, profiles = null, serverId = 'main', workerPool = null, content = null, plugins = null, hosts = null }) {
    this.registry = registry;
    this.profiles = profiles;
    this.serverId = serverId;
    this.workerPool = workerPool;
    this.vanilla = content ? Object.freeze({cs:content.cs,vanilla:true,plugins:[]}) : null;
    this.plugins = plugins; this.hosts = hosts; this.autoApplyPlugins = null;
    this.checkpointListeners = new Set();
    this.draining = false;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    /** ranked profiles (server/rankedStore.js); default: in-memory (server/index.js passes the persistent one) */
    this.ranked = ranked || new RankedStore({ file: null, now, log });
    this.history = history || new HistoryStore({ file: null, now, log });
    this.players = players || new PlayerStore({ file: null, now, log });
    this.chat = new ChatHub({ memberSink: (frame) => {
      for (const peer of this.registry.all()) if (peer.connected) sendSession(peer, frame);
    } });
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    const rawTestMode = options.testMode ?? process.env.SP_TEST_MODE;
    this.testMode = parseTestModeEnv(rawTestMode);
    this.testUnrecognized = unrecognizedTestMode(rawTestMode);
    this.testEnabled = false; this.testHost = ''; this.testWarn = this.testUnrecognized;
    if (options.testHost != null) this.setTestHost(options.testHost);
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    // Only explicitly published invitations enter the public recruitment directory.
    this.recruitmentRooms = new Map();
    this.recruitmentFrame = encode({ t: 'recruitment.snapshot', rooms: [] });
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
    /** Waiting room codes. The room itself owns its queue and vote state. */
    this.matchQueue = new Set();
    this.matchVoteSeq = 0;
    this.matchCandidates = new Map();
    this.matchTimer = null;
    this.offPluginStale = plugins?.onStale?.((id, ids) => this.notePluginsChanged(id, ids, 'visual')) || null;
    this.offPluginContentStale = plugins?.onContentStale?.((id, ids) => this.notePluginsChanged(id, ids, 'content')) || null;
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  setTestHost(host) {
    this.testHost = typeof host === 'string' ? host : '';
    const gate = testModeGate(this.testMode, this.testHost);
    this.testEnabled = gate.enabled === true;
    this.testWarn = this.testUnrecognized || gate.warn;
    return { enabled: this.testEnabled, warn: this.testWarn };
  }

  subscribeCheckpoint(listener) {
    this.checkpointListeners.add(listener);
    return () => this.checkpointListeners.delete(listener);
  }

  checkpoint(code, match) {
    for (const listener of this.checkpointListeners) {
      try { listener(code, match); } catch (error) { this.log.warn('[persist] checkpoint listener failed', error); }
    }
  }

  restoreRooms(docs, options = {}) { return restoreLobbyRooms(this, docs, { ...options, Room }); }
  restoreMatch(room, checkpoint) { return restoreLobbyMatch(this, room, checkpoint); }

  async restoreCompletedMatch(room, checkpoint) {
    const matchId = checkpoint?.matchId || room.restoredMatchContext?.matchId;
    if (!matchId) return false;
    for (const seat of room.activeHumans()) {
      const detail = await this.history.detail(seat.aid, matchId, seat.playerId);
      if (!detail?.result) continue;
      const { t, ...summary } = detail.result;
      room.lastSummary = summary;
      const frames = new Map(room.activeHumans().map((s) => [s.playerId, encode({ ...detail.result, playerId: s.playerId })]));
      room.replay = { publicFrame: null, frames, pending: new Set(frames.keys()) };
      room.matchKey = null;
      for (const s of room.activeHumans()) s.ready = false;
      delete room.restoredMatchContext;
      this.log.info(`[lobby] ${room.code} restored completed match ${matchId} from committed history`);
      return true;
    }
    return false;
  }

  beginDrain() {
    this.draining = true;
    if (this.matchTimer) { clearInterval(this.matchTimer); this.matchTimer = null; }
    for (const c of this.matchCandidates.values()) if (c.timer) clearTimeout(c.timer);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.graceTimers.clear(); this.resyncTimers.clear();
    for (const room of this.rooms.values()) {
      room.match?.sched?.suspend?.();
      room.match?._cancelWorkerTasks?.();
    }
  }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
    }
    return { rooms: this.rooms.size, matches, humans, bots };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  async onHello(session, { resumed, repeat, previousAid = session.profileBound ? session.aid : null }) {
    const socket = session.ws;
    const generation = session.profileGeneration = (session.profileGeneration || 0) + 1;
    const active = () => session.connected && session.ws === socket && session.profileGeneration === generation
      && (!this.profiles || this.profiles.validSession(session));
    const identityLocked = !!session.spectatorCode || !!this.roomOf(session)?.match;
    const name = session.name;
    if (!this.profiles && (!identityLocked || !session.profileBound)) {
      const source = this.players;
      const aid = await source.resolveName(name, session.clientAid || session.aid, {
        ranked: this.ranked, history: this.history, registry: this.registry, joining: session,
      });
      if (!active()) return;
      session.aid = aid;
      session.profileBound = true;
      session.profileName = name;
    }
    if (!this.profiles) await this.players.record(session.aid, name);
    if (!active()) return;
    await this.profiles?.refresh(session.aid);
    if (!active()) return;
    const stored = this.players.getLoadout(session.aid);
    let loadoutResult = OK;
    if (stored || previousAid !== session.aid) {
      const data = this.safeData();
      const checked = checkLoadout(stored?.entries || {}, (id) => lookup('chess', id, data));
      const ops = checkedOperatorSettings(stored?.ops, data);
      loadoutResult = this.applySessionLoadout(session, freezeLoadout(checked.loadout || {}), freezeOperatorSettings(ops.ops || {}));
    }
    await this.initializePresentation(session);
    if (!active()) return;
    session.profileReady = true;
    this.sendRecruitment(session);
    this.sendLoadoutState(session, { locked: loadoutResult.error === ERR.WRONG_PHASE || loadoutResult.error === ERR.ROOM_STARTED });
    this.applySessionPresentation(session, this.presentationFor(session));
    this.sendPresentationState(session);
    if (session.aid && this.ranked) {
      sendSession(session, { t: 'rank.me', ...this.ranked.summary(session.aid, session.name, session.debugAuthorized === true),
        profileId: this.players.profiles.get(session.aid)?.id || null });
    }
    // Empty chat needs no frame; preserve the existing result-replay order on reconnect.
    if (!repeat) {
      const items = this.profiles ? await this.profiles.chatHistory() : this.chat.history();
      if (!active()) return;
      const ids = new Set(items.map((item) => item.id));
      if (items.length) sendSession(session, { t: 'chat.history', items });
      for (const frame of session.pendingChat || []) if (!ids.has(frame.id)) {
        ids.add(frame.id); sendSession(session, frame);
      }
      session.pendingChat = [];
      session.initializingChat = false;
    }
    if (session.spectatorCode) {
      const watched = this.spectatorRoom(session);
      if (watched) this.resync(session, true);
      else sendSession(session, { t: 'spectator.closed', reason: 'ended' });
      return;
    }
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      this.sendPendingResult(session);
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    session.pendingResultGeneration++;
    session.pendingResultInFlight = 0;
    session.pendingResultFailed = false;
    const seat = room.seatOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.match && seat.aid !== session.aid) { seat.aid = session.aid; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, true);
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  async onMessage(session, msg) {
    if (session.spectatorCode && (msg.t.startsWith('room.') || msg.t.startsWith('g.') || msg.t.startsWith('b.') || msg.t.startsWith('chat.'))) {
      return fail(ERR.BAD_TARGET, '观战身份仅可查看');
    }
    switch (msg.t) {
      case 'session.release': return this.releaseSession(session);
      case 'spectator.list': return this.listSpectators(session, msg);
      case 'recruitment.list': this.sendRecruitment(session, msg.rid); return OK;
      case 'spectator.join': return this.joinSpectator(session, msg);
      case 'spectator.leave': return this.leaveSpectator(session);
      case 'spectator.watch': {
        const room = this.spectatorRoom(session);
        return room ? room.match.watchObserver(session.playerId, msg.fieldId, msg.playerId) : fail(ERR.NOT_IN_ROOM);
      }
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.card': return this.setCard(session, msg);
      case 'room.setAiPicksLast': return this.setAiPicksLast(session, msg);
      case 'room.rerollSetup': return this.rerollSetup(session, msg);
      case 'room.cancelReroll': return this.rerollSetup(session, msg, true);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.setCapacity': return this.setCapacity(session, msg);
      case 'room.cancelReady': return this.cancelReady(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.kick': return this.kick(session, msg);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.setPlugins': return this.setPlugins(session,msg);
      case 'room.setMode': return this.setMode(session,msg);
      case 'room.contentReady': return this.contentReady(session,msg);
      case 'room.start': return this.start(session);
      case 'room.matchFill': return this.setMatchFill(session, msg);
      case 'room.aiFillVote': return this.aiFillVote(session, msg);
      case 'room.matchConfirm': return this.matchConfirm(session, msg);
      case 'room.matchDifficultyVote': return this.matchDifficultyVote(session, msg);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      case 'profile.loadout': return this.profileLoadout(session, msg);
      case 'profile.presentation': return this.profilePresentation(session, msg);
      case 'chat.send': return this.sendChatText(session, msg);
      case 'chat.invite': return this.sendChatInvite(session);
      case 'rank.list': {
        const socket = session.ws;
        const items = await (this.profiles || this.ranked).leaderboard();
        const radiantThreshold = this.ranked.radiantThreshold(items);
        if (session.connected && session.ws === socket) sendSession(session, { t: 'rank.list', rid: msg.rid, items, radiantThreshold });
        return OK;
      }
      case 'history.list': return this.historyList(session, msg);
      case 'history.detail': return this.historyDetail(session, msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  sendChatText(session, msg) {
    const room = this.roomOf(session);
    if (msg.channel === 'match') {
      if (!session.connected || !room?.match || !room.matchCtx?.chat || msg.matchId !== room.matchCtx.matchId) return fail(ERR.NOT_IN_ROOM);
      return room.matchCtx.chat.publishText(session, msg.text, this.now());
    }
    if (room?.match || msg.matchId) return fail(ERR.BAD_TARGET, '对局中请使用本局频道');
    return this.profiles ? this.profiles.publishChat(session, { kind: 'text', text: msg.text })
      : this.chat.publishText(session, msg.text, this.now());
  }

  sendMatchChat(room, session) {
    const ctx = room.matchCtx;
    if (ctx?.chat) sendSession(session, { t: 'chat.history', channel: 'match', matchId: ctx.matchId, items: ctx.chat.history() });
  }

  spectatorRoom(session) {
    const room = this.rooms.get(session.spectatorCode);
    if (!room?.match || room.matchCtx?.matchId !== session.spectatorMatchId || !room.spectators.has(session.playerId)) {
      if (room) { room.spectators.delete(session.playerId); room.match?.removeObserver?.(session.playerId); }
      session.spectatorCode = null;
      session.spectatorMatchId = null;
      return null;
    }
    return room;
  }

  spectatorItems() {
    const items = [];
    for (const room of this.rooms.values()) {
      if (!room.match || !room.matchCtx?.live || typeof room.match.addObserver !== 'function') continue;
      if (room.test) continue;
      const pub = room.match.publicView();
      if (!pub || !Array.isArray(pub.players)) continue; // Hosted matches publish their first view asynchronously.
      items.push({ serverId: this.serverId, code: room.code, matchId: room.matchCtx.matchId, mode: room.mode, variant: room.variant, difficulty: room.difficulty,
        ranked: room.matchCtx.ranked, startedAt: room.matchCtx.startedAt, round: pub.round, phase: pub.phase,
        spectators: room.spectators.size, players: pub.players.map(({ playerId, name, isBot, alive, lp }) => ({ playerId, name, isBot, alive, lp })) });
    }
    return items;
  }

  listSpectators(session, msg) {
    const localItems = this.spectatorItems();
    const directory = this.profiles?.spectatorDirectory?.(localItems) || { items: localItems };
    sendSession(session, { t: 'spectator.list', ...(Number.isInteger(msg.rid) ? { rid: msg.rid } : {}), ...directory });
    return OK;
  }

  sendSpectatorState(room, session) {
    sendSession(session, { t: 'spectator.state', code: room.code, matchId: room.matchCtx.matchId,
      mode: room.mode, variant: room.variant, difficulty: room.difficulty, readOnly: true,
      seats: room.seats.filter(Boolean).map((seat) => ({ playerId: seat.playerId,
        card: seat.card || '', cardSkin: seat.cardSkin || '' })),
      ...(room.content ? { content: room.content } : {}) });
  }

  joinSpectator(session, { code, matchId }) {
    if (this.roomOf(session)) return fail(ERR.ROOM_STARTED, '请先离开同盟再观战');
    const room = this.rooms.get(code);
    if (room?.test) return fail(ERR.TEST_CONFIRM, '测试房只允许已确认加入的成员；不发布外部观战');
    if (!room?.match || room.matchCtx?.matchId !== matchId || typeof room.match.addObserver !== 'function') return fail(ERR.BAD_TARGET, '本局已结束');
    if (room.spectators.size >= 64 && !room.spectators.has(session.playerId)) return fail(ERR.RATE);
    this.leaveSpectator(session, false);
    room.spectators.add(session.playerId);
    session.spectatorCode = room.code;
    session.spectatorMatchId = matchId;
    session.notice = null;
    session.pendingResult = null;
    session.resyncAt = this.now();
    this.sendSpectatorState(room, session);
    room.match.addObserver(session.playerId);
    return OK;
  }

  leaveSpectator(session, notify = true, reason = 'left') {
    clearDeferred(session.ws);
    const room = this.rooms.get(session.spectatorCode);
    if (room) { room.spectators.delete(session.playerId); room.match?.removeObserver?.(session.playerId); }
    session.spectatorCode = null;
    session.spectatorMatchId = null;
    if (notify) sendSession(session, { t: 'spectator.closed', reason });
    return OK;
  }

  closeSpectators(room, reason) {
    for (const pid of [...room.spectators]) {
      const session = this.registry.byId(pid);
      if (session) this.leaveSpectator(session, true, reason);
      else { room.match?.removeObserver?.(pid); room.spectators.delete(pid); }
    }
  }

  /** Public, joinable rooms whose members explicitly sent an invitation. */
  recruitmentItems() {
    const rooms = [];
    for (const [code, invitedAt] of this.recruitmentRooms) {
      const room = this.rooms.get(code);
      if (!room || room.disposed || room.match) { this.recruitmentRooms.delete(code); continue; }
      if (room.mode !== 'coop' || room.freeSeat() < 0 || room.matchCandidate) continue;
      const seats = room.seats.filter((seat) => seat && !seat.left)
        .map(({ seat, playerId, name, isBot }) => ({ seat, playerId, name, isBot }));
      rooms.push({ serverId: this.serverId, code, mode: room.mode, variant: room.variant,
        modeId: room.variant === ENDLESS_VARIANT ? ENDLESS_MODE_ID : room.content?.modeId || modeIdFor(room.mode, room.difficulty),
        // 跨服公开目录遵守固定字段契约；插件内容身份由入房后的 room.state 传递。
        difficulty: room.difficulty,
        ranked: !!room.ranked, hostId: room.hostId,
        hostName: seats.find((seat) => seat.playerId === room.hostId)?.name || '',
        capacity: room.capacity, occupied: seats.length, missing: room.capacity - seats.length,
        seats, stage: null, createdAt: room.createdAt, invitedAt });
    }
    return rooms.sort((a, b) => b.invitedAt - a.invitedAt || a.code.localeCompare(b.code));
  }

  sendRecruitment(session, rid) {
    sendSession(session, { t: 'recruitment.snapshot', ...(Number.isInteger(rid) ? { rid } : {}), rooms: this.recruitmentDirectory() });
  }

  recruitmentDirectory() {
    const local = this.recruitmentItems();
    return this.profiles?.recruitmentDirectory ? this.profiles.recruitmentDirectory(local) : local;
  }

  broadcastRecruitment() {
    const frame = encode({ t: 'recruitment.snapshot', rooms: this.recruitmentDirectory() });
    if (frame === this.recruitmentFrame) return;
    this.recruitmentFrame = frame;
    for (const peer of this.registry.all()) {
      if (peer.connected && peer.profileReady !== false && (!this.profiles || this.profiles.validSession(peer))) sendRaw(peer.ws, frame);
    }
  }

  /** Publish a structured room invitation; the client never supplies the room code. */
  async sendChatInvite(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.match || room.disposed) return fail(ERR.ROOM_STARTED);
    if (room.mode !== 'coop' || room.freeSeat() < 0) return fail(ERR.ROOM_FULL);
    const result = await (this.profiles ? this.profiles.publishChat(session, { kind: 'invite', code: room.code })
      : this.chat.publishInvite(session, { code: room.code, serverId: this.serverId }, this.now()));
    if (result?.ok && this.rooms.get(room.code) === room && !room.disposed && !room.match) {
      this.recruitmentRooms.set(room.code, this.now());
      this.broadcastRecruitment();
    }
    return result;
  }

  /** 原队伍直到开局前不转移成员；匹配池只区分排位意愿。 */
  canMatchRoom(room) {
    if (!room || room.disposed || this.rooms.get(room.code) !== room || !room.matchFill || room.matchCandidate || room.match
        || room.mode !== 'coop' || room.variant || room.test || room.seats.some((s) => s?.isBot)) return false;
    const humans = room.activeHumans();
    return humans.length > 0 && humans.length <= MAX_SEATS
      && humans.every((s) => s.connected && this.registry.byId(s.playerId)?.connected
        && this.registry.byId(s.playerId)?.ws?.readyState === 1
        && this.registry.byId(s.playerId)?.roomCode === room.code);
  }

  stopMatchFill(room, broadcast = true) {
    if (room?.matchCandidate) this.cancelCandidate(room.matchCandidate, '队伍取消或状态变化', new Set([room]));
    if (!room?.matchFill) return;
    room.matchFill = null;
    this.matchQueue.delete(room.code);
    if (!this.matchQueue.size && this.matchTimer) { clearInterval(this.matchTimer); this.matchTimer = null; }
    if (broadcast && !room.disposed) this.broadcastState(room);
  }

  resetMatchVote(room) {
    if (room?.matchFill?.vote) room.matchFill.vote = null;
  }

  setMatchFill(session, { searching, queueId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.test) return fail(ERR.BAD_MSG, '测试房不参与普通匹配');
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.content?.plugins?.length) return fail(ERR.PLUGIN_BLOCKED, '插件房间请通过房号加入');
    if (room.variant) return fail(ERR.BAD_MSG, '娱乐同盟请通过房号加入或由房主添加 AI');
    if (!searching) {
      if (room.matchFill && queueId !== room.matchFill.id) return fail(ERR.BAD_MSG, '匹配队列已变化');
      this.stopMatchFill(room); return OK;
    }
    if (room.matchFill) return OK;
    if (room.mode !== 'coop' || room.seats.some((s) => s?.isBot)
      || room.activeHumans().some((s) => !s.connected)) return fail(ERR.BAD_MSG, '需合作房、在线真人且尚无 AI');
    room.matchFill = { id: randomBytes(16).toString('hex'), since: this.now(), vote: null, available: 0 };
    this.matchQueue.add(room.code);
    if (!this.matchTimer) {
      this.matchTimer = setInterval(() => this.matchQueued(), 5000);
      this.matchTimer.unref?.();
    }
    this.broadcastState(room);
    this.matchQueued();
    return OK;
  }

  aiFillVote(session, { choice, voteId, queueId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!this.canMatchRoom(room) || !room.seatOf(session.playerId)) return fail(ERR.BAD_MSG, '房间未在匹配');
    if (choice === 'start') {
      if (queueId !== room.matchFill.id) return fail(ERR.BAD_MSG, '匹配队列已变化');
      if (room.matchFill.vote) return fail(ERR.BAD_MSG, '本轮投票正在进行');
      room.matchFill.vote = { id: ++this.matchVoteSeq, votes: new Set([session.playerId]) };
    } else {
      const vote = room.matchFill.vote;
      if (!vote || vote.id !== voteId) return fail(ERR.BAD_MSG, '投票已过期');
      if (choice === 'no') { room.matchFill.vote = null; this.broadcastState(room); return OK; }
      vote.votes.add(session.playerId);
    }
    const people = room.activeHumans();
    if (people.every((s) => room.matchFill.vote.votes.has(s.playerId))) {
      this.createCandidate([room], MAX_SEATS - people.length);
    }
    this.broadcastState(room);
    return OK;
  }

  /** Ranked distance: compare the most distant pair across two pre-made teams. */
  matchDistance(a, b) {
    const get = (s) => {
      const p = s.aid && this.ranked?.profile(s.aid);
      return p?.placementDone ? p.points : null;
    };
    let distance = 0;
    for (const x of a.activeHumans()) for (const y of b.activeHumans()) {
      const px = get(x), py = get(y);
      distance = Math.max(distance, px == null || py == null ? (px == null && py == null ? 0 : 600) : Math.abs(px - py));
    }
    return distance;
  }

  /** Exactly the same eligibility rules power both matching and the displayed candidate count. */
  canMergeRooms(a, b) {
    if (a === b || !this.matchQueue.has(a?.code) || !this.matchQueue.has(b?.code)
        || !this.canMatchRoom(a) || !this.canMatchRoom(b)
        || a.ranked !== b.ranked
        || a.activeHumans().length + b.activeHumans().length > MAX_SEATS) return false;
    if (!a.ranked) return true;
    const wait = Math.min(this.now() - a.matchFill.since, this.now() - b.matchFill.since);
    const limit = wait >= 120_000 ? Infinity : 200 + 200 * Math.floor(Math.max(0, wait) / 15_000);
    return this.matchDistance(a, b) <= limit;
  }

  /** Excludes own teammates, incompatible room settings, over-capacity teams and out-of-range ranks. */
  refreshMatchCounts() {
    const rooms = [...this.matchQueue].map((code) => this.rooms.get(code)).filter((room) => this.canMatchRoom(room));
    for (const room of rooms) {
      const available = rooms.reduce((sum, other) => sum + (this.canMergeRooms(room, other) ? other.activeHumans().length : 0), 0);
      if (room.matchFill.available !== available) {
        room.matchFill.available = available;
        this.broadcastState(room, true);
      }
    }
  }

  /** 凑齐四席才预留候选；每个原队之间均执行同一分差约束。 */
  matchQueued() {
    if (this.matchBusy) return;
    this.matchBusy = true;
    try {
      for (;;) {
        const rooms = [...this.matchQueue].map((code) => this.rooms.get(code)).filter((r) => this.canMatchRoom(r))
          .sort((a, b) => a.matchFill.since - b.matchFill.since);
        let group = null;
        // 四席至多四个原队；逐锚点搜索，优先分差近的队伍，再按等待时间。
        for (const anchor of rooms) {
          const peers = rooms.filter((r) => this.canMergeRooms(anchor, r)).sort((a, b) =>
            (anchor.ranked ? this.matchDistance(anchor, a) - this.matchDistance(anchor, b) : 0)
            || a.matchFill.since - b.matchFill.since);
          const find = (picked, count, from) => {
            if (count === MAX_SEATS) return picked;
            for (let i = from; i < peers.length; i++) {
              const r = peers[i], size = r.activeHumans().length;
              if (count + size > MAX_SEATS || !picked.every((p) => this.canMergeRooms(p, r))) continue;
              const found = find([...picked, r], count + size, i + 1);
              if (found) return found;
            }
            return null;
          };
          group = find([anchor], anchor.activeHumans().length, 0);
          if (group) break;
        }
        if (!group) break;
        this.createCandidate(group, 0);
      }
    } finally { this.matchBusy = false; this.refreshMatchCounts(); }
  }

  createCandidate(rooms, botCount) {
    const candidate = {
      id: randomBytes(16).toString('hex'), deadline: this.now() + 20_000,
      ranked: !!rooms[0].ranked, allowed: [...(rooms[0].ranked ? RANKED_DIFFICULTIES : DIFFICULTIES)],
      botCount, confirmed: new Set(), votes: new Map(), timer: null,
      teams: rooms.map((room) => ({ room, queue: room.matchFill, hostId: room.hostId,
        difficulty: room.difficulty, seats: [...room.seats], members: room.activeHumans().map((s) => ({ playerId: s.playerId, name: s.name })) })),
    };
    this.matchCandidates.set(candidate.id, candidate);
    for (const room of rooms) {
      room.matchCandidate = candidate;
      this.resetMatchVote(room);
      this.matchQueue.delete(room.code);
      room.matchFill.available = 0;
      this.broadcastState(room);
    }
    this.armCandidate(candidate);
    return candidate;
  }

  armCandidate(candidate) {
    candidate.timer = setTimeout(() => {
      this.finishCandidate(candidate);
      if (this.matchCandidates.get(candidate.id) === candidate) this.armCandidate(candidate);
    }, Math.max(1, candidate.deadline - this.now()));
    candidate.timer.unref?.();
  }

  teamIntact(team) {
    const { room } = team;
    const humans = room.activeHumans();
    return !room.disposed && this.rooms.get(room.code) === room && !room.match
      && room.matchFill === team.queue && room.hostId === team.hostId
      && room.difficulty === team.difficulty && humans.length === team.members.length
      && team.members.every(({ playerId }) => {
        const session = this.registry.byId(playerId);
        return room.seatOf(playerId)?.connected && session?.connected && session.ws?.readyState === 1 && session.roomCode === room.code;
      });
  }

  candidateFor(session, id) {
    const room = this.roomOf(session);
    const c = room?.matchCandidate;
    if (!session.connected || !c || c.id !== id || this.matchCandidates.get(id) !== c) return null;
    if (this.now() >= c.deadline) { this.finishCandidate(c); return null; }
    const changed = c.teams.filter((t) => !this.teamIntact(t) || t.room.ranked !== c.ranked);
    if (changed.length) { this.cancelCandidate(c, '队伍状态已变化', new Set(changed.map((t) => t.room))); return null; }
    return c;
  }

  matchConfirm(session, { candidateId, accept }) {
    const c = this.candidateFor(session, candidateId);
    if (!c) return fail(ERR.BAD_MSG, '匹配候选已过期');
    if (!accept) {
      this.cancelCandidate(c, '有博士拒绝本次匹配', new Set([this.roomOf(session)]));
      return OK;
    }
    c.confirmed.add(session.playerId); // 幂等；投票绝不替代确认。
    this.publishCandidate(c);
    this.finishCandidate(c);
    return OK;
  }

  matchDifficultyVote(session, { candidateId, difficulty }) {
    const c = this.candidateFor(session, candidateId);
    if (!c) return fail(ERR.BAD_MSG, '匹配候选已过期');
    if (!c.allowed.includes(difficulty)) return fail(ERR.BAD_MSG, '该匹配池不允许此难度');
    c.votes.set(session.playerId, difficulty); // 每人一票，可在有效期内改票。
    this.publishCandidate(c);
    this.finishCandidate(c);
    return OK;
  }

  publishCandidate(c) {
    for (const { room } of c.teams) this.broadcastState(room);
  }

  clearCandidate(c) {
    clearTimeout(c.timer);
    this.matchCandidates.delete(c.id);
    for (const { room } of c.teams) if (room.matchCandidate === c) room.matchCandidate = null;
  }

  cancelCandidate(c, reason, excluded = new Set(), requeue = true) {
    if (this.matchCandidates.get(c.id) !== c) return;
    const restore = new Map(c.teams.map((t) => [t.room, requeue && !excluded.has(t.room) && this.teamIntact(t)
      && t.room.ranked === c.ranked && t.members.every((s) => c.confirmed.has(s.playerId))]));
    this.clearCandidate(c);
    for (const { room } of c.teams) {
      const back = restore.get(room);
      if (back) {
        // 新队列ID阻断上一轮遗留的取消/AI投票请求，保留原始等待时间。
        room.matchFill = { ...room.matchFill, id: randomBytes(16).toString('hex'), vote: null, available: 0 };
        this.matchQueue.add(room.code);
      } else { room.matchFill = null; this.matchQueue.delete(room.code); }
      this.broadcastRoom(room, { t: 'room.matchCancelled', candidateId: c.id, reason, requeued: back });
      this.broadcastState(room);
    }
    this.refreshMatchCounts();
  }

  finishCandidate(c) {
    if (this.matchCandidates.get(c.id) !== c) return;
    const changed = c.teams.filter((t) => !this.teamIntact(t) || t.room.ranked !== c.ranked);
    if (changed.length) { this.cancelCandidate(c, '队伍状态已变化', new Set(changed.map((t) => t.room))); return; }
    const humans = c.teams.flatMap((t) => t.members);
    const allConfirmed = humans.every((s) => c.confirmed.has(s.playerId));
    const expired = this.now() >= c.deadline;
    if (!expired && !(allConfirmed && humans.every((s) => c.votes.has(s.playerId)))) {
      return;
    }
    if (!allConfirmed) { this.cancelCandidate(c, '确认超时，本次匹配取消'); return; }
    const target = c.teams[0].room;
    const host = this.registry.byId(target.hostId);
    const key = host?.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.cancelCandidate(c, '当前网络对局数量已达上限'); return;
    }
    // 最高票数获胜；同票取最高，所有0票自然得到允许的最高难度。
    let difficulty = c.allowed[0], most = -1;
    for (const d of c.allowed) {
      const count = [...c.votes.values()].filter((v) => v === d).length;
      if (count >= most) { most = count; difficulty = d; }
    }
    this.clearCandidate(c);
    for (const { room } of c.teams) this.stopMatchFill(room, false);
    for (const { room } of c.teams.slice(1)) {
      for (const seat of room.activeHumans()) {
        room.seats[seat.seat] = null;
        seat.seat = target.freeSeat();
        target.seats[seat.seat] = seat;
        const session = this.registry.byId(seat.playerId);
        session.roomCode = target.code; session.notice = null; session.pendingResult = null;
      }
      this.disposeRoom(room, 'empty');
    }
    target.difficulty = difficulty;
    for (let i = 0; i < c.botCount; i++) {
      const idx = target.freeSeat();
      target.seats[idx] = { seat: idx, playerId: 'ai_' + randomBytes(8).toString('hex'),
        name: BOT_NAMES[i], isBot: true, ready: true, connected: true, left: false };
    }
    for (const s of target.activeHumans()) { s.ready = true; this.clearGrace(s.playerId); }
    const result = this.startMatch(target, key);
    if (result.error) {
      // 构造/启动失败也恢复完整原队，不留下半合并房间。
      for (const team of c.teams) {
        const { room } = team;
        room.disposed = false; this.rooms.set(room.code, room);
        room.seats = team.seats; room.hostId = team.hostId; room.difficulty = team.difficulty;
        room.matchFill = null;
        for (let idx = 0; idx < room.seats.length; idx++) {
          const s = room.seats[idx];
          if (!s) continue;
          s.seat = idx; s.ready = false;
          const session = this.registry.byId(s.playerId);
          if (session) session.roomCode = room.code;
        }
        this.broadcastRoom(room, { t: 'room.matchCancelled', candidateId: c.id, reason: '对局启动失败，已恢复原队伍', requeued: false });
        this.broadcastState(room);
      }
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.profiles?.disconnect(session);
    session.profileGeneration = (session.profileGeneration || 0) + 1;
    this.clearResync(session.playerId); // 保留 resyncAt：短时再次恢复仍遵守同一收敛窗口
    session.pendingResultGeneration++;
    session.pendingResultInFlight = 0;
    session.pendingResultFailed = false;
    if (session.spectatorCode) {
      this.spectatorRoom(session)?.match.removeObserver(session.playerId);
      return;
    }
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    if (!room) return;
    const seat = room.seatOf(session.playerId);
    seat.connected = false;
    seat.content = null;
    seat.contentGen = (seat.contentGen || 0) + 1;
    this.stopMatchFill(room, false); // A disconnected voter/teammate cannot stay in the matching queue.
    if (room.match) this.callMatch(room, 'onDisconnect', session.playerId);
    else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    if (session.spectatorCode) this.leaveSpectator(session, false);
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    this.offPluginStale?.(); this.offPluginStale = null;
    this.offPluginContentStale?.(); this.offPluginContentStale = null;
    for (const c of [...this.matchCandidates.values()]) this.cancelCandidate(c, '隔离服务关闭', new Set(), false);
    if (this.matchTimer) { clearInterval(this.matchTimer); this.matchTimer = null; }
    this.matchQueue.clear();
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty, ranked, variant, capacity, test }) {
    if (test === true && !this.testEnabled) return fail(ERR.TEST_DISABLED);
    if (test === true && ranked === true) return fail(ERR.BAD_MSG, '测试房不能开启排位');
    const entertainment = variant === 'entertainment_multi' || variant === ENDLESS_VARIANT;
    const cyclops = variant === 'entertainment_cyclops';
    const anyVariant = entertainment || cyclops;
    if ((variant !== undefined && !anyVariant) || (anyVariant && (mode !== 'coop' || ranked === true))
        || (capacity !== undefined && (!anyVariant
          || (entertainment ? !ENTERTAINMENT_CAPACITIES.includes(capacity) : !CYCLOPS_CAPACITIES.includes(capacity))))) {
      return fail(ERR.BAD_MSG, '娱乐模式仅支持非排位多人同盟；原模式不可扩容');
    }
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human.
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId, true);
    const roomDifficulty = variant === ENDLESS_VARIANT ? 'NORMAL' : difficulty;
    const room = new Room(code, mode, roomDifficulty, this.now(), !!ranked, variant, capacity);
    room.test = test === true;
    room.content = this.vanilla;
    if (!ranked && variant !== ENDLESS_VARIANT) {
      const defaults=this.plugins?.defaults?.() || [];
      if (defaults.length) { const r=this.resolveContent(room,defaults); if (!r.error) {room.content=r.content;this.holdContent(room.content);} else this.log.warn('[plugins] default room set refused: '+r.detail); }
    }
    room.ownerKey = key;
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}${ranked ? '/RANKED' : ''}) by ${session.name}`);
    this.broadcastState(room);
    if (this.matchQueue.size) this.matchQueued();
    return OK;
  }

  join(session, { code, serverId, testAck }) {
    const norm = String(code).trim().toUpperCase();
    const target = roomServer(norm);
    const wrong = serverId && serverId !== this.serverId ? serverId : target !== this.serverId ? target : null;
    if (wrong) return fail(ERR.BAD_TARGET, `该同盟位于${SERVER_NAMES[wrong]}，请切换服务器`);
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    if (room.test && testAck !== true) return fail(ERR.TEST_CONFIRM);
    const cur = this.roomOf(session);
    if (cur === room) { this.sendState(room, session); return OK; }
    if (room.matchCandidate) return fail(ERR.BAD_MSG, '匹配确认期间不能加入队伍');
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    // Do not run matchmaking during a manual room transfer: it could dispose the destination
    // between the destination lookup and assigning this player's seat.
    if (cur) this.removeMember(cur, session.playerId, true);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    if (room.matchFill) {
      this.resetMatchVote(room);
      if (room.activeHumans().length === MAX_SEATS) this.stopMatchFill(room, false);
    }
    this.broadcastState(room);
    if (this.matchQueue.size) this.matchQueued();
    return OK;
  }

  async releaseSession(session) {
    const room = this.roomOf(session);
    if (session.spectatorCode) return fail(ERR.BAD_TARGET, '请先结束观战再切换服务器');
    if (room?.match) return fail(ERR.ROOM_STARTED, '对局中不能切换服务器');
    session.profileReady = false;
    session.loginReleased = true;
    session.profileGeneration = (session.profileGeneration || 0) + 1;
    if (room) this.removeMember(room, session.playerId);
    try { await this.profiles?.releaseSession(session); }
    catch {
      this.registry.remove(session);
      return fail(ERR.INTERNAL, 'SESSION_RELEASED');
    }
    this.registry.remove(session);
    return OK;
  }

  leave(session) {
    // 主动退出撤销旧局结算恢复；断线/超时移除仍保留原恢复规则。
    session.notice = null;
    session.pendingResult = null;
    session.pendingResultGeneration++;
    session.pendingResultInFlight = 0;
    session.pendingResultFailed = false;
    this.clearResync(session.playerId);
    clearDeferred(session.ws);
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matchCandidate) return fail(ERR.BAD_MSG, '匹配确认独立于房间准备');
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (ready && room.modded && seat.content !== 'ready') return fail(ERR.CONTENT_NOT_READY);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  async setCard(session, { charId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (isSpecialNameCard(charId)) {
      let allowed = false;
      try { allowed = this.profiles ? await this.profiles.canSelectNameCard(session, charId)
        : canUseSpecialNameCard(this.ranked.summary(session.aid), charId); }
      catch { return fail(ERR.INTERNAL, '名片权限暂时无法验证，请重试'); }
      if (!allowed) return fail(ERR.BAD_TARGET, '名片尚未永久解锁');
      if (this.roomOf(session) !== room || !room.seatOf(session.playerId)) return fail(ERR.NOT_IN_ROOM);
    }
    const data = this.safeData();
    const records = data.chess;
    const list = Array.isArray(records) ? records : Object.values(records || {});
    const reserve = Object.prototype.hasOwnProperty.call(data.backups?.units || {}, charId) && data.backups.units[charId];
    if (charId && !isSpecialNameCard(charId) && !list.some(c => c.charId === charId && !c.isDiy) && reserve?.charId !== charId) return fail(ERR.BAD_TARGET);
    const seat = room.seatOf(session.playerId);
    session.card = charId;
    const cardSkin = this.cardSkinFor(charId, session.skins, session.portraits);
    if (seat.card !== charId || seat.cardSkin !== cardSkin) {
      seat.card = charId; seat.cardSkin = cardSkin; this.broadcastState(room);
    }
    return OK;
  }

  /** Only the selected name-card skin is public; the player's other selections stay private. */
  cardSkinFor(charId, skins, portraits = {}) {
    if (!charId || isSpecialNameCard(charId) || !skins) return '';
    const data = this.safeData();
    const records = Array.isArray(data.chess) ? data.chess : Object.values(data.chess || {});
    const rec = records.find(c => c.charId === charId && !c.isGolden && !c.isDiy);
    const art = (rec && portraits[rec.baseId || rec.chessId]) || portraits[`char:${charId}`];
    if (art === 'original' || art === 'e2') return art;
    const skin = art || (rec && skins[rec.baseId || rec.chessId]) || skins[`char:${charId}`];
    if (art && data.assets?.chars?.[charId]?.skins?.[art]?.portrait) return art;
    return typeof skin === 'string' && data.assets?.chars?.[charId]?.skins?.[skin]?.spine?.front ? skin : '';
  }

  setAiPicksLast(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET);
    if (room.aiPicksLast !== on) {
      room.aiPicksLast = on;
      this.stopMatchFill(room, false);
      for (const seat of room.activeHumans()) if (seat.playerId !== room.hostId) seat.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  rerollSetup(session, msg, cancel = false) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.matchCtx?.ranked || room.match?.ranked) return fail(ERR.WRONG_PHASE, '排位对局不允许投票重开');
    const method = cancel ? 'cancelSetupReroll' : 'requestSetupReroll';
    if (!room.match || typeof room.match[method] !== 'function') return fail(ERR.WRONG_PHASE);
    return this.callMatch(room, method, session.playerId, cancel ? msg.voteId : msg.setupRevision) || fail(ERR.INTERNAL);
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.variant === ENDLESS_VARIANT && difficulty !== 'NORMAL') return fail(ERR.BAD_TARGET, '无尽模式固定使用标准难度');
    if (room.difficulty !== difficulty || room.content?.modeId) {
      if (room.content?.modeId) { const c={...room.content}; delete c.modeId; room.content=Object.freeze(c); }
      this.stopMatchFill(room, false);
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  setCapacity(session, { capacity }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (!room.variant
      || (room.variant === 'entertainment_cyclops' ? !CYCLOPS_CAPACITIES.includes(capacity) : !ENTERTAINMENT_CAPACITIES.includes(capacity))) return fail(ERR.BAD_MSG);
    if (room.seats.slice(capacity).some(Boolean)) return fail(ERR.ROOM_FULL, '请先清空超出新容量的席位');
    if (capacity === room.capacity) return OK;
    this.dropReplay(room, session.playerId);
    room.seats = Array.from({ length: capacity }, (_, i) => room.seats[i] || null);
    room.capacity = capacity;
    for (const s of room.activeHumans()) if (s.playerId !== room.hostId) s.ready = false;
    this.broadcastState(room);
    return OK;
  }

  cancelReady(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (!room.variant) return fail(ERR.BAD_MSG);
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.capacity) return fail(ERR.BAD_TARGET);
    const target = room.seats[seat];
    if (!target || target.isBot || target.left || target.playerId !== playerId || playerId === room.hostId) return fail(ERR.BAD_TARGET);
    target.ready = false;
    this.dropReplay(room, playerId);
    this.broadcastState(room);
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matchFill) return fail(ERR.BAD_MSG, '匹配中请先全员同意 AI 补齐或取消匹配');
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matchFill) return fail(ERR.BAD_MSG, '匹配中不能手动调整 AI');
    this.dropReplay(room, session.playerId);
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.capacity) return fail(ERR.BAD_TARGET);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.capacity) return fail(ERR.BAD_TARGET);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matchFill) return fail(ERR.BAD_MSG, '请先结束匹配补齐');
    if (room.ranked && room.content?.plugins?.length) return fail(ERR.PLUGIN_BLOCKED);
    if (room.modded && room.activeHumans().some(seat=>seat.content!=='ready')) return fail(ERR.CONTENT_NOT_READY);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout against the game data, store it on the session and the seat,
   * and — while a match runs — hand it to the match (accepted only during INFO_CHECK, see the header).
   */
  loadout(session, { entries, ops }) {
    const data = this.dataFor(this.roomOf(session));
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const checkedOps = checkedOperatorSettings(ops === undefined ? session.ops : ops, data);
    if (checkedOps.error) return fail(checkedOps.error, checkedOps.detail);
    return this.applySessionLoadout(session, freezeLoadout(res.loadout), freezeOperatorSettings(checkedOps.ops));
  }

  async initializePresentation(session) {
    if (!this.players.profiles.has(session.aid)) return;
    const stored = this.players.getPresentation(session.aid);
    if (stored?.extraSkinDefaultsInitialized) return;
    const data = this.safeData();
    if (!data?.chess || !data?.backups?.units || !data?.skins?.chars || !data?.assets?.chars) return;
    const value = stored?.value || defaultPresentation();
    // 原棋子选择及主动清空保持不变；新增角色只初始化一次，规则与普通干员一致。
    const entries = stored?.skinDefaultsInitialized || Object.keys(value.skins).length
      ? [] : Object.entries(data.chess);
    entries.push(...Object.keys(data.backups.units).map((charId) => [`char:${charId}`, { charId }]));
    for (const [id, c] of entries) {
      if (Object.hasOwn(value.skins, id)) continue;
      const skins = (data.skins.chars[c.charId] || []).filter((skin) =>
        !checkPresentation({ ...value, skins: { [id]: skin.id } },
          (key) => lookup('chess', key, data), data.assets, data.backups.units).error);
      if (skins.length) value.skins[id] = skins[skins.length === 1 ? 0 : randomInt(skins.length)].id;
    }
    await (this.profiles || this.players).setPresentation(session.aid, { ...stored, v: 1, value,
      skinDefaultsInitialized: true, extraSkinDefaultsInitialized: true }, true, session);
  }

  presentationFor(session) {
    const data = this.safeData();
    const stored = this.players.getPresentation(session.aid);
    const value = stored?.value || defaultPresentation();
    // 资源目录变化后保留仍可用的选择，不丢失已保存的语音设置。
    const clean = { voice: value.voice, skins: Object.fromEntries(Object.entries(value.skins).filter(([id, skin]) => {
      return !checkPresentation({ voice: value.voice, skins: { [id]: skin } },
        (key) => lookup('chess', key, data), data?.assets, data?.backups?.units).error;
    })) };
    if (value.portraits !== undefined) clean.portraits = Object.fromEntries(Object.entries(value.portraits).filter(([id, choice]) =>
      !checkPresentation({ voice: value.voice, skins: {}, portraits: { [id]: choice } },
        (key) => lookup('chess', key, data), data?.assets, data?.backups?.units).error));
    if (value.card !== undefined) clean.card = checkPresentation({ voice: value.voice, skins: {}, card: value.card },
      (key) => lookup('chess', key, data), data?.assets, data?.backups?.units).error ? '' : value.card;
    return clean;
  }

  sendPresentationState(session, extra = {}) {
    const profile = this.players.profiles.get(session.aid);
    if (!profile) return;
    sendSession(session, { t: 'presentation.state', v: 1, profileId: profile.id,
      initialized: this.players.getPresentation(session.aid) !== null,
      value: this.presentationFor(session),
      locked: !!this.roomOf(session)?.match && this.roomOf(session).match.phase !== 'INFO_CHECK', ...extra });
  }

  async profilePresentation(session, { v, profileId, value, editId }) {
    const profile = this.players.profiles.get(session.aid);
    if (!session.profileBound || !profile || v !== 1 || profile.id !== profileId) return fail(ERR.BAD_TARGET, '档案已变化');
    const data = this.safeData();
    const checked = checkPresentation(value, (id) => lookup('chess', id, data), data?.assets, data?.backups?.units);
    if (checked.error) return fail(checked.error, checked.detail);
    if (isSpecialNameCard(value.card) && this.players.getPresentation(session.aid)?.value?.card !== value.card) {
      let allowed = false;
      try { allowed = this.profiles ? await this.profiles.canSelectNameCard(session, value.card)
        : canUseSpecialNameCard(this.ranked.summary(session.aid), value.card); }
      catch { return fail(ERR.INTERNAL, '名片权限暂时无法验证，请重试'); }
      if (!allowed) return fail(ERR.BAD_TARGET, '名片尚未永久解锁');
    }
    const aid = session.aid;
    try { await (this.profiles || this.players).setPresentation(aid, { v: 1, value: checked.value,
      skinDefaultsInitialized: true, extraSkinDefaultsInitialized: true }, false, session); }
    catch (e) { this.log.error('[players] presentation save failed', e); return fail(ERR.INTERNAL, '语音与皮肤保存失败，已恢复服务器配置'); }
    const current = this.presentationFor(session);
    for (const peer of this.registry.all()) {
      if (!peer.profileBound || peer.aid !== aid) continue;
      this.applySessionPresentation(peer, current);
      if (peer.connected) this.sendPresentationState(peer, { editorId: session.playerId, editId });
    }
    return OK;
  }

  applySessionPresentation(session, value) {
    session.skins = Object.freeze({ ...value.skins });
    session.portraits = Object.freeze({ ...value.portraits });
    session.card = value.card || '';
    const room = this.roomOf(session);
    const seat = room?.seatOf(session.playerId);
    if (seat) {
      const cardSkin = this.cardSkinFor(session.card, session.skins, session.portraits);
      const changed = seat.card !== session.card || seat.cardSkin !== cardSkin;
      seat.skins = session.skins; seat.card = session.card; seat.cardSkin = cardSkin;
      if (changed) this.broadcastState(room);
    }
    // 外观选择不调用 setLoadout，也不会解除技能和模组的本局锁定。
    room?.match?.setSkins?.(session.playerId, session.skins);
  }

  sendLoadoutState(session, extra = {}) {
    const profile = this.players.profiles.get(session.aid);
    if (!profile) return;
    const stored = this.players.getLoadout(session.aid);
    const data = this.safeData();
    const checked = checkLoadout(stored?.entries || {}, (id) => lookup('chess', id, data));
    sendSession(session, { t: 'loadout.state', v: 1, profileId: profile.id, initialized: stored !== null,
      entries: loadoutEntriesForWire(checked.loadout || {}), ops: checkedOperatorSettings(stored?.ops, data).ops || {}, locked: false, ...extra });
  }

  async profileLoadout(session, { v, profileId, entries, ops, editId }) {
    const profile = this.players.profiles.get(session.aid);
    if (!session.profileBound || !profile || v !== 1 || profile.id !== profileId) return fail(ERR.BAD_TARGET, '档案已变化');
    const data = this.safeData();
    const checked = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (checked.error) return fail(checked.error, checked.detail);
    const checkedOps = checkedOperatorSettings(ops === undefined ? this.players.getLoadout(session.aid)?.ops : ops, data);
    if (checkedOps.error) return fail(checkedOps.error, checkedOps.detail);
    const loadout = freezeLoadout(checked.loadout);
    const operatorSettings = freezeOperatorSettings(checkedOps.ops);
    const aid = session.aid;
    try { await (this.profiles || this.players).setLoadout(aid, { v: 1, entries: loadoutEntriesForWire(loadout), ops: operatorSettings }, session); }
    catch (e) { this.log.error('[players] loadout save failed', e); return fail(ERR.INTERNAL, '调配保存失败，请重试'); }
    let result = OK;
    // 包括断线但仍可恢复的会话：只替换下局配置，不改运行中的锁定快照。
    for (const peer of this.registry.all()) {
      if (!peer.profileBound || peer.aid !== aid) continue;
      const applied = this.applySessionLoadout(peer, loadout, operatorSettings);
      if (peer === session) result = applied;
      if (peer.connected) this.sendLoadoutState(peer, {
        editorId: session.playerId, editId,
        locked: applied.error === ERR.WRONG_PHASE || applied.error === ERR.ROOM_STARTED,
      });
    }
    return result;
  }

  applySessionLoadout(session, loadout, ops = session.ops || {}) {
    session.loadout = loadout;
    session.ops = ops;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.loadout = loadout; seat.ops = ops; }
    if (!room.match) return OK;
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout, ops);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  async historyList(session, msg) {
    const socket = session.ws;
    const items = await this.history.list(session.aid);
    const frame = { t: 'history.list', viewerId: session.playerId, items };
    if (Number.isInteger(msg.rid)) frame.rid = msg.rid;
    if (session.connected && session.ws === socket) sendSession(session, frame);
    return OK;
  }

  async historyDetail(session, msg) {
    const socket = session.ws;
    const detail = await this.history.detail(session.aid, msg.matchId, msg.playerId);
    if (!detail) return fail(ERR.BAD_TARGET, 'match not found');
    const frame = { t: 'history.detail', ...detail, viewerId: session.playerId };
    if (Number.isInteger(msg.rid)) frame.rid = msg.rid;
    if (session.connected && session.ws === socket) sendSession(session, frame);
    return OK;
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  ownership(session, { notOwned }) {
    const data = this.dataFor(this.roomOf(session));
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    session.notOwned = list;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.notOwned = list;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  diy(session, { picks }) {
    const res = checkDiyPicks(picks, { data: this.dataFor(this.roomOf(session)), kitted: this.kittedFor(this.roomOf(session)) });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    session.diy = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.diy = kept;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  welcomeInfo() {
    return { diyKitted: KITTED_CHARS, serverId: this.serverId, ...(this.testEnabled ? { testMode: true } : {}), ...(this.vanilla ? {content:{vanilla:this.vanilla.cs,plugins:this.plugins?.unofficial?.() || 0}} : {}) };
  }

  onRecoveredResult(job, value) {
    if (job.op !== 'complete') return;
    const archived = job.args[0];
    const live = [...this.rooms.values()].some((room) => room.matchCtx?.matchId === archived.match.matchId);
    for (const seat of archived.seats) {
      if (seat.isBot) continue;
      const peer = this.registry.byId(seat.playerId);
      if (!peer || peer.aid !== seat.aid) continue;
      if (!value.failed && peer.connected && peer.profileReady) {
        try { this.sendRecoveredRank(peer); } catch (e) { this.log.error('[lobby] recovered rank notification failed', e); }
      }
    }
    if (!live) this.updateFinishedResult(archived.match.matchId, { ...value.result, matchId: archived.match.matchId });
  }

  /** Only update an owed replay of this exact match; a late receipt must never reopen an old game. */
  updateFinishedResult(matchId, result) {
    for (const room of this.rooms.values()) {
      const replay = room.replay;
      if (!replay || replay.matchId !== matchId) continue;
      const { t, ...summary } = result;
      room.lastSummary = summary;
      for (const playerId of replay.pending) {
        const frame = encode({ ...result, matchId, playerId });
        if (!frame || replay.frames.get(playerId) === frame) continue;
        replay.frames.set(playerId, frame);
        const seat = room.seatOf(playerId), peer = this.registry.byId(playerId);
        if (!seat || seat.isBot || seat.left || !peer || peer.roomCode !== room.code || peer.aid !== seat.aid) continue;
        if (peer.connected && peer.profileReady) try { sendSession(peer, { ...result, matchId, playerId }); }
        catch (e) { this.log.error('[lobby] delayed result notification failed', e); }
      }
    }
  }

  onProfileRefresh(aid) {
    for (const peer of this.registry.all()) {
      if (!peer.connected || !peer.profileBound || !peer.profileReady || peer.aid !== aid) continue;
      const checked = checkLoadout(this.players.getLoadout(aid)?.entries || {}, (id) => lookup('chess', id, this.safeData()));
      const ops = checkedOperatorSettings(this.players.getLoadout(aid)?.ops, this.safeData());
      const applied = this.applySessionLoadout(peer, freezeLoadout(checked.loadout || {}), freezeOperatorSettings(ops.ops || {}));
      this.applySessionPresentation(peer, this.presentationFor(peer));
      this.sendLoadoutState(peer, { locked: applied.error === ERR.WRONG_PHASE || applied.error === ERR.ROOM_STARTED });
      this.sendPresentationState(peer);
      this.sendRecoveredRank(peer);
    }
  }

  sendRecoveredRank(session) {
    sendSession(session, { t: 'rank.me', ...this.ranked.summary(session.aid, session.name, session.debugAuthorized === true),
      profileId: this.players.profiles.get(session.aid)?.id || null });
    const room = this.roomOf(session);
    if (room && !room.match) this.broadcastState(room);
  }

  /** @param {Room} room @param {string | null} [key] 开局者的网络限额标识 */
  startMatch(room, key = null) {
    return this.startMatchWith(room, key, null);
  }

  startMatchWith(room, key = null, checkpoint = null) {
    if (room.test && !this.testEnabled) return fail(ERR.TEST_DISABLED);
    const host = room.seatOf(room.hostId);
    if (host && !checkpoint) host.ready = true;
    const seats = seatEntries(room, checkpoint, this.registry);
    const data = this.dataFor(room);
    if (room.modded && !checkpoint) for (const seat of seats) {
      const checked=checkLoadout(Object.fromEntries(Object.entries(seat.loadout || {}).filter(([id])=>lookup('chess',id,data))), id=>lookup('chess',id,data));
      seat.loadout=checked.loadout || {};
      const own=checkNotOwned((seat.notOwned || []).filter(id=>lookup('chess',id,data)),id=>lookup('chess',id,data)); seat.notOwned=own.notOwned || [];
      const diy=checkDiyPicks(seat.diy || {},{data,kitted:this.kittedFor(room)}); seat.diy=diy.picks || {};
    }
    const ranked = !room.test && !room.variant && !room.content?.plugins?.length && isRankedMatch(room.ranked, room.difficulty);
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const restored = checkpoint ? room.restoredMatchContext : null;
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null,
      results: new Map(), matchId: checkpoint?.matchId || restored?.matchId || randomBytes(16).toString('hex'),
      startedAt: restored?.startedAt ?? this.now(), seats: restored?.seats || seats, ranked };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    if (checkpoint && Number.isInteger(checkpoint.seed)) seed = checkpoint.seed >>> 0;
    try {
      const matchOptions = {
        roomCode: room.code,
        mode: room.mode,
        variant: room.variant,
        aiPicksLast: room.aiPicksLast,
        difficulty: room.difficulty,
        ranked,
        ...(room.test ? { test: true } : {}), hostId: room.hostId,
        rankedStore: this.ranked,
        completeMatch: !room.test && this.profiles ? (job) => this.profiles.completeMatch(job) : null,
        matchId: ctx.matchId,
        modeId: room.variant === ENDLESS_VARIANT ? ENDLESS_MODE_ID : room.content?.modeId || modeIdFor(room.mode, room.difficulty),
        ...(room.content ? {cs:room.content.cs} : {}),
        ...(room.content?.vs ? {vs:room.content.vs} : {}),
        ...(room.modded ? {requireCs:true} : {}),
        seats,
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: checkpoint ? Math.max(1, room.matchCount) : room.matchCount + 1,
        data,
        workerPool: this.workerPool,
        log: this.log,
        now: this.now,
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
        onResultUpdate: (result) => this.updateFinishedResult(ctx.matchId, result),
        onCheckpoint: (m) => this.checkpoint(room.code, m),
        onCheckpointDoc: () => { if (ctx.live && room.matchCtx===ctx) this.checkpoint(room.code,ctx.match); },
      };
      const match = room.modded ? this.hosts.create(room.content.cs,matchOptions,checkpoint) : new this.MatchClass(matchOptions);
      ctx.match = match;
      ctx.chat = new ChatHub({ frameFields: { channel: 'match', matchId: ctx.matchId }, memberSink: (frame) => {
        if (room.matchCtx === ctx && ctx.live && !ctx.ended) for (const peer of this.memberSessions(room)) sendSession(peer, frame);
      } });
      if (checkpoint) return adoptRestoredMatch(this, room, { match, ctx, key, checkpoint });
      room.match = match;
      room.matchCtx = ctx;
      for (const peer of this.memberSessions(room)) this.sendMatchChat(room, peer);
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      this.broadcastState(room);
      match.start();
      this.checkpoint(room.code, match);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  async onMatchEnd(room, ctx, summary) {
    // Capture archival work now, but never await it while the room still owns the ended match.
    // Pending/incomplete completion has its own durable outbox; do not archive a preview as final history.
    const recordHistory = !room.test && !ctx.match?.test && !ctx.match?.historyPersisted
      && !summary?.settlementPending && !summary?.incomplete;
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    if (ctx.ranked) {
      const aids = new Set(ctx.seats.filter((seat) => !seat.isBot).map((seat) => seat.aid));
      for (const peer of this.registry.all()) if (peer.connected && aids.has(peer.aid)) {
        try { sendSession(peer, { t: 'rank.me', ...this.ranked.summary(peer.aid, peer.name, peer.debugAuthorized === true),
          profileId: this.players.profiles.get(peer.aid)?.id || null }); }
        catch (e) { this.log.error('[lobby] ended match rank notification failed', e); }
      }
    }
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    try { this.closeSpectators(room, 'ended'); } catch (e) { this.log.error('[lobby] ended match spectator notice failed', e); }
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else { this.broadcastState(room); this.tellPluginsChanged(room); }
    this.checkpoint(room.code, null);
    if (recordHistory) try {
      await this.history.record({ matchId: ctx.matchId, at: this.now(), seats: ctx.seats, ranked: ctx.ranked, summary });
      await this.history.flush?.();
    } catch (e) { this.log.error('[lobby] ended match history retained outside room flow', e); }
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of room.seats) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { matchId: ctx.matchId, publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * 首次恢复立即发送；短时重连及重复 hello 每 resyncMinGapMs 合并一次完整恢复。
   * 延迟回调重新取得当前会话，确保最新连接收到状态，而不是忽略窗口内的恢复。
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => {
          this.resyncTimers.delete(pid);
          const current = this.registry.byId(pid);
          if (!current) return;
          try { this.runResync(current); }
          catch (e) { this.handleResyncError(current, e); }
        }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** Turn a delayed recovery failure into a transport close while preserving the session token. */
  handleResyncError(session, error) {
    this.log.error('[lobby] delayed resync failed', error);
    session.pendingResultGeneration++;
    session.pendingResultInFlight = 0;
    const ws = session.ws;
    if (ws && session.connected) {
      try { terminateSocket(ws, 'resync_error'); } catch { /* network close handler records the disconnect */ }
    }
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    clearDeferred(session.ws);
    if (session.spectatorCode) {
      const watched = this.spectatorRoom(session);
      if (!watched) { sendSession(session, { t: 'spectator.closed', reason: 'ended' }); return; }
      session.resyncAt = this.now();
      this.sendSpectatorState(watched, session);
      watched.match.addObserver(session.playerId);
      return;
    }
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.sendMatchChat(room, session);
      (this.callMatchStrict || this.callMatch).call(this, room, 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  async routeGame(session, msg) {
    if (session.spectatorCode) return fail(ERR.BAD_TARGET, '观战身份不能操作或上报结算');
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (msg.t === 'g.test') {
      if (!this.testEnabled) return fail(ERR.TEST_DISABLED);
      if (!room.test) return fail(ERR.TEST_FORBIDDEN);
      if (session.playerId !== room.hostId) return fail(ERR.NOT_HOST);
    }
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') return this.leave(session);
    if (msg.t === 'g.rerollVote' && room.matchCtx?.ranked) return fail(ERR.WRONG_PHASE, '排位对局不允许投票重开');
    let res;
    try {
      res = await room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Call a recovery hook; thrown errors must reach the network layer. */
  callMatchStrict(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    if (typeof m[method] !== 'function') return this.callMatch(room, method, ...args);
    return m[method].apply(m, args);
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      card: session.card || '',
      cardSkin: this.cardSkinFor(session.card, session.skins, session.portraits),
      loadout: session.loadout || null,
      ops: session.ops || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
      skins: session.skins || null,
      aid: session.aid || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId, deferMatch = false) {
    if (room.matchCandidate) this.cancelCandidate(room.matchCandidate, '队伍成员离开', new Set([room]));
    if (room.matchFill) this.resetMatchVote(room);
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) {
      session.roomCode = null;
      clearDeferred(session.ws);
      this.clearResync(playerId);
    }
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else {
      this.broadcastState(room);
      if (room.matchFill && !deferMatch) this.matchQueued();
    }
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  startGrace(room, seat) {
    if (this.draining) return;
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    this.closeSpectators(room, reason);
    this.stopMatchFill(room, false);
    this.releaseContent(room.content);
    room.disposed = true;
    this.recruitmentRooms.delete(room.code);
    this.broadcastRecruitment();
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    this.checkpoint(room.code, null);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const prefixes = CODE_PREFIXES[this.serverId];
      let code = prefixes[randomInt(prefixes.length)];
      for (let i = 1; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room. */
  *memberSessions(room) {
    for (const s of room.seats) {
      if (!s || s.isBot || s.left) continue;
      try {
        const session = this.registry.byId(s.playerId);
        if (session && session.connected && session.profileReady !== false && session.roomCode === room.code
          && (!this.profiles || this.profiles.validSession(session))) yield session;
      } catch (error) {
        this.log.error(`[lobby] ${room.code} member session ${s.playerId} unavailable`, error);
      }
    }
  }

  broadcastState(room, skipMatchCounts = false) {
    if (room.disposed) return;
    this.broadcastRecruitment();
    if (!skipMatchCounts && !this.matchBusy) this.refreshMatchCounts();
    const data = encode(room.toState(this.ranked));
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, { clearPool: true });
  }

  sendState(room, session) {
    sendSession(session, room.toState(this.ranked));
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const options = sendOptions(msg);
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, options);
    if (['m.public', 'm.ticker', 'm.emote', 'b.pool', 'b.speed', 'b.pause'].includes(msg.t)) {
      for (const pid of room.spectators) {
        try {
          const peer = this.registry.byId(pid);
          if (peer?.connected && peer.profileReady !== false && peer.spectatorMatchId === room.matchCtx?.matchId
            && (!this.profiles || this.profiles.validSession(peer))) sendRaw(peer.ws, data, options);
        } catch (error) {
          this.log.error(`[lobby] ${room.code} spectator session ${pid} unavailable`, error);
        }
      }
    }
    return data;
  }

  /** Send a disconnected player's notice/results one frame at a time; dequeue only after transport success. */
  sendPendingResult(session) {
    if (!session?.connected || this.registry.byId(session.playerId) !== session) return;
    if (session.pendingResultInFlight) return;
    const generation = ++session.pendingResultGeneration;
    const sendNext = () => {
      if (generation !== session.pendingResultGeneration || !session.connected || this.registry.byId(session.playerId) !== session) return;
      if (session.notice) {
        const notice = session.notice;
        session.pendingResultInFlight = 1;
        const queued = sendRaw(session.ws, encode({ t: 'room.closed', reason: notice }), {
          onComplete: (err) => {
            if (generation !== session.pendingResultGeneration) return;
            session.pendingResultInFlight = 0;
            if (err) { session.pendingResultFailed = true; return; }
            if (session.notice === notice) session.notice = null;
            sendNext();
          },
        });
        if (!queued) session.pendingResultInFlight = 0;
        return;
      }
      if (!session.pendingResult?.length) {
        session.pendingResult = null;
        session.pendingResultFailed = false;
        return;
      }
      const frame = session.pendingResult[0];
      session.pendingResultInFlight = 1;
      const queued = sendRaw(session.ws, frame, {
        onComplete: (err) => {
          if (generation !== session.pendingResultGeneration) return;
          session.pendingResultInFlight = 0;
          if (err) { session.pendingResultFailed = true; return; }
          if (session.pendingResult?.[0] === frame) session.pendingResult.shift();
          sendNext();
        },
      });
      if (!queued) session.pendingResultInFlight = 0;
    };
    sendNext();
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    if (room.spectators.has(playerId) && ['m.public', 'm.field', 'b.start', 'b.snap', 'b.ev', 'b.end', 'spectator.bench'].includes(msg?.t)) {
      const peer = this.registry.byId(playerId);
      return peer?.spectatorMatchId === room.matchCtx?.matchId ? sendSession(peer, msg) : false;
    }
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}

installPluginLobby(Lobby);
