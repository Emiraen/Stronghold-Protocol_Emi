import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, DEAD_AFTER_MS } from '../../public/js/net.js';
import { createStore, selectRoute } from '../../public/js/store.js';
import { bannerVisible } from '../../public/js/ui/connBanner.js';

// No real sockets, clocks, listeners on browser globals, or running game servers.
function context(t, { online = true } = {}) {
  const sockets = [];
  const scheduled = new Map();
  let sequence = 0;
  const timers = {
    setTimeout(fn, ms) { const id = ++sequence; scheduled.set(id, { fn, ms }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    setInterval(fn, ms) { const id = ++sequence; scheduled.set(id, { fn, ms }); return id; },
    clearInterval(id) { scheduled.delete(id); },
  };
  class FakeSocket {
    constructor() { this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(data) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    last(type) { return this.sent.findLast((frame) => frame.t === type); }
  }
  const net = new Net({
    url: 'ws://lease.invalid/ws', WebSocket: FakeSocket, timers,
    now: () => 1_000_000, monotonicNow: () => 1_000_000, random: () => 0.5,
    isHidden: () => false, getToken: () => 'test-resume-token',
  });
  const socket = () => sockets.at(-1);
  const welcome = () => socket().receive({
    t: 'welcome', rid: socket().last('hello').rid, name: 'test-player',
    playerId: 'player-lease', authTicket: 'test-ticket', token: 'test-resume-token',
  });
  t.after(() => net.close());
  net.setName('test-player');
  if (online) { socket().open(); welcome(); }
  return { net, socket, sockets, scheduled, welcome };
}

test('lease recovery retains online, current match and route, without reconnect or a status event', (t) => {
  const { net, socket, sockets } = context(t);
  const match = { public: { phase: 'BATTLE', matchId: 'existing-match' }, battle: { battleId: 'battle-1' } };
  const state = createStore({ session: { entered: true }, connection: net.snapshot(), match, room: { inMatch: true } });
  const statuses = [];
  net.on('status', (snap) => { statuses.push(snap); state.set({ connection: snap }); });
  const events = [];
  net.on('lease', (event) => events.push(event));
  const original = socket();
  const sentCount = original.sent.length;
  original.receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  assert.equal(net.leaseState, 'recovering');
  assert.equal(net.leaseRetryMs, 1500);
  assert.equal(net.status, 'online');
  assert.equal(net.ws, original);
  assert.equal(sockets.length, 1);
  assert.equal(original.sent.length, sentCount);
  assert.deepEqual(statuses, []);
  assert.deepEqual(events, [{ state: 'recovering', retryMs: 1500 }]);
  assert.equal(state.get().match, match);
  assert.equal(selectRoute(state.get()), 'game');
  assert.equal(bannerVisible(state.get().connection, true, false, false, true), true);
  assert.equal(DEAD_AFTER_MS, 15500);
});

test('active clears only the recovery hint and does not trigger status-driven game resubmission', (t) => {
  const { net, socket } = context(t);
  const statuses = [];
  const events = [];
  net.on('status', (snap) => statuses.push(snap));
  net.on('lease', (event) => events.push(event));
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  socket().receive({ t: 'session.lease', state: 'active' });
  assert.equal(net.leaseState, 'active');
  assert.equal(net.leaseRetryMs, 0);
  assert.equal(net.status, 'online');
  assert.deepEqual(statuses, []);
  assert.deepEqual(events.at(-1), { state: 'active', retryMs: 0 });
  assert.equal(bannerVisible(net.snapshot(), true, false, false, false), false);
});

test('duplicate recovery is idempotent, retry hints are bounded, and no polling timer is added', (t) => {
  const { net, socket, scheduled } = context(t);
  const events = [];
  net.on('lease', (event) => events.push(event));
  const timersBefore = [...scheduled];
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 100_000_000 });
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 100_000_000 });
  assert.equal(net.leaseRetryMs, 30_000);
  assert.equal(events.length, 1);
  assert.deepEqual([...scheduled], timersBefore);
});

test('invalid lease states and pre-welcome recovery cannot establish or change a session', (t) => {
  const { net, socket, welcome } = context(t, { online: false });
  socket().open();
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  assert.equal(net.leaseState, 'active');
  assert.equal(net.status, 'handshaking');
  welcome();
  socket().receive({ t: 'session.lease', state: 'revoked' });
  assert.equal(net.leaseState, 'active');
  assert.equal(net.status, 'online');
});

test('welcome, transport close, and manual server switch each clear recovery state', (t) => {
  const { net, socket, welcome } = context(t);
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  welcome();
  assert.equal(net.leaseState, 'active');
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  socket().drop();
  assert.equal(net.leaseState, 'active');
  assert.equal(net.status, 'reconnecting');
  net.connect(); socket().open(); welcome();
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  net.closeForServerSwitch();
  assert.equal(net.leaseState, 'active');
  assert.equal(net.leaseRetryMs, 0);
  assert.equal(net.status, 'closed');
});

test('obsolete socket frames and close callbacks cannot affect the replacement connection', (t) => {
  const { net, socket, welcome } = context(t);
  const old = socket();
  const lateMessage = old.onmessage;
  const lateClose = old.onclose;
  net.reconnectNow(); socket().open(); welcome();
  const current = socket();
  lateMessage({ data: JSON.stringify({ t: 'session.lease', state: 'recovering' }) });
  lateClose({ code: 1006 });
  assert.equal(net.ws, current);
  assert.equal(net.status, 'online');
  assert.equal(net.leaseState, 'active');
  current.receive({ t: 'session.lease', state: 'recovering' });
  lateMessage({ data: JSON.stringify({ t: 'session.lease', state: 'active' }) });
  assert.equal(net.leaseState, 'recovering');
});

test('recovery does not queue or replay a write rejected by the authoritative server', async (t) => {
  const { net, socket } = context(t);
  socket().receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  const rejection = assert.rejects(net.request('g.buy', { slot: 0 }), { code: 'BUSY' });
  const purchase = socket().last('g.buy');
  assert.ok(purchase);
  socket().receive({ t: 'error', rid: purchase.rid, code: 'BUSY', msg: 'lease recovery' });
  await rejection;
  socket().receive({ t: 'session.lease', state: 'active' });
  assert.equal(net.pendingCount, 0);
  assert.equal(socket().sent.filter((msg) => msg.t === 'g.buy').length, 1);
});
