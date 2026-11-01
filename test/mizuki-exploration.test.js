import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIZUKI_ORIGINAL_FLOORS, MIZUKI_ORIGINAL_NODE_TYPES, MIZUKI_ORIGINAL_ENDINGS, unavailableMizukiExploration,
  normalizeMizukiDungeon, createMizukiExplorationState, restoreMizukiExplorationState, mizukiExplorationView,
  mizukiExplorationChoices, completeMizukiExplorationNode } from '../server/modes/mizuki/exploration.js';

const original = JSON.parse(readFileSync(new URL('../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;

test('Mizuki exploration preserves all original floor node and ending presentation records', () => {
  assert.deepEqual(MIZUKI_ORIGINAL_FLOORS.map((floor) => floor.id), Object.keys(original.zones));
  for (const floor of MIZUKI_ORIGINAL_FLOORS) {
    assert.equal(floor.name, original.zones[floor.id].name);
    assert.equal(floor.backgroundId, original.zones[floor.id].backgroundId);
    assert.equal(floor.isHiddenZone, original.zones[floor.id].isHiddenZone);
  }
  assert.deepEqual(MIZUKI_ORIGINAL_NODE_TYPES.map((node) => [node.type, node.title]), Object.entries(original.nodeTypeData).map(([type, node]) => [type, node.name]));
  assert.deepEqual(MIZUKI_ORIGINAL_ENDINGS.map((ending) => ending.id), Object.keys(original.endings));
});

test('missing original dungeon is explicit and never replaced by stage cards or synthetic nodes', () => {
  const view = unavailableMizukiExploration();
  assert.equal(view.available, false);
  assert.equal(view.source.generatorAvailable, false);
  assert.equal(view.floor, null); assert.equal(view.currentNodeId, null);
  assert.deepEqual(view.nodes, []); assert.deepEqual(view.edges, []);
  view.floors[0].name = 'changed'; view.nodeTypes[0].title = 'changed';
  const fresh = unavailableMizukiExploration();
  assert.equal(fresh.floors[0].name, original.zones.zone_1.name);
  assert.equal(fresh.nodeTypes[0].title, original.nodeTypeData.BATTLE_NORMAL.name);
});

// Synthetic native-schema fixture exercises import; it is not an official layout.
const syntheticDungeon = () => ({ map: { zones: [{ id: 'zone_1', nodes: [
  [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [
    { x: 1, y: 0, hidden: 0 }, { x: 1, y: 1, hidden: 2 }, { x: 1, y: 2, hidden: 1 }, { x: 1, y: 3, key: true }] }],
  [{ pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
    { pos: { x: 1, y: 1 }, type: 'REST', next: [] },
    { pos: { x: 1, y: 2 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
    { pos: { x: 1, y: 3 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }],
] }] } });
const stages = [{ id: 'ro2_n_1_1', stageId: 'ro2_n_1_1', type: 'combat', title: '原版关卡', available: true }];

test('native SP regions do not advance ordinary floors and hidden ending zone 7 remains ordinary', () => {
  const zone = (id, zoneType) => ({ id, zoneType, nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] });
  const payload = { zones: [zone('zone_1', 'NORMAL'), zone('zone_2', 0), zone('zone_2', 'SP'),
    zone('zone_3', 'NORMAL'), zone('zone_4', 'NORMAL'), zone('zone_5', 'NORMAL'), zone('zone_7', 'NORMAL')] };
  const normalized = normalizeMizukiDungeon(payload);
  assert.deepEqual(normalized.floors.map((floor) => floor.ordinaryFloor), [1, 2, 2, 3, 4, 5, 6]);
  assert.equal(normalized.floors[2].isExtraRegion, true);
  assert.equal(normalized.floors.at(-1).isExtraRegion, false);
  assert.equal(normalized.dungeon.zones[1].zoneType, 'NORMAL');
  const state = createMizukiExplorationState(payload);
  const hidden = mizukiExplorationView({ ...state, zoneKey: '6' }, stages);
  assert.equal(hidden.floor.ordinaryFloor, 6);
  assert.equal(hidden.floor.zoneType, 'NORMAL');
  assert.equal(restoreMizukiExplorationState(state).dungeon.zones[2].zoneType, 'SP');
  const invalid = structuredClone(payload); invalid.zones[0].zoneType = 'invented';
  assert.throws(() => normalizeMizukiDungeon(invalid), /zone type/);
});

test('native dungeon import preserves coordinates explicit edges hidden types and floor identity', () => {
  const payload = syntheticDungeon();
  const normalized = normalizeMizukiDungeon(payload, { sourceLabel: 'synthetic test only' });
  assert.equal(normalized.floors[0].id, 'zone_1');
  assert.deepEqual(normalized.floors[0].nodes.map((node) => node.position), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }]);
  assert.deepEqual(normalized.floors[0].edges.map((edge) => [edge.hiddenType, edge.locked]), [['SHOW', false], ['APPEAR', false], ['HIDE', false], ['SHOW', true]]);
  payload.map.zones[0].nodes[0][0].next[0].x = 99;
  assert.equal(normalized.dungeon.zones[0].nodes[0].next[0].x, 1);
});

test('graph availability follows imported successors and never unlocks hidden keyed or noncombat nodes', () => {
  const state = createMizukiExplorationState(syntheticDungeon());
  assert.deepEqual(mizukiExplorationChoices(state, stages).map((node) => node.id), ['mzgraph:0:0:0']);
  const next = completeMizukiExplorationNode(state, 'mzgraph:0:0:0', stages);
  const view = mizukiExplorationView(next, stages);
  assert.equal(view.available, true); assert.equal(view.source.authenticity, 'caller_supplied');
  assert.equal(view.floor.backgroundId, original.zones.zone_1.backgroundId);
  assert.deepEqual(mizukiExplorationChoices(next, stages).map((node) => node.id), ['mzgraph:0:1:0', 'mzgraph:0:1:1']);
  assert.equal(view.nodes.find((node) => node.type === 'REST').available, true);
  assert.equal(view.nodes.find((node) => node.id === 'mzgraph:0:1:2').available, false);
  assert.equal(view.nodes.find((node) => node.id === 'mzgraph:0:1:3').available, false);
  assert.throws(() => completeMizukiExplorationNode(next, 'mzgraph:0:0:0', stages), /available successor/);
  assert.deepEqual(restoreMizukiExplorationState(next), next);
  const terminal = completeMizukiExplorationNode(next, 'mzgraph:0:1:0', stages);
  assert.deepEqual(mizukiExplorationChoices(terminal, stages), []);
  assert.equal(mizukiExplorationView(terminal, stages).floorTransitionAvailable, false);
});

test('invalid topology and tampered disconnected checkpoint traces are rejected', () => {
  const absent = syntheticDungeon(); absent.map.zones[0].nodes[0][0].next[0].x = 9;
  assert.throws(() => normalizeMizukiDungeon(absent), /absent node/);
  const duplicate = syntheticDungeon(); duplicate.map.zones[0].nodes[1][1].pos = { x: 0, y: 0 };
  assert.throws(() => normalizeMizukiDungeon(duplicate), /duplicate node/);
  const unknown = syntheticDungeon(); unknown.map.zones[0].id = 'invented';
  assert.throws(() => normalizeMizukiDungeon(unknown), /unknown original floor/);
  const numeric = syntheticDungeon(); numeric.map.zones[0].nodes[0][0].type = 1;
  assert.throws(() => normalizeMizukiDungeon(numeric), /symbolic original/);
  const state = createMizukiExplorationState(syntheticDungeon());
  assert.throws(() => restoreMizukiExplorationState({ ...state, cursor: 'mzgraph:0:1:2', trace: ['mzgraph:0:0:0', 'mzgraph:0:1:2'] }), /connected original path/);
});
