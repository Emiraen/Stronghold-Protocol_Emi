import test from 'node:test';
import assert from 'node:assert/strict';
import { profileConfig, serverDirectory } from '../server/profileService.js';
import { combinedHealthCounts } from '../server/healthCounts.js';
import { adminSnapshot } from '../server/admin.js';
import { identity, net } from '../public/js/net.js';
import { parseDirectory, prepareServerConnection } from '../public/js/servers.js';
import { isResourceOnlyOrigin } from '../public/js/serverOrigins.js';

const MAIN = 'https://super.emiraen.top:23331', SOUTH = 'https://south.emiraen.top';
async function withLocation(run) {
  const original = globalThis.location; globalThis.location = new URL('https://emiraen.top/');
  try { await run(); } finally { if (original) globalThis.location = original; else delete globalThis.location; }
}

test('retired game server is absent from directory, health and admin completeness', () => {
  const config = profileConfig({ SP_GAME_SERVERS: 'main', SP_MAIN_PUBLIC_URL: MAIN,
    SP_MAIN_PUBLIC_ALIASES: 'https://emiraen.top' });
  const directory = serverDirectory(config);
  assert.deepEqual(directory.servers.map(entry => entry.id), ['main']);
  assert.deepEqual(directory.servers[0].aliases, ['https://emiraen.top']);
  assert.throws(() => profileConfig({ SP_GAME_SERVERS: 'secondary' }));
  const counts = { sockets: 2, sessions: 3, online: 2, rooms: 1, matches: 1, humans: 2, bots: 0 };
  const health = combinedHealthCounts('main', counts, {}, 123, 12000, config.serverIds);
  assert.equal(health.countsComplete, true); assert.equal(health.online, 2); assert.deepEqual(Object.keys(health.servers), ['main']);
  const ranked = { profiles: new Map(), summary: () => ({ rank: { label: '未定级' } }) };
  const snapshot = adminSnapshot({ lobby: { ranked }, registry: {}, serverIds: config.serverIds,
    runtimes: { main: { ageMs: 0, runtime: { online: [], matches: [] } } } });
  assert.equal(snapshot.summary.complete, true); assert.equal(snapshot.summary.online, 0);
  assert.deepEqual(snapshot.servers.map(entry => entry.id), ['main']);
});

test('entry frontend selects East directly and retires a stored South selection', async () => withLocation(async () => {
  const old = identity.getServer(), netState = { name: net.name, url: net.url };
  identity.selectServer('secondary');
  try {
    const parsed = parseDirectory({ current: 'main', servers: [{ id: 'main', url: MAIN, aliases: ['https://emiraen.top'] }] });
    assert.equal(parsed.current, 'main'); assert.equal(identity.getServer(), 'main');
    assert.equal(await prepareServerConnection(Promise.resolve(parsed)), true);
    assert.equal(net.url, 'wss://super.emiraen.top:23331/ws');
    assert.throws(() => parseDirectory({ current: 'main', servers: [{ id: 'main', url: MAIN, aliases: [SOUTH] }] }), /别名/);
  } finally { identity.selectServer(old); Object.assign(net, netState); }
}));

test('resource CDN is resource-only while the entry server is not', () => {
  assert.equal(isResourceOnlyOrigin(SOUTH), true);
  assert.equal(isResourceOnlyOrigin('http://120.24.21.224:3000'), true);
  assert.equal(isResourceOnlyOrigin('https://emiraen.top'), false);
  assert.equal(isResourceOnlyOrigin('https://mainsouth.emiraen.top'), false);
});

test('essential payload prefers the resource CDN and falls back to East preserving Range', async () => withLocation(async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: new URL(input), range: new Headers(options.headers).get('Range') });
    return calls.length === 1 ? new Response('', { status: 503 }) : new Response('texture');
  };
  try {
    const { fetchResourceData } = await import('../public/js/resourceCache.js?topology');
    const response = await fetchResourceData('/assets/map.png?v=1', { headers: { Range: 'bytes=2-9' } }, { requiredOnline: true });
    assert.equal(await response.text(), 'texture');
    assert.deepEqual(calls.map(c => c.url.origin), [SOUTH, MAIN]);
    assert.ok(calls.every(c => c.range === 'bytes=2-9' && c.url.pathname + c.url.search === '/assets/map.png?v=1'));
  } finally { globalThis.fetch = before; }
}));
