"""Export original RO2 scene geometry; this is not a replacement shader renderer."""
import argparse
from collections import Counter
import hashlib
import json
import math
import re
from pathlib import Path
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
import aklz4  # noqa: E402,F401
import fx  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument('--only', action='append', default=[])
args = parser.parse_args()
client = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
output = ROOT / 'public/assets/mizuki/native-maps'
output.mkdir(parents=True, exist_ok=True)
index = json.loads((ROOT / 'data/mizuki/levels/index.json').read_text(encoding='utf8'))
names = sorted({Path(v['file']).stem for v in index['stagesById'].values()})
if args.only:
    unknown = set(args.only) - set(names)
    if unknown:
        raise ValueError(f'Unknown original scene: {sorted(unknown)}')
    names = [name for name in names if name in args.only]
cab_cache = ROOT / '.cache/mizuki-native-rules/client-cab-map.json'
cabs = json.loads(cab_cache.read_text(encoding='utf8')) if cab_cache.exists() else fx.scan_cabs(client, dirs=('',))
fx._init_worker([])
textures, meshes, scenes, warnings, groups = {}, {}, {}, [], {}
prefix = '/assets/mizuki/native-maps/'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def portable(value, field=''):
    if isinstance(value, float) and not math.isfinite(value):
        return 'Infinity' if value > 0 else '-Infinity' if value < 0 else 'NaN'
    if isinstance(value, int) and (field == 'm_PathID' or abs(value) > 9007199254740991):
        return str(value)
    if isinstance(value, dict):
        return {k: portable(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [portable(v) for v in value]
    return value

def write(relative, value):
    path = output / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(portable(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False) + chr(10), encoding='utf8')
    return path

for number, name in enumerate(names, 1):
    bundle = f'scenes/obt/roguelike/ro2/{name}/{name}.ab'
    if not (client / bundle).is_file():
        raise FileNotFoundError(bundle)
    env = fx.AssetEnv(client, cabs)
    sfiles = env.load_rel(bundle)
    local_warnings = []
    exporter = fx.Exporter(env, output, local_warnings.append)
    roots, lighting, types_count = [], [], Counter()
    for sf in sfiles:
        for obj in list(sf.objects.values()):
            kind = obj.type.name
            types_count[kind] += 1
            if kind in ('Transform', 'RectTransform'):
                tree = env.tt(obj)
                if not tree.get('m_Father', {}).get('m_PathID'):
                    _, go = env.resolve(sf, tree.get('m_GameObject'))
                    if go is not None:
                        key = name + '__' + str(go.path_id)
                        record = exporter.prefab(key, go, bundle)
                        record.update({'key': key, 'name': env.tt(go).get('m_Name', ''), 'pathId': str(go.path_id)})
                        roots.append(record)
            elif kind in ('RenderSettings', 'LightmapSettings', 'LightingSettings', 'Light', 'ReflectionProbe', 'Camera', 'NavMeshSettings'):
                lighting.append({'type': kind, 'pathId': str(obj.path_id), 'tree': env.tt(obj)})
    light_bundle = bundle[:-3] + '/lightingdata.ab'
    sources = {bundle: sha(client / bundle)}
    if (client / light_bundle).exists():
        sources[light_bundle] = sha(client / light_bundle)
        for sf in env.load_rel(light_bundle):
            for obj in list(sf.objects.values()):
                if obj.type.name == 'Texture2D':
                    exporter.texture(sf, obj)
                elif obj.type.name == 'LightingDataAsset':
                    lighting.append({'type': obj.type.name, 'pathId': str(obj.path_id), 'tree': env.tt(obj)})
    # Preserve every native serialized record in the selected scene bundles, not
    # only fields currently interpreted by the browser renderer.
    raw_records = []
    raw_dir = output / 'raw' / name
    raw_dir.mkdir(parents=True, exist_ok=True)
    for sf in [sf for path in env.loaded for sf in env.loaded[path] if path in [str(client / bundle), str(client / light_bundle)]]:
        source_file = re.sub(r'[^A-Za-z0-9_.-]', '_', sf.name)
        (raw_dir / source_file).mkdir(parents=True, exist_ok=True)
        for obj in sf.objects.values():
            blob = obj.get_raw_data()
            relative = 'raw/' + name + '/' + source_file + '/' + str(obj.path_id) + '.' + obj.type.name + '.bin'
            (output / relative).write_bytes(blob)
            raw_records.append({'serializedFile': sf.name, 'pathId': str(obj.path_id), 'type': obj.type.name, 'file': relative,
                'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
    textures.update(exporter.textures); meshes.update(exporter.meshes)
    scene = {'name': name, 'sourceBundlesSha256': sources, 'originalTypes': dict(types_count),
        'roots': roots, 'lighting': lighting, 'raw': raw_records, 'warnings': local_warnings}
    write('scenes/' + name + '.json', scene)
    scenes[name] = {'file': 'scenes/' + name + '.json', 'roots': len(roots), 'rawObjects': len(raw_records),
        'textures': len(exporter.textures), 'meshes': len(exporter.meshes), 'sourceBundlesSha256': sources}
    warnings.extend({'scene': name, 'message': warning} for warning in local_warnings)
    for root in roots:
        groups.setdefault('scene/roots', {})[root['key']] = {'path': prefix + 'fx/' + root['file'], 'kind': 'NativeSceneGraph'}
    print(json.dumps({'scene': name, 'index': number, 'total': len(names), 'roots': len(roots),
        'rawObjects': len(raw_records), 'textures': len(exporter.textures), 'meshes': len(exporter.meshes), 'warnings': len(local_warnings)}), flush=True)

groups['scene/data'] = {name: {'path': prefix + entry['file'], 'kind': 'NativeMapScene'} for name, entry in scenes.items()}
groups['scene/textures'] = {key: {'path': prefix + 'fx/' + v['file'], 'kind': 'Texture2D', 'w': v['w'], 'h': v['h'],
    **({'half': prefix + 'fx/' + v['half']} if v.get('half') else {})} for key, v in textures.items()}
groups['scene/meshes'] = {key: {'path': prefix + 'fx/' + v['file'], 'kind': 'NativeMesh', 'verts': v['verts']} for key, v in meshes.items()}
for group in groups.values():
    for value in group.values():
        path = ROOT / 'public' / value['path'].lstrip('/')
        value.update({'bytes': path.stat().st_size, 'sha256': sha(path)})
        if value.get('half'):
            half = ROOT / 'public' / value['half'].lstrip('/')
            value.update({'halfBytes': half.stat().st_size, 'halfSha256': sha(half)})
for name, record in scenes.items():
    record.update({'sha256': groups['scene/data'][name]['sha256'], 'bytes': groups['scene/data'][name]['bytes']})
write('manifest.json', {'version': 1, 'set': 'mizuki-native-map-scenes', 'source': 'local-client',
    'notice': 'Original scene graphs, transforms, geometry, materials, lighting records and raw serialized objects. Extraction does not claim baked Unity shader/light fidelity in the browser.',
    'stages': {key: Path(v['file']).stem for key, v in index['stagesById'].items() if Path(v['file']).stem in scenes},
    'scenes': scenes, 'groups': groups, 'warnings': warnings})
print(json.dumps({'ok': True, 'scenes': len(scenes), 'stageRecords': sum(Path(v['file']).stem in scenes for v in index['stagesById'].values()),
    'textures': len(textures), 'meshes': len(meshes), 'warnings': len(warnings)}), flush=True)
