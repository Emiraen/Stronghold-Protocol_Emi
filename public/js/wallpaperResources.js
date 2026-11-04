// Optional lobby media is read from the resource service or an explicitly imported pack.
import { readResourcePackRange } from './preloadSources.js';
import { WALLPAPER_PACK_NAME } from './wallpaperPackFiles.js';

const LIMIT = 8 * 1024 * 1024;
const listeners = new Set(), flights = new Map();
const state = { items: [], loaded: false, loading: false, running: false, importing: false,
  groups: [],
  paused: false, error: '', total: 0, done: 0, bytes: 0, downloadedBytes: 0, currentBytes: 0, currentTitle: '' };
let databasePromise, refreshFlight, controller, active = 0;
const queue = [];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const key = resource => resource.url + ':' + resource.version;
const aborted = signal => { if (signal?.aborted) throw signal.reason || new DOMException('已取消壁纸读取', 'AbortError'); };
const snapshot = () => ({ ...state, items: [...state.items], groups: [...state.groups] });
const publish = () => { for (const listener of listeners) listener(snapshot()); };

function database() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持壁纸缓存')); return; }
    const request = indexedDB.open('sp-hub-wallpaper-cache', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('resources'); request.result.createObjectStore('catalog');
    };
    request.onerror = request.onblocked = () => reject(new Error('壁纸缓存暂不可用'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = null; };
      db.onclose = () => { databasePromise = null; };
      resolve(db);
    };
  }).catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}

async function cache(table, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(table, mode), request = action(transaction.objectStore(table));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error('壁纸保存失败，请检查本机存储空间'));
  });
}

export function parseWallpaperPackHeader(header, length, total) {
  const catalog = header?.wallpapers;
  if (header?.schema !== 3 || header.kind !== 'hub-wallpapers' || catalog?.schema !== 1
    || catalog.id !== 'hub-wallpapers' || !Array.isArray(catalog.items) || !Array.isArray(header.resources)
    || !integer(length) || !length || length > LIMIT || !integer(total) || total <= length + 12)
    throw new Error('大厅壁纸资源包格式无效');
  const rows = new Map();
  let offset = length + 12;
  for (const row of header.resources) {
    if (!row || !/^\/assets\/hub-wallpapers\/(?:videos|covers)\/[A-Za-z0-9._-]+$/.test(row.url)
      || rows.has(row.url) || !integer(row.bytes) || !row.bytes || row.storedBytes !== row.bytes
      || row.encoding !== 'identity' || !/^[0-9a-f]{64}$/i.test(row.version || '')
      || !['video/mp4', 'image/webp', 'image/jpeg'].includes(row.type)) throw new Error('壁纸资源目录无效');
    rows.set(row.url, Object.freeze({ ...row, offset, packBytes: total }));
    offset += row.bytes;
    if (!Number.isSafeInteger(offset) || offset > total) throw new Error('壁纸资源区间无效');
  }
  if (offset !== total) throw new Error('壁纸资源包大小不符');
  const ids = new Set();
  const sourceGroups = catalog.groups;
  if (!Array.isArray(sourceGroups) || !sourceGroups.length || sourceGroups.length > 12)
    throw new Error('壁纸分组目录无效');
  const groupIds = new Set();
  const groups = sourceGroups.map(group => {
    if (!group || typeof group.id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(group.id) || groupIds.has(group.id)
      || typeof group.title !== 'string' || !group.title.trim() || group.title.length > 80) throw new Error('壁纸分组目录无效');
    groupIds.add(group.id); return { id: group.id, title: group.title };
  });
  const items = catalog.items.map(item => {
    const video = rows.get(item?.url), cover = rows.get(item?.cover);
    if (!item || !groupIds.has(item.group) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200
      || video?.type !== 'video/mp4' || !cover?.type.startsWith('image/')
      || item.width !== 1920 || item.height !== 1080 || !Number.isFinite(item.duration) || item.duration <= 0
      || item.version !== video.version || item.bytes !== video.bytes) throw new Error('壁纸条目信息无效');
    ids.add(item.id);
    return Object.freeze({ id: item.id, title: item.title, group: item.group, width: 1920, height: 1080,
      duration: item.duration, hasAudio: item.hasAudio === true, video, cover });
  });
  return { items, groups, resources: [...rows.values()], total };
}

function counts(catalog, keys) {
  state.total = catalog.items.length; state.bytes = catalog.resources.reduce((sum, row) => sum + row.bytes, 0);
  state.done = catalog.items.filter(item => keys.has(key(item.video)) && keys.has(key(item.cover))).length;
  state.downloadedBytes = catalog.resources.reduce((sum, row) => sum + (keys.has(key(row)) ? row.bytes : 0), 0);
}

async function storedCatalog() { return cache('catalog', 'readonly', table => table.get('current')); }
async function rememberCatalog(catalog) { await cache('catalog', 'readwrite', table => table.put(catalog, 'current')); }

