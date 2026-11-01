import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Network, SessionRegistry, CLOSE, send, sendSession } from '../server/net.js';
import { S2C } from '../shared/protocol.js';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.frames = []; this.closes = []; }
  send(data, callback) { this.frames.push(JSON.parse(data)); callback?.(); }
  close(code = 1000, reason = '') { this.closes.push({ code, reason }); this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006); }
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(t, { profiles, onMessage = () => ({ ok: true }), options = {}, attach = true } = {}) {
  const logs = [];
  const tcpMetrics = { register() {}, remove() {}, get() { return null; }, close() {} };
  const registry = new SessionRegistry();
  const handler = { profiles, onMessage };
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (...args) => logs.push({ level, args })]));
  const network = new Network({ registry, handler, tcpMetrics, log, options });
  const ws = new Socket(); network.handleConnection(ws);
  const conn = network.conns.get(ws);
  let session;
  if (attach) {
    session = registry.create('Test');
    Object.assign(session, { ws, connected: true, disconnectedAt: null, profileReady: true,
      aid: 'a'.repeat(32), profileBound: true });
    conn.session = session;
  }
  t.after(() => { ws.close(); network.close(); });
  const frame = (msg, binary = false) => ws.emit('message', Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)), binary);
  return { network, ws, conn, session, handler, logs, frame };
}

test('validated ping bypasses blocked business queue without changing business order', async (t) => {
  const gate = deferred(), seen = [];
  const h = harness(t, { onMessage: async (_s, msg) => { seen.push(msg.rid); if (msg.rid === 1) await gate.promise; } });
  h.frame({ t: 'room.leave', rid: 1 }); await tick();
  h.frame({ t: 'room.leave', rid: 2 });
  h.frame({ t: 'ping', rid: 3, c: 456 });
  assert.deepEqual(seen, [1]);
  assert.equal(h.conn.pendingMessages, 2);
  assert.deepEqual(h.ws.frames.at(-1), { t: 'pong', c: 456, s: h.ws.frames.at(-1).s, progressMs: h.conn.periodicInterval(), rid: 3 });
  gate.resolve(); await h.conn.messageChain;
  assert.deepEqual(seen, [1, 2]); assert.equal(h.conn.pendingMessages, 0);
});

test('ping fast path retains JSON, binary, schema and rate limit checks', (t) => {
  const h = harness(t, { options: { rateBurst: 4, ratePerSec: 0 } });
  h.frame({ t: 'ping', c: 'bad', rid: 1 });
  h.frame('{'); h.frame({ t: 'ping', c: 5 }, true);
  assert.equal(h.ws.frames.filter((x) => x.t === 'pong').length, 0);
  assert.equal(h.ws.frames.filter((x) => x.code === 'BAD_MSG').length, 3);
  h.frame({ t: 'ping', c: 6, rid: 4 }); assert.equal(h.ws.frames.at(-1).t, 'pong');
  h.frame({ t: 'ping', c: 7, rid: 5 }); assert.equal(h.ws.frames.at(-1).code, 'RATE');
});

test('ping is quiet on revoked, released, detached, draining and closing connections', (t) => {
  for (const mode of ['loginRevoked', 'loginReleased', 'detached', 'draining', 'closing']) {
    const h = harness(t);
    if (mode === 'detached') h.session.ws = new Socket();
    else if (mode === 'draining') h.network.draining = true;
    else if (mode === 'closing') h.conn.closing = true;
    else h.session[mode] = true;
    h.frame({ t: 'ping', c: 1 }); assert.equal(h.ws.frames.length, 0, mode);
  }
});

