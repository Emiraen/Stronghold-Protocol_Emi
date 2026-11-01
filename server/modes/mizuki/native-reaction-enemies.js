import { T, hurt, elem, targetsNear, areaAlliesInTiles, castSlot, setForm } from '../../sim/content/enemies.js';
import { artsBarrier } from '../../sim/content/enemies/archetypes.js';
import { applyHpLoss, makeDamageInfo } from '../../sim/damage.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';

function nativeReaper(ab) {
  return [{
    iv: 1,
    spawn(b, e, a) {
      a.awake = false; e.profile.noAttack = true;
      const duration = T(ab, 'sleepwalking.unmove_duration');
      if (duration > 0) b.addBuff(e, { key: 'mizuki:dslntc:waiting', duration, flags: { noMove: true } });
    },
    wake(b, e, a) {
      if (a.awake || !(e.hpRatio < (T(ab, 'sleepwalking.hp_ratio') ?? 0)) || b.time < e.unbalanceUntil) return;
      a.awake = true; a._acc = 0; e.profile.noAttack = false;
      b.removeBuff(e, 'mizuki:dslntc:waiting');
      b.addBuff(e, { key: 'mizuki:dslntc:awake', mods: { moveMul: 1 + (T(ab, 'revive.move_speed') ?? 0) }, persist: true });
      castSlot(b, e, ab.sk.Awake); setForm(b, e, 'awakened');
    },
    taken(_c, b, e, a) { a.wake(b, e, a); },
    dealt(c, b, e, a) { if (a.awake) elem(b, e, c.target, 'neural', e.s.atk * (T(ab, 'epdamage.attack@ep_damage_ratio') ?? 0)); },
    tick(b, e, a) {
      a.wake(b, e, a); if (!a.awake) return;
      const amount = e.s.maxHp * (T(ab, 'revive.hp_ratio') ?? 0);
      // Original DamageViaMaxHpRatio(PURE, skipModifierEvent, ignoreForSp).
      if (amount > 0) applyHpLoss(b, e, e, amount, makeDamageInfo({ amount, type: 'true', noSp: true,
        canDodge: false, tags: ['dot', 'periodic', 'mizuki:dslntc'] }));
      if (!e.alive) return;
      // The native Scream selector's CircleCollider2D radius is exactly 2.5.
      for (const u of targetsNear(b, e, 2.5 + ALLY_COLLIDER_RADIUS)) {
        elem(b, e, u, 'neural', e.s.atk * (T(ab, 'scream.ep_damage_ratio') ?? 0));
      }
    },
  }];
}
function nativeUrchin(ab) {
  const s = ab.sk.Stab;
  return [{
    spawn(_b, e, a) { a.ratio = e.hpRatio; e.profile.noAttack = true; },
    taken(_c, b, e, a) {
      if (!(a.ratio - e.hpRatio > (T(ab, 'damage_trigger.hp_ratio') ?? 0))) return;
      a.ratio = e.hpRatio;
      if (!s || e.s.flags.stun || e.s.flags.freeze || e.s.flags.levitate || !(e.hp > 0)) return;
      castSlot(b, e, s);
      // Original Stab selector has a 2.0 radius CircleCollider2D.
      for (const u of targetsNear(b, e, 2 + ALLY_COLLIDER_RADIUS)) {
        hurt(b, e, u, e.s.atk * s.bb.atk_scale, 'arts');
        if (u.alive) elem(b, e, u, 'neural', e.s.atk * s.bb.ep_damage_ratio);
      }
    },
  }];
}
function graytail(ab) {
  // The native prefab contains three distinct non-overridable BlockDamage
  // buffs [a]/[b]/[c], each with shield.dynamic; only [c] switches mode.
  const barrier = artsBarrier((T(ab, 'shield.dynamic') ?? 0) * 3, {
    key: 'mizuki:emouse:armor', whileUp: { defFlat: T(ab, 'shield.def') ?? 0 },
  });
  return [barrier, {
    sync(b, e, a) {
      if (barrier.left > 0 || a.broken) return;
      a.broken = true;
      b.addBuff(e, { key: 'mizuki:emouse:speedup', persist: true, mods: { moveMul: T(ab, 'speedup.move_speed') ?? 1 } });
      setForm(b, e, 'form2');
    },
    hitIn(_c, b, e, a) { a.sync(b, e, a); },
    taken(_c, b, e, a) { a.sync(b, e, a); },
    tick(b, e, a) { a.sync(b, e, a); },
  }];
}
function blastHammer(ab) {
  return [{ hitOut(c, b, e) {
    if (!c.dmg.isAttack || !c.target) return;
    // Native active-buff blackboard range_id=x-5: center + four adjacent
    // tiles. Source range_table.json confirms this is not a 3x3 square.
    for (const u of areaAlliesInTiles(b, e, c.target.tileR, c.target.tileC, 'plus', 1)) {
      if (u !== c.target && !u.isFlying) hurt(b, e, u, e.s.atk * (T(ab, 'aoe.attack@bsthmr_range.atk_scale') ?? 0), 'phys');
    }
  } }];
}

