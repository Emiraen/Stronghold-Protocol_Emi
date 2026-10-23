import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIAL_GOOD_BOY_CARD, canUseSpecialNameCard } from '../shared/nameCards.js';
import { checkPresentation, defaultPresentation } from '../shared/protocol.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { createAuthority, cardSkinForPresentation } from '../server/profileService.js';
import { Lobby } from '../server/lobby.js';
import { AccountAuth } from '../server/accountAuth.js';
import { ProfileReplication } from '../server/profileReplication.js';
import { HistoryStore } from '../server/historyStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const aid = 'aaaaaaaaaaaaaaaa';
const selected = () => ({ v: 1, value: { ...defaultPresentation(), card: SPECIAL_GOOD_BOY_CARD } });

test('special card protocol reads permanent unlocks independently of current division', () => {
  assert.equal(checkPresentation(selected().value, () => null, {}).ok, true);
  assert.equal(checkPresentation({ ...selected().value, card: 'unknown_card' }, () => null, {}).error, 'BAD_TARGET');
  for (const division of [null, 'immortal', 'ascendant', 'invented_future_rank']) {
    assert.equal(canUseSpecialNameCard({ rank: { division, points: 99999 } }), false);
  }
  assert.equal(canUseSpecialNameCard({ rank: { division: 'radiant' } }), false);
  assert.equal(canUseSpecialNameCard({ rank: { division: 'iron' }, unlockedNameCards: [SPECIAL_GOOD_BOY_CARD] }), true);
  assert.equal(cardSkinForPresentation(SPECIAL_GOOD_BOY_CARD, { portraits: { [`char:${SPECIAL_GOOD_BOY_CARD}`]: 'e2' } }, {}), '');
});

test('authority persists earned unlocks across demotion, switching cards, renames and reload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'special-name-card-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const players = new PlayerStore();
  const file = join(dir, 'ranked.json');
  const ranked = new RankedStore({ file });
  players.record(aid, 'player');
  const authority = createAuthority({ players, ranked, history: {} }, { local: true });
  await assert.rejects(authority.call('presentation', [aid, selected(), false]), /永久解锁/);
  assert.equal(players.getPresentation(aid), null);
  ranked.profiles.set(aid, ranked.sanitize({ aid, points: 2600, placementDone: true }));
  await authority.call('presentation', [aid, selected(), false]);
  assert.equal(players.getPresentation(aid).value.card, SPECIAL_GOOD_BOY_CARD);
  for (let i = 0; i < 50; i++) {
    const other = `competitor_${i}`;
    ranked.profiles.set(other, ranked.sanitize({ aid: other, points: 2700, placementDone: true }));
  }
  assert.equal(ranked.summary(aid).rank.division, 'immortal');
  await authority.call('presentation', [aid, { v: 1, value: { ...defaultPresentation(), card: '' } }, false]);
  await authority.call('presentation', [aid, selected(), false]);
  assert.equal(canUseSpecialNameCard(ranked.summary(aid)), true);
  // Ordinary operator cards keep the existing persistence path at every rank.
  await authority.call('presentation', [aid, { v: 1, value: { ...defaultPresentation(), card: 'char_test' } }, false]);
  assert.equal(players.getPresentation(aid).value.card, 'char_test');
  await authority.call('presentation', [aid, selected(), false]);
  ranked.profiles.get(aid).points = 2400;
  // Existing cards remain readable and editable after rank changes.
  assert.equal((await authority.call('read', [aid])).player.presentation.value.card, SPECIAL_GOOD_BOY_CARD);
  const changedVoice = selected();
  changedVoice.value.voice.volume = 0.3;
  await authority.call('presentation', [aid, changedVoice, false]);
  assert.equal(players.getPresentation(aid).value.voice.volume, 0.3);
  assert.equal(players.getPresentation(aid).value.card, SPECIAL_GOOD_BOY_CARD);
  // Switching away retains the permanent unlock.
  await authority.call('presentation', [aid, { v: 1, value: { ...defaultPresentation(), card: '' } }, false]);
  await authority.call('presentation', [aid, selected(), false]);
  ranked.ensure(aid, 'renamed');
  ranked.save();
  await ranked.flush();
  assert.equal(canUseSpecialNameCard(new RankedStore({ file }).summary(aid)), true);
  const blocked = 'bbbbbbbbbbbbbbbb';
  players.record(blocked, 'never radiant');
  ranked.profiles.set(blocked, ranked.sanitize({ aid: blocked, points: 2600, placementDone: true }));
  let mutations = 0;
  authority.replication = { transact() { mutations++; } };
  await assert.rejects(authority.call('presentation', [blocked, selected(), false]), /永久解锁/);
  assert.equal(mutations, 0);
  await assert.rejects(authority.call('rank.nameCards', [blocked, null]), /主服内部/);
  await ranked.flush();
});

