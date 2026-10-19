import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegionAuthority } from '../server/regions.js';
import { createRecruitmentCache, validateRecruitmentItems, RECRUITMENT_TTL_MS } from '../server/recruitmentDirectory.js';
import { startServer } from '../server/index.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';

const row = (serverId, code) => ({ serverId, code, mode: 'coop', variant: null, modeId: 'coop_normal', difficulty: 'NORMAL',
  ranked: false, hostId: `p_${serverId}`, hostName: serverId, capacity: 4, occupied: 1, missing: 3,
  seats: [{ seat: 0, playerId: `p_${serverId}`, name: serverId, isBot: false }], stage: null, createdAt: 100, invitedAt: 200 });
const heartbeat = (serverId, items) => ({ serverId, leases: [], sample: { bandwidthMbps: serverId === 'main' ? 5 : 3, bytesPerSecond: 0 }, recruitmentItems: items });

test('cross-region recruitment expires disconnected sources, clears empty snapshots and rejects private/foreign fields', () => {
  let now = 1000;
  const authority = createRegionAuthority({ now: () => now });
  const cache = createRecruitmentCache('main', () => now);
  const east = row('main', 'ABCD'), south = row('secondary', 'NPQR');
  authority.heartbeat(heartbeat('secondary', [south]));
  cache.update(authority.recruitmentSnapshots());
  assert.deepEqual(cache.directory([east]).map((r) => `${r.serverId}:${r.code}`), ['main:ABCD', 'secondary:NPQR']);
  authority.heartbeat(heartbeat('secondary', []));
  cache.update(authority.recruitmentSnapshots());
  assert.deepEqual(cache.directory([east]), [east], 'empty update withdraws room immediately');
  authority.heartbeat(heartbeat('secondary', [south]));
  cache.update(authority.recruitmentSnapshots());
  now += RECRUITMENT_TTL_MS;
  assert.deepEqual(cache.directory([east]), [east], 'local TTL works without any further network responses');
  assert.equal(authority.recruitmentSnapshots().secondary.items, null);
  for (const bad of [{ ...south, token: 'secret' }, { ...south, serverUrl: 'http://untrusted/' },
    { ...south, code: 'ABCD' }, { ...south, capacity: 8, missing: 7 }]) {
    assert.throws(() => validateRecruitmentItems([bad], 'secondary'));
  }
});

test('real signed profile bridge propagates both recruitment directories and withdrawals without extra polling endpoints', async () => {
  const stores = () => ({ ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }) });
  const config = { role: 'main', id: 'main', secret: 'test-recruitment-bridge', mainUrl: 'http://east.example:3000', secondaryUrl: 'http://south.example:3000', serviceUrl: null };
  const east = await startServer({ port: 0, host: '127.0.0.1', quiet: true, admin: false, profileConfig: config, ...stores() });
  let south;
  try {
    south = await startServer({ port: 0, host: '127.0.0.1', quiet: true, admin: false,
      profileConfig: { ...config, role: 'secondary', id: 'secondary', serviceUrl: `http://127.0.0.1:${east.port}` }, ...stores() });
    let eastItems = [row('main', 'ABCD')], southItems = [row('secondary', 'NPQR')];
    east.lobby.recruitmentItems = () => eastItems;
    south.lobby.recruitmentItems = () => southItems;
    await east.lobby.profiles.flushReplication();
    await south.lobby.profiles.flushReplication();
    for (const server of [east, south]) {
      const directory = server.lobby.recruitmentDirectory();
      assert.equal(directory.length, 2);
      assert.equal(directory.find((r) => r.serverId === 'main').serverUrl, config.mainUrl);
      assert.equal(directory.find((r) => r.serverId === 'secondary').serverName, '华南');
      assert.equal(directory.find((r) => r.serverId === 'secondary').serverUrl, config.secondaryUrl);
      assert.ok(!JSON.stringify(directory).match(/secret|token|lease|aid/));
    }
    southItems = [];
    await south.lobby.profiles.flushReplication();
    assert.equal(east.lobby.recruitmentDirectory().length, 1);
    assert.equal(south.lobby.recruitmentDirectory().length, 1);
    eastItems = [];
    await east.lobby.profiles.flushReplication();
    await south.lobby.profiles.flushReplication();
    assert.deepEqual(east.lobby.recruitmentDirectory(), []);
    assert.deepEqual(south.lobby.recruitmentDirectory(), []);
  } finally { if (south) await south.close(); await east.close(); }
});
