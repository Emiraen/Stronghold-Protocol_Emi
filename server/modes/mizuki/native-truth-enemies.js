// Original RO2 “Truth” enemies. Neutral civilians remain on their original
// route; their special allegiance is adapted only on this battle instance.
import { T, lpLoss } from '../../sim/content/enemies.js';
import { reborn } from '../../sim/content/enemies/archetypes.js';
import { aggroCmp, canTargetAlly } from '../../sim/targeting.js';
import { attackWindup } from '../../sim/ai.js';
import { ATTACK_PAUSE } from '../../sim/constants.js';

const present = (u) => u.alive && u.deployed && !u.hidden;
const neutral = (u) => !!u?.mem.mizukiNeutralCitizen;
const fx = (b, u, key, extra = {}) => b.fx('mizuki:effect', { key, unitId: u.id, x: u.x, y: u.y, ...extra });

function installNeutralAllegiance(b) {
  if (b._mizukiNeutralAllegiance) return;
  b._mizukiNeutralAllegiance = true;
  // Native side BOTH is friendly to operators. Keep civilians in the enemy
  // route list, while preventing friendly damage, including forced picks and
  // HP loss which bypasses the ordinary hit hooks.
  const damage = b.dealDamage.bind(b), loss = b.loseHp.bind(b);
  b.dealDamage = (source, target, info) => neutral(target) && source?.side === 'ally' ? 0 : damage(source, target, info);
  b.loseHp = (target, amount, options = {}) => neutral(target) && options.source?.side === 'ally' ? 0 : loss(target, amount, options);
  const recordLeak = b._recordLeak.bind(b);
  b._recordLeak = (e, timeout) => {
    if (!neutral(e) || timeout) return recordLeak(e, timeout);
    // Safe arrivals resolve the original wave entry without creating an enemy
    // leak, breaking perfect combat, or charging the mode's leak/light tally.
    if (e.inTotal) {
      b.leakedInTotal++;
      const pp = b._pp(e.ownerId); if (pp) pp.leakedInTotal++;
    }
  };
  b.on('beforeStatus', (c) => { if (neutral(c.target) && c.source?.side === 'ally') c.cancel = true; }, { priority: 10000 });
}

function nativeCitizen(ab) {
  return [{
    spawn(b, e) {
      installNeutralAllegiance(b); e.mem.mizukiNeutralCitizen = true;
      e._mizukiSourceSide = 2;
      e.profile.noAttack = true;
      // Original mark_neutral has BLOCK_FREE and the neutral selection mask.
      b.addBuff(e, { key: 'mark_neutral[effect]', persist: true,
        flags: { unblockable: true, untargetable: true }, visible: true });
      b.addBuff(e, { key: 'upeople_t', persist: true });
      fx(b, e, 'enemy_upeopl_buff', { id: 'upeople:neutral:' + e.id, loop: true, active: true });
    },
    death(c, b, e) {
      fx(b, e, 'enemy_upeopl_buff', { id: 'upeople:neutral:' + e.id, loop: true, phase: 'stop', active: false });
      // upeople_t's ModifyLifePoint has isReachExit=false. A safe exit is not
      // a death, and the source DB explicitly gives this citizen lpr=0.
      if (c.reason === 'killed') lpLoss(b, Math.max(0, -T(ab, 'dead.value')), 'upeople_t', e);
    },
  }];
}

