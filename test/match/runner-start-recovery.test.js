// Vanilla start recovery: deterministic clocks and deferred loads, no network or production data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeNet() {
  const listeners = new Map();
  const sent = [];
  return {
    sent, status: 'online',
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, value) { for (const fn of listeners.get(type) || []) fn({ t: type, ...value }); },
    send(type, value) { sent.push({ t: type, ...value }); return true; },
    request(type, value) { sent.push({ t: type, ...value }); return Promise.resolve({ t: 'ok' }); },
  };
}

function simulation({ throwBuilds = 0 } = {}) {
  const built = [];
  let attempts = 0;
  const sim = {
    ds: {},
    spec: {
      createBattleFromSpec(spec) {
        attempts++;
        if (attempts <= throwBuilds) throw new Error('transient construction failure');
        const battle = {
          spec, tickCount: 0, time: 0, finished: false, total: 3, killed: 0, leakedCount: 0,
          flags: { layerGainsEnabled: false }, allyUnits: [], events: [], endReason: null,
          step() {
            this.tickCount++; this.time = this.tickCount / 30;
            if (this.tickCount === 1) this.events.push(['spawn', { side: 'enemy', defId: 'test_enemy', id: 1 }]);
            if (this.tickCount >= (spec.endTick || 3000)) { this.finished = true; this.killed = this.total; }
          },
          forceEnd(reason) { this.finished = true; this.endReason = reason; },
          fieldMeta() { return { units: [], stageId: 'test_stage', rect: [0, 0, 8, 8] }; },
          snapshot() { return { t: this.time, units: [], total: this.total, killed: this.killed }; },
          drainEvents() { return this.events.splice(0); },
          result() { return { reason: this.endReason || 'cleared', time: this.time, perPlayer: {
            p: { killed: this.killed, total: this.total, leaked: [], perfect: true, layerGains: {}, unitsEnd: [] },
          } }; },
        };
        built.push(battle);
        return battle;
      },
      attachLpMeter() { return { lp: 0 }; },
      battleProgress(battle) { return { gt: battle.time, killed: battle.killed, total: battle.total, leaks: 0, done: battle.finished }; },
      compactResult(result) { return result; },
    },
  };
  return { sim, built, get attempts() { return attempts; } };
}

function start(id = 'battle-1', fields = {}) {
  return {
    t: 'b.start', battleId: id, fieldId: `n:${id}`, kind: 'normal',
    authoritative: true, watch: false, elapsed: 0, speed: 2,
    spec: { battleId: id, fieldId: `n:${id}`, kind: 'normal', round: 1,
      players: [{ playerId: 'p', units: [], bonds: {} }], ...fields.spec },
    ...fields,
  };
}

