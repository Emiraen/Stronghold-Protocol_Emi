// 三角初华: original BAR trait, both skills, talents and BAR-X module.
import { bardRegen } from '../../../professions.js';
import { addFever } from '../../mujica.js';
import { num, talentBb, moduleBb, bbOf, skillData, live, charId, isMujica, ensureMujica, enemiesInGrid, aura, inspire, fixedLoop, healTarget, inRange } from '../shared/mujica.js';

export default { chess_zj_dolris_a: (bb, chess) => {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1), mod = moduleBb(chess);
  const b1 = bbOf(chess, 'skchr_dolris_1'), b2 = bbOf(chess, 'skchr_dolris_2');
  const heal = (b, u, a, amount) => b.heal(u, a, amount * (charId(a) === 'char_4182_oblvns' ? num(mod.sp_scale_up, 1) : 1));
  return {
    skills: {
      skchr_dolris_1: { kind: 'duration', trigger: 'SP_FULL', targeting: { rangeGrid: skillData(chess, 'skchr_dolris_1').rangeGrid } },
      skchr_dolris_2: {
        kind: 'duration', trigger: 'SP_FULL',
        onStart({ battle, unit }) {
          unit.mem.mujicaDolrisPulse = 0;
          for (const ally of battle.allyUnits) battle.removeBuff(ally, `trait:bard:${unit.id}`);
        },
        onTick({ battle: b, unit: u, dt }) {
          u.mem.mujicaDolrisPulse += dt;
          const interval = Math.max(0.05, num(b2.interval, 0.3));
          while (u.mem.mujicaDolrisPulse >= interval - 1e-9) {
            u.mem.mujicaDolrisPulse -= interval;
            const foes = enemiesInGrid(b, u);
            const e = foes.length ? b.rng.pick(foes) : null;
            if (e) {
              b.fx('mujicaSound', { id: u.id, bank: 'battle.ON_BUFF_START.dolris_s2_attack_audio' });
              b.dealDamage(u, e, { amount: u.s.atk * num(b2['attack@atk_scale']), type: 'arts', isSkill: true, tags: ['skill', 'dolris'] });
              b.fx('sonic', { x: e.x, y: e.y, id: u.id, skill: 'skchr_dolris_2', radius: 0.4 });
            }
            const a = healTarget(b, u, true);
            if (a) heal(b, u, a, u.s.atk * num(b2['attack@heal_scale']));
          }
        },
      },
    },
    trait: {
      noAttack: true,
      install(b, u) {
        u.mem.noInspire = true;
        b.every(0.25, () => {
          if (!live(u)) return;
          for (const x of u.buffs.slice()) if (x.key === 'inspire' || x.key.startsWith('inspire:')) b.removeBuff(u, x);
          const allies = b.alliesInGrid(u), active = u.skill?.active;
          const s2 = active && u.skill.id === 'skchr_dolris_2';
          if (!s2) for (const a of allies) bardRegen(b, u, a, u.s.atk * 0.1);
          if (active) for (const a of allies) {
            if (a === u) continue;
            inspire(b, u, a, u.s.atk * num((s2 ? b2 : b1)['attack@atk']));
            if (!s2) inspire(b, u, a, u.s.def * num(b1['attack@def']), 'def');
          }
          if (allies.filter((a) => a !== u && a.kind === 'op').length >= num(mod.cnt, 2) && num(mod.atk) > 0) aura(b, u, 'mujica:dolris:module', [u], { atkPct: mod.atk });
        }, { owner: u });
      },
    },
    install(b, u) {
      ensureMujica(b);
      fixedLoop(b, u, num(t0['attack@heal_cd'], 4), () => {
        if (u.skill?.active) return false;
        const a = healTarget(b, u);
        if (!a) return false;
        heal(b, u, a, u.s.atk * num(t0['attack@heal_scale'], 0.3));
        u.lastAttackAt = b.time; u.stats.attacks++; b._ev(['atk', u.id, a.id, 'heal']);
        b.emit('attack', { attacker: u, targets: [a], isSkill: false });
        b.emit('mujicaStrike', { unit: u });
      });
      b.on('healed', (c) => {
        if (c.source === u && !c.opts?.regen && isMujica(c.target)) addFever(b, u, num(t1.normal_cnt, 5));
      }, { owner: u });
      b.on('hpDamage', (c) => {
        if (!live(u) || !u.skill?.active || u.skill.id !== 'skchr_dolris_1' || !inRange(u, c.target) || c.target.side !== 'ally') return;
        const special = healTarget(b, u, true);
        const a = charId(special) === 'char_4182_oblvns' ? special : c.target;
        heal(b, u, a, num(b1['attack@heal_value_s1']));
      }, { owner: u });
      b.on('hit', (c) => {
        if (!live(u) || !isMujica(c.source) || c.source.ownerId !== u.ownerId || c.target.side !== 'enemy' || !inRange(u, c.source)) return;
        if (c.dmg.tags.includes('dolris-rider')) return;
        b.dealDamage(u, c.target, { amount: u.s.atk * num(t1.atk_scale), type: 'arts', sourceless: true, tags: ['talent', 'dot', 'dolris-rider'] });
      }, { owner: u });
    },
  };
} };
