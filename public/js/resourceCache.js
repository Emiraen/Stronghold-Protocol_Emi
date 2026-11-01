import { mediaUrl } from './media.js';
import { PRELOAD_CDN_ORIGIN, preloadPackGroup, readPreloadRange, fetchPreloadManifest } from './preloadSources.js';
import { SOUTH_PRELOAD_ORIGIN, SOUTH_PRELOAD_HTTPS_ORIGIN } from './serverOrigins.js';
import { consumePreloadStream, resourceFilename, storedPreloadCursor, savePreloadCursor } from './resourceResume.js';

const GROUPS = ['required', 'optional', 'voice'];
const STORE = 'resources';
const listeners = new Set();
let entries = new Map();
let aliases = new Map();
const complete = new Set();
const savedBytes = new Map();
// Received bytes are display-only until the IndexedDB transaction commits.
const receiving = new Map();
function receivingProgress(item, bytes) {
  if (complete.has(item.key) || !bytes) receiving.delete(item.key);
  else receiving.set(item.key, { item, bytes: Math.min(item.bytes, Math.max(0, bytes)) });
  notifyProgress();
}
function pendingBytes(item) {
  return complete.has(item.key) ? 0 : Math.max(0, (receiving.get(item.key)?.bytes || 0) - (savedBytes.get(item.key) || 0));
}
const objectUrls = new Map();
const cachedReadJobs = new Map();
const cachedReadQueue = new Map();
const OBJECT_URL_CACHE_BYTES = 32 * 1024 * 1024;
const onlineRequiredBlobs = new Map();
const jobs = new Map();
const slots = [];
let active = 0;
let activePreloads = 0;
let progressTimer;
let manifestPromise;
let manifest;
let dbPromise;
let sessionInitPromise;
let startupPreloadStarted = false;
let checkPromise;
let scanChanges;
let checkedRevision = -1;
let ready = false;
let revision = 0;
let persistPromise;
export const WIN7_RESOURCE_ORIGIN = 'https://u75731.nyat.app:48335';
export const CDN_RESOURCE_ORIGIN = PRELOAD_CDN_ORIGIN;

// Rewrite IO only: canonical cache keys stay tied to the game URL so existing verified caches are reused.
export function win7ResourceUrl(url) {
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    if (!/^https?:$/.test(parsed.protocol) || !/^\/(?:assets|media|data|p)\//.test(parsed.pathname)) return null;
    return new URL(parsed.pathname + parsed.search, WIN7_RESOURCE_ORIGIN).href;
  } catch { return null; }
}

const CURRENT_RANK_RESOURCE_PATHS = new Set(["/assets/ranks/ascendant_1.png","/assets/ranks/ascendant_2.png","/assets/ranks/ascendant_3.png","/assets/ranks/bronze_1.png","/assets/ranks/bronze_2.png","/assets/ranks/bronze_3.png","/assets/ranks/diamond_1.png","/assets/ranks/diamond_2.png","/assets/ranks/diamond_3.png","/assets/ranks/gold_1.png","/assets/ranks/gold_2.png","/assets/ranks/gold_3.png","/assets/ranks/immortal_1.png","/assets/ranks/immortal_2.png","/assets/ranks/immortal_3.png","/assets/ranks/iron_1.png","/assets/ranks/iron_2.png","/assets/ranks/iron_3.png","/assets/ranks/platinum_1.png","/assets/ranks/platinum_2.png","/assets/ranks/platinum_3.png","/assets/ranks/radiant.png","/assets/ranks/silver_1.png","/assets/ranks/silver_2.png","/assets/ranks/silver_3.png","/assets/ranks/unranked.png"]);
export const SOUTH_RESOURCE_ORIGIN = SOUTH_PRELOAD_HTTPS_ORIGIN;
export const NEW_MAIN_RESOURCE_ORIGIN = 'https://super.emiraen.top:23331';
const LEGACY_PAGE_ORIGIN = 'https://emiraen.top';
const RESOURCE_PROBE_TIMEOUT_MS = 2000;
const PRELOAD_PROBE_TIMEOUT_MS = 10000;
const RESOURCE_FALLBACK_WINDOW_MS = 30000;
const resourceFallbackUntil = new Map();

function preloadResourceOrigin() {
  // HTTPS pages use the resource server's TLS endpoint to avoid mixed content.
  return SOUTH_PRELOAD_HTTPS_ORIGIN;
}

// Public deployments share the resource server; installed LAN builds own their files.
// Canonical cache keys never move when a download origin changes.
function deploymentResourceOrigin() {
  try {
    const url = new URL(globalThis.location?.href || globalThis.location?.origin);
    const publicIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) && !localResourceOrigin();
    return url.origin === LEGACY_PAGE_ORIGIN || url.origin === 'https://emiraen.top:23331' || url.origin === NEW_MAIN_RESOURCE_ORIGIN || publicIp
      ? NEW_MAIN_RESOURCE_ORIGIN : null;
  } catch { return null; }
}

// Installed LAN builds own their files and preload index. Public deployments keep
// their established remote routing and pack metadata.
export function localResourceOrigin() {
  try {
    const url = new URL(globalThis.location?.href || globalThis.location?.origin);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.origin === SOUTH_PRELOAD_ORIGIN) return url.origin;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const parts = host.split('.').map(Number);
    const ipv4 = parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
    const privateIp = ipv4 && (parts[0] === 127 || parts[0] === 10
      || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
      || parts[0] === 169 && parts[1] === 254);
    const privateHost = host === '::1' || /^[a-z0-9-]+$/.test(host)
      || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan');
    return privateIp || privateHost ? url.origin : null;
  } catch { return null; }
}

function requiredResourceOrigins() {
  return [preloadResourceOrigin(), NEW_MAIN_RESOURCE_ORIGIN];
}

// These files and rebuilt range packs are published together with South's current
// index. An older host may answer the same URL with a stale 200 or a missing-file 404.
function currentSouthResourcePath(path) {
  return /^\/assets\/resource-(?:required(?:-lossless)?|optional|voice)\.sprpack$/.test(path) ||
    /^\/assets\/mizuki\//.test(path) ||
    /^\/assets\/local\/fx\//.test(path) ||
    /^\/(?:assets\/(?:local\/)?audio\/(?:bgm|sfx)|media\/(?:bgm|sfx))\//.test(path) ||
    /^\/assets\/(?:local\/)?spine\/enemy\//.test(path) ||
    /^\/assets\/local\/(?:map|scene|mesh\/(?:map_autochess_bkg|s_background_common|s_common_box_01|s_wind_device|trap_110))\//.test(path);
}

export async function fetchResourceData(url, options = {}, { requiredOnline = false, preload = false } = {}) {
  const target = win7ResourceUrl(url);
  if (!target) throw new Error(`资源地址不可用：${url}`);
  const signal = options.signal;
  const cancelled = () => {
    if (signal?.aborted) throw signal.reason || new DOMException('请求已取消', 'AbortError');
  };
  cancelled();
  const init = { ...options, credentials: 'omit', redirect: 'error', mode: 'cors' };
  const finalOrigin = deploymentResourceOrigin();
  const localOrigin = localResourceOrigin();
  if (localOrigin) {
    const local = new URL(target);
    return fetch(new URL(local.pathname + local.search, localOrigin).href,
      { ...options, credentials: 'same-origin', redirect: 'error', mode: 'same-origin' });
  }
  if (!finalOrigin) return fetch(target, init);
  const targetUrl = new URL(target);
  const path = targetUrl.pathname + targetUrl.search;
  const [preferredOrigin, peerOrigin] = requiredResourceOrigins();
  // Art catalogues are needed by automatic game loading before icons/models.
  if (requiredOnline || !preload && targetUrl.pathname.startsWith('/data/')) {
    return fetchRequiredData(path, init, targetUrl.pathname.startsWith('/data/')
      ? [peerOrigin, preferredOrigin] : [preferredOrigin, peerOrigin]);
  }
  const finalUrl = new URL(path, requiredOnline ? peerOrigin : finalOrigin).href;

  // Foreground probes stay short; explicit preloads allow a busy resource host
  // ten seconds and retry it even after a foreground circuit break. The caller's total timeout
  // and cancellation still bound the full chain, including the final main fetch.
  // Updated maps, Mizuki/audio assets and packs must use the host of the current
  // manifest first. Other foreground IO retains the selected game's routing.
  const currentSouth = currentSouthResourcePath(targetUrl.pathname);
  const southOrigin = preloadResourceOrigin();
  const origins = currentSouth ? [southOrigin, ...(requiredOnline ? [preferredOrigin] : [])]
    : requiredOnline ? [preferredOrigin] : CURRENT_RANK_RESOURCE_PATHS.has(targetUrl.pathname)
      ? [southOrigin] : [southOrigin, WIN7_RESOURCE_ORIGIN];
  for (const origin of origins) {
    if (!preload && Date.now() < (resourceFallbackUntil.get(origin) || 0)) continue;
    cancelled();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new DOMException('资源服务器响应超时', 'TimeoutError')),
      preload ? PRELOAD_PROBE_TIMEOUT_MS : RESOURCE_PROBE_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(new URL(path, origin).href, { ...init, signal: controller.signal });
      cancelled();
      if (response.ok) {
        resourceFallbackUntil.delete(origin);
        // Keep caller cancellation attached after headers for a streaming body.
        if (!response.body) signal?.removeEventListener('abort', abort);
        return response;
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        resourceFallbackUntil.set(origin, Date.now() + RESOURCE_FALLBACK_WINDOW_MS);
      }
      // Do not let draining a failed response consume the next source's time budget.
      try { void response.body?.cancel().catch(() => {}); } catch { /* Continue to the next source. */ }
    } catch (error) {
      cancelled();
      resourceFallbackUntil.set(origin, Date.now() + RESOURCE_FALLBACK_WINDOW_MS);
    } finally {
      clearTimeout(timer);
      if (!response?.ok) signal?.removeEventListener('abort', abort);
    }
  }
  cancelled();
  // Exact path/query/Range and original signal; never recurse through this helper.
  return fetch(finalUrl, init);
}

