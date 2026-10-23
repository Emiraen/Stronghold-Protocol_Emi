import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give } from './harness.js';
import { createRegistry } from '../../server/match/effectsMeta.js';

function fixture(t) {
  const registry = createRegistry({ log: { info() {}, warn() {}, error() {} } });
  const h = makeMatch({ mode: 'coop', difficulty: 'ABYSS', humans: 3, registry, fake: true }).start();
  h.toPrep(1);
  t.after(() => h.m.dispose());
  const m = h.m;
  for (const ps of m.order) {
    ps.bandId = 'band_yu';
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.layers = {}; ps.bondCountBonus = {};
    give(m, ps, 'chess_char_2_02_a', 'hand', 0);
    give(m, ps, 'chess_char_5_21_a', 'hand', 1);
  }
  return { h, m, p: m.order, registry };
}
const fail = () => { throw new Error('injected independent operation failure'); };
function expectError(m, label) { assert.ok(m.errors.some(e => e.label.includes(label)), label); }

test('chain isolation: another player round-start failure does not suppress healthy players Yu or repay partial income', t => {
  const { m, p } = fixture(t);
  let attempts = 0;
  p[1].startRound = () => { attempts++; p[1].funds += 7; fail(); };
  const before = p[1].funds;
  m.startRound(8);
  assert.equal(p[0].layers.visiShip, 36); assert.equal(p[2].layers.visiShip, 36);
  assert.equal(p[1].layers.visiShip || 0, 0);
  assert.equal(p[1].funds, before + 7); assert.equal(attempts, 1);
  assert.ok(m._phaseTimer); expectError(m, 'startRound R8 player p_1');
});

test('chain isolation: final round-start recompute failure does not stop the next player or deadline', t => {
  const { m, p } = fixture(t);
  let calls = 0;
  const original = p[0].recompute.bind(p[0]);
  p[0].recompute = () => { if (++calls === 3) fail(); return original(); };
  m.startRound(8);
  assert.equal(p[2].layers.visiShip, 36); assert.ok(m._phaseTimer);
  expectError(m, 'roundStart recompute R8 player p_0');
});

test('chain isolation: structural round hook failure cannot suppress another player Yu hook', t => {
  const { m, p } = fixture(t); const dispatch = m.dispatch.bind(m);
  m.dispatch = (ps, hook, ...args) => { if (ps === p[0] && hook === 'onRoundStart') fail(); return dispatch(ps, hook, ...args); };
  m.startRound(8);
  assert.equal(p[0].layers.visiShip || 0, 0); assert.equal(p[1].layers.visiShip, 36); assert.equal(p[2].layers.visiShip, 36);
  assert.ok(m._phaseTimer); expectError(m, 'onRoundStart R8 player p_0');
});

test('chain isolation: item merge failure skips only that prep-start chain and bot scheduling', t => {
  const { m, p, registry } = fixture(t);
  const hooks = [], bots = [];
  registry.global('prep_spy', { onPrepStart(ctx) { hooks.push(ctx.playerId); } });
  p[0].checkItemMerges = fail;
  for (const ps of p) ps.autoplay = true;
  m.scheduleBotPrep = ps => bots.push(ps.playerId);
  m.enterPrep();
  assert.deepEqual(hooks, ['p_1', 'p_2']); assert.deepEqual(bots, ['p_1', 'p_2']);
  assert.ok(m._phaseTimer); expectError(m, 'enterPrep R1 player p_0');
});

test('chain isolation: one bot scheduling failure does not skip following bots', t => {
  const { m, p } = fixture(t);
  const bots = []; for (const ps of p) ps.autoplay = true;
  m.scheduleBotPrep = ps => { bots.push(ps.playerId); if (ps === p[0]) fail(); };
  m.enterPrep();
  assert.deepEqual(bots, ['p_0', 'p_1', 'p_2']); expectError(m, 'scheduleBotPrep R1 player p_0');
});

test('chain isolation: prep deadline resolves healthy players but does not field an unresolved player', t => {
  const { m, p } = fixture(t);
  const resolved = []; let ended = 0;
  for (const ps of p) { ps.ready = false; ps.resolveTemp = () => { resolved.push(ps.playerId); if (ps === p[0]) fail(); }; }
  m.endPrep = () => ended++; m.prepDeadline();
  assert.deepEqual(resolved, ['p_0', 'p_1', 'p_2']); assert.equal(ended, 0);
  assert.equal(p[0].ready, false); assert.equal(p[1].ready, true); assert.equal(p[2].ready, true);
  expectError(m, 'prepDeadline R1 player p_0');
});

