import { mediaUrl } from './media.js';

const GROUPS = ['required', 'optional', 'voice'];
const STORE = 'resources';
const listeners = new Set();
let entries = new Map();
let aliases = new Map();
const complete = new Set();
const savedBytes = new Map();
const objectUrls = new Map();
const cachedReadJobs = new Map();
const cachedReadQueue = new Map();
const OBJECT_URL_CACHE_BYTES = 32 * 1024 * 1024;
const jobs = new Map();
const slots = [];
let active = 0;
let activePreloads = 0;
let progressTimer;
let manifestPromise;
let manifest;
let dbPromise;
let checkPromise;
let scanChanges;
let checkedRevision = -1;
let ready = false;
let revision = 0;
let persistPromise;
export const WIN7_RESOURCE_ORIGIN = 'https://u75731.nyat.app:48335';
const PRELOAD_RESOURCE_ORIGIN = WIN7_RESOURCE_ORIGIN;

// Rewrite IO only: canonical cache keys stay tied to the game URL so existing verified caches are reused.
export function win7ResourceUrl(url) {
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    if (!/^https?:$/.test(parsed.protocol) || !/^\/(?:assets|media|data|p)\//.test(parsed.pathname)) return null;
    return new URL(parsed.pathname + parsed.search, PRELOAD_RESOURCE_ORIGIN).href;
  } catch { return null; }
}

