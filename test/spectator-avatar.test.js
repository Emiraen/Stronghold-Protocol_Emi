// Public avatar appearance survives joining/reconnecting as a read-only spectator.
// The server and accounts are isolated in memory on an ephemeral loopback port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { TestClient } from './helpers/wsClient.js';
import { seatAvatar } from '../public/js/ui/seatArt.js';
import { resourceCache } from '../public/js/resourceCache.js';

test('spectator joining and reconnecting receive only public avatar selections', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
    admin: false, stateFile: 'off', accountFile: null, announcementFile: null, studio: false, workerPool: null,
    ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }),
    profileConfig: { role: 'main', id: 'main', secret: '', serviceUrl: null, mainUrl: null,
      secondaryUrl: 'http://127.0.0.1:1', replicationFile: null, pendingFile: null } });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  async function player(name, token) {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(client);
    client.welcome = await client.hello(name, token, {
      aid: Buffer.from(name).toString('hex').slice(0, 64).padEnd(8, '0'),
      auth: { action: token ? 'login' : 'register', password: 'spectator-avatar-local-test' },
    });
    client.id = client.welcome.playerId;
    return client;
  }
  const ok = async (client, message) => assert.equal((await client.request(message)).t, 'ok');
  const host = await player('头像房主');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', ranked: false });
  const created = await host.waitFor('room.state');
  const members = [host];
  for (const name of ['普通头像', '默认头像']) {
    const member = await player(name);
    members.push(member);
    await ok(member, { t: 'room.join', code: created.code });
    await ok(member, { t: 'room.ready', ready: true });
  }
  await ok(host, { t: 'room.addBot' });
  await ok(host, { t: 'room.start' });
  const room = srv.lobby.getRoom(created.code);
  room.seats[0].card = 'special_duck_flower';
  room.seats[1].card = 'char_avatar_test';
  room.seats[1].cardSkin = 'e2';
  const expected = room.seats.filter(Boolean).map((seat, index) => ({ playerId: seat.playerId,
    card: index === 0 ? 'special_duck_flower' : index === 1 ? 'char_avatar_test' : '',
    cardSkin: index === 1 ? 'e2' : '' }));
  let viewer = await player('观战头像');
  await ok(viewer, { t: 'spectator.join', code: room.code, matchId: room.matchCtx.matchId });
  const joined = await viewer.waitFor('spectator.state');
  assert.deepEqual(joined.seats, expected);
  const token = viewer.welcome.token;
  const viewerId = viewer.id;
  await viewer.terminate();
  viewer = await player('观战头像', token);
  assert.equal(viewer.id, viewerId);
  const resumed = await viewer.waitFor('spectator.state');
  assert.deepEqual(resumed.seats, expected);
  await viewer.waitFor('m.public');
  for (const frame of [joined, resumed]) {
    for (const seat of frame.seats) assert.deepEqual(Object.keys(seat).sort(), ['card', 'cardSkin', 'playerId']);
    assert.equal(frame.seats.some(seat => seat.playerId === viewerId), false, 'spectators never become player seats');
  }
});

test('spectator avatars use the watched public choice, including special, default, and downloaded art', () => {
  const record = { charId: 'char_avatar_test', isGolden: true, assets: { avatar: 'char_avatar_test_2' } };
  const context = { pool: [record], byChar: new Map([[record.charId, record]]),
    myId: 'viewer', myCard: 'special_duck_burnard',
    m: { chars: { char_avatar_test: { avatar: '/normal.png', avatarE2: '/e2.png' } } } };
  const wasManaged = resourceCache.isManaged, wasCached = resourceCache.isCached;
  try {
    resourceCache.isManaged = () => true;
    resourceCache.isCached = () => true;
    assert.equal(seatAvatar({ playerId: 'p1', card: 'special_duck_flower' }, context), '/assets/local/playercards/duck-flower/avatar.png');
    assert.equal(seatAvatar({ playerId: 'p2', card: 'char_avatar_test', cardSkin: 'e2' }, context), '/e2.png');
    assert.equal(seatAvatar({ playerId: 'p3', card: '' }, context), '/normal.png');
    resourceCache.isCached = () => false;
    assert.equal(seatAvatar({ playerId: 'p2', card: 'char_avatar_test', cardSkin: 'e2' }, context), '/normal.png');
  } finally {
    resourceCache.isManaged = wasManaged;
    resourceCache.isCached = wasCached;
  }
});
