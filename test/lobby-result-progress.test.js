import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';

function fixture() {
  const playerId = 'p1', aid = 'a'.repeat(32), matchId = '1'.repeat(32), frames = [], errors = [];
  const seat = { playerId, aid, name: 'P', connected: true, isBot: false, ready: true };
  const peer = { playerId, aid, roomCode: 'TEST', connected: true, profileReady: true,
    ws: { readyState: 1, send(frame, callback) { frames.push(JSON.parse(frame)); callback?.(); } } };
  const pending = { t: 'm.result', matchId, settlementPending: true, players: [{ playerId }] };
  const ctx = { matchId, live: true, ended: false, match: {}, ranked: true, seats: [seat], results: new Map([[playerId, JSON.stringify(pending)]]), lastPublic: null };
  const room = { code: 'TEST', test: false, match: ctx.match, matchCtx: ctx, matchKey: 'key', hostId: playerId,
    matchCount: 1, seats: [seat], activeHumans: () => [seat], seatOf: pid => pid === playerId ? seat : null };
  const lobby = Object.create(Lobby.prototype);
  Object.assign(lobby, { rooms: new Map([[room.code, room]]), now: () => 0,
    log: { info() {}, error(...args) { errors.push(args); } },
    registry: { all: () => [peer], byId: pid => pid === playerId ? peer : null },
    ranked: { summary: () => ({}) }, history: { record() {}, flush() {} },
    closeSpectators() {}, disposeMatchCtx() {}, broadcastState() {}, tellPluginsChanged() {}, checkpoint() {},
  });
  return { lobby, room, ctx, seat, peer, frames, errors, pending };
}

for (const mode of ['hang', 'reject']) test('lobby result progress: ' + mode + ' history cannot keep the ended match attached', async () => {
  const f = fixture(); let records = 0;
  f.lobby.history.record = () => { records++; return mode === 'hang' ? new Promise(() => {}) : Promise.reject(new Error('history unavailable')); };
  const ended = f.lobby.onMatchEnd(f.room, f.ctx, { players: [{ playerId: f.seat.playerId }] });
  assert.equal(f.room.match, null); assert.equal(f.room.matchCtx, null); assert.equal(f.seat.ready, false);
  assert.equal(f.ctx.ended, true); assert.equal(records, 1);
  await f.lobby.onMatchEnd(f.room, f.ctx, {}); assert.equal(records, 1);
  if (mode === 'reject') { await ended; assert.equal(f.errors.length, 1); }
});

for (const kind of ['settlementPending', 'incomplete']) test('lobby result progress: ' + kind + ' is never persisted as completed fallback history', async () => {
  const f = fixture(); let records = 0; f.lobby.history.record = () => records++;
  await f.lobby.onMatchEnd(f.room, f.ctx, { [kind]: true, players: [] });
  assert.equal(records, 0); assert.equal(f.room.match, null);
});

test('lobby result progress: rank notification errors cannot prevent room detachment', async () => {
  const f = fixture(); f.ctx.match.historyPersisted = true;
  f.lobby.ranked.summary = () => { throw new Error('rank display failed'); };
  await f.lobby.onMatchEnd(f.room, f.ctx, { players: [] });
  assert.equal(f.room.match, null); assert.equal(f.ctx.ended, true); assert.equal(f.errors.length, 1);
});

test('lobby result progress: late real receipt replaces only the owed replay and is deduplicated', async () => {
  const f = fixture(); await f.lobby.onMatchEnd(f.room, f.ctx, f.pending); f.frames.length = 0;
  const final = { t: 'm.result', matchId: f.ctx.matchId, players: [{ playerId: f.seat.playerId, rank: { after: 99 } }] };
  f.lobby.updateFinishedResult(f.ctx.matchId, final); f.lobby.updateFinishedResult(f.ctx.matchId, final);
  assert.equal(f.frames.length, 1); assert.equal(f.frames[0].matchId, f.ctx.matchId);
  assert.equal(f.frames[0].t, 'm.result'); assert.equal(f.frames[0].settlementPending, undefined);
  assert.equal(JSON.parse(f.room.replay.frames.get(f.seat.playerId)).players[0].rank.after, 99);
});

test('lobby result progress: leaving result or beginning a new match suppresses stale receipt replay', async () => {
  const f = fixture(); await f.lobby.onMatchEnd(f.room, f.ctx, f.pending); f.frames.length = 0;
  const final = { t: 'm.result', matchId: f.ctx.matchId, players: [{ playerId: f.seat.playerId }] };
  f.lobby.dropReplay(f.room, f.seat.playerId); f.lobby.updateFinishedResult(f.ctx.matchId, final);
  assert.equal(f.frames.length, 0);
  f.room.replay = { matchId: '2'.repeat(32), pending: new Set([f.seat.playerId]), frames: new Map() };
  f.lobby.updateFinishedResult(f.ctx.matchId, final); assert.equal(f.frames.length, 0);
});
