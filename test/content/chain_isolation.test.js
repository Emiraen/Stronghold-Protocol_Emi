import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import { install as installCore } from '../../server/sim/content/bonds/core.js';
import { install as installAddon } from '../../server/sim/content/bonds/addon/battle.js';
import { install as installItems, installItem } from '../../server/sim/content/items/battle.js';
import { install as installGarrisons } from '../../server/sim/content/garrisons/battle.js';
import { battleStore, gameData, setGameData, isolateContentCallback } from '../../server/sim/content/support/index.js';
import { MAX_INTERNAL_ERRORS, MAX_HOOK_DEPTH } from '../../server/sim/constants.js';

const bond = (tier = 1, layers = 0) => ({ active: true, tier, count: tier * 3, layers });
const op = (id, bonds = [], extra = {}) => ({ ...chessRec({ id, bonds, skill: null }), ...extra });
function twoPlayers({ bonds, garrisonIds = [], unitBonds = Object.keys(bonds) } = {}) {
  return makeBattle({ content: 'none', defs: { chess: { chain_op_a: op('chain_op_a', unitBonds, { garrisonIds }) } },
    players: ['p1', 'p2'].map((playerId, i) => ({ playerId, seat: i, side: 'L', colOffset: 0,
      units: [{ chessId: 'chain_op_a', uid: i + 1, row: 10 + i, col: 3 }],
      bonds: structuredClone(bonds) })),
  });
}
const hasBuff = (u, key) => u.buffs.some(b => b.key === key);
const recorded = (b, message) => assert.ok(b.errors.some(e => e.message === message), 'fault remains recorded');

test('chain isolation: a throwing logger cannot escape a failed callback or stop later hooks', () => {
  const h = twoPlayers({ bonds: {} });
  h.b.opts.quiet = false;
  let logs = 0, later = 0;
  h.b.logger = { error() { logs++; throw Error('logger unavailable'); } };
  h.b.on('fault-injection', () => { throw Error('hook error'); });
  h.b.on('fault-injection', () => { later++; });
  assert.doesNotThrow(() => h.b.emit('fault-injection', {}));
  assert.doesNotThrow(() => h.b.emit('fault-injection', {}));
  assert.equal(later, 2); assert.equal(logs, 1, 'original error remains deduplicated');
  assert.equal(h.b.errorCount, 2); assert.equal(h.b.loggerErrorCount, 1);
  assert.equal(h.b.errors.filter(e => e.label === 'logger:error').length, 1);
  assert.equal(h.b._emitDepth, 0); recorded(h.b, 'hook error');
});

test('chain isolation: logger faults do not block scheduled callbacks or internal error fatal thresholds', () => {
  const h = twoPlayers({ bonds: {} });
  h.b.opts.quiet = false;
  h.b.logger = { error() { throw Error('logger unavailable'); } };
  let later = 0, ended = 0;
  h.b.after(0, () => { throw Error('timer error'); });
  h.b.after(0, () => { later++; });
  assert.doesNotThrow(() => h.b._runScheduled()); assert.equal(later, 1);
  h.b.forceEnd = reason => { assert.equal(reason, 'timeout'); ended++; };
  for (let i = 0; i <= MAX_INTERNAL_ERRORS; i++) assert.doesNotThrow(() => h.b._internalError('engine-test', Error('engine error')));
  assert.equal(h.b.internalErrorCount, MAX_INTERNAL_ERRORS + 1);
  assert.equal(h.b.errorCount, MAX_INTERNAL_ERRORS + 2);
  assert.equal(ended, 1);
  assert.equal(h.b.errors.filter(e => e.label === 'logger:error').length, 1);
});

test('chain isolation: logger faults cannot break hook-depth guard cleanup', () => {
  const h = twoPlayers({ bonds: {} }); h.b.opts.quiet = false;
  h.b.logger = { error() { throw Error('logger unavailable'); } };
  h.b._emitDepth = MAX_HOOK_DEPTH;
  let executed = false;
  assert.doesNotThrow(() => h.b._safe(() => { executed = true; }, 'guard-test'));
  assert.equal(executed, false); assert.equal(h.b._emitDepth, MAX_HOOK_DEPTH);
  h.b._emitDepth = 0;
  assert.doesNotThrow(() => h.b._safe(() => { throw Error('safe test'); }, 'safe-test'));
  assert.equal(h.b._emitDepth, 0); recorded(h.b, 'safe test');
});

