// Native RO2 FrostNova; all hooks and lifecycle adaptation stay in this mode.
import { T, targetsNear } from '../../sim/content/enemies.js';
import { reborn } from '../../sim/content/enemies/archetypes.js';

const fx = (b, u, key, extra = {}) => b.fx('mizuki:effect', { key, unitId: u.id, x: u.x, y: u.y, ...extra });
function installFrozenExit(b, e, factor) {
  if (!b._mizukiFrozenExitSources) {
    const sources = b._mizukiFrozenExitSources = new Map();
    const remove = b._remove.bind(b);
    b._remove = (unit, ...args) => {
      const mul = unit.kind === 'op' && unit.side === 'ally' && unit.s.flags.freeze
        ? Math.max(1, ...[...sources].filter(([source]) => source.alive && source.deployed).map(([, value]) => value)) : 1;
      const result = remove(unit, ...args);
      // Removal clears normal buffs before death listeners. Read FROZEN before
      // it, then affect only this exit's timer (the source card buff lasts until
      // the next spawn), including a voluntary retreat while frozen.
      if (mul > 1 && !unit.removed && Number.isFinite(unit.respawnAt))
        unit.respawnAt = b.time + Math.max(0, unit.respawnAt - b.time) * mul;
      return result;
    };
  }
  b._mizukiFrozenExitSources.set(e, factor);
}

function nativeFrostNova(ab) {
  const ice = ab.sk.IceBurst, summon = ab.sk.SummonFrosts;
  if (!ice || !summon) throw new TypeError('Missing native FrostNova skills');
  const begin = (b, e, duration) => {
    const cast = {}; e.mem.mizukiFrost.cast = cast; e.profile.noAttack = true; e.swing = false;
    e.skillAnimUntil = b.time + duration;
    b.addBuff(e, { key: 'mizuki:flwitch:casting', duration, flags: { noMove: true } });
    b.after(duration, () => {
      if (e.mem.mizukiFrost.cast !== cast) return;
      e.mem.mizukiFrost.cast = null; e.profile.noAttack = false;
    }, { owner: e });
    return cast;
  };
  return [{
    spawn(b, e) {
      e.mem.mizukiFrost = { phase: 'normal', cast: null, summoned: 0 };
      e.profile.melee = false; e.profile.deferHit = true; e.profile.shot = 'none';
      e.profile.canTarget = (u) => !u.isFlying;
      e.def = { ...e.def, attackAnim: { dur: 1.5, hit: .933 } };
      b.addBuff(e, { key: 'flwitch_t_invincible', duration: T(ab, 'invincible.duration'), flags: { invulnerable: true } });
      installFrozenExit(b, e, T(ab, 'respawntimemul.respawn_time'));
    },
    attack(c, b, e) {
      const target = c.targets[0]; if (!target) return;
      const p = b.addProjectile({ from: e, source: e, target, speed: 10, maxAge: 10, visual: 'none',
        onHit({ target: direct }) {
          if (!direct) return; fx(b, direct, 'frstar2_attack_01_hit');
          b.dealDamage(e, direct, { type: 'arts', amount: e.s.atk, isAttack: true, isProjectile: true });
          b.applyStatus(direct, 'cold', { duration: T(ab, 'attackfreeze.freeze'), source: e });
        } });
      fx(b, e, 'frstar2_attack_01_trail', { id: 'flwitch:' + p.id, to: { x: target.x, y: target.y }, toUnitId: target.id, speed: 10, loop: false });
    },
  }, reborn({
    key: 'mizuki:flwitch:reborn', dur: T(ab, 'reborn.duration'), invincible: T(ab, 'reborn.reborn_invincible.duration'),
    onKo(_b, e) { e.mem.mizukiFrost.phase = 'reborn'; e.mem.mizukiFrost.cast = null; },
    onReborn(b, e) {
      e.mem.mizukiFrost.phase = 'form2';
      b.addBuff(e, { key: 'flwitch_reborn_up', persist: true,
        mods: { atkPct: T(ab, 'reborn.atk'), hpPct: T(ab, 'reborn.max_hp') } });
    },
  }), {
    cd: ice.cd, left: ice.icd, sk: ice,
    cond(b, e) { return e.mem.mizukiFrost.phase !== 'reborn' && !e.mem.mizukiFrost.cast && e.canAct && targetsNear(b, e, e.base.rangeRadius).length > 0; },
    fire(b, e) {
      const cast = begin(b, e, 2.233);
      b.after(.667, () => {
        if (!e.canAct || e.mem.mizukiFrost.cast !== cast) return;
        fx(b, e, 'flwitch_skill_02_range');
        for (const target of targetsNear(b, e, e.base.rangeRadius)) {
          // Native AtkScaleUp(overwrite=false) calls MergeScale=max(0,a*b).
          const scale = ice.bb.atk_scale * (target.s.flags.freeze ? ice.bb['flwitch_s_atkscale.atk_scale'] : 1);
          b.dealDamage(e, target, { type: 'arts', amount: e.s.atk * scale, isSkill: true });
          b.applyStatus(target, 'cold', { duration: ice.bb.freeze, source: e });
        }
      }, { owner: e });
    },
  }, {
    cd: summon.cd, left: summon.icd, sk: summon,
    cond(_b, e) { const a = e.mem.mizukiFrost; return a.phase !== 'reborn' && !a.cast && a.summoned < 4 && e.canAct; },
    fire(b, e) {
      const cast = begin(b, e, 1.067);
      b.after(.433, () => {
        if (!e.alive || e.mem.mizukiFrost.cast !== cast) return;
        const a = e.mem.mizukiFrost;
        // Native MoveNextLevelBranch(isLoop=false): sequential phases 1,3,2,4;
        // never pick random alternatives or activate all four at battle start.
        const result = b._officialWaves?.triggerBranch(summon.bs.branch_id, { phaseIndex: a.summoned, blockGameFinish: false });
        if (!result?.ok) throw new Error('Native FrostNova ice branch unavailable');
        a.summoned++;
      }, { owner: e });
    },
  }];
}

export const MIZUKI_FROST_BOSS_KITS = { enemy_2007_flwitch: nativeFrostNova };
