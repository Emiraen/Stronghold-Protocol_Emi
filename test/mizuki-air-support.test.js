import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { resolveOfficialEnemy, createOfficialMizukiStage } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { resolveOfficialFacility } from '../server/modes/mizuki/OfficialStageMechanics.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { installMizukiEnemyBehaviors } from '../server/modes/mizuki/official-enemies.js';
import { spawnOfficialAirSupport,
  snapshotOfficialAirSupportEffects } from '../server/modes/mizuki/OfficialAirSupport.js';

const COMMANDER = 'enemy_1141_merbow_2', DRONE = 'enemy_1145_atkspd_2';
const bb = (entries) => ({ bb: Object.fromEntries((entries || []).map((v) => [v.key, v.value])) });
function fixture(t) {
  const combat = new MizukiCombat({ seed: 17, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: [{ playerId: 'p1', units: [] }],
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180 });
  t.after(() => combat.forceEnd());
  const battle = combat.battle, base = battle.data, source = Object.create(base), defs = new Map();
  for (const id of [COMMANDER, DRONE]) {
    const raw = resolveOfficialEnemy({ id, level: 0 });
    defs.set(id, normalizeEnemy(id, { key: id, name: raw.name, rank: raw.levelType, applyWay: raw.applyWay,
      stats: { ...raw.attributes, res: raw.attributes.magicResistance, rangeRadius: raw.rangeRadius, motion: raw.motion },
      talents: bb(raw.talentBlackboard), officialData: raw,
      skills: (raw.skills || []).map((s) => ({ ...s, ...bb(s.blackboard) })) }));
  }
  source.getEnemy = (id) => defs.get(id) || base.getEnemy(id); battle.data = source;
  installMizukiEnemyBehaviors(battle);
  function hangar(row = 9, col = 2, alias = 'hangar') {
    const p = { inst: { characterKey: 'trap_037_airsup', level: 1, phase: 'PHASE_0' },
      alias, position: { row, col }, direction: 'RIGHT', skillIndex: 0, mainSkillLvl: 1 };
    return spawnOfficialAirSupport(battle, p, resolveOfficialFacility(p));
  }
  function target(row = 9, col = 5, def = 1000) {
    return battle.spawnToken(null, 'test:target', row, col, {
      def: { name: 'target', stats: { maxHp: 100000, atk: 0, def, blockCnt: 0, baseAttackTime: 99 },
        profession: 'TOKEN', position: 'MELEE', rangeGrid: [], attackKind: 'none' },
      kit: { trait: { attack: 'none', noAttack: true }, install(b, u) {
        b.addBuff(u, { key: 'test:disarm', persist: true, flags: { disarm: true } });
      } },
    });
  }
  const advance = (seconds) => { for (let n = 0; n < Math.ceil(seconds / battle.dt); n++) battle.step(); };
  return { battle, combat, hangar, target, advance };
}

test('original tactical hangar is invulnerable, untargetable and only exposes its native source buff', (t) => {
  const { battle, hangar, advance } = fixture(t); const h = hangar();
  assert.equal(h.kind, 'device'); assert.equal(h.s.maxHp, 100);
  assert.ok(h.findBuff('trap_airsup_base')); assert.equal(h.s.flags.invulnerable, true);
  assert.equal(h.s.flags.untargetable, true); assert.deepEqual(h.mem.mizukiFilterTags, ['factory']);
  advance(3); assert.equal(battle.enemies.filter((e) => e.defId === DRONE).length, 0);
  assert.equal(battle.errorCount, 0);
});

test('original commander casts once for two seconds, picks first native hangar and preserves target tile', (t) => {
  const { battle, hangar, target, advance } = fixture(t);
  const first = hangar(); hangar(12, 10, 'second'); const ally = target();
  const e = battle.spawnEnemy(COMMANDER, { pos: [9, 7] });
  advance(.1); const command = e.mem.mizukiAirSupportCommand;
  assert.equal(command.casts, 1); assert.equal(command.casting, true); assert.equal(e.s.flags.noMove, true);
  assert.equal(command.hangar, first); assert.deepEqual(command.tile, [9, 5]);
  assert.equal(battle.enemies.some((u) => u.defId === DRONE), false);
  battle.retreat(ally, { permanent: true });
  advance(1.8); assert.equal(battle.enemies.some((u) => u.defId === DRONE), false);
  advance(.2); const drones = battle.enemies.filter((u) => u.defId === DRONE);
  assert.equal(drones.length, 1); const drone = drones[0];
  assert.equal(drone.counted, false); assert.equal(drone.motion, 'FLY'); assert.equal(drone.s.flags.disarm, true);
  assert.ok(Math.abs(drone.spawnX - first.x) <= .201); assert.ok(Math.abs(drone.spawnY - first.y) <= .201);
  assert.deepEqual(drone.mem.mizukiAirSupportFlight.targetTile, [9, 5]);
  assert.equal(drone.route.legs[1].t, 'wait'); assert.equal(drone.route.legs[1].time, 9999);
  battle.kill(e, null); advance(10);
  assert.equal(drone.alive, true); assert.equal(drone.mem.mizukiAirSupportDrone.activated, true);
  assert.equal(!!drone.s.flags.disarm, false);
  const effects = snapshotOfficialAirSupportEffects(battle);
  assert.equal(effects.find((s) => s.key === 'enemy_atkspd_buff_02').active, false);
  assert.equal(effects.find((s) => s.key === 'enemy_atkspd_attack_buff_01').active, true);
  assert.equal(battle.errorCount, 0);
});