test('chain isolation: pure fanout at depth 31 preserves the original callback budget and return values', () => {
  const h = twoPlayers({ bonds: {} });
  h.b._emitDepth = MAX_HOOK_DEPTH - 1;
  const seen = [];
  const value = isolateContentCallback(h.b, () => { seen.push(h.b._emitDepth); return isolateContentCallback(h.b, () => { seen.push(h.b._emitDepth); return 17; }, 'nested-fanout'); }, 'outer-fanout');
  assert.equal(value, 17); assert.deepEqual(seen, [31, 31]);
  assert.equal(h.b._emitDepth, 31);
  assert.equal(isolateContentCallback(h.b, () => { throw Error('fanout depth fault'); }, 'failed-fanout'), undefined);
  assert.equal(h.b._emitDepth, 31); recorded(h.b, 'fanout depth fault');
  h.b._emitDepth = 0;
});

test('chain isolation: core aggregate handlers execute recipients at the last allowed hook frame', () => {
  const h = twoPlayers({ bonds: { kjeragShip: bond(), siracusaShip: bond(2) } });
  installCore(h.b);
  const st = battleStore(h.b, 'bonds:core'), source = h.b.allyUnits[0];
  for (const name of ['hit', 'damaged']) {
    let calls = 0;
    (name === 'hit' ? st.hitFns : st.dmgFns).set(source, [() => { throw Error(name + ' last frame'); }, () => { calls++; assert.equal(h.b._emitDepth, MAX_HOOK_DEPTH); }]);
    h.b._emitDepth = MAX_HOOK_DEPTH - 1;
    h.b.emit(name, { source });
    assert.equal(calls, 1); assert.equal(h.b._emitDepth, MAX_HOOK_DEPTH - 1);
  }
  h.b._emitDepth = 0;
  assert.equal(h.b.errors.some(e => e.label.startsWith('hookDepth:')), false);
});

test('chain isolation: nested installer and member fanout preserve depth 31', () => {
  const h = twoPlayers({ bonds: { yanShip: bond(), preciShip: bond(), steadShip: bond() } });
  h.b._emitDepth = MAX_HOOK_DEPTH - 1;
  installCore(h.b); installAddon(h.b);
  assert.equal(h.b.allyUnits.every(u => hasBuff(u, 'bond:yan') && hasBuff(u, 'bond:preciShip') && hasBuff(u, 'bond:steadShip')), true);
  assert.equal(h.b._emitDepth, MAX_HOOK_DEPTH - 1);
  assert.equal(h.b.errors.some(e => e.label.startsWith('hookDepth:')), false);
  h.b._emitDepth = 0;
});

test('chain isolation: failed core member buff cannot block other members, bonds or players', () => {
  const h = twoPlayers({ bonds: { yanShip: bond(), kjeragShip: bond() } });
  const add = h.b.addBuff;
  h.b.addBuff = function(u, b) {
    if (u.ownerId === 'p1' && b.key === 'bond:yan') throw Error('core first buff');
    return add.call(this, u, b);
  };
  installCore(h.b);
  assert.equal(hasBuff(h.b.allyUnits[0], 'bond:kjerag'), true);
  assert.equal(hasBuff(h.b.allyUnits[1], 'bond:yan'), true);
  recorded(h.b, 'core first buff');
});

for (const name of ['layerRefresh', 'hit', 'damaged']) test(`chain isolation: core ${name} callbacks remain independent`, () => {
  const h = twoPlayers({ bonds: { yanShip: bond(), kjeragShip: bond(), siracusaShip: bond(2) } });
  installCore(h.b);
  const st = battleStore(h.b, 'bonds:core');
  let calls = 0;
  const callbacks = [() => { throw Error('core ' + name); }, () => { calls++; }];
  if (name === 'layerRefresh') {
    st.refreshers.set('p1|yanShip', callbacks);
    h.b.emit('layerGain', { playerId: 'p1', bondId: 'yanShip', n: 1 });
    h.b._runScheduled();
  } else {
    const source = h.b.allyUnits[0];
    (name === 'hit' ? st.hitFns : st.dmgFns).set(source, callbacks);
    h.b.emit(name, { source });
  }
  assert.equal(calls, 1);
  recorded(h.b, 'core ' + name);
});

