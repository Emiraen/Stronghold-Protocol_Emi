import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniteSurvivors, uniteRemainingLeaks } from '../../server/match/unite.js';
import { uniteLeft, compactResult } from '../../server/sim/spec.js';

test('unite: runtime split leaks keep attribution but never increase settlement LP or the next wave', () => {
  const original = { enemyKey: 'enemy_1195_sfyin', counted: true, sourcePlayerId: 'p1', mods: {} };
  const child = { ...original, enemyKey: 'enemy_child', uniteRuntime: true };
  const plan = { leaked: [original], notReentered: new Map(), leakers: [{ playerId: 'p1' }] };
  const result = { perPlayer: { p2: { leaked: [original, child, child] } }, unspawned: [] };
  assert.equal(uniteSurvivors(plan, result).get('p1'), 1);
  assert.deepEqual(uniteRemainingLeaks(plan, result).map((l) => l.enemyKey), [original.enemyKey]);
  const compact = compactResult(result);
  assert.equal(compact.perPlayer.p2.leaked.filter((l) => l.uniteRuntime).length, 2, 'transport retains the billing flag');
  assert.equal(uniteSurvivors(plan, compact).get('p1'), 1);
  assert.equal(uniteLeft({ finished: true, result: () => compact }).p1, 1);
});

test('unite: a runtime-only survivor costs no LP; scheduled and never-reentered leaks still count', () => {
  const child = { enemyKey: 'enemy_child', counted: true, sourcePlayerId: 'p1', uniteRuntime: true };
  const plan = { leaked: [], notReentered: new Map(), leakers: [{ playerId: 'p1' }] };
  const result = { perPlayer: { p2: { leaked: [child] } }, unspawned: [] };
  assert.equal(uniteSurvivors(plan, result).get('p1') || 0, 0);
  assert.deepEqual(uniteRemainingLeaks(plan, result), []);
  result.unspawned.push({ enemyKey: 'enemy_original', sourcePlayerId: 'p1' });
  plan.notReentered.set('p1', 2);
  assert.equal(uniteSurvivors(plan, result).get('p1'), 3);
});