function rig(t, { loadSim, simOptions, phase = 'COMBAT' } = {}) {
  let now = 1000, nextId = 0, loads = 0;
  const timers = new Map(), frames = new Map();
  const fake = simulation(simOptions);
  const net = fakeNet();
  const store = createStore({ ...initialState, match: { ...initialState.match, public: { phase, round: 1 } } });
  const addTimer = (fn, delay, interval = 0) => {
    const id = ++nextId; timers.set(id, { fn, at: now + delay, interval }); return id;
  };
  t.mock.method(console, 'warn', () => {});
  const runner = createBattleRunner({
    net, store, doc: { hidden: false, addEventListener() {} }, now: () => now,
    raf: (fn) => { const id = ++nextId; frames.set(id, fn); return id; },
    caf: (id) => frames.delete(id),
    setTimeout: (fn, ms) => addTimer(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => addTimer(fn, ms, ms), clearInterval: (id) => timers.delete(id),
    loadSim: () => { loads++; return loadSim ? loadSim(loads, fake.sim) : Promise.resolve(fake.sim); },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  t.after(() => runner.dispose());
  const feed = { fields: [], snaps: [], events: [] };
  runner.on('field', (frame) => feed.fields.push(frame));
  runner.on('snap', (frame) => feed.snaps.push(frame));
  runner.on('ev', (frame) => feed.events.push(...frame.ev));
  async function settle() {
    for (let i = 0; i < 24; i++) {
      await Promise.resolve();
      const pending = [...frames.values()]; frames.clear();
      for (const fn of pending) fn(now);
    }
  }
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      let earliest = null;
      for (const item of timers) if (item[1].at <= end && (!earliest || item[1].at < earliest[1].at)) earliest = item;
      if (!earliest) break;
      const [id, timer] = earliest; now = timer.at;
      if (timer.interval) timer.at += timer.interval; else timers.delete(id);
      timer.fn(); await settle();
    }
    now = end; await settle();
  }
  return { runner, net, store, fake, feed, settle, advance, get loads() { return loads; } };
}

test('a b.start received before the COMBAT public frame survives its own store updates', async (t) => {
  const load = deferred();
  const r = rig(t, { phase: 'PREP', loadSim: () => load.promise });
  r.net.emit('b.start', start('early-start'));
  await r.settle();
  assert.equal(r.runner._pending.size, 1, 'publishing loading state must not cancel the current start');
  load.resolve(r.fake.sim); await r.settle();
  assert.equal(r.fake.built.length, 1);
  assert.equal(r.feed.fields.at(-1)?.round, 1);
  r.store.patch('match', { public: { phase: 'COMBAT', round: 1 } });
  await r.advance(1000);
  assert.ok(r.feed.events.some(event => event[0] === 'spawn' && event[1].side === 'enemy'));
  assert.equal(r.runner.currentBattle()?.battleId, 'early-start');
});

test('same-id server resend restores field metadata without building or reporting twice', async (t) => {
  const r = rig(t);
  const msg = start('resync');
  await r.runner.onStart(msg);
  await r.advance(500);
  const battle = r.runner._entries.get('resync').battle;
  const tick = battle.tickCount;
  const fields = r.feed.fields.length;
  await r.runner.onStart(msg);
  assert.equal(r.fake.built.length, 1);
  assert.equal(r.runner._entries.get('resync').battle, battle);
  assert.equal(battle.tickCount, tick);
  assert.equal(r.feed.fields.length, fields + 1);
  assert.equal(r.net.sent.some(frame => frame.t === 'b.result'), false);
});

test('one failed sim load retries the same start after 1 second without another server frame', async (t) => {
  const r = rig(t, { loadSim: (attempt, sim) => attempt === 1 ? Promise.reject(new Error('temporary HTTP failure')) : Promise.resolve(sim) });
  r.net.emit('b.start', start());
  await r.settle();
  assert.equal(r.loads, 1);
  assert.equal(r.runner._entries.size, 0);
  await r.advance(999);
  assert.equal(r.loads, 1, 'no immediate retry storm');
  await r.advance(1);
  assert.equal(r.loads, 2);
  assert.equal(r.fake.built.length, 1);
  assert.equal(r.runner.state()?.loading, false);
  assert.equal(r.runner.currentBattle()?.battleId, 'battle-1');
  assert.equal(r.feed.snaps.at(-1)?.total, 3);
  await r.advance(1000);
  assert.ok(r.fake.built[0].tickCount >= 90, 'recovered battle catches up the loading delay and keeps spawning/stepping');
  assert.ok(r.net.sent.some((frame) => frame.t === 'b.progress' && frame.total === 3));
});

test('automatic start retry is bounded to three attempts with 1s and 2s backoffs', async (t) => {
  const r = rig(t, { loadSim: () => Promise.reject(new Error('still unavailable')) });
  r.net.emit('b.start', start()); await r.settle();
  assert.equal(r.loads, 1);
  await r.advance(1000); assert.equal(r.loads, 2);
  await r.advance(1999); assert.equal(r.loads, 2);
  await r.advance(1); assert.equal(r.loads, 3);
  await r.advance(10000); assert.equal(r.loads, 3, 'a failed round cannot poll forever');
  assert.equal(r.runner._entries.size, 0);
});

test('a battle construction failure does not loop and recovers on an explicit same-id resend', async (t) => {
  const r = rig(t, { simOptions: { throwBuilds: 1 } });
  r.net.emit('b.start', start()); await r.settle();
  assert.equal(r.fake.attempts, 1);
  assert.equal(r.fake.built.length, 0);
  await r.advance(10000);
  assert.equal(r.fake.attempts, 1, 'deterministic construction failures do not retry automatically');
  r.net.emit('b.start', start()); await r.settle();
  assert.equal(r.fake.attempts, 2);
  assert.equal(r.runner.currentBattle()?.battleId, 'battle-1');
});

test('pending same-id resend builds once and adopts the latest elapsed, authority and watch flags', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('same', { authoritative: false, watch: true, elapsed: 0 }));
  r.net.emit('b.start', start('same', { authoritative: true, watch: false, elapsed: 4 }));
  await r.settle();
  assert.equal(r.loads, 1);
  load.resolve(r.fake.sim); await r.settle();
  const entry = r.runner._entries.get('same');
  assert.ok(entry);
  assert.equal(r.fake.built.length, 1);
  assert.equal(entry.authoritative, true);
  assert.equal(entry.watch, false);
  assert.equal(entry.own, true);
  assert.ok(entry.battle.time >= 3.7, `latest elapsed was used: ${entry.battle.time}`);
  assert.equal(r.feed.fields.length, 1);
});