function nativeKnight(ab) {
  const skill = ab.sk.AtkDesWeaken;
  if (!skill) throw new TypeError('Missing native knight AtkDesWeaken');
  const targetOf = (b, e) => b.allyUnits.filter((u) => canTargetAlly(e, u, true) && !u.findBuff('lfkght_s[weaken]'))
    .sort((a, z) => z.s.atk - a.s.atk || aggroCmp(a, z))[0];
  const stop = (b, e, a) => {
    a.cast = null; e.profile.noAttack = false; b.removeBuff(e, 'mizuki:lfkght:casting');
  };
  return [{
    spawn(_b, e) {
      e.profile.melee = false; e.profile.deferHit = true; e.profile.shot = 'none';
      e.profile.canTarget = (u) => !u.isFlying;
      // Original Attack clip speed=1.4, duration=2, OnAttack=.967.
      e.def = { ...e.def, attackAnim: { dur: 2 / 1.4, hit: .967 / 1.4 } };
      e.mem.mizukiTruthKnight = {};
    },
    attack(c, b, e) {
      const target = c.targets[0]; if (!target) return;
      fx(b, e, 'enemy_lfkght_attack_01_start');
      fx(b, target, 'enemy_lfkght_attack_01_hit');
      // Original BattleDamageAbility damageType=ARTS, with no projectile.
      b.dealDamage(e, target, { type: 'arts', amount: e.s.atk, isAttack: true, attackId: b._attackSeq });
    },
    tick(b, e) {
      const a = e.mem.mizukiTruthKnight;
      if (a.cast && !e.canAct) stop(b, e, a);
    },
  }, reborn({ key: 'mizuki:lfkght:reborn', dur: T(ab, 'reborn.duration'), hpRatio: .2,
    onKo(b, e) {
      const a = e.mem.mizukiTruthKnight;
      a.cast = null; b.removeBuff(e, 'mizuki:lfkght:casting');
      fx(b, e, 'enemy_lfkght_skill_02_start');
    },
    onReborn(_b, e) { e.profile.noAttack = false; },
  }), {
    cd: skill.cd, left: skill.icd, sk: skill, sil: true,
    cond(b, e) { return !e.mem.mizukiTruthKnight.cast && e.canAct && !!targetOf(b, e); },
    fire(b, e) {
      const a = e.mem.mizukiTruthKnight, cast = {}; a.cast = cast;
      e.swing = false; e.swingTargets = null; e.profile.noAttack = true;
      e.skillAnimUntil = b.time + 1.5;
      b.addBuff(e, { key: 'mizuki:lfkght:casting', duration: 1.5, flags: { noMove: true } });
      fx(b, e, 'enemy_lfkght_skill_01_start');
      // The source selector is global, ATK-descending, excluding the existing
      // debuff, and selects at Skill_1's OnAttack (.4s).
      b.after(.4, () => {
        if (a.cast !== cast || !e.canAct) return;
        const target = targetOf(b, e); if (!target) return;
        b.removeBuff(target, 'lfkght_s[mark]');
        b.addBuff(target, { key: 'lfkght_s[weaken]', duration: skill.bb.duration,
          source: e, mods: { atkPct: skill.bb.atk }, visible: true });
        fx(b, target, 'enemy_lfkght_skill_01_hit');
        fx(b, target, 'wind_buff_01', { id: 'lfkght:weaken:' + target.id, duration: skill.bb.duration, loop: true, active: true });
      }, { owner: e });
      b.after(1.5, () => { if (a.cast === cast && !e.findBuff('mizuki:lfkght:reborn')) stop(b, e, a); }, { owner: e });
    },
  }];
}

