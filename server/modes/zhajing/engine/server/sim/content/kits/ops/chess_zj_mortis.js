// 若叶睦: damage conversion, silent substitute, S1 shield persistence and random S2 triple shots.
import { addFever } from '../../mujica.js';
import { num, talentBb, bbOf, skillData, live, mates, ensureMujica, enemiesInGrid, aura, attackEvent, strike, fixedLoop } from '../shared/mujica.js';
export default { chess_zj_mortis_a: (bb, chess) => {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1), tb = chess.trait?.bb || {};
  const b1 = bbOf(chess, 'skchr_mortis_1'), b2 = bbOf(chess, 'skchr_mortis_2');
  return {
    trait: { noAttack: true, dollNoAttack: true },
    skills: {
      skchr_mortis_1: {
        kind: 'duration', trigger: 'TAKE_DAMAGE',
        mods: { defPct: num(b1.def), blockCnt: num(b1.block_cnt, 2), taunt: num(b1.taunt_level, 1) },
        onStart({ unit }) { unit.mem.mortisShield = true; },
        onEnd({ unit, reason }) { if (reason !== 'substitute') unit.mem.mortisShield = false; },
      },
      skchr_mortis_2: {
        kind: 'duration', targeting: { rangeGrid: skillData(chess, 'skchr_mortis_2').rangeGrid },
        mods: { batPct: num(b2.base_attack_time) / Math.max(0.1, chess.stats.bat) },
      },
    },
    install(b, u) {
      ensureMujica(b);
      b.every(0.25, () => { if (live(u)) aura(b, u, 'mujica:mortis:hp', mates(b, u), { hpPct: num(t1.max_hp, 0.1) }); }, { owner: u });
      b.on('damageAttempt', (c) => { if (c.target === u && live(u)) addFever(b, u, num(t1.cnt, 3)); }, { owner: u });
      b.on('hpDamage', (c) => {
        if (c.target !== u || !['phys', 'arts'].includes(c.dmg.type) || !(c.amount > 0)) return;
        const converted = c.amount * num(t0.damage_resistance, 0.3);
        c.amount -= converted;
        b.dealDamage(u, u, { amount: converted * num(t0.dark_damage_mul_factor, 0.5), type: 'element', element: 'apoptosis', tags: ['talent', 'mortis-conversion'] });
      }, { owner: u, priority: -1000 });
      b.on('dollSwap', ({ unit, form }) => {
        if (unit !== u) return;
        if (form) {
          b.addBuff(u, { key: 'mujica:mortis:doll', mods: { defPct: num(t0.def), hpMul: 1 + num(tb.max_hp) } });
          if (u.mem.mortisShield) {
            const substitute = u.findBuff('trait:substitute');
            if (substitute) { substitute.mods.blockCnt = -2; u.markDirty(); }
            b.addBuff(u, { key: 'mujica:mortis:shield', mods: { defPct: num(b1.def), blockCnt: num(b1.block_cnt, 2), taunt: num(b1.taunt_level, 1) } });
          }
        } else {
          b.removeBuff(u, 'mujica:mortis:doll'); b.removeBuff(u, 'mujica:mortis:shield'); u.mem.mortisShield = false;
        }
      }, { owner: u });
      b.on('mujicaStrike', ({ unit: source }) => {
        if (!live(u) || !u.trait.doll || !source || source.ownerId !== u.ownerId || !mates(b, u).includes(source)) return;
        const doll = u.findBuff('trait:substitute');
        if (doll && b.rng() < num(t0.prob, 0.2)) doll.timeLeft = Math.max(0, doll.timeLeft - num(t0.delta_time, 1));
      }, { owner: u });
      b.on('damaged', (c) => {
        if (c.source !== u || !live(u) || !u.skill?.active || u.skill.id !== 'skchr_mortis_2' || c.target.side !== 'enemy' || !(c.amount > 0) || c.type === 'element' || c.dmg.tags.includes('mortis-self')) return;
        b.dealDamage(u, u, { amount: num(b2.value, 20), type: 'arts', canDodge: false, tags: ['skill', 'mortis-self'] });
      }, { owner: u });
      fixedLoop(b, u, () => u.s.interval, () => {
        if (u.trait.doll) return false;
        const targets = enemiesInGrid(b, u, null, { groundOnly: true, canHitFly: false });
        if (!targets.length) return false;
        const s2 = u.skill?.active && u.skill.id === 'skchr_mortis_2';
        const deployment = u.deploySeq;
        attackEvent(b, u, targets.slice(0, 1), (chosen, attackId) => {
          if (s2) b.fx('mujicaSound', { id: u.id, bank: 'battle.ON_BUFF_START.mortis_s2_spell_on_audio' });
          const n = s2 ? 3 : 1;
          for (let i = 0; i < n; i++) b.after((s2 ? 1/3 + i / 10 : 13/30) * u.s.interval / (s2 ? 0.9 : 1.2), () => {
            if (!live(u) || deployment !== u.deploySeq || u.trait.doll || !u.canAct || u.s.flags.disarm) return;
            const now = enemiesInGrid(b, u, null, { groundOnly: true, canHitFly: false });
            const e = s2 ? (now.length ? b.rng.pick(now) : null) : (live(chosen[0]) ? chosen[0] : now[0]);
            if (e) strike(b, u, e, s2 ? num(b2['attack@atk_scale']) : 1, { attackId, type: s2 ? 'arts' : 'phys', skill: s2 });
          }, { owner: u });
        }, s2);
      });
    },
  };
} };
