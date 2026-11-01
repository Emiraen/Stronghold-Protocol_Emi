// Client presentation records are not a dungeon-generation specification.
// Keep the battle archive distinct from a genuine original-server route graph.
import { readFileSync } from 'node:fs';
import { MIZUKI_VARIATION_IDS } from './Variations.js';
import { deriveSeed } from '../../sim/rng.js';

const official = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
export const MIZUKI_ROUTE_GENERATOR = 'stronghold_mizuki_route_v1';
export const MIZUKI_ROUTE_SOURCE_LABEL = '本模式服务端生成的路线';
const routeGenerator = (value) => {
  if (value === undefined || value === null) return null;
  if (value.id !== MIZUKI_ROUTE_GENERATOR || value.version !== 1 || !Number.isInteger(value.seed)
    || value.seed < 1 || value.seed > 0xffffffff) throw new TypeError('Invalid Mizuki route generator');
  return { id: value.id, version: 1, seed: value.seed };
};
const freezeRecords = (records) => Object.freeze(records.map((record) => Object.freeze(record)));

export const MIZUKI_EXPLORATION_SOURCE = Object.freeze({
  topicId: official.topic.id,
  presentation: 'data/mizuki/rogue2.json:rawTopic.zones,nodeTypeData,endings',
  nativeSchema: 'PlayerRoguelikeV2Dungeon.zones / PlayerRoguelikeV2Zone.nodes / PlayerRoguelikeNode.pos,next',
  generatorAvailable: false,
  originalGeneratorAvailable: false,
  missingRules: Object.freeze(['node_generation', 'zone_battle_pools']),
});

export const MIZUKI_ORIGINAL_FLOORS = freezeRecords(Object.values(official.rawTopic.zones).map((zone) => ({
  id: zone.id, name: zone.name, description: zone.description, backgroundId: zone.backgroundId,
  zoneIconId: zone.zoneIconId, isHiddenZone: zone.isHiddenZone,
  bgmSignal: zone.bgmSignal, bgmSignalWithLowSan: zone.bgmSignalWithLowSan,
})));

export const MIZUKI_ORIGINAL_NODE_TYPES = freezeRecords(Object.entries(official.rawTopic.nodeTypeData).map(([type, node]) => ({
  type, title: node.name, subtitle: node.subName, description: node.description,
})));

export const MIZUKI_ORIGINAL_ENDINGS = freezeRecords(Object.values(official.rawTopic.endings).map((ending) => ({
  id: ending.id, name: ending.name, priority: ending.priority, bossIconId: ending.bossIconId, backgroundId: ending.bgId,
})));

export function unavailableMizukiExploration() {
  return {
    version: 1, source: structuredClone(MIZUKI_EXPLORATION_SOURCE), available: false,
    unavailableReason: '客户端仅含原版楼层和节点表现资料，尚无原始服务端下发的路线节点图及其生成规则；关卡试玩列表不作为原版路线。',
    floor: null, currentNodeId: null, nodes: [], edges: [], votes: {},
    floors: structuredClone(MIZUKI_ORIGINAL_FLOORS),
    nodeTypes: structuredClone(MIZUKI_ORIGINAL_NODE_TYPES),
    endings: structuredClone(MIZUKI_ORIGINAL_ENDINGS),
  };
}

const floorById = new Map(MIZUKI_ORIGINAL_FLOORS.map((floor) => [floor.id, floor]));
const nodeByType = new Map(MIZUKI_ORIGINAL_NODE_TYPES.map((node) => [node.type, node]));
const battleTypes = Object.freeze({ BATTLE_NORMAL: 'combat', BATTLE_ELITE: 'elite', BATTLE_BOSS: 'boss' });
const supportedRouteNodeTypes = new Set(['REST', 'INCIDENT', 'EXPEDITION', 'WISH', 'BATTLE_SHOP',
  'ENTERTAINMENT', 'UNKNOWN', 'SACRIFICE', 'MISSION', 'PORTAL']);
const routeChoiceType = (type) => battleTypes[type] || (type === 'BATTLE_SHOP' ? 'shop'
  : supportedRouteNodeTypes.has(type) ? 'event' : null);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const coordinate = (value) => Number.isInteger(value) && value >= 0 && value <= 255;
