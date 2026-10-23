import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRankProgress, rankPyramidView, rankPyramidMiniView, cleanRankPyramid } from '../public/js/ui/rankPyramid.js';

const profile = ({ wins, points = 0, ranked = true, division = 'iron', divisionName = '黑铁', tier = 1, icon = 'iron_1', globalRank = null }) => ({
  wins,
  points,
  ranked,
  globalRank,
  rank: { division, divisionName, tier, icon, points },
});

// A score event is one completed settlement, not a jump in lifetime wins.
const scoringProfile = values => ({ ...profile(values), scoreDelta: 1 });
function recordScoreEvents(state, count, values = {}) {
  for (let i = 0; i < count; i++) {
    state = observeRankProgress(state, scoringProfile({ wins: state?.lastWins ?? 0, ...values }));
  }
  return state;
}

test('first rank snapshot establishes a baseline without importing historic wins', () => {
  const first = observeRankProgress(null, profile({ wins: 18, points: 900, division: 'gold', divisionName: '黄金', tier: 1, icon: 'gold_1' }));
  assert.equal(first.lastWins, 18);
  assert.equal(first.earned.length, 0);
  assert.equal(first.best.icon, 'gold_1');
  assert.equal(rankPyramidMiniView(first), null);
  assert.equal(rankPyramidView(first).filledWins, 0);

  const next = observeRankProgress(first, scoringProfile({ wins: 19, points: 950, division: 'gold', divisionName: '黄金', tier: 1, icon: 'gold_1' }));
  assert.equal(next.earned.length, 1);
  assert.equal(next.earned[0].division, 'gold');
  assert.equal(next.best.icon, 'gold_1');
});

test('unranked victories leave slots empty and cannot backfill after placement', () => {
  const unranked = wins => profile({ wins, ranked: false, division: null, divisionName: '未定级', tier: null, icon: 'unranked' });
  let state = observeRankProgress(null, unranked(100));
  state = observeRankProgress(state, unranked(102));
  assert.equal(state.lastWins, 102);
  assert.equal(state.totalWins, 0);
  assert.deepEqual(state.earned, []);
  assert.equal(rankPyramidView(state).winsToNextLayer, 1);
  assert.equal(rankPyramidMiniView(state), null);
  state = observeRankProgress(state, scoringProfile({ wins: 103, division: 'gold', icon: 'gold_1' }));
  assert.equal(state.totalWins, 1);
  assert.equal(state.earned.length, 1);
  assert.equal(state.earned[0].icon, 'gold_1');
  assert.equal(observeRankProgress(state, profile({ wins: 103 })).earned.length, 1);
});

test('old unranked placeholders do not occupy slots or unlock the card early', () => {
  const first = observeRankProgress(null, profile({ wins: 0 }));
  const ghost = { division: null, tier: null, icon: 'unranked' };
  const colored = { division: 'gold', tier: 1, icon: 'gold_1' };
  const legacy = { ...first, lastWins: 9, totalWins: 9, earned: [ghost, ghost, ...Array(7).fill(colored)] };
  const clean = cleanRankPyramid(legacy);
  assert.equal(clean.lastWins, 9);
  assert.equal(clean.totalWins, 7);
  assert.equal(clean.earned.length, 7);
  assert.deepEqual(cleanRankPyramid(clean), clean);
  assert.equal(rankPyramidView(legacy).filledWins, 7);
  assert.equal(rankPyramidMiniView(legacy), null);
});

test('saved radiant peak snapshots display the renamed division without changing rank', () => {
  const state = observeRankProgress(null, profile({ wins: 9, points: 2600, division: 'radiant', divisionName: '赋能战魂', tier: null, icon: 'radiant', globalRank: 12 }));
  assert.equal(state.best.divisionName, '源能战魂');
  assert.equal(cleanRankPyramid({ ...state, best: { ...state.best, divisionName: '赋能战魂' } }).best.divisionName, '源能战魂');
  assert.equal(state.best.icon, 'radiant');
  assert.equal(state.best.points, 2600);
  assert.equal(state.best.globalRank, 12);
});

