// Client entry: boot (fonts, identity, socket), net → store wiring, router, global overlays.
//
// Router (derived from the store, no URL routes):
//   not entered            → Title
//   m.public.phase ≠ LOBBY → Game (screens/game.js: briefing / band draft / match / result by phase)
//   room.inMatch           → Game (match starting, m.public on its way)
//   in a room              → Room
//   otherwise              → Lobby
// Deep link `?room=CODE`: remembered at boot, auto-joined once the player has entered and the
// session is online (after a short grace period in case the server restores a room on resume).
// Reloading a tab that already passed the title re-enters automatically (sessionStorage flag) and
// resumes the server session with the saved token; stale room/match state is dropped if the
// server does not re-push it within RESTORE_GRACE_MS after `welcome`. Boot waits for
// `identity.init()` (which token this tab may use without stealing another live tab's session)
// before the first connect; a page restored from the back/forward cache reloads.
// A `welcome` with a NEW playerId (the server restarted / the session expired) while a room or match was on screen:
// toast 「服务器会话已重置，上一局模拟已结束」 (store.js sessionResetNotice) and return to the lobby with nothing stale.
//
// Shared modules are imported relatively ('../../shared/…' resolves to /shared/… in the browser).
// Multi-device support (ui/device.js + css/devices.css): feature classes on <html>, no page zoom, safe areas, rotation
// re-layout; ui/compat.js polyfills are imported before anything else.
// 干员调配 (DESIGN §16): an overlay over any route (<LoadoutHost/>, opened from lobby / room / briefing); its loadout is
// kept in sync with the server by installLoadoutSync (room.loadout after every welcome and edit).
// Game data: every text of the game is static data (/data/*.json) downloaded once per page; the in-match files are
// warmed in the background as soon as the player is in a room (warmGameData), before the match needs them.

// Polyfills first (older Safari / Firefox ESR): every module evaluated after this one sees them.
import './ui/compat.js';
import { render } from '../vendor/preact.module.js';
import { useErrorBoundary, useLayoutEffect } from '../vendor/hooks.module.js';
import { html, UiHosts, Button, MicroLabel, closeAllDialogs, alertDialog } from './ui/components.js';
import { ConnectionBanner } from './ui/connBanner.js';
import { ToastHost, toast, toastError, describeError } from './ui/toasts.js';
import { net, identity, NetError } from './net.js';
import { consumeServerHandoff, prepareServerConnection, joinRoom, parseRoomTarget, loadServers } from './servers.js';
import { store, useStore, emptyMatch, selectRoute, sessionResetNotice, loadRankedPref } from './store.js';
import { data } from './data.js';
import { GAME_FILES } from './ui/gameComponents.js';
import { TitleScreen, sanitizeName, enterSession } from './screens/title.js';
import { initResourceCache, resourceCache } from './resourceCache.js';
import { assets, collectMatchResourceUrls } from './assets.js';
import { ResourcePreloadHost } from './ui/resourcePreload.js';
import { LobbyScreen, rememberRoom, parseRoomParam } from './screens/lobby.js';
import { RoomScreen } from './screens/room.js';
import { GameScreen } from './screens/game.js';
import { installAudio, audio } from './audio.js';
import { installContent, installContentSet } from './content.js';
import { cosmetics } from './cosmetics.js';
import { settingsStore } from './ui/settings.js';
import { GuideHost } from './ui/guide.js';
import { installDeviceSupport } from './ui/device.js';
import { LoadoutHost } from './screens/loadout.js';
import { StatsHost } from './screens/stats.js';
import { recordResult, installStatsRecorder } from './ui/stats.js';
import { installLoadoutSync, installOwnershipSync, installDiySync } from './ui/loadoutSync.js';
import { installSkinsSync } from './ui/skins.js';
import { AnnouncementBanner, acceptAnnouncement } from './ui/announcement.js';
import { startBuildGuard } from './ui/buildGuard.js';

import { initLang, useLang, tickerText } from './ui/lang.js';
import { translateWire, t } from '../../shared/i18n.js';
import { recordError } from './diag.js';

