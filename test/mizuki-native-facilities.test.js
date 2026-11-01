import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileEffect, Effect } from '../public/js/render/vfx/effect.js';
import { FrameData, cameraBasis } from '../public/js/render/vfx/geom.js';

const base = new URL('../public/assets/mizuki/native-facilities/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, base), 'utf8'));
const manifest = read('manifest.json'), fx = read('fx/manifest.json'), index = read('fx/index.json');
const fileUrl = (path) => new URL('../public/' + path.replace(/^\//, ''), import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalFacilities = {
  trap_038_dsbell: ['skin_dsbell_default', 'skin_dsbell_caven'],
  trap_001_crate: ['skin_crate_wild', 'skin_crate_chbo_a', 'skin_crate_chbo_b', 'skin_crate_lm_d', 'skin_crate_lm_n',
    'skin_crate_volcano', 'skin_crate_jungle', 'skin_crate_year', 'skin_crate_kxml2', 'skin_crate_rl_red'],
  trap_027_stone: ['skin_stone_cave'], trap_010_frosts: ['skin_frosts_default', 'skin_frosts_roof_n', 'skin_frosts_rl_red'],
  trap_008_farm: ['skin_farm_default', 'skin_farm_cloudy', 'skin_farm_wild', 'skin_farm_seashore', 'skin_farm_chernobog_b'],
  trap_007_ballis: ['skin_ballis_default', 'skin_ballis_night', 'skin_ballis_rl_red'],
  trap_057_wpnsts: ['skin_wpnsts_default', 'skin_wpnsts_t1'], trap_024_npcsld: [], trap_005_sensor: [],
  trap_065_normbox: [], trap_066_rarebox: [], trap_068_badbox: [], trap_061_creep: [], trap_011_ore: [],
};

test('Dsbell theme selection and bundle provenance match the original native MapDependentTrap skin table', () => {
  const bell = manifest.facilities.trap_038_dsbell;
  assert.equal(manifest.source, 'local-client'); assert.equal(bell.defaultSkin, 'skin_dsbell_default');
  assert.deepEqual(bell.themeSkins, { CAVE: 'skin_dsbell_caven', WATER_CAVE: 'skin_dsbell_caven' });
  assert.equal(bell.root.bundle, 'pkgrps/btl_pfb_tokens_0.ab');
  assert.ok(bell.root.scripts.includes('Torappu.Battle.MapDependentTrap'));
  assert.equal(bell.skins.skin_dsbell_caven.container, 'dyn/battle/prefabs/skins/trap/skin_dsbell_caven.prefab');
  assert.equal(bell.skins.skin_dsbell_caven.bundle, 'battle/prefabs/skins/trap.ab');
  assert.equal(manifest.bundlesSha256['battle/prefabs/skins/trap.ab'], '6c9e211481bd4448cb91604de8bc1fe47cc5d64dc2cdb3814173aaa80a18c5cd');
  assert.deepEqual(manifest.missing, []); assert.deepEqual(manifest.warnings, []);
});

test('Dsbell keeps its original S_zhong mesh, local quaternion and one-percent FBX scale', () => {
  for (const key of ['skin_dsbell_default', 'skin_dsbell_caven']) {
    const prefab = read('fx/prefabs/' + key + '.json');
    assert.equal(prefab.nodes.length, 2); const meshNode = prefab.nodes.find((node) => node.meshFilter);
    assert.deepEqual(meshNode.rot, [-0.5, -0.5, 0.5, 0.5]); assert.deepEqual(meshNode.scale, [0.01, 0.01, 0.01]);
    assert.equal(meshNode.meshFilter, 'S_zhong-40b955b2');
    assert.equal(prefab.nodes[0].behaviours[0].class, 'MeshAnimator');
    assert.deepEqual(prefab.nodes[0].behaviours[0].fields._animations, []);
    assert.equal(meshNode.animator.controller, null); assert.deepEqual(prefab.clips, []);
  }
  const mesh = read('fx/mesh/S_zhong-40b955b2.json');
  assert.equal(mesh.format, 'fx-mesh'); assert.equal(mesh.vertexCount, 1433);
  assert.equal(mesh.positions.length, mesh.vertexCount * 3); assert.ok(mesh.positions.every(Number.isFinite));
  assert.equal(mesh.uv0.length, mesh.vertexCount * 2); assert.equal(mesh.submeshes.length, 1);
});

test('Dsbell default and cave use the exact distinct native textures and unlit opaque shader', () => {
  const original = read('fx/prefabs/skin_dsbell_default.json').materials[0];
  const cave = read('fx/prefabs/skin_dsbell_caven.json').materials[0];
  assert.equal(original.name, 'MT_zhong'); assert.equal(cave.name, 'MT_zhong_caven');
  assert.equal(original.shader, 'Unlit/Texture'); assert.equal(cave.shader, 'Unlit/Texture');
  assert.equal(original.textures._MainTex.tex, 'TX_zhong-eafa7638');
  assert.equal(cave.textures._MainTex.tex, 'TX_zhong_caven-305e24e8');
  assert.equal(cave.passes[0].zWrite, true); assert.equal(cave.passes[0].cull, 'Back');
});

test('every configured facility skin resolves to its exported prefab and preserves its native renderer kind', () => {
  assert.equal(Object.keys(originalFacilities).length, 14);
  for (const [id, skins] of Object.entries(originalFacilities)) {
    const facility = manifest.facilities[id]; assert.ok(facility, id + ' original baseline');
    for (const key of skins) assert.ok(facility.skins[key], key + ' original skin baseline');
  }
  for (const [id, facility] of Object.entries(manifest.facilities)) {
    assert.equal(facility.root.key, id); assert.ok(index.prefabs[id]);
    for (const key of [facility.defaultSkin, ...Object.values(facility.themeSkins)].filter(Boolean)) {
      const graphic = facility.skins[key]; assert.ok(graphic, id + ':' + key); assert.ok(index.prefabs[key]);
      const descriptor = JSON.parse(readFileSync(fileUrl(graphic.path), 'utf8'));
      assert.equal(descriptor.key, key); assert.ok(graphic.meshes.length > 0);
    }
  }
  for (const id of ['trap_024_npcsld', 'trap_065_normbox', 'trap_066_rarebox', 'trap_068_badbox']) {
    const facility = manifest.facilities[id]; assert.equal(facility.meshAvailable, false);
    assert.ok(facility.root.scripts.includes('Spine.Unity.SkeletonAnimation'));
    assert.equal(facility.defaultSkin, null);
  }
  assert.ok(manifest.facilities.trap_061_creep.root.scripts.includes('Torappu.Battle.EmptyAnimator'));
  assert.equal(manifest.facilities.trap_061_creep.meshAvailable, false);
});

test('all original facility descriptor, mesh and texture references exist with recorded bytes and SHA256', () => {
  let count = 0;
  for (const group of Object.values(fx.groups)) for (const asset of Object.values(group)) {
    const url = fileUrl(asset.path), bytes = readFileSync(url);
    assert.equal(statSync(url).size, asset.bytes, asset.path); assert.equal(digest(bytes), asset.sha256, asset.path); count++;
    if (asset.half) {
      const half = readFileSync(fileUrl(asset.half)); assert.equal(half.length, asset.halfBytes); assert.equal(digest(half), asset.halfSha256);
    }
  }
  assert.ok(count > 100);
  const baselinePrefabs = new Set(), baselineMeshes = new Set(), baselineTextures = new Set();
  for (const [id, skins] of Object.entries(originalFacilities)) for (const key of [id, ...skins]) {
    assert.ok(index.prefabs[key], key); assert.ok(fx.groups['fx/prefabs'][key], key); baselinePrefabs.add(key);
    const desc = JSON.parse(readFileSync(fileUrl(fx.groups['fx/prefabs'][key].path), 'utf8'));
    desc.meshes.forEach(value => baselineMeshes.add(value)); desc.textures.forEach(value => baselineTextures.add(value));
  }
  assert.equal(baselinePrefabs.size, 40); assert.equal(baselineMeshes.size, 55); assert.equal(baselineTextures.size, 31);
  for (const [key, record] of Object.entries(fx.groups['fx/prefabs'])) {
    const desc = JSON.parse(readFileSync(fileUrl(record.path), 'utf8'));
    assert.equal(desc.key, key); assert.ok(index.prefabs[key]);
    for (const node of desc.nodes) for (const behaviour of node.behaviours || []) {
      assert.ok(behaviour.class && behaviour.class !== '?', key + ' native MonoScript');
    }
    for (const material of desc.materials) {
      assert.ok(material.shader, key + ' native shader ' + material.name);
      assert.ok(material.passes.length > 0, key + ' native shader passes ' + material.name);
    }
    for (const mesh of desc.meshes) assert.ok(fx.groups['fx/mesh'][mesh], key + ' mesh ' + mesh);
    for (const texture of desc.textures) assert.ok(fx.groups['fx/tex'][texture], key + ' texture ' + texture);
  }
  for (const key of baselineMeshes) assert.ok(fx.groups['fx/mesh'][key], key);
  for (const key of baselineTextures) assert.ok(fx.groups['fx/tex'][key], key);
});

test('new native battle dice facilities resolve to original FX that draw real geometry', () => {
  const meshes = new Map(Object.entries(fx.groups['fx/mesh']).map(([key, record]) => [key, JSON.parse(readFileSync(fileUrl(record.path), 'utf8'))]));
  const lib = { mesh: key => meshes.get(key) || null }, camera = cameraBasis(45, [0, -15, -15], 900, .8);
  const effects = new Set();
  for (const id of ['trap_067_dice', 'trap_088_dice2', 'trap_089_dice3']) {
    const facility = manifest.facilities[id]; assert.ok(facility);
    assert.equal(facility.graphicPolicy, 'original-battle-effects');
    assert.deepEqual(facility.resultEffects, ['rogue_buff_01', 'rogue_buff_02', 'rogue_buff_03', 'rogue_buff_04']);
    for (const key of facility.effectKeys) { assert.ok(fx.groups['fx/prefabs'][key]); effects.add(key); }
  }
  assert.equal(effects.size, 6);
  for (const key of effects) {
    const desc = JSON.parse(readFileSync(fileUrl(fx.groups['fx/prefabs'][key].path), 'utf8'));
    const effect = new Effect(compileEffect(desc, lib), { lib, seed: 1 });
    effect.place({ pos: [0, 0, 0], groundZ: 0 }); let triangles = 0;
    for (let frame = 0; frame < 60; frame++) {
      effect.update(1 / 30); effect.collect(camera, new FrameData(), item => { triangles += item.count || 0; }, frame);
    }
    assert.ok(triangles > 0, key + ' must render geometry');
  }
});
