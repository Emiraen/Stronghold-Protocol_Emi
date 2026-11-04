import { MUSIC_PLAYLISTS, loadMusicPlaylist, loadMusicTrack, parseMusicPackHeader } from './musicSources.js';

export const MUSIC_PRELOAD_GROUPS = Object.freeze([
  Object.freeze({ id: 'ost', category: 'ost-music', title: '明日方舟 OST', label: 'ARKNIGHTS OST' }),
  Object.freeze({ id: 'personal', category: 'personal-music', title: 'Emi 的歌单', label: 'EMI PLAYLIST' }),
]);

const listeners = new Set(), jobs = new Map();
const state = Object.fromEntries(MUSIC_PRELOAD_GROUPS.map(group => [group.id, {
  total: 0, done: 0, bytes: 0, downloadedBytes: 0, currentBytes: 0,
  loading: false, running: false, importing: false, paused: false, error: '', currentTitle: '',
}]));
let databasePromise;
const cacheKey = track => track.playlistId + ':' + track.id + ':' + track.version;
const checkAbort = signal => { if (signal.aborted) throw signal.reason || new DOMException('已暂停音乐预载', 'AbortError'); };
const snapshot = () => Object.fromEntries(Object.entries(state).map(([id, value]) => [id, { ...value }]));
const publish = () => { for (const listener of listeners) listener(snapshot()); };

// Use the player's existing per-song cache, so preloaded songs need no second
// download. Only one track per selected music group is held during a transfer.
function database() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持音乐缓存')); return; }
    const request = indexedDB.open('sp-music-resource-cache', 1);
    let failed = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('tracks')) request.result.createObjectStore('tracks');
    };
    request.onerror = request.onblocked = () => { failed = true; reject(new Error('无法打开音乐缓存，请关闭其他旧版游戏页面后重试')); };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = null; };
      db.onclose = () => { databasePromise = null; };
      resolve(db);
    };
  }).catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}

async function cacheOperation(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('tracks', mode), request = action(transaction.objectStore('tracks'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error('音乐缓存保存失败，请释放本机存储空间后继续'));
  });
}

function updateCounts(id, playlist, keys) {
  const value = state[id];
  value.total = playlist.tracks.length;
  value.bytes = playlist.tracks.reduce((sum, track) => sum + track.bytes, 0);
  const completed = playlist.tracks.filter(track => keys.has(cacheKey(track)));
  value.done = completed.length;
  value.downloadedBytes = completed.reduce((sum, track) => sum + track.bytes, 0);
}

async function catalog(id, signal) {
  const playlist = await loadMusicPlaylist(id, { signal });
  if (signal) checkAbort(signal);
  const keys = new Set(await cacheOperation('readonly', table => table.getAllKeys()));
  if (signal) checkAbort(signal);
  updateCounts(id, playlist, keys);
  return { playlist, keys };
}

async function refresh(id) {
  if (jobs.has(id) || state[id].loading) return;
  state[id].loading = true; state[id].error = ''; publish();
  try { await catalog(id); }
  catch (error) { state[id].error = error.message || '音乐歌单读取失败'; }
  finally { state[id].loading = false; publish(); }
}

async function download(id) {
  if (!state[id] || jobs.has(id)) return;
  const controller = new AbortController(), signal = controller.signal, value = state[id];
  jobs.set(id, controller);
  Object.assign(value, { running: true, importing: false, paused: false, error: '', currentBytes: 0 }); publish();
  try {
    const { playlist, keys } = await catalog(id, signal); publish();
    for (const track of playlist.tracks) {
      checkAbort(signal);
      const key = cacheKey(track);
      if (keys.has(key)) continue;
      value.currentTitle = track.title; value.currentBytes = 0; publish();
      const blob = await loadMusicTrack(track, { signal, onProgress: received => {
        if (signal.aborted) return;
        value.currentBytes = Math.min(track.bytes, received); publish();
      } });
      checkAbort(signal);
      // Playback can tolerate memory-only caching; a preload must actually be
      // saved before it is counted as downloaded.
      if (await cacheOperation('readonly', table => table.getKey(key)) === undefined)
        await cacheOperation('readwrite', table => table.put(blob, key));
      keys.add(key); value.done++; value.downloadedBytes += track.bytes;
      value.currentBytes = 0; publish();
    }
  } catch (error) {
    if (signal.aborted) value.paused = true;
    else value.error = error.message || '音乐预载失败，请重试';
  } finally {
    if (jobs.get(id) === controller) jobs.delete(id);
    Object.assign(value, { running: false, currentBytes: 0, currentTitle: '' }); publish();
  }
}

async function importPack(file) {
  if (!file || file.size < 12) return false;
  const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(prefix.subarray(0, 8)) !== 'SPPACK03') return false;
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(8, true);
  if (!length || length > 16 * 1024 * 1024 || length + 12 >= file.size) return false;
  const header = JSON.parse(await file.slice(12, 12 + length).text());
  if (header.kind !== 'music') return false;
  const descriptor = MUSIC_PLAYLISTS.find(group => group.id === header.music?.id);
  if (!descriptor) throw new Error('未知音乐资源包类别');
  const id = descriptor.id, value = state[id];
  if (jobs.has(id)) throw new Error('该歌单正在预载，请暂停后再导入');
  const playlist = parseMusicPackHeader(descriptor, header, length, file.size);
  const controller = new AbortController(), signal = controller.signal;
  jobs.set(id, controller);
  Object.assign(value, { running: true, importing: true, paused: false, error: '', currentBytes: 0 }); publish();
  try {
    const keys = new Set(await cacheOperation('readonly', table => table.getAllKeys()));
    updateCounts(id, playlist, keys); publish();
    for (const track of playlist.tracks) {
      checkAbort(signal);
      const key = cacheKey(track);
      if (keys.has(key)) continue;
      value.currentTitle = track.title; publish();
      // File.slice keeps multi-gigabyte packs out of JavaScript memory.
      await cacheOperation('readwrite', table => table.put(file.slice(track.offset, track.offset + track.bytes, track.type), key));
      value.done++; value.downloadedBytes += track.bytes; keys.add(key); publish();
    }
  } catch (error) {
    if (signal.aborted) value.paused = true;
    else value.error = error.message || '音乐资源包导入失败';
  } finally {
    if (jobs.get(id) === controller) jobs.delete(id);
    Object.assign(value, { running: false, importing: false, currentBytes: 0, currentTitle: '' }); publish();
  }
  return true;
}

export const musicPreload = {
  getState: snapshot,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  refresh(id) { return id && state[id] ? refresh(id) : Promise.all(MUSIC_PRELOAD_GROUPS.map(group => refresh(group.id))); },
  download,
  importPack,
  pause(id) {
    for (const [groupId, controller] of jobs) {
      if (id && groupId !== id) continue;
      state[groupId].paused = true;
      controller.abort(new DOMException('已暂停音乐预载', 'AbortError'));
    }
    publish();
  },
};
