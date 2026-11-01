// Execute the real in-match callback without a browser, socket or running game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { readyFundsPrompt } from '../../public/js/ui/gameLogic.js';

const source = readFileSync(process.env.SP_READY_SOURCE || new URL('../../public/js/screens/game/match.js', import.meta.url), 'utf8');
const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const screen = program.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'MatchScreen').declaration;
const names = new Set(['askingReady', 'readyPending', 'toggleReady']);
const declarations = screen.body.body.filter(node => node.type === 'VariableDeclaration'
  && node.declarations.some(item => names.has(item.id?.name)));
const script = declarations.map(node => source.slice(node.start, node.end)).join('\n') + '\n({ toggleReady, askingReady });';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ funds = 0, ready = false, modeId = 'mode_coop' } = {}) {
  let state = { connection: { status: 'online' }, spectator: null, me: { playerId: 'p1' },
    room: { code: 'ROOM1', serverId: 'local', inMatch: true },
    match: { public: { phase: 'PREP', round: 8, deadline: 1000, modeId, players: [{ playerId: 'p1', ready, autoplay: false }] },
      private: { alive: true, ready, funds, bandId: 'band_bldsk', hand: [], temp: [] } } };
  const requests = [], busy = [], errors = [], confirmations = [];
  let request = async () => true, confirm = async () => true;
  const net = { ws: {} };
  const context = {
    useRef: current => ({ current }), useCallback: fn => fn,
    store: { get: () => state }, net, PHASE: { PREP: 'PREP' },
    live: { get current() { return { pub: state.match.public, priv: state.match.private, myId: state.me.playerId }; } },
    readyFundsPrompt, data: { get: () => ({ economy: { leftoverFundsKeptByBands: ['band_cannot'] } }) },
    setReadyBusy: value => busy.push(value), toastError: error => errors.push(error),
    confirmDialog: options => { confirmations.push(options); return confirm(options); },
    actions: { ready: value => { requests.push(value); return request(value); } },
  };
  const callback = runInNewContext(script, context, { filename: 'ready-singleflight-real-callback.js' });
  return { ...callback, requests, busy, errors, confirmations, net, get state() { return state; },
    update(fn) { state = fn(state); },
    private(fields) { state = { ...state, match: { ...state.match, private: { ...state.match.private, ...fields } } }; },
    public(fields) { state = { ...state, match: { ...state.match, public: { ...state.match.public, ...fields } } }; },
    request(fn) { request = fn; }, confirm(fn) { confirm = fn; } };
}

