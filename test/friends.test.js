import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FriendsService, validateSocialSync } from '../server/friends.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { createAuthority } from '../server/profileService.js';
import { validateC2S, S2C } from '../shared/protocol.js';
import { socialModeName, friendPresenceText } from '../shared/friends.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
function fixture(options = {}) {
  let now = 100_000;
  const players = new PlayerStore({ file: null }), ranked = new RankedStore({ file: null }), history = new HistoryStore({ file: null });
  for (const [aid, name] of [[A, '甲博士'], [B, '乙博士'], [C, '丙博士']]) players.record(aid, name);
  const ids = Object.fromEntries([...players.profiles].map(([aid, p]) => [aid, p.id]));
  const stores = { players, ranked, history };
  const service = new FriendsService({ ...stores, now: () => now, random: () => .3, ...options });
  const presence = (aid, state = 'online', room) => ({ profileId: ids[aid], playerId: 'p_' + aid[0], state,
    lease: { owner: 'o_' + aid[0], generation: 1, serverId: aid === B ? 'secondary' : 'main' }, ...(room ? { room } : {}) });
  const action = (aid, action, fields = {}) => service.action(aid, { action, ...fields });
  const friend = async () => { await action(A, 'request', { targetId: ids[B] }); await action(B, 'accept', { targetId: ids[A] }); };
  const room = { code: 'ABCD', mode: 'coop', variant: 'entertainment_mizuki', capacity: 4, humans: 1, joinable: true };
  return { ...stores, ids, service, presence, action, friend, room, advance(ms) { now += ms; } };
}

test('friend requests, accept/reject, reciprocal requests and removal have real symmetric effects', async () => {
  const f = fixture();
  await assert.rejects(f.action(A, 'request', { targetId: f.ids[A] }), /自己/);
  await assert.rejects(f.action(A, 'request', { targetId: 'd'.repeat(32) }), /未找到/);
  await f.action(A, 'request', { targetId: f.ids[B] });
  await f.action(A, 'request', { targetId: f.ids[B] });
  assert.equal((await f.action(B, 'list')).requests.length, 1, 'duplicate requests do not accumulate');
  assert.deepEqual((await f.action(A, 'list')).outgoing, [f.ids[B]]);
  await f.action(B, 'request', { targetId: f.ids[A] });
  await f.action(B, 'accept', { targetId: f.ids[A] });
  assert.deepEqual((await f.action(A, 'list')).friends.map(p => p.id), [f.ids[B]]);
  assert.deepEqual((await f.action(B, 'list')).friends.map(p => p.id), [f.ids[A]]);
  assert.equal((await f.action(A, 'list')).requests.length, 0);
  assert.equal((await f.action(A, 'list')).outgoing.length, 0);
  await f.action(A, 'remove', { targetId: f.ids[B] });
  assert.equal((await f.action(B, 'list')).friends.length, 0);
  await f.action(C, 'request', { targetId: f.ids[B] });
  await f.action(B, 'reject', { targetId: f.ids[C] });
  assert.equal((await f.action(B, 'list')).requests.length, 0);
  await assert.rejects(f.action(B, 'accept', { targetId: f.ids[C] }), /已处理/);
});

test('search, recommendations, rank details and history reveal only public profile data', async () => {
  const f = fixture();
  await f.service.sync('main', [f.presence(A)]);
  await f.service.sync('secondary', [f.presence(B)]);
  assert.equal((await f.action(A, 'search', { query: '乙博士' })).items[0].id, f.ids[B]);
  assert.deepEqual((await f.action(A, 'search', { query: '' })).items, []);
  assert.deepEqual((await f.action(A, 'recommend')).items.map(p => p.id), [f.ids[B]], 'only online nonfriends are recommended');
  const rank = f.ranked.ensure(B, '乙博士'); rank.placementDone = true; rank.points = 2600; rank.wins = 8;
  const matchId = '1'.repeat(32);
  f.history.record({ matchId, seats: [{ aid: B, playerId: 'p_b', name: '乙博士' }], ranked: true,
    summary: { players: [{ playerId: 'p_b', name: '乙博士', stats: { kills: 10 } }] } });
  const detail = await f.action(A, 'profile', { targetId: f.ids[B] });
  assert.equal(detail.player.rank.points, 2600);
  assert.equal(detail.player.rank.wins, 8);
  assert.equal(detail.items.length, 1);
  assert.equal((await f.action(A, 'history', { targetId: f.ids[B], matchId })).playerId, 'p_b');
  await assert.rejects(f.action(A, 'history', { targetId: f.ids[C], matchId }), /不可用/);
  const serialized = JSON.stringify(detail);
  for (const privateValue of [A, B, C, 'loginLease', 'token', 'firstSeen', 'lastSeen']) assert.ok(!serialized.includes(privateValue));
  await f.friend();
  assert.equal((await f.action(A, 'recommend')).items.length, 0);
});

