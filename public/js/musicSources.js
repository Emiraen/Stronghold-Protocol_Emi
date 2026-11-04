// Music catalogues and bytes come only from the external resource service.
// Opening the panel reads small pack headers; a song is fetched only on demand.
import { readMusicPackRange as readExternalPackRange } from './preloadSources.js';

export const MUSIC_PLAYLISTS = Object.freeze([
  Object.freeze({ id: 'ost', title: '明日方舟原声带', category: 'ost-music', packName: 'resource-music-ost-20261103.sprpack' }),
  Object.freeze({ id: 'personal', title: 'The music so good even a devil may cry', category: 'personal-music', packName: 'resource-music-personal-20261103.sprpack' }),
]);

const HEADER_LIMIT = 16 * 1024 * 1024;
const DATABASE = 'sp-music-resource-cache', TABLE = 'tracks';
const catalogFlights = new Map(), trackFlights = new Map(), recent = new Map();
let databasePromise;
const abortError = signal => signal?.reason || new DOMException('请求已取消', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(signal); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const notify = (listener, ...args) => { try { listener?.(...args); } catch { /* A view does not own the transfer. */ } };

function database() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持音乐缓存')); return; }
    const request = indexedDB.open(DATABASE, 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE);
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(new Error('音乐缓存暂不可用'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      db.onclose = () => { databasePromise = undefined; };
      resolve(db);
    };
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

async function cacheOperation(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TABLE, mode);
    const request = action(transaction.objectStore(TABLE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error('音乐缓存读写失败'));
  });
}

function keepRecent(key, blob) {
  recent.delete(key); recent.set(key, blob);
  // Keep only the active/next song in memory. Completed songs remain in IndexedDB.
  while (recent.size > 2) recent.delete(recent.keys().next().value);
  return blob;
}

function trackKey(track) {
  if (!track || typeof track.id !== 'string' || !track.id || typeof track.version !== 'string' || !track.version
    || !MUSIC_PLAYLISTS.some(playlist => playlist.id === track.playlistId && playlist.packName === track.packName)
    || !integer(track.offset) || !integer(track.bytes) || !track.bytes || !integer(track.packBytes)
    || track.offset + track.bytes > track.packBytes || !String(track.type).startsWith('audio/')) {
    throw new Error('歌曲资源信息无效，请重新打开大厅音乐');
  }
  return track.playlistId + ':' + track.id + ':' + track.version;
}

// All offsets are derived from the resource-service header, never from a bundled
// game-server song list. This also permits future releases with different songs.
export function parseMusicPackHeader(descriptor, header, headerLength, packBytes) {
  const music = header?.music;
  if (header?.schema !== 3 || music?.schema !== 1 || music.id !== descriptor.id
    || music.category !== descriptor.category || !Array.isArray(music.tracks)
    || !Array.isArray(header.resources) || !integer(headerLength) || headerLength > HEADER_LIMIT
    || !integer(packBytes) || packBytes <= 12 + headerLength) throw new Error('音乐资源包的歌单格式无效');
  const resources = new Map();
  let offset = 12 + headerLength;
  for (const row of header.resources) {
    if (typeof row?.url !== 'string' || resources.has(row.url) || !integer(row.bytes) || !row.bytes
      || row.encoding !== 'identity' || row.storedBytes !== row.bytes || !integer(row.storedBytes)
      || typeof row.version !== 'string' || !row.version || typeof row.type !== 'string') {
      throw new Error('音乐资源包的资源目录无效');
    }
    resources.set(row.url, { ...row, offset }); offset += row.storedBytes;
    if (!Number.isSafeInteger(offset) || offset > packBytes) throw new Error('音乐资源包的歌曲区间无效');
  }
  if (offset !== packBytes) throw new Error('音乐资源包的大小与歌单不符');
  const title = typeof music.title === 'string' && music.title.trim() ? music.title.trim() : descriptor.title;
  const ids = new Set();
  const tracks = music.tracks.map(track => {
    const row = resources.get(track?.url);
    if (!row || typeof track.id !== 'string' || !track.id || ids.has(track.id)
      || typeof track.title !== 'string' || !track.title || !row.type.startsWith('audio/')
      || track.bytes !== row.bytes || track.type !== row.type || track.version !== row.version) {
      throw new Error('音乐资源包包含无效歌曲');
    }
    ids.add(track.id);
    return Object.freeze({ id: track.id, title: track.title, artist: descriptor.id !== 'ost' && typeof track.artist === 'string' ? track.artist : '',
      duration: Number.isFinite(track.duration) && track.duration >= 0 ? track.duration : null,
      url: row.url, bytes: row.bytes, type: row.type, version: row.version, offset: row.offset,
      playlistId: descriptor.id, playlistTitle: title, packName: descriptor.packName, packBytes });
  });
  return Object.freeze({ ...descriptor, title, tracks: Object.freeze(tracks) });
}