test('business waits for bounded authority recovery while transport ping stays responsive', async (t) => {
  const gate = deferred(); let valid = false, checks = 0, actions = 0;
  const h = harness(t, { profiles: { validSession: () => valid,
    ensureSession: async () => { checks++; await gate.promise; valid = true; return true; } },
    onMessage: () => { actions++; return { ok: true }; } });
  h.session.loginLease = 'lease'; h.session.leaseUntil = -1;
  h.frame({ t: 'room.leave', rid: 1 }); await tick();
  assert.equal(checks, 1); assert.equal(actions, 0);
  h.frame({ t: 'ping', c: 23, rid: 2 }); assert.equal(h.ws.frames.at(-1).t, 'pong');
  assert.equal(h.ws.closes.length, 0);
  assert.equal(send(h.ws, { t: 'm.public', phase: 'PREP' }), false);
  assert.equal(h.ws.closes.length, 0, 'an outgoing snapshot cannot independently kill recovery');
  h.session.leaseUntil = Infinity; gate.resolve(); await h.conn.messageChain;
  assert.equal(actions, 1); assert.equal(h.ws.closes.length, 0);
});

test('many expired outbound frames trigger one bounded recovery and no premature close', async (t) => {
  const gate = deferred(); let valid = false, checks = 0;
  const h = harness(t, { profiles: { validSession: () => valid,
    ensureSession: async () => { checks++; await gate.promise; valid = true; return true; } } });
  h.session.loginLease = 'lease'; h.session.leaseUntil = -1;
  for (let i = 0; i < 20; i++) assert.equal(send(h.ws, { t: 'm.public', phase: 'PREP', round: i }), false);
  assert.equal(sendSession(h.session, { t: 'm.private' }), false);
  assert.equal(checks, 1); assert.equal(h.ws.frames.length, 0); assert.equal(h.ws.closes.length, 0);
  h.session.leaseUntil = Infinity; gate.resolve(); await tick();
  assert.equal(h.conn.leaseRecovery, null); assert.equal(h.ws.closes.length, 0);
  assert.equal(send(h.ws, { t: 'm.public', phase: 'PREP' }), true);
});

test('pending login owns its deadline: expired outgoing frames and queued business cannot close it', async (t) => {
  let checks = 0, actions = 0;
  const h = harness(t, { profiles: { validSession: () => false,
    ensureSession: async () => { checks++; return false; } }, onMessage: () => { actions++; } });
  Object.assign(h.session, { loginLease: { generation: 1 }, loginGeneration: 2,
    loginInFlight: 2, leaseUntil: -1 });
  assert.equal(send(h.ws, { t: 'm.public', phase: 'PREP' }), false);
  assert.equal(sendSession(h.session, { t: 'm.private' }), false);
  h.frame({ t: 'room.leave', rid: 1 }); await h.conn.messageChain;
  assert.equal(checks, 0); assert.equal(actions, 0); assert.equal(h.ws.closes.length, 0);
  h.frame({ t: 'ping', c: 32 }); assert.equal(h.ws.frames.at(-1).t, 'pong');
});

test('a recovery result cannot close or authorize a replacement login on the same socket', async (t) => {
  for (const pending of [true, false]) {
    const gate = deferred(); let actions = 0;
    const h = harness(t, { profiles: { validSession: () => false, ensureSession: () => gate.promise },
      onMessage: () => { actions++; } });
    Object.assign(h.session, { loginLease: { generation: 1 }, loginGeneration: 1 });
    h.frame({ t: 'room.leave', rid: 1 }); await tick();
    h.session.loginGeneration = 2;
    if (pending) h.session.loginInFlight = 2;
    else h.session.loginLease = { generation: 2 };
    gate.resolve(false); await h.conn.messageChain;
    assert.equal(actions, 0); assert.equal(h.ws.closes.length, 0);
    assert.equal(h.session.profileReady, true, 'retired recovery cannot mutate replacement readiness');
  }
});

test('authority recovery must return true and a currently valid lease before dispatch', async (t) => {
  for (const mode of ['false', 'true-but-invalid', 'throws']) {
    let actions = 0;
    const h = harness(t, { profiles: { validSession: () => false,
      ensureSession: async () => { if (mode === 'throws') throw new Error('secret'); return mode !== 'false'; } },
      onMessage: () => { actions++; } });
    h.frame({ t: 'room.leave', rid: 1 }); await h.conn.messageChain;
    assert.equal(actions, 0, mode);
    assert.deepEqual(h.ws.closes[0], { code: CLOSE.POLICY, reason: 'login lease expired' });
    assert.equal(h.conn.closeCause, 'login_lease_expired');
    assert.equal(h.session.profileReady, false);
  }
});

