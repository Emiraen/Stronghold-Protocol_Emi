// Only recruited RO2 instances use these selections. Account loadouts and the
// shared data source are immutable inputs, never a destination for edits.
import { unitStatsEntry } from '../../../shared/protocol.js';
import { Unit } from '../../sim/units.js';
import { equipmentPassiveStatMods } from '../../sim/content/items/battle.js';
import { mizukiUnlockedSkills } from './SkillUnlock.js';

// Memoize a tiny Unit stat calculation, never a battlefield or a combat timer.
const equipmentStatsCache = new WeakMap();
function reserveEquipmentStats(source, unit, def, getItem) {
  const ids = (unit.items || []).map((item) => typeof item === 'string' ? item : item.id).sort();
  if (!ids.length || typeof getItem !== 'function') return null;
  let cache = equipmentStatsCache.get(source);
  if (!cache) { cache = new Map(); equipmentStatsCache.set(source, cache); }
  const key = JSON.stringify([unit.chessId, unit.skillIndex, unit.moduleId, ids]);
  if (cache.has(key)) return cache.get(key);
  const preview = new Unit({ id: 0, uid: unit.uid, side: 'ally', kind: 'op', def, base: def.stats });
  for (const id of ids) for (const mods of equipmentPassiveStatMods(getItem(id))) preview.buffs.push({ mods, stacks: 1 });
  const stats = unitStatsEntry(preview, preview.s);
  if (cache.size >= 1024) cache.clear();
  cache.set(key, stats);
  return stats;
}
const skillView = (skill) => ({ index: skill.index, skillId: skill.skillId, name: skill.name || '',
  description: skill.desc || '', iconId: skill.iconId, skillType: skill.skillType,
  spCost: skill.spCost, duration: skill.duration, unlockCond: skill.unlockCond || null });

export function mizukiRunLoadoutOptions(source, unit) {
  const raw = source.rawChess(unit.chessId);
  if (!raw) return { skills: [], modules: [] };
  const skills = mizukiUnlockedSkills(raw).map(skillView);
  const modules = [{ id: 'none', name: '不装备模组', description: '', level: 0 }];
  if (unit.promotion && raw.status?.phase >= 2) for (const module of raw.modules || []) modules.push({
    id: module.uniEquipId, name: module.name || module.uniEquipId, typeName: module.typeName,
    description: [module.traitOverride?.moduleDesc, ...(module.talentChanges || []).map((value) => value.desc)].filter(Boolean).join('\n'),
    level: module.level, attr: structuredClone(module.attr || {}), iconId: module.icon || module.uniEquipId,
  });
  return { skills, modules };
}

export function validMizukiRunLoadout(source, unit, selection = unit) {
  const options = mizukiRunLoadoutOptions(source, unit);
  return Number.isInteger(selection.skillIndex) && options.skills.some((skill) => skill.index === selection.skillIndex)
    && typeof selection.moduleId === 'string' && options.modules.some((module) => module.id === selection.moduleId);
}

export function applyMizukiRunLoadout(source, unit, selection) {
  if (!validMizukiRunLoadout(source, unit, selection)) return null;
  const def = source.getChess(unit.chessId, selection), raw = def.raw, skill = raw.skill || {};
  return { ...unit, skillIndex: def.loadout.skillIndex, moduleId: def.loadout.moduleId || 'none',
    skillName: skill.name || '', skillType: skill.skillType || skill.type || '', cost: raw.stats.cost,
    skills: mizukiUnlockedSkills(raw).map(skillView),
    runLoadout: { skillIndex: def.loadout.skillIndex, moduleId: def.loadout.moduleId || 'none' } };
}

export function mizukiRunLoadoutView(source, unit, { editable = false, disabledReason = null, runtimeUnit = null, getItem = null } = {}) {
  const options = mizukiRunLoadoutOptions(source, unit);
  const def = source.getChess(unit.chessId, { skillIndex: unit.skillIndex, moduleId: unit.moduleId });
  const stats = def.raw.stats, skillIndex = def.loadout.skillIndex, moduleId = def.loadout.moduleId || 'none';
  const trainingStats = { ...structuredClone(stats), attackInterval: stats.bat * 100 / Math.max(1, stats.aspd || 100) };
  const live = runtimeUnit ? unitStatsEntry(runtimeUnit, runtimeUnit.s) : reserveEquipmentStats(source, unit, def, getItem);
  const currentStats = live ? { ...trainingStats, maxHp: live.maxHp, atk: live.atk, def: live.def, res: live.res,
    blockCnt: live.blockCnt, attackInterval: live.interval, cost: runtimeUnit?.s.cost ?? stats.cost } : trainingStats;
  return { ...options, statsSource: runtimeUnit ? 'combat-runtime' : live ? 'official-training-module-and-passive-equipment' : 'official-training-and-selected-module',
    stats: currentStats, trainingStats, skillIndex, moduleId,
    selectedSkill: options.skills.find((skill) => skill.index === skillIndex) || null,
    selectedModule: options.modules.find((module) => module.id === moduleId) || null,
    editable, disabledReason };
}
