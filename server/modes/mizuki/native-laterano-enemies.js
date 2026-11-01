// Original Laterano enemies used only by Mizuki levels. Never alter shared KITS.
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { bodyDist } from '../../sim/body.js';

const live = (u) => u.alive && u.deployed && !u.hidden;
const selectable = (u) => live(u) && !u.s.flags.untargetable && !u.s.flags.sleep
  && !u.s.flags.stealth && !u.s.flags.camou && u._mizukiSourceSide !== 2
  && (u.kind !== 'device' || u._mizukiSourceCategory === 1);
const fx = (b, e, key, extra = {}) => b.fx('mizuki:effect', { key, x: e.x, y: e.y, unitId: e.id, ...extra });

function nativeSaxophonist(ab) {
  const skill = ab.sk.FourDirAttack;
  if (!skill) throw new TypeError('Missing native FourDirAttack');
  const shots = new Set();
  const launch = (b, e) => {
    for (const [dx, dy, dir] of [[1, 0, 'RIGHT'], [-1, 0, 'LEFT'], [0, 1, 'UP'], [0, -1, 'DOWN']]) {
      // Native lifetime60/speed9, maxHitNum1, source-invalid does not stop it.
      // It passes walls; the original magic circuit is a separate absorber.
      const to = { x: e.x + dx * 540, y: e.y + dy * 540 };
      const p = b.addProjectile({ from: e, source: e, to, speed: 9, maxAge: 60, visual: 'none' });
      shots.add({ p, x: e.x, y: e.y });
      fx(b, e, 'enemy_ltswar_skill_trail', { id: 'ltswar:' + p.id, dir, to, speed: 9, loop: false });
    }
  };
  return [{
    spawn(b, e, a) {
      e.profile.melee = true; e.def = { ...e.def, attackAnim: { dur: 2.5, hit: .8 } };
      e.mem.mizukiSaxophonist = a;
      // A battle listener owns emitted projectiles after their source dies.
      b.on('tick', () => {
        for (const shot of shots) {
          const p = shot.p, dx = p.x - shot.x, dy = p.y - shot.y, n = dx * dx + dy * dy;
          let first = null, firstT = Infinity;
          for (const target of b.allyUnits) {
            if (!selectable(target)) continue;
            const t = n > 0 ? Math.max(0, Math.min(1, ((target.x - shot.x) * dx + (target.y - shot.y) * dy) / n)) : 0;
            if (bodyDist(target, shot.x + t * dx, shot.y + t * dy) > .5 + ALLY_COLLIDER_RADIUS + 1e-9) continue;
            if (t < firstT || (t === firstT && target.id < first.id)) { first = target; firstT = t; }
          }
          if (first) {
            b.dealDamage(e, first, { amount: e.s.atk * skill.bb.atk_scale, type: 'phys', isSkill: true, isProjectile: true });
            fx(b, first, 'enemy_ltswar_skill_hit');
            b.projectiles.list = b.projectiles.list.filter((item) => item !== p); shots.delete(shot);
          } else if (!b.projectiles.list.includes(p)) shots.delete(shot);
          else { shot.x = p.x; shot.y = p.y; }
        }
      });
    },
  }, {
    cd: skill.cd, left: skill.icd, sk: skill, sil: true,
    cond(_b, e, a) { return !a.casting && e.canAct; },
    fire(b, e, a) {
      // Native FixedTime5/preDelay3. Skill_End's OnAttack event is .6s later.
      const cast = {}; a.casting = cast; e.mem.mizukiSaxophonist.cast = a;
      e.swing = false; e.swingTargets = null; e.profile.noAttack = true;
      e.skillAnimUntil = b.time + 5;
      b.addBuff(e, { key: 'mizuki:ltswar:cast', duration: 5, flags: { noMove: true } });
      for (const key of ['enemy_ltswar_skill_loop_1', 'enemy_ltswar_skill_loop_2']) fx(b, e, key, { duration: 3 });
      b.after(3, () => { if (a.casting === cast && e.alive) fx(b, e, 'enemy_ltswar_skill_end', { duration: 2 }); }, { owner: e });
      b.after(3.6, () => { if (a.casting === cast && e.canAct) launch(b, e); }, { owner: e });
      b.after(5, () => { if (a.casting !== cast) return; a.casting = null; e.profile.noAttack = false; b.removeBuff(e, 'mizuki:ltswar:cast'); }, { owner: e });
    },
    tick(b, e, a) {
      if (!a.casting || (!e.s.flags.stun && !e.s.flags.freeze && !e.s.flags.sleep)) return;
      a.casting = null; e.profile.noAttack = false; b.removeBuff(e, 'mizuki:ltswar:cast');
    },
  }];
}

export const MIZUKI_LATERANO_KITS = {
  enemy_1243_ltswar: nativeSaxophonist,
  enemy_1243_ltswar_2: nativeSaxophonist,
};
