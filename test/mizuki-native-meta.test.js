import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMizukiNativeMeta } from '../server/modes/mizuki/NativeMeta.js';
import { grantMizukiEconomicHope } from '../server/modes/mizuki/Economy.js';
import { MetaRegistry, getDefaultRegistry, MAX_DEPTH, GARRISON_HOOK } from '../server/match/effectsMeta.js';
import { getData } from '../server/data.js';

function fixture({ registry = new MetaRegistry(), pieces = [], garrisons = {}, chess = {}, bonds = {}, round = 1 } = {}) {
  const player = { hope: 0, gold: 37, bandId: null, equipmentEffects: [], metaCounters: {} };
  const gd = { bondIds: Object.keys(bonds), chess: id => chess[id], garrison: id => garrisons[id],
    bond: id => bonds[id], band: id => getData().bands[id], item: id => getData().items[id] };
  // Match can expose all pieces through hand(); their explicit areas win.
  const contextFactory = source => ({ source, gd, data: getData(), round, phase: 'PREP',
    board: () => [], hand: () => pieces, temp: () => [], piece: uid => pieces.find(piece => piece.uid === uid),
    bond: id => bonds[id], bondActive: id => bonds[id]?.active === true, bonds: () => bonds,
    layers: id => bonds[id]?.layers || 0,
    counter: key => player.metaCounters[key] || 0,
    setCounter: (key, value) => player.metaCounters[key] = value,
    incCounter: (key, amount = 1) => player.metaCounters[key] = (player.metaCounters[key] || 0) + amount,
    addFunds: amount => grantMizukiEconomicHope(player, amount).coinGranted,
    addPendingFunds: amount => grantMizukiEconomicHope(player, amount).coinGranted,
    funds: () => (player.economicCoinRemainder || 0) + (player.economicHopePending || 0) * 5,
    toast() {}, reportError() {} });
  const dispatch = (hook, event = {}, extra = {}) => dispatchMizukiNativeMeta({ player, gd, contextFactory, registry, hook, event, ...extra });
  return { player, gd, contextFactory, dispatch, pieces };
}

test('native order preserves sources, mutable event, persistent effects and handler this', () => {
  const registry = new MetaRegistry(), order = [];
  const handler = label => ({ label, onRoundStart(ctx, ev) {
    assert.equal(this.label, label);assert.equal(ctx.hook, 'onRoundStart');
    assert.equal(ctx.source.kind, label);order.push(label);ev.visits++;
  } });
  registry.global('test', handler('global'));registry.band('test', handler('band'));
  registry.bond('bond', handler('bond'));registry.garrison('TEST', handler('garrison'));
  registry.item('chess_item_1_03_e', handler('item'));registry.effect('test', handler('effect'));
  const f = fixture({ registry, pieces: [{ uid: 1, id: 'op', kind: 'chess', area: 'board', row: 1, col: 1,
    items: [{ uid: 10, id: 'chess_item_1_03_e_a' }] }],
  chess: { op: { garrisonIds: ['g'] } }, garrisons: { g: { effectKey: 'TEST', eventType: 'SERVER_PREP_START' } }, bonds: { bond: {} } });
  f.player.bandId = 'test';f.player.equipmentEffects.push({ id: 'effect', key: 'effect:test' });
  const event = { visits: 0 }, result = f.dispatch('onRoundStart', event);
  assert.deepEqual(order, ['global', 'band', 'bond', 'garrison', 'item', 'effect']);
  assert.equal(result.event, event);assert.equal(event.visits, 6);assert.equal(result.dispatched, 6);
  assert.deepEqual(result.errors, []);
});

test('garrisonHooks, board-only conditions and owned areas control trait eligibility', () => {
  const registry = new MetaRegistry(), seen = [];
  registry.garrison('WIDE', { garrisonHooks: () => ['onRoundStart', 'onPrepEnd'], run: ctx => seen.push(ctx.source.piece.uid) });
  const f = fixture({ registry, pieces: [
    { uid: 1, id: 'op', kind: 'chess', area: 'hand' },
    { uid: 2, id: 'op', kind: 'chess', area: 'board', row: 2, col: 3 },
    { uid: 3, id: 'op', kind: 'chess', area: 'temp' },
    { uid: 4, id: 'op', kind: 'chess', area: 'board', row: 1, col: 1 }],
  chess: { op: { garrisonIds: ['g'] } }, garrisons: { g: { effectKey: 'WIDE', eventType: 'SERVER_PREP_FIN',
    bbStr: { conditionkey: 'character_target_inboard' } } } });
  f.dispatch('onRoundStart');assert.deepEqual(seen, [4, 2]);
  f.dispatch('onPrepEnd');assert.deepEqual(seen, [4, 2, 4, 2]);
  f.dispatch('onIncome', { income: 0 });assert.equal(seen.length, 4);
});

