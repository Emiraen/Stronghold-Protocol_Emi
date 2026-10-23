// Authentication integration uses memory profiles, fake WebSockets and a loopback-only profile RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Network, SessionRegistry } from '../server/net.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { createProfileAccess, profileRpcHandler } from '../server/profileService.js';

const A = '1111111111111111';
const B = '2222222222222222';
const C = '3333333333333333';
const DEVICE = 'a'.repeat(32);
const PASSWORD = 'account-integration-password';
const log = { info() {}, warn() {}, error() {}, debug() {} };
const passwordAuth = (password = PASSWORD) => ({ action: 'login', password });
const ticketAuth = (ticket) => ({ action: 'login', ticket });
const registerAuth = () => ({ action: 'register', password: PASSWORD });

class Socket extends EventEmitter {
  constructor() {
    super(); this.readyState = 1; this.bufferedAmount = 0; this.frames = []; this.closes = [];
  }
  send(data, callback) { this.frames.push(JSON.parse(data)); callback?.(); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.closes.push({ code, reason }); this.readyState = 3; this.emit('close', code, reason);
  }
  terminate() { this.close(1006); }
  ping(_data, _mask, callback) { callback?.(); }
  frame(type) { return this.frames.filter((frame) => frame.t === type).at(-1); }
}

function stores() {
  return { players: new PlayerStore({ file: null }), ranked: new RankedStore({ file: null }),
    history: new HistoryStore({ file: null }) };
}

async function harness(t, seed = () => {}, paired = false) {
  const mainStores = stores(); seed(mainStores);
  const mainConfig = { role: 'main', id: 'main', secret: '', accountFile: null,
    mainUrl: 'http://127.0.0.1', secondaryUrl: 'http://127.0.0.1' };
  // The unrelated 12-second cold-authority guard is disabled in this isolated fixture.
  // The RPC handler still enforces its normal shared-secret authentication.
  const main = createProfileAccess(mainConfig, mainStores, log);
  const accesses = [main], networks = [];
  let rpc = null;
  t.after(async () => {
    for (const net of networks) net.close();
    for (const access of accesses.reverse()) access.close();
    if (rpc) await new Promise((resolve, reject) => rpc.close((error) => error ? reject(error) : resolve()));
  });
  await main.ready();
  let secondary = null, secondaryStores = null;
  if (paired) {
    const secret = 'loopback-test-profile-service';
    rpc = http.createServer(profileRpcHandler({ ...mainConfig, secret }, main.authority, log));
    await new Promise((resolve, reject) => {
      rpc.once('error', reject); rpc.listen(0, '127.0.0.1', resolve);
    });
    secondaryStores = stores();
    secondary = createProfileAccess({ role: 'secondary', id: 'secondary', secret,
      serviceUrl: `http://127.0.0.1:${rpc.address().port}`,
      mainUrl: 'http://127.0.0.1', secondaryUrl: 'http://127.0.0.1', accountFile: null }, secondaryStores, log);
    accesses.push(secondary); await secondary.ready();
  }
  const network = (profiles) => {
    const registry = new SessionRegistry({ debugTokenHashes: [] });
    const net = new Network({ registry, handler: { profiles }, log, options: { rateBurst: 1000 } });
    networks.push(net);
    const client = () => {
      const ws = new Socket(); net.handleConnection(ws);
      const conn = net.conns.get(ws);
      return { ws, conn,
        async send(message) {
          ws.emit('message', Buffer.from(JSON.stringify(message)), false);
          await conn.messageChain;
          return ws.frame('welcome');
        },
        async hello(message) { return this.send({ t: 'hello', ...message }); },
        get session() { return conn.session; },
      };
    };
    return { net, registry, client };
  };
  return { main, mainStores, secondary, secondaryStores, network };
}

test('legacy default password requires matching reset before welcome and retains the original profile', async (t) => {
  const h = await harness(t, ({ players, ranked }) => {
    players.record(A, '旧账户');
    Object.assign(ranked.ensure(A, '旧账户'), { points: 1900, placementDone: true });
  });
  const n = h.network(h.main), client = n.client();
  await client.hello({ name: '旧账户', aid: B, auth: passwordAuth('1234567') });
  assert.equal(client.ws.frame('error').code, 'AUTH_RESET_REQUIRED');
  assert.equal(client.ws.frame('welcome'), undefined);
  assert.equal(client.session, null);
  assert.equal(h.mainStores.players.size, 1);

  await client.hello({ name: '旧账户', auth: { action: 'reset', password: '1234567',
    newPassword: PASSWORD, confirmPassword: 'different-password' } });
  assert.equal(client.ws.frame('error').code, 'AUTH_PASSWORD_MISMATCH');
  assert.equal(client.ws.frame('welcome'), undefined);
  await client.hello({ name: '旧账户', aid: B, auth: { action: 'reset', password: '1234567',
    newPassword: PASSWORD, confirmPassword: PASSWORD } });
  const welcome = client.ws.frame('welcome');
  assert.ok(welcome); assert.equal(welcome.name, '旧账户');
  assert.equal(typeof welcome.authTicket, 'string');
  assert.equal(client.session.aid, A);
  assert.equal(h.mainStores.players.size, 1);
  assert.equal(h.mainStores.ranked.profile(A).points, 1900);
  assert.equal((await h.main.authenticate('旧账户', passwordAuth('1234567'))).error, 'AUTH_INVALID');
  const login = await h.main.authenticate('旧账户', passwordAuth());
  assert.equal(login.aid, A); assert.ok(login.ticket);
});

