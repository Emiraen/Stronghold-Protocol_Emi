import { T, elem, byPriority } from '../../sim/content/enemies.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { hypot } from '../../sim/detmath.js';
import { canTargetAlly } from '../../sim/targeting.js';

const onCreep = (b, u) => !u.isFlying && !u.s.flags.airborne
  && !!b._mizukiCreep?.isActive(Math.round(u.y), Math.round(u.x));
// Despite its template name, trap_creep_apply_ep_damage has no tile condition:
// the original action is ApplyElementDamage(SANITY), using ep_damage_ratio.
const creepElement = (ab) => ({ dealt(c, b, e) {
  elem(b, e, c.target, 'neural', e.s.atk * (T(ab, 'EpDamage.ep_damage_ratio') ?? 0));
} });
function runner(ab) {
  const evade = (b, e) => {
    const f = e.s.flags;
    // Original checker flags 0/16/12/25/13/19 + combo SLEEPING.
    const disabled = f.stun || f.freeze || f.silence || f.levitate || f.noMove || f.sleep;
    const value = disabled ? 0 : T(ab, 'Evade.prob') ?? 0;
    b.addBuff(e, { key: 'mizuki:dsrunr:evade', mods: { dodgePhys: value, dodgeArts: value }, refresh: 'replace' });
  };
  return [creepElement(ab), {
    iv: .2,
    spawn(b, e) { evade(b, e); },
    hitIn(_c, b, e) { evade(b, e); },
    status(_c, b, e) { evade(b, e); },
    tick(b, e, a) {
      evade(b, e);
      const active = onCreep(b, e);
      if (active && !a.inside) {
        b.removeBuff(e, 'mizuki:dsrunr:blockfree:out');
        b.addBuff(e, { key: 'mizuki:dsrunr:blockfree', flags: { unblockable: true } });
      } else if (!active && a.inside) {
        b.removeBuff(e, 'mizuki:dsrunr:blockfree');
        b.addBuff(e, { key: 'mizuki:dsrunr:blockfree:out', duration: .3, flags: { unblockable: true } });
      }
      a.inside = active;
    },
  }];
}
function sailor(ab) {
  const sync = (b, e, a) => {
    a.baseBlock ??= e.blockWeight;
    const stronger = e.hpRatio <= (T(ab, 'Buff.hp_ratio') ?? 0);
    if (stronger) b.addBuff(e, { key: 'mizuki:dssalr:defense', refresh: 'replace',
      mods: { defPct: T(ab, 'Buff.def') ?? 0 } });
    else b.removeBuff(e, 'mizuki:dssalr:defense');
    e.blockWeight = a.baseBlock + (stronger ? T(ab, 'Buff.block_volume') ?? 0 : 0);
    if (e.hpRatio <= (T(ab, 'Creep.hp_ratio') ?? 0) && !e.s.flags.silence) {
      b._mizukiCreep?.activate(Math.round(e.y), Math.round(e.x), { source: e.id });
    }
  };
  return [creepElement(ab), {
    spawn(b, e, a) { sync(b, e, a); },
    taken(_c, b, e, a) { sync(b, e, a); },
    tick(b, e, a) { sync(b, e, a); },
  }];
}
function shooter(ab) {
  return [creepElement(ab), { spawn(b, e) {
    // Native BuffKeyInGlobalRangeOrAdvancedSelector::OnPostFilter
    // (0x1809b7990) APPENDS global buff_creep[tile] targets to its ordinary
    // circle candidates. Its two-motion native circle also accepts flyers.
    const reach = e.base.rangeRadius + ALLY_COLLIDER_RADIUS;
    e.base.rangeRadius = Math.hypot(b.rect.r1 - b.rect.r0 + 1, b.rect.c1 - b.rect.c0 + 1);
    e.profile.melee = false;
    e.profile.maxTargets = T(ab, 'Attack.attack@max_target') ?? 1;
    const inCircle = (u) => hypot(u.x - e.x, u.y - e.y) <= reach + 1e-9;
    e.profile.canTarget = (u) => {
      if (!(inCircle(u) || onCreep(b, u))) return false;
      const possible = b.allies().filter((v) => canTargetAlly(e, v, true) && (inCircle(v) || onCreep(b, v)));
      const preferred = possible.filter((v) => onCreep(b, v));
      if (onCreep(b, u)) return true;
      // Native prior comparator (0x1809b7e20): creep before ordinary
      // taunt order. Reserve the remaining slots for ordinary targets.
      const count = Math.max(0, e.profile.maxTargets - preferred.length);
      return byPriority(e, possible.filter((v) => !onCreep(b, v))).slice(0, count).some((v) => v.id === u.id);
    };
  } }];
}

export const MIZUKI_CREEP_KITS = {
  enemy_1231_dsrunr: runner,
  enemy_1231_dsrunr_2: runner,
  enemy_1232_dssalr: sailor,
  enemy_1232_dssalr_2: sailor,
  enemy_1233_dsshtr: shooter,
  enemy_1233_dsshtr_2: shooter,
};
