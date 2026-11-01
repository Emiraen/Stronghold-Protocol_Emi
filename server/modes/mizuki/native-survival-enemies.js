// RO2-only native enemy abilities. Evidence is retained in
// docs/research/mizuki-native-survival-enemies.md; nothing patches shared KITS.
import { T, setForm } from '../../sim/content/enemies.js';
import { applyHpLoss, makeDamageInfo } from '../../sim/damage.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { aggroCmp } from '../../sim/targeting.js';

function nativeRageth(ab) {
  return [{
    iv: 1,
    spawn(_b, e, _a, runtime) {
      runtime.atkType = 'phys';
      e.profile.melee = false;
      e.profile.deferHit = true;
      e.profile.shot = 'none';
      e.profile.canTarget = (u) => !u.isFlying;
      // enm_pfb_4 CircleRange: not extendable/scalable; DB rangeRadius is unused.
      e.base.rangeRadius = 2;
      e.markDirty();
      // Original Spine Attack: duration 2.5, OnAttack at 1.467 seconds.
      e.def = { ...e.def, attackAnim: { dur: 2.5, hit: 1.467 } };
    },
    tick(b, e) {
      const amount = T(ab, 'periodic_damage.damage');
      if (!(amount > 0)) return;
      // periodic_damage_without_modify: NoSourceDamage(PURE),
      // damageWithoutModify=true, ignoreForSp=true. This is a damage event,
      // not a hpLoss-tagged drain, and ignores DEF/RES/modifiers/shields.
      applyHpLoss(b, null, e, amount, makeDamageInfo({ amount, type: 'true',
        sourceless: true, noSp: true, canDodge: false, tags: ['dot', 'periodic', 'mizuki:rageth'] }));
    },
    attack(c, b, e) {
      const target = c.targets[0];
      if (!target) return;
      const attackId = b._attackSeq;
      const p = b.addProjectile({ from: e, target, source: e, speed: 18, maxAge: 10, visual: 'none',
        onHit({ target: direct, x, y }) {
          if (!direct) return;
          b.fx('mizuki:effect', { key: 'rageth_attack_01_hit', unitId: direct.id, x, y });
          // Native useCachedAtkOnly=0 / stopWhenSourceInvalid=0: use current
          // attack even after the thrower's death; preserve projectile damage.
          b.dealDamage(e, direct, { amount: e.s.atk, type: 'phys', isAttack: true,
            attackId, isProjectile: true });
        } });
      b.fx('mizuki:effect', { id: 'rageth:projectile:' + p.id, key: 'rageth_attack_01_trail',
        x: e.x, y: e.y, to: { x: target.x, y: target.y }, toUnitId: target.id, speed: 18, loop: false });
    },
  }];
}

export function isNativeDevoured(unit) {
  return unit?.mem?.mizukiDevouredBy != null;
}

function devourImmune(unit) {
  if (unit.kind === 'device' || unit.def?.profession === 'TRAP') return true;
  return [unit.filterTags, unit.def?.filterTags, unit.def?.raw?.filterTags, unit.mem?.filterTags]
    .some((tags) => tags?.has?.('DEVOUR_IMMU') || (Array.isArray(tags) && tags.includes('DEVOUR_IMMU')));
}

function devourEffect(b, e, active) {
  b.fx('mizuki:effect', { id: 'nhkodo:devour:' + e.id, key: 'enemy_nhkodo_attack_01_start',
    unitId: e.id, x: e.x, y: e.y, active, loop: true, phase: active ? 'start' : 'stop' });
}

