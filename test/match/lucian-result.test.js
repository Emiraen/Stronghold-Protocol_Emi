import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specBounds, validateClientResult } from '../../server/match/fields.js';

test('Lucian scripted phantoms count as bounded derived kills, not scheduled HUD enemies', () => {
  const enemies = { enemy_2016_csphtm: {}, enemy_2017_csphts: {}, enemy_1007_slime: {} };
  const gd = { enemy: (key) => enemies[key] || null };
  const spec = { kind: 'boss', round: 14, timeLimit: 120,
    players: [{ playerId: 'p', units: [] }],
    spawns: [{ enemyKey: 'enemy_2016_csphtm', count: 1, tag: 'boss' }], flags: {} };
  const raw = { reason: 'cleared', time: 30,
    perPlayer: { p: { killed: 17, total: 1, leaked: [], perfect: true, coins: 0, layerGains: {}, unitsEnd: [] } } };
  const bounds = specBounds(spec, gd);
  assert.ok(bounds.derived.has('enemy_2017_csphts'));
  assert.equal(validateClientResult(spec, raw, { gd }).ok, true);
  const excess = structuredClone(raw);
  excess.perPlayer.p.killed = bounds.maxTotal + 1;
  assert.equal(validateClientResult(spec, excess, { gd }).reason, 'counts');
  const ordinary = { ...spec, kind: 'normal', spawns: [{ enemyKey: 'enemy_1007_slime', count: 1 }] };
  assert.equal(validateClientResult(ordinary, raw, { gd }).reason, 'counts');
  const missingChild = { enemy: (key) => key === 'enemy_2016_csphtm' ? {} : null };
  assert.equal(validateClientResult(spec, raw, { gd: missingChild }).reason, 'counts');
});
