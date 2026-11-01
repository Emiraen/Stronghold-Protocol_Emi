"""Export the original generic start/end tile effects used by RO2 scenes."""
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
if sys.version_info.minor >= 14:
    sys.path.insert(1, str(ROOT / '.tmp-mod-analysis-20261025/pipe-render-hotfix-20261025/pydeps'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
# UnityPy SpriteHelper supports a pure-Pillow path. The machine's optional
# NumPy build crashes on import, so do not load it for this graphics export.
sys.modules['numpy'] = None
import aklz4  # noqa: E402,F401
import fx  # noqa: E402

CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
OUT = ROOT / 'public/assets/mizuki/native-gates'
PREFIX = '/assets/mizuki/native-gates/'
BUNDLE = 'battle/prefabs/effects/tile.ab'
KEYS = ['tile_start', 'tile_end', 'tile_flystart', 'tile_end_special']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def portable(value):
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {key: portable(child) for key, child in value.items()}
    if isinstance(value, (tuple, list)):
        return [portable(child) for child in value]
    return value


def write(name, value):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(portable(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf8')
    return path


def export():
    OUT.mkdir(parents=True, exist_ok=True)
    cabs = json.loads((ROOT / '.cache/mizuki-native-rules/client-cab-map.json').read_text(encoding='utf8'))
    env = fx.AssetEnv(CLIENT, cabs)
    roots = env.prefabs(BUNDLE)
    fx._init_worker(tuple(roots))
    warnings = []
    exporter = fx.Exporter(env, OUT, warnings.append)
    entries = {}
    todo = list(KEYS)
    while todo:
        key = todo.pop(0)
        if key in entries:
            continue
        if key not in roots:
            raise KeyError('Original gate effect not found: ' + key)
        entries[key] = exporter.prefab(key, roots[key], BUNDLE)
        todo.extend(ref for ref in entries[key].get('refs', []) if ref in roots and ref not in entries)
    fullres, texture_payloads = {}, {}
    for sf in list(env.sf.values()):
        for obj in sf.objects.values():
            if obj.type.name != 'Texture2D':
                continue
            key = exporter._tex_keys.get((id(sf), obj.path_id))
            if not key:
                continue
            texture = obj.read()
            image = texture.image
            relative = 'fx/tex/fullres/' + key + '.png'
            path = OUT / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            image.save(path, format='PNG')
            record = {'path': PREFIX + relative, 'kind': 'NativeGateTexture', 'w': texture.m_Width, 'h': texture.m_Height,
                'sha256': sha(path), 'bytes': path.stat().st_size, 'decodedPixelSha256': hashlib.sha256(image.tobytes()).hexdigest()}
            fullres[key] = record
            payload_relative = 'texture-data/' + key + '.bin'
            payload = OUT / payload_relative
            payload.parent.mkdir(parents=True, exist_ok=True)
            payload.write_bytes(texture.get_image_data())
            texture_payloads[key] = {'path': PREFIX + payload_relative, 'kind': 'NativeTexturePayload', 'sha256': sha(payload), 'bytes': payload.stat().st_size}
            exporter.textures[key].update({'fullres': relative.removeprefix('fx/'), 'fullresFile': relative.removeprefix('fx/'),
                'losslessFile': relative.removeprefix('fx/'), 'fullresSha256': record['sha256'], 'fullresBytes': record['bytes'],
                'sourceSerializedFile': sf.name, 'sourcePathId': str(obj.path_id)})
    groups = {
        'fx/prefabs': {key: {'path': PREFIX + 'fx/' + entry['file'], 'kind': 'FxPrefab'} for key, entry in entries.items()},
        'fx/tex': {key: {'path': PREFIX + 'fx/' + entry['file'], 'kind': 'Texture2D', 'w': entry['w'], 'h': entry['h'],
            **({'fullres': PREFIX + 'fx/' + entry['fullres'], 'fullresSha256': entry['fullresSha256'], 'fullresBytes': entry['fullresBytes']} if entry.get('fullres') else {}),
            **({'half': PREFIX + 'fx/' + entry['half']} if entry.get('half') else {})} for key, entry in exporter.textures.items()},
        'fx/mesh': {key: {'path': PREFIX + 'fx/' + entry['file'], 'kind': 'FxMesh', 'verts': entry['verts']} for key, entry in exporter.meshes.items()},
        'fx/tex-fullres': fullres, 'fx/texture-payloads': texture_payloads,
    }
    raw = []
    for sf in env.load_rel(BUNDLE):
        folder = re.sub(r'[^A-Za-z0-9_.-]', '_', sf.name)
        for obj in sf.objects.values():
            relative = 'raw/' + folder + '/' + str(obj.path_id) + '.' + obj.type.name + '.bin'
            path = OUT / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            blob = obj.get_raw_data()
            path.write_bytes(blob)
            raw.append({'serializedFile': sf.name, 'pathId': str(obj.path_id), 'type': obj.type.name,
                'file': relative, 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
    summaries = {key: {field: entry[field] for field in ('file', 'bundle', 'nodes', 'particleSystems', 'liveParticles', 'duration', 'looping', 'refs', 'spawn', 'follow') if field in entry} for key, entry in entries.items()}
    write('fx/index.json', {'format': 'fx-index', 'version': fx.INDEX_VERSION, 'set': 'mizuki-native-gates',
        'source': {'root': CLIENT.name, 'client': fx.client_version(CLIENT)},
        'units': {}, 'projectiles': {}, 'skills': {}, 'skins': {}, 'generic': {'keys': list(entries)}, 'prefabs': summaries})
    write('fx/textures.json', {'format': 'fx-textures', 'version': fx.FORMAT_VERSION, 'textures': exporter.textures})
    groups['fx'] = {'index': {'path': PREFIX + 'fx/index.json', 'kind': 'FxIndex'},
        'textures': {'path': PREFIX + 'fx/textures.json', 'kind': 'FxTextures'}}
    for group in groups.values():
        for entry in group.values():
            path = ROOT / 'public' / entry['path'].lstrip('/')
            entry.update({'sha256': sha(path), 'bytes': path.stat().st_size})
            if entry.get('half'):
                path = ROOT / 'public' / entry['half'].lstrip('/')
                entry.update({'halfSha256': sha(path), 'halfBytes': path.stat().st_size})
    map_manifest = json.loads((ROOT / 'public/assets/mizuki/native-maps/manifest.json').read_text(encoding='utf8'))
    scenes = {}
    usage = Counter()
    for name, scene_entry in map_manifest['scenes'].items():
        scene = json.loads((ROOT / 'public/assets/mizuki/native-maps' / scene_entry['file']).read_text(encoding='utf8'))
        level = json.loads((ROOT / 'data/mizuki/levels' / (name + '.json')).read_text(encoding='utf8'))
        map_data = level['mapData']
        gates = []
        for root in scene['roots']:
            prefab = json.loads((ROOT / 'public/assets/mizuki/native-maps/fx' / root['file']).read_text(encoding='utf8'))
            for node in prefab['nodes']:
                for behaviour in node.get('behaviours', []):
                    fields = behaviour.get('fields', {})
                    if behaviour.get('namespace') != 'Torappu.Battle' or behaviour.get('class') != 'Tile' or fields.get('_effect') not in entries:
                        continue
                    ancestry = []
                    current = node
                    while current is not None:
                        ancestry.append({key: current[key] for key in ['id', 'name', 'pos', 'rot', 'scale', 'active'] if key in current})
                        parent = current.get('parent')
                        current = prefab['nodes'][parent] if isinstance(parent, int) and parent >= 0 else None
                    gate = {'rootKey': root['key'], 'rootFile': root['file'], 'node': node['id'], 'name': node['name'],
                        'effect': fields['_effect'], 'tileKey': fields.get('_tileKey'), 'height': fields.get('_height'),
                        'locateHeightOffset': fields.get('_locateHeightOffset'), 'data': fields.get('_data'), 'ancestry': ancestry}
                    match = re.fullmatch(r'\((\d+),(\d+)\)#.*', node['name'])
                    if match:
                        gate['sceneRow'] = int(match.group(1))
                        gate['sceneCol'] = int(match.group(2))
                        gate['gridRow'] = len(map_data['map']) - 1 - gate['sceneRow']
                        gate['gridCol'] = gate['sceneCol']
                        gate['levelTileIndex'] = map_data['map'][gate['gridRow']][gate['gridCol']]
                        if map_data['tiles'][gate['levelTileIndex']]['tileKey'] != gate['tileKey']:
                            raise ValueError('Original scene/level tile mismatch: ' + name + '/' + node['name'])
                    gates.append(gate)
                    usage[fields['_effect']] += 1
        scenes[name] = {'file': scene_entry['file'], 'gates': gates}
    write('placements.json', {'format': 'mizuki-native-gate-placements', 'version': 1,
        'notice': 'Exact original scene Tile effect references and transform ancestry. Scene row/col are original scene coordinates, not browser grid coordinates. Gates are tile effects, not inferred enemy spawn points.',
        'stages': map_manifest['stages'], 'scenes': scenes})
    groups['gates'] = {'placements': {'path': PREFIX + 'placements.json', 'kind': 'NativeGatePlacements',
        'sha256': sha(OUT / 'placements.json'), 'bytes': (OUT / 'placements.json').stat().st_size}}
    sources = {str(Path(path).relative_to(CLIENT)).replace('\\', '/'): sha(Path(path)) for path in env.loaded if Path(path).is_file()}
    manifest = {'format': 'fx-manifest', 'version': 1, 'set': 'mizuki-native-gates', 'source': 'local-client',
        'notice': 'Original Unity start/end tile effects: prefab transforms, particles, mesh, materials, clips and textures, plus untouched serialized tile bundle records. Browser support does not imply exact Unity shader fidelity.',
        'client': fx.client_version(CLIENT), 'sourceBundlesSha256': sources, 'prefabs': summaries, 'groups': groups,
        'raw': raw, 'usage': dict(usage), 'warnings': warnings}
    write('manifest.json', manifest)
    print(json.dumps({'ok': True, 'prefabs': list(entries), 'textures': len(exporter.textures), 'meshes': len(exporter.meshes),
        'raw': len(raw), 'scenes': len(scenes), 'stageIds': len(map_manifest['stages']), 'usage': dict(usage), 'warnings': warnings}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    export()
