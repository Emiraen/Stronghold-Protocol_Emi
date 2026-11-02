import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const SOURCE = JSON.parse(readFileSync(new URL('../../../data/mizuki/route-event-source.json', import.meta.url), 'utf8'));
const topic = DATA.rawTopic;
const milestone = id => /^rogue_2_relic_(?:grace_(?:8[3-9]|90)|curse_(?:7|8|9|10))$/.test(id);
const bb = effect => Object.fromEntries((effect.blackboard || []).map(value => [value.key, value.valueStr ?? value.value]));
const clean = value => String(value || '').replace(/<[^>]*>/g, '');

// Cooperative-mode balance overrides; keep the extracted source records intact.
export const MIZUKI_COLLECTIBLE_BALANCE = Object.freeze({
  rogue_2_relic_fight_43: Object.freeze({ weight: 5, price: 10 }),
  rogue_2_relic_fight_44: Object.freeze({ weight: 5, price: 10 }),
});

export const mizukiCollectibleSpec = id => {
  const raw = topic.items[id], info = SOURCE.relics[id];
  return raw?.type === 'RELIC' ? { id, name: raw.name, description: clean(raw.usage || info?.description || raw.description), iconId: raw.iconId,
    rarity: info?.rarity ?? ({ NORMAL: 0, RARE: 1, SUPER_RARE: 2 }[raw.rarity] ?? 0),
    price: MIZUKI_COLLECTIBLE_BALANCE[id]?.price ?? info?.price ?? 0, number: info?.number ?? null, tradable: info?.tradable === true,
    stackable: info?.stackable === true, canSacrifice: raw.canSacrifice === true,
    buffs: structuredClone(topic.relics[id]?.buffs || []) } : null;
};

/** Event-only milestones and trophies never leak into the normal reward/shop pools. */
export function mizukiCollectiblePool({ owned = [], rarity, kind = 'normal', shop = false, highRoll = false, bankRecord = 0, cognition } = {}) {
  return Object.keys(topic.relics).filter(id => {
    const item = mizukiCollectibleSpec(id), raw = topic.items[id];
    if (!item || milestone(id) || !item.stackable && owned.includes(id)) return false;
    if (rarity !== undefined && item.rarity !== rarity) return false;
    if (shop && (!item.price || !highRoll && !item.tradable)) return false;
    if (id === 'rogue_2_relic_fight_121' && bankRecord < 325) return false;
    if (id === 'rogue_2_relic_grace_63' && cognition && !cognition.duckBrickUnlocked) return false;
    if (kind === 'curse') return raw.subType === 'CURSE' && !raw.unlockCondDesc;
    if (raw.subType === 'CURSE') return false;
    // canSacrifice only controls the exchange node. Most resource relics have
    // it disabled even though they remain normal battle/event rewards.
    if (!(item.price > 0)) return false;
    if (kind === 'fight') return id.includes('_fight_');
    if (kind === 'grace') return id.includes('_grace_');
    if (kind === 'king') return (topic.relics[id]?.buffs || []).some(effect => bb(effect).key === 'rogue_2_relic_mark[king_suit]');
    return true;
  });
}

export function drawMizukiCollectible({ rng, ids, ...options } = {}) {
  const pool = ids ? ids.filter(id => mizukiCollectibleSpec(id)
    && (id !== 'rogue_2_relic_grace_63' || !options.cognition || options.cognition.duckBrickUnlocked)
    && (id !== 'rogue_2_relic_fight_121' || options.bankRecord >= 325)
    && (mizukiCollectibleSpec(id).stackable || !(options.owned || []).includes(id))) : mizukiCollectiblePool(options);
  if (!pool.length) return null;
  const weight = id => MIZUKI_COLLECTIBLE_BALANCE[id]?.weight ?? 1;
  const total = pool.reduce((sum, id) => sum + weight(id), 0);
  let roll = rng() * total;
  for (const id of pool) if ((roll -= weight(id)) < 0) return id;
  return pool.at(-1);
}

/** Applied once, when the server commits ownership; persistent combat effects are separate. */
export function mizukiCollectibleImmediateRewards(id) {
  return (topic.relics[id]?.buffs || []).filter(effect => effect.key === 'immediate_reward')
    .map(effect => bb(effect)).map(value => ({ id: value.id, count: Math.trunc(value.count || 0) }))
    .filter(value => typeof value.id === 'string' && value.count > 0);
}

