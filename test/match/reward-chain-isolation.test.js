import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { DATA } from './harness.js';
import { createRegistry, makeCtx } from '../../server/match/effectsMeta.js';
import { canSnapshot } from '../../server/match/snapshot.js';
import { grantLayersVerified, REWARD_FAILURE_TEXT } from '../../server/match/rewardRecovery.js';
import { bandMetaHandler } from '../../server/sim/content/bands/meta.js';
import { HANDLERS } from '../../server/sim/content/garrisons/meta.js';
import { forEachMeta } from '../../server/sim/content/support/meta.js';

function fixture() {
  const sent = [];
  const registry = createRegistry({ log: { warn() {}, error() {} } });
  const m = new Match({ roomCode: 'FAULT', mode: 'coop', variant: 'entertainment_multi', difficulty: 'ABYSS',
    data: DATA, seed: 44, scheduler: new VirtualScheduler(), registry,
    seats: [{ seat: 0, playerId: 'p0', name: 'Local', isBot: false, connected: true }],
    log: { info() {}, warn() {}, error() {} }, send(id, msg) { sent.push([id, msg]); return true; },
    broadcast() {}, onEnd() {}, clientCombat: true, verify: 'off' });
  const p = m.order[0];
  p.board.clear(); p.hand.fill(null); p.temp.fill(null); p.layers = {}; p.bandId = 'band_yu';
  for (const id of ['chess_char_2_02_a', 'chess_char_5_21_a']) p.hand[p.hand.findIndex(x => x === null)] = p.newPiece('chess', id);
  p.recompute(); m.round = 8; m.phase = 'ROUND_START';
  const run = () => m.dispatch(p, 'onRoundStart', { round: 8 });
  const ctx = () => makeCtx(m, p, { kind: 'band', key: 'band:band_yu', bandId: 'band_yu' }, 'onRoundStart');
  return { m, p, run, ctx, sent, registry };
}
function using(fn) { const f = fixture(); try { fn(f); } finally { f.m.dispose(); } }
function notices(f) { return f.sent.map(x => x[1]).filter(x => x.diagnostic?.code === 'LAYER_GRANT_FAILED'); }

test('yu: earlier recompute failure cannot suppress later visiShip, and committed layers are not retried', () => using(f => {
  f.p.bondCountBonus.yanShip = 99; f.p.recompute();
  const recompute = f.p.recompute.bind(f.p);
  let calls = 0;
  f.p.recompute = () => { if (++calls === 1) throw Error('first bond recompute'); return recompute(); };
  f.run();
  assert.equal(f.p.layers.yanShip, 12);
  assert.equal(f.p.layers.visiShip, 12);
  assert.equal(f.p.bonds.visiShip.layers, 12);
  assert.ok(f.m.errors.some(e => e.message === 'first bond recompute'));
  assert.equal(notices(f).length, 0);
}));

test('layer retry: pure preflight fault is retried once only after authoritative unchanged check', () => using(f => {
  const gd = f.p.gd; f.p.gd = Object.create(gd);
  let calls = 0;
  f.p.gd.bond = id => { if (++calls === 1) throw Error('transient preflight'); return gd.bond(id); };
  assert.equal(f.ctx().addLayers('visiShip', 36), 36);
  assert.equal(f.p.layers.visiShip, 36);
  assert.equal(notices(f).length, 0);
  assert.ok(f.m.dispatcher.errors >= 1);
}));

test('layer retry: two verified unreceived failures show exact prompt with copyable diagnostic', () => using(f => {
  const gd = f.p.gd; f.p.gd = Object.create(gd);
  let calls = 0; f.p.gd.bond = () => { calls++; throw Error('preflight unavailable'); };
  assert.equal(f.ctx().addLayers('visiShip', 36), 0);
  assert.equal(calls, 2);
  assert.equal(f.p.layers.visiShip ?? 0, 0);
  assert.equal(notices(f).length, 1);
  assert.equal(notices(f)[0].text, REWARD_FAILURE_TEXT);
  assert.equal(notices(f)[0].diagnostic.attempt, 2);
  assert.equal(notices(f)[0].diagnostic.receipt, 'not-received');
  assert.equal(notices(f)[0].diagnostic.before, notices(f)[0].diagnostic.after);
}));