// In-match delivery must include the body, not just fast headers from a stalled source.
// Keep manual pack preloads on South; missing essential files use both game mirrors first.
async function fetchRequiredData(path, options, origins) {
  let failure, failedResponse;
  const candidates = [...new Set(origins)];
  const available = candidates.filter(origin => Date.now() >= (resourceFallbackUntil.get(origin) || 0));
  for (const origin of available.length ? available : candidates) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('请求已取消', 'AbortError');
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let idleTimer, reader;
    const timeout = () => controller.abort(new DOMException('资源传输超时', 'TimeoutError'));
    const arm = ms => { clearTimeout(idleTimer); idleTimer = setTimeout(timeout, ms); };
    const deadline = setTimeout(timeout, 15000);
    arm(RESOURCE_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, origin).href, { ...options, signal: controller.signal });
      if (!response.ok) {
        try { void response.body?.cancel().catch(() => {}); } catch { /* Continue to the next source. */ }
        failedResponse = new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
        throw Object.assign(new Error('资源下载失败（HTTP ' + response.status + '）'), { status: response.status });
      }
      const chunks = [];
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          arm(3000);
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      resourceFallbackUntil.delete(origin);
      // Browser fetch already decodes HTTP compression. Do not carry the wire length/encoding
      // onto this decoded response, including when a mirror uses Brotli and another uses gzip.
      const headers = new Headers(response.headers);
      headers.delete('Content-Encoding'); headers.delete('Content-Length');
      return new Response(new Blob(chunks), { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      failure = error;
      if (options.signal?.aborted) throw options.signal.reason || error;
      if (!Number.isInteger(error.status) || error.status === 408 || error.status === 429 || error.status >= 500) {
        resourceFallbackUntil.set(origin, Date.now() + RESOURCE_FALLBACK_WINDOW_MS);
      }
    } finally {
      controller.abort();
      if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* Transport already closed. */ } reader.releaseLock(); }
      clearTimeout(idleTimer); clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  if (failedResponse && Number.isInteger(failure?.status)) return failedResponse;
  throw failure || new Error('必要资源服务器暂不可用。');
}

export function win7PortraitUrl(url) {
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    return /^\/assets\/char\/portrait\/(?:skin\/)?[A-Za-z0-9_.-]+\.png$/.test(parsed.pathname) ? win7ResourceUrl(url) : null;
  } catch { return null; }
}

// Kept as no-op exports while old open tabs finish using their imported quality module.
export function hdPortraitUrl() { return null; }
function isHdPortrait(item) { return !!item && /\/assets\/char\/portrait-hd\//.test(item.url); }
// Rank visuals and special-card static previews remain usable without optional animations.
function requiredOnlyAsset(url) {
  try {
    const path = new URL(url, globalThis.location?.href || 'http://localhost/').pathname;
    return /^\/assets\/(?:relics|annihilation-intro)\//.test(path) || CURRENT_RANK_RESOURCE_PATHS.has(path) ||
      /^\/assets\/local\/(?:map|scene|mesh\/(?:map_autochess_bkg|s_background_common|s_common_box_01|s_wind_device|trap_110))\//.test(path) ||
      /^\/assets\/(?:local\/)?spine\/enemy\//.test(path) ||
      /^\/assets\/mizuki\/(?:library\/spines|native-maps|native-board|native-reflections|native-sfx)\//.test(path) ||
      /^\/(?:assets\/(?:local\/)?audio\/sfx|media\/sfx)\//.test(path) ||
      path === '/assets/mizuki/native-audio/manifest.json' ||
      /^\/assets\/local\/playercards\/(?:good-boy|trickster-outbreak|duck-burnard|duck-flower|duck-brioche|paintbrush-tactics|soft-and-deadly|hatchbudz-quacked|commander-bruno)\/poster\.(?:png|webp)$/.test(path) ||
      /^\/assets\/local\/playercards\/evori-(?:solari|lunari|amari|terrari|evori)\/card\.png$/.test(path);
  } catch { return false; }
}
function optionalOnlyAsset(url) {
  try {
    const path = new URL(url, globalThis.location?.href || 'http://localhost/').pathname;
    return /^\/assets\/local\/playercards\/(?:good-boy|trickster-outbreak|duck-burnard|duck-flower|duck-brioche|hatchbudz-quacked|evori-(?:solari|lunari|amari|terrari|evori))\/card\.gif$/.test(path) ||
      /^\/assets\/char\/portrait\/(?:skin\/|[^/]+_2\.png$)/.test(path) ||
      /^\/(?:assets\/(?:local\/)?audio\/bgm|media\/bgm)\//.test(path) ||
      path.startsWith('/assets/mizuki/native-audio/tracks/');
  } catch { return false; }
}
const downloadSources = new Map();
let compressionPromise;
const groupState = () => ({ total: 0, done: 0, bytes: 0, downloadedBytes: 0, running: false, paused: false, error: null });
const state = { checking: false, error: null, missing: null, cacheRevision: 0, storageProtection: null, source: '预载资源优先阿里云企业网盘，失败时自动切换 CDN，文件直接保存到当前浏览器。', required: groupState(), optional: groupState(), voice: groupState(), hdPortraits: groupState(), pack: { running: null, done: 0, total: 0, note: null, error: null } };

function snapshot() {
  const result = { ...state, required: { ...state.required }, optional: { ...state.optional }, voice: { ...state.voice }, hdPortraits: { ...state.hdPortraits }, pack: { ...state.pack } };
  for (const { item } of receiving.values()) for (const group of item.groups) result[group].downloadedBytes += pendingBytes(item);
  return result;
}

function notify() {
  for (const fn of listeners) {
    try { fn(snapshot()); } catch (error) { console.error('资源缓存订阅回调失败', error); }
  }
}

function message(error) {
  if (error?.name === 'QuotaExceededError') return '浏览器存储空间不足，已保存的资源仍保留，请释放空间后重试。';
  if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') return '浏览器无法使用 IndexedDB，请检查隐私模式或存储权限。';
  return error?.message || '资源缓存操作失败，请重试。';
}

function gameHostedRequiredAudio(item) {
  const origin = globalThis.location?.origin;
  // Production manual preloads use shared direct/South routing, including alarm audio.
  if (!origin || deploymentResourceOrigin() || !item?.groups?.includes('required')) return null;
  try {
    const url = new URL(item.url, origin);
    const targetOrigin = origin;
    if (url.pathname === '/media/sfx/battle/b_ui/b_ui_alarmenter') return new URL(url.pathname + url.search, targetOrigin).href;
    if (url.pathname !== '/assets/audio/sfx/battle/b_ui/b_ui_alarmenter.mp3') return null;
    return new URL(mediaUrl(url.href, origin), targetOrigin).href;
  } catch { return null; }
}

function key(url) {
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    // Native map manifests keep [opt]/[ucp] literal, while pack indexes encode
    // those path segments. Unify only brackets; encoded slashes stay distinct.
    parsed.pathname = parsed.pathname.replace(/(?:\[|%5b)/ig, '%5B').replace(/(?:\]|%5d)/ig, '%5D');
    parsed.hash = '';
    return parsed.href;
  } catch { return null; }
}

function resolve(url) {
  const canonical = aliases.get(key(url)) || key(url);
  return entries.get(canonical);
}

function progress() {
  for (const group of [...GROUPS, 'hdPortraits']) {
    const items = group === 'hdPortraits'
      ? selectionItems('optional', { hdPortraits: true }) : selectionItems(group);
    state[group].total = items.length;
    state[group].bytes = items.reduce((n, item) => n + item.bytes, 0);
    state[group].done = items.reduce((n, item) => n + Number(complete.has(item.key)), 0);
    state[group].downloadedBytes = items.reduce((n, item) => n + (savedBytes.get(item.key) || 0), 0);
  }
}

// Cache writes already know the old/new state; do not scan every resource for each small download.
function updateItemProgress(item, bytes, finished) {
  scanChanges?.add(item.key);
  const previous = complete.has(item.key);
  const previousBytes = savedBytes.get(item.key) || 0;
  if (finished) { complete.add(item.key); receiving.delete(item.key); } else complete.delete(item.key);
  savedBytes.set(item.key, bytes);
  for (const group of item.groups) {
    state[group].done += Number(finished) - Number(previous);
    state[group].downloadedBytes += bytes - previousBytes;
  }
  const wasChecked = checkedRevision === revision;
  revision++;
  if (wasChecked) checkedRevision = revision;
  ready = state.required.done === state.required.total;
}

function notifyProgress() {
  if (progressTimer !== undefined) return;
  progressTimer = setTimeout(() => { progressTimer = undefined; notify(); }, 100);
}

function validTransport(transport) {
  return transport !== null && typeof transport === 'object' && !Array.isArray(transport) &&
    Object.keys(transport).length === 3 && typeof transport.version === 'string' && /^[a-f0-9]{64}$/i.test(transport.version) &&
    Number.isSafeInteger(transport.bytes) && transport.bytes > 0 && transport.type === 'image/webp';
}

function sameTransport(transport, expected) {
  return validTransport(transport) && validTransport(expected) && transport.version === expected.version &&
    transport.bytes === expected.bytes && transport.type === expected.type;
}

