import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { createMizukiExplorationState } from '../server/modes/mizuki/exploration.js';
import { mizukiBattleNativeDrops } from '../server/modes/mizuki/BattleRewards.js';

const rawTopic = JSON.parse(readFileSync(new URL('../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
const data = getData({ log: { warn() {}, error() {}, info() {} } });
const floorTwoDungeon = { zones: {
  floor1: { id: 'zone_1', zoneType: 'NORMAL', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] },
  floor2: { id: 'zone_2', zoneType: 'NORMAL', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] },
} };
const sequenceRng = (values) => {
  let index = 0;
  const rng = () => values[index++];
  rng.calls = () => index;
  return rng;
};

function rewardFixture(t, sample) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ scheduler, data, roomCode: 'MZDR', seed: 512, mizukiDifficultyGrade: 16,
    seats: [{ playerId: 'p0', seat: 0 }], send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.currentNode = { id: 'floor2-normal', type: 'combat', graphType: 'BATTLE_NORMAL', stageId: 'ro2_n_1_1' };
  match.explorationState = { ...createMizukiExplorationState(floorTwoDungeon), zoneKey: 'floor2' };
  match.order[0].battleOutcome = { id: 'battle:p0', nodeId: match.currentNode.id, battleId: 'battle',
    perfect: true, cleared: true, lpLoss: 0, leaked: 0, through: 0 };
  const originalRng = match._rng.bind(match);
  match._rng = (salt) => salt === 'battle-native-drops' ? () => sample : originalRng(salt);
  return match;
}

test('N16 battle drops use original per-floor probability, node filters, and independent unique groups', () => {
  const floorTwo = rawTopic.relics.rogue_2_feature_pill_2.buffs
    .filter((effect) => effect.key === 'battle_extra_drop')
    .map((effect) => Object.fromEntries(effect.blackboard.map((entry) => [entry.key, entry.valueStr ?? entry.value])));
  assert.deepEqual(floorTwo.map(({ id, rate, node, uniq_id }) => ({ id, rate, node, uniq_id })), [
    { id: 'rogue_2_pill', rate: 0.01, node: 'BATTLE_NORMAL', uniq_id: 'battle_pill,2' },
    { id: 'rogue_2_pill', rate: 0.02, node: 'BATTLE_ELITE,BATTLE_BOSS', uniq_id: 'battle_pill_elite,2' },
    { id: 'rogue_2_bigpill', rate: 0, node: 'BATTLE_NORMAL', uniq_id: 'battle_bigpill,2' },
    { id: 'rogue_2_bigpill', rate: 0, node: 'BATTLE_ELITE,BATTLE_BOSS', uniq_id: 'battle_bigpill_elite,2' },
  ]);

  const normalSuccessRng = sequenceRng([0.009]);
  assert.deepEqual(mizukiBattleNativeDrops({ node: { type: 'combat', graphType: 'BATTLE_NORMAL' }, floor: 2,
    grade: 16, rng: normalSuccessRng }), [{ id: 'rogue_2_pill', count: 1 }]);
  assert.equal(normalSuccessRng.calls(), 1, 'only the positive-rate normal-node unique group samples');

  const normalBoundaryRng = sequenceRng([0.01]);
  assert.deepEqual(mizukiBattleNativeDrops({ node: { type: 'combat', graphType: 'BATTLE_NORMAL' }, floor: 2,
    grade: 16, rng: normalBoundaryRng }), [], 'a sample equal to the 1% rate fails');
  assert.equal(normalBoundaryRng.calls(), 1);

  const eliteSuccessRng = sequenceRng([0.019]);
  assert.deepEqual(mizukiBattleNativeDrops({ node: { type: 'elite', graphType: 'BATTLE_ELITE' }, floor: 2,
    grade: 16, rng: eliteSuccessRng }), [{ id: 'rogue_2_pill', count: 1 }]);
  assert.equal(eliteSuccessRng.calls(), 1, 'elite uses its separate 2% group; zero-rate normal rows do not roll');
  const floorSixEliteRng = sequenceRng([0.199, 0.099]);
  assert.deepEqual(mizukiBattleNativeDrops({ node: { type: 'elite', graphType: 'BATTLE_ELITE' }, floor: 6,
    grade: 16, rng: floorSixEliteRng }), [
    { id: 'rogue_2_pill', count: 1 }, { id: 'rogue_2_bigpill', count: 1 },
  ], 'floor-six elite drops can succeed independently in their two original unique groups');
  assert.equal(floorSixEliteRng.calls(), 2);
  assert.deepEqual(mizukiBattleNativeDrops({ node: { type: 'combat' }, floor: 2, grade: 15, rng: () => 0 }), []);
  assert.deepEqual(mizukiBattleNativeDrops({ node: { type: 'event' }, floor: 2, grade: 18, rng: () => 0 }), []);
});

test('N16 _enterReward grants successful native drops to team inventory and records the actual reward', (t) => {
  for (const [sample, expectedCount] of [[0.009, 1], [0.01, 0]]) {
    const match = rewardFixture(t, sample);
    match._enterReward();

    assert.equal(match.nativeItems.rogue_2_pill, expectedCount,
      `sample ${sample} should ${expectedCount ? 'grant' : 'not grant'} the 1% N16 normal-node drop`);
    assert.equal(match.nativeItems.rogue_2_bigpill, 0);
    const recorded = match.order[0].battleOutcome.autoGranted.filter((reward) => reward.itemId === 'rogue_2_pill');
    assert.deepEqual(recorded.map(({ itemId, count, type, autoGranted, ownership }) => ({ itemId, count, type, autoGranted, ownership })),
      expectedCount ? [{ itemId: 'rogue_2_pill', count: 1, type: 'resource', autoGranted: true, ownership: 'team' }] : []);
    assert.equal(match.order[0].battleOutcome.rewards.exp > 0, true, 'ordinary battle settlement remains applied');
    assert.equal(match.order[0].rewards.filter((reward) => reward.type === 'recruitTicket').length, 2,
      'native drops coexist with the normal battle reward selection');
  }
});