test('cross-region presence, player counts, spectators and offline TTL are accurate; idle polls send no repeated bodies', async () => {
  const f = fixture(); await f.friend();
  const room = { ...f.room, matchId: '2'.repeat(32), humans: 2, capacity: 4, spectatable: true, joinable: false, variant: null };
  await f.service.sync('secondary', [f.presence(B, 'playing', room)]);
  let frames = await f.service.sync('main', [f.presence(A)]);
  assert.equal(frames[0].state.friends[0].presence.watch.serverId, 'secondary');
  assert.equal(friendPresenceText(frames[0].state.friends[0].presence), '同盟模拟（2/4）');
  assert.deepEqual(await f.service.sync('main', [f.presence(A)]), []);
  await f.service.sync('secondary', [f.presence(B, 'playing', { ...room, spectatable: false, variant: 'entertainment_mizuki' })]);
  frames = await f.service.sync('main', [f.presence(A)]);
  assert.equal(frames[0].state.friends[0].presence.watch, undefined);
  assert.equal(frames[0].state.friends[0].presence.modeName, '水月联合探索');
  f.advance(10_001);
  assert.equal((await f.action(A, 'list')).friends[0].presence.state, 'offline');
});

test('invitations derive the authoritative room, accept safely, expire, and block nonfriends/full rooms', async () => {
  const f = fixture();
  await f.service.sync('main', [f.presence(A, 'room', f.room)]);
  await f.service.sync('secondary', [f.presence(B)]);
  await assert.rejects(f.action(A, 'invite', { targetId: f.ids[B] }), /好友/);
  await f.friend();
  await f.action(A, 'invite', { targetId: f.ids[B] });
  const invite = (await f.action(B, 'list')).invitations[0];
  assert.equal(invite.from.name, '甲博士'); assert.equal(invite.modeName, '水月联合探索');
  await assert.rejects(f.action(C, 'respond', { inviteId: invite.id, accept: true }), /失效/);
  const accepted = await f.action(B, 'respond', { inviteId: invite.id, accept: true });
  assert.deepEqual(accepted.join, { serverId: 'main', code: 'ABCD' });
  await f.service.sync('secondary', [f.presence(B, 'room', f.room)]);
  // Same room code on a different server must not count as joined.
  assert.equal((await f.action(B, 'list')).invitations.length, 1);
  await f.service.sync('main', [f.presence(A, 'room', { ...f.room, joinable: false })]);
  assert.equal((await f.action(B, 'list')).invitations.length, 0);
  await assert.rejects(f.action(A, 'invite', { targetId: f.ids[B] }), /无法邀请/);
  await f.service.sync('main', [f.presence(A, 'room', f.room)]);
  await f.action(A, 'invite', { targetId: f.ids[B] });
  f.advance(120_001);
  assert.equal((await f.action(B, 'list')).invitations.length, 0);
});

test('accepting while playing creates a reservation; leaving the game offers joining without interrupting it', async () => {
  const f = fixture(); await f.friend();
  await f.service.sync('main', [f.presence(A, 'room', f.room)]);
  await f.service.sync('secondary', [f.presence(B, 'playing', { ...f.room, code: 'NPQR', joinable: false })]);
  await f.action(A, 'invite', { targetId: f.ids[B] });
  const invite = (await f.action(B, 'list')).invitations[0];
  assert.equal(invite.kind, 'reservation');
  assert.equal((await f.action(B, 'respond', { inviteId: invite.id, accept: true })).reserved, true);
  assert.equal((await f.action(B, 'list')).invitations[0].status, 'reserved');
  await f.service.sync('secondary', [f.presence(B)]);
  assert.equal((await f.action(B, 'list')).invitations[0].status, 'ready');
  assert.ok((await f.action(B, 'respond', { inviteId: invite.id, accept: true })).join);
});

