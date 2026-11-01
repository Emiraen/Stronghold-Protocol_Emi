import test from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { itemMergeRecipe } from '../shared/itemMerge.js';
import { grantMizukiEquipment, equipMizukiEquipment, dispatchMizukiEquipmentMeta,
  validMizukiEquipmentState } from '../server/modes/mizuki/Equipment.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const gd = new GameData(DATA, 'mode_mizuki');
const HAMMER = 'chess_item_1_01_e_a', SHIELD = 'chess_item_1_02_e_a';
const item = (uid, id, extra = {}) => ({ uid, id, kind: 'item', ...extra });
const op = (uid) => ({ uid, operatorId: 'chess_char_1_08_a', chessId: 'chess_char_1_08_a',
  promotion: 0, recruitCopies: 1, items: [] });
const fixture = () => ({ playerId: 'p0', seat: 0, alive: true, left: false, ready: false,
  roster: [op(10001), op(10002)], lineup: [10001], equipmentInventory: [], equipmentSeq: 50,
  gold: 17, hope: 6, layers: {}, metaCounters: {}, metaMessages: [] });
const allocateUid = (draft) => 100000000 + ++draft.equipmentSeq;
const options = (extra = {}) => ({ gd, phase: PHASE.PREP, actorId: 'p0', allocateUid, ...extra });
const all = (player) => [...player.equipmentInventory, ...player.roster.flatMap((unit) => unit.items)];

test('every real item uses the same standard synthesis eligibility, copy threshold and upgrade record', () => {
  const source = structuredClone(DATA.items);
  for (const record of Object.values(DATA.items)) {
    const recipe = itemMergeRecipe(record.id, (id) => gd.item(id), gd.itemMergeCount);
    const player = fixture();
    const count = recipe?.count || 2;
    // Existing material instances may be worn on a carried operator or reserve.
    for (let index = 0; index < count - 1; index++) player.roster[index % 2].items.push(item(100000001 + index, record.id));
    const result = grantMizukiEquipment(player, record.id, options());
    assert.equal(result.ok, true, record.id + ': ' + JSON.stringify(result));
    if (recipe) {
      assert.equal(result.events.length, 1, record.id);
      assert.equal(result.events[0].consumed.length, recipe.count, record.id);
      assert.equal(result.item.id, recipe.upgradeId, record.id);
      assert.equal(player.equipmentInventory.length, 1, record.id);
      assert.equal(all(player).length, 1, record.id);
      assert.equal(player.roster.flatMap((unit) => unit.items).length, 0, record.id);
      assert.ok(!result.events[0].consumed.includes(result.item.uid), 'new advanced instance');
    } else {
      assert.equal(result.events.length, 0, record.id + ': no fabricated recipe');
      assert.equal(all(player).length, count, record.id);
      assert.equal(player.roster[0].items[0].uid, 100000001, record.id + ': unavailable merge leaves worn item');
    }
    assert.equal(validMizukiEquipmentState(player, { gd }), true, record.id);
    assert.equal(player.hope, 6); assert.equal(player.gold, 17);
  }
  assert.deepEqual(DATA.items, source, 'the standard data catalog is immutable');
});

test('only consumed material instances detach; unrelated equipment and another player keep their exact metadata and UIDs', () => {
  const player = fixture(), other = fixture(); other.playerId = 'p1'; other.seat = 1;
  const keep = item(100000002, SHIELD, { meta: { source: 'reward', counter: 4 } });
  player.roster[0].items = [item(100000001, HAMMER, { meta: { used: 9 }, deferMerge: false }), keep];
  other.roster[0].items = [item(200000001, HAMMER, { meta: { counter: 8 } })];
  const before = structuredClone(other);
  const result = grantMizukiEquipment(player, HAMMER, options());
  assert.equal(result.ok, true);
  assert.deepEqual(player.roster[0].items, [keep]);
  assert.deepEqual(result.item.meta, {}, 'standard new item does not inherit a material counter');
  assert.equal(result.item.deferMerge, undefined);
  assert.notEqual(result.item.uid, 100000001);
  assert.deepEqual(other, before);
});

