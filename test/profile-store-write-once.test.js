import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore, StoreWriter } from '../server/historyStore.js';
import { ProfileReplication } from '../server/profileReplication.js';
import { createAuthority } from '../server/profileService.js';
import { defaultPresentation } from '../shared/protocol.js';

const AID = 'a'.repeat(32);
const MID = '1'.repeat(32);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stronghold-store-write-once-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function open() {
    const stores = { players: new PlayerStore({ file: join(dir, 'players.json') }),
      ranked: new RankedStore({ file: join(dir, 'ranked.json') }), history: new HistoryStore({ file: join(dir, 'history.json') }) };
    const authority = createAuthority(stores, { local: true });
    const replication = new ProfileReplication({ role: 'main', stores, file: join(dir, 'replication.json'),
      execute: (op, args) => authority.executeLocal(op, args, true) });
    authority.replication = replication;
    const snapshots = { players: 0, ranked: 0, history: 0 };
    for (const [name, store] of Object.entries(stores)) {
      const snapshot = store.writer.snapshot;
      store.writer.snapshot = () => { snapshots[name]++; return snapshot(); };
    }
    return { stores, replication, snapshots, disk: () => JSON.parse(readFileSync(replication.file, 'utf8')) };
  }
  return { dir, open };
}

test('a locally flushed record or presentation serializes the players store once before durable ACK', async (t) => {
  const { open } = fixture(t), env = open();
  await env.replication.transact('record', [AID, 'one-write']);
  assert.equal(env.snapshots.players, 1);
  assert.equal(env.disk().commit, undefined);
  assert.equal(new PlayerStore({ file: env.stores.players.file }).profiles.get(AID).name, 'one-write');
  await env.replication.transact('record', [AID, 'one-write']);
  assert.equal(env.snapshots.players, 1, 'unchanged records do not serialize a clean store');
  const selected = { v: 1, value: defaultPresentation() };
  await env.replication.transact('presentation', [AID, selected]);
  assert.equal(env.snapshots.players, 2, 'synchronous presentation write is not followed by a second full rewrite');
  assert.deepEqual(new PlayerStore({ file: env.stores.players.file }).getPresentation(AID), selected);
});

test('a history transaction writes once and its idempotent retry never rewrites the store', async (t) => {
  const { open } = fixture(t), env = open();
  const seats = [{ aid: AID, playerId: 'p1', name: 'one-write', isBot: false }];
  const job = { matchId: MID, at: Date.now(), ranked: false, seats,
    summary: { mode: 'solo', difficulty: 'NORMAL', players: [{ playerId: 'p1', name: 'one-write', victory: true, roundsPassed: 3 }] } };
  await env.replication.transact('historyRecord', [job]);
  assert.equal(env.snapshots.history, 1);
  await env.replication.transact('historyRecord', [job]);
  assert.equal(env.snapshots.history, 1);
  assert.equal(new HistoryStore({ file: env.stores.history.file }).list(AID).length, 1);
});

test('a ranked transaction reuses the first durable writes of both affected stores', async (t) => {
  const { open } = fixture(t), env = open();
  env.replication.execute = async () => {
    env.stores.ranked.profiles.set(AID, { aid: AID, points: 25, settlements: {} });
    env.stores.ranked.save();
    await env.stores.ranked.flush();
    env.stores.history.profiles.set(AID, { name: 'one-write', items: [] });
    env.stores.history.save();
    await env.stores.history.flush();
  };
  await env.replication.transact('complete', [{ ranked: true, seats: [{ aid: AID, isBot: false }] }]);
  assert.deepEqual(env.snapshots, { players: 0, ranked: 1, history: 1 });
  assert.equal(env.disk().commit, undefined);
  assert.equal(new RankedStore({ file: env.stores.ranked.file }).profiles.get(AID).points, 25);
});

test('a failed final flush retains a durable commit, and a restarted writer replays a stale store', async (t) => {
  const { open } = fixture(t), env = open();
  const originalFlush = env.stores.players.flush.bind(env.stores.players);
  let flushes = 0;
  env.stores.players.flush = async () => {
    if (++flushes === 2) throw new Error('injected final flush failure');
    return originalFlush();
  };
  await assert.rejects(env.replication.transact('record', [AID, 'durable']), /injected final flush failure/);
  assert.equal(env.disk().commit.patches[0].fields.identity.name, 'durable');
  writeFileSync(env.stores.players.file, JSON.stringify({ version: 1, profiles: [] }));
  const restarted = open();
  assert.equal(restarted.replication.initialized, false);
  await restarted.replication.recover();
  assert.equal(restarted.snapshots.players, 1, 'restart has no in-memory proof and must rewrite the commit');
  assert.equal(new PlayerStore({ file: env.stores.players.file }).profiles.get(AID).name, 'durable');
  assert.equal(restarted.disk().commit, undefined);
  assert.equal(restarted.replication.initialized, true);
});

