// Water Moon only: original squadBuffData, including strengthened virtues.
import { readFileSync } from 'node:fs';

const SOURCE = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic.squadBuffData;
const INSTALLED = new WeakMap(), PREFIX = 'mizuki:virtue:';
const blackboard = (buff) => Object.fromEntries((buff.blackboard || []).map((entry) => [entry.key, entry.valueStr ?? entry.value]));
const present = (unit) => unit?.side === 'ally' && unit.alive && unit.deployed && !unit.hidden && unit.hp > 0;

export function mizukiVirtueSpec(id) {
  const raw = SOURCE[id]; if (!raw) return null;
  const spec = { id, name: raw.outerName, description: raw.functionDesc, iconId: raw.iconId, rewards: [] };
  for (const buff of raw.buffs) {
    const bb = blackboard(buff);
    if (bb.key === 'rogue_2_attr_down[game_start]') spec.enemy = { duration: bb.duration, atk: bb.atk, move: bb.move_speed };
    else if (bb.key === 'rogue_2_modify_sp[highest_max_hp]') spec.sp = bb.sp;
    else if (bb.key === 'rogue_2_hp_recovery[lowest_hp]') spec.regen = bb.hp_recovery_per_sec;
    else if (bb.key === 'evade[non_pure]') spec.dodge = bb.prob;
    else if (buff.key === 'char_attribute_add') spec.ranged = { def: bb.def, res: bb.magic_resistance };
    else if (buff.key === 'battle_extra_exp') spec.extraExp = { count: bb.count, limit: bb.limit };
    else if (buff.key === 'immediate_reward') spec.rewards.push({ poolId: bb.id, count: bb.count });
  }
  return spec;
}

/** Install only on a Mizuki field. Reward settlement remains owned by Match. */
export function installMizukiNativeBlessings(battle, { virtues = [] } = {}) {
  if (INSTALLED.has(battle)) return INSTALLED.get(battle);
  const specs = [...new Set(virtues.map((virtue) => virtue?.id ?? virtue))].map(mizukiVirtueSpec).filter(Boolean);
  const fury = specs.filter((spec) => spec.enemy);
  const sp = specs.reduce((sum, spec) => sum + (spec.sp || 0), 0);
  const regen = specs.reduce((sum, spec) => sum + (spec.regen || 0), 0);
  const dodge = 1 - specs.reduce((chance, spec) => chance * (1 - (spec.dodge || 0)), 1);
  const ranged = specs.filter((spec) => spec.ranged);
  const enemy = (unit) => {
    if (unit?.side !== 'enemy') return;
    for (const spec of fury) {
      const remaining = spec.enemy.duration - battle.time; if (!(remaining > 0)) continue;
      battle.addBuff(unit, { key: PREFIX + spec.id, duration: remaining, mods: { atkMul: spec.enemy.atk, moveMul: spec.enemy.move } });
    }
  };
  const ally = (unit) => {
    if (unit?.side !== 'ally' || unit.def?.position !== 'RANGED') return;
    for (const spec of ranged) battle.addBuff(unit, { key: PREFIX + spec.id, duration: Infinity, persist: true, allowDead: true,
      mods: { defFlat: spec.ranged.def, resFlat: spec.ranged.res } });
  };
  battle.on('enemySpawn', ({ enemy: unit }) => enemy(unit), { priority: -5000 });
  battle.on('deploy', ({ unit }) => ally(unit), { priority: -5000 });
  for (const unit of battle.enemies) enemy(unit);
  for (const unit of battle.allyUnits) ally(unit);
  if (sp || regen) battle.on('tick', ({ dt }) => {
    const operators = battle.allyUnits.filter((unit) => present(unit) && unit.kind === 'op');
    if (sp && operators.length) {
      const target = operators.reduce((best, unit) => unit.s.maxHp > best.s.maxHp ? unit : best);
      target.skill?.gainSp(sp * dt, PREFIX + 'sp');
    }
    if (regen && operators.length) {
      const target = operators.reduce((best, unit) => unit.hp / unit.s.maxHp < best.hp / best.s.maxHp ? unit : best);
      battle.heal(target, target, regen * dt, { regen: true, silent: true });
    }
  });
  // Independent evade roll composes multiplicatively with operator talents.
  if (dodge) battle.on('hit', ({ source, target, dmg }) => {
    if (!present(target) || target.def?.position !== 'MELEE' || !dmg.canDodge || dmg.cancel
      || !['phys', 'arts'].includes(dmg.type) || battle.rng() >= dodge) return;
    dmg.cancel = true; battle.fx('dodge', { x: target.x, y: target.y, id: target.id });
    battle.emit('dodge', { source, target, dmg });
  }, { priority: -5000 });
  const controller = { snapshot: () => specs.map((spec) => structuredClone(spec)) };
  INSTALLED.set(battle, controller); return controller;
}
