import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { sanitizeName } from './net.js';
import { ChatHub } from './chat.js';
import { validateRecruitmentItems } from './recruitmentDirectory.js';
import { DIFFICULTIES, PHASE, MAX_SEATS, ENTERTAINMENT_MAX_SEATS, CYCLOPS_MAX_SEATS, ENDLESS_VARIANT, NAME_MAX_LEN } from '../shared/constants.js';

export const LEASE_MS = 12_000;
export const HEARTBEAT_MS = 3_000;
export const SERVER_NAMES = Object.freeze({ main: '华东', secondary: '华南' });
// Content identity excludes age: unchanged directories still need fresh source liveness.
export const directoryHash = (items) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
// Budget for the reference in BOTH directions, epoch and negotiation fields.
// Highly repetitive arrays can be large JSON but tiny gzip: judge the wire form.
export const directoryReferenceUseful = (items) => gzipSync(JSON.stringify(items)).length > 512;
const hashOK = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const directoryKinds = ['spectators', 'recruitment'];
export const targetIdOK = (value) => typeof value === 'string' && /^c_[0-9a-f]{32}$/.test(value);
export function validateKick(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(SERVER_NAMES, value.serverId) || !targetIdOK(value.targetId)) throw new Error('踢线目标无效');
  return { serverId: value.serverId, targetId: value.targetId };
}
export const CODE_PREFIXES = Object.freeze({ main: 'ABCDEFGHJKLM', secondary: 'NPQRSTUVWXYZ' });
export function roomServer(code) {
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z]{4}$/.test(code)) return null;
  return CODE_PREFIXES.main.includes(code[0]) ? 'main' : 'secondary';
}
export function loadLevel(sample, now = performance.now()) {
  if (!sample || now - sample.at >= LEASE_MS || now < sample.at
    || !Number.isFinite(sample.bytesPerSecond) || sample.bytesPerSecond < 0
    || !Number.isFinite(sample.bandwidthMbps) || sample.bandwidthMbps <= 0) return 'unknown';
  const ratio = sample.bytesPerSecond * 8 / (sample.bandwidthMbps * 1_000_000);
  return ratio < 0.5 ? 'idle' : ratio < 0.8 ? 'normal' : 'busy';
}

// 内部运行快照不包含档案、凭据或客户端提供的统计小计。
export function validateRuntime(value, serverId, copy = true) {
  const object = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
  const text = (v) => typeof v === 'string' && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);
  const aid = (v) => v === null || (typeof v === 'string' && /^[0-9a-f]{8,64}$/.test(v));
  const code = (v) => roomServer(v) === serverId;
  if (!Object.hasOwn(SERVER_NAMES, serverId) || !object(value, ['online', 'matches'])
    || !Array.isArray(value.online) || value.online.length > 2000
    || !Array.isArray(value.matches) || value.matches.length > 1000) throw new Error('运行快照无效');
  for (const row of value.online) {
    const keys = ['aid', 'name', 'roomCode', ...(Object.hasOwn(row, 'targetId') ? ['targetId'] : [])];
    if (!object(row, keys) || !aid(row.aid) || !text(row.name)
      || (Object.hasOwn(row, 'targetId') && !targetIdOK(row.targetId))
      || !(row.roomCode === null || code(row.roomCode))) throw new Error('在线快照无效');
  }
  const codes = new Set();
  for (const row of value.matches) {
    if (!object(row, ['code', 'mode', 'difficulty', 'ranked', 'round', 'phase', 'startedAt', 'players'])
      || !code(row.code) || codes.has(row.code) || !['solo', 'coop'].includes(row.mode)
      || !DIFFICULTIES.includes(row.difficulty) || typeof row.ranked !== 'boolean'
      || !Number.isSafeInteger(row.round) || row.round < 0 || row.round > 1_000_000
      || !(row.phase === '' || Object.values(PHASE).includes(row.phase))
      || !Number.isSafeInteger(row.startedAt) || row.startedAt < 0
      || !Array.isArray(row.players) || row.players.length > ENTERTAINMENT_MAX_SEATS) throw new Error('对局快照无效');
    codes.add(row.code);
    for (const seat of row.players) {
      if (!object(seat, ['name', 'isBot', 'connected']) || !text(seat.name)
        || typeof seat.isBot !== 'boolean' || typeof seat.connected !== 'boolean') throw new Error('座位快照无效');
    }
  }
  return copy ? structuredClone(value) : value;
}

