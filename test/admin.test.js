import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { startAdmin, adminSnapshot, checkAdminPassword } from '../server/admin.js';

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
const salt = randomBytes(32);
const pass = 'a-test-only-password-longer-than-sixteen';
const passwordHash = `scrypt$${salt.toString('hex')}$${scryptSync(pass, salt, 64, { maxmem: 64 * 1024 * 1024 }).toString('hex')}`;

test('admin snapshot exposes current rounds, safe seat names, full ranking, and no secrets', () => {
  const state = adminSnapshot(fixture());
  assert.equal(state.matches[0].round, 7);
  assert.equal(state.matches[0].players[0].name, '甲');
  assert.equal(state.ranking[0].name, '乙');
  assert.equal(state.online.length, 1);
  assert.equal(state.players.length, 2);
  assert.doesNotMatch(JSON.stringify(state), /do-not-leak|aaaabbbb|ccccdddd|playerId|secretSeed|token/);
});

test('admin login, origin, session, logout, retry limit and anti-leak headers', async () => {
  assert.ok(checkAdminPassword(pass, passwordHash));
  assert.equal(checkAdminPassword('wrong', passwordHash), false);
  const admin = await startAdmin({ ...fixture(), passwordHash, port: 0, host: '127.0.0.1', allowInsecureLocal: true, log: { error() {} } });
  const url = `http://127.0.0.1:${admin.port}`;
  try {
    const unauthorized = await fetch(url + '/api/state');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url + '/')).status, 200);
    assert.equal((await fetch(url + '/server/admin.js')).status, 404);
    const foreign = await fetch(url + '/api/login', { method: 'POST', headers: { origin: 'http://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ password: pass }) });
    assert.equal(foreign.status, 403);
    const headers = { origin: url, 'content-type': 'application/json' };
    const wrong = await fetch(url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(wrong.status, 401);
    const ok = await fetch(url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: pass }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const secured = await fetch(url + '/api/state', { headers: { cookie } });
    assert.equal(secured.status, 200);
    const data = await secured.json();
    assert.equal(data.summary.matches, 1);
    assert.equal(data.matches[0].phase, 'PREP');
    assert.doesNotMatch(JSON.stringify(data), /aaaabbbb|token|do-not-leak/);
    const logout = await fetch(url + '/api/logout', { method: 'POST', headers: { cookie, origin: url } });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(url + '/api/state', { headers: { cookie } })).status, 401);
    for (let i = 0; i < 8; i++) await fetch(url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal((await fetch(url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) })).status, 429);
  } finally { await admin.close(); }
});
