import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { createMizukiMapLoader } from '../public/js/mizukiMaps.js';
import { createAssets } from '../public/js/assets.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const node = (id, parent, extra = {}) => ({ id, parent, active: true, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], ...extra });

function fixture({ fail = null } = {}) {
  const files = new Map(), calls = [], decoded = [], activeImages = new Set();
  let maxImages = 0;
  const record = (path, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    files.set(path, bytes);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const texture = key => record('/assets/mizuki/test/' + key + '.png', key);
  const descriptor = { key: 'root', materials: { 0: { shader: 'Torappu/Scene/Standard', textures: { _MainTex: { tex: 'diffuse' }, _BumpMap: { tex: 'normal' } } } }, meshes: ['mesh'], nodes: [
    node(1, null, { name: 'MapGraphic', behaviours: [{ class: 'MapGraphic' }] }),
    node(2, 1, { name: 'Tiles' }),
    node(3, 2, { behaviours: [{ class: 'Tile' }] }),
    node(4, 1, { meshFilter: 'mesh', meshRenderer: { materials: [0], native: { m_LightmapIndex: 0 } } })
  ] };
  const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, -1, 0, 0, -1, 0, 0, -1], uv0: [0, 0, 1, 0, 0, 1], submeshes: [[0, 1, 2]] };
  const manifest = { scenes: {}, stages: { stage: 'scene' }, groups: {
    'scene/data': { scene: record('/assets/mizuki/test/scene.json', { roots: [{ key: 'root' }], lightmaps: [{ index: 0, textureKey: 'light', shadowMaskKey: 'shadow' }, { index: 1 }] }) },
    'scene/roots': { root: record('/assets/mizuki/test/root.json', descriptor) },
    'scene/meshes': { mesh: record('/assets/mizuki/test/mesh.json', mesh) },
    'scene/texture-fullres': Object.fromEntries(['diffuse', 'normal', 'light', 'shadow'].map(key => [key, texture(key)]))
  } };
  const env = texture('env');
  const reflection = record('/assets/mizuki/test/reflection.json', { images: { env: env.path }, light: { dir: [0, -1, 0], source: 'native' } });
  const reflectionManifest = { scenes: { scene: reflection }, groups: { 'scene/data': { scene: reflection }, 'scene/env': { env } } };
  const fetchFn = async path => {
    calls.push(path); await delay(6);
    if (path === fail) return new Response('unavailable', { status: 503 });
    const bytes = files.get(path); return new Response(bytes, { status: bytes ? 200 : 404 });
  };
  // This is the ordinary assets.image cache with an injected image decoder.
  const assets = createAssets({ manifest: { version: 1 }, localManifest: { version: 1, groups: {} }, loadImage: async path => {
    decoded.push(path); activeImages.add(path); maxImages = Math.max(maxImages, activeImages.size);
    await fetchFn(path); await delay(6); activeImages.delete(path);
    return { width: 1024, height: 1024, source: path, encoding: 'image/webp' };
  } });
  return { manifest, reflectionManifest, calls, decoded, files, fetchFn, assets, maxImages: () => maxImages };
}

test('prep to combat reuses ordinary decoded images and parsed native source without new IO', async () => {
  const f = fixture(), loader = createMizukiMapLoader(f.manifest, f);
  const [prep, concurrent] = await Promise.all([loader.load('stage', THREE, 2), loader.load('stage', THREE, 2)]);
  assert.equal(prep, concurrent);
  const calls = f.calls.length, decoded = f.decoded.length;
  const battle = await loader.load('stage', THREE, 0);
  assert.equal(f.calls.length, calls); assert.equal(f.decoded.length, decoded);
  assert.equal(f.calls.length, 9); assert.equal(new Set(f.calls).size, 9); assert.equal(decoded, 5);
  assert.equal(prep.images, battle.images);
  assert.equal(prep.chunks[0].index, battle.chunks[0].index);
  assert.equal(prep.chunks[0].uv, battle.chunks[0].uv);
  assert.equal(prep.chunks[0].normal, battle.chunks[0].normal);
  assert.notEqual(prep.chunks[0].position, battle.chunks[0].position);
  for (let i = 0; i < battle.chunks[0].position.length; i++) assert.equal(prep.chunks[0].position[i], battle.chunks[0].position[i] + (i % 3 === 1 ? 2 : 0));
  assert.equal(prep.images.lm[1], null);
  assert.equal(prep.images.env.encoding, 'image/webp');
  assert.ok(f.maxImages() >= 4, 'diffuse, normal, lightmap and shadowmask load concurrently');
});

test('preparing current stage starts native metadata before renderer and shares later load', async () => {
  const f = fixture(), loader = createMizukiMapLoader(f.manifest, f);
  const preparing = loader.prepare('stage:mizuki-prep');
  assert.ok(f.calls.includes('/assets/mizuki/test/scene.json'));
  assert.ok(f.calls.includes('/assets/mizuki/test/reflection.json'));
  await preparing;
  await loader.load('stage', THREE, 0);
  assert.equal(f.calls.filter(path => path.endsWith('scene.json')).length, 1);
  assert.equal(f.calls.filter(path => path.endsWith('mesh.json')).length, 1);
});

test('failed scene load is retryable and unavailable mandatory textures never produce a partial map', async () => {
  const f = fixture(); let failures = 1;
  const loader = createMizukiMapLoader(f.manifest, { ...f, fetchFn: path => {
    if (path.endsWith('/scene.json') && failures-- > 0) return Promise.resolve(new Response('', { status: 503 }));
    return f.fetchFn(path);
  } });
  await assert.rejects(loader.load('stage', THREE, 0), /Original map unavailable/);
  assert.ok((await loader.load('stage', THREE, 0)).chunks.length);
  const broken = fixture(); delete broken.manifest.groups['scene/texture-fullres'].diffuse;
  await assert.rejects(createMizukiMapLoader(broken.manifest, broken).load('stage', THREE, 0), /full-resolution lossless map texture unlisted/);
});

test('native JSON integrity is retained on the shared fetch path', async () => {
  const f = fixture(); f.files.set('/assets/mizuki/test/mesh.json', Buffer.from('{}'));
  await assert.rejects(createMizukiMapLoader(f.manifest, f).load('stage', THREE, 0), /integrity mismatch/);
});
