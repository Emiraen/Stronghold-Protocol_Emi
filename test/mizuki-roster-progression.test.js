import test from 'node:test';
import assert from 'node:assert/strict';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { canDismissMizukiOperator, dismissMizukiOperator, preserveMizukiEquipment,
  validMizukiRosterProgression, mizukiEquipmentView } from '../server/modes/mizuki/RosterProgression.js';
import { validMizukiPrep } from '../server/modes/mizuki/Prep.js';

const item = (uid, id = 'item_test') => ({ uid, id, kind: 'item', meta: { round: { r: 3, n: { equipped: 1 } } } });
const unit = (uid, operatorId = 'test_a', items = []) => ({ uid, operatorId, chessId: operatorId, promotion: 0, items });
function fixture() {
  return { playerId: 'p1', seat: 0, hope: 3, ready: true,
    roster: [unit(10001, 'test_a', [item(30001), item(30002, 'item_second')]), unit(10002, 'test_b')],
    lineup: [10001, 10002], equipmentInventory: [item(30003, 'item_bag')],
    prep: { hand: [null, 10001, ...Array(8).fill(null)], temp: [1000001, ...Array(4).fill(null)],
      board: [{ uid: 10002, row: 10, col: 4, dir: 'RIGHT' }, { uid: 1000002, row: 10, col: 5, dir: 'RIGHT' }],
      tokens: [{ uid: 1000001, kind: 'token', id: 'token_a', ownerUid: 10001, count: 2, items: [] },
        { uid: 1000002, kind: 'token', id: 'token_a', ownerUid: 10001, count: 1, items: [] }], tokenSeq: 2 } };
}

test('promotion retains the same operator and full persistent equipment instances', () => {
  const player = fixture(), previous = player.roster[0], before = structuredClone(previous);
  const next = preserveMizukiEquipment(previous, { ...unit(10009, 'test_a'), promotion: 1, chessId: 'test_a_golden' });
  assert.equal(next.uid, 10001); assert.equal(next.promotion, 1);
  assert.deepEqual(next.items, previous.items); assert.notEqual(next.items, previous.items);
  next.items[0].meta.round.n.equipped++;
  assert.deepEqual(previous, before);
  assert.deepEqual(preserveMizukiEquipment(null, unit(10003, 'test_c')).items, []);
  assert.throws(() => preserveMizukiEquipment(previous, unit(10001, 'different')), TypeError);
  assert.throws(() => preserveMizukiEquipment({ ...previous, items: ['item_test'] }, previous), TypeError);
});

test('lineup removal and public/private equipment views keep equipment on the roster', () => {
  const player = fixture(), items = structuredClone(player.roster[0].items);
  player.lineup = [10002];
  const publicView = mizukiEquipmentView(player), privateView = mizukiEquipmentView(player, { includeInventory: true });
  assert.deepEqual(player.roster[0].items, items);
  assert.deepEqual(publicView.equipped[0], { uid: 10001, items });
  assert.equal(Object.hasOwn(publicView, 'inventory'), false);
  assert.deepEqual(privateView.inventory, player.equipmentInventory);
  privateView.equipped[0].items[0].id = 'changed'; privateView.inventory.length = 0;
  assert.equal(player.roster[0].items[0].id, 'item_test'); assert.equal(player.equipmentInventory.length, 1);
});

test('dismissal allows explicit safe phases and only post-combat preparation', () => {
  for (const phase of [PHASE.ROUTE, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP, PHASE.RECRUIT]) {
    assert.equal(canDismissMizukiOperator({ phase }), true);
  }
  for (const phase of [PHASE.SQUAD, PHASE.COMBAT, PHASE.RESULT, PHASE.STRATEGY, PHASE.RECRUIT_GROUP, 'UNKNOWN', undefined]) {
    assert.equal(canDismissMizukiOperator({ phase, completedNodes: 1 }), false);
  }
  assert.equal(canDismissMizukiOperator({ phase: PHASE.PREP, completedNodes: 0 }), false);
  assert.equal(canDismissMizukiOperator({ phase: PHASE.PREP, completedNodes: 1 }), true);
  const player = fixture(), before = structuredClone(player);
  assert.equal(dismissMizukiOperator(player, 10001, { phase: PHASE.COMBAT }).error, 'BAD_PHASE');
  assert.equal(dismissMizukiOperator(player, 10001, { phase: PHASE.PREP, completedNodes: 0 }).error, 'BAD_PHASE');
  assert.deepEqual(player, before);
});

test('dismissal returns every item once and removes operator and owned summons from every prep area', () => {
  const player = fixture(), oldItems = structuredClone(player.roster[0].items);
  assert.equal(validMizukiPrep(player.prep, player), true);
  const result = dismissMizukiOperator(player, 10001, { phase: PHASE.PREP, completedNodes: 1, actorId: 'p1', requestId: 'dismiss-1' });
  assert.equal(result.ok, true); assert.equal(result.hopeRefund, 1); assert.equal(player.hope, 4); assert.equal(player.ready, false);
  assert.deepEqual(player.roster.map((entry) => entry.uid), [10002]); assert.deepEqual(player.lineup, [10002]);
  assert.deepEqual(player.equipmentInventory.slice(1), oldItems); assert.deepEqual(result.returnedItems, oldItems);
  assert.equal(player.prep.hand.every((id) => id === null), true); assert.equal(player.prep.temp.every((id) => id === null), true);
  assert.deepEqual(player.prep.board.map((place) => place.uid), [10002]); assert.deepEqual(player.prep.tokens, []);
  assert.equal(validMizukiPrep(player.prep, player), true); assert.equal(validMizukiRosterProgression(player), true);
  result.returnedItems[0].id = 'changed'; assert.equal(player.equipmentInventory[1].id, 'item_test');
  const after = structuredClone(player);
  assert.equal(dismissMizukiOperator(player, 10001).error, 'BAD_TARGET');
  assert.equal(dismissMizukiOperator(player, 10002, { requestId: 'dismiss-1' }).error, 'BAD_TARGET');
  assert.deepEqual(player, after);
});

