"""Export original RO2 facility graphics; never substitute a generic crate.

Uses the established local FX descriptor format, retaining original prefab
transforms, meshes, materials, textures, clips and MonoBehaviour references.
The separate facility manifest records the client's real theme-skin selection.
"""
import hashlib
import json
from pathlib import Path
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
import fx  # noqa: E402
import extract as native_extract  # noqa: E402

CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
DEST = ROOT / 'public/assets/mizuki/native-facilities'
TOKEN_BUNDLE = 'pkgrps/btl_pfb_tokens_0.ab'
SKIN_BUNDLE = 'battle/prefabs/skins/trap.ab'
PREFIX = '/assets/mizuki/native-facilities/fx/'
SPINE_PREFIX = '/assets/mizuki/native-facilities/spines/'
SPINE_FACILITIES = ['trap_024_npcsld', 'trap_065_normbox', 'trap_066_rarebox', 'trap_068_badbox',
                    'trap_009_battery', 'trap_012_mine', 'trap_018_bomb', 'trap_031_sleep', 'trap_083_bunker', 'trap_084_aidkit']
CABS_PATH = ROOT / '.cache/mizuki-native-rules/client-cab-map.json'


class NativeAssetEnv(fx.AssetEnv):
    """Refresh stale CAB filenames from current headers only, once per directory."""
    def __init__(self, ab_root, cabs):
        super().__init__(ab_root, cabs)
        self._refreshed_cab_dirs = set()

    def sfile(self, cab):
        cab = cab.lower()
        cached = self.cabs.get(cab)
        if cab not in self.sf and cached and not Path(cached).is_file():
            directory = Path(cached).parent.relative_to(self.ab_root).as_posix()
            if directory not in self._refreshed_cab_dirs:
                self._refreshed_cab_dirs.add(directory)
                self.cabs.update(fx.scan_cabs(self.ab_root, dirs=(directory,), files=()))
                write(CABS_PATH, self.cabs)
            if not Path(self.cabs.get(cab, cached)).is_file():
                raise FileNotFoundError('Native CAB is absent from current client: ' + cab)
        return super().sfile(cab)
FACILITIES = ['trap_038_dsbell', 'trap_001_crate', 'trap_027_stone', 'trap_010_frosts',
              'trap_008_farm', 'trap_007_ballis', 'trap_057_wpnsts', 'trap_024_npcsld',
              'trap_005_sensor', 'trap_065_normbox', 'trap_066_rarebox', 'trap_068_badbox',
              'trap_061_creep', 'trap_011_ore', 'trap_009_battery', 'trap_012_mine',
              'trap_018_bomb', 'trap_031_sleep', 'trap_083_bunker', 'trap_084_aidkit']


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + chr(10), encoding='utf8')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def walk(env, go):
    yield go
    for child in fx.go_children(env, go):
        yield from walk(env, child)


def native_details(env, go):
    components, scripts, clips = {}, [], []
    for node in walk(env, go):
        for component in env.tt(node).get('m_Component', []):
            sf, obj = env.resolve(node.assets_file, component.get('component'))
            if obj is None or sf == 'builtin':
                continue
            kind = obj.type.name
            components[kind] = components.get(kind, 0) + 1
            if kind == 'MonoBehaviour':
                namespace, cls = env.script(obj)
                if cls == '?':
                    raise ValueError('Unresolved native MonoScript: ' + env.tt(node).get('m_Name', ''))
                scripts.append('.'.join(x for x in (namespace, cls) if x))
            if kind in ('Animator', 'Animation'):
                tree = env.tt(obj)
                clips.append({'kind': kind, 'controllerPresent': bool(tree.get('m_Controller', {}).get('m_PathID')),
                              'legacyClipCount': len(tree.get('m_Animations', []))})
    return {'componentCounts': components, 'scripts': sorted(set(scripts)), 'animationComponents': clips}