test('data-defined synthesis chains respect each standard recipe count and return the final live item', () => {
  const player = fixture();
  const records = {
    test_a: { id: 'test_a', itemType: 'EQUIP', mergeable: true, upgradeNum: 3, upgradeChessId: 'test_b' },
    test_b: { id: 'test_b', itemType: 'EQUIP', mergeable: true, upgradeNum: 2, upgradeChessId: 'test_c' },
    test_c: { id: 'test_c', itemType: 'EQUIP', isGolden: true },
  };
  const custom = Object.create(gd); custom.item = (id) => records[id] || gd.item(id);
  player.roster[0].items = [item(100000001, 'test_a')];
  player.roster[1].items = [item(100000002, 'test_a'), item(100000003, 'test_b')];
  const events = [];
  const result = grantMizukiEquipment(player, 'test_a', options({ gd: custom, onMerge: (_draft, event) => events.push(event) }));
  assert.equal(result.ok, true); assert.deepEqual(result.merged.map((value) => value.id), ['test_b', 'test_c']);
  assert.deepEqual(events.map((event) => event.consumed.length), [3, 2]);
  assert.equal(result.item.id, 'test_c'); assert.deepEqual(all(player), [result.item]);
});

test('a nested onMerge grant follows standard synthesis again and the outer gain returns the final live result', () => {
  const player = fixture();
  const records = {
    nested_a: { id: 'nested_a', itemType: 'EQUIP', mergeable: true, upgradeNum: 2, upgradeChessId: 'nested_b' },
    nested_b: { id: 'nested_b', itemType: 'EQUIP', mergeable: true, upgradeNum: 2, upgradeChessId: 'nested_c' },
    nested_c: { id: 'nested_c', itemType: 'EQUIP', isGolden: true },
  };
  const custom = Object.create(gd); custom.item = (id) => records[id] || gd.item(id);
  player.roster[0].items = [item(100000001, 'nested_a')];
  const opts = options({ gd: custom, onMerge: (draft, event) => {
    if (event.itemId === 'nested_a') {
      const nested = grantMizukiEquipment(draft, 'nested_b', opts);
      assert.equal(nested.ok, true); assert.equal(nested.item.id, 'nested_c');
    }
  } });
  const result = grantMizukiEquipment(player, 'nested_a', opts);
  assert.equal(result.ok, true); assert.equal(result.item.id, 'nested_c');
  assert.deepEqual(result.events.map((event) => event.itemId), ['nested_a', 'nested_b']);
  assert.deepEqual(all(player), [result.item]);
  assert.equal(Object.keys(player).some((key) => key.includes('trace')), false, 'runtime trace is not saved');
});

test('a full equipment carrier merges eligible worn materials before replacement and keeps the selected unrelated slot', () => {
  const player = fixture();
  const worn = item(100000001, HAMMER), keep = item(100000002, SHIELD), incoming = item(100000003, HAMMER);
  player.roster[0].items = [worn, keep]; player.equipmentInventory = [incoming];
  const result = equipMizukiEquipment(player, { itemUid: incoming.uid, targetUid: 10001, replaceUid: keep.uid }, options());
  assert.equal(result.ok, true); assert.equal(result.events.length, 1);
  assert.deepEqual(player.roster[0].items, [keep], 'synthesis does not destroy the replacement candidate');
  assert.equal(player.equipmentInventory[0].id, itemMergeRecipe(HAMMER, (id) => gd.item(id)).upgradeId);
});

test('failed allocation or lack of result space preserves worn and loose materials in place', () => {
  const player = fixture(); player.roster[0].items = [item(100000001, HAMMER)];
  const before = structuredClone(player);
  const failure = grantMizukiEquipment(player, HAMMER, options({ allocateUid: (draft) => ++draft.equipmentSeq === 51 ? 100000051 : 10001 }));
  assert.equal(failure.ok, false); assert.deepEqual(player, before);
  const blocked = fixture();
  blocked.equipmentInventory = Array.from({ length: 4096 }, (_, index) => item(300000000 + index, 'chess_item_5_08_e_a'));
  blocked.roster[0].items = [item(100000001, HAMMER)]; blocked.roster[1].items = [item(100000002, HAMMER)];
  const locked = structuredClone(blocked);
  const result = dispatchMizukiEquipmentMeta(blocked, options({ hook: 'onPrepStart', executionId: 'no-space' }));
  assert.equal(result.ok, true); assert.deepEqual(blocked.roster, locked.roster); assert.deepEqual(blocked.equipmentInventory, locked.equipmentInventory);
  const overflow = grantMizukiEquipment(blocked, SHIELD, options());
  assert.equal(overflow.ok, false); assert.deepEqual(blocked.roster, locked.roster); assert.deepEqual(blocked.equipmentInventory, locked.equipmentInventory);
});

