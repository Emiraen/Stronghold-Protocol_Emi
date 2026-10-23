import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resourceBrowserHarness, resourceTestChrome } from './helpers/resourceCacheBrowser.js';

const sha = body => createHash('sha256').update(body).digest('hex');
const item = (url, body, extra = {}) => ({ url, version: sha(body), bytes: Buffer.byteLength(body), type: 'text/plain', ...extra });
const fixture = (required, optional = [], voice = [], bodies = {}) => ({ manifest: { schema: 1, groups: { required, optional, voice } }, bodies });
function pack(resources) {
  const header = Buffer.from(JSON.stringify({ schema: 1, resources: resources.map(({ item }) => item) }));
  const prefix = Buffer.alloc(12);
  prefix.write('SPPACK01'); prefix.writeUInt32LE(header.length, 8);
  return [...Buffer.concat([prefix, header, ...resources.map(({ body }) => Buffer.from(body))])];
}

describe('resource cache IO in real IndexedDB', { skip: resourceTestChrome ? false : 'requires local Chrome (CHROME_PATH)' }, () => {
  let harness;
  before(async () => { harness = await resourceBrowserHarness(); });
  after(async () => { await harness?.close(); });

  test('a miss reads twice, keeps the transactional guard, and returns the record won by another tab', async () => {
    const raw = 'raw png resource', webp = 'webp resource';
    const resource = item('/assets/cache-race.png', raw, { type: 'image/png',
      transport: { version: sha(webp), bytes: Buffer.byteLength(webp), type: 'image/webp' } });
    const result = await harness.run(fixture([resource], [], [], { [resource.url]: raw }), async () => {
      const f = globalThis.resourceFixture, resource = f.config.manifest.groups.required[0];
      await f.resourceCache.ensureSessionReady();
      f.resetIo();
      f.onFetch = async url => {
        if (url.pathname !== resource.url) return null;
        await f.put(resource, 'webp resource', { transport: resource.transport,
          blob: new Blob(['webp resource'], { type: 'image/webp' }) });
        return null;
      };
      const response = await f.cachedFetch(resource.url);
      return { text: await response.text(), type: response.headers.get('Content-Type'), gets: f.io.gets, requests: f.requests };
    });
    assert.equal(result.text, webp, 'must use the actual transaction result, not the competing raw download');
    assert.equal(result.type, 'image/webp');
    assert.equal(result.gets.filter(entry => entry.mode === 'readonly').length, 2,
      'one initial cache lookup plus one queued download lookup; no post-write re-read');
    assert.equal(result.gets.filter(entry => entry.mode === 'readwrite').length, 1, 'atomic guard remains inside writeRecord');
    assert.equal(result.requests.filter(request => request.path === resource.url).length, 1);
  });

  test('concurrent consumers share the download and all receive the complete resource', async () => {
    const body = 'concurrent resource body', resource = item('/assets/shared.txt', body);
    const result = await harness.run(fixture([resource], [], [], { [resource.url]: body }), async () => {
      const f = globalThis.resourceFixture;
      await f.resourceCache.ensureSessionReady();
      f.resetIo();
      const responses = await Promise.all(Array.from({ length: 4 }, () => f.cachedFetch('/assets/shared.txt')));
      return { bodies: await Promise.all(responses.map(response => response.text())), gets: f.io.gets,
        requests: f.requests, cached: f.resourceCache.isCached('/assets/shared.txt') };
    });
    assert.deepEqual(result.bodies, Array(4).fill(body));
    assert.equal(result.requests.filter(request => request.path === resource.url).length, 1);
    assert.equal(result.gets.filter(entry => entry.mode === 'readonly').length, 2);
    assert.equal(result.gets.filter(entry => entry.mode === 'readwrite').length, 1);
    assert.equal(result.cached, true);
  });

  test('cache hits share a pending lookup, avoid downloads, and honor later eviction', async () => {
    const body = 'already cached', resource = item('/assets/hit.txt', body);
    const result = await harness.run(fixture([], [resource]), async () => {
      const f = globalThis.resourceFixture, resource = f.config.manifest.groups.optional[0];
      await f.put(resource, 'already cached');
      await f.resourceCache.ensureSessionReady();
      f.resetIo();
      const responses = await Promise.all([f.cachedFetch(resource.url), f.cachedFetch(resource.url)]);
      const bodies = await Promise.all(responses.map(response => response.text()));
      const hitGets = f.io.gets.length;
      await f.remove(resource);
      await f.resourceCache.check();
      let missing;
      try { await f.cachedFetch(resource.url); } catch (error) { missing = error.name; }
      return { bodies, hitGets, requests: f.requests, missing, cached: f.resourceCache.isCached(resource.url) };
    });
    assert.deepEqual(result.bodies, [body, body]);
    assert.equal(result.hitGets, 1);
    assert.deepEqual(result.requests, []);
    assert.equal(result.missing, 'ResourceUnavailableError');
    assert.equal(result.cached, false);
  });

  test('a corrupt pack retry re-reads a newly completed record before raw fallback', async () => {
    const raw = 'expected png body', webp = 'finished webp';
    const resource = item('/assets/fallback.png', raw, { type: 'image/png',
      transport: { version: sha(webp), bytes: Buffer.byteLength(webp), type: 'image/webp' },
      pack: { offset: 12, storedBytes: Buffer.byteLength(raw), total: 12 + Buffer.byteLength(raw), encoding: 'identity' } });
    const result = await harness.run(fixture([resource], [], [], { [resource.url]: raw }), async () => {
      const f = globalThis.resourceFixture, resource = f.config.manifest.groups.required[0];
      await f.resourceCache.ensureSessionReady();
      f.resetIo();
      f.onFetch = async url => {
        if (!url.pathname.endsWith('.sprpack')) return null;
        await f.put(resource, 'finished webp', { transport: resource.transport,
          blob: new Blob(['finished webp'], { type: 'image/webp' }) });
        return new Response('x'.repeat(resource.bytes), { status: 206,
          headers: { 'Content-Range': `bytes 12-${resource.pack.total - 1}/${resource.pack.total}` } });
      };
      const response = await f.cachedFetch(resource.url);
      return { text: await response.text(), gets: f.io.gets, requests: f.requests };
    });
    assert.equal(result.text, webp);
    assert.equal(result.gets.filter(entry => entry.mode === 'readonly').length, 3,
      'initial lookup, first download lookup, and a fresh lookup after the pack failed');
    assert.equal(result.gets.filter(entry => entry.mode === 'readwrite').length, 0);
    assert.equal(result.requests.filter(request => request.path === resource.url).length, 0, 'another tab already supplied a valid record');
  });

  test('import statistics preserve existing/skipped records and replace partial progress exactly once', async () => {
    const a = item('/assets/import-a.txt', 'alpha'), b = item('/assets/import-b.txt', 'bravo'), c = item('/assets/import-c.txt', 'charlie');
    const obsolete = { ...a, version: '0'.repeat(64), url: '/assets/obsolete.txt' };
    const config = fixture([a], [b], [c]);
    config.pack = pack([{ item: a, body: 'alpha' }, { item: b, body: 'bravo' }, { item: c, body: 'charlie' }, { item: obsolete, body: 'alpha' }]);
    const result = await harness.run(config, async () => {
      const f = globalThis.resourceFixture;
      await f.put(f.config.manifest.groups.optional[0], 'bravo');
      await f.put(f.config.manifest.groups.voice[0], 'cha', { complete: false });
      const result = await f.resourceCache.importPack(new Blob([new Uint8Array(f.config.pack)]));
      return { result, state: f.resourceCache.getState(), requests: f.requests };
    });
    assert.deepEqual(result.result, { imported: 2, existing: 1, skipped: 1 });
    for (const [group, bytes] of [['required', 5], ['optional', 5], ['voice', 7]]) {
      assert.equal(result.state[group].done, 1);
      assert.equal(result.state[group].total, 1);
      assert.equal(result.state[group].downloadedBytes, bytes);
    }
    assert.equal(result.state.pack.done, 4);
    assert.equal(result.state.pack.total, 4);
    assert.deepEqual(result.requests, []);
  });

  test('an import failure retains earlier valid resources and a retry has correct progress', async () => {
    const a = item('/assets/kept.txt', 'valid-one'), b = item('/assets/retry.txt', 'valid-two');
    const config = fixture([a, b]);
    config.badPack = pack([{ item: a, body: 'valid-one' }, { item: b, body: 'corrupted' }]);
    config.goodPack = pack([{ item: a, body: 'valid-one' }, { item: b, body: 'valid-two' }]);
    const result = await harness.run(config, async () => {
      const f = globalThis.resourceFixture;
      const failed = await f.resourceCache.importPack(new Blob([new Uint8Array(f.config.badPack)]));
      const partial = f.resourceCache.getState();
      const retried = await f.resourceCache.importPack(new Blob([new Uint8Array(f.config.goodPack)]));
      return { failed, partial, retried, final: f.resourceCache.getState() };
    });
    assert.equal(result.failed, null);
    assert.match(result.partial.pack.error, /校验失败/);
    assert.equal(result.partial.required.done, 1);
    assert.equal(result.partial.required.downloadedBytes, 9);
    assert.deepEqual(result.retried, { imported: 1, existing: 1, skipped: 0 });
    assert.equal(result.final.required.done, 2);
    assert.equal(result.final.required.downloadedBytes, 18);
    assert.equal(result.final.pack.error, null);
  });

  test('the final import scan merges a foreground write completed after its snapshot', async () => {
    const a = item('/assets/pack.txt', 'from-pack'), b = item('/assets/foreground.txt', 'foreground');
    const config = fixture([a, b], [], [], { [b.url]: 'foreground' });
    config.pack = pack([{ item: a, body: 'from-pack' }]);
    const result = await harness.run(config, async () => {
      const f = globalThis.resourceFixture;
      f.pauseScanAt = 2; // packOperation's initial scan, followed by import's final scan.
      f.duringScan = async () => { await (await f.cachedFetch('/assets/foreground.txt')).text(); };
      const imported = await f.resourceCache.importPack(new Blob([new Uint8Array(f.config.pack)]));
      return { imported, state: f.resourceCache.getState(), error: f.scanWriteError, scans: f.io.scans,
        cached: f.resourceCache.isCached('/assets/foreground.txt') };
    });
    assert.deepEqual(result.imported, { imported: 1, existing: 0, skipped: 0 });
    assert.equal(result.error, undefined);
    assert.equal(result.scans, 2);
    assert.equal(result.cached, true);
    assert.equal(result.state.required.done, 2);
    assert.equal(result.state.required.downloadedBytes, 19);
  });

  test('a foreground consumer takes over an actively cancelled preload', async () => {
    const body = 'preload takeover', resource = item('/assets/takeover.txt', body);
    const result = await harness.run(fixture([resource], [], [], { [resource.url]: body }), async () => {
      const f = globalThis.resourceFixture;
      let started;
      const firstDownload = new Promise(resolve => { started = resolve; });
      let rawRequests = 0;
      f.onFetch = async (url, options) => {
        if (url.pathname !== '/assets/takeover.txt' || ++rawRequests > 1) return null;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')), { once: true });
          started();
        });
      };
      const preload = f.resourceCache.download('required', { urls: ['/assets/takeover.txt'] });
      await firstDownload;
      const before = f.io.gets.length;
      const foregroundHasRead = new Promise(resolve => {
        f.onReadComplete = entry => { if (entry.sequence > before) resolve(); };
      });
      const foreground = f.cachedFetch('/assets/takeover.txt');
      await foregroundHasRead;
      f.resourceCache.pause('required');
      const text = await (await foreground).text();
      return { text, preload: await preload, rawRequests, cached: f.resourceCache.isCached('/assets/takeover.txt') };
    });
    assert.equal(result.text, body);
    assert.equal(result.preload, false);
    assert.equal(result.rawRequests, 2, 'one cancelled request and one foreground retry');
    assert.equal(result.cached, true);
  });

  test('a queued preload skipped by pause cannot leave a foreground waiter without a resource', async () => {
    const blockers = [0, 1, 2].map(index => item(`/assets/block-${index}.txt`, `block-${index}`));
    const target = item('/assets/queued.txt', 'queued resource', { pack: { offset: 12, storedBytes: 15, total: 27, encoding: 'identity' } });
    const bodies = Object.fromEntries([...blockers.map((entry, index) => [entry.url, `block-${index}`]), [target.url, 'queued resource']]);
    const result = await harness.run(fixture([...blockers, target], [], [], bodies), async () => {
      const f = globalThis.resourceFixture, releases = [], started = [];
      f.onFetch = async url => {
        if (url.pathname.endsWith('.sprpack')) return null;
        if (!url.pathname.startsWith('/assets/block-')) return null;
        return new Promise(resolve => {
          releases.push(() => resolve(new Response(f.config.bodies[url.pathname])));
          started.splice(0).forEach(wake => wake());
        });
      };
      const blockers = [0, 1, 2].map(index => f.cachedFetch(`/assets/block-${index}.txt`));
      while (releases.length < 3) await new Promise(resolve => started.push(resolve));
      let observedCheck = false, off;
      const queued = new Promise(resolve => {
        off = f.resourceCache.subscribe(state => {
          if (state.checking) observedCheck = true;
          if (observedCheck && !state.checking && state.required.running) {
            off(); setTimeout(resolve, 0);
          }
        });
      });
      const preload = f.resourceCache.download('required', { urls: ['/assets/queued.txt'] });
      await queued;
      f.resourceCache.pause('required');
      const before = f.io.gets.length;
      const foregroundHasRead = new Promise(resolve => {
        f.onReadComplete = entry => { if (entry.sequence > before && entry.key.endsWith('/assets/queued.txt')) resolve(); };
      });
      const foreground = f.cachedFetch('/assets/queued.txt');
      await foregroundHasRead;
      releases[0]();
      const text = await (await foreground).text();
      releases.slice(1).forEach(release => release());
      await Promise.all(blockers);
      return { text, preload: await preload, targetRequests: f.requests.filter(request => request.path === '/assets/queued.txt').length };
    });
    assert.equal(result.text, 'queued resource');
    assert.equal(result.preload, false);
    assert.equal(result.targetRequests, 1);
  });

  test('disabled IndexedDB uses one shared verified online response without marking it cached', async () => {
    const body = 'storage unavailable', resource = item('/assets/no-idb.txt', body);
    const config = fixture([resource], [], [], { [resource.url]: body });
    config.disableIndexedDB = true;
    const result = await harness.run(config, async () => {
      const f = globalThis.resourceFixture;
      const entered = await f.resourceCache.ensureSessionReady();
      const responses = await Promise.all([f.cachedFetch('/assets/no-idb.txt'), f.cachedFetch('/assets/no-idb.txt')]);
      return { entered, bodies: await Promise.all(responses.map(response => response.text())),
        cached: f.resourceCache.isCached('/assets/no-idb.txt'),
        requests: f.requests.filter(request => request.path === '/assets/no-idb.txt').length };
    });
    assert.equal(result.entered, true);
    assert.deepEqual(result.bodies, [body, body]);
    assert.equal(result.cached, false);
    assert.equal(result.requests, 1);
  });

  test('a quota failure returns the verified downloaded blob without claiming persistence', async () => {
    const body = 'quota fallback data', resource = item('/assets/quota.txt', body);
    const result = await harness.run(fixture([resource], [], [], { [resource.url]: body }), async () => {
      const f = globalThis.resourceFixture, original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...rest) {
        if (this.name === 'resources') throw new DOMException('full', 'QuotaExceededError');
        return original.call(this, value, ...rest);
      };
      const response = await f.cachedFetch('/assets/quota.txt');
      IDBObjectStore.prototype.put = original;
      return { text: await response.text(), cached: f.resourceCache.isCached('/assets/quota.txt'), state: f.resourceCache.getState(),
        requests: f.requests.filter(request => request.path === '/assets/quota.txt').length };
    });
    assert.equal(result.text, body);
    assert.equal(result.cached, false);
    assert.equal(result.requests, 1);
    assert.equal(result.state.required.done, 0);
  });
});