async function fetchManifestFrom(fetchData) {
  try {
    const response = await fetchData('/data/resource-preload.runtime.json.gz', { cache: 'no-cache' });
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true);
        if (!length || length > 16 * 1024 * 1024) throw new Error('资源清单解压大小异常。');
        return JSON.parse(new TextDecoder().decode(await decompressResource(bytes, length)));
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch { /* Retry the uncompressed manifest when the runtime index is unavailable. */ }
  const response = await fetchData('/data/resource-preload.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`资源清单加载失败（HTTP ${response.status}），请稍后重试。`);
  return response.json();
}

async function fetchManifest() {
  if (localResourceOrigin()) {
    const response = await fetch('/data/resource-preload.local.json', { cache: 'no-cache' });
    if (response.ok) return response.json();
    if (response.status !== 404) throw new Error(`本地资源清单加载失败（HTTP ${response.status}）`);
  }
  // Development and LAN builds only read their own shipped manifest.
  if (!deploymentResourceOrigin()) return fetchManifestFrom((url, options) => fetch(url, options));
  // Both game mirrors ship this index. Empty-cache game loading must not wait
  // for the slower preload host before a single essential asset is delivered.
  try { return await fetchManifestFrom((url, options) => fetchPreloadManifest(url, {
    ...options, onSource: source => { state.source = source; notifyProgress(); },
  })); } catch {
    // Essential gameplay can still load its index during a share/CDN outage.
    return fetchManifestFrom((url, options) => fetchResourceData(url, options, { requiredOnline: true }));
  }
}

function loadManifest() {
  if (!manifestPromise) manifestPromise = (async () => {
    const data = await fetchManifest();
    if (data?.schema !== 1 || !['required', 'voice'].every(group => Array.isArray(data.groups?.[group])) ||
        (data.groups.optional !== undefined && !Array.isArray(data.groups.optional))) {
      throw new Error('资源清单格式不正确，请刷新页面重试。');
    }
    const indexed = new Map();
    const mapped = new Map();
    const groups = Object.fromEntries(GROUPS.map(group => [group, []]));
    const seenGroups = Object.fromEntries(GROUPS.map(group => [group, new Set()]));
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    let sliceStarted = now(), processed = 0;
    for (const group of GROUPS) {
      for (const sourceRaw of data.groups[group] || []) {
        // Keep input/painting responsive while indexing large manifests, including on Win7.
        if (++processed % 64 === 0 && now() - sliceStarted >= 8) {
          await new Promise(resolveYield => setTimeout(resolveYield, 0));
          sliceStarted = now();
        }
        if (isHdPortrait(sourceRaw)) continue;
        const targetGroup = requiredOnlyAsset(sourceRaw.url) ? 'required' : optionalOnlyAsset(sourceRaw.url) ? 'optional' : group;
        const raw = targetGroup !== group && sourceRaw.pack
          ? { ...sourceRaw, pack: { ...sourceRaw.pack, group: sourceRaw.pack.group || group } } : sourceRaw;
        const seen = seenGroups[targetGroup];
        if (typeof raw?.url !== 'string' || !raw.url || typeof raw.version !== 'string' || !raw.version ||
            !Number.isSafeInteger(raw.bytes) || raw.bytes <= 0 || typeof raw.type !== 'string') {
          throw new Error('资源清单条目不完整，请刷新页面重试。');
        }
        if (raw.transport !== undefined && (raw.type !== 'image/png' || !validTransport(raw.transport))) {
          throw new Error('资源清单的无损 WebP 传输元数据不正确，请刷新页面重试。');
        }
        if (raw.pack !== undefined && (!Number.isSafeInteger(raw.pack.offset) || raw.pack.offset < 12 ||
            !Number.isSafeInteger(raw.pack.storedBytes) || raw.pack.storedBytes <= 0 ||
            !Number.isSafeInteger(raw.pack.total) || raw.pack.offset > raw.pack.total - raw.pack.storedBytes ||
            !['gzip', 'identity', 'webp-lossless'].includes(raw.pack.encoding) ||
            (raw.pack.encoding === 'identity' && raw.pack.storedBytes !== raw.bytes) ||
            (raw.pack.encoding === 'webp-lossless' && (!validTransport(raw.transport) || raw.pack.storedBytes !== raw.transport.bytes)) ||
            (raw.pack.group !== undefined && !GROUPS.includes(raw.pack.group)))) {
          throw new Error('资源清单的按需范围索引不正确。');
        }
        const sourceKey = key(raw.url);
        const resourceUrl = mediaUrl(raw.url);
        const canonical = resourceUrl === raw.url ? sourceKey : key(resourceUrl);
        if (!canonical || !/^https?:/.test(canonical)) throw new Error('资源清单包含无效地址。');
        const previous = indexed.get(canonical);
        if (previous && (previous.version !== raw.version || previous.bytes !== raw.bytes || previous.type !== raw.type ||
            ((previous.transport !== undefined || raw.transport !== undefined) && !sameTransport(previous.transport, raw.transport)))) {
          throw new Error('资源清单包含冲突的音频别名或版本。');
        }
        const item = previous || { ...raw, url: resourceUrl, key: canonical, groups: [] };
        if (!previous) indexed.set(canonical, item);
        mapped.set(sourceKey, canonical);
        mapped.set(canonical, canonical);
        const remote = win7ResourceUrl(raw.url);
        if (remote) {
          mapped.set(key(remote), canonical);
          const parsed = new URL(remote);
          for (const origin of [CDN_RESOURCE_ORIGIN, SOUTH_PRELOAD_ORIGIN, SOUTH_PRELOAD_HTTPS_ORIGIN]) {
            mapped.set(key(new URL(parsed.pathname + parsed.search, origin).href), canonical);
          }
        }
        if (!seen.has(canonical)) {
          item.groups.push(targetGroup);
          seen.add(canonical);
          groups[targetGroup].push(item);
        }
      }
    }
    // Publish only the fully validated index; readers must never see a partially built manifest.
    entries = indexed;
    aliases = mapped;
    manifest = { groups, generation: data.generatedAt || '' };
    progress();
    notify();
    return manifest;
  })().catch(error => { manifestPromise = undefined; throw error; });
  return manifestPromise;
}

// 浏览器授权的持久存储可避免空间压力下的自动回收；下载、导入和已有缓存均申请保护。
function protectResources(retry = false) {
  if (persistPromise) return persistPromise;
  if (state.storageProtection === 'persisted' || (!retry && state.storageProtection)) return Promise.resolve();
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== 'function') {
    state.storageProtection = 'unsupported';
    notify();
    return Promise.resolve();
  }
  persistPromise = (async () => {
    try {
      const granted = (typeof storage.persisted === 'function' && await storage.persisted()) || await storage.persist();
      state.storageProtection = granted ? 'persisted' : 'unprotected';
    } catch {
      state.storageProtection = 'unprotected';
    } finally { notify(); }
  })().finally(() => { persistPromise = undefined; });
  return persistPromise;
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolveDb, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB，无法持久保存资源。'));
        return;
      }
      let request;
      try { request = indexedDB.open('stronghold-resource-cache', 1); } catch (error) { reject(error); return; }
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'url' });
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('资源数据库被其他页面占用，请关闭旧页面后重试。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        const disconnected = () => {
          dbPromise = undefined;
          ready = false;
          revision++;
          notify();
        };
        db.onversionchange = () => { db.close(); disconnected(); };
        db.onclose = disconnected;
        resolveDb(db);
      };
    }).catch(error => { dbPromise = undefined; throw error; });
  }
  return dbPromise;
}

// Local reads trust completed stored resources. No version, size, MIME, transport or content checks.
function valid(record) {
  return record?.complete !== false && record?.blob instanceof Blob;
}

function localItem(url) {
  const resourceUrl = mediaUrl(url);
  const item = resolve(resourceUrl);
  if (item) return item;
  let canonical = key(resourceUrl);
  // Canonical cache records belong to the page; remote origins are download aliases.
  if (deploymentResourceOrigin() && canonical) {
    const parsed = new URL(canonical);
    if ([CDN_RESOURCE_ORIGIN, WIN7_RESOURCE_ORIGIN, SOUTH_PRELOAD_ORIGIN, SOUTH_PRELOAD_HTTPS_ORIGIN].includes(parsed.origin) && /^\/(?:assets|media|data)\//.test(parsed.pathname)) {
      canonical = key(parsed.pathname + parsed.search);
    }
  }
  return canonical ? { key: canonical, url: resourceUrl, groups: [] } : null;
}

function partial(record, item) {
  return record?.url === item.key && record.version === item.version && record.bytes === item.bytes &&
    record.type === item.type && record.complete === false && record.transport === undefined && record.blob instanceof Blob &&
    record.blob.size > 0 && record.blob.size < item.bytes;
}

async function readRecord(item) {
  try {
    const db = await openDb();
    return await new Promise((resolveRecord, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(item.key);
      let record;
      request.onsuccess = () => { record = request.result; };
      tx.oncomplete = () => resolveRecord(record);
      tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error('读取本地资源失败，请重试。'));
    });
  } catch (error) { throw resourceStorageFailure(error); }
}

function resourceStorageFailure(error) {
  const failure = new Error(error?.message || '本地资源缓存不可用。');
  failure.resourceStorageError = true;
  failure.cause = error;
  return failure;
}

function readCachedRecord(item) {
  const pending = cachedReadJobs.get(item.key);
  if (pending) return pending.promise;
  let resolveRead, rejectRead;
  const promise = new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
  const job = { item, promise, resolve: resolveRead, reject: rejectRead };
  cachedReadJobs.set(item.key, job);
  cachedReadQueue.set(item.key, job);
  if (!cachedReadFlushScheduled) {
    cachedReadFlushScheduled = true;
    queueMicrotask(flushCachedReads);
  }
  return promise;
}

let cachedReadFlushScheduled = false;
async function flushCachedReads() {
  cachedReadFlushScheduled = false;
  const batch = [...cachedReadQueue.values()];
  cachedReadQueue.clear();
  if (!batch.length) return;
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    for (const job of batch) {
      if (cachedReadJobs.get(job.item.key) === job) cachedReadJobs.delete(job.item.key);
      if (error) job.reject(error);
      else job.resolve(job.record);
    }
  };
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    for (const job of batch) {
      const request = store.get(job.item.key);
      request.onsuccess = () => { job.record = request.result; };
    }
    tx.oncomplete = () => finish();
    tx.onabort = tx.onerror = () => finish(tx.error || new Error('读取本地资源失败，请重试。'));
  } catch (error) { finish(error); }
}

function retainObjectUrl(id, handle) {
  objectUrls.delete(id);
  objectUrls.set(id, handle);
  handle.refs++;
  let released = false;
  return { url: handle.url, release() {
    if (released) return;
    released = true;
    if (--handle.refs === 0) {
      if (handle.stale) URL.revokeObjectURL(handle.url);
      else pruneObjectUrls();
    }
  } };
}

function pruneObjectUrls() {
  let bytes = 0;
  for (const handle of objectUrls.values()) bytes += handle.bytes;
  if (bytes <= OBJECT_URL_CACHE_BYTES) return;
  for (const [id, handle] of objectUrls) {
    if (bytes <= OBJECT_URL_CACHE_BYTES) break;
    if (handle.refs) continue;
    objectUrls.delete(id);
    handle.stale = true;
    URL.revokeObjectURL(handle.url);
    bytes -= handle.bytes;
  }
}

