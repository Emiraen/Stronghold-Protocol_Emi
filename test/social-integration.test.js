import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { validateC2S } from '../shared/protocol.js';
import { observeTarget } from '../public/js/battle/observe.js';

async function fixture(t) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, seedFn: () => 721,
    ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }) });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  const player = async (name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    c.welcome = await c.hello(name, token, { aid: Buffer.from(name).toString('hex').slice(0, 64).padEnd(8, '0') });
    c.id = c.welcome.playerId;
    return c;
  };
  const team = [];
  for (let i = 0; i < 4; i++) team.push(await player(`队员${i}`));
  assert.equal((await team[0].request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', ranked: false })).t, 'ok');
  const state = await team[0].waitFor('room.state');
  for (const c of team.slice(1)) {
    assert.equal((await c.request({ t: 'room.join', code: state.code })).t, 'ok');
    assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
  }
  assert.equal((await team[0].request({ t: 'room.start' })).t, 'ok');
  const room = srv.lobby.getRoom(state.code);
  const id = room.matchCtx.matchId;
  const spectator = await player('观众');
  const outsider = await player('另一局');
  return { srv, player, team, room, id, spectator, outsider };
}

function noSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['aid', 'token', 'loadout'].includes(key), `公开帧泄露 ${key}`);
    noSecrets(child);
  }
}

async function toPrep(f) {
  for (const c of f.team) assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
  await f.team[0].waitFor('m.public', (m) => m.phase === 'BAND_DRAFT');
  const m = f.room.match;
  for (let i = 0; i < 4; i++) {
    const pid = m.draftTurn();
    const c = f.team.find((c) => c.id === pid);
    assert.equal((await c.request({ t: 'g.band', bandId: m.defaultBand(pid) })).t, 'ok');
  }
  await f.team[0].waitFor('m.public', (m) => m.phase === 'PREP', 10000);
}

test('社交协议：严格校验频道、对局标识、长度、观战目标与只读标志', () => {
  const id = 'a'.repeat(32);
  for (const msg of [
    { t: 'chat.send', channel: 'match', matchId: id, text: '好'.repeat(200) },
    { t: 'chat.send', text: '大厅' }, { t: 'spectator.list' }, { t: 'spectator.leave' },
    { t: 'spectator.join', code: 'ABCD', matchId: id }, { t: 'spectator.watch', fieldId: 'n:p_1' },
    { t: 'g.watch', fieldId: 'b1', viewOnly: true },
  ]) assert.equal(validateC2S(msg), null, JSON.stringify(msg));
  for (const msg of [
    { t: 'chat.send', channel: 'other', text: 'x' }, { t: 'chat.send', channel: 'match', text: 'x' },
    { t: 'chat.send', channel: 'lobby', matchId: id, text: 'x' }, { t: 'chat.send', text: 'x'.repeat(201) },
    { t: 'chat.send', text: '\u200b  ' }, { t: 'spectator.join', code: 'ABCD' },
    { t: 'spectator.join', code: 'abcd', matchId: id }, { t: 'spectator.watch', fieldId: {} },
    { t: 'g.watch', fieldId: 'b1', viewOnly: 'true' },
  ]) assert.ok(validateC2S(msg), JSON.stringify(msg));
});

