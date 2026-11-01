// Native per-enemy behaviors read this exact level's original blackboards.
import { T, elem, hurt, targetsNear, byPriority, areaAllies, areaAlliesInTiles, setForm } from '../../sim/content/enemies.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { summonNativeEnemies } from './NativeEnemySpawn.js';

function combatCaster(ab) {
  const sync = (b, e) => {
    const key = 'mizuki:ccwitch:defense';
    if (e.blockedBy && !e.s.flags.silence) b.addBuff(e, { key, refresh: 'replace',
      mods: { defFlat: T(ab, 'Def.def') ?? 0 } });
    else b.removeBuff(e, key);
    e.profile.dmgType = e.blockedBy ? 'phys' : 'arts';
  };
  return [{
    spawn(b, e) { e.profile.melee = false; sync(b, e); },
    blocked(_c, b, e) { sync(b, e); },
    tick(b, e) { sync(b, e); },
    before(_c, b, e) {
      sync(b, e);
      e.profile.atkScale = e.blockedBy ? T(ab, 'combat.attack@ccwitch_rage_attack.atk_scale') ?? 1 : 1;
    },
    hitOut(c, _b, e) {
      if (!c.dmg.isAttack || c.dmg.type === 'element') return;
      // A ranged projectile already in flight retains its original damage type.
      c.dmg.type = !c.dmg.isProjectile && e.blockedBy === c.target ? 'phys' : 'arts';
      if (c.dmg.isProjectile) c.dmg.amount /= e.profile.atkScale ?? 1;
    },
  }];
}
function jelly(ab) {
  return [{ dealt(c, b, e) {
    elem(b, e, c.target, 'neural', e.s.atk * (T(ab, 'epdamage.attack@ep_damage_ratio') ?? 0));
  } }];
}
function nativeDeathSpawn(ab) {
  return [{ sil: true, death(c, b, e) {
    if (c.reason !== 'killed') return;
    summonNativeEnemies(b, e, ab.tS['deathrattle.enemy_key'], {
      count: T(ab, 'deathrattle.cnt'), delay: T(ab, 'deathrattle.delay'),
      offsetBound: T(ab, 'deathrattle.offset_bound'), tryOutside: true,
      stopHostDead: false, dontBlockWave: false, useRandomDelay: false,
      tag: 'mizuki:deathrattle:' + e.id,
    });
  } }];
}
function nativeMortar(ab) {
  const marker = 'mizuki:native:mortar:splash';
  return [{
    spawn(_b, e) { e.profile.canTarget = (u) => !u.isFlying; },
    tick(b, e) {
      const key = 'mizuki:soticn:strength';
      if (e.findBuff('mizuki:sotidp:strength')) b.addBuff(e, { key, refresh: 'replace',
        mods: { aspd: T(ab, 'strength.attack_speed') ?? 0 } });
      else b.removeBuff(e, key);
    },
    hitOut(c, b, e) {
      if (!c.dmg.isAttack || !c.target || c.dmg.tags?.includes(marker)) return;
      // Original projectile_mortar uses a 3x3 BoxCollider and targets both
      // motions. The main selector is ground-only, the actual splash is not.
      for (const u of areaAlliesInTiles(b, e, c.target.tileR, c.target.tileC, 'box', 1)) {
        if (u === c.target) continue;
        b.dealDamage(e, u, { amount: c.dmg.amount, type: 'phys', isAttack: true,
          attackId: c.dmg.attackId, isProjectile: true, tags: [marker] });
      }
    },
  }];
}
function blockedResistance(ab) {
  const sync = (b, e) => {
    const key = 'mizuki:hirman:resistance';
    if (e.blockedBy && !e.s.flags.silence) b.addBuff(e, { key, refresh: 'replace',
      mods: { resFlat: T(ab, 'MagicResistance.magic_resistance') ?? 0 } });
    else b.removeBuff(e, key);
  };
  return [{
    spawn(b, e, _a, runtime) { runtime.atkType = 'phys'; sync(b, e); },
    blocked(_c, b, e) { sync(b, e); },
    status(_c, b, e) { sync(b, e); },
    hitIn(_c, b, e) { sync(b, e); },
    tick(b, e) { sync(b, e); },
  }];
}
function nativeKnightArmor(ab) {
  return [{ spawn(b, e, _a, runtime) {
    runtime.atkType = 'phys';
    e.profile.canTarget = (u) => !u.isFlying;
    // Original plkght_t has a timed, non-silenceable +flat DEF/RES buff.
    b.addBuff(e, { key: 'mizuki:plkght:armor', duration: T(ab, 'buff.duration'),
      mods: { defFlat: T(ab, 'buff.def') ?? 0, resFlat: T(ab, 'buff.magic_resistance') ?? 0 } });
  } }];
}
function nativeLasso(ab) {
  const s = ab.sk.lasso;
  if (!s) throw new TypeError('Missing native dmage lasso skill');
  const key = 'mizuki:dmage:casting';
  const targetOf = (b, e) => {
    const list = byPriority(e, targetsNear(b, e, s.bb.range_radius + ALLY_COLLIDER_RADIUS).filter((u) => !u.isFlying));
    // Native FilterUtil.NOT_STUNNED_HATRED_DES (12), then normal taunt order.
    return list.find((u) => !u.s.flags.stun) ?? list[0];
  };
  const stop = (b, e, a) => {
    if (!a.active) return;
    a.active = false;
    if (a.target) b.removeBuff(a.target, 'mizuki:dmage:lasso:' + e.id);
    if (a.projectile) b.projectiles.list = b.projectiles.list.filter((p) => p !== a.projectile);
    if (a.deathHook) b.off(a.deathHook);
    b.removeBuff(e, key);
    // Native _minPostDelayWhenProjectileInvalid is 0.667 seconds.
    if (e.alive) {
      b.addBuff(e, { key, duration: .667, flags: { noMove: true } });
      b.after(.667, () => { e.profile.noAttack = a.noAttack; }, { owner: e });
    } else e.profile.noAttack = a.noAttack;
    e.skillAnimUntil = b.time;
  };
  const valid = (b, e, a) => e.alive && !e.s.flags.silence && !e.s.flags.stun
    && b.time >= e.unbalanceUntil && a.target?.alive && a.target.deployed && !a.target.hidden
    && a.target.deploySeq === a.targetSeq;
  const stun = (b, e, t) => {
    // A projectile-owned infinite buff must be removable independently of
    // unrelated stuns. Route its status checks through the normal hook bus.
    if (t.def.immune?.has('stun') || t.s.flags.liftoff || (t.s.flags.invulnerable && t.s.flags.untargetable)) return;
    const c = b.emit('beforeStatus', { source: e, target: t, status: 'stun', duration: Infinity, value: undefined, cancel: false });
    if (c.cancel || !t.alive || !(c.duration > 0)) return;
    const entered = !t.s.flags.stun;
    b.addBuff(t, { key: 'mizuki:dmage:lasso:' + e.id, source: e, status: 'stun', visible: true,
      duration: c.duration, flags: { stun: true, noBlock: true } });
    b.releaseBlocked(t);
    b.emit('statusApplied', { source: e, target: t, status: 'stun', duration: c.duration, entered });
  };
  return [{
    cd: s.cd, left: s.icd, sk: s,
    spawn(_b, e, _a, runtime) { runtime.atkType = 'arts'; e.profile.canTarget = (u) => !u.isFlying; },
    cond(b, e, a) { return !a.used && !e.s.flags.silence && !!targetOf(b, e); },
    fire(b, e, a) {
      a.used = true; a.active = true; a.target = targetOf(b, e); a.targetSeq = a.target.deploySeq;
      a.noAttack = e.profile.noAttack; e.profile.noAttack = true; e.swing = false; e.swingTargets = null;
      b.addBuff(e, { key, flags: { noMove: true } });
      a.deathHook = b.on('death', ({ unit }) => { if (unit === a.target || unit === e) stop(b, e, a); }, { owner: e });
      a.projectile = b.projectiles.add({ source: e, from: e, target: a.target, speed: 10,
        visual: 'enemy', onHit({ target }) {
          if (!a.active || target !== a.target || !valid(b, e, a)) { stop(b, e, a); return; }
          a.attached = true; a.elapsed = 0; a.next = s.bb.hit_interval ?? 1;
          stun(b, e, target);
          hurt(b, e, target, e.s.atk * s.bb.atk_scale, 'arts', { tags: ['mizuki:dmage:lasso'] });
          b.fx('beam', { from: e.id, to: target.id, kind: 'mizuki:dmage:lasso', dur: s.bb.hit_duration });
        } });
      e.skillAnimUntil = b.time + s.bb.hit_duration;
    },
    status(_c, b, e, a) { if (a.active && !valid(b, e, a)) stop(b, e, a); },
    death(_c, b, e, a) { stop(b, e, a); },
    tick(b, e, a, dt) {
      if (!a.active) return;
      if (!valid(b, e, a)) { stop(b, e, a); return; }
      if (!a.attached) return;
      a.elapsed += dt;
      // LinkProjectile.OnInit reads hit_duration; hit_times=-1 disables
      // ModifierSplitter. Native GetKeepAlreadyHitTime defaults to 1 second.
      while (a.next <= a.elapsed + 1e-9 && a.next < s.bb.hit_duration - 1e-9 && a.active) {
        a.next += s.bb.hit_interval ?? 1;
        hurt(b, e, a.target, e.s.atk * s.bb.atk_scale, 'arts', { tags: ['mizuki:dmage:lasso'] });
      }
      if (a.elapsed >= s.bb.hit_duration - 1e-9) stop(b, e, a);
    },
  }];
}

