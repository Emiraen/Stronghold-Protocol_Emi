// Emi38：所有持久层纯内存，WebSocket 为进程内假连接，不启动或连接游戏服务器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Network, SessionRegistry, sanitizeName } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { adminSnapshot, checkAdminPassword } from '../server/admin.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { validateC2S } from '../shared/protocol.js';

const A = '1111111111111111', B = '2222222222222222', C = '3333333333333333';
const M = 'a'.repeat(32);
const perf = { alive: true, roundsPassed: 15, survivalRounds: 15, layers: 999, assists: 10,
  rankedDamage: 1_000_000, bossDamage: 250_000, rankedPerfectRounds: 15 };
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.frames = []; this.closes = []; }
  send(data, cb) { this.frames.push(JSON.parse(data)); cb?.(); }
  close(code) { this.closes.push(code); this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1006); }
  ping() {}
  frame(t) { return this.frames.filter((f) => f.t === t).at(-1); }
}
class IsolatedMatch extends Match {
  constructor(opts) { super({ ...opts, scheduler: new VirtualScheduler(), botRehearsal: 0 }); }
}
function harness(t) {
  const registry = new SessionRegistry({ debugTokenHashes: [] });
  const ranked = new RankedStore({ file: null });
  const history = new HistoryStore({ file: null });
  const players = new PlayerStore({ file: null });
  const lobby = new Lobby({ registry, ranked, history, players, MatchClass: IsolatedMatch, getData });
  const net = new Network({ registry, handler: lobby, options: { rateBurst: 1000 } });
  t.after(() => { net.close(); lobby.shutdown(); });
  const connect = (name, aid, token, extra = {}) => {
    const ws = new Socket(); net.handleConnection(ws);
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, aid, token, ...extra })), false);
    assert.ok(ws.frame('welcome'));
    return { ws, session: registry.byId(ws.frame('welcome').playerId) };
  };
  const send = (peer, msg) => peer.ws.emit('message', Buffer.from(JSON.stringify(msg)), false);
  const seed = (aid, points, placementDone = true, name = '共享') => {
    players.record(aid, name);
    Object.assign(ranked.ensure(aid, name), { points, placementDone });
  };
  return { registry, ranked, history, players, lobby, net, connect, send, seed };
}

test('两客户端同名只有一个新档案，各持独立会话/token/playerId，公开摘要不含秘密', (t) => {
  const h = harness(t), x = h.connect('共享', A), y = h.connect('共享', B);
  assert.equal(h.players.size, 1); assert.equal(x.session.aid, A); assert.equal(y.session.aid, A);
  assert.notEqual(x.session.playerId, y.session.playerId); assert.notEqual(x.session.token, y.session.token);
  assert.equal(x.ws.closes.length, 0); assert.equal(y.ws.closes.length, 0);
  assert.equal(y.ws.frame('welcome').token, y.session.token);
  const publicState = JSON.stringify({ players: h.players.list(), admin: adminSnapshot(h), rank: y.ws.frame('rank.me') });
  for (const secret of [A, B, x.session.token, y.session.token, 'debugAuthorized', 'clientAid']) assert.ok(!publicState.includes(secret));
  assert.equal(adminSnapshot(h).summary.online, 2);
  assert.equal(adminSnapshot(h).players.filter((p) => p.online).length, 1);
});

test('既有多同名离线按已定级、实际points、稳定aid选择，低档案token不能绕过', (t) => {
  const h = harness(t); h.seed(A, 200);
  const stale = h.connect('共享', A); assert.equal(stale.session.aid, A); stale.ws.close(1000);
  h.seed(B, 1650); h.seed(C, 99999, false);
  const low = h.connect('共享', A); assert.equal(low.session.aid, B);
  low.ws.close(1000);
  const again = h.connect('共享', A, stale.session.token); assert.equal(again.session.aid, B);
  assert.equal(again.session, stale.session); assert.equal(h.ranked.size, 3); assert.equal(h.ranked.profile(A).points, 200);
  assert.equal(h.ranked.profile(C).points, 99999); assert.equal(h.players.size, 3);
});

