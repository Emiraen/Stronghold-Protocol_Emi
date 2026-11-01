import test from 'node:test';
import assert from 'node:assert/strict';
import { mizukiLiveHealth } from '../public/js/mizukiHealth.js';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';

const live = (fields, extra = {}) => mizukiLiveHealth({ fields, playerId: 'p1', health: { life: 10, shield: 2 }, phase: 'COMBAT', ...extra });
const normal = (extra = {}) => ({ fieldId: 'n:p1', partyId: 'party-a', kind: 'normal', players: ['p1'], ...extra });

test('Mizuki normal battle pending life is personal, uses actual objective damage and absorbs shield first', () => {
  const fields = [normal({ objectiveLossByPlayer: { p1: 5, p2: 9 } })];
  assert.deepEqual(live(fields), { lp: 12, pending: 5, unite: false, left: null, shown: 7, shieldPending: 2 });
  assert.equal(live(fields, { health: { life: 10, shield: 8 } }).pending, 5);
  assert.equal(live(fields, { health: { life: 10, shield: 8 } }).shown, 13);
  assert.equal(live(fields, { health: { life: 2, shield: 0 } }).pending, 2);
  assert.equal(live(fields, { playerId: 'unrelated' }).pending, 0);
});

test('Mizuki rescue replaces old leaks, retains native direct loss and unrescued damage, and ignores other parties', () => {
  const original = normal({ active: false, objectiveLossByPlayer: { p1: 99 }, objectiveDirectLossByPlayer: { p1: 2 } });
  const rescue = { fieldId: 'u:party-a', partyId: 'party-a', kind: 'unite', active: true, players: ['helper'],
    objectiveRemainingByPlayer: { p1: 4 }, objectiveUnrescuedByPlayer: { p1: 3 },
    objectiveDirectLossByPlayer: { p1: 1 }, objectiveEnemiesLeftByPlayer: { p1: 2 } };
  const foreign = { ...rescue, fieldId: 'u:party-b', partyId: 'party-b', objectiveRemainingByPlayer: { p1: 1000 } };
  assert.deepEqual(live([original, rescue, foreign]), { lp: 12, pending: 10, unite: true, left: 2, shown: 2, shieldPending: 2 });
  const rescued = { ...rescue, objectiveRemainingByPlayer: {}, objectiveEnemiesLeftByPlayer: {} };
  assert.equal(live([original, rescued]).pending, 6, 'helping kills lower the pending loss without losing direct damage');
});

test('Mizuki settled private health and terminal presentation never apply a pending loss twice', () => {
  const fields = [normal({ objectiveLossByPlayer: { p1: 4 } })];
  for (const extra of [{ finishing: true }, { phase: 'PREP' }, { phase: 'MIZUKI_REWARD' }]) {
    assert.deepEqual(live(fields, { health: { life: 6, shield: 0 }, ...extra }),
      { lp: 6, pending: 0, unite: false, left: null, shown: 6, shieldPending: 0 });
  }
  assert.deepEqual(live(fields, { health: {} }), { lp: null, pending: 0, unite: false, left: null, shown: null, shieldPending: 0 });
});

const combat = (extra = {}) => new MizukiCombat({ battleId: 'health-check', fieldId: 'health-field', seed: 42,
  automatic: true, content: 'none', stageId: 'act1autochess_m02', rect: { r0: 9, r1: 12, c0: 2, c1: 10 },
  players: [{ playerId: 'p1', seat: 0, units: [] }], spawns: [], timeLimit: 180, ...extra });