test('layer retry: unknown modifier side effects are never replayed even when target delta is zero', () => using(f => {
  f.m.isCyclops = true;
  let calls = 0; f.p.addLayers = () => { calls++; throw Error('unknown commit state'); };
  assert.equal(f.ctx().addLayers('visiShip', 36), 0);
  assert.equal(calls, 1);
  assert.equal(notices(f)[0].diagnostic.receipt, 'unverified');
}));

test('layer retry: actual partial commit is never replayed or mistaken for a missing reward', () => using(f => {
  let calls = 0; f.p.addLayers = (id, n, { receipt }) => {
    calls++; receipt.stage = 'committed'; f.p.layers[id] = (f.p.layers[id] ?? 0) + 3; throw Error('partial commit');
  };
  assert.equal(f.ctx().addLayers('visiShip', 36), 3);
  assert.equal(calls, 1); assert.equal(f.p.layers.visiShip, 3);
  assert.equal(notices(f).length, 0);
}));

test('layer retry: normal cap/inactive no-op does not trigger retry or error notice', () => using(f => {
  f.p.layers.visiShip = 999; f.p.recompute();
  const add = f.p.addLayers.bind(f.p); let calls = 0;
  f.p.addLayers = (...args) => { calls++; return add(...args); };
  assert.equal(f.ctx().addLayers('visiShip', 36), 0);
  assert.equal(calls, 1); assert.equal(notices(f).length, 0);
}));

test('layer retry: inactive, invalid and fractional normal rules do not cause retry', () => using(f => {
  const add = f.p.addLayers.bind(f.p); let calls = 0;
  f.p.addLayers = (...args) => { calls++; return add(...args); };
  assert.equal(f.ctx().addLayers('yanShip', 36, { requireActive: true }), 0);
  assert.equal(f.ctx().addLayers('missingShip', 36), 0);
  assert.equal(f.ctx().addLayers('visiShip', 0), 0);
  assert.equal(f.ctx().addLayers('visiShip', 0.4), 0);
  assert.equal(calls, 4); assert.equal(notices(f).length, 0);
}));

test('yu: noStack rules and non-target round remain unchanged', () => using(f => {
  f.m.round = 9; f.run(); assert.equal(f.p.layers.visiShip ?? 0, 0);
  f.m.round = 8; f.p.bondCountBonus.suntShip = 99; f.p.recompute();
  assert.equal(f.p.bonds.suntShip.active, true);
  f.run(); assert.equal(f.p.layers.suntShip ?? 0, 0);
  assert.equal(f.p.layers.visiShip, 12);
}));

test('registry: global enumeration failure cannot suppress a healthy band', () => using(f => {
  f.registry.globals = () => { throw Error('global enumeration'); };
  f.run(); assert.equal(f.p.layers.visiShip, 36);
  assert.ok(f.m.dispatcher.errors > 0);
}));

test('error logger failure cannot turn an isolated content error into a chain failure', () => using(f => {
  f.m.log.error = () => { throw Error('logger unavailable'); };
  f.registry.global('broken', { onRoundStart() { throw Error('content failed'); } });
  f.run(); assert.equal(f.p.layers.visiShip, 36); assert.ok(f.m.dispatcher.errors > 0);
}));

test('garrison multi-target layers: failure of first bond does not suppress later bonds or operators', () => {
  const awarded = [], errors = [];
  const ctx = { source: { bb: { count: 3 } }, hand: () => [{ uid: 1, kind: 'chess' }, { uid: 2, kind: 'chess' }],
    pieceBonds: uid => uid === 1 ? ['broken', 'visiShip'] : ['yanShip'], bondActive: () => true,
    addLayers(id) { if (id === 'broken') throw Error('first garrison bond'); awarded.push(id); return 3; },
    reportError(label, error) { errors.push([label, error]); } };
  HANDLERS.SERVER_ADD_BOND_IN_HAND.run(ctx);
  assert.deepEqual(awarded, ['visiShip', 'yanShip']); assert.equal(errors.length, 1);
});

