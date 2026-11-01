// RO2 account progression. Existing squad cards resolve to a native tier; no
// additional selection controls or game text are introduced.
import { readFileSync } from 'node:fs';
import { MIZUKI_SQUADS, MIZUKI_SQUAD_TIERS } from '../../../shared/mizuki-squads.js';
const DATA = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const nodes = Object.values(DATA.customizeData.developments);
const nodeIds = new Set(nodes.map(node => node.buffId));
const needAllParents = DATA.rawTopic.detailConst.needAllFrontNode;
const gradeFactors = new Map(DATA.rawTopic.difficulties.filter(row => row.modeDifficulty === 'NORMAL')
  .map(row => [row.grade, row.scoreFactor]));
const FLOOR_SCORES = Object.freeze([0, 30, 80, 150, 270, 400, 550, 650]);
export const MIZUKI_COGNITION_SCORE_PER_TOKEN = 200;
export const MIZUKI_COGNITION_MAX_TOKENS = nodes.reduce((sum, node) => sum + node.tokenCost, 0);
export const MIZUKI_COGNITION_MAX_SCORE = MIZUKI_COGNITION_MAX_TOKENS * MIZUKI_COGNITION_SCORE_PER_TOKEN;
export const MIZUKI_COGNITION_SOURCE = Object.freeze({
  nodes: 'data/mizuki/rogue2.json:customizeData.developments',
  prerequisites: 'rawTopic.detailConst.needAllFrontNode',
  score: '.cache/mizuki-final-fixes-20261028/route-source-prts-main-text.txt:4622-4680',
  tokens: '.cache/mizuki-final-fixes-20261028/route-source-prts-main-text.txt:1154-1158',
  adaptation: 'Automatic purchase in original node order with original prerequisites and token costs.',
});
if (nodes.length !== 58 || MIZUKI_COGNITION_MAX_TOKENS !== 112
  || nodes.some(node => !Number.isSafeInteger(node.tokenCost) || node.tokenCost < 0
    || !Array.isArray(node.frontNodeId) || node.frontNodeId.some(id => !nodeIds.has(id))))
  throw new TypeError('Original Mizuki cognitive shaping records are incomplete');

/** Rebuild derived fields from authoritative score, preventing injected nodes
 * or token balances from surviving a profile load. */
export function normalizeCognition(value) {
  const totalScore = Number.isSafeInteger(value?.totalScore) && value.totalScore >= 0
    ? Math.min(value.totalScore, MIZUKI_COGNITION_MAX_SCORE) : 0;
  const earnedTokens = Math.floor(totalScore / MIZUKI_COGNITION_SCORE_PER_TOKEN);
  const unlocked = new Set();
  let tokens = 0;
  // Replay token arrivals, not one lump budget: otherwise an earlier expensive
  // node could replace a cheaper already-unlocked branch after a larger score.
  for (let earned = 0; earned < earnedTokens; earned++) {
    tokens++;
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (unlocked.has(node.buffId) || tokens < node.tokenCost) continue;
        const parents = node.frontNodeId;
        if (parents.length && !(needAllParents ? parents.every(id => unlocked.has(id)) : parents.some(id => unlocked.has(id)))) continue;
        unlocked.add(node.buffId); tokens -= node.tokenCost; changed = true;
      }
    }
  }
  return { version: 1, totalScore, scoreRemainder: totalScore % MIZUKI_COGNITION_SCORE_PER_TOKEN,
    earnedTokens, spentTokens: earnedTokens - tokens, tokens,
    unlockedNodeIds: nodes.filter(node => unlocked.has(node.buffId)).map(node => node.buffId) };
}
export function advanceCognition(score, previous) {
  if (!Number.isSafeInteger(score) || score < 0) throw new TypeError('Invalid Mizuki exploration score');
  const state = normalizeCognition(previous);
  return normalizeCognition({ totalScore: state.totalScore + Math.min(score, MIZUKI_COGNITION_MAX_SCORE - state.totalScore) });
}

/** Explicit consumers for all numeric and raw-text native nodes. Full original
 * node records remain available for traceability, with no mutation of data. */