test('dismissal rejects foreign actors and invalid targets without changing state', () => {
  const player = fixture(), before = structuredClone(player);
  for (const [uid, options] of [[10001, { actorId: 'p2' }], [20001, {}], ['10001', {}], [10001, { requestId: '' }], [10001, { hopeRefund: -1 }]]) {
    assert.equal(dismissMizukiOperator(player, uid, options).ok, false); assert.deepEqual(player, before);
  }
  player.hope = 9999;
  assert.equal(dismissMizukiOperator(player, 10001).ok, false); assert.equal(player.hope, 9999); assert.equal(player.roster.length, 2);
});

test('duplicate item ownership or malformed prep rejects the whole transaction', () => {
  const player = fixture(); player.equipmentInventory.push(structuredClone(player.roster[0].items[0]));
  const before = structuredClone(player);
  assert.equal(dismissMizukiOperator(player, 10001).ok, false); assert.deepEqual(player, before);
  const badPrep = fixture(); badPrep.prep.hand = null;
  const beforePrep = structuredClone(badPrep);
  assert.equal(dismissMizukiOperator(badPrep, 10001).ok, false); assert.deepEqual(badPrep, beforePrep);
  const badBoard = fixture(); badBoard.prep.board.push(null);
  const beforeBoard = structuredClone(badBoard);
  assert.equal(dismissMizukiOperator(badBoard, 10001).ok, false); assert.deepEqual(badBoard, beforeBoard);
});

test('an equipment bag at its safety limit rejects dismissal rather than losing equipment', () => {
  const player = fixture(); player.equipmentInventory = Array.from({ length: 4096 }, (_, i) => item(40000 + i));
  const before = structuredClone(player);
  assert.equal(dismissMizukiOperator(player, 10001).error, 'HAND_FULL'); assert.deepEqual(player, before);
});

test('checkpoint validation rejects bare IDs, duplicate UID, nonfinite metadata and unknown equipment', () => {
  const valid = fixture();
  assert.equal(validMizukiRosterProgression(JSON.parse(JSON.stringify(valid))), true);
  const checks = [
    (p) => { p.roster[0].items = ['item_test']; },
    (p) => { p.roster[0].items[0].uid = 10002; },
    (p) => { p.roster[0].items[0].uid = 1000001; },
    (p) => { p.roster[0].items[0].meta.invalid = Infinity; },
    (p) => { p.roster[0].items[0].kind = 'chess'; },
    (p) => { p.equipmentInventory = {}; },
    (p) => { p.prep.tokens = {}; },
    (p) => { p.prep.tokens = [null]; },
    (p) => { p.rosterRequestIds = ['same', 'same']; },
    (p) => { p.roster.push(structuredClone(p.roster[0])); },
  ];
  for (const corrupt of checks) { const p = fixture(); corrupt(p); assert.equal(validMizukiRosterProgression(p), false); }
  assert.equal(validMizukiRosterProgression(valid, { itemExists: () => false }), false);
  assert.equal(validMizukiRosterProgression(valid, { itemExists: (id) => id.startsWith('item_') }), true);
  assert.equal(validMizukiRosterProgression({ roster: [unit(10001)] }), true);
});

test('checkpoint item UID collection is atomic and catches foreign equipment or unit collisions', () => {
  const player = fixture(), seenItemUids = new Set([90001]);
  assert.equal(validMizukiRosterProgression(player, { seenItemUids, reservedUids: new Set([10001, 10002]) }), true);
  assert.deepEqual([...seenItemUids].sort((a, b) => a - b), [30001, 30002, 30003, 90001]);
  const before = new Set(seenItemUids);
  assert.equal(validMizukiRosterProgression(player, { seenItemUids }), false); assert.deepEqual(seenItemUids, before);
  assert.equal(validMizukiRosterProgression(player, { reservedUids: new Set([30001]) }), false);
  const another = fixture(); another.roster[0].items[1].id = '';
  const empty = new Set(); assert.equal(validMizukiRosterProgression(another, { seenItemUids: empty }), false); assert.equal(empty.size, 0);
});

test('request history and all equipment survive JSON checkpoint round trip after dismissal', () => {
  const player = fixture();
  assert.equal(dismissMizukiOperator(player, 10001, { requestId: 'stable-id', phase: PHASE.ROUTE }).ok, true);
  const restored = JSON.parse(JSON.stringify(player));
  assert.equal(validMizukiRosterProgression(restored), true);
  assert.deepEqual(restored.equipmentInventory.map((entry) => entry.uid).sort((a, b) => a - b), [30001, 30002, 30003]);
  assert.equal(dismissMizukiOperator(restored, 10002, { requestId: 'stable-id' }).ok, false);
  assert.equal(restored.roster.length, 1); assert.equal(restored.hope, 4);
});