test('an executor that never saved its mutation cannot reuse a previously persisted revision', async (t) => {
  const { open } = fixture(t), env = open();
  await env.replication.transact('record', [AID, 'before']);
  const before = env.snapshots.players;
  env.replication.execute = async () => { env.stores.players.profiles.get(AID).name = 'after'; };
  await env.replication.transact('record', [AID, 'after']);
  assert.equal(env.snapshots.players, before + 1);
  assert.equal(new PlayerStore({ file: env.stores.players.file }).profiles.get(AID).name, 'after');
});

test('saving an intermediate value does not prove an unsaved final commit was persisted', async (t) => {
  const { open } = fixture(t), env = open();
  env.replication.execute = async () => {
    env.stores.players.record(AID, 'intermediate');
    await env.stores.players.flush();
    env.stores.players.profiles.get(AID).name = 'final';
  };
  await env.replication.transact('record', [AID, 'final']);
  assert.equal(env.snapshots.players, 2, 'the final unsaved value needs commit replay');
  assert.equal(new PlayerStore({ file: env.stores.players.file }).profiles.get(AID).name, 'final');
  assert.equal(env.disk().commit, undefined);
  for (const store of Object.values(env.stores)) assert.equal(store.writer.persistenceObservers.size, 0);
});

test('a failed execution removes persistence observers before retry', async (t) => {
  const { open } = fixture(t), env = open();
  env.replication.execute = async () => { throw new Error('injected execution failure'); };
  await assert.rejects(env.replication.transact('record', [AID, 'unused']), /injected execution failure/);
  for (const store of Object.values(env.stores)) assert.equal(store.writer.persistenceObservers.size, 0);
  assert.equal(env.disk().intent, undefined);
});

test('an asynchronous write proves its serialized value rather than memory at rename time', async (t) => {
  const { open } = fixture(t), env = open();
  env.replication.execute = async () => {
    env.stores.history.profiles.set(AID, { name: 'intermediate', items: [] });
    env.stores.history.save();
    await new Promise((resolve) => setImmediate(resolve));
    env.stores.history.profiles.get(AID).name = 'final';
    await env.stores.history.flush();
  };
  await env.replication.transact('historyRecord', [{ seats: [{ aid: AID, isBot: false }] }]);
  assert.equal(env.snapshots.history, 2, 'a completed write of the intermediate state cannot ACK the final state');
  const disk = JSON.parse(readFileSync(env.stores.history.file, 'utf8'));
  assert.equal(disk.profiles.find((profile) => profile.aid === AID).name, 'final');
  assert.equal(env.disk().commit, undefined);
});

test('commit replay does not reuse a file whose target fields changed after execution', async (t) => {
  const { open } = fixture(t), env = open();
  const finish = env.replication.finishIntent.bind(env.replication);
  env.replication.finishIntent = async () => {
    const value = await finish();
    env.stores.players.profiles.get(AID).name = 'uncommitted';
    env.stores.players.writer.save();
    await env.stores.players.flush();
    return value;
  };
  await env.replication.transact('record', [AID, 'committed']);
  assert.equal(new PlayerStore({ file: env.stores.players.file }).profiles.get(AID).name, 'committed');
  assert.equal(env.snapshots.players, 3, 'execution, conflicting later write, then commit replay');
});

test('an older asynchronous write cannot supersede a newer synchronous revision', async (t) => {
  const { dir } = fixture(t);
  const file = join(dir, 'revision.json');
  let value = 'old';
  const writer = new StoreWriter(file, () => ({ value }), null, 'revision');
  writer.save();
  await new Promise((resolve) => setImmediate(resolve));
  value = 'new';
  assert.equal(writer.saveSync(), true);
  await writer.flush();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).value, 'new');
  assert.equal(writer.persistedRevision, writer.revision);
  assert.equal(writer.persistedSince(0), true);
});