test('ignore one sender for exactly one hour, including across service restarts, without muting other friends', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stronghold-friends-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'friends.json'), f = fixture({ file }); await f.friend();
  await f.service.sync('main', [f.presence(A, 'room', f.room)]); await f.service.sync('secondary', [f.presence(B)]);
  await f.action(A, 'invite', { targetId: f.ids[B] });
  const invite = (await f.action(B, 'list')).invitations[0];
  await f.action(B, 'respond', { inviteId: invite.id, accept: false, mute: true });
  await f.action(A, 'invite', { targetId: f.ids[B] });
  assert.equal((await f.action(B, 'list')).invitations.length, 0);
  const restart = new FriendsService({ players: f.players, ranked: f.ranked, history: f.history, file, now: () => 100_001 });
  assert.equal((await restart.action(A, { action: 'list' })).friends.length, 1);
  assert.ok(restart.state.mutes[f.ids[B]][f.ids[A]] > 100_001);
  f.advance(3600_001);
  await f.service.sync('main', [f.presence(A, 'room', f.room)]); await f.service.sync('secondary', [f.presence(B)]);
  await f.action(A, 'invite', { targetId: f.ids[B] });
  assert.equal((await f.action(B, 'list')).invitations.length, 1);
});

test('accept plus one-hour mute still accepts this invitation and mutes future ones', async () => {
  const f = fixture(); await f.friend();
  await f.service.sync('main', [f.presence(A, 'room', f.room)]); await f.service.sync('secondary', [f.presence(B)]);
  await f.action(A, 'invite', { targetId: f.ids[B] });
  const invite = (await f.action(B, 'list')).invitations[0];
  assert.ok((await f.action(B, 'respond', { inviteId: invite.id, accept: true, mute: true })).join);
  assert.ok(f.service.state.mutes[f.ids[B]][f.ids[A]]);
});

test('authority authenticates both regional leases, ignores forged roster identity, and rejects invalid actions', async () => {
  const f = fixture(), authority = createAuthority(f);
  const a = await authority.call('login', [{ serverId: 'main', owner: 'a'.repeat(36) + ':' + '1'.repeat(36), generation: 1, name: '甲博士', fixedAid: A }]);
  const b = await authority.call('login', [{ serverId: 'secondary', owner: 'b'.repeat(36) + ':' + '2'.repeat(36), generation: 1, name: '乙博士', fixedAid: B }]);
  assert.ok(a.lease && b.lease);
  const rows = await authority.call('social.sync', [{ serverId: 'main', roster: [{ ...f.presence(B), lease: a.lease, profileId: f.ids[B] }] }]);
  assert.equal(rows[0].state.selfId, f.ids[A], 'identity is derived from the verified login lease');
  await authority.call('social.action', [a.lease, { action: 'request', targetId: f.ids[B] }]);
  const request = await authority.call('social.action', [b.lease, { action: 'list' }]);
  assert.equal(request.requests[0].player.id, f.ids[A]);
  await authority.call('lease.release', [a.lease]);
  await assert.rejects(authority.call('social.action', [a.lease, { action: 'request', targetId: f.ids[C] }]), /失效/);
  assert.throws(() => validateSocialSync({ serverId: 'main', roster: [{ ...f.presence(A), room: { ...f.room, capacity: -1 } }] }));
  assert.equal(validateC2S({ t: 'friends.action', action: 'request', targetId: f.ids[B] }), null);
  assert.notEqual(validateC2S({ t: 'friends.action', action: 'request', targetId: 'bad' }), null);
  assert.notEqual(validateC2S({ t: 'friends.action', action: 'request', aid: B, targetId: f.ids[B] }), null);
  assert.ok(S2C.includes('friends.state') && S2C.includes('friends.result'));
});

test('all mode labels distinguish ranked, standard and entertainment variants', () => {
  for (const [variant, expected] of [['entertainment_mizuki', '水月联合探索'], ['entertainment_annihilation', '湮灭模拟'], ['entertainment_endless', '无尽模式'], ['entertainment_cyclops', '舟铲铲之战'], ['entertainment_multi', '多人模式']]) assert.equal(socialModeName({ variant }), expected);
  assert.equal(socialModeName({ mode: 'solo', ranked: true }), '独立排位');
  assert.equal(friendPresenceText(null), '离线');
});

