// Pure-memory lobby recovery regressions: no listeners, sockets, account I/O, or settlement replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Lobby } from '../server/lobby.js';
import { sendSession } from '../server/net.js';

function fixture() {
  const peers = new Map(), frames = new Map(), calls = { reconnect: 0, dispose: 0, settle: 0, observe: 0 };
  const peer = (playerId = 'p1') => {
    const out = []; frames.set(playerId, out);
    const session = { playerId, aid: playerId.padEnd(16, 'a'), name: playerId, connected: true, profileReady: true,
      profileBound: true, roomCode: null, spectatorCode: null, loginLease: { owner: playerId, generation: 1, epoch: 'test' },
      leaseUntil: performance.now() + 10_000, pendingResultGeneration: 0, pendingResultInFlight: 0,
      ws: { readyState: 1, send(data, complete) { out.push(JSON.parse(data)); complete?.(); }, terminate() {} } };
    peers.set(playerId, session); return session;
  };
  const lobby = Object.create(Lobby.prototype);
  Object.assign(lobby, { rooms: new Map(), registry: { byId: id => peers.get(id), all: () => peers.values() },
    profiles: { validSession: s => !s.loginRevoked && s.connected && performance.now() < s.leaseUntil,
      refresh() { throw Error('recovery may not refresh profiles'); },
      completeMatch() { calls.settle++; throw Error('recovery may not settle matches'); } },
    players: { record() { throw Error('recovery may not mutate player profiles'); } }, ranked: {},
    history: { record() { calls.settle++; throw Error('recovery may not write history'); } },
    now: () => performance.now(), opts: { resyncMinGapMs: 0 }, resyncTimers: new Map(), graceTimers: new Map(),
    recruitmentRooms: new Map(), log: { info() {}, error() {}, warn() {} },
    stopMatchFill() {}, releaseContent() {}, broadcastRecruitment() {}, broadcastState() {}, checkpoint() {},
    disposeMatchCtx() { calls.dispose++; },
    callMatchStrict(room, method, playerId) { room.match[method](playerId); } });
  const room = (members, { live = false } = {}) => {
    const seats = members.map((s, seat) => ({ seat, playerId: s.playerId, aid: s.aid, name: s.name,
      connected: true, isBot: false, left: false, ready: false }));
    const value = { code: 'ABCD', capacity: seats.length, seats, hostId: seats[0].playerId, spectators: new Set(),
      seatOf: pid => value.seats.find(s => s?.playerId === pid), activeHumans: () => value.seats.filter(s => s && !s.isBot && !s.left),
      toState: () => ({ t: 'room.state', code: value.code, inMatch: !!value.match }), match: null, matchCtx: null, replay: null };
    if (live) {
      value.matchCtx = { matchId: '1'.repeat(32), live: true, ended: false };
      value.match = { onReconnect(pid) {
        calls.reconnect++; sendSession(peers.get(pid), { t: 'm.public', phase: 'PREP' });
        sendSession(peers.get(pid), { t: 'm.private', playerId: pid });
      }, addObserver(pid) { calls.observe++; sendSession(peers.get(pid), { t: 'm.public', phase: 'PREP' }); }, removeObserver() {} };
    }
    lobby.rooms.set(value.code, value);
    for (const member of members) member.roomCode = value.code;
    return value;
  };
  const replay = (r, playerId = 'p1') => {
    r.replay = { matchId: '2'.repeat(32), publicFrame: JSON.stringify({ t: 'm.public', phase: 'ENDED' }),
      frames: new Map([[playerId, JSON.stringify({ t: 'm.result', matchId: '2'.repeat(32), players: [] })]]), pending: new Set([playerId]) };
    return lobby.replayFor(r, playerId);
  };
  const expire = session => { session.leaseUntil = performance.now() - 1; };
  const recover = session => { session.leaseUntil = performance.now() + 10_000; lobby.onLeaseRecovered(session); };
  return { lobby, peer, peers, frames, calls, room, replay, expire, recover };
}