test('onGain targets only its gained piece and retains the original investment multiplier', () => {
  const registry = new MetaRegistry(), seen = [];
  registry.garrison('GAIN', { run: ctx => seen.push(ctx.source.piece.uid) });
  const f = fixture({ registry, chess: { op: { garrisonIds: ['gain'] } },
    garrisons: { gain: { effectKey: 'GAIN', eventType: 'SERVER_GAIN' } },
    bonds: { investShip: { active: true, layers: 100, bb: { count: 2 }, layerMilestones: [{ layer: 100 }] } } });
  f.dispatch('onGain', { kind: 'chess', piece: { uid: 7, kind: 'chess', id: 'op' } });
  assert.deepEqual(seen, [7, 7, 7]);
  f.dispatch('onRoundStart');assert.deepEqual(seen, [7, 7, 7]);
});

test('onPrice invokes the priced chess trait before strategy modifiers', () => {
  const registry = new MetaRegistry();
  registry.garrison('PRICE', { run: (_ctx, ev) => ev.price = 1 });
  registry.band('test', { onPrice: (_ctx, ev) => ev.price = Math.max(0, ev.price - 1) });
  const f = fixture({ registry, chess: { op: { garrisonIds: ['g'] } },
    garrisons: { g: { effectKey: 'PRICE', eventType: 'SERVER_PRICE' } } });
  f.player.bandId = 'test';
  assert.equal(f.dispatch('onPrice', { slot: { kind: 'chess', id: 'op' }, price: 5 }).event.price, 0);
});

test('equipped item snapshots skip removed pairs and defer newly equipped items', () => {
  const registry = new MetaRegistry(), seen = [];
  const holder = { uid: 1, id: 'op', kind: 'chess', area: 'hand',
    items: [{ uid: 10, id: 'chess_item_1_03_e_a' }, { uid: 11, id: 'chess_item_1_04_e_a' }] };
  registry.item('chess_item_1_03_e', { onRoundStart() {
    seen.push(10);holder.items.splice(1, 1);holder.items.push({ uid: 12, id: 'chess_item_1_05_e_a' });
  } });
  registry.item('chess_item_1_04_e', { onRoundStart: () => seen.push(11) });
  registry.item('chess_item_1_05_e', { onRoundStart: () => seen.push(12) });
  const f = fixture({ registry, pieces: [holder] });
  f.dispatch('onRoundStart');assert.deepEqual(seen, [10]);
  registry.item('chess_item_1_03_e', { onEquip: () => seen.push('wrong') });
  f.dispatch('onEquip', { item: holder.items[0] });assert.deepEqual(seen, [10]);
});

test('only trait handlers use run fallback and one failure does not suppress other income', () => {
  const registry = new MetaRegistry();
  registry.global('run_only', { run() { throw Error('must not run'); } });
  registry.global('broken', { onRoundStart() { throw Error('broken content'); } });
  registry.effect('coin', { onRoundStart: ctx => ctx.addFunds(5) });
  const f = fixture({ registry });f.player.equipmentEffects.push({ key: 'effect:coin' });
  const result = f.dispatch('onRoundStart');
  assert.equal(result.errors.length, 1);assert.equal(result.errors[0].key, 'global:broken');
  assert.equal(f.player.hope, 1);assert.equal(f.player.gold, 37);
});

test('equipment can be dispatched by its separate transaction owner without double triggering', () => {
  const registry = new MetaRegistry(), seen = [];
  registry.global('test', { onRoundStart: () => seen.push('global') });
  registry.item('chess_item_1_03_e', { onRoundStart: () => seen.push('item') });
  registry.effect('coin', { onRoundStart: () => seen.push('effect') });
  const f = fixture({ registry, pieces: [{ uid: 1, id: 'op', kind: 'chess', area: 'hand',
    items: [{ uid: 10, id: 'chess_item_1_03_e_a' }] }] });
  f.player.equipmentEffects.push({ key: 'effect:coin' });
  f.dispatch('onRoundStart', {}, { includeEquipment: false });
  assert.deepEqual(seen, ['global']);
});

test('real original operator purchase strategy receives the recruited operator on onBuy', () => {
  const band = Object.values(getData().bands).find(value => value.buffs?.some(buff => buff.key === 'round_start_gain_coin_by_bond_char_chess_buy'));
  const rule = band.buffs.find(buff => buff.key === 'round_start_gain_coin_by_bond_char_chess_buy');
  const member = { bonds: [rule.bbStr.bond] };
  const f = fixture({ registry: getDefaultRegistry(), chess: { op: member } });
  f.player.bandId = band.bandId;
  const callbacks = { chessRecord: id => f.gd.chess(id) };
  const event = { kind: 'chess', slot: { id: 'op', kind: 'chess' }, piece: { uid: 1, id: 'op', kind: 'chess' }, price: 0 };
  assert.deepEqual(f.dispatch('onBuy', event, { callbacks, includeEquipment: false }).errors, []);
  assert.equal(f.player.economicCoinTotal, rule.bb.count);
  assert.equal(f.player.gold, 37);
});

