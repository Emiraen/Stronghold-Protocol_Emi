import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { TestClient } from './helpers/wsClient.js';
import { rankBoundaries, rankOf, RADIANT_POINTS } from '../shared/ranks.js';

async function fixture(t, { ranked = false, sizes = [2, 2], difficulties = ['FUNNY', 'ABYSS'], expectedErrors = 0 } = {}) {
  const errors = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', admin: false,
    ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }),
    log: { info() {}, warn() {}, debug() {}, error: (...args) => errors.push(args.join(' ')) },
    rateBurst: 1000, heavyBurst: 1000 });
  const clients = [], teams = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); assert.equal(errors.length, expectedErrors, JSON.stringify(errors)); });
  for (let i = 0; i < sizes.length; i++) {
    const members = [];
    for (let j = 0; j < sizes[i]; j++) {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      const w = await c.hello(`队伍${i + 1}博士${j + 1}`, null, { aid: `${i + 1}${j + 1}`.repeat(8) });
      c.id = w.playerId; c.token = w.token; clients.push(c); members.push(c);
    }
    await ok(members[0], { t: 'room.create', mode: 'coop', ranked, difficulty: difficulties[i % difficulties.length] });
    const state = await members[0].waitFor('room.state');
    for (const c of members.slice(1)) await ok(c, { t: 'room.join', code: state.code });
    teams.push({ members, room: srv.lobby.getRoom(state.code) });
  }
  async function queue() {
    for (const team of teams) await ok(team.members[0], { t: 'room.matchFill', searching: true });
    return teams[0].room.matchCandidate;
  }
  return { srv, clients, teams, queue };
}
async function ok(c, msg) { const r = await c.request(msg); assert.equal(r.t, 'ok', JSON.stringify(r)); return r; }
async function bad(c, msg) { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); return r; }
const confirm = (c, candidate) => ok(c, { t: 'room.matchConfirm', candidateId: candidate.id, accept: true });
const vote = (c, candidate, difficulty) => ok(c, { t: 'room.matchDifficultyVote', candidateId: candidate.id, difficulty });

test('Emi33 候选确认中踢人取消候选与跨队票，不误踢新座位', async (t) => {
  const f = await fixture(t);
  const candidate = await f.queue();
  await confirm(f.clients[2], candidate);
  await vote(f.clients[3], candidate, 'ABYSS');
  const team = f.teams[0];
  const guest = team.members[1];
  await bad(team.members[0], { t: 'room.kick', seat: 1, playerId: 'stale' });
  assert.equal(team.room.matchCandidate, candidate, '失败的双校验不得取消候选');
  await ok(team.members[0], { t: 'room.kick', seat: 1, playerId: guest.id });
  assert.equal((await guest.waitFor('room.closed')).reason, 'kicked');
  for (const item of f.teams) {
    assert.equal(item.room.matchCandidate, null);
    assert.equal(item.room.match, null);
  }
  assert.equal(team.room.seatOf(guest.id), null);
  await bad(f.clients[2], { t: 'room.matchConfirm', candidateId: candidate.id, accept: true });
});

for (const ranked of [false, true]) test(`${ranked ? '排位' : '普通'}跨难度真实WS：投票不等于确认、重复确认幂等、平票取最高`, async (t) => {
  const f = await fixture(t, { ranked });
  const c = await f.queue();
  assert.ok(c); assert.equal(c.deadline - f.srv.lobby.now() > 19_000, true);
  assert.deepEqual(c.allowed, ranked ? ['NORMAL', 'HARD', 'ABYSS'] : ['FUNNY', 'NORMAL', 'HARD', 'ABYSS']);
  const state = f.teams[0].room.toState();
  const publicPayload = JSON.stringify(state.matchCandidate);
  for (const p of f.clients) assert.equal(publicPayload.includes(p.token), false);
  assert.equal(/"(token|aid|loadout)"/.test(publicPayload), false);
  assert.equal(f.teams[0].room.activeHumans().length, 2);
  assert.equal(f.teams[1].room.activeHumans().length, 2);
  if (ranked) await bad(f.clients[0], { t: 'room.matchDifficultyVote', candidateId: c.id, difficulty: 'FUNNY' });
  for (const [i, p] of f.clients.entries()) await vote(p, c, i < 2 ? 'NORMAL' : 'ABYSS');
  assert.equal(c.confirmed.size, 0); assert.equal(f.teams[0].room.match, null);
  await confirm(f.clients[0], c); await confirm(f.clients[0], c);
  assert.equal(c.confirmed.size, 1);
  for (const p of f.clients.slice(1)) await confirm(p, c);
  const started = await f.clients[3].waitFor('room.state', (s) => s.inMatch);
  assert.equal(started.difficulty, 'ABYSS'); assert.equal(started.ranked, ranked);
  assert.deepEqual(started.seats.map((s) => s.playerId), f.clients.map((p) => p.id));
  assert.ok(f.teams[0].room.match); assert.equal(f.srv.lobby.getRoom(f.teams[1].room.code), null);
  await bad(f.clients[0], { t: 'room.matchConfirm', candidateId: c.id, accept: true });
});

