// Drive the real main.js handlers without booting browser UI or opening a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { createStore, initialState, emptyMatch, selectRoute, sessionResetNotice } from '../../public/js/store.js';
import { startBuildGuard } from '../../public/js/ui/buildGuard.js';

const source = readFileSync(process.env.SP_SESSION_RESTORE_SOURCE || new URL('../../public/js/main.js', import.meta.url), 'utf8');
const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const functions = new Set(['payload', 'clearRoomParam', 'clearPendingJoin', 'schedulePendingJoin',
  'maybeFinishRestore', 'backToLobby', 'onWelcome', 'onRoomState', 'wireNet']);
const variables = new Set(['RESTORE_GRACE_MS', 'JOIN_DELAY_MS', 'TICKER_KEEP', 'EMOTE_KEEP', 'CLOSE_REASON', 'seq',
  'welcomeAt', 'roomStateAt', 'matchAt', 'restoreTimer', 'restoreGeneration', 'roomGeneration',
  'matchGeneration', 'joinTimer', 'joinInFlight', 'appMounted', 'matchDismissed']);
const handlers = program.body.filter(node => (node.type === 'FunctionDeclaration' && functions.has(node.id?.name))
  || (node.type === 'VariableDeclaration' && node.declarations.some(item => variables.has(item.id?.name))));
assert.equal(handlers.filter(node => node.type === 'FunctionDeclaration').length, functions.size);
const script = handlers.map(node => source.slice(node.start, node.end)).join('\n') + '\nwireNet();';

