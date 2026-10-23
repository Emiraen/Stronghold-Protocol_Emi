import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, createIdentity } from '../public/js/net.js';

const NAME = '博士';
const PASSWORD = 'private-password';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values: () => [...values.values()],
  };
}

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
      for (;;) {
        let next = null;
        for (const entry of queue) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
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

function context(t, { onAuth } = {}) {
  const timers = fakeTimers();
  const local = memoryStorage();
  const session = memoryStorage();
  const identity = createIdentity({ local, session, channel: null });
  identity.saveName(NAME);
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      assert.equal(this.readyState, 1);
      const frame = JSON.parse(data);
      this.sent.push(frame);
      this.onSend?.(frame);
    }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
    last(type) { return this.sent.findLast((frame) => frame.t === type); }
  }
  const net = new Net({
    url: 'ws://main.test/ws', WebSocket: FakeWS, timers,
    now: timers.now, monotonicNow: timers.now, random: () => 0.5, isHidden: () => false,
    getToken: () => identity.getToken(), getAuth: (name) => identity.getAuth(name),
    onAuth: (name, ticket) => {
      identity.saveAuthTicket(name, ticket);
      onAuth?.(name, ticket);
    },
  });
  t.after(() => net.close());
  const socket = () => sockets.at(-1);
  const welcome = (ticket = 'ticket-main', serverId = 'main') => {
    const frame = { t: 'welcome', rid: socket().last('hello').rid, name: NAME,
      playerId: 'player-1', token: 'seat-token', authTicket: ticket, serverId, serverNow: timers.now() };
    socket().receive(frame);
    return frame;
  };
  return { net, identity, sockets, socket, timers, welcome, local, session };
}

test('login remains pending until welcome, and persists its ticket before online listeners and queued requests', async (t) => {
  const events = [];
  const ctx = context(t, { onAuth: (name, ticket) => events.push(['auth', name, ticket]) });
  const { net, identity, socket, welcome } = ctx;
  let settled = false;
  const login = net.login(NAME, { action: 'login', password: PASSWORD });
  login.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'opening the transport does not authenticate');
  socket().open();
  assert.deepEqual(socket().last('hello').auth, { action: 'login', password: PASSWORD });
  const queued = net.request('room.leave');
  net.on('status', ({ status }) => {
    if (status === 'online') events.push(['online', identity.getAuth(NAME)?.ticket]);
  });
  socket().onSend = (frame) => {
    if (frame.t === 'room.leave') events.push(['queued', identity.getAuth(NAME)?.ticket]);
  };
  socket().receive({ t: 'ok', rid: socket().last('hello').rid });
  await Promise.resolve();
  assert.equal(settled, false, 'a generic hello reply is not a successful login');
  assert.equal(net.status, 'handshaking');
  const accepted = welcome();
  assert.deepEqual(await login, accepted);
  assert.equal(net.status, 'online');
  assert.deepEqual(events, [['auth', NAME, 'ticket-main'], ['online', 'ticket-main'], ['queued', 'ticket-main']]);
  socket().receive({ t: 'ok', rid: socket().last('room.leave').rid });
  await queued;
});

test('a rejected login returns the server message and stops automatic reconnect until a fresh submission', async (t) => {
  const { net, socket, sockets, timers, welcome } = context(t);
  const errors = [];
  net.on('helloError', (error) => errors.push(error));
  const rejected = assert.rejects(net.login(NAME, { action: 'login', password: PASSWORD }),
    { code: 'AUTH_INVALID', message: '账户或密码错误' });
  socket().open();
  socket().receive({ t: 'error', rid: socket().last('hello').rid,
    code: 'AUTH_INVALID', detail: '账户或密码错误' });
  await rejected;
  assert.equal(net.status, 'closed');
  assert.equal(net.name, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].accountName, NAME);
  timers.advance(60_000);
  net.retryNow();
  net.resumeConnection(true);
  assert.equal(sockets.length, 1, 'browser wakeups cannot repeat a rejected authentication');
  const retry = net.login(NAME, { action: 'login', password: 'correct-password' });
  assert.equal(sockets.length, 2);
  socket().open();
  assert.equal(socket().last('hello').auth.password, 'correct-password');
  welcome();
  await retry;
});

test('disconnect after login reconnects using the rotated ticket without replaying the password', async (t) => {
  const { net, identity, socket, sockets, timers, welcome } = context(t);
  const login = net.login(NAME, { action: 'login', password: PASSWORD });
  socket().open(); welcome('ticket-1'); await login;
  socket().drop();
  assert.equal(net.status, 'reconnecting');
  timers.advance(500);
  assert.equal(sockets.length, 2);
  socket().open();
  assert.deepEqual(socket().last('hello').auth, { action: 'login', ticket: 'ticket-1' });
  assert.ok(!JSON.stringify(socket().sent).includes(PASSWORD));
  welcome('ticket-2');
  assert.deepEqual(identity.getAuth(NAME), { action: 'login', ticket: 'ticket-2' });
  socket().drop(); timers.advance(1000); socket().open();
  assert.deepEqual(socket().last('hello').auth, { action: 'login', ticket: 'ticket-2' });
});

test('restoring a saved ticket survives a temporary network failure before its first welcome', async (t) => {
  const { net, identity, socket, sockets, timers, welcome } = context(t);
  identity.saveAuthTicket(NAME, 'saved-ticket');
  const restore = net.login(NAME);
  socket().open();
  assert.deepEqual(socket().last('hello').auth, { action: 'login', ticket: 'saved-ticket' });
  socket().drop();
  assert.equal(net.status, 'reconnecting');
  timers.advance(500);
  assert.equal(sockets.length, 2);
  socket().open();
  assert.deepEqual(socket().last('hello').auth, { action: 'login', ticket: 'saved-ticket' });
  welcome('restored-ticket');
  await restore;
  assert.equal(net.status, 'online');
});

