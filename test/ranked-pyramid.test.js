import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RankedStore } from '../server/rankedStore.js';
import { cleanRankPyramid, rankPyramidMiniView, rankPyramidView } from '../shared/rankPyramid.js';

const aid = 'aabbccddaabbccddaabbccddaabbccdd';
const who = { aid, name: '金字塔测试', playerId: 'p1' };
const strong = { alive: true, roundsPassed: 15, survivalRounds: 15, layers: 999, assists: 10,
  rankedDamage: 1_000_000, bossDamage: 250_000, rankedPerfectRounds: 15 };
const match = (id, teamWin = true, difficulty = 'NORMAL') => ({
  matchId: id.toString(16).padStart(32, '0'), difficulty, teamWin, startingParticipantCount: 4,
});
function seeded(opts = {}, values = {}) {
  const store = new RankedStore({ now: () => 123456, ...opts });
  Object.assign(store.ensure(aid, who.name), { placementDone: true, placementPlayed: 3, points: 900, wins: 100, matches: 110, ...values });
  return store;
}

test('old lifetime wins are not imported; first new settlement uses ending rank color', () => {
  const store = seeded({}, { points: 1490, wins: 1000 });
  assert.equal(store.summary(aid).rankPyramid, null);
  const result = store.settleMatch(who, match(1), strong);
  const pyramid = store.summary(aid).rankPyramid;
  assert.equal(result.iconAfter, 'diamond_1');
  assert.equal(pyramid.startedAt, 123456);
  assert.equal(pyramid.totalWins, 1);
  assert.equal(pyramid.lastWins, 1001);
  assert.equal(pyramid.earned[0].icon, result.iconAfter);
  assert.equal(pyramid.earned[0].tier, 1);
  assert.equal(rankPyramidMiniView(pyramid), null);
});

test('placement victories without a rank do not fill or reserve pyramid slots', () => {
  const store = new RankedStore({ file: null, now: () => 123456 });
  for (let i = 1; i <= 2; i++) {
    store.settleMatch(who, match(i), strong);
    const state = store.summary(aid).rankPyramid;
    assert.equal(store.profile(aid).wins, i);
    assert.equal(state.lastWins, i);
    assert.equal(state.totalWins, 0);
    assert.deepEqual(state.earned, []);
  }
  // The final placement win has a real ending tier, so it is the first filled slot.
  store.settleMatch(who, match(3), strong);
  assert.equal(store.profile(aid).placementDone, true);
  assert.equal(store.summary(aid).rankPyramid.totalWins, 1);
  for (let i = 4; i <= 10; i++) store.settleMatch(who, match(i), strong);
  const beforeUnlock = store.summary(aid).rankPyramid;
  assert.equal(store.profile(aid).wins, 10);
  assert.equal(beforeUnlock.totalWins, 8);
  assert.equal(beforeUnlock.earned.filter(entry => entry.icon !== 'unranked').length, 8);
  assert.equal(rankPyramidMiniView(beforeUnlock), null);
  store.settleMatch(who, match(11), strong);
  const unlocked = store.summary(aid).rankPyramid;
  assert.equal(unlocked.totalWins, 9);
  assert.equal(rankPyramidMiniView(unlocked).rows.flat().filter(Boolean).length, 9);
  store.settleMatch(who, match(11), strong);
  assert.deepEqual(store.summary(aid).rankPyramid, unlocked);
});

test('each authoritative match keeps its own ending rank, including a newly promoted tier', () => {
  const store = seeded({}, { points: 1480 });
  const first = store.settleMatch(who, match(1), strong);
  store.profile(aid).points = 1790;
  const second = store.settleMatch(who, match(2), strong);
  const pyramid = store.summary(aid).rankPyramid;
  assert.equal(first.iconAfter, 'diamond_1');
  assert.equal(second.iconAfter, 'ascendant_1');
  assert.deepEqual(pyramid.earned.map(cell => cell.icon), ['ascendant_1', 'diamond_1']);
  assert.equal(pyramid.totalWins, 2);
});

test('fifty-first positive settlement preserves the best 49 cells and total qualifying progress', () => {
  const store = seeded({}, { points: 0 });
  for (let i = 1; i <= 49; i++) {
    store.profile(aid).points = 0;
    assert.ok(store.settleMatch(who, match(i), strong).totalDelta > 0);
  }
  store.profile(aid).points = 1500;
  store.settleMatch(who, match(50), strong);
  store.profile(aid).points = 300;
  store.settleMatch(who, match(51), strong);
  const pyramid = store.summary(aid).rankPyramid;
  assert.equal(pyramid.earned.length, 49);
  assert.equal(pyramid.totalWins, 51);
  assert.equal(pyramid.earned[0].icon, 'diamond_1');
  assert.equal(pyramid.earned[1].icon, 'bronze_1');
  assert.equal(pyramid.earned.filter(cell => cell.icon === 'iron_1').length, 47);
  assert.deepEqual(rankPyramidView(pyramid).rows.map(row => row.length), [1, 3, 5, 7, 9, 11, 13]);
  assert.equal(rankPyramidMiniView(pyramid).rows.flat().length, 9);
});

