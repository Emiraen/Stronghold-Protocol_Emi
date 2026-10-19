import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import http from 'node:http';
import { startServer } from '../server/index.js';
import { createRegionAuthority, createSpectatorCache, directoryHash, LEASE_MS } from '../server/regions.js';
import { createRecruitmentCache } from '../server/recruitmentDirectory.js';
import { createAuthority, createDirectoryTransport } from '../server/profileService.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';

const heartbeat = (serverId, extra = {}) => ({ serverId, leases: [],
  sample: { bandwidthMbps: serverId === 'main' ? 5 : 3, bytesPerSecond: 0 }, ...extra });
const recruit = (name = '房主') => ({ serverId: 'main', code: 'ABCD', mode: 'coop', variant: null,
  modeId: 'coop_normal', difficulty: 'NORMAL', ranked: false, hostId: 'p_host', hostName: name,
  capacity: 4, occupied: 1, missing: 3, seats: [{ seat: 0, playerId: 'p_host', name, isBot: false }],
  stage: null, createdAt: 100, invitedAt: 200 });
const spectator = () => ({ serverId: 'main', code: 'ABCD', matchId: 'a'.repeat(32), mode: 'coop',
  variant: null, difficulty: 'NORMAL', ranked: false, startedAt: 100, round: 1, phase: 'PREP',
  spectators: 0, players: [{ playerId: 'p_host', name: '房主', isBot: false, alive: true, lp: 100 }] });
const stores = () => ({ players: new PlayerStore({ file: null }), ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }) });
const bodyBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const gzipBytes = (value) => gzipSync(JSON.stringify(value)).length;
const largeRecruits = (name = '房主') => Array.from({ length: 80 }, (_, i) => ({
  ...recruit(name), code: `AA${'ABCDEFGHJKLM'[Math.floor(i / 12)]}${'ABCDEFGHJKLM'[i % 12]}`,
  hostId: `p_${i}`, createdAt: 100 + i, invitedAt: 200 + i,
}));
const largeSpectators = () => largeRecruits().map((r, i) => ({ ...spectator(), code: r.code, matchId: i.toString(16).padStart(32, '0') }));

test('chat sends history once, then all cursor events; gaps and new authority epochs recover full history', () => {
  let now = 1000;
  const authority = createRegionAuthority({ now: () => now });
  authority.heartbeat(heartbeat('secondary'));
  const publish = (n) => assert.equal(authority.chat.publishText({ playerId: `p_${n}`, name: '聊天者' }, `消息${n}`, now++).ok, true);
  for (let i = 0; i < 55; i++) publish(i);
  const initial = authority.chatHistory('secondary', 0, null, 1);
  assert.equal(initial.history.length, 50);
  assert.deepEqual(initial.events, [], 'history is not duplicated in events');
  const idle = authority.chatHistory('secondary', initial.cursor, initial.epoch, 1);
  assert.equal(Object.hasOwn(idle, 'history'), false);
  assert.deepEqual(idle.events, []);
  for (let i = 55; i < 115; i++) publish(i);
  const delta = authority.chatHistory('secondary', initial.cursor, initial.epoch, 1);
  assert.equal(delta.events.length, 60, 'display history limit never truncates incremental delivery');
  assert.equal(Object.hasOwn(delta, 'history'), false);
  authority.chatHistory('secondary', delta.cursor, delta.epoch, 1); // acknowledgement prunes old events
  const stale = authority.chatHistory('secondary', initial.cursor, initial.epoch, 1);
  assert.equal(stale.history.length, 50, 'expired cursor falls back to current history');
  assert.deepEqual(stale.events, []);
  assert.equal(authority.chatHistory('secondary', 10000, initial.epoch, 1).history.length, 50);
  const restarted = createRegionAuthority({ now: () => now });
  assert.deepEqual(restarted.chatHistory('secondary', delta.cursor, delta.epoch, 1).history, []);
  const legacy = authority.chatHistory('secondary', delta.cursor, delta.epoch);
  assert.equal(legacy.history.length, 50, 'old callers keep the original full response');
});