function nativeScout(ab) {
  const skill = ab.sk.Awake;
  if (!skill) throw new TypeError('Missing native scout Awake skill');
  return [{
    cd: skill.cd, left: Infinity, sk: skill,
    spawn(b, e, a, runtime) {
      e.profile.noAttack = true; a.waiting = true;
      runtime.immune = new Set([...(runtime.immune ?? []), 'stun', 'freeze', 'sleep', 'silence']);
      b.addBuff(e, { key: 'dscout_t', persist: true });
      // The original first mode has UNDEADABLE (flag6). Its HP listener
      // switches to mode1 on a tick, so the triggering hit cannot kill it.
      b.on('fatal', (c) => { if (c.unit === e && a.waiting) c.prevented = true; }, { owner: e });
    },
    tick(b, e, a, dt) {
      if (!a.waiting || !(e.hpRatio < T(ab, 'warn.hp_ratio'))) return;
      a.waiting = false; a.left = skill.icd + dt;
      b.removeBuff(e, 'dscout_t');
    },
    cond(_b, _e, a) { return !a.waiting && !a.used; },
    fire(b, e, a) {
      a.used = true;
      // The selector is global, both motions, without a target cap.
      // disableOverride=1 makes each scout a separate permanent source;
      // only units selected now get it, not future spawns.
      for (const unit of b.enemies) {
        if (!unit.alive || !unit.deployed || unit.hidden || unit.s.flags.untargetable || unit.s.flags.sleep) continue;
        b.addBuff(unit, { key: 'mizuki:dscout:buff:' + e.id, source: e, persist: true,
          mods: { atkPct: skill.bb.atk, defPct: skill.bb.def } });
        if (unit.findBuff('enemy_slumber')) b.emit('mizuki:scoutAlarm', { source: e, unit });
      }
    },
  }];
}

function nativeGrudgebearer(ab) {
  return [{
    spawn(b, e, a, runtime) {
      runtime.atkType = 'arts'; a.noAttack = e.profile.noAttack; e.profile.noAttack = true;
      e.profile.melee = false; e.profile.maxTargets = 2; e.profile.canTarget = (u) => !u.isFlying;
      // Native EasyToStartAbility waits for ATTACK(19), not its fallback
      // preDelay1.134. Both original spines hit at0.833 in Skill_Attack1.6.
      // Clone only this mode's instance definition, never shared data.
      e.def = { ...e.def, attackAnim: { dur: 1.6, hit: .833 } };
      // Original non-scalable CircleCollider: sleep1.5, normal2.0.
      e.base.rangeRadius = 1.5;
      b.addBuff(e, { key: 'enemy_slumber', persist: true, flags: { disarm: true } });
      // This timed private UNMOVABLE expires independently of the HP
      // listener. Expiry permits walking, but does not awaken its attacks.
      b.addBuff(e, { key: 'dbskar_t[sleep]', duration: T(ab, 'revive.unmove_duration'), flags: { noMove: true } });
      b.on('mizuki:scoutAlarm', ({ unit }) => { if (unit === e && e.alive) a.wake(b, e, a); }, { owner: e });
    },
    wake(b, e, a) {
      if (a.awake) return;
      a.awake = true; b.removeBuff(e, 'enemy_slumber'); b.removeBuff(e, 'dbskar_t[sleep]');
      e.profile.noAttack = a.noAttack; e.base.rangeRadius = 2;
      b.addBuff(e, { key: 'dbskar_t', persist: true, mods: { moveMul: 1 + T(ab, 'revive.move_speed') } });
      setForm(b, e, 'awakened');
    },
    tick(b, e, a) { if (!a.awake && e.hpRatio < T(ab, 'revive.hp_ratio')) a.wake(b, e, a); },
  }];
}
export const MIZUKI_REACTION_KITS = {
  enemy_1073_dscout: nativeScout,
  enemy_1073_dscout_2: nativeScout,
  ...Object.fromEntries(['enemy_1074_dbskar', 'enemy_1074_dbskar_2',
    'enemy_1074_dbskar_0', 'enemy_1074_dbskar_1', 'enemy_1074_dbskar_15',
    'enemy_1074_dbskar_2_0', 'enemy_1074_dbskar_2_1', 'enemy_1074_dbskar_2_2']
    .map((id) => [id, nativeGrudgebearer])),
  enemy_1151_dslntc: nativeReaper,
  enemy_1151_dslntc_2: nativeReaper,
  enemy_1152_dsurch: nativeUrchin,
  enemy_1152_dsurch_2: nativeUrchin,
  enemy_1060_emouse: graytail,
  enemy_1060_emouse_2: graytail,
  enemy_1076_bsthmr: blastHammer,
  enemy_1076_bsthmr_2: blastHammer,
};
