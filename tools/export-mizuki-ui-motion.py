"""Package original client UI motion without authoring new keyframes."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--source-exports', default='D:/Stronghold-Protocol_Emi-master.backup-before-annihilation-direct-20261025-003701/exports/is3-mizuki-20261027')
parser.add_argument('--output', default='public/assets/mizuki/native-ui-motion')
args = parser.parse_args()
source, output = Path(args.source_exports), Path(args.output)
output.mkdir(parents=True, exist_ok=True)
bundles, all_objects, cache = {}, {}, {}
for name in ['ui/rglktopic/rogue_2', 'ui/roguelike']:
    metadata = json.loads((source / 'assets' / name / 'metadata.json').read_text(encoding='utf8'))
    bundles[name] = {int(obj['path_id']): obj for obj in metadata['objects']}
    for path_id, obj in bundles[name].items():
        all_objects.setdefault(path_id, []).append((name, obj))

def read(bundle, obj):
    if obj is None:
        return {}
    key = (bundle, int(obj['path_id']))
    if key not in cache:
        relative = next((e['path'] for e in obj.get('exports', []) if e['format'] == 'typetree-json'), None)
        cache[key] = json.loads((source / relative).read_text(encoding='utf8')) if relative else {}
    return cache[key]

def resolve(bundle, pointer):
    path_id = pointer.get('m_PathID', 0) if isinstance(pointer, dict) else 0
    if not path_id:
        return None, None
    if not pointer.get('m_FileID') and path_id in bundles[bundle]:
        return bundle, bundles[bundle][path_id]
    candidates = all_objects.get(path_id, [])
    return candidates[0] if len(candidates) == 1 else (None, None)

def portable(value, field=''):
    if isinstance(value, float) and not math.isfinite(value):
        return 'Infinity' if value > 0 else '-Infinity' if value < 0 else 'NaN'
    if isinstance(value, int) and (field == 'm_PathID' or abs(value) > 9007199254740991):
        return str(value)
    if isinstance(value, dict):
        return {key: portable(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [portable(item) for item in value]
    return value

def write(relative, value):
    path = output / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(portable(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False) + chr(10), encoding='utf8')
    return hashlib.sha256(path.read_bytes()).hexdigest()

manifest = {'version': 1, 'source': str(source),
    'note': 'Original client Unity curves and bindings. Infinity slopes are strings denoting stepped interpolation; 64-bit path IDs are strings. Raw originals retain source bytes. No new motion timing is authored.',
    'objects': {}, 'clipsByName': {}, 'prefabs': {}, 'effectPrefabs': [], 'missing': []}
motion_types = {'AnimationClip', 'AnimatorController', 'AnimatorOverrideController', 'Animation', 'Animator'}
for bundle, objects in bundles.items():
    for obj in objects.values():
        if obj['type'] not in motion_types:
            continue
        relative = next((e['path'] for e in obj.get('exports', []) if e['format'] == 'typetree-json'), None)
        if not relative:
            continue
        key = bundle + ':' + str(obj['path_id'])
        safe = re.sub(r'[^A-Za-z0-9_.-]', '_', obj.get('name') or obj['type'])
        stem = bundle.replace('/', '_') + '/' + obj['type'] + '/' + safe + '__' + str(obj['path_id']) + '.json'
        raw_path = output / 'raw' / stem
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, raw_path)
        data = read(bundle, obj)
        compact = 'data/' + stem
        checksum = write(compact, data)
        record = {'name': obj.get('name'), 'type': obj['type'], 'pathId': str(obj['path_id']),
            'source': relative, 'sourceSha256': hashlib.sha256((source / relative).read_bytes()).hexdigest(),
            'file': compact, 'sha256': checksum, 'raw': 'raw/' + stem}
        if obj['type'] == 'AnimationClip':
            muscle = data.get('m_MuscleClip', {})
            times = [frame.get('time', 0) for kind in ['m_FloatCurves', 'm_PositionCurves', 'm_ScaleCurves', 'm_RotationCurves', 'm_EulerCurves']
                for curve in data.get(kind, []) for frame in curve.get('curve', {}).get('m_Curve', [])]
            record.update({'duration': muscle.get('m_StopTime', max(times, default=0)),
                'sampleRate': data.get('m_SampleRate'), 'wrapMode': data.get('m_WrapMode'),
                'floatCurves': len(data.get('m_FloatCurves', []))})
            manifest['clipsByName'].setdefault(obj['name'], []).append(key)
        manifest['objects'][key] = record

wanted = {'init_style', 'roguelike_init_relic', 'roguelike_init_recruit', 'roguelike_init_option',
    'roguelike_init_char', 'btn_confirm', 'dungeon_node', 'focus_node', 'dungeon_modules'}
# These UI prefabs embed ParticleSystems directly instead of referencing an
# effect folder. Ordinary run rewards remain in scope; monthly content does not.
embedded_particle_roots = {'dungeon_node', 'DiceScene', 'dice_view',
    'roguelike_topic_ending_sp_operator', 'reward_state'}
for bundle, objects in bundles.items():
    for obj in objects.values():
        if obj['type'] != 'GameObject' or not obj.get('container'):
            continue
        if obj['name'] in embedded_particle_roots or any('/effect/' in p or '/nodeeffect/' in p or 'scene_effect' in p or 'san_effect' in p for p in obj['container']):
            manifest['effectPrefabs'].append({'bundle': bundle + '.ab', 'name': obj['name'], 'pathId': str(obj['path_id']), 'container': obj['container']})
        if obj['name'] not in wanted:
            continue
        nodes, visited = [], set()
        def walk(current_bundle, current, parent=''):
            marker = (current_bundle, int(current['path_id']))
            if marker in visited:
                return
            visited.add(marker)
            data = read(current_bundle, current)
            path = parent + '/' + data.get('m_Name', '')
            node = {'path': path, 'pathId': str(current['path_id']), 'active': bool(data.get('m_IsActive', True)), 'motion': [], 'particles': [], 'images': []}
            transform = None
            for entry in data.get('m_Component', []):
                component_bundle, component = resolve(current_bundle, entry.get('component'))
                if component is None:
                    continue
                component_data = read(component_bundle, component)
                if component['type'] in ['Transform', 'RectTransform']:
                    transform = (component_bundle, component_data)
                    node['transform'] = component_data
                elif component['type'] in motion_types:
                    node['motion'].append({'type': component['type'], 'key': component_bundle + ':' + str(component['path_id']), 'data': component_data})
                elif component['type'] == 'ParticleSystem':
                    node['particles'].append(str(component['path_id']))
                elif isinstance(component_data.get('m_Sprite'), dict) and component_data['m_Sprite'].get('m_PathID'):
                    sprite_bundle, sprite = resolve(component_bundle, component_data['m_Sprite'])
                    node['images'].append({'sprite': sprite.get('name') if sprite else None, 'pointer': component_data['m_Sprite'], 'color': component_data.get('m_Color')})
            nodes.append(node)
            if transform:
                for pointer in transform[1].get('m_Children', []):
                    child_bundle, child_transform = resolve(transform[0], pointer)
                    if child_transform is not None:
                        go_bundle, child = resolve(child_bundle, read(child_bundle, child_transform).get('m_GameObject'))
                        if child is not None:
                            walk(go_bundle, child, path)
        walk(bundle, obj)
        manifest['prefabs'][obj['name']] = {'bundle': bundle, 'container': obj['container'], 'nodes': nodes}
manifest['nodeViewData'] = []
manifest['effectBindings'] = []
effect_ids = {(v['bundle'].removesuffix('.ab'), int(v['pathId'])): v for v in manifest['effectPrefabs']}
def owner_path(bundle, go):
    names, visited, container = [], set(), []
    while go is not None and (bundle, int(go['path_id'])) not in visited:
        visited.add((bundle, int(go['path_id'])))
        data = read(bundle, go)
        names.append(data.get('m_Name', go.get('name', '')))
        if go.get('container'):
            container = go['container']
        transform_bundle, transform = None, None
        for item in data.get('m_Component', []):
            cb, co = resolve(bundle, item.get('component'))
            if co and co['type'] in ['Transform', 'RectTransform']:
                transform_bundle, transform = cb, co
                break
        if transform is None:
            break
        parent_bundle, parent = resolve(transform_bundle, read(transform_bundle, transform).get('m_Father'))
        if parent is None:
            break
        bundle, go = resolve(parent_bundle, read(parent_bundle, parent).get('m_GameObject'))
    return {'path': '/' + '/'.join(reversed(names)), 'container': container}
def effect_references(bundle, value, path=''):
    if isinstance(value, dict):
        if value.get('m_PathID'):
            target_bundle, target = resolve(bundle, value)
            record = effect_ids.get((target_bundle, int(target['path_id']))) if target else None
            if record:
                yield {'field': path, 'key': Path(record['container'][0]).stem.lower(),
                    'name': record['name'], 'bundle': record['bundle'], 'pathId': record['pathId']}
        for key, item in value.items():
            yield from effect_references(bundle, item, path + '.' + key)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from effect_references(bundle, item, path + '[' + str(index) + ']')
for bundle, objects in bundles.items():
    for obj in objects.values():
        if obj['type'] != 'MonoBehaviour':
            continue
        data = read(bundle, obj)
        bindings = list(effect_references(bundle, data))
        if bindings:
            go_bundle, go = resolve(bundle, data.get('m_GameObject'))
            manifest['effectBindings'].append({'bundle': bundle, 'pathId': str(obj['path_id']),
                'gameObject': go.get('name') if go else None, **owner_path(go_bundle, go), 'bindings': bindings})
        if '_particles' in data and '_activeIcons' in data and '_selectableColors' in data:
            particles = []
            for particle in data['_particles']:
                target_bundle, target = resolve(bundle, particle.get('prefab'))
                particles.append({'type': particle['type'], 'key': Path(target['container'][0]).stem.lower()
                    if target and target.get('container') else None, 'pointer': particle.get('prefab')})
            path = 'data/node-view-data/' + str(obj['path_id']) + '.json'
            checksum = write(path, data)
            manifest['nodeViewData'].append({'bundle': bundle, 'pathId': str(obj['path_id']), 'file': path,
                'sha256': checksum, 'particles': particles, 'selectableColors': data['_selectableColors']})
manifest['summary'] = {kind: sum(v['type'] == kind for v in manifest['objects'].values()) for kind in sorted(motion_types)}
manifest['summary'].update({'prefabs': len(manifest['prefabs']), 'effectPrefabs': len(manifest['effectPrefabs'])})
write('manifest.json', manifest)
print(json.dumps(manifest['summary'], ensure_ascii=False))
