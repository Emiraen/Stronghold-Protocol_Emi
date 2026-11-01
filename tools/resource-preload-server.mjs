// Dedicated resource-host process. No game simulation or profile state lives here.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, open, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mediaUrl } from '../public/js/media.js';
import { resourceFilename, PRELOAD_STREAM_TYPE } from '../public/js/resourceResume.js';

const GROUPS = ['required', 'optional', 'voice'];
const origin = 'http://localhost';
const filename = url => resourceFilename(mediaUrl(url, origin));
const jsonLine = value => Buffer.from(JSON.stringify(value) + '\n');

export async function createPreloadCatalogue(root) {
  root = resolve(root);
  const manifest = JSON.parse(await readFile(resolve(root, 'data/resource-preload.json'), 'utf8'));
  const groups = new Map(), indexes = new Map();
  const handles = new Map(), packedFiles = new Map();
  async function pack(group) {
    if (!handles.has(group)) handles.set(group, (async () => {
      const path = resolve(root, 'assets/resource-' + (group === 'required' ? 'required-lossless' : group) + '.sprpack');
      const info = await stat(path), identity = [info.dev, info.ino, info.size, info.mtimeMs].join(':');
      if (packedFiles.has(identity)) return packedFiles.get(identity);
      const pending = readPack(path);
      packedFiles.set(identity, pending);
      return pending;
    })().catch(() => new Map()));
    return handles.get(group);
  }
  async function readPack(path) {
      const handle = await open(path, 'r');
      try {
        const prefix = Buffer.alloc(12); await handle.read(prefix, 0, 12, 0);
        const magic = prefix.subarray(0, 8).toString(), length = prefix.readUInt32LE(8);
        const schema = { SPPACK01: 1, SPPACK02: 2, SPPACK03: 3 }[magic];
        if (!schema || !length || length > 16 * 1024 * 1024) throw Error('Invalid resource pack');
        const bytes = Buffer.alloc(length); const read = await handle.read(bytes, 0, length, 12);
        if (read.bytesRead !== length) throw Error('Truncated resource pack');
        const header = JSON.parse(bytes.toString());
        if (header.schema !== schema || !Array.isArray(header.resources)) throw Error('Invalid resource pack header');
        let offset = 12 + length; const records = new Map();
        for (const item of header.resources) {
          const storedBytes = schema === 1 ? item.bytes : item.storedBytes;
          if (!Number.isSafeInteger(storedBytes) || storedBytes <= 0) throw Error('Invalid resource pack entry');
          records.set(filename(item.url), { ...item, encoding: schema === 1 ? 'identity' : item.encoding, offset, storedBytes, path });
          offset += storedBytes;
        }
        if (offset !== (await handle.stat()).size) throw Error('Truncated resource pack body');
        return records;
      } finally { await handle.close(); }
  }
  for (const group of GROUPS) {
    const seen = new Set(), items = [];
    for (const raw of manifest.groups[group] || []) {
      if (raw.url.includes('/portrait-hd/')) continue;
      const url = filename(raw.url);
      if (seen.has(url)) continue;
      seen.add(url); items.push({ ...raw, url, sourceUrl: raw.url });
    }
    groups.set(group, items); indexes.set(group, new Map(items.map((item, index) => [item.url, index])));
  }
  async function body(item, group) {
    const packed = (await pack(item.pack?.group || group)).get(item.url);
    const transportMatches = packed?.encoding !== 'webp-lossless' || JSON.stringify(packed.transport) === JSON.stringify(item.transport);
    if (packed && packed.version === item.version && packed.bytes === item.bytes && packed.type === item.type && transportMatches) {
      return { header: { url: item.url, bytes: item.bytes, storedBytes: packed.storedBytes, type: item.type, version: item.version,
        encoding: packed.encoding, ...(packed.transport ? { transport: packed.transport } : {}) },
        path: packed.path, start: packed.offset, end: packed.offset + packed.storedBytes - 1 };
    }
    const pathname = decodeURIComponent(new URL(item.sourceUrl, origin).pathname).replace(/^\/(assets|media|fonts)\/~[a-f0-9]{16}\//, '/$1/');
    if (pathname.includes('\\') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) throw Error('Invalid resource path');
    const candidates = pathname.startsWith('/media/')
      ? ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav'].map(ext => resolve(root, 'assets/audio', pathname.slice(7) + ext))
      : [resolve(root, '.' + pathname)];
    for (const path of candidates) {
      if (relative(root, path).startsWith('..')) continue;
      try {
        const info = await stat(path);
        if (info.isFile() && info.size === item.bytes) return { header: { url: item.url, bytes: item.bytes, storedBytes: item.bytes,
          type: item.type, version: item.version, encoding: 'identity' }, path };
      } catch { /* Try the next extension. */ }
    }
    throw Error('Missing preload resource: ' + item.url);
  }
  return { generation: manifest.generatedAt || '',
    select(group, from, language) {
      const list = groups.get(group); if (!list) return null;
      const start = from ? indexes.get(group).get(filename(from)) : 0;
      if (start === undefined) return null;
      return list.slice(start).filter(item => group !== 'voice' || !language || item.url.includes('/voice/' + language + '/'));
    }, body };
}

export function createPreloadHandler(catalogue, { maxBatchBytes = 16 * 1024 * 1024, maxBatchFiles = 256, log = console } = {}) {
  let sequence = 0;
  const transfers = new Map();
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' }); res.end(); return; }
    const url = new URL(req.url, origin);
    if (url.pathname === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, active: transfers.size })); return; }
    if (url.pathname === '/transfers' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([...transfers.values()])); return;
    }
    if (req.method !== 'GET' || url.pathname !== '/api/resource-preload' || req.url.length > 8192) { res.writeHead(404).end(); return; }
    const group = url.searchParams.get('group') || 'required', from = url.searchParams.get('from') || '';
    const language = url.searchParams.get('voiceLang') || '';
    const items = catalogue.select(group, from, ['cn', 'jp'].includes(language) ? language : null);
    if (!items) { res.writeHead(409).end(); return; }
    const bounded = url.searchParams.get('window') === '1';
    const id = ++sequence, started = Date.now();
    const transfer = { id, group, from, file: null, files: 0, bytes: 0, started, lastWrite: started };
    transfers.set(id, transfer);
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    async function write(bytes) {
      if (abort.signal.aborted) throw Error('Disconnected preload client');
      if (!res.write(bytes)) {
        // nginx can still be delivering buffered bytes over a slow WAN link. Its
        // downstream idle timeout and close event govern this wait, not a batch timer.
        await once(res, 'drain', { signal: abort.signal });
      }
      transfer.bytes += bytes.length; transfer.lastWrite = Date.now();
    }
    try {
      const batch = []; let bytes = 0;
      if (bounded) for (const item of items) {
        const source = await catalogue.body(item, group);
        if (batch.length && (bytes + source.header.storedBytes > maxBatchBytes || batch.length >= maxBatchFiles)) break;
        batch.push({ item, source }); bytes += source.header.storedBytes;
      }
      res.writeHead(200, { 'Content-Type': PRELOAD_STREAM_TYPE, 'X-Accel-Buffering': 'no' });
      const total = bounded ? batch.length : items.length;
      await write(jsonLine({ schema: 1, group, generation: catalogue.generation, total,
        remaining: items.length, bounded, from: items[0]?.url || null }));
      for (let index = 0; index < total; index++) {
        const item = items[index], source = bounded ? batch[index].source : await catalogue.body(item, group);
        transfer.file = item.url;
        await write(jsonLine(source.header));
        const stream = createReadStream(source.path, { start: source.start, end: source.end, highWaterMark: 65536, signal: abort.signal });
        for await (const bytes of stream) await write(bytes);
        transfer.files++;
      }
      await write(jsonLine({ done: true, ...(bounded ? { next: items[total]?.url || null } : {}) })); res.end();
    } catch (error) {
      const details = { id, group, from, file: transfer.file, files: transfer.files, bytes: transfer.bytes, elapsedMs: Date.now() - started };
      if (abort.signal.aborted) log.info?.('[preload] client closed', details);
      else log.warn?.('[preload] transfer failed', { ...details, error: error.message });
      res.destroy();
    } finally { transfers.delete(id); }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.SP_RESOURCE_PUBLIC || '/srv/stronghold-download/current/public';
  const catalogue = await createPreloadCatalogue(root);
  const server = http.createServer(createPreloadHandler(catalogue));
  server.requestTimeout = 0; server.timeout = 0; server.keepAliveTimeout = 10000;
  server.listen(Number(process.env.SP_PRELOAD_PORT || 3002), '127.0.0.1');
}