const position = (value) => object(value) && coordinate(value.x) && coordinate(value.y);
const idOf = (zoneKey, pos) => `mzgraph:${zoneKey}:${pos.x}:${pos.y}`;
const hiddenType = (value) => ({ 0: 'SHOW', 1: 'HIDE', 2: 'APPEAR' })[value] || value;
const foresightType = (value) => ({ 0: 'NORMAL', 1: 'HIDE_INVISIBLE', 2: 'HIDE_BATTLE', 3: 'PRESAGE' }[value] || value || 'NORMAL');
const optionalBool = (value) => value === undefined || value === null || typeof value === 'boolean';
const nodeForesight = (value) => ['NORMAL', 'HIDE_INVISIBLE', 'HIDE_BATTLE', 'PRESAGE'].includes(foresightType(value))
  ? foresightType(value) : null;
const bad = (reason) => { throw new TypeError(`Invalid Mizuki dungeon: ${reason}`); };

function collectNodes(value, result = [], depth = 0) {
  if (depth > 5) bad('node containers are too deeply nested');
  if (object(value) && Object.hasOwn(value, 'pos')) { result.push(value); return result; }
  if (!object(value) && !Array.isArray(value)) bad('nodes must be a collection of native node records');
  for (const child of Object.values(value)) {
    if (child === null) continue;
    collectNodes(child, result, depth + 1);
    if (result.length > 512) bad('a zone exceeds 512 nodes');
  }
  return result;
}

