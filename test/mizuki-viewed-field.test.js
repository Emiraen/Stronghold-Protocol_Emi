import test from 'node:test';
import assert from 'node:assert/strict';
import { mizukiViewedPrep, mizukiViewedPhase, adaptMizukiFieldScope } from '../public/js/mizukiViewedField.js';
import { mizukiPrepRenderState } from '../public/js/mizukiPrep.js';
import { createMizukiBattlePresentation } from '../public/js/mizukiBattlePresentation.js';

const piece = (uid, row = 0) => ({ uid, id: 'same-operator', row, col: 1 });
const privatePrep = { hand: [piece(1)], temp: [piece(2)], supplies: [piece(3)], board: [piece(4)] };
const publicFields = [
  { fieldId: 'own', boards: [{ playerId: 'p1', board: [piece(4)] }] },
  { fieldId: 'other', boards: [{ playerId: 'p2', board: [piece(5)] }] },
  { fieldId: 'boss', boards: [{ playerId: 'p1', board: [piece(4)] }, { playerId: 'p2', board: [piece(5)] }] },
  { fieldId: 'foreign-boss', boards: [{ playerId: 'p2', board: [piece(5)] }, { playerId: 'p3', board: [piece(6)] }] },
  { fieldId: 'empty', boards: [{ playerId: 'p2', board: [] }] },
];
const viewedPrep = (fieldId, ownFieldId = 'own') => mizukiViewedPrep(privatePrep, { fieldId, ownFieldId, playerId: 'p1', fields: publicFields });

test('watching another field excludes all own private pieces and keeps the watched board only', () => {
  const { prep, peerBoards } = viewedPrep('other');
  assert.deepEqual(prep.hand, []);
  assert.deepEqual(prep.temp, []);
  assert.deepEqual(prep.supplies, []);
  assert.deepEqual(peerBoards, []);
  assert.deepEqual(prep.board.map(unit => unit.uid), [5]);
  assert.deepEqual(mizukiPrepRenderState(prep, peerBoards).board, [piece(5, 2)]);
  assert.deepEqual(privatePrep.board, [piece(4)], 'view preparation does not move the private board');
  assert.equal(viewedPrep('own').prep, privatePrep);
  assert.deepEqual(viewedPrep('own').peerBoards, []);
});

test('Boss partners share their real field while foreign and empty fields never fall back to the own board', () => {
  const ownBoss = viewedPrep('boss', 'boss');
  assert.equal(ownBoss.prep, privatePrep);
  assert.deepEqual(ownBoss.peerBoards.map(unit => unit.uid), [5]);
  assert.deepEqual(mizukiPrepRenderState(ownBoss.prep, ownBoss.peerBoards).board.map(unit => unit.uid), [4, 5]);
  assert.deepEqual(viewedPrep('foreign-boss').prep.board.map(unit => unit.uid), [5, 6]);
  assert.deepEqual(viewedPrep('empty').prep.board, []);
  assert.deepEqual(viewedPrep('not-published').prep.board, []);
});

test('the viewed branch decides preparation or combat independently of the local branch', () => {
  const expedition = { parties: [{ id: 'preparing', phase: 'PREP' }, { id: 'fighting', phase: 'COMBAT' }] };
  assert.equal(mizukiViewedPhase({ partyId: 'preparing' }, expedition, 'COMBAT'), 'PREP');
  assert.equal(mizukiViewedPhase({ partyId: 'fighting' }, expedition, 'PREP'), 'COMBAT');
  assert.equal(mizukiViewedPhase({ phase: 'COMBAT', partyId: 'preparing' }, expedition, 'PREP'), 'COMBAT');
  assert.equal(mizukiViewedPhase({ done: true }, expedition, 'PREP'), 'COMBAT');
});

test('a persistent renderer rejects old field and battle packets even if their unit ids match', () => {
  const calls = [];
  const raw = adaptMizukiFieldScope({
    enterBattle: value => { calls.push(['enter', value]); return true; },
    setPrep: value => { calls.push(['prep', value]); return true; },
    pushEvents: value => { calls.push(['events', value]); return true; },
    pushSnapshot: value => { calls.push(['snapshot', value]); return true; },
  });
  const old = { fieldId: 'own', battleId: 'battle-a', units: [[1, 0, 0]] };
  const watched = { fieldId: 'other', battleId: 'battle-b', units: [[1, 4, 4]] };
  assert.equal(raw.pushSnapshot(old), false);
  raw.enterBattle(old);
  assert.equal(raw.pushSnapshot(old), true);
  raw.enterBattle(watched);
  const before = calls.length;
  for (const packet of [old, { ...watched, battleId: 'previous-battle' }, { ...watched, battleId: undefined }, { ...watched, fieldId: undefined }]) {
    assert.equal(raw.pushSnapshot(packet), false);
    assert.equal(raw.pushEvents({ ...packet, ev: [['spawn', { id: 1 }]] }), false);
  }
  assert.equal(calls.length, before, 'rejected frames never reach the renderer or facility adapters');
  assert.equal(raw.pushSnapshot(watched), true);
  assert.equal(raw.pushEvents({ ...watched, ev: [['spawn', { id: 1 }]] }), true);
  raw.enterBattle({ ...watched, battleId: 'battle-c' });
  assert.equal(raw.pushSnapshot(watched), false, 'the same field in its next node has a new battle scope');
  raw.setPrep({ fieldId: 'other', battleId: 'battle-c', hand: [], board: [] });
  assert.equal(raw.pushEvents({ ...watched, battleId: 'battle-c', ev: [['spawn', { id: 1 }]] }), false);
});

test('split combat frames retain the own pending result and drop a departed watched field', t => {
  const controller = createMizukiBattlePresentation();
  t.after(() => controller.reset());
  const own = { fieldId: 'own', battleId: 'a' }, other = { fieldId: 'other', battleId: 'b' };
  const props = { myId: 'p1', ownFieldId: 'own', phase: 'COMBAT', model: { currentNode: { id: 'node' }, fields: [own, other] } };
  controller.present({}, props);
  controller.present({}, { ...props, model: { ...props.model, fields: [] } });
  assert.deepEqual(controller.get().props.model.fields, [own]);
  const nextOwn = { ...own, battleId: 'next-node' };
  controller.present({}, { ...props, model: { ...props.model, fields: [nextOwn] } });
  assert.deepEqual(controller.get().props.model.fields, [nextOwn]);
});