test('directory references renew source freshness, preserve legacy shape and withdraw empty/stale directories', () => {
  let now = 1000;
  const authority = createRegionAuthority({ now: () => now });
  const items = largeRecruits(), spectators = largeSpectators();
  const full = authority.heartbeat(heartbeat('main', { recruitmentItems: items, spectatorItems: spectators, directoryDelta: 1 }));
  assert.deepEqual(full.recruitment.main, { ageMs: 0, items });
  const versions = { epoch: full.epoch, recruitment: { main: directoryHash(items) }, spectators: { main: directoryHash(spectators) } };
  now += LEASE_MS - 1;
  const confirmed = authority.heartbeat(heartbeat('main', { directoryDelta: 1, directoryVersions: versions,
    directoryReport: { epoch: full.epoch, recruitment: versions.recruitment.main, spectators: versions.spectators.main } }));
  assert.deepEqual(confirmed.recruitment.main, { ageMs: 0, version: versions.recruitment.main });
  assert.deepEqual(confirmed.spectators.main, { ageMs: 0, version: versions.spectators.main });
  assert.ok(confirmed.directorySequence > full.directorySequence);
  const legacy = authority.heartbeat(heartbeat('secondary'));
  assert.deepEqual(Object.keys(legacy.recruitment.main).sort(), ['ageMs', 'items']);
  assert.equal(Object.hasOwn(legacy, 'directoryDelta'), false);
  now += LEASE_MS;
  const stale = authority.heartbeat(heartbeat('secondary', { directoryDelta: 1, directoryVersions: versions }));
  assert.equal(stale.recruitment.main.items, null, 'ordinary peer heartbeats do not extend source liveness');
  const renewed = authority.heartbeat(heartbeat('main', { directoryDelta: 1, directoryVersions: versions,
    directoryReport: { epoch: full.epoch, recruitment: versions.recruitment.main } }));
  assert.equal(renewed.recruitment.main.ageMs, 0, 'matching source reference can revive retained content');
  const withdrawn = authority.heartbeat(heartbeat('main', { recruitmentItems: [], directoryDelta: 1, directoryVersions: versions }));
  assert.deepEqual(withdrawn.recruitment.main.items, [], 'empty replacement is explicit, never confused with unchanged');
  assert.equal(Object.hasOwn(withdrawn.recruitment.main, 'version'), false, 'tiny directories cost less as full arrays');
  assert.throws(() => authority.heartbeat(heartbeat('main', { directoryReport: { epoch: full.epoch, recruitment: 'bad' } })));
});

test('directory receiver handles three-chain response reorder, missing bases and authority restarts', () => {
  let now = 1000;
  const authority = createRegionAuthority({ now: () => now });
  const spectators = createSpectatorCache('secondary', () => now);
  const recruitment = createRecruitmentCache('secondary', () => now);
  const transport = createDirectoryTransport(spectators, recruitment);
  const first = authority.heartbeat(heartbeat('main', { recruitmentItems: largeRecruits('甲'), ...transport.request() }));
  transport.receive(first, now);
  const ack = authority.heartbeat(heartbeat('secondary', transport.request()));
  transport.receive(ack, now);
  assert.equal(Object.hasOwn(transport.report('main', { spectators: [], recruitment: largeRecruits('甲') }), 'recruitmentItems'), false);
  const middle = authority.heartbeat(heartbeat('main', { recruitmentItems: largeRecruits('乙'), ...transport.request() }));
  const latest = authority.heartbeat(heartbeat('main', { recruitmentItems: largeRecruits('丙'), ...transport.request() }));
  transport.receive(latest, now);
  assert.equal(transport.receive(middle, now), false);
  assert.equal(recruitment.directory([])[0].hostName, '丙');
  const reference = authority.heartbeat(heartbeat('secondary', transport.request()));
  assert.equal(Object.hasOwn(reference.recruitment.main, 'items'), false);
  transport.receive(reference, now);
  const broken = structuredClone(reference);
  broken.directorySequence++;
  broken.recruitment.main.version = 'f'.repeat(64);
  assert.throws(() => transport.receive(broken, now), /基准/);
  assert.equal(transport.request().directoryVersions, undefined, 'missing baseline requests a full recovery');
  const recovered = authority.heartbeat(heartbeat('secondary', transport.request()));
  assert.ok(Array.isArray(recovered.recruitment.main.items));
  transport.receive(recovered, now);
  const restarted = createRegionAuthority({ now: () => now });
  const restartFrame = restarted.heartbeat(heartbeat('main', { recruitmentItems: [recruit('新')], ...transport.request() }));
  assert.ok(Array.isArray(restartFrame.recruitment.main.items), 'epoch mismatch forces full contents');
  transport.receive(restartFrame, now);
  assert.equal(transport.receive(latest, now), false, 'late response cannot revive retired epoch');
  assert.equal(recruitment.directory([])[0].hostName, '新');
});

