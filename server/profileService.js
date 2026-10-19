import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRegionAuthority, LEASE_MS, HEARTBEAT_MS, SERVER_NAMES, loadLevel, validateHeartbeat, createSpectatorCache, directoryHash, directoryReferenceUseful } from './regions.js';
import { adminRuntime, adminSnapshot, createAdminStateSource } from './admin.js';
import { validateKick } from './regions.js';
import { createAnnouncementStore, validateAnnouncement } from './announcement.js';
import { sanitizeName, terminateSocket, sendSession } from './net.js';
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ProfileReplication } from './profileReplication.js';
import { createRecruitmentCache } from './recruitmentDirectory.js';

export const PROFILE_RPC_MAX_BYTES = 8 * 1024 * 1024;

const RPC_PATH = '/api/profile-service';
const MAX_BYTES = PROFILE_RPC_MAX_BYTES;
const aidOK = (v) => typeof v === 'string' && /^[0-9a-f]{8,64}$/.test(v);
const matchOK = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const playerOK = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const digest = (v) => createHash('sha256').update(v).digest();

export function cardSkinForPresentation(card, presentation, data) {
  if (!card) return '';
  const records = Array.isArray(data?.chess) ? data.chess : Object.values(data?.chess || {});
  const record = records.find((entry) => entry?.charId === card && !entry.isGolden && !entry.isDiy);
  const key = record?.baseId || record?.chessId || `char:${card}`;
  const portraits = presentation?.portraits || {};
  const skins = presentation?.skins || {};
  const art = portraits[key] || portraits[`char:${card}`];
  if (art === 'original' || art === 'e2') return art;
  const skin = art || skins[key] || skins[`char:${card}`];
  const skinData = data?.assets?.chars?.[card]?.skins?.[skin];
  if (art && data?.assets?.chars?.[card]?.skins?.[art]?.portrait) return art;
  return typeof skin === 'string' && skinData?.spine?.front ? skin : '';
}

function publicLeaderboard(ranked, players, data) {
  return ranked.leaderboard({ includeAid: true }).map((item) => {
    const player = players.profiles.get(item.aid);
    const presentation = player?.presentation?.value;
    const card = presentation?.card;
    const { aid: _aid, ...publicItem } = item;
    if (typeof card !== 'string' || !card) return publicItem;
    const cardSkin = cardSkinForPresentation(card, presentation, data);
    return { ...publicItem, card, ...(cardSkin ? { cardSkin } : {}) };
  });
}

/** Negotiated directory references are local to an authority epoch. A bounded set of
 * immutable bodies handles concurrent heartbeat/replication/report responses; sequence
 * order prevents a delayed full response from rolling the visible directory backwards. */
export function createDirectoryTransport(spectatorCache, recruitmentCache) {
  const caches = { spectators: spectatorCache, recruitment: recruitmentCache };
  const bases = new Map(), retired = new Set();
  let epoch = null, sequence = 0, compact = false, latestStarted = -Infinity;
  let versions = { spectators: {}, recruitment: {} };
  const clearVersions = () => { versions = { spectators: {}, recruitment: {} }; compact = false; };
  return {
    request() {
      const known = { epoch, spectators: { ...versions.spectators }, recruitment: { ...versions.recruitment } };
      return Object.keys(known.spectators).length || Object.keys(known.recruitment).length
        ? { directoryDelta: 1, directoryVersions: known } : {};
    },
    report(serverId, items) {
      const report = { epoch }, payload = {};
      for (const [kind, field] of [['spectators', 'spectatorItems'], ['recruitment', 'recruitmentItems']]) {
        const value = items[kind], hash = directoryHash(value);
        if (compact && versions[kind][serverId] === hash && directoryReferenceUseful(value)) report[kind] = hash;
        else payload[field] = value;
      }
      if (Object.keys(report).length > 1) payload.directoryReport = report;
      return payload;
    },
    receive(value, started) {
      if (typeof value.epoch !== 'string' || retired.has(value.epoch)) return false;
      const negotiated = value.directoryDelta === 1;
      if (negotiated && (!Number.isSafeInteger(value.directorySequence) || value.directorySequence < 1)) throw new Error('目录响应序号无效');
      if (epoch !== value.epoch) {
        if (started < latestStarted) return false;
        if (epoch !== null) retired.add(epoch);
        // Keep prior epochs retired for the lifetime of this bridge, so a late old
        // response cannot revive stale directories after an authority restart.
        epoch = value.epoch; sequence = 0; bases.clear(); clearVersions();
        for (const cache of Object.values(caches)) cache.update({}, started);
      }
      if (negotiated && value.directorySequence <= sequence) return false;
      if (!negotiated && started < latestStarted) return false;
      const decoded = {}, nextVersions = {}, additions = [];
      try {
        for (const [kind, cache] of Object.entries(caches)) {
          if (value[kind] === undefined && !negotiated && kind === 'recruitment') continue; // rolling old main
          const samples = value[kind];
          if (!samples || typeof samples !== 'object' || Array.isArray(samples)) throw new Error('目录响应无效');
          decoded[kind] = {}; nextVersions[kind] = {};
          for (const [id, sample] of Object.entries(samples)) {
            if (!Object.hasOwn(SERVER_NAMES, id) || !sample || typeof sample !== 'object') throw new Error('目录来源无效');
            let items, hash;
            if (Object.hasOwn(sample, 'items')) {
              items = sample.items;
              if (items !== null) {
                hash = directoryHash(items);
                additions.push([`${kind}:${id}:${hash}`, items]);
              }
            } else {
              if (!negotiated || typeof sample.version !== 'string' || !/^[0-9a-f]{64}$/.test(sample.version)) throw new Error('目录引用无效');
              hash = sample.version; items = bases.get(`${kind}:${id}:${hash}`);
              if (!items) throw new Error('目录引用缺少基准');
            }
            decoded[kind][id] = { ageMs: sample.ageMs, items };
            if (hash && directoryReferenceUseful(items)) nextVersions[kind][id] = hash;
          }
          // Existing validators retain the source fields, size bounds and TTL rules.
          cache.update(decoded[kind], started);
        }
      } catch (error) { clearVersions(); throw error; }
      for (const [key, items] of additions) bases.set(key, structuredClone(items));
      while (bases.size > 32) bases.delete(bases.keys().next().value);
      versions = { ...versions, ...nextVersions }; compact = negotiated;
      if (negotiated) sequence = value.directorySequence;
      latestStarted = Math.max(latestStarted, started);
      return true;
    },
  };
}