test('在线低段优先；断线不虚构在线；离线同points稳定ID，未定级内部按实际points', (t) => {
  const h = harness(t); h.seed(A, 10); h.seed(B, 1600);
  const online = h.registry.create('共享'); online.aid = A; online.connected = true; online.profileBound = true;
  const x = h.connect('共享', C); assert.equal(x.session.aid, A);
  online.connected = false; x.ws.close(1000);
  assert.equal(h.connect('共享', C).session.aid, B);
  const p = new PlayerStore({ file: null }), r = new RankedStore({ file: null });
  Object.assign(r.ensure(B, '同分'), { placementDone: true, points: 1610 });
  Object.assign(r.ensure(A, '同分'), { placementDone: true, points: 1610 });
  assert.equal(p.resolveName('同分', C, { ranked: r }), A);
  r.profile(A).placementDone = false; r.profile(B).placementDone = false; r.profile(B).points = 2000;
  assert.equal(p.resolveName('同分', C, { ranked: r }), B);
});

test('多个历史在线稳定aid优先，不受Map顺序、结算积分及hello轮次影响', (t) => {
  const h = harness(t); h.seed(B, 9000); h.seed(A, 1);
  for (const aid of [B, A]) { const peer = h.registry.create('共享'); peer.aid = aid; peer.connected = true; peer.profileBound = true; }
  const x = h.connect('共享', C); assert.equal(x.session.aid, A);
  for (let i = 0; i < 6; i++) {
    h.ranked.profile(A).points = i * 100; h.ranked.profile(B).points += 1000;
    h.send(x, { t: 'hello', name: '共享', aid: B }); assert.equal(x.session.aid, A);
  }
});

test('不同名、大小写精确隔离；只应用项目既有NFC/空白规范化；同aid改名不覆盖旧档案', (t) => {
  const h = harness(t), x = h.connect('Alpha', A), y = h.connect('alpha', A);
  assert.notEqual(x.session.aid, y.session.aid); assert.equal(h.players.size, 2);
  const p = new PlayerStore({ file: null }); p.record(A, sanitizeName(' e\u0301  队 '));
  assert.equal(p.resolveName('é 队', B), A); assert.equal(p.resolveName('É 队', B), B);
  assert.equal(p.resolveName('Ａlpha', B), B);
  assert.equal(h.players.profiles.get(A).name, 'Alpha');
});

test('同aid房间和真实对局两个独立玩家，不抢主机/视角/控制；各自token恢复自己的席位', (t) => {
  const h = harness(t), x = h.connect('共享', A), y = h.connect('共享', B);
  h.send(x, { t: 'room.create', mode: 'coop', difficulty: 'HARD', ranked: true });
  const room = h.lobby.getRoom(x.session.roomCode);
  h.send(y, { t: 'room.join', code: room.code });
  assert.equal(room.hostId, x.session.playerId); assert.equal(room.activeHumans().length, 2);
  h.send(y, { t: 'room.start' }); assert.equal(y.ws.frame('error').code, 'NOT_HOST');
  h.send(y, { t: 'room.ready', ready: true }); h.send(x, { t: 'room.start' });
  assert.ok(room.match); assert.equal(room.match.players.size, 2);
  const mx = room.match.players.get(x.session.playerId), my = room.match.players.get(y.session.playerId);
  assert.notEqual(mx, my); assert.equal(mx.aid, my.aid); assert.equal(mx.devOps, false);
  h.send(y, { t: 'g.infoReady', playerId: x.session.playerId });
  assert.equal(mx.infoReady, false); assert.equal(my.infoReady, true);
  const token = y.session.token; y.ws.close(1000);
  const back = h.connect('改名不换席', C, token);
  assert.equal(back.session.playerId, y.session.playerId); assert.equal(back.session.aid, A);
  assert.equal(back.session.name, '共享'); assert.equal(back.ws.frame('welcome').token, token);
  assert.equal(x.ws.closes.length, 0); assert.equal(room.hostId, x.session.playerId);
  assert.equal(room.seatOf(back.session.playerId).connected, true);
});

