// RO2-only enm_pfb_7 commander and air-defense drone behaviors.
// Original evidence: docs/research/mizuki-native-air-defense-enemies.md.
import { T, spawnChildren } from '../../sim/content/enemies.js';
import { ENEMY_COLLIDER_RADIUS } from '../../sim/constants.js';

export const MIZUKI_DEFENSE_DRONE_ID = 'enemy_1146_defspd_2';
const ATTACK_DRONE = 'enemy_1145_atkspd_2';
const EFFECTS = new WeakMap();
const OFFSET = .20000000298023224, REACHED = .05000000074505806;
const selectable = (u) => u.alive && u.deployed && !u.hidden
  && !u.s.flags.untargetable && !u.s.flags.sleep && !u.s.flags.stealth;

function effect(b, owner, key, active = true, target = owner, tile = null) {
  let states = EFFECTS.get(b);
  if (!states) { states = new Map(); EFFECTS.set(b, states); }
  const id = 'airdef:' + owner.id + ':' + key + ':' + (tile ? tile.join(',') : target.id);
  if (states.get(id)?.active === active) return;
  const state = { id, key, ownerId: owner.id, unitId: tile ? null : target.id,
    x: tile ? tile[1] : target.x, y: tile ? tile[0] : target.y, active, loop: true, since: b.time };
  states.set(id, state); b.fx('mizuki:effect', { ...state, phase: active ? 'start' : 'stop' });
}
function stopEffects(b, owner) {
  for (const state of EFFECTS.get(b)?.values() || []) {
    if (state.ownerId !== owner.id || !state.active) continue;
    state.active = false;
    b.fx('mizuki:effect', { ...state, phase: 'stop' });
  }
}
const oneShot = (b, u, key) => b.fx('mizuki:effect', { key, unitId: u.id, x: u.x, y: u.y });

export function snapshotNativeAirDefenseEffects(battle) {
  return [...(EFFECTS.get(battle)?.values() || [])].filter((v) => v.active).map((v) => ({ ...v }));
}

const firstHangar = (b) => b.units.find((u) => u.alive && u.deployed && !u.hidden && u.findBuff('trap_airsup_base')) || null;
function summon(b, owner, id, tile, hangar = undefined) {
  const source = hangar === undefined ? firstHangar(b) : hangar;
  if (!source?.alive || !b.data.getEnemy(id)) return null;
  // Native scheduler offsets every point of the route by the same independent
  // x/y sample, retaining the source collider's +/-0.2 sub-tile placement.
  const dx = (b.rng() * 2 - 1) * OFFSET, dy = (b.rng() * 2 - 1) * OFFSET;
  const start = [source.tileR + dy, source.tileC + dx], end = [tile[0] + dy, tile[1] + dx];
  const route = { motion: 'FLY', start, end,
    checkpoints: [{ type: 'MOVE', pos: end }, { type: 'WAIT', time: 9999 }] };
  const drone = spawnChildren(b, owner, id, 1, { route, pos: start, countInTotal: false })[0];
  if (!drone) return null;
  for (const leg of drone.route.legs) if (leg.t === 'move') { leg.r = end[0]; leg.c = end[1]; }
  drone.mem.mizukiAirSupportFlight = { targetTile: tile.slice(), end, offset: [dy, dx], commanderId: owner.id };
  drone._officialDontBlockWave = false;
  effect(b, drone, id === MIZUKI_DEFENSE_DRONE_ID ? 'enemy_defspd_buff_02' : 'enemy_atkspd_buff_02', true, drone, tile);
  return drone;
}

function attackEffects(b, e, a, keys) {
  if (e.swing && !a.swing) for (const key of keys) oneShot(b, e, key);
  a.swing = !!e.swing;
}

