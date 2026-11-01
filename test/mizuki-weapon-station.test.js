import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { resolveOfficialFacility } from '../server/modes/mizuki/OfficialStageMechanics.js';
import { spawnOfficialWeaponStation } from '../server/modes/mizuki/OfficialWeaponStation.js';
import { canTargetAlly, canTargetEnemy } from '../server/sim/targeting.js';

function fixture(t, side = 'ally') {
  const combat = new MizukiCombat({ seed: 17, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: [{ playerId: 'p1', units: [] }],
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180 });
  t.after(() => combat.forceEnd());
  const b = combat.battle, effects = [], logs = [];
  const p = { inst: { characterKey: 'trap_057_wpnsts', level: 1, phase: 'PHASE_0' },
    alias: 'station', position: { row: 10, col: 5 }, direction: 'RIGHT',
    skillIndex: side === 'enemy' ? 1 : 0, mainSkillLvl: 1 };
  const station = spawnOfficialWeaponStation(b, p, resolveOfficialFacility(p), {
    effect: (u, key, active = true, options = {}) => effects.push({ id: u.id, key, active, ...options, time: b.time }),
    log: (key, value) => logs.push({ key, value, time: b.time }),
  });
  const target = (row, col, opts = {}) => b.spawnToken(null, 'test:station_target', row, col, {
    def: { name: 'target', stats: { maxHp: 10000, atk: 0, def: 0, magicResistance: 0, blockCnt: 0 },
      profession: 'GUARD', position: 'MELEE', rangeGrid: [], attackKind: 'none' },
    kit: { trait: { attack: 'none', noAttack: true },
      skill: { kind: 'instant', spType: 'attack', spCost: 100, initSp: 0 }, ...opts },
  });
  const enemy = (row, col) => b.spawnEnemy('test:station_enemy', { pos: [row, col], countInTotal: false,
    def: { key: 'test:station_enemy', name: 'enemy', stats: { maxHp: 10000, atk: 0, def: 0, res: 0,
      rangeRadius: 0, moveSpeed: 0, baseAttackTime: 99 }, dmgType: 'none', motion: 'WALK' },
    route: { motion: 'WALK', start: [row, col], end: [row, col], checkpoints: [{ type: 'WAIT', time: 9999 }] } });
  const advance = (s) => { for (let n = 0; n < Math.ceil(s / b.dt); n++) b.step(); };
  return { b, combat, station, target, enemy, advance, effects, logs };
}

test('original station respects both initial modes and remains attackable by the opposite side', (t) => {
  const ally = fixture(t); const e = ally.enemy(10, 6);
  assert.equal(ally.station.side, 'ally'); assert.equal(ally.station.s.maxHp, 25000);
  assert.equal(ally.station.s.taunt, -1); assert.equal(ally.station.s.blockCnt, 0);
  assert.equal(ally.station.s.hpRegen, 75); assert.equal(canTargetAlly(e, ally.station, true), true);
  assert.deepEqual(ally.logs.map((x) => x.key), ['ally_default']);
  assert.deepEqual(ally.effects.filter((x) => x.active).map((x) => [x.key, x.loop]), [
    ['trap_latelan_char_01_start', true], ['trap_latelan_char_01', true],
  ]);
  const hostile = fixture(t, 'enemy'), a = hostile.target(10, 6);
  assert.equal(hostile.station.mem.mizukiWeaponStation.mode, 1);
  assert.equal(hostile.b.enemies.includes(hostile.station), true);
  assert.equal(hostile.b.allyUnits.includes(hostile.station), false);
  assert.equal(canTargetEnemy(a, hostile.station, a.profile), true);
  assert.equal(hostile.station.counted, false); assert.equal(hostile.station.mem.noLeak, true);
  assert.deepEqual(hostile.logs.map((x) => x.key), ['enemy_default']);
  hostile.advance(.1); assert.equal(hostile.b.errorCount, 0);
});

test('station aura grants native one SP per target per two seconds and resets on leaving x-1', (t) => {
  const { b, station, target, advance } = fixture(t);
  const inside = target(11, 6), outside = target(12, 7), far = target(9, 9);
  advance(1.9); assert.equal(inside.skill.spTotal, 0);
  advance(.1); assert.equal(inside.skill.spTotal, 1);
  assert.equal(outside.skill.spTotal, 0); assert.equal(far.skill.spTotal, 0);
  inside.x = 9; inside.tileC = 9; advance(1.5);
  inside.x = 6; inside.tileC = 6; advance(1.9); assert.equal(inside.skill.spTotal, 1);
  advance(.1); assert.equal(inside.skill.spTotal, 2);
  b.addBuff(station, { key: 'test:damage', persist: true });
  station.hp -= 150; advance(1); assert.ok(Math.abs(station.hp - (25000 - 75)) < 1e-6);
  assert.equal(b.heal(inside, station, 1000), 0); assert.equal(b.errorCount, 0);
});

