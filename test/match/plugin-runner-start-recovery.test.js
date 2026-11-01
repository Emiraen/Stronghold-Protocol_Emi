// Plugin start recovery: deterministic clocks and deferred loads, no network or production data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/pluginRunner.js';
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
    ds: {}, cs: 'plugin',
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
    spec: { battleId: id, fieldId: `n:${id}`, kind: 'normal', round: 1, cs: 'plugin',
      players: [{ playerId: 'p', units: [], bonds: {} }], ...fields.spec },
    ...fields,
  };
}

function rig(t, { loadSim, simOptions, createHost, heldCs = 'plugin' } = {}) {
  let now = 1000, nextId = 0, loads = 0;
  const timers = new Map(), frames = new Map();
  const fake = simulation(simOptions);
  const net = fakeNet();
  const store = createStore({ ...initialState, room: { ...initialState.room, content: { vanilla: false, cs: 'plugin' } }, match: { ...initialState.match, public: { phase: 'COMBAT', round: 1 } } });
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
    createHost, toast() {}, vanillaCs: () => 'vanilla',
    simContent: () => ({ cs: heldCs }), loadingContent: () => null,
    contentFor: (cs) => Promise.resolve({ cs, data: {} }),
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


test('plugin loader retries once without a new start and preserves loading wall time', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: (n) => n === 1 ? Promise.reject(new Error('temporary data failure')) : load.promise });
  r.net.emit('b.start', start()); await r.settle();
  await r.advance(999); assert.equal(r.loads, 1);
  await r.advance(1); assert.equal(r.loads, 2);
  await r.advance(4000);
  load.resolve(r.fake.sim); await r.settle();
  assert.equal(r.fake.built.length, 1);
  assert.ok(r.runner.currentBattle()?.time >= 9.7, 'five wall seconds at 2x are caught up');
  assert.equal(r.feed.snaps.at(-1)?.total, 3);
  assert.ok(r.net.sent.some(f => f.t === 'b.progress' && f.total === 3));
});

test('plugin retries stop at three attempts and online recovers the original clock after pause', async (t) => {
  const r = rig(t, { loadSim: (n, sim) => n <= 3 ? Promise.reject(new Error('unavailable')) : Promise.resolve(sim) });
  r.net.emit('b.start', start('resume')); await r.settle();
  r.net.emit('status', { status: 'online' }); await r.settle();
  assert.equal(r.loads, 1, 'online does not duplicate a waiting backoff');
  await r.advance(1000); assert.equal(r.loads, 2);
  await r.advance(1999); assert.equal(r.loads, 2);
  await r.advance(1); assert.equal(r.loads, 3);
  await r.advance(10000); assert.equal(r.loads, 3);
  r.store.patch('match', { public: { phase: 'COMBAT', round: 1, paused: true } });
  await r.advance(5000);
  r.store.patch('match', { public: { phase: 'COMBAT', round: 1, paused: false } });
  r.net.emit('status', { status: 'online' }); await r.settle();
  assert.equal(r.loads, 4);
  assert.equal(r.fake.built.length, 1);
  assert.ok(r.runner.currentBattle()?.time >= 25.7 && r.runner.currentBattle()?.time <= 26.1, 'all unpaused loading time survives exhausted retry recovery');
  for (let i = 0; i < 5; i++) r.net.emit('status', { status: 'online' });
  await r.advance(1000); assert.equal(r.loads, 4); assert.equal(r.fake.built.length, 1);
});

test('plugin same-id resend keeps one load, newest flags and a pause-correct pending clock', async (t) => {
  const load = deferred();
  const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('same', { authoritative: false, watch: true }));
  await r.settle(); await r.advance(2000);
  r.net.emit('b.start', start('same', { authoritative: true, watch: false, elapsed: 4 }));
  r.store.patch('match', { public: { phase: 'COMBAT', round: 1, paused: true } });
  await r.advance(5000);
  r.store.patch('match', { public: { phase: 'COMBAT', round: 1, paused: false } });
  await r.advance(1000); load.resolve(r.fake.sim); await r.settle();
  const e = r.runner._entries.get('same');
  assert.equal(r.loads, 1); assert.equal(r.fake.built.length, 1);
  assert.equal(e.authoritative, true); assert.equal(e.watch, false); assert.equal(e.own, true);
  assert.ok(e.battle.time >= 5.7 && e.battle.time <= 6.1, `pending clock was pause-correct: ${e.battle.time}`);
});