const RESTORE_GRACE_MS = 1500;
const JOIN_DELAY_MS = 350;
const TICKER_KEEP = 20;
const EMOTE_KEEP = 20;

const SCREENS = { title: TitleScreen, lobby: LobbyScreen, room: RoomScreen, game: GameScreen };

/** Copy of a server message without transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg; // eslint-disable-line no-unused-vars
  return rest;
}

function clearRoomParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

// ---- net → store wiring ---------------------------------------------------------------------------

let seq = 0;
let welcomeAt = 0;
let roomStateAt = 0;
let matchAt = 0;
let restoreTimer = null;
let joinTimer = null;
let joinInFlight = false;
let appMounted = false;
let matchDismissed = false;

function clearPendingJoin() {
  store.patch('ui', { pendingJoin: null });
  clearRoomParam();
}

/** Auto-join the deep-linked room once entered + online (idempotent). */
function schedulePendingJoin() {
  clearTimeout(joinTimer);
  joinTimer = setTimeout(async () => {
    const s = store.get();
    const target = s.ui.pendingJoin;
    if (!target || joinInFlight || !appMounted || !s.session.entered || net.status !== 'online') return;
    if (s.room?.code === target.code && s.room?.serverId === target.serverId) { clearPendingJoin(); return; }
    joinInFlight = true;
    try {
      await joinRoom(target);
    } catch (err) {
      toastError(err);
    } finally {
      joinInFlight = false;
      clearPendingJoin();
    }
  }, JOIN_DELAY_MS);
}

/** End the post-resume "syncing" state early once the server re-pushed what we were showing. */
function maybeFinishRestore() {
  const s = store.get();
  if (!s.ui.restoring) return;
  const roomOk = !s.room || roomStateAt >= welcomeAt;
  const matchOk = !s.match.public || matchAt >= welcomeAt || !s.room?.inMatch;
  if (roomOk && matchOk) {
    clearTimeout(restoreTimer);
    store.patch('ui', { restoring: false });
  }
}

/**
 * Leave whatever room / match was on screen for the lobby with nothing stale left behind: open imperative dialogs,
 * the post-resume restore timer, ticker lines and emote bubbles of the old match (the battle runner and the 暂离 flag
 * follow the store themselves).
 */
function backToLobby(allowResult = false) {
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  store.set({ room: null, spectator: null, matchChat: { matchId: null, items: [] }, match: emptyMatch(), ticker: [], emotes: [] });
  matchDismissed = !allowResult;
  store.patch('ui', { restoring: false });
}

function onWelcome(msg) {
  matchDismissed = false;
  identity.saveToken(msg.token);
  const prev = store.get();
  const prevId = prev.me.playerId;
  const name = typeof msg.name === 'string' && msg.name ? msg.name : prev.me.name;
  store.set({ me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null } });
  store.set({ content: { vanilla: msg.content?.vanilla || null }, installedPlugins: Number.isInteger(msg.content?.plugins) ? msg.content.plugins : 0 });
  welcomeAt = Date.now();

  if (prevId != null && prevId !== msg.playerId) {
    // A brand-new server session (the server restarted — crashed / killed, so no room.closed arrived — or this session
    // expired on it): whatever we showed before is gone — back to the lobby cleanly and say why.
    const notice = sessionResetNotice(prev, msg.playerId);
    backToLobby();
    store.set({ chat: { items: [] } });
    if (notice) toast(notice, 'warn', { ttl: 7000 });
  } else if (prev.room || prev.match.public) {
    // Resumed session: the server re-pushes room/match state; drop whatever it doesn't.
    store.patch('ui', { restoring: true });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const s = store.get();
      const patch = {};
      if (s.room && roomStateAt < welcomeAt) patch.room = null;
      if (s.match.public && matchAt < welcomeAt) {
        patch.match = emptyMatch();
        if (s.spectator) patch.spectator = null;
      }
      store.set(patch);
      store.patch('ui', { restoring: false });
    }, RESTORE_GRACE_MS);
  }
  schedulePendingJoin();
}