function discardObjectUrls(predicate) {
  for (const [id, handle] of objectUrls) {
    if (!predicate(handle.item)) continue;
    objectUrls.delete(id);
    handle.stale = true;
    if (!handle.refs) URL.revokeObjectURL(handle.url);
  }
}

async function writeRecord(item, blob, finished = true, markCorrupt = false, transport) {
  const webp = transport !== undefined;
  if (!markCorrupt && webp && (!finished || blob.type !== 'image/webp' ||
      !sameTransport(transport, item.transport) || blob.size !== transport.bytes)) {
    throw new Error('资源缓存的传输元数据与内容不符。');
  }
  const db = await openDb();
  return new Promise((resolveWrite, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get(item.key);
    let saved;
    request.onsuccess = () => {
      const previous = request.result;
      // 同一事务内锁定完整记录：其他页面的断点/失败下载不能降级它，较短断点也不能倒退进度。
      // 完整本地记录直接复用；不对版本、长度、类型或内容复验。
      if (!markCorrupt &&
          (valid(previous, item) || (!finished &&
            ((previous?.complete !== false && previous?.blob instanceof Blob && previous.blob.type !== 'image/webp' && previous.blob.size === previous.bytes) ||
             (partial(previous, item) && previous.blob.size >= blob.size))))) {
        saved = previous;
      } else {
        saved = { url: item.key, version: item.version, bytes: item.bytes, type: item.type, complete: finished, blob };
        if (webp) saved.transport = { version: transport.version, bytes: transport.bytes, type: transport.type };
        store.put(saved);
      }
    };
    tx.oncomplete = () => resolveWrite(saved);
    tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error('保存本地资源失败，请重试。'));
  });
}

function invalidate(item, bytes = 0) {
  onlineRequiredBlobs.delete(item.key);
  discardObjectUrls(candidate => candidate?.key === item.key);
  if (complete.has(item.key)) state.cacheRevision++;
  updateItemProgress(item, bytes, false);
  notifyProgress();
}

async function scan() {
  const db = await openDb();
  const found = new Set();
  const bytes = new Map();
  const batchSize = 256;
  let after;
  while (true) {
    // Short independent readonly transactions allow foreground lookups between inventory batches.
    const records = await new Promise((resolveBatch, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAllKeys(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true), batchSize);
      let batch;
      request.onsuccess = () => { batch = request.result; };
      tx.oncomplete = () => resolveBatch(batch);
      tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error('读取本地资源目录失败，请重试。'));
    });
    // Presence inventory reads primary keys only: no Blob, version, length, type or hash checks.
    for (const url of records) {
      const item = entries.get(url);
      if (item) { found.add(item.key); bytes.set(item.key, item.bytes); }
    }
    if (records.length < batchSize) return { found, bytes };
    after = records[records.length - 1];
    await new Promise(resolveYield => setTimeout(resolveYield, 0));
  }
}

function ensureReady() {
  // 启动期检查已完成就直接复用；尚在检查则等待同一任务。
  if (checkPromise) return checkPromise;
  if (checkedRevision === revision) return Promise.resolve(ready);
  return check();
}

function check() {
  if (checkPromise) return checkPromise;
  checkedRevision = -1;
  state.checking = true;
  state.error = null;
  ready = false;
  notify();
  checkPromise = (async () => {
    try {
      await loadManifest();
      // Let foreground image reads enter IndexedDB before the startup-wide cache scan.
      await new Promise(resolveScanYield => setTimeout(resolveScanYield, 0));
      // Background presence inventory never gates or invalidates foreground reads.
      // Merge writes made while its short read batches were running.
      const changed = scanChanges = new Set();
      const scanned = await scan();
      for (const url of changed) {
        if (complete.has(url)) scanned.found.add(url); else scanned.found.delete(url);
        if (savedBytes.has(url)) scanned.bytes.set(url, savedBytes.get(url)); else scanned.bytes.delete(url);
      }
      if (scanned.bytes.size) void protectResources();
      complete.clear();
      savedBytes.clear();
      for (const url of scanned.found) complete.add(url);
      for (const [url, bytes] of scanned.bytes) savedBytes.set(url, bytes);
      progress();
      ready = state.required.done === state.required.total;
      checkedRevision = revision;
      if (ready) state.missing = null;
      state.cacheRevision++;
      return ready;
    } catch (error) {
      state.error = message(error);
      return false;
    } finally {
      state.checking = false;
      scanChanges = undefined;
      checkPromise = undefined;
      notify();
    }
  })();
  return checkPromise;
}

async function ensureSessionReady() {
  // Authentication and server selection must not wait for the full resource index or IndexedDB.
  // Required-resource consumers still await the shared manifest when they actually need it.
  if (!sessionInitPromise) {
    sessionInitPromise = loadManifest().then(async () => {
      try { await openDb(); } catch (error) {
        state.error = message(error);
        state.source = '本地存储暂不可用，必要资源仍可实时获取（当前游戏服优先，另一游戏服备用）；个性化资源需恢复本地存储后下载。';
        notify();
        return;
      }
      // One filename reports the continuous checkpoint; no inventory upload or per-file HEAD requests.
      if (!startupPreloadStarted && deploymentResourceOrigin() && !localResourceOrigin()) {
        startupPreloadStarted = true;
        void download('required', { background: true });
      }
    }).catch(error => {
      state.error = message(error);
      notify();
    }).finally(() => { sessionInitPromise = undefined; });
  }
  return true;
}

async function prefetchRequired(urls, { priority = 1 } = {}) {
  try {
    if (priority < 2) {
      const requested = [...new Set(urls.filter(Boolean))];
      const local = await Promise.allSettled(requested.map(url => cachedBlob(url)));
      const missing = requested.filter((_, index) => local[index].status !== 'fulfilled' || !local[index].value);
      if (!missing.length) return true;
      await loadManifest();
      const required = missing.filter(url => resolve(mediaUrl(url))?.groups.includes('required'));
      const results = await Promise.allSettled(required.map(url => availableBlob(url)));
      return results.every(result => result.status === 'fulfilled' && !!result.value);
    }
    await loadManifest();
    const items = [...new Set(urls.filter(Boolean).map(url => resolve(mediaUrl(url))))]
      .filter(item => item?.groups.includes('required') && !complete.has(item.key));
    const results = await Promise.allSettled(items.map(async item => {
      if (priority < 2 && onlineRequiredBlobHit(item)) return;
      try {
        const saved = await saveItem(item, null, priority);
        if (priority < 2 && valid(saved, item)) rememberOnlineRequiredBlob({ item, blob: saved.blob });
      } catch (error) {
        if (priority >= 2 || (!error.resourceStorageError && !error.validatedResource)) throw error;
        rememberOnlineRequiredBlob(error.validatedResource || await onlineRequiredBlob(item));
      }
    }));
    return results.every(result => result.status === 'fulfilled');
  } catch { return false; }
}

function withSlot(fn, id, priority = 0) {
  return new Promise((resolveSlot, rejectSlot) => {
    slots.push({ fn, id, priority, resolveSlot, rejectSlot });
    drainSlots();
  });
}

function drainSlots() {
  slots.sort((a, b) => a.priority - b.priority);
  const limit = 6;
  while (active < limit && slots.length) {
    // Reserve two slots for UI/battle IO while manual downloads fill four streams.
    const next = slots.findIndex(task => task.priority < 2 || activePreloads < 4);
    if (next < 0) break;
    const [task] = slots.splice(next, 1);
    const preload = task.priority >= 2;
    active++;
    if (preload) activePreloads++;
    Promise.resolve().then(task.fn).then(task.resolveSlot, task.rejectSlot).finally(() => {
      active--;
      if (preload) activePreloads--;
      drainSlots();
    });
  }
}

// 每组一个压缩包；只读取缺少资源的区间，不整包下载或整包解压。
function packUnavailable(error) {
  const failure = new Error(`压缩包不可用：${message(error)}`);
  failure.packUnavailable = true;
  return failure;
}

