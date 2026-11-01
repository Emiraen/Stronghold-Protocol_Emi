// Native trap_037_airsup / sktok_airsup and enemy_1141_merbow_2 AirSupportAtk.
// Source prefab flags: INVINCIBLE + HIDDEN; the facility's passive itself
// does not generate drones. SummonEnemyToTileAbility selects trap_airsup_base.
import { T, targetsNear, byPriority, spawnChildren } from '../../sim/content/enemies.js';
import { areaSelectable } from '../../sim/targeting.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';

export const OFFICIAL_AIR_SUPPORT_KEY = 'trap_037_airsup';
export const OFFICIAL_ATTACK_DRONE_KEY = 'enemy_1145_atkspd_2';
const EFFECTS = new WeakMap();
const SOURCE_OFFSET = 0.20000000298023224;
const WAIT_TIME = 9999;
const REACHED_TOLERANCE = 0.05000000074505806;

// The state is merged into the facility snapshot by OfficialStageMechanics.
export function snapshotOfficialAirSupportEffects(battle) {
  return [...(EFFECTS.get(battle)?.values() || [])].map((state) => ({ ...state }));
}
function effect(b, unit, key, active = true, pos = null) {
  let effects = EFFECTS.get(b);
  if (!effects) { effects = new Map(); EFFECTS.set(b, effects); }
  const id = unit.id + ':' + key;
  if (effects.get(id)?.active === active) return;
  const state = { id, key, unitId: pos ? null : unit.id, ownerId: unit.id,
    x: pos ? pos[1] : unit.x, y: pos ? pos[0] : unit.y, dir: unit.dir, active, since: b.time };
  effects.set(id, state);
  b.fx('mizuki:effect', { ...state, phase: active ? 'start' : 'stop', loop: true });
}
const oneShot = (b, unit, key, pos = null) => b.fx('mizuki:effect', { key,
  unitId: pos ? null : unit.id, x: pos ? pos[1] : unit.x, y: pos ? pos[0] : unit.y, dir: unit.dir });
function stopEffects(b, unit) {
  for (const state of EFFECTS.get(b)?.values() || []) if (state.ownerId === unit.id && state.active) {
    effect(b, unit, state.key, false, state.unitId == null ? [state.y, state.x] : null);
  }
}

export function spawnOfficialAirSupport(battle, instance, def, { effect } = {}) {
  if (instance?.inst?.characterKey !== OFFICIAL_AIR_SUPPORT_KEY || def?.key !== OFFICIAL_AIR_SUPPORT_KEY
      || def.skill?.prefabId !== 'sktok_airsup') {
    throw new TypeError('Original air-support instance and resolved definition required');
  }
  const s = def.stats;
  const unit = battle.spawnDevice(def.key, instance.position.row, instance.position.col, {
    name: def.name, hp: s.maxHp, atk: s.atk, def: s.def, res: s.magicResistance,
    bat: s.baseAttackTime, aspd: s.attackSpeed, blockCnt: s.blockCnt, dir: instance.direction || 'RIGHT',
  });
  if (!unit) return null;
  unit._officialFacility = true;
  unit._mizukiSourceSide = def.raw.originalSide;
  unit._mizukiSourceCategory = def.raw.originalCategory;
  unit.mem.mizukiFacilityAlias = instance.alias || def.key;
  unit.mem.mizukiFilterTags = ['factory'];
  unit.mem.mizukiNotWithdrawable = true;
  battle.addBuff(unit, { key: 'trap_airsup_base', persist: true,
    flags: { invulnerable: true, untargetable: true } });
  effect?.(unit, 'trap_037_airsup_buff');
  return unit;
}

/** Original source selector: global TRAP_OR_ITEM with trap_airsup_base,
 * postFilter NONE. OnCastStart takes list[0], rather than a random factory. */
function firstHangar(b) {
  return b.units.find((u) => u.alive && u.deployed && !u.hidden && u.findBuff('trap_airsup_base'));
}