function nativeIceSlug(ab) {
  return [{
    spawn(_b, _e, _a, runtime) { runtime.atkType = 'phys'; },
    death(c, b, e) {
      // projectile_on_killed explicitly checks SILENCED even though its
      // passive buff is not itself silenceable. It does not run on a leak.
      if (c.reason !== 'killed' || e.s.flags.silence) return;
      const x = e.x, y = e.y, atk = e.s.atk;
      // Original SimpleProjectile has lifetime 1, no movement behaviour,
      // alwaysReachInTheEnd and HitBehaviour.onlyCheckHitWhenReachTarget.
      // Its CircleCollider2D radius is 1.65, not the generic bug radius.
      b.fx('mizuki:effect', { key: 'snslime_die_01_start', x, y, unitId: e.id });
      b.after(1, () => {
        for (const u of areaAllies(b, e, x, y, 1.65 + ALLY_COLLIDER_RADIUS)) {
          if (u.isFlying) continue;
          hurt(b, e, u, atk * (T(ab, 'boom.atk_scale') ?? 0), 'phys', { tags: ['mizuki:snslime:boom'] });
          if (u.alive) b.applyStatus(u, 'cold', { duration: T(ab, 'boom.freeze') ?? 0, source: e });
        }
      });
    },
  }];
}

