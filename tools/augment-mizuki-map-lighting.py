"""Resolve RO2 scene renderer/lightmap metadata without rewriting native raw records."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
if sys.version_info.minor >= 14:
    sys.path.insert(1, str(ROOT / '.tmp-mod-analysis-20261025/pipe-render-hotfix-20261025/pydeps'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
sys.modules['numpy'] = None
import aklz4  # noqa: E402,F401
import fx  # noqa: E402

CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
OUT = ROOT / 'public/assets/mizuki/native-maps'
PREFIX = '/assets/mizuki/native-maps/'
RENDERERS = ('MeshRenderer', 'SkinnedMeshRenderer', 'ParticleSystemRenderer', 'TrailRenderer', 'LineRenderer', 'SpriteRenderer')
parser = argparse.ArgumentParser()
parser.add_argument('--only', action='append', default=[])
args = parser.parse_args()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf8'))


def portable(value, field=''):
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, int) and (field == 'm_PathID' or abs(value) > 9007199254740991):
        return str(value)
    if isinstance(value, dict):
        return {key: portable(child, key) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [portable(child) for child in value]
    return value


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = (json.dumps(portable(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf8')
    path.write_bytes(body)
    return {'sha256': sha(body), 'bytes': len(body)}


def file_info(path):
    body = path.read_bytes()
    return {'sha256': sha(body), 'bytes': len(body)}


def run():
    manifest = read(OUT / 'manifest.json')
    texture_file = OUT / 'fx/textures.json'
    textures = read(texture_file) if texture_file.exists() else {
        'format': 'fx-textures', 'version': fx.FORMAT_VERSION,
        'textures': {key: {'file': entry['path'].split('/fx/', 1)[1], 'w': entry['w'], 'h': entry['h']}
            for key, entry in manifest['groups']['scene/textures'].items()}}
    texture_records = textures['textures']
    cabs = read(ROOT / '.cache/mizuki-native-rules/client-cab-map.json')
    scenes = [name for name in manifest['scenes'] if not args.only or name in args.only]
    if set(args.only) - set(scenes):
        raise ValueError('Unknown original scenes: ' + str(set(args.only) - set(scenes)))
    totals = Counter()
    for number, name in enumerate(scenes, 1):
        entry = manifest['scenes'][name]
        scene_path = OUT / entry['file']
        scene = read(scene_path)
        bundle = 'scenes/obt/roguelike/ro2/' + name + '/' + name + '.ab'
        env = fx.AssetEnv(CLIENT, cabs)
        sfiles = env.load_rel(bundle)
        raw = {(record['serializedFile'], record['pathId']): record for record in scene['raw']}

        def source(obj):
            result = {'serializedFile': obj.assets_file.name, 'pathId': str(obj.path_id), 'type': obj.type.name}
            record = raw.get((obj.assets_file.name, str(obj.path_id)))
            if record:
                result.update({'rawFile': record['file'], 'rawSha256': record['sha256']})
            return result

        node_count = renderer_count = 0
        for root in scene['roots']:
            path = OUT / 'fx' / root['file']
            prefab = read(path)
            root_obj = next((obj for sf in sfiles for obj in sf.objects.values() if obj.type.name == 'GameObject' and str(obj.path_id) == root['pathId']), None)
            if root_obj is None:
                raise ValueError('Original scene root missing: ' + root['key'])
            order, native_nodes = [(root_obj, None)], []
            while order:
                go, parent = order.pop(0)
                nid = len(native_nodes)
                native_nodes.append((go, parent))
                order[0:0] = [(child, nid) for child in fx.go_children(env, go)]
            if len(native_nodes) != len(prefab['nodes']):
                raise ValueError('Native/exported node count mismatch: ' + root['key'])
            for node, (go, parent) in zip(prefab['nodes'], native_nodes):
                gd = env.tt(go)
                if node['name'] != gd.get('m_Name', '') or node['parent'] != parent:
                    raise ValueError('Native/exported node order mismatch: ' + root['key'] + '/' + str(node['id']))
                node.update({'sourceGameObjectPathId': str(go.path_id), 'sourceSerializedFile': go.assets_file.name, 'sourceGameObject': source(go)})
                node_count += 1
                for component in gd.get('m_Component', []):
                    sf, obj = env.resolve(go.assets_file, component.get('component'))
                    if obj is None or sf == 'builtin':
                        continue
                    kind = obj.type.name
                    if kind in ('Transform', 'RectTransform'):
                        node['sourceTransformPathId'] = str(obj.path_id)
                        node['nativeTransform'] = env.tt(obj)
                    if kind not in RENDERERS:
                        continue
                    field = kind[0].lower() + kind[1:]
                    if field not in node:
                        node[field] = {}
                    renderer = node[field]
                    renderer.update({'sourceRendererPathId': str(obj.path_id), 'sourceSerializedFile': obj.assets_file.name,
                        'source': source(obj), 'native': env.tt(obj)})
                    renderer_count += 1
            root.update(write(path, prefab))
            manifest['groups']['scene/roots'][root['key']].update(file_info(path))
        lightmaps = []
        for sf in sfiles:
            for obj in sf.objects.values():
                if obj.type.name != 'LightmapSettings':
                    continue
                data = env.tt(obj)
                scene['lightmapsMode'] = data.get('m_LightmapsMode')
                scene['lightmapSettingsSource'] = source(obj)
                for index, native_slot in enumerate(data.get('m_Lightmaps', [])):
                    slot = {'index': index, 'native': native_slot, 'source': source(obj), 'textures': {}}
                    for native_field, key_field in [('m_Lightmap', 'textureKey'), ('m_DirLightmap', 'directionalTextureKey'), ('m_ShadowMask', 'shadowMaskKey')]:
                        pointer = native_slot.get(native_field)
                        tf, to = env.resolve(sf, pointer)
                        slot[key_field] = None
                        evidence = {'sourceSerializedFile': sf.name, 'pptr': pointer}
                        slot['textures'][native_field] = evidence
                        if to is None:
                            if pointer and int(pointer.get('m_PathID', 0)):
                                raise ValueError('Unresolved original lightmap texture PPtr: ' + name + '/' + native_field)
                            continue
                        if tf == 'builtin' or to.type.name != 'Texture2D':
                            raise TypeError('Original lightmap slot is not Texture2D: ' + name + '/' + native_field)
                        texture = to.read()
                        td = env.tt(to)
                        image = texture.image
                        digest = hashlib.sha1(f'{image.mode}:{image.size}'.encode())
                        digest.update(image.tobytes())
                        key = (fx.FX_SAFE.sub('_', texture.m_Name or 'tex').strip('._') or 'tex') + '-' + digest.hexdigest()[:8]
                        if key not in texture_records:
                            raise ValueError('Original lightmap absent from texture manifest: ' + key)
                        relative = 'fx/tex/fullres/' + key + '.png'
                        full = OUT / relative
                        full.parent.mkdir(parents=True, exist_ok=True)
                        if not full.exists():
                            image.save(full, format='PNG')
                        payload_relative = 'texture-data/' + key + '.bin'
                        payload = OUT / payload_relative
                        payload.parent.mkdir(parents=True, exist_ok=True)
                        original_data = texture.get_image_data()
                        if not payload.exists() or sha(payload.read_bytes()) != sha(original_data):
                            payload.write_bytes(original_data)
                        record = {'path': PREFIX + relative, 'kind': 'NativeLightmapTexture', 'w': texture.m_Width, 'h': texture.m_Height,
                            'format': fx.TEXTURE_FORMATS.get(td.get('m_TextureFormat'), str(td.get('m_TextureFormat'))),
                            'textureFormat': td.get('m_TextureFormat'), 'colorSpace': td.get('m_ColorSpace'), 'imageMode': image.mode,
                            'mipCount': td.get('m_MipCount'), **file_info(full)}
                        manifest['groups'].setdefault('scene/lightmap-textures', {})[key] = record
                        payload_record = {'path': PREFIX + payload_relative, 'kind': 'NativeTexturePayload', **file_info(payload)}
                        manifest['groups'].setdefault('scene/texture-payloads', {})[key] = payload_record
                        texture_records[key].update({'losslessFile': relative.removeprefix('fx/'), 'losslessSha256': record['sha256'], 'losslessBytes': record['bytes'],
                            'nativeTexturePayload': payload_relative, 'nativeTexturePayloadSha256': payload_record['sha256']})
                        slot[key_field] = key
                        evidence.update({'resolved': source(to), 'textureKey': key, 'textureName': texture.m_Name,
                            'textureFormat': td.get('m_TextureFormat'), 'colorSpace': td.get('m_ColorSpace'), 'width': texture.m_Width, 'height': texture.m_Height,
                            'fullres': record, 'originalPayload': payload_record, 'streamData': td.get('m_StreamData')})
                    lightmaps.append(slot)
        scene.update({'lightmaps': lightmaps, 'nativeMetadataVersion': 1})
        entry.update(write(scene_path, scene))
        entry.update({'nativeMetadataVersion': 1, 'sourceNodes': node_count, 'sourceRenderers': renderer_count, 'lightmaps': len(lightmaps)})
        manifest['groups']['scene/data'][name].update(file_info(scene_path))
        totals.update({'nodes': node_count, 'renderers': renderer_count, 'lightmaps': len(lightmaps)})
        print(json.dumps({'scene': name, 'index': number, 'total': len(scenes), 'nodes': node_count, 'renderers': renderer_count, 'lightmaps': len(lightmaps)}), flush=True)
    texture_meta = write(texture_file, textures)
    manifest['groups'].setdefault('scene/metadata', {})['textures'] = {
        'path': PREFIX + 'fx/textures.json', 'kind': 'NativeSceneTextureMetadata', **texture_meta}
    manifest.update({'nativeMetadataVersion': 1, 'nativeMetadataNotice': 'Per-node GameObject/Transform and renderer source identities and complete original renderer fields. Lightmap slots resolve original PPtrs, lossless full-resolution decoded textures and untouched compressed mip payloads. Existing original raw records are not rewritten.'})
    write(OUT / 'manifest.json', manifest)
    print(json.dumps({'ok': True, 'scenes': len(scenes), **totals, 'lightmapTextures': len(manifest['groups'].get('scene/lightmap-textures', {}))}), flush=True)


if __name__ == '__main__':
    run()
