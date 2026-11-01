import { net, identity, HELLO_TIMEOUT_MS, CONNECT_TIMEOUT_MS } from './net.js';
import { createStore, store, selectRoute } from './store.js';
import { loadoutStore } from './ui/loadoutSync.js';
import { skinsStore } from './ui/skins.js';
import { confirmDialog } from './ui/components.js';
import { resourceCache } from './resourceCache.js';
import { isResourceOnlyOrigin } from './serverOrigins.js';

const HANDOFF_PREFIX = '#sp-server=';
const REGION_NAMES = { main: '华东', secondary: '华南' };
export const serversState = createStore({ directory: null, loading: false, error: '', switching: false });
let directoryRequest = null;
let joining = null;
let initialSelectionDone = false;
let retryLogin = null;
let stopAutomaticFallback = null;

// 默认入口固定华东；负载采样不改变玩家的连接目标。
export function preferredServer(servers) {
  return servers.some((entry) => entry.id === 'main') ? 'main' : servers[0]?.id || 'main';
}

/** Only the fresh, anonymous title connection may fail over; never interrupt login or a restored game. */
export function installTitleServerFallback({ connection = net, account = identity, app = store, state = serversState, timers = globalThis } = {}) {
  let timer = null, disposed = false;
  const cancel = () => { if (timer !== null) timers.clearTimeout(timer); timer = null; };
  const eligible = () => {
    const s = app.get(), current = state.get();
    return !disposed && !current.switching && current.directory?.current === 'main'
      && account.getServer() === 'main' && connection.status === 'reconnecting'
      && !connection.name && !connection._loginAttempt && !connection.pendingCount
      && !account.getToken() && !account.wasEntered() && !s.session?.entered
      && !s.room && !s.spectator && !s.ui?.restoring && !s.ui?.pendingJoin
      && !Object.values(s.match || {}).some(Boolean);
  };
  const off = connection.on('status', () => {
    cancel();
    if (!eligible()) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (!eligible()) return;
      const directory = state.get().directory;
      const target = directory.servers.find((entry) => entry.id === 'secondary');
      if (!target) return;
      dispose();
      connection.closeForServerSwitch();
      account.selectServer('secondary');
      state.set({ directory: { ...directory, current: 'secondary' }, error: '' });
      connection.url = socketUrl(target);
      connection.connect();
    }, 250);
  });
  function dispose() { if (disposed) return; disposed = true; cancel(); off(); }
  return dispose;
}

export function roomServer(code) {
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z]{4}$/.test(code)) return null;
  return 'ABCDEFGHJKLM'.includes(code[0]) ? 'main' : 'secondary';
}

export function parseRoomTarget(input) {
  const object = input && typeof input === 'object';
  let raw = object ? input.code : String(input ?? '').trim();
  let origin = object ? input.origin : null;
  if (!object && /[?&]room=/.test(raw)) {
    try {
      const url = new URL(raw, globalThis.location?.href || 'http://local/');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      raw = url.searchParams.get('room'); origin = url.origin;
    } catch { return null; }
  }
  const code = String(raw ?? '').trim().toUpperCase();
  const serverId = roomServer(code);
  if (!serverId || (object && input.serverId && input.serverId !== serverId)) return null;
  return { code, serverId, ...(origin ? { origin } : {}) };
}

export function parseDirectory(value) {
  if (isResourceOnlyOrigin(location.origin)) throw new Error('此地址仅提供资源预载，请从原游戏入口访问');
  if (!value || !['main', 'secondary'].includes(value.current) || !Array.isArray(value.servers)
      || !value.servers.length || value.servers.length > 2
      || value.servers.some(entry => !['main', 'secondary'].includes(entry?.id))) {
    throw new Error('服务器目录格式不正确，请重试');
  }
  const servers = ['main', 'secondary'].filter(id => value.servers.some(entry => entry.id === id)).map((id) => {
    const entries = value.servers.filter((entry) => entry?.id === id);
    const entry = entries[0];
    if (entries.length !== 1 || typeof entry.url !== 'string' || !(entry.url === '/' || /^https?:\/\//i.test(entry.url))) {
      throw new Error('服务器目录配置不完整，请重试');
    }
    const url = new URL(entry.url, location.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('服务器公开地址无效，请重试');
    }
    if (isResourceOnlyOrigin(url.origin)) throw new Error('资源预载地址不能作为游戏服务器');
    const aliases = entry.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > 8 || aliases.some(alias => {
      try { const u = new URL(alias); return u.origin !== alias || !['http:', 'https:'].includes(u.protocol) || isResourceOnlyOrigin(u.origin); }
      catch { return true; }
    })) throw new Error('服务器入口别名无效，请重试');
    return { id, name: REGION_NAMES[id], origin: url.origin, aliases,
      load: ['idle', 'normal', 'busy'].includes(entry.load) ? entry.load : 'unknown' };
  });
  if (new Set(servers.map(entry => entry.origin)).size !== servers.length
      || !servers.some((entry) => entry.origin === location.origin || entry.aliases.includes(location.origin))) {
    throw new Error('请从华东或华南游戏入口访问游戏');
  }
  if (location.protocol === 'https:' && servers.some((entry) => !entry.origin.startsWith('https:'))) {
    throw new Error('HTTPS 游戏入口需要两服均配置 HTTPS/WSS 地址');
  }
  if (!servers.some(entry => entry.id === value.current)) throw new Error('当前游戏服务器未启用');
  if (!servers.some(entry => entry.id === identity.getServer())) identity.selectServer(preferredServer(servers));
  return { current: identity.getServer(), servers };
}

