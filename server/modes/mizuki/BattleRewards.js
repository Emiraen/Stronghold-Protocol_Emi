import { readFileSync } from 'node:fs';

const topic = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
const bb = effect => Object.fromEntries((effect.blackboard || []).map(entry => [entry.key, entry.valueStr ?? entry.value]));

// PRTS 水月与深蓝之树: 作战指挥经验值及源石锭数量 (base values,
// before cognition/relic multipliers). The cached source is kept with the audit.
const REGIONS = Object.freeze({
  1: { combat: [10, 2], elite: [12, 3] },
  2: { combat: [12, 2], elite: [18, 3] },
  3: { combat: [14, 2], elite: [24, 4], boss: [32, 5] },
  4: { combat: [16, 3], elite: [30, 4] },
  5: { combat: [20, 3], elite: [36, 5], boss: [50, 7] },
  6: { combat: [20, 3], elite: [36, 5], boss: [0, 0] },
  7: { combat: [20, 3], elite: [36, 5], boss: [50, 6] },
});
const SPECIAL = Object.freeze({ ro2_t_1: [3, 1], ro2_t_2: [5, 2], ro2_t_3: [7, 3], ro2_t_4: [9, 4], ro2_t_5: [15, 6],
  ro2_ev_1: [20, 7], ro2_ev_2: [14, 3], ro2_ev_3: [16, 3], ro2_ev_4: [14, 1], ro2_ev_5: [20, 1] });
const GRAPH_BATTLE_TYPES = Object.freeze({ BATTLE_NORMAL: 'combat', BATTLE_ELITE: 'elite', BATTLE_BOSS: 'boss' });
const battleType = node => GRAPH_BATTLE_TYPES[node?.graphType] || node?.type;

/** Original battle logs count destroyed field treasure, never unopened boxes.
 * PRTS and the original facility skills specify 2 / 4 / 10 ingots. The
 * rarebox is a spiked money chest, not a collectible chest. */
export function mizukiBattleFieldDrops(results = []) {
  return results.reduce((drops, result) => {
    const logs = result?.officialFacilities?.logs || {};
    const count = key => Math.max(0, Math.trunc(Number(logs[key]) || 0));
    drops.gold += count('trap_065_normbox') * 2 + count('trap_066_rarebox') * 4 + count('trap_068_badbox') * 10;
    drops.bonusRelics += count('bonusCollectible');
    return drops;
  }, { gold: 0, bonusRelics: 0 });
}

export function mizukiBattleBaseReward({ node, floor = 1, extraRegion = false } = {}) {
  const stageId = node?.eventBattleStageId || node?.stageId || '';
  let values = SPECIAL[stageId];
  if (!values && node?.eventBattleStageId && /^ro2_e_1_[1-4]$/.test(stageId)) values = [12, 3];
  if (!values && /^ro2_b_[1-3]_b$/.test(stageId)) values = [36, 6];
  if (!values) values = REGIONS[extraRegion ? 7 : floor]?.[battleType(node)] || [0, 0];
  return { exp: values[0], gold: values[1], source: 'https://prts.wiki/w/水月与深蓝之树#指挥等级' };
}

/** N16+ feature drops use the installed table's rate, node and unique group. */
export function mizukiBattleNativeDrops({ node, floor = 1, extraRegion = false, grade = 0, rng } = {}) {
  if (grade < 16) return [];
  const nativeType = node?.graphType || { combat: 'BATTLE_NORMAL', elite: 'BATTLE_ELITE', boss: 'BATTLE_BOSS' }[node?.type];
  const source = topic.relics['rogue_2_feature_pill_' + (extraRegion ? 7 : floor)];
  const seen = new Set(), rewards = [];
  for (const effect of source?.buffs || []) {
    const values = bb(effect);
    if (effect.key !== 'battle_extra_drop' || !String(values.node).split(',').includes(nativeType) || seen.has(values.uniq_id)) continue;
    seen.add(values.uniq_id);
    if (values.rate > 0 && rng() < values.rate) rewards.push({ id: values.id, count: Math.max(1, Math.trunc(values.count || 1)) });
  }
  return rewards;
}

// The original server's hidden relic-pool weights are absent from client data.
// These explicit cooperative-mode probabilities keep those drops functional;
// named relics, rarity, effects and extra-choice rules still use original data.
export const MIZUKI_BATTLE_LOOT_POLICY = Object.freeze({
  normalRelicChance: 0.15, eliteRelicChance: 1, bossRelicChance: 1,
  driftingCache: Object.freeze({ combat: .05, elite: .15, boss: .2 }),
  deepsea_1: 0.25, deepsea_2: 0.4,
  source: 'Cooperative-mode probabilities; original hidden server drop weights are not published.',
});

/** Cache existence is a native cognition unlock. Its hidden server drop
 * weights are not present in client tables; use the explicit cooperative
 * loot policy, as for the existing normal relic drops above. */
export function mizukiBattleDriftingCacheDrop({ node, cognition, rng } = {}) {
  if (!cognition?.driftingCacheUnlocked) return null;
  const type = node?.eventBattleStageId ? 'elite' : battleType(node);
  const chance = MIZUKI_BATTLE_LOOT_POLICY.driftingCache[type] || 0;
  return chance && rng() < chance ? { id: 'rogue_2_treasure', count: 1 } : null;
}

export function mizukiBattleRelicDrops({ node, squadEffects = [], rng } = {}) {
  const chance = battleType(node) === 'boss' ? MIZUKI_BATTLE_LOOT_POLICY.bossRelicChance
    : battleType(node) === 'elite' || node?.eventBattleStageId ? MIZUKI_BATTLE_LOOT_POLICY.eliteRelicChance
      : MIZUKI_BATTLE_LOOT_POLICY.normalRelicChance;
  let count = rng() < chance ? 1 : 0;
  for (const effect of squadEffects) if (effect.key === 'drop_extra_pool') {
    const rate = MIZUKI_BATTLE_LOOT_POLICY[bb(effect).id];
    if (rate && rng() < rate) count++;
  }
  return count;
}