async function packRange(url, start, end, total, signal, preload = false, onProgress) {
  const cloudGroup = preload && deploymentResourceOrigin() && !localResourceOrigin() && preloadPackGroup(url);
  if (cloudGroup) {
    try { return await readPreloadRange(cloudGroup, start, end, total, { signal, onProgress,
      onSource: source => { state.source = source; state[cloudGroup].source = source; notifyProgress(); },
    }); } catch (error) { throw packUnavailable(error); }
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 30000); };
  arm();
  try {
    const response = await fetchResourceData(url, {
      cache: 'no-store', signal: controller.signal,
      headers: { Range: `bytes=${start}-${end}` },
    }, { preload });
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    const size = Number(range?.[3]);
    if (response.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== end ||
        !Number.isSafeInteger(size) || size <= end || (total !== undefined && size !== total) || !response.body) {
      await response.body?.cancel();
      throw new Error(`资源包范围响应无效（HTTP ${response.status}）`);
    }
    const bytes = new Uint8Array(end - start + 1);
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > bytes.length) {
          await reader.cancel();
          throw new Error('资源包范围大小异常');
        }
        bytes.set(value, received);
        received += value.byteLength;
        onProgress?.(received, bytes.length);
      }
    } finally { reader.releaseLock(); }
    if (received !== bytes.length) throw new Error('资源包传输中断');
    return { bytes, total: size };
  } catch (error) {
    controller.abort();
    throw packUnavailable(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function packPrefix(prefix, total) {
  const magic = new TextDecoder().decode(prefix.subarray(0, 8));
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(8, true);
  if (![PACK_MAGIC, GZIP_PACK_MAGIC, LEGACY_PACK_MAGIC].includes(magic) || !length || length > PACK_HEADER_LIMIT || length > total - 12) {
    throw new Error('资源包格式不正确或文件已损坏。');
  }
  return { magic, length };
}

function packMatches(packed) {
  const { raw, item, encoding } = packed;
  return !!item && raw.version === item.version && raw.bytes === item.bytes && raw.type === item.type &&
    (encoding !== 'webp-lossless' || sameTransport(raw.transport, item.transport));
}

function packRecords(header, prefix, total) {
  const schema = prefix.magic === PACK_MAGIC ? 3 : prefix.magic === GZIP_PACK_MAGIC ? 2 : 1;
  const compressed = schema !== 1;
  if (header?.schema !== schema || !Array.isArray(header.resources) || !header.resources.length) {
    throw new Error('不支持的资源包版本或空资源包。');
  }
  const seen = new Set(), records = [];
  let offset = 12 + prefix.length;
  for (const raw of header.resources) {
    const encoding = compressed ? raw?.encoding : 'identity';
    const storedBytes = compressed ? raw?.storedBytes : raw?.bytes;
    const webp = encoding === 'webp-lossless';
    if (typeof raw?.url !== 'string' || !raw.url || typeof raw.version !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.version) ||
        !Number.isSafeInteger(raw.bytes) || raw.bytes <= 0 || typeof raw.type !== 'string' ||
        !(schema === 3 ? ['gzip', 'identity', 'webp-lossless'] : ['gzip', 'identity']).includes(encoding) ||
        !Number.isSafeInteger(storedBytes) || storedBytes <= 0 ||
        (encoding === 'identity' && storedBytes !== raw.bytes) || storedBytes > total - offset ||
        (webp ? raw.type !== 'image/png' || !validTransport(raw.transport) || storedBytes !== raw.transport.bytes : raw.transport !== undefined)) {
      throw new Error('资源包条目不完整或文件已截断。');
    }
    const resolved = resolve(mediaUrl(raw.url));
    const item = webp && !sameTransport(raw.transport, resolved?.transport) ? undefined : resolved;
    const id = resolved?.key || key(mediaUrl(raw.url));
    if (!id || seen.has(id)) throw new Error('资源包包含无效地址或重复条目。');
    seen.add(id);
    // 传输摘要只能来自当前清单；包索引不能自行授权另一份 WebP 内容。
    records.push({ raw, item, offset, storedBytes, encoding });
    offset += storedBytes;
  }
  if (offset !== total) throw new Error('资源包大小与索引不符。');
  return records;
}

function compression() {
  if (!compressionPromise) compressionPromise = import('../vendor/fflate.module.js')
    .catch(error => { compressionPromise = undefined; throw error; });
  return compressionPromise;
}

async function decompressResource(bytes, length) {
  if (typeof DecompressionStream === 'function' && typeof Blob.prototype.stream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzip } = await compression();
  return new Promise((resolve, reject) => {
    gunzip(bytes, { size: length }, (error, result) => error ? reject(error) : resolve(result));
  });
}

async function unpackResource(packed, bytes) {
  const { raw, encoding, storedBytes } = packed;
  if (bytes.length !== storedBytes) throw new Error('压缩资源长度与索引不符。');
  if (encoding === 'webp-lossless') {
    if (!packMatches(packed) || bytes.length !== raw.transport.bytes) throw new Error('无损 WebP 传输元数据与当前清单不符。');
    return new Blob([bytes], { type: 'image/webp' });
  }
  let decoded = bytes;
  if (encoding === 'gzip') {
    if (bytes.length < 18 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true) !== raw.bytes) {
      throw new Error('压缩资源的解压长度与清单不符。');
    }
    decoded = await decompressResource(bytes, raw.bytes);
  }
  if (decoded.length !== raw.bytes) throw new Error('解压资源大小与清单不符。');
  return new Blob([decoded], { type: raw.type });
}

async function prepareDownloadSource(group, manual = false, signal, items = []) {
  const source = { manual, rawOnly: true, records: new Map(), failed: new Set(), total: 0,
    url: new URL(`/assets/resource-${group === 'required' ? 'required-lossless' : group}.sprpack`, preloadResourceOrigin()).href };
  if (localResourceOrigin()) return source;
  // The published manifest already carries checked offsets. Avoid downloading
  // several megabytes of pack headers again before the first missing resource.
  if (manual && deploymentResourceOrigin()) {
    const indexed = items.filter(item => item.pack && (item.pack.group || group) === group);
    if (indexed.length) {
      source.total = indexed[0].pack.total;
      for (const item of indexed) if (item.pack.total === source.total) source.records.set(item.key, { raw: item, item, ...item.pack });
      source.rawOnly = false;
      return source;
    }
  }
  try {
    const first = await packRange(source.url, 0, 11, undefined, signal, manual);
    const prefix = packPrefix(first.bytes, first.total);
    const index = await packRange(source.url, 12, 11 + prefix.length, first.total, signal, manual);
    const records = packRecords(JSON.parse(new TextDecoder().decode(index.bytes)), prefix, first.total);
    for (const record of records) if (packMatches(record)) source.records.set(record.item.key, record);
    source.rawOnly = false;
    source.total = first.total;
    if (!manual) state.source = '正在获取缺少条目，已有完整缓存继续使用。';
  } catch (error) {
    if (signal?.aborted) throw error;
    // Pack and raw IO share the same direct, South and final-main routing.
    state.source = '资源包暂不可用，将从 CDN 获取缺少的原始资源。';
  }
  notify();
  return source;
}

function preparePackBatches(source, items) {
  if (!source?.manual || source.rawOnly) return items;
  const packed = items.filter(item => !complete.has(item.key) && source.records.has(item.key))
    .sort((a, b) => source.records.get(a.key).offset - source.records.get(b.key).offset);
  source.batches = new Map();
  let batch;
  for (const item of packed) {
    const record = source.records.get(item.key), end = record.offset + record.storedBytes - 1;
    // Bound memory and overfetch: combine nearby missing entries, never the full pack.
    if (!batch || end - batch.start + 1 > 2 * 1024 * 1024 || record.offset - batch.end - 1 > 32768 || batch.pending.size >= 64) {
      batch = { start: record.offset, end, pending: new Set(), promise: null };
    }
    batch.end = end;
    batch.pending.add(item.key);
    source.batches.set(item.key, batch);
  }
  const packedKeys = new Set(packed.map(item => item.key));
  return [...packed, ...items.filter(item => !packedKeys.has(item.key))];
}

async function packedResourceBytes(source, packed, signal, onTransfer) {
  const itemProgress = (record, bytes) => receivingProgress(record.item, Math.floor(record.item.bytes * Math.min(record.storedBytes, Math.max(0, bytes)) / record.storedBytes));
  const batch = source.batches?.get(packed.item.key);
  if (!batch) return (await packRange(source.url, packed.offset,
    packed.offset + packed.storedBytes - 1, source.total, signal, source.manual,
    bytes => { onTransfer?.(); itemProgress(packed, bytes); })).bytes;
  batch.heartbeats ||= new Set();
  if (onTransfer) batch.heartbeats.add(onTransfer);
  if (!batch.promise) batch.promise = packRange(source.url, batch.start, batch.end, source.total, signal, true, received => {
    for (const heartbeat of batch.heartbeats) heartbeat();
    for (const id of batch.pending) {
      const record = source.records.get(id);
      itemProgress(record, received - (record.offset - batch.start));
    }
  });
  try {
    const { bytes } = await batch.promise;
    return bytes.subarray(packed.offset - batch.start, packed.offset - batch.start + packed.storedBytes);
  } finally {
    batch.heartbeats.delete(onTransfer);
    batch.pending.delete(packed.item.key);
    if (!batch.pending.size) batch.promise = null;
  }
}

async function resourceResponse(item, start, source, signal, requiredOnline = false, preload = false, onTransfer) {
  const localOrigin = localResourceOrigin();
  if (localOrigin) {
    const local = new URL(item.url, localOrigin);
    return fetch(new URL(local.pathname + local.search, localOrigin).href, {
      cache: 'no-store', credentials: 'same-origin', redirect: 'error', mode: 'same-origin', signal,
      headers: start ? { Range: 'bytes=' + start + '-' } : {},
    });
  }
  // These standalone mode assets are also shipped by the local/LAN game server.
  if (!deploymentResourceOrigin() && item.groups.includes('required') && /^\/assets\/(?:relics|annihilation-intro)\//.test(new URL(item.url, globalThis.location.origin).pathname)) {
    return fetch(new URL(item.url, globalThis.location.origin).href, { cache: 'no-store', signal,
      headers: start ? { Range: 'bytes=' + start + '-' } : {} });
  }
  if (requiredOnline && item.groups.includes('required') && deploymentResourceOrigin()) {
    const requestUrl = new URL(mediaUrl(item.url), globalThis.location.origin);
    requestUrl.searchParams.set('__resourceVersion', item.version);
    return fetchResourceData(requestUrl.href, { cache: 'no-store', signal,
      headers: start ? { Range: 'bytes=' + start + '-' } : {} }, { requiredOnline: true });
  }
  const gameUrl = gameHostedRequiredAudio(item);
  if (gameUrl) {
    return fetch(gameUrl, { cache: 'no-store', credentials: 'omit', redirect: 'error', mode: 'cors', signal, headers: start ? { Range: `bytes=${start}-` } : {} });
  }
  const packed = source && !source.rawOnly && !source.failed.has(item.key) && source.records.get(item.key);
  if (packed) {
    try {
      const bytes = source.manual || !preload ? await packedResourceBytes(source, packed, signal, onTransfer)
        : (await packRange(source.url, packed.offset, packed.offset + packed.storedBytes - 1, source.total, signal, true)).bytes;
      const blob = await unpackResource(packed, bytes);
      return new Response(blob, { status: 200, headers: {
        'Content-Type': blob.type, 'X-Resource-Pack': '1', 'X-Resource-Encoding': packed.encoding,
      } });
    } catch (error) {
      if (signal?.aborted) throw error;
      source.failed.add(item.key);
      state.source = '压缩条目暂不可用，将从 CDN 获取缺少的原始资源。';
      notify();
      const failure = new Error(message(error));
      failure.packFallback = true;
      throw failure;
    }
  }
  const requestUrl = new URL(win7ResourceUrl(item.url));
  requestUrl.searchParams.set('__resourceVersion', item.version);
  if (preload && deploymentResourceOrigin()) {
    return fetch(new URL(requestUrl.pathname + requestUrl.search, CDN_RESOURCE_ORIGIN).href, {
      cache: 'no-store', signal, credentials: 'omit', mode: 'cors', redirect: 'error',
      headers: start ? { Range: `bytes=${start}-` } : {},
    });
  }
  return fetchResourceData(requestUrl.href, { cache: 'no-store', signal,
    headers: start ? { Range: `bytes=${start}-` } : {} }, { preload });
}