test('chain isolation: failed endPrep is not replayed and healthy player cleanup still completes', t => {
  const { m, p, registry } = fixture(t);
  let paid = 0, combat = 0; const ended = [];
  registry.global('prep_reward_spy', { onPrepEnd() { paid++; } });
  for (const ps of p) ps.endPrep = () => { ended.push(ps.playerId); if (ps === p[0]) fail(); };
  m.startCombat = () => combat++; m.endPrep(); m.endPrep();
  assert.deepEqual(ended, ['p_0', 'p_1', 'p_2']); assert.equal(paid, 3); assert.equal(combat, 0);
  expectError(m, 'endPrep R1 player p_0');
});

test('chain isolation: bot cancellation failure cannot suppress onPrepEnd or combat', t => {
  const { m, p } = fixture(t); let combat = 0;
  p[0]._botWorker = { cancel: fail }; m.startCombat = () => combat++;
  m.endPrep();
  assert.equal(p[0]._botWorker, null); assert.equal(combat, 1);
  expectError(m, 'cancelBotPrep R1 player p_0');
});

test('chain isolation: structural prep-end dispatch failure skips its dependent cleanup but not healthy players', t => {
  const { m, p } = fixture(t); const hooks = [], ended = []; let combat = 0;
  m.dispatch = (ps, hook) => { if (hook === 'onPrepEnd') { hooks.push(ps.playerId); if (ps === p[0]) fail(); } };
  for (const ps of p) ps.endPrep = () => ended.push(ps.playerId);
  m.startCombat = () => combat++; m.endPrep(); m.endPrep();
  assert.deepEqual(hooks, ['p_0', 'p_1', 'p_2']); assert.deepEqual(ended, ['p_1', 'p_2']);
  assert.equal(combat, 0); expectError(m, 'onPrepEnd R1 player p_0');
});

test('chain isolation: prep checkpoint remains before once marker and any prep-end grant', t => {
  const { m, registry } = fixture(t); const order = [];
  m.opts.onCheckpoint = () => { assert.notEqual(m._prepEndAttemptedRound, m.round); order.push('checkpoint'); };
  registry.global('checkpoint_spy', { onPrepEnd() { assert.equal(m._prepEndAttemptedRound, m.round); order.push('grant'); } });
  m.startCombat = () => {}; m.endPrep();
  assert.deepEqual(order, ['checkpoint', 'grant', 'grant', 'grant']);
});

function settleFixture(t) {
  const f = fixture(t);
  for (const ps of f.p) f.m.lastResults.set(ps.playerId, { leaked: [], perfect: true, coins: 3, layerGains: { visiShip: 4 }, killed: 2, damageDealt: 8, rankedDamage: 5 });
  return f;
}

test('chain isolation: a failed player settlement cannot suppress later rewards or be replayed', t => {
  const { m, p } = settleFixture(t);
  p[0].bounties = [null]; const before = p[2].pendingFunds;
  m.settle(null, null);
  assert.equal(p[2].pendingFunds, before + 3); assert.equal(p[2].layers.visiShip, 4);
  assert.ok(m._phaseTimer); expectError(m, 'settle R1 player p_0');
  m.settle(null, null); assert.equal(p[2].pendingFunds, before + 3); assert.equal(p[2].layers.visiShip, 4);
});

test('chain isolation: malformed ranked stats do not suppress following player stats or settlement', t => {
  const { m, p } = settleFixture(t); p[0].stats = null;
  m.settle(null, null);
  assert.equal(p[2].stats.rankedDamage, 5); assert.equal(p[2].layers.visiShip, 4);
  expectError(m, 'settle rankedDamage R1 player p_0');
});

test('chain isolation: settlement dirty notification failure cannot suppress rewards', t => {
  const { m, p } = settleFixture(t);
  p[0].pendingLayerGains = { visiShip: 4 }; p[0].dirty = fail;
  m.settle(null, null);
  assert.equal(p[0].pendingLayerGains, null); assert.equal(p[2].layers.visiShip, 4);
  expectError(m, 'settle dirty R1 player p_0');
});