// Accept the native PlayerRoguelikeV2Dungeon or CurrentData.map envelope.
// This imports topology, not official account inventory, progress or rewards.
export function normalizeMizukiDungeon(payload, { sourceLabel = '' } = {}) {
  if (!object(payload) || typeof sourceLabel !== 'string' || sourceLabel.length > 160) bad('invalid input or source label');
  const dungeon = object(payload.map) ? payload.map : payload;
  if (!object(dungeon.zones) && !Array.isArray(dungeon.zones)) bad('zones collection is missing');
  const entries = Object.entries(dungeon.zones);
  if (!entries.length || entries.length > 32) bad('zone count must be between 1 and 32');
  const zones = {}; const floors = [];
  let total = 0, ordinaryCount = 0;
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(key) || !object(raw) || !floorById.has(raw.id)) bad('unknown original floor');
    // PlayerRoguelikeV2Zone.zoneType / PlayerRoguelikeZoneType NORMAL, SP.
    // Hidden ending floors are ordinary regions; isHiddenZone is visual only.
    const zoneType = ({ 0: 'NORMAL', 1: 'SP' })[raw.zoneType] ?? raw.zoneType ?? 'NORMAL';
    if (!['NORMAL', 'SP'].includes(zoneType)) bad('invalid original zone type');
    const variation = raw.variation ?? null;
    if (variation !== null && !MIZUKI_VARIATION_IDS.includes(variation)) bad('invalid original zone variation');
    if (raw.returnZoneKey !== undefined && (raw.id !== 'zone_7' || zoneType !== 'SP'
      || typeof raw.returnZoneKey !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(raw.returnZoneKey)
      || raw.returnZoneKey === key)) bad('invalid portal return region');
    if (zoneType === 'NORMAL') ordinaryCount++;
    const natives = collectNodes(raw.nodes);
    if (!natives.length || (total += natives.length) > 1024) bad('empty zone or dungeon exceeds 1024 nodes');
    const nativeNodes = []; const ids = new Set();
    for (const node of natives) {
      if (!position(node.pos) || typeof node.type !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(node.type)) bad('symbolic original node type and integer position are required');
      const id = idOf(key, node.pos);
      if (ids.has(id)) bad('duplicate node position');
      ids.add(id);
      if (node.next !== null && node.next !== undefined && !Array.isArray(node.next)) bad('node.next must be a list');
      const next = node.next || [];
      if (next.length > 32) bad('node has too many outgoing edges');
      const seen = new Set();
      const links = next.map((line) => {
        if (!position(line) || !['SHOW', 'HIDE', 'APPEAR'].includes(hiddenType(line.hidden ?? 0))
          || (line.key !== undefined && typeof line.key !== 'boolean')) bad('invalid original edge');
        const target = idOf(key, line);
        if (target === id || seen.has(target)) bad('self or duplicate edge');
        seen.add(target);
        return { x: line.x, y: line.y, hidden: hiddenType(line.hidden ?? 0), key: line.key === true };
      });
      if (node.stage !== null && node.stage !== undefined && (typeof node.stage !== 'string' || node.stage.length > 128)) bad('invalid original stage ID');
      if (node.visibility !== null && node.visibility !== undefined && !['string', 'number'].includes(typeof node.visibility)) bad('invalid visibility');
      if (node.nodeDisplaySubType !== null && node.nodeDisplaySubType !== undefined && !Number.isInteger(node.nodeDisplaySubType)) bad('invalid node subtype');
      for (const key of ['canReach', 'isNextStep', 'isNextLocked', 'isDiscard', 'isFutureNode', 'isInTrace', 'isCurrent', 'isInDiffDisplayZone']) {
        if (!optionalBool(node[key])) bad(`invalid original ${key}`);
      }
      if (node.foresightType !== null && node.foresightType !== undefined && !nodeForesight(node.foresightType)) bad('invalid foresight type');
      nativeNodes.push({ pos: { x: node.pos.x, y: node.pos.y }, next: links, type: node.type, stage: node.stage || null,
        nodeDisplaySubType: node.nodeDisplaySubType ?? 0, visibility: node.visibility ?? null,
        canReach: node.canReach ?? null, isNextStep: node.isNextStep ?? null, isNextLocked: node.isNextLocked ?? null,
        isDiscard: node.isDiscard ?? null, isFutureNode: node.isFutureNode ?? null, isInTrace: node.isInTrace ?? null,
        isCurrent: node.isCurrent ?? null, isInDiffDisplayZone: node.isInDiffDisplayZone ?? null,
        foresightType: nodeForesight(node.foresightType) });
    }
    for (const node of nativeNodes) for (const line of node.next) if (!ids.has(idOf(key, line))) bad('edge references an absent node');
    const floor = { ...floorById.get(raw.id), key, index: floors.length, zoneType, variation,
      ordinaryFloor: ordinaryCount, isExtraRegion: zoneType === 'SP', returnZoneKey: raw.returnZoneKey || null,
      nodes: nativeNodes.map((node) => ({ id: idOf(key, node.pos), depth: node.pos.x, index: node.pos.y,
        position: { ...node.pos }, type: node.type, title: nodeByType.get(node.type)?.title || node.type,
        stageId: node.stage, nodeDisplaySubType: node.nodeDisplaySubType, visibility: node.visibility,
        canReach: node.canReach, isNextStep: node.isNextStep, isNextLocked: node.isNextLocked,
        isDiscard: node.isDiscard, isFutureNode: node.isFutureNode, isInTrace: node.isInTrace,
        isCurrent: node.isCurrent, isInDiffDisplayZone: node.isInDiffDisplayZone, foresightType: node.foresightType,
        next: node.next.map((line) => idOf(key, line)) })),
      edges: nativeNodes.flatMap((node) => node.next.map((line) => ({ from: idOf(key, node.pos), to: idOf(key, line),
        hidden: line.hidden !== 'SHOW', hiddenType: line.hidden, locked: line.key }))) };
    zones[key] = { id: raw.id, zoneType, ...(variation ? { variation } : {}), nodes: nativeNodes,
      ...(raw.returnZoneKey ? { returnZoneKey: raw.returnZoneKey } : {}) };
    floors.push(floor);
  }
  for (const zone of Object.values(zones)) if (zone.returnZoneKey && (!zones[zone.returnZoneKey]
    || zones[zone.returnZoneKey].zoneType !== 'NORMAL')) bad('portal returns to an absent ordinary region');
  for (const floor of floors) if (floor.isExtraRegion && floor.returnZoneKey)
    floor.ordinaryFloor = floors.find(origin => origin.key === floor.returnZoneKey).ordinaryFloor;
  return { version: 1, sourceLabel, dungeon: { zones }, floors };
}

export function createMizukiExplorationState(payload, options = {}) {
  const imported = normalizeMizukiDungeon(payload, options);
  const generator = routeGenerator(options.generator);
  return { version: 1, sourceLabel: imported.sourceLabel, dungeon: imported.dungeon,
    zoneKey: imported.floors[0].key, cursor: null, trace: [], ...(generator ? { generator } : {}) };
}

function floorForState(state) {
  return normalizeMizukiDungeon(state.dungeon, { sourceLabel: state.sourceLabel }).floors.find((floor) => floor.key === state.zoneKey);
}