test('main and secondary registrations serialize globally and reject legacy or registered duplicate names', async (t) => {
  const h = await harness(t, ({ players }) => players.record(A, '已有名称'), true);
  const duplicateLegacy = await h.secondary.authenticate('已有名称', registerAuth());
  assert.equal(duplicateLegacy.error, 'AUTH_NAME_TAKEN');
  assert.equal(duplicateLegacy.detail, '名称已被占用');
  const results = await Promise.all([
    h.main.authenticate('跨服注册', registerAuth()),
    h.secondary.authenticate('跨服注册', registerAuth()),
  ]);
  const success = results.filter((result) => !result.error);
  assert.equal(success.length, 1);
  assert.equal(results.filter((result) => result.error === 'AUTH_NAME_TAKEN').length, 1);
  const mainLogin = await h.main.authenticate('跨服注册', passwordAuth());
  const secondaryLogin = await h.secondary.authenticate('跨服注册', passwordAuth());
  assert.equal(mainLogin.aid, success[0].aid);
  assert.equal(secondaryLogin.aid, success[0].aid);
  assert.equal((await h.secondary.authenticate('跨服注册', ticketAuth(mainLogin.ticket))).aid, success[0].aid);
  assert.equal((await h.main.authenticate('跨服注册', ticketAuth(secondaryLogin.ticket))).aid, success[0].aid);
});

test('wrong or missing account credentials cannot replace a live session using its token or device ID', async (t) => {
  const h = await harness(t), n = h.network(h.main), owner = n.client();
  await owner.hello({ name: '在线账户', aid: A, deviceId: DEVICE, auth: registerAuth() });
  assert.ok(owner.ws.frame('welcome'));
  const session = owner.session, aid = session.aid, token = session.token;
  const before = { ws: session.ws, name: session.name, connected: session.connected, profileReady: session.profileReady };
  for (const auth of [undefined, passwordAuth('wrong-password'), ticketAuth(`${owner.ws.frame('welcome').authTicket}invalid`)]) {
    const intruder = n.client();
    await intruder.hello({ name: '在线账户', token, aid: B, deviceId: DEVICE, ...(auth ? { auth } : {}) });
    assert.equal(intruder.ws.frame('welcome'), undefined);
    assert.ok(['AUTH_REQUIRED', 'AUTH_INVALID'].includes(intruder.ws.frame('error').code));
    assert.equal(intruder.session, null);
    assert.equal(session.ws, before.ws); assert.equal(session.name, before.name);
    assert.equal(session.connected, before.connected); assert.equal(session.profileReady, before.profileReady);
    assert.equal(owner.ws.closes.length, 0); assert.equal(session.aid, aid);
  }
  // Failed account switching on the current socket must leave the current account usable as well.
  await owner.hello({ name: '另一个账户', token, deviceId: DEVICE, auth: passwordAuth('wrong-password') });
  assert.equal(owner.ws.frame('error').code, 'AUTH_INVALID');
  assert.equal(owner.session, session); assert.equal(session.ws, owner.ws);
  assert.equal(session.name, '在线账户'); assert.equal(session.aid, aid);
  assert.equal(session.connected, true); assert.equal(session.profileReady, true);
  assert.equal(owner.ws.closes.length, 0);
});

test('account ticket reconnects without a password and transfers across servers without changing the canonical aid', async (t) => {
  const h = await harness(t, () => {}, true);
  const mainNet = h.network(h.main), first = mainNet.client();
  await first.hello({ name: '免密转服', aid: A, deviceId: DEVICE, auth: registerAuth() });
  const welcome = first.ws.frame('welcome'); assert.ok(welcome);
  const aid = first.session.aid, playerId = first.session.playerId;
  assert.notEqual(aid, A);
  const token = welcome.token, ticket = welcome.authTicket;
  assert.ok(ticket);
  first.ws.close(1006);
  const reconnected = mainNet.client();
  await reconnected.hello({ name: '免密转服', aid: B, token, deviceId: DEVICE, auth: ticketAuth(ticket) });
  assert.equal(reconnected.ws.frame('welcome')?.resumed, true);
  assert.equal(reconnected.session.playerId, playerId);
  assert.equal(reconnected.session.aid, aid);
  assert.ok(reconnected.ws.frame('welcome').authTicket);

  // A higher-ranked historical namesake must never redirect an authenticated account.
  h.mainStores.players.record(C, '免密转服');
  Object.assign(h.mainStores.ranked.ensure(C, '免密转服'), { points: 99999, placementDone: true });
  await h.main.releaseSession(reconnected.session);
  reconnected.ws.close(1000);
  const secondaryNet = h.network(h.secondary), transferred = secondaryNet.client();
  await transferred.hello({ name: '免密转服', aid: C, deviceId: DEVICE,
    auth: ticketAuth(reconnected.ws.frame('welcome').authTicket) });
  assert.ok(transferred.ws.frame('welcome'));
  assert.equal(transferred.session.aid, aid);
  assert.equal(h.secondaryStores.players.profiles.get(aid)?.name, '免密转服');
  assert.equal((await h.secondary.authenticate('免密转服', ticketAuth(ticket))).aid, aid);
  assert.equal(h.mainStores.ranked.profile(C).points, 99999);
});
