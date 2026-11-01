import { readFileSync } from 'node:fs';
import { createRng, deriveSeed } from '../../sim/rng.js';

const TOPIC = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
export const MIZUKI_VARIATION_IDS = Object.freeze(Object.keys(TOPIC.variationData).sort());
export const MIZUKI_VARIATION_POLICY = Object.freeze({
  selection: 'Seeded equal-weight selection, one variation per generated region; original server assignment weights are unavailable.',
  repeat: 'Selection is independent per region.',
});

const VARIATIONS = Object.freeze({
  rogue_2_variation_1: Object.freeze({ extraDepth: 2, lightLossMultiplier: 2 }),
  rogue_2_variation_2: Object.freeze({ attackSpeed: 50, healingMultiplier: 0.3, excludesLeaders: true }),
  rogue_2_variation_3: Object.freeze({ nonBattleGold: 3, loseFloorGold: true }),
  rogue_2_variation_4: Object.freeze({ battleGoldMultiplier: 2, battleEntryLifeLoss: 1 }),
  rogue_2_variation_5: Object.freeze({ recruitTicketChance: 0.3, enemyResist: 15 }),
  rogue_2_variation_6: Object.freeze({ commanderExpMultiplier: 1.5, enemyDefenseMultiplier: 1.5 }),
  rogue_2_variation_7: Object.freeze({ battleMaxLife: 1, lifeLossMultiplier: 2 }),
  rogue_2_variation_8: Object.freeze({ firstWishCollectible: true, revealOnlyNext: true }),
});

export function mizukiVariationSpec(id) {
  if (id == null) return null;
  const effects = VARIATIONS[id];
  const source = TOPIC.variationData[id];
  return effects && source ? { id, name: source.outerName, description: source.functionDesc, type: source.type,
    effects: { ...effects } } : null;
}

export function mizukiVariationForZone(seed, zoneId) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff || typeof zoneId !== 'string' || !zoneId) {
    throw new TypeError('A valid Mizuki seed and zone ID are required');
  }
  const rng = createRng(deriveSeed(seed, 'mizuki:variation:' + zoneId));
  return MIZUKI_VARIATION_IDS[rng.int(MIZUKI_VARIATION_IDS.length)];
}

const INSTALLED = new WeakMap();

export function installMizukiVariation(battle, id) {
  if (INSTALLED.has(battle)) return INSTALLED.get(battle);
  const spec = mizukiVariationSpec(id), effects = spec?.effects || {};
  if (effects.attackSpeed || effects.enemyResist || effects.enemyDefenseMultiplier) {
    const applied = new WeakSet();
    const add = (unit) => {
      if (!unit || applied.has(unit)) return;
      const enemy = unit.side === 'enemy';
      if (!enemy && unit.side !== 'ally' || enemy && effects.excludesLeaders && (unit.isBoss || unit.def?.rank === 'BOSS')) return;
      const mods = {};
      if (effects.attackSpeed) mods.aspd = effects.attackSpeed;
      if (enemy && effects.enemyResist) mods.resFlat = effects.enemyResist;
      if (enemy && effects.enemyDefenseMultiplier) mods.defMul = effects.enemyDefenseMultiplier;
      if (!Object.keys(mods).length) return;
      battle.addBuff(unit, { key: 'mizuki:variation:' + id, duration: Infinity, persist: true, allowDead: true, mods });
      applied.add(unit);
    };
    battle.allyUnits.forEach(add); battle.enemies.forEach(add);
    battle.on('deploy', ({ unit }) => add(unit), { priority: 19000 });
    battle.on('enemySpawn', ({ enemy }) => add(enemy), { priority: 19000 });
  }
  if (effects.healingMultiplier != null) {
    const heal = battle.heal.bind(battle);
    battle.heal = (source, target, amount, options = {}) => heal(source, target,
      target?.side === 'ally' ? amount * effects.healingMultiplier : amount, options);
  }
  const controller = { id: spec?.id || null, effects: { ...effects }, snapshot: () => ({ id: spec?.id || null, effects: { ...effects } }) };
  INSTALLED.set(battle, controller);
  return controller;
}
