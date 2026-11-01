import test from 'node:test';
import assert from 'node:assert/strict';
import { identity, net, createIdentity } from '../public/js/net.js';
import { SOUTH_PRELOAD_ORIGIN, isResourceOnlyOrigin } from '../public/js/serverOrigins.js';
import { createStore, store } from '../public/js/store.js';
import { installTitleServerFallback, preferredServer } from '../public/js/servers.js';

let sequence = 0;
const directory = () => ({ current: 'main', servers: [
  { id: 'main', url: 'https://super.emiraen.top:23331', load: 'idle' },
  { id: 'secondary', url: 'https://emiraen.top', load: 'normal' },
] });

async function pageCase(origin, run, { selected = false, current = 'main', token = null, entered = false } = {}) {
  const locationBefore = globalThis.location, fetchBefore = globalThis.fetch;
  const saved = Object.fromEntries(['hasSelectedServer', 'getServer', 'selectServer', 'getToken', 'wasEntered'].map(key => [key, identity[key]]));
  const netBefore = { name: net.name, url: net.url, on: net.on };
  const appBefore = store.get(), listeners = [];
  net.on = (...args) => { const off = netBefore.on.apply(net, args); listeners.push(off); return off; };
  globalThis.location = new URL(origin + '/');
  identity.hasSelectedServer = () => selected; identity.getServer = () => current;
  identity.selectServer = value => { selected = true; current = value; };
  identity.getToken = () => token; identity.wasEntered = () => entered;
  net.name = null;
  try {
    const module = await import(`../public/js/servers.js?south-direct-test=${++sequence}`);
    await run(module);
  } finally {
    for (const off of listeners) off();
    store.set(appBefore);
    Object.assign(identity, saved); Object.assign(net, netBefore);
    globalThis.fetch = fetchBefore;
    if (locationBefore === undefined) delete globalThis.location;
    else globalThis.location = locationBefore;
  }
}

test('only the explicitly installed South China origin is trusted as a resource-only endpoint', () => {
  assert.equal(isResourceOnlyOrigin(SOUTH_PRELOAD_ORIGIN), true);
  for (const origin of ['http://120.24.21.224', 'https://120.24.21.224:3000', 'http://120.24.21.224:3001', 'http://20.24.21.224:3000']) {
    assert.equal(isResourceOnlyOrigin(origin), false);
  }
});

test('fresh game entries prefer East China even when South is idle or serves the page', async () => {
  const busy = directory().servers.map(entry => ({ ...entry, load: entry.id === 'main' ? 'busy' : 'idle' }));
  assert.equal(preferredServer(busy), 'main');
  for (const origin of ['https://super.emiraen.top:23331', 'https://emiraen.top']) {
    await pageCase(origin, async m => {
      const value = m.parseDirectory({ current: 'secondary', servers: busy });
      assert.equal(await m.prepareServerConnection(Promise.resolve(value)), true);
      assert.equal(identity.getServer(), 'main');
      assert.equal(net.url, 'wss://super.emiraen.top:23331/ws');
    }, { current: 'secondary' });
  }
});

test('a fresh room invitation preserves its target server', async () => {
  await pageCase('https://super.emiraen.top:23331', async m => {
    store.patch('ui', { pendingJoin: { code: 'NAAA', serverId: 'secondary' } });
    const value = m.parseDirectory(directory());
    assert.equal(await m.prepareServerConnection(Promise.resolve(value)), true);
    assert.equal(identity.getServer(), 'secondary');
    assert.equal(net.url, 'wss://emiraen.top/ws');
  });
});

