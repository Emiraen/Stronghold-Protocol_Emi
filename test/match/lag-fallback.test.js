import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSimulationQueue, localSimulationQueue, queueLocalSimulation } from '../../server/match/localSimulationQueue.js';
import { HeadlessJob, specBounds, validateClientResult } from '../../server/match/fields.js';
import { MatchClientCombat } from '../../server/match/match/clientCombat.js';
import { MatchInfra } from '../../server/match/match/infra.js';
import { MatchReports } from '../../server/match/match/reports.js';
import { GameData } from '../../server/match/gamedata.js';
import { compactResult } from '../../server/sim/spec.js';
import { makeBattle } from '../helpers/battleHarness.js';
import { DATA, makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';

class Clock {
  constructor() { this.time = 0; this.next = 0; this.pending = new Map(); this.unrefs = 0; }
  now = () => this.time;
  setTimeout = (fn, ms) => {
    const handle = { id: ++this.next, at: this.time + ms, fn, unref: () => { this.unrefs++; } };
    this.pending.set(handle.id, handle);
    return handle;
  };
  clearTimeout = (handle) => this.pending.delete(handle.id);
  runNext() {
    const handle = [...this.pending.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!handle) return false;
    this.pending.delete(handle.id);
    this.time = Math.max(this.time, handle.at);
    handle.fn();
    return true;
  }
}

test('fallback CPU is shared across rooms, round-robin and yields to network timers between turns', () => {
  const clock = new Clock();
  const queue = new LocalSimulationQueue({ now: clock.now, timers: clock });
  const visits = [], left = Array(12).fill(2);
  for (let id = 0; id < left.length; id++) queue.submit((budget) => {
    visits.push(id);
    clock.time += budget;
    return --left[id] === 0;
  });
  let networkAt = null;
  clock.setTimeout(() => { networkAt = clock.time; }, 4);
  clock.runNext();
  assert.deepEqual(visits, [0, 1, 2, 3], 'twelve rooms share one 8 ms turn');
  assert.equal(clock.time, 8);
  clock.runNext();
  assert.equal(networkAt, 8, 'a due network callback runs before the next simulation turn');
  while (clock.runNext()) {}
  assert.deepEqual(visits, [...Array(12).keys(), ...Array(12).keys()], 'no room jumps ahead of an unserved room');
  assert.ok(left.every((n) => n === 0), 'all battle / verification jobs eventually complete');
  assert.equal(queue.timer, null);
  assert.equal(clock.pending.size, 0);
  assert.ok(clock.unrefs > 0, 'background CPU work cannot keep shutdown alive');
});

test('fallback cancellation clears the only timer; invalid and throwing jobs do not stall other rooms', () => {
  const clock = new Clock();
  const queue = new LocalSimulationQueue({ now: clock.now, timers: clock });
  let ran = 0;
  const first = queue.submit(() => { ran++; return false; });
  first.cancel();
  assert.equal(clock.pending.size, 0);
  assert.equal(queue.queue.length, 0);
  const errors = [];
  queue.submit(() => { throw new Error('stale job ran'); }, { valid: () => false });
  queue.submit(() => { throw new Error('injected step failure'); }, { onError: (e) => errors.push(e.message) });
  queue.submit(() => { ran++; return true; });
  while (clock.runNext()) {}
  assert.deepEqual(errors, ['injected step failure']);
  assert.equal(ran, 1);
  assert.equal(queue.timer, null);
});

test('HeadlessJob yields after an expensive individual tick and retains its final result and timeline', () => {
  const clock = new Clock();
  const battle = () => ({
    time: 0, total: 1, killed: 0, finished: false,
    step() { clock.time += 3; this.time += 1 / 30; if (this.time >= 1) { this.finished = true; this.killed = 1; } },
    result() { return { time: this.time, killed: this.killed, total: 1, perPlayer: {} }; },
  });
  const sliced = new HeadlessJob(battle()), whole = new HeadlessJob(battle());
  assert.equal(sliced.run(2, clock.now), false);
  assert.equal(sliced.n, 1, 'one 3 ms tick is not multiplied into a 16-tick stall');
  while (!sliced.run(2, clock.now)) {}
  whole.run();
  assert.deepEqual(sliced.output().result, whole.output().result);
  assert.deepEqual(sliced.output().timeline, whole.output().timeline);
});

test('guarded callback exceptions reach onError and do not leave a live cancellation handle', async () => {
  let resolve;
  const finished = new Promise((yes) => { resolve = yes; });
  const swallowed = [], received = [];
  let flushes = 0;
  const m = { _workerTasks: new Set(), sched: { suspended: false },
    guard(fn) { try { fn(); } catch (e) { swallowed.push(e); } flushes++; },
  };
  const timeout = setTimeout(resolve, 2000);
  try {
    queueLocalSimulation(m, () => { throw new Error('injected callback exception'); }, {
      onError: (e) => { received.push(e.message); resolve(); },
    });
    await finished;
    assert.deepEqual(received, ['injected callback exception']);
    assert.deepEqual(swallowed, [], 'the settlement error handler owns callback failures');
    assert.equal(m._workerTasks.size, 0);
    assert.equal(localSimulationQueue.timer, null);
    assert.equal(flushes, 2, 'both the slice and its error recovery flush their state');
  } finally {
    clearTimeout(timeout);
    for (const task of m._workerTasks) task.cancel();
  }
});

test('an unexpected fallback callback exception releases the field with an unpunished synthetic result', async () => {
  let resolve;
  const finished = new Promise((yes) => { resolve = yes; });
  const field = { cc: true, fieldId: 'n:p', battleId: 'throw1', kind: 'normal', mode: 'server', players: ['p'], spec: {}, progress: { total: 1 } };
  const errors = [];
  const m = { fields: [field], _workerTasks: new Set(), sched: { virtual: false, suspended: false },
    headlessSliceMs: 1, guard(fn) { try { fn(); } catch (e) { errors.push(e.message); } },
    reportError(_label, e) { errors.push(e.message); }, cancel: clearTimeout, _armProgressTicker() {},
    _specBattle: () => ({ time: 0, total: 1, killed: 0 }),
    _armRelease(f) { f.done = true; resolve(); },
  };
  m._clearFieldTimers = MatchClientCombat.prototype._clearFieldTimers;
  const original = HeadlessJob.prototype.run;
  HeadlessJob.prototype.run = () => { throw new Error('injected outside battle.step'); };
  const timeout = setTimeout(resolve, 2000);
  try {
    MatchClientCombat.prototype._runOnServer.call(m, field, 'invalid', { local: true });
    await finished;
    assert.equal(field.done, true, 'the room cannot hang waiting on a vanished queue job');
    assert.equal(field.result.synthetic, true, 'existing settlement rules do not punish failed simulations');
    assert.ok(field.result.perPlayer.p);
    assert.equal(field.job, null);
    assert.equal(m._workerTasks.size, 0);
    assert.deepEqual(errors, ['injected outside battle.step']);
  } finally {
    clearTimeout(timeout);
    HeadlessJob.prototype.run = original;
    for (const task of m._workerTasks) task.cancel();
  }
});

const gd = new GameData(DATA, 'mode_multi_hard');
for (const kind of ['normal', 'unite']) test(`counts: real 磨砻 children are accepted in ${kind}, forged counts/coins/leaks stay rejected`, () => {
  const parentKey = 'enemy_1195_sfyin';
  const h = makeBattle({ kind, autoFinish: false, timeLimit: 30,
    enemies: [{ key: parentKey, pos: [10, 6], ownerPlayerId: 'p1' }] });
  h.step();
  const parent = h.enemy(parentKey);
  assert.ok(parent);
  h.b.kill(parent, null);
  const children = h.b.enemies.filter((e) => e !== parent && e.alive);
  assert.ok(children.length > 0, 'real enemy kit spawned its children');
  for (const child of children) h.b.kill(child, null);
  h.b.forceEnd('cleared');
  const raw = compactResult(h.b.result());
  assert.ok(raw.perPlayer.p1.killed > raw.perPlayer.p1.total, 'the former false-rejection trigger');
  const spec = { kind, round: 1, timeLimit: 30, players: h.b.opts.players, spawns: h.b.opts.spawns, flags: {} };
  const bound = specBounds(spec, gd);
  assert.ok(bound.derived.size > 0);
  const accepted = validateClientResult(spec, raw, { gd });
  assert.ok(accepted.ok, accepted.reason);
  const changed = (patch) => {
    const copy = structuredClone(raw);
    Object.assign(copy.perPlayer.p1, patch);
    return validateClientResult(spec, copy, { gd });
  };
  for (const patch of [{ killed: bound.maxTotal + 1 }, { killed: -1 }, { killed: 1.5 }, { total: -1 }, { total: bound.maxTotal + 1 }]) {
    assert.deepEqual(changed(patch), { ok: false, reason: 'counts' });
  }
  assert.deepEqual(changed({ coins: 1 }), { ok: false, reason: 'coins' });
  assert.equal(changed({ leaked: [{ enemyKey: 'enemy_not_in_spec', counted: true }] }).ok, false);
  const plain = { ...spec, spawns: [{ enemyKey: 'enemy_1422_lrsldr', count: 1 }] };
  assert.equal(specBounds(plain, gd).derived.size, 0);
  assert.deepEqual(validateClientResult(plain, raw, { gd }), { ok: false, reason: 'counts' }, 'plain waves cannot invent children');
});

test('a real-clock battle rejected by the worker pool finishes through shared fallback and can be cancelled', async () => {
  const fields = [];
  const m = { fields, disposed: false, ended: false, sched: { virtual: false, suspended: false, now: Date.now },
    _workerTasks: new Set(), _workerAuditAt: -Infinity, workerStats: { submitted: 0, completed: 0, rejected: 0, failed: 0, cancelled: 0 },
    log: { info() {}, warn() {} }, headlessSliceMs: 1, verifyStats: { takeovers: 0 },
    guard(fn) { fn(); }, sendTo() {}, cancel: clearTimeout, _armProgressTicker() {},
    workerPool: { submit() { return { promise: Promise.reject(Object.assign(new Error('busy'), { code: 'POOL_FULL' })), cancel() {} }; } },
    _specBattle: () => ({ time: 0, total: 1, killed: 0, finished: false,
      step() { this.time++; if (this.time === 80) this.finished = true; },
      result() { return { time: this.time, total: 1, killed: 0, perPlayer: {} }; },
    }),
  };
  for (const name of ['_clearFieldTimers', '_runOnServer']) m[name] = MatchClientCombat.prototype[name];
  m._submitWorker = MatchInfra.prototype._submitWorker;
  const field = { cc: true, fieldId: 'n:p', battleId: 'b1', kind: 'normal', mode: 'client', authority: 'p', players: ['p'], spec: {}, progress: { total: 1 }, done: false };
  fields.push(field);
  let resolve;
  const finished = new Promise((yes) => { resolve = yes; });
  m._armRelease = (f) => { f.done = true; resolve(); };
  const timeout = setTimeout(() => { resolve(); }, 2000);
  try {
    m._runOnServer(field, 'invalid');
    assert.equal(field.job, null, 'worker submission does not run a whole battle inline');
    await finished;
    assert.equal(field.done, true, 'a real battle still obtains its final result');
    assert.equal(field.result.time, 80);
    assert.equal(m.workerStats.rejected, 1);
    assert.equal(m._workerTasks.size, 0);
    const pending = queueLocalSimulation(m, () => false);
    assert.equal(m._workerTasks.size, 1);
    m.disposed = true;
    MatchInfra.prototype._cancelWorkerTasks.call(m);
    assert.equal(m._workerTasks.size, 0);
    assert.equal(localSimulationQueue.timer, null, 'disposing the last room removes its queue timer');
    pending.cancel();
  } finally {
    clearTimeout(timeout);
    for (const task of m._workerTasks) task.cancel();
  }
});

test('required verification finishes through the shared queue after worker rejection', async () => {
  const spec = { kind: 'normal', timeLimit: 30, spawns: [], players: [{ playerId: 'p', units: [] }], flags: {} };
  const simulated = { reason: 'cleared', time: 1, perPlayer: { p: {
    killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0,
    damageDealt: 12, rankedDamage: 0, leaderLpLoss: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [],
  } } };
  const field = { cc: true, spec, battleId: 'verify1', fieldId: 'n:p', kind: 'normal', players: ['p'], mode: 'client', done: false };
  const errors = [];
  const m = { fields: [field], disposed: false, ended: false, paused: false,
    sched: { virtual: false, suspended: false, now: Date.now },
    _workerTasks: new Set(), _workerAuditAt: -Infinity,
    workerStats: { submitted: 0, completed: 0, rejected: 0, failed: 0, cancelled: 0 },
    verifyMode: 'all', verifyStats: { checked: 0, mismatches: 0 }, headlessSliceMs: 1, gd: null,
    log: { warn() {} }, guard(fn) { fn(); }, reportError(_label, error) { errors.push(error); }, cancel: clearTimeout,
    workerPool: { submit() { return { promise: Promise.reject(Object.assign(new Error('busy'), { code: 'POOL_FULL' })), cancel() {} }; } },
    _specBattle: () => ({ time: 0, total: 0, killed: 0, finished: false,
      step() { this.time += 1 / 30; if (this.time >= 1) this.finished = true; }, result: () => simulated,
    }),
  };
  m._submitWorker = MatchInfra.prototype._submitWorker;
  m._clearFieldTimers = MatchClientCombat.prototype._clearFieldTimers;
  const uploaded = compactResult(simulated);
  uploaded.perPlayer.p.damageDealt = 0;
  let accepted = null;
  let resolve;
  const finished = new Promise((yes) => { resolve = yes; });
  const timeout = setTimeout(resolve, 2000);
  try {
    MatchReports.prototype._verifyResult.call(m, field, uploaded, (result) => { accepted = result; resolve(); });
    await finished;
    assert.equal(accepted?.perPlayer.p.damageDealt, 12, 'verification applies the actual server result');
    assert.equal(m.verifyStats.checked, 1);
    assert.equal(m.verifyStats.mismatches, 1);
    assert.equal(m.workerStats.rejected, 1);
    assert.equal(field.verifying, false);
    assert.equal(m._workerTasks.size, 0);
    assert.deepEqual(errors, []);
  } finally {
    clearTimeout(timeout);
    for (const task of m._workerTasks) task.cancel();
  }
});

for (const errorCode of ['REHEARSAL_BUSY', 'POOL_FULL']) test(`bot preview ${errorCode} waits for the worker instead of simulating on the main thread`, () => {
  const h = makeMatch({ mode: 'solo', seats: [{ seat: 0, playerId: 'ai_0', name: 'AI', isBot: true, connected: true }],
    seed: 4, fake: true, botRehearsal: 3 }).start();
  const m = h.m;
  try {
    h.run(() => m.phase === PHASE.PREP && m.round === 3);
    m.workerPool = {};
    let submissions = 0, builtLocal = 0;
    const construct = m.newBattle.bind(m);
    m.newBattle = (opts) => { if (opts.fieldId.startsWith('r:')) builtLocal++; return construct(opts); };
    m._submitWorker = (_type, _payload, callbacks) => {
      submissions++;
      const task = { cancel() {} };
      m.later(0, () => { if (callbacks.valid()) callbacks.failed({ code: errorCode }); });
      return task;
    };
    m.scheduleBotPrep(m.order[0]);
    h.run(() => submissions > 0);
    const firstAt = h.sched.now();
    h.sched.advance(499);
    assert.equal(submissions, 1, 'busy previews back off instead of retrying immediately');
    assert.equal(builtLocal, 0);
    h.run(() => submissions >= 2);
    assert.ok(h.sched.now() >= firstAt + 500);
    assert.equal(builtLocal, 0, 'no rejected preview created fallback battles');
    m.dispose();
    h.sched.advance(2000);
    assert.equal(submissions, 2, 'disposing the room prevents delayed retries');
  } finally { m.dispose(); }
});
