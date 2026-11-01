import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createPreloadCatalogue, createPreloadHandler } from '../tools/resource-preload-server.mjs';
import { consumePreloadStream, resourceFilename } from '../public/js/resourceResume.js';
import { resourceBrowserHarness, resourceTestChrome } from './helpers/resourceCacheBrowser.js';

const version = 'a'.repeat(64), generation = 'resume-fixture-v1';
const entry = (name, body) => ({ url: '/assets/' + name + '.txt', bytes: Buffer.byteLength(body), version, type: 'text/plain' });
const bodies = ['first body', 'second body', 'third body', 'fourth body'];
const items = bodies.map((body, i) => entry(String(i), body));
const document = { schema: 1, generatedAt: generation, groups: { required: items, optional: [], voice: [] } };
const line = value => Buffer.from(JSON.stringify(value) + '\n');
function responseBytes(start, truncate = false) {
  const chunks = [line({ schema: 1, group: 'required', generation, total: items.length - start, from: items[start].url })];
  for (let i = start; i < items.length; i++) {
    chunks.push(line({ ...items[i], storedBytes: items[i].bytes, encoding: 'identity' }), Buffer.from(bodies[i]));
    if (truncate && i === start) break;
  }
  if (!truncate) chunks.push(line({ done: true }));
  return Buffer.concat(chunks);
}

