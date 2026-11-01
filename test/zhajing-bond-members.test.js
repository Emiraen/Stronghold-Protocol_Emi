import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bondMembers, memberHeadCount } from '../public/js/ui/gameLogic/bonds.js';
import { rebuildZhajingBondMembers } from '../tools/rebuild-zhajing-bond-members.mjs';

const read = file => JSON.parse(fs.readFileSync(new URL('../data/' + file, import.meta.url), 'utf8'));
const chess = read('zhajing/chess.json');
const bonds = read('zhajing/bonds.json');
const roster = Object.values(chess).filter(c => c?.zhajing && !c.isGolden && !c.isHidden && !c.isDiy);
const getChess = id => chess[id] || null;

for (const bond of Object.values(bonds)) test(`${bond.name}: displayed members match the actual 炸惊 roster`, () => {
  const expected = roster.filter(c => c.bonds.includes(bond.bondId)).map(c => c.chessId).sort();
  const rows = bondMembers(bond, { board: [], hand: [], temp: [] }, [], getChess);
  assert.deepEqual(rows.map(r => r.id).sort(), expected);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  assert.ok(rows.every(r => getChess(r.id)?.zhajing && !getChess(r.id).isGolden));
});

test('岁 and 医师 show actual owned, deployed and elite members once', () => {
  for (const id of ['suiShip', 'physicianShip', 'penguinShip']) {
    const bond = bonds[id];
    const first = chess[bond.members[0]];
    const second = chess[bond.members[1]];
    const piece = c => ({ kind: 'chess', id: c.chessId, items: [] });
    const priv = { board: [piece(first), piece(chess[first.goldenId])], hand: [piece(second)], temp: [] };
    const rows = bondMembers(bond, priv, [], getChess);
    assert.equal(rows.filter(r => r.onBoard).length, 1);
    assert.equal(rows.filter(r => r.owned).length, 2);
    assert.equal(memberHeadCount(rows, bond.countsHand), bond.countsHand ? 2 : 1);
  }
  assert.equal(bonds.suiShip.members.length, 6);
  assert.equal(bonds.physicianShip.members.length, 4);
  assert.equal(bonds.penguinShip.members.length, 5);
  assert.ok(bonds.suiShip.members.includes('chess_zj_chyue_a'), 'strategy-only 重岳 remains discoverable');
});

test('membership repair preserves every gameplay field and does not mutate normal data', () => {
  const normal = read('bonds.json');
  const snapshot = JSON.stringify(normal);
  const result = rebuildZhajingBondMembers(normal, chess);
  assert.equal(JSON.stringify(normal), snapshot);
  for (const id of Object.keys(normal)) {
    const { members: oldMembers, visibleMembers: oldVisible, ...oldRules } = normal[id];
    const { members: newMembers, visibleMembers: newVisible, ...newRules } = result[id];
    assert.deepEqual(newRules, oldRules);
  }
  assert.equal(bonds.suntShip.countMode, 'BOARD_ALL_CHESS');
  assert.deepEqual(bonds.suntShip.members, []);
  assert.deepEqual(bonds.emptyShip.members, []);
});