for (const cancel of ['clear', 'PREP']) {
  test(`plugin ${cancel} cancels both pending loads and retry timers`, async (t) => {
    const load = deferred(); const r = rig(t, { loadSim: () => load.promise });
    r.net.emit('b.start', start('cancel')); await r.settle();
    if (cancel === 'clear') r.runner.clear(); else r.store.patch('match', { public: { phase: 'PREP', round: 2 } });
    load.resolve(r.fake.sim); await r.settle(); await r.advance(10000);
    assert.equal(r.fake.built.length, 0); assert.equal(r.runner.currentBattle(), null);
    assert.equal(r.feed.fields.length, 0); assert.equal(r.net.sent.length, 0);
    const retry = rig(t, { loadSim: () => Promise.reject(new Error('failed before cancellation')) });
    retry.net.emit('b.start', start('cancel-retry')); await retry.settle();
    if (cancel === 'clear') retry.runner.clear(); else retry.store.patch('match', { public: { phase: 'PREP', round: 2 } });
    await retry.settle(); const count = retry.loads; await retry.advance(10000);
    assert.equal(retry.loads, count);
    retry.net.emit('status', { status: 'online' }); await retry.settle();
    assert.equal(retry.loads, count, 'cancel cannot resurrect an exhausted start');
  });
}

test('plugin pending takeover suppresses reports, and first forced end wins without catchup', async (t) => {
  const load = deferred(); const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('takeover')); r.net.emit('b.end', { battleId: 'takeover', reason: 'takeover' });
  load.resolve(r.fake.sim); await r.settle(); await r.advance(1000);
  assert.equal(r.runner._entries.get('takeover')?.authoritative, false);
  assert.equal(r.net.sent.length, 0);
  const endLoad = deferred(); const ended = rig(t, { loadSim: () => endLoad.promise });
  ended.net.emit('b.start', start('end', { elapsed: 30 }));
  ended.net.emit('b.end', { battleId: 'end', reason: 'timeout' });
  ended.net.emit('b.end', { battleId: 'end', reason: 'forced' });
  endLoad.resolve(ended.fake.sim); await ended.settle();
  assert.equal(ended.fake.built[0]?.endReason, 'timeout'); assert.equal(ended.fake.built[0]?.tickCount, 0);
  assert.equal(ended.net.sent.filter(f => f.t === 'b.result').length, 1);
});

test('plugin superseded authority finishes, but a pending replica is discarded', async (t) => {
  const load = deferred(); const r = rig(t, { loadSim: () => load.promise });
  r.net.emit('b.start', start('replica', { authoritative: false, watch: true }));
  r.net.emit('b.start', start('authority', { spec: { battleId: 'authority', fieldId: 'n:authority', cs: 'plugin', kind: 'normal', round: 1, endTick: 30, players: [{ playerId: 'p' }] } }));
  r.net.emit('b.start', start('view', { authoritative: false, watch: true }));
  load.resolve(r.fake.sim); await r.settle(); await r.advance(2000);
  assert.equal(r.runner._entries.has('replica'), false); assert.equal(r.fake.built.length, 2);
  assert.equal(r.runner.currentBattle()?.battleId, 'view');
  assert.equal(r.net.sent.filter(f => f.t === 'b.result' && f.battleId === 'authority').length, 1);
});

test('plugin content mismatch never becomes authoritative after loading retry', async (t) => {
  const r = rig(t, { heldCs: 'different', loadSim: (n, sim) => n === 1 ? Promise.reject(new Error('temporary')) : Promise.resolve(sim) });
  r.net.emit('b.start', start('mismatch')); await r.settle(); await r.advance(1000);
  assert.equal(r.fake.built.length, 1); assert.equal(r.runner._entries.get('mismatch')?.authoritative, false);
  await r.advance(2000); assert.equal(r.net.sent.length, 0);
});

test('plugin construction failures are not retried automatically', async (t) => {
  const r = rig(t, { simOptions: { throwBuilds: 1 } });
  r.net.emit('b.start', start('build')); await r.settle(); await r.advance(10000);
  assert.equal(r.loads, 1); assert.equal(r.fake.attempts, 1);
  r.net.emit('status', { status: 'online' }); await r.settle(); assert.equal(r.fake.attempts, 1);
  r.net.emit('b.start', start('build')); await r.settle();
  assert.equal(r.fake.attempts, 2); assert.equal(r.fake.built.length, 1);
});

test('plugin worker startup failures use the existing takeover signal without automatic recreation', async (t) => {
  let hosts = 0;
  const r = rig(t, { createHost: () => {
    hosts++; return { remote: true, async load() { throw new Error('worker startup failure'); }, stop() {} };
  } });
  r.net.emit('b.start', start('worker')); await r.settle(); await r.advance(10000);
  for (let i = 0; i < 5; i++) r.net.emit('status', { status: 'online' }); await r.settle();
  assert.equal(hosts, 1); assert.equal(r.loads, 1);
  assert.equal(r.net.sent.filter(f => f.t === 'b.result' && f.battleId === 'worker' && !f.cs).length, 1);
  assert.equal(r.runner.currentBattle(), null);
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
