import { createHash } from 'node:crypto';
import { compressBuffer, compressionTag, isNotModified, preferredEncoding } from './files.js';

/** Only for public, request-independent JSON (announcement and server directory), never player/profile data. */
export function createPublicJsonResponder() {
  // Keep only the current response per route, including in-flight compression shared by concurrent requests.
  const routes = new Map();
  return async (req, res, route, value) => {
    const json = JSON.stringify(value);
    let entry = routes.get(route);
    if (!entry || entry.json !== json) {
      const raw = Buffer.from(json);
      entry = { json, raw, tag: createHash('sha256').update(raw).digest('hex'), encoded: new Map() };
      routes.set(route, entry);
    }
    const encoding = entry.raw.length >= 512 ? preferredEncoding(req.headers['accept-encoding']) : null;
    const etag = `"json-${entry.tag}${encoding ? `-${compressionTag(encoding)}` : ''}"`;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache',
      ETag: etag, Vary: 'Accept-Encoding' };
    if (isNotModified(req, etag, null)) { res.writeHead(304, headers); res.end(); return; }
    let body = entry.raw;
    if (encoding) {
      if (!entry.encoded.has(encoding)) {
        const pending = compressBuffer(entry.raw, encoding).catch(err => { entry.encoded.delete(encoding); throw err; });
        entry.encoded.set(encoding, pending);
      }
      body = await entry.encoded.get(encoding);
      headers['Content-Encoding'] = encoding;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
