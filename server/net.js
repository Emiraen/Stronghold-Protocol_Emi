import { getSendMetadata } from './sendMetadata.js';
import { heavyFriendAction } from '../shared/friends.js';
export { markSend } from './sendMetadata.js';
// server/net.js — WebSocket session layer (DESIGN §1, §8).
//
// Responsibilities:
//   * Session objects (playerId, secret reconnect token, name, bound socket, connection state) and the
//     SessionRegistry that resolves reconnect tokens and expires sessions after the reconnect window (10 min; the
//     lobby may extend it per session via `session.resumeWindowMs` — a solo run: 24 h, see server/lobby.js).
//   * Per-connection pipeline: token-bucket rate limit (40 msg/s) → JSON decode → schema validation
//     (shared/protocol.js) → `hello`/`ping` handling → dispatch to the lobby handler → `ok`/`error`
//     reply echoing the request id (`rid`). Intents whose answer is a large state resend (`g.watch` →
//     m.field) also draw from a second, much smaller bucket (2/s, burst 6), so one socket cannot turn
//     40 tiny requests per second into hundreds of KB/s of downstream traffic.
//   * Client address per connection (`clientAddress`): the socket peer, or — when the peer is a local
//     reverse proxy (loopback / private address, e.g. `cloudflared tunnel --url http://localhost:3000`) —
//     the address it forwards (CF-Connecting-IP, X-Real-IP, rightmost X-Forwarded-For). Its `key` (IPv4
//     address or IPv6 /64) is what per-network limits count against: concurrent sockets here
//     (`maxConnectionsPerAddr`, checked at upgrade time through `admission`), rooms and running matches
//     in server/lobby.js. Local / LAN peers without a forwarding header (dev machine, tests, LAN party)
//     have no key and are never limited per address.
//   * Heartbeat (ws ping/pong every `heartbeatMs`, dead sockets terminated), hello timeout.
//   * Per-connection high/medium/low send queues: >20KB pauses low, >50KB pauses medium,
//     <10KB restores one level every 250ms. Replaceable states keep only the latest; cosmetic frames
//     expire. The 16MB hard guard reconnects for a full state resync.
//
// Close codes used by the server (clients should NOT auto-reconnect on 4001):
//   4001 session replaced (the same token connected from another socket/tab)
//   4002 hello timeout
//   1008 abusive flooding (rate-limit drops > abuseDropsPerSec)
//   1001 server shutdown
//
// The handler object (implemented by server/lobby.js) receives:
//   onHello(session, { resumed, repeat })  after `welcome` was sent
//   onMessage(session, msg) → { ok: true } | { error: ERR code, detail?: string } | undefined
//   routeGame(session, msg) → same (optional): client-side combat reports `b.progress` / `b.result` (DESIGN §14) go
//                                          straight to the running match through it; without it they reach onMessage
//   onLeaseRecovered(session)              one state-only resync after bounded lease recovery
//   onDisconnect(session)                  the session's socket closed (session kept for the reconnect window)
//   onExpire(session)                      the session was purged (disconnected longer than the window)

import { randomBytes, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { TcpMetrics } from './tcpMetrics.js';
import { PrioritySender, CongestionTrend } from '../shared/sendFlow.js';
import { C2S, validateC2S } from '../shared/protocol.js';
import { ERR, ERR_TEXT, NAME_MAX_LEN, PROTOCOL_VERSION } from '../shared/constants.js';
import { wireMessage } from '../shared/i18n.js';

/** Tunables (all overridable through the Network / SessionRegistry constructors). */
export const NET_DEFAULTS = Object.freeze({
  ratePerSec: 40,               // token bucket refill rate
  rateBurst: 40,                // token bucket capacity
  abuseDropsPerSec: 400,        // rate-limited messages within one second before the socket is closed (1008)
  heartbeatMs: 30_000,          // ping interval
  heartbeatTimeoutMs: 5 * 60_000, // allow suspended background clients five minutes to answer
  helloTimeoutMs: 30_000,       // sockets that never say hello are closed (4002)
  reconnectWindowMs: 10 * 60_000, // disconnected sessions stay resumable this long
  bandwidthMbps: 3,           // WebSocket-only budget; HTTP downloads are excluded
  snapDropBytes: 50 * 1024,    // compatibility override for periodic snapshots
  lowPauseBytes: 20 * 1024,
  mediumPauseBytes: 50 * 1024,
  resumeBytes: 10 * 1024,
  hardBufferBytes: 16 << 20,    // terminate a socket whose send queue exceeds this
  maxConnections: 2000,         // concurrent sockets (enforced by index.js at upgrade time)
  maxConnectionsPerAddr: 64,    // concurrent sockets per client network key (0 = unlimited); see clientAddress
  maxSessions: 20_000,          // registry cap; oldest idle sessions are evicted first
  heavyPerSec: 2,               // refill of the bucket for resend-heavy intents (HEAVY_TYPES)
  heavyBurst: 6,
  trustProxy: 'auto',           // forwarding headers: 'auto' = from loopback/private peers only, true = always, false = never
});

/**
 * Intents that also draw from the per-connection heavy bucket: g.watch (its reply is a large state resend, m.field) and
 * room.loadout (a ≤ 160-entry map validated against the game data; the client debounces its edits), and
 * history.detail (a potentially large saved result).
 */
export const HEAVY_TYPES = new Set(['g.watch', 'room.loadout', 'profile.loadout', 'profile.presentation', 'history.detail', 'spectator.join', 'spectator.watch']);

/** Close codes (see header). */
export const CLOSE = Object.freeze({ REPLACED: 4001, HELLO_TIMEOUT: 4002, ADMIN_KICK: 4003, POLICY: 1008, SHUTDOWN: 1001 });

const WS_OPEN = 1;
const RESUME_PROBE_TIMEOUT_MS = 2000;
const MAX_RID = 2 ** 31;
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// Session & registry
// ---------------------------------------------------------------------------------------------------

/** One logical player identity; survives socket reconnects for the reconnect window. */
export class Session {
  /**
   * @param {{ playerId: string, token: string, name: string, now?: number }} init
   */
  constructor({ playerId, token, name, now = Date.now() }) {
    /** @type {string} public id, shared with other players */
    this.playerId = playerId;
    /** @type {string} secret 128-bit hex reconnect token (only ever sent to its owner) */
    this.token = token;
    /** @type {string} sanitized nickname */
    this.name = name;
    /** @type {import('ws').WebSocket | null} currently bound socket */
    this.ws = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {number} ms epoch of the last inbound frame / pong */
    this.lastSeen = now;
    /** @type {number | null} ms epoch when the socket was lost (null while connected) */
    this.disconnectedAt = now;
    /** @type {string | null} room code — owned and maintained by server/lobby.js */
    this.roomCode = null;
    /** @type {string | null} pending `room.closed` reason to deliver on the next resume (lobby-owned) */
    this.notice = null;
    /** @type {string[] | null} encoded frames (final m.public + m.result) to deliver on the next resume (lobby-owned) */
    this.pendingResult = null;
    /** @type {number} generation of the current transport replay callbacks (lobby-owned) */
    this.pendingResultGeneration = 0;
    /** @type {number} callbacks still outstanding for the current transport replay (lobby-owned) */
    this.pendingResultInFlight = 0;
    /** @type {boolean} whether a transport replay callback failed (lobby-owned) */
    this.pendingResultFailed = false;
    /** @type {number} ms epoch of the last full match resync (lobby-owned; throttles repeated hellos) */
    this.resyncAt = -Infinity;
    /** @type {Record<string, { skill: number, module: string|null }> | null} checked operator loadout (lobby-owned, DESIGN §16) */
    this.loadout = null;
    this.ops = null;
    this.zhajingLoadout = null;
    this.zhajingOps = null;
    /** @type {string | null} anonymous ranked-profile id from hello.aid (localStorage 'sp.aid'; rankedStore key) */
    this.aid = null;
    // 设备输入与公共档案分离；这些字段从不放入公开帧。
    this.clientAid = null;
    this.profileBound = false;
    this.profileName = null;
    this.debugAuthorized = false;
    /** @type {string} client address of the latest connection (logging) */
    this.addr = '?';
    /** @type {string | null} per-network limit key of the latest connection (null = not limited), see clientAddress */
    this.limitKey = null;
    /**
     * @type {number | null} lobby-owned extension of the reconnect window for this session (ms; null = the registry's
     * window). A solo run keeps its session resumable for the official `singleReconnectTime` (24 h) — see lobby.js.
     */
    this.resumeWindowMs = null;
  }
}

/** Random 128-bit hex token. */
export const newToken = () => randomBytes(16).toString('hex');

/** Registry of sessions by playerId and by token; purges sessions disconnected longer than the window. */
export class SessionRegistry {
  /**
   * @param {{ reconnectWindowMs?: number, maxSessions?: number, now?: () => number }} [opts]
   */
  constructor({ reconnectWindowMs = NET_DEFAULTS.reconnectWindowMs, maxSessions = NET_DEFAULTS.maxSessions, now = Date.now,
    debugTokenHashes = (process.env.SP_DEBUG_SESSION_SHA256 || '').split(',') } = {}) {
    // 只接受服务端显式授权的 resume token 哈希；名字和公共 aid 都不是授权凭证。
    this.debugTokenHashes = new Set(debugTokenHashes.filter((hash) => /^[0-9a-f]{64}$/.test(hash)));
    this.reconnectWindowMs = reconnectWindowMs;
    this.maxSessions = maxSessions;
    this.now = now;
    /** @type {Map<string, Session>} */ this.byPlayerId = new Map();
    /** @type {Map<string, Session>} */ this.byTokenMap = new Map();
  }

  get size() { return this.byPlayerId.size; }

  /**
   * Create a new session with a fresh playerId and token. Evicts the oldest idle (disconnected, roomless)
   * session when the registry is full. Returns null when full of active sessions.
   * @param {string} name
   * @returns {Session | null}
   */
  create(name) {
    if (this.byPlayerId.size >= this.maxSessions && !this.evictOne()) return null;
    let playerId;
    do playerId = 'p_' + randomBytes(5).toString('hex'); while (this.byPlayerId.has(playerId));
    let token;
    do token = newToken(); while (this.byTokenMap.has(token));
    const s = new Session({ playerId, token, name, now: this.now() });
    this.byPlayerId.set(playerId, s);
    this.byTokenMap.set(token, s);
    return s;
  }

  /** Rebuild a disconnected identity; transport, login leases and live authorization never come from disk. */
  adopt(doc) {
    if (!doc || typeof doc.playerId !== 'string' || !doc.playerId || typeof doc.token !== 'string' || !doc.token
        || this.byPlayerId.has(doc.playerId) || this.byTokenMap.has(doc.token)
        || this.byPlayerId.size >= this.maxSessions) return null;
    const s = new Session({ playerId: doc.playerId, token: doc.token, name: sanitizeName(doc.name), now: this.now() });
    for (const key of ['roomCode', 'aid', 'clientAid', 'deviceId', 'profileName', 'loadout', 'ops', 'zhajingLoadout', 'zhajingOps', 'notOwned', 'diy',
      'skins', 'portraits', 'card', 'nameplate', 'addr', 'limitKey', 'notice', 'pendingResult',
      'chatStrikes', 'chatLastHitAt', 'chatMutedUntil']) {
      if (Object.hasOwn(doc, key)) s[key] = doc[key];
    }
    s.profileBound = doc.profileBound === true;
    s.profileReady = false;
    s.resumeWindowMs = Number.isFinite(doc.resumeWindowMs) && doc.resumeWindowMs > 0 ? doc.resumeWindowMs : null;
    s.disconnectedAt = Number.isFinite(doc.disconnectedAt) ? doc.disconnectedAt : this.now();
    this.byPlayerId.set(s.playerId, s); this.byTokenMap.set(s.token, s);
    return s;
  }

  /** @param {unknown} token @returns {Session | null} a live (non-expired) session for this token */
  byToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const s = this.byTokenMap.get(token);
    if (!s) return null;
    if (this.isExpired(s, this.now())) return null;
    if (this.debugTokenHashes.has(createHash('sha256').update(token).digest('hex'))) s.debugAuthorized = true;
    return s;
  }

  /** @param {string} playerId @returns {Session | null} */
  byId(playerId) { return this.byPlayerId.get(playerId) || null; }

  /** @param {Session} s */
  remove(s) {
    if (this.byPlayerId.get(s.playerId) === s) this.byPlayerId.delete(s.playerId);
    if (this.byTokenMap.get(s.token) === s) this.byTokenMap.delete(s.token);
  }

  /**
   * The reconnect window of one session: the registry's, or the session's own `resumeWindowMs` when that is longer
   * (the lobby may only extend it, never shorten it).
   * @param {Session} s @returns {number} ms
   */
  windowOf(s) {
    const own = s.resumeWindowMs;
    return typeof own === 'number' && own > this.reconnectWindowMs ? own : this.reconnectWindowMs;
  }

  /** @param {Session} s @param {number} now */
  isExpired(s, now) {
    return !s.connected && s.disconnectedAt != null && now - s.disconnectedAt > this.windowOf(s);
  }

  /**
   * Remove and return every session whose reconnect window has elapsed.
   * @param {number} [now]
   * @returns {Session[]}
   */
  sweep(now = this.now()) {
    const out = [];
    for (const s of this.byPlayerId.values()) if (this.isExpired(s, now)) out.push(s);
    for (const s of out) this.remove(s);
    return out;
  }

  /** Evict the oldest disconnected session that is not in a room. @returns {boolean} */
  evictOne() {
    for (const s of this.byPlayerId.values()) {
      if (!s.connected && !s.roomCode) { this.remove(s); return true; }
    }
    return false;
  }

  /** @returns {IterableIterator<Session>} */
  all() { return this.byPlayerId.values(); }
}