export function restoreMizukiExplorationState(state) {
  if (!object(state) || state.version !== 1 || !Array.isArray(state.trace) || state.trace.length > 1024) bad('invalid exploration checkpoint');
  const imported = normalizeMizukiDungeon(state.dungeon, { sourceLabel: state.sourceLabel });
  const generator = routeGenerator(state.generator);
  const floor = imported.floors.find((entry) => entry.key === state.zoneKey);
  if (!floor || (state.cursor !== null && !floor.nodes.some((node) => node.id === state.cursor))) bad('invalid cursor');
  if (new Set(state.trace).size !== state.trace.length) bad('duplicate trace');
  for (let index = 0; index < state.trace.length; index++) {
    const node = floor.nodes.find((entry) => entry.id === state.trace[index]);
    if (!node || (index && !floor.edges.some((edge) => edge.from === state.trace[index - 1] && edge.to === node.id
      && edge.hiddenType !== 'HIDE' && !edge.locked))) bad('trace is not a connected original path');
    if (!index && floor.edges.some((edge) => edge.to === node.id)) bad('trace does not begin at an entry node');
  }
  if (state.cursor !== (state.trace.at(-1) ?? null)) bad('cursor does not match completed trace');
  let portalReturn;
  if (state.portalReturn !== undefined) {
    const origin = state.portalReturn;
    if (!object(origin) || Object.keys(origin).some(key => !['zoneKey', 'cursor', 'trace'].includes(key))
      || floor.id !== 'zone_7' || floor.zoneType !== 'SP' || floor.returnZoneKey !== origin.zoneKey)
      bad('invalid portal return checkpoint');
    const restoredOrigin = restoreMizukiExplorationState({ version: 1, sourceLabel: imported.sourceLabel,
      dungeon: imported.dungeon, zoneKey: origin.zoneKey, cursor: origin.cursor, trace: origin.trace,
      ...(generator ? { generator } : {}) });
    const originFloor = imported.floors.find(entry => entry.key === origin.zoneKey);
    if (originFloor?.nodes.find(node => node.id === origin.cursor)?.type !== 'PORTAL') bad('portal origin is not a completed portal');
    portalReturn = { zoneKey: restoredOrigin.zoneKey, cursor: restoredOrigin.cursor, trace: restoredOrigin.trace };
  }
  return { version: 1, sourceLabel: imported.sourceLabel, dungeon: imported.dungeon,
    zoneKey: state.zoneKey, cursor: state.cursor, trace: [...state.trace], ...(generator ? { generator } : {}),
    ...(portalReturn ? { portalReturn } : {}) };
}

/** Enter only after the party has resolved and completed its native portal. */
export function enterMizukiPortalExploration(state, zone) {
  const origin = restoreMizukiExplorationState(state), floor = floorForState(origin);
  if (origin.portalReturn || floor.zoneType !== 'NORMAL'
    || floor.nodes.find(node => node.id === origin.cursor)?.type !== 'PORTAL'
    || zone?.id !== 'zone_7' || zone.zoneType !== 'SP' || zone.returnZoneKey !== origin.zoneKey)
    bad('portal entry does not match its completed origin');
  const dungeon = structuredClone(origin.dungeon);
  const portalKey = 'portal_' + deriveSeed(1, origin.zoneKey + ':' + origin.cursor).toString(16);
  dungeon.zones[portalKey] = structuredClone(zone);
  return restoreMizukiExplorationState({ ...origin, dungeon, zoneKey: portalKey, cursor: null, trace: [],
    portalReturn: { zoneKey: origin.zoneKey, cursor: origin.cursor, trace: [...origin.trace] } });
}

/** Finishing 绀碧摇篮 resumes the source region immediately after the portal. */
export function leaveMizukiPortalExploration(state) {
  const current = restoreMizukiExplorationState(state), floor = floorForState(current);
  const boss = floor.nodes.find(node => node.id === current.cursor);
  if (!current.portalReturn || boss?.type !== 'BATTLE_BOSS' || boss.next.length) bad('portal region is not complete');
  const { portalReturn, ...rest } = current;
  return restoreMizukiExplorationState({ ...rest, ...portalReturn });
}