function fallbackCase(overrides = {}) {
  const listeners = new Set(), pending = new Map(), calls = [];
  let nextTimer = 0, selected = 'main', token = null, entered = false;
  const connection = {
    status: 'connecting', name: null, _loginAttempt: null, pendingCount: 0, url: 'wss://super.emiraen.top:23331/ws',
    on(event, fn) { assert.equal(event, 'status'); listeners.add(fn); return () => listeners.delete(fn); },
    closeForServerSwitch() { calls.push('close'); this.status = 'closed'; for (const fn of listeners) fn(); },
    connect() { calls.push('connect'); this.status = 'connecting'; }
  };
  const account = {
    getServer: () => selected, getToken: () => token, wasEntered: () => entered,
    selectServer(value) { selected = value; calls.push(value); }
  };
  const app = createStore({ session: { entered: false }, room: null, spectator: null, ui: {}, match: {} });
  const state = createStore({ switching: false, directory: { current: 'main', servers: [
    { id: 'main', origin: 'https://super.emiraen.top:23331' },
    { id: 'secondary', origin: 'https://emiraen.top' }
  ] } });
  const timers = { setTimeout(fn, delay) { assert.equal(delay, 250); pending.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) { pending.delete(id); } };
  Object.assign(connection, overrides);
  const dispose = installTitleServerFallback({ connection, account, app, state, timers });
  return { connection, account, app, state, calls, pending, dispose,
    emit(status) { connection.status = status; for (const fn of [...listeners]) fn(); },
    flush() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    setToken(value) { token = value; }, setEntered(value) { entered = value; },
    listenerCount: () => listeners.size };
}

test('failed anonymous East title connection switches once to South without a close callback race', () => {
  const h = fallbackCase();
  h.emit('reconnecting'); assert.equal(h.pending.size, 1); h.flush();
  assert.deepEqual(h.calls, ['close', 'secondary', 'connect']);
  assert.equal(h.connection.url, 'wss://emiraen.top/ws');
  assert.equal(h.state.get().directory.current, 'secondary');
  assert.equal(h.listenerCount(), 0);
  h.emit('reconnecting'); h.flush();
  assert.deepEqual(h.calls, ['close', 'secondary', 'connect']);
});

test('successful connection cancels fallback and manual disposal pins the current selection', () => {
  for (const status of ['connected', 'handshaking', 'online']) {
    const h = fallbackCase(); h.emit('reconnecting'); h.emit(status); h.flush();
    assert.deepEqual(h.calls, []); assert.equal(h.pending.size, 0); h.dispose();
  }
  const h = fallbackCase(); h.emit('reconnecting'); h.dispose(); h.flush();
  assert.deepEqual(h.calls, []); assert.equal(h.listenerCount(), 0);
});

test('fallback never interrupts login, saved identity, requests or gameplay', () => {
  const guards = [
    h => { h.connection.name = 'player'; },
    h => { h.connection._loginAttempt = {}; },
    h => { h.connection.pendingCount = 1; },
    h => h.setToken('saved-token'), h => h.setEntered(true),
    h => h.app.set({ session: { entered: true } }),
    h => h.app.set({ room: { inMatch: false } }),
    h => h.app.set({ spectator: {} }),
    h => h.app.set({ ui: { restoring: true } }),
    h => h.app.set({ ui: { pendingJoin: { serverId: 'secondary' } } }),
    h => h.app.set({ match: { public: {} } }),
    h => h.app.set({ match: { battle: {} } }),
    h => h.state.set({ switching: true }),
    h => h.state.set({ directory: { ...h.state.get().directory, current: 'secondary' } })
  ];
  for (const guard of guards) {
    const h = fallbackCase(); guard(h); h.emit('reconnecting'); h.flush();
    assert.deepEqual(h.calls, []); h.dispose();
  }
});

test('fallback rechecks login and game state at the moment the timer fires', () => {
  for (const change of [h => { h.connection._loginAttempt = {}; }, h => h.app.set({ room: {} }), h => h.setToken('new-token')]) {
    const h = fallbackCase(); h.emit('reconnecting'); assert.equal(h.pending.size, 1);
    change(h); h.flush(); assert.deepEqual(h.calls, []); h.dispose();
  }
});