function joinFlight(map, key, make, { signal, onProgress } = {}) {
  checkAbort(signal);
  let entry = map.get(key);
  if (!entry || entry.controller.signal.aborted) {
    entry = { controller: new AbortController(), listeners: new Set(), progress: null };
    map.set(key, entry);
    entry.promise = Promise.resolve().then(() => make(entry.controller.signal, (received, total) => {
      entry.progress = [received, total];
      for (const listener of entry.listeners) notify(listener.onProgress, received, total);
    })).finally(() => { if (map.get(key) === entry) map.delete(key); });
  }
  return new Promise((resolve, reject) => {
    const listener = { onProgress };
    entry.listeners.add(listener);
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      entry.listeners.delete(listener);
    };
    const abort = () => {
      finish();
      if (!entry.listeners.size) entry.controller.abort(abortError(signal));
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (entry.progress) notify(onProgress, ...entry.progress);
    entry.promise.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
    if (signal?.aborted) abort();
  });
}

export async function loadMusicPlaylist(id, options = {}) {
  const descriptor = MUSIC_PLAYLISTS.find(playlist => playlist.id === id);
  if (!descriptor) throw new Error('未知音乐歌单');
  // Share simultaneous opens only; remove the flight after it finishes so the
  // next open always asks the external resource service for the current list.
  return joinFlight(catalogFlights, id, async signal => {
    try {
      const first = await readExternalPackRange(descriptor.packName, 0, 11, { signal });
      if (first.bytes.length !== 12 || new TextDecoder().decode(first.bytes.subarray(0, 8)) !== 'SPPACK03') {
        throw new Error('音乐资源包格式无效');
      }
      const length = new DataView(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength).getUint32(8, true);
      if (!length || length > HEADER_LIMIT || length + 12 >= first.total) throw new Error('音乐歌单大小无效');
      const second = await readExternalPackRange(descriptor.packName, 12, 11 + length, { signal, total: first.total });
      const header = JSON.parse(new TextDecoder().decode(second.bytes));
      return parseMusicPackHeader(descriptor, header, length, first.total);
    } catch (error) {
      checkAbort(signal);
      throw new Error('无法从资源服务器获取“' + descriptor.title + '”歌单：' + (error?.message || '下载失败'));
    }
  }, options);
}

export async function loadMusicTrack(track, options = {}) {
  const key = trackKey(track);
  checkAbort(options.signal);
  if (recent.has(key)) {
    notify(options.onProgress, track.bytes, track.bytes);
    return keepRecent(key, recent.get(key));
  }
  return joinFlight(trackFlights, key, async (signal, onProgress) => {
    // Cache failure must not prevent music playback (e.g. private browsing or a
    // full device). A successful network response can still play in memory.
    let cached;
    try { cached = await cacheOperation('readonly', table => table.get(key)); } catch { /* Use resource service. */ }
    checkAbort(signal);
    if (cached instanceof Blob) { onProgress(track.bytes, track.bytes); return keepRecent(key, cached); }
    try {
      const { bytes } = await readExternalPackRange(track.packName, track.offset, track.offset + track.bytes - 1,
        { signal, total: track.packBytes, onProgress });
      checkAbort(signal);
      const blob = new Blob([bytes], { type: track.type });
      keepRecent(key, blob);
      try { await cacheOperation('readwrite', table => table.put(blob, key)); } catch { /* Play the in-memory song. */ }
      checkAbort(signal);
      return blob;
    } catch (error) {
      checkAbort(signal);
      throw new Error('无法从资源服务器下载“' + track.title + '”：' + (error?.message || '下载失败'));
    }
  }, options);
}

export async function clearMusicTrackCache() {
  recent.clear();
  for (const entry of trackFlights.values()) entry.controller.abort(new DOMException('音乐缓存已清理', 'AbortError'));
  await cacheOperation('readwrite', table => table.clear());
}