test('room selection trusts the profile authority instead of a radiant local display cache', async () => {
  const session = { aid, playerId: 'p', skins: {}, portraits: {} };
  const seat = { card: '', cardSkin: '' };
  const room = { seatOf: () => seat };
  let broadcast = 0;
  const lobby = Object.create(Lobby.prototype);
  Object.assign(lobby, {
    roomOf: () => room, safeData: () => ({ chess: {} }),
    ranked: { summary: () => ({ rank: { division: 'radiant' } }) },
    profiles: { canSelectNameCard: async () => false },
    broadcastState: () => { broadcast++; },
  });
  assert.equal((await lobby.setCard(session, { charId: SPECIAL_GOOD_BOY_CARD })).error, 'BAD_TARGET');
  assert.equal(seat.card, '');
  lobby.profiles.canSelectNameCard = async () => true;
  assert.equal((await lobby.setCard(session, { charId: SPECIAL_GOOD_BOY_CARD })).ok, true);
  assert.equal(seat.card, SPECIAL_GOOD_BOY_CARD);
  assert.equal(seat.cardSkin, '');
  assert.equal(broadcast, 1);
  lobby.profiles.canSelectNameCard = async () => false;
  assert.equal((await lobby.setCard(session, { charId: SPECIAL_GOOD_BOY_CARD })).error, 'BAD_TARGET');
  assert.equal(broadcast, 1);
});

test('presentation edits retain an already selected special card without rechecking rank', async () => {
  let stored = selected();
  let permissionChecks = 0;
  const session = { aid, playerId: 'p', profileBound: true };
  const lobby = Object.create(Lobby.prototype);
  Object.assign(lobby, {
    players: { profiles: new Map([[aid, { id: 'profile' }]]), getPresentation: () => stored },
    profiles: {
      canSelectNameCard: async () => { permissionChecks++; return false; },
      setPresentation: async (_aid, value) => { stored = value; },
    },
    safeData: () => ({}), registry: { all: () => [] },
  });
  const value = selected().value;
  value.voice.volume = 0.2;
  assert.equal((await lobby.profilePresentation(session, { v: 1, profileId: 'profile', value })).ok, true);
  assert.equal(stored.value.voice.volume, 0.2);
  assert.equal(permissionChecks, 0);
  stored = { v: 1, value: { ...defaultPresentation(), card: '' } };
  assert.equal((await lobby.profilePresentation(session, { v: 1, profileId: 'profile', value })).error, 'BAD_TARGET');
  assert.equal(permissionChecks, 1);
});