test('lobby lease recovery restores room and current match state without login or settlement', () => {
  const f = fixture(), session = f.peer(), room = f.room([session], { live: true }), match = room.match;
  f.expire(session); f.lobby.onLeaseRecovered(session); assert.deepEqual(f.frames.get('p1'), []);
  f.recover(session);
  assert.deepEqual(f.frames.get('p1').map(x => x.t), ['room.state', 'm.public', 'm.private']);
  assert.equal(room.match, match); assert.equal(f.calls.reconnect, 1); assert.equal(f.calls.settle, 0);
});

test('lobby lease recovery resends only owed finished result frames and never settles again', () => {
  const f = fixture(), session = f.peer(), room = f.room([session]); f.replay(room);
  f.recover(session); f.recover(session);
  assert.deepEqual(f.frames.get('p1').map(x => x.t), ['room.state', 'm.public', 'm.result', 'room.state', 'm.public', 'm.result']);
  assert.equal(f.calls.reconnect, 0); assert.equal(f.calls.settle, 0);
});

test('lobby lease recovery drains a retained room close and detached result exactly once', () => {
  const f = fixture(), session = f.peer();
  session.notice = 'timeout'; session.pendingResult = [JSON.stringify({ t: 'm.result', matchId: '2'.repeat(32) })];
  f.expire(session); f.lobby.onLeaseRecovered(session); assert.equal(session.notice, 'timeout');
  f.recover(session); f.recover(session);
  assert.deepEqual(f.frames.get('p1').map(x => x.t), ['room.closed', 'm.result']);
  assert.equal(session.notice, null); assert.equal(session.pendingResult, null); assert.equal(f.calls.settle, 0);
});

test('disposeRoom preserves online lease-fenced close notice and replay before clearing the room', () => {
  const f = fixture(), session = f.peer(), room = f.room([session]);
  const replay = f.replay(room); f.expire(session); f.lobby.disposeRoom(room, 'shutdown');
  assert.equal(f.lobby.rooms.size, 0); assert.equal(session.roomCode, null); assert.equal(session.notice, 'shutdown');
  assert.deepEqual(session.pendingResult, replay); assert.deepEqual(f.frames.get('p1'), []);
  f.recover(session); f.recover(session);
  assert.deepEqual(f.frames.get('p1').map(x => x.t), ['room.closed', 'm.public', 'm.result']);
  assert.equal(f.calls.settle, 0);
});

test('kick preserves the removed player replay and a close refused during lease recovery', () => {
  const f = fixture(), host = f.peer('host'), target = f.peer('target'), room = f.room([host, target]);
  const replay = f.replay(room, target.playerId); f.expire(target);
  assert.deepEqual(f.lobby.kick(host, { seat: 1, playerId: target.playerId }), { ok: true });
  assert.equal(target.roomCode, null); assert.equal(target.notice, 'kicked'); assert.deepEqual(target.pendingResult, replay);
  assert.equal(room.seats[1], null); f.recover(target); f.recover(target);
  assert.deepEqual(f.frames.get('target').map(x => x.t), ['room.closed', 'm.public', 'm.result']);
  assert.equal(f.calls.settle, 0);
});

test('lobby lease recovery refreshes a current spectator without changing membership or granting controls', () => {
  const f = fixture(), host = f.peer('host'), viewer = f.peer('viewer'), room = f.room([host], { live: true });
  viewer.spectatorCode = room.code; viewer.spectatorMatchId = room.matchCtx.matchId; room.spectators.add(viewer.playerId);
  f.recover(viewer);
  assert.deepEqual(f.frames.get('viewer').map(x => x.t), ['spectator.state', 'm.public']);
  assert.equal(viewer.roomCode, null); assert.equal(f.calls.observe, 1); assert.equal(f.calls.reconnect, 0);
});

test('a lease-fenced spectator close is retained once and sent when authorization recovers', () => {
  const f = fixture(), host = f.peer('host'), viewer = f.peer('viewer'), room = f.room([host], { live: true });
  viewer.spectatorCode = room.code; viewer.spectatorMatchId = room.matchCtx.matchId; room.spectators.add(viewer.playerId);
  f.expire(viewer); f.lobby.closeSpectators(room, 'ended');
  assert.equal(viewer.spectatorCode, null); assert.equal(viewer.spectatorNotice, 'ended');
  f.recover(viewer); f.recover(viewer);
  assert.deepEqual(f.frames.get('viewer'), [{ t: 'spectator.closed', reason: 'ended' }]);
  assert.equal(viewer.spectatorNotice, null);
});