test('takeover received during sim load demotes the eventual battle and suppresses reports', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('takeover'));
  r.net.emit('b.end', { battleId: 'takeover', fieldId: 'n:takeover', reason: 'takeover' });
  load.resolve(r.fake.sim); await r.settle();
  assert.equal(r.runner._entries.get('takeover')?.authoritative, false);
  await r.advance(2000);
  assert.equal(r.net.sent.some((frame) => frame.t === 'b.progress' || frame.t === 'b.result' || frame.t === 'b.yield'), false);
});

test('the first forced end received during sim load is applied without simulating a stale wave', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('ended', { elapsed: 20 }));
  r.net.emit('b.end', { battleId: 'ended', fieldId: 'n:ended', reason: 'timeout' });
  r.net.emit('b.end', { battleId: 'ended', fieldId: 'n:ended', reason: 'forced' });
  load.resolve(r.fake.sim); await r.settle();
  const entry = r.runner._entries.get('ended');
  assert.ok(entry?.done);
  assert.equal(entry.battle.endReason, 'timeout');
  assert.equal(entry.battle.tickCount, 0, 'an already ended battle does not silently catch up');
  assert.equal(r.net.sent.filter((frame) => frame.t === 'b.result').length, 1);
});

for (const cancel of ['clear', 'PREP']) {
  test(`${cancel} cancels a pending start and its retry without resurrecting an old round`, async (t) => {
    const load = deferred();
    const r = rig(t, { loadSim: () => load.promise });
    r.net.emit('b.start', start('cancelled')); await r.settle();
    if (cancel === 'clear') r.runner.clear();
    else r.store.patch('match', { public: { phase: 'PREP', round: 2 } });
    load.resolve(r.fake.sim); await r.settle(); await r.advance(10000);
    assert.equal(r.fake.built.length, 0);
    assert.equal(r.runner._entries.size, 0);
    assert.equal(r.runner.currentBattle(), null);
    assert.equal(r.feed.fields.length, 0);
    assert.equal(r.net.sent.length, 0);

    const r2 = rig(t, { loadSim: () => Promise.reject(new Error('load failed before clear')) });
    r2.net.emit('b.start', start('retry-cancelled')); await r2.settle();
    if (cancel === 'clear') r2.runner.clear();
    else r2.store.patch('match', { public: { phase: 'PREP', round: 2 } });
    await r2.settle();
    const afterCancel = r2.loads; // PREP can legitimately warm the simulation once.
    await r2.advance(10000);
    assert.equal(r2.loads, afterCancel, 'cancel removes scheduled 1s/2s retries');
    if (cancel === 'clear') assert.equal(afterCancel, 1);
    assert.equal(r2.runner.currentBattle(), null);
  });
}

test('a newer field supersedes a pending replica, but preserves a pending authority until it reports', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('old-replica', { authoritative: false, watch: true }));
  r.net.emit('b.start', start('new-view', { authoritative: false, watch: true }));
  load.resolve(r.fake.sim); await r.settle();
  assert.equal(r.runner._entries.has('old-replica'), false);
  assert.equal(r.runner.currentBattle()?.battleId, 'new-view');
  assert.equal(r.fake.built.length, 1);

  const authorityLoad = deferred();
  const r2 = rig(t, { loadSim: () => authorityLoad.promise });
  r2.net.emit('b.start', start('old-authority', { spec: { battleId: 'old-authority', fieldId: 'n:old-authority', kind: 'normal', round: 1, endTick: 30, players: [{ playerId: 'p', units: [], bonds: {} }] } }));
  r2.net.emit('b.start', start('watch-view', { authoritative: false, watch: true }));
  authorityLoad.resolve(r2.fake.sim); await r2.settle();
  assert.equal(r2.runner.currentBattle()?.battleId, 'watch-view');
  assert.equal(r2.runner._entries.get('old-authority')?.authoritative, true);
  assert.equal(r2.fake.built.length, 2);
  await r2.advance(2000);
  assert.equal(r2.runner._entries.get('old-authority')?.done, true);
  assert.equal(r2.net.sent.filter((frame) => frame.t === 'b.result' && frame.battleId === 'old-authority').length, 1);
  assert.equal(r2.runner.currentBattle()?.battleId, 'watch-view');
});

