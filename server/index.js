/* eslint-disable no-unsafe-finally */
// server/index.js — process entry & boot (DESIGN §1, §2).
//
//   * node:http static server:  /        → public/      (index.html for directories)
//                                /data/   → data/        (generated game data)
//                                /shared/ → shared/      (ESM shared with the browser)
//                                /sim/    → server/sim/  (the battle simulation, read-only, `.js` only — client-side
//                                                         combat, DESIGN §14; the Node-only loader nodeData.js is not served)
//                                /data.js → a generated browser stand-in of server/data.js (the sim's content modules
//                                           import `../../../data.js`; in the browser it serves the data injected with
//                                           /sim/simdata.js setSimData). No other server file is ever served.
//                                /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 — the same audio files, addressed
//                                           **without** an extension so download managers (IDM / 迅雷 …) stop popping a
//                                           "下载文件信息" dialog for every BGM track (shared/media.js, public/js/media.js)
//     MIME types incl. .mjs/.js text/javascript, .skel application/octet-stream, .atlas text/plain;
//     gzip for text-like types, .skel and uncompressed fonts when the client accepts it (small files are
//     compressed once and cached in memory); strong ETag + Last-Modified with 304s; Cache-Control
//     (html & code/data: no-cache + revalidate; 资源以内容SHA-256校验并复用HTTP缓存，代码`?v=` URL: immutable);
//     single byte-range requests (206/416, used by <audio>); traversal & dotfile protection; 404 page.
//   * GET /healthz → JSON status (protocol `version`, release `app`, rooms, matches, sessions, sockets).
//   * WebSocket (ws) at /ws, maxPayload 64 KB → server/net.js Network → server/lobby.js Lobby.
//   * Env: PORT (default 3000), HOST (default 0.0.0.0), TRUST_PROXY ('auto' default: honour CF-Connecting-IP /
//     X-Real-IP / X-Forwarded-For only from loopback/private peers such as a local cloudflared; '1' always; '0' never).
//     Prints LAN URLs on boot.
//   * Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
//     (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//   * Graceful shutdown on SIGINT/SIGTERM (rooms get room.closed{reason:'shutdown'}, sockets close 1001).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS, sendSession } from './net.js';
import { Lobby } from './lobby.js';
import { defaultRankedStore } from './rankedStore.js';
import { defaultHistoryStore } from './historyStore.js';
import { defaultPlayerStore } from './playerStore.js';
import { profileConfig, createProfileAccess, profileRpcHandler } from './profileService.js';
import { startAdmin } from './admin.js';
import { getData, loadData } from './data.js';
import { APP_VERSION } from '../shared/constants.js';
import { createPluginRegistry } from './plugins/registry.js';
import { computeVanillaContent } from './plugins/identity.js';
import { createVisualSets } from './plugins/visualSet.js';
import { createContentSets } from './plugins/contentSets.js';
import { createPluginPolicy } from './plugins/policy.js';
import { createRoomSets } from './plugins/roomSets.js';
import { createMatchHosts } from './match/host/index.js';
import { createStudio } from './studio/index.js';
import { createPluginHttp } from './plugins/http.js';
import { SimulationPool, workerSettings } from './workers/pool.js';
import { Persister, restoreServer, PERSIST_VERSION } from './persist.js';
import { FileStateStore } from './stateFile.js';
import { SNAPSHOT_VERSION } from './match/snapshot.js';

import { ROOT, WS_MAX_PAYLOAD, noopLog } from "./http/config.js";
import { buildTag, resetBuildTag } from "./http/build.js";
import { splitUrl, installHttpSocketCleanup, rejectHttpSocket } from "./http/common.js";
import { createStaticHandler, DATA_SHIM_JS } from "./http/static.js";
import { createRequestHandler } from "./http/routes.js";
import { siteCsp } from './http/csp.js';
import { createTrafficCounter } from './http/traffic.js';
import { narrowDeflateOffer, meterSocket } from './http/websocketCompat.js';
import { applyPendingUpdate } from './update.js';