test('menu keeps seven rows while card unlocks exactly three rows at nine new wins', () => {
  let state = observeRankProgress(null, profile({ wins: 0, ranked: false, division: null, divisionName: '未定级', tier: null, icon: 'unranked' }));
  state = recordScoreEvents(state, 9, { wins: 9, points: 1200, division: 'platinum', divisionName: '白金', tier: 1, icon: 'platinum_1' });
  assert.deepEqual(rankPyramidView(state).rows.map((row) => row.length), [1, 3, 5, 7, 9, 11, 13]);
  assert.equal(rankPyramidView(state).rows.flat().filter(Boolean).length, 9);
  assert.deepEqual(rankPyramidView(state).rows.slice(0, 3).map((row) => row.length), [1, 3, 5]);

  state = recordScoreEvents(state, 7, { wins: 16, points: 1500, division: 'diamond', divisionName: '钻石', tier: 1, icon: 'diamond_1' });
  assert.deepEqual(rankPyramidView(state).rows.map((row) => row.length), [1, 3, 5, 7, 9, 11, 13]);
  state = recordScoreEvents(state, 33, { wins: 49, points: 2100, division: 'immortal', divisionName: '神话', tier: 1, icon: 'immortal_1', globalRank: 321 });
  assert.deepEqual(rankPyramidView(state).rows.map((row) => row.length), [1, 3, 5, 7, 9, 11, 13]);
  assert.equal(state.earned.length, 49);
  assert.deepEqual(rankPyramidMiniView(state).rows.map(row => row.length), [1, 3, 5]);
  assert.equal(rankPyramidMiniView(state).rows.flat().length, 9);
});

test('best rank never regresses and rank text is reserved for Mythic and above', () => {
  let state = observeRankProgress(null, profile({ wins: 0, points: 200, division: 'iron', divisionName: '黑铁', tier: 2, icon: 'iron_2' }));
  state = observeRankProgress(state, scoringProfile({ wins: 1, points: 600, division: 'silver', divisionName: '白银', tier: 1, icon: 'silver_1' }));
  assert.equal(state.best.icon, 'silver_1');
  state = observeRankProgress(state, profile({ wins: 1, points: 2100, division: 'immortal', divisionName: '神话', tier: 1, icon: 'immortal_1', globalRank: 82 }));
  assert.equal(state.best.icon, 'immortal_1');
  assert.equal(state.earned.length, 1);
  state = observeRankProgress(state, profile({ wins: 1, points: 500, division: 'bronze', divisionName: '青铜', tier: 3, icon: 'bronze_3' }));
  assert.equal(state.best.icon, 'immortal_1');
  assert.equal(rankPyramidView({ ...state, earned: Array(9).fill(state.earned[0]) }).bestLabel, '神话一 #82');
  state = recordScoreEvents(state, 2, { wins: 3, points: 2600, division: 'radiant', divisionName: '源能战魂', tier: null, icon: 'radiant', globalRank: 12 });
  assert.equal(state.best.icon, 'radiant');
  assert.equal(rankPyramidView({ ...state, earned: Array(9).fill(state.earned[0]) }).bestLabel, '源能战魂 #12');

  const lowRank = observeRankProgress(null, profile({ wins: 0, points: 300, division: 'bronze', divisionName: '青铜', tier: 1, icon: 'bronze_1' }));
  const lowAfterWin = recordScoreEvents(lowRank, 9, { wins: 9, points: 500, division: 'bronze', divisionName: '青铜', tier: 3, icon: 'bronze_3' });
  assert.equal(rankPyramidView(lowAfterWin).best.icon, 'bronze_3');
  assert.equal(rankPyramidView(lowAfterWin).bestLabel, '');
});

test('snapshots without score events cannot duplicate or erase recorded progress', () => {
  let state = observeRankProgress(null, profile({ wins: 4 }));
  state = recordScoreEvents(state, 2, { wins: 6, points: 200, division: 'iron', divisionName: '黑铁', tier: 3, icon: 'iron_3' });
  const stale = observeRankProgress(state, profile({ wins: 5, points: 100, division: 'iron', divisionName: '黑铁', tier: 2, icon: 'iron_2' }));
  assert.equal(stale.lastWins, 6);
  assert.equal(stale.earned.length, 2);
  assert.equal(stale.totalWins, 2);
});

test('card stays absent for every progress level below nine, menu shows all empty slots', () => {
  assert.equal(rankPyramidView(null).rows.flat().length, 49);
  assert.equal(rankPyramidMiniView(null), null);
  let state = observeRankProgress(null, profile({ wins: 100 }));
  for (let i = 0; i <= 8; i++) {
    if (i > 0) state = observeRankProgress(state, scoringProfile({ wins: 100 + i }));
    assert.equal(rankPyramidMiniView(state), null);
    assert.equal(rankPyramidView(state).filledWins, i);
  }
  state = observeRankProgress(state, scoringProfile({ wins: 109 }));
  assert.equal(rankPyramidMiniView(state).rows.flat().filter(Boolean).length, 9);
});

