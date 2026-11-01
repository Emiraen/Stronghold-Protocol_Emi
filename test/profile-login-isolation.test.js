// In-memory RPC integration: no listening socket, real server, or global timer replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createProfileAccess, createAuthority } from '../server/profileService.js';
import { ProfileReplication } from '../server/profileReplication.js';
import { AccountAuth } from '../server/accountAuth.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32);
const memoryStores = () => ({ players: new PlayerStore({ file: null }),
  ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { legacy = false } = {}) {
  const errors = [], requests = [];
  const log = { info() {}, warn() {}, error(...args) { errors.push(args); } };
  const mainStores = memoryStores();
  const main = createProfileAccess({ role: 'main', id: 'main', secret: '', accountFile: null,
    mainUrl: 'http://main.invalid', secondaryUrl: 'http://secondary.invalid' }, mainStores, log);
  let south, hook = null, beforeHook = null, authority = main.authority;
  // Intercept the actual compressed RPC boundary without making any network connection.
  t.mock.method(http, 'request', (url, options, receive) => {
    assert.equal(url.hostname, 'login-isolation.invalid');
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
        if (legacy && op === 'region.heartbeat' && args[0].replication) delete args[0].replication.sharedWrites;
        let value = await authority.call(op, args);
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
  if (legacy) {
    authority = createAuthority(mainStores, { sharedWrites: false, accounts: new AccountAuth({ file: null }) });
    authority.replication = main.replication;
  }
  south = createProfileAccess({ role: 'secondary', id: 'secondary', secret: 'memory-only-test',
    serviceUrl: 'http://login-isolation.invalid', accountFile: null,
    mainUrl: 'http://main.invalid', secondaryUrl: 'http://secondary.invalid' }, memoryStores(), log);
  await south.ready();
  const session = (aid = A) => {
    const ws = { readyState: 1, terminated: 0, frames: [], terminate() { this.terminated++; this.readyState = 3; },
      send(data, done) { this.frames.push(JSON.parse(data)); done?.(); } };
    return { connected: true, ws, profileReady: true, profileBound: true, aid };
  };
  const login = async (aid = A, next = session(aid)) => {
    assert.deepEqual(await south.login(next, 'Login-' + aid[0], aid, next.ws, false, aid), { aid });
    assert.equal(south.validSession(next), true); return next;
  };
  return { main, mainStores, south, authority, session, login, requests, errors,
    hook(value) { hook = value; }, before(value) { beforeHook = value; } };
}


const historyJob = (aid = B, match = '1') => ({ matchId: match.repeat(32),
  seats: [{ aid, playerId: 'p1', isBot: false }], summary: { players: [{ playerId: 'p1' }] } });
const job = (aid = A) => ({ ranked: true, match: { matchId: '2'.repeat(32) },
  seats: [{ aid, playerId: 'p1', isBot: false }], entries: [{ who: { aid, playerId: 'p1' }, row: { roundsPassed: 1 } }],
  result: { t: 'm.result', players: [{ playerId: 'p1', stats: { kills: 1 } }] } });
async function bounded(value, ms = 3000) {
  let timer;
  try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('independent operation blocked')), ms); })]); }
  finally { clearTimeout(timer); }
}

test('login isolation: another account waiting for a 10-second history receipt cannot block this login', async t => {
  const h = await fixture(t), captured = deferred(), release = deferred();
  h.before(async row => { if (row.op === 'historyRecord') { captured.resolve(); await release.promise; } });
  const pending = h.south.history.record(historyJob(B)); await captured.promise;
  try {
    await bounded(h.login(A));
    assert.equal(h.requests.filter(row => row.op === 'historyRecord').length, 1, 'login must not replay unrelated pending work');
  } finally { release.resolve(); await pending; }
});

