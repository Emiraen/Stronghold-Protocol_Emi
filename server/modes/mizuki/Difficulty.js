// NORMAL N0-N18 only. Display records and initial resources are copied from
// the installed client's original RO2 topic table, never a monthly mode.
import { readFileSync } from 'node:fs';

const topic = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
const grades = topic.difficulties.filter((entry) => entry.modeDifficulty === 'NORMAL').sort((a, b) => a.grade - b.grade);
const initial = new Map(topic.init.filter((entry) => entry.modeId === 'NORMAL').map((entry) => [entry.modeGrade, entry]));
if (grades.length !== 19 || grades.some((entry, index) => entry.grade !== index || !initial.has(index))) {
  throw new TypeError('Original Mizuki N0-N18 records are incomplete');
}

export const validMizukiDifficulty = (grade) => Number.isInteger(grade) && grade >= 0 && grade <= 18;
// Original opening stock + the explicitly requested cooperative-mode bonus.
export const MIZUKI_INITIAL_DICE = Object.freeze({ initialDice: 1, bonusDice: 4 });

const COMMAND_LEVELS = topic.detailConst.playerLevelTable;
const COMMAND_MAX_LEVEL = Math.max(...Object.keys(COMMAND_LEVELS).map(Number));
const validCommandMaxLevel = level => Number.isInteger(level) && level >= 1 && level <= COMMAND_MAX_LEVEL;
/** Native RoguelikeDataUtil.GetLevelWithExp reads table[level+1] and
 * subtracts that row's exp on each level-up, rather than treating rows as
 * cumulative thresholds. Evidence: commander-data-util-disassembly.txt. */
export function mizukiCommanderProgress(totalExp = 0, maxLevel = COMMAND_MAX_LEVEL) {
  if (!Number.isSafeInteger(totalExp) || totalExp < 0 || totalExp > 999999999) throw new TypeError('Invalid Mizuki command experience');
  if (!validCommandMaxLevel(maxLevel)) throw new TypeError('Invalid Mizuki command level cap');
  let level = 1, exp = totalExp;
  while (level < maxLevel && exp >= COMMAND_LEVELS[level + 1].exp) {
    exp -= COMMAND_LEVELS[++level].exp;
  }
  return { level, exp, totalExp };
}
export function validMizukiCommander(value, maxLevel = COMMAND_MAX_LEVEL) {
  if (!validCommandMaxLevel(maxLevel) || !value || !Number.isSafeInteger(value.totalExp) || value.totalExp < 0 || value.totalExp > 999999999) return false;
  const expected = mizukiCommanderProgress(value.totalExp, maxLevel);
  return value.level === expected.level && value.exp === expected.exp;
}
export function mizukiCommanderNextExp(level, maxLevel = COMMAND_MAX_LEVEL) {
  if (!validCommandMaxLevel(maxLevel)) throw new TypeError('Invalid Mizuki command level cap');
  return level < maxLevel ? COMMAND_LEVELS[level + 1]?.exp ?? null : null;
}
export function mizukiCommanderLevelRewards(previousLevel, nextLevel) {
  if (!Number.isInteger(previousLevel) || !Number.isInteger(nextLevel) || previousLevel < 1
    || nextLevel < previousLevel || nextLevel > COMMAND_MAX_LEVEL) throw new TypeError('Invalid Mizuki command levels');
  return Array.from({ length: nextLevel - previousLevel }, (_, i) => ({ level: previousLevel + i + 1,
    ...structuredClone(COMMAND_LEVELS[previousLevel + i + 1]) }));
}

export function mizukiDifficultyOptions() {
  return grades.map(({ grade, name, ruleDesc, addDesc, color, warningType, scoreFactor }) => ({
    grade, label: 'N' + grade, name, ruleDesc, addDesc, color, warningType, scoreFactor,
  }));
}

export function mizukiDifficultyInitial(grade = 0) {
  if (!validMizukiDifficulty(grade)) throw new TypeError('Invalid Mizuki difficulty grade');
  return structuredClone(initial.get(grade));
}

export function mizukiDifficultyLight(grade = 0) {
  if (!validMizukiDifficulty(grade)) throw new TypeError('Invalid Mizuki difficulty grade');
  return 100 - (grade >= 6 ? 15 : 0) - (grade >= 10 ? 15 : 0);
}

export const mizukiDifficultyHopeDelta = (grade, rarity) => grade >= 4 && rarity >= 3 ? 1 : 0;
export const mizukiDifficultyDeployDelta = (grade) => grade >= 14 ? -1 : 0;
export const mizukiDifficultyCursePool = () => Object.values(topic.items).filter((item) => item.type === 'RELIC'
  && item.subType === 'CURSE' && item.rarity === 'RARE' && item.canSacrifice && !item.unlockCondDesc).map((item) => item.id);