test('highest divisions and small tiers occupy the top before lower-ranked wins', () => {
  let state = observeRankProgress(null, profile({ wins: 0 }));
  state = recordScoreEvents(state, 8, { wins: 8, division: 'gold', icon: 'gold_1', tier: 1 });
  state = observeRankProgress(state, scoringProfile({ wins: 9, division: 'gold', icon: 'gold_3', tier: 3 }));
  state = observeRankProgress(state, scoringProfile({ wins: 10, division: 'diamond', icon: 'diamond_1', tier: 1 }));
  const icons = rankPyramidView(state).rows.flat().filter(Boolean).map(cell => cell.icon);
  assert.deepEqual(icons.slice(0, 3), ['diamond_1', 'gold_3', 'gold_1']);
  assert.equal(state.earned[1].tier, 3);
});

test('new high-rank wins replace the lowest of 49 retained wins, not the highest', () => {
  let state = observeRankProgress(null, profile({ wins: 0 }));
  state = recordScoreEvents(state, 49, { wins: 49 });
  state = observeRankProgress(state, scoringProfile({ wins: 50, division: 'diamond', icon: 'diamond_2', tier: 2 }));
  assert.equal(state.earned.length, 49);
  assert.equal(state.earned[0].icon, 'diamond_2');
  assert.equal(rankPyramidView(state).totalWins, 50);
  state = recordScoreEvents(state, 50, { wins: 100, division: 'gold', icon: 'gold_3', tier: 3 });
  assert.equal(state.earned.length, 49);
  assert.equal(state.earned[0].icon, 'diamond_2');
  assert.equal(state.earned.at(-1).icon, 'gold_3');
  assert.equal(rankPyramidView(state).totalWins, 100);
});

test('seven-row progress reports the next unfilled layer and keeps total wins beyond 49', () => {
  const baseline = observeRankProgress(null, profile({ wins: 100 }));
  const cases = [
    [0, 1, 1], [1, 2, 3], [3, 2, 1], [4, 3, 5], [8, 3, 1],
    [9, 4, 7], [15, 4, 1], [16, 5, 9], [17, 5, 8], [24, 5, 1],
    [25, 6, 11], [35, 6, 1], [36, 7, 13], [48, 7, 1],
    [49, null, 0], [50, null, 0], [75, null, 0], [100, null, 0],
  ];
  for (const [wins, nextLayer, remaining] of cases) {
    const state = recordScoreEvents(baseline, wins, { wins: 100 + wins });
    const view = rankPyramidView(state);
    assert.equal(view.totalWins, wins, `total at ${wins} wins`);
    assert.equal(view.filledWins, Math.min(wins, 49));
    assert.equal(view.nextLayer, nextLayer, `next layer at ${wins} wins`);
    assert.equal(view.winsToNextLayer, remaining, `remaining at ${wins} wins`);
    assert.equal(view.rows.flat().length, 49);
  }
  assert.equal(rankPyramidView(null).nextLayer, 1);
  assert.equal(rankPyramidView(null).winsToNextLayer, 1);
});

test('peak honors rank before points and improves high-rank placement without a win', () => {
  let state = observeRankProgress(null, profile({ wins: 0, points: 2800, division: 'immortal', icon: 'immortal_3', tier: 3, globalRank: 55 }));
  state = observeRankProgress(state, profile({ wins: 0, points: 2700, division: 'radiant', icon: 'radiant', tier: null, globalRank: 20 }));
  assert.equal(state.best.icon, 'radiant');
  state = observeRankProgress(state, profile({ wins: 0, points: 2700, division: 'radiant', icon: 'radiant', tier: null, globalRank: 12 }));
  assert.equal(state.best.globalRank, 12);
  state = observeRankProgress(state, profile({ wins: 0, points: 2900, division: 'radiant', icon: 'radiant', tier: null, globalRank: 15 }));
  assert.equal(state.best.globalRank, 12);
  assert.equal(state.best.points, 2700);
});

 test('clean rank state retains authoritative progress through serialization', () => {
   let state = observeRankProgress(null, { ...profile({ wins: 100 }), startedAt: 12345 });
   state = recordScoreEvents(state, 9, { wins: 109, division: 'gold', icon: 'gold_2', tier: 2 });
   const restored = cleanRankPyramid(JSON.parse(JSON.stringify(state)));
   assert.equal(restored.totalWins, 9);
   assert.equal(restored.startedAt, 12345);
   assert.equal(restored.earned[0].icon, 'gold_2');
   assert.equal(cleanRankPyramid({ version: -1 }), null);
 });

