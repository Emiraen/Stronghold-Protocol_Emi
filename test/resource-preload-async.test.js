import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createPreloadHandler } from '../tools/resource-preload-server.mjs';
import { resourceBrowserHarness, resourceTestChrome } from './helpers/resourceCacheBrowser.js';

const version = 'a'.repeat(64), generation = 'async-fixture';
const entry = (name, body) => ({ url: '/assets/' + name + '.txt', bytes: Buffer.byteLength(body), version, type: 'text/plain' });

test('downstream backpressure lasting more than 45 seconds does not truncate a healthy resource stream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'resource-slow-receiver-')), path = join(root, 'body');
  await writeFile(path, 'payload');
  const item = entry('slow', 'payload'), response = new EventEmitter();
  let first = true, destroyed = false, ended = false; const chunks = [];
  response.setHeader = () => {}; response.writeHead = () => response;
  response.write = bytes => { chunks.push(Buffer.from(bytes)); const result = !first; first = false; return result; };
  response.destroy = () => { destroyed = true; response.emit('close'); };
  response.end = () => { ended = true; };
  const handler = createPreloadHandler({ generation, select: () => [item],
    async body() { return { path, start: 0, end: 6, header: { ...item, encoding: 'identity', storedBytes: 7 } }; } }, { log: { info() {}, warn() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = handler({ method: 'GET', url: '/api/resource-preload', socket: { remoteAddress: '127.0.0.1' } }, response);
    await new Promise(setImmediate); t.mock.timers.tick(46000); await new Promise(setImmediate);
    assert.equal(destroyed, false); assert.equal(ended, false);
    response.emit('drain'); await pending;
    assert.equal(ended, true); assert.equal(destroyed, false); assert.ok(Buffer.concat(chunks).includes(Buffer.from('payload')));
  } finally { t.mock.timers.reset(); await rm(root, { recursive: true, force: true }); }
});

test('slow required stream does not block optional transfer or its independent completion', { skip: !resourceTestChrome, timeout: 15000 }, async () => {
  const harness = await resourceBrowserHarness();
  try {
    const groups = { required: [entry('required', 'required')], optional: [entry('optional', 'optional')], voice: [] };
    const result = await harness.run({ productionRouting: true, manifest: { schema: 1, generatedAt: generation, groups }, bodies: {} }, async () => {
      const f = resourceFixture, requested = []; let release;
      await f.resourceCache.check();
      f.onFetch = async (url, options) => {
        if (url.pathname !== '/api/resource-preload') throw Error('Unexpected fallback');
        const group = url.searchParams.get('group'), item = f.config.manifest.groups[group][0];
        requested.push(group);
        return new Response(new ReadableStream({ start(stream) {
          const line = value => new TextEncoder().encode(JSON.stringify(value) + '\n');
          stream.enqueue(line({ schema: 1, group, generation: 'async-fixture', total: 1, from: item.url }));
          stream.enqueue(line({ ...item, encoding: 'identity', storedBytes: item.bytes }));
          const finish = () => { stream.enqueue(new TextEncoder().encode(group)); stream.enqueue(line({ done: true })); stream.close(); };
          if (group === 'required') release = finish; else finish();
          options.signal.addEventListener('abort', () => { try { stream.error(new DOMException('paused', 'AbortError')); } catch {} }, { once: true });
        } }), { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
      };
      const required = f.resourceCache.download('required');
      const optional = f.resourceCache.download('optional');
      let timer;
      try {
        const optionalReady = await Promise.race([optional, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Optional blocked by required')), 1500); })]);
        const during = f.resourceCache.getState(); release();
        const requiredReady = await required;
        return { requested, optionalReady, requiredReady, during: { required: during.required.running, optional: during.optional.running }, state: f.resourceCache.getState() };
      } finally { clearTimeout(timer); f.resourceCache.pause(); }
    });
    assert.deepEqual(result.requested.sort(), ['optional', 'required']);
    assert.equal(result.optionalReady, true); assert.equal(result.requiredReady, true);
    assert.deepEqual(result.during, { required: true, optional: false });
    for (const group of ['required', 'optional']) { assert.equal(result.state[group].done, 1); assert.equal(result.state[group].downloadedBytes, 8); }
  } finally { await harness.close(); }
});

test('resource gzip decoding uses native asynchronous decompression and the worker fallback', { skip: !resourceTestChrome, timeout: 20000 }, async () => {
  const harness = await resourceBrowserHarness();
  try {
    const body = 'resource payload '.repeat(32768), item = entry('compressed', body), compressed = gzipSync(body);
    for (const worker of [false, true]) {
      const result = await harness.run({ productionRouting: true, manifest: { schema: 1, generatedAt: generation, groups: { required: [item], optional: [], voice: [] } }, bodies: {}, worker, compressed: compressed.toString('base64') }, async () => {
        const f = resourceFixture; let asynchronousCalls = 0;
        if (f.config.worker) {
          globalThis.DecompressionStream = undefined;
          const OriginalWorker = Worker;
          globalThis.Worker = class extends OriginalWorker { constructor(...args) { super(...args); asynchronousCalls++; } };
        } else {
          const OriginalStream = DecompressionStream;
          globalThis.DecompressionStream = class extends OriginalStream { constructor(...args) { super(...args); asynchronousCalls++; } };
        }
        await f.resourceCache.check();
        const item = f.config.manifest.groups.required[0];
        f.onFetch = async url => {
          if (url.pathname !== '/api/resource-preload') throw Error('Unexpected fallback');
          const bytes = Uint8Array.from(atob(f.config.compressed), c => c.charCodeAt(0));
          const line = value => JSON.stringify(value) + '\n';
          return new Response(new Blob([line({ schema: 1, group: 'required', generation: 'async-fixture', total: 1, from: item.url }),
            line({ ...item, encoding: 'gzip', storedBytes: bytes.length }), bytes, line({ done: true })]),
            { headers: { 'Content-Type': 'application/x-stronghold-resources' } });
        };
        const ok = await f.resourceCache.download('required');
        return { ok, asynchronousCalls, body: await (await f.inspect(item)).blob.text() };
      });
      assert.equal(result.ok, true); assert.equal(result.asynchronousCalls, 1); assert.equal(result.body, body);
    }
  } finally { await harness.close(); }
});

test('resource service accepts more than 32 concurrent transfers without an artificial cap', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-concurrent-')), path = join(root, 'body');
  const item = entry('body', 'payload'); let release; const gate = new Promise(resolve => { release = resolve; });
  await writeFile(path, 'payload');
  const server = http.createServer(createPreloadHandler({ generation, select: () => [item],
    async body() { await gate; return { path, start: 0, end: 6, header: { ...item, encoding: 'identity', storedBytes: 7 } }; } }));
  const controller = new AbortController(); let pending = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    pending = Array.from({ length: 40 }, () => fetch(origin + '/api/resource-preload?window=1', { signal: controller.signal }).then(async response => ({ status: response.status, body: await response.text() })));
    let active = 0;
    for (let i = 0; i < 100 && active < 40; i++) { active = (await (await fetch(origin + '/healthz')).json()).active; if (active < 40) await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(active, 40); release();
    const results = await Promise.all(pending); assert.ok(results.every(result => result.status === 200 && result.body.includes('payload')));
  } finally { release(); controller.abort(); await Promise.allSettled(pending); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
