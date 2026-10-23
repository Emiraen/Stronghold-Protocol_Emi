import test from 'node:test';
import assert from 'node:assert/strict';
import { startAdmin, adminSnapshot } from '../server/admin.js';

function fixture() {
  const ranked = { profiles: new Map(), summary: (aid) => ({ rank: { label: aid === 'aaaabbbb' ? '黄金一 20分' : '未定级' } }) };
  ranked.profiles.set('aaaabbbb', { aid: 'aaaabbbb', name: '甲', placementDone: true, points: 920, wins: 2, losses: 1, lastActive: 123 });
  ranked.profiles.set('ccccdddd', { aid: 'ccccdddd', name: '乙', placementDone: true, points: 1400, wins: 3, losses: 2, lastActive: 456 });
  const registry = { byPlayerId: new Map([
    ['p1', { playerId: 'p1', name: '甲', aid: 'aaaabbbb', connected: true, roomCode: 'ABCD', token: 'do-not-leak' }],
    ['p2', { playerId: 'p2', name: '乙', aid: 'ccccdddd', connected: false, roomCode: null, token: 'do-not-leak' }],
  ]) };
  const match = { round: 7, phase: 'PREP', secretSeed: 'do-not-leak' };
  const lobby = { ranked, rooms: new Map([
    ['ABCD', { code: 'ABCD', mode: 'coop', difficulty: 'HARD', ranked: true, match, matchCtx: { startedAt: 100 }, createdAt: 100,
      seats: [{ name: '甲', playerId: 'p1', isBot: false, connected: true }, { name: 'BOT', isBot: true, connected: true }] }],
  ]) };
  const players = { list: () => [{ aid: 'aaaabbbb', name: '甲', firstSeen: 10, lastSeen: 20 },
    { aid: 'ccccdddd', name: '乙', firstSeen: 11, lastSeen: 21 }] };
  return { registry, lobby, players };
}

test('admin snapshot exposes current rounds, safe seat names, full ranking, and no secrets', () => {
  const state = adminSnapshot(fixture());
  assert.equal(state.matches[0].round, 7);
  assert.equal(state.matches[0].players[0].name, '甲');
  assert.equal(state.ranking[0].name, '乙');
  assert.equal(state.online.length, 1);
  assert.equal(state.players.length, 2);
  assert.doesNotMatch(JSON.stringify(state), /do-not-leak|aaaabbbb|ccccdddd|playerId|secretSeed|token/);
});

test('admin opens without a password or cookie and retains same-origin control checks', async () => {
  let announcement = null;
  let kicks = 0;
  const controls = {
    getAnnouncement: () => announcement,
    publishAnnouncement: (body) => (announcement = { ...body, updatedAt: Date.now() }),
    kick: () => { kicks++; return { ok: true, status: 'kicked' }; },
    kickStatus: () => ({ ok: true, status: 'kicked' }),
  };
  const admin = await startAdmin({ ...fixture(), controls, port: 0, host: '127.0.0.1', allowInsecureLocal: true, log: { error() {} } });
  const url = `http://127.0.0.1:${admin.port}`;
  try {
    const state = await fetch(url + '/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.headers.get('cache-control'), 'no-store');
    assert.equal(state.headers.get('set-cookie'), null);
    const data = await state.json();
    assert.equal(data.summary.matches, 1);
    assert.equal(data.matches[0].phase, 'PREP');
    assert.doesNotMatch(JSON.stringify(data), /aaaabbbb|token|do-not-leak/);
    const page = await fetch(url + '/');
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /id="loginForm"|type="password"|id="logoutButton"/);
    assert.equal((await fetch(url + '/server/admin.js')).status, 404);
    const headers = { origin: url, 'content-type': 'application/json' };
    const content = JSON.stringify({ title: '新公告', content: '无需管理密码' });
    for (const origin of [undefined, 'http://foreign.invalid']) {
      const response = await fetch(url + '/api/announcement', { method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: content });
      assert.equal(response.status, 403);
    }
    assert.equal(announcement, null);
    assert.equal((await fetch(url + '/api/announcement', { method: 'POST', headers, body: content })).status, 200);
    assert.equal((await (await fetch(url + '/api/announcement')).json()).announcement.title, '新公告');
    assert.equal((await fetch(url + '/api/announcement', { method: 'POST', headers, body: '{}' })).status, 400);
    const target = JSON.stringify({ serverId: 'main', targetId: 'c_' + 'a'.repeat(32) });
    assert.equal((await fetch(url + '/api/kick', { method: 'POST', headers, body: target })).status, 200);
    assert.equal(kicks, 1);
    assert.equal((await fetch(url + '/api/login', { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(url + '/api/logout', { method: 'POST', headers })).status, 404);
  } finally { await admin.close(); }
});