test('全员确认但未投票：完整20秒不早开，无票最终最高；真实定时器与真实Match', async (t) => {
  const f = await fixture(t);
  const c = await f.queue();
  for (const p of f.clients) await confirm(p, c);
  await delay(250);
  assert.equal(f.teams[0].room.match, null);
  const started = await f.clients[0].waitFor('room.state', (s) => s.inMatch, 22_000);
  assert.ok(Date.now() >= c.deadline); assert.equal(started.difficulty, 'ABYSS');
});

test('全员确认但有人未投：等到截止，最高票而非最高难度获胜', async (t) => {
  const f = await fixture(t); const c = await f.queue();
  for (const p of f.clients) await confirm(p, c);
  await vote(f.clients[0], c, 'NORMAL'); await vote(f.clients[1], c, 'NORMAL'); await vote(f.clients[2], c, 'ABYSS');
  assert.equal(f.teams[0].room.match, null);
  f.srv.lobby.now = () => c.deadline;
  f.srv.lobby.finishCandidate(c);
  assert.equal(f.teams[0].room.difficulty, 'NORMAL'); assert.ok(f.teams[0].room.match);
});

for (const action of ['reject', 'timeout', 'disconnect', 'cancel', 'leave', 'host-change']) test(`候选取消 ${action}：其他已确认原队整队回队列，旧候选和旧取消无效`, async (t) => {
  const f = await fixture(t); const c = await f.queue();
  const [good, other] = f.teams;
  const oldQueueId = good.room.matchFill.id;
  for (const p of good.members) await confirm(p, c);
  if (action === 'reject') await ok(other.members[1], { t: 'room.matchConfirm', candidateId: c.id, accept: false });
  if (action === 'timeout') { f.srv.lobby.now = () => c.deadline; f.srv.lobby.finishCandidate(c); }
  if (action === 'disconnect') {
    await other.members[1].terminate();
    await good.members[0].waitFor('room.matchCancelled', (m) => m.candidateId === c.id);
  }
  if (action === 'cancel') await ok(other.members[0], { t: 'room.matchFill', searching: false, queueId: other.room.matchFill.id });
  if (action === 'leave') await ok(other.members[0], { t: 'room.leave' });
  if (action === 'host-change') { other.room.hostId = other.members[1].id; await bad(other.members[0], { t: 'room.matchConfirm', candidateId: c.id, accept: true }); }
  assert.equal(f.srv.lobby.matchCandidates.size, 0);
  assert.equal(good.room.matchCandidate, null); assert.equal(good.room.match, null);
  assert.equal(f.srv.lobby.matchQueue.has(good.room.code), true);
  assert.deepEqual(good.room.activeHumans().map((s) => s.playerId), good.members.map((p) => p.id));
  assert.ok(good.room.matchFill.id !== oldQueueId);
  assert.equal(other.room.matchFill, null);
  await bad(good.members[0], { t: 'room.matchConfirm', candidateId: c.id, accept: true });
  await bad(good.members[0], { t: 'room.matchDifficultyVote', candidateId: c.id, difficulty: 'NORMAL' });
  await bad(good.members[0], { t: 'room.matchFill', searching: false, queueId: oldQueueId });
  assert.ok(good.room.matchFill);
});

test('一个原队只有部分确认时绝不拆队回队列；新候选拒绝跨候选旧票', async (t) => {
  const f = await fixture(t); const first = await f.queue();
  await confirm(f.clients[0], first);
  await ok(f.clients[3], { t: 'room.matchConfirm', candidateId: first.id, accept: false });
  assert.equal(f.srv.lobby.matchQueue.size, 0);
  assert.ok(f.teams.every((team) => team.room.activeHumans().length === 2));
  const second = await f.queue(); assert.notEqual(first.id, second.id);
  await bad(f.clients[0], { t: 'room.matchDifficultyVote', candidateId: first.id, difficulty: 'ABYSS' });
  assert.equal(second.votes.size, 0);
  f.srv.lobby.finishCandidate(first); assert.equal(f.teams[0].room.matchCandidate, second);
});

