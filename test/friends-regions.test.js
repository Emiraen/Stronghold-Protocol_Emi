import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createProfileAccess, profileRpcHandler } from '../server/profileService.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { Network, SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';

const stores = () => ({ players: new PlayerStore({ file: null }), ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }) });
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.frames = []; this.bufferedAmount = 0; }
  send(data, callback) { this.frames.push(JSON.parse(data)); callback?.(); }
  close() { this.readyState = 3; this.emit('close', 1000, ''); }
  terminate() { this.close(); }
  ping(_data, _mask, callback) { callback?.(); }
  frame(type) { return this.frames.filter(row => row.t === type).at(-1); }
}
test('two real regional lobbies exchange friend requests, presence, invites and public profiles through signed compressed RPC', async t => {
  const errors = [], log = { info() {}, warn() {}, debug() {}, error(...args) { errors.push(args.map(String).join(' ')); } };
  const mainConfig = { role: 'main', id: 'main', secret: '', accountFile: null, mainUrl: 'http://east.invalid', secondaryUrl: 'http://south.invalid' };
  const eastStores = stores(), east = createProfileAccess(mainConfig, eastStores, log);
  await east.ready();
  const secret = 'friends-loopback-only';
  const rpc = http.createServer(profileRpcHandler({ ...mainConfig, secret }, east.authority, log));
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  const southStores = stores(), south = createProfileAccess({ ...mainConfig, role: 'secondary', id: 'secondary', secret,
    serviceUrl: `http://127.0.0.1:${rpc.address().port}` }, southStores, log);
  const networks = [];
  t.after(async () => { networks.forEach(net => net.close()); south.close(); east.close(); await new Promise(resolve => rpc.close(resolve)); });
  await south.ready();
  const region = (profiles, serverId) => {
    const registry = new SessionRegistry({ debugTokenHashes: [] });
    const lobby = new Lobby({ registry, profiles, players: profiles.players, ranked: profiles.ranked, history: profiles.history,
      serverId, MatchClass: StubMatch, getData: () => ({}), log });
    profiles.bindAdmin(lobby, registry);
    const net = new Network({ registry, handler: lobby, log, options: { rateBurst: 1000, heavyBurst: 1000 } });
    profiles.bindNetwork(net, () => {}); networks.push(net);
    return { registry, lobby, profiles, async player(name, auth = { action: 'register', password: 'friends-integration-password' }) {
      const ws = new Socket(); net.handleConnection(ws); const conn = net.conns.get(ws); let rid = 0;
      const send = async fields => {
        const requestId = ++rid; ws.emit('message', Buffer.from(JSON.stringify({ ...fields, rid: requestId })), false);
        await conn.messageChain;
        const err = ws.frames.find(row => row.rid === requestId && row.t === 'error');
        if (err) throw new Error(JSON.stringify(err));
        return ws.frames.find(row => row.rid === requestId && row.t !== 'ok');
      };
      await send({ t: 'hello', version: 1, name, auth });
      assert.ok(ws.frame('welcome'), JSON.stringify(ws.frames));
      assert.equal(conn.session.profileReady, true);
      const profileId = profiles.players.profiles.get(conn.session.aid).id;
      return { ws, send, session: conn.session, profileId, async action(action, fields = {}) {
        const reply = await send({ t: 'friends.action', action, ...fields });
        assert.equal(reply.t, 'friends.result'); return reply.result;
      } };
    } };
  };
  const e = region(east, 'main'), s = region(south, 'secondary');
  const alice = await e.player('跨服甲'), bob = await s.player('跨服乙');
  await east.syncFriends(); await south.syncFriends();
  assert.equal((await alice.action('search', { query: '跨服乙' })).items[0].id, bob.profileId);
  await alice.action('request', { targetId: bob.profileId });
  await south.syncFriends();
  assert.equal(bob.ws.frame('friends.state').requests[0].player.id, alice.profileId);
  await bob.action('accept', { targetId: alice.profileId });
  await east.syncFriends();
  assert.equal(alice.ws.frame('friends.state').friends[0].name, '跨服乙');
  const pm=await alice.action('message.send',{targetId:bob.profileId,text:'跨服私信验证',clientId:'7'.repeat(32)});
  await south.syncFriends();assert.equal(bob.ws.frame('friends.state').threads[0].unread,1);
  assert.equal((await bob.action('message.list',{targetId:alice.profileId})).items[0].id,pm.message.id);
  await bob.action('message.read',{targetId:alice.profileId,throughSeq:pm.message.seq});
  assert.equal((await bob.action('list')).threads[0].unread,0);

  await alice.send({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = alice.ws.frame('room.state');
  assert.equal(room.seats[0].profileId, alice.profileId, 'room cards expose a safe target ID');
  await alice.action('invite', { targetId: bob.profileId }); await south.syncFriends();
  const invite = bob.ws.frame('friends.state').invitations[0];
  assert.equal(invite.modeName, '同盟模拟');
  const accepted = await bob.action('respond', { inviteId: invite.id, accept: true });
  assert.deepEqual(accepted.join, { serverId: 'main', code: room.code });
  const publicProfile = await bob.action('profile', { targetId: alice.profileId });
  assert.equal(publicProfile.player.name, '跨服甲');
  const body = JSON.stringify(publicProfile);
  assert.ok(!body.includes(alice.session.aid) && !body.includes('loginLease') && !body.includes('mmr'));
  await bob.action('respond', { inviteId: invite.id, accept: false, mute: true });
  await alice.action('invite', { targetId: bob.profileId }); await south.syncFriends();
  assert.equal((await bob.action('list')).invitations.length, 0);
  const liveRoom = e.lobby.getRoom(room.code), observers = new Set();
  liveRoom.match = { addObserver: pid => observers.add(pid), removeObserver: pid => observers.delete(pid), dispose() {},
    publicView: () => ({ phase: 'PREP', round: 1, players: [{ playerId: alice.session.playerId, name: '跨服甲', alive: true, lp: 100 }] }) };
  liveRoom.matchCtx = { matchId: 'f'.repeat(32), live: true, ended: false, seats: liveRoom.seats.filter(Boolean) };
  await east.syncFriends();
  assert.equal((await bob.action('list')).friends[0].presence.watch.code, room.code);
  const ticket = bob.ws.frame('welcome').authTicket;
  await bob.send({ t: 'session.release' });
  bob.ws.close();
  await south.flushReplication();
  const moved = await e.player('跨服乙', { action: 'login', ticket });
  assert.equal(moved.profileId, bob.profileId, 'cross-server transfer keeps the same social identity');
  assert.equal((await moved.action('list')).friends[0].id, alice.profileId);
  assert.equal((await moved.action('message.list',{targetId:alice.profileId})).items[0].text,'跨服私信验证');
  await moved.send({ t: 'spectator.join', code: room.code, matchId: liveRoom.matchCtx.matchId });
  assert.equal(moved.ws.frame('spectator.state').code, room.code);
  assert.ok(observers.has(moved.session.playerId), 'friend spectating reaches the existing observer implementation');
  moved.ws.close();
  await east.syncFriends();
  await south.syncFriends();
  assert.equal((await alice.action('list')).friends[0].presence.state, 'offline');
  await assert.rejects(bob.action('request', { targetId: alice.profileId }));
  assert.deepEqual(errors, [], 'no service or bridge errors');
});