export function loadServers() {
  if (directoryRequest) return directoryRequest;
  if (serversState.get().switching) return Promise.resolve(null);
  serversState.set({ loading: true, error: '' });
  directoryRequest = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let receivedDirectory = false;
    try {
      const response = await fetch('/api/servers', { method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-cache', signal: controller.signal });
      if (!response.ok) throw new Error('服务器目录加载失败，请重试');
      receivedDirectory = true;
      const directory = parseDirectory(await response.json());
      serversState.set({ directory, error: '' });
      return directory;
    } catch (err) {
      // 移动网络短暂失败不移除已校验的地址；收到无效目录时仍丢弃旧配置。
      const directory = receivedDirectory ? null : serversState.get().directory;
      serversState.set({ directory, error: err?.name === 'AbortError' ? '服务器目录请求超时，请重试' : err?.message || '服务器目录加载失败，请重试' });
      return null;
    } finally {
      clearTimeout(timer);
      directoryRequest = null;
      serversState.set({ loading: false });
    }
  })();
  return directoryRequest;
}

// 交接仅含名字、进入意愿及可选入房目标；身份初始化前立即清除 fragment。
export function consumeServerHandoff(sanitizeName) {
  if (!location.hash.startsWith(HANDOFF_PREFIX)) return null;
  const encoded = location.hash.slice(HANDOFF_PREFIX.length);
  history.replaceState(history.state, '', location.pathname);
  const invalid = { name: '', entered: false };
  try {
    if (encoded.length > 2048) return invalid;
    const value = JSON.parse(decodeURIComponent(encoded));
    if (!value || Array.isArray(value) || Object.keys(value).some((k) => !['name', 'entered', 'join'].includes(k))
        || typeof value.name !== 'string' || typeof value.entered !== 'boolean'
        || sanitizeName(value.name) !== value.name || (value.entered && !value.name)) return invalid;
    const join = value.join ? parseRoomTarget(value.join) : null;
    if (value.join && (!join || Object.keys(value.join).some((k) => !['code', 'serverId'].includes(k)))) return invalid;
    return { name: value.name, entered: value.entered, ...(join ? { join } : {}) };
  } catch { return invalid; }
}

function socketUrl(entry) {
  return entry.origin.replace(/^http/, 'ws') + '/ws';
}

// 刷新仍留同一资源 origin，但恢复此标签选定的游戏服。
export async function prepareServerConnection(directoryReady = loadServers()) {
  const directory = await directoryReady;
  if (!directory) { net.close(); return false; }
  // 仅首次未登录首页自动选服；断线凭据、已进入状态和用户手选不受刷新影响。
  if (!initialSelectionDone) {
    initialSelectionDone = true;
    if (!net.name && !identity.getToken() && !identity.wasEntered() && !identity.hasSelectedServer()) {
      const pendingTarget = store.get().ui?.pendingJoin?.serverId;
      const preferred = ['main', 'secondary'].includes(pendingTarget) ? pendingTarget : preferredServer(directory.servers);
      if (preferred !== directory.current) identity.selectServer(preferred);
      directory.current = preferred;
      serversState.set({ directory });
      if (!pendingTarget) stopAutomaticFallback = installTitleServerFallback();
    }
  }
  net.url = socketUrl(directory.servers.find((entry) => entry.id === directory.current));
  return true;
}

