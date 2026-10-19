// WebSocket client for the game server (DESIGN §8).
//
// - One socket at ws(s)://<host>/ws, JSON text frames `{ t, ...payload }`.
// - Auto-reconnect with exponential backoff + jitter; a heartbeat (`ping`) measures latency and
//   detects dead sockets (a ping left unanswered — no inbound frame at all — for DEAD_AFTER_MS ⇒
//   close ⇒ reconnect). Measured from the oldest unanswered ping, not from the last inbound frame,
//   so a background tab whose timers the browser throttles to ~1/min is not mistaken for dead.
// - On every (re)connect, once a player name is known, sends `hello {name, token, version}`;
//   the session is "online" after `welcome`.
// - `request(t, fields)` adds a `rid` and resolves on the matching `ok` (or any reply carrying the
//   rid), rejects with a NetError on `error` or after REQUEST_TIMEOUT_MS. Requests made while
//   reconnecting are queued and flushed after `welcome` (still bound by their timeout).
// - Every server push is emitted by its `t` (see shared/protocol.js S2C) and as '*'.
//   Extra events: 'status', 'ping', 'clock', 'helloError', 'unhandledError', 'replaced'.
// - Server close code 4001 ("session replaced": the same token connected from another tab) stops
//   auto-reconnect (status 'closed', lastError REPLACED) so two tabs never fight over one session.
// - Before a name is known (title screen) the socket only pings; the server closes such sockets
//   with 4002 (hello timeout). That close is answered with a quiet swap: a fresh socket is opened
//   while the status stays 'connected', so the title's server indicator doesn't flicker.
// - Server clock offset (serverNow ≈ Date.now() + offset) from pong samples (lowest RTT wins),
//   bootstrapped from `welcome.serverNow` / `m.public.serverNow`.
//
// Identity persistence (`identity`, see the section at the end): the name lives in localStorage;
// the reconnect token lives in sessionStorage (survives reloads of this tab) plus a short list of
// recent tokens in localStorage (resume after closing/reopening the tab). `identity.init()` asks
// the other live tabs over a BroadcastChannel which tokens they hold, so a second or duplicated tab
// of the same browser becomes a separate player instead of hijacking another tab's session.
//
// Shared modules are imported relatively: in the browser '../../shared/x.js' from /js/ resolves
// to /shared/x.js (URL resolution clamps at the root); under Node it resolves to <repo>/shared.

import { PROTOCOL_VERSION, ERR_TEXT } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { PrioritySender, CongestionTrend } from '../../shared/sendFlow.js';

export const REQUEST_TIMEOUT_MS = 8000;
export const HELLO_TIMEOUT_MS = 8000;
export const CONNECT_TIMEOUT_MS = 10000;
// 所有浏览器使用相同建连窗口。
export function connectTimeoutMs() {
  return CONNECT_TIMEOUT_MS;
}

export const MAX_PENDING_REQUESTS = 128;
export const MAX_SEND_BUFFER_BYTES = 256 * 1024;
export const PROGRESS_SOFT_BUFFER_BYTES = 50 * 1024;

export function progressInterval(net, bossLike) {
  const rtt = typeof net?.progressRtt === 'function' ? net.progressRtt() : net?.ping;
  const buffered = net?.ws?.bufferedAmount || 0;
  const profile = Number.isFinite(net?.serverProgressMs) ? net.serverProgressMs : 250;
  const base = Math.max(bossLike ? 250 : 1000, profile);
  const max = Math.max(bossLike ? 1000 : 2000, profile);
  const factor = net?.trend?.factor() ?? 1;
  return Math.min(max, Math.max(base + (max - base) * (factor - 1) / 3,
    (Number.isFinite(rtt) ? rtt : 0) * 2,
    buffered > 20 * 1024 ? max : 0));
}
const MAX_FRAME_BYTES = 64 * 1024;
const utf8 = new TextEncoder();
export const PING_INTERVAL_MS = 4000;
export const BACKGROUND_PING_INTERVAL_MS = 30000;
export const DEAD_AFTER_MS = 15000;
export const BACKGROUND_DEAD_AFTER_MS = 5 * 60_000;
export const RESUME_PROBE_MS = 3000;
export const BACKOFF = Object.freeze({ base: 500, factor: 2, max: 10000, jitter: 0.2 });
const STABLE_CONNECTION_MS = 15000;
const QUEUE_BATCH_SIZE = 8;
const QUEUE_BATCH_MS = 250;
const HEAVY_QUEUE_MS = 500;
// 与 server/net.js 的 HEAVY_TYPES 保持一致；heavy 同时消耗普通桶。
const HEAVY_TYPES = new Set(['g.watch', 'room.loadout', 'profile.loadout', 'profile.presentation', 'history.detail', 'spectator.join', 'spectator.watch']);

/** Client-side error codes (in addition to shared ERR codes). */
export const CLIENT_ERR_TEXT = Object.freeze({
  TIMEOUT: '请求超时，请重试',
  OFFLINE: '未连接到服务器',
  DISCONNECTED: '连接已断开，请重试',
  CLOSED: '连接已关闭',
  BUSY: '待处理请求过多，请稍后重试',
  REPLACED: '此设备的该账号已在另一页面恢复',
  ADMIN_KICK: '你已被管理员下线，请主动重新连接',
  VERSION: '客户端版本与服务器不一致，请刷新页面',
});

/** Server close code: the session was taken over by another socket (server/net.js CLOSE.REPLACED). */
export const CLOSE_REPLACED = 4001;
/** Administrator disconnected this socket; only an explicit user action reconnects. */
export const CLOSE_ADMIN_KICK = 4003;
/** Server close code: the socket never sent `hello` (server/net.js CLOSE.HELLO_TIMEOUT, ~30–60 s). */
export const CLOSE_HELLO_TIMEOUT = 4002;
/** A pre-hello socket must have lived this long before a 4002 close is swapped quietly (no loop). */
const QUIET_SWAP_MIN_AGE_MS = 5000;

/**
 * Human readable (Chinese) text for an error code.
 * @param {string} code
 * @param {string} [msg] server-provided message (fallback)
 * @returns {string}
 */
export function errorText(code, msg) {
  return ERR_TEXT[code] || CLIENT_ERR_TEXT[code] || (typeof msg === 'string' && msg) || String(code || '未知错误');
}

/** Error thrown/rejected by requests. `code` is an ERR code or a CLIENT_ERR_TEXT key. */
export class NetError extends Error {
  /** @param {string} code @param {string} [msg] server text @param {string} [detail] server developer detail */
  constructor(code, msg, detail) {
    const versionMismatch = typeof detail === 'string' && /version/i.test(detail);
    const loginConflict = typeof detail === 'string' && detail.startsWith('该账户已在其他连接登录');
    super(versionMismatch ? CLIENT_ERR_TEXT.VERSION : loginConflict ? detail : errorText(code, msg));
    this.name = 'NetError';
    this.code = String(code || 'INTERNAL');
    this.serverMsg = msg ?? null;
    this.detail = typeof detail === 'string' ? detail : null;
  }
}

