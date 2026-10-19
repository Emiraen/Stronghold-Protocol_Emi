import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { sendError } from "./common.js";
import { PrecompressedStore } from './precompressed.js';

/** Extension → Content-Type. */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
});

/** Extensions worth gzipping (text-like, .skel, uncompressed fonts). */
export const COMPRESSIBLE = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.md', '.csv', '.xml',
  '.atlas', '.skel', '.bin', '.wasm', '.svg', '.otf', '.ttf', '.ico', '.wav', '.gltf', '.glb', '.obj', '.mtl',
]);

const GZIP_MIN_BYTES = 512;
const GZIP_CACHE_MAX_FILE = 8 << 20;      // larger files are gzip-streamed on the fly
const GZIP_CACHE_MAX_TOTAL = 96 << 20;
// 资源URL可被原地更新：no-cache允许浏览器落盘，复用前用内容ETag校验；不依赖构建号或安全上下文。
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const RESOURCE_DIRS = ['assets', 'fonts', 'vendor']; // public/下的资源目录

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);
// Prefer smaller responses when an offline precompressed variant is unavailable.
// Compression stays asynchronous and shares the existing bounded 96 MB LRU.
const BROTLI_OPTIONS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } };
export const compressionTag = (encoding) => `${encoding}-q9`;
export const compressBuffer = (raw, encoding) => encoding === 'br'
  ? brotliAsync(raw, BROTLI_OPTIONS) : gzipAsync(raw, { level: 9 });
// ---------------------------------------------------------------------------------------------------
// gzip cache (LRU by bytes)
// ---------------------------------------------------------------------------------------------------

export class GzipCache {
  constructor(maxTotal = GZIP_CACHE_MAX_TOTAL, { precompressedDir } = {}) {
    this.maxTotal = maxTotal;
    this.total = 0;
    /** @type {Map<string, Buffer>} */ this.map = new Map();
    /** @type {Map<string, Promise<Buffer>>} */ this.inflight = new Map();
    this.precompressed = new PrecompressedStore(precompressedDir);
  }