export function cognitionEffects(cognition) {
  const normalized = normalizeCognition(cognition), owned = new Set(normalized.unlockedNodeIds), sums = {};
  const rawNodes = nodes.filter(node => owned.has(node.buffId));
  for (const node of rawNodes) for (const display of node.buffDisplayInfo || [])
    sums[display.displayType] = (sums[display.displayType] || 0) + display.displayNum;
  const has = number => owned.has('rogue_2_outbuff_' + number);
  const tier = numbers => numbers.reduce((level, number, index) => has(number) ? index + 1 : level, 0);
  return { atkPct: (sums.display_bat_attack || 0) / 100, defPct: (sums.display_bat_def || 0) / 100,
    hpPct: (sums.display_bat_max_hp || 0) / 100, initialGold: sums.display_gold || 0,
    initialMaxLife: sums.display_hp || 0, initialDice: sums.display_dice_point || 0, initialKey: sums.display_key_point || 0,
    squadCapacity: sums.display_squad_capacity || 0, deployLimit: sums.display_bat_char_limit || 0,
    commanderExpMultiplier: 1 + (sums.display_exp || 0) / 100, livingCellMultiplier: 1 + (sums.display_grow_point || 0) / 100,
    driftingCacheUnlocked: has(2), exchangeUnlocked: has(3), expeditionUnlocked: has(4), portalUnlocked: has(5), duckBrickUnlocked: has(44),
    perfectShieldLifeThreshold: has(27) ? 8 : has(25) ? 10 : null, sanRerollEnabled: has(36), wishRerollEnabled: has(45),
    shopDiscount: has(54) ? 0.4 : has(12) ? 0.6 : has(9) ? 0.8 : null,
    squadLevels: { rogue_2_band_11: tier([30, 35, 52]), rogue_2_band_15: tier([41, 46, 51]), rogue_2_band_19: tier([8, 16, 50]) },
    unlockedNodeIds: [...normalized.unlockedNodeIds], rawNodes: structuredClone(rawNodes) };
}
export function resolvedSquad(baseId, cognition) {
  if (!MIZUKI_SQUADS.some(squad => squad.id === baseId)) return null;
  const level = cognitionEffects(cognition).squadLevels[baseId] || 0;
  const squad = MIZUKI_SQUAD_TIERS.find(candidate => candidate.level === level
    && (DATA.rawTopic.bandRef[candidate.id]?.normalBandId || candidate.id) === baseId);
  return squad ? structuredClone(squad) : null;
}

/** Scores derive from committed events, including collected items subsequently
 * traded away. Living Cell conversion bonuses never affect this score. */
export function mizukiExplorationScoreBreakdown(counters = {}, grade = 0) {
  if (!counters || typeof counters !== 'object' || Array.isArray(counters) || !gradeFactors.has(grade))
    throw new TypeError('Invalid Mizuki exploration score context');
  const values = {};
  for (const key of ['floorsPassed', 'stepsPassed', 'normalBattles', 'eliteBattles', 'bossBattles', 'recruits', 'itemsGained']) {
    const value = counters[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Mizuki exploration score counter');
    values[key] = value;
  }
  if (values.floorsPassed >= FLOOR_SCORES.length) throw new TypeError('Invalid Mizuki cleared floor count');
  const points = { floorsPassed: FLOOR_SCORES[values.floorsPassed], stepsPassed: values.stepsPassed,
    normalBattles: values.normalBattles * 10, eliteBattles: values.eliteBattles * 20,
    bossBattles: values.bossBattles * 30, recruits: values.recruits * 2, itemsGained: values.itemsGained * 5 };
  const base = Object.values(points).reduce((sum, value) => sum + value, 0);
  const factor = gradeFactors.get(grade), score = Math.floor(base * factor);
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(score)) throw new TypeError('Mizuki exploration score overflow');
  return { counters: values, points, base, factor, total: score };
}

export function mizukiExplorationScore(counters = {}, grade = 0) {
  return mizukiExplorationScoreBreakdown(counters, grade).total;
}
