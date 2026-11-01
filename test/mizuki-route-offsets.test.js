import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateOfficialRoute } from '../server/modes/mizuki/official-stages.js';
import { normalizeRoute } from '../server/sim/simdata.js';
import { compileRoute, updateEnemy, remainingDistance } from '../server/sim/ai.js';
import { remainingRoute } from '../server/sim/content/enemies/helpers.js';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';

test('native checkpoint offsets survive repeated normalization, path planning and summoned children', t => {
  const level = JSON.parse(readFileSync(new URL('../data/mizuki/levels/level_rogue2_1-1.json', import.meta.url)));
  const raw = level.routes[14], converted = translateOfficialRoute(raw);
  const cp = raw.checkpoints.findIndex(c => c.reachOffset?.y);
  assert.ok(cp >= 0);
  assert.deepEqual(converted.checkpoints[cp].offset, [raw.checkpoints[cp].reachOffset.y, raw.checkpoints[cp].reachOffset.x]);
  const route = normalizeRoute(normalizeRoute({ motion: 'WALK', start: [2, 1], end: [2, 5], checkpoints: [
    { type: 'MOVE', pos: [2, 3], offset: [0.14, -0.2] }, { type: 'WAIT', time: 10 },
  ] }));
  assert.deepEqual(compileRoute(route)[0], { t: 'move', r: 2.14, c: 2.8, tileR: 2, tileC: 3 });
  const c = new MizukiCombat({ stage: { id: 'offset-test', rows: Array(19).fill('r'.repeat(21)) },
    rect: { r0: 0, r1: 5, c0: 0, c1: 6 }, players: [{ playerId: 'p1', units: [] }], spawns: [] });
  t.after(() => c.forceEnd());
  const e = c.battle.spawnEnemy('enemy_1007_slime', { route });
  e.profile.noAttack = true;
  for (let i = 0; i < 600 && e.route.legIdx === 0; i++) updateEnemy(c.battle, e, 1 / 30);
  assert.ok(Math.abs(e.x - 2.8) < 1e-9); assert.ok(Math.abs(e.y - 2.14) < 1e-9);
  assert.ok(e.route.waitLeft > 0); assert.ok(Number.isFinite(remainingDistance(c.battle, e)));
  e.route.legIdx = 0; e.route.waitLeft = null;
  const child = normalizeRoute(remainingRoute(e));
  assert.deepEqual(compileRoute(child)[0], compileRoute(route)[0]);
  assert.equal(c.battle.errorCount, 0);
});

test('routes without offsets retain their existing integer legs', () => {
  assert.deepEqual(compileRoute({ checkpoints: [{ type: 'MOVE', pos: [2, 3] }], end: [4, 5] }),
    [{ t: 'move', r: 2, c: 3 }, { t: 'move', r: 4, c: 5, final: true }]);
});
