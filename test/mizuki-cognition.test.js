import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIZUKI_SQUADS, MIZUKI_SQUAD_TIERS } from '../shared/mizuki-squads.js';
import { normalizeCognition, advanceCognition, cognitionEffects, resolvedSquad, mizukiExplorationScore, mizukiExplorationScoreBreakdown,
  MIZUKI_COGNITION_MAX_TOKENS, MIZUKI_COGNITION_MAX_SCORE } from '../server/modes/mizuki/Cognition.js';
import { mizukiCommanderProgress, validMizukiCommander, mizukiCommanderNextExp } from '../server/modes/mizuki/Difficulty.js';
const DATA = JSON.parse(readFileSync(new URL('../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const nodes = Object.values(DATA.customizeData.developments);
const node = number => 'rogue_2_outbuff_' + number;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, actual + ' != ' + expected);

test('cognition source contains all 58 nodes and exactly 112 original token costs', () => {
  assert.equal(nodes.length, 58);
  assert.equal(nodes.reduce((sum, value) => sum + value.tokenCost, 0), 112);
  assert.equal(MIZUKI_COGNITION_MAX_TOKENS, 112); assert.equal(MIZUKI_COGNITION_MAX_SCORE, 22400);
  assert.deepEqual(normalizeCognition(), { version: 1, totalScore: 0, scoreRemainder: 0,
    earnedTokens: 0, spentTokens: 0, tokens: 0, unlockedNodeIds: [] });
  assert.deepEqual(normalizeCognition({ totalScore: -1, tokens: 10000, unlockedNodeIds: nodes.map(x => x.buffId) }), normalizeCognition());
  assert.deepEqual(normalizeCognition({ totalScore: 199, tokens: 99, unlockedNodeIds: [node(50)] }),
    { ...normalizeCognition(), totalScore: 199, scoreRemainder: 199 });
});

test('tokens retain cross-run score remainders and apply actual native bonuses', () => {
  const previous = advanceCognition(199); const snapshot = structuredClone(previous);
  const next = advanceCognition(1, previous);
  assert.deepEqual(previous, snapshot); assert.equal(next.earnedTokens, 1); assert.equal(next.scoreRemainder, 0);
  assert.deepEqual(next.unlockedNodeIds, [node(1)]); assert.equal(next.spentTokens, 1); assert.equal(next.tokens, 0);
  assert.equal(cognitionEffects(next).commanderExpMultiplier, 1.1);
  assert.equal(cognitionEffects(next).driftingCacheUnlocked, false);
  const second = advanceCognition(200, next); assert.deepEqual(second.unlockedNodeIds, [node(1), node(2)]);
  assert.equal(cognitionEffects(second).driftingCacheUnlocked, true);
  assert.throws(() => advanceCognition(-1), TypeError); assert.throws(() => advanceCognition(0.1), TypeError);
  assert.throws(() => advanceCognition(Number.MAX_SAFE_INTEGER + 1), TypeError);
});

test('automatic purchases are monotonic, costed, prerequisite complete and independent of score batching', () => {
  let incremental = normalizeCognition();
  for (let earned = 1; earned <= 112; earned++) {
    const previous = incremental; incremental = advanceCognition(200, previous);
    const direct = normalizeCognition({ totalScore: earned * 200 });
    assert.deepEqual(incremental, direct);
    const owned = new Set(direct.unlockedNodeIds);
    for (const id of previous.unlockedNodeIds) assert.ok(owned.has(id), 'an unlocked node cannot disappear: ' + id);
    for (const value of nodes.filter(value => owned.has(value.buffId)))
      for (const parent of value.frontNodeId) assert.ok(owned.has(parent), value.buffId + ' requires ' + parent);
    const spent = nodes.filter(value => owned.has(value.buffId)).reduce((sum, value) => sum + value.tokenCost, 0);
    assert.equal(direct.spentTokens, spent); assert.equal(direct.tokens + spent, earned);
    assert.deepEqual(normalizeCognition(direct), direct);
  }
  assert.equal(incremental.unlockedNodeIds.length, 58); assert.equal(incremental.spentTokens, 112);
  assert.equal(incremental.tokens, 0);
  assert.deepEqual(advanceCognition(Number.MAX_SAFE_INTEGER, incremental), incremental);
});

test('all native numeric cognition bonuses aggregate without inventing additional attributes', () => {
  const effects = cognitionEffects({ totalScore: 22400 });
  assert.deepEqual(Object.fromEntries(['atkPct', 'defPct', 'hpPct', 'initialGold', 'initialMaxLife', 'initialDice',
    'initialKey', 'squadCapacity', 'deployLimit', 'commanderExpMultiplier', 'livingCellMultiplier'].map(key => [key, effects[key]])),
  { atkPct: 0.2, defPct: 0.3, hpPct: 0.3, initialGold: 15, initialMaxLife: 3, initialDice: 2,
    initialKey: 2, squadCapacity: 1, deployLimit: 1, commanderExpMultiplier: 1.4, livingCellMultiplier: 1.2 });
  assert.equal(effects.rawNodes.length, 58); assert.deepEqual(effects.rawNodes, nodes);
  effects.rawNodes[0].tokenCost = 999;
  assert.equal(cognitionEffects({ totalScore: 22400 }).rawNodes[0].tokenCost, nodes[0].tokenCost);
});

test('every raw cognitive effect exposes its original gate and strongest nonstacking tier', () => {
  const gates = { 2: 'driftingCacheUnlocked', 3: 'exchangeUnlocked', 4: 'expeditionUnlocked',
    5: 'portalUnlocked', 36: 'sanRerollEnabled', 44: 'duckBrickUnlocked', 45: 'wishRerollEnabled' };
  for (let tokens = 0; tokens <= 112; tokens++) {
    const state = normalizeCognition({ totalScore: tokens * 200 }), owned = new Set(state.unlockedNodeIds);
    const effects = cognitionEffects(state);
    for (const [number, key] of Object.entries(gates)) assert.equal(effects[key], owned.has(node(number)), key);
    assert.equal(effects.perfectShieldLifeThreshold, owned.has(node(27)) ? 8 : owned.has(node(25)) ? 10 : null);
    assert.equal(effects.shopDiscount, owned.has(node(54)) ? 0.4 : owned.has(node(12)) ? 0.6 : owned.has(node(9)) ? 0.8 : null);
  }
});

test('the thirteen existing squad cards resolve all nine upgraded native tiers and preserve original effect records', () => {
  const seen = new Set(); assert.equal(MIZUKI_SQUADS.length, 13);
  for (let tokens = 0; tokens <= 112; tokens++) {
    const state = normalizeCognition({ totalScore: tokens * 200 });
    for (const base of MIZUKI_SQUADS) {
      const squad = resolvedSquad(base.id, state); assert.ok(squad); seen.add(squad.id);
      assert.deepEqual(squad, MIZUKI_SQUAD_TIERS.find(value => value.id === squad.id));
      assert.equal(squad.name, base.name);
    }
  }
  assert.equal(seen.size, 22);
  assert.equal(resolvedSquad('rogue_2_band_12', { totalScore: 22400 }), null, 'upgraded IDs are not additional input cards');
  assert.equal(resolvedSquad('unknown', normalizeCognition()), null);
  for (const [base, upgraded] of [['rogue_2_band_11', 'rogue_2_band_14'], ['rogue_2_band_15', 'rogue_2_band_18'], ['rogue_2_band_19', 'rogue_2_band_22']])
    assert.equal(resolvedSquad(base, { totalScore: 22400 }).id, upgraded);
});

test('exploration scoring uses native floor totals, committed events and only the difficulty score multiplier', () => {
  for (const [floorsPassed, expected] of [0, 30, 80, 150, 270, 400, 550, 650].entries())
    assert.equal(mizukiExplorationScore({ floorsPassed }), expected);
  const counters = { floorsPassed: 5, stepsPassed: 25, normalBattles: 7, eliteBattles: 3, bossBattles: 2, recruits: 8, itemsGained: 11 };
  const base = 400 + 25 + 70 + 60 + 60 + 16 + 55;
  assert.equal(mizukiExplorationScore(counters), base);
  for (const row of DATA.rawTopic.difficulties.filter(value => value.modeDifficulty === 'NORMAL'))
    assert.equal(mizukiExplorationScore(counters, row.grade), Math.floor(base * row.scoreFactor));
  assert.equal(mizukiExplorationScore({ itemsGained: 3 }), 15);
  assert.throws(() => mizukiExplorationScore({ floorsPassed: 8 }), TypeError);
  assert.throws(() => mizukiExplorationScore({ recruits: -1 }), TypeError);
  assert.throws(() => mizukiExplorationScore({}, 19), TypeError);
  assert.throws(() => mizukiExplorationScore({ itemsGained: Number.MAX_SAFE_INTEGER }), TypeError);
});

test('commander caps affect actual progress and next experience while default legacy behavior remains eleven', () => {
  const total = Object.values(DATA.rawTopic.detailConst.playerLevelTable).reduce((sum, row) => sum + row.exp, 0);
  const legacy = mizukiCommanderProgress(total), capped = mizukiCommanderProgress(total, 10);
  assert.equal(legacy.level, 11); assert.equal(legacy.exp, 0);
  assert.equal(capped.level, 10); assert.equal(capped.exp, 80);
  assert.equal(validMizukiCommander(capped, 10), true); assert.equal(validMizukiCommander(legacy, 10), false);
  assert.equal(validMizukiCommander(legacy), true); assert.equal(mizukiCommanderNextExp(10, 10), null);
  assert.equal(mizukiCommanderNextExp(10), 80); assert.equal(mizukiCommanderNextExp(11), null);
  assert.equal(mizukiCommanderProgress(500, 1).level, 1);
  for (const invalid of [0, 12, 1.5, null]) {
    assert.throws(() => mizukiCommanderProgress(0, invalid), TypeError);
    assert.throws(() => mizukiCommanderNextExp(1, invalid), TypeError);
    assert.equal(validMizukiCommander(legacy, invalid), false);
  }
  close(cognitionEffects().commanderExpMultiplier, 1);
});


test('settlement breakdown exposes all official terms and floors only after applying the native multiplier', () => {
  const counters={floorsPassed:5,stepsPassed:42,normalBattles:12,eliteBattles:6,bossBattles:3,recruits:14,itemsGained:31};
  for(const row of DATA.rawTopic.difficulties.filter(x=>x.modeDifficulty==='NORMAL')){
    const score=mizukiExplorationScoreBreakdown(counters,row.grade);
    assert.deepEqual(score.counters,counters);assert.equal(score.points.floorsPassed,400);
    assert.equal(Object.values(score.points).reduce((a,b)=>a+b,0),score.base);
    assert.equal(score.total,Math.floor(score.base*row.scoreFactor));
  }
});