export function createOfficialAirSupportCommand(ab) {
  const skill = ab.sk.AirSupportAtk;
  if (!skill || !(skill.bb.duration > 0)) throw new TypeError('Original AirSupportAtk blackboard required');
  return [{
    iv: 0, sil: true, cd: skill.cd, left: skill.icd, sk: skill,
    spawn(b, e, a, runtime) {
      runtime.atkType = 'phys';
      e.mem.mizukiAirSupportCommand = a;
      b.on('death', ({ unit }) => { if (unit === e) stopEffects(b, e); }, { owner: e });
    },
    cond(b, e, a) {
      if (a.used) return false;
      const ground = targetsNear(b, e, e.base.rangeRadius + ALLY_COLLIDER_RADIUS).filter((u) => !u.isFlying);
      a.target = byPriority(e, ground)[0] || null;
      return !!a.target;
    },
    fire(b, e, a) {
      a.used = true; a.casting = true;
      // Both source and target tile are cached at cast start. A retreated target
      // or a dead commander does not redirect an already released drone.
      a.hangar = firstHangar(b);
      a.tile = [a.target.tileR, a.target.tileC];
      e.skillAnimUntil = b.time + skill.bb.duration;
      b.addBuff(e, { key: 'mizuki:airsup:cast', flags: { noMove: true, disarm: true }, persist: true });
      effect(b, e, 'enemy_merbow_buff_02');
      oneShot(b, e, 'enemy_merbow_buff_01');
      effect(b, e, 'enemy_atkspd_buff_01', true, a.tile);
      a.finishAt = b.time + skill.bb.duration;
      a.timer = b.after(skill.bb.duration, () => {
        if (!e.alive || !a.casting) return;
        a.casting = false; b.removeBuff(e, 'mizuki:airsup:cast');
        stopEffects(b, e);
        if (!a.hangar?.alive || !b.data.getEnemy(OFFICIAL_ATTACK_DRONE_KEY)) return;
        // Scheduler::SpawnSummonedEnemyWithRuntimeRoute samples independent
        // +/-0.2 offsets and applies that offset to the whole locator route.
        const dx = (b.rng() * 2 - 1) * SOURCE_OFFSET;
        const dy = (b.rng() * 2 - 1) * SOURCE_OFFSET;
        const start = [a.hangar.tileR + dy, a.hangar.tileC + dx];
        const end = [a.tile[0] + dy, a.tile[1] + dx];
        const route = { motion: 'FLY', start, end,
          checkpoints: [{ type: 'MOVE', pos: end }, { type: 'WAIT', time: WAIT_TIME }] };
        const drone = spawnChildren(b, e, OFFICIAL_ATTACK_DRONE_KEY, 1, { route, pos: start, countInTotal: false })[0];
        if (!drone) return;
        // Shared compileRoute clamps integer checkpoints to the automatic
        // field. Native air-support locators retain sub-tile edge offsets.
        for (const leg of drone.route.legs) if (leg.t === 'move') { leg.r = end[0]; leg.c = end[1]; }
        drone.mem.mizukiAirSupportFlight = { targetTile: a.tile.slice(), end, offset: [dy, dx], commanderId: e.id };
        drone._officialDontBlockWave = false;
        a.droneId = drone.id;
        effect(b, drone, 'enemy_atkspd_buff_02', true, a.tile);
      }, { owner: e });
    },
    tick(b, e, a) {
      if (!a.casting || !(e.s.flags.stun || e.s.flags.freeze || e.s.flags.sleep || e.s.flags.palsy)) return;
      // Native OnCastEnd(non-success) releases the telegraph without summoning.
      a.casting = false; a.interrupted = true; a.timer?.cancel();
      b.removeBuff(e, 'mizuki:airsup:cast'); stopEffects(b, e);
      e.skillAnimUntil = b.time;
    },
  }];
}

export function createOfficialAttackDroneAbilities(ab) {
  const fuel = T(ab, 'SelfDestruction.duration');
  const duration = T(ab, 'DefDown.duration'), multiplier = T(ab, 'DefDown.def');
  if (!(fuel > 0) || !(duration > 0) || !Number.isFinite(multiplier)) {
    throw new TypeError('Original attack-drone talents required');
  }
  const defenseDown = (b, e, target, a) => {
    if (!target.alive || e.s.flags.silence) return;
    b.addBuff(target, { key: 'atkspd_def_down:' + e.id + ':' + ++a.hitCount, source: e, duration,
      mods: { defMul: multiplier }, visible: true });
    oneShot(b, target, 'buff_defdown');
  };
  return [{
    iv: 0,
    spawn(b, e, a, runtime) {
      runtime.atkType = 'phys'; a.hitCount = 0;
      e.mem.mizukiAirSupportDrone = a;
      e.profile.deferHit = true; e.profile.shot = 'none';
      b.addBuff(e, { key: 'airsup_drone', persist: true });
      b.addBuff(e, { key: 'atkspd_disarm', flags: { disarm: true }, persist: true });
      a.expiresAt = b.time + fuel;
      b.on('death', ({ unit }) => { if (unit === e) stopEffects(b, e); }, { owner: e });
      b.after(fuel, () => {
        if (!e.alive) return;
        // enemy_suicide_on_buff_end first removes log_killed. No operator is
        // credited, and the original unharmful summon never charges life.
        e.mem.mizukiSelfDestructed = true;
        b.removeBuff(e, 'log_killed'); b.kill(e, null);
      }, { owner: e });
    },
    tick(b, e, a) {
      if (a.activated) return;
      const flight = e.mem.mizukiAirSupportFlight;
      if (!flight) return;
      // Native GetLocatorPosition subtracts its route offset; CheckReached
      // compares that locator with the end tile using a 0.05 tolerance.
      const dx = e.x - flight.end[1], dy = e.y - flight.end[0];
      if (dx * dx + dy * dy > REACHED_TOLERANCE ** 2) return;
      a.activated = true; b.removeBuff(e, 'atkspd_disarm');
      b.addBuff(e, { key: 'atkspd_activated', persist: true });
      effect(b, e, 'enemy_atkspd_buff_02', false, flight.targetTile);
      effect(b, e, 'enemy_atkspd_attack_buff_01');
    },
    attack(c, b, e, a) {
      if (!a.activated) return;
      const target = c.targets[0]; if (!target) return;
      oneShot(b, e, 'enemy_atkspd_attack_start_01');
      oneShot(b, e, 'enemy_atkspd_attack_start_02');
      const atk = e.s.atk, attackId = b._attackSeq;
      b.addProjectile({ from: e, target, source: e, speed: 5, maxAge: 10, visual: 'enemy',
        onHit({ target: direct, x, y }) {
          // The original projectile has a 3x3 BoxCollider2D, not a circle.
          const targets = b.allyUnits.filter((u) => (u === direct || areaSelectable(e, u))
            && Math.abs(u.x - x) <= 1.5 && Math.abs(u.y - y) <= 1.5);
          oneShot(b, { x, y, dir: e.dir }, 'enemy_atkspd_attack_hit');
          for (const unit of targets) {
            b.dealDamage(e, unit, { amount: atk, type: 'phys', isAttack: true, attackId, isProjectile: true });
            defenseDown(b, e, unit, a);
          }
        },
      });
    },
  }];
}
