import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPECIAL_GOOD_BOY_CARD, SPECIAL_TRICKSTER_CARD, canUseSpecialNameCard } from '../shared/nameCards.js';
import { defaultPresentation, checkPresentation } from '../shared/protocol.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { AccountAuth } from '../server/accountAuth.js';
import { createAuthority } from '../server/profileService.js';
import { ProfileReplication } from '../server/profileReplication.js';
import { TRICKSTER_GRANT_MIGRATION } from '../server/nameCardUnlocks.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';
const selected = (card) => ({ v: 1, value: { ...defaultPresentation(), card } });

test('two special name cards are separate entitlements', async () => {
  const ranked = new RankedStore();
  ranked.grantSpecialNameCard(A);
  assert.deepEqual(ranked.summary(A).unlockedNameCards, [SPECIAL_GOOD_BOY_CARD]);
  assert.equal(canUseSpecialNameCard(ranked.summary(A), SPECIAL_TRICKSTER_CARD), false);
  assert.equal(checkPresentation(selected(SPECIAL_TRICKSTER_CARD).value, () => null, {}).ok, true);
  const authority = createAuthority({ players: new PlayerStore(), ranked, history: new HistoryStore() }, { local: true });
  await assert.rejects(authority.call('presentation', [A, selected(SPECIAL_TRICKSTER_CARD), false]), /名片尚未永久解锁/);
});

