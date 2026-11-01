// In-memory RPC integration: no listening socket, real server, or global timer replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createProfileAccess } from '../server/profileService.js';
import { LEASE_MS, HEARTBEAT_MS } from '../server/regions.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32);
const memoryStores = () => ({ players: new PlayerStore({ file: null }),
  ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const errors = [], requests = [];
  const log = { info() {}, warn() {}, error(...args) { errors.push(args); } };
  const main = createProfileAccess({ role: 'main', id: 'main', secret: '', accountFile: null,
    mainUrl: 'http://main.invalid', secondaryUrl: 'http://secondary.invalid' }, memoryStores(), log);
  let south, hook = null, beforeHook = null;
  // Intercept the actual compressed RPC boundary without making any network connection.
  t.mock.method(http, 'request', (url, options, receive) => {
    assert.equal(url.hostname, 'lease-recovery.invalid');
    assert.equal(options.method, 'POST');
    const request = new EventEmitter();
    request.closed = false;
    const close = () => { if (!request.closed) { request.closed = true; request.emit('close'); } };
    request.destroy = error => { if (!request.closed) { request.emit('error', error || Error('destroyed')); close(); } };
    request.end = packed => {
      const { op, args } = JSON.parse(gunzipSync(packed).toString());
      const row = { op, args }; requests.push(row);
      void Promise.resolve().then(async () => {
        if (beforeHook) await beforeHook(row);
        let value = await main.authority.call(op, args);
        if (hook) value = await hook(row, value);
        if (request.closed) return;
        const response = new EventEmitter(); response.statusCode = 200; response.headers = {};
        response.destroy = error => response.emit('error', error);
        receive(response); response.emit('data', Buffer.from(JSON.stringify({ value }))); response.emit('end'); close();
      }).catch(error => request.destroy(error));
    };
    return request;
  });
  t.after(async () => { south?.close(); main.close(); await turn(); });
  await main.ready();
  south = createProfileAccess({ role: 'secondary', id: 'secondary', secret: 'memory-only-test',
    serviceUrl: 'http://lease-recovery.invalid', accountFile: null,
    mainUrl: 'http://main.invalid', secondaryUrl: 'http://secondary.invalid' }, memoryStores(), log);
  await south.ready();
  const login = async (aid = A) => {
    const ws = { readyState: 1, terminated: 0, frames: [], terminate() { this.terminated++; this.readyState = 3; },
      send(data, done) { this.frames.push(JSON.parse(data)); done?.(); } };
    const session = { connected: true, ws, profileReady: true, profileBound: true, aid };
    assert.deepEqual(await south.login(session, `Lease-${aid[0]}`, aid, ws, false, aid), { aid });
    assert.equal(south.validSession(session), true);
    return session;
  };
  return { main, south, login, requests, errors, hook(value) { hook = value; }, before(value) { beforeHook = value; } };
}

test('secondary recovery keeps the original authority/heartbeat timing and reads one lease only', async t => {
  const h = await fixture(t), session = await h.login(), other = await h.login(B);
  assert.equal(LEASE_MS, 12_000); assert.equal(HEARTBEAT_MS, 3_000);
  const unchanged = h.requests.length;
  assert.equal(await h.south.ensureSession(other), true);
  assert.equal(h.requests.length, unchanged, 'an already-valid lease needs no RPC or profile read');
  const started = performance.now();
  session.leaseUntil = started - 1;
  const before = h.requests.length;
  assert.equal(await h.south.ensureSession(session), true);
  const checks = h.requests.slice(before).filter(r => r.op === 'region.heartbeat');
  assert.equal(checks.length, 1, 'a targeted recovery performs one bounded authority check');
  assert.deepEqual(checks[0].args[0].leases, [session.loginLease]);
  assert.equal(h.south.validSession(session), true);
  assert.ok(session.leaseUntil > performance.now());
  assert.ok(session.leaseUntil <= performance.now() + LEASE_MS - 1000);
  assert.equal(session.ws.terminated, 0);
});

test('secondary does not recover an explicitly released authority lease', async t => {
  const h = await fixture(t), session = await h.login();
  await h.main.authority.call('lease.release', [session.loginLease]);
  session.leaseUntil = performance.now() - 1;
  assert.equal(await h.south.ensureSession(session), false);
  assert.equal(h.south.validSession(session), false);
  assert.equal(session.ws.terminated, 1);
});

test('secondary accepts a still-valid renewal response after the old local deadline', async t => {
  const h = await fixture(t), session = await h.login();
  const captured = deferred(), release = deferred();
  h.hook(async (row, value) => {
    if (row.op === 'region.heartbeat' && row.args[0].leases.some(key => key.owner === session.loginLease.owner)) {
      captured.resolve(); await release.promise;
    }
    return value;
  });
  const exchange = h.south.flushReplication();
  await captured.promise;
  session.leaseUntil = performance.now() - 1;
  release.resolve(); await exchange;
  assert.equal(h.south.validSession(session), true);
  assert.equal(session.ws.terminated, 0);
});

test('secondary never treats a successful old-epoch response as current authority', async t => {
  const h = await fixture(t), session = await h.login();
  h.hook((row, value) => row.op === 'region.heartbeat' ? { ...value, epoch: 'retired-authority', renewed: [true] } : value);
  session.leaseUntil = performance.now() - 1;
  assert.equal(await h.south.ensureSession(session), false);
  assert.equal(h.south.validSession(session), false);
});

test('secondary does not revive a disconnected session from an in-flight success', async t => {
  const h = await fixture(t), session = await h.login();
  const captured = deferred(), release = deferred();
  h.hook(async (row, value) => {
    if (row.op === 'region.heartbeat' && row.args[0].leases.length) { captured.resolve(); await release.promise; }
    return value;
  });
  session.leaseUntil = performance.now() - 1;
  const recovery = h.south.ensureSession(session); await captured.promise;
  session.connected = false; h.south.disconnect(session); release.resolve();
  assert.equal(await recovery, false); assert.equal(h.south.validSession(session), false);
  assert.equal(session.loginLease, null);
});

test('a delayed old-generation rejection cannot revoke the replacement secondary login', async t => {
  const h = await fixture(t), session = await h.login();
  const oldLease = session.loginLease, captured = deferred(), release = deferred();
  let held = false;
  h.hook(async (row, value) => {
    if (!held && row.op === 'region.heartbeat' && row.args[0].leases.some(key => key.generation === oldLease.generation)) {
      held = true; captured.resolve(); await release.promise; return { ...value, renewed: [false] };
    }
    return value;
  });
  session.leaseUntil = performance.now() - 1;
  const recovery = h.south.ensureSession(session); await captured.promise;
  assert.deepEqual(await h.south.login(session, `Lease-${A[0]}`, A, session.ws, false, A), { aid: A });
  const replacement = session.loginLease; assert.ok(replacement.generation > oldLease.generation);
  release.resolve(); await recovery;
  assert.equal(session.loginLease, replacement); assert.equal(h.south.validSession(session), true);
  assert.equal(session.ws.terminated, 0);
});

test('secondary renewal is committed before an optional recruitment broadcast throws', async t => {
  const h = await fixture(t), first = await h.login(A), second = await h.login(B);
  let broadcasts = 0;
  const lobby = { rooms: new Map(), spectatorItems: () => [], recruitmentItems: () => [],
    broadcastRecruitment() {
      broadcasts++;
      assert.equal(h.south.validSession(first), true, 'first renewal must precede optional display work');
      assert.equal(h.south.validSession(second), true, 'other players must renew before optional display work');
      throw Error('injected optional recruitment broadcast failure');
    } };
  h.south.bindAdmin(lobby, { all: () => [] });
  const captured = deferred(), release = deferred(); let held = false;
  h.hook(async (row, value) => {
    if (!held && row.op === 'region.heartbeat' && row.args[0].leases.length === 2) {
      held = true; captured.resolve(); await release.promise;
    }
    return value;
  });
  const exchange = h.south.flushReplication(); await captured.promise;
  first.leaseUntil = performance.now() - 1; second.leaseUntil = performance.now() - 1;
  release.resolve(); await exchange;
  assert.ok(broadcasts > 0); assert.equal(h.south.validSession(first), true);
  assert.equal(h.south.validSession(second), true);
  assert.equal(first.ws.terminated + second.ws.terminated, 0);
});

test('concurrent secondary recovery callers share one bounded check and never grant on I/O failure', async t => {
  const h = await fixture(t), session = await h.login();
  let checks = 0;
  h.hook((row, value) => {
    if (row.op === 'region.heartbeat' && row.args[0].leases.length) { checks++; throw Error('injected RPC failure'); }
    return value;
  });
  session.leaseUntil = performance.now() - 1;
  const results = await Promise.all([h.south.ensureSession(session), h.south.ensureSession(session)]);
  assert.deepEqual(results, [false, false]); assert.equal(checks, 1);
  assert.equal(h.south.validSession(session), false); assert.equal(session.ws.terminated, 1);
});

test('one secondary authority rejection does not block another player renewal', async t => {
  const h = await fixture(t), first = await h.login(A), second = await h.login(B);
  await h.main.authority.call('lease.release', [first.loginLease]);
  await h.south.flushReplication();
  assert.equal(h.south.validSession(first), false); assert.equal(first.ws.terminated, 1);
  assert.equal(h.south.validSession(second), true); assert.equal(second.ws.terminated, 0);
});

test('a retired lease timer cannot terminate a replacement login on the same socket', async t => {
  const h = await fixture(t), session = await h.login();
  // Capture the actual scheduled callback, not a replacement clock or a fabricated stop hook.
  const retiredTimer = session.leaseTimer?._onTimeout;
  assert.equal(typeof retiredTimer, 'function');
  const previous = session.loginLease;
  assert.deepEqual(await h.south.login(session, `Lease-${A[0]}`, A, session.ws, false, A), { aid: A });
  assert.ok(session.loginLease.generation > previous.generation);
  retiredTimer(); await turn();
  assert.equal(h.south.validSession(session), true); assert.equal(session.ws.terminated, 0);
});

test('secondary recovery exits within its 2500 ms budget instead of leaving an unbounded session', { timeout: 4000 }, async t => {
  const h = await fixture(t), session = await h.login();
  const hold = deferred();
  h.hook(async (row, value) => {
    if (row.op === 'region.heartbeat' && row.args[0].leases.length) await hold.promise;
    return value;
  });
  session.leaseUntil = performance.now() - 1;
  const start = performance.now();
  try {
    assert.equal(await h.south.ensureSession(session), false);
    assert.ok(performance.now() - start < 2900, 'recovery may not reset or exceed the authority-check budget');
    assert.equal(h.south.validSession(session), false); assert.equal(session.ws.terminated, 1);
  } finally { hold.resolve(); }
});

test('secondary keeps renewing the valid old lease during replacement preclaim synchronization', async t => {
  const h = await fixture(t), session = await h.login();
  const oldLease = session.loginLease, captured = deferred(), release = deferred();
  let preclaim = null;
  h.before(async row => {
    if (!preclaim && row.op === 'region.heartbeat' && session.loginInFlight) {
      preclaim = row; captured.resolve(); await release.promise;
    }
  });
  const replacement = h.south.login(session, `Lease-${A[0]}`, A, session.ws, false, A);
  await captured.promise;
  try {
    assert.equal(session.loginLease, oldLease, 'preclaim does not erase the still-valid prior lease');
    assert.ok(preclaim.args[0].leases.some(key => key.owner === oldLease.owner
      && key.generation === oldLease.generation), 'preclaim synchronization must keep old-lease renewal');
    assert.equal(session.ws.terminated, 0);
  } finally { release.resolve(); }
  assert.deepEqual(await replacement, { aid: A });
  assert.ok(session.loginLease.generation > oldLease.generation);
  assert.equal(h.south.validSession(session), true);
});
test('a secondary socket termination error cannot prevent another player in the same batch renewing', async t => {
  const h = await fixture(t), first = await h.login(A), second = await h.login(B);
  await h.main.authority.call('lease.release', [first.loginLease]);
  const terminate = first.ws.terminate;
  first.ws.terminate = function () { this.terminated++; throw Error('injected socket terminate failure'); };
  try {
    await h.south.flushReplication();
    assert.equal(h.south.validSession(first), false);
    assert.equal(h.south.validSession(second), true); assert.equal(second.ws.terminated, 0);
  } finally { first.ws.terminate = terminate; }
});

test('an in-flight recovery resolves false when the local session is revoked before its reply', async t => {
  const h = await fixture(t), session = await h.login();
  const captured = deferred(), release = deferred();
  h.hook(async (row, value) => {
    if (row.op === 'region.heartbeat' && row.args[0].leases.length) { captured.resolve(); await release.promise; }
    return value;
  });
  session.leaseUntil = performance.now() - 1;
  const recovery = h.south.ensureSession(session); await captured.promise;
  session.loginRevoked = true; release.resolve();
  let timer;
  try {
    const outcome = await Promise.race([recovery, new Promise(resolve => { timer = setTimeout(() => resolve('pending'), 100); })]);
    assert.equal(outcome, false, 'fencing an obsolete reply must also finish its old recovery waiter');
    assert.equal(h.south.validSession(session), false);
  } finally { clearTimeout(timer); h.south.disconnect(session); }
});

test('secondary batches simultaneous expired players once and grants no business before confirmation', async t => {
  const h = await fixture(t), first = await h.login(A), second = await h.login(B);
  const captured = deferred(), release = deferred();
  let checks = 0, keys = null;
  h.hook(async (row, value) => {
    if (row.op === 'region.heartbeat' && row.args[0].leases.length) {
      checks++; keys = row.args[0].leases; captured.resolve(); await release.promise;
    }
    return value;
  });
  first.leaseUntil = performance.now() - 1; second.leaseUntil = performance.now() - 1;
  const results = Promise.all([h.south.ensureSession(first), h.south.ensureSession(second)]);
  await captured.promise;
  try {
    assert.equal(h.south.validSession(first), false); assert.equal(h.south.validSession(second), false);
    assert.equal(first.ws.terminated + second.ws.terminated, 0, 'recovery retains the sockets but not authorization');
    assert.equal(checks, 1); assert.deepEqual(keys, [first.loginLease, second.loginLease]);
  } finally { release.resolve(); }
  assert.deepEqual(await results, [true, true]); assert.equal(checks, 1);
});

test('an older successful secondary response cannot shorten a newer confirmed lease', async t => {
  const h = await fixture(t), session = await h.login();
  const captured = deferred(), release = deferred(), oldReturned = deferred();
  let held = false;
  h.hook(async (row, value) => {
    if (!held && row.op === 'region.heartbeat' && row.args[0].leases.length) {
      held = true; captured.resolve(); await release.promise; oldReturned.resolve();
    }
    return value;
  });
  session.leaseUntil = performance.now() - 1;
  const oldRecovery = h.south.ensureSession(session); await captured.promise;
  await turn(); await h.south.flushReplication();
  const newerDeadline = session.leaseUntil;
  assert.equal(h.south.validSession(session), true);
  release.resolve(); await oldReturned.promise; await oldRecovery; await turn();
  assert.equal(session.leaseUntil, newerDeadline);
  assert.equal(h.south.validSession(session), true); assert.equal(session.ws.terminated, 0);
});


test('main recovery uses the same authority fencing without a remote service', async t => {
  const main = createProfileAccess({ role: 'main', id: 'main', secret: '', accountFile: null,
    mainUrl: 'http://main.invalid', secondaryUrl: 'http://secondary.invalid' }, memoryStores(),
  { info() {}, warn() {}, error() {} });
  t.after(() => main.close());
  await main.ready();
  const ws = { readyState: 1, terminated: 0, terminate() { this.terminated++; this.readyState = 3; } };
  const session = { connected: true, ws, profileReady: true, profileBound: true, aid: A };
  assert.deepEqual(await main.login(session, 'Local-main', A, ws, false, A), { aid: A });
  session.leaseUntil = performance.now() - 1;
  assert.equal(await main.ensureSession(session), true);
  assert.equal(main.validSession(session), true);
  assert.equal(ws.terminated, 0);
  await main.authority.call('lease.release', [session.loginLease]);
  assert.equal(await main.ensureSession(session), false);
  assert.equal(main.validSession(session), false);
  assert.equal(ws.terminated, 1);
});

test('an early lease timer wakeup rearms the exact deadline instead of losing the expiry check', async t => {
  const h = await fixture(t), session = await h.login();
  const timer = session.leaseTimer, until = session.leaseUntil, before = h.requests.length;
  assert.equal(typeof timer?._onTimeout, 'function');
  timer._onTimeout(); await turn();
  assert.notEqual(session.leaseTimer, timer);
  assert.equal(session.leaseUntil, until, 'early timer rearm never extends authorization');
  assert.equal(h.requests.length, before);
  assert.equal(h.south.validSession(session), true);
  assert.equal(session.ws.terminated, 0);
});
