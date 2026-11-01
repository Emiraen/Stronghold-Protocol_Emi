// Native factions and special selectors from original enemy prefabs/templates.
import { T, setForm } from '../../sim/content/enemies.js';
import { canTargetAlly } from '../../sim/targeting.js';
import { ALLY_COLLIDER_RADIUS } from '../../sim/constants.js';

const STRENGTH = 'mizuki:sotidp:strength';
function commanderEffect(b, e) {
  const sources = b.enemies.filter((s) => s.alive && s !== e && s.mem.mizukiCommander);
  const source = sources[0];
  if (source) b.addBuff(e, { key: STRENGTH, source, refresh: 'replace',
    mods: { atkPct: T(source.mem.ab, 'strength.atk') ?? 0, defFlat: T(source.mem.ab, 'strength.def') ?? 0 } });
  else b.removeBuff(e, STRENGTH);
}
const enhanced = (stat, mod) => (ab) => [{
  iv: .25,
  tick(b, e) {
    const key = 'mizuki:sotidp:enhanced:' + mod;
    if (e.findBuff(STRENGTH)) b.addBuff(e, { key, refresh: 'replace',
      mods: { [mod]: (mod === 'moveMul' ? 1 : 0) + (T(ab, 'strength.' + stat) ?? 0) } });
    else b.removeBuff(e, key);
  },
}];

function specialTarget(value) {
  return [{ spawn(b, e) {
    // Native selector priorities are applied before taunt; ties retain the
    // engine's existing deployment/aggro order. Filtering occurs at swing lock.
    e.profile.canTarget = (u) => {
      if (e.blockedBy) return u === e.blockedBy;
      if (u.isFlying || !canTargetAlly(e, u, true)) return false;
      const candidates = b.alliesInRadius(e.x, e.y, e.base.rangeRadius + ALLY_COLLIDER_RADIUS)
        .filter((a) => !a.isFlying && canTargetAlly(e, a, true));
      const best = Math.min(...candidates.map(value));
      return value(u) <= best + 1e-9;
    };
  } }];
}
function duel(ab) {
  const selfKey = 'mizuki:cchmpn:self';
  const targetKey = 'mizuki:cchmpn:target';
  const sync = (b, e, a) => {
    const target = e.s.flags.silence ? null : e.blockedBy;
    if (a.target && a.target !== target) b.removeBuff(a.target, targetKey + ':' + e.id);
    a.target = target;
    if (!target) { b.removeBuff(e, selfKey); return; }
    b.addBuff(e, { key: selfKey, refresh: 'replace', mods: {
      defMul: 1 + (T(ab, 'duel.cchmpn_t_buff_self.def') ?? 0),
      taunt: T(ab, 'duel.cchmpn_t_buff_self.taunt_level') ?? 0 }, visible: true });
    b.addBuff(target, { key: targetKey + ':' + e.id, source: e, refresh: 'replace',
      mods: { defMul: 1 + (T(ab, 'duel.cchmpn_t_buff_blocker.def') ?? 0) }, visible: true });
  };
  return [{
    tick(b, e, a) { sync(b, e, a); },
    blocked(_c, b, e, a) { sync(b, e, a); },
    hitIn(c, b, e, a) {
      sync(b, e, a);
      if (a.target && c.source !== a.target) c.dmg.amount *= T(ab, 'duel.cchmpn_t_buff_self.damage_scale') ?? 0;
    },
    death(_c, b, e, a) { if (a.target) b.removeBuff(a.target, targetKey + ':' + e.id); },
  }];
}
function bloodKnight(ab) {
  return [{ spawn(b, e, a) {
    a.stacks = 0;
    b.on('death', ({ unit, reason }) => {
      if (!e.alive || unit?.side !== 'enemy' || unit === e || reason !== 'killed') return;
      a.stacks = Math.min(T(ab, 'enhance.max_stack_cnt') ?? 0, a.stacks + 1);
      b.addBuff(e, { key: 'mizuki:wdkght:enhance', refresh: 'replace', persist: true, visible: true,
        mods: { atkPct: a.stacks * (T(ab, 'enhance.atk') ?? 0), aspd: a.stacks * (T(ab, 'enhance.attack_speed') ?? 0) } });
      if (a.stacks === T(ab, 'enhance.max_stack_cnt')) setForm(b, e, 'rage');
    }, { owner: e });
  } }];
}
function imperialElite(ab) {
  const sync = (b, e) => {
    const key = 'mizuki:empace:atkup';
    if (e.hpRatio <= .5) b.addBuff(e, { key, mods: { atkPct: T(ab, 'atkup.atk') ?? 0 }, refresh: 'replace', visible: true });
    else b.removeBuff(e, key);
  };
  return [{
    spawn(_b, e) { e.profile.melee = false; },
    taken(_c, b, e) { sync(b, e); },
    before(_c, b, e) { sync(b, e); },
    tick(b, e) { sync(b, e); },
  }];
}

export const MIZUKI_FACTION_KITS = {
  enemy_1080_sotidp: () => [{
    spawn(b, e) {
      e.mem.mizukiCommander = true;
      for (const unit of b.enemies) if (unit.alive) commanderEffect(b, unit);
      b.on('enemySpawn', ({ enemy }) => commanderEffect(b, enemy), { owner: e, priority: -100 });
    },
    tick(b) { for (const e of b.enemies) if (e.alive) commanderEffect(b, e); },
    death(_c, b) { for (const e of b.enemies) if (e.alive) commanderEffect(b, e); },
  }],
  enemy_1078_sotisc: enhanced('move_speed', 'moveMul'),
  enemy_1079_sotisp: () => [],
  enemy_1083_sotiab: enhanced('atk', 'atkPct'),
  enemy_1083_sotiab_2: enhanced('atk', 'atkPct'),
  enemy_1098_cchmpn_2: duel,
  enemy_1103_wdkght: bloodKnight,
  enemy_1103_wdkght_2: bloodKnight,
  enemy_1113_empace: imperialElite,
  enemy_1113_empace_2: imperialElite,
  enemy_1153_dsexcu: () => specialTarget((u) => u.hpRatio),
  enemy_1153_dsexcu_2: () => specialTarget((u) => u.hpRatio),
  enemy_1190_krgbow: () => specialTarget((u) => u.s.def),
};
