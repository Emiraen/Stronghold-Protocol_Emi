import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerStore, defaultPlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const tmp = mkdtempSync(join(tmpdir(), 'stronghold-players-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';

describe('private player registry', () => {
  test('records aid once, preserves first login and id, updates name and last login', () => {
    let time = 1000;
    const file = join(tmp, 'players.json');
    const store = new PlayerStore({ file, now: () => time });
    assert.equal(store.record(null, 'Temporary'), null);
    assert.equal(store.record('not-a-valid-aid', 'Temporary'), null);
    assert.equal(store.size, 0);
    assert.equal(readdirSync(tmp).includes('players.json'), false);
    const id = store.record(A, 'Alice');
    time = 2000;
    assert.equal(store.record(A, 'Alicia'), id);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.deepEqual(store.list(), [{ name: 'Alicia', firstSeen: 1000, lastSeen: 2000 }]);
    assert.equal(JSON.stringify(store.list()).includes(A), false);
    assert.equal(store.internalSnapshot()[0].aid, A);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.profiles[0].aid, A);
    assert.equal(saved.profiles[0].id, id);
    assert.equal(readdirSync(tmp).some((name) => name.endsWith('.tmp')), false);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(new PlayerStore({ file }).list(), store.list());
  });

  test('merges historical ranked and match profiles by aid with bounded dates and stable ids', () => {
    const file = join(tmp, 'merged.json');
    const store = new PlayerStore({ file, now: () => 9000 });
    store.record(A, 'Current');
    const oldId = store.internalSnapshot()[0].id;
    const ranked = new RankedStore({ file: null });
    ranked.profiles.set(A, { name: 'Old name', lastActive: 3000 });
    ranked.profiles.set(B, { name: 'Ranked', lastActive: 6000 });
    const history = new HistoryStore({ file: null });
    history.profiles.set(A, { name: 'Historical', items: [{ at: 1000 }, { at: 4000 }] });
    history.profiles.set(C, { name: 'History', items: [{ at: 5000 }, { at: 2000 }] });
    store.mergeExisting(ranked, history);
    assert.equal(store.size, 3);
    const entries = store.internalSnapshot();
    assert.deepEqual(entries.find((p) => p.aid === A), { id: oldId, aid: A, name: 'Current', firstSeen: 1000, lastSeen: 9000 });
    assert.deepEqual(entries.find((p) => p.aid === B), { id: entries.find((p) => p.aid === B).id,
      aid: B, name: 'Ranked', firstSeen: 6000, lastSeen: 6000 });
    assert.deepEqual(entries.find((p) => p.aid === C), { id: entries.find((p) => p.aid === C).id,
      aid: C, name: 'History', firstSeen: 2000, lastSeen: 5000 });
    const before = store.list();
    store.mergeExisting(ranked, history);
    assert.deepEqual(store.list(), before);
    assert.deepEqual(new PlayerStore({ file }).list(), before);
  });

  test('successful WebSocket hello records humans; missing aid stays session-only', async () => {
    let time = 10000;
    const players = new PlayerStore({ file: null, now: () => time });
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, admin: null,
      ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players });
    const clients = [];
    try {
      const connect = async (name, aid) => {
        const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
        clients.push(client);
        await client.hello(name, null, aid ? { aid } : {});
        return client;
      };
      await connect('Anonymous');
      assert.equal(players.size, 0);
      await connect('Alice', A);
      time = 20000;
      await connect('Alicia', A);
      assert.deepEqual(players.list().map(({ name, firstSeen, lastSeen }) => ({ name, firstSeen, lastSeen })),
        [{ name: 'Alicia', firstSeen: 10000, lastSeen: 20000 }]);
    } finally {
      for (const client of clients) await client.close();
      await srv.close();
    }
  });

  test('default registry path stays outside static mounts', () => {
    const store = defaultPlayerStore();
    assert.equal(store.file.endsWith('player-registry.json'), true);
    assert.equal(store.file.includes(`${join('public', 'data')}`), false);
  });
});
