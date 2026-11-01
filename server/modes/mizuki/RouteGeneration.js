// Native-schema RO2 regions with the original fixed regional/ending structure.
import { createRng, deriveSeed } from '../../sim/rng.js';
import { MIZUKI_ROUTE_GENERATOR } from './exploration.js';
import { MIZUKI_REGION_RULES, MIZUKI_ENDING_REGION_RULE, MIZUKI_PORTAL_REGION_RULE,
  MIZUKI_ENDING_ROUTE_RULES } from './OriginalRouteRules.js';
import { mizukiVariationForZone, mizukiVariationSpec, MIZUKI_VARIATION_POLICY } from './Variations.js';
export { MIZUKI_ROUTE_GENERATOR, MIZUKI_ROUTE_SOURCE_LABEL } from './exploration.js';

export const MIZUKI_ROUTE_PROFILE = Object.freeze({
  source: 'PRTS 水月肉鸽, 区域; original client stage, zone and node records',
  sourceUrl: 'https://prts.wiki/w/%E6%B0%B4%E6%9C%88%E8%82%89%E9%B8%BD', sourceRevision: 441598,
  verifiedDepths: Object.freeze(MIZUKI_REGION_RULES.map(rule => rule.depth)),
  verifiedEntryCounts: Object.freeze(MIZUKI_REGION_RULES.map(rule => rule.entries)),
  verifiedMaxBranches: Object.freeze(MIZUKI_REGION_RULES.map(rule => rule.maxBranches)),
  verifiedConstraints: Object.freeze([
    'Five ordinary regions; the second ending replaces the fifth-region boss.',
    'The third and fourth ending conditions open the same sixth region, 幽海丛林, with different bosses.',
    '幽海丛林 is merchant → safe corner → battle → boss, with one branch.',
    '绀碧摇篮 is an optional portal excursion, with 2 wishes → 2 battles → 2 battles → boss, then returns.',
    'Floor 2 and floor 4 end in wish nodes; the original source does not state their counts.',
  ]),
  inferredByThisMode: Object.freeze([
    'Unspecified ordinary middle-column widths, connection choices and category weights use a deterministic local policy.',
    'Official stage IDs are selected without replacement within each region when the pool permits.',
    MIZUKI_VARIATION_POLICY.selection,
  ]),
});
const BATTLE_TYPES = Object.freeze({ combat: 'BATTLE_NORMAL', elite: 'BATTLE_ELITE', boss: 'BATTLE_BOSS' });
const BASE_MID_BOSSES = new Set(['ro2_b_1', 'ro2_b_2', 'ro2_b_3']);
const nativeNode = (x, y, type, stage = null) => ({ pos: { x, y }, type, stage, next: [] });
const choose = (rng, values) => values[rng.int(values.length)];
const stageIdPattern = (kind, floor) => new RegExp(`^ro2_${kind}_${floor}_[0-9]+$`);
function playableStages(stageOptions) {
  if (!Array.isArray(stageOptions)) throw new TypeError('Playable Mizuki stage options are required');
  return stageOptions.filter(stage => stage.available === true && Object.hasOwn(BATTLE_TYPES, stage.type))
    .slice().sort((a, b) => a.stageId.localeCompare(b.stageId));
}
function chooseStage(rng, stages, used) {
  if (!stages.length) throw new RangeError('Original Mizuki region has no playable battle stage');
  const fresh = stages.filter(stage => !used.has(stage.stageId));
  const selected = choose(rng, fresh.length ? fresh : stages);
  used.add(selected.stageId); return selected.stageId;
}
function stagePools(playable, floors) {
  return Object.fromEntries([['combat', 'n'], ['elite', 'e']].map(([type, prefix]) => [type,
    playable.filter(stage => stage.type === type && floors.some(floor => stageIdPattern(prefix, floor).test(stage.stageId)))]));
}
function pickNode(rng, x, y, type, pools, bosses, used) {
  const combatType = Object.entries(BATTLE_TYPES).find(([, nativeType]) => type === nativeType)?.[0];
  return nativeNode(x, y, type, combatType ? chooseStage(rng, combatType === 'boss' ? bosses : pools[combatType], used) : null);
}
// Cover every node, then add monotone neighbouring branches. Equal-width
// columns can branch and rejoin instead of becoming isolated parallel rails.
function connectColumns(columns, rng) {
  for (let depth = 0; depth < columns.length - 1; depth++) {
    const from = columns[depth], to = columns[depth + 1], links = from.map(() => new Set());
    for (let i = 0; i < from.length; i++) {
      const start = Math.floor(i * to.length / from.length);
      const end = Math.max(start, Math.ceil((i + 1) * to.length / from.length) - 1);
      for (let j = start; j <= end; j++) links[i].add(j);
    }
    for (const i of rng.shuffle(Array.from({ length: from.length }, (_, index) => index))) {
      for (const direction of rng.shuffle([-1, 1])) {
        const target = direction < 0 ? Math.min(...links[i]) - 1 : Math.max(...links[i]) + 1;
        if (target < 0 || target >= to.length || !rng.chance(0.5)) continue;
        if (i > 0 && Math.max(...links[i - 1]) > target || i + 1 < from.length && Math.min(...links[i + 1]) < target) continue;
        links[i].add(target);
      }
    }
    from.forEach((node, i) => { node.next = [...links[i]].sort((a, b) => a - b)
      .map(target => ({ ...to[target].pos, hidden: 'SHOW', key: false })); });
  }
}
function middleTypes(floor, depth, cognition) {
  if (floor === 1 && depth === 1) return ['BATTLE_NORMAL', 'INCIDENT'];
  return ['BATTLE_NORMAL', 'BATTLE_NORMAL', 'BATTLE_NORMAL', 'BATTLE_ELITE',
    'INCIDENT', 'INCIDENT', 'REST', 'BATTLE_SHOP', 'EXPEDITION',
    'ENTERTAINMENT', 'UNKNOWN', 'SACRIFICE', 'MISSION', 'PORTAL'].filter(type => !cognition
      || !({ SACRIFICE: 'exchangeUnlocked', EXPEDITION: 'expeditionUnlocked', PORTAL: 'portalUnlocked' })[type]
      || cognition[({ SACRIFICE: 'exchangeUnlocked', EXPEDITION: 'expeditionUnlocked', PORTAL: 'portalUnlocked' })[type]] === true);
}
function generateOrdinaryRegion(rule, { seed, playable, cognition, uniqueNodes }) {
  const floor = Number(rule.id.split('_')[1]);
  const variation = mizukiVariationForZone(seed, rule.id), variationEffects = mizukiVariationSpec(variation).effects;
  const rng = createRng(deriveSeed(seed, MIZUKI_ROUTE_GENERATOR + ':' + rule.id));
  const pools = stagePools(playable, [floor]);
  const bosses = playable.filter(stage => floor === 3 ? BASE_MID_BOSSES.has(stage.stageId)
    : floor === 5 && stage.stageId === 'ro2_b_4');
  if (!pools.combat.length || !pools.elite.length || rule.terminalType === 'BATTLE_BOSS' && !bosses.length)
    throw new RangeError('Playable Mizuki route pool is missing for floor ' + floor);
  const used = new Set();
  const depthCount = rule.depth + (variationEffects.extraDepth || 0);
  const columns = Array.from({ length: depthCount }, (_, depth) => {
    const terminal = depth === depthCount - 1;
    const count = depth === 0 ? rule.entries : terminal && rule.terminalType !== 'WISH' ? 1
      : 1 + rng.int(rule.maxBranches);
    return Array.from({ length: count }, (_, y) => {
      let type = terminal ? rule.terminalType : depth === 0
        ? floor === 1 ? 'BATTLE_NORMAL' : choose(rng, ['BATTLE_NORMAL', 'INCIDENT'])
        : choose(rng, middleTypes(floor, depth, cognition));
      if (type === 'MISSION') {
        if (uniqueNodes.has(type)) type = 'INCIDENT';
        else uniqueNodes.add(type);
      }
      return pickNode(rng, depth, y, type, pools, bosses, used);
    });
  });
  connectColumns(columns, rng);
  return { id: rule.id, zoneType: 'NORMAL', variation, nodes: columns.flat() };
}
/** Five ordinary regions; ending progression opens the sixth region. */
export function generateMizukiDungeon({ seed = 1, stageOptions, cognition } = {}) {
  const playable = playableStages(stageOptions);
  const uniqueNodes = new Set();
  return { zones: Object.fromEntries(MIZUKI_REGION_RULES.map(rule => [rule.id,
    generateOrdinaryRegion(rule, { seed, playable, cognition, uniqueNodes })])) };
}
function fixedRegion(rule, { seed, playable, bossStageId, returnZoneKey = null }) {
  const variation = mizukiVariationForZone(seed, rule.id), variationEffects = mizukiVariationSpec(variation).effects;
  const rng = createRng(deriveSeed(seed, MIZUKI_ROUTE_GENERATOR + ':' + rule.id));
  const pools = stagePools(playable, rule.battleFloors || [6]);
  const bosses = playable.filter(stage => stage.type === 'boss' && (bossStageId
    ? stage.stageId === bossStageId : rule.stages.includes(stage.stageId)));
  const used = new Set();
  const types = [...rule.columns];
  if (variationEffects.extraDepth) types.splice(types.length - 1, 0, ...Array(variationEffects.extraDepth).fill('BATTLE_NORMAL'));
  const columns = types.map((type, x) => Array.from({ length: rule.widths?.[x] || 1 }, (_, y) =>
    pickNode(rng, x, y, type, pools, bosses, used)));
  connectColumns(columns, rng);
  return { id: rule.id, zoneType: returnZoneKey ? 'SP' : 'NORMAL', variation, nodes: columns.flat(),
    ...(returnZoneKey ? { returnZoneKey } : {}) };
}
/** Clone and apply the route derived from real ending event/battle history. */
export function applyMizukiEndingRoute(dungeon, route, { seed = 1, stageOptions } = {}) {
  if (!dungeon?.zones || !route || !['ro2_b_4', 'ro2_b_5'].includes(route.fifthBossStageId)
    || route.sixthBossStageId != null && !MIZUKI_ENDING_REGION_RULE.stages.includes(route.sixthBossStageId)
    || !Object.hasOwn(MIZUKI_ENDING_ROUTE_RULES, route.endingId)) throw new TypeError('Invalid original Mizuki ending route');
  const ending = MIZUKI_ENDING_ROUTE_RULES[route.endingId];
  if ((route.sixthBossStageId || route.fifthBossStageId) !== ending.stageId)
    throw new TypeError('Original Mizuki ending boss does not match its ending');
  const playable = playableStages(stageOptions);
  if (!playable.some(stage => stage.type === 'boss' && stage.stageId === route.fifthBossStageId))
    throw new RangeError('The original fifth-region boss is not playable');
  const result = structuredClone(dungeon);
  const fifth = Object.values(result.zones).find(zone => zone.id === 'zone_5' && zone.zoneType !== 'SP');
  if (!fifth || !Array.isArray(fifth.nodes)) throw new TypeError('Original fifth Mizuki region is missing');
  for (const node of fifth.nodes) if (node.type === 'BATTLE_BOSS') node.stage = route.fifthBossStageId;
  for (const [key, zone] of Object.entries(result.zones)) if (zone.id === 'zone_6') delete result.zones[key];
  if (route.sixthBossStageId) result.zones.zone_6 = fixedRegion(MIZUKI_ENDING_REGION_RULE,
    { seed, playable, bossStageId: route.sixthBossStageId });
  return result;
}
/** An optional portal excursion, never an automatic seventh floor. */
export function generateMizukiPortalZone({ seed = 1, stageOptions, returnZoneKey } = {}) {
  if (typeof returnZoneKey !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(returnZoneKey)
    || returnZoneKey === 'zone_7') throw new TypeError('An original Mizuki portal return region is required');
  return fixedRegion(MIZUKI_PORTAL_REGION_RULE, { seed, playable: playableStages(stageOptions), returnZoneKey });
}