export function fetchResourceData(url, options = {}) {
  const target = win7ResourceUrl(url);
  if (!target) return Promise.reject(new Error(`资源地址不可用：${url}`));
  return fetch(target, { ...options, credentials: 'omit', redirect: 'error' });
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
function optionalOnlyAsset(url) {
  try {
    const path = new URL(url, globalThis.location?.href || 'http://localhost/').pathname;
    return /^\/assets\/local\/playercards\/(?:good-boy|trickster-outbreak|duck-burnard|duck-flower|duck-brioche|hatchbudz-quacked|evori-(?:solari|lunari|amari|terrari|evori))\/card\.gif$/.test(path) ||
      /^\/assets\/char\/portrait\/(?:skin\/|[^/]+_2\.png$)/.test(path) || path.startsWith('/assets/local/scene/') || path.startsWith('/assets/local/mesh/trap_110/');
  } catch { return false; }
}
const downloadSources = new Map();
let compressionPromise;
const groupState = () => ({ total: 0, done: 0, bytes: 0, downloadedBytes: 0, running: false, paused: false, error: null });
const state = { checking: false, error: null, missing: null, cacheRevision: 0, storageProtection: null, source: '预载资源仅从 Win7 资源服务器获取；预载需主动开始，未缓存的必要资源按需获取。', required: groupState(), optional: groupState(), voice: groupState(), hdPortraits: groupState(), pack: { running: null, done: 0, total: 0, note: null, error: null } };

function snapshot() {
  return { ...state, required: { ...state.required }, optional: { ...state.optional }, voice: { ...state.voice }, hdPortraits: { ...state.hdPortraits }, pack: { ...state.pack } };
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
  if (!origin || !item?.groups?.includes('required')) return null;
  try {
    const url = new URL(item.url, origin);
    if (url.pathname === '/media/sfx/battle/b_ui/b_ui_alarmenter') return url.href;
    if (url.pathname !== '/assets/audio/sfx/battle/b_ui/b_ui_alarmenter.mp3') return null;
    return new URL(mediaUrl(url.href, origin), origin).href;
  } catch { return null; }
}

function key(url) {
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
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
  if (finished) complete.add(item.key); else complete.delete(item.key);
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
        const { gunzipSync } = await compression();
        return JSON.parse(new TextDecoder().decode(gunzipSync(bytes, { out: new Uint8Array(length) })));
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch { /* Retry the uncompressed manifest when the runtime index is unavailable. */ }
  const response = await fetchData('/data/resource-preload.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`资源清单加载失败（HTTP ${response.status}），请稍后重试。`);
  return response.json();
}

async function fetchManifest() {
  try {
    return await fetchManifestFrom((url, options) => fetch(url, options));
  } catch {
    // The app ships the matching manifest under /data; use the remote host only for deployments without it.
    return fetchManifestFrom(fetchResourceData);
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
        const targetGroup = group === 'required' && optionalOnlyAsset(sourceRaw.url) ? 'optional' : group;
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
        if (remote) mapped.set(remote, canonical);
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
    manifest = { groups };
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

function valid(record, item) {
  if (record?.url !== item.key || record.version !== item.version || record.bytes !== item.bytes ||
      record.type !== item.type || record.complete === false || !(record.blob instanceof Blob) || record.blob.size <= 0) return false;
  if (record.transport !== undefined) {
    return sameTransport(record.transport, item.transport) && record.blob.type === 'image/webp' && record.blob.size === item.transport.bytes;
  }
  return record.blob.size === item.bytes;
}

function partial(record, item) {
  return record?.url === item.key && record.version === item.version && record.bytes === item.bytes &&
    record.type === item.type && record.complete === false && record.transport === undefined && record.blob instanceof Blob &&
    record.blob.size > 0 && record.blob.size < item.bytes;
}

async function readRecord(item) {
  const db = await openDb();
  return new Promise((resolveRecord, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(item.key);
    let record;
    request.onsuccess = () => { record = request.result; };
    tx.oncomplete = () => resolveRecord(record);
    tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error('读取本地资源失败，请重试。'));
  });
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
      // 仅导出时确认原记录校验失败，才允许显式标记该完整记录损坏。
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
  discardObjectUrls(candidate => candidate?.key === item.key);
  if (complete.has(item.key)) state.cacheRevision++;
  updateItemProgress(item, bytes, false);
  notifyProgress();
}

async function scan() {
  const db = await openDb();
  return new Promise((resolveScan, reject) => {
    const found = new Set();
    const bytes = new Map();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const batchSize = 2048;
    let request;
    const next = (range) => {
      request = store.getAll(range, batchSize);
      request.onsuccess = () => {
        const records = request.result;
        // 同一只读事务内分批完整检查，仅取元数据及 Blob.size，不读取二进制内容。
        for (const record of records) {
          const item = entries.get(record.url);
          if (!item) continue;
          if (valid(record, item)) { found.add(item.key); bytes.set(item.key, item.bytes); }
          else if (partial(record, item)) bytes.set(item.key, record.blob.size);
        }
        if (records.length === batchSize) next(IDBKeyRange.lowerBound(records[records.length - 1].url, true));
      };
    };
    next();
    tx.oncomplete = () => resolveScan({ found, bytes });
    tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error('检查本地资源失败，请重试。'));
  });
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
      // One consistent IndexedDB snapshot is enough. Merge writes made while it was read,
      // rather than restarting forever when another download keeps changing the revision.
      const changed = scanChanges = new Set();
      const scanned = await scan();
      for (const url of changed) {
        if (complete.has(url)) scanned.found.add(url); else scanned.found.delete(url);
        if (savedBytes.has(url)) scanned.bytes.set(url, savedBytes.get(url)); else scanned.bytes.delete(url);
      }
      discardObjectUrls(item => !scanned.found.has(item.key));
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
  try {
    await loadManifest();
    try { await openDb(); } catch (error) {
      state.error = message(error);
      state.source = '本地存储暂不可用，必要资源仍可实时从 Win7 资源服务器获取；个性化资源需恢复本地存储后下载。';
      notify();
    }
    return true;
  } catch (error) {
    state.error = message(error);
    notify();
    return false;
  }
}

async function prefetchRequired(urls, { priority = 1 } = {}) {
  try {
    await loadManifest();
    const items = [...new Set(urls.filter(Boolean).map(url => resolve(mediaUrl(url))))]
      .filter(item => item?.groups.includes('required') && !complete.has(item.key));
    const results = await Promise.allSettled(items.map(item => saveItem(item, null, priority)));
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
  while (active < 3 && slots.length) {
    // At most two preloads: UI and battle assets always have a foreground slot available.
    const next = slots.findIndex(task => task.priority < 2 || activePreloads < 2);
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

async function packRange(url, start, end, total, signal) {
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
    });
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
    const { gunzipSync } = await compression();
    decoded = gunzipSync(bytes, { out: new Uint8Array(raw.bytes) });
  }
  if (decoded.length !== raw.bytes) throw new Error('解压资源大小与清单不符。');
  return new Blob([decoded], { type: raw.type });
}

async function prepareDownloadSource(group, manual = false, signal) {
  const source = { manual, rawOnly: true, records: new Map(), failed: new Set(), total: 0,
    url: new URL(`/assets/resource-${group === 'required' ? 'required-lossless' : group}.sprpack`, PRELOAD_RESOURCE_ORIGIN).href };
  try {
    const first = await packRange(source.url, 0, 11, undefined, signal);
    const prefix = packPrefix(first.bytes, first.total);
    const index = await packRange(source.url, 12, 11 + prefix.length, first.total, signal);
    const records = packRecords(JSON.parse(new TextDecoder().decode(index.bytes)), prefix, first.total);
    for (const record of records) if (packMatches(record)) source.records.set(record.item.key, record);
    source.rawOnly = false;
    source.total = first.total;
    state.source = '正在从 Win7 资源服务器获取缺少条目，已有完整缓存继续使用。';
  } catch (error) {
    if (signal?.aborted) throw error;
    // Raw fallback remains on the same host; game servers are never probed for resources.
    state.source = 'Win7 资源包暂不可用，将尝试同一 Win7 服务器的原始资源。';
  }
  notify();
  return source;
}

async function resourceResponse(item, start, source, signal) {
  const gameUrl = gameHostedRequiredAudio(item);
  if (gameUrl) {
    return fetch(gameUrl, { cache: 'no-store', signal, headers: start ? { Range: `bytes=${start}-` } : {} });
  }
  const packed = source && !source.rawOnly && !source.failed.has(item.key) && source.records.get(item.key);
  if (packed) {
    try {
      const { bytes } = await packRange(source.url, packed.offset, packed.offset + packed.storedBytes - 1, source.total, signal);
      const blob = await unpackResource(packed, bytes);
      return new Response(blob, { status: 200, headers: {
        'Content-Type': blob.type, 'X-Resource-Pack': '1', 'X-Resource-Encoding': packed.encoding,
      } });
    } catch (error) {
      if (signal?.aborted) throw error;
      source.failed.add(item.key);
      state.source = 'Win7 压缩条目暂不可用，将尝试同一 Win7 服务器的原始资源。';
      notify();
    }
  }
  const requestUrl = new URL(win7ResourceUrl(item.url));
  requestUrl.searchParams.set('__resourceVersion', item.version);
  return fetchResourceData(requestUrl.href, { cache: 'no-store', signal,
    headers: start ? { Range: `bytes=${start}-` } : {} });
}

async function requiredSource(item) {
  const group = item.pack?.group || (item.groups.includes('required') ? 'required' : item.groups.includes('optional') ? 'optional' : 'voice');
  if (item.pack) {
    const records = new Map([[item.key, { raw: item, item, ...item.pack }]]);
    return { rawOnly: false, failed: new Set(), records, total: item.pack.total,
      url: new URL(`/assets/resource-${group === 'required' ? 'required-lossless' : group}.sprpack`, PRELOAD_RESOURCE_ORIGIN).href };
  }
  // Raw illustrations are included individually in the Win7 package.
  if (win7PortraitUrl(item.url)) return null;
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
      if (!source || !source.records.has(item.key)) source = await requiredSource(item);
      const start = partial(record, item) ? record.blob.size : 0;
      invalidate(item, start);
      const response = await resourceResponse(item, start, source, controller?.signal);
      armTimeout();
      if (!response.ok || ![200, 206].includes(response.status)) {
        throw new Error(`资源下载失败（HTTP ${response.status}）：${item.url}`);
      }
      const packedResponse = response.headers.get('X-Resource-Pack') === '1';
      const transport = packedResponse && response.headers.get('X-Resource-Encoding') === 'webp-lossless'
        ? item.transport : undefined;
      const expectedBytes = transport?.bytes || item.bytes;
      const contentType = transport?.type || item.type;
      const expectedVersion = transport?.version || item.version;
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
      if (await resourceHash(blob) !== expectedVersion) {
        if (packedResponse) {
          source.failed.add(item.key);
          const error = new Error(`压缩资源内容校验失败：${item.url}`);
          error.packFallback = true;
          throw error;
        }
        const saved = await writeRecord(item, blob, false);
        if (!valid(saved, item)) invalidate(item);
        throw new Error(`资源内容校验失败：${item.url}，请重试。`);
      }
      try { return await writeRecord(item, blob, true, false, transport); } catch (error) {
        // 内容已校验通过。按需读取可直接使用，不因持久存储额度不足再下载一次。
        error.validatedResource = { item, blob };
        throw error;
      }
    }
    return record;
    };
    let saved;
    try { saved = await store(); } catch (error) {
      if (!error.packFallback) throw error;
      state.source = 'Win7 压缩条目校验失败，将尝试同一 Win7 服务器的原始资源。';
      notify();
      saved = await store();
    }
    updateItemProgress(item, item.bytes, true);
    state.cacheRevision++;
    if (state.missing === item.key) state.missing = null;
    notifyProgress();
    // writeRecord may retain another page's complete record; return what actually committed.
    return saved;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
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
    downloadedBytes: items.reduce((n, item) => n + (savedBytes.get(item.key) || 0), 0) };
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
      const items = selectionItems(group, options);
      let source = null;
      if (!control.paused && items.some(item => !complete.has(item.key) && !item.pack && !win7PortraitUrl(item.url))) {
        // 主动下载 source 只属于本轮下载，不与游戏内按需 source 共用。
        source = await prepareDownloadSource(group, true, control.controller.signal);
      }
      await Promise.all(Array.from({ length: Math.min(options.background ? 1 : 3, items.length) }, async () => {
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
      // Every saved item has already been hashed and committed. A full database scan here can
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

async function resourceHash(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('');
  }
  // Public HTTP origins do not expose SubtleCrypto; keep the same SHA256 check there.
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const words = new Uint32Array(64);
  const rotate = (n, shift) => (n >>> shift) | (n << (32 - shift));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    const next = [a,b,c,d,e,f,g,h];
    for (let i = 0; i < 8; i++) hash[i] += next[i];
  }
  return Array.from(hash, n => n.toString(16).padStart(8, '0')).join('');
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
      if (await resourceHash(record.blob) !== (transport?.version || item.version)) {
        await writeRecord(item, record.blob, false, true, transport);
        invalidate(item);
        throw new Error(`本地资源校验失败，请补充下载后导出：${item.url}`);
      }
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
        const transport = packed.encoding === 'webp-lossless' ? item.transport : undefined;
        if (await resourceHash(blob) !== (transport?.version || item.version)) throw new Error(`资源包内容校验失败：${raw.url}。此前成功导入的资源已保留。`);
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
  try { await loadManifest(); } catch (error) {
    state.error = message(error);
    ready = false;
    notify();
    throw error;
  }
  return cachedBlobItem(resolve(mediaUrl(url)));
}

async function availableBlob(url) {
  await loadManifest();
  const item = resolve(mediaUrl(url));
  const onDemand = item?.groups.includes('required');
  let hit;
  try { hit = await cachedBlobItem(item); } catch (error) {
    // 隐私模式、禁用 IndexedDB 等情况只影响本地预载，不阻断必要游戏资源。
    if (!onDemand) throw missingResource(url);
    return onlineRequiredBlob(item);
  }
  if (hit) return hit;
  if (!onDemand) throw missingResource(url);
  void protectResources();
  try {
    const saved = await saveItem(item, null, 0);
    if (!valid(saved, item)) throw new Error(`资源下载后未能写入缓存：${url}`);
    return { item, blob: saved.blob };
  } catch (error) {
    state.error = message(error);
    notify();
    if (error.validatedResource) return error.validatedResource;
    throw error;
  }
}

const onlineJobs = new Map();
function onlineRequiredBlob(item) {
  if (onlineJobs.has(item.key)) return onlineJobs.get(item.key);
  const job = withSlot(async () => {
    const source = await requiredSource(item);
    const response = await resourceResponse(item, 0, source);
    if (!response.ok) throw new Error(`资源下载失败（HTTP ${response.status}）：${item.url}`);
    const transport = response.headers.get('X-Resource-Encoding') === 'webp-lossless' ? item.transport : null;
    const blob = await response.blob();
    if (blob.size !== (transport?.bytes || item.bytes) || await resourceHash(blob) !== (transport?.version || item.version)) {
      throw new Error(`资源内容与清单不符：${item.url}，请重试。`);
    }
    return { item, blob };
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
  const item = resolve(mediaUrl(url));
  const id = item && JSON.stringify([item.key, item.version]);
  const cached = id && !state.clearing && complete.has(item.key) ? objectUrls.get(id) : null;
  if (cached && !cached.stale) return retainObjectUrl(id, cached);
  const hit = cachedOnly ? await cachedBlob(url) : await availableBlob(url);
  if (!hit) throw missingResource(url);
  const hitId = JSON.stringify([hit.item.key, hit.item.version]);
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
  isCached(url) { const item = resolve(mediaUrl(url)); return !!item && complete.has(item.key); },
  isReady() { return ready; },
};
