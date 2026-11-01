"""Audit original UI particle ownership; exporting an effect root is not full UI coverage."""
import json
from collections import Counter
from pathlib import Path

ROOT = Path.cwd()
SOURCE = Path('D:/Stronghold-Protocol_Emi-master.backup-before-annihilation-direct-20261025-003701/exports/is3-mizuki-20261027')
motion = json.loads((ROOT / 'public/assets/mizuki/native-ui-motion/manifest.json').read_text(encoding='utf8'))
selected = {(v['bundle'].removesuffix('.ab'), int(v['pathId'])) for v in motion['effectPrefabs']}
result = {'sourceParticleSystems': 0, 'coveredParticleSystems': 0, 'bundles': [], 'uncovered': []}
for bundle in ['ui/rglktopic/rogue_2', 'ui/roguelike']:
    meta = json.loads((SOURCE / 'assets' / bundle / 'metadata.json').read_text(encoding='utf8'))
    objects = {int(v['path_id']): v for v in meta['objects']}
    cache = {}
    def read(path_id):
        if path_id not in cache:
            obj = objects.get(path_id, {})
            path = next((e['path'] for e in obj.get('exports', []) if e['format'] == 'typetree-json'), None)
            cache[path_id] = json.loads((SOURCE / path).read_text(encoding='utf8')) if path else {}
        return cache[path_id]
    def pointer(value):
        return int(value.get('m_PathID', 0)) if isinstance(value, dict) and not value.get('m_FileID') else 0
    covered, total, uncovered = 0, 0, Counter()
    for path_id, obj in objects.items():
        if obj['type'] != 'ParticleSystem':
            continue
        total += 1
        go = pointer(read(path_id).get('m_GameObject'))
        ancestry, seen = [], set()
        while go and go not in seen:
            seen.add(go)
            ancestry.append(go)
            transform = next((pointer(c.get('component')) for c in read(go).get('m_Component', [])
                if objects.get(pointer(c.get('component')), {}).get('type') in ['Transform', 'RectTransform']), 0)
            parent = pointer(read(transform).get('m_Father'))
            go = pointer(read(parent).get('m_GameObject')) if parent else 0
        if any((bundle, node) in selected for node in ancestry):
            covered += 1
        else:
            root = next((node for node in reversed(ancestry) if objects.get(node, {}).get('container')), ancestry[-1] if ancestry else 0)
            uncovered[root] += 1
    result['sourceParticleSystems'] += total
    result['coveredParticleSystems'] += covered
    result['bundles'].append({'bundle': bundle, 'total': total, 'covered': covered})
    for root, count in uncovered.items():
        obj = objects.get(root, {})
        result['uncovered'].append({'bundle': bundle, 'name': obj.get('name'), 'pathId': str(root),
            'container': obj.get('container', []), 'particleSystems': count})
output = ROOT / 'public/assets/mizuki/native-ui-motion/fx/coverage-report.json'
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + chr(10), encoding='utf8')
print(json.dumps(result, ensure_ascii=False))