  /** @returns {Promise<Buffer>} compressed file identified by encoding and file metadata */
  get(absPath, stat, encoding = 'gzip') {
    const key = `${encoding}\0${absPath}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); return Promise.resolve(hit); }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const raw = await fsp.readFile(absPath);
      const gz = await compressBuffer(raw, encoding);
      this.store(key, gz);
      return gz;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  getBuffer(raw, hash, encoding) {
    const key = `buffer\0${encoding}\0${hash}`;
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); return Promise.resolve(hit); }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = compressBuffer(raw, encoding).then(body => { this.store(key, body); return body; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  store(key, buf) {
    if (buf.length > this.maxTotal) return;
    const old = this.map.get(key);
    if (old) this.total -= old.length;
    this.map.set(key, buf);
    this.total += buf.length;
    for (const [k, v] of this.map) {
      if (this.total <= this.maxTotal) break;
      this.map.delete(k);
      this.total -= v.length;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------

/** Does the Accept-Encoding header allow gzip (q > 0)? @param {string | undefined} header */
export function acceptsGzip(header) {
  return encodingQuality(header, 'gzip') > 0;
}

function encodingQuality(header, wanted) {
  if (!header || typeof header !== 'string') return 0;
  let exactQ = null;
  let starQ = 0;
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q) || q < 0 || q > 1) q = 0;
    if (token === wanted || (wanted === 'gzip' && token === 'x-gzip')) exactQ = q;
    else if (token === '*') starQ = q;
  }
  return exactQ ?? starQ;
}

/** Prefer Brotli when equally acceptable; legacy gzip-only and identity clients keep their representation. */
export function preferredEncoding(header) {
  const br = encodingQuality(header, 'br');
  const gzip = encodingQuality(header, 'gzip');
  return br > 0 && br >= gzip ? 'br' : gzip > 0 ? 'gzip' : null;
}

/**
 * Parse a single `bytes=` range against a file size.
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null} null = ignore header (serve 200)
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // multi-range or malformed → ignore (RFC 9110 permits serving the full body)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (b !== '' && Number(b) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

const stripWeak = (tag) => tag.trim().replace(/^W\//, '');

/** Conditional GET check (If-None-Match wins over If-Modified-Since). */
export function isNotModified(req, etag, mtime) {
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string') {
    if (inm.trim() === '*') return true;
    return inm.split(',').some((t) => stripWeak(t) === etag);
  }
  const ims = req.headers['if-modified-since'];
  if (typeof ims === 'string' && mtime) {
    const t = Date.parse(ims);
    if (Number.isFinite(t)) return Math.floor(mtime.getTime() / 1000) * 1000 <= t;
  }
  return false;
}

/** If-Range: serve the range only when the validator still matches. */
function ifRangeMatches(req, etag, lastModified) {
  const v = req.headers['if-range'];
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (s.startsWith('"') || s.startsWith('W/')) return s === etag; // strong comparison
  return s === lastModified;
}

const isResource = (mountName, segments) => mountName === 'public' && segments.length > 1 && RESOURCE_DIRS.includes(segments[0]);

function cacheControlFor(ext, mountName, segments, query) {
  if (ext === '.html' || ext === '.htm' || isResource(mountName, segments)) return 'no-cache';
  if (/(^|&)v=/.test(query)) return IMMUTABLE_CACHE;
  return 'no-cache';
}

// 按需读流计算内容版本，同一文件并发合并；元数据变化重算，但内容相同的部署不会改变ETag。
async function resourceContentTag(absPath, stat, cache) {
  const stamp = `${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
  let entry = cache.get(absPath);
  if (!entry || entry.stamp !== stamp) {
    entry = { stamp, promise: null };
    entry.promise = (async () => {
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(absPath)) hash.update(chunk);
      return hash.digest('hex');
    })().catch((err) => {
      if (cache.get(absPath) === entry) cache.delete(absPath);
      throw err;
    });
    cache.set(absPath, entry);
  }
  return entry.promise;
}

export async function serveFile(req, res, absPath, stat, mountName, segments, query, gzipCache, contentTags, log) {
  const ext = path.extname(absPath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const compressible = COMPRESSIBLE.has(ext);
  const rangeHeader = req.headers.range;
  const encoding = compressible && stat.size >= GZIP_MIN_BYTES && !rangeHeader
    ? preferredEncoding(req.headers['accept-encoding']) : null;
  const resource = isResource(mountName, segments);
  let baseTag, precompressed = null;
  try {
    const hasPrecompressed = encoding && await gzipCache.precompressed?.available();
    baseTag = resource || hasPrecompressed ? await resourceContentTag(absPath, stat, contentTags)
      : `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
    if (hasPrecompressed) precompressed = await gzipCache.precompressed.find(baseTag, stat.size, encoding);
  } catch (err) {
    log.error('[http] resource hash failed', err);
    sendError(req, res, 500, '资源读取失败');
    return;
  }
  // Encoding settings can change without changing the source: distinguish each encoded byte sequence.
  const representation = precompressed ? `-${encoding}-${precompressed.sha256}` : encoding ? `-${compressionTag(encoding)}` : '';
  const etag = `"${baseTag}${representation}"`;
  const lastModified = stat.mtime.toUTCString();
  const isHead = req.method === 'HEAD';

  const headers = {
    'Content-Type': type,
    'Cache-Control': cacheControlFor(ext, mountName, segments, query),
    ETag: etag,
    'Last-Modified': lastModified,
  };
  if (compressible) headers.Vary = 'Accept-Encoding';

  // 资源可在同一秒内或保留mtime更新，不能仅凭Last-Modified判定内容未变。
  if (isNotModified(req, etag, resource ? null : stat.mtime)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (encoding) {
    headers['Content-Encoding'] = encoding;
    if (precompressed) {
      headers['Content-Length'] = precompressed.bytes;
      res.writeHead(200, headers);
      if (isHead) { res.end(); return; }
      await streamTo(fs.createReadStream(precompressed.file), res, log);
      return;
    }
    if (stat.size <= GZIP_CACHE_MAX_FILE) {
      const gz = await gzipCache.get(absPath, stat, encoding);
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      res.end(isHead ? undefined : gz);
      return;
    }
    res.writeHead(200, headers);
    if (isHead) { res.end(); return; }
    await streamTo(fs.createReadStream(absPath), res, log,
      encoding === 'br' ? zlib.createBrotliCompress(BROTLI_OPTIONS) : zlib.createGzip({ level: 9 }));
    return;
  }

  headers['Accept-Ranges'] = 'bytes';
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (rangeHeader && ifRangeMatches(req, etag, resource ? null : lastModified)) {
    const r = parseRange(rangeHeader, stat.size);
    if (r === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 0, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (r) {
      ({ start, end } = r);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (isHead || stat.size === 0) { res.end(); return; }
  await streamTo(fs.createReadStream(absPath, { start, end }), res, log);
}

/** Immutable/public plugin snapshots only; never use this cache for player or session data. */
export async function serveStaticBuffer(req, res, raw, { type = MIME['.json'], cacheControl = 'no-store', tag } = {}, cache, log) {
  const hash = createHash('sha256').update(raw).digest('hex');
  const compressible = /^(text\/|application\/(?:json|javascript|wasm)|image\/svg)/.test(type);
  const encoding = compressible && raw.length >= GZIP_MIN_BYTES && !req.headers.range
    ? preferredEncoding(req.headers['accept-encoding']) : null;
  const precompressed = encoding ? await cache.precompressed?.find(hash, raw.length, encoding) : null;
  const etag = `"${tag || hash}${precompressed ? `-${encoding}-${precompressed.sha256}` : encoding ? `-${compressionTag(encoding)}` : ''}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: etag };
  if (compressible) headers.Vary = 'Accept-Encoding';
  if (isNotModified(req, etag, null)) { res.writeHead(304, headers); res.end(); return; }
  if (encoding) {
    headers['Content-Encoding'] = encoding;
    if (precompressed) {
      headers['Content-Length'] = precompressed.bytes;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else await streamTo(fs.createReadStream(precompressed.file), res, log);
    } else {
      const body = await cache.getBuffer(raw, hash, encoding);
      res.writeHead(200, { ...headers, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    }
    return;
  }
  headers['Accept-Ranges'] = 'bytes';
  let body = raw, status = 200;
  if (req.headers.range && ifRangeMatches(req, etag, null)) {
    const range = parseRange(req.headers.range, raw.length);
    if (range === 'unsatisfiable') { res.writeHead(416, { 'Content-Range': `bytes */${raw.length}`, 'Content-Length': 0, 'Cache-Control': 'no-store' }); res.end(); return; }
    if (range) { status = 206; body = raw.subarray(range.start, range.end + 1); headers['Content-Range'] = `bytes ${range.start}-${range.end}/${raw.length}`; }
  }
  res.writeHead(status, { ...headers, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function streamTo(src, res, log, transform) {
  try {
    if (transform) await pipeline(src, transform, res);
    else await pipeline(src, res);
  } catch (e) {
    if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.debug?.('[http] stream aborted', e.code || e.message);
    res.destroy();
  }
}

export { GzipCache as CompressCache };