test('login isolation: the same account pending history remains fenced instead of being skipped', async t => {
  const h = await fixture(t), captured = deferred(), release = deferred();
  h.before(async row => { if (row.op === 'historyRecord') { captured.resolve(); await release.promise; } });
  const pending = h.south.history.record(historyJob(A)); await captured.promise;
  const session = h.session(A);
  try {
    await assert.rejects(bounded(h.south.login(session, 'Login-a', A, session.ws, false, A)), { code: 'RESULT_SETTLEMENT_FAILED' });
    assert.equal(h.south.validSession(session), false);
    assert.equal(h.requests.filter(row => row.op === 'login').length, 0);
  } finally { release.resolve(); await pending; }
});

test('login isolation: unknown economic result blocks its own account but unrelated login never replays it', async t => {
  const h = await fixture(t);
  h.before(row => { if (row.op === 'complete') throw Error('lost economic receipt'); });
  await assert.rejects(h.south.completeMatch(job(A)), { code: 'RESULT_SETTLEMENT_FAILED' });
  const session = h.session(A);
  await assert.rejects(h.south.login(session, 'Login-a', A, session.ws, false, A), { code: 'RESULT_SETTLEMENT_FAILED' });
  await bounded(h.login(B)); await h.south.drain();
  assert.equal(h.requests.filter(row => row.op === 'complete').length, 1);
  assert.equal(h.south.validSession(session), false);
});

test('login isolation: a moving unrelated replication head cannot prevent receipt-version login completion', async t => {
  const h = await fixture(t); let batches = 0, lastHead;
  h.hook((row, value) => {
    if (row.op === 'region.heartbeat' && value.replication) {
      batches++; lastHead = value.replication.cursor + 1;
      value.replication.head = lastHead;
    }
    return value;
  });
  await bounded(h.login(A));
  assert.equal(batches, 2, 'one preclaim batch and one account-version batch suffice');
  assert.ok(h.south.replication.state.cursor < lastHead, 'login need not reach the moving global head');
  assert.equal(h.south.replication.version(A, 'identity'), h.main.replication.version(A, 'identity'));
});

test('login isolation: own versions require all ordered batches and never overwrite from the login snapshot', async t => {
  const h = await fixture(t);
  for (let i = 0; i < 4; i++) await h.main.replication.transact('record', [B, 'Other-' + i]);
  h.hook(async (row, value) => {
    if (row.op === 'login') {
      value.player.name = 'poisoned snapshot';
      for (let i = 0; i < 3; i++) await h.main.replication.transact('record', [B, 'Later-' + i]);
    }
    if (row.op === 'region.heartbeat' && value.replication?.events.length > 1) {
      value.replication.events = value.replication.events.slice(0, 1);
      value.replication.cursor = value.replication.events[0].revision;
    }
    return value;
  });
  await bounded(h.login(A));
  assert.equal(h.south.players.profiles.get(A).name, 'Login-a');
  assert.equal(h.south.replication.version(A, 'identity'), h.main.replication.version(A, 'identity'));
  assert.ok(h.south.replication.state.cursor < h.main.replication.state.revision, 'later unrelated events are not required for this receipt');
  const cursors = h.requests.filter(row => row.op === 'region.heartbeat').map(row => row.args[0].replication?.cursor).filter(x => x !== undefined);
  assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b));
  assert.ok(cursors.length >= 5);
});

test('login isolation: an unavailable necessary profile version rejects without authorizing', async t => {
  const h = await fixture(t), session = h.session(A);
  h.hook((row, value) => { if (row.op === 'login') value.profileVersions.identity++; return value; });
  await assert.rejects(bounded(h.south.login(session, 'Login-a', A, session.ws, false, A)), /\u7248\u672c\u5c1a\u672a\u540c\u6b65/);
  assert.equal(h.south.validSession(session), false); assert.equal(session.loginLease ?? null, null);
});

for (const [label, mutate] of [
  ['missing', value => { delete value.profileVersions; delete value.grant; }],
  ['negative', value => { value.profileVersions = { identity: -1 }; }],
  ['unknown field', value => { value.profileVersions = { economy: 1 }; }],
  ['wrong account', value => { value.aid = B; }],
]) test('login isolation: ' + label + ' login receipt never authorizes', async t => {
  const h = await fixture(t), session = h.session(A);
  h.hook((row, value) => { if (row.op === 'login') mutate(value); return value; });
  await assert.rejects(bounded(h.south.login(session, 'Login-a', A, session.ws, false, A)));
  assert.equal(h.south.validSession(session), false); assert.equal(session.loginLease ?? null, null);
});