export { ROOT, WS_MAX_PAYLOAD } from "./http/config.js";
export { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from "./http/build.js";
export { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from "./http/files.js";
export { DATA_SHIM_JS, createStaticHandler } from "./http/static.js";

// ---------------------------------------------------------------------------------------------------
// Server assembly
// ---------------------------------------------------------------------------------------------------

/** Non-internal IPv4 addresses as http URLs. @param {number} port */
export function lanUrls(port) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, simDir?: string, packsDir?: string,
 *   ranked?: import('./rankedStore.js').RankedStore, players?: import('./playerStore.js').PlayerStore,
 *   accountFile?: string | null,
 *   admin?: object | null | false,
 *   MatchClass?: Function, seedFn?: () => number, history?: import('./historyStore.js').HistoryStore,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   bandwidthMbps?: 3 | 5,
 * }} [opts]
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: WebSocketServer,
 *                     lobby: Lobby, network: Network, registry: SessionRegistry, close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  const log = opts.log || makeLogger(!!opts.quiet);
  const config = opts.profileConfig || profileConfig();
  const publicDir = opts.publicDir || path.join(ROOT, 'public');
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const sharedDir = opts.sharedDir || path.join(ROOT, 'shared');
  // The per-port private directory survives local and service restarts; ephemeral port callers opt in explicitly.
  const stateFile = opts.stateFile !== undefined ? opts.stateFile
    : process.env.SP_STATE_FILE ?? (port ? path.join(ROOT, '.state', `server-${port}`) : null);
  if (stateFile && stateFile !== 'off') {
    const target = path.resolve(stateFile);
    for (const root of [publicDir, dataDir, sharedDir, opts.simDir || path.join(ROOT, 'server', 'sim'),
      opts.packsDir || path.join(ROOT, 'packs')]) {
      const relative = path.relative(path.resolve(root), target);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('SP_STATE_FILE must be outside public static directories');
      }
    }
  }
  const store = opts.store !== undefined ? opts.store
    : stateFile && stateFile !== 'off' ? new FileStateStore({ file: stateFile, log }) : null;

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const netOptions = {};
  for (const k of ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
    'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy', 'bandwidthMbps']) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  // 游戏 WS 预算按角色设默认档，HTTP 下载和档案 RPC 独立。
  netOptions.bandwidthMbps ??= Number(process.env.SP_BANDWIDTH_MBPS || (config.role === 'main' ? 5 : 3));
  if (![3, 5].includes(netOptions.bandwidthMbps)) throw new RangeError('SP_BANDWIDTH_MBPS must be 3 or 5');
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = {};
  for (const k of ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs', 'testMode']) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  const stores = {
    ranked: opts.ranked !== undefined ? opts.ranked : defaultRankedStore(log),
    history: opts.history !== undefined ? opts.history : defaultHistoryStore(log),
    players: opts.players !== undefined ? opts.players : defaultPlayerStore(log),
  };
  const profiles = createProfileAccess({ ...config,
    getData: () => data,
    accountFile: opts.accountFile !== undefined ? opts.accountFile : (opts.env || process.env).ACCOUNT_AUTH_FILE || undefined,
    announcementFile: opts.announcementFile !== undefined ? opts.announcementFile : isMain() ? path.join(publicDir, 'announcement.json') : null,
    announcementInitialFile: path.join(publicDir, 'announcement.json'),
  }, stores, log);
  const ownsWorkerPool = opts.workerPool === undefined;
  const settings = workerSettings(opts.env || process.env);
  const workerPool = ownsWorkerPool ? (settings.size ? new SimulationPool({ data, ...settings }) : null) : opts.workerPool;
  const packsDir = opts.packsDir || path.join(ROOT,'packs');
  const pluginsDir = opts.pluginsDir || path.join(ROOT,'plugins');
  const simDir = opts.simDir || path.join(ROOT,'server','sim');
  const scriptMode = process.env.SP_PLUGIN_SCRIPTS === 'sandbox' ? 'sandbox' : 'off';
  const packs = createPluginRegistry({publicDir,dataDir,sharedDir,simDir,packsDir,pluginsDir},{log,scriptHost:host,scriptMode});
  const content = computeVanillaContent({simDir,sharedDir,dataDir,shim:DATA_SHIM_JS,log});
  const visual = createVisualSets({registry:packs,log});
  const policy = createPluginPolicy({pluginsDir,log});
  const contents = createContentSets({registry:packs,vanillaData:data,log,maxSets:()=>policy.get().maxSets});
  const roomSets = createRoomSets({registry:packs,visual,contents,policy});
  const hosts = createMatchHosts({contents,log,options:opts.matchHost || {}});
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions,
    ranked: profiles.ranked, history: profiles.history, players: profiles.players, profiles, serverId: config.id, workerPool, content, plugins:roomSets, hosts });
  const testGate = lobby.setTestHost(host);
  if (testGate.warn) log.warn(testGate.warn);
  let persister = null;
  profiles.onRecovered = (job, value) => lobby.onRecoveredResult(job, value);
  const adminStateSource = profiles.bindAdmin(lobby, registry);
  const flushStores = async () => {
    const results = await Promise.allSettled([lobby.players, lobby.history, lobby.ranked]
      .map((store) => store?.flush?.()));
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'store flush failed');
  };
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  profiles.bindNetwork(network, (frame) => {
    for (const peer of registry.all()) {
      if (!peer.connected) continue;
      if (peer.initializingChat) (peer.pendingChat ||= []).push(frame);
      else sendSession(peer, frame);
    }
  });
  const pluginHttp = createPluginHttp({registry:packs,content,visual,contents,log});
  const serveStatic = createStaticHandler({publicDir,dataDir,sharedDir,simDir,packsDir,pluginsDir,packs,pluginHttp,log});
  const studio = opts.studio === false ? null : createStudio({publicDir,pluginsDir,dataDir,registry:packs,lobby,sessions:registry,log,mode:process.env.SP_STUDIO === 'off' ? 'off' : 'local',fetch:opts.fetch});
  const startedAt = Date.now();
  const traffic = createTrafficCounter();
  const csp = siteCsp(publicDir, [config.mainUrl, config.secondaryUrl]);
  // Accept existing deployments' password setting as an enable flag only.
  const adminEnabled = process.env.ADMIN_ENABLED === '1' || (process.env.ADMIN_ENABLED !== '0'
    && (process.env.ADMIN_PORT || process.env.ADMIN_PASSWORD_HASH));
  const adminOpts = opts.admin !== undefined ? opts.admin : (adminEnabled ? {
    tls: process.env.ADMIN_TLS_KEY && process.env.ADMIN_TLS_CERT ? {
      key: fs.readFileSync(process.env.ADMIN_TLS_KEY), cert: fs.readFileSync(process.env.ADMIN_TLS_CERT),
    } : null,
    port: Number(process.env.ADMIN_PORT || 56129), host: process.env.ADMIN_HOST || '0.0.0.0',
  } : null);
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag();

  const server = http.createServer(createRequestHandler({ serveStatic, startedAt, network, registry, lobby, log, studio, traffic, csp,
    trustProxy: netOptions.trustProxy,
    pageEntry: () => config.role === 'secondary' ? config.mainUrl : null,
    announcement: () => profiles.announcement(),
    directory: () => profiles.directory(), profileRpc: profileRpcHandler(config, profiles.authority, log) }));
  installHttpSocketCleanup(server);

  server.on('clientError', (err, socket) => {
    if (err && err.code === 'ECONNRESET') { socket.destroy(); return; }
    rejectHttpSocket(socket, 400, 'Bad Request');
  });

  const wss = new WebSocketServer({
    noServer: true, maxPayload: WS_MAX_PAYLOAD, clientTracking: false,
    perMessageDeflate: {
      serverNoContextTakeover: true, clientNoContextTakeover: true,
      threshold: 192, concurrencyLimit: 4,
      zlibDeflateOptions: { level: 9, memLevel: 7 },
      zlibInflateOptions: { chunkSize: 16 * 1024 },
    },
  });
  log.info(`[net] WebSocket bandwidth profile: ${netOptions.bandwidthMbps} Mbps (80% target; downloads excluded)`);
  wss.on('connection', (ws, req) => { meterSocket(ws, req, traffic); network.handleConnection(ws, req); });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => rejectHttpSocket(socket, status, text);
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    if (narrowDeflateOffer(req.headers['sec-websocket-extensions'])) delete req.headers['sec-websocket-extensions'];
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });

  try {
    if (config.role === 'main') lobby.players?.mergeExisting?.(lobby.ranked, stores.history);
    await profiles.ready();
    if (store) {
      const doc = await store.load?.();
      if (doc && opts.resume !== false) {
        const restored = await restoreServer({ doc, registry, lobby, log });
        if (!restored.ok) throw new Error(`state snapshot incompatible (${restored.reason}); original state preserved`);
        log.info(`[persist] restored ${restored.sessions} sessions, ${restored.rooms} rooms, ${restored.matches} matches`);
      } else if (doc && (doc.v !== PERSIST_VERSION || (doc.snapshot != null && doc.snapshot !== SNAPSHOT_VERSION)
          || Object.values(doc.matches || {}).some((checkpoint) => checkpoint && checkpoint.v !== SNAPSHOT_VERSION))) {
        throw new Error('state snapshot incompatible; original state preserved');
      }
      persister = new Persister({ store, registry, lobby, log, saveMs: opts.saveMs ?? process.env.SP_STATE_SAVE_MS });
    }
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    profiles.close();
    studio?.close(); hosts.close(); contents.close(); visual.close?.();
    lobby.shutdown('shutdown');
    network.close(); // stop heartbeat/sweep timers of the half-built server
    await Promise.allSettled([persister?.dispose(), store?.close?.(), ownsWorkerPool ? workerPool?.close?.() : null, flushStores()]);
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  let admin = null;
  if (adminOpts) {
    try { admin = await startAdmin({ lobby, registry, players: lobby.players, log, ...adminOpts,
      stateSource: adminStateSource, controls: profiles.adminControls }); }
    catch (error) {
      profiles.close();
      studio?.close(); hosts.close(); contents.close(); visual.close?.();
      lobby.shutdown('shutdown');
      network.close();
      await new Promise((resolve) => server.close(resolve));
      wss.close();
      await Promise.allSettled([persister?.dispose(), store?.close?.(), ownsWorkerPool ? workerPool?.close?.() : null, flushStores()]);
      throw error;
    }
  }

  profiles.start(registry, (aid) => lobby.onProfileRefresh(aid));
  persister?.start();
  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try {
        const incoming = network.beginDrain();
        lobby.beginDrain();
        await incoming;
        await Promise.all([...lobby.rooms.values()].filter(room=>room.match?.hosted).map(room=>room.match.beginDrain()));
        const settled = await profiles.drain();
        if (settled) await Promise.allSettled([...lobby.rooms.values()].map((room) => room.match?.finishPromise));
        if (persister && !await persister.shutdown('shutdown')) throw new Error('final server state was not saved');
      } finally { // eslint-disable-line no-unsafe-finally
        profiles.close();
        studio?.close();
        try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
        hosts.close(); contents.close(); visual.close?.();
        network.close();
        try {
          if (admin) await admin.close();
        } finally { // eslint-disable-line no-unsafe-finally
          await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections?.();
            setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
          });
          try { wss.close(); } catch { /* ignore */ }
          const results = await Promise.allSettled([persister?.dispose(), flushStores(), store?.close?.(),
            ownsWorkerPool ? workerPool?.close?.() : null]);
          const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
          if (errors.length) throw new AggregateError(errors, 'shutdown cleanup failed');
        }
      }
    })();
    return closing;
  }

  return { port: actualPort, host, url, server, wss, lobby, network, registry, admin, workerPool, store, persister, packs, content, visual, contents, hosts, studio, traffic, close };
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  if (applyPendingUpdate(ROOT).state === 'failed') { process.exitCode = 1; return; }
  process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[process] uncaught exception', e));
  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`端口已被占用 / port in use: ${e.port ?? process.env.PORT ?? 3000}. Try PORT=3001 npm start`);
    else console.error('[boot] failed to start', e);
    process.exit(1);
  }
  console.log(`\n  卫戍协议：盟约 · Stronghold Protocol: Alliance v${APP_VERSION}`);
  console.log(`  Local:   ${srv.url}`);
  if (srv.host === '0.0.0.0' || srv.host === '::') {
    for (const u of lanUrls(srv.port)) console.log(`  LAN:     ${u}`);
  }
  console.log('  Internet: cloudflared tunnel --url ' + `http://localhost:${srv.port}` + '\n');

  // Serve players first; resume the frozen memorial-card cohort after startup.
  if (srv.lobby.profiles?.authority) {
    const grantMemorialCards = () => {
      void srv.lobby.profiles.authority.migrateTricksterNameCards()
        .then((report) => console.log('[profiles] 捣蛋鬼出没玩家纪念发放', {
          total: report.total, granted: report.granted.length, deferred: report.deferredAids.length,
        }))
        .catch((error) => console.error('[profiles] 捣蛋鬼出没发放暂停；重启后继续', error));
    };
    setTimeout(grantMemorialCards, 30_000).unref();
  }

  let stopping = false;
  const stop = (signal) => {
    if (stopping) { console.log('[shutdown] waiting for store flush'); return; }
    stopping = true;
    console.log(`\n[${signal}] shutting down…`);
    srv.close().then(() => process.exit(0), (error) => {
      console.error('[shutdown] failed', error);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (isMain()) main();
