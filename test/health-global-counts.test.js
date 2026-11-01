import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRegionAuthority, LEASE_MS } from '../server/regions.js';
import { combinedHealthCounts, localHealthCounts } from '../server/healthCounts.js';
import { createRequestHandler, healthReport } from '../server/http/routes.js';

const east = { sockets: 7, sessions: 9, online: 5, rooms: 3, matches: 2, humans: 6, bots: 2 };
const south = { sockets: 11, sessions: 13, online: 8, rooms: 5, matches: 4, humans: 9, bots: 3 };
const heartbeat = (serverId, health) => ({ serverId, leases: [], sample: { bandwidthMbps: 5, bytesPerSecond: 0 }, health });

test('regional heartbeats carry bounded counters, and both regions report identical totals without doubling local counts', () => {
  let now = 1000;
  const authority = createRegionAuthority({ now: () => now });
  authority.heartbeat(heartbeat('main', east)); authority.heartbeat(heartbeat('secondary', south));
  const states = authority.states();
  const a = combinedHealthCounts('main', east, states, now), b = combinedHealthCounts('secondary', south, states, now);
  for (const key of Object.keys(east)) assert.equal(a[key], east[key] + south[key]);
  assert.deepEqual(a, b); assert.equal(a.countsComplete, true);
  states.secondary.health.online = 999;
  assert.equal(authority.states().secondary.health.online, 8, 'public counters cannot mutate stored heartbeat state');
  assert.throws(() => authority.heartbeat(heartbeat('main', { ...east, sockets: -1 })), /健康统计/);
  assert.throws(() => authority.heartbeat(heartbeat('main', { ...east, sockets: NaN })), /健康统计/);
});

test('expired or older-server samples are explicitly partial and never silently counted as current', () => {
  const states = { secondary: { at: 100, health: south } };
  assert.equal(combinedHealthCounts('main', east, states, 100 + LEASE_MS - 1).matches, 6);
  const stale = combinedHealthCounts('main', east, states, 100 + LEASE_MS);
  assert.equal(stale.matches, 2); assert.equal(stale.countsComplete, false); assert.equal(stale.servers.secondary.available, false);
  assert.equal(combinedHealthCounts('main', east, { secondary: { at: 100 } }, 101).countsComplete, false);
});

test('live health counts distinguish online players, resumable sessions and transport connections', () => {
  const local = localHealthCounts({ connectionCount: 4 }, { size: 5, all: () => [{ connected: true }, { connected: false }, { connected: true }] },
    { stats: () => ({ rooms: 2, matches: 1, humans: 3, bots: 1 }) });
  assert.deepEqual(local, { sockets: 4, sessions: 5, online: 2, rooms: 2, matches: 1, humans: 3, bots: 1 });
});

test('/healthz and diagnostic report use the same regional totals and retain app 0.3.1', async t => {
  const registry = { size: east.sessions, all: () => Array.from({ length: east.online }, () => ({ connected: true })) };
  const lobby = { ranked: { size: 30 }, stats: () => east,
    profiles: { healthCounters: local => combinedHealthCounts('main', local, { secondary: { at: 100, health: south } }, 101) } };
  const options = { startedAt: Date.now(), network: { connectionCount: east.sockets }, registry, lobby, log: { error: assert.fail }, serveStatic() {} };
  const server = http.createServer(createRequestHandler(options));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`), body = await response.json();
  assert.equal(body.app, '0.3.1'); assert.equal(body.online, 13); assert.equal(body.matches, 6); assert.equal(body.sockets, 18);
  assert.equal(body.sessions, 22); assert.equal(body.ranked, 30); assert.equal(body.countsComplete, true);
  const diagnostic = healthReport(options);
  for (const key of Object.keys(east)) assert.equal(diagnostic[key], body[key]);
});
