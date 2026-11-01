import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBattleSpec, uniteLeft } from '../../server/sim/spec.js';
import { validateClientResult } from '../../server/match/fields.js';
import { uniteSurvivors, uniteRemainingLeaks } from '../../server/match/unite.js';
import { GameData } from '../../server/match/gamedata.js';
import { DATA } from './harness.js';

const gd = new GameData(DATA, 'mode_multi_hard');
const parent = 'enemy_1195_sfyin', child = 'enemy_1196_msfyin';
const spec = buildBattleSpec({ battleId: 'child-leak', fieldId: 'u', kind: 'unite', seed: 1, round: 5, timeLimit: 60,
  players: [{ playerId: 'helper', units: [], bonds: {} }],
  spawns: [{ enemyKey: parent, count: 1, time: 0, sourcePlayerId: 'leaker', mods: {} }],
  flags: { layerGainsEnabled: false } });
const raw = (leaked) => ({ reason: 'timeout', time: 60, killed: 0, total: 1, errors: 0,
  perPlayer: { helper: { killed: 0, total: 1, leaked, perfect: false, layerGains: {}, coins: 0,
    damageDealt: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [] } } });
const leak = (enemyKey, extra = {}) => ({ enemyKey, sourcePlayerId: 'leaker', counted: true, ...extra });

test('scheduled frequency children are exempt in active HUD, escaped results, unspawned and repeated unite waves', () => {
  const plan = { leaked: [leak(child), leak(parent)], notReentered: new Map(), leakers: [{ playerId: 'leaker' }] };
  const result = { perPlayer: { helper: { leaked: [leak(child), leak(parent)] } }, unspawned: [leak('enemy_1204_msfhu')] };
  assert.equal(uniteSurvivors(plan, result).get('leaker'), 1);
  assert.deepEqual(uniteRemainingLeaks(plan, result).map((l) => l.enemyKey), [parent]);
  assert.deepEqual(uniteLeft({ finished: true, result: () => result }), { leaker: 1 });
  assert.deepEqual(uniteLeft({ _perPlayer: {}, _pending: [leak(child)],
    enemies: [{ defId: child, sourcePlayerId: 'leaker', alive: true, counted: true },
      { defId: parent, sourcePlayerId: 'leaker', alive: true, counted: true }] }), { leaker: 1 });
});

test('validated unite split children keep their exemption without trusting client billing flags', () => {
  const checked = validateClientResult(spec, raw([leak(child), leak(child)]), { gd });
  assert.ok(checked.ok, checked.reason);
  assert.ok(checked.result.perPlayer.helper.leaked.every((l) => l.uniteRuntime === true));
  const plan = { leaked: [leak(parent)], notReentered: new Map(), leakers: [{ playerId: 'leaker' }] };
  assert.equal(uniteSurvivors(plan, checked.result).get('leaker') || 0, 0);
  assert.deepEqual(uniteRemainingLeaks(plan, checked.result), []);
  assert.deepEqual(uniteLeft({ finished: true, result: () => checked.result }), {});
  const forged = validateClientResult(spec, raw([leak(parent, { uniteRuntime: true })]), { gd });
  assert.ok(forged.ok, forged.reason);
  assert.equal(forged.result.perPlayer.helper.leaked[0].uniteRuntime, undefined);
  assert.equal(uniteSurvivors(plan, forged.result).get('leaker'), 1);
});