test('chain isolation: cosmetic settlement ticker cannot suppress same-player battle-result hook', t => {
  const { m, p, registry } = settleFixture(t); const results = [];
  registry.global('result_spy', { onBattleResult(ctx) { results.push(ctx.playerId); } });
  m._charDamageTickers = fail; m.settle(null, null);
  assert.deepEqual(results, ['p_0', 'p_1', 'p_2']); assert.equal(p[2].layers.visiShip, 4);
  expectError(m, 'settle ticker R1 player p_0');
});

test('chain isolation: one elimination failure cannot suppress other eliminations or launch invalid next round', t => {
  const { m, p } = settleFixture(t); const eliminated = [];
  let deadlines = 0; m.setDeadline = () => deadlines++;
  for (const ps of p) { ps.lp = 0; ps.eliminate = () => { eliminated.push(ps.playerId); if (ps === p[0]) fail(); ps.alive = false; }; }
  m.settle(null, null);
  assert.deepEqual(eliminated, ['p_0', 'p_1', 'p_2']); assert.equal(deadlines, 0);
  expectError(m, 'settle eliminate R1 player p_0');
});

test('chain isolation: cosmetic elimination notice failure does not block a valid next round', t => {
  const { m, p } = settleFixture(t); let deadlines = 0;
  p[0].lp = 0; m.toast = fail; m.setDeadline = () => deadlines++;
  m.settle(null, null);
  assert.equal(p[0].alive, false); assert.equal(deadlines, 1); expectError(m, 'settle eliminate notice R1 player p_0');
});

test('chain isolation: private serialization failure keeps only affected dirty entry and sends later players', t => {
  const { m, p } = fixture(t); const sent = [];
  m._pubDirty = false; m._lastFlowScope = `${m.phase}:${m.round}:${!!m.paused}:${m.deadline}`;
  m._privDirty = new Set(p);
  p[0].privateView = () => { const v = {}; v.self = v; return v; };
  m.sendFn = (pid, msg) => { if (msg.t === 'm.private') sent.push(pid); return true; };
  m.flush();
  assert.deepEqual(sent, ['p_1', 'p_2']); assert.ok(m._privDirty.has(p[0])); assert.equal(m._privDirty.size, 1);
  expectError(m, 'flush private player p_0');
});

test('chain isolation: private view throw retains dirty entry rather than losing it', t => {
  const { m, p } = fixture(t); p[0].privateView = fail;
  m._privDirty.clear(); m._sendPrivate(p[0], false, false);
  assert.ok(m._privDirty.has(p[0])); expectError(m, 'privateView');
});

test('chain isolation: scout and observer flush failures cannot drop later players', t => {
  const { m, p } = fixture(t); const scouts = [], observers = [];
  m._privDirty = new Set(p);
  m._notifyPrepScouts = ps => { scouts.push(ps.playerId); if (ps === p[0]) fail(); };
  m.observers.set('bad', { target: 'p_0' }); m.observers.set('good', { target: 'p_0' });
  m.refreshObserver = pid => { observers.push(pid); if (pid === 'bad') fail(); };
  m._maybeSendPublic = () => {}; m.flush();
  assert.deepEqual(scouts, ['p_0', 'p_1', 'p_2']); assert.deepEqual(observers, ['bad', 'good']);
  assert.ok(m._privDirty.has(p[0])); expectError(m, 'flush scouts player p_0'); expectError(m, 'flush observer bad');
});

test('chain isolation: broadcast observer/scout failures cannot skip healthy recipients', t => {
  const { m } = fixture(t); const observers = [], scouts = [];
  m.observers.set('bad', {}); m.observers.set('good', {});
  m.refreshObserver = pid => { observers.push(pid); if (pid === 'bad') fail(); };
  m.watchers.set('scout_bad', 'n:p_0'); m.watchers.set('scout_good', 'n:p_1');
  m._sendObserverBench = pid => { scouts.push(pid); if (pid === 'scout_bad') fail(); };
  m.broadcast({ t: 'm.public' });
  assert.deepEqual(observers, ['bad', 'good']); assert.deepEqual(scouts, ['scout_bad', 'scout_good']);
  expectError(m, 'broadcast observer bad'); expectError(m, 'broadcast scout scout_bad');
});