async function requiredSource(item) {
  if (localResourceOrigin()) return null;
  const group = item.pack?.group || (item.groups.includes('required') ? 'required' : item.groups.includes('optional') ? 'optional' : 'voice');
  if (item.pack) {
    const records = new Map([[item.key, { raw: item, item, ...item.pack }]]);
    return { rawOnly: false, failed: new Set(), records, total: item.pack.total,
      url: new URL(`/assets/resource-${group === 'required' ? 'required-lossless' : group}.sprpack`, preloadResourceOrigin()).href };
  }
  // Raw illustrations are included individually in the Win7 package.
  if (win7PortraitUrl(item.url) || /^\/assets\/(?:relics|annihilation-intro)\//.test(new URL(item.url, globalThis.location.origin).pathname)) return null;
  if (!downloadSources.has(group)) downloadSources.set(group, prepareDownloadSource(group));
  return downloadSources.get(group);
}

async function saveItem(item, source, priority = 2, canStart, signal) {
  if (jobs.has(item.key)) {
    const queued = slots.find(task => task.id === item.key);
    if (queued) { queued.priority = Math.min(queued.priority, priority); drainSlots(); }
    const pending = jobs.get(item.key);
    if (priority >= 2) return pending;
    let saved;
    try { saved = await pending; } catch (error) { if (!error.preloadCancelled) throw error; }
    // A paused preload may have skipped this job; foreground loading still needs the resource.
    return saved || saveItem(item, null, priority);
  }
  const job = withSlot(async () => {
    if (canStart && !canStart()) return;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer;
    const armTimeout = () => {
      if (!controller) return;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 45000);
    };
    armTimeout();
    try {
    const store = async () => {
    const record = await readRecord(item);
    if (!valid(record, item)) {
      const requiredOnline = priority < 2 && item.groups.includes('required') && !!deploymentResourceOrigin();
      if (!requiredOnline && (!source || !source.records.has(item.key))) {
        source = await requiredSource(item);
        if (source && priority >= 2) source = { ...source, manual: true };
      }
      const start = partial(record, item) ? record.blob.size : 0;
      invalidate(item, start);
      const response = await resourceResponse(item, start, source, controller?.signal, requiredOnline, priority >= 2, armTimeout);
      armTimeout();
      if (!response.ok || ![200, 206].includes(response.status)) {
        throw new Error(`资源下载失败（HTTP ${response.status}）：${item.url}`);
      }
      const packedResponse = response.headers.get('X-Resource-Pack') === '1';
      const transport = packedResponse && response.headers.get('X-Resource-Encoding') === 'webp-lossless'
        ? item.transport : undefined;
      const expectedBytes = transport?.bytes || item.bytes;
      const contentType = transport?.type || item.type;
      const resume = start > 0 && response.status === 206;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
        if (!range || Number(range[1]) !== start || Number(range[2]) !== item.bytes - 1 || Number(range[3]) !== item.bytes) {
          await response.body?.cancel();
          throw new Error(`资源续传范围与清单不符：${item.url}，请重试。`);
        }
      }
      const parts = resume ? [record.blob] : [];
      let size = resume ? start : 0;
      const storePartial = async () => {
        // 压缩条目先完整解压并校验；未校验内容不能变成原始下载的续传前缀。
        if (packedResponse) return;
        if (size > 0 && size < item.bytes) {
          const saved = await writeRecord(item, new Blob(parts, { type: item.type }), false);
          updateItemProgress(item, valid(saved, item) ? item.bytes : partial(saved, item) ? saved.blob.size : 0, valid(saved, item));
          notifyProgress();
        }
      };
      if (response.body) {
        const reader = response.body.getReader();
        let checkpoint = size;
        try {
          while (true) {
            const { done, value } = await reader.read();
            armTimeout();
            if (done) break;
            size += value.byteLength;
            if (size > expectedBytes) {
              await reader.cancel();
              throw new Error(`资源大小与清单不符：${item.url}，请重试。`);
            }
            parts.push(value);
            receivingProgress(item, Math.floor(item.bytes * size / expectedBytes));
            if (size - checkpoint >= 4 * 1024 * 1024 && size < expectedBytes) {
              await storePartial();
              checkpoint = size;
              const prefix = new Blob(parts, { type: contentType });
              parts.length = 0;
              parts.push(prefix);
            }
          }
        } catch (error) {
          await storePartial();
          throw error;
        } finally { reader.releaseLock(); }
      } else {
        const chunk = await response.blob();
        parts.push(chunk);
        size += chunk.size;
      }
      if (size !== expectedBytes) {
        await storePartial();
        throw new Error(`资源大小与清单不符：${item.url}，请重试。`);
      }
      const blob = new Blob(parts, { type: contentType });
      try { return await writeRecord(item, blob, true, false, transport); } catch (error) {
        // 大小及传输结构已校验。按需读取可直接使用，不因持久存储额度不足再下载一次。
        error.validatedResource = { item, blob };
        throw error;
      }
    }
    return record;
    };
    let saved;
    try { saved = await store(); } catch (error) {
      if (!error.packFallback) throw error;
      state.source = '压缩条目校验失败，将从 CDN 获取缺少的原始资源。';
      notify();
      saved = await store();
    }
    updateItemProgress(item, item.bytes, true);
    state.cacheRevision++;
    if (state.missing === item.key) state.missing = null;
    notifyProgress();
    // writeRecord may retain another page's complete record; return what actually committed.
    return saved;
    } finally { receivingProgress(item, 0); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }, item.key, priority).catch(error => {
    if (signal?.aborted && !error.validatedResource) error.preloadCancelled = true;
    throw error;
  });
  jobs.set(item.key, job);
  try { return await job; } finally { jobs.delete(item.key); }
}

const downloads = new Map();
const downloadControls = new Map();
function selectionItems(group, options = {}) {
  if (options.hdPortraits === true) return [];
  const selected = Array.isArray(options.urls) ? new Set(options.urls.map(url => resolve(mediaUrl(url))?.key).filter(Boolean)) : null;
  return (manifest?.groups[group] || []).filter(item =>
    (!selected || selected.has(item.key)) &&
    !isHdPortrait(item) &&
    (group !== 'voice' || !['cn', 'jp'].includes(options.voiceLang) || item.url.includes(`/voice/${options.voiceLang}/`)));
}
function selectionState(group, options = {}) {
  const items = selectionItems(group, options);
  return { ...(state[group === 'optional' && options.hdPortraits === true ? 'hdPortraits' : group] || groupState()), total: items.length,
    bytes: items.reduce((n, item) => n + item.bytes, 0),
    done: items.filter(item => complete.has(item.key)).length,
    downloadedBytes: items.reduce((n, item) => n + (savedBytes.get(item.key) || 0) + pendingBytes(item), 0) };
}
function pause(group = null) {
  if (!group || group === 'hdPortraits') state.hdPortraits.paused = true;
  for (const [name, control] of downloadControls) {
    if (group && group !== name) continue;
    control.paused = true;
    control.controller.abort();
    state[name].paused = true;
  }
  notify();
}

async function resumeResourceStream(group, options, control, continuation = null) {
  // Public preloads use direct cloud ranges with CDN failover, without a game relay.
  if (deploymentResourceOrigin() || localResourceOrigin() || Array.isArray(options.urls)) return false;
  const items = selectionItems(group, options);
  if (!items.length) return true;
  const firstMissing = items.findIndex(item => !complete.has(item.key));
  const generation = manifest.generation;
  const previous = storedPreloadCursor(group, generation);
  const cursorIndex = previous ? items.findIndex(item => resourceFilename(item.url) === previous) : -1;
  // IndexedDB keys only establish a safe prefix. A later out-of-order cache write cannot skip a hole.
  const boundary = firstMissing < 0 ? items.length - 1 : Math.max(0, firstMissing - 1);
  const continuedIndex = continuation ? items.findIndex(item => resourceFilename(item.url) === continuation) : -1;
  const start = continuedIndex >= 0 ? continuedIndex : cursorIndex >= 0 ? Math.min(cursorIndex, boundary) : boundary;
  const from = items[start].url;
  control.streamFrom = resourceFilename(from);
  const current = await readRecord(items[start]);
  if (!valid(current) && complete.has(items[start].key)) invalidate(items[start]);
  const url = new URL('/api/resource-preload', preloadResourceOrigin());
  url.searchParams.set('group', group); url.searchParams.set('from', resourceFilename(from));
  url.searchParams.set('window', '1');
  if (group === 'voice' && ['cn', 'jp'].includes(options.voiceLang)) url.searchParams.set('voiceLang', options.voiceLang);
  const request = new AbortController();
  const cancel = () => request.abort(control.controller.signal.reason);
  control.controller.signal.addEventListener('abort', cancel, { once: true });
  if (control.controller.signal.aborted) cancel();
  const timeout = setTimeout(() => request.abort(new DOMException('资源续传响应超时', 'TimeoutError')), 20000);
  let response;
  try {
    response = await fetch(url, { signal: request.signal, cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: 'error' });
  } catch (error) { control.controller.signal.removeEventListener('abort', cancel); error.resumeFrom = resourceFilename(from); throw error; }
  finally { clearTimeout(timeout); }
  if (!control.streamReceived && ([404, 405, 409, 410, 501].includes(response.status) ||
      response.ok && response.headers.get('Content-Type')?.split(';')[0] !== 'application/x-stronghold-resources')) {
    control.controller.signal.removeEventListener('abort', cancel);
    try { void response.body?.cancel().catch(() => {}); } catch { /* Closed response. */ }
    request.abort();
    return false;
  }
  const selected = new Map(items.map(item => [resourceFilename(item.url), item]));
  let expectedIndex = start, next = null, received = false, transferItem = null, transferBytes = 0;
  const displayProgress = (item, bytes) => {
    if (transferItem !== item) {
      if (transferItem) for (const name of transferItem.groups) state[name].downloadedBytes -= transferBytes;
      transferItem = item; transferBytes = 0;
    }
    const delta = bytes - transferBytes; transferBytes = bytes;
    for (const name of item.groups) state[name].downloadedBytes += delta;
    notifyProgress();
  };
  try { await consumePreloadStream(response, { signal: control.controller.signal,
    onStart(info) {
      if (info.generation !== generation || info.group !== group || info.total > items.length - start || info.total < 1 ||
          (!info.bounded && info.total !== items.length - start) || info.from !== resourceFilename(from)) {
        throw new Error('资源续传目录已更新，请重试。');
      }
      received = true; control.streamReceived = true;
      savePreloadCursor(group, generation, from);
    },
    onProgress(raw, bytes) {
      const item = selected.get(resourceFilename(raw.url));
      if (!item) return;
      control.streamFrom = resourceFilename(item.url);
      const pending = Math.max(0, item.bytes - (savedBytes.get(item.key) || 0));
      displayProgress(item, Math.min(pending, Math.floor(pending * bytes / raw.storedBytes)));
    },
    async onFile(raw, bytes) {
      const item = selected.get(resourceFilename(raw.url));
      if (!item || item !== items[expectedIndex++] || raw.version !== item.version || raw.bytes !== item.bytes || raw.type !== item.type ||
          (raw.encoding === 'webp-lossless' && !sameTransport(raw.transport, item.transport))) throw new Error('资源续传条目与当前目录不符。');
      // The cursor is inclusive: a complete or interrupted current file is always offered again next time.
      const packed = { raw: { ...item, ...(raw.transport ? { transport: raw.transport } : {}) }, item,
        encoding: raw.encoding, storedBytes: raw.storedBytes };
      const blob = await unpackResource(packed, bytes);
      const saved = await writeRecord(item, blob, true, false, raw.encoding === 'webp-lossless' ? item.transport : undefined);
      if (!valid(saved)) throw new Error('资源续传未能保存：' + item.url);
      displayProgress(item, 0);
      updateItemProgress(item, item.bytes, true);
      state.cacheRevision++; notifyProgress();
      savePreloadCursor(group, generation, item.url);
    },
    onEnd(info) {
      const expected = items[expectedIndex];
      if (info.next != null && resourceFilename(info.next) !== resourceFilename(expected?.url || '/')) throw new Error('资源续传断点顺序不符。');
      next = info.next || null;
      if (!next && expected) throw new Error('资源续传尚未完成。');
    },
  }); } catch (error) {
    error.resumeFrom = control.streamFrom || resourceFilename(from);
    error.preloadStreamStarted = received;
    throw error;
  } finally {
    if (transferItem) displayProgress(transferItem, 0);
    control.controller.signal.removeEventListener('abort', cancel);
    request.abort();
  }
  return next ? { next } : true;
}