test('截止后确认不可补救且过期计时不能启动下一个候选', async (t) => {
  const f = await fixture(t); const c = await f.queue();
  for (const p of f.clients.slice(0, 3)) await confirm(p, c);
  const beforeNow = f.srv.lobby.now; f.srv.lobby.now = () => c.deadline;
  await bad(f.clients[3], { t: 'room.matchConfirm', candidateId: c.id, accept: true });
  assert.equal(f.teams[0].room.match, null);
  f.srv.lobby.now = beforeNow;
  await ok(f.teams[1].members[0], { t: 'room.matchFill', searching: true });
  const next = f.teams[0].room.matchCandidate; assert.ok(next);
  f.srv.lobby.finishCandidate(c); assert.equal(f.teams[0].room.matchCandidate, next);
});

test('AI补位仍需原队全员同意，再独立确认及难度投票才开局；不重复补机器人', async (t) => {
  const f = await fixture(t, { sizes: [2], ranked: true, difficulties: ['HARD'] });
  const room = f.teams[0].room; await f.queue();
  await ok(f.clients[0], { t: 'room.aiFillVote', choice: 'start', queueId: room.matchFill.id });
  const oldVoteId = room.matchFill.vote.id;
  await bad(f.clients[1], { t: 'room.aiFillVote', choice: 'yes', voteId: oldVoteId + 1 });
  await ok(f.clients[1], { t: 'room.aiFillVote', choice: 'yes', voteId: oldVoteId });
  const c = room.matchCandidate; assert.ok(c); assert.equal(c.botCount, 2); assert.equal(room.seats.filter((s) => s?.isBot).length, 0);
  await bad(f.clients[1], { t: 'room.aiFillVote', choice: 'yes', voteId: oldVoteId });
  for (const p of f.clients) { await vote(p, c, 'HARD'); await confirm(p, c); }
  assert.ok(room.match); assert.equal(room.seats.filter((s) => s?.isBot).length, 2);
  f.srv.lobby.finishCandidate(c); assert.equal(room.seats.filter((s) => s?.isBot).length, 2);
});

test('预组队2+1+1和四人原队都能生成候选；两人等待时不提前合并', async (t) => {
  const f = await fixture(t, { sizes: [2, 1, 1], difficulties: ['FUNNY', 'NORMAL', 'HARD'] });
  await ok(f.teams[0].members[0], { t: 'room.matchFill', searching: true });
  await ok(f.teams[1].members[0], { t: 'room.matchFill', searching: true });
  assert.equal(f.srv.lobby.matchCandidates.size, 0);
  assert.deepEqual(f.teams.map((team) => team.room.activeHumans().length), [2, 1, 1]);
  await ok(f.teams[2].members[0], { t: 'room.matchFill', searching: true });
  const c = f.teams[0].room.matchCandidate;
  assert.equal(c.teams.length, 3);
  for (const p of f.clients) { await confirm(p, c); await vote(p, c, 'FUNNY'); }
  assert.equal(f.teams[0].room.difficulty, 'FUNNY');
});

test('直接房间开始不增加确认；完整原队选择匹配时才有候选', async (t) => {
  const f = await fixture(t, { sizes: [4], difficulties: ['NORMAL'] });
  await ok(f.clients[0], { t: 'room.matchFill', searching: true });
  const room = f.teams[0].room; assert.ok(room.matchCandidate);
  await ok(f.clients[0], { t: 'room.matchFill', searching: false, queueId: room.matchFill.id });
  for (const p of f.clients.slice(1)) await ok(p, { t: 'room.ready', ready: true });
  await ok(f.clients[0], { t: 'room.start' });
  assert.ok(room.match); assert.equal(room.matchCandidate, null);
});

test('排位分差窗口保留且ranked+FUNNY不能绕过；普通池不读取分差', async (t) => {
  const f = await fixture(t, { ranked: true });
  const [a, b] = f.teams;
  for (const [team, points] of [[a, 1000], [b, 1450]]) for (const p of team.members) {
    Object.assign(f.srv.lobby.ranked.ensure(f.srv.registry.byId(p.id).aid), { placementDone: true, points });
  }
  assert.equal(await f.queue(), null);
  // 分差窗口取两队等待时间的较小值，不能以WS请求完成时间作为排队起点。
  const since = Math.max(a.room.matchFill.since, b.room.matchFill.since);
  f.srv.lobby.now = () => since + 29_999; f.srv.lobby.matchQueued();
  assert.equal(a.room.matchCandidate, null);
  f.srv.lobby.now = () => since + 30_000; f.srv.lobby.matchQueued();
  assert.ok(a.room.matchCandidate);
});