test('unacknowledged social deliveries replay after a lost regional response, then stop after acknowledgement', async () => {
  const f = fixture(), row = { ...f.presence(A), seenRevision: 0 };
  const first = await f.service.sync('main', [row]);
  const retry = await f.service.sync('main', [row]);
  assert.equal(retry[0].state.revision, first[0].state.revision, 'retry reuses the same ordered snapshot');
  assert.deepEqual(await f.service.sync('main', [{ ...row, seenRevision: first[0].state.revision }]), []);
  await f.action(B, 'request', { targetId: f.ids[A] });
  const changed = await f.service.sync('main', [{ ...row, seenRevision: first[0].state.revision }]);
  assert.equal(changed[0].state.requests.length, 1);
  assert.ok(changed[0].state.revision > first[0].state.revision);
});


test('private messages are friend-only, durable, idempotent and unread until the recipient reads the received sequence', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'stronghold-pm-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const file=path.join(folder,'friends.json'),f=fixture({file});
  const request={targetId:f.ids[B],text:'你好\n一起玩炸惊吗？',clientId:'1'.repeat(32)};
  await assert.rejects(f.action(A,'message.send',request),/好友/);await f.friend();
  const sent=await f.action(A,'message.send',request);assert.equal(sent.message.seq,1);
  assert.deepEqual(await f.action(A,'message.send',request),sent);
  await assert.rejects(f.action(A,'message.send',{...request,text:'changed'}),/编号/);
  let state=await f.action(B,'list');assert.equal(state.threads[0].unread,1);
  assert.equal((await f.action(C,'list')).threads.length,0);
  await assert.rejects(f.action(C,'message.list',{targetId:f.ids[A]}),/好友/);
  assert.equal((await f.action(B,'message.list',{targetId:f.ids[A]})).items[0].text,request.text);
  assert.equal((await f.action(B,'list')).threads[0].unread,1,'fetching for local archival is not reading');
  await f.action(B,'message.read',{targetId:f.ids[A],throughSeq:1});assert.equal((await f.action(B,'list')).threads[0].unread,0);
  await assert.rejects(f.action(B,'message.read',{targetId:f.ids[A],throughSeq:2}),/无效/);
  const restart=new FriendsService({players:f.players,ranked:f.ranked,history:f.history,file,now:()=>100000});
  assert.equal((await restart.action(B,{action:'message.list',targetId:f.ids[A]})).items[0].id,sent.message.id);
  await f.action(A,'remove',{targetId:f.ids[B]});await assert.rejects(f.action(A,'message.list',{targetId:f.ids[B]}),/好友/);
});

test('private messages expire after exactly 24 hours and regional sync persists their removal without reusing sequences', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'stronghold-pm-ttl-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const file=path.join(folder,'friends.json'),f=fixture({file});await f.friend();
  await f.action(A,'message.send',{targetId:f.ids[B],text:'一天前的消息',clientId:'2'.repeat(32)});
  f.advance(86400000-1);assert.equal((await f.action(B,'message.list',{targetId:f.ids[A]})).items.length,1);
  f.advance(1);await f.service.sync('main',[]);
  assert.ok(!fs.readFileSync(file,'utf8').includes('一天前的消息'));
  assert.equal((await f.action(B,'message.list',{targetId:f.ids[A]})).items.length,0);
  const next=await f.action(B,'message.send',{targetId:f.ids[A],text:'新消息',clientId:'3'.repeat(32)});
  assert.equal(next.message.seq,2);
});

test('private message history pages neither overlap nor skip; invalid text and forged metadata are rejected', async () => {
  const f=fixture();await f.friend();
  for(let i=0;i<61;i++){f.advance(1100);await f.action(A,'message.send',{targetId:f.ids[B],text:'消息'+i,clientId:i.toString(16).padStart(32,'0')});}
  const latest=await f.action(B,'message.list',{targetId:f.ids[A]});assert.equal(latest.items.length,50);assert.equal(latest.items[0].seq,12);assert.equal(latest.hasOlder,true);
  const older=await f.action(B,'message.list',{targetId:f.ids[A],beforeSeq:12});assert.deepEqual(older.items.map(x=>x.seq),Array.from({length:11},(_,i)=>i+1));
  const incremental=await f.action(B,'message.list',{targetId:f.ids[A],afterSeq:0});assert.equal(incremental.items.at(-1).seq,50);assert.equal(incremental.hasNewer,true);
  for(const text of ['   ','x'.repeat(501),'bad\u0000'])assert.notEqual(validateC2S({t:'friends.action',action:'message.send',targetId:f.ids[B],clientId:'4'.repeat(32),text}),null);
  assert.notEqual(validateC2S({t:'friends.action',action:'message.send',targetId:f.ids[B],clientId:'4'.repeat(32),text:'hi',from:f.ids[C]}),null);
});