test('messaging recovery: online failed private send does not commit cache and is retried with identical content', t => {
  const { m, p } = fixture(t); const ps = p[0];
  const view = ps.privateView(); let attempts = 0;
  ps.privateView = () => view; ps._lastPriv = 'previous';
  m._privDirty.clear(); m._pubDirty = false;
  m._lastFlowScope = `${m.phase}:${m.round}:${!!m.paused}:${m.deadline}`;
  m.sendFn = () => ++attempts > 1;
  m._sendPrivate(ps, false, false);
  assert.equal(ps._lastPriv, 'previous'); assert.ok(m._privDirty.has(ps)); assert.equal(attempts, 1);
  m.flush();
  assert.equal(ps._lastPriv, JSON.stringify(view)); assert.equal(m._privDirty.has(ps), false); assert.equal(attempts, 2);
  m._sendPrivate(ps, false, false); assert.equal(attempts, 2);
});

test('messaging recovery: private send that disconnects the player does not keep an offline retry pending', t => {
  const { m, p } = fixture(t); const ps = p[0]; let attempts = 0;
  ps._lastPriv = 'previous'; m._privDirty.clear(); m._pubDirty = false;
  m._lastFlowScope = `${m.phase}:${m.round}:${!!m.paused}:${m.deadline}`;
  m.sendFn = () => { attempts++; ps.connected = false; return false; };
  m._sendPrivate(ps, false, false);
  assert.equal(ps._lastPriv, 'previous'); assert.equal(m._privDirty.has(ps), false);
  m.flush(); m.flush(); assert.equal(attempts, 1);
});

test('messaging recovery: an online retry is dropped after disconnect and reconnect forces the full view', t => {
  const { m, p } = fixture(t); const ps = p[0]; let attempts = 0;
  m._privDirty.clear(); m._pubDirty = false;
  m._lastFlowScope = `${m.phase}:${m.round}:${!!m.paused}:${m.deadline}`;
  m.sendFn = (_pid, msg) => { if (msg.t === 'm.private') attempts++; return false; };
  m._sendPrivate(ps, false, false); assert.ok(m._privDirty.has(ps));
  ps.connected = false; m.flush(); m.flush();
  assert.equal(attempts, 1); assert.equal(m._privDirty.has(ps), false);
  m.sendFn = (_pid, msg) => { if (msg.t === 'm.private') attempts++; return true; };
  m.onReconnect(ps.playerId);
  assert.equal(attempts, 2); assert.equal(ps._lastPriv, JSON.stringify(ps.privateView()));
});

test('messaging recovery: failed public view retains dirty and sends on the next successful flush', t => {
  const { m } = fixture(t); const publicView = m.publicView.bind(m); const sent = [];
  m._privDirty.clear(); m._pubDirty = true; m._lastPubAt = -Infinity;
  m._lastPubJson = null; m._lastFlowScope = `${m.phase}:${m.round}:${!!m.paused}:${m.deadline}`;
  m.broadcastFn = msg => sent.push(msg); m.publicView = fail;
  m.flush(); assert.equal(m._pubDirty, true); assert.equal(sent.length, 0);
  m.publicView = publicView; m.flush();
  assert.equal(m._pubDirty, false); assert.equal(sent.length, 1); expectError(m, 'publicView');
});

test('messaging recovery: public encoding failure retains dirty and does not commit cache or scope', t => {
  const { m } = fixture(t); const publicView = m.publicView.bind(m); const sent = [];
  m._privDirty.clear(); m._pubDirty = true; m._lastPubAt = -Infinity; m._lastPubJson = 'previous';
  const scope = `${m.phase}:${m.round}:${!!m.paused}:${m.deadline}`; m._lastFlowScope = scope;
  m.broadcastFn = msg => sent.push(msg);
  m.publicView = () => { const view = publicView(); view.circular = view; return view; };
  m.flush();
  assert.equal(m._pubDirty, true); assert.equal(m._lastPubJson, 'previous');
  assert.equal(m._lastFlowScope, scope); assert.equal(m._lastPubAt, -Infinity); assert.equal(sent.length, 0);
  m.publicView = publicView; m.flush();
  assert.equal(m._pubDirty, false); assert.equal(sent.length, 1); expectError(m, 'publicView');
});
