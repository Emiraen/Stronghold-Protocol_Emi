// 冻河 (V79): triggered effects keep their source identity and are consumed by their documented event.
import { num, talentBb, skillRec, up, alliesInGridOf, byEnemyAttack } from '../shared/tier1.js';
import { canTargetEnemy } from '../../../targeting.js';
import { hasHp } from '../../../damage.js';

const S1 = 'skchr_tocka_1', S2 = 'skchr_tocka_2', S3 = 'skchr_tocka_3';
export const TOCKA_MARKS = Object.freeze({ s1: 'tocka:trigger:shield', s2: 'tocka:trigger:auto', s3: 'tocka:trigger:spring' });
const SPRING = TOCKA_MARKS.s3;
const skillBb = (raw, sid) => skillRec(raw, sid)?.bb || {};
const skillUsable = u => up(u) && !u.hidden && u.canAct && !u.s.flags.silence && u.skill?.ready
  && !(u.skill.active && u.skill.isTimed) && !u.skill.pending && !u.skill.opCooling;
const canMark = (battle, source, target) => target.kind === 'op' && up(target) && !target.hidden && battle.allySelectable(target, source);
const ratio = u => u.skill?.noSkill ? -1 : u.skill?.ready ? 1 : (u.skill?.sp || 0) / Math.max(1, u.skill?.spCost || 1);
// The S3 selector explicitly orders by skill-point proportion. Stable deployment order resolves ties.
const mostSp = units => units.sort((a, b) => ratio(b) - ratio(a) || b.deploySeq - a.deploySeq || a.id - b.id);
const hasActiveSkill = u => u.skill && !u.skill.noSkill && u.skill.kind !== 'passive';
const springOrder = units => units.sort((a, b) => {
  const group = u => hasActiveSkill(u) ? (u.skill.active ? 1 : 0) : 2;
  return group(a) - group(b) || ratio(b) - ratio(a) || b.deploySeq - a.deploySeq || a.id - b.id;
});

function decayAttack(battle, source, target, value, duration, rate) {
  if (!(value > 0 && duration > 0) || !up(target)) return;
  battle.addBuff(target, {
    key: `tocka:spring:atk:${source.id}`, duration, source, mods: { atkPct: value }, interval: battle.dt,
    tags: ['skill', 'tocka:spring'],
    onTick({ unit, buff }) {
      const elapsed = Math.max(0, duration - buff.timeLeft + battle.dt);
      buff.mods = { atkPct: Math.max(0, value - rate * elapsed) };
      unit.markDirty();
    },
  });
}

