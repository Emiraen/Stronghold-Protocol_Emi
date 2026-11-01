import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = new URL('../public/assets/mizuki/native-maps/', import.meta.url);
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = read(new URL('manifest.json', base));
const meshCache = new Map();
const publicFile = (path) => new URL('../public/' + path.replace(/^\//, ''), import.meta.url);
const verify = (record) => {
  const bytes = readFileSync(publicFile(record.path));
  assert.equal(bytes.length, record.bytes, record.path);
  assert.equal(sha(bytes), record.sha256, record.path);
  return bytes;
};

test('every original scene node and renderer has a verifiable native identity and complete static batch/lightmap fields', () => {
  assert.equal(manifest.nativeMetadataVersion, 1);
  assert.equal(Object.keys(manifest.scenes).length, 60);
  let nodeCount = 0, rendererCount = 0, staticBatchCount = 0;
  for (const [sceneId, entry] of Object.entries(manifest.scenes)) {
    const scene = read(new URL(entry.file, base));
    const raw = new Map(scene.raw.map((record) => [record.serializedFile + ':' + record.pathId, record]));
    const sceneBytes = readFileSync(new URL(entry.file, base));
    assert.equal(sha(sceneBytes), entry.sha256, sceneId);
    let nodes = 0, renderers = 0;
    for (const root of scene.roots) {
      const rootBytes = readFileSync(new URL('fx/' + root.file, base));
      assert.equal(sha(rootBytes), root.sha256, root.key);
      assert.equal(sha(rootBytes), manifest.groups['scene/roots'][root.key].sha256, root.key);
      const prefab = JSON.parse(rootBytes.toString('utf8'));
      for (const node of prefab.nodes) {
        nodes++;
        const gameObject = raw.get(node.sourceSerializedFile + ':' + node.sourceGameObjectPathId);
        assert.equal(gameObject?.type, 'GameObject', sceneId + '/' + node.name);
        assert.equal(node.sourceGameObject.rawSha256, gameObject.sha256);
        const transform = raw.get(node.sourceSerializedFile + ':' + node.sourceTransformPathId);
        assert.ok(['Transform', 'RectTransform'].includes(transform?.type), sceneId + '/' + node.name);
        assert.equal(node.nativeTransform.m_GameObject.m_PathID, node.sourceGameObjectPathId);
        for (const field of ['meshRenderer', 'skinnedMeshRenderer', 'particleSystemRenderer', 'trailRenderer', 'lineRenderer', 'spriteRenderer']) {
          const renderer = node[field];
          if (!renderer) continue;
          renderers++;
          const original = raw.get(renderer.sourceSerializedFile + ':' + renderer.sourceRendererPathId);
          assert.ok(original, sceneId + '/' + node.name + '/' + field);
          assert.equal(renderer.source.rawSha256, original.sha256);
          assert.equal(renderer.native.m_GameObject.m_PathID, node.sourceGameObjectPathId);
          assert.equal(typeof renderer.native.m_LightmapIndex, 'number');
          assert.equal(typeof renderer.native.m_LightmapTilingOffset.x, 'number');
          if (renderer.native.m_LightmapIndex < 65534) assert.ok(scene.lightmaps[renderer.native.m_LightmapIndex], sceneId);
          const batch = renderer.native.m_StaticBatchInfo;
          if (!batch?.subMeshCount || !node.meshFilter || node.meshFilter.startsWith('builtin:')) continue;
          staticBatchCount++;
          if (!meshCache.has(node.meshFilter)) meshCache.set(node.meshFilter, read(publicFile(manifest.groups['scene/meshes'][node.meshFilter].path)));
          const mesh = meshCache.get(node.meshFilter);
          assert.ok(batch.firstSubMesh >= 0 && batch.firstSubMesh + batch.subMeshCount <= mesh.submeshes.length, sceneId + '/' + node.name);
        }
      }
    }
    assert.equal(nodes, entry.sourceNodes, sceneId);
    assert.equal(renderers, entry.sourceRenderers, sceneId);
    nodeCount += nodes;
    rendererCount += renderers;
  }
  assert.equal(nodeCount, 19213);
  assert.equal(rendererCount, 10174);
  assert.ok(staticBatchCount > 5000);
});

test('all original lightmap slots resolve exact PPtrs to full-resolution lossless pixels and original compressed mip payloads', () => {
  let slots = 0;
  const checked = new Set();
  for (const [sceneId, entry] of Object.entries(manifest.scenes)) {
    const scene = read(new URL(entry.file, base));
    const raw = new Map(scene.raw.map((record) => [record.serializedFile + ':' + record.pathId, record]));
    const settings = scene.lighting.find((record) => record.type === 'LightmapSettings');
    assert.equal(scene.lightmapsMode, settings.tree.m_LightmapsMode, sceneId);
    assert.equal(scene.lightmaps.length, settings.tree.m_Lightmaps.length, sceneId);
    for (const slot of scene.lightmaps) {
      slots++;
      assert.deepEqual(slot.native, settings.tree.m_Lightmaps[slot.index], sceneId);
      for (const [nativeField, keyField] of [['m_Lightmap', 'textureKey'], ['m_DirLightmap', 'directionalTextureKey'], ['m_ShadowMask', 'shadowMaskKey']]) {
        const evidence = slot.textures[nativeField];
        assert.deepEqual(evidence.pptr, slot.native[nativeField], sceneId);
        if (!slot[keyField]) {
          assert.equal(evidence.pptr.m_PathID, '0', sceneId);
          continue;
        }
        assert.equal(evidence.resolved.pathId, evidence.pptr.m_PathID, sceneId);
        const original = raw.get(evidence.resolved.serializedFile + ':' + evidence.resolved.pathId);
        assert.equal(original?.type, 'Texture2D', sceneId);
        assert.equal(original.sha256, evidence.resolved.rawSha256, sceneId);
        assert.equal(evidence.textureKey, slot[keyField], sceneId);
        const key = evidence.textureKey;
        assert.deepEqual(evidence.fullres, manifest.groups['scene/lightmap-textures'][key]);
        assert.deepEqual(evidence.originalPayload, manifest.groups['scene/texture-payloads'][key]);
        if (checked.has(key)) continue;
        checked.add(key);
        const png = verify(evidence.fullres);
        assert.equal(png.readUInt32BE(16), evidence.width, key);
        assert.equal(png.readUInt32BE(20), evidence.height, key);
        assert.equal(evidence.fullres.textureFormat, evidence.textureFormat, key);
        assert.equal(evidence.fullres.colorSpace, evidence.colorSpace, key);
        assert.ok(verify(evidence.originalPayload).length > 0, key);
      }
    }
  }
  assert.equal(slots, 61);
  assert.equal(checked.size, 122);
});

test('every original material and lightmap texture has an original-size PNG and hashed native mip payload', () => {
  const originals = manifest.groups['scene/textures'];
  const fullres = manifest.groups['scene/texture-fullres'];
  const sources = read(new URL('texture-sources.json', base));
  assert.equal(Object.keys(originals).length, 204);
  assert.deepEqual(Object.keys(fullres).sort(), Object.keys(originals).sort());
  assert.deepEqual(manifest.losslessTextureCoverage.missing, []);
  assert.equal(manifest.losslessTextureCoverage.fullresKeys, 204);
  assert.equal(manifest.losslessTextureCoverage.materialOnlyKeys, 82);
  for (const [key, original] of Object.entries(originals)) {
    const entry = fullres[key];
    assert.ok(entry.path.endsWith('.png'), key);
    assert.ok(!entry.path.includes('/half/'), key);
    assert.equal(entry.w, original.w, key);
    assert.equal(entry.h, original.h, key);
    const png = verify(entry);
    assert.equal(png.readUInt32BE(16), original.w, key);
    assert.equal(png.readUInt32BE(20), original.h, key);
    assert.ok(verify(manifest.groups['scene/texture-payloads'][key]).length > 0, key);
    assert.ok(sources.textures[key]?.length > 0, key);
    if (manifest.groups['scene/texture-sources'][key]) verify(manifest.groups['scene/texture-sources'][key]);
  }
});