def export_spine(env, root, key, records):
    """Follow the actual SkeletonAnimation pointer, including cross-CAB references.

    Skeleton bytes remain exact.  The portable atlas only gains the dimensions
    and PMA flag required by the existing parser; original serialized objects
    and original atlas text are preserved separately and all files are hashed.
    """
    renderers = []
    for node in walk(env, root):
        tree = env.tt(node)
        for component in tree.get('m_Component', []):
            sf, obj = env.resolve(node.assets_file, component.get('component'))
            if obj is None or sf == 'builtin' or obj.type.name != 'MonoBehaviour':
                continue
            value = env.tt(obj)
            if value.get('skeletonDataAsset', {}).get('m_PathID'):
                renderers.append((tree.get('m_Name', ''), bool(tree.get('m_IsActive', 1)), node, obj, value))
    live = [item for item in renderers if item[1]] or renderers
    selected = next((item for name in ('Front', 'Spine') for item in live if item[0] == name), live[0] if live else None)
    if selected is None:
        raise ValueError(key + ': native SkeletonAnimation not found')
    node_name, active, node, renderer, renderer_tree = selected
    source_objects = {}

    def retain(obj):
        source_objects[(obj.assets_file.name, obj.path_id)] = obj
        return obj

    def resolve(origin, pointer):
        sf, obj = env.resolve(origin.assets_file, pointer)
        if obj is None or sf == 'builtin':
            return None
        return retain(obj)

    retain(node)
    retain(renderer)
    sda = resolve(renderer, renderer_tree['skeletonDataAsset'])
    if sda is None:
        raise ValueError(key + ': SkeletonDataAsset unresolved')
    sda_tree = env.tt(sda)
    skeleton = resolve(sda, sda_tree.get('skeletonJSON'))
    if skeleton is None:
        raise ValueError(key + ': skeleton TextAsset unresolved')
    skeleton_asset = skeleton.read()
    stem = native_extract.safe_name(getattr(skeleton_asset, 'm_Name', '') or key).removesuffix('.skel')
    atlas_texts, pages, atlas_assets = [], {}, []
    for pointer in sda_tree.get('atlasAssets', []):
        atlas = resolve(sda, pointer)
        if atlas is None:
            raise ValueError(key + ': AtlasAsset unresolved')
        atlas_tree = env.tt(atlas)
        atlas_assets.append((atlas, atlas_tree))
        text = resolve(atlas, atlas_tree.get('atlasFile'))
        if text is None:
            raise ValueError(key + ': atlas TextAsset unresolved')
        atlas_texts.append(native_extract._text_bytes(text.read()).decode('utf-8'))
        for mat_pointer in atlas_tree.get('materials', []):
            material = resolve(atlas, mat_pointer)
            if material is None:
                raise ValueError(key + ': atlas material unresolved')
            props = env.tt(material)['m_SavedProperties']
            textures = dict(props['m_TexEnvs'])
            floats = dict(props.get('m_Floats') or [])
            main = resolve(material, textures.get('_MainTex', {}).get('m_Texture'))
            alpha = resolve(material, textures.get('_AlphaTex', {}).get('m_Texture'))
            if main is None:
                raise ValueError(key + ': atlas page texture unresolved')
            main_texture = main.read()
            pages[native_extract.safe_name(main_texture.m_Name) + '.png'] = native_extract.merge_alpha(
                main_texture.image, alpha.read().image if alpha is not None else None,
                floats.get('_StraightAlphaInput') == 1)
    if not atlas_texts or not pages:
        raise ValueError(key + ': incomplete original atlas')
    source_atlas = atlas_texts[0] if len(atlas_texts) == 1 else '\n\n'.join(text.strip('\n') for text in atlas_texts) + '\n'
    names = native_extract.atlas_pages(source_atlas)
    if set(names) != set(pages):
        if len(names) != 1 or len(pages) != 1:
            raise ValueError(key + ': native atlas pages do not match materials')
        pages = {names[0]: next(iter(pages.values()))}
    if any(Path(name).name != name or ':' in name or name in ('', '.', '..') for name in names):
        raise ValueError(key + ': unsafe atlas page filename')
    directory = DEST / 'spines' / key
    directory.mkdir(parents=True, exist_ok=True)
    blobs = {
        stem + '.skel': native_extract._text_bytes(skeleton_asset),
        stem + '.atlas': native_extract.normalize_atlas(source_atlas, {name: image.size for name, image in pages.items()}).encode('utf-8'),
        stem + '.source.atlas': source_atlas.encode('utf-8'),
    }
    for name, blob in blobs.items():
        (directory / name).write_bytes(blob)
    write(directory / 'SkeletonDataAsset.json', sda_tree)
    for index, (_, tree) in enumerate(atlas_assets):
        write(directory / ('AtlasAsset-%s.json' % index), tree)
    for name, image in pages.items():
        image.save(directory / name)
    original_records = []
    for (cab, path_id), obj in sorted(source_objects.items()):
        relative = 'source/' + hashlib.sha256(cab.encode('utf-8')).hexdigest()[:8] + '_' + str(path_id) + '.bin'
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(obj.get_raw_data())
        original_records.append({'path': SPINE_PREFIX + key + '/' + relative,
                                 'cab': cab, 'pathId': str(path_id), 'type': obj.type.name,
                                 'bytes': target.stat().st_size, 'sha256': sha(target)})
    files = []
    for file in sorted(directory.rglob('*')):
        if not file.is_file():
            continue
        relative = file.relative_to(directory).as_posix()
        entry = {'path': SPINE_PREFIX + key + '/' + relative,
                 'kind': 'Texture2D' if file.suffix == '.png' else ('OriginalSerializedObject' if file.suffix == '.bin' else 'SpineData')}
        if file.suffix == '.png':
            entry.update({'w': pages[file.name].width, 'h': pages[file.name].height})
        records[key + '/' + relative] = entry
        if relative in (stem + '.skel', stem + '.atlas') or relative in pages:
            files.append({'name': relative, 'bytes': file.stat().st_size, 'sha256': sha(file)})
    return {'skel': SPINE_PREFIX + key + '/' + stem + '.skel',
            'atlas': SPINE_PREFIX + key + '/' + stem + '.atlas',
            'textures': [SPINE_PREFIX + key + '/' + name for name in names],
            'pma': True, 'anims': {}, 'files': files, 'sourceObjects': original_records,
            'skeletonDataAsset': SPINE_PREFIX + key + '/SkeletonDataAsset.json',
            'scale': sda_tree.get('scale'), 'defaultAnimation': renderer_tree.get('_animationName', ''),
            'defaultLoop': bool(renderer_tree.get('loop')), 'timeScale': renderer_tree.get('timeScale', 1),
            'initialFlipX': bool(renderer_tree.get('initialFlipX')), 'initialFlipY': bool(renderer_tree.get('initialFlipY')),
            'discovery': {'method': 'prefab_renderer_reference', 'bundle': TOKEN_BUNDLE,
                          'prefabContainer': next((name for name, pointer in env.prefabs(TOKEN_BUNDLE, full=True).items()
                                                   if pointer.path_id == root.path_id), None),
                          'node': node_name, 'active': active,
                          'skeletonDataAsset': {'cab': sda.assets_file.name, 'pathId': str(sda.path_id), 'name': sda_tree.get('m_Name')}}}


