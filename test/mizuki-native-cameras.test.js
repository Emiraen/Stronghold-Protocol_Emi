import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = new URL('../public/assets/mizuki/native-cameras/', import.meta.url);
const maps = new URL('../public/assets/mizuki/native-maps/', import.meta.url);
const read = url => JSON.parse(readFileSync(url, 'utf8'));
const camera = read(new URL('cameras.json', base));
const manifest = read(new URL('manifest.json', maps));
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, String(actual) + ' != ' + expected);
const transform = (matrix, point) => matrix.slice(0, 3).map(row => row[0]*point[0] + row[1]*point[1] + row[2]*point[2] + row[3]);

test('original camera export covers every native RO2 scene and stage', () => {
  assert.equal(Object.keys(camera.scenes).length, 60);
  assert.equal(Object.keys(camera.stages).length, 97);
  assert.deepEqual(camera.stages, manifest.stages);
  assert.deepEqual(Object.keys(camera.scenes).sort(), Object.keys(manifest.scenes).sort());
  for (const [sceneId, record] of Object.entries(camera.scenes)) {
    const scene = read(new URL(manifest.scenes[sceneId].file, maps));
    const descriptor = read(new URL(record.source.rootFile, maps));
    const graphic = descriptor.nodes.find(node => node.id === record.source.mapGraphicNode);
    const store = graphic.behaviours.find(item => item.class === 'StoreValueComponent').fields;
    const focus = store._objects.find(item => item.key === 'camera_focus').value;
    const offset = store._values.find(item => item.key === 'camera_offset');
    assert.deepEqual(record.source.sourceBundlesSha256, scene.sourceBundlesSha256);
    assert.deepEqual(record.storeValueCameraFocus, focus);
    assert.deepEqual(record.storeValueCameraOffset, offset);
    assert.equal(record.positionSource, 'focus.position + cameraOffset');
    assert.deepEqual(record.offsetInSourceWorldAxes, offset.value.split(',').map(Number));
    for (let axis = 0; axis < 3; axis++) close(record.sourceWorldPosition[axis], record.focusWorldPosition[axis] + record.offsetInSourceWorldAxes[axis]);
    transform(record.boardFromSourceWorld, record.sourceWorldPosition).forEach((value, axis) => close(record.boardPosition[axis], value));
    const tilePos = transform(record.tilesFromSourceWorld, record.sourceWorldPosition);
    record.boardPosition.forEach((value, axis) => close(value, tilePos[axis] * (axis === 2 ? -1 : 1)));
  }
});

test('camera lens and quaternion retain the original common prefab values', () => {
  const originals = camera.prefabSource.records;
  const rawCamera = originals.find(record => record.type === 'Camera').native;
  const rawTransform = originals.find(record => record.type === 'Transform').native;
  const rawController = originals.find(record => record.type === 'MonoBehaviour').native;
  assert.deepEqual(camera.camera.rotation, ['x', 'y', 'z', 'w'].map(axis => rawTransform.m_LocalRotation[axis]));
  assert.equal(camera.camera.verticalFov, rawCamera['field of view']);
  assert.equal(camera.camera.near, rawCamera['near clip plane']);
  assert.equal(camera.camera.far, rawCamera['far clip plane']);
  assert.equal(camera.camera.verticalFov, 40);
  assert.equal(camera.camera.orthographic, false);
  assert.deepEqual(camera.camera.cullingMask, rawCamera.m_CullingMask);
  assert.equal(rawCamera.m_CullingMask.m_Bits & 1, 1);
  for (const [name, value] of Object.entries(camera.camera.aspectAdaptation)) assert.deepEqual(value, rawController[name]);
  close(camera.camera.sourceForward[1], 0.5);
  close(camera.camera.sourceForward[2], Math.sqrt(3)/2);
  close(camera.camera.sourceUp[1], Math.sqrt(3)/2);
  close(camera.camera.sourceUp[2], -0.5);
  for (const original of originals) {
    const bytes = readFileSync(new URL(original.file, base));
    assert.equal(bytes.length, original.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), original.sha256);
  }
});

test('camera presets retain source DLL evidence and the cave scene uses its custom position', () => {
  assert.deepEqual(camera.presets.map(item => item.name), ['DEFAULT', 'MAX', 'MEDIUM', 'ULTIMATE', 'UP']);
  assert.deepEqual(camera.presets.map(item => item.value), [0, 1, 2, 3, 4]);
  assert.equal(camera.presetSource.method, 'Torappu.Battle.Consts::.cctor');
  assert.equal(camera.presetSource.sha256.length, 64);
  assert.equal(camera.presetSource.stores.reduce((count, store) => count + store.floatCount, 0), 15);
  const cave = camera.scenes[camera.stages.ro2_n_4_5];
  assert.equal(cave.cameraViewName, 'ULTIMATE');
  assert.deepEqual(cave.sourceWorldPosition, [0, -6.1, -9.76]);
  close(cave.boardPosition[0], 4.5);
  close(cave.boardPosition[1], -2.6);
  close(cave.boardPosition[2], 9.76);
});
