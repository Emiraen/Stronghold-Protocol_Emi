// Original Laterano weapons used by RO2 4-8; never mutate shared enemy kits.
import { T, targetsNear } from '../../sim/content/enemies.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { bodyDist, hitRect } from '../../sim/body.js';

const present = (u) => u.alive && u.deployed && !u.hidden;
const station = (u) => !!u.mem.mizukiFilterTags?.includes('TAG_TRAP_WPNSTS');
const fx = (b, u, key, extra = {}) => b.fx('mizuki:effect', { key, x: u.x, y: u.y, unitId: u.id, ...extra });
const selectable = (u, camouflage = false) => present(u) && !u.s.flags.untargetable && !u.s.flags.sleep
  && !u.s.flags.stealth && (camouflage || !u.s.flags.camou) && u._mizukiSourceSide !== 2
  && (u.kind !== 'device' || u._mizukiSourceCategory === 1);

function ammunition(e, key) {
  const data = e.def.raw.officialData?.spData;
  if (!data || !Number.isFinite(data.maxSp)) throw new TypeError('Missing native ammunition for ' + e.defId);
  const state = e.mem[key] = { sp: { value: data.initSp, max: data.maxSp } };
  // Original weapon-station SP aura affects the same SP store as attacks.
  e.mem.mizukiGainSp = (amount) => {
    state.sp.value = Math.max(0, Math.min(state.sp.max, state.sp.value + amount));
    state.sync?.(); return state.sp.value;
  };
  return state;
}

const shot = (b, e, target, { speed = 10, age = 10, trail, impact, hit }) => {
  const p = b.addProjectile({ from: e, source: e, target, speed, maxAge: age, visual: 'none',
    onHit({ target: direct, x, y }) {
      if (impact) fx(b, { ...target, x, y }, impact);
      hit(direct, x, y);
    } });
  fx(b, e, trail, { id: 'native:gun:' + p.id, to: { x: target.x, y: target.y },
    toUnitId: target.id, speed, loop: false });
};
const trapDamage = (b, e, u, amount) => {
  if (present(u) && station(u)) b.dealDamage(e, u, { amount, type: 'arts', noSp: true, isAttack: true, isProjectile: true });
};

function nativePathfinder(ab) {
  return [{
    spawn(b, e) {
      e.profile.melee = false; e.profile.deferHit = true; e.profile.shot = 'none';
      e.def = { ...e.def, attackAnim: { dur: 1, hit: .533 } };
      // The native tag-priority selector still gives its blocker precedence.
      e.profile.canTarget = (u) => {
        if (u.isFlying) return false;
        if (e.blockedBy) return true;
        const tagged = targetsNear(b, e, e.base.rangeRadius + ALLY_COLLIDER_RADIUS).some((v) => !v.isFlying && station(v));
        return !tagged || station(u);
      };
    },
    attack(c, b, e) {
      const target = c.targets[0]; if (!target) return;
      shot(b, e, target, { trail: 'enemy_ptrarc_attack_01_trail', impact: 'enemy_ptrarc_attack_01_hit',
        hit(direct) {
          if (!direct) return;
          b.dealDamage(e, direct, { amount: e.s.atk, type: 'phys', isAttack: true, isProjectile: true });
          trapDamage(b, e, direct, T(ab, 'shottrap.attack@trapdamage'));
        } });
    },
  }];
}

// Original BoxCollider2D size3x3, circle/rectangle intersection, not a radius.
function inShellBox(u, x, y) {
  const r = hitRect(u);
  if (r) return r.x1 >= x - 1.5 && r.x0 <= x + 1.5 && r.y1 >= y - 1.5 && r.y0 <= y + 1.5;
  const dx = Math.max(0, Math.abs(u.x - x) - 1.5), dy = Math.max(0, Math.abs(u.y - y) - 1.5);
  return dx * dx + dy * dy <= ALLY_COLLIDER_RADIUS ** 2 + 1e-9;
}

function nativeCanSoldier(ab) {
  return [{
    spawn(_b, e) {
      const state = ammunition(e, 'mizukiCanSoldier');
      e.profile.shot = 'none'; e.profile.canTarget = (u) => !u.isFlying;
      state.sync = () => {
        const gun = state.sp.value > 0;
        e.profile.melee = !gun; e.profile.deferHit = gun;
        e.def = { ...e.def, attackAnim: gun ? { dur: 2.5, hit: 1.333 } : { dur: 1.5, hit: .833 } };
      };
      state.sync();
    },
    attack(c, b, e) {
      const a = e.mem.mizukiCanSoldier, target = c.targets[0];
      if (!target || a.sp.value <= 0) return;
      // Native attack-event SP modification spends a shell at emission.
      a.sp.value = Math.max(0, a.sp.value + T(ab, 'shotbuff.attack@headshot_sp'));
      shot(b, e, target, { speed: 4, trail: 'enemy_cansld_skill_01_trail', impact: 'enemy_cansld_skill_01_hit',
        hit(direct, x, y) {
          const victims = b.allyUnits.filter((u) => selectable(u, true) && inShellBox(u, x, y));
          if (direct && present(direct) && !victims.includes(direct)) victims.push(direct);
          for (const u of victims) {
            b.dealDamage(e, u, { amount: e.s.atk * T(ab, 'shotbuff.attack@headshot_atk_scale'),
              type: 'phys', isAttack: true, isProjectile: true });
            trapDamage(b, e, u, T(ab, 'shotbuff.attack@headshot_trapdamage'));
          }
        } });
      a.sync();
    },
  }];
}