test('按座位顺序逐真人累计，aid+playerId+match幂等，重复finish无覆盖且最终摘要相同', (t) => {
  const h = harness(t); h.seed(A, 1600);
  const messages = [], seats = [1, 0].map((seat) => ({ seat, playerId: `p_${seat}`, name: '共享', aid: A, isBot: false, connected: true }));
  const match = new Match({ roomCode: 'TEST', mode: 'coop', difficulty: 'HARD', ranked: true, rankedStore: h.ranked,
    matchId: M, seats, seed: 1, data: getData(), scheduler: new VirtualScheduler(), send: (id, msg) => messages.push({ id, msg }), broadcast() {}, onEnd() {} });
  t.after(() => match.dispose());
  match.outcome = { victory: true }; const rows = seats.map((s) => ({ playerId: s.playerId, roundsPassed: 15,
    stats: { ...perf, activatedLayers: perf.layers } }));
  const result = { players: rows }; match._settleRanked(result);
  const first = rows.find((r) => r.playerId === 'p_0').rank, second = rows.find((r) => r.playerId === 'p_1').rank;
  assert.equal(first.before, 1600); assert.equal(second.before, first.after);
  assert.equal(h.ranked.profile(A).points, second.after); assert.equal(h.ranked.profile(A).matches, 2);
  const snapshots = messages.filter((m) => m.msg.t === 'rank.me');
  assert.equal(snapshots.length, 2); assert.ok(snapshots.every((m) => m.msg.points === second.after));
  match._settleRanked({ players: seats.map((s) => ({ playerId: s.playerId, roundsPassed: 15, stats: { ...perf, activatedLayers: perf.layers } })) });
  assert.equal(h.ranked.profile(A).matches, 2); assert.equal(h.ranked.profile(A).points, second.after);
  // 模拟重载只复制内存数据，不触碰真实或临时存档。
  const reload = new RankedStore({ file: null }); reload.profiles.set(A, reload.sanitize(structuredClone(h.ranked.profile(A))));
  assert.deepEqual(reload.settleMatch({ aid: A, playerId: 'p_0', name: '共享' }, { matchId: M, difficulty: 'HARD', teamWin: true }, perf), first);
  assert.equal(reload.profile(A).matches, 2);
  reload.settleMatch({ aid: A, playerId: 'p_0', name: '共享' }, { matchId: 'b'.repeat(32), difficulty: 'HARD', teamWin: true }, perf);
  assert.equal(reload.profile(A).matches, 3);
});

test('同aid同场保留每人历史行且幂等，详情以match+playerId定位，不泄露嵌套凭据', () => {
  const history = new HistoryStore({ file: null });
  const seats = ['p_0', 'p_1'].map((playerId) => ({ playerId, aid: A, name: '共享', isBot: false }));
  const summary = { difficulty: 'HARD', token: '私密令牌', players: seats.map((s, index) => ({ playerId: s.playerId,
    victory: index === 0, roundsPassed: 15, rank: { before: 1600 + index * 60, after: 1660 + index * 60 }, nested: { aid: A, resumeToken: '私密令牌', devOps: true } })) };
  for (let i = 0; i < 2; i++) history.record({ matchId: M, seats, ranked: true, summary });
  assert.equal(history.list(A).length, 2); assert.equal(history.list(B).length, 0);
  for (const seat of seats) {
    const detail = history.detail(A, M, seat.playerId); assert.equal(detail.playerId, seat.playerId);
    const serialized = JSON.stringify(detail); for (const value of ['私密令牌', A, 'devOps']) assert.ok(!serialized.includes(value));
  }
  assert.equal(history.detail(A, M, '陌生席位'), null);
  assert.equal(validateC2S({ t: 'history.detail', matchId: M, playerId: 'p_0' }), null);
});