function onRoomState(msg) {
  const room = payload(msg);
  roomStateAt = Date.now();
  const myId = store.get().me.playerId;
  const seats = Array.isArray(room.seats) ? room.seats : [];
  if (myId != null && seats.length && !seats.some((s) => s && s.playerId === myId)) {
    // We are no longer seated (kicked / left elsewhere) — neither in a player seat nor a spectator seat.
    if (store.get().room) toast(t('你已不在该同盟中'), 'warn');
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) store.set({ match: emptyMatch() });
  store.set({ room });
  if (room.inMatch) matchDismissed = false;
  if (room.mode === 'coop' && typeof room.code === 'string') rememberRoom(room.code);
  maybeFinishRestore();
}

const CLOSE_REASON = {
  // 'timeout' = this player was removed after staying disconnected past the lobby grace (server/lobby.js)
  host_left: '创建者已离开，同盟已解散', timeout: '由于长时间断开连接，你已离开同盟', empty: '同盟已解散',
  kicked: '你已被移出同盟', ended: '模拟已结束', expired: '同盟已过期', shutdown: '服务器维护中，同盟已关闭',
};

function wireNet() {
  net.on('serverSwitch', () => {
    clearTimeout(restoreTimer);
    clearTimeout(joinTimer);
    restoreTimer = joinTimer = null;
    joinInFlight = false;
    seq = welcomeAt = roomStateAt = matchAt = 0;
    matchDismissed = false;
    closeAllDialogs();
    store.reset();
  });
  net.on('status', (snap) => {
    const cur = store.get().connection;
    store.set({
      ...(snap.status !== 'online' ? { recruitment: { rooms: [] } } : {}),
      connection: {
        status: snap.status, ping: snap.ping, attempt: snap.attempt, retryAt: snap.retryAt,
        lastError: snap.lastError, everOnline: cur.everOnline || snap.status === 'online',
      },
    });
  });
  net.on('clock', (c) => store.set({ clock: { offset: c.offset, rtt: c.rtt, synced: c.synced } }));
  net.on('welcome', onWelcome);
  net.on('helloError', (err) => toastError(err));
  net.on('replaced', () => toast('此设备的该账号已在另一页面恢复，本页已断开', 'info', { ttl: 6000 }));
  net.on('kicked', () => {
    closeAllDialogs();
    void alertDialog({ title: t('连接已断开'), micro: 'ADMIN ACTION', text: t('你已被管理员下线。当前页面不会自动重连；如需继续游戏，请主动点击重新连接。') });
  });
  net.on('announcement.updated', ({ announcement }) => acceptAnnouncement(announcement));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  net.on('room.matchCancelled', (msg) => {
    if (store.get().room?.matchCandidate?.id !== msg.candidateId) return;
    toast(t('{reason}；{status}', { reason: msg.reason, status: t(msg.requeued ? '原队伍已安全返回匹配队列' : '原队伍保留，请重新发起匹配') }), 'warn', { ttl: 6000 });
  });
  net.on('spectator.state', (msg) => {
    clearTimeout(restoreTimer);
    store.set({ spectator: payload(msg), room: null, match: emptyMatch(), matchChat: { matchId: null, items: [] } });
    matchDismissed = false;
    store.patch('ui', { restoring: false });
    warmGameData();
  });
  net.on('spectator.bench', (msg) => {
    const s = store.get();
    // 观众与局内查看队友共用这条只读棋盘消息；匹配目标由 MatchScreen 校验。
    if (matchDismissed || (!s.spectator && !s.room?.inMatch)) return;
    store.patch('match', { watchBench: payload(msg) });
  });
  net.on('spectator.closed', (msg) => {
    backToLobby();
    if (msg.reason !== 'left') toast(t('观战对局已结束，已返回大厅'), 'info');
  });
  net.on('recruitment.snapshot', (msg) => {
    store.set({ recruitment: { rooms: Array.isArray(msg.rooms) ? msg.rooms : [] } });
  });
  net.on('chat.history', (msg) => {
    const items = Array.isArray(msg.items) ? msg.items.slice(-50) : [];
    if (msg.channel === 'match') store.set({ matchChat: { matchId: msg.matchId, items } });
    else store.set({ chat: { items } });
  });
  net.on('chat.message', (msg) => {
    if (!msg || typeof msg.id !== 'string' || !['text', 'invite'].includes(msg.kind)) return;
    const key = msg.channel === 'match' ? 'matchChat' : 'chat';
    if (key === 'matchChat' && store.get().matchChat.matchId !== msg.matchId) return;
    store.set((s) => ({ [key]: { ...s[key], items: [...(s[key]?.items || []).filter((item) => item.id !== msg.id).slice(-49), msg] } }));
  });
  net.on('rank.me', (msg) => { store.set({ rank: payload(msg) }); });
  net.on('room.closed', (msg) => {
    // 超时移除后的合法结算会紧随 room.closed 重播，不能一概拦截。
    backToLobby(true);
    toast(t(CLOSE_REASON[msg.reason]) || (typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭')), 'warn');
  });
  net.on('m.public', (msg) => {
    const s = store.get();
    if (matchDismissed || (!s.room?.inMatch && !s.spectator && msg.phase !== 'RESULT')) return;
    matchAt = Date.now(); store.patch('match', { public: payload(msg) }); maybeFinishRestore();
  });
  net.on('m.private', (msg) => {
    if (matchDismissed || !store.get().room?.inMatch) return;
    matchAt = Date.now(); store.patch('match', { private: payload(msg) });
  });
  net.on('m.field', (msg) => {
    const s = store.get();
    if (matchDismissed || (!s.room?.inMatch && !s.spectator)) return;
    store.patch('match', { field: payload(msg) });
  });
  net.on('m.result', (msg) => {
    if (matchDismissed) return;
    const result = payload(msg);
    const s = store.get();
    store.patch('match', { result });
    recordResult(result, { myId: s.me.playerId, roomMode: s.room?.mode, now: Date.now() });
  });
  net.on('m.toast', (msg) => {
    const kind = ['info', 'success', 'warn', 'error'].includes(msg.kind) ? msg.kind : 'info';
    toast(translateWire(msg), kind);
  });
  net.on('m.ticker', (msg) => {
    if (typeof msg.text !== 'string') return;
    // type, player + the round it came in: a BOSS_HIT line is dropped once its boss round is over and superseded by the
    // same player's next one (ui/ticker.js tickerLineLive / tickerSupersedes)
    const type = typeof msg.type === 'string' ? msg.type : null;
    const playerId = typeof msg.playerId === 'string' ? msg.playerId : null;
    // its broadcast priority: the strip plays the highest first (ui/ticker.js enqueueTickerLines)
    const priority = Number.isFinite(msg.priority) ? msg.priority : 0;
    store.set((s) => ({ ticker: [...s.ticker.slice(-(TICKER_KEEP - 1)), { id: ++seq, text: tickerText(msg), at: Date.now(), type, playerId, round: s.match?.public?.round ?? null, priority }] }));
  });
  net.on('m.emote', (msg) => {
    store.set((s) => ({ emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, id: msg.id, at: Date.now() }] }));
  });

  // Entering (title → lobby) while already online also needs the deep-link join.
  store.subscribe((s, prev) => {
    // 已主动清空/离开旧局后，不让仍在途的旧帧恢复它；新局/观战确认会重新开放。
    if ((prev.match.public && !s.match.public) || (prev.room?.inMatch && !s.room) || (prev.spectator && !s.spectator)) matchDismissed = true;
    if (s.session.entered && !prev.session.entered) schedulePendingJoin();
    // in a room (co-op or solo, also a resumed one) a match is near: its data starts downloading
    if (s.room && !prev.room) warmGameData();
    if (s.match.private !== prev.match.private || s.match.watchBench !== prev.match.watchBench ||
        s.match.field !== prev.match.field || s.match.public?.bossId !== prev.match.public?.bossId ||
        s.match.public?.phase !== prev.match.public?.phase) scheduleMatchPrefetch();
  });
}

