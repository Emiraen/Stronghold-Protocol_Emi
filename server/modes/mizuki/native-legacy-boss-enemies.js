// Native prior-expedition bosses included in RO2. Keep source mechanisms local.
import { T, targetsNear, setForm, castSlot } from '../../sim/content/enemies.js';

function nativeRusthammer(ab) {
  const skill = ab.sk.CriticalHit;
  if (!skill) throw new TypeError('Missing original rusthammer CriticalHit');
  const targetOf = (b, e) => targetsNear(b, e, e.base.rangeRadius).find((u) => !u.isFlying);
  const emit = (b, e, target, special, attackId) => {
    const trail = special ? 'flsnip_skill_01_trail' : 'flsnip_attack_01_trail';
    const hit = special ? 'flsnip_skill_01_hit' : 'flsnip_attack_01_hit';
    const p = b.addProjectile({ from: e, target, source: e, speed: 10, maxAge: 5, visual: 'none',
      onHit({ target: direct, x, y }) {
        if (!direct) return;
        b.fx('mizuki:effect', { key: hit, unitId: direct.id, x, y });
        b.dealDamage(e, direct, { amount: e.s.atk * (special ? skill.bb.atk_scale : 1),
          type: special ? 'arts' : 'phys', isAttack: true, isSkill: special, isProjectile: true, attackId });
      } });
    b.fx('mizuki:effect', { id: 'flsnip:projectile:' + p.id, key: trail,
      x: e.x, y: e.y, to: { x: target.x, y: target.y }, toUnitId: target.id, speed: 10, loop: false });
  };
  return [{
    spawn(b, e) {
      e.profile.melee = false; e.profile.deferHit = true; e.profile.shot = 'none';
      e.profile.canTarget = (u) => !u.isFlying;
      // Original source Spine Attack: 3s, OnAttack=1.333. Both normal and
      // skill arrows use native speed10/lifetime5 and survive their source.
      e.def = { ...e.def, attackAnim: { dur: 3, hit: 1.333 } };
      b.addBuff(e, { key: 'faust_t_invi', duration: T(ab, 'invincible.duration'), flags: { invulnerable: true } });
    },
    attack(c, b, e) { if (c.targets[0]) emit(b, e, c.targets[0], false, b._attackSeq); },
  }, {
    cd: skill.cd, left: skill.icd, sk: skill,
    cond(b, e, a) { return !a.casting && e.canAct && !!targetOf(b, e); },
    fire(b, e, a) {
      const target = targetOf(b, e); if (!target) return;
      const seq = target.deploySeq, cast = {}; a.casting = cast;
      e.swing = false; e.swingTargets = null; e.profile.noAttack = true;
      e.skillAnimUntil = b.time + 3;
      b.addBuff(e, { key: 'mizuki:flsnip:casting', duration: 3, flags: { noMove: true } });
      b.after(1.333, () => {
        if (a.casting === cast && e.alive && target.alive && target.deployed
          && !target.hidden && target.deploySeq === seq) emit(b, e, target, true);
      }, { owner: e });
      b.after(3, () => {
        if (a.casting !== cast) return; a.casting = null;
        e.profile.noAttack = false; b.removeBuff(e, 'mizuki:flsnip:casting');
      }, { owner: e });
    },
  }];
}

