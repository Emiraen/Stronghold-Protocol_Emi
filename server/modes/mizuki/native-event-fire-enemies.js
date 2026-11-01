// Original RO2 event 狂信如火. All adaptations are confined to Mizuki units.
import { T } from '../../sim/content/enemies.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { bodyDist, bodyOnTile } from '../../sim/body.js';
import { roundHalfEven } from '../../sim/detmath.js';
import { aggroCmp, evadesGround } from '../../sim/targeting.js';
import { summonNativeEnemies } from './NativeEnemySpawn.js';

const present = (u) => u.alive && u.deployed && !u.hidden;
const category = (u) => u._mizukiSourceCategory ?? (u.obstacle ? 4 : u.kind === 'device' ? 2 : 1);
const selectable = (u, area = false) => present(u) && category(u) === 1 && u._mizukiSourceSide !== 2
  && !u.s.flags.untargetable && !u.s.flags.sleep && !u.s.flags.stealth && (area || !u.s.flags.camou);
const able = (e) => present(e) && !e.s.flags.stun && !e.s.flags.freeze && !e.s.flags.sleep
  && !e.s.flags.levitate && !e.s.flags.fear && !e.s.flags.disarm;
const fx = (b, u, key, extra = {}) => b.fx('mizuki:effect', { key, unitId: u.id, x: u.x, y: u.y, ...extra });
const near = (u, x, y, radius) => bodyDist(u, x, y) <= radius + ALLY_COLLIDER_RADIUS + 1e-9;
const onTile = (e, u) => bodyOnTile(u, roundHalfEven(e.y), roundHalfEven(e.x));

function nativeCadet(ab) {
  const skill = ab.sk.ChargeAttack;
  if (!skill) throw new TypeError('Missing original ChargeAttack');
  const stopChargeEffects = (b, e) => {
    for (const [key, suffix] of [['enemy_cadkgt_skill_buff', 'buff'], ['enemy_cadkgt_skill_range', 'range']])
      fx(b, e, key, { id: 'cadkgt:' + e.id + ':' + suffix, loop: true, phase: 'stop', active: false });
  };
  const finish = (b, e) => {
    const state = e.mem.mizukiCadet;
    if (!state.cast) return;
    state.cast = null; e.profile.noAttack = false;
    b.removeBuff(e, 'cadkgt_immune_invisible'); b.removeBuff(e, 'mizuki:cadkgt:cast');
    stopChargeEffects(b, e);
  };
  return [{
    spawn(b, e) {
      e.mem.mizukiCadet = { cast: null };
      e.profile.melee = false; e.profile.dmgType = 'arts'; e.profile.deferHit = true; e.profile.shot = 'none';
      e.profile.canTarget = (u) => !u.isFlying;
      e.def = { ...e.def, attackAnim: { dur: 1.833, hit: .667 } };
      b.addBuff(e, { key: 'cadkgt_t_invisible', persist: true, flags: { stealth: true } });
      for (const key of ['enemy_cadkgt_buff_01', 'enemy_cadkgt_buff_02'])
        fx(b, e, key, { id: 'cadkgt:' + e.id + ':' + key, loop: true });
    },
    before(_c, b, e) { fx(b, e, 'enemy_cadkgt_attack_start'); },
    attack(c, b, e) {
      const target = c.targets[0]; if (!target) return;
      const p = b.addProjectile({ from: e, source: e, target, speed: 10, maxAge: 10, visual: 'none',
        onHit({ target: direct }) {
          if (!direct) return;
          b.dealDamage(e, direct, { amount: e.s.atk, type: 'arts', isAttack: true, isProjectile: true });
          fx(b, direct, 'enemy_cadkgt_attack_hit');
        } });
      fx(b, e, 'enemy_cadkgt_attack_trail', { id: 'cadkgt:' + p.id,
        to: { x: target.x, y: target.y }, toUnitId: target.id, speed: 10, loop: false });
    },
    status(_c, b, e) { if (!able(e)) finish(b, e); },
    death(_c, b, e) { finish(b, e); },
  }, {
    cd: skill.cd, left: skill.icd, sk: skill, sil: true,
    cond(b, e) {
      return able(e) && !e.mem.mizukiCadet.cast && b.allyUnits.some((u) => selectable(u)
        && !u.isFlying && !evadesGround(e, u) && near(u, e.x, e.y, e.base.rangeRadius));
    },
    fire(b, e) {
      const selected = b.allyUnits.filter((u) => selectable(u) && !u.isFlying
        && !evadesGround(e, u) && near(u, e.x, e.y, e.base.rangeRadius)).sort(aggroCmp);
      const target = selected[0]; if (!target) return;
      // Native selectTargetSource=SELECTOR fixes the input point at cast start.
      const cast = { x: target.x, y: target.y }; e.mem.mizukiCadet.cast = cast;
      const duration = skill.bb.duration;
      e.swing = false; e.swingTargets = null; e.profile.noAttack = true; e.skillAnimUntil = b.time + duration;
      b.addBuff(e, { key: 'mizuki:cadkgt:cast', duration, flags: { noMove: true } });
      b.addBuff(e, { key: 'cadkgt_immune_invisible', duration, flags: { reveal: true } });
      fx(b, e, 'enemy_cadkgt_skill_buff', { id: 'cadkgt:' + e.id + ':buff', duration, loop: true });
      fx(b, { ...e, ...cast }, 'enemy_cadkgt_skill_range', { id: 'cadkgt:' + e.id + ':range', unitId: null, duration, loop: true });
      // ThreePartChannelingAnimation fits begin(.667)+loop+end(2) inside
      // LOAD_FROM_BLACKBOARD duration7. Skill_End's OnAttack is .667s in.
      const endAt = duration - 2, hitAt = endAt + .667;
      b.after(hitAt, () => {
        if (e.mem.mizukiCadet.cast !== cast || !able(e)) return;
        cast.released = true; stopChargeEffects(b, e);
        fx(b, e, 'enemy_cadkgt_skill_start'); fx(b, e, 'enemy_cadkgt_skill_buff_end');
        // Native projectile immediately reaches the cached input point; its
        // radius BB selects every motion and ignores camouflage.
        fx(b, { ...e, ...cast }, 'enemy_cadkgt_skill_hit', { unitId: null });
        for (const u of b.allyUnits) if (selectable(u, true) && !evadesGround(e, u)
          && near(u, cast.x, cast.y, skill.bb.range_radius))
          b.dealDamage(e, u, { amount: e.s.atk * skill.bb.atk_scale, type: 'arts', isSkill: true, isProjectile: true });
      }, { owner: e });
      b.after(duration, () => { if (e.mem.mizukiCadet.cast === cast) finish(b, e); }, { owner: e });
    },
    tick(b, e) { if (e.mem.mizukiCadet.cast && !able(e)) finish(b, e); },
  }];
}