// 已有校验地址时立即重建当前服连接，不让目录请求的8秒超时阻塞用户重试。
export async function retryServerConnection() {
  if (serversState.get().switching) return false;
  const directory = serversState.get().directory || await loadServers();
  if (!directory || serversState.get().switching) return false;
  const target = directory.servers.find((entry) => entry.id === identity.getServer());
  net.url = socketUrl(target);
  if (retryLogin && retryLogin.serverId === identity.getServer() && !net.name) {
    const { name, entered } = retryLogin;
    identity.clearToken(); identity.saveName(name); identity.setEntered(entered);
    store.set({ me: { playerId: null, name, token: null }, session: { entered } });
    net.setName(name);
    retryLogin = null;
  }
  if (net.status === 'closed' || net.status === 'idle') net.connect();
  else net.reconnectNow();
  return true;
}

function waitForServer(id) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); offStatus(); offError(); };
    const offError = net.on('helloError', (err) => { cleanup(); reject(err); });
    const offStatus = net.on('status', () => {
      if (net.status === 'online' && net.serverId === id) {
        cleanup(); resolve();
      }
    });
    // 与所有浏览器统一建连预算一致，再留出完整 hello 窗口。
    const timeout = (net.connectTimeoutMs ?? CONNECT_TIMEOUT_MS) + HELLO_TIMEOUT_MS;
    const timer = setTimeout(() => { cleanup(); reject(new Error('目标服务器连接超时，请重试')); }, timeout);
  });
}

function parseWatchTarget(input) {
  const target = parseRoomTarget(input);
  return target && typeof input?.matchId === 'string' && /^[0-9a-f]{32}$/.test(input.matchId)
    ? { ...target, matchId: input.matchId } : null;
}

export async function switchServer(id, { name: desiredName, join = null, watch = null } = {}) {
  const state = serversState.get();
  if (state.switching) return false;
  const directory = state.directory;
  const target = directory?.servers.find((entry) => entry.id === id);
  if (!target) throw new Error('请先加载有效的服务器目录');
  initialSelectionDone = true;
  stopAutomaticFallback?.(); stopAutomaticFallback = null;
  if (id === directory.current) return false;
  const s = store.get();
  if (s.spectator || s.room?.inMatch || Object.values(s.match).some(Boolean) || s.ui.restoring) {
    throw new Error('请先结束对局或观战再切换服务器');
  }
  const loggedIn = !!net.name;
  if (loggedIn && (net.status !== 'online' || net.serverId !== directory.current)) throw new Error('请等待当前服务器完成身份连接');
  if (loggedIn && (net.pendingCount || [loadoutStore.get().sync, skinsStore.get().sync].some((sync) => ['pending', 'sending', 'error'].includes(sync)))) {
    throw new Error('当前请求或档案编辑尚未完成，请稍后切服');
  }
  const roomTarget = join ? parseRoomTarget(join) : null;
  const watchTarget = watch ? parseWatchTarget(watch) : null;
  if (join && watch) throw new Error('不能同时加入同盟和观战');
  if (join && (!roomTarget || roomTarget.serverId !== id)) throw new Error('同盟所属服务器不匹配');
  if (watch && (!watchTarget || watchTarget.serverId !== id)) throw new Error('观战目标无效或所属服务器不匹配');
  if (watchTarget && s.room) throw new Error('请先离开当前同盟再观战');
  const name = desiredName ?? net.serverName ?? s.me.name ?? '';
  const entered = s.session.entered && !!name;
  serversState.set({ switching: true, error: '' });
  let moved = false;
  try {
    if ((entered || roomTarget || watchTarget) && !await resourceCache.ensureSessionReady()) throw new Error('资源清单或本地存储尚未就绪，请重试');
    // 等权威释放回执，再直连目标 WS；页面与 IndexedDB 始终留在主入口。
    if (loggedIn) {
      try { await net.request('session.release', {}); }
      catch (err) {
        if (err?.detail === 'SESSION_RELEASED') {
          retryLogin = { serverId: directory.current, name, entered };
          identity.clearToken(); identity.setEntered(false);
          net.closeForServerSwitch();
          store.set({ me: { playerId: null, name, token: null }, session: { entered: false } });
        }
        throw err;
      }
    }
    retryLogin = null;
    history.replaceState(history.state, '', location.pathname);
    identity.clearToken();
    net.closeForServerSwitch();
    identity.selectServer(id); identity.saveName(name); identity.setEntered(entered);
    moved = true;
    net.url = socketUrl(target);
    serversState.set({ directory: { ...directory, current: id } });
    loadoutStore.set({ open: false, from: null, sel: null });
    store.set({ me: { playerId: null, name, token: null }, session: { entered } });
    // 标题页只选连接目标，不等待 TCP/WS 建连；弱网时仍能立即切回另一服。
    if (!loggedIn && !entered) {
      net.connect();
      return true;
    }
    const connected = waitForServer(id);
    net.setName(name);
    net.connect();
    await connected;
    if (roomTarget) await net.request('room.join', { code: roomTarget.code, serverId: id });
    if (watchTarget) await net.request('spectator.join', { code: watchTarget.code, matchId: watchTarget.matchId });
    return true;
  } catch (err) {
    serversState.set({ error: err?.message || '切服失败，请重试' });
    // 尚未释放/切走时保留原连接；入房或观战失败也不撤销目标身份。
    if (!moved || (net.status === 'online' && net.serverId === id)) throw err;
    // 失败后停在标题，仅在用户明确重试时恢复登录意愿，绝不复用已释放 token。
    retryLogin = { serverId: id, name, entered };
    identity.clearToken(); identity.setEntered(false);
    net.closeForServerSwitch();
    store.set({ me: { playerId: null, name, token: null }, session: { entered: false } });
    throw err;
  } finally {
    serversState.set({ switching: false });
  }
}

