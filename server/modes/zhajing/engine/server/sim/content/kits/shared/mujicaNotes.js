// Sakiko's free / tracking / piercing note states. Movement timings and radii: PRTS skill remarks.
import { COLS } from '../../../constants.js';
import { dirVec } from '../../../dir.js';
import { canTargetEnemy } from '../../../targeting.js';
import { live } from './mujica.js';
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const PARAMS = Object.freeze({
  normal: { update: 0.4, freeTime: 0.1, freeSpeed: 1.3, speed: 2, turn: 7, radius: 1, wave: 0.3 },
  s1: { update: 0.2, freeTime: 0.6, freeSpeed: 1.7, speed: 2.2, turn: 5, radius: 1, wave: 0 },
  piano: { update: 0.2, freeTime: 0.4, freeSpeed: 1.9, speed: 3.5, turn: 15, radius: 0.8, wave: 0.4, pierce: 0.5 },
  organ: { update: 0.4, freeTime: 0.4, freeSpeed: 0.7, speed: 1, turn: 2.5, radius: 1, wave: 0.15 },
  s3: { update: 0.4, freeTime: 0.8, freeSpeed: 0.8, speed: 1.3, turn: 7.5, radius: 1, wave: 0.5 },
});
export function installNotes(b, u) {
  const notes = u.mem.mujicaNotes = [];
  let seq = 0;
  const visual = (n, state) => b.fx('mujicaNote', { id: u.id, ownerId: u.ownerId, noteId: n.id, x: n.x, y: n.y, tx: n.target?.x ?? n.x, ty: n.target?.y ?? n.y, kind: n.color, projectile: n.projectile, state });
  const valid = (e) => live(e) && e.side === 'enemy' && canTargetEnemy(u, e, { canHitFly: true });
  const hit = (n, e) => {
    if (!valid(e) || n.hit.has(e.id)) return;
    n.hit.add(e.id);
    b.dealDamage(u, e, { amount: n.atk, type: n.type, isAttack: true, isSkill: n.skill, isProjectile: true, attackId: n.attackId, tags: ['mujica', 'mujica-note'] });
    visual(n, 'hit');
  };
  b.on('tick', ({ dt }) => {
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i], p = n.params;
      n.age += dt;
      if ((!live(u) && n.state !== 'track') || n.age > 60) n.done = true;
      if (n.state === 'pierce') {
        n.hitAge += dt;
        n.x += Math.cos(n.angle) * 3 * dt; n.y += Math.sin(n.angle) * 3 * dt;
        for (const e of b.enemiesInRadius(n.x, n.y, 0.8)) hit(n, e);
        if (n.hitAge >= p.pierce) n.done = true;
      } else {
        n.check -= dt;
        if (n.check <= 0) {
          n.check += p.update;
          if (!valid(n.target)) { n.target = null; n.state = 'free'; }
          if (!n.target) {
            const candidates = b.enemiesInRadius(n.x, n.y, p.radius).filter(valid);
            candidates.sort((a, z) => Math.hypot(a.x-n.x,a.y-n.y)-Math.hypot(z.x-n.x,z.y-n.y) || a.spawnSeq-z.spawnSeq);
            n.target = candidates[0] || null;
          }
          if (n.target && n.age >= p.freeTime) n.state = 'track';
        }
        if (n.state === 'track' && valid(n.target)) {
          const wanted = Math.atan2(n.target.y - n.y, n.target.x - n.x);
          const delta = wrap(wanted - n.angle);
          n.angle += Math.max(-p.turn*dt, Math.min(p.turn*dt, delta));
          const distance = Math.hypot(n.target.x - n.x, n.target.y - n.y);
          if (distance <= p.speed * dt + 0.2) {
            n.x = n.target.x; n.y = n.target.y;
            hit(n, n.target);
            if (p.pierce) { n.state = 'pierce'; n.hitAge = 0; }
            else n.done = true;
          } else { n.x += Math.cos(n.angle)*p.speed*dt; n.y += Math.sin(n.angle)*p.speed*dt; }
        } else {
          const a = n.angle + p.wave * Math.sin(n.age * 4) * Math.min(1, n.age);
          n.x += Math.cos(a)*p.freeSpeed*dt; n.y += Math.sin(a)*p.freeSpeed*dt;
        }
        const inside = u.rangeKeySet?.has(Math.round(n.y)*COLS+Math.round(n.x));
        n.outside = !inside && !n.target ? n.outside + dt : 0;
        if (n.outside >= 1) n.done = true;
      }
      if (n.done) { visual(n, 'end'); notes.splice(i, 1); }
      else if (b.time >= n.nextVisual) { visual(n, 'move'); n.nextVisual = b.time + 0.1; }
    }
  }, { owner: u });
  return function launch({ target = null, scale = 1, type = 'phys', kind = 'normal', color = kind, angle = null, rangedScale = 0.8, isSkill = false, attackId = null, projectile = null } = {}) {
    const [dr, dc] = dirVec(u.dir);
    if (!target && b.grid.tile(u.tileR+dr,u.tileC+dc).pass === 'NONE') return null;
    let params = PARAMS[kind] || PARAMS.normal;
    if (kind === 'normal' && target) params = { ...params, freeSpeed: 2, turn: 5, wave: 0 };
    const n = { id: `${u.id}:${++seq}`, x: u.x, y: u.y, angle: Math.atan2(dr,dc) + (angle ?? (b.rng()*40-20)*Math.PI/180), target, params, color, type,
      atk: u.s.atk * u.s.atkScaleMul * scale * (u.blocking?.length ? 1 : rangedScale), attackId, skill: isSkill, state: 'free', age: 0, outside: 0, check: 0, hit: new Set(), nextVisual: 0,
      projectile: projectile || (kind === 's3' ? `projectile_chr_oblvns_s3_${type === 'phys' ? 'phy' : 'mag'}` : kind === 'piano' ? 'projectile_chr_oblvns_s2' : kind === 'organ' ? 'projectile_chr_oblvns_s2_slow' : 'projectile_chr_oblvns') };
    notes.push(n); visual(n, 'spawn');
    b.emit('mujicaStrike', { unit: u, attackId });
    return n;
  };
}