test('chain isolation: addon passive failure cannot block later bonds or players', () => {
  const h = twoPlayers({ bonds: { preciShip: bond(), steadShip: bond(), emptyShip: bond() } });
  const add = h.b.addBuff;
  h.b.addBuff = function(u, b) {
    if (u.ownerId === 'p1' && b.key === 'bond:preciShip') throw Error('addon first buff');
    return add.call(this, u, b);
  };
  installAddon(h.b);
  assert.equal(hasBuff(h.b.allyUnits[0], 'bond:steadShip'), true);
  assert.equal(hasBuff(h.b.allyUnits[0], 'bond:emptyShip'), true);
  assert.equal(hasBuff(h.b.allyUnits[1], 'bond:preciShip'), true);
  recorded(h.b, 'addon first buff');
});

test('chain isolation: failed addon bond state is not published partially', () => {
  const h = twoPlayers({ bonds: { preciShip: bond(), steadShip: bond() } });
  Object.defineProperty(h.b.getPlayer('p1').bonds, 'preciShip', { get() { throw Error('addon state'); } });
  installAddon(h.b);
  assert.equal(hasBuff(h.b.allyUnits[0], 'bond:steadShip'), true);
  assert.equal(hasBuff(h.b.allyUnits[1], 'bond:preciShip'), true);
  recorded(h.b, 'addon state');
});

test('chain isolation: a failed opening revival flush cannot discard later queued players', () => {
  const h = twoPlayers({ bonds: { egirShip: bond(2) } });
  installCore(h.b);
  const start = battleStore(h.b, 'bonds:egir:start');
  let calls = 0;
  start.flush.unshift(() => { throw Error('egir first flush'); }, () => { calls++; });
  h.b.emit('battleStart', {});
  assert.equal(calls, 1);
  assert.equal(start.flush.length, 0);
  recorded(h.b, 'egir first flush');
});

test('chain isolation: failed aura recipient does not block the next player in a shared battle', () => {
  const h = twoPlayers({ bonds: { skillfulShip: bond() } });
  installAddon(h.b);
  for (const u of h.b.allyUnits) { u.alive = true; u.deployed = true; }
  const add = h.b.addBuff;
  h.b.addBuff = function(u, b) { if (u.ownerId === 'p1' && b.key === 'bond:skillfulShip') throw Error('aura first player'); return add.call(this, u, b); };
  h.b.emit('battleStart', {});
  assert.equal(hasBuff(h.b.allyUnits[1], 'bond:skillfulShip'), true);
  recorded(h.b, 'aura first player');
});

test('chain isolation: failed tier-two revival SP recipient does not block later SP or the revival', () => {
  const ids = ['chain_indom_one', 'chain_indom_two', 'chain_indom_three'];
  const h = makeBattle({ content: 'none', defs: { chess: Object.fromEntries(ids.map(id => [id, op(id, ['indomShip'])])) },
    units: ids.map((chessId, i) => ({ chessId, row: 10, col: 3 + i })), bonds: { indomShip: bond(2, 1000) } });
  installAddon(h.b);
  for (const u of h.b.allyUnits) { u.alive = true; u.deployed = true; }
  const [first, second, dead] = h.b.allyUnits; let sp = 0, revived = 0;
  first.skill = { gainSp() { throw Error('indom first sp'); } }; second.skill = { gainSp() { sp++; } };
  dead.alive = false; dead.deployed = false;
  h.b.redeploy = () => { revived++; return true; };
  h.b.emit('death', { unit: dead, reason: 'killed' });
  assert.equal(sp, 1); assert.equal(revived, 1); recorded(h.b, 'indom first sp');
});

const stat = (key, bb) => ({ key, bb, bbStr: { key } });
test('chain isolation: one item buff failure cannot skip later buffs or cleanup entries', () => {
  const base = gameData();
  setGameData({ ...base, items: { ...base.items, chain_item_a: { id: 'chain_item_a', itemType: 'EQUIP', tier: 1, buffs: [
    stat('attr_common_global_buff', { atk: .1 }), stat('magic_penetrate_global_buff', { magic_resist_penetrate: .2 }),
  ] } } });
  try {
    const h = twoPlayers({ bonds: {} }), u = h.b.allyUnits[0];
    const add = h.b.addBuff;
    h.b.addBuff = function(target, buff) {
      if (buff.key.endsWith('stat:attr_common_global_buff')) throw Error('item first buff');
      return add.call(this, target, buff);
    };
    const grant = installItem(h.b, u, 'chain_item_a');
    assert.equal(u.buffs.some(b => b.mods?.resIgnorePct === .2), true);
    recorded(h.b, 'item first buff');
    const scope = grant.scope;
    let cancelled = false, removed = false, disposed = 0;
    scope.scheds.push({ cancel() { throw Error('item timer cleanup'); } }, { cancel() { cancelled = true; } });
    const remove = h.b.removeBuff;
    h.b.removeBuff = function(target, key) { if (key === 'bad') throw Error('item buff cleanup'); if (key === 'good') removed = true; return remove.call(this, target, key); };
    scope.buffs.push([u, 'bad'], [u, 'good']);
    scope.fns.push(() => { throw Error('item callback cleanup'); }, () => { disposed++; });
    grant.dispose();
    grant.dispose();
    assert.equal(cancelled, true); assert.equal(removed, true); assert.equal(disposed, 1);
    for (const text of ['item timer cleanup', 'item buff cleanup', 'item callback cleanup']) recorded(h.b, text);
  } finally { setGameData(base); }
});