test('new directory receiver accepts old main and always uploads full data until compact is acknowledged', () => {
  const authority = createRegionAuthority();
  const transport = createDirectoryTransport(createSpectatorCache('secondary'), createRecruitmentCache('secondary'));
  const items = { spectators: [], recruitment: [recruit()] };
  assert.deepEqual(transport.report('main', items).recruitmentItems, items.recruitment);
  transport.receive(authority.heartbeat(heartbeat('main', { recruitmentItems: items.recruitment })), performance.now());
  assert.deepEqual(transport.report('main', items).recruitmentItems, items.recruitment, 'legacy response is not a reference acknowledgement');
  const unknown = authority.heartbeat(heartbeat('main', { directoryDelta: 1,
    directoryReport: { epoch: 'old-authority', recruitment: directoryHash([recruit('别处')]) } }));
  assert.deepEqual(unknown.recruitment.main.items, items.recruitment, 'unrecognized reports never replace retained content');
});

test('an unseen old epoch arriving after a newer request cannot retire the new authority', () => {
  const oldAuthority = createRegionAuthority(), newAuthority = createRegionAuthority();
  const transport = createDirectoryTransport(createSpectatorCache('secondary'), createRecruitmentCache('secondary'));
  const old = oldAuthority.heartbeat(heartbeat('main', { recruitmentItems: [recruit('旧')], ...transport.request() }));
  const fresh = newAuthority.heartbeat(heartbeat('main', { recruitmentItems: [recruit('新')], ...transport.request() }));
  assert.equal(transport.receive(fresh, 200), true);
  assert.equal(transport.receive(old, 100), false);
  assert.equal(transport.receive(newAuthority.heartbeat(heartbeat('main', transport.request())), 300), true);
});

test('announcement response is conditional only for callers with the matching version', async () => {
  const authority = createAuthority(stores());
  const announcement = { title: '测试公告', content: '公告正文'.repeat(100), updatedAt: 42 };
  authority.announcementProvider = () => announcement;
  assert.deepEqual((await authority.call('region.heartbeat', [heartbeat('secondary')])).announcement, announcement);
  assert.equal(Object.hasOwn(await authority.call('region.heartbeat', [heartbeat('secondary', { announcementVersion: 42 })]), 'announcement'), false);
  assert.deepEqual((await authority.call('region.heartbeat', [heartbeat('secondary', { announcementVersion: 41 })])).announcement, announcement);
  assert.throws(() => authority.call('region.heartbeat', [heartbeat('secondary', { announcementVersion: -1 })]));
  authority.announcementProvider = () => ({ ...announcement, updatedAt: 0 });
  assert.equal((await authority.call('region.heartbeat', [heartbeat('secondary', { announcementVersion: 0 })])).announcement.updatedAt, 0,
    'unversioned initial files can differ between regions and must still synchronize');
});

test('representative repeated directory/chat response byte comparison preserves gzip', (t) => {
  const authority = createRegionAuthority({ now: () => 1000 });
  const transport = createDirectoryTransport(createSpectatorCache('secondary', () => 1000), createRecruitmentCache('secondary', () => 1000));
  const seeded = authority.heartbeat(heartbeat('main', { recruitmentItems: largeRecruits(), spectatorItems: largeSpectators(), ...transport.request() }));
  transport.receive(seeded, 1000);
  const legacy = authority.heartbeat(heartbeat('secondary'));
  const compact = authority.heartbeat(heartbeat('secondary', transport.request()));
  assert.ok(bodyBytes(compact) < bodyBytes(legacy));
  assert.ok(gzipBytes(compact) < gzipBytes(legacy));
  const legacyTotal = gzipBytes({ op: 'region.heartbeat', args: [heartbeat('secondary')] }) + gzipBytes({ value: legacy });
  const compactTotal = gzipBytes({ op: 'region.heartbeat', args: [heartbeat('secondary', transport.request())] }) + gzipBytes({ value: compact });
  assert.ok(compactTotal < legacyTotal, 'references must save compressed bytes in both directions combined');
  t.diagnostic(`large directory bidirectional gzip ${legacyTotal} -> ${compactTotal} B`);
  for (let i = 0; i < 50; i++) authority.chat.publishText({ playerId: `p_${i}`, name: '聊天者' }, `测试消息${i} ${'内容'.repeat(70)}`, 1000);
  const chat = authority.chatHistory('secondary', 0, null, 1);
  const oldChat = authority.chatHistory('secondary', chat.cursor, chat.epoch);
  const newChat = authority.chatHistory('secondary', chat.cursor, chat.epoch, 1);
  assert.ok(gzipBytes(newChat) < gzipBytes(oldChat));
  t.diagnostic(`directory response JSON ${bodyBytes(legacy)} -> ${bodyBytes(compact)} B; gzip ${gzipBytes(legacy)} -> ${gzipBytes(compact)} B`);
  t.diagnostic(`idle 50-message chat response JSON ${bodyBytes(oldChat)} -> ${bodyBytes(newChat)} B; gzip ${gzipBytes(oldChat)} -> ${gzipBytes(newChat)} B`);
  t.diagnostic(`directory request JSON ${bodyBytes(heartbeat('secondary'))} -> ${bodyBytes(heartbeat('secondary', transport.request()))} B; gzip ${gzipBytes(heartbeat('secondary'))} -> ${gzipBytes(heartbeat('secondary', transport.request()))} B`);
});