export function watchMatch(input) {
  if (joining || serversState.get().switching) return Promise.resolve(false);
  const target = parseWatchTarget(input);
  if (!target) return Promise.reject(new Error('观战目标无效，请刷新列表'));
  joining = (async () => {
    const s = store.get();
    if (!s.session.entered || net.status !== 'online') throw new Error('请先输入代号并连接服务器');
    if (s.spectator || Object.values(s.match).some(Boolean) || s.ui.restoring) throw new Error('请先结束对局或观战');
    if (s.room) throw new Error('请先离开当前同盟再观战');
    const directory = serversState.get().directory || await loadServers();
    if (!directory) throw new Error(serversState.get().error);
    const entry = directory.servers.find((item) => item.id === target.serverId);
    if (!entry) throw new Error('该服务器已下线，请刷新观战列表');
    if (target.origin && target.origin !== entry.origin && target.origin !== directory.servers[0].origin) {
      throw new Error('观战目标不属于已配置的服务器');
    }
    if (directory.current !== net.serverId) throw new Error('服务器身份尚未确认，请稍后重试');
    if (target.serverId === directory.current) {
      if (!await resourceCache.ensureSessionReady()) throw new Error('资源清单或本地存储尚未就绪，请重试');
      if (net.status !== 'online' || store.get().room || store.get().spectator) throw new Error('当前状态已改变，请刷新列表');
      await net.request('spectator.join', { code: target.code, matchId: target.matchId });
      return true;
    }
    const confirmed = await confirmDialog({ title: '切换服务器',
      text: `该对局位于${entry.name}，是否断开当前连接并前往观战？`,
      okText: '切换并观战', cancelText: '取消' });
    if (!confirmed) return false;
    return switchServer(target.serverId, { watch: target });
  })().catch((err) => {
    if (err?.detail === '本局已结束') throw new Error('本局已结束，请刷新观战列表');
    throw err;
  }).finally(() => { joining = null; });
  return joining;
}

export function joinRoom(input) {
  if (joining || serversState.get().switching) return Promise.resolve(false);
  const target = parseRoomTarget(input);
  if (!target) return Promise.reject(new Error('请输入有效的四位同盟密钥或邀请链接'));
  joining = (async () => {
    const s = store.get();
    if (!s.session.entered || net.status !== 'online') throw new Error('请先输入代号并连接服务器');
    if (selectRoute(s) === 'game') throw new Error('正在对局或观战，无法切换同盟');
    const directory = serversState.get().directory || await loadServers();
    if (!directory) throw new Error(serversState.get().error);
    const entry = directory.servers.find((item) => item.id === target.serverId);
    if (!entry) throw new Error('该服务器已下线，请使用当前服务器的同盟邀请');
    if (target.origin && target.origin !== entry.origin && target.origin !== directory.servers[0].origin) {
      throw new Error('邀请链接不属于已配置的服务器');
    }
    if (directory.current !== net.serverId) throw new Error('服务器身份尚未确认，请稍后重试');
    if (target.serverId === directory.current) {
      await net.request('room.join', { code: target.code, serverId: target.serverId });
      return true;
    }
    const confirmed = await confirmDialog({ title: '切换服务器',
      text: `该同盟位于${entry.name}，是否断开当前连接并前往加入？`,
      okText: '切换并加入', cancelText: '取消' });
    if (!confirmed) return false;
    return switchServer(target.serverId, { join: target });
  })().finally(() => { joining = null; });
  return joining;
}
