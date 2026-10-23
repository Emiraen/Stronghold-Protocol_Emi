import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankOf, rankBoundaries, normalizeRankLabel } from '../shared/ranks.js';
import { RankedStore } from '../server/rankedStore.js';

test('renamed radiant labels preserve historical scores and placement', () => {
  assert.equal(normalizeRankLabel('赋能战魂 450分 #50'), '源能战魂 450分 #50');
  assert.equal(normalizeRankLabel('神话三 450分 #51'), '神话三 450分 #51');
  assert.equal(normalizeRankLabel(null), null);
});

test('radiant requires both 450 mythic points and a valid global top-50 position', () => {
  assert.equal(rankOf(2549, 1).icon, 'immortal_3');
  assert.equal(rankOf(2550, 50).label, '源能战魂 450分');
  for (const position of [51, 0, -1, null, undefined, 1.5, '1']) {
    const rank = rankOf(3000, position);
    assert.equal(rank.icon, 'immortal_3');
    assert.equal(rank.divisionName, '神话');
    assert.equal(rank.label, '神话三 900分');
  }
  assert.equal(rankOf(100, 1).label, '黑铁二 0分');
  assert.equal(rankBoundaries().at(-1).icon, 'radiant');
  assert.equal(rankBoundaries().at(-1).from, 2550);
});

function fixture() {
  const store = new RankedStore({ file: null, now: () => 10_000 });
  for (let i = 1; i <= 51; i++) {
    const aid = i.toString(16).padStart(16, '0');
    store.profiles.set(aid, store.sanitize({ aid, name: `玩家${i}`, placementDone: true,
      points: i <= 49 ? 3000 + i : i === 50 ? 2551 : 2550, lastActive: i }));
  }
  return { store, cutoff: (50).toString(16).padStart(16, '0'), next: (51).toString(16).padStart(16, '0') };
}

test('summary and full leaderboard agree as players enter and leave the top 50', () => {
  const { store, cutoff, next } = fixture();
  assert.equal(store.summary(cutoff).rank.icon, 'radiant');
  assert.equal(store.summary(next).rank.label, '神话三 450分 #51');
  assert.equal(store.leaderboard().at(-1).rank.icon, 'immortal_3');
  store.profile(cutoff).points = 2549;
  assert.equal(store.summary(next).rank.label, '源能战魂 450分 #50');
  assert.equal(store.summary(cutoff).rank.icon, 'immortal_3');
  for (const item of store.leaderboard({ includeAid: true })) {
    const summary = store.summary(item.aid);
    assert.equal(item.rank.icon, summary.rank.icon);
    assert.equal(item.position, summary.globalRank);
  }
});

test('settlement uses standings before and after the score change without changing the scoring rule', () => {
  const { store, next } = fixture();
  const result = store.settleMatch({ aid: next, name: '玩家51' },
    { difficulty: 'ABYSS', teamWin: true, hiddenCleared: false },
    { alive: true, roundsPassed: 15, layers: 200, assists: 3, rankedDamage: 1_000_000 });
  assert.equal(result.tierBefore, '神话三 450分');
  assert.equal(result.globalRank, 50);
  assert.equal(result.iconAfter, 'radiant');
  assert.equal(store.summary(next).rank.icon, 'radiant');
});