def repair_metadata():
    """Restore MonoScript/shader references without re-exporting existing geometry."""
    read = lambda name: json.loads((DEST / name).read_text(encoding='utf8'))
    manifest, index, assets, textures = [read(name) for name in
        ('manifest.json', 'fx/index.json', 'fx/manifest.json', 'fx/textures.json')]
    env = NativeAssetEnv(CLIENT, json.loads(CABS_PATH.read_text(encoding='utf8')))
    warnings = []

    class MetadataExporter(fx.Exporter):
        def _export_texture(self, obj):
            texture = obj.read()
            image = texture.image
            if image is None:
                raise ValueError('Native texture could not be decoded: ' + texture.m_Name)
            digest = hashlib.sha1(f'{image.mode}:{image.size}'.encode())
            digest.update(image.tobytes())
            name = fx.FX_SAFE.sub('_', texture.m_Name or 'tex').strip('._') or 'tex'
            key = name + '-' + digest.hexdigest()[:8]
            if key not in textures['textures']:
                return super()._export_texture(obj)
            return key

    exporter = MetadataExporter(env, DEST, warnings.append)
    bundles, details, pending, changed = {}, {}, {}, []
    for key, asset in assets['groups']['fx/prefabs'].items():
        path = ROOT / 'public' / asset['path'].lstrip('/')
        descriptor = json.loads(path.read_text(encoding='utf8'))
        before = json.dumps(descriptor, sort_keys=True)
        bundle = descriptor['bundle']
        if bundle not in bundles:
            bundles[bundle] = env.prefabs(bundle)
        root = bundles[bundle].get(key)
        if root is None:
            raise ValueError('Native prefab is absent: ' + key)
        nodes = list(walk(env, root))
        if len(nodes) != len(descriptor['nodes']):
            raise ValueError('Native node count changed: ' + key)
        material_ids = {}
        for node, native in zip(descriptor['nodes'], nodes):
            tree = env.tt(native)
            if tree.get('m_Name', '') != node['name']:
                raise ValueError('Native node identity changed: ' + key + ':' + node['name'])
            behaviours = []
            for component in tree.get('m_Component', []):
                sf, obj = env.resolve(native.assets_file, component.get('component'))
                if obj is None or sf == 'builtin':
                    continue
                kind, value = obj.type.name, env.tt(obj)
                if kind == 'MonoBehaviour':
                    namespace, cls = env.script(obj)
                    if cls == '?':
                        raise ValueError('Unresolved native MonoScript: ' + key + ':' + node['name'])
                    behaviours.append((namespace, cls))
                renderer = node.get(kind[0].lower() + kind[1:])
                if not isinstance(renderer, dict) or 'materials' not in renderer:
                    continue
                pointers = value.get('m_Materials', [])
                if len(pointers) != len(renderer['materials']):
                    raise ValueError('Native material slots changed: ' + key)
                for slot, (pointer, material_id) in enumerate(zip(pointers, renderer['materials'])):
                    mf, material = env.resolve(obj.assets_file, pointer)
                    if material is None or mf == 'builtin':
                        if pointer.get('m_PathID'):
                            raise ValueError('Unresolved native material: ' + key)
                        continue
                    restored = exporter.material(mf, material)
                    if not restored['shader'] or not restored['passes']:
                        raise ValueError('Unresolved native shader: ' + key + ':' + restored['name'])
                    identity = (id(mf), material.path_id)
                    if material_id is None:
                        if identity not in material_ids:
                            material_ids[identity] = len(descriptor['materials'])
                            descriptor['materials'].append(restored)
                        material_id = material_ids[identity]
                        renderer['materials'][slot] = material_id
                    material_ids[identity] = material_id
                    current = descriptor['materials'][material_id]
                    if current['name'] != restored['name']:
                        raise ValueError('Native material identity changed: ' + key)
                    descriptor['materials'][material_id] = restored
            if len(behaviours) != len(node.get('behaviours', [])):
                raise ValueError('Native behaviour count changed: ' + key)
            for behaviour, (namespace, cls) in zip(node.get('behaviours', []), behaviours):
                behaviour.update({'namespace': namespace, 'class': cls})
        details[key] = native_details(env, root)
        if '?' in details[key]['scripts']:
            raise ValueError('Unresolved native script metadata: ' + key)
        descriptor['textures'] = sorted(set(descriptor['textures']) | {
            value['tex'] for material in descriptor['materials'] for value in material['textures'].values()
            if value.get('tex') and not value['tex'].startswith('builtin:')})
        if before != json.dumps(descriptor, sort_keys=True):
            pending[path] = descriptor
            changed.append(key)
    if warnings:
        raise ValueError('Native metadata warnings: ' + repr(warnings))
    for facility in manifest['facilities'].values():
        for graphic in [facility['root'], *facility['skins'].values()]:
            graphic.update(details[graphic['key']])
    for path in env.loaded:
        file = Path(path)
        relative = file.relative_to(CLIENT).as_posix()
        manifest['bundlesSha256'][relative] = sha(file)
        index['source']['bundlesSha256'][relative] = sha(file)
    for source in (manifest['bundlesSha256'], index['source']['bundlesSha256']):
        for relative in list(source):
            if not (CLIENT / relative).is_file():
                del source[relative]
    for path, descriptor in pending.items():
        write(path, descriptor)
    for key, value in exporter.textures.items():
        textures['textures'][key] = value
        record = {'path': PREFIX + value['file'], 'kind': 'Texture2D', 'w': value['w'], 'h': value['h']}
        if value.get('half'):
            record['half'] = PREFIX + value['half']
        assets['groups']['fx/tex'][key] = record
    write(DEST / 'fx/textures.json', textures)
    write(DEST / 'manifest.json', manifest)
    write(DEST / 'fx/index.json', index)
    for group in assets['groups'].values():
        for asset in group.values():
            path = ROOT / 'public' / asset['path'].lstrip('/')
            asset.update({'bytes': path.stat().st_size, 'sha256': sha(path)})
            if asset.get('half'):
                half = ROOT / 'public' / asset['half'].lstrip('/')
                asset.update({'halfBytes': half.stat().st_size, 'halfSha256': sha(half)})
    write(DEST / 'fx/manifest.json', assets)
    mode_dir = ROOT / 'public/assets/mizuki/fx'
    mode_manifest = json.loads((mode_dir / 'manifest.json').read_text(encoding='utf8'))
    mode_textures = json.loads((mode_dir / 'textures.json').read_text(encoding='utf8'))
    aliases = {key for key, value in mode_manifest['groups']['fx/prefabs'].items()
               if value['path'].startswith(PREFIX)}
    for key in aliases:
        mode_manifest['groups']['fx/prefabs'][key] = assets['groups']['fx/prefabs'][key]
        descriptor = read('fx/' + index['prefabs'][key]['file'])
        for group, ids in [('fx/tex', descriptor['textures']), ('fx/mesh', descriptor['meshes'])]:
            for identity in ids:
                mode_manifest['groups'][group][identity] = assets['groups'][group][identity]
                if group == 'fx/tex':
                    mode_textures['textures'][identity] = textures['textures'][identity]
    write(mode_dir / 'textures.json', mode_textures)
    texture_file = mode_dir / 'textures.json'
    mode_manifest['groups']['fx']['textures'].update({'bytes': texture_file.stat().st_size, 'sha256': sha(texture_file)})
    write(mode_dir / 'manifest.json', mode_manifest)
    extraction = read('extraction-report.json')
    extraction.update({'facilities': len(manifest['facilities']), 'prefabs': len(assets['groups']['fx/prefabs']),
                       'meshes': len(assets['groups']['fx/mesh']), 'textures': len(assets['groups']['fx/tex']),
                       'spines': len(manifest['spines']), 'spineFiles': len(assets['groups'].get('spines', {}))})
    write(DEST / 'extraction-report.json', extraction)
    report = {'changedPrefabs': changed, 'prefabsChecked': len(details),
              'newTextures': sorted(exporter.textures),
              'refreshedCabDirectories': sorted(env._refreshed_cab_dirs), 'warnings': warnings}
    write(ROOT / '.cache/mizuki-completion-20261029/native-metadata-repair.json', report)
    print(json.dumps(report, ensure_ascii=False), flush=True)


