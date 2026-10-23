import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';

function fixture() {
  const sessions = new Map(), errors = [], sent = [];
  const room = { code: 'TEST', seats: [], spectators: new Set(), matchCtx: { matchId: 'match' }, disposed: false };
  const lobby = Object.create(Lobby.prototype);
  lobby.log = { error: (...args) => errors.push(args) };
  lobby.registry = { byId: pid => sessions.get(pid) }; lobby.profiles = { validSession: () => true };
  const add = (pid, spectator = false) => {
    const session = { playerId: pid, connected: true, profileReady: true, roomCode: room.code, spectatorMatchId: 'match',
      ws: { readyState: 1, bufferedAmount: 0, send: data => sent.push([pid, JSON.parse(data)]), terminate() {} } };
    sessions.set(pid, session);
    if (spectator) room.spectators.add(pid); else room.seats.push({ playerId: pid, isBot: false, left: false });
    return session;
  };
  return { lobby, room, sessions, errors, sent, add };
}
const fail = () => { throw new Error('injected authentication failure'); };

test('lobby send isolation: one member authentication failure denies that member but enumerates later authorized seats', () => {
  const { lobby, room, errors, add } = fixture(); add('bad'); add('denied'); add('good');
  lobby.profiles.validSession = ps => { if (ps.playerId === 'bad') fail(); return ps.playerId !== 'denied'; };
  assert.deepEqual([...lobby.memberSessions(room)].map(ps => ps.playerId), ['good']);
  assert.equal(errors.length, 1); assert.match(errors[0][0], /member session bad/);
});

test('lobby send isolation: registry lookup failure does not terminate member generator', () => {
  const { lobby, room, sessions, errors, add } = fixture(); add('bad'); add('good');
  lobby.registry.byId = pid => { if (pid === 'bad') fail(); return sessions.get(pid); };
  assert.deepEqual([...lobby.memberSessions(room)].map(ps => ps.playerId), ['good']); assert.equal(errors.length, 1);
});

test('lobby send isolation: member and spectator failures cannot block other authorized recipients or allow rejected recipients', () => {
  const { lobby, room, errors, sent, add } = fixture();
  add('bad_member'); add('good_member'); add('bad_spectator', true); add('denied_spectator', true); add('good_spectator', true);
  lobby.profiles.validSession = ps => { if (ps.playerId.startsWith('bad_')) fail(); return !ps.playerId.startsWith('denied_'); };
  assert.equal(typeof lobby.broadcastRoom(room, { t: 'm.public' }), 'string');
  assert.deepEqual(sent.map(([pid]) => pid), ['good_member', 'good_spectator']); assert.equal(errors.length, 2);
  assert.match(errors[1][0], /spectator session bad_spectator/);
});