test('online restarts an exhausted missing start without duplicating a waiting or existing battle', async (t) => {
  const r = rig(t, { loadSim: (attempt, sim) => attempt <= 3 ? Promise.reject(new Error('offline data request')) : Promise.resolve(sim) });
  r.net.emit('b.start', start('online')); await r.settle();
  assert.equal(r.loads, 1);
  r.net.emit('status', { status: 'online' }); await r.settle();
  assert.equal(r.loads, 1, 'online does not create a parallel retry while backoff is waiting');
  await r.advance(3000);
  assert.equal(r.loads, 3);
  assert.equal(r.fake.built.length, 0);
  r.net.emit('status', { status: 'online' }); await r.settle();
  assert.equal(r.loads, 4, 'online restarts the missing start after bounded retries are exhausted');
  assert.equal(r.fake.built.length, 1);
  for (let i = 0; i < 5; i++) r.net.emit('status', { status: 'online' });
  await r.advance(5000);
  assert.equal(r.loads, 4);
  assert.equal(r.fake.built.length, 1, 'neither status nor the cancelled retry duplicates a running battle');

  const load = deferred();
  const pending = rig(t, { loadSim: () => load.promise });
  pending.net.emit('b.start', start('still-loading'));
  for (let i = 0; i < 5; i++) pending.net.emit('status', { status: 'online' });
  await pending.settle();
  assert.equal(pending.loads, 1, 'online cannot start a parallel load');
  load.resolve(pending.fake.sim); await pending.settle();
  assert.equal(pending.fake.built.length, 1);
});


test('delayed load catches up from the received server clock instead of restarting at zero', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('slow-load', { elapsed: 3 }));
  await r.advance(2000);
  load.resolve(r.fake.sim); await r.settle();
  assert.ok(r.fake.built[0].time >= 6.9, '3 elapsed + 2 wall seconds at 2x');
  assert.equal(r.feed.snaps.at(-1)?.total, 3);
});

test('solo pause during pending data loading is excluded from the catch-up clock', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('paused-load'));
  await r.advance(1000);
  r.store.patch('match', { public: { phase: 'COMBAT', round: 1, paused: true } });
  await r.advance(5000);
  r.store.patch('match', { public: { phase: 'COMBAT', round: 1, paused: false } });
  await r.advance(1000);
  load.resolve(r.fake.sim); await r.settle();
  assert.ok(r.fake.built[0].time >= 3.9 && r.fake.built[0].time <= 4.1, '2 active wall seconds at 2x; no paused time');
});


test('takeover during loading survives retry exhaustion without recovering authority', async (t) => {
  const r = rig(t, { loadSim: (n, sim) => n <= 3 ? Promise.reject(new Error('temporary data outage')) : Promise.resolve(sim) });
  r.net.emit('b.start', start('takeover-exhausted')); await r.settle();
  r.net.emit('b.end', { battleId: 'takeover-exhausted', reason: 'takeover' });
  await r.advance(3000); assert.equal(r.loads, 3);
  r.net.emit('status', { status: 'online' }); await r.settle();
  assert.equal(r.loads, 4); assert.equal(r.fake.built.length, 1);
  assert.equal(r.runner._entries.get('takeover-exhausted')?.authoritative, false);
  await r.advance(60000);
  assert.equal(r.net.sent.some(f => ['b.progress', 'b.result', 'b.yield'].includes(f.t)), false);
});

for (const reason of ['timeout', 'forced']) {
  test(`terminal ${reason} during loading cannot restart after retry exhaustion`, async (t) => {
    const r = rig(t, { loadSim: (n, sim) => n <= 3 ? Promise.reject(new Error('temporary data outage')) : Promise.resolve(sim) });
    r.net.emit('b.start', start('ended-exhausted')); await r.settle();
    r.net.emit('b.end', { battleId: 'ended-exhausted', reason });
    await r.advance(3000); assert.equal(r.loads, 3);
    r.net.emit('status', { status: 'online' }); await r.settle();
    assert.equal(r.loads, 3); assert.equal(r.fake.built.length, 0);
    assert.equal(r.net.sent.length, 0);
  });
}

for (const reason of ['takeover', 'timeout', 'forced']) {
  test(`${reason} after retry exhaustion cancels online start recovery`, async (t) => {
    const r = rig(t, { loadSim: (n, sim) => n <= 3 ? Promise.reject(new Error('temporary data outage')) : Promise.resolve(sim) });
    r.net.emit('b.start', start('late-end')); await r.settle();
    await r.advance(3000); assert.equal(r.loads, 3);
    r.net.emit('b.end', { battleId: 'late-end', reason });
    r.net.emit('status', { status: 'online' }); await r.settle();
    assert.equal(r.loads, 3); assert.equal(r.fake.built.length, 0); assert.equal(r.net.sent.length, 0);
  });
}
