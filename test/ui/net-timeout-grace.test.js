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
    stall(ms) { now += ms; }, // a main-thread long task: clocks advance without executing callbacks
    scheduled: () => [...queue.values()],
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
        now = Math.max(now, timer.at);
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

test('foreground silence gets the unchanged 15.5-second grace and one task to process queued input', (t) => {
  const { net, timers, socket, sockets } = context(t);
  const original = socket();
  timers.advance(15_500);
  net._heartbeat();
  assert.equal(net.ws, original, 'full grace is available');
  assert.equal(original.closes.length, 0);
  timers.advance(1);
  net._heartbeat();
  assert.equal(net.status, 'online', 'one bounded task turn is available for queued input');
  timers.advance(0);
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

test('any valid inbound frame clears heartbeat silence after a foreground probe', (t) => {
  const { net, timers, socket, sockets } = context(t);
  timers.advance(13_300);
  net.resumeConnection();
  timers.advance(2_000);
  socket().receive({ t: 'room.state', code: 'TEST' });
  timers.advance(15_000);
  assert.equal(net.status, 'online');
  assert.equal(sockets.length, 1);
});

test('foreground focus accepts a pong slower than three seconds without switching sockets', (t) => {
  const { net, timers, socket, sockets } = context(t);
  const original = socket();
  net.resumeConnection();
  assert.equal(net._resumeTimer, null, 'a live session has no shorter focus deadline');
  const probe = original.last('ping');
  timers.advance(5_000);
  assert.equal(sockets.length, 1);
  assert.equal(net.status, 'online');
  original.receive({ t: 'pong', c: probe.c, s: timers.now() });
  assert.equal(net.ping, 5_000);
  timers.advance(10_000);
  assert.equal(net.ws, original);
  assert.equal(net.status, 'online');
});

test('repeated focus signals do not indefinitely extend a silent probe deadline', (t) => {
  const { net, timers, socket, sockets } = context(t);
  const original = socket();
  const since = net._unansweredSince;
  net.resumeConnection();
  for (let i = 0; i < 15; i++) {
    timers.advance(1_000); net.resumeConnection(i % 2 === 0);
    assert.equal(net._unansweredSince, since);
    assert.equal(net._resumeTimer, null);
  }
  assert.equal(net.ws, original);
  timers.advance(501); net.resumeConnection();
  timers.advance(0);
  assert.equal(net.status, 'reconnecting');
  assert.equal(original.closes.at(-1).reason, 'heartbeat timeout');
  timers.advance(500);
  assert.equal(sockets.length, 2);
});

test('a live socket with no focus reply still reconnects on its existing heartbeat deadline', (t) => {
  const { net, timers, socket, sockets } = context(t);
  const original = socket();
  net.resumeConnection();
  timers.advance(15_500);
  assert.equal(net.ws, original);
  timers.advance(500); // the existing four-second heartbeat samples silence at 16 seconds
  assert.equal(net.status, 'reconnecting');
  assert.equal(original.closes.at(-1).reason, 'heartbeat timeout');
  timers.advance(500);
  assert.equal(sockets.length, 2);
});

test('the pre-hello connected indicator also retains the full heartbeat window after focus', (t) => {
  const { net, timers, socket } = context(t);
  const original = socket();
  net.name = net.helloName = null;
  net.status = 'connected';
  net.resumeConnection();
  timers.advance(5_000);
  assert.equal(net.ws, original);
  assert.equal(net.status, 'connected');
  original.receive({ t: 'pong', c: original.last('ping').c, s: timers.now() });
  assert.equal(net._resumeTimer, null);
});

test('a long foreground pause gives an already queued message one task before timeout confirmation', (t) => {
  const { net, timers, socket } = context(t);
  const original = socket();
  timers.setTimeout(() => original.receive({ t: 'room.state', code: 'TEST' }), 5_000);
  timers.stall(20_000);
  net._heartbeat(); // overdue timer runs before the queued socket event
  assert.equal(net.status, 'online');
  assert.notEqual(net._silenceTimer, null);
  timers.advance(0);
  assert.equal(net.status, 'online');
  assert.equal(net.ws, original);
  assert.equal(original.closes.length, 0);
  assert.equal(net._silenceTimer, null);
});

test('a long foreground pause without queued input closes after exactly one confirmation task', (t) => {
  const { net, timers, socket } = context(t);
  const original = socket();
  timers.stall(20_000);
  const since = net._unansweredSince;
  net._heartbeat();
  const timer = net._silenceTimer;
  for (let i = 0; i < 5; i++) net.resumeConnection();
  assert.equal(net._silenceTimer, timer, 'focus cannot replace or extend confirmation');
  assert.equal(net._unansweredSince, since);
  timers.advance(0);
  assert.equal(original.closes.at(-1).reason, 'heartbeat timeout');
  assert.equal(net.status, 'reconnecting');
});

test('a cancelled timeout confirmation and stale socket input cannot close or alter a switched connection', (t) => {
  const { net, timers, socket, welcome } = context(t);
  const old = socket();
  const oldMessage = old.onmessage;
  timers.stall(20_000);
  net._heartbeat();
  const confirmation = timers.scheduled().find((item) => item.interval === 0 && item.at === timers.now())?.fn;
  assert.equal(typeof confirmation, 'function');
  net.closeForServerSwitch();
  net.setName('博士');
  net.connect(); socket().open(); welcome();
  const current = socket();
  current.receive({ t: 'session.lease', state: 'recovering', retryMs: 1500 });
  const pending = net._unansweredSince;
  oldMessage({ data: JSON.stringify({ t: 'pong', c: old.last('ping').c, s: timers.now() }) });
  confirmation();
  assert.equal(net.ws, current);
  assert.equal(net.status, 'online');
  assert.equal(net.leaseState, 'recovering');
  assert.equal(net._unansweredSince, pending);
  assert.equal(current.closes.length, 0);
  assert.equal(net._silenceTimer, null);
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

test('a genuinely silent background socket still closes at the existing five-minute budget', (t) => {
  const { net, timers, socket, setHidden } = context(t);
  const original = socket();
  setHidden(true); net.resumeConnection();
  timers.advance(BACKGROUND_DEAD_AFTER_MS);
  assert.equal(net.status, 'online');
  assert.equal(net.ws, original);
  timers.advance(4_000);
  assert.equal(original.closes.at(-1).reason, 'heartbeat timeout');
  assert.equal(net.status, 'reconnecting');
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