function nativeShaper(ab) {
  const ranged = ab.sk.SummonFireBall, combat = ab.sk.SummonFireBall2;
  if (!ranged || !combat) throw new TypeError('Missing original SummonFireBall skills');
  return [{
    spawn(_b, e) { e.profile.noAttack = true; e.mem.mizukiShaper = { cast: null }; },
    status(_c, b, e) {
      if (able(e)) return;
      e.mem.mizukiShaper.cast = null; b.removeBuff(e, 'mizuki:dusocr:cast');
    },
  }, ...[[ranged, false], [combat, true]].map(([skill, blocked]) => ({
    cd: skill.cd, left: skill.icd, sk: skill,
    // Original masks ATTACK=1 / COMBAT=2, not two simultaneous summons.
    // Both skill timers run; silence is explicitly ignored by each skill.
    cond(_b, e) { return able(e) && !!e.blockedBy === blocked && !e.mem.mizukiShaper.cast; },
    fire(b, e) {
      const cast = {}; e.mem.mizukiShaper.cast = cast; e.swing = false; e.swingTargets = null;
      e.skillAnimUntil = b.time + 1.333;
      b.addBuff(e, { key: 'mizuki:dusocr:cast', duration: 1.333, flags: { noMove: true } });
      fx(b, e, 'enemy_dusocr_2_attack_01_stait', { duration: 1.333 });
      b.after(.767, () => {
        if (e.mem.mizukiShaper.cast !== cast || !able(e)) return;
        const enemyKey = skill.bs.enemy_key;
        if (!enemyKey) throw new TypeError('Missing original fireball enemy_key');
        summonNativeEnemies(b, e, enemyKey, { count: skill.bb.cnt });
      }, { owner: e });
      b.after(1.333, () => {
        if (e.mem.mizukiShaper.cast !== cast) return;
        e.mem.mizukiShaper.cast = null; b.removeBuff(e, 'mizuki:dusocr:cast');
      }, { owner: e });
    },
  }))];
}

