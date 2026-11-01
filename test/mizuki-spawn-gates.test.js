import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage } from '../server/modes/mizuki/official-stages.js';

const original = JSON.parse(readFileSync(new URL('../data/mizuki/levels/level_rogue2_1-1.json', import.meta.url), 'utf8'));
const pair = (position) => [position.row, position.col];

test('production Mizuki auto combat spawns the original 1-1 waves at their source routes and three distinct red gates', (t) => {
  const setup = createOfficialMizukiStage('ro2_n_1_1', { seed: 1 });
  const engine = new MizukiAutoCombat({ ...setup, seed: 1, fieldId: 'spawn-gates', battleId: 'spawn-gates',
    players: [{ playerId: 'p1', units: [] }], content: 'full' });
  t.after(() => engine.forceEnd());
  const observed = [];
  engine.battle.on('enemySpawn', ({ enemy }) => {
    const entry = engine.officialWaves.meta.get(enemy.tag);
    if (!entry || entry.branchKey || entry.action.actionType !== 'SPAWN') return;
    const routeIndex = entry.action.routeIndex;
    const source = original.routes[routeIndex];
    // Read in the spawn event: the same simulation step subsequently moves
    // enemies, which would make a post-step position an invalid spawn check.
    const position = [enemy.y, enemy.x];
    assert.deepEqual(position, pair(source.startPosition), 'route ' + routeIndex + ': original spawn position');
    assert.deepEqual(setup.routes[routeIndex].end, pair(source.endPosition));
    const moves = enemy.route.legs.filter((leg) => leg.t === 'move' || leg.t === 'appear');
    const expectedMoves = (source.checkpoints || []).filter((cp) => cp.type === 'MOVE' || cp.type === 'APPEAR_AT_POS')
      .map((cp) => pair(cp.position));
    assert.deepEqual(moves.slice(0, -1).map((leg) => [leg.r, leg.c]), expectedMoves,
      'route ' + routeIndex + ': original checkpoint positions');
    const end = moves.at(-1);
    assert.deepEqual([end.r, end.c], pair(source.endPosition), 'route ' + routeIndex + ': original blue objective');
    assert.equal(end.final, true);
    observed.push({ time: engine.time, routeIndex, position, tile: engine.battle.grid.tile(...position).key });
  });
  while (!engine.done && engine.time < 60) engine.step();
  assert.equal(engine.battle.errorCount, 0);
  for (const [time, routeIndex, position] of [[3, 12, [5, 1]], [12, 13, [1, 0]], [59, 18, [4, 8]]]) {
    const spawn = observed.find((value) => value.routeIndex === routeIndex && Math.abs(value.time - time) < engine.dt + 1e-9);
    assert.ok(spawn, 'original action route ' + routeIndex + ' spawns at ' + time + ' seconds');
    assert.deepEqual(spawn.position, position);
    assert.equal(spawn.tile, 'tile_start');
  }
  const preplaced = observed.find((value) => value.routeIndex === 10);
  assert.ok(preplaced, 'seed 1 retains the original random preplaced diver');
  assert.deepEqual(preplaced.position, [2, 3]);
  assert.equal(preplaced.time, 0);
  assert.notEqual(preplaced.tile, 'tile_start', 'do not relocate the original preplaced enemy to a red gate');
  assert.ok(observed.length >= 14, 'run the actual wave scheduler through the third red-gate action');
});

test('official route start, checkpoint and endpoint coordinates remain unchanged when adapted for auto combat', () => {
  const setup = createOfficialMizukiStage('ro2_n_1_1', { seed: 1 });
  for (let index = 0; index < original.routes.length; index++) {
    const source = original.routes[index], route = setup.routes[index];
    assert.deepEqual(route.start, pair(source.startPosition), 'route ' + index + ': start');
    assert.deepEqual(route.end, pair(source.endPosition), 'route ' + index + ': end');
    assert.deepEqual(route.checkpoints.map((cp) => cp.pos), (source.checkpoints || []).map((cp) => pair(cp.position)),
      'route ' + index + ': checkpoints');
    assert.deepEqual(setup.officialLevel.routes[index], route);
  }
});