/**
 * Download every data file of the match UI (gameComponents GAME_FILES: operators, skills, bonds, items, enemies, 特质 …)
 * in the background once the player is in a room — a match is near (the lobby alone never downloads them). The game's
 * texts are static data loaded once per page — never fetched during a match — and the match screen waits for these
 * files, so with them warmed it opens at once and no text ever appears late (user playtest #3 item 9). Idempotent (the
 * data store shares each file's promise).
 */
function warmGameData() {
  const go = () => { const s = store.get(); if ((s.room?.content ?? s.spectator?.content)?.vanilla === false) return; data.loadAll(GAME_FILES).then(scheduleMatchPrefetch).catch(() => {}); };
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(go, { timeout: 2500 });
  else setTimeout(go, 600);
}

let matchPrefetchPending = false;
let matchResourceKey = '';
function scheduleMatchPrefetch() {
  if (matchPrefetchPending) return;
  const current = store.get();
  if (!current.room && !current.match.private && !current.match.watchBench && !current.match.field && !current.match.public) {
    matchResourceKey = '';
    return;
  }
  matchPrefetchPending = true;
  // 合并同轮 store 更新；只下载文件，不等待解析或暂停战斗 runner。
  setTimeout(async () => {
    try {
      await data.loadAll(GAME_FILES);
      const s = store.get();
      assets.seed(data.getRaw('assets'));
      assets.seedLocal(data.get('local'));
      const urls = collectMatchResourceUrls(assets, data, s.match, { prepareBoard: !!s.room }).sort();
      const key = JSON.stringify(urls);
      if (key === matchResourceKey) return;
      matchResourceKey = key;
      // 不占住调度器等待网络：新商店或新战场可立即加入预取队列。
      void resourceCache.prefetchRequired(urls, { priority: 1 }).then((ok) => {
        if (!ok && matchResourceKey === key) matchResourceKey = '';
      }).catch(() => { if (matchResourceKey === key) matchResourceKey = ''; });
    } catch { /* 数据稍后由 warmGameData 或下一次状态更新重试。 */ }
    finally { matchPrefetchPending = false; }
  }, 0);
}

