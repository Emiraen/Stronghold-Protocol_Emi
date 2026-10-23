import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileReplication } from '../server/profileReplication.js';

const AID = 'a'.repeat(32);
const PEER = '11111111-1111-4111-8111-111111111111';
const noLease = { current: () => false };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stronghold-replication-idle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function open(role) {
    const stores = Object.fromEntries(['players', 'ranked', 'history'].map((name) => {
      const file = join(dir, `${role}-${name}.json`);
      const store = { file, profiles: new Map(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []),
        saves: 0, flushes: 0, failFlush: false };
      store.writer = { save() { store.saves++; } };
      store.flush = async () => {
        store.flushes++;
        if (store.failFlush) { store.failFlush = false; throw new Error('injected store flush failure'); }
        writeFileSync(file, JSON.stringify([...store.profiles]));
      };
      return [name, store];
    }));
    const replication = new ProfileReplication({ role, file: join(dir, `${role}-replication.json`), stores,
      execute(op, args) {
        assert.equal(op, 'record');
        const [aid, name] = args;
        stores.players.profiles.set(aid, { aid, name });
        return { aid, name };
      } });
    let saves = 0;
    const save = replication.save.bind(replication);
    replication.save = () => { saves++; return save(); };
    return { replication, stores, saves: () => saves, disk: () => JSON.parse(readFileSync(replication.file, 'utf8')) };
  }
  return { dir, open };
}

async function pair(t) {
  const f = fixture(t), main = f.open('main'), secondary = f.open('secondary');
  await secondary.replication.initialize((request) => main.replication.bootstrap(request));
  const exchange = async (request) => ({ replication: await main.replication.exchange(request, noLease) });
  await secondary.replication.sync(exchange);
  return { ...f, main, secondary, exchange };
}

test('idle main exchanges bind the peer once and avoid full-state serialization or writes thereafter', async (t) => {
  const { open } = fixture(t), main = open('main');
  const request = { id: PEER, cursor: 0, pending: [], releases: [] };
  await main.replication.exchange(request, noLease);
  assert.equal(main.saves(), 1);
  assert.equal(main.disk().peer, PEER);
  // A no-op must not even serialize the replication state, regardless of its size.
  Object.defineProperty(main.replication.state, 'toJSON', { value() { throw new Error('unexpected full-state serialization'); } });
  for (let i = 0; i < 5; i++) {
    const response = await main.replication.exchange(request, noLease);
    assert.deepEqual(response.events, []);
    assert.equal(response.cursor, 0);
  }
  assert.equal(main.saves(), 1);
});

test('idle secondary heartbeat sync and release polling do not persist an empty commit', async (t) => {
  const { main, secondary, exchange } = await pair(t);
  const before = [main.saves(), secondary.saves()];
  Object.defineProperty(secondary.replication.state, 'toJSON', { value() { throw new Error('unexpected full-state serialization'); } });
  for (let i = 0; i < 5; i++) {
    await secondary.replication.releaseIdle(new Set());
    await secondary.replication.sync(exchange, true, new Set());
  }
  assert.deepEqual([main.saves(), secondary.saves()], before);
  assert.equal(secondary.replication.state.commit, undefined);
});

test('real cursor advancement and its ACK remain durable across both server restarts', async (t) => {
  const { main, secondary, exchange, open } = await pair(t);
  await main.replication.transact('record', [AID, 'first']);
  await secondary.replication.sync(exchange);
  assert.equal(secondary.disk().cursor, 1);
  assert.equal(secondary.disk().commit, undefined);
  assert.equal(secondary.stores.players.profiles.get(AID).name, 'first');
  assert.equal(main.disk().log.length, 1, 'sending a response alone never acknowledges the peer cursor');
  const restarted = open('secondary');
  assert.equal(restarted.stores.players.profiles.get(AID).name, 'first');
  await restarted.replication.sync(exchange);
  assert.equal(main.disk().log.length, 0, 'the peer durable cursor prunes the replay log');
  const restartedMain = open('main');
  assert.equal(restartedMain.replication.state.log.length, 0);
  assert.equal(restartedMain.replication.state.revision, 1);
  const before = main.saves();
  await restarted.replication.sync(exchange);
  assert.equal(main.saves(), before, 'repeated ACK does not rewrite the state');
});

