"""Export original module type icons into Mizuki's private asset directory."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
import aklz4  # noqa: E402,F401
import UnityPy  # noqa: E402

CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
BUNDLE = 'spritepack/ui_equip_type_hub_h2_0.ab'


def normalized(value):
    return value.strip().translate(str.maketrans({'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'Δ': 'd'})).lower()


def export(client, output):
    source = client / BUNDLE
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    environment = UnityPy.load(str(source))
    containers = {}
    for path, pointer in environment.container.items():
        containers.setdefault(pointer.path_id, []).append(path)
    output.mkdir(parents=True, exist_ok=True)
    icons = {}
    for obj in environment.objects:
        if obj.type.name != 'Sprite':
            continue
        data = obj.read()
        tree = obj.read_typetree()
        key = normalized(data.m_Name)
        assert key not in icons, 'Duplicate normalized module type: ' + key
        assert all(c.isalnum() or c in '-_' for c in key), 'Unexpected module type name: ' + key
        file = output / (key + '.png')
        image = data.image
        image.save(file)
        icons[key] = {'path': '/assets/mizuki/native-ui-roster/modules/' + file.name,
                      'width': image.width, 'height': image.height,
                      'bytes': file.stat().st_size,
                      'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                      'source': {'bundle': BUNDLE, 'bundleSha256': digest,
                                 'name': data.m_Name, 'type': 'Sprite',
                                 'pathId': str(obj.path_id),
                                 'texturePathId': str(tree['m_RD']['texture']['m_PathID']),
                                 'rect': tree['m_Rect'],
                                 'container': containers.get(obj.path_id, [])}}
    manifest = {'version': 1,
                'source': 'Installed official Arknights client, original module type Sprite pixels',
                'normalization': 'Trim, replace Greek alpha/beta/gamma/delta with a/b/g/d, lowercase',
                'groups': {'module': dict(sorted(icons.items()))}}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client', type=Path, default=CLIENT)
    parser.add_argument('--out', type=Path, default=ROOT / 'public/assets/mizuki/native-ui-roster/modules')
    arguments = parser.parse_args()
    result = export(arguments.client, arguments.out)
    print(json.dumps({'icons': len(result['groups']['module']), 'manifest': str(arguments.out / 'manifest.json')}, ensure_ascii=False))