// ---- UI chrome (the connection banner lives in ui/connBanner.js) -----------------------------------

function ScreenCrashed({ error, reset }) {
  return html`<div class="screen crash">
    <div class="crash__box brackets">
      <${MicroLabel} tone="mint">SYSTEM FAULT<//>
      <h2>${t('界面发生错误')}</h2>
      <p class="t-lo">${String(error?.message || error).slice(0, 200)}</p>
      <${Button} variant="primary" icon="refresh" onClick=${reset}>${t('重新加载界面')}<//>
    </div>
  </div>`;
}

function App() {
  useLang();
  const route = useStore(selectRoute);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('sp-social-portrait', route !== 'title');
    return () => document.documentElement.classList.remove('sp-social-portrait');
  }, [route]);
  const [error, resetError] = useErrorBoundary((err) => { console.error('[ui] screen crashed', err); recordError('error', err, 'screen crashed'); });
  const Screen = SCREENS[route] || LobbyScreen;
  return html`<div class="app-root">
    <div class="app-bg" aria-hidden="true"></div>
    ${error ? html`<${ScreenCrashed} error=${error} reset=${resetError} />` : html`<${Screen} key=${route} />`}
    <${ConnectionBanner} />
    <${AnnouncementBanner} />
    <${ToastHost} />
    <${UiHosts} />
    <${GuideHost} />
    <${LoadoutHost} />
    <${StatsHost} />
    <${ResourcePreloadHost} />
  </div>`;
}

// ---- boot -----------------------------------------------------------------------------------------

async function waitForFonts(ms) {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const loads = [
    fonts.load('900 1em "Noto Sans SC"', '卫戍协议盟约'),
    fonts.load('700 1em "Noto Sans SC"', '开始'),
    fonts.load('700 1em Bender', '0123456789'),
    fonts.load('700 1em Rajdhani', '0123456789'),
  ].map((p) => p.catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))]);
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    const err = ev.reason;
    // Media autoplay/abort rejections (audio.play() before a user gesture, interrupted loads) are
    // expected browser behaviour, not app errors: log quietly, never toast.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) { console.warn('[app] ignored rejection', err.name); return; }
    console.error('[app] unhandled rejection', err);
    if (!(err instanceof NetError)) recordError('rejection', err);
    if (err instanceof NetError) toastError(err);
    else toast(t('发生意外错误：{reason}', { reason: describeError(err) }).slice(0, 120), 'error');
  });
  window.addEventListener('error', (ev) => {
    if (!(ev instanceof ErrorEvent)) return; // resource load errors are not script errors
    console.error('[app] uncaught error', ev.error || ev.message);
    recordError('error', ev.error || ev.message, ev.error ? null : `${ev.filename || '?'}:${ev.lineno || 0}:${ev.colno || 0}`);
  });
}