test('grant changes and idle release handoffs persist once, while duplicate heartbeats stay idle', async (t) => {
  const { main, secondary, exchange, open } = await pair(t);
  const lease = { aid: AID, serverId: 'secondary', owner: 'session', generation: 1, expiresAt: 10000 };
  const grant = await main.replication.grant(AID, lease, noLease);
  const mainSaved = main.saves();
  assert.deepEqual(await main.replication.grant(AID, lease, noLease), grant);
  assert.equal(main.saves(), mainSaved);
  await secondary.replication.acceptGrant(grant);
  const accepted = secondary.saves();
  await secondary.replication.acceptGrant(grant);
  assert.equal(secondary.saves(), accepted);
  await secondary.replication.releaseIdle(new Set([AID]));
  assert.equal(secondary.saves(), accepted);
  await secondary.replication.releaseIdle(new Set());
  assert.equal(secondary.saves(), accepted + 1);
  await secondary.replication.releaseIdle(new Set());
  assert.equal(secondary.saves(), accepted + 1);
  await secondary.replication.sync(exchange);
  assert.deepEqual(main.disk().owners[AID], { serverId: 'main' });
  assert.equal(secondary.disk().grants[AID], undefined);
  assert.deepEqual(secondary.disk().releases, []);
  assert.deepEqual(open('main').replication.state.owners[AID], { serverId: 'main' });
  assert.equal(open('secondary').replication.state.grants[AID], undefined);
  const before = [main.saves(), secondary.saves()];
  await secondary.replication.sync(exchange, true, new Set());
  assert.deepEqual([main.saves(), secondary.saves()], before);
});

test('ownership migration is durable, but duplicate shared-writer requests do not rewrite it', async (t) => {
  const { main, secondary, open } = await pair(t);
  const lease = { aid: AID, serverId: 'secondary', owner: 'session', generation: 1 };
  await main.replication.grant(AID, lease, noLease);
  const request = { id: secondary.replication.state.id, cursor: 0, pending: [], releases: [], sharedWrites: true };
  await main.replication.exchange(request, noLease);
  assert.deepEqual(open('main').replication.state.owners[AID], { serverId: 'main' });
  const before = main.saves();
  await main.replication.exchange(request, noLease);
  assert.equal(main.saves(), before);
});

test('an otherwise-idle exchange retries a failed durable write instead of dropping the mutation', async (t) => {
  const { open } = fixture(t), main = open('main');
  const request = { id: PEER, cursor: 0, pending: [], releases: [] };
  mkdirSync(`${main.replication.file}.tmp`);
  await assert.rejects(main.replication.exchange(request, noLease));
  assert.equal(main.replication.dirty, true);
  assert.equal(main.replication.state.peer, PEER);
  rmSync(`${main.replication.file}.tmp`, { recursive: true });
  await main.replication.exchange(request, noLease);
  assert.equal(main.replication.dirty, false);
  assert.equal(main.disk().peer, PEER);
  const before = main.saves();
  await main.replication.exchange(request, noLease);
  assert.equal(main.saves(), before);
});

test('a failed store flush keeps the durable commit and recovery reapplies it before returning an ACK', async (t) => {
  const { main, secondary, exchange, open } = await pair(t);
  await main.replication.transact('record', [AID, 'recoverable']);
  secondary.stores.players.failFlush = true;
  await assert.rejects(secondary.replication.sync(exchange), /injected store flush failure/);
  assert.equal(secondary.disk().commit.patches[0].aid, AID);
  assert.equal(main.disk().log.length, 1);
  const recovered = open('secondary');
  assert.equal(recovered.replication.initialized, false);
  await recovered.replication.sync(exchange);
  assert.equal(recovered.replication.initialized, true);
  assert.equal(recovered.stores.players.profiles.get(AID).name, 'recoverable');
  assert.equal(recovered.disk().commit, undefined);
  assert.equal(recovered.disk().cursor, 1);
  assert.equal(main.disk().log.length, 0);
});