function nativeDefenseCommander(ab) {
  const skill = ab.sk.AirSupportDef;
  if (!skill || !(skill.bb.duration > 0)) throw new TypeError('Native AirSupportDef blackboard required');
  const castBuff = 'mizuki:mershd:cast';
  const able = (b, e) => !e.s.flags.stun && b.time >= e.unbalanceUntil;
  const end = (b, e, a) => {
    if (!a.casting) return;
    a.casting = false; a.timer?.cancel(); b.removeBuff(e, castBuff);
    e.skillAnimUntil = b.time; effect(b, e, 'enemy_mershd_buff_02', false);
    if (a.tile) effect(b, e, 'enemy_defspd_buff_01', false, e, a.tile);
  };
  const start = (b, e, a) => {
    if (a.used || !e.alive || !(e.hp / e.s.maxHp < T(ab, 'HalfHPCallDef.hp_ratio')) || !able(b, e)) return;
    a.used = true; a.casting = true; a.tile = [e.tileR, e.tileC];
    a.hangar = firstHangar(b);
    // Original TriggerEnemySkill interrupts the current attack, clears palsy,
    // and consumes its maxTriggerTime=1 even if the new cast is interrupted.
    for (const buff of e.buffs.slice()) if (buff.status === 'palsy') b.removeBuff(e, buff);
    e.swing = false; e.swingTargets = null; b._cutAttackStand(e);
    b.addBuff(e, { key: castBuff, persist: true, flags: { noMove: true, disarm: true } });
    e.skillAnimUntil = b.time + skill.bb.duration;
    oneShot(b, e, 'enemy_mershd_buff_01'); effect(b, e, 'enemy_mershd_buff_02');
    effect(b, e, 'enemy_defspd_buff_01', true, e, a.tile);
    b._ev(['cast', e.id, skill.slot, skill.bb.duration]);
    a.timer = b.after(skill.bb.duration, () => {
      if (!a.casting || !e.alive) return;
      if (!able(b, e)) { a.interrupted = true; end(b, e, a); return; }
      end(b, e, a);
      a.droneId = summon(b, e, MIZUKI_DEFENSE_DRONE_ID, a.tile, a.hangar)?.id ?? null;
    }, { owner: e });
  };
  return [{
    spawn(_b, e, a, runtime) {
      runtime.atkType = 'phys'; e.profile.melee = true;
      e.def = { ...e.def, attackAnim: { dur: 1, hit: .467 } };
      e.mem.mizukiDefenseCommander = a;
    },
    taken(_c, b, e, a) { start(b, e, a); },
    status(_c, b, e, a) {
      if (a.casting && !able(b, e)) { a.interrupted = true; end(b, e, a); }
    },
    tick(b, e, a, dt) {
      if (a.casting && !able(b, e)) { a.interrupted = true; end(b, e, a); }
      a.check = (a.check || 0) + dt;
      if (a.check >= .1 - 1e-9) { a.check %= .1; start(b, e, a); }
      attackEffects(b, e, a, ['enemy_mershd_attack_01_start']);
    },
    attack(c, b) { for (const u of c.targets) oneShot(b, u, 'enemy_mershd_attack_01_hit'); },
    death(_c, b, e, a) { end(b, e, a); stopEffects(b, e); },
  }];
}

function nativeLegendaryCommander(ab) {
  const ratio = T(ab, 'HalfHPCallDef.hp_ratio'), speed = T(ab, 'AirSupSpeedUp.move_speed');
  if (!(ratio > 0) || !Number.isFinite(speed)) throw new TypeError('Native merlgd blackboards required');
  const speedKey = 'merlgd_airsup_spdup';
  const clearAura = (b, e, a) => {
    for (const u of a.aura || []) {
      if (u.findBuff(speedKey)?.source === e) b.removeBuff(u, speedKey);
      effect(b, e, 'enemy_merlgd_attack_buff_01', false, u);
    }
    a.aura?.clear();
  };
  const ready = (b, e, a) => { if (a.defCalled && a.atkCalled) effect(b, e, 'enemy_merlgd_buff_01', false); };
  const signal = (b, e) => {
    effect(b, e, 'enemy_merlgd_buff_02');
    b.after(1, () => effect(b, e, 'enemy_merlgd_buff_02', false), { owner: e });
  };
  const defense = (b, e, a) => {
    if (a.defCalled || !e.alive || !(e.hp / e.s.maxHp < ratio)) return;
    a.defCalled = true; signal(b, e);
    a.defDroneId = summon(b, e, MIZUKI_DEFENSE_DRONE_ID, [e.tileR, e.tileC])?.id ?? null;
    ready(b, e, a);
  };
  const beginAttack = (b, e, a, target) => {
    if (a.atkStarted || !target) return;
    a.atkStarted = true; signal(b, e);
    // The common ability starts alongside the main attack and snapshots its
    // source/target tiles before waiting for the owner's OnAttack event.
    a.pendingAtk = { tile: [target.tileR, target.tileC], hangar: firstHangar(b) };
  };
  const releaseAttack = (b, e, a) => {
    if (!a.pendingAtk || a.atkCalled) return;
    a.atkCalled = true;
    a.atkDroneId = summon(b, e, ATTACK_DRONE, a.pendingAtk.tile, a.pendingAtk.hangar)?.id ?? null;
    a.pendingAtk = null; ready(b, e, a);
  };
  return [{
    spawn(b, e, a, runtime) {
      runtime.atkType = 'phys'; e.profile.melee = true;
      e.def = { ...e.def, attackAnim: { dur: 1.933, hit: .8 } };
      a.aura = new Set(); e.mem.mizukiLegendaryCommander = a;
      effect(b, e, 'enemy_merlgd_buff_01');
    },
    taken(_c, b, e, a) { defense(b, e, a); },
    tick(b, e, a) {
      // AirSupSpeedUp is global, not the commander's attack radius. Same key
      // maxStackCnt=1 prevents multiple commanders multiplying the aura.
      const current = new Set(b.enemies.filter((u) => selectable(u) && u.findBuff('airsup_drone')));
      for (const u of a.aura) if (!current.has(u)) {
        if (u.findBuff(speedKey)?.source === e) b.removeBuff(u, speedKey);
        effect(b, e, 'enemy_merlgd_attack_buff_01', false, u);
      }
      for (const u of current) {
        b.addBuff(u, { key: speedKey, source: e, persist: true, refresh: 'replace', mods: { moveMul: 1 + speed } });
        effect(b, e, 'enemy_merlgd_attack_buff_01', true, u);
      }
      a.aura = current;
      if (e.swing && !a.swing) beginAttack(b, e, a, e.swingTargets?.[0]);
      attackEffects(b, e, a, ['enemy_merlgd_attack_start_01', 'enemy_merlgd_attack_start_02', 'enemy_merlgd_attack_start_03']);
    },
    before(c, b, e, a) {
      beginAttack(b, e, a, c.targets[0]); releaseAttack(b, e, a);
    },
    attack(c, b) {
      for (const u of c.targets) oneShot(b, u, 'enemy_merlgd_attack_hit');
    },
    death(_c, b, e, a) { clearAura(b, e, a); stopEffects(b, e); },
  }];
}

