import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf, attach } from '../server/sim/content/enemies.js';
import { updateEnemy, attackWindup } from '../server/sim/ai.js';
import { spawnOfficialAirSupport, createOfficialAttackDroneAbilities } from '../server/modes/mizuki/OfficialAirSupport.js';
import { resolveOfficialFacility } from '../server/modes/mizuki/OfficialStageMechanics.js';
import { MIZUKI_AIR_DEFENSE_KITS, snapshotNativeAirDefenseEffects }
  from '../server/modes/mizuki/native-air-defense-enemies.js';

const DEF = 'enemy_1146_defspd_2', SHIELD = 'enemy_1142_mershd_2';
const LEGEND = 'enemy_1144_merlgd_2', ATK = 'enemy_1145_atkspd_2';
function fixture(t) {
  const c = new MizukiCombat({ seed: 19, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: [{ playerId: 'p', units: [] }],
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180 });
  t.after(() => c.forceEnd());
  const b = c.battle, source = Object.create(b.data), base = b.data, defs = new Map();
  const bb = (entries = []) => ({ bb: Object.fromEntries(entries.map((v) => [v.key, v.value])) });
  for (const id of [SHIELD, LEGEND, DEF, ATK]) {
    const raw = resolveOfficialEnemy({ id, level: 0 });
    defs.set(id, normalizeEnemy(id, { key: id, name: raw.name, rank: raw.levelType, applyWay: raw.applyWay,
      stats: { ...raw.attributes, res: raw.attributes.magicResistance, rangeRadius: raw.rangeRadius, motion: raw.motion },
      talents: bb(raw.talentBlackboard), officialData: raw,
      skills: (raw.skills || []).map((s) => ({ ...s, ...bb(s.blackboard) })) }));
  }
  source.getEnemy = (id) => defs.get(id) || base.getEnemy(id); b.data = source;
  b.on('enemySpawn', ({ enemy: e }) => {
    if (e.defId === ATK && !e.mem.mizukiAirSupportDrone) {
      attach(b, e, createOfficialAttackDroneAbilities(abOf(b, e), e, b)); return;
    }
    if (!MIZUKI_AIR_DEFENSE_KITS[e.defId] || e.mem.mizukiDefenseCommander
      || e.mem.mizukiLegendaryCommander || e.mem.mizukiDefenseDrone) return;
    attach(b, e, MIZUKI_AIR_DEFENSE_KITS[e.defId](abOf(b, e), e, b));
  }, { priority: 80 });
  const hangar = (row = 9, col = 2) => {
    const p = { inst: { characterKey: 'trap_037_airsup', level: 1, phase: 'PHASE_0' },
      position: { row, col }, direction: 'RIGHT', skillIndex: 0, mainSkillLvl: 1 };
    return spawnOfficialAirSupport(b, p, resolveOfficialFacility(p));
  };
  const enemy = (id, row = 9, col = 6) => b.spawnEnemy(id, { pos: [row, col], countInTotal: false,
    route: { motion: id === DEF || id === ATK ? 'FLY' : 'WALK', start: [row, col], end: [row, col],
      checkpoints: [{ type: 'WAIT', time: 9999 }] } });
  const tick = (dt = b.dt) => b.emit('tick', { dt });
  const after = (seconds) => { b.time += seconds; b._runScheduled(); };
  const target = () => b.spawnToken(null, 'test:legend-target', 9, 6, {
    def: { name: 'target', stats: { maxHp: 100000, atk: 0, def: 1000, blockCnt: 1 },
      profession: 'TOKEN', position: 'MELEE', rangeGrid: [], attackKind: 'none' },
    kit: { trait: { attack: 'none', noAttack: true } },
  });
  return { b, c, hangar, enemy, tick, after, target };
}

test('native shield commander triggers strictly below half HP and calls a defense drone after two seconds', (t) => {
  const { b, hangar, enemy, tick, after } = fixture(t); const h = hangar(), e = enemy(SHIELD);
  b.dealDamage(null, e, { amount: 5000, type: 'true' }); tick(.1);
  assert.equal(e.mem.mizukiDefenseCommander.used, undefined);
  b.dealDamage(null, e, { amount: 1, type: 'true' });
  const a = e.mem.mizukiDefenseCommander;
  assert.equal(a.used, true); assert.equal(a.casting, true); assert.equal(a.hangar, h);
  assert.deepEqual(e.def.attackAnim, { dur: 1, hit: .467 });
  assert.equal(e.s.flags.noMove, true); assert.equal(e.s.flags.disarm, true);
  after(1.999); assert.equal(b.enemies.some((u) => u.defId === DEF), false);
  after(.001); const d = b.enemies.find((u) => u.id === a.droneId); assert.ok(d);
  assert.equal(a.casting, false); assert.equal(d.counted, false); assert.equal(d.motion, 'FLY');
  assert.ok(Math.abs(d.spawnX - h.x) <= .201); assert.ok(Math.abs(d.spawnY - h.y) <= .201);
  assert.deepEqual(d.mem.mizukiAirSupportFlight.targetTile, [9, 6]);
  assert.equal(d.route.legs.find((v) => v.t === 'wait').time, 9999);
  b.kill(e, null); assert.equal(d.alive, true); assert.equal(b.errorCount, 0);
});