// ---------------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------------

/** Classic token bucket: `burst` capacity, refilled continuously at `ratePerSec`. */
export class TokenBucket {
  /** @param {number} ratePerSec @param {number} burst @param {number} now ms */
  constructor(ratePerSec, burst, now) {
    this.rate = ratePerSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  /** Consume one token. @param {number} now ms @returns {boolean} false when rate-limited */
  take(now) {
    const dt = Math.max(0, now - this.at);
    this.at = now;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Send helpers (never throw)
// ---------------------------------------------------------------------------------------------------

/**
 * JSON-encode a message; returns null (and never throws) on unserializable input.
 * @param {object} msg
 * @returns {string | null}
 */
export function encode(msg) {
  try {
    const prepared = getSendMetadata(msg).encoded;
    if (typeof prepared === 'string') return prepared;
    // 旧文本帧保持原样；结构化消息同时给旧客户端中文 text 和新客户端词典键。
    if ((msg?.t === 'm.toast' || msg?.t === 'm.ticker') && msg.text && typeof msg.text === 'object'
      && typeof msg.text.msgid === 'string') msg = { ...msg, ...wireMessage(msg.text) };
    const s = JSON.stringify(msg);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

// 差量只在实际发送层计算；基准保存JSON副本，不引用会被业务修改的对象。
const STATE_TYPES = new Set(['m.public', 'm.private', 'b.snap', 'b.pool']);
const stateKey = (msg) => msg.t === 'b.snap' ? `b.snap:${msg.fieldId}` : msg.t;
// Broadcast recipients share immutable wire JSON, while sequence/epoch stay per
// connection. Retain a bounded short window so delayed four-field batches also
// reuse parsing/patches across recipients. Other rooms cannot grow this cache.
const stateFrames = new Map();
const stateFrameCells = new WeakMap();
const stateFrameCell = Symbol('stateFrameCell');
const legacyStateFrames = new WeakMap();
let stateFrameBytes = 0;
const wireByteLengths = new Map();
let wireByteLengthBytes = 0;
function encodedByteLength(data) {
  const cached = wireByteLengths.get(data);
  if (cached !== undefined) return cached;
  const bytes = Buffer.byteLength(data);
  if (bytes <= 1024 * 1024) {
    wireByteLengths.set(data, bytes); wireByteLengthBytes += bytes;
    while (wireByteLengths.size > 64 || wireByteLengthBytes > 4 * 1024 * 1024) {
      const oldest = wireByteLengths.keys().next().value;
      wireByteLengthBytes -= wireByteLengths.get(oldest); wireByteLengths.delete(oldest);
    }
  }
  return bytes;
}
// These subtrees are substantial but normally stay identical for a whole
// battle. Native JSON equality avoids walking every legal tile, description,
// skill option and stage cell for each idle panel update. Cache only weakly
// held parsed objects; the exact JSON comparison cannot hide a changed value.
const unchangedStateSubtrees = new Set(['geometry', 'meta', 'rosters', 'stage', 'covenants', 'garrisons',
  'mizukiDifficulty', 'mizukiMutations', 'mizukiVirtues', 'officialWaves', 'officialFacilities',
  'prep', 'exploration', 'expedition', 'roster', 'equipment', 'equipmentRules', 'trainingSource',
  'trainingReport', 'catalogueReport', 'recruitmentRules', 'strategyOptions', 'initialSupplyOptions',
  'recruitGroups', 'difficultyOptions', 'squads', 'selectedSquad', 'strategy', 'initialSupply', 'recruitGroup']);
const stateSubtreeJson = new WeakMap();
const stateSubtreeLengths = new WeakMap();
const protectedStateKeys = new Set(['__proto__', 'prototype', 'constructor']);
function objectKeys(value) {
  const keys = Object.keys(value);
  keys.hasProtected = keys.some(key => protectedStateKeys.has(key));
  return keys;
}
function subtreeJson(value) {
  let json = stateSubtreeJson.get(value);
  if (json === undefined) { json = JSON.stringify(value); stateSubtreeJson.set(value, json); }
  return json;
}
// These values belong only to JSON.parse snapshots, never live game objects.
// Native serialization sizes a replacement without per-leaf caches or a
// handwritten parser competing with battle simulation on the event loop.
function subtreeJsonLength(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value).length;
  const cached = stateSubtreeLengths.get(value);
  if (cached !== undefined) return cached;
  // Parsed wire frames and equality-compared subtrees already retain their
  // exact serialized JSON. Reuse its length instead of serializing the same
  // immutable battle/public state again for each replacement candidate.
  const length = subtreeJson(value).length;
  stateSubtreeLengths.set(value, length);
  return length;
}
function parseStateFrame(data, cell) {
  if (cell?.data === data && cell.frame) return cell.frame;
  const cached = stateFrames.get(data);
  if (cached) {
    stateFrames.delete(data); stateFrames.set(data, cached);
    if (cell?.data === data) cell.frame = cached;
    return cached;
  }
  const frame = { data, bytes: encodedByteLength(data), msg: JSON.parse(data), patches: new WeakMap() };
  if (frame.msg && typeof frame.msg === 'object') stateSubtreeJson.set(frame.msg, data);
  if (STATE_TYPES.has(frame.msg?.t) && frame.bytes <= 1024 * 1024) {
    stateFrames.set(data, frame); stateFrameBytes += frame.bytes;
    while (stateFrames.size > 16 || stateFrameBytes > 2 * 1024 * 1024) {
      const oldest = stateFrames.keys().next().value;
      stateFrameBytes -= stateFrames.get(oldest).bytes; stateFrames.delete(oldest);
    }
  }
  if (cell?.data === data) cell.frame = frame;
  return frame;
}
const emptyStatePatch = Object.freeze(Object.assign([], { jsonLength: 2 }));
function replacementPatch(path, after, pathLength = JSON.stringify(path).length) {
  const patch = [[path, after]];
  patch.jsonLength = 5 + pathLength + subtreeJsonLength(after);
  return patch;
}
function statePatch(before, after, path = [], pathLength = 2) {
  if (before === after) return emptyStatePatch;
  const a = before && typeof before === 'object', b = after && typeof after === 'object';
  if (!a || !b || Array.isArray(before) !== Array.isArray(after)
      || (Array.isArray(after) && before.length !== after.length)) return replacementPatch(path, after, pathLength);
  const beforeKeys = objectKeys(before), afterKeys = objectKeys(after);
  if (beforeKeys.hasProtected || afterKeys.hasProtected) return replacementPatch(path, after, pathLength);
  if (unchangedStateSubtrees.has(path.at(-1))) {
    const previousJson = subtreeJson(before), nextJson = subtreeJson(after);
    if (previousJson === nextJson && !/"(?:__proto__|prototype|constructor)":/.test(nextJson)) return emptyStatePatch;
  }
  const patch = [];
  let jsonLength = 2;
  let replace;
  const append = child => {
    if (!child.length) return;
    jsonLength += child.jsonLength - 2 + (patch.length ? 1 : 0);
    patch.push(...child);
  };
  const childPathLength = key => pathLength + (path.length ? 1 : 0) + JSON.stringify(key).length;
  for (const key of beforeKeys) if (!Object.hasOwn(after, key)) {
    const removedPath = [...path, key], removed = [[removedPath]];
    removed.jsonLength = 4 + childPathLength(key); append(removed);
    replace ||= replacementPatch(path, after, pathLength);
    if (jsonLength >= replace.jsonLength) return replace;
  }
  for (const key of afterKeys) {
    // Identical primitive leaves require neither a path allocation nor JSON
    // sizing. This is the dominant case in twenty-Hz battle snapshots.
    if (Object.hasOwn(before, key) && before[key] === after[key]) continue;
    const length = childPathLength(key);
    if (!Object.hasOwn(before, key)) append(replacementPatch([...path, key], after[key], length));
    else append(statePatch(before[key], after[key], [...path, key], length));
    if (patch.length) {
      replace ||= replacementPatch(path, after, pathLength);
      if (jsonLength >= replace.jsonLength) return replace;
    }
  }
  // 无变化的子树无需反复序列化整棵替换候选；输出仍是同一个空差量。
  if (!patch.length) return emptyStatePatch;
  patch.jsonLength = jsonLength;
  replace ||= replacementPatch(path, after, pathLength);
  // Exact JSON lengths propagate bottom-up. Serializing the entire patch and
  // replacement again at every ancestor made parallel rooms quadratic work.
  return jsonLength < replace.jsonLength ? patch : replace;
}

function referenceBattleFields(frame, conn) {
  const fields = frame.msg.mizuki?.fields;
  if (!conn.compactEnabled || frame.msg.t !== 'm.public' || !Array.isArray(fields) || !fields.length) return frame;
  let mask = '';
  const references = fields.map(field => {
    if (conn.streamEnabled && field?.fieldId !== (conn.streamFieldId || conn.ownFieldId)) {
      mask += 'h';
      frame.overviews ||= new WeakMap();
      let overview = frame.overviews.get(field);
      if (!overview) {
        overview = {};
        for (const [key, value] of Object.entries(field)) if (value == null || ['string', 'number', 'boolean'].includes(typeof value)
          || key.startsWith('objective') || ['players', 'damageRows', 'dps', 'dp'].includes(key)) overview[key] = value;
        frame.overviews.set(field, overview);
      }
      return ['$h', overview];
    }
    const delivered = conn.stateBases.get('b.snap:' + field?.fieldId)?.v;
    const reusable = delivered?.battleId === field?.battleId && delivered?.fieldId === field?.fieldId
      && delivered?.time === field?.t;
    mask += reusable ? '1' : '0';
    return reusable ? ['$b', field.fieldId, field.battleId] : field;
  });
  if (!mask.includes('1') && !mask.includes('h')) return frame;
  frame.references ||= new Map();
  let compact = frame.references.get(mask);
  if (!compact) {
    const msg = { ...frame.msg, mizuki: { ...frame.msg.mizuki, fields: references } };
    const data = JSON.stringify(msg);
    stateSubtreeJson.set(msg, data);
    compact = { data, msg, bytes: Buffer.byteLength(data), patches: new WeakMap() };
    frame.references.set(mask, compact);
  }
  return compact;
}
function prepareState(conn, data, options) {
  if (!conn?.deltaEnabled) return { data };
  // 正常发送已有服务端分类；非状态帧无需为每位收件人再次 JSON.parse。
  // 未分类的 sendRaw 及所有基准失效边界仍走原来的解析/清理流程。
  if (typeof options.type === 'string' && options.type !== 'welcome' && !STATE_TYPES.has(options.type)
      && !options.clearDeferred && !options.clearBattle && options.clearField == null) return { data };
  let frame;
  try { frame = parseStateFrame(data, options[stateFrameCell]); } catch { return { data }; }
  let msg = frame.msg;
  if (options.clearDeferred || options.clearBattle || options.clearField != null || msg?.t === 'welcome') {
    conn.stateBases.clear();
    conn.stateEpoch++;
  }
  if (!STATE_TYPES.has(msg?.t)) return { data };
  if (conn.streamEnabled && msg.t === 'm.private' && typeof msg.mizuki?.fieldId === 'string') {
    const previous = conn.ownFieldId; conn.ownFieldId = msg.mizuki.fieldId;
    if (!conn.streamManual || !conn.streamFieldId || conn.streamFieldId === previous) conn.streamFieldId = conn.ownFieldId;
  }
  if (conn.streamEnabled && msg.t === 'm.public' && Array.isArray(msg.mizuki?.fields)) {
    const fields = msg.mizuki.fields;
    if (!fields.some(field => field.fieldId === conn.streamFieldId)) {
      conn.streamManual = false;
      conn.streamFieldId = fields.find(field => field.fieldId === conn.ownFieldId)?.fieldId
        || fields.find(field => field.players?.includes(conn.session?.playerId))?.fieldId || fields[0]?.fieldId || null;
    }
  }
  frame = referenceBattleFields(frame, conn); msg = frame.msg; data = frame.data;
  const key = stateKey(msg), previous = conn.stateBases.get(key);
  const next = (previous?.n || 0) + 1;
  const compactTag = conn.compactEnabled && msg.t === 'm.public' && msg.mizuki ? ',"c":1' : '';
  // data 已是完整 JSON；直接嵌入封装，避免每位收件人再序列化同一状态正文。
  const fullPrefix = `{"t":"net.state","e":${conn.stateEpoch},"k":${JSON.stringify(key)},"n":${next}${compactTag},"v":`;
  const full = fullPrefix + data + '}';
  const fullBytes = Buffer.byteLength(fullPrefix) + frame.bytes + 1;
  let encoded = full, bytes = fullBytes;
  if (previous) {
    let patch = frame.patches.get(previous.v);
    if (!patch) {
      const operations = statePatch(previous.v, msg);
      const json = JSON.stringify(operations);
      patch = { empty: !operations.length, json, bytes: Buffer.byteLength(json) };
      frame.patches.set(previous.v, patch);
    }
    // 相同状态不占链路，也不推进差量序号；恢复/结束等带完成回调的帧仍实际发送。
    if (patch.empty && !options.onComplete) return { skip: true };
    const deltaPrefix = `{"t":"net.delta","e":${conn.stateEpoch},"k":${JSON.stringify(key)},"b":${previous.n},"n":${next}${compactTag},"p":`;
    const delta = deltaPrefix + patch.json + '}';
    const deltaBytes = Buffer.byteLength(deltaPrefix) + patch.bytes + 1;
    // 不划算的差量走全量；压缩仍作用于两种帧。
    if (deltaBytes < fullBytes * 0.85) { encoded = delta; bytes = deltaBytes; }
  }
  return { data: encoded, bytes, commit() {
    conn.stateBases.delete(key);
    conn.stateBases.set(key, { n: next, v: msg });
    if (conn.stateBases.size > 64) conn.stateBases.delete(conn.stateBases.keys().next().value);
  } };
}

// 本Network仅跟踪游戏WebSocket的TCP计数；不会注册HTTP下载连接。
class BandwidthBudget {
  constructor(mbps, now) {
    this.now = now;
    this.rate = mbps * 1_000_000 / 8 * 0.8;
    this.baseMs = mbps <= 3 ? 400 : 250;
    this.capacity = this.rate / 4;
    this.tokens = this.capacity;
    this.at = now();
    this.sampleAt = this.at;
    this.sockets = new Map();
    this.bytes = 0;
    this.writtenBytes = 0;
    this.bytesPerSecond = 0;
    this.factor = 1;
  }
  register(ws) {
    const socket = ws._socket;
    if (socket) this.sockets.set(ws, { socket, last: socket.bytesWritten || 0 });
  }
  collect(ws) {
    const item = this.sockets.get(ws);
    if (!item) return;
    const written = item.socket.bytesWritten || 0;
    const delta = Math.max(0, written - item.last);
    item.last = written;
    this.bytes += delta;
    this.writtenBytes += delta;
    this.tokens -= delta;
  }
  remove(ws) { this.collect(ws); this.sockets.delete(ws); }
  sample() {
    const now = this.now(), dt = Math.max(0, now - this.at);
    this.at = now;
    this.tokens = Math.min(this.capacity, this.tokens + this.rate * dt / 1000);
    if (now - this.sampleAt < 250) return;
    for (const ws of this.sockets.keys()) this.collect(ws);
    const elapsed = now - this.sampleAt;
    const rate = this.bytes * 1000 / elapsed;
    this.bytes = 0;
    this.sampleAt = now;
    this.bytesPerSecond = this.bytesPerSecond * 0.5 + rate * 0.5;
    if (Math.max(rate, this.bytesPerSecond) > this.rate * 0.9) this.factor = Math.min(4, this.factor + 0.5);
    else if (this.bytesPerSecond < this.rate * 0.6) this.factor = Math.max(1, this.factor - 0.125);
  }
  buffered() {
    this.sample();
    return this.tokens <= 0 ? NET_DEFAULTS.mediumPauseBytes + 1
      : this.tokens < this.capacity * 0.25 ? NET_DEFAULTS.lowPauseBytes + 1 : 0;
  }
  reserve(bytes, { deferToWire = false } = {}) {
    this.sample();
    // Deflate's pending input is bounded separately from the actual TCP
    // queue. Debiting its uncompressed bytes as line traffic falsely paused
    // every other room until hysteresis recovered after tiny compressed writes.
    const reserved = deferToWire ? 0 : bytes;
    this.tokens -= reserved;
    return () => {
      this.tokens = Math.min(this.capacity, this.tokens + reserved);
    };
  }
  interval() { this.sample(); return Math.min(2000, this.baseMs * this.factor); }
  close() { this.sockets.clear(); }
}

// 发送调用者不变；在 terminate 同步触发 close 前记录连接的硬终止原因。
const socketConnections = new WeakMap();
function compressedSocket(ws) {
  return typeof ws.extensions === 'string' && ws.extensions.split(',').some(extension => extension.trim() === 'permessage-deflate')
    && Number.isFinite(ws._socket?.writableLength);
}
function socketPacingBuffered(ws, limits = NET_DEFAULTS) {
  const raw = Math.max(0, ws.bufferedAmount || 0);
  if (!compressedSocket(ws)) return raw;
  const wire = Math.max(0, ws._socket.writableLength), compression = Math.max(0, raw - wire);
  // Keep real slow-socket thresholds unchanged. Compression work has its own
  // finite soft limits; the existing raw sixteen-MiB write guard still applies.
  return Math.max(wire, compression > 1024 * 1024 ? limits.mediumPauseBytes + 1
    : compression > 512 * 1024 ? limits.lowPauseBytes + 1 : 0);
}
export function clearPendingPool(ws) { socketConnections.get(ws)?.clearPendingPool(); }
export function clearDeferred(ws) { socketConnections.get(ws)?.flow.clear((entry) => entry.priority !== 'high'); }
const CLOSE_REASONS = new Set(['session replaced', 'hello timeout', 'admin kick', 'rate limit', 'server shutdown',
  'login lease expired', 'message backlog', 'login rejected', 'login unavailable', 'session released',
  'server switch', 'server switch failed']);
const safeCloseReason = (reason) => {
  const text = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
  return CLOSE_REASONS.has(text) ? text : text ? '[redacted]' : '';
};
const POLICY_CLOSE_CAUSES = Object.freeze({
  'rate limit': 'rate_limit', 'login lease expired': 'login_lease_expired', 'message backlog': 'message_backlog',
  'login rejected': 'login_rejected', 'login unavailable': 'login_unavailable', 'session released': 'session_released',
});
const closeCause = (code, reason) => code === CLOSE.POLICY
  ? POLICY_CLOSE_CAUSES[safeCloseReason(reason)] || 'policy_close' : ({
  [CLOSE.REPLACED]: 'session_replaced', [CLOSE.HELLO_TIMEOUT]: 'hello_timeout',
  [CLOSE.SHUTDOWN]: 'server_shutdown', [CLOSE.ADMIN_KICK]: 'admin_kick',
})[code] || 'server_close';

export function terminateSocket(ws, cause, detail = {}) {
  const conn = socketConnections.get(ws);
  if (conn) { conn.closing = true; conn.stopPeriodic(); }
  if (conn && !conn.terminationCause) {
    conn.terminationCause = cause;
    conn.event('ws_terminate', { cause: conn.closeCause || cause, terminationCause: cause, ...detail }, 'warn');
  }
  ws.terminate();
}

/**
 * Send an encoded frame through the connection's priority queues. False can mean deferred/coalesced;
 * callbacks still belong to actual WebSocket writes. Unregistered sockets retain direct reliable sends.
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {string} data
 * @param {{ droppable?: boolean, onComplete?: (err?: Error) => void }} [opts]
 * @returns {boolean} true when the frame was queued
 */
export function sendRaw(ws, data, options = {}) {
  if (!ws || ws.readyState !== WS_OPEN || typeof data !== 'string') return false;
  try {
    const conn = socketConnections.get(ws);
    if (conn?.closing) return false;
    if (!conn) return writeRaw(ws, data, options);
    if (!conn.fieldMetadataEnabled && typeof options.legacyMessage === 'function') {
      let legacy = legacyStateFrames.get(options);
      if (!legacy || legacy.source !== data) {
        const message = options.legacyMessage();
        legacy = { source: data, data: encode(message), options: sendOptions(message) };
        legacyStateFrames.set(options, legacy);
      }
      data = legacy.data; options = legacy.options;
      if (data == null) return false;
    }
    if (conn.streamEnabled && options.type === 'b.snap' && options.periodic && options.cadenceMs != null
      && (conn.streamFieldId || conn.ownFieldId) && options.fieldId !== (conn.streamFieldId || conn.ownFieldId)) return true;
    if (options.clearDeferred) conn.flow.clear((entry) => entry.priority !== 'high');
    if (options.clearField != null) conn.flow.clear((entry) => entry.priority !== 'high'
      && entry.options.fieldId === options.clearField);
    if (options.clearBattle) conn.flow.clear((entry) => entry.priority !== 'high'
      && ['b.snap', 'b.pool', 'b.ev'].includes(entry.options.type));
    if (options.clearPool) conn.clearPendingPool();
    const priority = options.onComplete ? 'high' : options.priority
      || (options.droppable || options.category === 'pool' ? 'medium' : 'high');
    const key = options.key ?? (options.category === 'pool' ? 'b.pool' : null);
    // A four-field broadcast can outlive the small global LRU while sibling
    // sockets wait for their sender drain. Retain one lazy parsed JSON copy
    // with the queued options, keyed by the exact immutable encoded string.
    // Coalesced-away frames are never parsed, and no live game object is held.
    let cell;
    if (conn.deltaEnabled && STATE_TYPES.has(options.type)) {
      cell = stateFrameCells.get(options);
      if (cell?.data !== data) { cell = { data, frame: null }; stateFrameCells.set(options, cell); }
    }
    return conn.flow.enqueue(data, { ...options, priority, key,
      ...(cell ? { [stateFrameCell]: cell } : {}),
      periodic: options.periodic ?? (options.droppable || options.category === 'pool'),
      onOverflow: priority === 'medium' ? () => terminateSocket(ws, 'deferred_buffer_limit') : null });
  } catch {
    try { terminateSocket(ws, 'send_error'); } catch { /* 已关闭 */ }
    return false;
  }
}

// 只在真正写入WebSocket时确认预算及完成回调；应用队列没有伪造回执。
function writeRaw(ws, data, options = {}) {
  const { onComplete = null } = options;
  let release = null;
  try {
    const conn = socketConnections.get(ws);
    if (ws.readyState !== WS_OPEN || conn?.closing) return false;
    const session = conn?.session;
    if (session?.loginRevoked) {
      session.profileReady = false;
      terminateSocket(ws, 'login_lease_lost');
      return false;
    }
    // Transport-only controls do not authorize play. Expiry is resolved by the bounded authority
    // check, not by an unrelated outgoing snapshot racing its renewal callback.
    const leaseControl = options.type === 'pong' || options.type === 'session.lease';
    if (session?.loginLease && performance.now() >= session.leaseUntil && !leaseControl) {
      // No business frame leaves while uncertain. The same bounded check owns all failure handling.
      if (!session.loginInFlight) void conn?.network?.ensureCurrentSession(conn).catch(() => {});
      return false;
    }
    if (session?.loginReleased) {
      const type = JSON.parse(data).t;
      if (type !== 'ok' && type !== 'error') return false;
    }
    const frame = prepareState(conn, data, options);
    if (frame.skip) return true;
    const limits = conn?.opts || NET_DEFAULTS;
    const queued = ws.bufferedAmount || 0, bytes = frame.bytes ?? Buffer.byteLength(frame.data);
    if (queued + bytes > limits.hardBufferBytes) {
      terminateSocket(ws, 'hard_buffer_limit', { bufferedBytes: queued, frameBytes: bytes, hardBufferBytes: limits.hardBufferBytes });
      return false;
    }
    release = conn?.bandwidth.reserve(bytes, { deferToWire: compressedSocket(ws) });
    ws.send(frame.data, (err) => {
      release?.();
      release = null;
      conn?.bandwidth.collect(ws);
      try { onComplete?.(err || undefined); } catch { /* recovery bookkeeping must not block close */ }
      if (err) {
        try { terminateSocket(ws, 'send_error'); } catch { /* 已关闭 */ }
      }
    });
    // ws按调用顺序压缩/发送；合并或淘汰的应用队列条目从不提交基准。
    if (!conn?.closing) frame.commit?.();
    return true;
  } catch {
    release?.();
    try { terminateSocket(ws, 'send_error'); } catch { /* 已关闭 */ }
    return false;
  }
}

// 分类只在进程内传递，不能进入协议 JSON；未标记的池帧视为可靠恢复帧。


/** 仅周期战斗快照可因背压跳过；基础/重同步和结束快照显式排除。 */
export const isDroppable = (msg) => !!msg && msg.t === 'b.snap' && msg.droppable !== false;
const LOW_EVENTS = new Set(['heal', 'layer', 'bounty']);
const LOW_FX = new Set(['heal', 'healAoe', 'bandage', 'blessing', 'cleanse', 'hpShare',
  'spGift', 'spGain', 'reload', 'sp', 'shield', 'catShield', 'saltWard', 'shell',
  'vest', 'sleepGuard', 'truesilver', 'shieldBreak', 'dp', 'coin', 'steal', 'lpLoss',
  'dodge', 'riposte', 'counter', 'block', 'thorns', 'pulse', 'ripple', 'sonic', 'sermon']);
function cosmeticEvent(ev) {
  if (!Array.isArray(ev)) return false;
  if (LOW_EVENTS.has(ev[0])) return true;
  const extra = ev[4];
  return ev[0] === 'fx' && LOW_FX.has(ev[1])
    && !(extra && typeof extra === 'object' && (Object.hasOwn(extra, 'form') || extra.consumed));
}

export function sendOptions(msg) {
  const metadata = getSendMetadata(msg);
  const t = msg?.t;
  const droppable = isDroppable(msg);
  const pool = metadata.category === 'pool';
  const low = ['chat.message', 'm.toast', 'm.ticker'].includes(t)
    || (t === 'b.ev' && !metadata.core && msg.ev?.length > 0 && msg.ev.every(cosmeticEvent));
  const priority = metadata.priority || (low ? 'low' : droppable || pool ? 'medium' : 'high');
  const key = metadata.key ?? (t === 'b.snap' ? `b.snap:${msg.fieldId}`
    : t === 'b.pool' ? 'b.pool' : ['m.public', 'm.private'].includes(t) ? t : null);
  const reset = ['m.result', 'room.closed', 'room.state', 'spectator.state', 'spectator.closed'].includes(t);
  return {
    ...metadata, type: t, fieldId: msg?.fieldId, priority, key,
    periodic: metadata.periodic ?? (droppable || pool),
    droppable, category: metadata.category || 'reliable',
    clearDeferred: reset,
    clearField: ['m.field', 'b.end'].includes(t) || (t === 'b.snap' && !droppable) ? msg.fieldId : null,
    clearBattle: t === 'b.start' || !!metadata.clearBattle,
    clearPool: metadata.clearPool || (t === 'b.pool' && !pool)
      || ['b.end', 'b.start', 'm.result', 'room.closed', 'room.state'].includes(t)
      || (t === 'm.public' && msg.phase != null && !['FINAL_ASSAULT', 'HIDDEN_CORE'].includes(msg.phase)),
  };
}

/**
 * Encode and send one message to a socket. Never throws.
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {object} msg
 * @returns {boolean}
 */
export function send(ws, msg) {
  const data = encode(msg);
  if (data == null) return false;
  return sendRaw(ws, data, sendOptions(msg));
}

/**
 * Send to a session's current socket (no-op while disconnected). Never throws.
 * @param {Session | null | undefined} session
 * @param {object} msg
 * @returns {boolean}
 */
export function sendSession(session, msg) {
  if (!session || !session.connected || session.profileReady === false || session.loginReleased || session.loginRevoked) return false;
  if (session.loginLease && performance.now() >= session.leaseUntil) {
    const conn = socketConnections.get(session.ws);
    if (!session.loginInFlight && conn?.session === session) void conn.network?.ensureCurrentSession(conn).catch(() => {});
    return false;
  }
  return send(session.ws, msg);
}

/** @param {unknown} rid */
const validRid = (rid) => Number.isInteger(rid) && rid >= 0 && rid <= MAX_RID;

/**
 * True for a real ERR code (own property; rejects inherited names like "constructor").
 * @param {unknown} code
 * @returns {boolean}
 */
export const isErrCode = (code) => typeof code === 'string' && Object.hasOwn(ERR, code);

/**
 * Build an `error` frame.
 * @param {string} code ERR code
 * @param {unknown} [rid]
 * @param {string} [detail] developer-facing reason
 */
export function errorMsg(code, rid, detail) {
  const known = isErrCode(code);
  const m = { t: 'error', code: known ? code : ERR.INTERNAL, msg: known ? ERR_TEXT[code] || ERR_TEXT.INTERNAL : ERR_TEXT.INTERNAL };
  if (validRid(rid)) m.rid = rid;
  if (detail) m.detail = String(detail).slice(0, 120);
  return m;
}

// ---------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------

// Control chars, zero-width & bidi controls, BOM.
const STRIP_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const hexEscape = (n) => '\\u' + n.toString(16).padStart(4, '0');
const STRIP_RE = new RegExp('[' + STRIP_RANGES.map(([a, b]) => (a === b ? hexEscape(a) : `${hexEscape(a)}-${hexEscape(b)}`)).join('') + ']', 'g');
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Normalize a nickname: strip control/invisible characters and lone surrogates, collapse whitespace,
 * trim, cap at NAME_MAX_LEN code points. Returns null when nothing printable remains.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').replace(LONE_SURROGATE_RE, '').replace(/\s+/g, ' ').replace(STRIP_RE, '').replace(/ {2,}/g, ' ').trim();
  s = [...s].slice(0, NAME_MAX_LEN).join('').trim();
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------------------------------
// Client addresses (per-network limits)
// ---------------------------------------------------------------------------------------------------

/**
 * Canonical textual IP: lowercase, zone id stripped, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → IPv4.
 * @param {unknown} raw
 * @returns {string} '' when not an IP address
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  const withPort = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s); // [v6]:port, v4:port
  if (withPort) s = withPort[1];
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (isIP(s) === 6) {
    const g = ipv6Groups(s);
    if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) s = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return isIP(s) ? s : '';
}

/** Expand an IPv6 address into 8 numeric groups (null when malformed). @param {string} ip */
function ipv6Groups(ip) {
  let s = ip;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Loopback or private-network address (RFC 1918, link-local, CGNAT/Tailscale, IPv6 ULA / link-local).
 * @param {string} ip normalized
 */
export function isLocalIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.every((x, i) => (i < 7 ? x === 0 : x <= 1))) return true; // ::1 and ::
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * The key per-network limits count against: the IPv4 address, or the /64 prefix of an IPv6 address
 * (one subscriber typically owns a whole /64).
 * @param {string} ip normalized
 */
export function limitKeyOf(ip) {
  if (isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : ip;
}

/** The client address a trusted local proxy forwards (null when it sent none). */
function forwardedAddress(headers) {
  if (!headers) return null;
  const one = (h) => (Array.isArray(h) ? h[h.length - 1] : h);
  for (const name of ['cf-connecting-ip', 'x-real-ip']) {
    const ip = normalizeIp(one(headers[name]));
    if (ip) return ip;
  }
  const xff = one(headers['x-forwarded-for']);
  if (typeof xff === 'string') {
    // The rightmost entry was appended by the proxy nearest to us; earlier ones are client-controlled.
    const parts = xff.split(',');
    const ip = normalizeIp(parts[parts.length - 1]);
    if (ip) return ip;
  }
  return null;
}

/**
 * Resolve an upgrade request's client address and its per-network limit key.
 * Forwarding headers are honoured from loopback/private peers ('auto'), always (true) or never (false).
 * Local/private peers without a forwarded address get `key: null` (never limited per network).
 * @param {import('node:http').IncomingMessage | undefined} req
 * @param {'auto' | boolean} [trustProxy]
 * @returns {{ ip: string, key: string | null }}
 */
export function clientAddress(req, trustProxy = NET_DEFAULTS.trustProxy) {
  const peer = normalizeIp(req?.socket?.remoteAddress);
  const local = !peer || isLocalIp(peer);
  if (trustProxy === true || (trustProxy !== false && local)) {
    const fwd = forwardedAddress(req?.headers);
    if (fwd) return { ip: fwd, key: isLocalIp(fwd) ? null : limitKeyOf(fwd) };
  }
  if (local) return { ip: peer || '?', key: null };
  return { ip: peer, key: limitKeyOf(peer) };
}

// ---------------------------------------------------------------------------------------------------
// Network: per-socket pipeline
// ---------------------------------------------------------------------------------------------------

/** Per-socket state. */
class Connection {
  /** @param {import('ws').WebSocket} ws @param {{ ip: string, key: string | null }} addr @param {number} now @param {typeof NET_DEFAULTS} opts */
  constructor(ws, addr, now, opts, log, clock, monotonicNow, tcpMetrics, bandwidth) {
    this.bandwidth = bandwidth;
    this.deltaEnabled = false;
    this.compactEnabled = false;
    this.streamEnabled = false;
    this.fieldMetadataEnabled = false;
    this.streamFieldId = null;
    this.streamManual = false;
    this.ownFieldId = null;
    this.stateBases = new Map();
    this.stateEpoch = 0;
    this.monotonicNow = monotonicNow;
    this.tcpMetrics = tcpMetrics;
    this.pingProbe = null;
    this.rtt = null;
    this.rttAt = null;
    this.lastPoolAt = -Infinity;
    this.lastSnapAt = -Infinity;
    this.trend = new CongestionTrend({ now: monotonicNow, expiryMs: opts.heartbeatMs * 2 });
    this.flow = new PrioritySender({
      buffered: () => Math.max(socketPacingBuffered(ws, opts), this.bandwidth.buffered()),
      send: (data, options) => writeRaw(ws, data, options),
      now: monotonicNow, interval: entry => this.periodicInterval(this.deltaEnabled ? entry?.options.cadenceMs : undefined), batchSize: 4,
      sizeOf: encodedByteLength,
      hardBytes: opts.hardBufferBytes, lowBytes: opts.lowPauseBytes,
      mediumBytes: Math.min(opts.mediumPauseBytes, opts.snapDropBytes),
      resumeBytes: Math.min(opts.resumeBytes, opts.snapDropBytes / 2),
    });
    this.log = log;
    this.now = clock;
    this.opts = opts;
    this.connectionId = 'c_' + randomBytes(6).toString('hex');
    this.targetId = 'c_' + randomBytes(16).toString('hex');
    this.closeCause = null;
    this.terminationCause = null;
    this.requestedCloseCode = null;
    this.detachedIdentity = null;
    this.closeLogged = false;
    this.ws = ws;
    this.ip = addr.ip;
    /** @type {string | null} per-network limit key (see clientAddress) */
    this.key = addr.key;
    this.openedAt = now;
    this.alive = true;
    /** @type {Session | null} */
    this.session = null;
    this.bucket = new TokenBucket(opts.ratePerSec, opts.rateBurst, now);
    this.heavy = new TokenBucket(opts.heavyPerSec, opts.heavyBurst, now);
    this.dropWindowAt = now;
    this.drops = 0;
    /** true once the server initiated the close; frames still in flight are ignored */
    this.closing = false;
  }

  periodicInterval(cadenceMs) {
    const now = this.monotonicNow();
    const tcp = this.tcpMetrics.get(this);
    const rtt = tcp?.rttMs ?? (this.rttAt != null
      && now - this.rttAt <= this.opts.heartbeatMs * 2 ? this.rtt : null);
    const normalInterval = this.bandwidth.interval();
    const explicitCadence = Number.isFinite(cadenceMs) && cadenceMs >= 10 && cadenceMs <= 2000;
    const interval = explicitCadence ? normalInterval / this.bandwidth.baseMs * cadenceMs : normalInterval;
    // Absolute RTT is latency, not evidence that a healthy 20 Hz snapshot
    // stream is congested. Explicit battle cadence still follows measured
    // bandwidth, retransmission/RTT trend and buffered-byte backpressure.
    return Math.min(2000, Math.max(interval * this.trend.factor(now), explicitCadence ? 0 : (rtt || 0) * 2,
      socketPacingBuffered(this.ws, this.opts) > this.opts.lowPauseBytes ? 1000 : 0));
  }

  onTcpSample(sample) {
    this.trend.expiryMs = this.tcpMetrics.expiryMs;
    this.trend.update({ source: 'tcp', at: sample.sampledAt,
      rtt: sample.rttMs, retransDelta: sample.retransDelta });
  }

  clearPendingPool() { this.flow.clear((entry) => entry.key === 'b.pool'); }

  onPong(data) {
    this.alive = true;
    const probe = this.pingProbe;
    if (!probe || !Buffer.isBuffer(data) || !data.equals(probe.payload)) return;
    this.pingProbe = null;
    const now = this.monotonicNow();
    const rtt = now - probe.at;
    if (rtt < 0 || rtt > this.opts.heartbeatMs) return;
    this.rtt = rtt;
    this.rttAt = now;
    const tcp = this.tcpMetrics.get(this);
    if (!tcp) {
      this.trend.expiryMs = this.opts.heartbeatMs * 2;
      this.trend.update({ source: 'rtt', at: now, rtt });
    }
    this.event('ws_metrics', { rttMs: rtt, tcpRttMs: tcp?.rttMs ?? null,
      totalRetrans: tcp?.totalRetrans ?? null, retransDelta: tcp?.retransDelta ?? null,
      periodicIntervalMs: this.periodicInterval() });
  }

  stopPeriodic() {
    this.flow.close();
    this.trend.clear();
    this.pingProbe = null;
    this.rtt = null;
    this.rttAt = null;
    this.tcpMetrics.remove(this);
    this.bandwidth.remove(this.ws);
    this.stateBases.clear();
  }

  identity() {
    return this.session ? { playerId: this.session.playerId, roomCode: this.session.roomCode || this.session.spectatorCode || null } :
      this.detachedIdentity || { playerId: null, roomCode: null };
  }

  event(event, detail = {}, level = 'info') {
    // 只选取诊断字段，不序列化会话、请求、名字或凭证；日志失败不影响连接机制。
    try {
      this.log[level]?.('[net] ' + JSON.stringify({
        event, time: this.now(), connectionId: this.connectionId, ...this.identity(),
        ageMs: this.now() - this.openedAt, bufferedBytes: this.ws.bufferedAmount,
        requestedCloseCode: this.requestedCloseCode, ...detail,
      }));
    } catch { /* 日志不可阻断关闭或发送 */ }
  }

  /** Server-initiated close (never throws). Later frames from this socket are ignored. */
  close(code, reason) {
    this.closing = true;
    this.stopPeriodic();
    if (!this.closeCause) {
      this.closeCause = closeCause(code, reason);
      this.requestedCloseCode = code;
      this.event('ws_close_requested', { cause: this.closeCause, closeReason: safeCloseReason(reason) });
    }
    try { this.ws.close(code, reason); } catch { /* ignore */ }
  }
}

/** Frames larger than this are not parsed just to echo a rid on a RATE error (CPU guard). */
const PEEK_RID_MAX_BYTES = 2048;

/** Owns every live socket; turns frames into validated messages for the handler. */
export class Network {
  /**
   * @param {{
   *   registry: SessionRegistry,
   *   handler: { onHello?: Function, onMessage: Function, onDisconnect?: Function, onExpire?: Function, onLeaseRecovered?: Function, welcomeInfo?: Function },
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   now?: () => number,
   *   options?: Partial<typeof NET_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, handler, log = noopLog, now = Date.now, options = {},
    monotonicNow = () => performance.now(), tcpMetrics = new TcpMetrics({ now: monotonicNow }) }) {
    this.registry = registry;
    this.handler = handler;
    this.log = log;
    this.now = now;
    this.opts = { ...NET_DEFAULTS, ...options };
    this.monotonicNow = monotonicNow;
    this.tcpMetrics = tcpMetrics;
    this.bandwidth = new BandwidthBudget(this.opts.bandwidthMbps, monotonicNow);
    this.loadPrevious = { at: monotonicNow(), bytes: 0 };
    /** @type {Map<import('ws').WebSocket, Connection>} */
    this.conns = new Map();
    /** @type {Map<string, number>} open sockets per client network key */
    this.connsPerKey = new Map();
    this.closed = false;
    this.draining = false;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
    this.heartbeatTimer.unref?.();
    const sweepMs = Math.max(20, Math.min(15_000, Math.floor(this.opts.reconnectWindowMs / 4)));
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  async adminKick(targetId) {
    const conn = [...this.conns.values()].find((item) => item.targetId === targetId && !item.closing
      && item.ws.readyState === WS_OPEN && item.session?.connected && item.session.ws === item.ws);
    if (!conn) return false;
    await new Promise((resolve) => {
      const timer = setTimeout(() => terminateSocket(conn.ws, 'admin_kick_timeout'), 1000);
      timer.unref?.();
      conn.ws.once('close', () => { clearTimeout(timer); resolve(); });
      conn.close(CLOSE.ADMIN_KICK, 'admin kick');
    });
    return true;
  }

  /** Number of open sockets. */
  get connectionCount() { return this.conns.size; }

  loadSample() {
    this.bandwidth.sample();
    const at = this.monotonicNow();
    const bytes = this.bandwidth.writtenBytes;
    const previous = this.loadPrevious;
    const elapsed = at - previous.at;
    const bytesPerSecond = elapsed > 0 ? Math.max(0, bytes - previous.bytes) * 1000 / elapsed : 0;
    this.loadPrevious = { at, bytes };
    return { bandwidthMbps: this.opts.bandwidthMbps, bytesPerSecond };
  }

  /**
   * Upgrade-time admission check (server/index.js): null to accept, otherwise the reason to refuse.
   * @param {import('node:http').IncomingMessage} req
   * @returns {null | 'shutdown' | 'full' | 'per-address'}
   */
  admission(req) {
    if (this.closed || this.draining) return 'shutdown';
    if (this.conns.size >= this.opts.maxConnections) return 'full';
    const { key } = clientAddress(req, this.opts.trustProxy);
    const cap = this.opts.maxConnectionsPerAddr;
    if (key && cap > 0 && (this.connsPerKey.get(key) || 0) >= cap) return 'per-address';
    return null;
  }

  /**
   * Adopt a freshly upgraded socket.
   * @param {import('ws').WebSocket} ws
   * @param {import('node:http').IncomingMessage} [req]
   */
  handleConnection(ws, req) {
    if (this.closed || this.draining) { try { ws.close(CLOSE.SHUTDOWN, 'server shutdown'); } catch { /* ignore */ } return; }
    const conn = new Connection(ws, clientAddress(req, this.opts.trustProxy), this.now(), this.opts, this.log, this.now,
      this.monotonicNow, this.tcpMetrics, this.bandwidth);
    conn.network = this;
    this.bandwidth.register(ws);
    this.conns.set(ws, conn);
    socketConnections.set(ws, conn);
    this.tcpMetrics.register(conn, ws._socket || req?.socket);
    if (conn.key) this.connsPerKey.set(conn.key, (this.connsPerKey.get(conn.key) || 0) + 1);
    ws.on('message', (data, isBinary) => {
      try { this.onFrame(conn, data, isBinary); } catch (e) { this.log.error('[net] frame handler crashed', e); }
    });
    ws.on('pong', (data) => {
      if (conn.closing || this.conns.get(ws) !== conn) return;
      conn.onPong(data);
      if (conn.session && conn.session.ws === ws) conn.session.lastSeen = this.now();
    });
    ws.on('error', (e) => {
      if (conn.socketErrorCode) return;
      conn.socketErrorCode = /^E[A-Z0-9_]{1,63}$/.test(e?.code) ? e.code : 'unknown';
      conn.event('ws_error', { errorCode: conn.socketErrorCode }, 'warn');
    });
    ws.on('close', (code, reason) => { try { this.onClose(conn, code, reason); } catch (e) { this.log.error('[net] close handler crashed', e); } });
  }

  /** @param {Connection} conn @param {object} msg */
  reply(conn, msg) { return send(conn.ws, msg); }

  /** @param {Connection} conn */
  onFrame(conn, data, isBinary) {
    // A socket we are closing (replaced by another tab, hello timeout, flooding, shutdown) may still have
    // frames in flight; acting on them could e.g. mint an orphan session from a late `hello`.
    if (conn.closing || this.closed || this.draining) return;
    const now = this.now();
    conn.alive = true;
    if (conn.session && conn.session.ws === conn.ws) conn.session.lastSeen = now;

    if (!conn.bucket.take(now)) {
      if (now - conn.dropWindowAt >= 1000) { conn.dropWindowAt = now; conn.drops = 0; }
      if (++conn.drops > this.opts.abuseDropsPerSec) {
        conn.close(CLOSE.POLICY, 'rate limit');
        return;
      }
      this.reply(conn, errorMsg(ERR.RATE, peekRid(data, isBinary)));
      return;
    }

    if (isBinary) { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'binary frame')); return; }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'invalid json')); return; }
    const rid = msg && typeof msg === 'object' ? msg.rid : undefined;
    // Own-property check first: validateC2S alone would accept inherited keys like "constructor".
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || !Object.hasOwn(C2S, msg.t)) {
      const t = msg && typeof msg === 'object' ? String(msg.t).slice(0, 32) : typeof msg;
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `unknown type ${t}`));
      return;
    }
    const reason = validateC2S(msg);
    if (reason) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, reason)); return; }

    if (msg.t === 'session.probeAck') {
      conn.resumeProbes?.get(msg.nonce)?.();
      return;
    }
    // Validated pings pay the normal connection bucket but never wait behind profile/room I/O.
    // They return transport information only; all business intents remain serialized below.
    if (msg.t === 'ping') { this.onPing(conn, msg, now); return; }
    if ((HEAVY_TYPES.has(msg.t) || heavyFriendAction(msg)) && !conn.heavy.take(now)) { this.reply(conn, errorMsg(ERR.RATE, rid, `${msg.t} too often`)); return; }
    if ((conn.pendingMessages || 0) >= 128) { conn.close(CLOSE.POLICY, 'message backlog'); return; }
    conn.pendingMessages = (conn.pendingMessages || 0) + 1;
    conn.messageChain = (conn.messageChain || Promise.resolve()).then(() => this.dispatchMessage(conn, msg, now))
      .catch((e) => this.log.error('[net] 消息处理失败', e))
      .finally(() => { conn.pendingMessages--; });
  }

  onPing(conn, msg, now) {
    if (conn.closing || this.closed || this.draining || this.conns.get(conn.ws) !== conn
      || conn.session?.loginReleased || conn.session?.loginRevoked
      || (conn.session && conn.session.ws !== conn.ws)) return;
    const pong = { t: 'pong', c: msg.c, s: now, progressMs: conn.periodicInterval() };
    if (validRid(msg.rid)) pong.rid = msg.rid;
    this.reply(conn, pong);
  }

  /** A recovery frame is transport state only: it never grants session permission. */
  leaseState(session, state, recoveryMs) {
    if (state !== 'recovering' && state !== 'active') return false;
    const ws = session?.ws;
    const conn = ws && this.conns.get(ws);
    if (!conn || conn.session !== session || !session.connected || conn.closing || this.closed || this.draining
      || session.loginReleased || session.loginRevoked) return false;
    if (state === 'active' && this.handler.profiles && !this.handler.profiles.validSession(session)) return false;
    if (state === 'recovering') {
      const previous = conn.leaseRecoveryNotice;
      if (!previous || previous.scheduled || previous.session !== session || previous.ws !== ws
        || previous.generation !== session.loginGeneration || previous.lease !== session.loginLease) {
        conn.leaseRecoveryNotice = { session, ws, generation: session.loginGeneration,
          lease: session.loginLease, scheduled: false };
      }
    } else {
      const recovery = conn.leaseRecoveryNotice;
      if (recovery && !recovery.scheduled) {
        recovery.scheduled = true;
        const timer = setImmediate(() => {
          if (conn.leaseRecoveryNotice !== recovery) return;
          conn.leaseRecoveryNotice = null;
          const report = () => {
            const now = this.now();
            if (now - (conn.lastLeaseRecoveryHookErrorAt ?? -Infinity) < 10_000) return;
            conn.lastLeaseRecoveryHookErrorAt = now;
            conn.event('login_lease_resync_error', { cause: 'recovery_resync_failed' }, 'warn');
          };
          try {
            if (conn.closing || this.closed || this.draining || this.conns.get(ws) !== conn
              || conn.session !== session || recovery.session !== session || recovery.ws !== ws
              || session.ws !== ws || !session.connected || session.profileReady !== true
              || session.loginInFlight || session.loginReleased || session.loginRevoked
              || session.loginGeneration !== recovery.generation || session.loginLease !== recovery.lease
              || (this.handler.profiles && !this.handler.profiles.validSession(session))) return;
            const result = this.handler.onLeaseRecovered?.(session);
            if (result?.then) void Promise.resolve(result).catch(report);
          } catch { report(); }
        });
        timer.unref?.();
      }
    }
    const frame = { t: 'session.lease', state };
    if (state === 'recovering' && Number.isFinite(recoveryMs) && recoveryMs >= 0) frame.retryMs = Math.min(30_000, Math.ceil(recoveryMs));
    return this.reply(conn, frame);
  }

  /** Local deadline expiry gets one bounded, single-flight authority check owned by profiles. */
  async ensureCurrentSession(conn) {
    const session = conn.session;
    const generation = session?.loginGeneration, lease = session?.loginLease;
    // A replacement login owns its independent bounded deadline. Old recovery callbacks must not
    // authorize it or close it, even when it keeps the same socket and Session object.
    const current = () => !conn.closing && !this.closed && !this.draining && this.conns.get(conn.ws) === conn
      && conn.session === session && session?.ws === conn.ws && !session.loginReleased && !session.loginRevoked
      && !session.loginInFlight && session.loginGeneration === generation && session.loginLease === lease;
    if (!current()) return false;
    const profiles = this.handler.profiles;
    if (!profiles || profiles.validSession(session)) return true;
    if (conn.leaseRecovery?.session === session) return conn.leaseRecovery.promise;
    const recovery = { session, promise: null };
    conn.leaseRecovery = recovery;
    recovery.promise = (async () => {
      let recovered = false;
      try { recovered = typeof profiles.ensureSession === 'function' && await profiles.ensureSession(session); }
      catch {
        const now = this.now();
        if (now - (conn.lastLeaseRecoveryErrorAt ?? -Infinity) >= 10_000) {
          conn.lastLeaseRecoveryErrorAt = now;
          conn.event('login_lease_recovery_error', { cause: 'login_unavailable', closeReason: 'login unavailable' }, 'warn');
        }
      }
      if (!current()) return false;
      if (recovered === true && profiles.validSession(session)) return true;
      session.profileReady = false;
      conn.close(CLOSE.POLICY, 'login lease expired');
      return false;
    })();
    try { return await recovery.promise; }
    finally { if (conn.leaseRecovery === recovery) conn.leaseRecovery = null; }
  }

  async dispatchMessage(conn, msg, now) {
    if (conn.closing || this.closed || this.draining || this.conns.get(conn.ws) !== conn) return;
    const rid = msg.rid;
    if (conn.session?.loginReleased || conn.session?.loginRevoked) return;
    if (msg.t === 'ping') { this.onPing(conn, msg, now); return; }
    if (msg.t === 'hello') { await this.onHelloMsg(conn, msg, now); return; }
    if (!conn.session || !conn.session.profileReady) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'hello required')); return; }
    if (!await this.ensureCurrentSession(conn)) return;

    let res;
    try {
      // client-side combat reports (b.progress / b.result, DESIGN §14) belong to the running match like 'g.*' intents:
      // handed to the lobby's match router when the handler has one (server/lobby.js routeGame)
      if (msg.t.startsWith('b.') && typeof this.handler.routeGame === 'function') res = await this.handler.routeGame(conn.session, msg);
      else res = await this.handler.onMessage(conn.session, msg);
      if (conn.closing || conn.session?.ws !== conn.ws) return;
    } catch (e) {
      this.log.error(`[net] handler crashed on ${msg.t}`, e);
      res = { error: ERR.INTERNAL };
    }
    if (res && res.error) {
      // fire-and-forget battle progress (no rid) that reached no running match — the match just ended, the room went
      // back to the lobby — is stale, not a client mistake: never answered (DESIGN §14; a rid-less error frame would
      // surface as an error toast in the browser)
      if (msg.t === 'b.progress' && !validRid(rid)) return;
      const message = errorMsg(isErrCode(res.error) ? res.error : ERR.INTERNAL, rid, res.detail);
      if (conn.session?.loginReleased) sendRaw(conn.ws, encode(message), { onComplete: () => conn.close(1000, 'server switch failed') });
      else this.reply(conn, message);
    } else if (msg.t === 'session.release') {
      const data = encode({ t: 'ok', ...(validRid(rid) ? { rid } : {}) });
      const queued = sendRaw(conn.ws, data, { onComplete: () => conn.close(1000, 'server switch') });
      if (!queued) conn.close(1000, 'server switch');
    } else {
      if (conn.streamEnabled && ['g.watch', 'spectator.watch'].includes(msg.t)) {
        conn.streamFieldId = msg.fieldId; conn.streamManual = msg.fieldId !== conn.ownFieldId;
      }
      if (validRid(rid)) this.reply(conn, { t: 'ok', rid });
    }
  }

  /** @param {Connection} conn @param {any} msg @param {number} now */
  async onHelloMsg(conn, msg, now) {
    const rid = msg.rid;
    if (msg.version != null && msg.version !== PROTOCOL_VERSION) {
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `version mismatch: server ${PROTOCOL_VERSION}`));
      return;
    }
    const name = sanitizeName(msg.name);
    if (!name) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'bad field name')); return; }

    // Authenticate before touching sockets, devices, tokens or existing room seats.
    // A reconnect uses the account ticket; old session tokens alone are not passwords.
    let account;
    try {
      account = this.handler.profiles?.authenticate
        ? await this.handler.profiles.authenticate(name, msg.auth)
        : { error: ERR.AUTH_REQUIRED };
    } catch (error) {
      this.log.error('[net] 账户验证不可用', error);
      if (!conn.closing) this.reply(conn, errorMsg(ERR.INTERNAL, rid, '登录服务暂不可用，请稍后重试'));
      return;
    }
    if (conn.closing || this.closed || this.draining || this.conns.get(conn.ws) !== conn) return;
    if (account.error) { this.reply(conn, errorMsg(account.error, rid, account.detail)); return; }
    if (account.name !== name || typeof account.aid !== 'string' || !/^[0-9a-f]{8,64}$/.test(account.aid)) {
      this.reply(conn, errorMsg(ERR.AUTH_INVALID, rid)); return;
    }

    const deviceId = typeof msg.deviceId === 'string' && /^[0-9a-f]{32}$/.test(msg.deviceId) ? msg.deviceId : null;
    // 切账号先解绑旧会话，其房间和恢复凭证仍按原设备/账号保留。
    if (conn.session && (conn.session.name !== name || (conn.session.profileBound && conn.session.aid !== account.aid))) {
      const previous = conn.session;
      previous.ws = null;
      previous.connected = false;
      previous.disconnectedAt = now;
      conn.session = null;
      this.handler.onDisconnect?.(previous);
    }
    let session = conn.session;
    let resumed = false;
    const repeat = !!session;
    let wasOnline = !!session?.connected;
    if (!session) {
      session = msg.token ? this.registry.byToken(msg.token) : null;
      if (session?.profileBound && session.aid !== account.aid) session = null;
      if (deviceId) {
        if (session && (session.name !== name || (session.deviceId && session.deviceId !== deviceId))) session = null;
        session ||= [...this.registry.all()].find((s) => s.deviceId === deviceId && s.name === name
          && (!s.profileBound || s.aid === account.aid)
          && !s.loginReleased && !s.debugAuthorized && !this.registry.isExpired(s, now)) || null;
      } else if (session && session.name !== name) {
        session = null;
      }
      if (session?.loginReleased) session = null;
      wasOnline = !!session?.connected;
      if (session) {
        // 同设备同账号直接恢复；不同设备使用各自会话，不再探测或拒绝顶号。
        const oldWs = session.ws;
        if (oldWs) this.detachReplaced(oldWs);
        resumed = true;
      } else {
        session = this.registry.create(name);
        if (!session) { this.reply(conn, errorMsg(ERR.INTERNAL, rid, 'server full')); return; }
      }
      conn.session = session;
      if (deviceId) session.deviceId = deviceId;
      session.ws = conn.ws;
      session.targetId = conn.targetId;
      session.connected = true;
      session.profileReady = false;
      session.initializingChat = true;
      session.pendingChat = [];
      session.disconnectedAt = null;
    }
    session.helloWasOnline = wasOnline;
    const previousAid = session.profileBound ? session.aid : null;
    // 对局快照固定至结束；未开局房间仍保留既有改名功能。
    const identityLocked = !!session.spectatorCode || !!(session.roomCode && this.handler.roomOf?.(session)?.match);
    if (this.handler.profiles) {
      const previousReady = session.profileReady;
      if (repeat && !await this.ensureCurrentSession(conn)) return;
      session.profileReady = false;
      if (session.loginReleased) { conn.close(CLOSE.POLICY, 'session released'); return; }
      if (!repeat) session.loginRevoked = false;
      try {
        const result = await this.handler.profiles.login(session, identityLocked ? session.name : name,
          account.aid, conn.ws, identityLocked, account.aid);
        if (conn.closing || session.ws !== conn.ws) return;
        if (result.error) {
          if (repeat) {
            session.profileReady = previousReady && this.handler.profiles.validSession(session);
            this.reply(conn, errorMsg(result.error, rid, result.detail));
          }
          else sendRaw(conn.ws, encode(errorMsg(result.error, rid, result.detail)), {
            onComplete: () => conn.close(CLOSE.POLICY, 'login rejected') });
          return;
        }
        session.aid = result.aid;
        session.profileBound = true;
        session.profileName = identityLocked ? session.name : name;
      } catch (error) {
        this.log.error('[net] 登录权威不可用', error);
        if (session.ws !== conn.ws) return;
        conn.close(CLOSE.POLICY, 'login unavailable');
        return;
      }
    }
    if (!identityLocked) session.name = name;
    if (!session.profileBound && typeof msg.aid === 'string' && /^[0-9a-f]{8,64}$/.test(msg.aid)) {
      session.clientAid = msg.aid;
      session.aid = msg.aid;
    }
    session.profileReady = false;
    session.initializingChat = !repeat;
    if (repeat) session.pendingChat = [];
    session.lastSeen = now;
    session.addr = conn.ip;
    session.limitKey = conn.key;

    let extra = null;
    try { extra = this.handler.welcomeInfo?.() ?? null; } catch (e) { this.log.error('[net] welcomeInfo crashed', e); }
    const welcome = { ...(extra && typeof extra === 'object' ? extra : null), t: 'welcome', playerId: session.playerId, token: session.token, authTicket: account.ticket, name: session.name, serverNow: now, version: PROTOCOL_VERSION, resumed };
    // 仅接受明确版本标记；额外hello字段不改变既有协议版本。
    conn.deltaEnabled = msg.stateDelta === 1;
    conn.compactEnabled = conn.deltaEnabled && msg.stateCompact === 1;
    conn.streamEnabled = conn.compactEnabled && [1, 2].includes(msg.stateStream);
    conn.fieldMetadataEnabled = conn.streamEnabled && msg.stateStream === 2;
    conn.streamFieldId = null; conn.ownFieldId = null; conn.streamManual = false;
    conn.resumeProbeEnabled = msg.resumeProbe === 1;
    welcome.stateDelta = conn.deltaEnabled ? 1 : 0;
    welcome.stateCompact = conn.compactEnabled ? 1 : 0;
    welcome.stateStream = conn.fieldMetadataEnabled ? 2 : conn.streamEnabled ? 1 : 0;
    welcome.bandwidthMbps = this.opts.bandwidthMbps;
    welcome.progressMs = this.bandwidth.baseMs;
    // Authoritative membership at welcome; absence of later snapshots is never an exit signal.
    welcome.roomCode = session.roomCode ?? null;
    welcome.spectatorCode = session.spectatorCode ?? null;
    if (validRid(rid)) welcome.rid = rid;
    if (!this.reply(conn, welcome)) return;
    try {
      session.profileReady = false;
      await this.handler.onHello?.(session, { resumed, repeat, previousAid });
      if (!conn.closing && session.ws === conn.ws && !session.loginReleased && !session.loginRevoked
        && (!this.handler.profiles || this.handler.profiles.validSession(session))) session.profileReady = true;
    } catch (e) {
      this.log.error('[net] onHello crashed', e);
      // welcome 后的重同步失败不能留下一个看似在线却缺失状态的会话。
      try { terminateSocket(conn.ws, 'resync_error'); } catch { /* 已关闭 */ }
    }
  }

  /** Probe only a token-authorized resume's old socket, without waiting for the periodic heartbeat. */
  resumeSocketAlive(oldWs) {
    const old = this.conns.get(oldWs);
    if (!old || old.closing || oldWs.readyState !== WS_OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      const payload = randomBytes(8);
      const nonce = payload.toString('hex');
      const applicationProbe = old.resumeProbeEnabled === true;
      let settled = false;
      const onPong = (data) => {
        if (!applicationProbe && Buffer.isBuffer(data) && data.equals(payload)) finish(true);
      };
      const onLost = () => finish(false);
      const finish = (alive) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        oldWs.removeListener('pong', onPong);
        oldWs.removeListener('close', onLost);
        oldWs.removeListener('error', onLost);
        old.resumeProbes?.delete(nonce);
        resolve(alive);
      };
      // 新客户端由页面确认存活；旧客户端继续兼容原控制 ping。
      const timer = setTimeout(() => finish(false), RESUME_PROBE_TIMEOUT_MS);
      timer.unref?.();
      oldWs.on('pong', onPong);
      oldWs.on('close', onLost);
      oldWs.on('error', onLost);
      if (applicationProbe) {
        old.resumeProbes ||= new Map();
        old.resumeProbes.set(nonce, () => finish(true));
        if (!this.reply(old, { t: 'session.probe', nonce })) finish(false);
      } else {
        try { oldWs.ping(payload, false, (error) => { if (error) finish(false); }); }
        catch { finish(false); }
      }
    });
  }

  /** The session moved to a new socket: unbind and close the old one without firing a disconnect. */
  detachReplaced(oldWs) {
    const old = this.conns.get(oldWs);
    if (old) {
      old.detachedIdentity = old.identity();
      const session = old.session;
      if (session) {
        // Replacement bypasses onDisconnect; invalidate lobby-owned replay callbacks explicitly.
        session.pendingResultGeneration = (session.pendingResultGeneration || 0) + 1;
        session.pendingResultInFlight = 0;
        session.pendingResultFailed = false;
      }
      old.session = null;
      old.close(CLOSE.REPLACED, 'session replaced');
    } else {
      try { oldWs.close(CLOSE.REPLACED, 'session replaced'); } catch { /* ignore */ }
    }
  }

  /** @param {Connection} conn */
  onClose(conn, code = 1006, reason = '') {
    conn.closing = true;
    conn.stopPeriodic();
    if (!conn.closeLogged) {
      conn.closeLogged = true;
      conn.event('ws_close', {
        closeCode: code, closeReason: safeCloseReason(reason), closeReasonBytes: Buffer.byteLength(reason),
        cause: conn.closeCause || conn.terminationCause || (code === 1006 ? 'transport_lost' : 'peer_close'),
        terminationCause: conn.terminationCause, errorCode: conn.socketErrorCode || null,
      });
    }
    socketConnections.delete(conn.ws);
    if (this.conns.delete(conn.ws) && conn.key) {
      const n = (this.connsPerKey.get(conn.key) || 1) - 1;
      if (n > 0) this.connsPerKey.set(conn.key, n);
      else this.connsPerKey.delete(conn.key);
    }
    const s = conn.session;
    conn.session = null;
    if (!s || s.ws !== conn.ws) return;
    s.ws = null;
    s.connected = false;
    s.disconnectedAt = this.now();
    if (this.closed || this.draining) return;
    try { this.handler.onDisconnect?.(s); } catch (e) { this.log.error('[net] onDisconnect crashed', e); }
  }

  /** Ping every socket; allow background suspension until the independent silence timeout. */
  heartbeat() {
    const now = this.now();
    for (const conn of this.conns.values()) {
      try {
        if (conn.closing) {
          // Closing handshake never completed within a heartbeat interval → drop the TCP connection.
          if (!conn.alive) terminateSocket(conn.ws, 'close_handshake_timeout');
          conn.alive = false;
          continue;
        }
        if (!conn.session && now - conn.openedAt > this.opts.helloTimeoutMs) {
          conn.close(CLOSE.HELLO_TIMEOUT, 'hello timeout');
          continue;
        }
        const heartbeatTimeoutMs = this.opts.heartbeatTimeoutMs ?? NET_DEFAULTS.heartbeatTimeoutMs;
        const lastSeen = conn.session?.lastSeen ?? conn.openedAt;
        if (now - lastSeen > heartbeatTimeoutMs) {
          terminateSocket(conn.ws, 'heartbeat_timeout', {
            heartbeatMs: this.opts.heartbeatMs, heartbeatTimeoutMs,
          });
          continue;
        }
        conn.alive = false;
        const payload = randomBytes(8);
        conn.pingProbe = { payload, at: this.monotonicNow() };
        conn.ws.ping(payload, false, (err) => {
          if (err) { try { terminateSocket(conn.ws, 'heartbeat_send_error'); } catch { /* 已关闭 */ } }
        });
      } catch (e) {
        this.log.debug?.('[net] heartbeat error', /^E[A-Z0-9_]{1,63}$/.test(e?.code) ? e.code : 'unknown');
      }
    }
  }

  /** Purge expired sessions and tell the handler. */
  sweep() {
    let expired;
    try { expired = this.registry.sweep(this.now()); } catch (e) { this.log.error('[net] sweep crashed', e); return; }
    for (const s of expired) {
      try { this.handler.onExpire?.(s); } catch (e) { this.log.error('[net] onExpire crashed', e); }
    }
  }

  /** Stop new inputs and expiry while the final checkpoint is saved; already queued sends can still drain. */
  async beginDrain() {
    this.draining = true;
    clearInterval(this.heartbeatTimer); clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.conns.values()].map((conn) => conn.messageChain));
  }

  /**
   * Stop timers and close every socket (graceful: close frame, then terminate after 1 s).
   * @param {number} [code] @param {string} [reason]
   */
  close(code = CLOSE.SHUTDOWN, reason = 'server shutdown') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.sweepTimer);
    this.tcpMetrics.close();
    for (const conn of this.conns.values()) {
      conn.close(code, reason);
      const t = setTimeout(() => { try { terminateSocket(conn.ws, 'shutdown_timeout'); } catch { /* ignore */ } }, 1000);
      t.unref?.();
    }
  }
}

/** Best-effort rid extraction for rate-limited frames (so the client's pending request resolves). */
function peekRid(data, isBinary) {
  if (isBinary || !data || data.length > PEEK_RID_MAX_BYTES) return undefined;
  try {
    const m = JSON.parse(data.toString('utf8'));
    return m && typeof m === 'object' ? m.rid : undefined;
  } catch {
    return undefined;
  }
}