test('an authenticated server switch keeps the account ticket after the old socket and seat are cleared', async (t) => {
  const { net, identity, socket, welcome } = context(t);
  const login = net.login(NAME, { action: 'login', password: PASSWORD });
  socket().open(); welcome('shared-account-ticket'); await login;
  identity.saveToken('old-main-seat');
  net.closeForServerSwitch();
  identity.selectServer('secondary');
  assert.equal(identity.getToken(), null);
  net.url = 'ws://secondary.test/ws';
  net.setName(NAME);
  net.connect(); socket().open();
  assert.equal(socket().url, 'ws://secondary.test/ws');
  assert.deepEqual(socket().last('hello').auth, { action: 'login', ticket: 'shared-account-ticket' });
  assert.equal(socket().last('hello').token, undefined);
  assert.ok(!JSON.stringify(socket().sent).includes(PASSWORD));
  welcome('secondary-rotated-ticket', 'secondary');
  assert.equal(net.status, 'online');
  assert.equal(net.serverId, 'secondary');
});

test('account tickets survive a tab refresh in sessionStorage, stay separate by name and never enter localStorage', async () => {
  const local = memoryStorage(), session = memoryStorage();
  const first = createIdentity({ local, session, channel: null });
  first.saveName(NAME); first.setEntered(true);
  first.saveAuthTicket(NAME, 'private-account-ticket');
  first.saveAuthTicket('其他账户', 'other-ticket');
  const refreshed = createIdentity({ local, session, channel: null });
  await refreshed.init();
  assert.equal(refreshed.loadName(), NAME);
  assert.equal(refreshed.wasEntered(), true);
  assert.deepEqual(refreshed.getAuth(NAME), { action: 'login', ticket: 'private-account-ticket' });
  refreshed.selectServer('secondary');
  assert.equal(refreshed.getAuth(NAME).ticket, 'private-account-ticket');
  assert.ok(session.values().includes('private-account-ticket'));
  assert.ok(!local.values().includes('private-account-ticket'));
  assert.ok(!local.values().includes('other-ticket'));
  const newTab = createIdentity({ local, session: memoryStorage(), channel: null });
  assert.equal(newTab.getAuth(NAME), null, 'a new tab must use the password form');
  assert.equal(newTab.wasEntered(), false);
  refreshed.clearAuth(NAME);
  assert.equal(refreshed.getAuth(NAME), null);
  assert.equal(refreshed.getAuth('其他账户').ticket, 'other-ticket');
});

test('remembered form fields survive reopening without logging in, and opting out preserves active authentication', () => {
  const local = memoryStorage(), session = memoryStorage();
  const first = createIdentity({ local, session, channel: null });
  assert.equal(first.loadRememberedLogin(), null);
  first.saveRememberedLogin(NAME, PASSWORD);
  first.saveAuthTicket(NAME, 'active-ticket');
  first.setEntered(true);
  const reopened = createIdentity({ local, session: memoryStorage(), channel: null });
  assert.deepEqual(reopened.loadRememberedLogin(), { name: NAME, password: PASSWORD });
  assert.equal(reopened.wasEntered(), false, 'remembered fields still require pressing Start');
  assert.equal(reopened.getAuth(NAME), null, 'remembered passwords are separate from authenticated tickets');
  reopened.selectServer('secondary');
  assert.deepEqual(reopened.loadRememberedLogin(), { name: NAME, password: PASSWORD });
  first.clearRememberedLogin();
  assert.equal(reopened.loadRememberedLogin(), null, 'unchecking removes the remembered fields across tabs');
  assert.equal(first.getAuth(NAME).ticket, 'active-ticket');
  assert.equal(first.wasEntered(), true);
});

test('broken or unavailable remembered-login storage leaves a usable empty form', () => {
  const local = memoryStorage();
  const identity = createIdentity({ local, session: memoryStorage(), channel: null });
  for (const saved of ['{', 'null', '{"name":"博士","password":7}', '{"name":"博士","password":""}']) {
    local.setItem('sp.remembered.login', saved);
    assert.equal(identity.loadRememberedLogin(), null);
  }
  const unavailable = createIdentity({ local: null, session: null, channel: null });
  unavailable.saveRememberedLogin(NAME, PASSWORD);
  assert.equal(unavailable.loadRememberedLogin(), null);
  unavailable.clearRememberedLogin();
});

for (const interrupt of ['drop', 'reconnectNow', 'replaced', 'kicked']) {
  test(`one-time registration is rejected and never replayed after ${interrupt}`, async (t) => {
    const { net, socket, sockets, timers } = context(t);
    const rejected = assert.rejects(net.login(NAME, { action: 'register', password: PASSWORD }),
      (error) => ['DISCONNECTED', 'REPLACED', 'ADMIN_KICK'].includes(error.code));
    socket().open();
    assert.equal(socket().last('hello').auth.action, 'register');
    if (interrupt === 'reconnectNow') net.reconnectNow();
    else socket().drop(interrupt === 'replaced' ? 4001 : interrupt === 'kicked' ? 4003 : 1006);
    await rejected;
    timers.advance(60_000);
    assert.equal(net.status, 'closed');
    assert.equal(sockets.length, 1);
    assert.equal(socket().sent.filter((frame) => frame.t === 'hello').length, 1);
  });
}