test('first primary startup freezes existing account and profile aids, replicates grants, and excludes future players', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trickster-name-card-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rankedFile = join(dir, 'ranked.json');
  const replicationFile = join(dir, 'replication.json');
  const accounts = new AccountAuth();
  const registered = await accounts.authenticate('registered-only', { action: 'register', password: 'test-password-only' });
  const stores = { players: new PlayerStore(), ranked: new RankedStore({ file: rankedFile }), history: new HistoryStore() };
  stores.players.record(A, 'old player');
  stores.ranked.grantSpecialNameCard(A);
  stores.ranked.ensure(B, 'old rank');
  stores.history.profiles.set(C, { aid: C, name: 'old history', items: [] });
  let authority = createAuthority(stores, { accounts, local: true });
  let replication = new ProfileReplication({ role: 'main', stores, file: replicationFile,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  const first = await authority.migrateTricksterNameCards();
  assert.equal(first.total, 4);
  assert.equal(first.granted.length, 4);
  assert.deepEqual(first.deferredAids, []);
  for (const id of [registered.aid, A, B, C]) {
    assert.equal(canUseSpecialNameCard(stores.ranked.summary(id), SPECIAL_TRICKSTER_CARD), true);
  }
  assert.equal(stores.ranked.nameCardGrantSnapshots[TRICKSTER_GRANT_MIGRATION].aids.length, 4);
  assert.equal(replication.state.nameCardGrantSnapshots[TRICKSTER_GRANT_MIGRATION].aids.length, 4);
  assert.equal(replication.state.log.length, 4);
  assert.equal(canUseSpecialNameCard(stores.ranked.summary(A)), true);
  const secondaryStores = { players: new PlayerStore(), ranked: new RankedStore(), history: new HistoryStore() };
  const secondary = new ProfileReplication({ role: 'secondary', stores: secondaryStores, execute: async () => {} });
  await secondary.initialize((request) => replication.bootstrap(request));
  assert.equal(canUseSpecialNameCard(secondaryStores.ranked.summary(registered.aid), SPECIAL_TRICKSTER_CARD), true);

  const newcomer = await accounts.authenticate('newcomer', { action: 'register', password: 'test-password-only' });
  stores.players.record(newcomer.aid, 'newcomer');
  const restartedStores = { players: stores.players, ranked: new RankedStore({ file: rankedFile }), history: stores.history };
  authority = createAuthority(restartedStores, { accounts, local: true });
  replication = new ProfileReplication({ role: 'main', stores: restartedStores, file: replicationFile,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  const second = await authority.migrateTricksterNameCards();
  assert.equal(second.total, 4);
  assert.deepEqual(second.granted, []);
  assert.equal(canUseSpecialNameCard(restartedStores.ranked.summary(newcomer.aid), SPECIAL_TRICKSTER_CARD), false);
  assert.equal(replication.state.log.length, 4);
  assert.equal(canUseSpecialNameCard(restartedStores.ranked.summary(A)), true);
});

test('an interrupted first grant resumes the durable cohort without adding later players', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trickster-name-card-interrupted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ranked.json');
  const players = new PlayerStore();
  players.record(A, 'before grant');
  let ranked = new RankedStore({ file });
  let authority = createAuthority({ players, ranked, history: new HistoryStore() }, { local: true });
  const flush = ranked.flush.bind(ranked);
  ranked.flush = async () => { await flush(); throw new Error('interrupted after cohort persisted'); };
  await assert.rejects(authority.migrateTricksterNameCards(), /interrupted/);
  players.record(B, 'after interruption');
  ranked = new RankedStore({ file });
  authority = createAuthority({ players, ranked, history: new HistoryStore() }, { local: true });
  const result = await authority.migrateTricksterNameCards();
  assert.deepEqual(result.granted, [A]);
  assert.equal(ranked.hasSpecialNameCard(A, SPECIAL_TRICKSTER_CARD), true);
  assert.equal(ranked.hasSpecialNameCard(B, SPECIAL_TRICKSTER_CARD), false);
});

test('owned-by-secondary player remains in frozen cohort until replica handoff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trickster-name-card-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'replication.json');
  const rankedFile = join(dir, 'ranked.json');
  let stores = { players: new PlayerStore(), ranked: new RankedStore({ file: rankedFile }), history: new HistoryStore() };
  stores.players.record(A, 'already here');
  let authority = createAuthority(stores, { local: true });
  let replication = new ProfileReplication({ role: 'main', stores, file,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  replication.state.owners[A] = { serverId: 'secondary' };
  const first = await authority.migrateTricksterNameCards();
  assert.deepEqual(first.deferredAids, [A]);
  assert.equal(replication.state.pendingNameCardUnlocks[A].migrations.includes(TRICKSTER_GRANT_MIGRATION), true);
  assert.equal(stores.ranked.hasSpecialNameCard(A, SPECIAL_TRICKSTER_CARD), false);

  stores = { ...stores, ranked: new RankedStore({ file: rankedFile }) };
  authority = createAuthority(stores, { local: true });
  replication = new ProfileReplication({ role: 'main', stores, file,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  replication.state.owners[A] = { serverId: 'main' };
  replication.save();
  await authority.retryDeferredNameCards();
  assert.equal(stores.ranked.hasSpecialNameCard(A, SPECIAL_TRICKSTER_CARD), true);
  assert.deepEqual(replication.state.pendingNameCardUnlocks, {});
  assert.equal((await authority.migrateTricksterNameCards()).granted.length, 0);
});

test('invalid grant metadata aborts startup without overwriting existing ranked profiles', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trickster-invalid-cohort-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ranked.json');
  for (const bad of [42, [], { [TRICKSTER_GRANT_MIGRATION]: { aids: ['invalid aid'] } }]) {
    const original = JSON.stringify({ version: 1, profiles: [{ aid: A, points: 2500 }],
      nameCardGrantSnapshots: bad });
    writeFileSync(file, original);
    assert.throws(() => new RankedStore({ file }), /invalid name card grant snapshot/);
    assert.equal(readFileSync(file, 'utf8'), original);
  }
});

test('replication cohort repairs a missing ranked copy and survives loss of the replication copy', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trickster-cohort-repair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ranked.json');
  const stores = { players: new PlayerStore(), ranked: new RankedStore({ file }), history: new HistoryStore() };
  stores.players.record(A, 'existing player');
  stores.players.record(B, 'new player after original snapshot');
  const authority = createAuthority(stores, { local: true });
  const replication = new ProfileReplication({ role: 'main', stores,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication = replication;
  replication.state.nameCardGrantSnapshots = { [TRICKSTER_GRANT_MIGRATION]: { createdAt: 1, aids: [A] } };
  await authority.migrateTricksterNameCards();
  assert.deepEqual(new RankedStore({ file }).nameCardGrantSnapshots[TRICKSTER_GRANT_MIGRATION].aids, [A]);

  const restarted = { ...stores, ranked: new RankedStore({ file }) };
  const nextAuthority = createAuthority(restarted, { local: true });
  nextAuthority.replication = new ProfileReplication({ role: 'main', stores: restarted,
    execute: (op, args) => nextAuthority.executeLocal(op, args, true) });
  assert.equal((await nextAuthority.migrateTricksterNameCards()).total, 1);
  assert.equal(restarted.ranked.hasSpecialNameCard(B, SPECIAL_TRICKSTER_CARD), false);
});

test('conflicting durable cohorts stop the migration before any grant', async () => {
  const stores = { players: new PlayerStore(), ranked: new RankedStore(), history: new HistoryStore() };
  await stores.ranked.freezeNameCardGrantSnapshot(TRICKSTER_GRANT_MIGRATION, [A]);
  const authority = createAuthority(stores, { local: true });
  authority.replication = new ProfileReplication({ role: 'main', stores,
    execute: (op, args) => authority.executeLocal(op, args, true) });
  authority.replication.state.nameCardGrantSnapshots = {
    [TRICKSTER_GRANT_MIGRATION]: { createdAt: 1, aids: [B] },
  };
  await assert.rejects(authority.migrateTricksterNameCards(), /冻结名单副本不一致/);
  assert.equal(stores.ranked.hasSpecialNameCard(A, SPECIAL_TRICKSTER_CARD), false);
  assert.equal(stores.ranked.hasSpecialNameCard(B, SPECIAL_TRICKSTER_CARD), false);
});

test('invalid replication cohort never falls back to rescanning current players', async () => {
  for (const bad of [null, [], { [TRICKSTER_GRANT_MIGRATION]: null }]) {
    const stores = { players: new PlayerStore(), ranked: new RankedStore(), history: new HistoryStore() };
    stores.players.record(B, 'future player');
    const replication = new ProfileReplication({ role: 'main', stores, execute: async () => {} });
    replication.state.nameCardGrantSnapshots = bad;
    await assert.rejects(replication.freezeNameCardGrantSnapshot(TRICKSTER_GRANT_MIGRATION, [B]), /冻结名单无效/);
    assert.deepEqual(stores.ranked.nameCardGrantSnapshots, {});
  }
});