function nativeSaint(ab) {
  const skill = ab.sk.Fire, charge = ab.sk.Charge;
  if (!skill || !charge) throw new TypeError('Missing native saint skills');
  const mode = (b, e, a, value) => {
    a.mode = value; a.cast = null; e.swing = false; e.swingTargets = null;
    e.profile.noAttack = value !== 'sword'; e.profile.melee = value === 'sword';
    e.profile.deferHit = false; e.profile.shot = 'none';
    b.removeBuff(e, 'mizuki:saint:reload');
    if (value === 'reload') {
      a.charge = 2;
      b.addBuff(e, { key: 'mizuki:saint:reload', persist: true, flags: { noMove: true } });
    }
    setForm(b, e, value === 'gun' ? 'normal' : value);
  };
  const interrupted = (b, e, a) => {
    if (a.mode !== 'reload') return;
    mode(b, e, a, a.sp.value > 0 ? 'gun' : 'sword');
    // Original reload-mode event42 first picks the mode using remaining SP,
    // then gives the owner Stun.stun. It never stuns the operators.
    b.applyStatus(e, 'stun', { duration: T(ab, 'Stun.stun'), source: e });
  };
  return [{
    spawn(b, e, a) {
      const data = e.def.raw.officialData?.spData;
      if (!data || !Number.isFinite(data.maxSp)) throw new TypeError('Missing original saint ammunition');
      a.sp = { value: data.initSp, max: data.maxSp }; a.reload = T(ab, 'Reload.interval'); a.fire = 0;
      e.mem.mizukiSaint = a; e.profile.canTarget = (u) => !u.isFlying;
      e.def = { ...e.def, attackAnim: { dur: 1.5, hit: .867 } }; mode(b, e, a, 'gun');
    },
    status(c, b, e, a) { if (['stun', 'freeze', 'levitate'].includes(c.status)) interrupted(b, e, a); },
    tick(b, e, a, dt) {
      a.reload -= dt; a.fire -= dt;
      // The common native talent checks empty ammunition at its own 35s
      // interval; the final projectile separately switches to Sword on hit.
      if (a.reload <= 1e-9) {
        a.reload += T(ab, 'Reload.interval');
        if (a.sp.value <= 0 && a.mode !== 'reload') { mode(b, e, a, 'reload'); return; }
      }
      if (a.mode === 'reload') {
        if (e.s.flags.stun || e.s.flags.freeze || e.s.flags.levitate) { interrupted(b, e, a); return; }
        if (!e.canAct) return;
        a.charge -= dt;
        while (a.charge <= 1e-9 && a.mode === 'reload') {
          a.sp.value = Math.min(a.sp.max, a.sp.value + (charge.bb.sp ?? 1)); a.charge += 2;
          if (a.sp.value >= a.sp.max) mode(b, e, a, 'gun');
        }
        return;
      }
      if (a.mode !== 'gun' || a.cast || a.sp.value < skill.sp || a.fire > 1e-9 || !e.canAct) return;
      const target = targetsNear(b, e, e.base.rangeRadius).find((u) => !u.isFlying);
      if (!target) return;
      const cast = {}, seq = target.deploySeq; a.cast = cast; a.sp.value -= skill.sp;
      a.fire = e.s.interval; castSlot(b, e, skill);
      e.skillAnimUntil = b.time + 1.5;
      b.addBuff(e, { key: 'mizuki:saint:fire', duration: 1.5, flags: { noMove: true } });
      b.after(.867, () => {
        if (a.cast !== cast || !e.canAct || !target.alive || !target.deployed || target.deploySeq !== seq) return;
        const p = b.addProjectile({ from: e, source: e, target, speed: 10, maxAge: 5, visual: 'none',
          onHit({ target: direct, x, y }) {
            if (!direct) return;
            b.fx('mizuki:effect', { key: 'enemy_syudg_attack_01_hit_01', unitId: direct.id, x, y });
            b.dealDamage(e, direct, { type: 'phys', amount: e.s.atk * skill.bb.atk_scale, isSkill: true, isProjectile: true });
            if (e.alive && a.sp.value <= 0 && a.mode === 'gun') mode(b, e, a, 'sword');
          } });
        b.fx('mizuki:effect', { id: 'saint:' + p.id, key: 'enemy_syudg_attack_01_trail_01',
          x: e.x, y: e.y, to: { x: target.x, y: target.y }, toUnitId: target.id, speed: 10, loop: false });
      }, { owner: e });
      b.after(1.5, () => { if (a.cast === cast) a.cast = null; }, { owner: e });
    },
  }];
}

export const MIZUKI_LEGACY_BOSS_KITS = {
  enemy_2006_flsnip: nativeRusthammer,
  enemy_2026_syudg: nativeSaint,
  enemy_2027_syudg2: nativeSaint,
};