function configuredUrl(value, key) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} 必须是无凭据的 HTTP/HTTPS 地址`);
  }
  return url.href.replace(/\/$/, '');
}

export function profileConfig(env = process.env) {
  const role = env.SP_SERVER_ROLE || 'main';
  if (!['main', 'secondary'].includes(role)) throw new Error('SP_SERVER_ROLE 必须是 main 或 secondary');
  const id = env.SP_SERVER_ID || role;
  if (id !== role) throw new Error('SP_SERVER_ID 必须与 SP_SERVER_ROLE 相同');
  const secret = env.SP_PROFILE_SERVICE_SECRET || '';
  if (/[\r\n]/.test(secret)) throw new Error('SP_PROFILE_SERVICE_SECRET 不能包含换行');
  const serviceUrl = configuredUrl(env.SP_PROFILE_SERVICE_URL, 'SP_PROFILE_SERVICE_URL');
  const mainUrl = configuredUrl(env.SP_MAIN_PUBLIC_URL, 'SP_MAIN_PUBLIC_URL');
  const secondaryUrl = configuredUrl(env.SP_SECONDARY_PUBLIC_URL || 'http://120.24.21.224:3000', 'SP_SECONDARY_PUBLIC_URL');
  if (role === 'secondary' && (!secret.trim() || !serviceUrl || !mainUrl)) {
    throw new Error('附服必须配置 SP_PROFILE_SERVICE_SECRET、SP_PROFILE_SERVICE_URL 和 SP_MAIN_PUBLIC_URL');
  }
  if (secret && !secret.trim()) throw new Error('SP_PROFILE_SERVICE_SECRET 不能只包含空白');
  return { role, id, secret, serviceUrl, mainUrl, secondaryUrl };
}

// 列表负载统计整机出口 TX（HTTP、WebSocket 及其他进程），不改变 WebSocket 发送预算。
// 只读默认出口网卡，避免回环/虚拟接口重复计数；采样不可用时明确返回未知。
function createHostLoadSampler() {
  let previous = null, rate = null;
  return (bandwidthMbps) => {
    const at = performance.now();
    if (previous && at - previous.at < 1000) return { bandwidthMbps, bytesPerSecond: rate };
    try {
      if (process.platform !== 'linux') throw new Error('Host TX counters unavailable');
      const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((row) => row[1] === '00000000' && row[7] === '00000000'
          && (parseInt(row[3], 16) & 1) && row[0] !== 'lo' && /^[A-Za-z0-9_.-]+$/.test(row[0])
          && Number.isFinite(Number(row[6])))
        .sort((a, b) => Number(a[6]) - Number(b[6]));
      const iface = routes[0]?.[0];
      if (!iface) throw new Error('Default egress interface unavailable');
      const bytes = BigInt(readFileSync(`/sys/class/net/${iface}/statistics/tx_bytes`, 'utf8').trim());
      rate = null;
      if (previous && previous.iface === iface && bytes >= previous.bytes && at > previous.at) {
        const delta = Number(bytes - previous.bytes);
        const sampled = delta * 1000 / (at - previous.at);
        if (Number.isSafeInteger(delta) && Number.isFinite(sampled) && sampled <= Number.MAX_SAFE_INTEGER) rate = sampled;
      }
      previous = { iface, bytes, at };
    } catch {
      previous = null;
      rate = null;
    }
    return { bandwidthMbps, bytesPerSecond: rate };
  };
}

export function serverDirectory(config, states = {}) {
  return { current: config.id, servers: ['main', 'secondary'].map((id) => ({
    id, name: SERVER_NAMES[id], url: id === 'main' ? config.mainUrl || '/' : config.secondaryUrl,
    bandwidthMbps: states[id]?.bandwidthMbps || (id === 'main' ? 5 : 3),
    load: loadLevel(states[id]),
  })) };
}

function validate(op, args) {
  if (!Array.isArray(args)) throw new Error('档案请求参数无效');
  if (op === 'profile.bootstrap') {
    if (args.length !== 1 || !args[0] || typeof args[0] !== 'object') throw new Error('全量复制参数无效');
    return;
  }
  if (op === 'admin.announcement.publish' || op === 'admin.kick' || op === 'admin.kick.status') {
    if (args.length !== 1) throw new Error('管理操作参数无效');
    if (op === 'admin.announcement.publish') validateAnnouncement(args[0]);
    else validateKick(args[0]);
    return;
  }
  if (op === 'admin.state' || op === 'admin.announcement.get') {
    if (args.length !== 0) throw new Error('管理快照参数无效');
    return;
  }
  if (op === 'region.heartbeat') {
    if (args.length !== 1) throw new Error('心跳参数无效');
    validateHeartbeat(args[0]);
    return;
  }
  if (['login', 'lease.release', 'region.heartbeat', 'chat.publish', 'chat.history'].includes(op)) {
    if (op !== 'chat.history' && (!args[0] || typeof args[0] !== 'object')) throw new Error('共享服务参数无效');
    return;
  }
  if (op === 'leaderboard') return;
  if (op === 'complete') {
    const job = args[0];
    if (!job || !matchOK(job.match?.matchId) || !Array.isArray(job.seats) || !Array.isArray(job.entries)
      || job.seats.length > 256 || job.entries.length > 256 || !Array.isArray(job.result?.players)) throw new Error('结算请求无效');
    for (const seat of job.seats) if (!seat.isBot && (!aidOK(seat.aid) || !playerOK(seat.playerId)
      || !job.result.players.some((p) => p?.playerId === seat.playerId))) throw new Error('历史玩家无效');
    const seen = new Set();
    for (const entry of job.entries) {
      if (!aidOK(entry.who?.aid) || !playerOK(entry.who?.playerId) || seen.has(entry.who.playerId)
        || !job.seats.some((s) => !s.isBot && s.aid === entry.who.aid && s.playerId === entry.who.playerId)) throw new Error('结算身份无效');
      seen.add(entry.who.playerId);
      if (!entry.row || Object.values(entry.row).some((v) => typeof v === 'number' && !Number.isFinite(v))) throw new Error('结算数据无效');
    }
    if (job.ranked && job.seats.some((s) => !s.isBot && !seen.has(s.playerId))) throw new Error('排位结算缺少玩家');
    return;
  }
  if (op === 'historyRecord') {
    if (!matchOK(args[0]?.matchId) || !Array.isArray(args[0]?.seats) || !Array.isArray(args[0]?.summary?.players)) throw new Error('历史请求无效');
    return;
  }
  if (!['read', 'record', 'loadout', 'presentation', 'historyList', 'historyDetail'].includes(op) || !aidOK(args[0])) throw new Error('档案操作无效');
  if (op === 'historyDetail' && !matchOK(args[1])) throw new Error('历史编号无效');
  if (op === 'record' && (typeof args[1] !== 'string' || args[1].length > 64)) throw new Error('名字无效');
}

export function createAuthority({ players, ranked, history }, options = {}) {
  const sharedWrites = options.sharedWrites !== false;
  let serial = Promise.resolve();
  const regions = createRegionAuthority(options);
  const snapshot = (aid) => {
    const profile = ranked.profile(aid);
    const rank = profile ? { ...profile } : null;
    if (rank) delete rank.settlements;
    const player = players.profiles.get(aid) || null;
    return { player, rank, summary: ranked.summary(aid, player?.name || ''),
      authorizedSummary: ranked.summary(aid, player?.name || '', true) };
  };
  async function execute(op, args, replay = false) {
    validate(op, args);
    if (op === 'login') {
      const lease = regions.current(args[0]);
      if (!lease) return { error: 'BAD_TARGET', detail: '连接租约已失效，请重连' };
      const aid = lease.aid || (aidOK(args[0].fixedAid) ? args[0].fixedAid
        : players.resolveName(lease.name, args[0].requestedAid, { ranked, history }));
      lease.aid = aid;
      if (authority.replication && !sharedWrites) {
        if (authority.canGrant && !authority.canGrant(aid, lease.serverId)) {
          regions.release(args[0]);
          return { error: 'BAD_TARGET', detail: '本服对局档案仍在写入，请稍后切服' };
        }
        const grant = await authority.replication.grant(aid, lease, regions);
        if (!grant) {
          regions.release(args[0]);
          return { error: 'BAD_TARGET', detail: '华南档案尚未同步交接，请稍后重连' };
        }
        await authority.replication.transact('record', [aid, lease.name, args[0]], { coordinator: true });
      } else if (authority.replication) {
        await authority.replication.transact('record', [aid, lease.name, args[0]]);
      } else {
        players.record(aid, lease.name);
        await players.flush();
      }
      if (!regions.current(args[0])) return { error: 'BAD_TARGET', detail: '连接租约已失效，请重连' };
      return structuredClone({ aid, lease: { owner: lease.owner, generation: lease.generation,
        serverId: lease.serverId, epoch: lease.epoch }, ...snapshot(aid),
        ...(authority.replication && !sharedWrites ? { grant: { aid, token: authority.replication.state.owners[aid].token,
          versions: authority.replication.state.versions[aid] || {} } } : {}) });
    }
    if (!options.local && !replay && ['record', 'loadout', 'presentation'].includes(op)) {
      const lease = regions.current(args.at(-1));
      if (!lease || lease.aid !== args[0]) throw new Error('档案写入租约无效');
    }
    if (op === 'read') {
      await players.flush();
      await ranked.flush();
      return structuredClone(snapshot(args[0]));
    }
    if (op === 'leaderboard') {
      await ranked.flush();
      return publicLeaderboard(ranked, players, options.getData?.() || null);
    }
    if (op === 'historyList') { await history.flush(); return history.list(args[0]); }
    if (op === 'historyDetail') { await history.flush(); return history.detail(...args); }
    if (op === 'record') players.record(...args);
    if (op === 'loadout') players.setLoadout(...args);
    if (op === 'presentation') {
      // 两服同时初始化默认外观时，保留先持久化的一份。
      if (!args[2] || !players.getPresentation(args[0])?.extraSkinDefaultsInitialized) players.setPresentation(args[0], args[1]);
    }
    if (['record', 'loadout', 'presentation'].includes(op)) {
      await players.flush();
      return structuredClone(snapshot(args[0]));
    }
    if (op === 'historyRecord') {
      if (history.record(args[0]) === false) throw new Error('历史结果无效或超过现有存储上限');
      await history.flush();
      return null;
    }
    const job = args[0];
    const result = structuredClone(job.result);
    if (job.ranked) for (const entry of job.entries) {
      const row = result.players.find((p) => p.playerId === entry.who.playerId);
      if (!row) throw new Error('结算结果缺少玩家');
      const existing = ranked.profile(entry.who.aid)?.settlements?.[`${job.match.matchId}:${entry.who.playerId}`];
      row.rank = existing ? structuredClone(existing) : ranked.settleMatch(entry.who, job.match, entry.row);
    }
    // 已有 settlements 幂等键在落盘后才回执；历史失败可重复执行整个请求。
    await ranked.flush();
    const { t, ...summary } = result;
    if (history.record({ matchId: job.match.matchId, at: job.at, seats: job.seats, ranked: job.ranked, summary }) === false) {
      throw new Error('历史结果无效或超过现有存储上限');
    }
    await history.flush();
    return structuredClone({ result, profiles: [...new Set(job.seats.filter((s) => !s.isBot && aidOK(s.aid)).map((s) => s.aid))]
      .map((aid) => ({ aid, ...snapshot(aid) })) });
  }
  const authority = { regions, adminStateSource: null, replication: null,
    executeLocal: execute, snapshot,
    call(op, args) {
    validate(op, args);
    if (['admin.announcement.get', 'admin.announcement.publish', 'admin.kick', 'admin.kick.status'].includes(op)) {
      if (!authority.adminControls) return Promise.reject(new Error('管理操作尚未就绪'));
      if (op === 'admin.announcement.get') return authority.adminControls.getAnnouncement();
      if (op === 'admin.announcement.publish') return authority.adminControls.publishAnnouncement(args[0]);
      if (op === 'admin.kick.status') return authority.adminControls.kickStatus(args[0]);
      return authority.adminControls.kick(args[0]);
    }
    if (op === 'admin.state') {
      if (!authority.adminStateSource) return Promise.reject(new Error('管理快照尚未就绪'));
      return authority.adminStateSource.state();
    }
    if (op === 'lease.release') return Promise.resolve(regions.release(args[0]));
    if (op === 'profile.bootstrap') {
      if (!authority.replication) return Promise.reject(new Error('档案复制未启用'));
      return authority.replication.bootstrap(args[0]);
    }
    if (op === 'region.heartbeat') {
      const value = regions.heartbeat(args[0]);
      const announcement = authority.announcementProvider?.();
      const withAnnouncement = announcement && (announcement.updatedAt === 0 || args[0].announcementVersion !== announcement.updatedAt)
        ? { ...value, announcement } : value;
      if (!args[0].replication) return Promise.resolve(withAnnouncement);
      if (args[0].serverId !== 'secondary' || !authority.replication) return Promise.reject(new Error('档案复制未启用'));
      return authority.replication.exchange(args[0].replication, regions)
        .then((replication) => ({ ...withAnnouncement, replication }));
    }
    if (op === 'chat.history') return Promise.resolve(regions.chatHistory(...args));
    if (op === 'chat.publish') return Promise.resolve(regions.publish(args[0]));
    if (op === 'login') {
      const lease = regions.claim(args[0]);
      if (lease.error) return Promise.resolve(lease);
      args = [{ ...args[0], epoch: lease.epoch }];
    }
    const next = serial.then(() => {
      if (authority.replication && ['record', 'loadout', 'presentation', 'complete', 'historyRecord'].includes(op)) {
        if (['record', 'loadout', 'presentation'].includes(op)) {
          const lease = regions.current(args.at(-1));
          if (!lease || lease.aid !== args[0] || (!sharedWrites && lease.serverId !== 'main')) throw new Error('档案写入租约无效');
        }
        return authority.replication.transact(op, args);
      }
      return execute(op, args);
    });
    serial = next.catch(() => {});
    return next;
  } };
  return authority;
}

export function remoteCall(config, op, args) {
  const url = new URL(config.serviceUrl);
  url.pathname = url.pathname.replace(/\/$/, '') + RPC_PATH;
  const raw = Buffer.from(JSON.stringify({ op, args }));
  if (raw.length > MAX_BYTES) return Promise.reject(new Error('档案请求过大'));
  const body = gzipSync(raw);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length,
        'Content-Encoding': 'gzip', 'Accept-Encoding': 'gzip',
        Authorization: `Bearer ${config.secret}` },
    }, (res) => {
      const chunks = []; let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { res.destroy(new Error('档案响应过大')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(Object.assign(new Error(`主服档案接口返回 ${res.statusCode}`), { statusCode: res.statusCode })); return; }
        try {
          const packed = Buffer.concat(chunks);
          const data = res.headers['content-encoding'] === 'gzip' ? gunzipSync(packed, { maxOutputLength: MAX_BYTES }) : packed;
          resolve(JSON.parse(data.toString('utf8')).value);
        } catch { reject(new Error('主服档案响应无效或解压超过上限')); }
      });
    });
    const timeout = setTimeout(() => req.destroy(new Error('主服共享请求超时')),
      ['login', 'lease.release', 'region.heartbeat', 'chat.publish', 'chat.history', 'admin.state'].includes(op) ? 2500 : 10_000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', reject);
    req.end(body);
  });
}

export function profileRpcHandler(config, authority, log) {
  return async (req, res) => {
    const reply = (status, value) => {
      const data = Buffer.from(JSON.stringify(value));
      if (data.length > MAX_BYTES) { status = 413; value = { error: '档案响应过大' }; }
      const compressed = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const body = data.length > MAX_BYTES ? Buffer.from(JSON.stringify(value)) : data;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) });
      res.end(compressed ? gzipSync(body) : body);
    };
    if (config.role !== 'main' || !config.secret) { reply(404, { error: '档案接口未启用' }); return; }
    if (req.method !== 'POST') { reply(405, { error: '仅支持 POST' }); return; }
    const supplied = req.headers.authorization || '';
    if (!timingSafeEqual(digest(supplied), digest(`Bearer ${config.secret}`))) { reply(401, { error: '档案鉴权失败' }); return; }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { reply(413, { error: '档案请求过大' }); return; }
        chunks.push(chunk);
      }
      let body, raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'gzip') { reply(415, { error: '档案压缩格式无效' }); return; }
      if (req.headers['content-encoding'] === 'gzip') {
        try { raw = gunzipSync(raw, { maxOutputLength: MAX_BYTES }); }
        catch (error) { reply(error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, { error: '档案解压失败或超过上限' }); return; }
      }
      try { body = JSON.parse(raw.toString('utf8')); validate(body.op, body.args); }
      catch { reply(400, { error: '档案请求无效' }); return; }
      const value = await authority.call(body.op, body.args);
      reply(200, { value });
    } catch (error) {
      log.error('[profiles] 主服档案处理失败', error);
      if (!res.headersSent) reply(503, { error: '档案暂不可用' });
    }
  };
}

class PendingResults {
  constructor(file, call, receive, log) {
    this.file = file; this.call = call; this.receive = receive; this.log = log;
    this.jobs = new Map(); this.waiters = new Map(); this.running = false; this.closed = false;
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('待办格式无效');
      for (const job of data.jobs) {
        if (!['complete', 'historyRecord'].includes(job.op) || typeof job.id !== 'string') throw new Error('待办操作无效');
        validate(job.op, job.args); this.jobs.set(job.id, job);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`不能读取结算待办：${error.message}`); }
  }
  save() {
    if (!this.file) return;
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }), { mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.file);
  }
  submit(op, args) {
    validate(op, args);
    const matchId = op === 'complete' ? args[0].match.matchId : args[0].matchId;
    const id = `${op}:${matchId}`;
    if (!this.jobs.has(id)) {
      this.jobs.set(id, { id, op, args: structuredClone(args) });
      try { this.save(); } catch (error) { this.jobs.delete(id); throw error; }
    }
    const promise = new Promise((resolve) => {
      const waiting = this.waiters.get(id) || []; waiting.push(resolve); this.waiters.set(id, waiting);
    });
    void this.drain();
    return promise;
  }
  start() { void this.drain(); }
  async drain() {
    if (this.running) { await this.finished; return; }
    if (this.closed) return;
    clearTimeout(this.timer);
    this.running = true;
    let finish;
    this.finished = new Promise((resolve) => { finish = resolve; });
    try {
      for (const [id, job] of this.jobs) {
        if (this.closed) break;
        try {
          const value = await this.call(job.op, job.args);
          this.jobs.delete(id);
          try { this.save(); } catch (error) { this.jobs.set(id, job); throw error; }
          try { this.receive(job, value); } catch (error) { this.log.error('[profiles] 持久化完成后的通知失败', error); }
          for (const resolve of this.waiters.get(id) || []) resolve(value);
          this.waiters.delete(id);
        } catch (error) {
          this.log.error(`[profiles] 待办 ${id} 保留并将在 5 秒后重试`, error);
          break;
        }
      }
    } finally {
      this.running = false;
      finish();
      if (this.jobs.size && !this.closed) {
        this.timer = setTimeout(() => this.drain(), 5000); this.timer.unref?.();
      }
    }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}

export function createProfileAccess(config, stores, log) {
  if (!['players', 'ranked', 'history'].every((name) => stores[name]?.profiles instanceof Map && stores[name]?.writer)) {
    throw new Error('两服均必须提供完整 players/ranked/history stores');
  }
  const authority = config.role === 'main' ? createAuthority(stores, { startupGuard: !!config.secret, getData: config.getData }) : null;
  const local = authority || createAuthority(stores, { local: true, getData: config.getData });
  const announcementStore = createAnnouncementStore({
    file: authority ? config.announcementFile : null,
    initialFile: config.announcementInitialFile,
  });
  if (authority) authority.announcementProvider = () => announcementStore.read();
  const dataDir = config.dataDir || dirname(stores.players.file || fileURLToPath(import.meta.url));
  const inMemory = !config.dataDir && ['players', 'ranked', 'history'].every((name) => !stores[name].file);
  const replication = new ProfileReplication({ role: config.role, stores,
    file: config.replicationFile !== undefined ? config.replicationFile : inMemory ? null : join(dataDir, `profile-replication-${config.id}.json`),
    bootstrapFromCopiedStores: config.bootstrapFromCopiedStores === true,
    execute: (op, args) => local.executeLocal(op, args, true) });
  if (authority) authority.replication = replication;
  const instance = randomUUID();
  const sessions = new Set();
  const logins = new Set();
  const stateCache = {};
  const spectatorCache = createSpectatorCache(config.id);
  const recruitmentCache = createRecruitmentCache(config.id);
  const directoryTransport = createDirectoryTransport(spectatorCache, recruitmentCache);
  let legacyHeartbeat = false, legacyChat = false;
  let network = null, runtimeSource = null, lobbySource = null, chatSink = null, chatItems = [], chatInitialized = false, closed = false;
  const kickExecutions = new Map();
  let adminRegistry = null;
  const consumeChat = (items) => {
    const seen = new Set(chatItems.map((item) => item.id));
    // 游标推进由串行 chatChain 保证，50 条展示历史不截断轮询增量。
    const fresh = items.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
    chatItems = [...chatItems, ...fresh].slice(-50);
    if (chatInitialized) for (const item of fresh) chatSink?.(item);
    chatInitialized = true;
  };
  const stopSession = (session) => {
    session.profileReady = false;
    session.loginRevoked = true;
    clearTimeout(session.leaseTimer);
    if (session.ws) terminateSocket(session.ws, 'login_lease_lost');
  };
  const arm = (session, started) => {
    session.leaseUntil = started + LEASE_MS - 1000;
    clearTimeout(session.leaseTimer);
    session.leaseTimer = setTimeout(() => stopSession(session), Math.max(0, session.leaseUntil - performance.now()));
    session.leaseTimer.unref?.();
  };
  const call = authority ? (op, args) => authority.call(op, args) : (op, args) => remoteCall(config, op, args);
  const signatures = new Map();
  const { players, ranked } = stores;
  // 共享档案的修改在权威顺序执行；附服只复制结果，不再用旧快照独立结算。
  const localCall = async (op, args) => {
    const value = await call(op, args);
    if (!authority) await sync();
    return value;
  };
  const pending = new PendingResults(config.pendingFile !== undefined ? config.pendingFile : inMemory ? null
    : join(config.dataDir || dirname(fileURLToPath(import.meta.url)), `profile-pending-${config.id}.json`), localCall,
    (job, value) => { access.onRecovered?.(job, value); }, log);
  const sampleHostLoad = createHostLoadSampler();
  const hostLoad = () => sampleHostLoad(network?.opts?.bandwidthMbps || (config.id === 'main' ? 5 : 3));
  // 登录、续租和档案复制只携带核心字段；可选展示快照另行上报。
  // 滚动更新时旧主服可拒绝新管理字段，但不能连带拒绝玩家身份和档案同步。
  const heartbeatPayload = (report = false) => ({ serverId: config.id,
    leases: report ? [] : [...sessions].filter((s) => access.validSession(s) && !s.loginInFlight).map((s) => s.loginLease),
    sample: hostLoad(),
    ...(!legacyHeartbeat ? {
      ...(announcementStore.read().updatedAt > 0 ? { announcementVersion: announcementStore.read().updatedAt } : {}),
      ...directoryTransport.request(),
    } : {}),
    ...(report ? {
      ...(runtimeSource ? { runtime: runtimeSource() } : {}),
      ...(!legacyHeartbeat ? directoryTransport.report(config.id, {
        spectators: lobbySource?.spectatorItems() || [], recruitment: lobbySource?.recruitmentItems() || [],
      }) : { spectatorItems: lobbySource?.spectatorItems() || [], recruitmentItems: lobbySource?.recruitmentItems() || [] }),
    } : {}) });
  const callHeartbeat = async (payload) => {
    if (legacyHeartbeat) {
      const { directoryDelta, directoryVersions, directoryReport, announcementVersion, ...legacy } = payload;
      void directoryDelta; void directoryVersions; void announcementVersion;
      if (directoryReport) {
        legacy.spectatorItems = lobbySource?.spectatorItems() || [];
        legacy.recruitmentItems = lobbySource?.recruitmentItems() || [];
      }
      return call('region.heartbeat', [legacy]);
    }
    try { return await call('region.heartbeat', [payload]); }
    catch (error) {
      // Strict older main versions may reject unknown optional fields with 400.
      // Retry the original core payload immediately; never downgrade on auth or I/O errors.
      if (error.statusCode !== 400 || !(payload.directoryDelta === 1 || Object.hasOwn(payload, 'announcementVersion'))) throw error;
      legacyHeartbeat = true;
      return callHeartbeat(payload);
    }
  };
  const notifyAnnouncement = (announcement) => {
    const frame = { t: 'announcement.updated', announcement };
    for (const session of adminRegistry?.all?.() || []) if (session.connected) sendSession(session, frame);
  };
  if (authority) authority.adminControls = {
    getAnnouncement: async () => announcementStore.read(),
    publishAnnouncement: async (value) => {
      const result = announcementStore.publish(value);
      notifyAnnouncement(result);
      return result;
    },
    kick: async (value) => {
      validateKick(value);
      if (value.serverId !== config.id) return authority.regions.kick(value);
      const disconnected = await network?.adminKick?.(value.targetId);
      authority.regions.heartbeat(heartbeatPayload(true));
      authority.adminStateSource?.invalidate();
      return disconnected ? { ok: true, status: 'kicked' } : { error: '目标连接已离线', code: 409 };
    },
    kickStatus: async (value) => authority.regions.kickStatus(value),
  };
  const adminControls = {
    getAnnouncement: () => call('admin.announcement.get', []),
    publishAnnouncement: (value) => call('admin.announcement.publish', [value]),
    kick: (value) => call('admin.kick', [value]),
    kickStatus: (value) => call('admin.kick.status', [value]),
  };
  const activeAids = () => {
    const active = new Set([...sessions].filter((s) => access.validSession(s)).map((s) => s.loginAid));
    // main 按名字解析出的 aid 可能不是 requestedAid；响应返回前也保护同名档案。
    for (const login of logins) {
      active.add(login.aid); active.add(login.session.loginAid);
      for (const [aid, player] of players.profiles) if (player.name === login.name) active.add(aid);
    }
    for (const job of pending.jobs.values()) for (const seat of job.args[0].seats || []) if (!seat.isBot) active.add(seat.aid);
    for (const room of lobbySource?.rooms?.values?.() || []) {
      if (room.matchCtx?.live && !room.matchCtx.ended) for (const seat of room.matchCtx.seats || []) if (!seat.isBot) active.add(seat.aid);
    }
    return active;
  };
  const consumeKicks = async (commands) => {
    if (!network || closed) return;
    for (const [id, row] of kickExecutions) if (row.until < Date.now()) kickExecutions.delete(id);
    const results = await Promise.all(commands.filter((command) => command.expiresAt > Date.now()).map((command) => {
      let row = kickExecutions.get(command.targetId);
      if (!row) {
        row = { until: Date.now() + 2 * LEASE_MS,
          promise: network.adminKick(command.targetId).then((ok) => ({ targetId: command.targetId, status: ok ? 'kicked' : 'gone' })) };
        kickExecutions.set(command.targetId, row);
      }
      return row.promise;
    }));
    if (results.length && !closed) await callHeartbeat({ ...heartbeatPayload(), kickResults: results });
  };
  const exchangeHeartbeat = async (payload) => {
    const started = performance.now();
    const value = await callHeartbeat(payload);
    if (!closed) {
      // Optional directory recovery must not fail login renewal or profile replication.
      // A missing reference clears advertised bases, so the next exchange gets full data.
      try { directoryTransport.receive(value, started); }
      catch (error) { log.error('[profiles] 目录快照暂不可用，将重取完整目录', error.message); }
      lobbySource?.broadcastRecruitment();
      for (const [id, sample] of Object.entries(value.states)) stateCache[id] = { ...sample, at: started - sample.ageMs };
      if (value.announcement && !authority) {
        const before = announcementStore.read();
        const updated = announcementStore.apply(value.announcement);
        if (updated.updatedAt > before.updatedAt) notifyAnnouncement(updated);
      }
      // 管理操作不阻塞登录续租；同一命令复用执行结果，回执丢失可随下一次心跳重传。
      if (value.kickCommands?.length) void consumeKicks(value.kickCommands).catch((error) => log.error('[admin] 踢线回执暂不可用', error.message));
    }
    return value;
  };
  const reportRuntime = async () => {
    try { await exchangeHeartbeat(heartbeatPayload(true)); }
    catch (error) { log.error('[profiles] 运行快照上报失败，不影响登录和档案同步', error); }
  };
  const sync = async (drain = true) => {
    // 每一批真正发送时重取身份，不能用进入复制队列前的旧租约续命。
    const exchange = (request) => exchangeHeartbeat({ ...heartbeatPayload(),
      ...(request ? { replication: { ...request, sharedWrites: true } } : {}) });
    if (authority) { await replication.run(() => {}); return exchange(); }
    if (!replication.initialized) await replication.initialize((request) => call('profile.bootstrap', [request]));
    return replication.sync(exchange, drain, new Set());
  };
  const access = {
    players, ranked, authority, replication, adminControls, announcement: () => announcementStore.read(), onRecovered: null,
    get initialized() { return replication.initialized; },
    async ready() {
      await sync(); await pending.drain();
      if (pending.jobs.size) throw new Error('本服结算待办正在恢复，暂不开放登录');
      if (!authority) await sync();
      return access;
    },
    async flushReplication() { const value = await sync(); await reportRuntime(); return value; },
    bindAdmin(lobby, registry) {
      lobbySource = lobby;
      adminRegistry = registry;
      runtimeSource = () => adminRuntime({ lobby, registry });
      if (authority) {
        authority.adminStateSource = createAdminStateSource({ snapshot: () => adminSnapshot({
          lobby, registry, players, runtimes: authority.regions.adminRuntimes(),
        }) });
        return authority.adminStateSource;
      }
      // 每次授权读取均联系 main；附服的档案展示缓存绝不是权威全局结果。
      return { state: () => call('admin.state', []) };
    },
    bindNetwork(value, sink) {
      network = value; chatSink = sink;
      if (authority) authority.regions.chat.memberSink = (frame) => {
        chatItems = authority.regions.chat.history(); chatInitialized = true; chatSink(frame);
      };
    },
    validSession(session) {
      return replication.initialized && !closed && !session.loginReleased && !session.loginRevoked && session.connected && !!session.loginLease
        && performance.now() < session.leaseUntil
        && (!authority || !!authority.regions.current(session.loginLease));
    },
    async login(session, name, requestedAid, socket, identityLocked = false) {
      if (!replication.initialized) return { error: 'BAD_TARGET', detail: '本服档案正在初始化，请稍后重连' };
      if (session.loginReleased || session.loginRevoked) return { error: 'BAD_TARGET', detail: '连接身份已撤销，请重连' };
      const generation = session.loginGeneration = (session.loginGeneration || 0) + 1;
      session.loginOwner ||= `${instance}:${randomUUID()}`;
      const key = { owner: session.loginOwner, generation, serverId: config.id, name, requestedAid,
        ...(identityLocked && session.profileBound ? { fixedAid: session.aid } : {}) };
      let started, data, timer, expired = false;
      const loginTimeoutMs = 7000;
      const deadline = performance.now() + loginTimeoutMs;
      const login = { session, aid: key.fixedAid || requestedAid, name: sanitizeName(name) };
      const check = () => {
        if (expired || performance.now() >= deadline || closed || !session.connected || session.ws !== socket
          || generation !== session.loginGeneration || session.loginReleased || session.loginRevoked) {
          throw new Error('连接已失效或登录等待超时，请重连');
        }
      };
      session.loginInFlight = generation;
      try {
        return await Promise.race([(async () => {
          await pending.drain(); check();
          if (pending.jobs.size) throw new Error('本服结算待办尚未恢复，拒绝旧档案登录');
          // 待办先完成，再用一次完整同步交接旧 grant。
          await sync(); check();
          logins.add(login);
          started = performance.now();
          data = await call('login', [key]); check();
          if (data.error) return data;
          login.aid = data.aid;
          if (!authority) {
            // 登录时 main 创建/更新 identity 后，再推进到 grant 的字段版本。
            await sync(); check();
            check();
          }
          if (performance.now() >= started + LEASE_MS - 1000) throw new Error('连接租约已失效，请重连');
          session.loginLease = data.lease;
          session.loginAid = data.aid;
          sessions.add(session); arm(session, started);
          return { aid: data.aid };
        })(), new Promise((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Error('登录等待超时，请重连')); }, loginTimeoutMs);
        })]);
      }
      catch (error) {
        void call('lease.release', [key]).catch(() => {});
        if (session.ws === socket && session.loginGeneration === generation) stopSession(session);
        throw error;
      } finally {
        clearTimeout(timer);
        logins.delete(login);
        if (session.loginInFlight === generation) session.loginInFlight = null;
      }
    },
    async releaseSession(session) {
      const key = session.loginLease;
      session.profileReady = false;
      session.loginReleased = true;
      clearTimeout(session.leaseTimer);
      sessions.delete(session);
      session.loginLease = null;
      if (key) {
        try { await call('lease.release', [key]); await sync(); }
        catch (error) { session.loginLease = key; throw error; }
      }
    },
    disconnect(session) {
      const key = session.loginOwner ? { owner: session.loginOwner,
        generation: session.loginGeneration, serverId: config.id } : session.loginLease;
      sessions.delete(session); clearTimeout(session.leaseTimer);
      session.loginLease = null;
      if (key) void call('lease.release', [key]).then(() => closed ? undefined : sync()).catch((error) => log.error('[profiles] 断线交接失败，保留同步待办', error));
    },
    async chatHistory() {
      const next = (access.chatChain || Promise.resolve()).catch(() => {}).then(async () => {
        // Old authorities ignore the fourth argument and still return history.
        const args = [config.id, access.chatCursor || 0, access.chatEpoch || null];
        let value;
        try { value = await call('chat.history', legacyChat ? args : [...args, 1]); }
        catch (error) {
          if (legacyChat || error.statusCode !== 400) throw error;
          legacyChat = true; value = await call('chat.history', args);
        }
        if (access.chatEpoch !== value.epoch) { chatInitialized = false; chatItems = []; }
        consumeChat(value.events?.length ? value.events : value.history || []);
        if (Array.isArray(value.history)) chatItems = value.history.slice(-50);
        access.chatCursor = value.cursor; access.chatEpoch = value.epoch;
        return chatItems.map((item) => ({ ...item }));
      });
      access.chatChain = next;
      return next;
    },
    async publishChat(session, value) {
      if (!access.validSession(session)) return { error: 'BAD_TARGET', detail: '连接租约已失效，请重连' };
      try { return await call('chat.publish', [{ ...session.loginLease, playerId: session.playerId, ...value }]); }
      catch { return { error: 'INTERNAL', detail: '公共聊天暂不可用，请重试' }; }
    },
    directory() {
      const states = authority ? authority.regions.states() : stateCache;
      return serverDirectory(config, states);
    },
    spectatorDirectory(localItems) {
      if (authority) spectatorCache.update(authority.regions.spectatorSnapshots());
      return spectatorCache.directory(localItems);
    },
    recruitmentDirectory(localItems) {
      if (authority) recruitmentCache.update(authority.regions.recruitmentSnapshots());
      const servers = serverDirectory(config).servers;
      return recruitmentCache.directory(localItems).map((item) => {
        const server = servers.find((entry) => entry.id === item.serverId);
        return { ...item, serverUrl: server?.url || '/', serverName: server?.name || item.serverId };
      }).sort((a, b) => b.invitedAt - a.invitedAt || a.serverId.localeCompare(b.serverId) || a.code.localeCompare(b.code));
    },
    async refresh(aid) {
      if (!aidOK(aid)) return false;
      const data = local.snapshot(aid);
      const signature = JSON.stringify([data.player?.loadout, data.player?.presentation, data.summary, data.authorizedSummary]);
      const changed = signatures.get(aid) !== signature;
      signatures.set(aid, signature);
      return changed;
    },
    async setLoadout(aid, value, session) {
      if (!access.validSession(session)) throw new Error('连接租约失效');
      if (session.aid !== aid) throw new Error('档案写入身份无效');
      await localCall('loadout', [aid, value, session.loginLease]);
    },
    async setPresentation(aid, value, initialize = false, session) {
      if (!access.validSession(session)) throw new Error('连接租约失效');
      if (session.aid !== aid) throw new Error('档案写入身份无效');
      await localCall('presentation', [aid, value, initialize, session.loginLease]);
    },
    leaderboard() {
      return Promise.resolve(publicLeaderboard(ranked, players, config.getData?.() || null));
    },
    history: {
      list(aid) { return Promise.resolve(stores.history.list(aid)); },
      detail(aid, matchId, playerId) { return Promise.resolve(stores.history.detail(aid, matchId, playerId)); },
      record(value) {
        if (!replication.initialized) return Promise.reject(new Error('档案尚未初始化'));
        return pending.submit('historyRecord', [value]);
      },
      flush() { return stores.history?.flush?.(); },
    },
    completeMatch(job) {
      if (!replication.initialized) return Promise.reject(new Error('档案尚未初始化'));
      return pending.submit('complete', [job]);
    },
    async drain() {
      // Failed remote writes remain in the existing durable queue; shutdown never waits for a retry timer.
      await pending.drain();
      await pending.finished;
      return pending.jobs.size === 0;
    },
    start(registry, changed) {
      if (access.heartbeatTimer) return;
      void access.ready().catch((error) => log.error('[profiles] 档案初始化失败，心跳将重试', error));
      let heartbeating = false, syncing = false, reporting = false, polling = false;
      const report = async () => {
        if (reporting || closed || !network) return;
        reporting = true;
        try { await reportRuntime(); } finally { reporting = false; }
      };
      const replicate = async () => {
        if (syncing || closed) return;
        syncing = true;
        try { await sync(false); pending.start(); }
        catch (error) { log.error('[profiles] 档案同步失败，保留复制待办', error); }
        finally { syncing = false; }
      };
      const heartbeat = async () => {
        if (heartbeating || closed || !network) return;
        heartbeating = true;
        const started = performance.now();
        const peers = [...sessions].filter((s) => access.validSession(s) && !s.loginInFlight);
        const keys = peers.map((s) => s.loginLease);
        try {
          const value = await exchangeHeartbeat({ ...heartbeatPayload(), leases: keys });
          if (closed) return;
          for (let i = 0; i < peers.length; i++) {
            const session = peers[i];
            if (session.loginLease !== keys[i] || !session.connected || session.loginReleased || session.loginRevoked || session.loginInFlight) continue;
            if (!value.renewed[i] || performance.now() >= session.leaseUntil) stopSession(session);
            else arm(session, started);
          }
        } catch (error) {
          // 传输失败不能证明权威撤销；不移动原到期 timer，持续断联仍按期关闭。
          for (const id of Object.keys(stateCache)) delete stateCache[id];
          log.error('[profiles] 登录心跳暂不可用，保留既有租约到期时间', error);
        } finally { heartbeating = false; }
      };
      void heartbeat(); void report();
      access.heartbeatTimer = setInterval(() => {
        void heartbeat(); void replicate(); void report();
        // Also prune stale remote invitations when the profile bridge is unavailable.
        lobbySource?.broadcastRecruitment();
      }, HEARTBEAT_MS); access.heartbeatTimer.unref?.();
      if (!authority) {
        access.chatTimer = setInterval(async () => {
          if (polling || closed) return;
          polling = true;
          try { await access.chatHistory(); }
          catch (error) { log.error('[profiles] 公共聊天轮询失败', error); }
          finally { polling = false; }
        }, 1000);
        access.chatTimer.unref?.();
      }
      let refreshing = false;
      access.refreshTimer = setInterval(async () => {
        if (refreshing) return;
        refreshing = true;
        try {
          const aids = [...new Set([...registry.all()].filter((s) => s.connected && s.profileBound && s.profileReady).map((s) => s.aid))];
          for (const aid of aids) if (await access.refresh(aid)) changed(aid);
        } catch (error) { log.error('[profiles] 在线档案刷新失败，保留展示缓存', error); }
        finally { refreshing = false; }
      }, 15_000);
      access.refreshTimer.unref?.();
    },
    close() {
      closed = true; pending.close();
      clearInterval(access.refreshTimer); clearInterval(access.heartbeatTimer); clearInterval(access.chatTimer);
      for (const session of [...sessions]) { stopSession(session); access.disconnect(session); }
    },
  };
  return access;
}
