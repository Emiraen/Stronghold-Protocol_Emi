import test from 'node:test';
import assert from 'node:assert/strict';
import { RankedStore } from '../server/rankedStore.js';
import { RANK_INACTIVITY_MS, RADIANT_POINTS } from '../shared/ranks.js';

const now = Date.UTC(2026, 9, 25, 10);
function seed(store, name, points, inactive = false, extra = {}) {
  const aid = name.padEnd(16, '_');
  store.profiles.set(aid, store.sanitize({ aid, name, points, wins: 7, placementDone: true,
    lastActive: now - 1, lastScoredAt: now - (inactive ? RANK_INACTIVITY_MS : 1), ...extra }));
  return aid;
}

test('inactive players follow all active players without taking a rank or changing score', () => {
  const store = new RankedStore({ now: () => now });
  const hidden = seed(store, 'hidden', 9000, true);
  const first = seed(store, 'first', 2800);
  const tied = seed(store, 'tied', 2800);
  const third = seed(store, 'third', 2400);
  seed(store, 'below', 2000);
  seed(store, 'placement', 9999, false, { placementDone: false });
  const list = store.leaderboard({ includeAid: true });
  assert.deepEqual(list.map(({ aid, position }) => [aid, position]), [[first, 1], [tied, 1], [third, 3], [hidden, null]]);
  assert.equal(store.globalRank(hidden), null);
  assert.equal(store.globalRank(third), 3);
  assert.deepEqual(list.at(-1), { aid: hidden, inactive: true, position: null, name: 'hidden',
    points: 9000, wins: 7, unlockedNameCards: store.unlockedNameCards(hidden),
    rank: { icon: store.summary(hidden).rank.icon, label: '神话一' } });
  assert.equal(store.currentRadiantAids().includes(hidden), false);
  assert.ok(store.leaderboard().every((entry) => !Object.hasOwn(entry, 'aid')));
});

test('inactive entries never raise the fiftieth-player threshold', () => {
  const store = new RankedStore({ now: () => now });
  for (let i = 0; i < 49; i++) seed(store, `active${i}`, 4000 - i);
  seed(store, 'hidden', 9000, true);
  assert.equal(store.radiantThreshold().cutoffPoints, null);
  assert.equal(store.radiantThreshold().points, RADIANT_POINTS);
  seed(store, 'fiftieth', 2800);
  assert.equal(store.radiantThreshold().cutoffPoints, 2800);
  assert.equal(store.radiantThreshold().points, 2800);
});

test('an all-inactive leaderboard has no ranked positions or radiant qualifiers', () => {
  const store = new RankedStore({ now: () => now });
  seed(store, 'hidden1', 9000, true);
  seed(store, 'hidden2', 3000, true);
  assert.ok(store.leaderboard().every((entry) => entry.position === null && entry.inactive && entry.rank.label === '神话一'));
  assert.deepEqual(store.currentRadiantAids(), []);
  assert.equal(store.radiantThreshold().cutoffPoints, null);
});

test('a scored timestamp restores the existing ranking eligibility without score loss', () => {
  const store = new RankedStore({ now: () => now });
  const aid = seed(store, 'returning', 3000, true);
  seed(store, 'active', 2800);
  store.profile(aid).lastScoredAt = now;
  const entry = store.leaderboard({ includeAid: true })[0];
  assert.equal(entry.aid, aid);
  assert.equal(entry.position, 1);
  assert.equal(entry.inactive, undefined);
  assert.equal(entry.points, 3000);
  assert.equal(store.globalRank(aid), 1);
});
