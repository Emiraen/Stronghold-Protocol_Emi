#!/usr/bin/env python3
"""Read native maps, export original reflections/light to a separate private package.

Never writes native-maps or its 74k raw objects. Every native Cubemap retains its
complete encoded payload, serialized object, all six faces and every mip level.
"""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parent.parent
CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
DEST = ROOT / 'public/assets/mizuki/native-reflections'
PREFIX = '/assets/mizuki/native-reflections/'
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
import fx  # noqa: E402
import scenes as native_scenes  # noqa: E402
from PIL import Image  # noqa: E402
from UnityPy.enums import TextureFormat  # noqa: E402
from UnityPy.export.Texture2DConverter import parse_image_data  # noqa: E402

# The shared helper is untouched. Windows RGBM uses DXT5 in these local scenes.
BLOCK_BYTES = {'DXT1': 8, 'DXT5': 16, 'BC7': 16, 'ETC2_RGBA8': 16}
native_scenes.ENV_BLOCK_BYTES = {**native_scenes.ENV_BLOCK_BYTES, **BLOCK_BYTES}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def portable(value, key=''):
    if key in ('m_PathID', 'pathId'):
        return str(value)
    if isinstance(value, dict):
        return {str(k): portable(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [portable(v) for v in value]
    if isinstance(value, bytes):
        return {'bytes': len(value), 'sha256': sha(value)}
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def json_bytes(data):
    return (json.dumps(portable(data), ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf8')


def image_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def xyz(value, keys='xyz'):
    return [float(value[k]) for k in keys]


def inverse_vector(matrix, vector):
    a, b, c = matrix[0][:3]
    d, e, f = matrix[1][:3]
    g, h, i = matrix[2][:3]
    determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(determinant) < 1e-15:
        raise ValueError('Singular native Tiles world transform')
    inverse = [[e * i - f * h, c * h - b * i, b * f - c * e],
               [f * g - d * i, a * i - c * g, c * d - a * f],
               [d * h - e * g, b * g - a * h, a * e - b * d]]
    return [sum(row[j] * vector[j] for j in range(3)) / determinant for row in inverse]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int, default=60, help='debug subset only; manifest.complete remains false')
    args = parser.parse_args()
    source_manifest = json.loads((ROOT / 'public/assets/mizuki/native-maps/manifest.json').read_text(encoding='utf8'))
    if len(source_manifest['scenes']) != 60:
        raise ValueError('Expected all 60 original scene source records')
    env = fx.AssetEnv(CLIENT, json.loads((ROOT / '.cache/mizuki-native-rules/client-cab-map.json').read_text(encoding='utf8')))
    groups, cubemaps, atlases, raw_objects, records, bundles = {}, {}, {}, {}, {}, {}
    warnings = []

    def save(group, relative, blob, kind, **metadata):
        target = DEST / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        record = {'path': PREFIX + relative, 'sha256': sha(blob), 'bytes': len(blob), 'kind': kind, **metadata}
        groups.setdefault(group, {})[relative] = record
        return record

    def source_bundle(name, expected=None):
        if name not in bundles:
            bundles[name] = sha((CLIENT / name).read_bytes())
        if expected and bundles[name] != expected:
            raise ValueError('Installed source bundle differs: ' + name)
        return bundles[name]

    def origin(obj):
        for name, serialized in env.loaded.items():
            if obj.assets_file in serialized:
                relative = Path(name).relative_to(CLIENT).as_posix()
                return {'bundle': relative, 'bundleSha256': source_bundle(relative),
                        'cab': obj.assets_file.name, 'pathId': str(obj.path_id), 'type': obj.type.name}
        raise ValueError('Cannot establish original serialized-file bundle')

    def retain(obj):
        key = sha((obj.assets_file.name + ':' + str(obj.path_id)).encode('utf8'))[:20]
        if key not in raw_objects:
            raw_objects[key] = {**save('scene/source', 'source/' + key + '.bin', obj.get_raw_data(), 'OriginalSerializedObject'),
                                **origin(obj)}
        return raw_objects[key]

    def resolve(origin_obj, pointer, required=False):
        sf, obj = env.resolve(origin_obj.assets_file, pointer)
        if obj is None or sf == 'builtin':
            if required:
                raise ValueError('Unresolved native PPtr: ' + repr(pointer))
            return None
        return obj

    transforms, active_cache = {}, {}

    def transform(go):
        for component in env.tt(go).get('m_Component', []):
            obj = resolve(go, component.get('component'))
            if obj is not None and obj.type.name == 'Transform':
                return obj
        raise ValueError('GameObject has no native Transform: ' + str(go.path_id))

    def world(tr, stack=None):
        key = (tr.assets_file.name, tr.path_id)
        if key in transforms:
            return transforms[key]
        stack = set() if stack is None else stack
        if key in stack:
            raise ValueError('Cyclic native Transform hierarchy')
        stack.add(key)
        value = env.tt(tr)
        matrix = native_scenes.trs(xyz(value['m_LocalPosition']), xyz(value['m_LocalRotation'], 'xyzw'), xyz(value['m_LocalScale']))
        father = resolve(tr, value.get('m_Father'))
        if father is not None:
            matrix = native_scenes.mul(world(father, stack), matrix)
        transforms[key] = matrix
        return matrix

    def active(go):
        key = (go.assets_file.name, go.path_id)
        if key not in active_cache:
            state = bool(env.tt(go)['m_IsActive'])
            tr = transform(go)
            father = resolve(tr, env.tt(tr).get('m_Father'))
            if father is not None:
                parent = resolve(father, env.tt(father)['m_GameObject'], True)
                state = state and active(parent)
            active_cache[key] = state
        return active_cache[key]

    def transform_record(go):
        tr = transform(go)
        tree = env.tt(tr)
        return {'gameObject': origin(go), 'name': env.tt(go)['m_Name'], 'activeInHierarchy': active(go),
                'transform': origin(tr), 'localPosition': xyz(tree['m_LocalPosition']),
                'localRotation': xyz(tree['m_LocalRotation'], 'xyzw'), 'localScale': xyz(tree['m_LocalScale']),
                'worldMatrix': world(tr), 'rawGameObject': retain(go), 'rawTransform': retain(tr)}

    def cube_record(obj):
        key = sha((obj.assets_file.name + ':' + str(obj.path_id)).encode('utf8'))[:20]
        if key in cubemaps:
            return key
        if obj.type.name != 'Cubemap':
            raise ValueError('Reflection PPtr does not resolve to a Cubemap')
        cube = obj.read()
        data = bytes(cube.get_image_data())
        fmt = TextureFormat(cube.m_TextureFormat)
        size, mips = cube.m_Width, cube.m_MipCount
        if cube.m_Height != size or cube.m_MipsStripped:
            raise ValueError('Unexpected nonsquare or stripped original Cubemap')
        if fmt.name not in BLOCK_BYTES:
            raise ValueError('Original Cubemap format needs exact decoder: ' + fmt.name)
        sizes = [max(1, size >> mip) for mip in range(mips)]
        lengths = [((side + 3) // 4) ** 2 * BLOCK_BYTES[fmt.name] for side in sizes]
        if len(data) != 6 * sum(lengths):
            raise ValueError('Cubemap payload does not include exactly six complete mip chains')
        source_atlas = Image.new('RGBA', (6 * size, sum(sizes)))
        cells, offset = [], 0
        for face in range(6):
            y = 0
            for mip, (side, length) in enumerate(zip(sizes, lengths)):
                image = parse_image_data(data[offset:offset + length], side, side, fmt,
                                         obj.assets_file.version, obj.assets_file.target_platform, flip=False).convert('RGBA')
                source_atlas.paste(image, (face * side, y))
                cells.append({'face': face, 'mip': mip, 'size': side, 'offset': offset,
                              'bytes': length, 'x': face * side, 'y': y})
                offset += length
                y += side
        tree = {k: v for k, v in env.tt(obj).items() if k != 'image data'}
        cubemaps[key] = {'key': key, 'name': cube.m_Name, **origin(obj),
                         'size': size, 'mips': mips, 'faces': 6, 'format': fmt.name,
                         'formatValue': int(cube.m_TextureFormat), 'lightmapFormat': cube.m_LightmapFormat,
                         'colorSpace': cube.m_ColorSpace, 'mipsStripped': cube.m_MipsStripped,
                         'payload': save('scene/cubemap-payloads', 'cubes/' + key + '.payload.bin', data, 'FullCubemapMipPayload'),
                         'rawObject': retain(obj),
                         'typeTree': save('scene/cubemap-metadata', 'cubes/' + key + '.json', json_bytes(tree), 'CubemapTypeTree'),
                         'sourceAtlas': save('scene/env', 'cubes/' + key + '.rgba.png', image_bytes(source_atlas), 'LosslessDecodedRGBMAtlas',
                                             w=source_atlas.width, h=source_atlas.height),
                         'cells': cells, 'faceOrder': ['+X', '-X', '+Y', '-Y', '+Z', '-Z'],
                         'layout': 'face-major native payload; atlas mip rows y=sum(previous mip sizes), x=face*mipSize; no flip, no dropped mip'}
        return key

    def reflection(origin_obj, pointer, intensity, source, pointer_field):
        if not isinstance(intensity, (int, float)) or not math.isfinite(intensity):
            raise ValueError('Missing/nonfinite native reflection intensity')
        cube = resolve(origin_obj, pointer, True)
        key = cube_record(cube)
        atlas_key = key + '-' + sha(repr(float(intensity)).encode('ascii'))[:8]
        if atlas_key not in atlases:
            texture = cube.read()
            atlas, range_value = native_scenes.env_atlas(bytes(texture.get_image_data()), texture.m_Width, texture.m_MipCount,
                                                        texture.m_TextureFormat, cube.assets_file.version,
                                                        cube.assets_file.target_platform, intensity)
            atlases[atlas_key] = {**save('scene/env', 'env/' + atlas_key + '.png', image_bytes(atlas), 'LosslessReflectionAtlas',
                                        w=atlas.width, h=atlas.height),
                                  'size': texture.m_Width, 'mips': texture.m_MipCount,
                                  'range': range_value, 'cubemapKey': key, 'intensity': intensity}
        atlas = atlases[atlas_key]
        return {'source': source, 'pointerField': pointer_field, 'pointer': pointer,
                'pointerOwner': origin(origin_obj), 'cubemapKey': key, 'atlasKey': atlas_key,
                'intensity': intensity, 'atlas': atlas,
                'env': {field: atlas[field] for field in ('size', 'mips', 'range', 'cubemapKey', 'intensity')},
                'intensityAlreadyApplied': True, 'encoding': 'display-gamma RGBM5 * original intensity / env.range; PNG lossless'}

    selected_records = list(source_manifest['scenes'].items())[:args.limit]
    for index, (name, source) in enumerate(selected_records):
        objects = []
        source_hashes = source['sourceBundlesSha256']
        for bundle, expected in source_hashes.items():
            source_bundle(bundle, expected)
            for serialized in env.load_rel(bundle):
                objects.extend(serialized.objects.values())
        settings = [obj for obj in objects if obj.type.name == 'RenderSettings']
        if len(settings) != 1:
            raise ValueError(name + ': expected one original RenderSettings')
        rs = settings[0]
        rs_tree = env.tt(rs)
        go_named = {}
        for obj in objects:
            if obj.type.name == 'GameObject':
                go_named.setdefault(env.tt(obj)['m_Name'], []).append(obj)
        if len(go_named.get('Tiles', [])) != 1 or len(go_named.get('Anchor', [])) != 1:
            raise ValueError(name + ': native Tiles/Anchor basis is ambiguous')
        tiles = transform_record(go_named['Tiles'][0])
        anchor = transform_record(go_named['Anchor'][0])
        anchor_world = [row[3] for row in anchor['worldMatrix']]
        default_field = 'm_GeneratedSkyboxReflection' if rs_tree['m_DefaultReflectionMode'] == 0 else 'm_CustomReflection'
        default = None
        if rs_tree.get(default_field, {}).get('m_PathID'):
            default = reflection(rs, rs_tree[default_field], rs_tree['m_ReflectionIntensity'], 'default', default_field)
        probes = []
        for obj in objects:
            if obj.type.name != 'ReflectionProbe':
                continue
            tree = env.tt(obj)
            go = resolve(obj, tree['m_GameObject'], True)
            tf = transform_record(go)
            field = 'm_CustomBakedTexture' if tree.get('m_CustomBakedTexture', {}).get('m_PathID') else 'm_BakedTexture'
            record = {'id': str(obj.path_id), **origin(obj), 'tree': tree, 'rawObject': retain(obj),
                      'transform': tf, 'enabled': bool(tree['m_Enabled']),
                      'importance': tree['m_Importance'], 'blendDistance': tree['m_BlendDistance'],
                      'boxProjection': tree['m_BoxProjection'], 'box': {'size': xyz(tree['m_BoxSize']), 'offset': xyz(tree['m_BoxOffset'])}}
            center = [tf['worldMatrix'][axis][3] + record['box']['offset'][axis] for axis in range(3)]
            half = [abs(value) / 2 for value in record['box']['size']]
            record['box']['worldCenter'] = center
            record['containsAnchor'] = all(abs(anchor_world[axis] - center[axis]) <= half[axis] for axis in range(3))
            if tree.get(field, {}).get('m_PathID'):
                record.update(reflection(obj, tree[field], tree['m_IntensityMultiplier'], 'probe', field))
            probes.append(record)
        candidates = [record for record in probes if record['enabled'] and record['transform']['activeInHierarchy']
                      and record['containsAnchor'] and 'atlas' in record]
        candidates.sort(key=lambda record: (-record['importance'], math.prod(abs(value) for value in record['box']['size'])))
        selected = candidates[0] if candidates else default
        lights = []
        for obj in objects:
            if obj.type.name != 'Light':
                continue
            tree = env.tt(obj)
            if tree['m_Type'] != 1:
                continue
            go = resolve(obj, tree['m_GameObject'], True)
            tf = transform_record(go)
            toward_light_world = [-tf['worldMatrix'][axis][2] for axis in range(3)]
            local = inverse_vector(tiles['worldMatrix'], toward_light_world)
            board_direction = [local[0], -local[1], -local[2]]
            length = math.sqrt(sum(value * value for value in board_direction))
            if not length:
                raise ValueError(name + ': zero native directional light vector')
            lights.append({'source': 'original-directional-light', 'dir': [value / length for value in board_direction],
                           'color': xyz(tree['m_Color'], 'rgb'), 'intensity': tree['m_Intensity'],
                           'enabled': bool(tree['m_Enabled']), 'transform': tf, 'tree': tree,
                           'rawObject': retain(obj), **origin(obj), 'towardLightWorld': toward_light_world,
                           'coordinateSpace': 'board x=Tiles.x, y=-Tiles.y, z=-Tiles.z; world direction transformed by inverse Tiles world matrix'})
        explicit_sun = resolve(rs, rs_tree.get('m_Sun'))
        live = [light for light in lights if light['enabled'] and light['transform']['activeInHierarchy']]
        if explicit_sun:
            chosen = next((light for light in lights if light['pathId'] == str(explicit_sun.path_id) and light['cab'] == explicit_sun.assets_file.name), None)
            selection = 'RenderSettings.m_Sun'
        elif len(live) == 1:
            chosen, selection = live[0], 'only-active-original-directional-light; RenderSettings.m_Sun is null'
        else:
            raise ValueError(name + ': cannot select original main light without guessing')
        document = {'version': 1, 'name': name, 'sourceBundlesSha256': source_hashes,
                    'renderSettings': {'tree': rs_tree, **origin(rs), 'rawObject': retain(rs)},
                    'coordinateBasis': {'tiles': tiles, 'anchor': anchor, 'anchorWorld': anchor_world},
                    'reflections': {'probes': probes, 'default': default,
                                    'selection': 'enabled active probes containing original Anchor; importance descending then smallest native box; otherwise original RenderSettings default',
                                    'selectedProbeId': selected.get('id') if selected else None,
                                    'scope': 'All probes/default retained. Convenience env is chosen at board Anchor; this is not a claim of per-renderer edge blending.'},
                    'images': {'env': selected['atlas']['path']} if selected else {},
                    'env': {**selected['env'], 'source': selected['source'], 'probeId': selected.get('id'),
                            'atlasKey': selected['atlasKey'], 'intensityAlreadyApplied': True} if selected else None,
                    'light': {**chosen, 'selection': selection}, 'directionalLights': lights, 'warnings': []}
        record = save('scene/data', 'scenes/' + name + '.json', json_bytes(document), 'NativeSceneReflections')
        records[name] = {**record, 'file': 'scenes/' + name + '.json', 'probes': len(probes),
                         'envSource': selected['source'] if selected else None,
                         'sourceBundlesSha256': source_hashes}
        print(json.dumps({'scene': name, 'index': index + 1, 'probes': len(probes),
                          'env': records[name]['envSource'], 'lightIntensity': chosen['intensity']}, ensure_ascii=False), flush=True)
    complete = len(records) == 60
    manifest = {'version': 1, 'format': 'mizuki-native-reflections', 'source': 'local-client',
                'client': fx.client_version(CLIENT), 'complete': complete,
                'scenes': records, 'stages': {stage: name for stage, name in source_manifest['stages'].items() if name in records},
                'cubemaps': cubemaps, 'atlases': atlases, 'sourceObjects': raw_objects,
                'bundlesSha256': bundles, 'groups': groups, 'warnings': warnings, 'missing': [],
                'notice': 'Independent package; native-maps and original map raw objects are read-only. Cubemap payloads retain all six faces and all native mips. Original intensity is already applied to convenience env atlas; do not multiply twice.'}
    save_path = DEST / 'manifest.json'
    save_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = DEST / 'manifest.json.tmp'
    temporary.write_bytes(json_bytes(manifest))
    temporary.replace(save_path)
    print(json.dumps({'complete': complete, 'scenes': len(records), 'stages': len(manifest['stages']),
                      'cubemaps': len(cubemaps), 'atlases': len(atlases), 'files': sum(len(group) for group in groups.values()),
                      'sourceBundles': len(bundles), 'warnings': warnings}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