test('positive-score defeat fills one cell without changing victory statistics or replaying progress', () => {
  const store = seeded({}, { points: 900 });
  const wins = store.profile(aid).wins;
  const result = store.settleMatch(who, match(1, false), strong);
  assert.ok(result.totalDelta > 0);
  assert.equal(store.profile(aid).wins, wins);
  assert.equal(store.summary(aid).rankPyramid.totalWins, 1);
  assert.equal(store.summary(aid).rankPyramid.earned[0].icon, result.iconAfter);
  const pyramid = store.summary(aid).rankPyramid;
  assert.deepEqual(store.settleMatch(who, match(1, false), strong), result);
  assert.deepEqual(store.summary(aid).rankPyramid, pyramid);
});

test('zero-score victory and negative-score result do not fill cells', () => {
  const store = seeded({}, { points: 900 });
  const zero = { alive: true, roundsPassed: 0, survivalRounds: 0, layers: 0, assists: 0 };
  const emptyWin = store.settleMatch(who, match(1), zero);
  assert.equal(emptyWin.totalDelta, 0);
  assert.equal(store.summary(aid).rankPyramid.totalWins, 0);
  store.profile(aid).points = 2100;
  const loss = store.settleMatch(who, match(2, false), { ...zero, alive: false });
  assert.ok(loss.totalDelta < 0);
  assert.equal(store.summary(aid).rankPyramid.earned.length, 0);
});

test('a positive-scoring final placement loss starts progress at its real ending tier', () => {
  const store = new RankedStore({ file: null, now: () => 123456 });
  for (let id = 1; id <= 2; id++) {
    const result = store.settleMatch(who, match(id, false), strong);
    assert.equal(result.totalDelta, 0);
    assert.equal(store.summary(aid).rankPyramid.totalWins, 0);
  }
  const result = store.settleMatch(who, match(3, false), strong);
  assert.ok(result.totalDelta > 0);
  assert.equal(store.profile(aid).wins, 0);
  assert.equal(store.summary(aid).rankPyramid.totalWins, 1);
  assert.equal(store.summary(aid).rankPyramid.earned[0].icon, result.iconAfter);
});

test('failed settlement records an observed peak but never a victory cell', () => {
  const store = seeded({}, { points: 2100 });
  store.settleMatch(who, match(1, false), { ...strong, alive: false, survivalRounds: 2 });
  const pyramid = store.summary(aid).rankPyramid;
  assert.equal(pyramid.totalWins, 0);
  assert.equal(pyramid.earned.length, 0);
  assert.equal(pyramid.best.icon, 'immortal_1');
  assert.equal(pyramid.best.globalRank, 1);
});

test('replayed match settlement cannot duplicate pyramid progress or alter its start time', () => {
  let now = 123456;
  const store = seeded({ now: () => now });
  const first = store.settleMatch(who, match(1), strong);
  const pyramid = store.summary(aid).rankPyramid;
  now += 9000;
  const replay = store.settleMatch(who, match(1), strong);
  assert.deepEqual(replay, first);
  assert.deepEqual(store.summary(aid).rankPyramid, pyramid);
});

test('pyramid state survives flush and store reload; replay remains idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronghold-rank-pyramid-'));
  try {
    const file = join(dir, 'ranked.json');
    const store = seeded({ file });
    store.settleMatch(who, match(1), strong);
    await store.flush();
    const recovered = new RankedStore({ file });
    assert.deepEqual(recovered.summary(aid).rankPyramid, store.summary(aid).rankPyramid);
    recovered.settleMatch(who, match(1), strong);
    assert.equal(recovered.summary(aid).rankPyramid.totalWins, 1);
    await recovered.flush();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('summary is read-only and standard or entertainment difficulty cannot start progress', () => {
  const store = seeded();
  assert.equal(store.summary('ffffffffffffffff').rankPyramid, null);
  assert.equal(store.summary(aid).rankPyramid, null);
  assert.equal(store.profile(aid).rankPyramid, null);
  for (const difficulty of ['FUNNY', 'STANDARD']) {
    assert.equal(store.settleMatch(who, match(1, true, difficulty), strong), null);
    assert.equal(store.profile(aid).rankPyramid, null);
  }
  const unranked = new RankedStore();
  unranked.ensure(aid, who.name);
  assert.equal(unranked.summary(aid).rankPyramid, null);
});

test('cleanRankPyramid returns detached snapshots and retains the start timestamp', () => {
  const store = seeded();
  store.settleMatch(who, match(1), strong);
  const clean = cleanRankPyramid(store.profile(aid).rankPyramid);
  assert.equal(clean.startedAt, 123456);
  clean.earned[0].icon = 'radiant';
  assert.notEqual(store.profile(aid).rankPyramid.earned[0].icon, 'radiant');
});