function nativeDevour(ab) {
  const skill = ab.sk.Devour;
  if (!skill) throw new TypeError('Missing native nhkodo Devour skill');
  const castingBuff = 'mizuki:nhkodo:casting';
  const able = (b, e) => e.alive && e.deployed && !e.hidden && !e.s.flags.stun && !e.s.flags.freeze
    && !e.s.flags.sleep && !e.s.flags.levitate && b.time >= e.unbalanceUntil;
  const valid = (b, e, a) => able(b, e) && a.target?.alive && a.target.deployed
    && !a.target.hidden && a.target.deploySeq === a.targetSeq;
  const targetOf = (b, e) => b.alliesInRadius(e.x, e.y, .7 + ALLY_COLLIDER_RADIUS)
    .filter((u) => !u.isFlying && !devourImmune(u)).sort(aggroCmp)[0];
  const finish = (b, e, a) => {
    if (!a.active) return;
    a.active = false;
    delete e.mem.mizukiDevourCasting;
    e.profile.noAttack = a.noAttack;
    e.skillAnimUntil = b.time;
    b.removeBuff(e, castingBuff);
    devourEffect(b, e, false);
  };
  const release = (b, e, a) => {
    const unit = a.swallowed;
    if (unit?.mem.mizukiDevouredBy !== e.id) return;
    delete unit.mem.mizukiDevouredBy;
    // Native card respawn_disabled MarkInvalid(-1) suppresses its countdown;
    // removing HOLD_BY_BUFF makes the next card tick return it ready.
    unit.respawnAt = b.time;
    b.emit('mizuki:devourReleased', { enemy: e, unit });
  };
  return [{
    cd: skill.cd, left: skill.icd, sk: skill,
    spawn(_b, e, _a, runtime) {
      runtime.atkType = 'phys'; e.profile.melee = true;
      // Both modes have a native MeleeAttack combat ability. The separate
      // Devour uses Attack_A, while ordinary mode-zero attacks use Attack_A2.
      e.def = { ...e.def, attackAnim: { dur: 1.5, hit: .833 } };
    },
    cond(b, e, a) { return !a.done && !a.active && able(b, e) && !!targetOf(b, e); },
    fire(b, e, a) {
      const target = targetOf(b, e);
      if (!target) return;
      a.active = true; a.target = target; a.targetSeq = target.deploySeq;
      a.noAttack = e.profile.noAttack; e.profile.noAttack = true;
      e.swing = false; e.swingTargets = null; e.skillAnimUntil = b.time + 1.833;
      const cast = {}; e.mem.mizukiDevourCasting = cast;
      b.addBuff(e, { key: castingBuff, flags: { noMove: true } });
      devourEffect(b, e, true);
      // Original Attack_A OnAttack: 0.833 s. It cannot hit a later deployment
      // of a target that retreated or died during the cast.
      b.after(.833, () => {
        if (e.mem.mizukiDevourCasting !== cast || !a.active) return;
        if (!valid(b, e, a)) { finish(b, e, a); return; }
        a.done = true;
        if (target.kind === 'op') {
          a.swallowed = target;
          target.mem.mizukiDevouredBy = e.id;
        }
        // Native CreateBuffUseTargetAsSource, then InstantKill(killSource),
        // skipReborn=false: resolve real kill hooks rather than huge damage.
        b.kill(target, target);
        if (isNativeDevoured(target)) target.respawnAt = -1;
        finish(b, e, a);
        if (!e.alive) { release(b, e, a); return; }
        b.addBuff(e, { key: 'enemy_nhkodo_buff', persist: true,
          mods: { defFlat: T(ab, 'Stronger.def'), moveMul: 1 + T(ab, 'Stronger.move_speed') } });
        setForm(b, e, 'devoured');
        e.atkCd = e.s.interval;
      }, { owner: e });
    },
    tick(b, e, a) {
      if (a.active && !valid(b, e, a)) finish(b, e, a);
      // Battle's content tick follows AI. The actual ordinary swing begins
      // before this tick; native ON_CAST_START belongs to that transition,
      // not to the damage-frame attack hook below.
      if (a.done && e.swing && !a.swingEffect) b.fx('mizuki:effect', {
        key: 'enemy_nhkodo_attack_02_start', unitId: e.id, x: e.x, y: e.y });
      a.swingEffect = !!e.swing;
    },
    status(_c, b, e, a) { if (a.active && !valid(b, e, a)) finish(b, e, a); },
    death(_c, b, e, a) { finish(b, e, a); release(b, e, a); },
    attack(c, b, e, a) {
      if (!a.done) return;
      for (const target of c.targets) b.fx('mizuki:effect', { key: 'enemy_nhkodo_attack_02_hit',
        unitId: target.id, x: target.x, y: target.y });
    },
  }];
}

export const MIZUKI_SURVIVAL_KITS = {
  enemy_1063_rageth: nativeRageth,
  enemy_1063_rageth_2: nativeRageth,
  enemy_1271_nhkodo: nativeDevour,
};

export function snapshotNativeSurvivalEffects(battle) {
  return battle.enemies.filter((e) => e.alive && e.deployed && !e.hidden && e.mem.mizukiDevourCasting)
    .map((e) => ({ id: 'nhkodo:devour:' + e.id, key: 'enemy_nhkodo_attack_01_start',
      unitId: e.id, x: e.x, y: e.y, active: true, loop: true }));
}