test('ready: same-task mouse/Space flood sends only one in-flight request', async () => {
  const h = harness(), wait = deferred(); h.request(() => wait.promise);
  const first = h.toggleReady(true);
  const repeated = Array.from({ length: 50 }, () => h.toggleReady(true));
  try {
    assert.deepEqual(h.requests, [true]);
    assert.deepEqual(h.busy, [true]);
  } finally {
    wait.resolve(true);
  }
  assert.ok((await Promise.all(repeated)).every(result => result === false));
  assert.equal(await first, true); assert.deepEqual(h.busy, [true, false]);
});
test('ready: cancel uses the same gate and releases operator editing from authoritative private state', async () => {
  const h = harness({ ready: true }), wait = deferred(); h.request(() => wait.promise);
  const first = h.toggleReady(false); await h.toggleReady(false); await h.toggleReady(true);
  assert.deepEqual(h.requests, [false]);
  h.private({ ready: false }); wait.resolve(true); await first;
  assert.equal(h.state.match.private.ready, false);
  h.request(async () => true); assert.equal(await h.toggleReady(true), true);
  assert.deepEqual(h.requests, [false, true]);
});
for (const outcome of ['false', 'throw']) test('ready: ' + outcome + ' request clears busy and permits a later retry', async () => {
  const h = harness();
  h.request(async () => { if (outcome === 'throw') throw new Error('request rejected'); return false; });
  assert.equal(await h.toggleReady(true), false);
  assert.deepEqual(h.busy, [true, false]);
  assert.equal(h.errors.length, outcome === 'throw' ? 1 : 0);
  h.request(async () => true); assert.equal(await h.toggleReady(true), true);
  assert.deepEqual(h.requests, [true, true]);
});
test('ready: confirmation and network request share a single synchronous lock', async () => {
  const h = harness({ funds: 5 }), answer = deferred(), request = deferred();
  h.confirm(() => answer.promise); h.request(() => request.promise);
  const first = h.toggleReady(true); await h.toggleReady(true);
  assert.equal(h.confirmations.length, 1); assert.equal(h.requests.length, 0);
  answer.resolve(true); await Promise.resolve();
  await h.toggleReady(true); assert.deepEqual(h.requests, [true]);
  request.resolve(true); await first; assert.equal(h.askingReady.current, false);
  assert.deepEqual(h.busy, [true, false]);
});
for (const outcome of ['cancel', 'throw']) test('ready: ' + outcome + ' confirmation leaves no request or stuck lock', async () => {
  const h = harness({ funds: 5 });
  h.confirm(async () => { if (outcome === 'throw') throw new Error('dialog failed'); return false; });
  assert.equal(await h.toggleReady(true), false);
  assert.equal(h.requests.length, 0); assert.equal(h.askingReady.current, false);
  assert.deepEqual(h.busy, [true, false]);
  h.confirm(async () => true); assert.equal(await h.toggleReady(true), true);
  assert.deepEqual(h.requests, [true]);
});
const transitions = {
  round: h => h.public({ round: 9 }),
  deadline: h => h.public({ deadline: 2000 }),
  phase: h => h.public({ phase: 'COMBAT' }),
  room: h => h.update(s => ({ ...s, room: { ...s.room, code: 'ROOM2' } })),
  server: h => h.update(s => ({ ...s, room: { ...s.room, serverId: 'other' } })),
  player: h => h.update(s => ({ ...s, me: { playerId: 'p2' } })),
  disconnect: h => h.update(s => ({ ...s, connection: { status: 'reconnecting' } })),
  socket: h => { h.net.ws = {}; },
  spectator: h => h.update(s => ({ ...s, spectator: { code: 'ROOM2' } })),
  eliminated: h => h.private({ alive: false }),
  missingPrivate: h => h.update(s => ({ ...s, match: { ...s.match, private: null } })),
  alreadyReady: h => h.private({ ready: true }),
};
for (const [name, transition] of Object.entries(transitions)) test('ready: delayed confirmation cannot cross ' + name, async () => {
  const h = harness({ funds: 5 }), answer = deferred(); h.confirm(() => answer.promise);
  const first = h.toggleReady(true); transition(h); answer.resolve(true);
  assert.equal(await first, false); assert.equal(h.requests.length, 0);
  assert.equal(h.askingReady.current, false); assert.deepEqual(h.busy, [true, false]);
});
test('ready: latest store state wins before rerender; contradictory public status cannot block cancel', async () => {
  const h = harness(); h.private({ ready: true });
  assert.equal(await h.toggleReady(true), false); assert.equal(h.requests.length, 0);
  assert.equal(h.state.match.public.players[0].ready, false);
  assert.equal(await h.toggleReady(false), true); assert.deepEqual(h.requests, [false]);
});
test('ready: no speculative mutation, automatic retry or extra request after authoritative push', async () => {
  const h = harness(); assert.equal(await h.toggleReady(true), true);
  assert.equal(h.state.match.private.ready, false);
  h.private({ ready: true }); assert.equal(await h.toggleReady(true), false);
  assert.deepEqual(h.requests, [true]);
});
test('ready: Cyclops still skips leftover-funds confirmation', async () => {
  const h = harness({ funds: 5, modeId: 'mode_cyclops' });
  assert.equal(await h.toggleReady(true), true); assert.equal(h.confirmations.length, 0);
});
test('ready: button and keyboard retain one shared callback and authoritative private ready', () => {
  assert.ok(source.includes('onReady=$' + '{toggleReady}'));
  assert.ok(source.includes('toggleReady(!L.priv.ready)'));
  assert.match(source, /const editable =[^;]*!priv\.ready/);
  const hud = readFileSync(new URL('../../public/js/ui/hud.js', import.meta.url), 'utf8');
  assert.ok(hud.includes('const ready = !!priv?.ready'));
  assert.ok(hud.includes('disabled=$' + '{!!reason || busy}'));
});