test('a full personal bag still accepts a gain when its existing copy frees the result slot', () => {
  const player = fixture();
  player.equipmentInventory = [item(100000001, HAMMER),
    ...Array.from({ length: 4095 }, (_, index) => item(300000000 + index, 'chess_item_5_08_e_a'))];
  const result = grantMizukiEquipment(player, HAMMER, options());
  assert.equal(result.ok, true); assert.equal(player.equipmentInventory.length, 4096);
  assert.equal(result.item.id, gd.item(HAMMER).goldenId); assert.ok(player.equipmentInventory.some((value) => value.uid === result.item.uid));
});

const command = (match, playerId, message) => {
  const result = match.handle(playerId, message); assert.equal(result.ok, true, JSON.stringify(result)); return result;
};
test('an actual PREP item reward strips its duplicate and immediately rebuilds slots and combat stats', (t) => {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const match = new MizukiMatch({ roomCode: 'MGEQ', hostId: 'p0', seed: 512, data: DATA, scheduler,
    seats: [0, 1].map((seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) }, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); }); match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  const quiet = match.strategyOptions.filter((option) => DATA.bands[option.bandId]?.buffs?.every((buff) => buff.key === 'env_gbuff_new_with_verify'));
  for (const [index, player] of match.order.entries()) command(match, player.playerId, { t: 'g.mizuki.strategy', bandId: quiet[index].bandId });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  const player = match.players.get('p0'); assert.equal(match._addOperator(player, 'chess_char_1_08_a'), true);
  const unit = player.roster[0], reward = grantMizukiEquipment(player, HAMMER, match._equipmentOptions(player));
  command(match, 'p0', { t: 'g.mizuki.equip', itemUid: reward.item.uid, targetUid: unit.uid });
  const node = match.route.find((value) => value.available && value.type === 'combat');
  for (const member of match.order) command(match, member.playerId, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
  const tile = match.privateView('p0').mizuki.prep.legalTiles[unit.uid][0];
  command(match, 'p0', { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' });
  const before = match.fields.get('n:p0').engine, equippedAtk = match.privateView('p0').mizuki.roster[0].loadout.stats.atk;
  const funds = { hope: player.hope, gold: player.gold };
  const other = structuredClone(match.players.get('p1'));
  player.equipmentOffers = [{ id: 'duplicate-item', kind: 'item', choices: [HAMMER], source: 'item:test', createdRound: 1, pick: 1, grantOpts: {} }];
  command(match, 'p0', { t: 'g.mizuki.equipmentPick', offerId: 'duplicate-item', itemId: HAMMER });
  const view = match.privateView('p0').mizuki;
  assert.notEqual(match.fields.get('n:p0').engine, before);
  assert.deepEqual(view.equipment.equipped[0].items, []); assert.equal(view.equipment.inventory.length, 1);
  assert.equal(view.equipment.inventory[0].id, gd.item(HAMMER).goldenId);
  assert.ok(view.roster[0].loadout.stats.atk < equippedAtk, 'detached material stops contributing immediately');
  command(match, 'p0', { t: 'g.mizuki.equip', itemUid: view.equipment.inventory[0].uid, targetUid: unit.uid });
  const upgraded = match.privateView('p0').mizuki;
  assert.equal(upgraded.equipment.equipped[0].items.length, 1);
  assert.ok(upgraded.roster[0].loadout.stats.atk > equippedAtk, 'the actual advanced item effect applies when equipped');
  assert.deepEqual({ hope: player.hope, gold: player.gold }, funds);
  assert.deepEqual(match.players.get('p1'), other);
  assert.deepEqual(errors, []);
});