test('late recovery cannot dispatch or close a replacement connection', async (t) => {
  const gate = deferred(); let actions = 0;
  const h = harness(t, { profiles: { validSession: () => false, ensureSession: () => gate.promise }, onMessage: () => { actions++; } });
  h.frame({ t: 'room.leave', rid: 1 }); await tick();
  h.session.ws = new Socket(); gate.resolve(true); await h.conn.messageChain;
  assert.equal(actions, 0); assert.equal(h.ws.closes.length, 0); assert.equal(h.session.ws.closes.length, 0);
});

test('repeat hello recovers authority before refreshing login, and never bypasses rejection', async (t) => {
  for (const recover of [true, false]) {
    let valid = false, loginCalls = 0, checks = 0;
    const h = harness(t, { profiles: {
      authenticate: async () => ({ aid: 'a'.repeat(32), name: 'Test', ticket: 'ticket' }),
      validSession: () => valid,
      ensureSession: async () => { checks++; valid = recover; return recover; },
      login: async () => { loginCalls++; return { aid: 'a'.repeat(32) }; },
    } });
    h.frame({ t: 'hello', name: 'Test', rid: 1 }); await h.conn.messageChain;
    assert.equal(checks, 1); assert.equal(loginCalls, recover ? 1 : 0);
    assert.equal(h.session.profileReady, recover);
    assert.equal(h.ws.frames.some((x) => x.t === 'welcome'), recover);
  }
});

test('lease control is bound to current transport, is not authorization, and exposes no identity', (t) => {
  let valid = false;
  const h = harness(t, { profiles: { validSession: () => valid } });
  h.session.loginLease = 'secret'; h.session.leaseUntil = -1;
  assert.ok(S2C.includes('session.lease'));
  assert.equal(h.network.leaseState(h.session, 'recovering', 2000.1), true);
  assert.deepEqual(h.ws.frames.at(-1), { t: 'session.lease', state: 'recovering', retryMs: 2001 });
  assert.equal(h.network.leaseState(h.session, 'active'), false);
  valid = true; h.session.leaseUntil = Infinity;
  assert.equal(h.network.leaseState(h.session, 'active'), true);
  assert.deepEqual(h.ws.frames.at(-1), { t: 'session.lease', state: 'active' });
  assert.equal(h.network.leaseState(h.session, 'other'), false);
  h.session.ws = new Socket(); assert.equal(h.network.leaseState(h.session, 'recovering', 10), false);
});

test('policy close classification uses fixed safe reasons, never leaks arbitrary strings, logs once', (t) => {
  const reasons = { 'rate limit': 'rate_limit', 'login lease expired': 'login_lease_expired',
    'message backlog': 'message_backlog', 'login rejected': 'login_rejected',
    'login unavailable': 'login_unavailable', 'session released': 'session_released', 'token-secret': 'policy_close' };
  for (const [reason, cause] of Object.entries(reasons)) {
    const h = harness(t);
    h.conn.close(CLOSE.POLICY, reason); h.conn.close(CLOSE.POLICY, reason);
    assert.equal(h.conn.closeCause, cause);
    const events = h.logs.flatMap((x) => x.args.filter((v) => typeof v === 'string' && v.startsWith('[net] ')).map((v) => JSON.parse(v.slice(6))));
    const requests = events.filter((x) => x.event === 'ws_close_requested'); assert.equal(requests.length, 1);
    assert.equal(requests[0].cause, cause);
    assert.equal(requests[0].closeReason, reason === 'token-secret' ? '[redacted]' : reason);
    assert.ok(!JSON.stringify(events).includes('token-secret'));
  }
});