test('resource host streams the supplied filename inclusively from the existing compressed pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-stream-'));
  let server;
  try {
    await mkdir(join(root, 'assets')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data/resource-preload.json'), JSON.stringify(document));
    const compressed = bodies.map(body => gzipSync(body));
    const header = Buffer.from(JSON.stringify({ schema: 3, resources: items.map((item, i) => ({ ...item, encoding: 'gzip', storedBytes: compressed[i].length })) }));
    const prefix = Buffer.alloc(12); prefix.write('SPPACK03'); prefix.writeUInt32LE(header.length, 8);
    await writeFile(join(root, 'assets/resource-required-lossless.sprpack'), Buffer.concat([prefix, header, ...compressed]));
    server = http.createServer(createPreloadHandler(await createPreloadCatalogue(root)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(origin + '/api/resource-preload?from=' + encodeURIComponent(items[1].url));
    const received = [];
    await consumePreloadStream(response, { onFile(raw, bytes) { received.push({ url: raw.url, bytes: bytes.length, encoding: raw.encoding }); } });
    assert.deepEqual(received.map(value => value.url), items.slice(1).map(item => item.url));
    assert.ok(received.every((value, i) => value.encoding === 'gzip' && value.bytes === compressed[i + 1].length));
    assert.equal((await fetch(origin + '/api/resource-preload?from=/assets/unknown')).status, 409);
    assert.equal((await fetch(origin + '/api/resource-preload?from=../../etc/passwd')).status, 409);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('bounded resource responses close at a file boundary and report the exact next filename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-stream-window-')); let server;
  try {
    await mkdir(join(root, 'assets')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data/resource-preload.json'), JSON.stringify(document));
    for (let i = 0; i < items.length; i++) await writeFile(join(root, 'assets', i + '.txt'), bodies[i]);
    server = http.createServer(createPreloadHandler(await createPreloadCatalogue(root), { maxBatchBytes: 25, maxBatchFiles: 2 }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const names = []; let next = items[0].url, windows = 0;
    while (next) {
      const from = next; next = null;
      await consumePreloadStream(await fetch(origin + '/api/resource-preload?window=1&from=' + encodeURIComponent(from)), {
        onStart(info) { assert.equal(info.bounded, true); assert.ok(info.total <= 2); assert.equal(info.from, from); },
        onFile(raw) { names.push(raw.url); }, onEnd(info) { next = info.next; },
      }); windows++;
    }
    assert.deepEqual(names, items.map(item => item.url)); assert.equal(windows, 2);
    assert.deepEqual(await (await fetch(origin + '/transfers')).json(), []);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('stream parser accepts split headers/bodies and requires a terminal record', async () => {
  const bytes = responseBytes(1), received = [];
  const response = new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
  assert.equal(await consumePreloadStream(response, { onFile(raw, body) { received.push([raw.url, Buffer.from(body).toString()]); } }), 3);
  assert.deepEqual(received, items.slice(1).map((item, i) => [item.url, bodies[i + 1]]));
  await assert.rejects(consumePreloadStream(new Response(responseBytes(1, true), { headers: { 'Content-Type': 'application/x-stronghold-resources' } }), { onFile() {} }), /中断/);
});

test('stream parser cancels an interrupted reader and preserves reserved path separators', async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(line({ schema: 1, total: 1 })); }, cancel() { cancelled = true; } }),
    { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
  const promise = consumePreloadStream(response, { signal: controller.signal, onFile() {} });
  setTimeout(() => controller.abort(new DOMException('paused', 'AbortError')), 5);
  await assert.rejects(promise, { name: 'AbortError' }); assert.equal(cancelled, true);
  assert.equal(resourceFilename('/assets/[opt]/a%2Fb.png'), '/assets/%5Bopt%5D/a%2Fb.png');
});

test('stream parser reports received bytes before a whole file finishes', async () => {
  const controller = new AbortController(), progress = []; let completed = false;
  const response = new Response(new ReadableStream({ start(stream) {
    stream.enqueue(line({ schema: 1, total: 1 }));
    stream.enqueue(line({ ...items[0], storedBytes: items[0].bytes, encoding: 'identity' }));
    stream.enqueue(new TextEncoder().encode('first'));
  } }), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
  await assert.rejects(consumePreloadStream(response, { signal: controller.signal,
    onProgress(raw, bytes) { progress.push(bytes); if (bytes > 0) controller.abort(new DOMException('paused', 'AbortError')); },
    onFile() { completed = true; },
  }), { name: 'AbortError' });
  assert.deepEqual(progress, [0, 5]); assert.equal(completed, false);
});

test('browser reports one filename and replaces an existing partial file inclusively', { skip: !resourceTestChrome }, async () => {
  const harness = await resourceBrowserHarness();
  try {
    const config = { productionRouting: true, manifest: document, bodies: {} };
    config.streamBody = responseBytes(1).toString('base64');
    const result = await harness.run(config, async () => {
      const f = resourceFixture, items = f.config.manifest.groups.required;
      await f.put(items[0], 'first body');
      await f.put(items[1], 'sec', { complete: false });
      await f.resourceCache.check();
      localStorage.setItem('stronghold-preload-cursor-v1:required', JSON.stringify({ generation: 'resume-fixture-v1', url: items[1].url }));
      const requests = [];
      f.onFetch = async url => {
        if (url.pathname !== '/api/resource-preload') throw Error('Unexpected download: ' + url.pathname);
        requests.push([...url.searchParams.entries()]);
        // A partial existing file is considered present in the key scan. The stream includes and replaces it.
        const encoded = f.config.streamBody;
        return new Response(Uint8Array.from(atob(encoded), value => value.charCodeAt(0)), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
      };
      const ok = await f.resourceCache.download('required');
      return { ok, requests, bodies: await Promise.all(items.map(async item => (await f.inspect(item)).blob.text())),
        cursor: JSON.parse(localStorage.getItem('stronghold-preload-cursor-v1:required')) };
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.requests, [[['group', 'required'], ['from', items[1].url], ['window', '1']]]);
    assert.deepEqual(result.bodies, bodies); assert.equal(result.cursor.url, items.at(-1).url);
  } finally { await harness.close(); }
});

test('browser resumes a complete cursor, skips no earlier hole, and preserves a checkpoint after a broken stream', { skip: !resourceTestChrome }, async () => {
  const harness = await resourceBrowserHarness();
  try {
    const config = { productionRouting: true, manifest: document, bodies: {} };
    config.full = responseBytes(1).toString('base64'); config.partial = responseBytes(1, true).toString('base64');
    const result = await harness.run(config, async () => {
      const f = resourceFixture, items = f.config.manifest.groups.required;
      await f.put(items[0], 'first body'); await f.put(items[1], 'second body'); await f.put(items[3], 'fourth body');
      await f.resourceCache.check();
      localStorage.setItem('stronghold-preload-cursor-v1:required', JSON.stringify({ generation: 'resume-fixture-v1', url: items[3].url }));
      const requests = []; let recover = false;
      f.onFetch = async url => {
        if (url.pathname !== '/api/resource-preload') throw Error('fallback unavailable');
        requests.push(url.searchParams.get('from'));
        const body = recover ? f.config.full : f.config.partial;
        return new Response(Uint8Array.from(atob(body), value => value.charCodeAt(0)), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
      };
      const first = await f.resourceCache.download('required');
      const checkpoint = JSON.parse(localStorage.getItem('stronghold-preload-cursor-v1:required'));
      recover = true;
      const second = await f.resourceCache.download('required');
      return { first, second, checkpoint, requests, body: await (await f.inspect(items[2])).blob.text() };
    });
    assert.equal(result.first, false); assert.equal(result.second, true);
    assert.deepEqual(result.requests, Array(5).fill(items[1].url));
    assert.equal(result.checkpoint.url, items[1].url); assert.equal(result.body, bodies[2]);
  } finally { await harness.close(); }
});

test('browser recovers Safari Load failed at the current file without switching to old pack downloads', { skip: !resourceTestChrome }, async () => {
  const harness = await resourceBrowserHarness();
  try {
    const config = { productionRouting: true, manifest: document, bodies: {} };
    config.full = responseBytes(1).toString('base64');
    const result = await harness.run(config, async () => {
      const f = resourceFixture, items = f.config.manifest.groups.required;
      await f.put(items[0], 'first body'); await f.put(items[1], 'sec', { complete: false }); await f.resourceCache.check();
      localStorage.setItem('stronghold-preload-cursor-v1:required', JSON.stringify({ generation: 'resume-fixture-v1', url: items[1].url }));
      const requests = [];
      f.onFetch = async url => {
        requests.push(url.pathname);
        if (url.pathname !== '/api/resource-preload') throw Error('old path must not be used');
        if (requests.length === 1) {
          const from = url.searchParams.get('from');
          return new Response(new ReadableStream({ start(stream) {
            stream.enqueue(new TextEncoder().encode(JSON.stringify({ schema: 1, group: 'required', generation: 'resume-fixture-v1', total: 3, from }) + '\n'));
            setTimeout(() => stream.error(new TypeError('Load failed')), 5);
          } }), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
        }
        return new Response(Uint8Array.from(atob(f.config.full), value => value.charCodeAt(0)), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
      };
      const ok = await f.resourceCache.download('required');
      return { ok, requests, body: await (await f.inspect(items[3])).blob.text(), error: f.resourceCache.getState().error };
    });
    assert.equal(result.ok, true); assert.equal(result.error, null);
    assert.deepEqual(result.requests, ['/api/resource-preload', '/api/resource-preload']); assert.equal(result.body, bodies[3]);
  } finally { await harness.close(); }
});

test('browser continues bounded batches and displays bytes while a file is still incomplete', { skip: !resourceTestChrome }, async () => {
  const harness = await resourceBrowserHarness();
  try {
    const result = await harness.run({ productionRouting: true, manifest: document, bodies: {} }, async () => {
      const f = resourceFixture, items = f.config.manifest.groups.required;
      await f.put(items[0], 'first body'); await f.resourceCache.check();
      const froms = [], progress = [];
      f.onFetch = async url => {
        if (url.pathname !== '/api/resource-preload') throw Error('Unexpected fallback');
        const from = url.searchParams.get('from'), index = items.findIndex(item => item.url === from);
        froms.push(from);
        const item = items[index], body = new TextEncoder().encode(['first body', 'second body', 'third body', 'fourth body'][index]);
        return new Response(new ReadableStream({ start(stream) {
          stream.enqueue(new TextEncoder().encode(JSON.stringify({ schema: 1, group: 'required', generation: 'resume-fixture-v1', total: 1, bounded: true, from }) + '\n'));
          stream.enqueue(new TextEncoder().encode(JSON.stringify({ ...item, storedBytes: body.length, encoding: 'identity' }) + '\n'));
          stream.enqueue(body.subarray(0, 3));
          setTimeout(() => {
            progress.push({ done: f.resourceCache.getState().required.done, bytes: f.resourceCache.getState().required.downloadedBytes });
            stream.enqueue(body.subarray(3));
            stream.enqueue(new TextEncoder().encode(JSON.stringify({ done: true, next: items[index + 1]?.url || null }) + '\n'));
            stream.close();
          }, 20);
        } }), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
      };
      const ok = await f.resourceCache.download('required');
      return { ok, froms, progress, state: f.resourceCache.getState().required };
    });
    assert.equal(result.ok, true); assert.deepEqual(result.froms, items.map(item => item.url));
    assert.ok(result.progress.some(value => value.done === 1 && value.bytes > items[0].bytes));
    assert.equal(result.state.done, items.length); assert.equal(result.state.downloadedBytes, bodies.reduce((n, value) => n + Buffer.byteLength(value), 0));
  } finally { await harness.close(); }
});