// 公开目录独立于管理 runtime；拒绝附加字段，而不是在公开时临时删密钥。
export function validateSpectatorItems(value, serverId, copy = true) {
  const object = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
  const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
  if (!Object.hasOwn(SERVER_NAMES, serverId) || !Array.isArray(value) || value.length > 1000) throw new Error('观战快照无效');
  const codes = new Set(), matches = new Set();
  for (const row of value) {
    if (!object(row, ['serverId', 'code', 'matchId', 'mode', 'variant', 'difficulty', 'ranked', 'startedAt', 'round', 'phase', 'spectators', 'players'])
      || row.serverId !== serverId || roomServer(row.code) !== serverId || codes.has(row.code)
      || typeof row.matchId !== 'string' || !/^[0-9a-f]{32}$/.test(row.matchId) || matches.has(row.matchId)
      || !['solo', 'coop'].includes(row.mode) || ![null, 'entertainment_multi', 'entertainment_cyclops', ENDLESS_VARIANT].includes(row.variant)
      || (row.variant !== null && (row.mode !== 'coop' || row.ranked !== false))
      || !DIFFICULTIES.includes(row.difficulty) || typeof row.ranked !== 'boolean'
      || !integer(row.startedAt, Number.MAX_SAFE_INTEGER) || !integer(row.round, 1_000_000)
      || !Object.values(PHASE).includes(row.phase) || !integer(row.spectators, 64)
      || !Array.isArray(row.players) || row.players.length < 1
      || row.players.length > (row.mode === 'solo' ? 1 : row.variant === 'entertainment_cyclops' ? CYCLOPS_MAX_SEATS : row.variant === 'entertainment_multi' || row.variant === ENDLESS_VARIANT ? ENTERTAINMENT_MAX_SEATS : MAX_SEATS)) throw new Error('观战对局无效');
    codes.add(row.code); matches.add(row.matchId);
    const players = new Set();
    for (const seat of row.players) {
      if (!object(seat, ['playerId', 'name', 'isBot', 'alive', 'lp'])
        || typeof seat.playerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(seat.playerId) || players.has(seat.playerId)
        || typeof seat.name !== 'string' || [...seat.name].length > NAME_MAX_LEN || sanitizeName(seat.name) !== seat.name
        || typeof seat.isBot !== 'boolean' || typeof seat.alive !== 'boolean'
        || !Number.isFinite(seat.lp) || seat.lp < 0 || seat.lp > Number.MAX_SAFE_INTEGER
        || (row.mode === 'solo' && seat.isBot)) throw new Error('观战玩家无效');
      players.add(seat.playerId);
    }
  }
  return copy ? structuredClone(value) : value;
}

export function createSpectatorCache(serverId, now = () => performance.now()) {
  let samples = {};
  return {
    update(value, started = now()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((id) => !Object.hasOwn(SERVER_NAMES, id))) throw new Error('观战目录响应无效');
      const next = {};
      for (const [id, sample] of Object.entries(value)) {
        if (!sample || Object.keys(sample).length !== 2 || !Object.hasOwn(sample, 'items')
          || !(sample.ageMs === null || (Number.isFinite(sample.ageMs) && sample.ageMs >= 0))
          || (sample.items !== null && (sample.ageMs === null || sample.ageMs >= LEASE_MS))) throw new Error('观战目录年龄无效');
        if (sample.items !== null) next[id] = { items: validateSpectatorItems(sample.items, id), at: started - sample.ageMs };
      }
      samples = next;
    },
    directory(localItems) {
      const items = [...localItems], unavailable = [], at = now();
      for (const id of Object.keys(SERVER_NAMES)) {
        if (id === serverId) continue;
        const sample = samples[id];
        if (!sample || at < sample.at || at - sample.at >= LEASE_MS) unavailable.push(id);
        else items.push(...structuredClone(sample.items));
      }
      return { items, unavailable };
    },
  };
}