test('the South China resource page cannot become a main or secondary game entry', async () => {
  await pageCase(SOUTH_PRELOAD_ORIGIN, async m => {
    const before = net.url;
    assert.throws(() => m.parseDirectory(directory()), /资源预载/);
    for (const index of [0, 1]) {
      const value = directory(); value.servers[index].url = SOUTH_PRELOAD_ORIGIN;
      assert.throws(() => m.parseDirectory(value), /资源预载/);
    }
    assert.equal(identity.getServer(), 'main'); assert.equal(net.url, before);
  });
});

test('normal game entry preserves explicit selections and authenticated server state', async () => {
  for (const options of [{ selected: true }, { token: 'existing-token' }, { entered: true }, { selected: true, current: 'secondary' }]) {
    await pageCase('https://super.emiraen.top:23331', async m => {
      const value = m.parseDirectory(directory());
      assert.equal(await m.prepareServerConnection(Promise.resolve(value)), true);
      assert.equal(identity.getServer(), options.current || 'main');
      assert.equal(net.url, options.current === 'secondary' ? 'wss://emiraen.top/ws' : 'wss://super.emiraen.top:23331/ws');
      assert.equal(identity.getToken(), options.token || null);
    }, options);
  }
});

test('resource origin is rejected if advertised as a game server on the normal entry', async () => {
  await pageCase('https://super.emiraen.top:23331', async m => {
    for (const index of [0, 1]) {
      const value = directory(); value.servers[index].url = SOUTH_PRELOAD_ORIGIN;
      assert.throws(() => m.parseDirectory(value), /资源预载/);
    }
    const value = m.parseDirectory(directory());
    assert.equal(await m.prepareServerConnection(Promise.resolve(value)), true);
    assert.equal(identity.getServer(), 'main'); assert.equal(net.url, 'wss://super.emiraen.top:23331/ws');
  });
});

test('other public origins retain their existing entry restrictions', async () => {
  await pageCase('http://120.24.21.224:3001', async m => assert.throws(() => m.parseDirectory(directory()), /华东/));
});

test('the South China resource-only page retains its complete local index and same-origin resource requests', async () => {
  await pageCase(SOUTH_PRELOAD_ORIGIN, async () => {
    const calls = [];
    const manifest = { schema: 1, groups: { required: [], optional: [], voice: [] } };
    globalThis.fetch = async (input, options) => {
      const url = new URL(input, location); calls.push({ url: url.href, options });
      return url.pathname === '/data/resource-preload.local.json' ? Response.json(manifest) : new Response('local resource');
    };
    const resources = await import(`../public/js/resourceCache.js?south-direct=${++sequence}`);
    assert.equal(resources.localResourceOrigin(), SOUTH_PRELOAD_ORIGIN);
    await resources.resourceCache.ensureSessionReady();
    assert.equal(calls[0].url, SOUTH_PRELOAD_ORIGIN + '/data/resource-preload.local.json');
    const response = await resources.fetchResourceData('/assets/mizuki/native-map.bin?v=2', { headers: { Range: 'bytes=1-9' } });
    assert.equal(await response.text(), 'local resource');
    assert.equal(calls.at(-1).url, SOUTH_PRELOAD_ORIGIN + '/assets/mizuki/native-map.bin?v=2');
    assert.equal(calls.at(-1).options.mode, 'same-origin');
    assert.equal(calls.at(-1).options.credentials, 'same-origin');
    assert.equal(calls.at(-1).options.headers.Range, 'bytes=1-9');
  });
});

test('identity distinguishes remembered or explicit server choice from its initial default', () => {
  const storage = data => ({ getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value; }, removeItem: key => { delete data[key]; } });
  const fresh = createIdentity({ local: storage({}), session: storage({}), channel: null });
  assert.equal(fresh.hasSelectedServer(), false); fresh.selectServer('main'); assert.equal(fresh.hasSelectedServer(), true);
  const remembered = createIdentity({ local: storage({ 'sp.game.server': 'secondary' }), session: storage({}), channel: null });
  assert.equal(remembered.hasSelectedServer(), true); assert.equal(remembered.getServer(), 'secondary');
});