export function mizukiExplorationView(state, stageOptions, { votes = {}, currentNodeId = null } = {}) {
  if (!state) return unavailableMizukiExploration();
  const floor = floorForState(state);
  if (!floor) bad('current floor is absent');
  const completed = new Set(state.trace);
  // Hidden links must never turn their destinations into extra entry nodes.
  // APPEAR activation remains scoped to the completed source of this import.
  const activeEdges = floor.edges.filter((edge) => edge.hiddenType === 'SHOW'
    || edge.hiddenType === 'APPEAR' && completed.has(edge.from));
  const next = state.cursor === null
    ? new Set(floor.nodes.filter((node) => !floor.edges.some((edge) => edge.to === node.id)).map((node) => node.id))
    : new Set(activeEdges.filter((edge) => edge.from === state.cursor && !edge.locked).map((edge) => edge.to));
  const reachable = new Set(next); const queue = [...next];
  while (queue.length) {
    const from = queue.shift();
    // Not-yet-drawn APPEAR links still belong to the future topology.
    for (const edge of floor.edges.filter((edge) => edge.from === from && edge.hiddenType !== 'HIDE')) {
      if (!reachable.has(edge.to)) { reachable.add(edge.to); queue.push(edge.to); }
    }
  }
  const generator = routeGenerator(state.generator);
  const generated = !!generator;
  const stages = new Map(stageOptions.map((stage) => [stage.stageId, stage]));
  const currentDepth = floor.nodes.find((entry) => entry.id === state.cursor)?.depth ?? -1;
  return { ...unavailableMizukiExploration(), available: true, unavailableReason: null,
    source: { ...structuredClone(MIZUKI_EXPLORATION_SOURCE),
      topology: generated ? 'mode_server_generated' : 'imported_native_schema',
      authenticity: generated ? 'mode_generated' : 'caller_supplied',
      label: state.sourceLabel || (generated ? MIZUKI_ROUTE_SOURCE_LABEL : '手动导入的原始结构数据'),
      progression: generated ? 'mode_generated_topology_official_battles' : 'imported_topology_without_event_or_floor_reward_emulation',
      ...(generated ? { generatorAvailable: true, originalGeneratorAvailable: false, generator } : {}) },
    floor: { index: floor.index, key: floor.key, id: floor.id, name: floor.name,
      backgroundId: floor.backgroundId, isHiddenZone: floor.isHiddenZone,
      description: floor.description || '', zoneIconId: floor.zoneIconId || null,
      zoneType: floor.zoneType, ordinaryFloor: floor.ordinaryFloor, isExtraRegion: floor.isExtraRegion,
      returnZoneKey: floor.returnZoneKey },
    currentNodeId: currentNodeId || state.cursor, votes: { ...votes },
    edges: activeEdges.map((edge) => ({ ...edge, locked: !!edge.locked })),
    nodes: floor.nodes.map((node) => {
      const stage = stages.get(node.stageId); const combatType = battleTypes[node.type];
      const incoming = floor.edges.filter((edge) => edge.to === node.id);
      // Native view-model flags describe an imported snapshot, not subsequent
      // local turns. Recompute them from this party's own completed trace.
      const nextStep = next.has(node.id);
      const candidateEdges = state.cursor === null ? [] : incoming.filter((edge) => edge.from === state.cursor && edge.hiddenType !== 'HIDE');
      const nextLocked = !nextStep && candidateEdges.length > 0 && candidateEdges.every((edge) => edge.locked);
      const future = node.depth > currentDepth;
      const discarded = state.cursor !== null && !completed.has(node.id) && !reachable.has(node.id);
      const foresight = node.foresightType || 'NORMAL';
      const visibility = typeof node.visibility === 'string' ? node.visibility.toUpperCase() : null;
      const hiddenByVisibility = visibility === 'HIDE' || visibility === 'HIDDEN'
        || visibility === 'APPEAR' && !nextStep && !completed.has(node.id);
      const variationHidden = floor.variation === 'rogue_2_variation_8' && !nextStep && !completed.has(node.id);
      const unknown = node.type === 'UNKNOWN' || hiddenByVisibility || variationHidden || foresight === 'HIDE_INVISIBLE'
        || foresight === 'HIDE_BATTLE' && !!combatType;
      const supportedRouteType = !!routeChoiceType(node.type);
      const disabledReason = !combatType && !supportedRouteType ? '该原生节点类型尚未接入'
        : combatType && !stage ? '该原版关卡不在当前关卡档案中'
          : combatType && !stage.available ? stage.unavailableReason || '该关卡机制尚未接入'
            : combatType && stage.type !== combatType ? '节点类型与原版关卡记录不一致'
              : null;
      // Official future/discard flags affect presentation; they do not by
      // themselves erase a normal node's visible category. Battle details
      // remain private until the party actually enters or completes the node.
      // The stage name is visible when this battle becomes a selectable stop.
      const revealed = !unknown;
      const detailsRevealed = node.id === currentNodeId || completed.has(node.id);
      const available = nextStep && !completed.has(node.id) && !discarded && !nextLocked && !disabledReason;
      const stageName = revealed && (available || detailsRevealed) && stage ? stage.title || stage.name || null : null;
      return { id: node.id, depth: node.depth, index: node.index, position: { ...node.position },
        type: revealed ? node.type : 'UNKNOWN', title: revealed ? node.title : '迷雾重重',
        description: revealed ? nodeByType.get(node.type)?.description || '' : '',
        stageId: detailsRevealed ? node.stageId : null,
        stageName,
        nodeDisplaySubType: revealed ? node.nodeDisplaySubType : 0,
        foresightType: foresight, current: node.id === (currentNodeId || state.cursor),
        completed: completed.has(node.id), discarded, future, nextStep, locked: nextLocked,
        revealed, detailsRevealed, available,
        disabledReason: !available && disabledReason ? '该节点暂不可进入' : null,
        chosenBy: Object.keys(votes).filter((playerId) => votes[playerId] === node.id) };
    }),
    floorTransitionAvailable: generated,
    floorTransitionReason: generated ? '当前层终点完成后，队伍会合并自动进入下一层；最后一层首领完成后结算本模式路线。'
      : '层间结算、后续楼层生成和结局条件仍需原始服务端规则，不自动补造。',
  };
}