test('real MizukiCombat objective health combines native direct loss with the original source of a leak', () => {
  const c = combat(), b = c.battle;
  const enemy = b.spawnEnemy('enemy_1007_slime', { pos: [9, 5], ownerPlayerId: 'p1', sourcePlayerId: 'p2', countInTotal: true });
  assert.ok(enemy);
  const damage = enemy.lpr;
  b.leak(enemy);
  b.emit('lpLoss', { amount: 2, source: { ownerId: 'p1' } });
  const snapshot = c.snapshot();
  assert.equal(snapshot.objectiveLossByPlayer.p1, 2);
  assert.equal(snapshot.objectiveLossByPlayer.p2, damage);
  assert.deepEqual(snapshot.objectiveDirectLossByPlayer, { p1: 2 });
  assert.equal(snapshot.objectiveEnemiesLeftByPlayer.p2, 1);
  assert.equal(b.errorCount, 0);
});

test('real MizukiCombat rescue tracks scheduled and living originals and exempts children born during rescue', () => {
  const c = combat({ kind: 'unite', spawns: [{ time: 0, count: 2, interval: 100,
    enemyKey: 'enemy_1007_slime', ownerPlayerId: 'p1', sourcePlayerId: 'p2' }] });
  const b = c.battle;
  const damage = b.data.getEnemy('enemy_1007_slime').lpr;
  assert.equal(c.objectiveHealth().objectiveRemainingByPlayer.p2, damage * 2);
  c.step();
  const original = b.enemies.find(enemy => enemy.alive && !enemy.uniteRuntime);
  assert.ok(original);
  const child = b.spawnEnemy(original.defId, { pos: [9, 5], ownerPlayerId: 'p1', sourcePlayerId: 'p2', countInTotal: true });
  assert.equal(child.uniteRuntime, true);
  b.leak(child);
  assert.equal(c.objectiveHealth().objectiveRemainingByPlayer.p2, damage * 2);
  assert.equal(c.objectiveHealth().objectiveEnemiesLeftByPlayer.p2, 2);
  b.kill(original, null);
  assert.equal(c.objectiveHealth().objectiveRemainingByPlayer.p2, damage);
  assert.equal(c.objectiveHealth().objectiveEnemiesLeftByPlayer.p2, 1);
  assert.equal(b.errorCount, 0);
});

test('real MizukiCombat rescue preserves exact inline life damage before spawning and after timeout', () => {
  const key = 'enemy_1007_slime';
  const base = combat().battle.data.getEnemy(key).raw;
  const definition = { ...base, stats: { ...base.stats, lpr: 7 } };
  const c = combat({ kind: 'unite', spawns: [{ time: 100, enemyKey: key,
    sourcePlayerId: 'p2', ownerPlayerId: 'p1', countInTotal: true, def: definition }] });
  assert.equal(c.battle._pending.length, 1);
  assert.equal(c.battle.enemies.length, 0);
  assert.equal(c.snapshot().objectiveRemainingByPlayer.p2, 7, 'the original inline definition applies before the enemy is born');
  assert.equal(c.objectiveHealth().objectiveEnemiesLeftByPlayer.p2, 1);
  c.battle.start();
  c.battle.forceEnd('timeout');
  assert.equal(c.done, true);
  assert.equal(c.battle.result().unspawned[0].lpr, 7, 'timeout cannot replace the original source damage with the database default');
  assert.equal(c.snapshot().objectiveRemainingByPlayer.p2, 7);
  assert.equal(c.objectiveHealth().objectiveEnemiesLeftByPlayer.p2, 1);
  assert.equal(c.battle.errorCount, 0);
});

test('shield extends the visible leak buffer without absorbing direct damage or changing real life', () => {
  const health = { life: 1, maxLife: 10, shield: 5 };
  assert.equal(live([], { health }).lp, 6);
  assert.equal(live([], { health, phase: 'PREP' }).shown, 6);
  const hit = live([normal({ objectiveLossByPlayer: { p1: 3 }, objectiveDirectLossByPlayer: { p1: 1 } })], { health });
  assert.deepEqual(hit, { lp: 6, pending: 3, unite: false, left: null, shown: 3, shieldPending: 2 });
  assert.deepEqual(health, { life: 1, maxLife: 10, shield: 5 });
});