test('native shield commander defers while controlled and consumes an interrupted call without retrying', (t) => {
  const { b, hangar, enemy, tick, after } = fixture(t); hangar(); const e = enemy(SHIELD);
  b.applyStatus(e, 'stun', { duration: 10 });
  b.dealDamage(null, e, { amount: 5001, type: 'true' }); tick(.1);
  assert.equal(e.mem.mizukiDefenseCommander.used, undefined);
  b.removeBuff(e, e.buffs.find((v) => v.status === 'stun')); tick(.1);
  assert.equal(e.mem.mizukiDefenseCommander.casting, true);
  b.applyStatus(e, 'stun', { duration: 1 }); after(3); tick(.1);
  assert.equal(e.mem.mizukiDefenseCommander.interrupted, true);
  assert.equal(e.mem.mizukiDefenseCommander.casting, false);
  assert.equal(b.enemies.some((u) => u.defId === DEF), false);
  assert.ok(snapshotNativeAirDefenseEffects(b).every((v) => v.ownerId !== e.id)); assert.equal(b.errorCount, 0);
});

test('native defense drone activates only after arriving, excludes itself and uses fixed collider aura', (t) => {
  const { b, enemy, tick } = fixture(t); const d = enemy(DEF), near = enemy(SHIELD, 9, 8.59);
  const far = enemy(SHIELD, 9, 8.61); near.hp -= 500;
  d.mem.mizukiAirSupportFlight = { end: [9, 6.1], targetTile: [9, 6], offset: [0, .1] };
  tick(); assert.equal(near.s.def, near.base.def);
  d.x = 6.1; tick();
  assert.equal(d.mem.mizukiDefenseDrone.activated, true); assert.equal(d.profile.noAttack, true);
  assert.equal(d.s.def, d.base.def); assert.equal(near.s.def, near.base.def + 300);
  assert.equal(near.s.hpRegen, 250); assert.equal(far.s.def, far.base.def + 300);
  // Boundary follows the original circle plus target's 0.1 collider.
  far.x = d.x + 2.601; tick(); assert.equal(far.s.def, far.base.def);
  near.x = d.x + 2.599; tick(); assert.equal(near.s.def, near.base.def + 300);
  const hp = near.hp; b._tickBuffs(.5); assert.equal(near.hp, hp + 125);
  b.applyStatus(d, 'silence', { duration: 5 }); tick();
  assert.equal(near.s.def, near.base.def); assert.equal(near.s.hpRegen, 0);
  assert.equal(b.errorCount, 0);
});

test('native defense aura does not stack across drones and ends on owner removal and forty-second fuel', (t) => {
  const { b, enemy, tick, after } = fixture(t), target = enemy(SHIELD, 9, 7);
  const drones = [enemy(DEF), enemy(DEF)];
  for (const d of drones) d.mem.mizukiAirSupportFlight = { end: [9, 6], targetTile: [9, 6], offset: [0, 0] };
  tick(); assert.equal(target.s.def, target.base.def + 300); assert.equal(target.s.hpRegen, 250);
  b._remove(drones[0], 'expired'); tick(); assert.equal(target.s.def, target.base.def + 300);
  after(39.999); assert.equal(drones[1].alive, true);
  after(.001); assert.equal(drones[1].alive, false); assert.equal(target.s.def, target.base.def);
  assert.equal(target.s.hpRegen, 0); assert.equal(drones[1].mem.mizukiSelfDestructed, true);
  assert.equal(b.killed, 0); assert.equal(b._mizukiLeakDamage || 0, 0);
  assert.equal(snapshotNativeAirDefenseEffects(b).length, 0); assert.equal(b.errorCount, 0);
});