test('interrupted original commander consumes its one cast without summoning a fallback drone', (t) => {
  const { battle, hangar, target, advance } = fixture(t); hangar(); target();
  const e = battle.spawnEnemy(COMMANDER, { pos: [9, 7] }); advance(.1);
  battle.applyStatus(e, 'stun', { duration: 1 }); advance(3);
  assert.equal(e.mem.mizukiAirSupportCommand.interrupted, true);
  assert.equal(e.mem.mizukiAirSupportCommand.casts, 1);
  assert.equal(battle.enemies.some((u) => u.defId === DRONE), false); assert.equal(battle.errorCount, 0);
});

test('original drone fuel expires forty seconds after birth and clears all looping effects', (t) => {
  const { battle, target, advance } = fixture(t); target();
  const e = battle.spawnEnemy(DRONE, { pos: [9, 6], countInTotal: false,
    route: { motion: 'FLY', start: [9, 6], end: [9, 6], checkpoints: [{ type: 'WAIT', time: 9999 }] } });
  e.mem.mizukiAirSupportFlight = { end: [9, 6], targetTile: [9, 6], offset: [0, 0] };
  advance(39.9); assert.equal(e.alive, true); advance(.2);
  assert.equal(e.alive, false); assert.equal(e.mem.mizukiSelfDestructed, true);
  assert.equal(battle.killed, 0); assert.equal(battle._mizukiLeakDamage || 0, 0);
  assert.ok(snapshotOfficialAirSupportEffects(battle).every((s) => !s.active));
  assert.equal(battle.errorCount, 0);
});

test('original drone impact uses a three-by-three square and independently stacking five-second defense halves', (t) => {
  const { battle, target, advance } = fixture(t); const center = target(10, 6);
  const diagonal = target(11, 7), outside = target(12, 8);
  const e = battle.spawnEnemy(DRONE, { pos: [9, 6], countInTotal: false,
    route: { motion: 'FLY', start: [9, 6], end: [9, 6], checkpoints: [{ type: 'WAIT', time: 9999 }] } });
  e.mem.mizukiAirSupportFlight = { end: [9, 6], targetTile: [9, 6], offset: [0, 0] };
  battle.addBuff(e, { key: 'test:hold', flags: { disarm: true }, persist: true });
  advance(.1);
  const ability = e.mem.mizukiAirSupportDrone;
  const attack = () => ability.attack({ targets: [center] }, battle, e, ability);
  attack(); advance(.3);
  assert.equal(center.s.def, 500); assert.equal(diagonal.s.def, 500); assert.equal(outside.s.def, 1000);
  attack(); advance(.3); assert.equal(center.s.def, 250); assert.equal(diagonal.s.def, 250);
  battle.addBuff(e, { key: 'test:hold', flags: { disarm: true }, persist: true });
  advance(5.1); assert.equal(center.s.def, 1000); assert.equal(diagonal.s.def, 1000);
  assert.equal(battle.errorCount, 0);
});

test('real ro2_n_4_7 loads original drone dependency and summons from its activated weighted hangar', (t) => {
  const source = createMizukiCatalog(getData()).source;
  const stage = createOfficialMizukiStage('ro2_n_4_7', { data: source, seed: 77 });
  const c = new MizukiCombat({ ...stage, seed: 77, players: [{ playerId: 'p', units: [] }] });
  t.after(() => c.forceEnd());
  const b = c.battle; b.step();
  const hangars = b.units.filter((u) => u.defId === 'trap_037_airsup');
  assert.equal(hangars.length, 1);
  assert.equal(b.data.getEnemy(DRONE).maxHp, 8000);
  const target = b.spawnToken(null, 'test:actual_stage_target', 3, 4, {
    def: { name: 'target', stats: { maxHp: 100000, atk: 0, def: 1000, blockCnt: 0 },
      profession: 'TOKEN', position: 'MELEE', rangeGrid: [], attackKind: 'none' },
    kit: { trait: { attack: 'none', noAttack: true } },
  });
  assert.ok(target);
  const commander = b.spawnEnemy(COMMANDER, { pos: [3, 5], countInTotal: false });
  for (let n = 0; n < Math.ceil(2.3 / b.dt); n++) b.step();
  const command = commander.mem.mizukiAirSupportCommand;
  assert.equal(command.casts, 1); assert.equal(command.hangar, hangars[0]);
  const drone = b.enemies.find((u) => u.id === command.droneId);
  assert.ok(drone); assert.equal(drone.mem._mizukiOfficialKit, true);
  assert.equal(drone.counted, false); assert.equal(drone.mem.mizukiAirSupportDrone.expiresAt > b.time, true);
  assert.deepEqual(c.officialWaves.snapshot().unsupported, []);
  assert.equal(b.errorCount, 0);
});