def main():
    cabs_path = CABS_PATH
    cabs = json.loads(cabs_path.read_text(encoding='utf8')) if cabs_path.exists() else fx.scan_cabs(CLIENT)
    env = NativeAssetEnv(CLIENT, cabs)
    original = env.prefabs(TOKEN_BUNDLE)
    skins = env.prefabs(SKIN_BUNDLE)
    fx._init_worker([*FACILITIES, *skins])
    warnings, missing = [], []
    exporter = fx.Exporter(env, DEST, warnings.append)
    entries, facilities, metadata = {}, {}, {}
    spines, spine_records = {}, {}

    def export(key, go, bundle):
        if key not in entries:
            entries[key] = exporter.prefab(key, go, bundle)
            metadata[key] = native_details(env, go)
        entry = entries[key]
        return {'key': key, 'path': PREFIX + entry['file'], 'bundle': bundle,
                'container': ('dyn/battle/prefabs/skins/trap/' + key + '.prefab') if bundle == SKIN_BUNDLE else None,
                'meshes': entry['meshes'], 'textures': entry['textures'], **metadata[key]}

    for key in FACILITIES:
        root = original.get(key)
        if root is None:
            missing.append({'facility': key, 'reason': 'original prefab not found', 'bundle': TOKEN_BUNDLE})
            continue
        data = {}
        for component in env.tt(root).get('m_Component', []):
            sf, obj = env.resolve(root.assets_file, component.get('component'))
            if obj is not None and sf != 'builtin' and obj.type.name == 'MonoBehaviour':
                value = env.tt(obj)
                if '_modes' in value:
                    data = value
                    break
        default = data.get('_defaultSkin') or None
        themes = {value['theme']: value['skinKey'] for value in data.get('_skins', [])}
        graphic_keys = list(dict.fromkeys(([default] if default else []) + list(themes.values())))
        graphics = {}
        for skin in graphic_keys:
            graphic = skins.get(skin)
            if graphic is None:
                missing.append({'facility': key, 'skin': skin, 'reason': 'configured skin prefab not found', 'bundle': SKIN_BUNDLE})
            else:
                graphics[skin] = export(skin, graphic, SKIN_BUNDLE)
        native = export(key, root, TOKEN_BUNDLE)
        facilities[key] = {'root': native, 'defaultSkin': default, 'themeSkins': themes, 'skins': graphics,
                           'graphicPolicy': 'configured-native-skin' if graphic_keys else 'original-prefab',
                           'meshAvailable': bool(native['meshes'] or any(value['meshes'] for value in graphics.values()))}
        if key in SPINE_FACILITIES or (key in ['trap_009_battery', 'trap_012_mine', 'trap_018_bomb',
                                              'trap_031_sleep', 'trap_083_bunker', 'trap_084_aidkit']
                                         and any('Spine' in name for name in native.get('scripts', []))):
            spines[key] = export_spine(env, root, key, spine_records)
            facilities[key].update({'spineKey': key, 'spineAvailable': True, 'graphicPolicy': 'original-spine'})
        print(json.dumps({'facility': key, 'skins': len(graphics), 'meshAvailable': facilities[key]['meshAvailable']}, ensure_ascii=False), flush=True)

    sources = {}
    for path in env.loaded:
        file = Path(path)
        if file.is_file():
            sources[file.relative_to(CLIENT).as_posix()] = sha(file)
    summary_fields = ['file', 'bundle', 'nodes', 'particleSystems', 'liveParticles', 'duration', 'looping', 'refs', 'spawn', 'follow']
    prefabs = {key: {name: value[name] for name in summary_fields if name in value} for key, value in entries.items()}
    index = {'format': 'fx-index', 'version': fx.INDEX_VERSION, 'set': 'mizuki-native-facilities',
             'source': {'client': fx.client_version(CLIENT), 'bundlesSha256': sources},
             'units': {}, 'projectiles': {}, 'skills': {}, 'skins': {}, 'generic': {'keys': sorted(entries)}, 'prefabs': prefabs}
    write(DEST / 'fx/index.json', index)
    write(DEST / 'fx/textures.json', {'format': 'fx-textures', 'version': fx.FORMAT_VERSION, 'textures': exporter.textures})
    groups = {
        'fx': {'index': {'path': PREFIX + 'index.json', 'kind': 'FxIndex', 'version': fx.INDEX_VERSION},
               'textures': {'path': PREFIX + 'textures.json', 'kind': 'FxTextures'}},
        'fx/prefabs': {key: {'path': PREFIX + value['file'], 'kind': 'FxPrefab'} for key, value in entries.items()},
        'fx/tex': {key: {'path': PREFIX + value['file'], 'kind': 'Texture2D', 'w': value['w'], 'h': value['h'],
                        **({'half': PREFIX + value['half']} if value.get('half') else {})} for key, value in exporter.textures.items()},
        'fx/mesh': {key: {'path': PREFIX + value['file'], 'kind': 'FxMesh', 'verts': value['verts']} for key, value in exporter.meshes.items()},
        'spines': spine_records,
    }
    for group in groups.values():
        for value in group.values():
            path = ROOT / 'public' / value['path'].lstrip('/')
            value.update({'bytes': path.stat().st_size, 'sha256': sha(path)})
            if value.get('half'):
                half = ROOT / 'public' / value['half'].lstrip('/')
                value.update({'halfBytes': half.stat().st_size, 'halfSha256': sha(half)})
    write(DEST / 'fx/manifest.json', {'format': 'fx-manifest', 'version': 1, 'source': 'local-client',
                                     'client': fx.client_version(CLIENT), 'set': 'mizuki-native-facilities',
                                     'groups': groups, 'missing': missing, 'warnings': warnings})
    manifest = {'format': 'mizuki-native-facilities', 'version': 1, 'source': 'local-client',
                'client': fx.client_version(CLIENT), 'bundlesSha256': sources, 'facilities': facilities, 'spines': spines,
                'fxManifest': PREFIX + 'manifest.json', 'fxIndex': PREFIX + 'index.json', 'fxTextures': PREFIX + 'textures.json',
                'missing': missing, 'warnings': warnings,
                'notice': 'Original prefab data only. Skin selection follows the native theme table. A missing mesh is not permission to render a crate. Animator without a controller has no invented animation.'}
    write(DEST / 'manifest.json', manifest)
    report = {'facilities': len(facilities), 'prefabs': len(entries), 'meshes': len(exporter.meshes),
              'textures': len(exporter.textures), 'spines': len(spines), 'spineFiles': len(spine_records),
              'missing': missing, 'warnings': warnings}
    write(DEST / 'extraction-report.json', report)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    repair_metadata() if '--repair-metadata' in sys.argv else main()