test('startup grants current radiant and the three resolved aids once, without historic inference', async () => {
  const stores = { players: new PlayerStore(), ranked: new RankedStore(), history: new HistoryStore() };
  const accounts = new AccountAuth();
  const assigned = [];
  for (const name of ['味精', '迷路', 'Emiraen']) {
    const identity = await accounts.authenticate(name, { action: 'register', password: 'test-password-only' }, stores);
    assigned.push(identity.aid);
    stores.players.record(identity.aid, name);
  }
  stores.players.record(aid, 'current radiant');
  stores.ranked.profiles.set(aid, stores.ranked.sanitize({ aid, name: 'current radiant', points: 2600, placementDone: true }));
  const historical = 'bbbbbbbbbbbbbbbb';
  stores.ranked.profiles.set(historical, stores.ranked.sanitize({ aid: historical, points: 2400, placementDone: true,
    settlements: { [`${'1'.repeat(32)}:p`]: { after: 2600, globalRank: 1, placementDone: true, iconAfter: 'radiant' } } }));
  const authority = createAuthority(stores, { accounts, local: true });
  const replication = new ProfileReplication({ role: 'main', stores,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  const report = await authority.migrateNameCards();
  assert.deepEqual(report.unresolvedNames, []);
  for (const id of [aid, ...assigned]) assert.equal(canUseSpecialNameCard(stores.ranked.summary(id)), true);
  assert.equal(canUseSpecialNameCard(stores.ranked.summary(historical)), false);
  assert.equal(replication.state.log.length, 4);
  const replicaStores = { players: new PlayerStore(), ranked: new RankedStore(), history: new HistoryStore() };
  const replica = new ProfileReplication({ role: 'secondary', stores: replicaStores, execute: async () => {} });
  await replica.initialize((request) => replication.bootstrap(request));
  for (const id of assigned) assert.equal(canUseSpecialNameCard(replicaStores.ranked.summary(id)), true);
  stores.players.profiles.get(assigned[0]).name = 'renamed';
  stores.ranked.profiles.get(assigned[0]).name = 'renamed';
  const replacement = 'cccccccccccccccc';
  stores.players.record(replacement, '味精');
  const restartedAuthority = createAuthority(stores, { accounts: new AccountAuth(), local: true });
  const second = await restartedAuthority.migrateNameCards();
  assert.deepEqual(second.granted, []);
  assert.equal(canUseSpecialNameCard(stores.ranked.summary(replacement)), false);
  assert.equal(stores.ranked.profile(assigned[0]).nameCardGrantMigrations.length, 1);
});

test('a player promoted into the top fifty by another settlement receives a replicated unlock', async () => {
  const stores = { players: new PlayerStore(), ranked: new RankedStore(), history: new HistoryStore() };
  const other = 'bbbbbbbbbbbbbbbb';
  for (let i = 0; i < 49; i++) {
    const id = (i + 16).toString(16).padStart(16, '0');
    stores.ranked.profiles.set(id, stores.ranked.sanitize({ aid: id, points: 2700, placementDone: true }));
  }
  stores.ranked.profiles.set(aid, stores.ranked.sanitize({ aid, points: 2551, placementDone: true }));
  stores.ranked.profiles.set(other, stores.ranked.sanitize({ aid: other, points: 2550, placementDone: true }));
  assert.equal(stores.ranked.globalRank(other), 51);
  const authority = createAuthority(stores, { local: true });
  const replication = new ProfileReplication({ role: 'main', stores,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  await authority.call('complete', [{ match: { matchId: '2'.repeat(32), difficulty: 'ABYSS', mode: 'coop', teamWin: false },
    at: 1, ranked: true, seats: [{ aid, playerId: 'p', name: 'player' }],
    entries: [{ who: { aid, playerId: 'p', name: 'player' }, row: { alive: false, roundsPassed: 1, survivalRounds: 1 } }],
    result: { mode: 'coop', difficulty: 'ABYSS', players: [{ playerId: 'p' }] } }]);
  assert.equal(stores.ranked.globalRank(other), 50);
  assert.equal(canUseSpecialNameCard(stores.ranked.summary(other)), true);
  assert.equal(replication.state.log.some((entry) => entry.patch.aid === other && entry.patch.fields.rank), true);
});

test('deferred earned and named grants survive restart and retry after shared-write owner handoff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'name-card-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'replication.json');
  const stores = { players: new PlayerStore(), ranked: new RankedStore(), history: new HistoryStore() };
  const other = 'bbbbbbbbbbbbbbbb';
  stores.players.record(aid, '味精');
  stores.players.record(other, 'ordinary radiant');
  for (const id of [aid, other]) stores.ranked.profiles.set(id,
    stores.ranked.sanitize({ aid: id, points: 2600, placementDone: true }));
  let authority = createAuthority(stores, { local: true });
  let replication = new ProfileReplication({ role: 'main', file, stores,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  for (const id of [aid, other]) replication.state.owners[id] = { serverId: 'secondary' };
  const deferred = await authority.migrateNameCards();
  assert.equal(deferred.deferredAids.includes(aid), true);
  assert.equal(replication.state.pendingNameCardUnlocks[other].earned, true);
  assert.equal(stores.ranked.hasSpecialNameCard(aid), false);
  // The already observed achievement remains valid while the old owner finishes syncing.
  for (const id of [aid, other]) stores.ranked.profiles.get(id).points = 2400;
  authority = createAuthority(stores, { local: true });
  replication = new ProfileReplication({ role: 'main', file, stores,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  const heartbeat = { serverId: 'secondary', leases: [], sample: { bandwidthMbps: 3, bytesPerSecond: 0 },
    replication: { id: '11111111-1111-4111-8111-111111111111', cursor: 0, pending: [], releases: [], sharedWrites: true } };
  await Promise.all([authority.call('region.heartbeat', [heartbeat]), authority.call('region.heartbeat', [heartbeat])]);
  for (const id of [aid, other]) {
    assert.equal(replication.state.owners[id].serverId, 'main');
    assert.equal(stores.ranked.hasSpecialNameCard(id), true);
  }
  assert.equal(stores.ranked.profile(aid).nameCardGrantMigrations.includes('good-boy-legacy-v1:weijing'), true);
  assert.deepEqual(replication.state.pendingNameCardUnlocks, {});
  assert.equal(replication.state.log.length, 3);
});
