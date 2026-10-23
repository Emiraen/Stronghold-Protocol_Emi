import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVORI_RANK_NAME_CARDS, isSpecialNameCard, canUseSpecialNameCard } from '../shared/nameCards.js';
import { defaultPresentation, checkPresentation } from '../shared/protocol.js';
import { rankOf } from '../shared/ranks.js';
import { observeRankProgress } from '../shared/rankPyramid.js';
import { earnedRankNameCards } from '../server/nameCardUnlocks.js';
import { RankedStore } from '../server/rankedStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { createAuthority } from '../server/profileService.js';
import { Lobby } from '../server/lobby.js';

const aid = 'aaaaaaaaaaaaaaaa';
const cards = EVORI_RANK_NAME_CARDS.map((reward) => reward.card);
const evoriOnly = (value) => value.filter((card) => cards.includes(card));
const seed = (store, points, extra = {}, key = aid) => {
  const profile = store.sanitize({ aid: key, name: '段位纪念测试', placementDone: true, placementPlayed: 3, points, ...extra });
  store.profiles.set(key, profile);
  return profile;
};
const selected = (card) => ({ v: 1, value: { ...defaultPresentation(), card } });
const settlement = (store, key = 1, teamWin = false) => store.settleMatch({ aid, name: '段位纪念测试', playerId: 'p1' },
  { matchId: key.toString(16).padStart(32, '0'), difficulty: 'ABYSS', teamWin, startingParticipantCount: 4 },
  { alive: teamWin, roundsPassed: teamWin ? 15 : 1, survivalRounds: teamWin ? 15 : 1, layers: 0, assists: 0 });

test('Evori has five distinct locked card/avatar identities with the requested descriptions', () => {
  assert.equal(new Set(cards).size, 5);
  assert.deepEqual(EVORI_RANK_NAME_CARDS.map((reward) => reward.minimumDivision), ['gold', 'platinum', 'diamond', 'ascendant', 'immortal']);
  for (const reward of EVORI_RANK_NAME_CARDS) {
    assert.equal(reward.description, '段位纪念');
    assert.equal(isSpecialNameCard(reward.card), true);
    assert.equal(checkPresentation(selected(reward.card).value, () => null, {}).ok, true);
    assert.equal(canUseSpecialNameCard({ rank: rankOf(99999, 1) }, reward.card), false);
  }
});

test('current authoritative rank unlocks every reached milestone at the exact boundaries', () => {
  const store = new RankedStore();
  for (const [points, count] of [[0, 0], [899, 0], [900, 1], [1199, 1], [1200, 2], [1499, 2],
    [1500, 3], [1799, 3], [1800, 4], [2099, 4], [2100, 5], [3000, 5]]) {
    seed(store, points);
    assert.deepEqual(evoriOnly(store.summary(aid).unlockedNameCards), cards.slice(0, count), `points ${points}`);
    for (let index = 0; index < cards.length; index++) assert.equal(store.hasSpecialNameCard(aid, cards[index]), index < count);
  }
});

test('unranked raw points do not unlock rewards and nonexistent history is not reconstructed', () => {
  const store = new RankedStore();
  seed(store, 99999, { placementDone: false, matches: 999, wins: 999, placementScore: 99999 });
  assert.deepEqual(evoriOnly(store.summary(aid).unlockedNameCards), []);
  seed(store, 899, { matches: 999, wins: 999 });
  assert.deepEqual(evoriOnly(store.summary(aid).unlockedNameCards), []);
  assert.deepEqual(earnedRankNameCards(null), []);
});

test('already recorded peak unlocks lower milestones even after demotion', () => {
  const store = new RankedStore();
  const rankPyramid = observeRankProgress(null, { ranked: true, wins: 0, points: 1850, rank: rankOf(1850) });
  seed(store, 500, { rankPyramid });
  assert.deepEqual(evoriOnly(store.summary(aid).unlockedNameCards), cards.slice(0, 4));
  const profile = store.profile(aid);
  profile.rankPyramid = { ...rankPyramid, version: 999 };
  assert.deepEqual(earnedRankNameCards(profile), []);
});

test('reading automatic unlocks does not mutate accounts, queue grants or save profiles', () => {
  const store = new RankedStore();
  seed(store, 2100);
  const before = structuredClone([...store.profiles]);
  let saves = 0;
  store.save = () => { saves++; };
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(evoriOnly(store.summary(aid).unlockedNameCards), cards);
    assert.equal(store.hasSpecialNameCard(aid, cards[4]), true);
  }
  assert.equal(saves, 0);
  assert.deepEqual([...store.profiles], before);
  assert.deepEqual(store.nameCardGrantSnapshots, {});
});

