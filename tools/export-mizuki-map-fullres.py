"""Add lossless original-size material textures; never promote half/WebP assets."""
from collections import Counter
import hashlib
import json
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


def read(path):
    return json.loads(path.read_text(encoding='utf8'))


def sha(body):
    return hashlib.sha256(body).hexdigest()


def file_info(path):
    body = path.read_bytes()
    return {'sha256': sha(body), 'bytes': len(body)}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf8')
    path.write_bytes(body)
    return {'sha256': sha(body), 'bytes': len(body)}


def pointer(value):
    return {'m_FileID': value.get('m_FileID', 0), 'm_PathID': str(value.get('m_PathID', 0))}


def run():
    from PIL import Image
    manifest_path = OUT / 'manifest.json'
    manifest = read(manifest_path)
    wanted = set(manifest['groups']['scene/textures'])
    textures_file = OUT / 'fx/textures.json'
    textures = read(textures_file)
    fullres = manifest['groups'].setdefault('scene/texture-fullres', {})
    payloads = manifest['groups'].setdefault('scene/texture-payloads', {})
    source_groups = manifest['groups'].setdefault('scene/texture-sources', {})
    known_sources, checked, materials_seen, references = {}, set(), set(), {}
    cabs = read(ROOT / '.cache/mizuki-native-rules/client-cab-map.json')
    for scene_entry in manifest['scenes'].values():
        scene = read(OUT / scene_entry['file'])
        for slot in scene['lightmaps']:
            for evidence in slot['textures'].values():
                if not evidence.get('textureKey'):
                    continue
                key = evidence['textureKey']
                resolved = evidence['resolved']
                known_sources[(resolved['serializedFile'], resolved['pathId'])] = key
                references.setdefault(key, []).append({'usage': 'LightmapSettings', 'source': resolved, 'pptr': evidence['pptr'],
                    'sourceSerializedFile': evidence['sourceSerializedFile']})
                fullres[key] = {**evidence['fullres'], 'kind': 'NativeSceneTexture'}
    unknown_keys, invalid_pointers = set(), []
    new_count = 0
    for number, (scene_id, scene_entry) in enumerate(manifest['scenes'].items(), 1):
        env = fx.AssetEnv(CLIENT, cabs)
        bundle = 'scenes/obt/roguelike/ro2/' + scene_id + '/' + scene_id + '.ab'
        env.load_rel(bundle)
        light_bundle = bundle[:-3] + '/lightingdata.ab'
        if (CLIENT / light_bundle).is_file():
            env.load_rel(light_bundle)
        scene = read(OUT / scene_entry['file'])

        def export_texture(texture_file, texture_obj, reference=None):
            nonlocal new_count
            identity = (texture_file.name, str(texture_obj.path_id))
            if identity in known_sources:
                key = known_sources[identity]
                if reference and key in wanted:
                    references.setdefault(key, []).append(reference)
                return key
            if identity in checked:
                return None
            checked.add(identity)
            texture = texture_obj.read()
            data = env.tt(texture_obj)
            image = texture.image
            if image is None:
                raise ValueError('Original texture image unavailable: ' + str(identity))
            digest = hashlib.sha1(f'{image.mode}:{image.size}'.encode())
            digest.update(image.tobytes())
            key = (fx.FX_SAFE.sub('_', texture.m_Name or 'tex').strip('._') or 'tex') + '-' + digest.hexdigest()[:8]
            if key not in wanted:
                unknown_keys.add(key)
                return None
            known_sources[identity] = key
            if reference:
                references.setdefault(key, []).append(reference)
            full_relative = 'fx/tex/fullres/' + key + '.png'
            full = OUT / full_relative
            full.parent.mkdir(parents=True, exist_ok=True)
            if not full.exists():
                image.save(full, format='PNG')
            original_payload = texture.get_image_data()
            payload_relative = 'texture-data/' + key + '.bin'
            payload = OUT / payload_relative
            payload.parent.mkdir(parents=True, exist_ok=True)
            if not payload.exists() or sha(payload.read_bytes()) != sha(original_payload):
                payload.write_bytes(original_payload)
            source_relative = 'texture-source/' + key + '.Texture2D.bin'
            source_file = OUT / source_relative
            source_file.parent.mkdir(parents=True, exist_ok=True)
            raw = texture_obj.get_raw_data()
            if not source_file.exists() or sha(source_file.read_bytes()) != sha(raw):
                source_file.write_bytes(raw)
            record = {'path': PREFIX + full_relative, 'kind': 'NativeSceneTexture', 'w': texture.m_Width, 'h': texture.m_Height,
                'format': fx.TEXTURE_FORMATS.get(data.get('m_TextureFormat'), str(data.get('m_TextureFormat'))),
                'textureFormat': data.get('m_TextureFormat'), 'colorSpace': data.get('m_ColorSpace'), 'imageMode': image.mode,
                'mipCount': data.get('m_MipCount'), **file_info(full)}
            fullres[key] = record
            payload_record = {'path': PREFIX + payload_relative, 'kind': 'NativeTexturePayload', **file_info(payload)}
            payloads[key] = payload_record
            source_groups[key] = {'path': PREFIX + source_relative, 'kind': 'NativeTextureSerializedRecord', **file_info(source_file)}
            textures['textures'][key].update({'losslessFile': full_relative.removeprefix('fx/'), 'losslessSha256': record['sha256'], 'losslessBytes': record['bytes'],
                'nativeTexturePayload': payload_relative, 'nativeTexturePayloadSha256': payload_record['sha256'],
                'sourceTextureSerializedFile': texture_file.name, 'sourceTexturePathId': str(texture_obj.path_id),
                'format': record['format'], 'srgb': data.get('m_ColorSpace', 1) == 1,
                'mips': data.get('m_MipCount'), 'nativeTextureSettings': data.get('m_TextureSettings'),
                'nativeStreamData': data.get('m_StreamData')})
            references.setdefault(key, []).append({'usage': 'Texture2D', 'sourceSerializedFile': texture_file.name,
                'sourcePathId': str(texture_obj.path_id), 'rawRecord': source_groups[key], 'streamData': data.get('m_StreamData')})
            new_count += 1
            return key

        for root in scene['roots']:
            prefab = read(OUT / 'fx' / root['file'])
            for node in prefab['nodes']:
                for field in ['meshRenderer', 'skinnedMeshRenderer', 'particleSystemRenderer', 'trailRenderer', 'lineRenderer', 'spriteRenderer']:
                    renderer = node.get(field)
                    if not renderer:
                        continue
                    source_file = env.sfile(renderer['sourceSerializedFile'])
                    if source_file is None:
                        raise ValueError('Renderer source serialized file unavailable: ' + renderer['sourceSerializedFile'])
                    for material_pointer in renderer['native'].get('m_Materials', []):
                        native_pointer = {'m_FileID': material_pointer.get('m_FileID', 0), 'm_PathID': int(material_pointer.get('m_PathID', 0))}
                        material_file, material = env.resolve(source_file, native_pointer)
                        if material is None or material_file == 'builtin':
                            continue
                        identity = (material_file.name, str(material.path_id))
                        if identity in materials_seen:
                            continue
                        materials_seen.add(identity)
                        material_data = env.tt(material)
                        for property_name, texenv in material_data.get('m_SavedProperties', {}).get('m_TexEnvs', []):
                            texture_pointer = texenv.get('m_Texture')
                            texture_file, texture = env.resolve(material_file, texture_pointer)
                            if texture is None:
                                if int((texture_pointer or {}).get('m_PathID', 0)):
                                    invalid_pointers.append([material_file.name, str(material.path_id), property_name, pointer(texture_pointer)])
                                continue
                            if texture_file == 'builtin' or texture.type.name != 'Texture2D':
                                continue
                            reference = {'usage': 'Material', 'sourceSerializedFile': material_file.name, 'sourcePathId': str(material.path_id),
                                'material': material_data.get('m_Name'), 'property': property_name, 'pptr': pointer(texture_pointer),
                                'resolvedSerializedFile': texture_file.name, 'resolvedPathId': str(texture.path_id)}
                            export_texture(texture_file, texture, reference)
        # MapGraphic water/material properties and tile range graphics also own
        # textures outside a Renderer.m_Materials slot. Follow those exact
        # serialized PPtrs instead of substituting a similarly named asset.
        walked = set()

        def walk_pointers(value, source_file, source_obj, field_path=''):
            if isinstance(value, list):
                for child_index, child in enumerate(value):
                    walk_pointers(child, source_file, source_obj, field_path + '[' + str(child_index) + ']')
            elif isinstance(value, dict):
                if 'm_FileID' in value and 'm_PathID' in value:
                    target_file, target = env.resolve(source_file, value)
                    if target is None or target_file == 'builtin':
                        return
                    reference = {'usage': source_obj.type.name, 'sourceSerializedFile': source_file.name, 'sourcePathId': str(source_obj.path_id),
                        'field': field_path, 'pptr': pointer(value), 'resolvedSerializedFile': target_file.name, 'resolvedPathId': str(target.path_id)}
                    if target.type.name == 'Texture2D':
                        export_texture(target_file, target, reference)
                    elif target.type.name in ('Material', 'Sprite'):
                        identity = (target_file.name, str(target.path_id))
                        if identity not in walked:
                            walked.add(identity)
                            walk_pointers(env.tt(target), target_file, target)
                    return
                for child_field, child in value.items():
                    walk_pointers(child, source_file, source_obj, field_path + '.' + child_field)

        for source_file in list(env.load_rel(bundle)):
            for obj in source_file.objects.values():
                if obj.type.name == 'MonoBehaviour':
                    walk_pointers(env.tt(obj), source_file, obj)
        # The original map exporter also emitted Texture2Ds physically stored in
        # lighting bundles even when no renderer has a Material reference to them.
        for source_file in list(env.sf.values()):
            for obj in source_file.objects.values():
                if obj.type.name == 'Texture2D':
                    export_texture(source_file, obj)
        print(json.dumps({'scene': scene_id, 'index': number, 'total': len(manifest['scenes']),
            'fullres': len(fullres), 'wanted': len(wanted), 'new': new_count}), flush=True)
    missing = sorted(wanted - set(fullres))
    if missing:
        raise ValueError('Original texture keys not resolved: ' + str(missing))
    if invalid_pointers:
        raise ValueError('Unresolved original material texture PPtrs: ' + str(invalid_pointers[:8]))
    for key in wanted:
        original = manifest['groups']['scene/textures'][key]
        if (original['w'], original['h']) != (fullres[key]['w'], fullres[key]['h']):
            raise ValueError('Original full-resolution dimensions mismatch: ' + key)
        with Image.open(ROOT / 'public' / fullres[key]['path'].lstrip('/')) as decoded:
            pixels = decoded.tobytes()
            fingerprint = hashlib.sha1(f'{decoded.mode}:{decoded.size}'.encode())
            fingerprint.update(pixels)
            if fingerprint.hexdigest()[:8] != key.rsplit('-', 1)[-1]:
                raise ValueError('PNG pixels differ from original decoded texture fingerprint: ' + key)
            fullres[key].update({'decodedPixelSha256': sha(pixels), 'nativePixelFingerprintVerified': True})
    reference_relative = 'texture-sources.json'
    ref_info = write(OUT / reference_relative, {'format': 'mizuki-native-texture-sources', 'version': 1,
        'notice': 'Exact native Material/LightmapSettings PPtrs and original decoded texture-key mapping. PNGs preserve full-size decoded pixels; compressed payload files preserve all original mips.',
        'textures': references})
    texture_meta = write(textures_file, textures)
    manifest['groups'].setdefault('scene/metadata', {})['texture-sources'] = {'path': PREFIX + reference_relative, 'kind': 'NativeTextureSourceMap', **ref_info}
    manifest['groups']['scene/metadata']['textures'] = {'path': PREFIX + 'fx/textures.json', 'kind': 'NativeSceneTextureMetadata', **texture_meta}
    manifest['losslessTextureCoverage'] = {'originalKeys': len(wanted), 'fullresKeys': len(fullres), 'missing': missing,
        'lightmapKeys': len(manifest['groups']['scene/lightmap-textures']), 'materialOnlyKeys': len(wanted - set(manifest['groups']['scene/lightmap-textures']))}
    write(manifest_path, manifest)
    print(json.dumps({'ok': True, **manifest['losslessTextureCoverage'], 'formats': dict(Counter(record['format'] for record in fullres.values())),
        'unknownUnusedTextureKeys': len(unknown_keys)}), flush=True)


if __name__ == '__main__':
    run()
