import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resourceBrowserHarness, resourceTestChrome } from './helpers/resourceCacheBrowser.js';

const version = 'a'.repeat(64);
const item = (url, extra = {}) => ({ url, version, bytes: 7, type: 'text/plain', ...extra });
const fixture = required => ({ manifest: { schema: 1, groups: { required, optional: [], voice: [] } }, bodies: {} });
const largeItems = (prefix, count = 8193) => Array.from({ length: count }, (_, index) => item(`/assets/${prefix}-${index}.bin`));

describe('resource manifest indexing in the browser', { skip: resourceTestChrome ? false : 'requires local Chrome (CHROME_PATH)' }, () => {
  let harness;
  before(async () => { harness = await resourceBrowserHarness(); });
  after(async () => { await harness?.close(); });

  test('large manifests yield before publishing and concurrent callers share one complete index', async () => {
    const items = largeItems('index');
    const result = await harness.run(fixture(items), async () => {
      const f = globalThis.resourceFixture, NativeURL = globalThis.URL;
      let queued = false, resolved = 0, observation;
      const probe = new Promise(resolve => {
        globalThis.URL = class extends NativeURL {
          constructor(url, base) {
            super(url, base);
            if (!queued && String(url).startsWith('/assets/index-')) {
              queued = true;
              setTimeout(() => {
                const state = f.resourceCache.getState();
                observation = { resolved, first: f.resourceCache.isManaged('/assets/index-0.bin'),
                  last: f.resourceCache.isManaged('/assets/index-8192.bin'), total: state.required.total };
                resolve();
              }, 0);
            }
          }
        };
      });
      const pending = Array.from({ length: 6 }, () => f.resourceCache.ensureSessionReady().then(value => { resolved++; return value; }));
      try {
        const results = await Promise.all(pending);
        await probe;
        return { results, observation, manifestRequests: f.manifestRequests.length,
          state: f.resourceCache.getState(), first: f.resourceCache.isManaged('/assets/index-0.bin'),
          last: f.resourceCache.isManaged('/assets/index-8192.bin') };
      } finally { globalThis.URL = NativeURL; }
    });
    assert.deepEqual(result.results, Array(6).fill(true));
    assert.deepEqual(result.observation, { resolved: 0, first: false, last: false, total: 0 },
      'a normal event-loop task must run during indexing while the public index is still unpublished');
    assert.equal(result.manifestRequests, 1);
    assert.equal(result.state.required.total, items.length);
    assert.equal(result.first, true);
    assert.equal(result.last, true);
  });

  test('cross-group aliases, audio normalization, optional migrations and group deduplication keep their meaning', async () => {
    const rawAudio = '/assets/audio/bgm/theme.mp3?edition=1#raw';
    const audio = item(rawAudio, { type: 'audio/mpeg' });
    const gif = item('/assets/local/playercards/trickster-outbreak/card.gif', { type: 'image/gif' });
    const portrait = item('/assets/char/portrait/skin/amiya_special.png', { type: 'image/png' });
    const config = fixture([audio, gif, portrait, item('/assets/char/portrait-hd/retired.png', { type: 'image/png' })]);
    config.manifest.groups.optional = [item('/media/bgm/theme?edition=1#optional', { type: 'audio/mpeg' }), audio];
    config.manifest.groups.voice = [audio, audio];
    const result = await harness.run(config, async () => {
      const f = globalThis.resourceFixture;
      const ready = await f.resourceCache.ensureSessionReady();
      const states = [
        '/assets/audio/bgm/theme.mp3?edition=1#anything',
        '/media/bgm/theme?edition=1#anything',
        `${f.WIN7_RESOURCE_ORIGIN}/assets/audio/bgm/theme.mp3?edition=1#anything`,
        `${location.origin}/assets/audio/bgm/theme.mp3?edition=1`,
      ].map(url => ({ managed: f.resourceCache.isManaged(url), optional: f.resourceCache.isOptional(url) }));
      const migrated = [f.config.manifest.groups.required[1].url, f.config.manifest.groups.required[2].url]
        .map(url => ({ managed: f.resourceCache.isManaged(url), optional: f.resourceCache.isOptional(url) }));
      return { ready, states, migrated, state: f.resourceCache.getState(),
        retired: f.resourceCache.isManaged('/assets/char/portrait-hd/retired.png') };
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.states, Array(4).fill({ managed: true, optional: false }));
    assert.deepEqual(result.migrated, Array(2).fill({ managed: true, optional: true }));
    assert.equal(result.state.required.total, 1);
    assert.equal(result.state.optional.total, 3);
    assert.equal(result.state.voice.total, 1);
    assert.equal(result.state.hdPortraits.total, 0);
    assert.equal(result.retired, false);
  });

  test('absolute and protocol-relative URLs preserve origin, query and fragment semantics', async () => {
    const config = fixture([item('http://resources.example/assets/remote.bin?rev=1#first')]);
    const result = await harness.run(config, async () => {
      const f = globalThis.resourceFixture;
      f.config.manifest.groups.required.push({ url: `${location.origin}/assets/same.bin?rev=2#first`,
        version: 'a'.repeat(64), bytes: 7, type: 'text/plain' });
      await f.resourceCache.ensureSessionReady();
      return { remote: [
        'http://resources.example/assets/remote.bin?rev=1#second',
        '//resources.example/assets/remote.bin?rev=1',
        'http://resources.example/assets/remote.bin?rev=2',
        'https://resources.example/assets/remote.bin?rev=1',
      ].map(url => f.resourceCache.isManaged(url)),
      local: ['/assets/same.bin?rev=2#different', `${location.origin}/assets/same.bin?rev=2`,
        '/assets/same.bin?rev=3'].map(url => f.resourceCache.isManaged(url)) };
    });
    assert.deepEqual(result.remote, [true, true, false, false]);
    assert.deepEqual(result.local, [true, true, false]);
  });

  test('a required item moved to optional still downloads from its original indexed pack group', async () => {
    const body = 'dynamic-card';
    const resource = item('/assets/local/playercards/trickster-outbreak/card.gif', {
      version: createHash('sha256').update(body).digest('hex'), bytes: body.length, type: 'image/gif',
      pack: { offset: 12, storedBytes: body.length, total: body.length + 12, encoding: 'identity' },
    });
    const config = fixture([resource]);
    config.bodies[resource.url] = body;
    const result = await harness.run(config, async () => {
      const f = globalThis.resourceFixture;
      await f.resourceCache.ensureSessionReady();
      const downloaded = await f.resourceCache.download('optional', { urls: [f.config.manifest.groups.required[0].url] });
      return { downloaded, requests: f.requests, state: f.resourceCache.getState() };
    });
    assert.equal(result.downloaded, true);
    assert.deepEqual(result.requests.map(request => request.path), [
      '/assets/resource-required-lossless.sprpack', resource.url,
    ]);
    assert.equal(result.state.required.total, 0);
    assert.equal(result.state.optional.total, 1);
    assert.equal(result.state.optional.done, 1);
  });

  for (const kind of ['conflict', 'bad-item']) {
    test(`a late ${kind} rejects the shared load and retry leaves no partial entries or aliases`, async () => {
      const items = largeItems('discard', 4097);
      const audio = item('/assets/audio/bgm/discard.mp3', { type: 'audio/mpeg' });
      const invalid = kind === 'conflict' ? { ...audio, url: '/media/bgm/discard', version: 'b'.repeat(64) }
        : item('/assets/invalid.bin', { bytes: 0 });
      const config = fixture([audio, ...items, invalid]);
      const result = await harness.run(config, async () => {
        const f = globalThis.resourceFixture, NativeURL = globalThis.URL;
        let queued = false, yielded = false;
        globalThis.URL = class extends NativeURL {
          constructor(url, base) {
            super(url, base);
            if (!queued && String(url).startsWith('/assets/discard-')) {
              queued = true;
              setTimeout(() => { yielded = true; }, 0);
            }
          }
        };
        let first;
        try { first = await Promise.all([f.resourceCache.ensureSessionReady(), f.resourceCache.ensureSessionReady()]); }
        finally { globalThis.URL = NativeURL; }
        const rejectedState = f.resourceCache.getState();
        const before = { first: f.resourceCache.isManaged('/assets/discard-0.bin'),
          last: f.resourceCache.isManaged('/assets/discard-4096.bin'), audio: f.resourceCache.isManaged('/media/bgm/discard') };
        f.config.manifest = { schema: 1, groups: { required: [{ url: '/assets/repaired.bin', version: 'c'.repeat(64), bytes: 3, type: 'text/plain' }], optional: [], voice: [] } };
        const retried = await f.resourceCache.ensureSessionReady();
        return { first, before, rejectedState, retried, yielded, requests: f.manifestRequests.length,
          state: f.resourceCache.getState(), repaired: f.resourceCache.isManaged('/assets/repaired.bin'),
          leftovers: ['/assets/discard-0.bin', '/assets/discard-4096.bin', '/assets/audio/bgm/discard.mp3',
            '/media/bgm/discard', `${f.WIN7_RESOURCE_ORIGIN}/assets/audio/bgm/discard.mp3`]
            .map(url => f.resourceCache.isManaged(url)) };
      });
      assert.deepEqual(result.first, [false, false]);
      assert.equal(result.yielded, true, 'the rejected attempt must have already yielded between batches');
      assert.ok(result.rejectedState.error);
      assert.equal(result.rejectedState.required.total, 0);
      assert.deepEqual(result.before, { first: false, last: false, audio: false });
      assert.equal(result.retried, true);
      assert.equal(result.requests, 2);
      assert.equal(result.repaired, true);
      assert.deepEqual(result.leftovers, Array(5).fill(false));
      assert.equal(result.state.required.total, 1);
      assert.equal(result.state.optional.total, 0);
      assert.equal(result.state.voice.total, 0);
    });
  }

  test('the shipped runtime manifest loads at full size without fetching any resource', async () => {
    const manifest = JSON.parse(gunzipSync(await readFile(new URL('../data/resource-preload.runtime.json.gz', import.meta.url))));
    const result = await harness.run({ manifest, bodies: {} }, async () => {
      const f = globalThis.resourceFixture;
      const loaded = await f.resourceCache.ensureSessionReady();
      const state = f.resourceCache.getState();
      return { loaded, error: state.error, counts: { required: state.required.total, optional: state.optional.total, voice: state.voice.total },
        requests: f.requests, manifestRequests: f.manifestRequests.length,
        missing: Object.values(f.config.manifest.groups).flat()
          .filter(item => !item.url.includes('/assets/char/portrait-hd/') && !f.resourceCache.isManaged(item.url))
          .map(item => item.url),
        firstRequired: f.resourceCache.isManaged(f.config.manifest.groups.required[0].url),
        lastOptional: f.resourceCache.isManaged(f.config.manifest.groups.optional.at(-1).url),
        firstVoice: f.resourceCache.isManaged(f.config.manifest.groups.voice[0].url) };
    });
    assert.equal(result.loaded, true);
    assert.equal(result.error, null);
    assert.equal(result.manifestRequests, 1);
    assert.deepEqual(result.requests, []);
    assert.equal(result.firstRequired, true);
    assert.equal(result.lastOptional, true);
    assert.equal(result.firstVoice, true);
    assert.deepEqual(result.missing, []);
    assert.ok(Object.values(result.counts).reduce((total, count) => total + count, 0) > 10000);
    for (const group of ['required', 'optional', 'voice']) {
      assert.ok(result.counts[group] > 0);
      assert.ok(result.counts[group] <= manifest.groups[group].length);
    }
  });
});
