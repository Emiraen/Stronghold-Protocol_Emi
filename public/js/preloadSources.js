// Public share credentials are short-lived and scoped to these published files.
// Resource bytes travel directly from the chosen source to the player's browser.
export const PRELOAD_CDN_ORIGIN = 'https://sources.emiraen.cfd';
export const PRELOAD_CLOUD_API = 'https://bj40593.api.aliyunfile.com';
export const PRELOAD_CLOUD_DATA = 'https://5180167180b0486ea77bda19b2d8e7a7.data.aliyunfile.com';
const SHARE_ID = '1xfF9z8duTt';
export const PRELOAD_FILES = Object.freeze({
  'resource-required-lossless.sprpack': { fileId: '6ae6d34e8415d29fb7a84a17ac610ef70db4b6a8', bytes: 1287414277, sha1: '8e371fbecb3f8ddab3fe2fae451a4dd2f5ccd003' },
  'resource-optional.sprpack': { fileId: '6ae6d3aa5200a4d5e18e41baa539a2f5cfd14c5c', bytes: 765238697, sha1: 'ef14ee473a8d460b3746ccb48b5e4c57920b7b50' },
  'resource-voice.sprpack': { fileId: '6ae6d34e4142ad88c973454f89cbb0c190e8412f', bytes: 160584738, sha1: '2e08529205bed8f2a6b601023635120a4f76eae3' },
  'resource-preload.runtime.json.gz': { fileId: '6ae6d43d11a867fa9e8e44618e51a087dfba811f', bytes: 2922331, sha1: '5760e7cddc401da1d40f4fe8b462751bd0090982' },
  'resource-preload.json': { fileId: '6ae6d440309230c101504605bc5a58d429e97ebb', bytes: 12867955, sha1: '3ebaf3fcc8f722318485edf467a7cff7e959e2fd' },
});
const links = new Map();
let token, tokenPromise, cloudRetryAt = 0;
const abortError = signal => signal?.reason || new DOMException('请求已取消', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(signal); }
function report(fn, ...args) { try { fn?.(...args); } catch { /* Display listeners do not own the transfer. */ } }
function waitFor(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function api(path, body, shareToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(PRELOAD_CLOUD_API + path, { method: 'POST', credentials: 'omit', mode: 'cors', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(shareToken ? { 'X-Share-Token': shareToken } : {}) }, body: JSON.stringify(body), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(`企业网盘接口不可用（HTTP ${response.status}）`), { status: response.status });
    return value;
  } finally { clearTimeout(timer); }
}
async function shareToken() {
  if (token && token.until > Date.now() + 30000) return token.value;
  if (!tokenPromise) tokenPromise = (async () => {
    const value = await api('/v2/share_link/get_share_token', { share_id: SHARE_ID });
    if (typeof value.share_token !== 'string' || !value.share_token) throw new Error('企业网盘分享不可用。');
    const until = Date.parse(value.expire_time) || Date.now() + Math.max(60, Number(value.expires_in) || 300) * 1000;
    token = { value: value.share_token, until };
    return token.value;
  })().finally(() => { tokenPromise = undefined; });
  return tokenPromise;
}
async function downloadLink(name, signal) {
  const file = PRELOAD_FILES[name];
  let cached = links.get(name);
  if (cached?.until > Date.now() + 30000) return cached.url;
  if (!cached?.promise) {
    cached = {};
    cached.promise = (async () => {
      let value;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { value = await api('/v2/file/get_download_url', { share_id: SHARE_ID, file_id: file.fileId }, await shareToken()); break; }
        catch (error) { if (attempt || ![401, 403].includes(error.status)) throw error; token = undefined; }
      }
      const url = new URL(value.url);
      if (url.origin !== PRELOAD_CLOUD_API || value.file_id !== file.fileId || value.size !== file.bytes ||
          value.content_hash_name !== 'sha1' || value.content_hash?.toLowerCase() !== file.sha1) throw new Error('企业网盘资源版本与当前资源包不符。');
      cached.url = url.href;
      cached.until = Date.parse(value.expiration) || Date.now() + 60000;
      return cached.url;
    })().catch(error => { if (links.get(name) === cached) links.delete(name); throw error; })
      .finally(() => { cached.promise = undefined; });
    links.set(name, cached);
  }
  return waitFor(cached.promise, signal);
}
async function readTransfer(url, file, { start, end, signal, cloud, onProgress }) {
  const controller = new AbortController();
  const abort = () => controller.abort(abortError(signal));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer, reader, response;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new DOMException('资源传输超时', 'TimeoutError')), 20000); };
  arm();
  try {
    const ranged = start !== undefined;
    const expected = ranged ? end - start + 1 : file.bytes;
    response = await fetch(url, { cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: cloud ? 'follow' : 'error',
      signal: controller.signal, headers: ranged ? { Range: `bytes=${start}-${end}` } : {} });
    if (!response.ok || response.status !== (ranged ? 206 : 200)) {
      void response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`资源下载响应无效（HTTP ${response.status}）`), { status: response.status });
    }
    if (cloud && ![PRELOAD_CLOUD_API, PRELOAD_CLOUD_DATA].includes(new URL(response.url).origin)) throw new Error('企业网盘下载地址发生变化。');
    const range = response.headers.get('Content-Range');
    const length = response.headers.get('Content-Length');
    // PDS exposes only ETag. Its signed link metadata pins the full file size and SHA1;
    // for its hidden Content-Range, require 206 and the exact exposed response length.
    // CDN responses keep strict Content-Range validation.
    if (ranged && ((range && range !== `bytes ${start}-${end}/${file.bytes}`) ||
        (!range && (!cloud || Number(length) !== expected)))) throw new Error('资源区间与请求不符。');
    if (length !== null && Number(length) !== expected) throw new Error('资源响应大小不符。');
    if (!response.body) throw new Error('资源响应没有内容。');
    reader = response.body.getReader();
    const bytes = new Uint8Array(expected);
    let received = 0;
    while (true) {
      arm();
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.byteLength > expected) throw new Error('资源响应超出请求大小。');
      bytes.set(value, received); received += value.byteLength;
      report(onProgress, received, expected);
    }
    checkAbort(signal);
    if (received !== expected) throw new Error('资源传输中断。');
    return bytes;
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else { try { void response?.body?.cancel().catch(() => {}); } catch { /* Already closed. */ } }
    controller.abort(); signal?.removeEventListener('abort', abort);
  }
}
async function transfer(name, path, options) {
  const file = PRELOAD_FILES[name];
  if (!file) throw new Error('未知资源包。');
  checkAbort(options.signal);
  let failure;
  const sources = Date.now() < cloudRetryAt ? ['cdn'] : ['cloud', 'cdn'];
  for (const source of sources) {
    const cloud = source === 'cloud';
    report(options.onSource, cloud ? '阿里云企业网盘' : 'CDN');
    for (let attempt = 0; attempt < (cloud ? 2 : 1); attempt++) {
      try {
        const url = cloud ? await downloadLink(name, options.signal) : new URL(path, PRELOAD_CDN_ORIGIN).href;
        const bytes = await readTransfer(url, file, { ...options, cloud });
        if (cloud) cloudRetryAt = 0;
        return { bytes, total: file.bytes, source };
      } catch (error) {
        checkAbort(options.signal);
        failure = error;
        report(options.onProgress, 0, options.end === undefined ? file.bytes : options.end - options.start + 1);
        if (cloud && !attempt && [401, 403].includes(error.status)) { links.delete(name); continue; }
        if (cloud) cloudRetryAt = Date.now() + 30000;
        break;
      }
    }
  }
  throw failure || new Error('资源下载渠道暂不可用。');
}
export function preloadPackGroup(url) {
  try { return /^\/assets\/resource-(required-lossless|optional|voice)\.sprpack$/.exec(new URL(url, globalThis.location?.href || 'http://localhost').pathname)?.[1]?.replace('required-lossless', 'required') || null; }
  catch { return null; }
}
export function readPreloadRange(group, start, end, total, options = {}) {
  const name = `resource-${group === 'required' ? 'required-lossless' : group}.sprpack`, file = PRELOAD_FILES[name];
  if (!file || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.bytes ||
      (total !== undefined && total !== file.bytes)) return Promise.reject(new Error('资源包区间或版本无效。'));
  return transfer(name, '/assets/' + name, { ...options, start, end });
}
export async function fetchPreloadManifest(path, options = {}) {
  const name = path.split('/').at(-1);
  if (!PRELOAD_FILES[name] || !name.startsWith('resource-preload.')) throw new Error('未知资源清单。');
  const { bytes } = await transfer(name, path, options);
  const hash = await crypto.subtle.digest('SHA-1', bytes);
  const hex = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hex !== PRELOAD_FILES[name].sha1) throw new Error('资源清单内容与发布版本不符。');
  return new Response(bytes, { headers: { 'Content-Type': name.endsWith('.gz') ? 'application/gzip' : 'application/json' } });
}