test('nested dispatch uses the shared original depth limit and recovers afterward', () => {
  const registry = new MetaRegistry();let calls = 0, nested;
  const f = fixture({ registry });
  registry.global('recursive', { onRoundStart() {
    calls++;const result = f.dispatch('onRoundStart');if (result.errors.length) nested = result;
  } });
  assert.deepEqual(f.dispatch('onRoundStart').errors, []);
  assert.equal(calls, MAX_DEPTH);assert.match(nested.errors[0].error, /depth limit/);
  registry.global('recursive', { onRoundStart() { calls++; } });
  f.dispatch('onRoundStart');assert.equal(calls, MAX_DEPTH + 1);
});

test('eliminated players only run persistent effects explicitly permitted after elimination', () => {
  const registry = new MetaRegistry(), seen = [];
  registry.global('test', { onRoundStart: () => seen.push('global') });
  registry.effect('normal', { onRoundStart: () => seen.push('normal') });
  registry.effect('gift', { afterElimination: true, onRoundStart: () => seen.push('gift') });
  const f = fixture({ registry });f.player.eliminated = true;
  f.player.equipmentEffects.push({ key: 'effect:normal' }, { key: 'effect:gift' });
  f.dispatch('onRoundStart');assert.deepEqual(seen, ['gift']);
});

test('real original round-income strategy and persistent equipment income convert to hope', () => {
  const band = Object.values(getData().bands).find(value => value.buffs?.some(buff => buff.key === 'give_coin_in_round'));
  assert.ok(band);
  const rule = band.buffs.find(buff => buff.key === 'give_coin_in_round').bb;
  const f = fixture({ registry: getDefaultRegistry(), round: rule.round });
  f.player.bandId = band.bandId;
  const event = { round: rule.round, income: 0, pending: 0 };
  assert.deepEqual(f.dispatch('onIncome', event).errors, []);
  assert.equal(event.income, rule.coin);
  grantMizukiEconomicHope(f.player, event.income + event.pending);
  f.player.equipmentEffects.push({ id: 'doll:1', key: 'effect:builtin_round_coin', params: { count: 5 } });
  assert.deepEqual(f.dispatch('onRoundStart', { round: rule.round }).errors, []);
  assert.equal(f.player.economicCoinTotal, rule.coin + 5);
  assert.equal(f.player.hope, Math.floor((rule.coin + 5) / 5));
  assert.equal(f.player.gold, 37);
});

test('real original one-time coin traits follow gain, sale and prep-end events through the pending funds adapter', () => {
  const traits = Object.values(getData().garrisons).filter(value => value.effectKey.startsWith('SERVER_ONCE_GOLD') && value.bb?.count > 0);
  assert.ok(traits.length > 0);
  for (const garrison of traits) {
    const piece = { uid: 1, id: 'op', kind: 'chess', area: 'board', row: 1, col: 1 };
    const f = fixture({ registry: getDefaultRegistry(), chess: { op: { garrisonIds: ['real'] } },
      garrisons: { real: garrison }, pieces: [piece] });
    assert.deepEqual(f.dispatch('onRoundStart').errors, []);assert.equal(f.player.economicCoinTotal, undefined);
    const result = f.dispatch(GARRISON_HOOK[garrison.eventType], { kind: 'chess', piece });
    assert.deepEqual(result.errors, []);assert.equal(f.player.economicCoinTotal, garrison.bb.count);
    assert.equal(f.player.hope, Math.floor(garrison.bb.count / 5));assert.equal(f.player.gold, 37);
  }
});

test('original capital interest reads only unconverted coins and cannot use ingots as capital', () => {
  const band = Object.values(getData().bands).find(value => value.buffs?.some(buff => buff.key === 'coin_carry_over'));
  assert.ok(band);
  const f = fixture({ registry: getDefaultRegistry() });f.player.bandId = band.bandId;
  grantMizukiEconomicHope(f.player, 14);
  assert.equal(f.dispatch('onIncome', { income: 0, pending: 0 }).event.income, 0);
  f.player.hope = 9999;grantMizukiEconomicHope(f.player, 5);
  const event = { income: 0, pending: 0 }, result = f.dispatch('onIncome', event);
  assert.deepEqual(result.errors, []);assert.equal(event.income, 1);assert.equal(f.player.gold, 37);
});