async function boot() {
  const handoff = consumeServerHandoff(sanitizeName);
  installGlobalErrorHandlers();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  loadRankedPref();
  // A page restored from the back/forward cache has a dead socket and a stale token choice: start over.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  // Pick this tab's reconnect token (asks other live tabs; ≤150 ms) while fonts load.
  const resourceReady = initResourceCache();
  const identityReady = identity.init({ handoff });
  // 目录与身份/资源并行准备，仍在身份选择完成后才创建游戏连接。
  const directoryReady = loadServers();

  const pendingJoin = handoff ? handoff.join || null : parseRoomTarget(parseRoomParam(location.search));
  const savedName = sanitizeName(identity.loadName());
  const entered = identity.wasEntered() && !!savedName;
  store.set((s) => ({
    me: { ...s.me, name: savedName },
    session: { entered: false },
    ui: { ...s.ui, pendingJoin },
  }));

  installContent({ toast });
  installContentSet({ toast });
  wireNet();
  installStatsRecorder(store);
  installLoadoutSync({ net });
  installOwnershipSync({ net });
  installDiySync({ net });
  installSkinsSync({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM follows the route / match phase (js/audio.js).
  installAudio({ getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute, settings: settingsStore.get(), onFailed: (url) => cosmetics.fail(url) });
  cosmetics.subscribe(() => audio.refreshBgm());
  data.load('assets').catch(() => {});
  // Warm the data cache in the background (missing files are tolerated).
  data.loadAll('config').catch(() => {});
  // Optional local-client art manifest (emotes, tutorial pages, official UI sprites; DESIGN §13).
  data.load('local').catch(() => {});

  const connectWhenReady = identityReady.then(async () => {
    if (!await prepareServerConnection(directoryReady)) return;
    // Neither a saved tab flag nor ordinary login may bypass the actual local-resource check.
    if (entered) void enterSession(savedName);
    net.connect();
  });
  // The title screen does not depend on the server directory, IndexedDB scan, fonts, or a language pack.
  // Waiting for all four here made a slow / unavailable directory (up to 8 s) look like a stuck progress bar.
  // Start those jobs in parallel, but let the first render happen immediately with the built-in Chinese strings
  // and CSS fallback fonts.  The language hook and connection/store subscriptions update the mounted app when
  // their background work completes; resource errors remain visible in the resource manager instead of blocking boot.
  void Promise.allSettled([waitForFonts(1200), connectWhenReady, initLang(), resourceReady]);
  const root = document.getElementById('app');
  render(html`<${App} />`, root);
  appMounted = true;
  // Bulk resource preloads begin only when the player starts them in the resource manager.
  void loadServers();
  if (handoff?.join && handoff.join.serverId !== net.serverId && net.status === 'online') {
    clearPendingJoin(); toast('切服入房目标与当前服务器不匹配', 'error');
  } else schedulePendingJoin();

  const splash = document.getElementById('boot');
  if (splash) {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 300);
  }
  globalThis.__SP__ = { store, net, data, version: 1 };
  // A page keeps the modules it imported at load time for its whole lifetime, so a deploy cannot reach an open tab
  // (ui/buildGuard.js): watch `/healthz.build`. Outside a match the page reloads itself; during a match the guard says
  // so instead (the connection banner offers 刷新页面) and reloads once the match — settlement screen included — is over,
  // so a running game is never thrown away.
  try {
    startBuildGuard({
      inMatch: () => selectRoute(store.get()) === 'game',
      onStale: ({ waiting }) => { if (waiting) store.patch('ui', { buildStale: true }); },
    });
  } catch (err) {
    console.warn('[app] build guard failed to start', err);
  }
}

boot().catch((err) => {
  console.error('[app] boot failed', err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = t('启动失败，请刷新页面重试');
});
