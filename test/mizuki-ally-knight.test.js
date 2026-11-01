import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { resolveOfficialFacility } from '../server/modes/mizuki/OfficialStageMechanics.js';
import { spawnOfficialAllyKnight } from '../server/modes/mizuki/OfficialAllyKnight.js';

function fixture(t) {
  const combat = new MizukiCombat({ seed: 17, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: [{ playerId: 'p1', units: [] }],
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180 });
  t.after(() => combat.forceEnd());
  const battle = combat.battle;
  const instance = { inst: { characterKey: 'trap_079_allydonq', level: 1, phase: 'PHASE_0' },
    alias: 'trap_079_allydonq#1', position: { row: 9, col: 4 }, direction: 'RIGHT', hidden: true,
    mainSkillLvl: 1, skillIndex: 0 };
  const logs = [];
  const knight = spawnOfficialAllyKnight(battle, instance, resolveOfficialFacility(instance),
    { log: (key, addition, unit) => logs.push({ key, addition, id: unit.defId }) });
  const advance = (seconds) => { for (let n = 0; n < Math.ceil(seconds / battle.dt); n++) battle.step(); };
  return { battle, combat, knight, advance, logs };
}

test('original ally knight is an ownerless fighting token with original stats, range, attack-recovery skill and born log', (t) => {
  const { battle, knight, logs } = fixture(t);
  assert.ok(knight); assert.equal(knight.kind, 'token'); assert.equal(knight.ownerId, null);
  assert.equal(knight.s.maxHp, 3000); assert.equal(knight.s.atk, 400);
  assert.equal(knight.s.def, 1000); assert.equal(knight.s.res, 50); assert.equal(knight.s.blockCnt, 2);
  assert.equal(knight.s.interval, 2); assert.deepEqual(knight.def.rangeGrid, [[0, 0], [0, 1]]);
  assert.equal(knight.skill.spCost, 4); assert.equal(knight.skill.spType, 'attack'); assert.equal(knight.skill.manual, false);
  assert.equal(knight.s.flags.healFree, true); assert.equal(!!knight.s.flags.noHeal, false);
  assert.deepEqual(logs, [{ key: 'born', addition: 1, id: knight.defId }]);
  assert.equal(battle.getPlayer('p1').units.length, 0); assert.equal(battle.errorCount, 0);
});

test('original ally knight attacks through the real AI and casts its 200 percent physical radial-force-two fifth hit', (t) => {
  const { battle, knight, advance } = fixture(t);
  const target = battle.spawnEnemy('enemy_1007_slime', { pos: [9, 5],
    def: { name: 'source attack fixture', stats: { maxHp: 100000, atk: 0, def: 0, massLevel: 0, moveSpeed: 0 }, applyWay: 'NONE' } });
  battle.addBuff(target, { key: 'test:hold', flags: { noMove: true, disarm: true }, persist: true });
  const hits = []; battle.on('damaged', (c) => { if (c.source === knight && c.target === target) hits.push(c); });
  const pushes = [], push = battle.push.bind(battle);
  battle.push = (unit, force, opts) => { const result = push(unit, force, opts); pushes.push({ unit, force, opts, result }); return result; };
  advance(8.1);
  assert.equal(hits.length, 5); assert.deepEqual(hits.map((c) => c.dmg.amount), [400, 400, 400, 400, 800]);
  assert.ok(hits.every((c) => c.dmg.type === 'phys')); assert.equal(knight.skill.activations, 1);
  assert.equal(knight.skill.sp, 0); assert.equal(pushes.length, 1); assert.equal(pushes[0].force, 2);
  assert.equal(pushes[0].opts.from, knight); assert.equal(pushes[0].opts.dir, undefined);
  assert.ok(pushes[0].result > 0); assert.equal(battle.errorCount, 0);
});

test('original ally knight rejects ordinary healing but permits the source aid-kit exception and logs killed only on a real death', (t) => {
  const { battle, knight, logs } = fixture(t);
  battle.dealDamage(null, knight, { amount: 1000, type: 'true' });
  assert.equal(knight.hp, 2000);
  assert.equal(battle.heal(null, knight, 500), 0); assert.equal(knight.hp, 2000);
  assert.equal(battle.heal(null, knight, 500, { ignoreHealFree: true }), 500); assert.equal(knight.hp, 2500);
  battle.kill(knight, null); battle.kill(knight, null);
  assert.deepEqual(knight.mem.mizukiAllyKnight, { born: 1, killed: 1 });
  assert.deepEqual(logs.map((x) => x.key), ['born', 'killed']); assert.equal(battle.errorCount, 0);
});

test('retreating the original ally knight does not fabricate a killed log or a route ending', (t) => {
  const { battle, knight, logs } = fixture(t);
  battle.retreat(knight, { permanent: true });
  assert.deepEqual(logs.map((x) => x.key), ['born']);
  assert.deepEqual(knight.mem.mizukiAllyKnight, { born: 1, killed: 0 });
  assert.equal(battle.errorCount, 0);
});
