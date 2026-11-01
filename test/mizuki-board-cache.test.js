import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMizukiBoardAssets } from '../public/js/mizukiBoard.js';
import { createAssets } from '../public/js/assets.js';

test('board initialization shares ordinary image decoding and requests no unused metadata', async () => {
  let reads = 0, decodes = 0;
  const image = { width: 2, height: 2 };
  const base = createAssets({ manifest: {}, localManifest: { groups: {} }, loadImage: async () => { decodes++; return image; } });
  const manifest = { groups: { 'map/autochess': {
    TX_autochessi_D: { path: '/assets/mizuki/board/d.png' },
    materials: { path: '/assets/mizuki/board/materials.json' },
    unused: { path: '/assets/mizuki/board/unused.obj' },
  } } };
  const prepared = await prepareMizukiBoardAssets(base, manifest, { fetchFn: async () => { reads++; return new Response('{}'); } });
  assert.equal(reads, 0);
  const url = prepared.assets.localUrl('map/autochess', 'TX_autochessi_D');
  assert.equal(await prepared.assets.image(url), image);
  assert.equal(await base.image(url), image);
  assert.equal(decodes, 1);
  const [a, b] = await Promise.all([prepared.assets.fetchBoardData('/assets/mizuki/board/materials.json'), prepared.assets.fetchBoardData('/assets/mizuki/board/materials.json')]);
  assert.notEqual(a, b);
  assert.deepEqual(await a.json(), {}); assert.deepEqual(await b.json(), {});
  assert.equal(reads, 1);
  prepared.destroy();
  await assert.rejects(prepared.assets.fetchBoardData('/assets/mizuki/board/materials.json'), /released/);
  assert.equal(await base.image(url), image);
  assert.equal(decodes, 1);
});

test('failed board metadata can retry without discarding the shared image cache', async () => {
  let reads = 0;
  const prepared = await prepareMizukiBoardAssets({ image: async () => ({ width: 1 }) }, { groups: { 'map/autochess': {
    TX_autochessi_D: { path: '/assets/mizuki/board/d.png' }, materials: { path: '/assets/mizuki/board/materials.json' },
  } } }, { fetchFn: async () => { reads++; if (reads === 1) throw Error('transient'); return new Response('{"ok":true}'); } });
  await assert.rejects(prepared.assets.fetchBoardData('/assets/mizuki/board/materials.json'), /transient/);
  assert.deepEqual(await (await prepared.assets.fetchBoardData('/assets/mizuki/board/materials.json')).json(), { ok: true });
  assert.equal(reads, 2);
  prepared.destroy();
});