test('only a finite positive numeric score event fills a cell', () => {
  const baseline = observeRankProgress(null, profile({ wins: 100 }));
  for (const scoreDelta of [0, -1, -500, NaN, Infinity, -Infinity, undefined, null, '1', true]) {
    const state = observeRankProgress(baseline, { ...profile({ wins: 200 }), scoreDelta });
    assert.equal(state.totalWins, 0, `no progress for ${String(scoreDelta)}`);
    assert.equal(state.earned.length, 0, `no cell for ${String(scoreDelta)}`);
    assert.equal(rankPyramidMiniView(state), null);
  }
});

test('lifetime win jumps and missing score events never import historic progress', () => {
  const baseline = observeRankProgress(null, profile({ wins: 18 }));
  let state = observeRankProgress(baseline, profile({ wins: 118, points: 950, division: 'gold', tier: 1, icon: 'gold_1' }));
  assert.equal(state.lastWins, 118);
  assert.equal(state.totalWins, 0);
  assert.deepEqual(state.earned, []);
  assert.equal(state.best.icon, 'gold_1');
  state = observeRankProgress(state, scoringProfile({ wins: 118, division: 'gold', tier: 1, icon: 'gold_1' }));
  assert.equal(state.totalWins, 1);
  assert.equal(state.earned.length, 1);
  const snapshotOnly = observeRankProgress(state, profile({ wins: 218 }));
  assert.equal(snapshotOnly.totalWins, 1);
  assert.deepEqual(snapshotOnly.earned, state.earned);
});

test('each positive settlement fills one cell regardless of points gained or team win', () => {
  let state = observeRankProgress(null, profile({ wins: 7 }));
  for (const scoreDelta of [1, 500]) {
    state = observeRankProgress(state, { ...profile({ wins: 7 }), teamWin: false, scoreDelta });
  }
  assert.equal(state.lastWins, 7);
  assert.equal(state.totalWins, 2);
  assert.equal(state.earned.length, 2);
});

test('an older higher lifetime baseline cannot block a real positive score event', () => {
  const baseline = observeRankProgress(null, profile({ wins: 1000 }));
  const state = observeRankProgress(baseline, { ...profile({ wins: 1 }), scoreDelta: 5 });
  assert.equal(state.lastWins, 1000);
  assert.equal(state.totalWins, 1);
  assert.equal(state.earned.length, 1);
});

test('first observation still creates only a baseline and unranked scores cannot fill cells', () => {
  const first = observeRankProgress(null, { ...profile({ wins: 99 }), scoreDelta: 500 });
  assert.equal(first.totalWins, 0);
  assert.deepEqual(first.earned, []);
  const unranked = profile({ wins: 100, ranked: false, division: null, tier: null, icon: 'unranked' });
  const pending = observeRankProgress(first, { ...unranked, scoreDelta: 50 });
  assert.equal(pending.totalWins, 0);
  assert.deepEqual(pending.earned, []);
  const placed = observeRankProgress(pending, { ...profile({ wins: 100, division: 'gold', tier: 2, icon: 'gold_2' }), scoreDelta: 900 });
  assert.equal(placed.totalWins, 1);
  assert.deepEqual(placed.earned.map(cell => cell.icon), ['gold_2']);
});

test('lower-rank overflow increases the event count without displacing any high-rank cell', () => {
  const baseline = observeRankProgress(null, profile({ wins: 0 }));
  let state = recordScoreEvents(baseline, 49, { wins: 0, division: 'diamond', tier: 2, icon: 'diamond_2' });
  state = observeRankProgress(state, scoringProfile({ wins: 0, division: 'bronze', tier: 3, icon: 'bronze_3' }));
  assert.equal(state.totalWins, 50);
  assert.equal(state.earned.length, 49);
  assert.ok(state.earned.every(cell => cell.icon === 'diamond_2'));
  assert.equal(rankPyramidMiniView(state).rows.flat().filter(Boolean).length, 9);
});

test('higher small tiers win overflow selection within the same major division', () => {
  const baseline = observeRankProgress(null, profile({ wins: 0 }));
  let state = recordScoreEvents(baseline, 49, { wins: 0, division: 'gold', tier: 1, icon: 'gold_1' });
  state = observeRankProgress(state, scoringProfile({ wins: 0, division: 'gold', tier: 3, icon: 'gold_3' }));
  assert.equal(state.totalWins, 50);
  assert.equal(state.earned.length, 49);
  assert.equal(state.earned[0].icon, 'gold_3');
  assert.equal(state.earned.filter(cell => cell.icon === 'gold_1').length, 48);
});