test('joining another spectator room clears an obsolete close notice before the new observer starts', () => {
  const f = fixture(), host = f.peer('host'), viewer = f.peer('viewer'), room = f.room([host], { live: true });
  viewer.spectatorNotice = 'ended';
  assert.deepEqual(f.lobby.joinSpectator(viewer, { code: room.code, matchId: room.matchCtx.matchId }), { ok: true });
  assert.equal(viewer.spectatorNotice, null); assert.equal(viewer.spectatorCode, room.code);
  f.frames.get('viewer').length = 0; f.recover(viewer);
  assert.equal(f.frames.get('viewer').some(x => x.t === 'spectator.closed'), false);
});

test('lease recovery ignores stale registry identity, disconnected, unready and revoked sessions', () => {
  for (const kind of ['stale', 'disconnected', 'unready', 'revoked']) {
    const f = fixture(), session = f.peer(); f.room([session], { live: true });
    if (kind === 'stale') f.peers.set(session.playerId, { ...session });
    if (kind === 'disconnected') session.connected = false;
    if (kind === 'unready') session.profileReady = false;
    if (kind === 'revoked') session.loginRevoked = true;
    f.lobby.onLeaseRecovered(session); assert.deepEqual(f.frames.get('p1'), [], kind);
  }
});

test('authenticated onHello sends a retained spectator close once without re-observing an ended match', async () => {
  const f = fixture(), session = f.peer(); session.spectatorNotice = 'ended';
  Object.assign(f.lobby.profiles, { refresh: async () => {} });
  Object.assign(f.lobby.players, { profiles: new Map(), getLoadout: () => null });
  Object.assign(f.lobby, { ranked: null, initializePresentation: async () => {}, sendRecruitment() {},
    sendLoadoutState() {}, applySessionPresentation() {}, presentationFor: () => ({}), sendPresentationState() {} });
  await f.lobby.onHello(session, { resumed: true, repeat: true });
  await f.lobby.onHello(session, { resumed: true, repeat: true });
  assert.deepEqual(f.frames.get('p1'), [{ t: 'spectator.closed', reason: 'ended' }]);
  assert.equal(session.spectatorNotice, null); assert.equal(f.calls.observe, 0); assert.equal(f.calls.settle, 0);
});

test('expiring a detached session drops its stale single spectator close notice', () => {
  const f = fixture(), session = f.peer(); session.spectatorNotice = 'ended';
  f.lobby.onExpire(session); assert.equal(session.spectatorNotice, null);
  f.recover(session); assert.deepEqual(f.frames.get('p1'), []);
});

test('one player replay capture failure cannot block room cleanup or another player retained result', () => {
  const f = fixture(), first = f.peer('first'), second = f.peer('second'), room = f.room([first, second]);
  const replay = f.replay(room, second.playerId); const replayFor = f.lobby.replayFor.bind(f.lobby);
  f.lobby.replayFor = (r, pid) => { if (pid === first.playerId) throw Error('injected replay capture failure'); return replayFor(r, pid); };
  f.expire(first); f.expire(second); f.lobby.disposeRoom(room, 'shutdown');
  assert.equal(room.disposed, true); assert.equal(f.lobby.rooms.size, 0);
  assert.equal(first.roomCode, null); assert.equal(second.roomCode, null);
  assert.equal(first.notice, 'shutdown'); assert.equal(second.notice, 'shutdown');
  assert.deepEqual(second.pendingResult, replay); f.recover(second);
  assert.deepEqual(f.frames.get('second').map(x => x.t), ['room.closed', 'm.public', 'm.result']);
});

test('recovering a vanished spectator room clears both stale spectator context fields', () => {
  const f = fixture(), viewer = f.peer('viewer');
  viewer.spectatorCode = 'ABCD'; viewer.spectatorMatchId = '1'.repeat(32); f.recover(viewer);
  assert.equal(viewer.spectatorCode, null); assert.equal(viewer.spectatorMatchId, null);
  assert.deepEqual(f.frames.get('viewer'), [{ t: 'spectator.closed', reason: 'ended' }]);
});