test('native legendary commander calls attack support at first attack frame and defense independently below half', (t) => {
  const { b, hangar, enemy, target, tick, after } = fixture(t); hangar(); const u = target(), e = enemy(LEGEND);
  e.blockedBy = u; e.atkCd = 0;
  assert.deepEqual(e.def.attackAnim, { dur: 1.933, hit: .8 });
  updateEnemy(b, e, b.dt); tick();
  assert.equal(e.swing, true); assert.equal(b.enemies.some((v) => v.defId === ATK), false);
  updateEnemy(b, e, attackWindup(e)); tick();
  const a = e.mem.mizukiLegendaryCommander, drone = b.enemies.find((v) => v.id === a.atkDroneId);
  assert.ok(drone); assert.deepEqual(drone.mem.mizukiAirSupportFlight.targetTile, [9, 6]);
  assert.equal(a.atkCalled, true); assert.equal(drone.s.moveSpeed, drone.base.moveSpeed * 3);
  b.dealDamage(null, e, { amount: 6000, type: 'true' }); assert.equal(a.defCalled, undefined);
  b.dealDamage(null, e, { amount: 1, type: 'true' }); assert.equal(a.defCalled, true);
  assert.ok(b.enemies.some((v) => v.id === a.defDroneId));
  assert.equal(!!e.s.flags.noMove, false);
  assert.ok(!snapshotNativeAirDefenseEffects(b).some((v) => v.ownerId === e.id && v.key === 'enemy_merlgd_buff_01'));
  b.emit('attack', { attacker: e, targets: [u], isSkill: false });
  assert.equal(b.enemies.filter((v) => v.defId === ATK).length, 1);
  after(1); assert.ok(!snapshotNativeAirDefenseEffects(b).some((v) => v.key === 'enemy_merlgd_buff_02'));
  b.kill(e, null); assert.equal(drone.s.moveSpeed, drone.base.moveSpeed);
  assert.equal(drone.alive, true); assert.equal(b.errorCount, 0);
});

test('native legendary global speed aura follows drone marker and stays unstacked across commanders', (t) => {
  const { b, enemy, tick } = fixture(t); const commanders = [enemy(LEGEND), enemy(LEGEND)];
  const drone = enemy(DEF, 12, 10), ordinary = enemy(SHIELD, 12, 10);
  tick(); assert.equal(drone.s.moveSpeed, drone.base.moveSpeed * 3);
  assert.equal(ordinary.s.moveSpeed, ordinary.base.moveSpeed);
  b.kill(commanders[0], null); tick(); assert.equal(drone.s.moveSpeed, drone.base.moveSpeed * 3);
  b.removeBuff(drone, 'airsup_drone'); tick(); assert.equal(drone.s.moveSpeed, drone.base.moveSpeed);
  b.kill(commanders[1], null); assert.equal(b.errorCount, 0);
});

test('native air support has no fabricated fallback when its original source hangar is absent', (t) => {
  const { b, enemy, tick, after, target } = fixture(t); const shield = enemy(SHIELD);
  b.dealDamage(null, shield, { amount: 5001, type: 'true' }); after(2.1); tick(.1);
  assert.equal(shield.mem.mizukiDefenseCommander.used, true); assert.equal(shield.mem.mizukiDefenseCommander.droneId, null);
  const legend = enemy(LEGEND), u = target();
  b.emit('beforeAttack', { attacker: legend, targets: [u], isSkill: false });
  b.emit('attack', { attacker: legend, targets: [u], isSkill: false });
  b.dealDamage(null, legend, { amount: 6001, type: 'true' });
  assert.equal(legend.mem.mizukiLegendaryCommander.atkDroneId, null);
  assert.equal(legend.mem.mizukiLegendaryCommander.defDroneId, null);
  assert.equal(b.enemies.some((v) => v.defId === DEF || v.defId === ATK), false); assert.equal(b.errorCount, 0);
});

test('native summon caches a missing source and first-attack target before its wait', (t) => {
  const { b, enemy, tick, after, hangar, target } = fixture(t);
  const shield = enemy(SHIELD); b.dealDamage(null, shield, { amount: 5001, type: 'true' });
  hangar(); after(2); assert.equal(shield.mem.mizukiDefenseCommander.droneId, null);
  const e = enemy(LEGEND), u = target(); e.blockedBy = u; e.atkCd = 0;
  updateEnemy(b, e, b.dt); tick();
  assert.deepEqual(e.mem.mizukiLegendaryCommander.pendingAtk.tile, [9, 6]);
  u.x = 8; u.y = 12; b.retreat(u, { permanent: true });
  updateEnemy(b, e, attackWindup(e)); tick();
  const drone = b.enemies.find((v) => v.id === e.mem.mizukiLegendaryCommander.atkDroneId);
  assert.ok(drone); assert.deepEqual(drone.mem.mizukiAirSupportFlight.targetTile, [9, 6]);
  assert.equal(b.errorCount, 0);
});