export function validateHeartbeat(value) {
  if (!value || !Object.hasOwn(SERVER_NAMES, value.serverId) || !Array.isArray(value.leases)
    || value.leases.length > 1024) throw new Error('心跳参数无效');
  const sample = value.sample;
  if (!sample || Object.keys(sample).length !== 2 || ![3, 5].includes(sample.bandwidthMbps)
    || !(sample.bytesPerSecond === null || (Number.isFinite(sample.bytesPerSecond)
      && sample.bytesPerSecond >= 0 && sample.bytesPerSecond <= Number.MAX_SAFE_INTEGER))) throw new Error('状态采样无效');
  if (value.kickResults !== undefined && (!Array.isArray(value.kickResults) || value.kickResults.length > 2000
    || value.kickResults.some((row) => !row || Object.keys(row).length !== 2 || !targetIdOK(row.targetId)
      || !['kicked', 'gone'].includes(row.status)))) throw new Error('踢线回执无效');
  if (value.announcementVersion !== undefined && (!Number.isSafeInteger(value.announcementVersion) || value.announcementVersion < 0)) throw new Error('公告版本无效');
  if (value.directoryDelta !== undefined && value.directoryDelta !== 1) throw new Error('目录传输版本无效');
  if (value.directoryVersions !== undefined) {
    const known = value.directoryVersions;
    if (!known || typeof known !== 'object' || Array.isArray(known)
      || !(known.epoch === null || typeof known.epoch === 'string')
      || Object.keys(known).some((key) => !['epoch', ...directoryKinds].includes(key))) throw new Error('目录版本无效');
    for (const kind of directoryKinds) {
      const versions = known[kind];
      if (!versions || typeof versions !== 'object' || Array.isArray(versions)
        || Object.entries(versions).some(([id, version]) => !Object.hasOwn(SERVER_NAMES, id) || !hashOK(version))) throw new Error('目录版本无效');
    }
  }
  if (value.directoryReport !== undefined) {
    const report = value.directoryReport;
    if (!report || typeof report !== 'object' || Array.isArray(report) || typeof report.epoch !== 'string'
      || Object.keys(report).some((key) => !['epoch', ...directoryKinds].includes(key))
      || directoryKinds.some((kind) => report[kind] !== undefined && !hashOK(report[kind]))) throw new Error('目录确认无效');
  }
  // This pass only checks fields; storage and public callers still receive isolated copies.
  if (value.runtime !== undefined) validateRuntime(value.runtime, value.serverId, false);
  if (value.spectatorItems !== undefined) validateSpectatorItems(value.spectatorItems, value.serverId, false);
  if (value.recruitmentItems !== undefined) validateRecruitmentItems(value.recruitmentItems, value.serverId);
}

