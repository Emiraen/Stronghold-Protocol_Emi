// One cursor filename per request. File bodies follow their length-delimited JSON header.
export const PRELOAD_STREAM_TYPE = 'application/x-stronghold-resources';
export const PRELOAD_CURSOR_KEY = 'stronghold-preload-cursor-v1:';
const decoder = new TextDecoder();

export function resourceFilename(url) {
  const value = new URL(url, globalThis.location?.href || 'http://localhost/');
  return value.pathname.replace(/(?:\[|%5b)/ig, '%5B').replace(/(?:\]|%5d)/ig, '%5D') + value.search;
}

export function storedPreloadCursor(group, generation) {
  try {
    const cursor = JSON.parse(localStorage.getItem(PRELOAD_CURSOR_KEY + group));
    return cursor?.generation === generation && typeof cursor.url === 'string' ? cursor.url : null;
  } catch { return null; }
}

export function savePreloadCursor(group, generation, url) {
  try { localStorage.setItem(PRELOAD_CURSOR_KEY + group, JSON.stringify({ generation, url: resourceFilename(url) })); }
  catch { /* Storage denial does not prevent the download. */ }
}

/** Reads at most one compressed resource at a time; IndexedDB commits apply backpressure. */
export async function consumePreloadStream(response, { signal, onStart, onFile, onProgress, onEnd }) {
  if (!response.ok || response.headers.get('Content-Type')?.split(';')[0] !== PRELOAD_STREAM_TYPE || !response.body) {
    try { await response.body?.cancel(); } catch { /* Invalid source. */ }
    throw new Error('资源续传服务暂不可用。');
  }
  const reader = response.body.getReader();
  let chunk = new Uint8Array(), offset = 0, count = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const cancelled = () => { if (signal?.aborted) throw signal.reason || new DOMException('请求已取消', 'AbortError'); };
  async function fill() {
    cancelled();
    let timer;
    const result = await Promise.race([reader.read(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new Error('资源续传长时间未收到数据。'));
      }, 30000);
    })]).finally(() => clearTimeout(timer));
    cancelled();
    if (result.done) return false;
    chunk = result.value; offset = 0;
    return true;
  }
  async function line() {
    const parts = []; let size = 0;
    while (true) {
      if (offset === chunk.length && !await fill()) throw new Error('资源续传意外中断。');
      const end = chunk.indexOf(10, offset), until = end < 0 ? chunk.length : end;
      const part = chunk.subarray(offset, until);
      size += part.length;
      if (size > 65536) throw new Error('资源续传条目过大。');
      parts.push(part); offset = end < 0 ? until : end + 1;
      if (end >= 0) {
        const bytes = new Uint8Array(size); let at = 0;
        for (const part of parts) { bytes.set(part, at); at += part.length; }
        return JSON.parse(decoder.decode(bytes));
      }
    }
  }
  try {
    cancelled();
    const start = await line();
    if (start.schema !== 1 || !Number.isSafeInteger(start.total) || start.total < 0) throw new Error('资源续传信息无效。');
    await onStart?.(start);
    while (true) {
      cancelled();
      const entry = await line();
      if (entry.done === true) {
        if (count !== start.total) throw new Error('资源续传数量不完整。');
        await onEnd?.(entry);
        return count;
      }
      if (typeof entry.url !== 'string' || !Number.isSafeInteger(entry.storedBytes) || entry.storedBytes <= 0 ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 256 * 1024 * 1024 ||
          entry.storedBytes > 256 * 1024 * 1024 || !['identity', 'gzip', 'webp-lossless'].includes(entry.encoding)) {
        throw new Error('资源续传条目无效。');
      }
      const bytes = new Uint8Array(entry.storedBytes); let at = 0;
      await onProgress?.(entry, 0);
      while (at < bytes.length) {
        if (offset === chunk.length && !await fill()) throw new Error('资源文件传输中断：' + entry.url);
        const size = Math.min(bytes.length - at, chunk.length - offset);
        bytes.set(chunk.subarray(offset, offset + size), at); at += size; offset += size;
        await onProgress?.(entry, at);
      }
      cancelled();
      await onFile(entry, bytes);
      if (++count > start.total) throw new Error('资源续传数量异常。');
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    // A failed Safari fetch can leave cancellation pending; cleanup must never block a retry.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