function harness({ spectator = false, waiting = false } = {}) {
  const store = createStore(structuredClone(initialState));
  const room = { code: 'ROOM1', mode: 'coop', inMatch: !waiting,
    seats: [{ playerId: 'p1' }, { playerId: 'p2' }] };
  const match = { ...emptyMatch(), public: { matchId: 'match1', phase: 'COMBAT', round: 8 },
    private: { gold: 12 }, field: { fieldId: 'field1' }, battle: { battleId: 'battle1', done: false } };
  store.set({ session: { entered: true }, me: { playerId: 'p1', name: 'Player', token: 'token' },
    room: spectator ? null : room,
    spectator: spectator ? { code: 'ROOM1', targetPlayerId: 'p2' } : null,
    match: waiting ? emptyMatch() : match });
  const clock = { now: 100_000, nextId: 0, pending: new Map() };
  const routes = [], toasts = [], results = [], listeners = new Map();
  store.subscribe(state => routes.push(selectRoute(state)));
  const net = {
    status: 'online',
    on(type, fn) { listeners.set(type, fn); },
  };
  class TestDate extends Date { static now() { return clock.now; } }
  const noop = () => {};
  const context = { store, net, emptyMatch, sessionResetNotice, Date: TestDate,
    identity: { saveName: noop, saveToken: noop, clearAuth: noop, clearToken: noop, setEntered: noop },
    closeAllDialogs: noop, toast: (...args) => toasts.push(args), toastError: noop, t: value => value,
    warmGameData: noop, scheduleMatchPrefetch: noop, rememberRoom: noop, recordResult: (...args) => results.push(args),
    setTimeout(fn, delay) {
      const id = ++clock.nextId;
      clock.pending.set(id, { fn, at: clock.now + delay });
      return id;
    },
    clearTimeout(id) { clock.pending.delete(id); },
  };
  runInNewContext(script, context, { filename: 'main-session-restore.js' });
  function emit(type, fields = {}) {
    if (type === 'status') net.status = fields.status;
    assert.ok(listeners.has(type), 'real main handler is registered: ' + type);
    listeners.get(type)({ t: type, ...fields });
  }
  function advance(ms) {
    const end = clock.now + ms;
    for (let count = 0; count < 1000; count++) {
      const next = [...clock.pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { clock.now = end; return; }
      const [id, timer] = next;
      clock.pending.delete(id);
      clock.now = timer.at;
      timer.fn();
    }
    assert.fail('timer loop did not settle');
  }
  return { store, room, match, routes, toasts, results, emit, advance,
    welcome: fields => emit('welcome', { playerId: 'p1', name: 'Player', token: 'token2',
      roomCode: spectator ? null : room.code, spectatorCode: spectator ? room.code : null, ...fields }),
    roomState: fields => emit('room.state', { ...room, ...fields }),
    publicState: fields => emit('m.public', { ...match.public, ...fields }),
  };
}

function assertInGame(h) {
  assert.equal(selectRoute(h.store.get()), 'game');
  assert.ok(h.routes.every(route => route === 'game'), 'recovery must not unmount the game screen');
}

test('same-session recovery delayed beyond 1500 ms keeps the room, board and battle runner', () => {
  const h = harness();
  h.emit('status', { status: 'reconnecting' });
  h.welcome();
  h.advance(2500);
  assertInGame(h);
  assert.equal(h.store.get().room, h.room);
  assert.equal(h.store.get().match.field, h.match.field);
  assert.equal(h.store.get().match.battle, h.match.battle);
  assert.equal(h.store.get().ui.restoring, true);
  h.roomState();
  h.publicState({ round: 9 });
  assertInGame(h);
  assert.equal(h.store.get().match.public.round, 9);
  assert.equal(h.store.get().match.battle, h.match.battle);
  assert.equal(h.store.get().ui.restoring, false);
});

test('another disconnect during recovery cannot let an old timer erase the match', () => {
  const h = harness();
  h.welcome();
  h.advance(500);
  h.emit('status', { status: 'reconnecting' });
  h.advance(10_000);
  assertInGame(h);
  h.welcome();
  h.advance(3000);
  assertInGame(h);
  h.roomState(); h.publicState();
  assertInGame(h);
  assert.equal(h.store.get().ui.restoring, false);
});

test('a late public snapshot does not erase the existing board after room recovery', () => {
  const h = harness();
  h.welcome(); h.roomState();
  h.advance(5000);
  assertInGame(h);
  assert.equal(h.store.get().match.public, h.match.public);
  assert.equal(h.store.get().match.field, h.match.field);
  assert.equal(h.store.get().ui.restoring, true);
  h.publicState();
  assert.equal(h.store.get().ui.restoring, false);
});

test('private state in the same millisecond is not proof of public-state recovery', () => {
  const h = harness();
  h.welcome();
  h.emit('m.private', { gold: 15 });
  h.roomState();
  assert.equal(h.store.get().ui.restoring, true);
  assertInGame(h);
  h.publicState();
  assert.equal(h.store.get().ui.restoring, false);
});

test('multiple welcomes within one millisecond each require their own recovery frames', () => {
  const h = harness();
  h.welcome(); h.roomState(); h.publicState();
  assert.equal(h.store.get().ui.restoring, false);
  h.welcome(); h.roomState();
  assert.equal(h.store.get().ui.restoring, true, 'the previous generation is not a recovered match');
  h.publicState();
  assert.equal(h.store.get().ui.restoring, false);
  assertInGame(h);
});

test('public recovery may precede room recovery without losing the running game', () => {
  const h = harness();
  h.welcome(); h.publicState({ round: 9 });
  h.advance(2500);
  assertInGame(h);
  assert.equal(h.store.get().ui.restoring, true);
  h.roomState();
  assert.equal(h.store.get().ui.restoring, false);
  assertInGame(h);
});

test('a real room closure still immediately exits and late combat frames cannot reopen it', () => {
  const h = harness();
  h.welcome();
  h.emit('room.closed', { reason: 'timeout' });
  h.advance(5000);
  h.publicState();
  assert.equal(selectRoute(h.store.get()), 'lobby');
  assert.equal(h.store.get().room, null);
  assert.equal(h.store.get().match.public, null);
  assert.equal(h.store.get().ui.restoring, false);
});

test('a processed leave with a lost ACK is resolved by authoritative empty welcome context', () => {
  const h = harness();
  h.emit('status', { status: 'reconnecting' });
  h.welcome({ roomCode: null, spectatorCode: null });
  h.advance(5000);
  assert.equal(selectRoute(h.store.get()), 'lobby');
  assert.equal(h.store.get().room, null);
  assert.equal(h.store.get().match.battle, null);
  assert.equal(h.store.get().ui.restoring, false);
});

test('authoritative empty welcome context still accepts a subsequent pending result replay', () => {
  const h = harness();
  h.welcome({ roomCode: null, spectatorCode: null });
  h.publicState({ phase: 'RESULT' });
  h.emit('m.result', { matchId: 'match1', outcome: 'completed' });
  assert.equal(selectRoute(h.store.get()), 'game');
  assert.equal(h.store.get().match.public.phase, 'RESULT');
  assert.equal(h.store.get().match.result.matchId, 'match1');
});

test('an older server omitting welcome context is not mistaken for an authoritative empty room', () => {
  const h = harness();
  h.welcome({ roomCode: undefined, spectatorCode: undefined });
  h.advance(10_000);
  assertInGame(h);
  h.roomState(); h.publicState();
  assert.equal(h.store.get().ui.restoring, false);
});

test('a new server session still clears the old match with a reset notice', () => {
  const h = harness();
  h.welcome({ playerId: 'p_new' });
  h.advance(5000);
  assert.equal(selectRoute(h.store.get()), 'lobby');
  assert.equal(h.store.get().match.battle, null);
  assert.equal(h.store.get().ui.restoring, false);
  assert.ok(h.toasts.some(([text]) => text === '服务器会话已重置，上一局模拟已结束'));
});

test('a waiting room also survives slow same-session recovery without a phantom exit', () => {
  const h = harness({ waiting: true });
  h.welcome(); h.advance(5000);
  assert.equal(selectRoute(h.store.get()), 'room');
  h.roomState({ inMatch: false });
  assert.equal(h.store.get().ui.restoring, false);
  assert.ok(h.routes.every(route => route === 'room'));
});

test('spectator recovery also keeps the game route while snapshots are delayed', () => {
  const h = harness({ spectator: true });
  h.welcome(); h.advance(5000);
  assertInGame(h);
  assert.equal(h.store.get().match.battle, h.match.battle);
  h.emit('spectator.state', { code: 'ROOM1', targetPlayerId: 'p2' });
  h.publicState();
  assertInGame(h);
  assert.equal(h.store.get().ui.restoring, false);
});

test('an explicit spectator closure exits immediately rather than retaining stale state', () => {
  const h = harness({ spectator: true });
  h.welcome(); h.emit('spectator.closed', { reason: 'ended' });
  h.advance(5000);
  assert.equal(selectRoute(h.store.get()), 'lobby');
  assert.equal(h.store.get().spectator, null);
  assert.equal(h.store.get().ui.restoring, false);
});

test('an authoritative seat removal clears both the match and the restoring indicator', () => {
  const h = harness();
  h.welcome(); h.roomState({ seats: [{ playerId: 'p2' }] });
  h.advance(5000);
  assert.equal(selectRoute(h.store.get()), 'lobby');
  assert.equal(h.store.get().match.public, null);
  assert.equal(h.store.get().ui.restoring, false);
});

test('server switching still discards the previous server context without a delayed resurrection', () => {
  const h = harness();
  h.welcome(); h.emit('serverSwitch'); h.advance(5000);
  assert.equal(selectRoute(h.store.get()), 'title');
  assert.equal(h.store.get().room, null);
  assert.equal(h.store.get().match.public, null);
});

test('a stale-build check during slow recovery cannot mistake the match for the lobby and reload', async () => {
  const h = harness();
  let build = 'old-build', reloads = 0;
  const guard = startBuildGuard({
    fetchFn: async () => ({ ok: true, json: async () => ({ build }) }),
    inMatch: () => selectRoute(h.store.get()) === 'game',
    reload: () => { reloads++; },
    setInterval: () => 1, clearInterval: () => {},
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    h.welcome(); h.advance(2500);
    build = 'new-build';
    await guard.check(); await guard.check();
    assert.equal(reloads, 0);
    assertInGame(h);
    h.roomState(); h.publicState();
    assert.equal(reloads, 0);
  } finally { guard.stop(); }
});

test('pending result is replaced by its same-match authoritative receipt without altering combat context', () => {
  const h = harness();
  h.publicState({ phase: 'RESULT' });
  h.emit('m.result', { matchId: 'match1', settlementPending: true });
  assert.equal(h.store.get().match.result.settlementPending, true);
  assert.equal(h.results[0][1].historyOnly, false);
  h.emit('m.result', { matchId: 'match1', players: [{ playerId: 'p1' }] });
  assert.equal(h.store.get().match.result.settlementPending, undefined);
  assert.equal(h.store.get().match.public.matchId, 'match1');
  assert.equal(h.store.get().match.battle, h.match.battle);
});

test('late previous-match receipt saves history only and cannot interrupt a newer match', () => {
  const h = harness();
  h.publicState({ matchId: 'match2', round: 1 });
  h.emit('m.result', { matchId: 'match1', players: [{ playerId: 'p1' }] });
  assert.equal(h.store.get().match.result, null);
  assert.equal(h.store.get().match.public.matchId, 'match2');
  assert.equal(h.store.get().match.public.phase, 'COMBAT');
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0][1].historyOnly, true);
  assertInGame(h);
});