test('chain isolation: item lookup failure cannot skip later equipment or players', () => {
  const base = gameData();
  const items = { ...base.items };
  Object.defineProperty(items, 'chain_broken_a', { get() { throw Error('item record lookup'); } });
  items.chain_good_a = { id: 'chain_good_a', itemType: 'EQUIP', tier: 1, buffs: [stat('attr_common_global_buff', { atk: .25 })] };
  setGameData({ ...base, items });
  try {
    const h = twoPlayers({ bonds: {} });
    h.b.allyUnits[0].items = ['chain_broken_a', 'chain_good_a'];
    h.b.allyUnits[1].items = ['chain_good_a'];
    installItems(h.b);
    assert.ok(h.b.allyUnits.every(u => u.buffs.some(b => b.mods?.atkPct === .25)));
    recorded(h.b, 'item record lookup');
  } finally { setGameData(base); }
});

test('chain isolation: failed garrison grant does not skip later traits or retry partial rewards', () => {
  const base = gameData(), key = 'act1autochess_gar_event_useskill';
  const rec = (id, target) => ({ garrisonId: id, effectKey: key, eventType: 'IN_BATTLE', bb: { bond_add_count: 1 }, bbStr: { bond_id: target } });
  setGameData({ ...base, garrisons: { ...base.garrisons, chain_bad: rec('chain_bad', 'yanShip'), chain_good: rec('chain_good', 'kjeragShip') } });
  try {
    const h = twoPlayers({ bonds: { yanShip: bond(), kjeragShip: bond() }, garrisonIds: ['chain_bad', 'chain_good'] });
    installGarrisons(h.b);
    const add = h.b.addLayers; let attempts = 0;
    h.b.addLayers = function(pid, id, ...args) { if (id === 'yanShip') { attempts++; throw Error('garrison grant'); } return add.call(this, pid, id, ...args); };
    h.b.emit('skillStart', { unit: h.b.allyUnits[0] });
    assert.equal(h.b.getPlayer('p1').bonds.kjeragShip.layers, 1);
    assert.equal(attempts, 1); recorded(h.b, 'garrison grant');
  } finally { setGameData(base); }
});

test('chain isolation: garrison reader failure cannot disable other readers or later layer refresh', () => {
  const base = gameData(), key = 'act1autochess_gar_eff_attrByBond';
  const rec = id => ({ garrisonId: id, effectKey: key, eventType: 'IN_BATTLE', bb: { divide_num: 1, atk: .1 }, bbStr: { bond_id: 'yanShip' } });
  setGameData({ ...base, garrisons: { ...base.garrisons, chain_reader_bad: rec('chain_reader_bad'), chain_reader_good: rec('chain_reader_good') } });
  try {
    const h = twoPlayers({ bonds: { yanShip: bond(1, 1) }, garrisonIds: ['chain_reader_bad', 'chain_reader_good'] });
    const add = h.b.addBuff;
    h.b.addBuff = function(u, buff) { if (buff.key === 'gar:chain_reader_bad') throw Error('garrison reader'); return add.call(this, u, buff); };
    installGarrisons(h.b);
    assert.equal(h.b.allyUnits.every(u => hasBuff(u, 'gar:chain_reader_good')), true);
    h.b.addBuff = add;
    h.b.emit('layerGain', { playerId: 'p1', bondId: 'yanShip', n: 0 }); h.b._runScheduled();
    assert.equal(h.b.allyUnits.every(u => hasBuff(u, 'gar:chain_reader_bad')), true, 'failed idempotent readers were not marked current');
    h.b.addLayers('p1', 'yanShip', 1); h.b._runScheduled();
    assert.equal(h.b.allyUnits[0].buffs.find(b => b.key === 'gar:chain_reader_good').mods.atkPct, .2);
    recorded(h.b, 'garrison reader');
  } finally { setGameData(base); }
});