function nativeFlame(ab) {
  const lifetime = T(ab, 'Weaken.duration'), reduction = T(ab, 'Weaken.atk');
  if (!(lifetime > 0) || !Number.isFinite(reduction)) throw new TypeError('Missing original fireball Weaken');
  const finish = (b, e) => {
    if (!e.alive) return;
    fx(b, e, 'enemy_dusocr_2_attack_01_trail_Die'); b.kill(e, null);
  };
  const hit = (b, e, u) => {
    b.dealDamage(e, u, { amount: e.s.atk, type: 'arts', isAttack: true });
    b.dealDamage(e, u, { amount: e.s.atk * T(ab, 'epdamage.attack@ep_damage_ratio'), type: 'element', element: 'burn' });
    fx(b, u, 'enemy_duspfr_2_Die_01_hit');
  };
  return [{
    spawn(b, e, a) {
      e.profile.noAttack = true; a.age = 0; a.cast = null; e.mem.mizukiFlame = a;
      // Native IgnoreAllButMoveCp(true): inherit the route's MOVE checkpoints,
      // bypassing the host's waits, disappear/appear and other cursor commands.
      e.route.legs = e.route.legs.filter((leg) => leg.t === 'move'); e.route.legIdx = 0;
      b.addBuff(e, { key: 'dufrbl_invincible', persist: true, flags: { invulnerable: true, untargetable: true } });
      b.addBuff(e, { key: 'dufrbl_t', persist: true, mods: { atkMul: 1 } });
      fx(b, e, 'enemy_dusocr_2_attack_01_trail', { id: 'dufrbl:' + e.id, loop: true });
    },
    tick(b, e, a, dt) {
      a.age += dt;
      if (a.age >= lifetime - 1e-9) { finish(b, e); return; }
      if (!a.cast) {
        // Original timed template updates ATK multiplier every .1 seconds.
        // A cast adds dufrbl_t[stop_weaken], retaining its current multiplier.
        const steps = Math.floor((a.age + 1e-9) * 10);
        const buff = e.findBuff('dufrbl_t');
        buff.mods.atkMul = 1 + reduction * Math.min(1, steps / (lifetime * 10)); e.markDirty();
      }
      if (a.cast || !able(e)) return;
      const obstacle = b.units.find((u) => present(u) && category(u) === 4 && !u.isFlying && onTile(e, u));
      const direct = b.allyUnits.find((u) => selectable(u) && !u.isFlying && !evadesGround(e, u) && onTile(e, u));
      if (!obstacle && !direct) return;
      a.cast = { direct }; e.swing = false; e.swingTargets = null;
      b.addBuff(e, { key: 'dufrbl_t[stop_weaken]', persist: true });
      b.addBuff(e, { key: 'mizuki:dufrbl:cast', persist: true, flags: { noMove: true } });
      // DeadBoom sequence: AttackObstacle's .1s delay precedes AttackNormal.
      b.after(.1, () => {
        if (!e.alive) return;
        const wall = b.units.find((u) => present(u) && category(u) === 4 && !u.isFlying && onTile(e, u));
        if (wall) { hit(b, e, wall); fx(b, e, 'enemy_dusocr_2_attack_01_hit'); }
        const targets = b.allyUnits.filter((u) => selectable(u, true) && !u.isFlying
          && !evadesGround(e, u) && near(u, e.x, e.y, 2));
        if (direct && present(direct) && !targets.includes(direct)) targets.push(direct);
        for (const u of targets) hit(b, e, u);
        finish(b, e);
      }, { owner: e });
    },
    death(_c, b, e) {
      fx(b, e, 'enemy_dusocr_2_attack_01_trail', { id: 'dufrbl:' + e.id, loop: true, phase: 'stop', active: false });
    },
  }];
}

export const MIZUKI_EVENT_FIRE_KITS = {
  enemy_1184_cadkgt: nativeCadet,
  enemy_1184_cadkgt_2: nativeCadet,
  enemy_1176_dusocr: nativeShaper,
  enemy_1177_dufrbl: nativeFlame,
};

// Reconnection snapshots must retain the sprite-less fireball and active charge
// loops, just as their original buff effects survive between animation events.
export function snapshotMizukiEventFireEffects(battle) {
  const effects = [];
  for (const e of battle.enemies) {
    if (!present(e)) continue;
    const add = (key, extra = {}) => effects.push({ key, unitId: e.id, x: e.x, y: e.y, loop: true, active: true, ...extra });
    if (e.mem.mizukiFlame) add('enemy_dusocr_2_attack_01_trail', { id: 'dufrbl:' + e.id });
    if (!e.mem.mizukiCadet) continue;
    for (const key of ['enemy_cadkgt_buff_01', 'enemy_cadkgt_buff_02']) add(key, { id: 'cadkgt:' + e.id + ':' + key });
    const cast = e.mem.mizukiCadet.cast;
    if (!cast || cast.released) continue;
    add('enemy_cadkgt_skill_buff', { id: 'cadkgt:' + e.id + ':buff' });
    add('enemy_cadkgt_skill_range', { id: 'cadkgt:' + e.id + ':range', unitId: null, x: cast.x, y: cast.y });
  }
  return effects;
}
