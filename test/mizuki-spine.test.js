import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMizukiSpineCache, loadMizukiSpine, unloadMizukiSpine } from '../public/js/mizukiSpine.js';

function fixture() {
  const root = '/assets/mizuki/library/spines/real/real';
  const entry = { skel: root + '.skel', atlas: root + '.atlas', textures: [root + '.png'], pma: true, anims: {} };
  const files = new Map([[entry.skel, new Uint8Array([1, 2, 3])],
    [entry.atlas, new TextEncoder().encode('real.png')], [entry.textures[0], new Uint8Array([4, 5])]]);
  entry.files = [...files].map(([url, bytes]) => ({ name: url.slice(url.lastIndexOf('/') + 1),
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const calls = []; const textures = [];
  const atlas = { pages: [], disposed: 0, dispose() { this.disposed++; for (const texture of textures) texture.baseTexture.destroyed = true; } };
  const data = { animations: [] };
  const atlasParser = { test: url => url.endsWith('.atlas'), async parse(text, asset, loader) {
    calls.push('atlas'); assert.equal(text, 'real.png'); assert.deepEqual(asset.data, {});
    assert.strictEqual(await loader.load({ src: entry.textures[0] }), textures[0]); return atlas;
  } };
  const skeletonParser = { test: url => url.endsWith('.skel'), parse(bytes, asset) {
    calls.push('skeleton'); assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3]);
    assert.strictEqual(asset.data.spineAtlas, atlas); return { spineData: data };
  } };
  const PIXI = { spine: {}, Assets: { loader: { parsers: [atlasParser, skeletonParser] } } };
  const options = { PIXI, fetch: async url => { calls.push(url); const bytes = files.get(url);
    return { ok: !!bytes, arrayBuffer: async () => bytes.slice().buffer }; },
  makeTexture: async () => { const texture = { baseTexture: { destroyed: false }, destroyed: 0,
    destroy() { this.destroyed++; } }; textures.push(texture); return texture; } };
  return { entry, files, options, calls, textures, atlas, data, atlasParser, skeletonParser };
}

test('extracted models use unchanged native parsers and release their own textures once', async () => {
  const f = fixture(); const parsers = [...f.options.PIXI.Assets.loader.parsers];
  assert.strictEqual(await loadMizukiSpine(f.entry, f.options), f.data);
  assert.deepEqual(f.calls.slice(-2), ['atlas', 'skeleton']);
  assert.deepEqual(f.options.PIXI.Assets.loader.parsers, parsers);
  unloadMizukiSpine(f.entry, f.data); unloadMizukiSpine(f.entry, f.data);
  assert.equal(f.atlas.disposed, 1); assert.equal(f.textures[0].destroyed, 1);
});

test('source integrity failures and non-Mizuki paths never enter a native parser', async () => {
  const f = fixture(); f.files.set(f.entry.skel, new Uint8Array([9, 2, 3]));
  await assert.rejects(loadMizukiSpine(f.entry, f.options), /hash mismatch/);
  assert.equal(f.textures.length, 0); assert.ok(!f.calls.includes('skeleton'));
  const count = f.calls.length;
  await assert.rejects(loadMizukiSpine({ ...f.entry, skel: '/assets/spine/old.skel' }, f.options), /Not a Mizuki/);
  assert.equal(f.calls.length, count);
});

test('partial native parse failure frees only locally created textures', async () => {
  const f = fixture(); f.skeletonParser.parse = () => { throw new Error('bad skeleton'); };
  await assert.rejects(loadMizukiSpine(f.entry, f.options), /bad skeleton/);
  assert.equal(f.atlas.disposed, 1); assert.equal(f.textures[0].destroyed, 1);
});

test('private Mizuki opt-in loads installed base operators without changing default path restrictions', async () => {
  const f = fixture(), old = { ...f.entry, skel: '/assets/~abc12345/spine/op/real.skel', atlas: '/assets/~abc12345/spine/op/real.atlas', textures: ['/assets/~abc12345/spine/op/real.png'] };
  for (const [before, after] of [[f.entry.skel,old.skel],[f.entry.atlas,old.atlas],[f.entry.textures[0],old.textures[0]]]) f.files.set(after,f.files.get(before));
  await assert.rejects(loadMizukiSpine(old, f.options), /Not a Mizuki/);
  assert.equal(f.calls.length,0);
  assert.strictEqual(await loadMizukiSpine(old, { ...f.options, allowLocal: true }),f.data);
  unloadMizukiSpine(old,f.data);
  assert.equal(f.atlas.disposed,1);
  await assert.rejects(loadMizukiSpine({ ...old, skel:'https://example.com/assets/real.skel' },{...f.options,allowLocal:true}),/Not a Mizuki/);
});

test('mode cache delegates native entries and keeps extracted entries outside the shared cache', async () => {
  const f = fixture(); const calls = [];
  const base = { acquire: async entry => { calls.push(['acquire', entry]); return 'shared'; },
    release: entry => calls.push(['release', entry]), peek: () => 'shared', restart: () => true,
    hold: () => { calls.push(['hold']); return () => calls.push(['unhold']); },
    clear: () => calls.push(['clear']), stats: () => ({ size: 1, ready: 1, failed: 0 }) };
  const cache = createMizukiSpineCache(base, f.options);
  const native = { skel: '/assets/spine/real.skel' };
  assert.equal(await cache.acquire(native), 'shared'); cache.release(native);
  const release = cache.hold();
  assert.strictEqual(await cache.acquire(f.entry), f.data);
  assert.equal(cache.stats().extracted.ready, 1);
  assert.equal(calls.filter(([kind]) => kind === 'acquire').length, 1);
  cache.release(f.entry); release(); cache.clear();
  assert.ok(!calls.some(([kind]) => kind === 'clear'), 'clear never unloads the shared cache');
  assert.equal(f.atlas.disposed, 1);
});