test('外人同名root不继承调试/管理；原显式授权会话经自己的token保留devOps与奖励', (t) => {
  const h = harness(t), authorized = h.connect('root', A);
  h.registry.debugTokenHashes.add(createHash('sha256').update(authorized.session.token).digest('hex'));
  authorized.ws.close(1000);
  const own = h.connect('root', A, authorized.session.token), stranger = h.connect('root', B, null, { debugAuthorized: true, devOps: true, admin: true });
  assert.equal(own.session.debugAuthorized, true); assert.equal(stranger.session.debugAuthorized, false);
  assert.equal(own.session.aid, stranger.session.aid); assert.notEqual(own.session.token, stranger.session.token);
  h.send(own, { t: 'room.create', mode: 'coop', difficulty: 'HARD', ranked: true });
  const room = h.lobby.getRoom(own.session.roomCode); h.send(stranger, { t: 'room.join', code: room.code });
  h.send(stranger, { t: 'room.ready', ready: true }); h.send(own, { t: 'room.start' });
  assert.equal(room.match.players.get(own.session.playerId).devOps, true);
  assert.equal(room.match.players.get(stranger.session.playerId).devOps, false);
  assert.equal(checkAdminPassword('root', 'root'), false);
  assert.equal(Object.hasOwn(stranger.ws.frame('welcome'), 'debugAuthorized'), false);
  const ordinary = new RankedStore({ file: null });
  const i = ordinary.settleMatch({ aid: A, name: 'root', playerId: 'p_0' }, { matchId: M, difficulty: 'HARD', teamWin: true }, perf);
  assert.equal(i.bonus, 0); assert.equal(i.placementDone, false); assert.equal(i.placementMatches, 3);
  const adminOnly = new RankedStore({ file: null });
  const privileged = adminOnly.settleMatch({ aid: A, name: 'root', playerId: 'p_1', debugAuthorized: true }, { matchId: M, difficulty: 'HARD', teamWin: true }, perf);
  assert.equal(privileged.bonus, 2000); assert.equal(privileged.placementDone, true);
});

test('真实finish贯通大厅和历史，同场各计一次；再次finish及随后标准局不重复加分', (t) => {
  const h = harness(t); h.seed(A, 1600);
  const x = h.connect('共享', A), y = h.connect('共享', B);
  h.send(x, { t: 'room.create', mode: 'coop', difficulty: 'HARD', ranked: true });
  const room = h.lobby.getRoom(x.session.roomCode); h.send(y, { t: 'room.join', code: room.code });
  h.send(y, { t: 'room.ready', ready: true }); h.send(x, { t: 'room.start' });
  const match = room.match;
  for (const ps of match.players.values()) Object.assign(ps.stats, perf);
  match.finish({ victory: true, reason: 'victory' });
  const rows = x.ws.frame('m.result').players;
  assert.equal(rows.length, 2); assert.equal(rows[1].rank.before, rows[0].rank.after);
  assert.equal(h.ranked.profile(A).matches, 2); assert.equal(h.history.list(A).length, 2);
  assert.equal(x.ws.frame('rank.me').points, rows[1].rank.after);
  assert.equal(y.ws.frame('rank.me').points, rows[1].rank.after);
  assert.equal(match.errorCount, 0);
  const before = structuredClone(h.ranked.profile(A));
  match.finish({ victory: true, reason: 'victory' }); assert.deepEqual(h.ranked.profile(A), before);
  const pushes = x.ws.frames.filter((f) => f.t === 'rank.me').length;
  h.send(x, { t: 'room.setDifficulty', difficulty: 'FUNNY' });
  h.send(y, { t: 'room.ready', ready: true }); h.send(x, { t: 'room.start' });
  assert.ok(room.match); room.match.finish({ victory: true, reason: 'victory' });
  assert.deepEqual(h.ranked.profile(A), before); assert.equal(h.history.list(A).length, 4);
  assert.equal(x.ws.frames.filter((f) => f.t === 'rank.me').length, pushes);
});

test('标准模拟任何共享名都不计段位、定级、MMR、奖励或幂等回执', (t) => {
  const h = harness(t); h.seed(A, 1600, true, 'root');
  const before = structuredClone(h.ranked.profile(A));
  for (const playerId of ['p_0', 'p_1']) {
    assert.equal(h.ranked.settleMatch({ aid: A, name: 'root', playerId, debugAuthorized: true }, { matchId: M, difficulty: 'FUNNY', teamWin: true }, perf), null);
  }
  assert.deepEqual(h.ranked.profile(A), before);
});
