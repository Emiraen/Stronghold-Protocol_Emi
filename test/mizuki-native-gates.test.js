import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = new URL('../public/assets/mizuki/native-gates/', import.meta.url);
const maps = new URL('../public/assets/mizuki/native-maps/', import.meta.url);
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = read(new URL('manifest.json', base));
const placements = read(new URL('placements.json', base));

test('original gate textures, meshes, prefabs and all untouched serialized records retain verified hashes', () => {
  assert.equal(manifest.source, 'local-client');
  assert.equal(manifest.warnings.length, 0);
  assert.deepEqual(Object.keys(manifest.prefabs).sort(), ['tile_end', 'tile_end_special', 'tile_flystart', 'tile_start']);
  assert.equal(Object.keys(manifest.groups['fx/tex']).length, 6);
  assert.equal(Object.keys(manifest.groups['fx/mesh']).length, 8);
  assert.equal(Object.keys(manifest.groups['fx/tex-fullres']).length, 6);
  assert.equal(Object.keys(manifest.groups['fx/texture-payloads']).length, 6);
  for (const [key, original] of Object.entries(manifest.groups['fx/tex'])) {
    const full = manifest.groups['fx/tex-fullres'][key];
    assert.equal(original.fullres, full.path, key);
    assert.equal(full.w, original.w, key);
    assert.equal(full.h, original.h, key);
    assert.ok(full.path.endsWith('.png') && !full.path.includes('/half/'), key);
  }
  for (const group of Object.values(manifest.groups)) for (const entry of Object.values(group)) {
    const path = new URL('../public/' + entry.path.replace(/^\//, ''), import.meta.url);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(sha(bytes), entry.sha256, entry.path);
  }
  assert.ok(manifest.raw.length > 1000);
  for (const entry of manifest.raw) {
    const bytes = readFileSync(new URL(entry.file, base));
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(sha(bytes), entry.sha256, entry.file);
  }
});

test('all 280 gate placements come from original scene tiles and match all 60 original level matrices', () => {
  const mapManifest = read(new URL('manifest.json', maps));
  assert.deepEqual(placements.stages, mapManifest.stages);
  assert.equal(Object.keys(placements.stages).length, 97);
  assert.equal(Object.keys(placements.scenes).length, 60);
  const usage = {};
  for (const [sceneId, scene] of Object.entries(placements.scenes)) {
    const level = read(new URL('../data/mizuki/levels/' + sceneId + '.json', import.meta.url));
    for (const gate of scene.gates) {
      const prefab = read(new URL('fx/' + gate.rootFile, maps));
      const node = prefab.nodes[gate.node];
      const tile = node.behaviours.find((item) => item.class === 'Tile' && item.namespace === 'Torappu.Battle');
      assert.equal(gate.effect, tile.fields._effect, sceneId);
      assert.equal(gate.tileKey, tile.fields._tileKey, sceneId);
      assert.deepEqual(gate.data, tile.fields._data, sceneId);
      assert.deepEqual(gate.ancestry[0].pos, node.pos, sceneId);
      assert.deepEqual(gate.ancestry[0].rot, node.rot, sceneId);
      assert.equal(gate.gridRow, level.mapData.map.length - 1 - gate.sceneRow, sceneId);
      assert.equal(gate.gridCol, gate.sceneCol, sceneId);
      assert.equal(gate.levelTileIndex, level.mapData.map[gate.gridRow][gate.gridCol], sceneId);
      assert.equal(level.mapData.tiles[gate.levelTileIndex].tileKey, gate.tileKey, sceneId);
      usage[gate.effect] = (usage[gate.effect] || 0) + 1;
    }
  }
  assert.deepEqual(usage, { tile_start: 183, tile_end: 87, tile_flystart: 10 });
  assert.deepEqual(usage, manifest.usage);
});

test('original gates preserve directionless infinite particle loops and the separate flying gate animation', () => {
  for (const key of ['tile_start', 'tile_end']) {
    const prefab = read(new URL('fx/prefabs/' + key + '.json', base));
    const effect = prefab.nodes[0].behaviours.find((item) => item.class === 'ParticleEffect').fields;
    assert.equal(effect._rotateType, 0);
    assert.equal(effect._spawnLocation, 0);
    assert.equal(effect._isLoop, 1);
    assert.equal(effect._maxLifetime, -1);
    assert.equal(effect._useBodyRotation, 0);
    assert.equal(prefab.nodes.find((item) => item.name === 'Meshes').behaviours[0].fields._delayTime, 0.4);
    assert.equal(prefab.clips[0].length, 2);
    assert.equal(prefab.clips[0].loop, true);
  }
  const flying = read(new URL('fx/prefabs/tile_flystart.json', base));
  assert.equal(flying.stats.particleSystems, 0);
  assert.equal(flying.clips[0].loop, true);
  assert.ok(Math.abs(flying.clips[0].length - 0.966667) < 1e-6);
});