// 租约不经过档案写盘队列；重启后等待旧租约全数失效才准入。
export function createRegionAuthority({ now = () => performance.now(), startupGuard = false } = {}) {
  const epoch = randomUUID(), readyAt = now() + (startupGuard ? LEASE_MS : 0);
  const owners = new Map(), generations = new Map(), states = new Map(), runtimes = new Map(), spectators = new Map(), recruitment = new Map();
  let directorySequence = 0;
  const directorySnapshot = (samples, known = null) => {
    const at = now();
    return Object.fromEntries(Object.keys(SERVER_NAMES).map((id) => {
      const sample = samples.get(id), ageMs = sample ? Math.max(0, at - sample.at) : null;
      const fresh = sample && at >= sample.at && ageMs < LEASE_MS;
      if (!known) return [id, { ageMs, items: fresh ? structuredClone(sample.items) : null }];
      if (!fresh) return [id, { ageMs, items: null }];
      // Sending a hash for [] or a tiny directory would cost more than its body.
      return [id, known[id] === sample.version && directoryReferenceUseful(sample.items)
        ? { ageMs, version: sample.version } : { ageMs, items: structuredClone(sample.items) }];
    }));
  };
  const kicks = new Map();
  const pruneKicks = () => {
    for (const [key, row] of kicks) {
      if (now() >= row.expires) kicks.delete(key);
      else if (row.status === 'pending' && now() >= row.deadline) row.status = 'timeout';
    }
  };
  const kickResult = (row) => {
    if (!row) return { error: '踢线请求已过期或不存在', code: 404 };
    if (row.status === 'gone') return { error: '目标连接已离线', code: 409 };
    if (row.status === 'timeout') return { error: '踢线回执超时，无法确认结果', code: 504 };
    return { ok: true, status: row.status };
  };
  const recordKickResults = (serverId, results) => {
    for (const result of results || []) {
      const row = kicks.get(`${serverId}:${result.targetId}`);
      if (row && ['pending', 'timeout'].includes(row.status)) {
        row.status = result.status;
        row.expires = now() + 60_000;
      }
    }
  };
  const chat = new ChatHub();
  let chatSequence = 0;
  const chatEvents = [];
  const record = chat.record.bind(chat);
  chat.record = (data) => {
    const message = record({ ...data, sequence: ++chatSequence });
    if (states.get('secondary') && now() - states.get('secondary').at < LEASE_MS) chatEvents.push(message);
    else chatEvents.length = 0;
    return message;
  };
  const failure = (detail = '该账户已在其他连接登录') => ({ error: 'BAD_TARGET', detail });
  function valid(value) {
    return value && ['main', 'secondary'].includes(value.serverId)
      && typeof value.owner === 'string' && /^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(value.owner)
      && Number.isSafeInteger(value.generation) && value.generation > 0;
  }
  function current(value) {
    const lease = owners.get(value?.owner);
    return valid(value) && value.epoch === epoch && lease && lease.generation === value.generation
      && lease.serverId === value.serverId && lease.expires > now() ? lease : null;
  }
  function remove(lease) {
    if (owners.get(lease.owner) === lease) owners.delete(lease.owner);
  }
  return {
    chat,
    chatHistory(serverId, cursor, previousEpoch, delta = 0) {
      if (!['main', 'secondary'].includes(serverId) || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('聊天游标无效');
      const initial = previousEpoch !== epoch;
      if (serverId === 'secondary' && !initial) {
        while (chatEvents.length && chatEvents[0].sequence <= cursor) chatEvents.shift();
      }
      if (delta === 1) {
        const events = (serverId === 'main' ? chat.history() : chatEvents).filter((item) => item.sequence > cursor);
        const gap = cursor > chatSequence || (cursor < chatSequence && events[0]?.sequence !== cursor + 1);
        return { epoch, cursor: chatSequence,
          ...(initial || gap ? { history: chat.history(), events: [] } : { events }) };
      }
      return { epoch, cursor: chatSequence, history: chat.history(),
        events: initial ? chat.history() : serverId === 'main' ? [] : chatEvents.filter((item) => item.sequence > cursor) };
    },
    claim(value) {
      if (!valid(value) || !sanitizeName(value.name)) throw new Error('登录租约参数无效');
      if (now() < readyAt) return failure('登录权威正在恢复，请稍后重连');
      const name = sanitizeName(value.name), previous = owners.get(value.owner);
      if (previous && previous.serverId !== value.serverId) return failure('连接租约不匹配');
      const known = generations.get(value.owner) || 0;
      if (value.generation < known || (value.generation === known && !previous)) return failure('连接租约已撤销，请重连');
      if (previous && value.generation === previous.generation && name !== previous.name) return failure('连接租约不匹配');
      const lease = { ...value, name, epoch, expires: now() + LEASE_MS,
        aid: previous?.name === name ? previous.aid : null };
      if (previous) remove(previous);
      generations.set(value.owner, value.generation);
      owners.set(value.owner, lease);
      return lease;
    },
    current,
    release(value) {
      if (!valid(value)) throw new Error('释放租约参数无效');
      const known = generations.get(value.owner) || 0;
      if (value.generation >= known) {
        generations.set(value.owner, value.generation);
        const lease = owners.get(value.owner);
        if (lease && lease.generation <= value.generation) remove(lease);
      }
      return { ok: true };
    },
    kick(value) {
      validateKick(value); pruneKicks();
      const key = `${value.serverId}:${value.targetId}`, previous = kicks.get(key);
      if (previous) return kickResult(previous);
      const sample = runtimes.get(value.serverId);
      if (!sample || now() < sample.at || now() - sample.at >= LEASE_MS) return { error: '目标服务器离线或状态已过期', code: 503 };
      if (!sample.value.online.some((row) => row.targetId === value.targetId)) return { error: '目标连接已离线', code: 409 };
      kicks.set(key, { ...value, status: 'pending', deadline: now() + LEASE_MS, expires: now() + 60_000 });
      return { ok: true, status: 'pending' };
    },
    kickStatus(value) {
      validateKick(value); pruneKicks();
      const row = kicks.get(`${value.serverId}:${value.targetId}`);
      return kickResult(row);
    },
    reportKick(value, status) {
      validateKick(value);
      if (!['kicked', 'gone'].includes(status)) throw new Error('踢线回执无效');
      pruneKicks();
      recordKickResults(value.serverId, [{ targetId: value.targetId, status }]);
      return kickResult(kicks.get(`${value.serverId}:${value.targetId}`));
    },
    heartbeat(value) {
      validateHeartbeat(value);
      pruneKicks();
      recordKickResults(value.serverId, value.kickResults);
      const at = now();
      states.set(value.serverId, { bandwidthMbps: value.sample.bandwidthMbps, bytesPerSecond: value.sample.bytesPerSecond, at });
      if (value.runtime !== undefined) runtimes.set(value.serverId, { at, value: validateRuntime(value.runtime, value.serverId) });
      if (value.spectatorItems !== undefined) {
        const items = validateSpectatorItems(value.spectatorItems, value.serverId);
        spectators.set(value.serverId, { at, items, version: directoryHash(items) });
      }
      if (value.recruitmentItems !== undefined) {
        const items = validateRecruitmentItems(value.recruitmentItems, value.serverId);
        recruitment.set(value.serverId, { at, items, version: directoryHash(items) });
      }
      // A reference only renews the exact acknowledged source content. Missing/old bases
      // remain stale and are returned in full, so the next report repairs them.
      if (value.directoryReport?.epoch === epoch) {
        for (const [kind, samples] of [['spectators', spectators], ['recruitment', recruitment]]) {
          const sample = samples.get(value.serverId);
          if (sample && value.directoryReport[kind] === sample.version) sample.at = at;
        }
      }
      const renewed = value.leases.map((key) => {
        const lease = current(key);
        if (!lease || lease.serverId !== value.serverId) return false;
        lease.expires = now() + LEASE_MS;
        return true;
      });
      const compact = value.directoryDelta === 1;
      const known = value.directoryVersions?.epoch === epoch ? value.directoryVersions : null;
      return { epoch, renewed, states: this.states(),
        ...(compact ? { directoryDelta: 1, directorySequence: ++directorySequence } : {}),
        spectators: directorySnapshot(spectators, compact ? known?.spectators || {} : null),
        recruitment: directorySnapshot(recruitment, compact ? known?.recruitment || {} : null),
        kickCommands: [...kicks.values()].filter((row) => row.serverId === value.serverId && row.status === 'pending')
          .map((row) => ({ targetId: row.targetId, expiresAt: Date.now() + Math.max(0, row.deadline - now()) })) };
    },
    spectatorSnapshots() {
      return directorySnapshot(spectators);
    },
    recruitmentSnapshots() {
      return directorySnapshot(recruitment);
    },
    states() { return Object.fromEntries([...states].map(([id, sample]) => [id, { ...sample, ageMs: now() - sample.at, load: loadLevel(sample, now()) }])); },
    adminRuntimes() {
      const at = now();
      return Object.fromEntries(Object.keys(SERVER_NAMES).map((id) => {
        const sample = runtimes.get(id), ageMs = sample ? Math.max(0, at - sample.at) : null;
        const fresh = sample && at >= sample.at && ageMs < LEASE_MS;
        return [id, { ageMs, runtime: fresh ? structuredClone(sample.value) : null }];
      }));
    },
    publish(value) {
      const lease = current(value);
      if (!lease?.aid || !/^[A-Za-z0-9_-]{1,64}$/.test(value.playerId || '')) return failure('连接租约已失效，请重连');
      const session = { name: lease.name, aid: lease.aid, playerId: value.playerId };
      if (value.kind === 'text') return chat.publishText(session, value.text);
      if (value.kind === 'invite' && roomServer(value.code) === lease.serverId) {
        return chat.publishInvite(session, { code: value.code, serverId: lease.serverId });
      }
      return { error: 'BAD_MSG' };
    },
  };
}