export function mizukiExplorationChoices(state, stageOptions) {
  const floor = floorForState(state), view = mizukiExplorationView(state, stageOptions);
  return view.nodes.filter((node) => node.available).map((node) => {
    const native = floor.nodes.find((entry) => entry.id === node.id);
    const stage = stageOptions.find((entry) => entry.stageId === native?.stageId);
    const type = routeChoiceType(native.type);
    const nativeInfo = nodeByType.get(native.type);
    return { ...(stage ? structuredClone(stage) : { type, title: nativeInfo?.title || node.title,
      description: nativeInfo?.description || '', available: true }), id: node.id, graphNodeId: node.id,
      graphType: native?.type, depth: node.depth, index: node.index, position: node.position, floorKey: state.zoneKey,
      revealed: node.revealed, detailsRevealed: node.detailsRevealed, nodeDisplaySubType: node.nodeDisplaySubType,
      stageName: node.stageName,
      foresightType: native?.foresightType || 'NORMAL' };
  });
}

/** Public route projection. Keep stage resolution internal until entry,
 * independently of a node category being visible on the route. */
export function mizukiRouteChoiceView(choice) {
  if (!choice) return null;
  const revealed = choice.revealed !== false;
  const detailsRevealed = choice.detailsRevealed === true;
  // Explicit allowlist: spreading a full stage record would leak its map,
  // description, render assets, enemy details, BGM and media into route votes.
  const out = { id: choice.id, graphNodeId: choice.graphNodeId || choice.id,
    depth: choice.depth, index: choice.index, position: structuredClone(choice.position), floorKey: choice.floorKey,
    revealed, detailsRevealed, available: choice.available !== false,
    graphType: revealed ? choice.graphType : 'UNKNOWN',
    type: revealed ? choice.type : 'unknown',
    title: revealed ? nodeByType.get(choice.graphType)?.title || '节点' : '迷雾重重',
    stageName: revealed && (detailsRevealed || choice.available !== false) ? choice.stageName || choice.title || null : null,
    stageId: null, nodeDisplaySubType: revealed ? choice.nodeDisplaySubType ?? 0 : 0,
    foresightType: choice.foresightType || 'NORMAL' };
  if (detailsRevealed) {
    for (const key of ['stageId', 'title', 'description', 'code', 'renderAsset', 'map', 'bgm', 'media',
      'mapPreview', 'preview', 'levelId', 'available', 'unavailableReason']) {
      if (Object.hasOwn(choice, key)) out[key] = structuredClone(choice[key]);
    }
    out.graphType = choice.graphType; out.type = choice.type; out.revealed = true;
    out.stageName = choice.stageName || choice.title || null;
  }
  return out;
}

export function completeMizukiExplorationNode(state, id, stageOptions) {
  if (!mizukiExplorationChoices(state, stageOptions).some((node) => node.id === id)) bad('completed node is not an available successor');
  return { ...structuredClone(state), cursor: id, trace: [...state.trace, id] };
}
