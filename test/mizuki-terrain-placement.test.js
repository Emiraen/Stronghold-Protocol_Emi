import test from 'node:test';
import assert from 'node:assert/strict';
import { mizukiTerrainAllows } from '../shared/mizukiPlacement.js';
import { mizukiPrepLegal, moveMizukiPrep, syncMizukiPrep } from '../server/modes/mizuki/Prep.js';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { Grid } from '../server/sim/grid.js';
import { getDefaultSource } from '../server/sim/simdata.js';
import { mizukiCanPlace, MIZUKI_PREP_SHIFT } from '../public/js/mizukiPrep.js';

const rect = { r0: 1, r1: 3, c0: 1, c1: 5 };
const stage = { id: 'terrain', rows: Array(19).fill('r'.repeat(21)) };
const source = getDefaultSource();
const ranged = source.getChess('chess_char_1_01_a');

test('Mizuki terrain respects build masks and explicit all-terrain exceptions', () => {
  for (const height of ['LOW', 'HIGH']) {
    assert.equal(mizukiTerrainAllows({ position: 'RANGED' }, { build: 'MELEE', height }), false);
    assert.equal(mizukiTerrainAllows({ position: 'MELEE' }, { build: 'RANGED', height }), false);
    assert.equal(mizukiTerrainAllows({ position: 'RANGED' }, { build: 'RANGED', height }), true);
    assert.equal(mizukiTerrainAllows({ position: 'MELEE' }, { build: 'MELEE', height }), true);
  }
  for (const build of ['MELEE', 'RANGED', 'ALL']) {
    for (const def of [{ position: 'ALL' }, { position: 'MELEE', subProfessionId: 'hookmaster' }])
      assert.equal(mizukiTerrainAllows(def, { build }), true);
    assert.equal(mizukiTerrainAllows({ position: 'RANGED' }, { build }, true), true);
  }
  assert.equal(mizukiTerrainAllows({ position: 'ALL' }, { build: 'NONE' }, true), false);
});

test('Mizuki prep, swap, fallback and direct deployment reject ranged-on-ground while ordinary Grid is unchanged', t => {
  const grid = new Grid(stage, rect);
  grid.tiles[1 * 21 + 1] = { ...grid.tile(1, 1), build: 'MELEE' };
  grid.tiles[1 * 21 + 2] = { ...grid.tile(1, 2), build: 'RANGED', height: 'HIGH' };
  const player = { playerId: 'p1', seat: 0, roster: [
    { uid: 101, chessId: ranged.id, position: 'RANGED', items: [] },
    { uid: 102, chessId: 'chess_char_1_02_a', position: 'MELEE', items: [] },
  ], lineup: [101, 102] };
  const context = { source, grid, deployLimit: 8, fieldDeployCount: 0 };
  syncMizukiPrep(player, context);
  const move = (uid, col) => moveMizukiPrep(player, uid, { area: 'board', row: 1, col }, 'RIGHT', context);
  assert.equal(move(101, 1).error, 'BAD_TILE');
  assert.equal(move(101, 2).ok, true);
  assert.equal(move(102, 1).ok, true);
  assert.equal(move(101, 1).error, 'BAD_TILE');
  assert.equal(mizukiPrepLegal(player, { uid: 101 }, 1, 1, { ...context, collectibles: ['rogue_2_relic_fight_44'] }), true);
  assert.equal(grid.canStand(1, 1, { ranged: true }), true);
  const c = new MizukiCombat({ stage, rect, data: source, players: [{ playerId: 'p1', units: [{ uid: 101, chessId: ranged.id }] }] });
  t.after(() => c.forceEnd());
  c.battle.grid.tiles[1 * 21 + 1] = { ...c.battle.grid.tile(1, 1), build: 'MELEE' };
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 1, col: 1, dir: 'RIGHT' }).error, 'WRONG_TILE');
  assert.equal(mizukiCanPlace({ hand: [{ uid: 101, position: 'RANGED' }] }, { tiles: [{ row: 1, col: 1, build: 'MELEE' }] },
    101, { area: 'board', row: 1 + MIZUKI_PREP_SHIFT, col: 1 }), false);
});