test('garrison per-bond preparation: failed first calculation cannot suppress later bond calculation', () => {
  const awarded = [], errors = []; let boards = 0;
  const ctx = { source: { bb: { multi: 1 }, bbStr: { bond: 'broken,visiShip', add_method: 'same_bond_diff_lv' },
    garrison: {}, piece: null },
    board() { if (++boards === 1) throw Error('first target board read'); return [{ kind: 'chess', uid: 2, tier: 3 }]; },
    pieceBonds: () => ['visiShip'], bondActive: () => true,
    addLayers(id, n) { awarded.push([id, n]); return n; },
    reportError(...args) { errors.push(args); } };
  HANDLERS.SERVER_ADD_BOND_METHOD.run(ctx);
  assert.deepEqual(awarded, [['visiShip', 1]]); assert.equal(errors.length, 1);
});

test('warfarin: bad bond cannot suppress the selected operators other bonds', () => {
  const band = Object.values(DATA.bands).find(x => x.buffs?.some(b => b.key === 'prep_finish_char_bond_add_layer'));
  assert.ok(band); const awarded = [], errors = [];
  const ctx = { board: () => [{ uid: 1, kind: 'chess', tier: 1 }, { uid: 2, kind: 'chess', tier: 2 }],
    rng: { pick: xs => xs[0] }, pieceBonds: uid => uid === 1 ? ['bad', 'visiShip'] : ['yanShip'],
    addLayers(id) { if (id === 'bad') throw Error('bad reward'); awarded.push(id); },
    reportError: (...args) => errors.push(args) };
  bandMetaHandler(band.bandId).onPrepEnd(ctx);
  assert.deepEqual(awarded, ['visiShip', 'yanShip']); assert.equal(errors.length, 1);
});

test('independent helper never silently swallows faults without a reporting context', () => {
  assert.throws(() => forEachMeta({}, 'no reporter', [1], () => { throw Error('visible fault'); }), /visible fault/);
});

test('snapshot refuses partial end-of-prep rewards while keeping pre-effects checkpoint safe', () => using(f => {
  f.m.phase = 'PREP'; assert.equal(canSnapshot(f.m), true);
  f.m._prepEndAttemptedRound = f.m.round; assert.equal(canSnapshot(f.m), false);
}));

test('match reporting: failed logger cannot escape guard or suppress its flush', () => using(f => {
  f.m.log.error = () => { throw Error('logger failed'); };
  let flushed = false; f.m.flush = () => { flushed = true; };
  assert.doesNotThrow(() => f.m.guard(() => { throw Error('player callback failed'); }));
  assert.equal(flushed, true);
  assert.ok(f.m.errors.some(e => e.message === 'player callback failed'));
}));

function targetedFixture(action) {
  const sent = [], errors = [];
  let actual = 18, reads = 0, calls = 0;
  const ps = { playerId: 'target-player', layers: new Proxy({}, {
    get(_target, key) {
      assert.equal(key, 'visiShip', 'must read only the intended bond');
      reads++;
      return actual;
    },
    ownKeys() { throw Error('full layer reads forbidden'); },
  }), addLayers(id, n, opts) {
    assert.equal(id, 'visiShip');
    calls++;
    return action({ call: calls, n, opts, set(value) { actual = value; }, get actual() { return actual; } });
  } };
  const m = { round: 8, dispatcher: { _report(...args) { errors.push(args); } },
    sendTo(id, msg) { sent.push([id, msg]); } };
  return { m, ps, sent, errors, run: () => grantLayersVerified(m, ps, 'visiShip', 36, {},
    { source: 'band:band_yu', hook: 'onRoundStart' }),
  get actual() { return actual; }, get reads() { return reads; }, get calls() { return calls; } };
}

test('targeted receipt: silent first miss reads target once then retries once, ignoring pre-existing stacks', () => {
  const f = targetedFixture(x => { if (x.call === 2) x.set(x.actual + x.n); return 0; });
  assert.equal(f.run(), 36);
  assert.equal(f.calls, 2); assert.equal(f.reads, 3); // baseline + once after each attempt
  assert.equal(f.actual, 54); assert.equal(f.sent.length, 0);
});

test('targeted receipt: actual grant wins over a false zero return, with no second call', () => {
  const f = targetedFixture(x => { x.set(x.actual + x.n); return 0; });
  assert.equal(f.run(), 36); assert.equal(f.calls, 1); assert.equal(f.reads, 2);
  assert.equal(f.sent.length, 0);
});

test('targeted receipt: actual partial grant followed by throw is not reissued or called a missing reward', () => {
  const f = targetedFixture(x => { x.set(x.actual + 3); throw Error('refresh failed after write'); });
  assert.equal(f.run(), 3); assert.equal(f.calls, 1); assert.equal(f.reads, 2);
  assert.equal(f.errors.length, 1); assert.equal(f.sent.length, 0);
});