test('候选阶段不能加人或房间准备代替确认，取消后新队列拒绝旧AI启动', async (t) => {
  const f = await fixture(t); const c = await f.queue();
  const outsider = await TestClient.connect(`ws://127.0.0.1:${f.srv.port}/ws`); t.after(() => outsider.terminate()); await outsider.hello('新队友');
  await bad(outsider, { t: 'room.join', code: f.teams[0].room.code });
  await bad(f.clients[1], { t: 'room.ready', ready: true });
  assert.equal(c.confirmed.size, 0);
  const oldQueueId = f.teams[0].room.matchFill.id;
  for (const p of f.teams[0].members) await confirm(p, c);
  await ok(f.clients[3], { t: 'room.matchConfirm', candidateId: c.id, accept: false });
  await bad(f.clients[0], { t: 'room.aiFillVote', choice: 'start', queueId: oldQueueId });
  assert.equal(f.teams[0].room.matchFill.vote, null);
});

test('改票只保留一票，多数优先；旧队列AI启动与未授权成员都被拒绝', async (t) => {
  const f = await fixture(t); const c = await f.queue();
  await vote(f.clients[0], c, 'ABYSS'); await vote(f.clients[0], c, 'NORMAL');
  await vote(f.clients[1], c, 'NORMAL'); await vote(f.clients[2], c, 'HARD'); await vote(f.clients[3], c, 'ABYSS');
  assert.equal(c.votes.size, 4); assert.equal(f.teams[0].room.toState().matchCandidate.counts.NORMAL, 2);
  const outsider = await TestClient.connect(`ws://127.0.0.1:${f.srv.port}/ws`); t.after(() => outsider.terminate()); await outsider.hello('旁观者');
  await bad(outsider, { t: 'room.matchConfirm', candidateId: c.id, accept: true });
  await bad(f.clients[0], { t: 'room.matchDifficultyVote', candidateId: c.id, difficulty: 'INVALID' });
  for (const p of f.clients) await confirm(p, c);
  assert.equal(f.teams[0].room.difficulty, 'NORMAL');
});

for (const when of ['construct', 'start']) test(`对局${when}失败恢复原队，移除候选和机器人，不留半合并房间`, async (t) => {
  const f = await fixture(t, { expectedErrors: 1 }); const c = await f.queue();
  f.srv.lobby.MatchClass = class {
    constructor() { if (when === 'construct') throw new Error('测试构造失败'); }
    start() { throw new Error('测试启动失败'); }
    dispose() {}
  };
  for (const p of f.clients) { await confirm(p, c); await vote(p, c, 'HARD'); }
  for (const team of f.teams) {
    assert.equal(f.srv.lobby.getRoom(team.room.code), team.room);
    assert.equal(team.room.match, null); assert.equal(team.room.matchCandidate, null);
    assert.equal(team.room.matchFill, null);
    assert.deepEqual(team.room.activeHumans().map((s) => s.playerId), team.members.map((p) => p.id));
    for (const p of team.members) assert.equal(f.srv.registry.byId(p.id).roomCode, team.room.code);
    assert.equal(team.room.seats.filter((s) => s?.isBot).length, 0);
  }
});

test('最后一票到达前socket已经关闭但尚未触发onDisconnect也不能开局', async (t) => {
  const f = await fixture(t); const c = await f.queue();
  for (const p of f.clients) await confirm(p, c);
  for (const p of f.clients.slice(0, 3)) await vote(p, c, 'HARD');
  const dropped = f.srv.registry.byId(f.clients[3].id);
  dropped.ws.terminate();
  await bad(f.clients[0], { t: 'room.matchDifficultyVote', candidateId: c.id, difficulty: 'NORMAL' });
  assert.equal(f.teams[0].room.match, null);
});

test('段位弹窗边界逐分验证与权威rankOf一致，没有手写第二份表', () => {
  const rows = rankBoundaries(); assert.equal(rows.length, 25);
  for (let p = 0; p <= RADIANT_POINTS + 20; p++) {
    const row = rows.find((r) => p >= r.from && (r.to == null || p <= r.to));
    assert.equal(row.icon, rankOf(p).icon);
  }
  assert.deepEqual(rows.slice(-4).map((r) => [r.from, r.to]), [[2100, 2199], [2200, 2299], [2300, 2549], [2550, null]]);
});