async function refresh() {
  if (refreshFlight) return refreshFlight;
  state.loading = true; state.error = ''; publish();
  refreshFlight = (async () => {
    let catalog;
    try {
      const first = await readResourcePackRange(WALLPAPER_PACK_NAME, 0, 11);
      if (new TextDecoder().decode(first.bytes.subarray(0, 8)) !== 'SPPACK03') throw new Error('壁纸包格式无效');
      const length = new DataView(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength).getUint32(8, true);
      if (!length || length > LIMIT || length + 12 >= first.total) throw new Error('壁纸目录大小无效');
      const second = await readResourcePackRange(WALLPAPER_PACK_NAME, 12, length + 11, { total: first.total });
      catalog = parseWallpaperPackHeader(JSON.parse(new TextDecoder().decode(second.bytes)), length, first.total);
      try { await rememberCatalog(catalog); } catch { /* Current session can still show the catalogue. */ }
    } catch (error) {
      try { catalog = await storedCatalog(); } catch { /* Show the source failure below. */ }
      if (!catalog) { state.error = '大厅壁纸资源暂不可用，可在资源预载中导入壁纸包。'; throw error; }
    }
    state.items = catalog.items; state.groups = catalog.groups; state.loaded = true;
    let keys = new Set();
    try { keys = new Set(await cache('resources', 'readonly', table => table.getAllKeys())); } catch { /* Optional cache unavailable. */ }
    counts(catalog, keys);
    return catalog;
  })().finally(() => { state.loading = false; refreshFlight = null; publish(); });
  return refreshFlight;
}

function enqueue(operation) {
  return new Promise((resolve, reject) => {
    queue.push(() => { active++; operation().then(resolve, reject).finally(() => {
      active--; if (queue.length) queue.shift()();
    }); });
    if (active < 3) queue.shift()();
  });
}

async function load(resource, { signal, cachedOnly = false, onProgress } = {}) {
  aborted(signal);
  const id = key(resource);
  let blob;
  try { blob = await cache('resources', 'readonly', table => table.get(id)); } catch { /* Download only after explicit selection. */ }
  aborted(signal);
  if (blob instanceof Blob) return blob;
  if (cachedOnly) return null;
  if (!flights.has(id)) {
    const flight = enqueue(async () => {
      aborted(signal);
      const { bytes } = await readResourcePackRange(WALLPAPER_PACK_NAME, resource.offset,
        resource.offset + resource.bytes - 1, { signal, total: resource.packBytes, onProgress });
      aborted(signal);
      const value = new Blob([bytes], { type: resource.type });
      try { await cache('resources', 'readwrite', table => table.put(value, id)); } catch { /* Can use the selected wallpaper for this session. */ }
      return value;
    }).finally(() => flights.delete(id));
    flights.set(id, flight);
  }
  return flights.get(id);
}

export const loadWallpaperCover = (item, options) => load(item.cover, options);
export const loadWallpaperVideo = (item, options) => load(item.video, options);
export async function getCachedWallpaper(id) {
  const catalog = await storedCatalog();
  const item = catalog?.items.find(value => value.id === id);
  if (!item) return null;
  const blob = await loadWallpaperVideo(item, { cachedOnly: true });
  return blob ? { item, blob } : null;
}

async function download() {
  if (controller) return;
  const control = controller = new AbortController();
  Object.assign(state, { running: true, paused: false, error: '', currentBytes: 0 }); publish();
  try {
    const catalog = await refresh();
    const keys = new Set(await cache('resources', 'readonly', table => table.getAllKeys()));
    counts(catalog, keys);
    for (const item of catalog.items) {
      state.currentTitle = item.title;
      for (const row of [item.cover, item.video]) {
        aborted(control.signal);
        if (keys.has(key(row))) continue;
        const blob = await load(row, { signal: control.signal, onProgress: received => { state.currentBytes = received; publish(); } });
        aborted(control.signal);
        await cache('resources', 'readwrite', table => table.put(blob, key(row)));
        keys.add(key(row)); state.currentBytes = 0; counts(catalog, keys); publish();
      }
    }
  } catch (error) { if (control.signal.aborted) state.paused = true; else state.error = error.message || '壁纸预载失败'; }
  finally { controller = null; Object.assign(state, { running: false, currentBytes: 0, currentTitle: '' }); publish(); }
}

async function importPack(file) {
  if (!file || file.size < 12) return false;
  const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(prefix.subarray(0, 8)) !== 'SPPACK03') return false;
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(8, true);
  if (!length || length > LIMIT || length + 12 >= file.size) return false;
  const header = JSON.parse(await file.slice(12, length + 12).text());
  if (header.kind !== 'hub-wallpapers') return false;
  if (controller) throw new Error('壁纸正在预载，请先暂停');
  const catalog = parseWallpaperPackHeader(header, length, file.size);
  const control = controller = new AbortController();
  Object.assign(state, { items: catalog.items, groups: catalog.groups, loaded: true, running: true, importing: true, error: '', paused: false }); publish();
  try {
    const keys = new Set(await cache('resources', 'readonly', table => table.getAllKeys()));
    counts(catalog, keys);
    for (const row of catalog.resources) {
      aborted(control.signal);
      if (keys.has(key(row))) continue;
      await cache('resources', 'readwrite', table => table.put(file.slice(row.offset, row.offset + row.bytes, row.type), key(row)));
      keys.add(key(row)); counts(catalog, keys); publish();
    }
    await rememberCatalog(catalog);
  } catch (error) { if (control.signal.aborted) state.paused = true; else state.error = error.message || '壁纸导入失败'; }
  finally { controller = null; Object.assign(state, { running: false, importing: false }); publish(); }
  return true;
}

export const wallpaperResources = {
  getState: snapshot,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  refresh, download, importPack,
  pause() { state.paused = true; controller?.abort(new DOMException('已暂停壁纸预载', 'AbortError')); publish(); },
  async clear() {
    if (controller) throw new Error('请先暂停壁纸预载');
    await cache('resources', 'readwrite', table => table.clear());
    state.done = state.downloadedBytes = 0; publish();
  },
};