export default {
  char_4244_tocka: (_bb, raw) => {
    const b1 = skillBb(raw, S1), b2 = skillBb(raw, S2), b3 = skillBb(raw, S3);
    const t0 = talentBb(raw, 0), t1 = talentBb(raw, 1);
    const triggerTalent = (battle, source) => {
      if (!up(source)) return;
      source.skill?.gainSp(num(t0.sp), 'tocka:trigger');
      const injured = alliesInGridOf(battle, source).filter(a => a.kind === 'op' && a.hp < a.s.maxHp && !a.s.flags.noHeal);
      injured.sort((a, b) => a.hpRatio - b.hpRatio || a.id - b.id);
      if (injured[0] && num(t0.heal_scale) > 0) battle.heal(source, injured[0], source.s.atk * num(t0.heal_scale));
    };
    const grant = (battle, source, target, key) => {
      if (!canMark(battle, source, target) || target.findBuff(key)) return false;
      const mark = battle.addBuff(target, { key, source, visible: true, tags: ['skill', 'tocka:trigger'] });
      if (mark && num(t1['attack@t2_buff_duration']) > 0) source.mem.tockaNextSplash = true;
      if (mark) battle.fx('tocka_mark', { id: source.id, target: target.id, x: target.x, y: target.y,
        skill: key === SPRING ? S3 : key === TOCKA_MARKS.s2 ? S2 : S1, dur: 0 });
      return !!mark;
    };
    const owned = (battle, source, key) => battle.alliesFor(source).find(a => a.findBuff(key)?.source === source);
    const transferSpring = (battle, source, holder) => {
      const choices = springOrder(alliesInGridOf(battle, source).filter(a => a !== source && a !== holder
        && canMark(battle, source, a) && !a.findBuff(SPRING)));
      if (choices[0]) grant(battle, source, choices[0], SPRING);
    };
    const triggerSpring = (battle, source, holder) => {
      if (holder?.findBuff(SPRING)?.source !== source || !up(source) || !up(holder)) return false;
      battle.removeBuff(holder, SPRING);
      const amount = num(b3.bonus_init_atk), duration = num(b3.bonus_duration, 15);
      const rate = num(b3.bonus_atk_dec_per_sec, duration > 0 ? amount / duration : 0);
      decayAttack(battle, source, holder, amount, duration, rate);
      decayAttack(battle, source, source, amount, duration, rate);
      battle.fx('tocka_trigger', { id: source.id, target: holder.id, x: holder.x, y: holder.y, skill: S3, dur: duration });
      triggerTalent(battle, source);
      transferSpring(battle, source, holder);
      return true;
    };
    const candidates = (battle, source, key, global = false) => {
      const list = global ? battle.alliesFor(source) : alliesInGridOf(battle, source);
      const valid = list.filter(a => canMark(battle, source, a) && !a.findBuff(key));
      if (key === TOCKA_MARKS.s2) return valid.filter(a => hasActiveSkill(a) && !a.skill.active
        && !a.findBuff('tocka:auto:aspd') && !Object.values(TOCKA_MARKS).some(k => a.findBuff(k)))
        .sort((a, b) => Number(a === source) - Number(b === source) || b.deploySeq - a.deploySeq || a.id - b.id);
      return mostSp(valid);
    };
    const applyMarks = (battle, source, key, bb, global = false) => {
      const count = Math.max(1, Math.floor(num(bb.max_target, 1)));
      for (const target of candidates(battle, source, key, global).slice(0, count)) grant(battle, source, target, key);
    };
    return {
      trait: { dmgType: 'phys', attack: 'ranged', projectile: 'bolt', canHitFly: true, heal: null },
      skills: {
        [S1]: { kind: 'instant', trigger: 'NEVER', onStart({ battle, unit }) { applyMarks(battle, unit, TOCKA_MARKS.s1, b1); } },
        [S2]: { kind: 'instant', trigger: 'NEVER', onStart({ battle, unit }) { applyMarks(battle, unit, TOCKA_MARKS.s2, b2, true); } },
        [S3]: {
          kind: 'duration', mods: { aspd: num(b3.attack_speed) },
          targeting: { maxTargets: Math.max(1, Math.floor(num(b3['attack@max_target'], 4))) },
          attack: { dmgType: 'phys', atkScale: num(b3['attack@atk_scale'], 1),
            onEachHit({ battle, unit, target }) {
              if (target?.alive && num(b3['attack@stun']) > 0) battle.applyStatus(target, 'stun', { duration: num(b3['attack@stun']), source: unit });
            } },
          onStart({ battle, unit }) {
            const holder = owned(battle, unit, SPRING);
            if (holder) triggerSpring(battle, unit, holder);
            else {
              const choices = springOrder(alliesInGridOf(battle, unit).filter(a => a !== unit && canMark(battle, unit, a) && !a.findBuff(SPRING)));
              if (choices[0]) grant(battle, unit, choices[0], SPRING);
            }
          },
        },
      },
      install(battle, source) {
        let nextSp = battle.time + 1;
        let nextAuto = battle.time;
        const triggerReady = target => {
          if (!up(source) || !up(target) || !target.skill?.ready) return;
          if (target.findBuff(TOCKA_MARKS.s2)?.source !== source) return;
          battle.removeBuff(target, TOCKA_MARKS.s2);
          battle.addBuff(target, { key: 'tocka:auto:aspd', source, duration: num(b2.buff_duration, 15),
            mods: { aspd: num(b2.attack_speed) }, tags: ['skill', 'tocka:auto'] });
          battle.fx('tocka_trigger', { id: source.id, target: target.id, x: target.x, y: target.y,
            skill: S2, dur: num(b2.buff_duration, 15) });
          triggerTalent(battle, source);
        };
        battle.on('skillReady', ({ unit }) => {
          if (unit.findBuff(TOCKA_MARKS.s2)?.source === source) triggerReady(unit);
          else if (unit.findBuff('tocka:auto:aspd')?.source === source) triggerTalent(battle, source);
        }, { owner: source });
        battle.on('deploy', ({ unit }) => {
          if (unit === source) { source.mem.tockaNextSplash = false; nextSp = battle.time + 1; }
        }, { owner: source });
        battle.on('death', ({ unit }) => {
          if (unit !== source) return;
          source.mem.tockaNextSplash = false;
          for (const target of battle.allyUnits) for (const key of Object.values(TOCKA_MARKS)) {
            if (target.findBuff(key)?.source === source) battle.removeBuff(target, key);
          }
        }, { owner: source });
        battle.on('hit', ctx => {
          const target = ctx.target;
          if (!up(source) || !up(target) || !byEnemyAttack(ctx)) return;
          if (target.findBuff(TOCKA_MARKS.s1)?.source !== source) return;
          battle.removeBuff(target, TOCKA_MARKS.s1);
          const total = source.s.atk * num(b1.shield_atk_scale), duration = num(b1.shield_time, 10);
          battle.addBuff(target, { key: 'tocka:shield', source, shield: total, duration, visible: true, interval: battle.dt,
            onTick({ unit, buff }) {
              buff.shield = Math.max(0, buff.shield - total * battle.dt / duration); unit.markDirty();
            } });
          battle.fx('tocka_trigger', { id: source.id, target: target.id, x: target.x, y: target.y, skill: S1, dur: duration });
          if (ctx.source.alive) battle.applyStatus(ctx.source, 'stun', { duration: num(b1.stun), source });
          triggerTalent(battle, source);
        }, { owner: source, priority: 600 });
        battle.on('skillStart', ({ unit }) => {
          if (unit !== source) triggerSpring(battle, source, unit);
        }, { owner: source });
        battle.on('beforeAttack', ctx => {
          if (ctx.attacker !== source || !up(source) || !source.mem.tockaNextSplash || !ctx.targets?.length) return;
          source.mem.tockaNextSplash = false;
          const prev = ctx.profile.onEachHit;
          // A private per-attack profile keeps later shots from mutating an in-flight talent projectile.
          ctx.profile = { ...ctx.profile, splashRadius: num(t1['attack@projectile_range'], 1.5), splashScale: 1,
            onEachHit(b, unit, target, hit) {
              if (prev) prev(b, unit, target, hit);
              if (!hasHp(target) || !canTargetEnemy(unit, target, { canHitFly: true })) return;
              const duration = num(t1['attack@t2_buff_duration']);
              if (!(duration > 0)) return;
              b.fx('tocka_snow', { id: unit.id, target: target.id, x: target.x, y: target.y, dur: duration });
              b.applyStatus(target, 'weaken', { duration, value: Math.abs(num(t1['attack@t2_atk'])), source: unit });
              b.addBuff(target, { key: `tocka:snow:${unit.id}`, source: unit, duration, interval: 1,
                tags: ['talent', 'dot'], onTick({ battle: battle2, unit: victim }) {
                  battle2.dealDamage(unit, victim, { amount: unit.s.atk * num(t1['attack@t2_magic_atk_scale']),
                    type: 'arts', canDodge: false, tags: ['talent', 'dot', 'tocka:snow'] });
                } });
            } };
        }, { owner: source, priority: -50 });
        battle.on('tick', () => {
          if (!up(source) || source.hidden) return;
          const skill = source.skill;
          if (skillUsable(source) && battle.time >= skill.nextCastAt - 1e-9) {
            if (skill.id === S1 && candidates(battle, source, TOCKA_MARKS.s1).length) skill.activate('tocka:shield:auto');
            if (skill.id === S2 && candidates(battle, source, TOCKA_MARKS.s2, true).length) skill.activate('tocka:effect:auto');
          }
          for (const target of battle.alliesFor(source)) triggerReady(target);
          if (battle.time >= nextAuto - 1e-9) {
            nextAuto = battle.time + .2;
            for (const target of battle.alliesFor(source)) {
              if (target.findBuff('tocka:auto:aspd')?.source === source && skillUsable(target)) target.skill.activate('tocka:auto');
            }
          }
          if (battle.time >= nextSp - 1e-9) {
            nextSp = battle.time + 1;
            if (skill.active && skill.id === S3) {
              const holder = owned(battle, source, SPRING);
              holder?.skill?.gainSp(num(b3.bonus_sp, 1), 'tocka:spring');
            }
          }
        }, { owner: source });
      },
    };
  },
};
