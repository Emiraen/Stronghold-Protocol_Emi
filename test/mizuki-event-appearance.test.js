import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMizukiRouteEvent } from '../server/modes/mizuki/RouteEvents.js';
import { createMizukiEndingProgress, recordMizukiEndingChoice, mizukiEndingUnlocksAfter } from '../server/modes/mizuki/EndingProgression.js';
import { applyMizukiEndingRoute } from '../server/modes/mizuki/RouteGeneration.js';

const SOURCE = JSON.parse(readFileSync(new URL('../data/mizuki/route-event-source.json', import.meta.url), 'utf8'));
const ALL = ['ro2_ending_1', 'ro2_ending_2', 'ro2_ending_3', 'ro2_ending_4'];
const ordinal = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const base = { seed: 1, floor: 1, light: 100, dice: 5, key: 5, endingUnlocks: ALL, collectibles: [],
  endingProgress: createMizukiEndingProgress(), players: [{ playerId: 'p0', life: 20, maxLife: 20, gold: 20, hope: 10, hopeCapacity: 10, roster: [] }] };
function sample(context, graphType = 'INCIDENT', count = 640) {
  const seen = new Set();
  for (let seed = 1; seed <= count; seed++) {
    const event = createMizukiRouteEvent({ id: 'appearance:' + seed, graphType }, { ...base, ...context, seed });
    seen.add(Number(event.state.eventKey.split('_').at(-1)));
    const definition = SOURCE.events.find(value => value.id === event.state.eventKey);
    assert.ok(!definition.floors[0] || definition.floors.includes(ordinal[context.floor || 1]), 'event ' + event.state.eventKey + ' cannot spawn on floor ' + context.floor);
  }
  return seen;
}
function history(choiceId, relicId, floor = 1, previous = base) {
  const collectibles = [...previous.collectibles, relicId];
  return { ...previous, collectibles, endingProgress: recordMizukiEndingChoice(previous.endingProgress,
    { choiceId, relicId, nodeId: 'prior:' + choiceId, floor, light: previous.light,
      collectiblesBefore: previous.collectibles, collectibles, endingUnlocks: previous.endingUnlocks }) };
}

for (const type of ['INCIDENT', 'UNKNOWN']) for (const floor of [1, 2, 3, 4, 5]) test(type + ' floor ' + floor + ' only rolls original floor-eligible events', () => {
  const seen = sample({ floor }, type);
  assert.ok(seen.size > 3);
});

test('locked story chains never appear merely because their hope or light alternative is available', () => {
  for (const floor of [1, 2, 3, 4, 5]) {
    const seen = sample({ floor, endingUnlocks: ['ro2_ending_1'] });
    for (const number of [40, 41, 42, 43, 44, 45, 46]) assert.equal(seen.has(number), false, number + ' appeared before its original unlock or prerequisite');
  }
});

test('opening appears only after Silent Age completion and stops after choosing either branch', () => {
  const firstEnding = mizukiEndingUnlocksAfter(['ro2_ending_1'], 'ro2_ending_1');
  assert.equal(sample({ floor: 1, endingUnlocks: firstEnding }).has(42), false);
  const silentAge = mizukiEndingUnlocksAfter(firstEnding, 'ro2_ending_2');
  assert.equal(sample({ floor: 1, endingUnlocks: silentAge }).has(42), true);
  for (const [choiceId, relicId] of [['choice_ro2_bossb1_1', 'rogue_2_relic_curse_7'], ['choice_ro2_bossb1_3', 'rogue_2_relic_curse_9']]) {
    const previous = history(choiceId, relicId);
    assert.equal(sample({ ...previous, floor: 1 }).has(42), false);
  }
});