test('四人比赛频道：仅同局成员收到，拒绝观众/跨局/旧局/超长及限速，复用敏感词', async (t) => {
  const f = await fixture(t);
  const { team, id, room, spectator, outsider } = f;
  assert.equal((await outsider.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' })).t, 'ok');
  assert.equal((await outsider.request({ t: 'room.start' })).t, 'ok');
  for (const c of team) {
    const history = await c.waitFor('chat.history', (m) => m.channel === 'match');
    assert.equal(history.matchId, id);
    assert.deepEqual(history.items, []);
    assert.equal((await c.request({ t: 'chat.send', channel: 'match', matchId: id, text: `成员${c.id}傻-逼` })).t, 'ok');
  }
  for (const c of team) for (const sender of team) {
    const msg = await c.waitFor('chat.message', (m) => m.playerId === sender.id && m.channel === 'match');
    assert.equal(msg.matchId, id);
    assert.ok(msg.text.includes('***'));
    assert.ok(!msg.text.includes('傻'));
    noSecrets(msg);
  }
  await Promise.all([spectator, outsider].map((c) => c.expectNone('chat.message', (m) => m.channel === 'match', 100)));
  for (const c of [spectator, outsider]) assert.equal((await c.request({ t: 'chat.send', channel: 'match', matchId: id, text: '伪造' })).t, 'error');
  assert.equal((await team[0].request({ t: 'chat.send', channel: 'match', matchId: id, text: '过快' })).code, 'RATE');
  assert.equal((await team[1].request({ t: 'chat.send', channel: 'match', matchId: id, text: 'x'.repeat(201) })).code, 'BAD_MSG');
  assert.equal((await team[2].request({ t: 'chat.send', channel: 'match', matchId: 'f'.repeat(32), text: '旧局' })).t, 'error');
  assert.equal((await team[3].request({ t: 'chat.send', text: '不能广播其他对局' })).t, 'error');
  assert.equal(room.matchCtx.chat.history().length, 4);
});

test('观战大厅仅列进行中局，无身份密钥；观众不占座、不收私有/聊天/结算且操作被拒', async (t) => {
  const f = await fixture(t);
  const { spectator: c, room, id, team } = f;
  assert.equal((await c.request({ t: 'spectator.list' })).t, 'ok');
  const list = await c.waitFor('spectator.list');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].players.length, 4);
  noSecrets(list);
  assert.equal((await c.request({ t: 'spectator.join', code: room.code, matchId: id })).t, 'ok');
  await c.waitFor('spectator.state');
  noSecrets(await c.waitFor('m.public'));
  noSecrets(await c.waitFor('m.field'));
  assert.equal(room.activeHumans().length, 4);
  assert.equal(room.match.order.length, 4);
  assert.ok(!room.match.players.has(c.id));
  for (const msg of [
    { t: 'room.ready', ready: true }, { t: 'room.start' }, { t: 'room.addBot' },
    { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' }, { t: 'room.loadout', entries: {} },
    { t: 'g.infoReady' }, { t: 'g.ready', ready: true }, { t: 'g.move', uid: 1, to: { area: 'hand', idx: 0 } },
    { t: 'g.watch', fieldId: `n:${team[0].id}`, viewOnly: true }, { t: 'g.pause', on: true }, { t: 'g.autoplay', on: true },
    { t: 'chat.send', channel: 'match', matchId: id, text: '观众插话' }, { t: 'chat.invite' },
    { t: 'b.progress', battleId: 'forged', gt: 0, killed: 0, total: 0 },
  ]) assert.equal((await c.request(msg)).t, 'error', JSON.stringify(msg));
  await c.expectNone('m.private');
  const rank = f.srv.lobby.ranked.size;
  room.match.finish({ victory: false, reason: 'defeat' });
  assert.equal((await c.waitFor('spectator.closed')).reason, 'ended');
  await c.expectNone('m.result');
  assert.equal(f.srv.lobby.ranked.size, rank);
  assert.equal(room.spectators.size, 0);
  assert.equal((await c.request({ t: 'spectator.list' })).t, 'ok');
  assert.deepEqual((await c.waitFor('spectator.list')).items, []);
});

test('观众离开、断线重连、超期及旧局入口清理；参赛者须先离开同盟', async (t) => {
  const f = await fixture(t);
  let { spectator: c, room, id, team } = f;
  assert.equal((await team[0].request({ t: 'spectator.join', code: room.code, matchId: id })).t, 'error');
  assert.equal((await c.request({ t: 'spectator.join', code: room.code, matchId: '0'.repeat(32) })).t, 'error');
  assert.equal((await c.request({ t: 'spectator.join', code: room.code, matchId: id })).t, 'ok');
  await c.waitFor('spectator.state');
  assert.equal((await c.request({ t: 'spectator.leave' })).t, 'ok');
  await c.waitFor('spectator.closed');
  assert.equal(room.spectators.size, 0);
  assert.equal(room.match.observers.size, 0);
  assert.equal((await c.request({ t: 'spectator.watch', fieldId: `n:${team[0].id}` })).t, 'error');
  assert.equal((await c.request({ t: 'spectator.join', code: room.code, matchId: id })).t, 'ok');
  const token = c.welcome.token;
  const pid = c.id;
  await c.terminate();
  c = await f.player('观众', token);
  assert.equal(c.id, pid);
  await c.waitFor('spectator.state');
  await c.waitFor('m.field');
  assert.equal(room.spectators.size, 1);
  f.srv.lobby.onExpire(f.srv.registry.byId(c.id));
  assert.equal(room.spectators.size, 0);
  assert.equal(room.match.observers.size, 0);
});

test('观众及参赛者切换阵地，战斗副本永不取得他人权威；阶段切换自动跟随', async (t) => {
  const f = await fixture(t);
  const { spectator: c, room, id, team } = f;
  assert.equal((await c.request({ t: 'spectator.join', code: room.code, matchId: id })).t, 'ok');
  await toPrep(f);
  for (const member of team) {
    const fieldId = `n:${member.id}`;
    assert.equal((await c.request({ t: 'spectator.watch', fieldId })).t, 'ok');
    noSecrets(await c.waitFor('m.field', (m) => m.fieldId === fieldId));
    assert.equal((await team[0].request({ t: 'g.watch', fieldId, viewOnly: true })).t, 'ok');
  }
  assert.equal((await c.request({ t: 'spectator.watch', fieldId: 'n:outside' })).t, 'error');
  for (const member of team) assert.equal((await member.request({ t: 'g.ready', ready: true })).t, 'ok');
  const shown = await c.waitFor('b.start', () => true, 10000);
  assert.equal(shown.watch, true);
  assert.equal(shown.authoritative, false);
  noSecrets(shown);
  const own = room.match.fields.find((f) => f.players.includes(team[0].id));
  const other = room.match.fields.find((f) => f.players.includes(team[1].id));
  const authority = own.authority;
  assert.equal((await team[0].request({ t: 'g.watch', fieldId: other.fieldId, viewOnly: true })).t, 'ok');
  const replica = await team[0].waitFor('b.start', (m) => m.fieldId === other.fieldId);
  assert.equal(replica.watch, true);
  assert.equal(replica.authoritative, false);
  assert.equal(own.authority, authority);
  assert.equal((await c.request({ t: 'spectator.watch', fieldId: own.fieldId })).t, 'ok');
  assert.equal((await c.waitFor('b.start', (m) => m.fieldId === own.fieldId)).authoritative, false);
  assert.equal((await c.request({ t: 'b.progress', battleId: own.battleId, gt: 10, killed: 1, total: 10 })).t, 'error');
  const result = { reason: 'cleared', time: 1, perPlayer: { [team[0].id]: {
    killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0,
    damageDealt: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [],
  } } };
  const report = { t: 'b.result', battleId: own.battleId, result };
  assert.equal(validateC2S(report), null, '结算结构有效，必须由身份权限拒绝而非格式校验');
  assert.equal((await c.request(report)).code, 'BAD_TARGET');
  assert.equal(own.authority, authority);
});

test('房间销毁清理观众身份与公开列表，不把观众作为参赛者结算', async (t) => {
  const f = await fixture(t);
  const { spectator: c, room, id } = f;
  assert.equal((await c.request({ t: 'spectator.join', code: room.code, matchId: id })).t, 'ok');
  await c.waitFor('spectator.state');
  const session = f.srv.registry.byId(c.id);
  f.srv.lobby.disposeRoom(room, 'empty');
  assert.equal((await c.waitFor('spectator.closed')).reason, 'empty');
  assert.equal(session.spectatorCode, null);
  assert.equal(session.spectatorMatchId, null);
  assert.equal(room.spectators.size, 0);
  assert.equal((await c.request({ t: 'spectator.list' })).t, 'ok');
  assert.deepEqual((await c.waitFor('spectator.list')).items, []);
  await c.expectNone('m.result');
});

test('参赛者重连恢复本局历史，下一局重置历史并拒绝旧频道', async (t) => {
  const f = await fixture(t);
  const { room, id } = f;
  let c = f.team[0];
  assert.equal((await c.request({ t: 'chat.send', channel: 'match', matchId: id, text: '本局历史' })).t, 'ok');
  const token = c.welcome.token;
  const pid = c.id;
  await c.terminate();
  c = await f.player('队员0', token);
  assert.equal(c.id, pid);
  const history = await c.waitFor('chat.history', (m) => m.channel === 'match');
  assert.equal(history.matchId, id);
  assert.equal(history.items[0].text, '本局历史');
  room.match.finish({ victory: false, reason: 'defeat' });
  for (const member of f.team.slice(1)) assert.equal((await member.request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  const next = room.matchCtx.matchId;
  assert.notEqual(next, id);
  assert.deepEqual((await c.waitFor('chat.history', (m) => m.channel === 'match' && m.matchId === next)).items, []);
  assert.equal((await c.request({ t: 'chat.send', channel: 'match', matchId: id, text: '旧频道' })).code, 'NOT_IN_ROOM');
});

test('客户端只读视角规则允许作战中及其他 boss 组，同时保留旧观战规则', () => {
  const pub = { phase: 'FINAL_ASSAULT', players: [{ playerId: 'p1', alive: true }, { playerId: 'p2', alive: true }],
    fields: [{ fieldId: 'b1', kind: 'boss', players: ['p1'], live: true }, { fieldId: 'b2', kind: 'boss', players: ['p2'], live: true }] };
  assert.ok(observeTarget(pub.players[1], pub, 'p1').reason);
  assert.deepEqual(observeTarget(pub.players[1], pub, 'p1', { viewOnly: true }), { fieldId: 'b2' });
  pub.phase = 'COMBAT';
  pub.fields.forEach((f) => { f.kind = 'normal'; });
  assert.deepEqual(observeTarget(pub.players[1], pub, 'p1', { viewOnly: true }), { fieldId: 'b2' });
});