test('targeted receipt: two silent misses show exact prompt and only target-item diagnostic', () => {
  const f = targetedFixture(() => 0);
  assert.equal(f.run(), 0);
  assert.equal(f.calls, 2); assert.equal(f.reads, 3); assert.equal(f.sent.length, 1);
  const [id, msg] = f.sent[0];
  assert.equal(id, 'target-player'); assert.equal(msg.text, REWARD_FAILURE_TEXT);
  assert.equal(msg.diagnostic.bondId, 'visiShip'); assert.equal(msg.diagnostic.attempt, 2);
  assert.equal(msg.diagnostic.receipt, 'not-received');
});

test('targeted receipt: unreadable actual target never causes blind reissue', () => {
  const f = targetedFixture(x => { x.set(NaN); return 36; });
  assert.equal(f.run(), 0);
  assert.equal(f.calls, 1); assert.equal(f.reads, 2);
  assert.equal(f.sent[0][1].diagnostic.receipt, 'unverified');
});

test('targeted receipt: decreased target cannot be mistaken for a missing grant safe to retry', () => {
  const f = targetedFixture(x => { x.set(x.actual - 1); return 0; });
  assert.equal(f.run(), 0);
  assert.equal(f.calls, 1); assert.equal(f.sent[0][1].diagnostic.receipt, 'unverified');
});

test('targeted receipt: failed retry still reads target once and shows the exact failure prompt', () => {
  const f = targetedFixture(() => { throw Error('no write'); });
  assert.equal(f.run(), 0);
  assert.equal(f.calls, 2); assert.equal(f.reads, 3);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][1].text, REWARD_FAILURE_TEXT);
});

test('targeted receipt: invalid baseline stops before any grant and never reads other items', () => {
  const f = targetedFixture(() => { throw Error('must not call'); });
  Object.defineProperty(f.ps, 'layers', { value: { visiShip: NaN } });
  assert.equal(f.run(), 0);
  assert.equal(f.calls, 0); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][1].diagnostic.attempt, 0);
});

test('targeted receipt: exhausted retry yields immediately and the same handler continues', () => {
  const f = targetedFixture(() => { throw Error('unavailable'); });
  const order = [];
  assert.doesNotThrow(() => { order.push('start'); order.push(f.run()); order.push('next action'); });
  assert.deepEqual(order, ['start', 0, 'next action']);
  assert.equal(f.calls, 2); assert.equal(f.sent.length, 1);
});

test('targeted receipt: unknown Cyclops side effect skips only this action, not the following action', () => {
  const f = targetedFixture(x => { x.opts.receipt.stage = 'preparing'; throw Error('modifier unknown'); });
  f.m.isCyclops = true;
  let continued = false;
  assert.doesNotThrow(() => { assert.equal(f.run(), 0); continued = true; });
  assert.equal(continued, true); assert.equal(f.calls, 1); assert.equal(f.reads, 2);
  assert.equal(f.sent[0][1].diagnostic.receipt, 'unverified');
});

test('targeted receipt: reporting and sending failures cannot prevent the next action', () => {
  const f = targetedFixture(() => { throw Error('grant unavailable'); });
  f.m.dispatcher._report = () => { throw Error('report failed'); };
  f.m.sendTo = () => { throw Error('send failed'); };
  f.m.reportError = () => { throw Error('fallback reporter failed'); };
  let continued = false;
  assert.doesNotThrow(() => { f.run(); continued = true; });
  assert.equal(continued, true); assert.equal(f.calls, 2);
});

test('layer post-commit: failed recompute cannot suppress onLayers or subsequent handler actions', () => using(f => {
  const dispatch = f.m.dispatch.bind(f.m), order = [];
  f.p.recompute = () => { throw Error('refresh failed'); };
  f.m.dispatch = (ps, hook, ev, opts) => { if (hook === 'onLayers') order.push(hook); return dispatch(ps, hook, ev, opts); };
  assert.doesNotThrow(() => {
    assert.equal(f.ctx().addLayers('visiShip', 36), 36);
    order.push('after addLayers');
  });
  assert.deepEqual(order, ['onLayers', 'after addLayers']);
  assert.equal(f.p.layers.visiShip, 36);
}));