test('login isolation: old-generation login receipt cannot resurrect over the replacement', async t => {
  const h = await fixture(t), session = h.session(A), captured = deferred(), release = deferred(); let held = false;
  h.hook(async (row, value) => { if (!held && row.op === 'login') { held = true; captured.resolve(); await release.promise; } return value; });
  const old = h.south.login(session, 'Login-a', A, session.ws, false, A);
  const rejected = assert.rejects(old, /\u8fde\u63a5\u5df2\u5931\u6548/);
  await captured.promise;
  try {
    await bounded(h.login(A, session)); const current = session.loginLease;
    release.resolve(); await rejected;
    assert.equal(session.loginLease, current); assert.equal(h.south.validSession(session), true);
    assert.equal(session.ws.terminated, 0);
  } finally { release.resolve(); }
});

test('login isolation: a delayed receipt for the replaced socket cannot install a lease', async t => {
  const h = await fixture(t), session = h.session(A), captured = deferred(), release = deferred(); let held = false;
  h.hook(async (row, value) => { if (!held && row.op === 'login') { held = true; captured.resolve(); await release.promise; } return value; });
  const oldSocket = session.ws;
  const stale = h.south.login(session, 'Login-a', A, oldSocket, false, A);
  const rejected = assert.rejects(stale, /\u8fde\u63a5\u5df2\u5931\u6548/);
  await captured.promise;
  session.ws = h.session(A).ws; release.resolve(); await rejected;
  assert.equal(session.loginLease ?? null, null); assert.equal(h.south.validSession(session), false);
  await bounded(h.login(A, session));
  assert.equal(h.south.validSession(session), true); assert.equal(session.ws.terminated, 0);
});

for (const stage of ['claim', 'sync', 'grant']) for (const kind of ['pending', 'releases']) {
  test('login isolation: own ' + kind + ' appearing during ' + stage + ' cannot pass final authorization', async t => {
    const h = await fixture(t, { legacy: stage === 'grant' }), session = h.session(A);
    const add = () => { h.south.replication.state[kind].push(kind === 'pending' ? { aid: A, sequence: 99 } : { aid: A, token: 'unconfirmed' }); };
    if (stage === 'claim') h.hook((row, value) => { if (row.op === 'login') add(); return value; });
    else if (stage === 'sync') {
      const sync = h.south.replication.sync.bind(h.south.replication); let batches = 0;
      h.south.replication.sync = async (...args) => { const result = await sync(...args); if (++batches === 2) add(); return result; };
    } else {
      const accept = h.south.replication.acceptGrant.bind(h.south.replication);
      h.south.replication.acceptGrant = async grant => { await accept(grant); add(); };
    }
    try {
      await assert.rejects(bounded(h.south.login(session, 'Login-a', A, session.ws, false, A)), /\u4ea4\u63a5\u5c1a\u672a\u786e\u8ba4/);
      assert.equal(h.south.validSession(session), false); assert.equal(session.loginLease ?? null, null);
    } finally { h.south.replication.state[kind] = []; }
  });
}

test('login isolation: a legacy receipt uses its matching grant versions without requiring a new watermark', async t => {
  const h = await fixture(t, { legacy: true });
  h.hook((row, value) => { if (row.op === 'login') delete value.profileVersions; return value; });
  await bounded(h.login(A));
  assert.equal(h.south.replication.state.grants[A].token, h.main.replication.state.owners[A].token);
  assert.equal(h.south.replication.version(A, 'identity'), h.main.replication.version(A, 'identity'));
});

test('login isolation: a legacy grant for another account cannot be accepted by this login', async t => {
  const h = await fixture(t, { legacy: true }), session = h.session(A);
  h.hook((row, value) => { if (row.op === 'login') value.grant.aid = B; return value; });
  await assert.rejects(bounded(h.south.login(session, 'Login-a', A, session.ws, false, A)), /\u6388\u6743\u8eab\u4efd\u4e0d\u5339\u914d/);
  assert.equal(h.south.replication.state.grants[B], undefined); assert.equal(h.south.validSession(session), false);
});