test('the normal settlement transaction persists pre-loss entitlements, including a demotion', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evori-rank-rewards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ranked.json');
  writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ aid, placementDone: true, placementPlayed: 3, points: 2100 }] }));
  const original = readFileSync(file, 'utf8');
  const store = new RankedStore({ file });
  assert.deepEqual(evoriOnly(store.summary(aid).unlockedNameCards), cards);
  assert.equal(readFileSync(file, 'utf8'), original);
  const result = settlement(store);
  assert.ok(result.after < 2100);
  assert.deepEqual(evoriOnly(store.profile(aid).unlockedNameCards), cards);
  await store.flush();
  const loaded = new RankedStore({ file });
  loaded.profile(aid).points = 0;
  loaded.profile(aid).rankPyramid = null;
  assert.deepEqual(evoriOnly(loaded.summary(aid).unlockedNameCards), cards);
  assert.deepEqual(settlement(store), result);
  assert.equal(new Set(store.profile(aid).unlockedNameCards).size, store.profile(aid).unlockedNameCards.length);
});

test('new promotion unlocks within the existing settlement, with no separate grant command', () => {
  const store = new RankedStore();
  seed(store, 899);
  const result = settlement(store, 2, true);
  assert.ok(result.after >= 900);
  assert.deepEqual(evoriOnly(store.profile(aid).unlockedNameCards), cards.slice(0, 1));
  assert.deepEqual(store.nameCardGrantSnapshots, {});
});

test('server presentation authority enforces each rank milestone rather than trusting the client', async () => {
  const store = new RankedStore();
  seed(store, 900);
  const players = new PlayerStore();
  players.record(aid, '段位纪念测试');
  const authority = createAuthority({ players, ranked: store, history: {} }, { local: true });
  await authority.call('presentation', [aid, selected(cards[0]), false]);
  assert.equal(players.getPresentation(aid).value.card, cards[0]);
  for (const card of cards.slice(1)) await assert.rejects(authority.call('presentation', [aid, selected(card), false]), /永久解锁/);
  assert.equal(players.getPresentation(aid).value.card, cards[0]);
});

test('leaderboard score floor uses at least 450 mythic points until 50th entry exceeds it', () => {
  const store = new RankedStore();
  assert.deepEqual(store.radiantThreshold(), { points: 2550, mythicPoints: 450, cutoffRank: 50, cutoffPoints: null, minimumPoints: 2550 });
  for (let index = 0; index < 49; index++) seed(store, 4000 - index, {}, index.toString(16).padStart(16, '0'));
  assert.equal(store.radiantThreshold().mythicPoints, 450);
  seed(store, 2300, {}, 'fffffffffffffffe');
  assert.equal(store.radiantThreshold().mythicPoints, 450);
  seed(store, 2800, {}, 'fffffffffffffffe');
  assert.equal(store.radiantThreshold().mythicPoints, 700);
});

test('cutoff uses the 50th list slot even when the list contains tied positions', () => {
  const store = new RankedStore();
  const items = Array.from({ length: 51 }, (_, index) => ({ points: index < 48 ? 4000 - index : 2850, position: index < 48 ? index + 1 : 49 }));
  const before = structuredClone(items);
  assert.equal(store.radiantThreshold(items).mythicPoints, 750);
  assert.deepEqual(items, before);
  assert.equal(rankOf(2850, 49).division, 'radiant');
  assert.equal(rankOf(2850, 51).division, 'immortal');
});

test('rank.list publishes the threshold from the same list without altering items', async () => {
  const sent = [];
  const items = Array.from({ length: 50 }, (_, index) => ({ name: `玩家${index}`, points: 3000 - index, position: index + 1 }));
  const store = new RankedStore();
  const lobby = Object.create(Lobby.prototype);
  lobby.ranked = store;
  lobby.profiles = { leaderboard: async () => items };
  const session = { connected: true, ws: { readyState: 1, bufferedAmount: 0, send: (message) => sent.push(JSON.parse(message)) } };
  assert.deepEqual(await lobby.onMessage(session, { t: 'rank.list', rid: 7 }), { ok: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].items, items);
  assert.deepEqual(sent[0].radiantThreshold, store.radiantThreshold(items));
  assert.equal(sent[0].radiantThreshold.mythicPoints, 851);
});

test('rank.me notification identity uses canonical player profile id, not the aid', () => {
  const sent = [];
  const lobby = Object.create(Lobby.prototype);
  const players = new PlayerStore();
  players.record(aid, '段位纪念测试');
  Object.assign(lobby, { ranked: new RankedStore(), players, roomOf: () => null });
  lobby.sendRecoveredRank({ aid, name: '段位纪念测试', connected: true,
    ws: { readyState: 1, bufferedAmount: 0, send: (message) => sent.push(JSON.parse(message)) } });
  assert.equal(sent[0].t, 'rank.me');
  assert.equal(sent[0].profileId, players.profiles.get(aid).id);
  assert.notEqual(sent[0].profileId, aid);
});
