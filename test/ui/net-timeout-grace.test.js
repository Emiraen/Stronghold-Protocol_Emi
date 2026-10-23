import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Net, CONNECT_TIMEOUT_MS, HELLO_TIMEOUT_MS, DEAD_AFTER_MS, RESUME_PROBE_MS,
  REQUEST_TIMEOUT_MS, BACKGROUND_DEAD_AFTER_MS, CLOSE_ADMIN_KICK,
} from '../../public/js/net.js';

// No native sockets or clocks: all transport events and deadlines are explicit.
function fakeTimers() {
  let now = 1_000_000;
  let sequence = 0;
  const queue = new Map();
  const add = (fn, ms, interval = 0) => {
    const id = ++sequence;
    queue.set(id, { fn, at: now + ms, interval });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms),
    clearTimeout: (id) => queue.delete(id),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (id) => queue.delete(id),
    advance(ms) {
      const end = now + ms;
      let calls = 0;
      for (;;) {
        let next = null;
        for (const entry of queue) {
          if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        }
        if (!next) break;
        assert.ok(++calls < 100_000, 'fake timer queue must terminate');
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else queue.delete(id);
        timer.fn();
      }
      now = end;
    },
  };
}

function context(t, { online = true } = {}) {
  const timers = fakeTimers();
  const sockets = [];
  let hidden = false;
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closes = [];
      sockets.push(this);
    }
    send(data) {
      assert.equal(this.readyState, 1);
      this.sent.push(JSON.parse(data));
    }
    close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
    last(type) { return this.sent.findLast((frame) => frame.t === type); }
  }
  const net = new Net({
    url: 'ws://fake.invalid/ws', WebSocket: FakeWebSocket, timers,
    now: timers.now, monotonicNow: timers.now, random: () => 0.5,
    isHidden: () => hidden, getToken: () => 'resume-token',
    getAuth: () => ({ action: 'login', ticket: 'test-ticket' }),
  });
  t.after(() => net.close());
  const socket = () => sockets.at(-1);
  const welcome = () => socket().receive({
    t: 'welcome', rid: socket().last('hello').rid, name: '博士', playerId: 'player-1',
    token: 'resume-token', authTicket: 'test-ticket', serverNow: timers.now(),
  });
  net.setName('博士');
  if (online) { socket().open(); welcome(); }
  return { net, timers, sockets, socket, welcome, setHidden: (value) => { hidden = value; } };
}

test('only foreground disconnect grace gains 500 ms; all other timeouts stay unchanged', () => {
  assert.equal(DEAD_AFTER_MS, 15_500);
  assert.equal(RESUME_PROBE_MS, 3_000);
  assert.equal(CONNECT_TIMEOUT_MS, 10_000);
  assert.equal(HELLO_TIMEOUT_MS, 8_000);
  assert.equal(REQUEST_TIMEOUT_MS, 8_000);
  assert.equal(BACKGROUND_DEAD_AFTER_MS, 5 * 60_000);
});

test('foreground silence at the old 15-second threshold retains the same socket', (t) => {
  const { net, timers, socket, sockets } = context(t);
  const original = socket();
  timers.advance(15_000);
  net._heartbeat();
  assert.equal(net.status, 'online');
  assert.equal(net.ws, original);
  assert.equal(sockets.length, 1);
  assert.equal(original.closes.length, 0);
});

test('foreground silence gets the exact 15.5-second grace then reconnects', (t) => {
  const { net, timers, socket, sockets } = context(t);
  const original = socket();
  timers.advance(15_500);
  net._heartbeat();
  assert.equal(net.ws, original, 'full grace is available');
  assert.equal(original.closes.length, 0);
  timers.advance(1);
  net._heartbeat();
  assert.equal(net.status, 'reconnecting');
  assert.equal(original.closes.at(-1).reason, 'heartbeat timeout');
  timers.advance(500);
  assert.equal(sockets.length, 2);
});

test('a delayed pong clears silence without replacing the connection', (t) => {
  const { net, timers, socket, sockets } = context(t);
  const original = socket();
  const initialPing = original.last('ping');
  timers.advance(15_300);
  original.receive({ t: 'pong', c: initialPing.c, s: timers.now() });
  assert.equal(net.ping, 15_300);
  timers.advance(15_000);
  assert.equal(net.status, 'online');
  assert.equal(net.ws, original);
  assert.equal(sockets.length, 1);
});

test('any valid inbound frame clears both heartbeat silence and a pending resume probe', (t) => {
  const { net, timers, socket, sockets } = context(t);
  timers.advance(13_300);
  net.resumeConnection();
  timers.advance(2_000);
  socket().receive({ t: 'room.state', code: 'TEST' });
  timers.advance(15_000);
  assert.equal(net.status, 'online');
  assert.equal(sockets.length, 1);
});

test('focus recovery keeps its original 3-second deadline', (t) => {
  const { net, timers, sockets } = context(t);
  net.resumeConnection();
  timers.advance(2_999);
  assert.equal(sockets.length, 1);
  assert.equal(net.status, 'online');
  timers.advance(1);
  assert.equal(sockets.length, 2);
  assert.equal(net.status, 'connecting');
});