function download(group, options = {}) {
  if (options.hdPortraits === true || (group !== 'required' && options.background === true)) return Promise.resolve(false);
  if (state.pack.running || state.clearing || !GROUPS.includes(group)) return Promise.resolve(false);
  const name = group;
  if (downloads.has(name)) return downloads.get(name);
  const control = { paused: false, controller: new AbortController() };
  downloadControls.set(name, control);
  const status = state[name];
  status.running = true;
  status.paused = false;
  status.error = null;
  state.error = null;
  notify();
  const task = (async () => {
    let failed = false;
    try {
      await loadManifest();
      await protectResources(true);
      await ensureReady();
      if (control.paused) return false;
      if (state.error) throw new Error(state.error);
      await openDb();
      let index = 0;
      const selected = Array.isArray(options.urls) || ['cn', 'jp'].includes(options.voiceLang);
      let items = selectionItems(group, options);
      let continuation = null, retries = 0;
      while (!control.paused) {
        try {
          const result = await resumeResourceStream(group, options, control, continuation);
          if (result?.next) { continuation = result.next; retries = 0; continue; }
          if (result) return items.every(item => complete.has(item.key));
          break;
        } catch (error) {
          if (control.paused || control.controller.signal.aborted) return false;
          if (error.resourceStorageError || ['QuotaExceededError', 'SecurityError', 'InvalidStateError'].includes(error.name)) throw error;
          continuation = error.resumeFrom || continuation;
          if (++retries <= 3) {
            await new Promise(resolveRetry => {
              const done = () => { clearTimeout(timer); control.controller.signal.removeEventListener('abort', done); resolveRetry(); };
              const timer = setTimeout(done, 500 * retries);
              control.controller.signal.addEventListener('abort', done, { once: true });
            });
            continue;
          }
          // An accepted stream resumes its file cursor, never restarts a large pack via the old path.
          if (control.streamReceived) throw new Error('资源连接中断，已保留下载进度，请继续预载。');
          break;
        }
      }
      let source = null;
      if (!control.paused && items.some(item => !complete.has(item.key))) {
        // 主动下载 source 只属于本轮下载，不与游戏内按需 source 共用。
        source = await prepareDownloadSource(group, true, control.controller.signal, items);
      }
      items = preparePackBatches(source, items);
      await Promise.all(Array.from({ length: Math.min(options.background ? 1 : 4, items.length) }, async () => {
        while (!failed && !control.paused && index < items.length) {
          const item = items[index++];
          if (complete.has(item.key)) continue;
          try { await saveItem(item, source, options.background ? 3 : 2, () => !control.paused, control.controller.signal); } catch (error) {
            if (control.paused) break;
            failed = true;
            status.error = message(error);
            state.error = status.error;
            notify();
          }
        }
      }));
      // Every saved item has passed size/transport checks and been committed. A full database scan here can
      // keep a paused download running indefinitely while foreground writes change its revision.
      const verified = ready;
      if (state.error && !status.error) status.error = state.error;
      if (failed) state.error = status.error;
      return !control.paused && !failed && !status.error && (selected ? items.length > 0 && items.every(item => complete.has(item.key)) : group === 'required' ? verified : status.done === status.total);
    } catch (error) {
      if (control.paused) return false;
      status.error = message(error);
      state.error = status.error;
      return false;
    } finally {
      for (const item of selectionItems(group, options)) receiving.delete(item.key);
      status.running = false;
      downloads.delete(name);
      downloadControls.delete(name);
      notify();
    }
  })();
  downloads.set(name, task);
  return task;
}

function resumeHdPortraits() {}
function cacheHdPortrait() { return Promise.resolve(false); }

async function clearOptional() {
  if (state.clearing || state.pack.running || state.checking || downloads.size || jobs.size) return { busy: true };
  state.clearing = true;
  state.error = null;
  notify();
  try {
    await loadManifest();
    const db = await openDb();
    const keys = new Set([...entries.values()].filter(item => !item.groups.includes('required')).map(item => item.key));
    await new Promise((resolveClear, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const key of keys) store.delete(key);
      // Retired HD records no longer appear in the manifest but still belong to personalization cleanup.
      const retired = store.openCursor();
      retired.onsuccess = () => {
        const cursor = retired.result;
        if (!cursor) return;
        if (isHdPortrait({ url: String(cursor.key) })) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = resolveClear;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('本地资源清理失败'));
    });
    discardObjectUrls(item => keys.has(item.key));
    for (const key of keys) { scanChanges?.add(key); complete.delete(key); savedBytes.delete(key); }
    revision++; state.cacheRevision++; progress();
    return { ok: true };
  } catch (error) { state.error = message(error); return { error: state.error }; }
  finally { state.clearing = false; notify(); }
}

// SPPACK03 支持像素无损 WebP；SPPACK02 gzip 与 SPPACK01 原始资源仍支持导入。
const PACK_MAGIC = 'SPPACK03';
const GZIP_PACK_MAGIC = 'SPPACK02';
const LEGACY_PACK_MAGIC = 'SPPACK01';
const PACK_HEADER_LIMIT = 16 * 1024 * 1024;

// Existing cached files are never rehashed. Validate only newly imported external pack bodies.
async function validateImportedResource(packed, blob) {
  const expected = packed.encoding === 'webp-lossless' ? packed.raw.transport.version : packed.raw.version;
  let digest;
  if (globalThis.crypto?.subtle) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    digest = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  } else {
    const { createSha256 } = await import('../../shared/sha256.js');
    const hash = createSha256();
    for (let start = 0; start < blob.size; start += 256 * 1024) {
      hash.update(new Uint8Array(await blob.slice(start, start + 256 * 1024).arrayBuffer()));
      await new Promise(resolveYield => setTimeout(resolveYield, 0));
    }
    digest = hash.hex();
  }
  if (digest !== expected.toLowerCase()) throw new Error('资源包条目校验失败：' + packed.raw.url);
}

async function packOperation(kind, operation) {
  if (state.clearing || state.pack.running || downloads.size || GROUPS.some(group => state[group].running) || jobs.size) return null;
  state.pack = { running: kind, done: 0, total: 0, note: null, error: null };
  notify();
  try {
    await loadManifest();
    await check();
    if (state.error) throw new Error(state.error);
    return await operation();
  } catch (error) {
    state.pack.error = message(error);
    return null;
  } finally {
    state.pack.running = null;
    notify();
  }
}

function exportPack() {
  return packOperation('export', async () => {
    const items = [...entries.values()].filter(item => complete.has(item.key));
    if (!items.length) throw new Error('没有可导出的完整资源，请先下载资源。');
    state.pack.total = items.length;
    notify();
    const records = [], blobs = [];
    const { gzipSync } = await compression();
    for (const item of items) {
      const record = await readRecord(item);
      if (!valid(record, item)) throw new Error(`本地资源不完整，请补充下载后导出：${item.url}`);
      const transport = record.transport;
      const url = new URL(item.key);
      let stored = record.blob, encoding = 'webp-lossless';
      if (!transport) {
        const compressed = gzipSync(new Uint8Array(await record.blob.arrayBuffer()), { level: 9, mtime: 0 });
        const useGzip = compressed.length < item.bytes;
        stored = useGzip ? new Blob([compressed]) : record.blob;
        encoding = useGzip ? 'gzip' : 'identity';
      }
      records.push({ url: url.origin === globalThis.location.origin ? url.pathname + url.search : item.url,
        version: item.version, bytes: item.bytes, type: item.type, storedBytes: stored.size, encoding,
        ...(transport ? { transport } : {}) });
      blobs.push(stored);
      state.pack.done++;
      notify();
    }
    const header = new TextEncoder().encode(JSON.stringify({ schema: 3, resources: records }));
    if (header.length > PACK_HEADER_LIMIT) throw new Error('资源包索引过大，无法导出。');
    const prefix = new Uint8Array(12);
    prefix.set(new TextEncoder().encode(PACK_MAGIC));
    new DataView(prefix.buffer).setUint32(8, header.length, true);
    const blob = new Blob([prefix, header, ...blobs], { type: 'application/octet-stream' });
    state.pack.note = `已导出 ${records.length} 个完整资源：无损 WebP 保留为 WebP，其他资源无损压缩；不降低画质。`;
    return blob;
  });
}

