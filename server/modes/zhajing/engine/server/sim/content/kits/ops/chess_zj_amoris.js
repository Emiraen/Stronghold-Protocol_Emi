// 祐天寺若麦: deterministic continuous hammer attacks, exact multi-hit ratios and HAM-X.
import { addFever } from '../../mujica.js';
import { COLS } from '../../../constants.js';
import { dirVec } from '../../../dir.js';
import { num, talentBb, moduleBb, bbOf, skillData, live, mates, ensureMujica, enemiesInGrid, aura, attackEvent, strike, fixedLoop } from '../shared/mujica.js';
export default { chess_zj_amoris_a: (bb, chess) => {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1), mod = moduleBb(chess), tb = chess.trait?.bb || {};
  const b1 = bbOf(chess, 'skchr_amoris_1'), b2 = bbOf(chess, 'skchr_amoris_2');
  return {
    trait: { noAttack: true },
    skills: {
      skchr_amoris_1: { kind: 'duration', targeting: { rangeGrid: [[0,1]], noRangeExtend: true } },
      skchr_amoris_2: { kind: 'duration', targeting: { rangeGrid: skillData(chess, 'skchr_amoris_2').rangeGrid } },
    },
    install(b, u) {
      ensureMujica(b);
      b.every(num(t1.interval, 1), () => { if (live(u)) addFever(b, u, num(t1.cnt, 3)); }, { owner: u });
      b.every(0.25, () => { if (live(u)) aura(b, u, 'mujica:amoris', mates(b, u), { atkPct: num(t1.atk, 0.08) }); }, { owner: u });
      b.on('hit', (c) => {
        if (c.source !== u || c.target.side !== 'enemy' || !live(u)) return;
        if (b.rng() < num(t0.prob, 0.1)) b.applyStatus(c.target, 'fragile', { value: Math.max(0, num(t0.damage_scale, 1.08) - 1), duration: num(t0['weak[limit]'], 2), source: u });
      }, { owner: u });
      fixedLoop(b, u, () => u.s.interval, () => {
        const id = u.skill?.active ? u.skill.id : null;
        const s1 = id === 'skchr_amoris_1', s2 = id === 'skchr_amoris_2';
        const chosen = enemiesInGrid(b, u, null, { groundOnly: true, canHitFly: false });
        const [dr, dc] = dirVec(u.dir);
        if (!chosen.length && (u.tileR + dr < 0 || u.tileR + dr >= 19 || u.tileC + dc < 0 || u.tileC + dc >= 21)) return false;
        const times = s2 ? [0.1, 1/3, 17/30, 0.8, 1, 37/30, 44/30, 1.7] : s1 ? [8/30, 26/30, 44/30] : [20/30];
        const rate = u.s.interval / 1.8;
        const deployment = u.deploySeq;
        attackEvent(b, u, chosen.slice(0,1), (targets, attackId) => {
          for (let i = 0; i < times.length; i++) b.after(times[i] * rate, () => {
            if (!live(u) || deployment !== u.deploySeq || !u.canAct || u.s.flags.disarm) return;
            const now = enemiesInGrid(b, u, null, { groundOnly: true, canHitFly: false });
            const target = s2 ? (now.length ? b.rng.pick(now) : null) : (live(targets[0]) ? targets[0] : now[0] || null);
            const radius = s1 && i === 0 ? 1.5 : num(tb['attack@ability_range_radius'], 1);
            let scale = s2 ? num(i === 0 || i === 4 ? b2['attack@atk_scale_heavy'] : b2['attack@atk_scale_light']) : s1 ? num(i === 0 ? b1['attack@atk_scale_heavy'] : b1['attack@atk_scale_light']) : 1;
            const key = s2 && !target && u.rangeKeys.length ? b.rng.pick(u.rangeKeys) : null;
            const point = key == null ? { x: u.x + dc, y: u.y + dr } : { x: key % COLS, y: Math.floor(key / COLS) };
            const pos = target || point;
            if (num(mod['attack@e_002_atk_scale'], num(tb.atk_scale_e)) > 0 && b.enemiesInRadius(pos.x, pos.y, radius).filter((e) => !e.isFlying).length >= num(mod['attack@cnt'], num(tb.cnt, 3))) scale *= num(mod['attack@e_002_atk_scale'], tb.atk_scale_e);
            const bank = s1 || s2 ? `battle.ON_PROJECTILE_BORN.projectile_chr_amoris_s${s2 ? 2 : 1}_${i === 0 || (s2 && i === 4) ? 1 : 2}`
              : 'battle.ON_PROJECTILE_REACH.projectile_chr_amoris';
            b.fx('mujicaSound', { id: u.id, bank });
            const projectile = s1 || s2 ? `projectile_chr_amoris_s${s2 ? 2 : 1}_${i === 0 || (s2 && i === 4) ? 1 : 2}` : 'projectile_chr_amoris';
            strike(b, u, target, scale, { attackId, skill: s1 || s2, splash: radius, splashScale: num(tb['attack@atk_scale_2'], 0.5), point, projectile });
          }, { owner: u });
        }, s1 || s2);
      });
    },
  };
} };
