import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRange } from '../public/js/screens/game/range.js';
import { rangeTiles } from '../public/js/ui/facing.js';
import { MIZUKI_PREP_SHIFT } from '../public/js/mizukiPrep.js';

const chess = { id: 'op', chessId: 'op', rangeGrid: [[0, 0], [0, 1]] };
const detail = { type: 'chess', chess };

test('Mizuki prep uses its bench shift once; combat uses the live tuple with no bench shift', () => {
  const piece = { uid: 7, dir: 'UP' };
  const prep = inspectRange({ target: { kind: 'piece', uid: 7 }, detail, showPrep: true,
    pieces: new Map([[7, { area: 'board', row: 1 + MIZUKI_PREP_SHIFT, col: 4, piece }]]) });
  const combat = inspectRange({ target: { kind: 'unit', unit: { id: 3, side: 'ally', kind: 'op', x: 4, y: 1, dir: 'UP' } },
    detail, field: {}, snapshot: [3, 4, 1, 500, 500], live: { range: [[0, 0], [0, 1], [0, 2]] } });
  assert.equal(prep.row, 3); assert.equal(combat.row, 1);
  assert.deepEqual(rangeTiles(prep.grid, prep.row, prep.col, prep.dir), [[3, 4], [4, 4]]);
  assert.deepEqual(rangeTiles(combat.grid, combat.row, combat.col, combat.dir), [[1, 4], [2, 4], [3, 4]]);
});

test('live movement, rotation and bottom battle row are shown; removed units have no range', () => {
  const target = { kind: 'unit', unit: { id: 3, side: 'ally', kind: 'op', x: 9, y: 8, dir: 'RIGHT' } };
  const range = inspectRange({ target, detail, field: {}, snapshot: [3, 5.02, 0.03, 300, 500], live: { dir: 'LEFT', range: [[0, 0], [0, 1]] } });
  assert.deepEqual(rangeTiles(range.grid, range.row, range.col, range.dir), [[0, 5], [0, 4]]);
  assert.equal(inspectRange({ target, detail, field: {}, snapshot: [3, 5, 0, 0, 500] }), null);
  assert.equal(inspectRange({ target, detail, field: {}, snapshot: null }), null);
});
