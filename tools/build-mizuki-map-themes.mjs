// Extract exact original map themes from already exported local-client scenes.
// No stage-name heuristics, generated theme assignments, or shared-mode edits.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = new URL('../public/assets/mizuki/native-maps/', import.meta.url);
const source = new URL('../public/assets/mizuki/native-facilities/fx/prefabs/trap_038_dsbell.json', import.meta.url);
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const manifest = read(new URL('manifest.json', base)), trap = read(source);
const skin = trap.nodes.flatMap((node) => node.behaviours || []).find((behaviour) => behaviour.class === 'MapDependentTrap');
if (!skin || typeof skin.fields._defaultSkin !== 'string' || !Array.isArray(skin.fields._skins)) throw new Error('Missing original DSbell skin selector');
const selection = { defaultSkin: skin.fields._defaultSkin, overrides: skin.fields._skins };
const skinFor = (theme) => selection.overrides.find((entry) => entry.theme === theme)?.skinKey || selection.defaultSkin;
const scenes = {}, stages = {}, sceneCounts = {}, stageCounts = {};

for (const [sceneId, entry] of Object.entries(manifest.scenes)) {
  const scene = read(new URL(entry.file, base)), candidates = [];
  for (const root of scene.roots) {
    const file = `fx/${root.file}`, prefabBytes = readFileSync(new URL(file, base));
    const prefab = JSON.parse(prefabBytes.toString('utf8'));
    for (const node of prefab.nodes || []) for (const behaviour of node.behaviours || []) {
      if (behaviour.class !== 'MapGraphic') continue;
      const theme = behaviour.fields?._mapSettings?.theme;
      if (typeof theme !== 'string' || !theme.length) throw new Error('Missing original MapGraphic theme: ' + sceneId);
      candidates.push({ theme, root: { file, key: root.key, nodeId: node.id, nodeName: node.name,
        component: 'Torappu.Battle.MapGraphic', field: '_mapSettings.theme', sha256: sha256(prefabBytes) } });
    }
  }
  if (candidates.length !== 1) throw new Error('Ambiguous MapGraphic theme: ' + sceneId);
  const [{ theme, root }] = candidates, encoded = Buffer.from(theme, 'utf8');
  const raw = scene.raw.filter((object) => object.type === 'MonoBehaviour').flatMap((object) => {
    const bytes = readFileSync(new URL(object.file, base)), offset = bytes.indexOf(encoded);
    if (offset < 4 || bytes.readUInt32LE(offset - 4) !== encoded.length) return [];
    if (sha256(bytes) !== object.sha256) throw new Error('Raw scene hash mismatch: ' + object.file);
    return [{ file: object.file, pathId: object.pathId, serializedFile: object.serializedFile, sha256: object.sha256,
      themeUtf8Offset: offset, themeByteLength: encoded.length }];
  });
  if (raw.length !== 1) throw new Error('Ambiguous raw MapGraphic theme bytes: ' + sceneId);
  scenes[sceneId] = { theme, dsbellSkin: skinFor(theme), root, raw: raw[0],
    sceneFile: entry.file, sceneSha256: entry.sha256, sourceBundlesSha256: entry.sourceBundlesSha256 };
  sceneCounts[theme] = (sceneCounts[theme] || 0) + 1;
}
for (const [stageId, scene] of Object.entries(manifest.stages)) {
  if (!scenes[scene]) throw new Error('Missing original scene for stage: ' + stageId);
  const { theme, dsbellSkin } = scenes[scene]; stages[stageId] = { scene, theme, dsbellSkin };
  stageCounts[theme] = (stageCounts[theme] || 0) + 1;
}
const assembly = 'C:/Program Files/Hypergryph Launcher/games/Arknights Game/GameAssembly.dll';
const output = { version: 1, source: 'local-client',
  field: 'Torappu.Battle.MapGraphic._mapSettings.theme',
  notice: 'Themes are copied from original serialized MapGraphic settings, including elite scene aliases. They are not inferred from stage IDs, stage names, floor numbers, textures, or water effects.',
  nativeRuntime: { assembly: 'GameAssembly.dll', assemblySha256: sha256(readFileSync(assembly)),
    mapThemeGetter: { method: 'Torappu.Battle.Map::get_mapTheme', address: '0x18084d260',
      mapSettingsCall: '0x18084d302 -> Torappu.Battle.MapGraphic::get_mapSettings', themeLoad: '0x18084d30c: mov rax, qword ptr [rax + 0x20]' },
    trapSkinSelector: { method: 'Torappu.Battle.MapDependentTrap::_TryLoadSkin', address: '0x180a4f9b0',
      mapThemeCall: '0x180a4faf7 -> Torappu.Battle.Map::get_mapTheme',
      comparison: '0x180a4fb38..0x180a4fb50: compare each SkinEntry.theme with mapTheme',
      matchSkinLoad: '0x180a4fb81: mov r14, qword ptr [rcx + rax*8 + 0x28]' } },
  skinSelection: { ...selection, source: '/assets/mizuki/native-facilities/fx/prefabs/trap_038_dsbell.json', sha256: sha256(readFileSync(source)) },
  counts: { scenes: Object.keys(scenes).length, stages: Object.keys(stages).length, sceneThemes: sceneCounts, stageThemes: stageCounts },
  stages, scenes };
const destination = new URL('themes.json', base); writeFileSync(destination, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ file: destination.pathname, ...output.counts }));
