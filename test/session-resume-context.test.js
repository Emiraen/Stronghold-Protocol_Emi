// Loopback-only resume regressions: real account authentication, entirely in-memory stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const PASSWORD = 'resume-context-integration-password';
const TIMEOUT = 5000;

// Add only the documented observer interface to the existing platform stub.
class ObservableStubMatch extends StubMatch {
  constructor(options) { super(options); this.observers = new Set(); }
  addObserver(playerId) {
    this.observers.add(playerId);
    this.sendFn(playerId, this.publicView());
  }
  removeObserver(playerId) { this.observers.delete(playerId); }
  dispose() { this.observers.clear(); super.dispose(); }
}

async function harness(t) {
  const players = new PlayerStore({ file: null });
  const ranked = new RankedStore({ file: null });
  const history = new HistoryStore({ file: null });
  const server = await startServer({
    host: '127.0.0.1', port: 0, quiet: true, admin: false, studio: false,
    stateFile: null, store: null, workerPool: null, env: {},
    players, ranked, history, accountFile: null, announcementFile: null,
    MatchClass: ObservableStubMatch,
    profileConfig: {
      role: 'main', id: 'main', secret: '',
      mainUrl: 'http://127.0.0.1', secondaryUrl: 'http://127.0.0.1',
      accountFile: null, pendingFile: null, replicationFile: null, announcementFile: null,
    },
  });
  const clients = new Set();
  t.after(async () => {
    await Promise.all([...clients].map((client) => client.terminate()));
    await server.close();
  });
  assert.equal(server.store, null);
  assert.equal(server.persister, null);
  for (const store of [players, ranked, history]) assert.equal(store.file, null);
  const connect = async () => {
    const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`, { timeout: TIMEOUT });
    clients.add(client);
    return client;
  };
  const register = async (name) => {
    const client = await connect();
    const welcome = await client.request({ t: 'hello', version: 1, name,
      auth: { action: 'register', password: PASSWORD } }, TIMEOUT);
    assert.equal(welcome.t, 'welcome', JSON.stringify(welcome));
    assert.equal(typeof welcome.authTicket, 'string');
    return { client, welcome, name };
  };
  const resume = async (previous) => {
    const client = await connect();
    const welcome = await client.request({ t: 'hello', version: 1, name: previous.name,
      token: previous.welcome.token,
      auth: { action: 'login', ticket: previous.welcome.authTicket } }, TIMEOUT);
    assert.equal(welcome.t, 'welcome', JSON.stringify(welcome));
    assert.equal(welcome.resumed, true);
    assert.equal(welcome.playerId, previous.welcome.playerId);
    return { client, welcome, name: previous.name };
  };
  return { server, connect, register, resume };
}

async function ok(client, message) {
  const reply = await client.request(message, TIMEOUT);
  assert.equal(reply.t, 'ok', JSON.stringify(reply));
  return reply;
}

async function createRoom(client, mode = 'coop') {
  await ok(client, { t: 'room.create', mode, difficulty: 'NORMAL' });
  return client.waitFor('room.state', () => true, TIMEOUT);
}

function assertNoContext(welcome) {
  assert.equal(Object.hasOwn(welcome, 'roomCode'), true);
  assert.equal(Object.hasOwn(welcome, 'spectatorCode'), true);
  assert.equal(welcome.roomCode, null);
  assert.equal(welcome.spectatorCode, null);
}

test('authenticated welcome carries authoritative room and spectator resume contexts', { timeout: 30000 }, async (t) => {
  const h = await harness(t);

  await t.test('initial welcome has explicit null contexts and anonymous hello remains forbidden', async () => {
    const unauthenticated = await h.connect();
    const denied = await unauthenticated.request({ t: 'hello', version: 1, name: '未认证恢复' }, TIMEOUT);
    assert.equal(denied.t, 'error');
    assert.equal(denied.code, 'AUTH_REQUIRED');
    assert.equal(unauthenticated.log.some((frame) => frame.t === 'welcome'), false);
    await unauthenticated.terminate();
    const player = await h.register('首次恢复上下文');
    assert.equal(player.welcome.resumed, false);
    assertNoContext(player.welcome);
  });

  await t.test('same player id resumes its existing lobby room with the room context', async () => {
    const player = await h.register('房间恢复上下文');
    const room = await createRoom(player.client);
    await player.client.terminate();
    const resumed = await h.resume(player);
    assert.equal(resumed.welcome.roomCode, room.code);
    assert.equal(resumed.welcome.spectatorCode, null);
    const state = await resumed.client.waitFor('room.state', (frame) => frame.code === room.code, TIMEOUT);
    assert.equal(state.inMatch, false);
    assert.equal(state.seats.some((seat) => seat?.playerId === player.welcome.playerId && seat.connected), true);
  });

  await t.test('active match keeps its identity and resumes room, public and private state', async () => {
    const player = await h.register('局内恢复上下文');
    const room = await createRoom(player.client, 'solo');
    await ok(player.client, { t: 'room.start' });
    await player.client.waitFor('m.private', () => true, TIMEOUT);
    const match = h.server.lobby.rooms.get(room.code).match;
    assert.ok(match instanceof StubMatch);
    await player.client.terminate();
    const resumed = await h.resume(player);
    assert.equal(resumed.welcome.roomCode, room.code);
    assert.equal(resumed.welcome.spectatorCode, null);
    const state = await resumed.client.waitFor('room.state', (frame) => frame.code === room.code, TIMEOUT);
    assert.equal(state.inMatch, true);
    assert.equal((await resumed.client.waitFor('m.public', () => true, TIMEOUT)).phase, 'INFO_CHECK');
    assert.equal((await resumed.client.waitFor('m.private', () => true, TIMEOUT)).playerId, player.welcome.playerId);
    assert.equal(h.server.lobby.rooms.get(room.code).match, match, 'resume does not create a different match');
    const welcomeIndex = resumed.client.log.findIndex((frame) => frame.t === 'welcome');
    const roomIndex = resumed.client.log.findIndex((frame) => frame.t === 'room.state');
    const publicIndex = resumed.client.log.findIndex((frame) => frame.t === 'm.public');
    assert.ok(welcomeIndex < roomIndex && roomIndex < publicIndex, 'context precedes room and match frames');
  });

  await t.test('processed leave with a lost success ACK resumes the same identity with explicit null contexts', async () => {
    const player = await h.register('离房丢失回执');
    const room = await createRoom(player.client);
    const connection = [...h.server.network.conns.values()].find((conn) =>
      conn.session?.playerId === player.welcome.playerId && conn.ws.readyState === 1);
    assert.ok(connection);
    const rid = player.client.nextRid;
    let confirmDropped;
    const dropped = new Promise((resolve) => { confirmDropped = resolve; });
    const send = connection.ws.send;
    connection.ws.send = function (data, ...args) {
      const frame = JSON.parse(String(data));
      if (frame.t === 'ok' && frame.rid === rid) {
        const callback = args.find((arg) => typeof arg === 'function');
        callback?.();
        confirmDropped();
        return;
      }
      return send.call(this, data, ...args);
    };
    assert.equal(player.client.send({ t: 'room.leave' }), rid);
    try {
      await Promise.race([dropped, delay(TIMEOUT, null, { ref: false }).then(() => {
        throw new Error('server did not process the leave and attempt its ACK');
      })]);
    } finally { connection.ws.send = send; }
    assert.equal(connection.session.roomCode, null);
    assert.equal(h.server.lobby.rooms.has(room.code), false);
    assert.equal(player.client.log.some((frame) => frame.t === 'ok' && frame.rid === rid), false);
    await player.client.terminate();
    const resumed = await h.resume(player);
    assertNoContext(resumed.welcome);
    const pong = await resumed.client.request({ t: 'ping', c: 1 }, TIMEOUT);
    assert.equal(pong.t, 'pong');
    assert.equal(resumed.client.log.some((frame) => frame.t === 'room.state'), false);
  });

  await t.test('spectator resume advertises spectator context without claiming a player room', async () => {
    const host = await h.register('观战上下文房主');
    const room = await createRoom(host.client, 'solo');
    await ok(host.client, { t: 'room.start' });
    await host.client.waitFor('m.private', () => true, TIMEOUT);
    const roomObject = h.server.lobby.rooms.get(room.code);
    const viewer = await h.register('观战恢复上下文');
    await ok(viewer.client, { t: 'spectator.join', code: room.code, matchId: roomObject.matchCtx.matchId });
    await viewer.client.waitFor('spectator.state', () => true, TIMEOUT);
    await viewer.client.terminate();
    const resumed = await h.resume(viewer);
    assert.equal(resumed.welcome.roomCode, null);
    assert.equal(resumed.welcome.spectatorCode, room.code);
    const state = await resumed.client.waitFor('spectator.state', () => true, TIMEOUT);
    assert.equal(state.code, room.code);
    assert.equal(state.matchId, roomObject.matchCtx.matchId);
    assert.equal(state.readOnly, true);
  });
});
