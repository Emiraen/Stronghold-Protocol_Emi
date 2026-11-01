// Original enemy_1020_obsv: talent_invisible plus talent_antiinvi.
// The anti-invisibility buff grants immunity to INVISIBLE(9), not CAMOUFLAGE.
// Adapt only affected unit instances: shared targeting reads effective flags,
// while original stealth buffs remain intact and resume when the aura leaves.
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { bodyDist } from '../../sim/body.js';

const IMMUNITY = 'mizuki:invisibleImmune';
function adaptInvisibleImmunity(unit) {
  if (unit.mem.mizukiInvisibleImmuneAdapter) return;
  unit.mem.mizukiInvisibleImmuneAdapter = true;
  const recalc = unit._recalc;
  unit._recalc = function () {
    recalc.call(this);
    if (this.buffs.some((buff) => buff.tags.includes(IMMUNITY))) this._s.flags.stealth = false;
  };
}

function nativeObserver() {
  return [{
    spawn(b, e, a, runtime) {
      runtime.atkType = 'phys'; e.profile.melee = true;
      b.addBuff(e, { key: 'talent_invisible', persist: true, flags: { stealth: true },
        data: { stealthRestore: 3 } });
      a.targets = new Set(); a.key = 'talent_antiinvi:' + e.id;
      e.mem.mizukiObserverRangeEffect = true;
      b.fx('mizuki:effect', { id: 'obsv:' + e.id, key: 'obsv_buff_01_range',
        x: e.x, y: e.y, unitId: e.id, loop: true, phase: 'start', active: true });
      a.update(b, e, a);
    },
    update(b, e, a) {
      const next = new Set();
      // Native CircleRange radius2, _extendable=0, _scaleble=0. The unused
      // talent BB range_radius3.3 is not applied by Range.SetBlackboard.
      const radius = 2 + ALLY_COLLIDER_RADIUS;
      if (e.alive && e.deployed && !e.hidden) for (const unit of b.allyUnits) {
        // Original ignoreTargetFree=1 includes invisible/sleeping/unselectable
        // targets; other target-free conditions are not removed by this buff.
        if (!unit.alive || !unit.deployed || unit.hidden
          || (unit.kind === 'device' && unit._mizukiSourceCategory !== 1)
          || bodyDist(unit, e.x, e.y) > radius + 1e-9) continue;
        next.add(unit);
        if (a.targets.has(unit)) continue;
        adaptInvisibleImmunity(unit);
        b.addBuff(unit, { key: a.key, source: e, persist: true, tags: [IMMUNITY], flags: { reveal: true } });
      }
      for (const unit of a.targets) if (!next.has(unit)) b.removeBuff(unit, a.key);
      a.targets = next;
    },
    tick(b, e, a) { a.update(b, e, a); },
    death(_c, b, e, a) {
      for (const unit of a.targets) b.removeBuff(unit, a.key);
      a.targets.clear();
      e.mem.mizukiObserverRangeEffect = false;
      b.fx('mizuki:effect', { id: 'obsv:' + e.id, key: 'obsv_buff_01_range',
        x: e.x, y: e.y, unitId: e.id, loop: true, phase: 'stop', active: false });
    },
  }];
}

export const MIZUKI_VISIBILITY_KITS = { enemy_1020_obsv: nativeObserver };

export function snapshotNativeEnemyEffects(battle) {
  return battle.enemies.filter((e) => e.alive && e.deployed && !e.hidden && e.mem.mizukiObserverRangeEffect)
    .map((e) => ({ id: 'obsv:' + e.id, key: 'obsv_buff_01_range',
      x: e.x, y: e.y, unitId: e.id, loop: true, active: true }));
}