test('active lease runs one deferred recovery hook without login or business replay', async (t) => {
  const h = harness(t, { profiles: { validSession: () => true } });
  Object.assign(h.session, { loginGeneration: 1, loginLease: { generation: 1 } });
  let recoveries = 0, logins = 0, business = 0;
  h.handler.onLeaseRecovered = session => { assert.equal(session, h.session); recoveries++; };
  h.handler.onHello = () => logins++;
  h.handler.onMessage = () => business++;
  h.network.leaseState(h.session, 'active'); await tick(); assert.equal(recoveries, 0);
  h.network.leaseState(h.session, 'recovering', 2500);
  h.network.leaseState(h.session, 'recovering', 2500);
  h.network.leaseState(h.session, 'active'); h.network.leaseState(h.session, 'active');
  assert.equal(recoveries, 0, 'the entire authority renewal batch commits before resync');
  await tick(); assert.equal(recoveries, 1);
  h.network.leaseState(h.session, 'active'); await tick(); assert.equal(recoveries, 1);
  assert.equal(logins, 0); assert.equal(business, 0);
  h.network.leaseState(h.session, 'recovering', 2500); h.network.leaseState(h.session, 'active');
  await tick(); assert.equal(recoveries, 2, 'a later actual recovery gets its own state resync');
});

test('recovery hook rechecks current identity, authorization and readiness at execution time', async (t) => {
  for (const mode of ['socket', 'generation', 'lease', 'login', 'revoked', 'released', 'disconnected', 'not-ready', 'invalid', 'draining', 'closing']) {
    let valid = true, recoveries = 0;
    const h = harness(t, { profiles: { validSession: () => valid } });
    Object.assign(h.session, { loginGeneration: 1, loginLease: { generation: 1 } });
    h.handler.onLeaseRecovered = () => recoveries++;
    h.network.leaseState(h.session, 'recovering', 2500); h.network.leaseState(h.session, 'active');
    if (mode === 'socket') h.session.ws = new Socket();
    else if (mode === 'generation') h.session.loginGeneration++;
    else if (mode === 'lease') h.session.loginLease = { generation: 1 };
    else if (mode === 'login') h.session.loginInFlight = 2;
    else if (mode === 'revoked') h.session.loginRevoked = true;
    else if (mode === 'released') h.session.loginReleased = true;
    else if (mode === 'disconnected') h.session.connected = false;
    else if (mode === 'not-ready') h.session.profileReady = false;
    else if (mode === 'invalid') valid = false;
    else if (mode === 'draining') h.network.draining = true;
    else if (mode === 'closing') h.conn.closing = true;
    await tick(); assert.equal(recoveries, 0, mode);
    assert.equal(h.conn.leaseRecoveryNotice, null, 'stale recovery is retired rather than retried');
  }
});

test('old recovery notice cannot resync a replacement login even after it becomes active', async (t) => {
  const h = harness(t, { profiles: { validSession: () => true } });
  Object.assign(h.session, { loginGeneration: 1, loginLease: { generation: 1 } });
  let recoveries = 0; h.handler.onLeaseRecovered = () => recoveries++;
  h.network.leaseState(h.session, 'recovering', 2500);
  h.session.loginGeneration = 2; h.session.loginLease = { generation: 2 };
  h.network.leaseState(h.session, 'active'); await tick();
  assert.equal(recoveries, 0);
});

test('recovery hook exceptions are rate limited and never block another connection', async (t) => {
  const bad = harness(t, { profiles: { validSession: () => true } });
  const good = harness(t, { profiles: { validSession: () => true } });
  let goodCalls = 0, badCalls = 0;
  bad.handler.onLeaseRecovered = () => { badCalls++; throw Error('private detail'); };
  good.handler.onLeaseRecovered = () => goodCalls++;
  for (let i = 0; i < 2; i++) {
    bad.network.leaseState(bad.session, 'recovering', 2500); bad.network.leaseState(bad.session, 'active');
    good.network.leaseState(good.session, 'recovering', 2500); good.network.leaseState(good.session, 'active');
    await tick();
  }
  assert.equal(badCalls, 2); assert.equal(goodCalls, 2);
  const warnings = bad.logs.filter(x => x.level === 'warn' && x.args.some(v => String(v).includes('login_lease_resync_error')));
  assert.equal(warnings.length, 1); assert.ok(!JSON.stringify(bad.logs).includes('private detail'));
  bad.handler.onLeaseRecovered = () => Promise.reject(Error('private async detail'));
  bad.network.leaseState(bad.session, 'recovering', 2500); bad.network.leaseState(bad.session, 'active');
  await tick(); await tick();
  assert.equal(bad.ws.closes.length, 0);
});
