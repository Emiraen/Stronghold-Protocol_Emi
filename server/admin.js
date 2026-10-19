// Private management HTTP(S) listener. Never mount these routes on the public game listener.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { rankOf } from '../shared/ranks.js';
import { LEASE_MS, SERVER_NAMES, validateKick } from './regions.js';
import { validateAnnouncement } from './announcement.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONT = path.join(ROOT, 'admin');
const SESSION_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 50;
const SNAPSHOT_CACHE_MS = 5000;
const snapshotCaches = new WeakMap();
const failed = (res, code, message) => reply(res, code, { error: message });
const reply = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const nameOf = (value) => String(value || '').slice(0, 64);

/** Environment format: scrypt$<32-byte-hex-salt>$<64-byte-hex-derived-key>. */
export function checkAdminPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024 || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[0-9a-f]{64}$/.test(parts[1]) || !/^[0-9a-f]{128}$/.test(parts[2])) return false;
  const actual = scryptSync(password, Buffer.from(parts[1], 'hex'), 64, { maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}

export function adminRuntime({ lobby, registry }) {
  return {
    online: [...registry.byPlayerId.values()].filter((s) => s.connected).map((s) => ({
      aid: s.aid || null, name: nameOf(s.name), roomCode: s.roomCode || null,
      ...(s.targetId ? { targetId: s.targetId } : {}),
    })),
    matches: [...lobby.rooms.values()].filter((r) => r.match && !r.disposed).map((r) => ({
      code: r.code, mode: r.mode, difficulty: r.difficulty, ranked: !!r.ranked,
      round: Number.isInteger(r.match?.round) ? r.match.round : 0,
      phase: typeof r.match?.phase === 'string' ? r.match.phase : '',
      startedAt: Number.isFinite(r.matchCtx?.startedAt) ? r.matchCtx.startedAt : r.createdAt,
      players: r.seats.filter((seat) => seat && !seat.left).map((seat) => ({
        name: nameOf(seat.name), isBot: !!seat.isBot, connected: !!seat.connected,
      })),
    })),
  };
}

export function adminSnapshot({ lobby, registry, players, runtimes }) {
  const rankedProfiles = [...lobby.ranked.profiles.values()].filter((p) => p.placementDone)
    .sort((a, b) => b.points - a.points || b.lastActive - a.lastActive || a.name.localeCompare(b.name, 'zh'));
  const ranks = new Map();
  let position = 0;
  for (const [i, p] of rankedProfiles.entries()) {
    const previous = rankedProfiles[i - 1];
    if (!previous || p.points !== previous.points || p.lastActive !== previous.lastActive) position = i + 1;
    if (p.points >= 2100) ranks.set(p.aid, position);
  }
  const sources = runtimes ? Object.keys(SERVER_NAMES).map((id) => ({ id, ...runtimes[id] }))
    : [{ runtime: adminRuntime({ lobby, registry }) }];
  const complete = sources.every((source) => !!source.runtime);
  const sessions = sources.flatMap(({ id, runtime }) => (runtime?.online || [])
    .map((row) => ({ ...row, ...(runtimes ? { serverId: id } : {}) })));
  const onlineIds = new Set(sessions.map((s) => s.aid).filter(Boolean));
  const online = sessions.map((s) => ({
    name: nameOf(s.name), roomCode: s.roomCode || null,
    rankedLabel: s.aid ? lobby.ranked.summary(s.aid, s.name, false, ranks).rank.label : '未定级',
    serverId: s.serverId || 'main', targetId: s.targetId || null,
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const matches = sources.flatMap(({ id, runtime }) => (runtime?.matches || [])
    .map((row) => ({ ...row, ...(runtimes ? { serverId: id } : {}) })))
    .sort((a, b) => a.startedAt - b.startedAt);
  const recorded = players?.internalSnapshot?.() || players?.list?.() || [];
  const registered = recorded.map((p) => ({
    name: nameOf(p.name), firstSeen: p.firstSeen || null, lastSeen: p.lastSeen || null,
    online: p.aid && onlineIds.has(p.aid) ? true : complete ? false : null,
    rankedLabel: p.aid ? lobby.ranked.summary(p.aid, p.name, false, ranks).rank.label : '未定级',
  }));
  // Existing ranked/history profiles predate the independent player registry. Deduplicate by aid internally.
  const known = new Set(recorded.map((p) => p.aid));
  for (const p of lobby.ranked.profiles.values()) {
    if (known.has(p.aid)) continue;
    registered.push({ name: nameOf(p.name), firstSeen: null, lastSeen: p.lastActive || null,
      online: onlineIds.has(p.aid) ? true : complete ? false : null,
      rankedLabel: lobby.ranked.summary(p.aid, p.name, false, ranks).rank.label });
    known.add(p.aid);
  }
  registered.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const ranking = rankedProfiles.map((p, i) => ({ position: i + 1, name: nameOf(p.name), points: p.points,
      label: rankOf(p.points).label, wins: p.wins, losses: p.losses }));
  const subtotal = { online: runtimes ? onlineIds.size + sessions.filter((s) => !s.aid).length : online.length,
    matches: matches.length, ranked: matches.filter((match) => match.ranked).length };
  const servers = runtimes ? sources.map(({ id, ageMs, runtime }) => ({
    id, name: SERVER_NAMES[id], status: runtime ? 'online' : 'unknown', ageMs: ageMs ?? null,
    summary: runtime ? { online: new Set(runtime.online.map((s) => s.aid).filter(Boolean)).size
      + runtime.online.filter((s) => !s.aid).length, matches: runtime.matches.length,
    ranked: runtime.matches.filter((match) => match.ranked).length } : { online: null, matches: null, ranked: null },
  })) : null;
  return {
    now: Date.now(), summary: { online: complete ? subtotal.online : null, players: registered.length,
      matches: complete ? subtotal.matches : null, ranked: complete ? subtotal.ranked : null,
      ...(runtimes ? { complete, known: subtotal } : {}) },
    matches, online, players: registered, ranking, ...(runtimes ? { servers } : {}),
  };
}

// 同一数据源共享一次生成、一次序列化；聚合缓存不得越过任一服的失联边界。
export function createAdminStateSource({ snapshot, now = () => performance.now() }) {
  let cache = null, expiresAt = 0, pending = null, revision = 0;
  return {
    invalidate() { revision++; cache = null; expiresAt = 0; },
    async state() {
      if (cache !== null && now() < expiresAt) return cache;
      const started = now(), generation = revision;
      if (!pending) pending = Promise.resolve().then(snapshot).then((value) => {
        const ttl = Math.min(SNAPSHOT_CACHE_MS, ...(value.servers || [])
          .filter((server) => server.status === 'online').map((server) => Math.max(0, LEASE_MS - server.ageMs)));
        const json = JSON.stringify(value);
        if (generation === revision) { cache = json; expiresAt = started + ttl; }
        return json;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

/** Create a listener; HTTP is allowed only for unit tests on loopback. */
export async function startAdmin({ lobby, registry, players, stateSource, controls, port = 56129, host = '0.0.0.0',
  passwordHash, tls, allowInsecureLocal = false, log = console }) {
  if (typeof passwordHash !== 'string' || !/^scrypt\$[0-9a-f]{64}\$[0-9a-f]{128}$/.test(passwordHash)) {
    throw new Error('invalid ADMIN_PASSWORD_HASH');
  }
  if (!tls && !(allowInsecureLocal && (host === '127.0.0.1' || host === '::1'))) {
    throw new Error('admin listener requires TLS');
  }
  let registryCaches = snapshotCaches.get(lobby);
  if (!registryCaches) snapshotCaches.set(lobby, registryCaches = new WeakMap());
  let playerCaches = registryCaches.get(registry);
  if (!playerCaches) registryCaches.set(registry, playerCaches = new Map());
  let stateCache = playerCaches.get(players);
  if (!stateCache) playerCaches.set(players, stateCache = { json: null, expiresAt: 0 });
  const sessions = new Map();
  const attempts = new Map();
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  };
  const server = (tls ? https.createServer.bind(null, tls) : http.createServer)((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const pathname = req.url?.split('?')[0];
    const peer = req.socket.remoteAddress || '';
    const now = Date.now();
    for (const [id, exp] of sessions) if (exp <= now) sessions.delete(id);
    for (const [ip, row] of attempts) if (now - row.start > 15 * 60_000) attempts.delete(ip);
    const raw = /(?:^|;\s*)sp_admin=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const authorized = raw && sessions.get(sha(raw)) > now;
    const sameOrigin = () => {
      const expected = `${tls ? 'https' : 'http'}://${req.headers.host}`;
      return req.headers.origin === expected;
    };
    const readBody = async () => {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32 * 1024) throw new Error('body too large');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const action = async () => {
      if (req.method === 'POST' && (pathname === '/api/login' || pathname === '/api/logout')) {
        if (!sameOrigin()) return failed(res, 403, '请求来源无效');
        if (pathname === '/api/logout') {
          if (raw) sessions.delete(sha(raw));
          res.setHeader('Set-Cookie', `sp_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tls ? '; Secure' : ''}`);
          res.writeHead(204); res.end(); return;
        }
        const row = attempts.get(peer) || { start: now, count: 0 };
        if (now - row.start > 15 * 60_000) { row.start = now; row.count = 0; }
        if (row.count >= 8) return failed(res, 429, '尝试过多，请稍后再试');
        const body = await readBody();
        if (!checkAdminPassword(body?.password, passwordHash)) {
          row.count++;
          if (attempts.size >= 10_000 && !attempts.has(peer)) attempts.delete(attempts.keys().next().value);
          attempts.set(peer, row);
          return failed(res, 401, '密码错误');
        }
        attempts.delete(peer);
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        const secret = randomBytes(32).toString('hex');
        sessions.set(sha(secret), now + SESSION_MS);
        res.setHeader('Set-Cookie', `sp_admin=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${tls ? '; Secure' : ''}`);
        return reply(res, 200, { ok: true });
      }
      if (pathname === '/api/state') {
        if (!authorized) return failed(res, 401, '请先登录');
        if (req.method !== 'GET') return failed(res, 405, '方法不支持');
        let json;
        if (stateSource) {
          try { json = await stateSource.state(); }
          catch (error) { log?.error?.('[admin] 全局快照不可用', error.message); return failed(res, 503, '全局档案暂不可用'); }
        } else {
          if (stateCache.json === null || performance.now() >= stateCache.expiresAt) {
            stateCache.json = JSON.stringify(adminSnapshot({ lobby, registry, players }));
            stateCache.expiresAt = performance.now() + SNAPSHOT_CACHE_MS;
          }
          json = stateCache.json;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(json);
        return;
      }
      if (pathname === '/api/announcement' || pathname === '/api/kick' || pathname === '/api/kick/status') {
        if (!authorized) return failed(res, 401, '请先登录');
        const announcement = pathname === '/api/announcement';
        if (req.method !== 'POST' && !(announcement && req.method === 'GET')) return failed(res, 405, '方法不支持');
        if (req.method === 'POST' && !sameOrigin()) return failed(res, 403, '请求来源无效');
        if (!controls) return failed(res, 503, '管理操作暂不可用');
        if (req.method === 'GET') {
          try { return reply(res, 200, { announcement: await controls.getAnnouncement() }); }
          catch (error) { log?.error?.('[admin] 读取公告失败', error.message); return failed(res, 503, '公告暂不可用'); }
        }
        let body;
        try {
          body = await readBody();
          if (announcement) body = validateAnnouncement(body);
          else body = validateKick(body);
        } catch { return failed(res, 400, '操作参数无效'); }
        try {
          if (announcement) return reply(res, 200, { ok: true, announcement: await controls.publishAnnouncement(body) });
          const result = await (pathname === '/api/kick/status' ? controls.kickStatus(body) : controls.kick(body));
          if (result.error) return failed(res, result.code || 503, result.error);
          return reply(res, 200, result);
        } catch (error) {
          log?.error?.('[admin] 管理操作失败', error.message);
          return failed(res, 503, '操作暂不可用，请稍后重试');
        }
      }
      if (files[pathname]) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return failed(res, 405, '方法不支持');
        const [file, type] = files[pathname];
        const data = readFileSync(path.join(FRONT, file));
        res.writeHead(200, { 'Content-Type': type });
        res.end(req.method === 'HEAD' ? undefined : data); return;
      }
      return failed(res, 404, '未找到');
    };
    action().catch((error) => { log?.error?.('[admin] request failed', error.message); if (!res.headersSent) failed(res, 400, '请求无效'); else res.destroy(); });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  return { server, port: address.port, close: () => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections?.();
  }) };
}