function nativeSotiwz(ab) {
  const normal = ab.sk.Immo, rage = ab.sk['Immo[Rage]'];
  if (!normal || !rage) throw new TypeError('Missing native sotiwz pulse skills');
  return [{
    cd: normal.cd, left: normal.icd, sk: normal,
    spawn(b, e, a, runtime) {
      e.profile.noAttack = true;
      runtime.immune = new Set([...(runtime.immune ?? []), 'silence']);
      b.addBuff(e, { key: 'ore_immune', persist: true });
      b.addBuff(e, { key: 'ore_listener', persist: true });
      b.on('mizuki:orePulse', ({ unit, mode }) => {
        if (unit !== e || !e.alive || mode !== 1 || a.rage) return;
        a.rage = true; a.sk = rage; a.cd = rage.cd; a.left = rage.icd;
        setForm(b, e, 'rage');
        b.fx('mizuki:effect', { key: 'buff_curse_01', x: e.x, y: e.y, unitId: e.id });
        b.fx('mizuki:effect', { key: 'sotidp_buff_01_start', x: e.x, y: e.y, unitId: e.id });
      }, { owner: e });
    },
    cond(_b, e) { return !e.s.flags.sleep; },
    fire(b, e, a) {
      const r = a.rage ? 2.5 : 1.5;
      b.fx('mizuki:effect', { key: a.rage ? 'sotiwz_attack_02_start' : 'sotiwz_attack_01_start',
        x: e.x, y: e.y, unitId: e.id });
      for (const u of areaAllies(b, e, e.x, e.y, r + ALLY_COLLIDER_RADIUS)) {
        if (!u.isFlying) hurt(b, e, u, e.s.atk * a.sk.bb.atk_scale, 'arts', { tags: ['mizuki:sotiwz:pulse'] });
      }
    },
  }];
}

export const MIZUKI_SPECIAL_KITS = {
  enemy_1067_snslime_2: nativeIceSlug,
  enemy_1085_sotiwz_2: nativeSotiwz,
  enemy_1096_ccwitch: combatCaster,
  enemy_1096_ccwitch_2: combatCaster,
  enemy_1150_dsjely: jelly,
  enemy_1150_dsjely_2: jelly,
  enemy_1132_sarchn: nativeDeathSpawn,
  enemy_1132_sarchn_2: nativeDeathSpawn,
  enemy_1130_infstr: nativeDeathSpawn,
  enemy_1130_infstr_2: nativeDeathSpawn,
  // The native plasm prefab has only its birth VFX and a physical combat hit.
  enemy_1137_plasm: () => [],
  enemy_1024_mortar: nativeMortar,
  enemy_1024_mortar_2: nativeMortar,
  enemy_1082_soticn: nativeMortar,
  enemy_1082_soticn_2: nativeMortar,
  enemy_1048_hirman_2: blockedResistance,
  enemy_1101_plkght: nativeKnightArmor,
  enemy_1022_dmage: nativeLasso,
};