/**
 * Reconnect delay for the n-th consecutive failed attempt (0-based), with ±jitter.
 * @param {number} attempt
 * @param {() => number} [rand]
 * @returns {number} milliseconds
 */
export function backoffDelay(attempt, rand = Math.random) {
  const n = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)));
  const raw = Math.min(BACKOFF.max, BACKOFF.base * BACKOFF.factor ** n);
  const jitter = raw * BACKOFF.jitter * (rand() * 2 - 1);
  return Math.max(100, Math.round(raw + jitter));
}

/**
 * WebSocket URL for the current page (`ws(s)://host/ws`).
 * @param {{protocol: string, host: string}} [loc]
 * @returns {string}
 */
export function defaultWsUrl(loc = globalThis.location) {
  if (!loc || !loc.host) return 'ws://localhost:3000/ws';
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

const WS_OPEN = 1;
const WS_CONNECTING = 0;
const STATE_TYPES = new Set(['m.public', 'm.private', 'b.snap', 'b.pool']);
const stateKey = (msg) => msg.t === 'b.snap' ? `b.snap:${msg.fieldId}` : msg.t;
function applyStatePatch(base, patch) {
  let value = JSON.parse(JSON.stringify(base));
  if (!Array.isArray(patch)) throw new Error('invalid state patch');
  for (const op of patch) {
    if (!Array.isArray(op) || ![1, 2].includes(op.length) || !Array.isArray(op[0])) throw new Error('invalid state operation');
    const path = op[0];
    if (path.some((key) => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('invalid state path');
    if (!path.length) {
      if (op.length !== 2) throw new Error('invalid state root');
      value = op[1];
      continue;
    }
    let parent = value;
    for (const key of path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('missing state path');
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('invalid state parent');
    const key = path[path.length - 1];
    if (op.length === 1) delete parent[key];
    else Object.defineProperty(parent, key, { value: op[1], enumerable: true, configurable: true, writable: true });
  }
  return value;
}

/**
 * Game server connection. Construct with injectable dependencies for tests.
 */
export class Net {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url] socket URL (default: derived from location at connect time)
   * @param {any} [opts.WebSocket] WebSocket constructor (default: globalThis.WebSocket)
   * @param {string} [opts.userAgent] browser identification (default: navigator.userAgent)
   * @param {() => (string|null)} [opts.getToken] reconnect-token provider for `hello`
   * @param {() => number} [opts.now]
   * @param {() => number} [opts.random]
   * @param {{setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function}} [opts.timers]
   */
  constructor(opts = {}) {
    this.url = opts.url || null;
    this.WS = opts.WebSocket || null;
    this.connectTimeoutMs = connectTimeoutMs(opts.userAgent);
    this.getToken = typeof opts.getToken === 'function' ? opts.getToken : () => null;
    this.getAid = typeof opts.getAid === 'function' ? opts.getAid : () => null;
    this.getDeviceId = typeof opts.getDeviceId === 'function' ? opts.getDeviceId : () => null;
    this.now = opts.now || (() => Date.now());
    this.monotonicNow = opts.monotonicNow || (() => performance.now());
    this.isHidden = opts.isHidden || (() => globalThis.document?.visibilityState === 'hidden');
    this._background = this.isHidden();
    this._pingSamples = new Map();
    this._pingSequence = 0;
    this._pingAt = null;
    this._lastPingSentAt = null;
    this.random = opts.random || Math.random;
    this.timers = opts.timers || {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (id) => globalThis.clearInterval(id),
    };

    /** @type {'idle'|'connecting'|'connected'|'handshaking'|'online'|'reconnecting'|'closed'} */
    this.status = 'idle';
    this.ws = null;
    this.name = null;          // desired player name (hello is sent when set)
    this.helloName = null;     // name we sent in the hello that got the last welcome
    this.serverName = null;    // name as normalised by the server
    this.serverId = null;
    this.playerId = null;
    this.attempt = 0;          // consecutive failed connection attempts
    this.retryAt = 0;          // epoch ms of the next reconnect attempt (0 = none)
    this.ping = null;          // last RTT in ms
    this.lastError = null;     // last NetError relevant to the connection (e.g. hello rejected)
    this.clockOffset = 0;
    this.clockSynced = false;

    this._rid = 0;
    this._pending = new Map(); // rid -> { msg, resolve, reject, timer, sent }
    this._expired = new Set(); // rids that timed out locally (their late error was already reported)
    this._listeners = new Map();
    this._manualClose = false;
    this._quietSwap = false;   // next connect() keeps the current status (see CLOSE_HELLO_TIMEOUT)
    this._openedAt = 0;
    this._reconnectTimer = null;
    this._connectTimer = null;
    this._resumeTimer = null;
    this._connectStartedAt = 0;
    this._pingTimer = null;
    this._helloTimer = null;
    this._stableTimer = null;
    this._queueTimer = null;
    this._queueBatchAt = 0;
    this._queueHeavyAt = 0;
    this._helloRid = null;
    this._helloSentName = null;
    this._lastRx = 0;
    this._unansweredSince = null; // time of the oldest ping sent since the last inbound frame
    this._clockSamples = [];   // [{ offset, rtt }]
    this.trend = new CongestionTrend({ expiryMs: DEAD_AFTER_MS, now: this.monotonicNow });
    this._flow = null;
    this._stateBases = new Map();
    this._stateEpoch = null;
    this._stateDelta = false;
    this.serverProgressMs = 250;
  }

  // ---- events ----------------------------------------------------------------------------------

  /**
   * Subscribe to a message type (any S2C `t`), '*' (all messages) or a client event
   * ('status' | 'ping' | 'clock' | 'helloError' | 'unhandledError').
   * @param {string} type
   * @param {(payload: any) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = this._listeners.get(type);
    if (!set) this._listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  /** @param {string} type @param {Function} fn */
  off(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[net] listener for "${type}" failed`, err); }
    }
  }

  /** Snapshot of the connection state (what the 'status' event carries). */
  snapshot() {
    return {
      status: this.status, attempt: this.attempt, retryAt: this.retryAt, ping: this.ping,
      lastError: this.lastError ? { code: this.lastError.code, text: this.lastError.message } : null,
      playerId: this.playerId,
    };
  }

  _setStatus(status) {
    this.status = status;
    this._emit('status', this.snapshot());
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** Open the socket (no-op when already open/connecting). Also resumes after close()/replacement. */
  connect() {
    const quiet = this._quietSwap;
    this._quietSwap = false;
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) return;
    this._manualClose = false;
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    this.retryAt = 0;
    const WS = this.WS || globalThis.WebSocket;
    const url = this.url || defaultWsUrl();
    let ws;
    try {
      ws = new WS(url);
    } catch (err) {
      console.warn('[net] cannot create WebSocket', err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    this._connectStartedAt = this.now();
    if (!quiet) this._setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    ws.onopen = () => { if (ws === this.ws) this._onOpen(); };
    ws.onmessage = (ev) => { if (ws === this.ws) this._onMessage(ev?.data); };
    ws.onerror = () => {
      // 部分WebView出错后迟迟没有close；主动清理，旧socket回调随之隔离。
      if (ws === this.ws) this._disconnectForRetry('socket error');
    };
    ws.onclose = (ev) => { if (ws === this.ws) this._onClose(ev); };
    this._clearTimer('_connectTimer', 'clearTimeout');
    this._connectTimer = this.timers.setTimeout(() => {
      if (ws === this.ws && ws.readyState === WS_CONNECTING) this._disconnectForRetry('connect timeout');
    }, this.connectTimeoutMs);
  }

  /** Close for good (no reconnect). Pending requests reject with CLOSED. */
  close() {
    this._manualClose = true;
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    this.retryAt = 0;
    const ws = this.ws;
    this._teardownSocket();
    try { ws?.close(1000, 'client close'); } catch { /* ignore */ }
    this._failPending('CLOSED', true);
    this._setStatus('closed');
  }

  closeForServerSwitch() {
    this.close();
    this.name = this.helloName = this.serverName = this.playerId = this.serverId = null;
    this._rid = 0;
    this._expired.clear();
    this._clockSamples = [];
    this.clockOffset = 0;
    this.clockSynced = false;
    this._pingSequence = 0;
    this.attempt = 0;
    this.lastError = null;
    this._quietSwap = false;
    this._emit('serverSwitch');
  }

  /** Skip the backoff wait and reconnect right now (used on `online` / tab focus / retry button). */
  retryNow() {
    if (this._manualClose) return;
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) return;
    this.connect();
  }

  /** Explicit retry replaces even an OPEN/CONNECTING socket and resumes after a manual stop. */
  reconnectNow() {
    this._manualClose = false;
    const ws = this.ws;
    this._teardownSocket();
    try { ws?.close(4000, 'reconnect'); } catch { /* ignore */ }
    this._failPending('DISCONNECTED', false);
    this.attempt = 0;
    this.connect();
  }

  /**
   * Set the player name used in `hello`. Sends hello right away when the socket is open (the server
   * accepts a repeated hello on a live socket: it renames the session and resyncs room/match
   * state), otherwise as soon as it opens. No-op when that name is already accepted.
   * @param {string} name
   */
  setName(name) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return;
    const changed = n !== this.name;
    this.name = n;
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      if (!this.ws && !this._reconnectTimer && !this._manualClose) this.connect();
      return; // hello goes out on open
    }
    if (this.status === 'online' && this.helloName === n) return;
    if (this.status === 'handshaking' && !changed && this._helloSentName === n) return;
    // The server accepts a repeated hello on a live socket (it renames the session and resyncs).
    this._sendHello();
  }

  _onOpen() {
    this._clearTimer('_resumeTimer', 'clearTimeout');
    this._stateBases.clear();
    this._stateEpoch = null;
    this._stateDelta = false;
    this.serverProgressMs = 250;
    this._clearTimer('_connectTimer', 'clearTimeout');
    this._flow?.close();
    this.trend.clear();
    const ws = this.ws;
    this._flow = new PrioritySender({
      buffered: () => ws.bufferedAmount || 0,
      send: (msg, options) => {
        if (ws !== this.ws) return false;
        const entry = options.request;
        if (entry) {
          entry.queued = false;
          return this.status === 'online' && this._pending.get(msg.rid) === entry
            && !entry.sent && this._sendRequest(entry);
        }
        return this._writeRaw(msg, options);
      },
      now: this.monotonicNow, timers: this.timers,
      interval: () => progressInterval(this, true), hardBytes: MAX_SEND_BUFFER_BYTES,
    });
    // 新连接可能对应重启后的服务器；旧 RTT 样本不能压住新的时钟基准。
    this._clockSamples = [];
    this.clockSynced = false;
    this.ping = null;
    this._pingAt = null;
    this._pingSamples.clear();
    this._openedAt = this.now();
    this._queueBatchAt = 0;
    this._queueHeavyAt = 0;
    this._lastRx = this._openedAt;
    this._unansweredSince = null;
    this.retryAt = 0;
    this._startHeartbeat();
    if (this.name) {
      this._setStatus('handshaking');
      this._sendHello();
    } else {
      this._setStatus('connected');
      this._resetBackoffWhenStable();
      this._sendPing();
    }
  }

  _resetBackoffWhenStable() {
    this._clearTimer('_stableTimer', 'clearTimeout');
    const ws = this.ws;
    this._stableTimer = this.timers.setTimeout(() => {
      if (ws !== this.ws) return;
      this._stableTimer = null;
      if (ws?.readyState !== WS_OPEN || (this.status !== 'online' && !(this.status === 'connected' && !this.name))) return;
      this.attempt = 0;
      this._emit('status', this.snapshot());
    }, STABLE_CONNECTION_MS);
  }

  _onClose(ev) {
    this._teardownSocket();
    this._failPending('DISCONNECTED', false);
    if (this._manualClose) { this._setStatus('closed'); return; }
    if (ev && (ev.code === CLOSE_REPLACED || ev.code === CLOSE_ADMIN_KICK)) {
      // Neither a replaced nor an administratively disconnected socket should fight the server.
      const kicked = ev.code === CLOSE_ADMIN_KICK;
      this._manualClose = true;
      this._failPending(kicked ? 'ADMIN_KICK' : 'REPLACED', true);
      this.lastError = new NetError(kicked ? 'ADMIN_KICK' : 'REPLACED');
      this._setStatus('closed');
      this._emit(kicked ? 'kicked' : 'replaced', this.lastError);
      return;
    }
    if (ev && ev.code === CLOSE_HELLO_TIMEOUT && !this.name && this.status === 'connected'
        && this.now() - this._openedAt >= QUIET_SWAP_MIN_AGE_MS) {
      // Idle pre-hello socket dropped by the server: replace it without a visible status change.
      this._quietSwap = true;
      this.connect();
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._manualClose) return;
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.retryAt = this.now() + delay;
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    this._reconnectTimer = this.timers.setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
    this._setStatus('reconnecting');
  }

  _disconnectForRetry(reason) {
    const ws = this.ws;
    this._teardownSocket();
    try { ws?.close(4000, reason); } catch { /* 连接可能尚未建立 */ }
    this.lastError = new NetError('DISCONNECTED');
    this._failPending('DISCONNECTED', false);
    this._scheduleReconnect();
  }

  _teardownSocket() {
    this._clearTimer('_resumeTimer', 'clearTimeout');
    this._stateBases.clear();
    this._stateEpoch = null;
    this._stateDelta = false;
    this.serverProgressMs = 250;
    this._flow?.close();
    this._flow = null;
    for (const entry of this._pending.values()) entry.queued = false;
    this.trend.clear();
    this._clearTimer('_connectTimer', 'clearTimeout');
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    }
    this.ws = null;
    this.ping = null;
    this._pingAt = null;
    this._pingSamples.clear();
    this._lastPingSentAt = null;
    this._unansweredSince = null;
    this._clearTimer('_pingTimer', 'clearInterval');
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._clearTimer('_stableTimer', 'clearTimeout');
    this._clearTimer('_queueTimer', 'clearTimeout');
    this._queueBatchAt = 0;
    this._queueHeavyAt = 0;
    this._helloRid = null;
    this._helloSentName = null;
  }

  _clearTimer(field, fn) {
    if (this[field] != null) {
      try { this.timers[fn](this[field]); } catch { /* ignore */ }
      this[field] = null;
    }
  }

  // ---- handshake -------------------------------------------------------------------------------

  _sendHello() {
    if (!this.name) return;
    this._flow?.clear((entry) => {
      const stale = entry.data.t === 'b.progress' || entry.data.t.startsWith('chat.');
      if (stale && entry.options.request) entry.options.request.queued = false;
      return stale;
    });
    this._clearTimer('_stableTimer', 'clearTimeout');
    this._clearTimer('_queueTimer', 'clearTimeout');
    const rid = this._nextRid();
    const msg = { t: 'hello', rid, name: this.name, version: PROTOCOL_VERSION, stateDelta: 1, resumeProbe: 1 };
    const deviceId = this.getDeviceId();
    if (deviceId) msg.deviceId = deviceId;
    let token = null;
    try { token = this.getToken(); } catch { token = null; }
    if (typeof token === 'string' && token.length > 0 && token.length <= 64) msg.token = token;
    let aid = null;
    try { aid = this.getAid(this.name); } catch { aid = null; }
    if (typeof aid === 'string' && /^[0-9a-f]{8,64}$/.test(aid)) msg.aid = aid;
    this._helloRid = rid;
    this._helloSentName = this.name;
    if (this.status !== 'handshaking') this._setStatus('handshaking');
    if (!this._sendRaw(msg)) {
      if (this.ws?.readyState === WS_OPEN) this._disconnectForRetry('hello send failed');
      return;
    }
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloTimer = this.timers.setTimeout(() => {
      this._helloTimer = null;
      if (this.status !== 'handshaking') return;
      console.warn('[net] hello timed out; reconnecting');
      const ws = this.ws;
      this._teardownSocket();
      try { ws?.close(4000, 'hello timeout'); } catch { /* ignore */ }
      this._failPending('DISCONNECTED', false);
      this._scheduleReconnect();
    }, HELLO_TIMEOUT_MS);
  }

  _onWelcome(msg) {
    this._stateBases.clear();
    this._stateEpoch = null;
    this._stateDelta = msg.stateDelta === 1;
    this.serverProgressMs = Number.isFinite(msg.progressMs) ? Math.min(2000, Math.max(250, msg.progressMs)) : 250;
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloRid = null;
    // Compare future setName() calls against what we sent (the server may normalise the name).
    this.helloName = this._helloSentName;
    this.serverName = typeof msg.name === 'string' && msg.name ? msg.name : this._helloSentName;
    this.playerId = msg.playerId ?? null;
    this.serverId = ['main', 'secondary'].includes(msg.serverId) ? msg.serverId : null;
    this._resetBackoffWhenStable();
    this.lastError = null;
    if (Number.isFinite(msg.serverNow)) this._addClockSample(msg.serverNow + (this.ping ?? 0) / 2 - this.now(), Infinity);
    this._setStatus('online');
    this._flushQueue();
    this._sendPing();
  }

  _onHelloError(msg) {
    if (!this.playerId && typeof msg.detail === 'string' && msg.detail.startsWith('该账户已在其他连接登录')) {
      // 新连接被拒绝即停止自动重试，避免反复登录；原玩家保持在线。
      this._manualClose = true;
    }
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloRid = null;
    this.lastError = new NetError(msg.code, msg.msg, msg.detail);
    this._setStatus('connected');
    // Queued requests can't be sent without a session.
    this._failPending('OFFLINE', true);
    this._emit('helloError', this.lastError);
  }

  // ---- requests --------------------------------------------------------------------------------

  _nextRid() {
    this._rid = (this._rid % 2147483000) + 1;
    return this._rid;
  }

  /**
   * Send a request and wait for its `ok` (resolves with the reply message) or `error`
   * (rejects with NetError). Rejects with TIMEOUT after `timeout` ms, OFFLINE when there is no
   * session to send it on, BAD_MSG when it fails shared/protocol.js validation locally.
   * @param {string} t message type (C2S)
   * @param {object} [fields]
   * @param {{timeout?: number}} [opts]
   * @returns {Promise<any>}
   */
  request(t, fields = {}, opts = {}) {
    return new Promise((resolve, reject) => {
      if (t === 'hello') { reject(new NetError('BAD_MSG', 'use setName() for hello')); return; }
      const rid = this._nextRid();
      const msg = { ...(fields && typeof fields === 'object' ? fields : {}), t, rid };
      const bad = validateC2S(msg);
      if (bad) {
        console.warn(`[net] refusing invalid ${t}: ${bad}`);
        reject(new NetError('BAD_MSG', bad));
        return;
      }
      // Queue while a session is being (re)established; fail fast when none can come.
      const establishing = this.status === 'connecting' || this.status === 'handshaking' || this.status === 'reconnecting';
      if (this.status !== 'online' && !(establishing && this.name && !this._manualClose)) {
        reject(new NetError(this._manualClose ? 'CLOSED' : 'OFFLINE'));
        return;
      }
      if (this._pending.size >= MAX_PENDING_REQUESTS) {
        reject(new NetError('BUSY'));
        return;
      }
      const timeout = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : REQUEST_TIMEOUT_MS;
      const entry = { msg, resolve, reject, sent: false, queued: false, timer: null };
      entry.timer = this.timers.setTimeout(() => {
        if (this._pending.get(rid) !== entry) return;
        this._pending.delete(rid);
        this._flow?.clear((pending) => pending.options.request === entry);
        entry.queued = false;
        if (entry.sent) {
          this._expired.add(rid);
          if (this._expired.size > 64) this._expired.delete(this._expired.values().next().value);
        }
        if (![...this._pending.values()].some((pending) => !pending.sent)) this._clearTimer('_queueTimer', 'clearTimeout');
        reject(new NetError('TIMEOUT'));
      }, timeout);
      this._pending.set(rid, entry);
      if (this.status === 'online') {
        // 恢复队列仍在排空时，新请求加入尾部，不能越过旧操作；即使队列已暂时排空，也要遵守剩余冷却。
        const now = this.now();
        const queued = this._queueTimer != null
          || this._queueBatchAt > now
          || this._queueHeavyAt > now
          || [...this._pending.values()].some((p) => p !== entry && !p.sent);
        if (queued || t.startsWith('chat.')) {
          this._clearTimer('_queueTimer', 'clearTimeout');
          this._flushQueue();
        } else this._dispatchRequest(entry);
      }
    });
  }

  /**
   * Fire-and-forget message (no rid). Returns false when it could not be sent.
   * @param {string} t
   * @param {object} [fields]
   * @returns {boolean}
   */
  send(t, fields = {}, { periodic = false } = {}) {
    if (t === 'hello') return false;
    const msg = { ...(fields && typeof fields === 'object' ? fields : {}), t };
    const bad = validateC2S(msg);
    if (bad) { console.warn(`[net] refusing invalid ${t}: ${bad}`); return false; }
    if (this.status !== 'online') return false;
    const priority = t.startsWith('chat.') ? 'low' : t === 'b.progress' && periodic ? 'medium' : 'high';
    const key = t === 'b.progress' ? `b.progress:${msg.battleId}` : null;
    return this._sendRaw(msg, { priority, key, periodic });
  }

  _sendRaw(obj, options = {}) {
    try {
      return this._flow?.enqueue(obj, options) ?? false;
    } catch (err) {
      console.warn('[net] send failed', err);
      this._disconnectForRetry('send failed');
      return false;
    }
  }

  _writeRaw(obj, options = {}) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      const data = JSON.stringify(obj);
      const bytes = utf8.encode(data).byteLength;
      if (bytes > MAX_FRAME_BYTES || (ws.bufferedAmount || 0) + bytes > MAX_SEND_BUFFER_BYTES) {
        this._disconnectForRetry('send buffer limit');
        return false;
      }
      options.beforeSend?.();
      ws.send(data);
      return true;
    } catch (err) {
      console.warn('[net] send failed', err);
      this._disconnectForRetry('send failed');
      return false;
    }
  }

  _dispatchRequest(entry) {
    if (entry.queued || entry.sent || this._pending.get(entry.msg.rid) !== entry) return false;
    // TTL/溢出淘汰也不在同socket重复入队；仍由原timeout结束，断线时复位。
    entry.queued = true;
    return this._sendRaw(entry.msg, {
      priority: entry.msg.t.startsWith('chat.') ? 'low' : 'high',
      key: `request:${entry.msg.rid}`, request: entry,
    });
  }

  _sendRequest(entry) {
    // 真实 dispatch 时标记尝试发送，失败的非幂等操作不能重放。
    if (this._pending.get(entry.msg.rid) !== entry || entry.sent) return false;
    entry.sent = true;
    if (this._writeRaw(entry.msg)) return true;
    if (this._pending.delete(entry.msg.rid)) {
      this._clearEntryTimer(entry);
      entry.reject(new NetError('DISCONNECTED'));
    }
    return false;
  }

  _flushQueue() {
    if (this.status !== 'online' || this._queueTimer != null) return;
    const ws = this.ws;
    const batchStartedAt = this.now();
    let count = 0;
    let delay = Infinity;
    // 分档只改变跨档顺序；每档保留原始插入序，尤其不能重排购买操作。
    for (const priority of ['high', 'low']) {
      for (const entry of this._pending.values()) {
        if (this.status !== 'online') return;
        if (entry.sent || entry.queued || (entry.msg.t.startsWith('chat.') ? 'low' : 'high') !== priority) continue;
        const now = this.now();
        const heavy = HEAVY_TYPES.has(entry.msg.t);
        const wait = Math.max(0, count === 0 ? this._queueBatchAt - now : 0,
          heavy ? this._queueHeavyAt - now : 0);
        if (count >= QUEUE_BATCH_SIZE || wait > 0) {
          if (count >= QUEUE_BATCH_SIZE) this._queueBatchAt = Math.max(this._queueBatchAt, batchStartedAt + QUEUE_BATCH_MS);
          delay = Math.min(delay, count >= QUEUE_BATCH_SIZE ? QUEUE_BATCH_MS : wait);
          break;
        }
        this._dispatchRequest(entry);
        if (ws !== this.ws || this.status !== 'online') return;
        // false表示尚未实际发送；低档积压不占高档恢复预算，也不挂请求轮询timer。
        if (priority === 'high' || entry.sent) count++;
        if (heavy) this._queueHeavyAt = Math.max(this._queueHeavyAt, this.now() + HEAVY_QUEUE_MS);
      }
    }
    // 保留恢复批次250ms及heavy 500ms冷却，低档阻塞不会形成高档队首障碍。
    if (count) this._queueBatchAt = Math.max(this._queueBatchAt, batchStartedAt + QUEUE_BATCH_MS);
    if (Number.isFinite(delay) && [...this._pending.values()].some((entry) => !entry.sent && !entry.queued)) {
      this._queueTimer = this.timers.setTimeout(() => {
        if (ws !== this.ws) return;
        this._queueTimer = null;
        this._flushQueue();
      }, Math.max(1, delay));
    }
  }

  /**
   * Reject pending requests. Sent ones always fail (their reply is lost with the socket);
   * unsent (queued) ones fail only when `includeQueued` is true.
   */
  _failPending(code, includeQueued) {
    for (const [rid, entry] of [...this._pending]) {
      if (!entry.sent && !includeQueued) continue;
      this._pending.delete(rid);
      this._flow?.clear((pending) => pending.options.request === entry);
      entry.queued = false;
      this._clearEntryTimer(entry);
      try { entry.reject(new NetError(code)); } catch { /* ignore */ }
    }
  }

  _clearEntryTimer(entry) {
    if (entry.timer != null) {
      try { this.timers.clearTimeout(entry.timer); } catch { /* ignore */ }
      entry.timer = null;
    }
  }

  /** Number of requests waiting for a reply (sent or queued). */
  get pendingCount() {
    return this._pending.size;
  }

  // ---- incoming --------------------------------------------------------------------------------

  _decodeState(frame) {
    if (!this._stateDelta || typeof frame.k !== 'string'
        || !Number.isSafeInteger(frame.e) || !Number.isSafeInteger(frame.n) || frame.n < 1) throw new Error('invalid state frame');
    if (this._stateEpoch !== frame.e) {
      if (frame.t !== 'net.state') throw new Error('missing full state');
      this._stateBases.clear();
      this._stateEpoch = frame.e;
    }
    const previous = this._stateBases.get(frame.k);
    let msg;
    if (frame.t === 'net.state') msg = frame.v;
    else {
      if (!previous || previous.n !== frame.b || frame.n !== frame.b + 1) throw new Error('state baseline mismatch');
      msg = applyStatePatch(previous.v, frame.p);
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !STATE_TYPES.has(msg.t)
        || stateKey(msg) !== frame.k) throw new Error('invalid reconstructed state');
    // 订阅消费者可能修改对象，基准必须持有独立副本。
    this._stateBases.delete(frame.k);
    this._stateBases.set(frame.k, { n: frame.n, v: JSON.parse(JSON.stringify(msg)) });
    if (this._stateBases.size > 64) this._stateBases.delete(this._stateBases.keys().next().value);
    return msg;
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      console.warn('[net] dropped non-JSON frame');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    if (msg.t === 'net.state' || msg.t === 'net.delta') {
      try { msg = this._decodeState(msg); }
      catch {
        this._disconnectForRetry('state resync');
        return;
      }
    }
    this._lastRx = this.now();
    this._clearTimer('_resumeTimer', 'clearTimeout');
    this._unansweredSince = null;
    const { t } = msg;
    const rid = msg.rid;
    const isHelloError = t === 'error' && rid != null && rid === this._helloRid;
    const clearsBattle = t === 'b.end' || t === 'b.start' || t === 'spectator.closed'
      || t === 'room.state' || t === 'room.closed'
      || (t === 'm.public' && (!msg.phase || ['PREP', 'ROUND_START', 'SP_DRAFT', 'RESULT',
        'LOBBY', 'INFO_CHECK', 'BAND_DRAFT', 'BATTLE_CHECK'].includes(msg.phase)));
    // 先于订阅回调清理，避免终局未从本socket force或换field后补发旧进度。
    if (clearsBattle) this._flow?.clear((entry) => entry.priority === 'medium' && entry.data.t === 'b.progress');

    if (t === 'session.probe') {
      // 必须由当前页面响应；WebSocket 自动 pong 不能证明页面仍在运行。
      if (typeof msg.nonce === 'string' && /^[0-9a-f]{16}$/.test(msg.nonce))
        this._sendRaw({ t: 'session.probeAck', nonce: msg.nonce });
      return;
    }
    if (t === 'welcome') {
      this._onWelcome(msg);
    } else if (t === 'pong') {
      this._onPong(msg);
    } else if (isHelloError) {
      this._onHelloError(msg);
    } else if (t === 'm.public' && Number.isFinite(msg.serverNow) && !this.clockSynced) {
      this._addClockSample(msg.serverNow + (this.ping ?? 0) / 2 - this.now(), Infinity);
    }

    let handled = false;
    if (rid != null && t !== 'welcome' && this._pending.has(rid)) {
      const entry = this._pending.get(rid);
      this._pending.delete(rid);
      this._clearEntryTimer(entry);
      handled = true;
      try {
        if (t === 'error') entry.reject(new NetError(msg.code, msg.msg, msg.detail));
        else entry.resolve(msg);
      } catch (err) { console.error('[net] request callback failed', err); }
    }
    const late = rid != null && !handled && this._expired.delete(rid); // reply to a request that already timed out
    if (t === 'error' && !handled && !isHelloError && !late) {
      this._emit('unhandledError', new NetError(msg.code, msg.msg, msg.detail));
    }

    this._emit(t, msg);
    this._emit('*', msg);
  }

  // ---- heartbeat & clock -----------------------------------------------------------------------

  _startHeartbeat() {
    this._clearTimer('_pingTimer', 'clearInterval');
    this._pingTimer = this.timers.setInterval(() => this._heartbeat(), PING_INTERVAL_MS);
  }

  _heartbeat() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    this._syncVisibility();
    const live = this.status === 'online' || this.status === 'connected';
    const timeout = this._background ? BACKGROUND_DEAD_AFTER_MS : DEAD_AFTER_MS;
    if (live && this._unansweredSince != null && this.monotonicNow() - this._unansweredSince > timeout) {
      console.warn('[net] connection silent; reconnecting');
      this._teardownSocket();
      try { ws.close(4000, 'heartbeat timeout'); } catch { /* ignore */ }
      this._failPending('DISCONNECTED', false);
      this._scheduleReconnect();
      return;
    }
    const interval = this._background ? BACKGROUND_PING_INTERVAL_MS : PING_INTERVAL_MS;
    if (this._lastPingSentAt == null || this.monotonicNow() - this._lastPingSentAt >= interval) this._sendPing();
  }

  _sendPing() {
    if (this.status !== 'online' && this.status !== 'connected') return;
    const c = ++this._pingSequence;
    const ws = this.ws;
    this._sendRaw({ t: 'ping', c }, { beforeSend: () => {
      const at = this.monotonicNow();
      this._lastPingSentAt = at;
      for (const [id, sample] of this._pingSamples) if (at - sample.at > 60000) this._pingSamples.delete(id);
      this._pingSamples.set(c, { at, ws });
      if (this._pingSamples.size > 16) this._pingSamples.delete(this._pingSamples.keys().next().value);
      if (this._unansweredSince == null) this._unansweredSince = at;
    } });
  }

  /** Force an immediate latency probe (e.g. when the tab regains focus). */
  probe() {
    this._lastPingSentAt = null;
    this._heartbeat();
  }

  progressRtt() {
    return this._pingAt != null && this.monotonicNow() - this._pingAt <= DEAD_AFTER_MS ? this.ping : null;
  }

  _onPong(msg) {
    if (Number.isFinite(msg.progressMs)) this.serverProgressMs = Math.min(2000, Math.max(250, msg.progressMs));
    const now = this.now();
    const sample = this._pingSamples.get(msg.c);
    if (!sample || sample.ws !== this.ws) return;
    this._pingSamples.delete(msg.c);
    const at = this.monotonicNow();
    const rtt = at - sample.at;
    if (!(rtt >= 0 && rtt < 60000)) return;
    this._pingAt = at;
    this.ping = Math.round(rtt);
    this.trend.update({ source: 'rtt', at, rtt });
    if (Number.isFinite(msg.s)) this._addClockSample(msg.s + rtt / 2 - now, rtt);
    this._emit('ping', this.ping);
    this._emit('status', this.snapshot());
  }

  _addClockSample(offset, rtt) {
    if (!Number.isFinite(offset)) return;
    this._clockSamples.push({ offset, rtt });
    if (this._clockSamples.length > 8) this._clockSamples.shift();
    let best = this._clockSamples[0];
    for (const s of this._clockSamples) if (s.rtt < best.rtt) best = s;
    const prev = this.clockOffset;
    this.clockOffset = Math.round(best.offset);
    const wasSynced = this.clockSynced;
    this.clockSynced = this.clockSynced || Number.isFinite(rtt);
    if (Math.abs(prev - this.clockOffset) >= 1 || wasSynced !== this.clockSynced || this._clockSamples.length === 1) {
      this._emit('clock', { offset: this.clockOffset, rtt: Number.isFinite(best.rtt) ? best.rtt : null, synced: this.clockSynced });
    }
  }

  /** Current server time estimate (ms epoch). */
  serverNow() {
    return this.now() + this.clockOffset;
  }

  /**
   * Hook browser signals: reconnect immediately when the network comes back or the tab becomes
   * visible, and probe latency on focus. Safe to call in non-browser environments (no-op).
   */
  _syncVisibility() {
    const hidden = this.isHidden();
    if (this._background && !hidden) {
      // 恢复前台先给新探测完整答复窗口，不用暂停期间积累的旧超时断线。
      this._unansweredSince = null;
      this._pingSamples.clear();
    }
    this._background = hidden;
    if (hidden) this._clearTimer('_resumeTimer', 'clearTimeout');
  }

  /** A mobile browser may keep a dead transport OPEN after suspension or a network change. */
  resumeConnection(networkChanged = false) {
    this._syncVisibility();
    if (this._manualClose || this._background || this.status === 'idle') return;
    const ws = this.ws;
    if (!ws || ![WS_OPEN, WS_CONNECTING].includes(ws.readyState)) {
      this.retryNow();
      return;
    }
    if (ws.readyState === WS_CONNECTING || this.status === 'handshaking') {
      const timeout = ws.readyState === WS_CONNECTING ? RESUME_PROBE_MS : HELLO_TIMEOUT_MS;
      const startedAt = ws.readyState === WS_CONNECTING ? this._connectStartedAt : this._openedAt;
      const remaining = timeout - (this.now() - startedAt);
      if (networkChanged || remaining <= 0) this.reconnectNow();
      else if (this._resumeTimer == null) {
        this._resumeTimer = this.timers.setTimeout(() => {
          this._resumeTimer = null;
          if (ws === this.ws && !this._manualClose && !this.isHidden()
              && (ws.readyState === WS_CONNECTING || this.status === 'handshaking')) this.reconnectNow();
        }, remaining);
      }
      return;
    }
    if (!['online', 'connected'].includes(this.status) || this._resumeTimer != null) return;
    this.probe();
    if (ws !== this.ws) { this.retryNow(); return; }
    // Repeated focus/visibility signals must not keep extending the recovery deadline.
    this._resumeTimer = this.timers.setTimeout(() => {
      this._resumeTimer = null;
      if (ws === this.ws && !this._manualClose && !this.isHidden()) this.reconnectNow();
    }, RESUME_PROBE_MS);
  }

  attachBrowserHooks() {
    if (typeof window === 'undefined' || this._hooked) return;
    this._hooked = true;
    window.addEventListener('online', () => this.resumeConnection(true));
    window.addEventListener('focus', () => this.resumeConnection());
    document.addEventListener('visibilitychange', () => this.resumeConnection());
  }
}

// ---- identity persistence -------------------------------------------------------------------------
//
// Which reconnect token a tab uses is decided once per page load by `identity.init()`:
//   1. this tab's own token (sessionStorage: survives reloads of this tab),
//   2. else the most recent token of this browser (localStorage, so closing the tab and reopening
//      the game within the server's reconnect window resumes the seat),
// skipping every token that another *live* tab of this browser is using. Liveness is asked over a
// BroadcastChannel ('who holds these token hashes?' → 'mine'), not inferred from timer heartbeats:
// browsers throttle background-tab timers to ~1/min, which would make a busy background tab look
// dead. A duplicated tab (sessionStorage is copied) therefore drops the copied token and becomes a
// new player instead of kicking the original tab off its session (server close 4001). Two tabs
// resolving at the same moment tie-break on tab id. Without BroadcastChannel a tab only ever uses
// its own token (never another tab's), so it can't steal a live session either.

const K_NAME = 'sp.name';
// origin 自身隔离存储；显式命名空间使旧单服键只迁移到当前 origin。
const SESSION_SCOPE = encodeURIComponent(globalThis.location?.origin || 'local');
const K_SERVER = 'sp.game.server';
const K_MIGRATED = `sp.server.${SESSION_SCOPE}.migrated`;
const K_ENTERED = 'sp.entered';  // sessionStorage: this tab passed the title screen
const K_AID = 'sp.aid';          // localStorage: anonymous ranked-profile id (RANKED; stable across sessions)
const RECENT_MAX = 4;
const TOKEN_MAX_LEN = 64;        // protocol limit for hello.token
// BroadcastChannel 已按 origin 隔离；保留频道名以识别尚未刷新的旧单服标签页。
const CHANNEL_NAME = 'sp.identity';
/** How long init() waits for other tabs to claim a candidate token (ms). */
export const CLAIM_QUERY_MS = 150;

function safeStorage(kind) {
  try {
    const s = globalThis[kind];
    if (!s) return null;
    const probe = '__sp_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function sget(s, k) { try { return s ? s.getItem(k) : null; } catch { return null; } }
function sset(s, k, v) { try { if (s) s.setItem(k, v); } catch { /* quota / privacy mode */ } }
function sdel(s, k) { try { if (s) s.removeItem(k); } catch { /* ignore */ } }

const isToken = (t) => typeof t === 'string' && t.length > 0 && t.length <= TOKEN_MAX_LEN;

/**
 * Short, stable hash of a token (FNV-1a, hex) so tabs never broadcast tokens in clear.
 * @param {string} token
 * @returns {string}
 */
export function tokenHash(token) {
  let h = 2166136261;
  const s = String(token);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function defaultChannel() {
  try {
    return typeof globalThis.BroadcastChannel === 'function' ? new globalThis.BroadcastChannel(CHANNEL_NAME) : null;
  } catch {
    return null;
  }
}

/**
 * Create the identity helper (nickname, "entered" flag and reconnect-token selection; see above).
 * @param {{ local?: Storage|null, session?: Storage|null, tabId?: string,
 *           channel?: { postMessage: Function, addEventListener?: Function, onmessage?: any } | null,
 *           setTimeout?: (fn: Function, ms: number) => any, queryMs?: number }} [deps]
 */
export function createIdentity(deps = {}) {
  const local = deps.local !== undefined ? deps.local : safeStorage('localStorage');
  const session = deps.session !== undefined ? deps.session : safeStorage('sessionStorage');
  const tabId = deps.tabId || Math.random().toString(36).slice(2) + Date.now().toString(36);
  const setTimer = deps.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const queryMs = Number.isFinite(deps.queryMs) && deps.queryMs >= 0 ? deps.queryMs : CLAIM_QUERY_MS;
  let deviceId = sget(local, 'sp.deviceId');
  if (!/^[0-9a-f]{32}$/.test(deviceId || '')) {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    deviceId = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    sset(local, 'sp.deviceId', deviceId);
  }
  let accountName = (sget(local, K_NAME) || '').normalize('NFC').trim().replace(/\s+/g, ' ');
  const accountKey = () => `sp.device.${deviceId}.${serverId}.${encodeURIComponent(accountName)}.token`;
  const accountToken = () => {
    const token = sget(local, accountKey());
    return isToken(token) ? token : null;
  };
  const savedServer = sget(session, K_SERVER) || sget(local, K_SERVER);
  let serverId = savedServer === 'secondary' ? 'secondary' : 'main';
  // 保留华东旧键兼容；华南凭据与页面 origin 解耦，仍单独保存。
  let K_TOKEN = `sp.server.${SESSION_SCOPE}${serverId === 'main' ? '' : '.secondary'}.token`;
  let K_RECENT = `sp.server.${SESSION_SCOPE}${serverId === 'main' ? '' : '.secondary'}.tokens`;

  if (sget(local, K_MIGRATED) !== '1') {
    if (!sget(local, K_RECENT)) {
      const legacy = sget(local, 'sp.tokens');
      if (legacy) sset(local, K_RECENT, legacy);
    }
    sset(local, K_MIGRATED, '1');
    sdel(local, 'sp.tokens');
  }
  if (sget(session, K_MIGRATED) !== '1') {
    if (!sget(session, K_TOKEN)) {
      const legacy = sget(session, 'sp.token');
      if (isToken(legacy)) sset(session, K_TOKEN, legacy);
    }
    sset(session, K_MIGRATED, '1');
    sdel(session, 'sp.token');
  }

  let channel = null;
  let initPromise = null;
  let initialized = false;
  let current = null;    // token this tab uses (null = let the server create a session)
  let resolving = null;  // { hashes: Set<hash>, taken: Set<hash> } while init() waits for claims

  const readRecent = () => {
    try {
      const v = JSON.parse(sget(local, K_RECENT) || '[]');
      return Array.isArray(v) ? v.filter(isToken) : [];
    } catch {
      return [];
    }
  };
  const writeRecent = (list) => sset(local, K_RECENT, JSON.stringify([...new Set(list)].slice(0, RECENT_MAX)));

  const post = (msg) => {
    try { channel?.postMessage({ ...msg, from: tabId }); } catch { /* channel closed */ }
  };

  function onChannelMessage(ev) {
    const m = ev && ev.data;
    if (!m || typeof m !== 'object' || m.from === tabId || typeof m.from !== 'string') return;
    if (m.type === 'who' && Array.isArray(m.hashes)) {
      if (current) {
        const h = tokenHash(current);
        if (m.hashes.includes(h)) post({ type: 'mine', hash: h, to: m.from });
      }
      // Another tab is choosing at the same time: the smaller tab id has precedence.
      // 后创建的 channel 可能错过初次查询，待定候选也需按优先级回复。
      if (resolving) for (const h of m.hashes) {
        if (typeof h !== 'string') continue;
        if (m.from < tabId) resolving.taken.add(h);
        else if (resolving.hashes.has(h)) post({ type: 'mine', hash: h, to: m.from });
      }
    } else if (m.type === 'mine' && resolving && m.to === tabId && typeof m.hash === 'string') {
      resolving.taken.add(m.hash);
    }
  }

  async function resolveToken(fresh = false) {
    channel = deps.channel !== undefined ? deps.channel : defaultChannel();
    if (channel) {
      if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onChannelMessage);
      else channel.onmessage = onChannelMessage;
    }
    if (fresh) return null;
    if (accountName && accountToken()) return accountToken();
    const own = sget(session, K_TOKEN);
    const ownOk = isToken(own) ? own : null;
    // Without a channel we cannot tell whether a shared token is in use: never adopt one.
    const candidates = [...new Set([ownOk, ...(channel ? readRecent() : [])].filter(isToken))];
    if (!channel || candidates.length === 0) return ownOk;
    resolving = { hashes: new Set(candidates.map(tokenHash)), taken: new Set() };
    post({ type: 'who', hashes: [...resolving.hashes] });
    await new Promise((r) => setTimer(r, queryMs));
    const { taken } = resolving;
    resolving = null;
    return candidates.find((t) => !taken.has(tokenHash(t))) || null;
  }

  return {
    tabId,
    getDeviceId: () => deviceId,
    getServer: () => serverId,
    selectServer(id) {
      if (!['main', 'secondary'].includes(id)) throw new Error('无效服务器');
      current = null;
      serverId = id;
      sset(session, K_SERVER, id);
      K_TOKEN = `sp.server.${SESSION_SCOPE}${id === 'main' ? '' : '.secondary'}.token`;
      K_RECENT = `sp.server.${SESSION_SCOPE}${id === 'main' ? '' : '.secondary'}.tokens`;
      // 主动切服创建新会话，不能恢复目标服上次留下的座位或抢占其他标签。
      sdel(session, K_TOKEN);
      initialized = true;
    },
    /**
     * Decide which reconnect token this tab uses (once per page load; later calls return the same
     * promise). Call before the first `hello`. Never rejects.
     * @returns {Promise<string|null>}
     */
    init({ handoff = null } = {}) {
      if (!initPromise) {
        if (handoff) {
          // 主动切服只按名字选档，绝不恢复目标 origin 上次留下的房间会话。
          sdel(session, K_TOKEN);
          sdel(local, K_RECENT);
          sdel(session, 'sp.token');
          sdel(local, 'sp.tokens');
          current = null;
          if (handoff.name) sset(local, K_NAME, handoff.name);
          if (handoff.name && handoff.entered) sset(session, K_ENTERED, '1');
          else sdel(session, K_ENTERED);
        }
        initPromise = resolveToken(!!handoff).catch(() => null).then((pick) => {
          const own = sget(session, K_TOKEN);
          if (pick) sset(session, K_TOKEN, pick);
          else if (own) sdel(session, K_TOKEN); // duplicated tab: the copied token belongs to a live tab
          // A welcome may already have set a token while we were waiting: that one wins.
          if (!current) current = pick;
          initialized = true;
          return current;
        });
      }
      return initPromise;
    },
    /** @returns {string} remembered player name ('' if none) */
    loadName: () => (sget(local, K_NAME) || '').slice(0, 64),
    /** @param {string} name */
    saveName(name) {
      const next = String(name).normalize('NFC').trim().replace(/\s+/g, ' ');
      if (next !== accountName) {
        accountName = next;
        current = accountToken();
        initialized = true;
        sdel(session, K_TOKEN);
      }
      sset(local, K_NAME, next);
    },
    /** Token for `hello` (null ⇒ new session). Before init() only this tab's own token is used. */
    getToken() {
      if (accountName && accountToken()) return accountToken();
      if (current) return current;
      if (initialized) return null;
      const own = sget(session, K_TOKEN);
      return isToken(own) ? own : null;
    },
    /** @param {string} token from `welcome` */
    saveToken(token) {
      if (!isToken(token)) return;
      current = token;
      if (accountName) sset(local, accountKey(), token);
      // 已成功登录的服务器需跨大退保留；原标签仍优先使用自己的选服。
      sset(session, K_SERVER, serverId);
      sset(local, K_SERVER, serverId);
      sset(session, K_TOKEN, token);
      writeRecent([token, ...readRecent().filter((t) => t !== token)]);
    },
    /** Forget this tab's token (e.g. the server said the session is invalid). */
    clearToken() {
      const t = current || sget(session, K_TOKEN);
      if (accountName) sdel(local, accountKey());
      current = null;
      sdel(session, K_TOKEN);
      if (t) writeRecent(readRecent().filter((x) => x !== t));
    },
    /** Whether this tab already passed the title screen (survives reloads, not new tabs). */
    wasEntered: () => sget(session, K_ENTERED) === '1',
    /** @param {boolean} on */
    setEntered: (on) => (on ? sset(session, K_ENTERED, '1') : sdel(session, K_ENTERED)),
    /**
     * Anonymous ranked-profile id (RANKED): ONE PER PLAYER NAME (same browser switching names gets
     * separate ranked profiles — otherwise every tab/name in one browser would share a single rank).
     * Keyed as `sp.aid.<name>` in localStorage (32 hex chars; protocol limit 8–64 hex).
     * Existing profiles are recovered by NAME on the server (lobby adopts a same-named profile for a
     * fresh aid), so no legacy `sp.aid` migration is needed here.
     * @param {string} name player name from the hello being sent
     * @returns {string|null}
     */
    getAid(name) {
      const norm = String(name || '').trim();
      if (!norm) return null;
      const key = `${K_AID}.${encodeURIComponent(norm.toLowerCase())}`;
      const isAid = (v) => typeof v === 'string' && /^[0-9a-f]{8,64}$/.test(v);
      const cur = sget(local, key);
      if (isAid(cur)) return cur;
      let hex = '';
      try {
        const buf = new Uint8Array(16);
        (globalThis.crypto || { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); } }).getRandomValues(buf);
        hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { return null; }
      if (!isAid(hex)) return null;
      sset(local, key, hex);
      return hex;
    },
  };
}

/** Browser identity singleton (main.js awaits `identity.init()` before connecting). */
export const identity = createIdentity();

/** Browser connection singleton (created lazily-safe: nothing touches the network until connect()). */
export const net = new Net({ getToken: () => identity.getToken(), getAid: (name) => identity.getAid(name),
  getDeviceId: () => identity.getDeviceId() });
