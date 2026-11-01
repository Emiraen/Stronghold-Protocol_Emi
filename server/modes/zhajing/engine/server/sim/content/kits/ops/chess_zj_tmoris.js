// 八幡海铃: AMB-Y dodge, independent hit rolls, five-strike S1 and fixed one-second S2.
import { addFever } from '../../mujica.js';
import { num, talentBb, bbOf, live, mates, isMujica, ensureMujica, enemiesInGrid, attackEvent, fixedLoop } from '../shared/mujica.js';
const WIDE = [[1,-1],[1,0],[1,1],[1,2],[0,-1],[0,0],[0,1],[0,2],[0,3],[-1,-1],[-1,0],[-1,1],[-1,2]];
export default { chess_zj_tmoris_a: (bb, chess) => {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const b1 = bbOf(chess, 'skchr_tmoris_1'), b2 = bbOf(chess, 'skchr_tmoris_2');
  const range = num(t0.mark) ? WIDE : chess.rangeGrid;
  return {
    trait: { noAttack: true },
    skills: {
      skchr_tmoris_1: {
        kind: 'duration', targeting: { rangeGrid: range },
        onStart({ battle: b, unit: u, skill }) {
          const activation = skill.activations;
          for (let i = 0; i < num(b1.times, 5); i++) b.after(11 / 30 + i * 4 / 30, () => {
            if (!live(u) || !skill.active || activation !== skill.activations) return;
            const targets = enemiesInGrid(b, u, range, { groundOnly: true, canHitFly: false });
            for (const e of targets) b.dealDamage(u, e, { amount: u.s.atk * num(b1.atk_scale), type: 'arts', isSkill: true, tags: ['skill', 'tmoris'] });
            b.emit('mujicaStrike', { unit: u });
            b.fx('sonic', { x: u.x, y: u.y, id: u.id, skill: 'skchr_tmoris_1', radius: 2 });
          }, { owner: u });
        },
      },
      skchr_tmoris_2: {
        kind: 'duration', targeting: { rangeGrid: range },
        onStart({ battle: b, unit: u }) {
          u.mem.mujicaAttackReset = true;
          for (const e of enemiesInGrid(b, u, range, { groundOnly: true, canHitFly: false })) {
            b.applyStatus(e, 'feared', { duration: num(b2.fear, 1.5), source: u });
            addFever(b, u, num(t1.cnt, 2)); // Fear attempts count even on an immune target (PRTS).
          }
        },
      },
    },
    install(b, u) {
      ensureMujica(b);
      fixedLoop(b, u, () => u.skill?.active && u.skill.id === 'skchr_tmoris_2' ? num(b2['attack@interval'], 1) : u.s.interval, () => {
        if (u.skill?.active && u.skill.id === 'skchr_tmoris_1') return false;
        const targets = enemiesInGrid(b, u, null, { groundOnly: true, canHitFly: false });
        if (!targets.length) return false;
        attackEvent(b, u, targets, (chosen, attackId) => {
          const s2 = u.skill?.active && u.skill.id === 'skchr_tmoris_2';
          for (const e of chosen) b.dealDamage(u, e, { amount: u.s.atk * u.s.atkScaleMul * (s2 ? num(b2['attack@atk_scale']) : 1), type: s2 ? 'arts' : 'phys', isAttack: true, isSkill: s2, attackId });
          b.emit('mujicaStrike', { unit: u, attackId });
        });
      });
      b.on('hit', (c) => {
        if (!live(u) || c.target.side !== 'enemy') return;
        if (c.source === u) {
          const p = num(t0.prob, 0.21) * (u.skill?.active && u.skill.id === 'skchr_tmoris_2' ? num(b2.talent_scale, 1) : 1);
          if (b.rng() < p && b.applyStatus(c.target, 'sluggish', { duration: num(t0.sluggish, 3), source: u })) addFever(b, u, num(t1.cnt, 2));
        }
        if (isMujica(c.source) && c.source.ownerId === u.ownerId && (c.target.hasBuff('sluggish') || c.target.hasBuff('feared'))) c.dmg.mul *= num(t1.damage_scale, 1.1);
      }, { owner: u });
      b.on('skillStart', ({ unit: other }) => {
        if (other === u || !live(u) || !isMujica(other) || other.ownerId !== u.ownerId || u.skill?.id !== 'skchr_tmoris_1' || u.skill.active || !u.canAct || u.s.flags.silence) return;
        u.skill.activate('mujica-bonus', { free: true });
      }, { owner: u });
    },
  };
} };
