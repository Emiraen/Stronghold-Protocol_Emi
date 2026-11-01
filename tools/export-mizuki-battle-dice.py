"""Add native battle dice to the existing Mizuki facility resource library."""
import importlib.util
import json
from pathlib import Path

ROOT = Path.cwd()
spec = importlib.util.spec_from_file_location('mizuki_facilities', ROOT / 'tools/export-mizuki-native-facilities.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
keys = ['trap_067_dice', 'trap_088_dice2', 'trap_089_dice3']
cabs = json.loads((ROOT / '.cache/mizuki-native-rules/client-cab-map.json').read_text(encoding='utf8'))
env = native.NativeAssetEnv(native.CLIENT, cabs)
roots = env.prefabs(native.TOKEN_BUNDLE)
effect_keys = ['rogue_active_01', 'rogue_trai_01', 'rogue_buff_01', 'rogue_buff_02', 'rogue_buff_03', 'rogue_buff_04']
effect_bundle = 'battle/prefabs/effects/rogue.ab'
effects = env.prefabs(effect_bundle)
native.fx._init_worker(keys + effect_keys)
warnings = []
exporter = native.fx.Exporter(env, native.DEST, warnings.append)
read = lambda name: json.loads((native.DEST / name).read_text(encoding='utf8'))
manifest, index, textures, fxmanifest = [read(name) for name in ['manifest.json', 'fx/index.json', 'fx/textures.json', 'fx/manifest.json']]
records = {}
for key in effect_keys:
    entry = exporter.prefab(key, effects[key], effect_bundle)
    index['prefabs'][key] = {name: entry[name] for name in ['file', 'bundle', 'nodes', 'particleSystems',
                           'liveParticles', 'duration', 'looping', 'refs', 'spawn', 'follow'] if name in entry}
    if key not in index['generic']['keys']:
        index['generic']['keys'].append(key)
    fxmanifest['groups']['fx/prefabs'][key] = {'path': native.PREFIX + entry['file'], 'kind': 'FxPrefab'}
    print(json.dumps({'effect': key, 'meshes': entry['meshes'], 'textures': entry['textures'],
                      'particleSystems': entry['particleSystems']}), flush=True)
for key in keys:
    root = roots[key]
    entry = exporter.prefab(key, root, native.TOKEN_BUNDLE)
    details = native.native_details(env, root)
    graphic = {'key': key, 'path': native.PREFIX + entry['file'], 'bundle': native.TOKEN_BUNDLE,
               'container': None, 'meshes': entry['meshes'], 'textures': entry['textures'], **details}
    facility = {'root': graphic, 'defaultSkin': None, 'themeSkins': {}, 'skins': {},
                'graphicPolicy': 'original-battle-effects', 'meshAvailable': bool(entry['meshes']),
                'effectKeys': effect_keys, 'resultEffects': effect_keys[2:]}
    if any('Spine' in name for name in details['scripts']):
        manifest['spines'][key] = native.export_spine(env, root, key, records)
        facility.update({'spineKey': key, 'spineAvailable': True, 'graphicPolicy': 'original-spine'})
    manifest['facilities'][key] = facility
    index['prefabs'][key] = {name: entry[name] for name in ['file', 'bundle', 'nodes', 'particleSystems',
                           'liveParticles', 'duration', 'looping', 'refs', 'spawn', 'follow'] if name in entry}
    if key not in index['generic']['keys']:
        index['generic']['keys'].append(key)
    fxmanifest['groups']['fx/prefabs'][key] = {'path': native.PREFIX + entry['file'], 'kind': 'FxPrefab'}
    print(json.dumps({'key': key, 'meshes': entry['meshes'], 'spine': bool(facility.get('spineKey'))}), flush=True)
for key, value in exporter.textures.items():
    textures['textures'][key] = value
    fxmanifest['groups']['fx/tex'][key] = {'path': native.PREFIX + value['file'], 'kind': 'Texture2D',
                                        'w': value['w'], 'h': value['h']}
    if value.get('half'):
        fxmanifest['groups']['fx/tex'][key]['half'] = native.PREFIX + value['half']
for key, value in exporter.meshes.items():
    fxmanifest['groups']['fx/mesh'][key] = {'path': native.PREFIX + value['file'], 'kind': 'FxMesh', 'verts': value['verts']}
fxmanifest['groups']['spines'].update(records)
for path in env.loaded:
    file = Path(path)
    if file.is_file():
        rel = file.relative_to(native.CLIENT).as_posix()
        manifest['bundlesSha256'][rel] = native.sha(file)
        index['source']['bundlesSha256'][rel] = native.sha(file)
for name, data in [('fx/index.json', index), ('fx/textures.json', textures), ('manifest.json', manifest)]:
    native.write(native.DEST / name, data)
for group in fxmanifest['groups'].values():
    for value in group.values():
        file = ROOT / 'public' / value['path'].lstrip('/')
        value.update({'bytes': file.stat().st_size, 'sha256': native.sha(file)})
        if value.get('half'):
            half = ROOT / 'public' / value['half'].lstrip('/')
            value.update({'halfBytes': half.stat().st_size, 'halfSha256': native.sha(half)})
fxmanifest['warnings'].extend(warnings)
native.write(native.DEST / 'fx/manifest.json', fxmanifest)
# The existing mode FX adapter consumes these original result prefabs.
mode_dir = ROOT / 'public/assets/mizuki/fx'
mode_manifest = json.loads((mode_dir / 'manifest.json').read_text(encoding='utf8'))
mode_index = json.loads((mode_dir / 'index.json').read_text(encoding='utf8'))
mode_textures = json.loads((mode_dir / 'textures.json').read_text(encoding='utf8'))
for key in effect_keys:
    mode_manifest['groups']['fx/prefabs'][key] = fxmanifest['groups']['fx/prefabs'][key]
    mode_index['prefabs'][key] = index['prefabs'][key]
    if key not in mode_index['generic']['keys']:mode_index['generic']['keys'].append(key)
for key, value in exporter.textures.items():
    mode_manifest['groups']['fx/tex'][key] = fxmanifest['groups']['fx/tex'][key]
    mode_textures['textures'][key] = value
for key in exporter.meshes:
    mode_manifest['groups']['fx/mesh'][key] = fxmanifest['groups']['fx/mesh'][key]
for name, value in [('index.json', mode_index), ('textures.json', mode_textures)]:
    native.write(mode_dir / name, value)
for key, name in [('index', 'index.json'), ('textures', 'textures.json')]:
    file = mode_dir / name
    mode_manifest['groups']['fx'][key].update({'bytes': file.stat().st_size, 'sha256': native.sha(file)})
native.write(mode_dir / 'manifest.json', mode_manifest)
library_path = ROOT / 'public/assets/mizuki/library/manifest.json'
library = json.loads(library_path.read_text(encoding='utf8'))
for item in ['rogue_2_dice_battle1', 'rogue_2_dice_battle2', 'rogue_2_dice_battle3']:
    library['groups']['items'][item] = {**library['groups']['ui']['DICE'], 'name': item, 'group': 'items'}
native.write(library_path, library)
print(json.dumps({'dice': keys, 'warnings': warnings}), flush=True)