function replicationPair() {
  const make = role => {
    const stores = memoryStores();
    return new ProfileReplication({ role, stores, execute(op, [aid, name]) {
      assert.equal(op, 'record'); return stores.players.record(aid, name);
    } });
  };
  return { main: make('main'), secondary: make('secondary') };
}

test('replication isolation: full drain yields serial between batches and concurrent callers keep ordered ACK/cursor', async () => {
  const { main, secondary } = replicationPair();
  await secondary.initialize(request => main.bootstrap(request));
  for (let i = 0; i < 4; i++) await main.transact('record', [A, 'Name-' + i]);
  const seen = [], first = deferred(), release = deferred(); let inflight = 0, peak = 0;
  const exchange = async request => {
    peak = Math.max(peak, ++inflight); seen.push(request.cursor);
    try {
      if (seen.length === 1) { first.resolve(); await release.promise; }
      await turn();
      const value = await main.exchange(request, { current: () => false });
      value.events = value.events.slice(0, 1); value.cursor = value.events.at(-1)?.revision ?? request.cursor;
      return { replication: value };
    } finally { inflight--; }
  };
  const draining = secondary.sync(exchange, true); await first.promise;
  const single = secondary.sync(exchange, false); release.resolve();
  const one = await single;
  assert.equal(one.replication.cursor, 2, 'the already-queued one-batch reader gets the next batch, not the global drain tail');
  await draining;
  assert.equal(peak, 1); assert.equal(secondary.state.cursor, 4);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(secondary.stores.players.profiles.get(A).name, 'Name-3');
  await secondary.sync(exchange); assert.equal(main.state.log.length, 0, 'a durable cursor is ACKed on the next exchange');
});

test('replication isolation: pending mutations are acknowledged in order while full and one-batch calls interleave', async () => {
  const { main, secondary } = replicationPair();
  await secondary.initialize(request => main.bootstrap(request));
  const lease = { aid: B, serverId: 'secondary', owner: 'one', generation: 1 };
  await secondary.acceptGrant(await main.grant(B, lease, { current: () => false }));
  await secondary.transact('record', [B, 'First']); await secondary.transact('record', [B, 'Second']);
  const seq = [], cursors = [];
  const exchange = async request => {
    seq.push(request.pending.map(patch => patch.sequence)); cursors.push(request.cursor); await turn();
    const value = await main.exchange({ ...request, pending: request.pending.slice(0, 1) }, { current: () => false });
    return { replication: value };
  };
  await Promise.all([secondary.sync(exchange), secondary.sync(exchange, false), secondary.sync(exchange, false)]);
  assert.deepEqual(seq.slice(0, 2), [[1, 2], [2]]);
  assert.equal(secondary.state.pending.length, 0); assert.equal(main.state.received, 2);
  assert.equal(main.stores.players.profiles.get(B).name, 'Second'); assert.equal(secondary.stores.players.profiles.get(B).name, 'Second');
  assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b));
});

test('replication isolation: active accounts are refreshed after a yielded batch before releasing a newly accepted grant', async () => {
  const { main, secondary } = replicationPair();
  await secondary.initialize(request => main.bootstrap(request));
  let active = new Set(), batches = 0;
  const granted = deferred();
  const exchange = async request => {
    batches++;
    const value = await main.exchange(request, { current: () => false });
    if (batches === 1) {
      value.head = value.cursor + 1;
      void secondary.run(async () => {
        active = new Set([B]);
        secondary.state.grants[B] = { aid: B, token: 'new-token', versions: {} };
        granted.resolve();
      });
    }
    return { replication: value };
  };
  await secondary.sync(exchange, true, () => active); await granted.promise;
  assert.ok(batches >= 2); assert.deepEqual(secondary.state.releases, []);
  assert.equal(secondary.state.grants[B].token, 'new-token');
});
