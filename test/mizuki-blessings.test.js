import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../server/sim/Battle.js';
import { SkillRuntime } from '../server/sim/skills.js';
import { installMizukiNativeBlessings, mizukiVirtueSpec } from '../server/modes/mizuki/NativeBlessings.js';

const id = (index) => 'rogue_2_virtue_' + index;
function setup(ids) {
  const b = new Battle({ seed: 77, stageId: 'act1autochess_m02', content: 'none',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: [{ playerId: 'p1', seat: 0, units: [
      { uid: 1, chessId: 'chess_char_1_02_a', row: 10, col: 5, abs: true },
      { uid: 2, chessId: 'chess_char_1_02_a', row: 11, col: 5, abs: true }] }] });
  const controller = installMizukiNativeBlessings(b, { virtues: ids.map((n) => ({ id: id(n), used: false })) });
  const units = b.allyUnits.filter((unit) => unit.kind === 'op');
  units.forEach((unit) => b._deploy(unit));
  return { b, units, controller };
}
test('all 14 original virtue blackboards decode including one-use experience and immediate pools', () => {
  for (let index = 1; index <= 14; index++) assert.equal(mizukiVirtueSpec(id(index)).id, id(index));
  assert.deepEqual(mizukiVirtueSpec(id(3)).extraExp, { count: 70, limit: 1 });
  assert.deepEqual(mizukiVirtueSpec(id(10)).extraExp, { count: 120, limit: 1 });
  assert.deepEqual(mizukiVirtueSpec(id(7)).rewards, Array.from({ length: 2 }, () => ({ poolId: 'pool_meide', count: 1 })));
  assert.equal(mizukiVirtueSpec(id(14)).rewards.length, 4);
  assert.equal(mizukiVirtueSpec('invented'), null);
});
test('anger uses a battle-wide 30-second deadline; late spawns do not get another 30 seconds', () => {
  const { b } = setup([1]); const early = b.spawnEnemy('enemy_1007_slime');
  assert.equal(early.s.atk, early.base.atk * .7);
  assert.equal(early.s.moveSpeed, early.base.moveSpeed * .7);
  b._tickBuffs(29); b.time = 29;
  const late = b.spawnEnemy('enemy_1007_slime');
  assert.equal(late.findBuff('mizuki:virtue:' + id(1)).timeLeft, 1);
  b._tickBuffs(1.01); b.time = 30.01;
  assert.equal(early.s.atk, early.base.atk); assert.equal(late.s.atk, late.base.atk);
  assert.equal(b.spawnEnemy('enemy_1007_slime').s.atk, early.base.atk);
  const strong = setup([8]); strong.b.time = 150; const enemy = strong.b.spawnEnemy('enemy_1007_slime');
  assert.equal(enemy.findBuff('mizuki:virtue:' + id(8)).timeLeft, 150);
});
test('resilience selects the lowest HP ratio each tick and respects regeneration semantics', () => {
  for (const [index, amount] of [[4, 50], [11, 100]]) {
    const { b, units: [a, c] } = setup([index]);
    a.hp = 200; c.hp = 100; b.emit('tick', { dt: 1 });
    assert.equal(a.hp, 200); assert.equal(c.hp, 100 + amount);
    a.hp = 50; b.emit('tick', { dt: .5 }); assert.equal(a.hp, 50 + amount * .5);
  }
});
test('vicissitude grants SP only to the highest max-HP operator and honors active-skill/no-SP locks', () => {
  for (const [index, rate] of [[2, 2], [9, 4]]) {
    const { b, units: [a, c] } = setup([index]);
    for (const unit of [a, c]) unit.skill = new SkillRuntime(b, unit, {}, { spCost: 100, kind: 'duration', duration: 10, spType: 'attack' });
    c.base.maxHp = a.base.maxHp * 2; c.markDirty(); c.hp = c.s.maxHp;
    b.emit('tick', { dt: 1 });
    assert.equal(a.skill.spTotal, 0); assert.equal(c.skill.spTotal, rate);
    b.addBuff(c, { key: 'test:no-sp', flags: { noSp: true }, duration: Infinity });
    b.emit('tick', { dt: 1 }); assert.equal(c.skill.spTotal, rate);
    b.removeBuff(c, 'test:no-sp'); c.skill.active = true;
    b.emit('tick', { dt: 1 }); assert.equal(c.skill.spTotal, rate);
    c.skill.active = false; b.kill(c); b.emit('tick', { dt: .5 });
    assert.equal(a.skill.spTotal, rate * .5);
  }
});
test('sophistication increases only ranged DEF/RES and persists once through redeployment', () => {
  for (const [index, def, res] of [[6, 300, 30], [13, 500, 50]]) {
    const { b, units: [a, c] } = setup([]);
    a.def = { ...a.def, position: 'RANGED' };
    installMizukiNativeBlessings(b, { virtues: [id(index)] }); // existing installer remains immutable
    const fresh = new Battle({ players: [], content: 'none' }); fresh.allyUnits.push(a, c);
    installMizukiNativeBlessings(fresh, { virtues: [id(index)] });
    assert.equal(a.s.def, a.base.def + def); assert.equal(a.s.res, Math.min(100, a.base.res + res));
    assert.equal(c.s.def, c.base.def); fresh.emit('deploy', { unit: a });
    assert.equal(a.s.def, a.base.def + def);
  }
});
test('glory evasion is independent and excludes undodgeable, true and elemental damage', () => {
  const { b, units: [unit] } = setup([5]); b.rng = () => 0;
  const hp = unit.hp; b.dealDamage(null, unit, { amount: 100, type: 'arts' }); assert.equal(unit.hp, hp);
  b.dealDamage(null, unit, { amount: 100, type: 'true' }); assert.equal(unit.hp, hp - 100);
  const before = unit.hp; b.dealDamage(null, unit, { amount: 100, type: 'arts', canDodge: false }); assert.ok(unit.hp < before);
  const strong = setup([12]); let hits = 0; strong.b.rng = () => .54;
  strong.b.on('dodge', () => hits++); strong.b.dealDamage(null, strong.units[0], { amount: 100, type: 'phys' });
  assert.equal(hits, 1);
});
test('empty virtues leave a normal battle unchanged and installation is idempotent', () => {
  const { b, controller } = setup([]); const enemy = b.spawnEnemy('enemy_1007_slime');
  assert.equal(enemy.s.atk, enemy.base.atk);
  assert.equal(installMizukiNativeBlessings(b, { virtues: [id(1)] }), controller);
  assert.deepEqual(controller.snapshot(), []);
});