test('late receipt after dismissing the report stays in the lobby but still reaches authoritative history', () => {
  const h = harness();
  h.publicState({ phase: 'RESULT' });
  h.store.set({ room: null, match: emptyMatch() });
  h.emit('m.result', { matchId: 'match1', players: [{ playerId: 'p1' }] });
  assert.equal(selectRoute(h.store.get()), 'lobby');
  assert.equal(h.store.get().match.result, null);
  assert.equal(h.results[0][1].historyOnly, true);
});

test('legacy result without matchId still completes the current result screen', () => {
  const h = harness();
  h.publicState({ phase: 'RESULT', matchId: undefined });
  h.emit('m.result', { victory: true, players: [{ playerId: 'p1' }] });
  assert.equal(h.store.get().match.result.victory, true);
  assert.equal(h.results[0][1].historyOnly, false);
});

test('an older pending replay cannot downgrade the same match authoritative receipt', () => {
  const h = harness();
  h.publicState({ phase: 'RESULT' });
  h.emit('m.result', { matchId: 'match1', players: [{ playerId: 'p1', reward: 23 }] });
  h.emit('m.result', { matchId: 'match1', settlementPending: true, players: [{ playerId: 'p1', reward: 23 }] });
  assert.equal(h.store.get().match.result.settlementPending, undefined);
  assert.equal(h.store.get().match.result.players[0].reward, 23);
  assert.equal(h.results[1][1].historyOnly, true);
});