function nativePriest(ab) {
  return [{
    spawn(_b, e) {
      ammunition(e, 'mizukiPriest');
      e.profile.melee = false; e.profile.deferHit = true; e.profile.shot = 'none';
      e.profile.canTarget = (u) => !u.isFlying;
      e.def = { ...e.def, attackAnim: { dur: 1.333, hit: .767 } };
      // Original SelectVg has no matching vgctrl in the RO2 4-8 scene.
      // Passive.sp=2 belongs to that controller, not the attack BB.
    },
    attack(c, b, e) {
      const target = c.targets[0]; if (!target) return;
      shot(b, e, target, { age: 5, trail: 'enemy_sgprst_attack_01_trail', impact: 'enemy_sgprst_attack_01_hit',
        hit(direct) {
          if (!direct) return;
          b.dealDamage(e, direct, { amount: e.s.atk, type: 'phys', isAttack: true, isProjectile: true });
          const a = e.mem.mizukiPriest;
          // Original CheckHasSp and ModifySp use attack-local defaults 1/-1.
          if (!present(direct) || a.sp.value < 1) return;
          a.sp.value--;
          const key = 'enemy_sgprst_reduce_def', prior = direct.findBuff(key)?.mods.defFlat ?? 0;
          b.addBuff(direct, { key, source: e, duration: Infinity, refresh: 'replace',
            mods: { defFlat: prior + T(ab, 'Passive.attack@def') }, visible: true });
        } });
    },
  }];
}

function nativeUnconcerned(ab) {
  const skill = ab.sk.FireBottle;
  if (!skill) throw new TypeError('Missing original FireBottle');
  const zones = [];
  const pulse = (b, zone) => {
    for (const u of b.allyUnits) if (selectable(u, true) && bodyDist(u, zone.x, zone.y) <= 1.5 + ALLY_COLLIDER_RADIUS + 1e-9) {
      // Original NoSourceDamage PURE and ignoreForSp; no attack attribution.
      b.dealDamage(null, u, { amount: skill.bb.damage, type: 'true', noSp: true, canDodge: false });
      fx(b, u, 'endmy_sgwlf_skill_buff');
    }
  };
  return [{
    spawn(b, e, a) {
      e.profile.noAttack = true; a.count = 1; a.zones = zones; e.mem.mizukiFireBottle = a;
      // Listener is intentionally independent of the dead source. Native
      // INFINITY projectile does not stopWhenSourceInvalid.
      b.on('tick', ({ dt }) => {
        for (const zone of zones) {
          zone.left -= dt;
          while (zone.left <= 1e-9) { zone.left += 1; pulse(b, zone); }
        }
      });
    },
    taken(_c, b, e, a) {
      const ratio = T(ab, 'FireBottleTrigger.hp_ratio'), lost = 1 - e.hp / e.s.maxHp;
      // HpRatioTrigger default cnt1, GT, floor(loss/ratio)+1. One
      // attribute event can skip thresholds, not spawn one fire per step.
      if (!(lost > a.count * ratio + 1e-9)) return;
      a.count = Math.floor(lost / ratio) + 1;
      // The condition node updates its BB before TriggerEnemySkill; a
      // disabled cast does not bank that lost-HP threshold for later.
      if (!e.alive || !e.canAct || e.s.flags.silence) return;
      const cast = {}; a.cast = cast;
      e.swing = false; e.swingTargets = null; e.skillAnimUntil = b.time + 1;
      b.addBuff(e, { key: 'mizuki:sgwlf:cast', duration: 1, flags: { noMove: true } });
      fx(b, e, 'endmy_sgwlf_skill_start');
      b.after(.2, () => {
        if (a.cast !== cast || !e.canAct) return;
        const zone = { x: e.x, y: e.y, left: 1 }; zones.push(zone);
        fx(b, e, 'endmy_sgwlf_skill_range', { id: 'sgwlf:fire:' + e.id + ':' + zones.length, loop: true });
        pulse(b, zone);
      }, { owner: e });
      b.after(1, () => { if (a.cast === cast) a.cast = null; }, { owner: e });
    },
  }];
}

export const MIZUKI_GUN_KITS = {
  enemy_1215_ptrarc: nativePathfinder,
  enemy_1216_cansld: nativeCanSoldier,
  enemy_1284_sgprst: nativePriest,
  enemy_1285_sgwlf: nativeUnconcerned,
};