test('empty and small directories use the unchanged full wire protocol with no negotiation overhead', () => {
  for (const items of [[], [recruit()]]) {
    const authority = createRegionAuthority({ now: () => 1000 });
    const transport = createDirectoryTransport(createSpectatorCache('secondary'), createRecruitmentCache('secondary'));
    const frame = authority.heartbeat(heartbeat('main', { recruitmentItems: items, spectatorItems: [] }));
    transport.receive(frame, 1000);
    assert.deepEqual(transport.request(), {});
    assert.deepEqual(transport.report('main', { spectators: [], recruitment: items }), { spectatorItems: [], recruitmentItems: items });
    const old = authority.heartbeat(heartbeat('secondary'));
    const fresh = authority.heartbeat(heartbeat('secondary', transport.request()));
    assert.equal(gzipBytes({ value: old }), gzipBytes({ value: fresh }));
  }
});

test('strict old-main HTTP400 negotiates immediate legacy retry and retains replication and chat', async () => {
  const config = { role: 'main', id: 'main', secret: 'local-transport-test', mainUrl: 'http://east.example', secondaryUrl: 'http://south.example' };
  const east = await startServer({ port: 0, host: '127.0.0.1', quiet: true, admin: false, workerPool: null, stateFile: 'off', profileConfig: config, ...stores() });
  await east.lobby.profiles.adminControls.publishAnnouncement({ title: '兼容公告', content: '用于验证已确认版本的降级传输' });
  let south, heartbeatRejects = 0, chatRejects = 0, authRejects = 0, denyChat = false;
  const proxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const packed = Buffer.concat(chunks);
    const body = JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(packed) : packed).toString());
    const value = body.args[0];
    if (body.op === 'chat.history' && denyChat) { authRejects++; res.writeHead(401); res.end(); return; }
    if (body.op === 'region.heartbeat' && ['announcementVersion', 'directoryDelta', 'directoryVersions', 'directoryReport'].some(k => Object.hasOwn(value, k))) {
      heartbeatRejects++; res.writeHead(400); res.end(); return;
    }
    if (body.op === 'chat.history' && body.args.length > 3) { chatRejects++; res.writeHead(400); res.end(); return; }
    const forwarded = http.request({ hostname: '127.0.0.1', port: east.port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    forwarded.on('error', error => res.destroy(error));
    forwarded.end(packed);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    south = await startServer({ port: 0, host: '127.0.0.1', quiet: true, admin: false, workerPool: null, stateFile: 'off',
      profileConfig: { ...config, role: 'secondary', id: 'secondary', serviceUrl: `http://127.0.0.1:${proxy.address().port}` }, ...stores() });
    assert.equal(south.lobby.profiles.initialized, true);
    await south.lobby.profiles.flushReplication();
    await south.lobby.profiles.chatHistory();
    await south.lobby.profiles.chatHistory();
    assert.equal(heartbeatRejects, 1, 'only the first optional heartbeat is rejected');
    assert.equal(chatRejects, 1, 'only the first extended chat request is rejected');
    denyChat = true;
    await assert.rejects(south.lobby.profiles.chatHistory(), /401/);
    assert.equal(authRejects, 1, 'authentication failures must never trigger retry/downgrade');
  } finally {
    if (south) await south.close();
    await new Promise(resolve => proxy.close(resolve));
    await east.close();
  }
});