test('enemy-side station uses a real per-enemy SP hook without inventing attack-cooldown changes', (t) => {
  const { b, station, enemy, advance } = fixture(t, 'enemy');
  const inside = enemy(10, 6), unsupported = enemy(11, 6), calls = [];
  inside.mem.mizukiGainSp = (amount, meta) => calls.push({ amount, ...meta });
  const cooldown = unsupported.nextAtkAt;
  advance(1.9); assert.equal(calls.length, 0);
  advance(.1); assert.equal(calls.length, 1);
  assert.equal(calls[0].amount, 1); assert.equal(calls[0].reason, 'wpnsts');
  assert.equal(calls[0].source, station);
  inside.x = 9; inside.tileC = 9; advance(1);
  inside.x = 6; inside.tileC = 6; advance(1.9);
  assert.equal(calls.length, 1);
  advance(.1); assert.equal(calls.length, 2);
  assert.equal(unsupported.nextAtkAt, cooldown); assert.equal(b.errorCount, 0);
});

test('fatal hit blasts old allies then switches side and waits exactly twenty seconds before full rebirth', (t) => {
  const { b, station, target, enemy, advance, effects, logs } = fixture(t);
  const oldAlly = target(11, 6), out = target(12, 7), foe = enemy(10, 6);
  b.dealDamage(foe, station, { amount: 25000, type: 'true', canDodge: false });
  assert.equal(station.alive, true); assert.equal(station.side, 'enemy');
  assert.equal(station.mem.mizukiWeaponStation.mode, 0);
  assert.equal(station.mem.mizukiWeaponStation.reborn, true);
  assert.equal(oldAlly.hp, 9000); assert.equal(oldAlly.s.flags.stun, true);
  assert.equal(oldAlly.buffs.find((v) => v.status === 'stun').duration, 5);
  assert.equal(out.hp, 10000); assert.equal(foe.hp, 10000);
  assert.equal(b.dealDamage(oldAlly, station, { amount: 99999, type: 'true' }), 0);
  assert.equal(station.s.flags.invulnerable, true);
  assert.equal(canTargetEnemy(oldAlly, station, oldAlly.profile), false);
  assert.equal(b.killed, 0); assert.equal(b.resolved, 0); assert.equal(b.total, 1);
  assert.deepEqual(logs.map((x) => x.key), ['ally_default', 'enemy']);
  assert.ok(effects.some((x) => x.key === 'trap_latelan_char_01' && !x.active && x.loop));
  assert.equal(effects.filter((x) => x.key === 'trap_latelan_char_01' && x.active).length, 1);
  assert.ok(effects.some((x) => x.key === 'trap_latelan_enemy_charging_01' && x.active));
  assert.equal(effects.find((x) => x.key === 'trap_latelan_enemy_charging_01' && x.active).loop, true);
  assert.equal(effects.find((x) => x.key === 'trap_latelan_enemy_attack_01' && x.active).loop, false);
  advance(19.9); assert.equal(station.mem.mizukiWeaponStation.reborn, true);
  advance(.2); assert.equal(station.mem.mizukiWeaponStation.reborn, false);
  assert.equal(station.mem.mizukiWeaponStation.mode, 1); assert.equal(station.hp, 25000);
  assert.equal(!!station.s.flags.invulnerable, false);
  assert.equal(canTargetEnemy(oldAlly, station, oldAlly.profile), true);
  assert.ok(effects.some((x) => x.key === 'trap_latelan_enemy_charging_01' && !x.active));
  assert.ok(effects.some((x) => x.key === 'trap_latelan_enemy_attack_01' && !x.active && !x.loop));
  assert.equal(effects.filter((x) => x.key === 'trap_latelan_enemy_attack_01' && x.active).length, 1);
  assert.ok(effects.some((x) => x.key === 'trap_latelan_enemy_01_start' && x.active));
  assert.ok(effects.some((x) => x.key === 'trap_latelan_enemy_01' && x.active && x.loop));
  b.dealDamage(oldAlly, station, { amount: 25000, type: 'true', canDodge: false });
  assert.equal(station.side, 'ally'); assert.equal(foe.hp, 9000);
  assert.equal(station.mem.mizukiWeaponStation.captures, 2);
  advance(20.1); assert.equal(station.hp, 25000);
  assert.equal(station.mem.mizukiWeaponStation.mode, 0); assert.equal(b.errorCount, 0);
});

test('station has original abnormal, elemental and environment damage immunities on either side', (t) => {
  const { b, station, target, advance } = fixture(t, 'enemy'); const a = target(10, 6);
  for (const status of ['stun', 'freeze', 'silence', 'cold', 'disarm', 'sleep']) {
    assert.equal(b.applyStatus(station, status, { duration: 5, source: a }), false, status);
  }
  assert.equal(b.push(station, 5, { from: a }), 0);
  assert.equal(b.dealDamage(a, station, { amount: 1000, type: 'element', element: 'neural' }), 0);
  assert.equal(station.elem.neural, 0);
  assert.equal(b.dealDamage(null, station, { amount: 1000, type: 'true', tags: ['IS_ENVIRONMENT_DAMAGE'] }), 0);
  for (const tag of ['terrain', 'deepsea', 'mizuki:volcano', 'mizuki:ballista', 'mizuki:ore']) {
    assert.equal(b.dealDamage(null, station, { amount: 1000, type: 'true', tags: [tag] }), 1000, tag);
  }
  assert.equal(b.dealDamage(a, station, { amount: 100, type: 'true' }), 100);
  advance(.1); assert.equal(b.errorCount, 0);
});
