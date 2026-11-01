import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const base = new URL('../public/assets/mizuki/native-maps/', import.meta.url);
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const themes = read(new URL('themes.json', base)), manifest = read(new URL('manifest.json', base));

test('all 97 water roguelike stage themes match original 60-scene MapGraphic settings and hashed raw serialized strings', () => {
  assert.equal(themes.source, 'local-client'); assert.equal(themes.counts.stages, 97); assert.equal(themes.counts.scenes, 60);
  assert.deepEqual(Object.keys(themes.stages).sort(), Object.keys(manifest.stages).sort());
  assert.deepEqual(Object.keys(themes.scenes).sort(), Object.keys(manifest.scenes).sort());
  for (const [sceneId, evidence] of Object.entries(themes.scenes)) {
    const bytes = readFileSync(new URL(evidence.root.file, base)); assert.equal(sha256(bytes), evidence.root.sha256, sceneId);
    const root = JSON.parse(bytes.toString('utf8')), node = root.nodes.find((entry) => entry.id === evidence.root.nodeId);
    const component = node.behaviours.find((entry) => entry.class === 'MapGraphic');
    assert.equal(component.fields._mapSettings.theme, evidence.theme, sceneId);
    const raw = readFileSync(new URL(evidence.raw.file, base)), offset = evidence.raw.themeUtf8Offset, length = evidence.raw.themeByteLength;
    assert.equal(sha256(raw), evidence.raw.sha256, sceneId); assert.equal(raw.readUInt32LE(offset - 4), length, sceneId);
    assert.equal(raw.subarray(offset, offset + length).toString('utf8'), evidence.theme, sceneId);
  }
  for (const [stageId, entry] of Object.entries(themes.stages)) {
    assert.equal(entry.scene, manifest.stages[stageId], stageId);
    assert.equal(entry.theme, themes.scenes[entry.scene].theme, stageId);
    assert.equal(entry.dsbellSkin, themes.scenes[entry.scene].dsbellSkin, stageId);
  }
});

test('DSbell theme-specific skin selection comes only from the original MapDependentTrap prefab', () => {
  const source = new URL('../public/assets/mizuki/native-facilities/fx/prefabs/trap_038_dsbell.json', import.meta.url);
  assert.equal(sha256(readFileSync(source)), themes.skinSelection.sha256);
  const trap = read(source), component = trap.nodes.flatMap((node) => node.behaviours || []).find((entry) => entry.class === 'MapDependentTrap');
  assert.equal(themes.skinSelection.defaultSkin, component.fields._defaultSkin);
  assert.deepEqual(themes.skinSelection.overrides, component.fields._skins);
  for (const entry of Object.values(themes.stages)) assert.equal(entry.dsbellSkin,
    component.fields._skins.find((skin) => skin.theme === entry.theme)?.skinKey || component.fields._defaultSkin);
  assert.equal(themes.stages.ro2_n_1_1.theme, 'SALVIENTO'); assert.equal(themes.stages.ro2_n_1_1.dsbellSkin, 'skin_dsbell_default');
  assert.equal(themes.stages.ro2_n_3_1.theme, 'CAVE'); assert.equal(themes.stages.ro2_n_3_1.dsbellSkin, 'skin_dsbell_caven');
  assert.equal(themes.stages.ro2_n_5_1.theme, 'DEEPSEA'); assert.equal(themes.stages.ro2_n_5_1.dsbellSkin, 'skin_dsbell_default');
});
