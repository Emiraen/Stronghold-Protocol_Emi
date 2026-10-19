// Player-selected media stays in this browser. This module never uses fetch or the game connection.
const DATABASE = 'sp-east-local-media';
const TABLE = 'assets';
let pendingDatabase;

function database() {
  if (pendingDatabase) return pendingDatabase;
  pendingDatabase = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持本地媒体存储')); return; }
    const request = indexedDB.open(DATABASE, 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE);
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(new Error('本地媒体存储暂不可用，请关闭其他游戏标签页后重试'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); pendingDatabase = null; };
      db.onclose = () => { pendingDatabase = null; };
      resolve(db);
    };
  }).catch(error => { pendingDatabase = null; throw error; });
  return pendingDatabase;
}

async function transaction(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, mode);
    const request = action(tx.objectStore(TABLE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(new Error('本地媒体保存失败，请检查浏览器可用空间'));
  });
}

export const getLocalMedia = key => transaction('readonly', table => table.get(key));
export const putLocalMedia = (key, value) => transaction('readwrite', table => table.put(value, key));
export const deleteLocalMedia = key => transaction('readwrite', table => table.delete(key));

/** Decode a local image directly; object URLs never need an HTTP request or a cache repair. */
export function readLocalImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const finish = error => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      if (error) { img.src = ''; reject(error); } else resolve(img);
    };
    const timer = setTimeout(() => finish(new Error('图片读取超时，请换一个文件')), 15000);
    img.onload = () => img.naturalWidth && img.naturalHeight
      ? finish() : finish(new Error('图片文件无效'));
    img.onerror = () => finish(new Error('浏览器无法读取该图片'));
    img.decoding = 'async';
    img.src = url;
  });
}

/** Validate a local audio/video Blob and release its temporary player and URL in every outcome. */
export async function probeLocalMedia(blob, kind) {
  const url = URL.createObjectURL(blob);
  const element = document.createElement(kind);
  element.preload = 'metadata';
  element.muted = true;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('媒体读取超时，请换一个文件')), 12000);
      element.onloadedmetadata = () => {
        if (!Number.isFinite(element.duration) || element.duration <= 0) {
          reject(new Error('媒体文件无效')); return;
        }
        if (kind === 'video' && (!element.videoWidth || !element.videoHeight)) {
          reject(new Error('视频文件无效')); return;
        }
        resolve({ duration: element.duration, width: element.videoWidth, height: element.videoHeight });
      };
      element.onerror = () => reject(new Error(kind === 'video'
        ? '浏览器无法播放该视频，请使用 H.264 MP4 或 WebM'
        : '浏览器无法播放该音频，请使用 MP3 或 M4A'));
      element.src = url;
    });
  } finally {
    clearTimeout(timer);
    element.onloadedmetadata = element.onerror = null;
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}