export const mizukiCollectibleEffects = (ids = []) => ids.flatMap((id) => topic.relics[id]?.buffs || [])
  .map((effect) => ({ key: effect.key, values: Object.fromEntries((effect.blackboard || [])
    .map((entry) => [entry.key, entry.valueStr ?? entry.value])) }));

/** Each ordinary region, including the first, compounds the original area rate.
 * The grade's area rate replaces the preceding grade's rate; rank bonuses and
 * the three +15% elemental-loss thresholds remain cumulative. */
export function mizukiDifficultyModifiers(grade = 0, areaCount = 1, rank = 'NORMAL') {
  if (!validMizukiDifficulty(grade) || !Number.isInteger(areaCount) || areaCount < 1 || areaCount > 32) {
    throw new TypeError('Invalid Mizuki difficulty area context');
  }
  const hpRate = grade >= 18 ? 0.3 : grade >= 17 ? 0.25 : grade >= 16 ? 0.2 : grade / 100;
  const atkRate = grade >= 16 ? 0.2 : grade / 100;
  const boss = rank === 'BOSS', leader = boss || rank === 'ELITE';
  return { grade, areaCount, rank,
    hp: (1 + hpRate) ** areaCount * (leader && grade >= 11 ? 1.2 : 1) * (leader && grade >= 15 ? 1.2 : 1),
    atk: (1 + atkRate) ** areaCount * (boss && grade >= 5 ? 1.15 : 1) * (leader && grade >= 15 ? 1.2 : 1),
    def: (boss && grade >= 5 ? 1.15 : 1) * (leader && grade >= 15 ? 1.2 : 1),
    res: (grade >= 3 ? 10 : 0) + (grade >= 12 ? 10 : 0),
    move: grade >= 7 ? 1.15 : 1, aspd: grade >= 9 ? 15 : 0,
    elementalLoss: 1.15 ** [1, 8, 13].filter((threshold) => grade >= threshold).length,
    arrival: grade >= 18 && leader ? { duration: 20, atk: 1.3, phys: 0.5, arts: 0.5 } : null };
}

const INSTALLED = new WeakMap();
export function installMizukiDifficulty(battle, { grade = 0, areaCount = 1 } = {}) {
  if (INSTALLED.has(battle)) return INSTALLED.get(battle);
  const ordinary = mizukiDifficultyModifiers(grade, areaCount);
  const enemies = new WeakSet(), allies = new WeakSet();
  const applyAlly = (unit) => {
    if (unit?.side !== 'ally' || allies.has(unit)) return;
    allies.add(unit);
    if (ordinary.elementalLoss !== 1) battle.addBuff(unit, { key: 'mizuki:difficulty:element-loss',
      mods: { elemTakenMul: ordinary.elementalLoss }, duration: Infinity, persist: true, allowDead: true });
  };
  const applyEnemy = (enemy) => {
    if (!enemy || enemy.side !== 'enemy' || enemies.has(enemy)) return;
    enemies.add(enemy);
    const rank = enemy.def?.raw?.officialData?.levelType || enemy.def?.rank || (enemy.isBoss ? 'BOSS' : 'NORMAL');
    const mods = mizukiDifficultyModifiers(grade, areaCount, rank);
    // This is native preprocessing of the fresh unit's base, before in-battle
    // buffs. Its original definition/replay payload stays unmodified.
    enemy.base.maxHp *= mods.hp; enemy.base.atk *= mods.atk; enemy.base.def *= mods.def;
    enemy.base.res += mods.res; enemy.base.moveSpeed *= mods.move; enemy.base.aspd += mods.aspd;
    enemy.markDirty(); void enemy.s;
    if (mods.arrival) battle.addBuff(enemy, { key: 'mizuki:difficulty:arrival', duration: mods.arrival.duration,
      mods: { atkPct: mods.arrival.atk - 1, physTakenMul: mods.arrival.phys, artsTakenMul: mods.arrival.arts } });
  };
  battle.allyUnits.forEach(applyAlly); battle.enemies.forEach(applyEnemy);
  battle.on('deploy', ({ unit }) => applyAlly(unit), { priority: 20000 });
  battle.on('enemySpawn', ({ enemy }) => applyEnemy(enemy), { priority: 20000 });
  const controller = { grade, areaCount, applyEnemy, applyAlly, snapshot: () => ({ grade, areaCount,
    normal: ordinary, elite: mizukiDifficultyModifiers(grade, areaCount, 'ELITE'),
    boss: mizukiDifficultyModifiers(grade, areaCount, 'BOSS') }) };
  INSTALLED.set(battle, controller); return controller;
}