test('repeated focus signals do not indefinitely extend a silent probe deadline', (t) => {
  const { net, timers, sockets } = context(t);
  net.resumeConnection();
  timers.advance(1_000); net.resumeConnection();
  timers.advance(1_000); net.resumeConnection();
  timers.advance(1_000);
  assert.equal(sockets.length, 2);
});

test('returning from background gets a fresh probe window instead of stale foreground timeout', (t) => {
  const { net, timers, sockets, socket, setHidden } = context(t);
  const original = socket();
  setHidden(true); net.resumeConnection();
  timers.advance(120_000);
  assert.equal(net.status, 'online');
  setHidden(false); net.resumeConnection();
  timers.advance(2_000);
  assert.equal(sockets.length, 1);
  original.receive({ t: 'pong', c: original.last('ping').c, s: timers.now() });
  timers.advance(6_000);
  assert.equal(net.ws, original);
  assert.equal(net.status, 'online');
});

test('connecting sockets keep their original 10-second connection budget', (t) => {
  const { net, timers, socket, sockets } = context(t, { online: false });
  const original = socket();
  timers.advance(9_999);
  assert.equal(net.ws, original);
  assert.equal(sockets.length, 1);
  assert.equal(net.status, 'connecting');
  original.open();
  timers.advance(1);
  assert.equal(net.status, 'handshaking', 'the obsolete connect timer cannot cut a successful socket');
});

test('focus keeps the original 3-second recovery deadline while connecting', (t) => {
  const { net, timers, sockets } = context(t, { online: false });
  timers.advance(1_000); net.resumeConnection();
  timers.advance(1_999);
  assert.equal(sockets.length, 1);
  timers.advance(1);
  assert.equal(sockets.length, 2);
});

test('a connection which never opens is retried at the original 10 seconds', (t) => {
  const { net, timers, socket, sockets } = context(t, { online: false });
  const original = socket();
  timers.advance(9_999);
  assert.equal(net.ws, original);
  timers.advance(1);
  assert.equal(net.status, 'reconnecting');
  assert.equal(original.closes.at(-1).reason, 'connect timeout');
  timers.advance(500);
  assert.equal(sockets.length, 2);
});

test('welcome still succeeds within the original 8-second handshake budget', (t) => {
  const { net, timers, socket, sockets, welcome } = context(t, { online: false });
  socket().open();
  timers.advance(6_000); net.resumeConnection();
  timers.advance(1_000);
  assert.equal(net.status, 'handshaking');
  assert.equal(sockets.length, 1);
  welcome();
  timers.advance(2_000);
  assert.equal(net.status, 'online');
  assert.equal(sockets.length, 1);
});

test('a handshake without welcome still times out at the original 8 seconds', (t) => {
  const { net, timers, socket, sockets } = context(t, { online: false });
  socket().open();
  const original = socket();
  timers.advance(7_999);
  assert.equal(net.status, 'handshaking');
  timers.advance(1);
  assert.equal(net.status, 'reconnecting');
  assert.equal(original.closes.at(-1).reason, 'hello timeout');
  timers.advance(500);
  assert.equal(sockets.length, 2);
});

test('an explicit transport close reconnects without waiting for the silence grace', (t) => {
  const { net, timers, socket, sockets } = context(t);
  socket().drop();
  assert.equal(net.status, 'reconnecting');
  timers.advance(500);
  assert.equal(sockets.length, 2);
});

test('administrator kick and manual close still stop automatic reconnection', (t) => {
  const kicked = context(t);
  kicked.socket().drop(CLOSE_ADMIN_KICK);
  assert.equal(kicked.net.status, 'closed');
  kicked.timers.advance(120_000);
  kicked.net.resumeConnection(true);
  assert.equal(kicked.sockets.length, 1);
  const closed = context(t);
  closed.net.close();
  closed.timers.advance(120_000);
  closed.net.resumeConnection(true);
  assert.equal(closed.sockets.length, 1);
});

test('ordinary requests still time out after 8 seconds without disconnect or unsafe replay', async (t) => {
  const { net, timers, socket, sockets, welcome } = context(t);
  const original = socket();
  const rejected = assert.rejects(net.request('g.buy', { slot: 0 }), { code: 'TIMEOUT' });
  const purchase = original.last('g.buy');
  assert.ok(purchase);
  timers.advance(8_000);
  await rejected;
  assert.equal(net.status, 'online');
  assert.equal(net.ws, original);
  assert.equal(net.pendingCount, 0);
  assert.equal(original.sent.filter((frame) => frame.t === 'g.buy').length, 1);
  original.receive({ t: 'ok', rid: purchase.rid });
  original.drop(); timers.advance(500); socket().open(); welcome();
  assert.equal(sockets.length, 2);
  assert.equal(socket().sent.filter((frame) => frame.t === 'g.buy').length, 0);
});

test('larger disconnect grace does not retain stale RTT or congestion samples longer', (t) => {
  const { net, timers, socket } = context(t);
  timers.advance(100);
  socket().receive({ t: 'pong', c: socket().last('ping').c, s: timers.now() });
  assert.equal(net.progressRtt(), 100);
  assert.equal(net.trend.expiryMs, 15_000);
  timers.advance(15_001);
  assert.equal(net.progressRtt(), null);
  assert.equal(net.status, 'online');
});