function nativeDefenseDrone(ab) {
  const fuel = T(ab, 'SelfDestruction.duration'), def = T(ab, 'DefAndHpRecoveryUp.def');
  const regen = T(ab, 'DefAndHpRecoveryUp.hp_recovery_per_sec'), buffKey = 'defspd_def_hprecover_up';
  if (!(fuel > 0) || !Number.isFinite(def) || !Number.isFinite(regen)) throw new TypeError('Native defense drone blackboards required');
  const clear = (b, e, a) => {
    for (const u of a.targets || []) {
      if (u.findBuff(buffKey)?.source === e) b.removeBuff(u, buffKey);
      effect(b, e, 'enemy_defspd_skill_buff_01', false, u);
    }
    a.targets?.clear();
  };
  return [{
    spawn(b, e, a) {
      e.profile.noAttack = true; a.targets = new Set(); a.expiresAt = b.time + fuel;
      e.mem.mizukiDefenseDrone = a; b.addBuff(e, { key: 'airsup_drone', persist: true });
      b.after(fuel, () => {
        if (!e.alive) return;
        e.mem.mizukiSelfDestructed = true; b.removeBuff(e, 'log_killed'); b.kill(e, null);
      }, { owner: e });
    },
    tick(b, e, a) {
      const flight = e.mem.mizukiAirSupportFlight;
      if (!a.activated && flight && (e.x - flight.end[1]) ** 2 + (e.y - flight.end[0]) ** 2 <= REACHED ** 2) {
        a.activated = true;
        effect(b, e, 'enemy_defspd_buff_02', false, e, flight.targetTile);
        effect(b, e, 'enemy_defspd_attack_buff_01');
      }
      if (!a.activated || e.s.flags.silence) { clear(b, e, a); return; }
      // Original CircleRange is fixed 2.5, collision-selected, self EXCLUDE.
      const current = new Set(b.enemiesInRadius(e.x, e.y, 2.5 + ENEMY_COLLIDER_RADIUS)
        .filter((u) => u !== e && selectable(u)));
      for (const u of a.targets) if (!current.has(u)) {
        if (u.findBuff(buffKey)?.source === e) b.removeBuff(u, buffKey);
        effect(b, e, 'enemy_defspd_skill_buff_01', false, u);
      }
      for (const u of current) {
        b.addBuff(u, { key: buffKey, source: e, persist: true, refresh: 'replace', mods: { defFlat: def, hpRegen: regen } });
        effect(b, e, 'enemy_defspd_skill_buff_01', true, u);
      }
      a.targets = current;
    },
    death(_c, b, e, a) { clear(b, e, a); stopEffects(b, e); },
  }];
}

export const MIZUKI_AIR_DEFENSE_KITS = {
  enemy_1142_mershd_2: nativeDefenseCommander,
  enemy_1144_merlgd_2: nativeLegendaryCommander,
  enemy_1146_defspd_2: nativeDefenseDrone,
};
