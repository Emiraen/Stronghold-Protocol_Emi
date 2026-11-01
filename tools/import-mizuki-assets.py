"""Import locally extracted IS3 art without altering gameplay data or guessing model aliases."""
import argparse
import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def image_group(bundle, name):
    if 'ticket' in name:
        return 'tickets'
    if 'relic' in name or 'topic_item' in bundle:
        return 'items'
    if 'mappreview' in bundle:
        return 'stages'
    if bundle.startswith('avg/') or 'homebackground' in bundle:
        return 'backgrounds'
    return 'ui'


def import_assets(source, output):
    source = source.resolve()
    output.mkdir(parents=True, exist_ok=True)
    inventory = source / 'inventory.jsonl'
    spine_source = source / 'usable/spine/enemy'
    if not inventory.is_file() or not (spine_source / 'manifest.json').is_file():
        raise ValueError('Expected verified is3 export inventory and usable enemy Spine manifest')
    summary = json.loads((source / 'summary.json').read_text(encoding='utf-8'))
    selected = []
    with inventory.open(encoding='utf-8') as stream:
        for line in stream:
            item = json.loads(line)
            if item.get('category') != 'theme' or item.get('type') not in ('Sprite', 'Texture2D'):
                continue
            if item['bundle'].startswith('scenes/'):
                continue  # lightmaps require scene conversion, never treat them as ready UI
            for export in item.get('exports', []):
                if export['path'].endswith('.png'):
                    selected.append((item, export))
    selected.sort(key=lambda pair: (pair[0]['type'] != 'Sprite', pair[0]['bundle'], pair[0].get('name', ''), pair[0]['path_id']))
    manifest = {'schema': 1, 'topic': 'rogue_2', 'lazy': True,
                'notice': 'Art library only: stage previews and enemy art do not establish gameplay rule support.',
                'sourceVersions': summary.get('source_versions', []),
                'groups': {}, 'images': [], 'spines': {}, 'counts': {}}
    # Public provenance identifies bundles and versions, not machine-specific install paths.
    for version in manifest['sourceVersions']:
        version.pop('root', None)
    copied = {}
    for item, exported in selected:
        original = source / exported['path']
        sha = digest(original)
        rel = Path('images') / (sha[:32] + '.png')
        dest = output / rel
        if sha not in copied:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, dest)
            if digest(dest) != sha:
                raise ValueError('Image copy checksum mismatch: ' + str(original))
            copied[sha] = dest.stat().st_size
        name = item.get('name') or str(item['path_id'])
        group = image_group(item['bundle'], name)
        entry = {'name': name, 'path': '/assets/mizuki/library/' + rel.as_posix(),
                 'group': group, 'type': item['type'], 'bundle': item['bundle'],
                 'pathId': str(item['path_id']), 'sha256': sha, 'bytes': dest.stat().st_size,
                 'width': item.get('width'), 'height': item.get('height'),
                 'border': item.get('border'), 'rect': item.get('rect'),
                 'container': item.get('container', [])}
        manifest['images'].append(entry)
        manifest['groups'].setdefault(group, {}).setdefault(name, entry)
    spines = json.loads((spine_source / 'manifest.json').read_text(encoding='utf-8'))
    spine_bytes = 0
    spine_files = 0
    for enemy_id, model in spines['models'].items():
        if model.get('status') != 'exported':
            continue
        assets = {}
        evidence = []
        for filename, meta in model['files'].items():
            original = spine_source / meta['path']
            rel = Path('spines') / enemy_id / filename
            dest = output / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, dest)
            sha = digest(original)
            if digest(dest) != sha:
                raise ValueError('Spine copy checksum mismatch: ' + str(original))
            url = '/assets/mizuki/library/' + rel.as_posix()
            assets[Path(filename).suffix] = url
            evidence.append({'name': filename, 'sha256': sha, 'bytes': dest.stat().st_size})
            spine_bytes += dest.stat().st_size
            spine_files += 1
        if not all(ext in assets for ext in ('.skel', '.atlas', '.png')):
            raise ValueError('Incomplete model: ' + enemy_id)
        manifest['spines'][enemy_id] = {'skel': assets['.skel'], 'atlas': assets['.atlas'],
              'textures': [assets['.png']], 'pma': True, 'anims': {}, 'files': evidence,
              'discovery': model.get('discovery'), 'playableDefinitionImported': False}
    manifest['counts'] = {'imageObjects': len(manifest['images']), 'uniqueImages': len(copied),
                          'imagesByGroup': dict(Counter(v['group'] for v in manifest['images'])),
                          'imageBytes': sum(copied.values()), 'spineModels': len(manifest['spines']),
                          'spineFiles': spine_files, 'spineBytes': spine_bytes}
    manifest['unresolvedEnemyIds'] = spines.get('not_found', [])
    # These are informational names/evidence; no nonexistent game definitions are synthesized.
    target = output / 'manifest.json'
    temporary = output / 'manifest.tmp.json'
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(target)
    print(json.dumps({'output': str(output.resolve()), **manifest['counts']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'public/assets/mizuki/library')
    args = parser.parse_args()
    import_assets(args.source, args.output)