test('heart needs research history, original late floors and sufficient light before the event is rolled', () => {
  const research = history('choice_ro2_bossb1_1', 'rogue_2_relic_curse_7');
  assert.equal(sample({ ...research, floor: 3 }).has(43), false);
  assert.equal(sample({ ...research, floor: 4, light: 19 }).has(43), false);
  assert.equal(sample({ ...research, floor: 4, light: 20 }).has(43), true);
  const heart = history('choice_ro2_bossb2_6', 'rogue_2_relic_curse_8', 4, research);
  assert.equal(sample({ ...heart, floor: 4 }).has(43), false);
  assert.equal(sample({ ...heart, floor: 4 }).has(44), false);
  assert.equal(sample({ ...heart, floor: 5 }).has(44), true);
});

test('memory followups only appear on their original floors before their milestone is claimed', () => {
  const memory = history('choice_ro2_bossb1_3', 'rogue_2_relic_curse_9');
  assert.equal(sample({ ...memory, floor: 1 }).has(45), false);
  assert.equal(sample({ ...memory, floor: 2 }).has(45), true);
  assert.equal(sample({ ...memory, floor: 3 }).has(46), false);
  assert.equal(sample({ ...memory, floor: 4, light: 0 }).has(46), true);
  const tree = history('choice_ro2_bossc2_2', 'rogue_2_relic_curse_10', 2, memory);
  assert.equal(sample({ ...tree, floor: 3 }).has(45), false);
  const branch = history('choice_ro2_bossc3_3', 'rogue_2_relic_grace_90', 4, memory);
  assert.equal(sample({ ...branch, floor: 5 }).has(46), false);
});

test('knight followup requires living knight history and cannot appear as a resource-only event', () => {
  assert.equal(sample({ floor: 2 }).has(41), false);
  const knight = history('choice_ro2_bossa1_1', 'rogue_2_relic_grace_83');
  assert.equal(sample({ ...knight, floor: 1 }).has(41), false);
  assert.equal(sample({ ...knight, floor: 2 }).has(41), true);
  assert.equal(sample({ ...knight, floor: 2, endingProgress: { ...knight.endingProgress, knightDeaths: ['prior-battle'] } }).has(41), false);
});

test('entertainment draws respect original late-floor choices', () => {
  assert.deepEqual([...sample({ floor: 1 }, 'ENTERTAINMENT')], [48]);
  assert.deepEqual([...sample({ floor: 2 }, 'ENTERTAINMENT')], [48]);
  assert.ok(sample({ floor: 3 }, 'ENTERTAINMENT').has(23));
  assert.ok(sample({ floor: 4 }, 'ENTERTAINMENT').has(18));
});

for (const endingUnlocks of [['ro2_ending_1'], ALL]) test('the legal sixth-floor layout has no random incident and its safe corner remains usable', () => {
  const stageOptions = [
    { stageId: 'ro2_n_6_1', type: 'combat', available: true },
    { stageId: 'ro2_b_4', type: 'boss', available: true },
    { stageId: 'ro2_b_6', type: 'boss', available: true },
    { stageId: 'ro2_b_7', type: 'boss', available: true },
  ];
  for (let seed = 1; seed <= 64; seed++) for (const ending of [3, 4]) {
    const dungeon = applyMizukiEndingRoute({ zones: { zone_5: { id: 'zone_5', zoneType: 'NORMAL', nodes: [] } } },
      { fifthBossStageId: 'ro2_b_4', sixthBossStageId: 'ro2_b_' + (ending + 3), endingId: 'ro2_ending_' + ending }, { seed, stageOptions });
    const nodes = dungeon.zones.zone_6.nodes;
    assert.equal(nodes.some(node => ['INCIDENT', 'UNKNOWN'].includes(node.type)), false);
    assert.ok(nodes.some(node => node.type === 'REST'));
    const event = createMizukiRouteEvent({ id: 'sixth:safe-corner:' + seed, graphType: 'REST' }, { ...base, floor: 6, endingUnlocks });
    assert.equal(event.state.eventKey, 'prts_ro2_event_47');assert.ok(event.choices.some(choice => choice.available));
  }
});