function nativeOfficer() {
  const able = (b, e) => e.canAct && !e.s.flags.disarm && !e.s.flags.fear && b.time >= e.unbalanceUntil - 1e-9;
  const citizens = (b, e) => b.enemies.filter((u) => neutral(u) && present(u) && !u.isFlying && !u.s.flags.sleep
    && (u.x - e.x) ** 2 + (u.y - e.y) ** 2 <= (1.2 + .1) ** 2 + 1e-9).sort(aggroCmp);
  const stop = (b, e, a) => {
    a.cast = null; e.profile.noAttack = false; b.removeBuff(e, 'mizuki:uoffcr:casting');
  };
  return [{
    spawn(_b, e, a) {
      // Combat is a separate physical melee ability; Attack's ranged selector
      // only accepts mark_neutral[effect], never ordinary operators.
      e.profile.melee = true; e.profile.dmgType = 'phys';
      e.def = { ...e.def, attackAnim: { dur: 1, hit: .5 } };
      e.mem.mizukiTruthOfficer = a;
    },
    tick(b, e, a) {
      if (a.cast) {
        if (!able(b, e) || e.blockedBy) stop(b, e, a);
        return;
      }
      if (e.blockedBy || !able(b, e) || e.atkCd > attackWindup(e) + 1e-9) return;
      const target = citizens(b, e)[0]; if (!target) return;
      const cast = {}; a.cast = cast; const seq = target.deploySeq;
      // Use the same clip compression as the ordinary enemy attack loop.
      const speed = Math.max(1, 1 / e.s.interval), wind = .5 / speed, duration = 1 / speed;
      e.profile.noAttack = true; e.swing = false; e.swingTargets = null;
      b.addBuff(e, { key: 'mizuki:uoffcr:casting', duration, flags: { noMove: true } });
      b.after(wind, () => {
        if (a.cast !== cast || !able(b, e)) return;
        const valid = (u) => neutral(u) && present(u) && !u.s.flags.sleep;
        const event = { enemy: e, targets: valid(target) && target.deploySeq === seq ? [target] : [] };
        b.emit('enemyAttackStart', event);
        if (!able(b, e)) return;
        // Native ranged attacks participate in the normal attack interruption
        // hooks, including neural-burst palsy, just like blocker combat.
        const palsy = e.findBuff('palsy');
        if (palsy) {
          const keep = !!b.emit('palsyTrigger', { enemy: e, buff: palsy, keep: false }).keep;
          if (!e.alive) return;
          if (!keep) { if (--palsy.stacks <= 0) b.removeBuff(e, palsy); else e.markDirty(); }
          e.atkCd = e.s.interval; e.atkStandUntil = b.time + ATTACK_PAUSE;
          b.fx('palsy', { x: e.x, y: e.y, id: e.id }); stop(b, e, a); return;
        }
        const ctx = { attacker: e, targets: event.targets.length ? event.targets : [target],
          profile: { ...e.profile, noAttack: false }, isSkill: false };
        b.emit('beforeAttack', ctx);
        if (!e.alive || !ctx.targets?.length) return;
        e.atkCd = e.s.interval; e.lastAttackAt = b.time; e.stats.attacks++;
        const attackId = ++b._attackSeq;
        const direct = ctx.targets.find(valid);
        // A locked civilian which died during the wind-up still spends this
        // attack's cooldown; it cannot make the officer immediately refire.
        if (!direct) {
          b.emit('attack', { attacker: e, targets: [], targetDeployments: new Map(), isSkill: false }); return;
        }
        b._ev(['atk', e.id, direct.id, 'none']);
        // Original tracking projectile: speed10, lifetime5, one hit, remains
        // valid when its source dies (stopWhenSourceInvalid=false).
        const p = b.addProjectile({ from: e, source: e, target: direct, speed: 10, maxAge: 5, visual: 'none',
          onHit({ target: direct }) {
            if (!direct) return; fx(b, direct, 'common_enemy_hit_01');
            b.dealDamage(e, direct, { type: 'phys', amount: e.s.atk, isAttack: true, isProjectile: true, attackId });
          } });
        fx(b, e, 'enemy_uoffcr_attack_01_trail', { id: 'uoffcr:' + p.id,
          to: { x: direct.x, y: direct.y }, toUnitId: direct.id, speed: 10, loop: false });
        b.emit('attack', { attacker: e, targets: [direct], targetDeployments: new Map([[direct, direct.deploySeq]]), isSkill: false });
      }, { owner: e });
      b.after(duration, () => { if (a.cast === cast) stop(b, e, a); }, { owner: e });
    },
  }];
}

export const MIZUKI_TRUTH_KITS = {
  enemy_1104_lfkght_2: nativeKnight,
  enemy_3001_upeopl: nativeCitizen,
  enemy_1107_uoffcr_2: nativeOfficer,
};

// Only live native buff loops belong in reconnection state; attack, skill hit,
// and rebirth one-shots continue to be driven by their original event frames.
export function snapshotMizukiTruthEffects(battle) {
  const effects = [];
  for (const e of battle.enemies) if (present(e) && neutral(e)) effects.push({
    id: 'upeople:neutral:' + e.id, key: 'enemy_upeopl_buff', unitId: e.id,
    x: e.x, y: e.y, loop: true, active: true,
  });
  for (const u of battle.allyUnits) {
    if (!present(u)) continue;
    const buff = u.findBuff('lfkght_s[weaken]');
    if (buff && buff.timeLeft > 0) effects.push({ id: 'lfkght:weaken:' + u.id, key: 'wind_buff_01',
      unitId: u.id, x: u.x, y: u.y, duration: buff.timeLeft,
      since: battle.time - (buff.duration - buff.timeLeft), loop: true, active: true });
  }
  return effects;
}