function importPack(file) {
  return packOperation('import', async () => {
    if (!(file instanceof Blob) || file.size < 12) throw new Error('资源包格式不正确，请选择导出的 .sprpack 文件。');
    const prefix = packPrefix(new Uint8Array(await file.slice(0, 12).arrayBuffer()), file.size);
    let header;
    try { header = JSON.parse(await file.slice(12, 12 + prefix.length).text()); }
    catch { throw new Error('资源包索引已损坏。'); }
    const records = packRecords(header, prefix, file.size);
    await protectResources(true);
    state.pack.total = records.length;
    notify();
    let imported = 0, existing = 0, skipped = 0;
    for (const packed of records) {
      const { raw, item, offset: start, storedBytes } = packed;
      if (!packMatches(packed)) skipped++;
      else if (valid(await readRecord(item), item)) existing++;
      else {
        const blob = await unpackResource(packed, new Uint8Array(await file.slice(start, start + storedBytes).arrayBuffer()));
        await validateImportedResource(packed, blob);
        const transport = packed.encoding === 'webp-lossless' ? item.transport : undefined;
        await writeRecord(item, blob, true, false, transport);
        updateItemProgress(item, item.bytes, true);
        imported++;
      }
      state.pack.done++;
      notifyProgress();
    }
    await check();
    if (state.error) throw new Error(state.error);
    state.pack.note = `导入完成：新增 ${imported} 个，已有 ${existing} 个，版本不匹配或不需要 ${skipped} 个。${ready ? '必要资源已齐全。' : '缺少的必要资源仍需补充下载。'}`;
    return { imported, existing, skipped };
  });
}

async function cachedBlobItem(item) {
  if (!item) return null;
  try {
    const record = await readCachedRecord(item);
    if (valid(record, item)) return { item, blob: record.blob };
    invalidate(item);
  } catch (error) {
    state.error = message(error);
    // 读取异常不等于资源已丢失，不抹去已经确认的缓存状态。
    notify();
    throw error;
  }
  return null;
}

async function cachedBlob(url) {
  // Local-only access never starts or waits for manifest loading or completeness inventory.
  return cachedBlobItem(localItem(url));
}

async function availableBlob(url) {
  const direct = localItem(url);
  let storageError;
  try {
    const hit = await cachedBlobItem(direct);
    if (hit) return hit;
  } catch (error) { storageError = error; }
  // Only a local miss needs the manifest to determine download policy and any remaining aliases.
  await loadManifest();
  const item = resolve(mediaUrl(url));
  const onDemand = item && (item.groups.includes('required') || !!localResourceOrigin());
  if (!storageError && item && item.key !== direct?.key) {
    try {
      const hit = await cachedBlobItem(item);
      if (hit) return hit;
    } catch (error) { storageError = error; }
  }
  const onlineHit = onDemand && onlineRequiredBlobHit(item);
  if (onlineHit) return onlineHit;
  if (!onDemand) throw missingResource(url);
  if (storageError) return onlineRequiredBlob(item);
  void protectResources();
  try {
    const saved = await saveItem(item, null, 0);
    if (!valid(saved)) throw new Error('资源下载后未能写入缓存：' + url);
    return { item, blob: saved.blob };
  } catch (error) {
    state.error = message(error);
    notify();
    if (error.validatedResource) return rememberOnlineRequiredBlob(error.validatedResource);
    if (error.resourceStorageError) return onlineRequiredBlob(item);
    throw error;
  }
}

const onlineJobs = new Map();
function onlineRequiredBlobHit(item) {
  const hit = onlineRequiredBlobs.get(item.key);
  if (!hit) return null;
  onlineRequiredBlobs.delete(item.key);
  onlineRequiredBlobs.set(item.key, hit);
  return hit;
}

function rememberOnlineRequiredBlob(hit) {
  if (!hit?.item?.groups.includes('required') || !(hit.blob instanceof Blob)) return hit;
  onlineRequiredBlobs.delete(hit.item.key);
  onlineRequiredBlobs.set(hit.item.key, hit);
  let bytes = 0;
  for (const entry of onlineRequiredBlobs.values()) bytes += entry.blob.size;
  for (const [key, entry] of onlineRequiredBlobs) {
    if (bytes <= OBJECT_URL_CACHE_BYTES) break;
    onlineRequiredBlobs.delete(key);
    bytes -= entry.blob.size;
  }
  return hit;
}

function onlineRequiredBlob(item) {
  const hit = onlineRequiredBlobHit(item);
  if (hit) return Promise.resolve(hit);
  if (onlineJobs.has(item.key)) return onlineJobs.get(item.key);
  const job = withSlot(async () => {
    const requiredOnline = !!deploymentResourceOrigin();
    const source = requiredOnline ? null : await requiredSource(item);
    let response;
    try { response = await resourceResponse(item, 0, source, undefined, requiredOnline); } catch (error) {
      if (!error.packFallback) throw error;
      try {
        const record = await readCachedRecord(item);
        if (valid(record)) return rememberOnlineRequiredBlob({ item, blob: record.blob });
      } catch { /* Storage may be unavailable; the raw resource still works. */ }
      response = await resourceResponse(item, 0, source, undefined, requiredOnline);
    }
    if (!response.ok) throw new Error(`资源下载失败（HTTP ${response.status}）：${item.url}`);
    const transport = response.headers.get('X-Resource-Encoding') === 'webp-lossless' ? item.transport : null;
    const blob = await response.blob();
    if (blob.size !== (transport?.bytes || item.bytes)) {
      throw new Error(`资源内容与清单不符：${item.url}，请重试。`);
    }
    return rememberOnlineRequiredBlob({ item, blob });
  }, item.key, 0).finally(() => { onlineJobs.delete(item.key); });
  onlineJobs.set(item.key, job);
  return job;
}

function missingResource(url) {
  const item = resolve(mediaUrl(url));
  if (!item) {
    const error = new Error(`可选资源不可用，已跳过加载：${url}`);
    error.name = 'ResourceUnavailableError';
    return error;
  }
  const required = item.groups.includes('required');
  const error = new Error(required
    ? `本地资源缺失，请在资源预载中补充下载或导入资源包：${url}`
    : item.groups.includes('voice')
      ? '角色语音尚未预载，已跳过播放；可在资源预载中下载或导入语音。'
      : `可选资源尚未预载，已跳过加载：${url}`);
  error.name = required ? 'ResourcePreloadRequiredError' : 'ResourceUnavailableError';
  if (required && state.missing !== error.message) { state.missing = error.message; notify(); }
  return error;
}

// Plugin resources have immutable, server-checked URLs and are outside the base preload manifest.
function pluginResource(url) {
  try {
    const origin = globalThis.location?.origin || 'http://localhost';
    const parsed = new URL(url, origin);
    return parsed.origin === origin && /^\/p\/[a-z0-9][a-z0-9._-]*\/[0-9a-f]{8}\/.+/i.test(parsed.pathname);
  } catch { return false; }
}

export async function cachedFetch(url, opts = {}) {
  if (pluginResource(url)) return fetch(url, opts);
  const headers = new Headers(opts.headers);
  const method = (opts.method || 'GET').toUpperCase();
  const cacheable = method === 'GET' && !headers.has('Range') && !headers.has('If-Range') && !headers.has('If-None-Match') && !headers.has('If-Modified-Since');
  if (opts.signal?.aborted) throw opts.signal.reason || new DOMException('请求已取消', 'AbortError');
  if (/^(blob:|data:)/i.test(String(url))) return fetch(url, opts);
  const hit = cacheable ? await availableBlob(url) : null;
  if (opts.signal?.aborted) throw opts.signal.reason || new DOMException('请求已取消', 'AbortError');
  if (hit) {
    return new Response(hit.blob, { headers: {
      'Content-Type': hit.blob.type || hit.item.type || 'application/octet-stream',
      'Content-Length': String(hit.blob.size),
    } });
  }
  // 非普通 GET 不隐式下载；可选资源与语音继续由显式预载管理。
  throw missingResource(url);
}

export async function acquireResourceUrl(url, { cachedOnly = false } = {}) {
  if (pluginResource(url)) return { url, release() {} };
  if (/^(blob:|data:)/i.test(String(url))) return { url, release() {} };
  const item = localItem(url);
  const id = item?.key;
  const cached = id && !state.clearing ? objectUrls.get(id) : null;
  if (cached && !cached.stale) return retainObjectUrl(id, cached);
  const hit = cachedOnly ? await cachedBlob(url) : await availableBlob(url);
  if (!hit) throw missingResource(url);
  const hitId = hit.item.key;
  let handle = objectUrls.get(hitId);
  if (!handle) {
    handle = { url: URL.createObjectURL(hit.blob), refs: 0, bytes: hit.blob.size, item: hit.item, stale: false };
    objectUrls.set(hitId, handle);
  }
  return retainObjectUrl(hitId, handle);
}

export function initResourceCache() {
  return check();
}

export const resourceCache = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getState: snapshot,
  check,
  ensureReady,
  ensureManifestReady() { return loadManifest().then(() => true).catch(error => { state.error = message(error); notify(); return false; }); },
  ensureSessionReady,
  prefetchRequired,
  download,
  cacheHdPortrait,
  resumeHdPortraits,
  pause,
  clearOptional,
  selectionState,
  exportPack,
  importPack,
  isManaged(url) { return !!resolve(mediaUrl(url)); },
  isOptional(url) { const item = resolve(mediaUrl(url)); return !!item && !item.groups.includes('required'); },
  isCached(url) { const item = localItem(url); return !!item && (complete.has(item.key) || objectUrls.has(item.key)); },
  isReady() { return ready; },
};
