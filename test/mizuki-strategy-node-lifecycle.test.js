import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { itemMergeRecipe } from '../shared/itemMerge.js';
import { dispatchMizukiNativeMeta } from '../server/modes/mizuki/NativeMeta.js';
import { MetaRegistry } from '../server/match/effectsMeta.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const CELL = 'chess_item_5_08_e_a';
function fixture(t, bandId, { count = 1, ...extra } = {}) {
  const scheduler = new VirtualScheduler();
  const options = { data: DATA, scheduler, seed: 503, roomCode: 'STNODE',
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    send() {}, broadcast() {}, onEnd() {}, log: { info() {}, warn() {}, error() {} }, ...extra };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); });
  const command = message => { const result = match.handle('p0', message);assert.deepEqual(result, { ok: true }); };
  match.start();
  for (const player of match.order) assert.deepEqual(match.handle(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' }), { ok: true });
  for (const player of match.order) assert.deepEqual(match.handle(player.playerId, { t: 'g.mizuki.strategy', bandId: player.seat ? 'band_amiya' : bandId }), { ok: true });
  for (const player of match.order) assert.deepEqual(match.handle(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' }), { ok: true });
  for (const player of match.order) assert.deepEqual(match.handle(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' }), { ok: true });
  skipMizukiRecruit(match);
  return { match, player: match.players.get('p0'), command, options };
}

test('fixed-round strategy rewards survive noncombat rounds and never repeat on route reread or prep', t => {
  const { match, player } = fixture(t, 'band_justin');
  const pig = 'chess_item_3_12_e_a';
  assert.equal(player.equipmentInventory.filter(item => item.id === pig).length, 1, 'round one starts when initial recruitment reaches the route');
  const advance = () => match._withParty(match.expedition.partyFor('p0'), () => {
    match.currentNode = null;match._completeNode();
  });
  advance();advance();advance();
  assert.equal(match.privateView('p0').mizuki.round, 4);
  const recipe = itemMergeRecipe(pig, id => match.gd.item(id), match.gd.itemMergeCount);
  assert.ok(recipe);
  assert.equal(player.equipmentInventory.filter(item => item.id === recipe.upgradeId).length, 1, 'round four reward combines with the round one copy using the original recipe');
  const inventory = structuredClone(player.equipmentInventory);
  const party = match.expedition.partyFor('p0');
  match._withParty(party, () => match._enterRoute());
  assert.deepEqual(player.equipmentInventory, inventory, 'same-round route reentry does not pay twice');
  const node = match.privateView('p0').mizuki.route.find(value => value.available && ['combat', 'elite', 'boss'].includes(value.type));
  assert.ok(node);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.route', nodeId: node.id }), { ok: true });
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.routeStart' }), { ok: true });
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.PREP);
  assert.deepEqual(player.equipmentInventory, inventory, 'preparation keeps the round reward idempotent');
  player.nativeHookIds = player.nativeHookIds.filter(id => !id.startsWith('strategy:band_justin:'));
  match._withParty(party, () => match._enterPrep());
  assert.deepEqual(player.equipmentInventory, inventory, 'legacy preparation claims prevent introducing a duplicate reward during migration');
});

for (const round of [8, 9]) test('board-dependent Yu applies at the first prepared board on round ' + round + ' once across checkpoint replay', t => {
  const { match, player, options } = fixture(t, 'band_yu');
  match._withParty(match.expedition.partyFor('p0'), () => {
    match.completedNodes = 7;match._enterRoute();
    if (round === 9) { match.currentNode = null;match._completeNode(); }
  });
  assert.equal(player.nativeHookIds.some(id => id.startsWith('strategy:band_yu:')), false);
  for (const id of ['chess_char_1_09_a', 'chess_char_1_17_a']) assert.equal(match._addOperator(player, id), true);
  player.prep.board = player.roster.map((unit, i) => ({ uid: unit.uid, row: 9, col: 4 + i, dir: 'RIGHT' }));
  player.prep.hand = player.prep.hand.map(uid => player.roster.some(unit => unit.uid === uid) ? null : uid);
  assert.equal(match._prepBonds(player).preciShip.active, true);
  const before = player.layers.preciShip || 0;
  const node = match.privateView('p0').mizuki.route.find(value => value.available && ['combat', 'elite', 'boss'].includes(value.type));
  assert.ok(node);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.route', nodeId: node.id }), { ok: true });
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.routeStart' }), { ok: true });
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.PREP);
  assert.ok(player.layers.preciShip > before, 'Yu reads the newly placed operators at preparation instead of swallowing the hook on an empty route board');
  const layers = structuredClone(player.layers), checkpoint = structuredClone(match.exportCheckpoint());
  const scheduler = new VirtualScheduler(), restored = new MizukiMatch({ ...options, scheduler });
  t.after(() => { restored.dispose();scheduler.dispose(); });
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  const recovered = restored.players.get('p0');
  restored._withParty(restored.expedition.partyFor('p0'), () => restored._enterPrep());
  assert.deepEqual(recovered.layers, layers, 'restored preparation cannot replay the deferred once-only effect');
  match._withParty(match.expedition.partyFor('p0'), () => match._enterPrep());
  assert.deepEqual(player.layers, layers, 'same-round preparation reentry cannot pay the layers again');
});

test('Cathy consumes her cell allowance only after successful receipt from her own offer', t => {
  const { match, player, command } = fixture(t, 'band_cathy');
  const addOffer = (id, source, itemId) => {
    player.equipmentOffers.push({ id, kind: 'item', choices: [itemId], source, createdRound: match.round, pick: 1, grantOpts: {} });
  };
  addOffer('test:other', 'band:band_quintus', CELL);
  command({ t: 'g.mizuki.equipmentPick', offerId: 'test:other', itemId: CELL });
  assert.equal(player.metaCounters['band:cathy:cellTaken'] || 0, 0);
  addOffer('test:cathy', 'band:band_cathy', CELL);
  const invalid = match.handle('p0', { t: 'g.mizuki.equipmentPick', offerId: 'test:cathy', itemId: 'chess_item_1_01_e_a' });
  assert.notEqual(invalid.ok, true);assert.equal(player.metaCounters['band:cathy:cellTaken'] || 0, 0);
  addOffer('test:queued', 'band:band_cathy', CELL);
  player.equipmentOffers.at(-1).choices.push('chess_item_1_01_e_a');
  command({ t: 'g.mizuki.equipmentPick', offerId: 'test:cathy', itemId: CELL });
  assert.equal(player.metaCounters['band:cathy:cellTaken'], 1);
  assert.equal(player.equipmentOffers.some(offer => offer.id === 'test:cathy'), false);
  assert.deepEqual(player.equipmentOffers.find(offer => offer.id === 'test:queued').choices, ['chess_item_1_01_e_a']);
  const replay = match.handle('p0', { t: 'g.mizuki.equipmentPick', offerId: 'test:cathy', itemId: CELL });
  assert.notEqual(replay.ok, true);assert.equal(player.metaCounters['band:cathy:cellTaken'], 1);
  const originalChoices = match.gd.choices, ownChoices = Object.hasOwn(match.gd, 'choices');
  const others = Object.values(DATA.items).filter(item => !item.isGolden && item.itemType === 'EQUIP' && item.id !== CELL)
    .map(item => item.chessId || item.id).filter(Boolean).slice(0, 3);
  Object.defineProperty(match.gd, 'choices', { configurable: true, value: { ...originalChoices,
    pools: { ...originalChoices.pools, pool_equip_kathe: { kind: 'equip', items: [CELL, ...others] } } } });
  t.after(() => { if (ownChoices) Object.defineProperty(match.gd, 'choices', { configurable: true, value: originalChoices });else delete match.gd.choices; });
  match._equipmentStage = () => 6;
  match._nativeHook(player, 'onLevelUp', { level: 6, mizukiCommanderLevelUp: true }, 'cathy-exclusion');
  assert.equal(player.equipmentOffers.at(-1).choices.length, 3);
  assert.equal(player.equipmentOffers.at(-1).choices.includes(CELL), false, 'future genuine strategy draws exclude the cell after its receipt');
});

test('Lao Li receives round-three income after noncombat rounds and preparation cannot pay it twice', t => {
  const { match, player } = fixture(t, 'band_lmlee');
  for (let i = 0; i < 2; i++) match._withParty(match.expedition.partyFor('p0'), () => { match.currentNode = null;match._completeNode(); });
  assert.equal(match.privateView('p0').mizuki.round, 3);
  assert.equal(player.economicCoinTotal, 15);
  assert.equal(player.roster.length, 2, 'both scheduled original operator pools pay even without a combat prep at round three');
  match._withParty(match.expedition.partyFor('p0'), () => {
    const skipBand = match._strategyRouteHook(player, 'onIncome');
    const income = match._nativeHook(player, 'onIncome', { income: 0, pending: 0 }, 'prep-income', { skipBand });
    assert.equal(income.income, 0);
  });
  assert.equal(player.economicCoinTotal, 15);
});

test('scheduled strategy grants remain personal and idempotent after split-party checkpoint restore', t => {
  const dungeon = { zones: [{ id: 'zone_1', nodes: Array.from({ length: 5 }, (_, x) => [0, 1].map(y => ({
    pos: { x, y }, type: 'BATTLE_SHOP', next: x < 4 ? [{ x: x + 1, y }] : [],
  }))).flat() }] };
  const { match, player, options } = fixture(t, 'band_justin', { count: 2, dungeon });
  const choices = match.privateView('p0').mizuki.route.filter(node => node.available);
  assert.equal(choices.length, 2);
  const command = (who, message) => { const result = match.handle(who, message);assert.equal(result.ok, true, JSON.stringify(result));return result; };
  command('p0', { t: 'g.mizuki.route', nodeId: choices[0].id });
  command('p1', { t: 'g.mizuki.route', nodeId: choices[1].id });
  const request = command('p1', { t: 'g.mizuki.splitRequest', nodeId: choices[1].id }).request;
  command('p0', { t: 'g.mizuki.splitDecide', requestId: request.id, approve: true });
  command('p0', { t: 'g.mizuki.routeStart' });
  assert.equal(match.expedition.parties.size, 2);
  for (let n = 0; n < 3; n++) {
    assert.equal(match.privateView('p0').mizuki.phase, PHASE.SHOP);
    command('p0', { t: 'g.mizuki.ready', on: true });
    if (n < 2) {
      const node = match.privateView('p0').mizuki.route.find(value => value.available);assert.ok(node);
      command('p0', { t: 'g.mizuki.route', nodeId: node.id });
      command('p0', { t: 'g.mizuki.routeStart' });
    }
  }
  assert.equal(match.privateView('p0').mizuki.round, 4);
  assert.equal(match.privateView('p1').mizuki.round, 1);
  assert.equal(match.players.get('p1').equipmentInventory.length, 0);
  const inventory = structuredClone(player.equipmentInventory), checkpoint = structuredClone(match.exportCheckpoint());
  const scheduler = new VirtualScheduler(), restored = new MizukiMatch({ ...options, scheduler });
  t.after(() => { restored.dispose();scheduler.dispose(); });
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  const recovered = restored.players.get('p0');
  assert.deepEqual(recovered.equipmentInventory, inventory);
  restored._withParty(restored.expedition.partyFor('p0'), () => restored._enterRoute());
  assert.deepEqual(recovered.equipmentInventory, inventory, 'checkpoint replay does not issue the personal round-four reward again');
  assert.equal(restored.players.get('p1').equipmentInventory.length, 0);
});

test('legacy preparation checkpoint without strategy ledger cannot duplicate a paid scheduled reward', t => {
  const { match, player, options } = fixture(t, 'band_justin');
  const node = match.privateView('p0').mizuki.route.find(value => value.available && value.type === 'combat');
  assert.ok(node);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.route', nodeId: node.id }), { ok: true });
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.routeStart' }), { ok: true });
  const checkpoint = structuredClone(match.exportCheckpoint());
  for (const saved of checkpoint.players) saved.nativeHookIds = saved.nativeHookIds.filter(id => !id.startsWith('strategy:'));
  const scheduler = new VirtualScheduler(), restored = new MizukiMatch({ ...options, scheduler });
  t.after(() => { restored.dispose();scheduler.dispose(); });
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  restored._withParty(restored.expedition.partyFor('p0'), () => restored._enterPrep());
  assert.deepEqual(restored.players.get('p0').equipmentInventory, player.equipmentInventory);
});

test('native dispatcher defaults preserve order and band-only switches isolate precisely one source', () => {
  const registry = new MetaRegistry(), seen = [];
  registry.global('probe', { onRoundStart() { seen.push('global'); } });
  registry.band('test', { onRoundStart() { seen.push('band'); } });
  registry.bond('test', { onRoundStart() { seen.push('bond'); } });
  registry.effect('probe', { onRoundStart() { seen.push('effect'); } });
  const player = { alive: true, bandId: 'test', equipmentEffects: [{ id: 'test', key: 'effect:probe' }] };
  const contextFactory = () => ({ board: () => [], hand: () => [], temp: () => [], bond: () => null });
  const options = { player, gd: { band: () => ({}), bondIds: ['test'] }, registry, contextFactory, hook: 'onRoundStart' };
  assert.deepEqual(dispatchMizukiNativeMeta(options).errors, []);
  assert.deepEqual(seen, ['global', 'band', 'bond', 'effect']);seen.length = 0;
  assert.deepEqual(dispatchMizukiNativeMeta({ ...options, skipBand: true }).errors, []);
  assert.deepEqual(seen, ['global', 'bond', 'effect']);seen.length = 0;
  assert.deepEqual(dispatchMizukiNativeMeta({ ...options, onlyBand: true }).errors, []);
  assert.deepEqual(seen, ['band']);
});
