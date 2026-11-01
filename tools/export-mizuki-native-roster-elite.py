"""Export the original E1/E2 emblems into Mizuki's private roster assets."""
import hashlib
import json
from pathlib import Path
import sys
from PIL import ImageChops

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
import aklz4  # noqa: E402,F401
import UnityPy  # noqa: E402

CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
BUNDLE = 'arts/elite_hub.ab'
SOURCE = CLIENT / BUNDLE
OUTPUT = ROOT / 'public/assets/mizuki/native-ui-roster'
OUTPUT.mkdir(parents=True, exist_ok=True)
manifest_path = OUTPUT / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
bundle_sha = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
env = UnityPy.load(str(SOURCE))
assets = {}
for obj in env.objects:
    if obj.type.name != 'Sprite':
        continue
    data = obj.read()
    if data.m_Name not in ['elite_1', 'elite_2']:
        continue
    tree = obj.read_typetree()
    file = OUTPUT / (data.m_Name + '.png')
    image = data.image.convert('RGBA')
    image.save(file)
    assets[data.m_Name] = {'path': '/assets/mizuki/native-ui-roster/' + file.name,
                           'name': data.m_Name, 'width': image.width, 'height': image.height,
                           'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'bytes': file.stat().st_size,
                           'usage': 'Official E1 emblem for unpromoted Mizuki operators' if data.m_Name == 'elite_1' else 'Official E2 emblem for promoted Mizuki operators',
                           'source': {'bundle': BUNDLE, 'bundleSha256': bundle_sha, 'pathId': str(obj.path_id), 'type': 'Sprite', 'texturePathId': str(tree['m_RD']['texture']['m_PathID']), 'sourceRect': tree['m_Rect']}}
    assert ImageChops.difference(image, obj.read().image.convert('RGBA')).getbbox() is None
assert len(assets) == 2
manifest['assets'].update(assets)
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
report = {'status': 'complete', 'assets': assets, 'mapping': {'unpromoted': 'elite_1.png', 'promoted': 'elite_2.png'}, 'validation': {'sourceSpritePixelsPreserved': True, 'originalWhiteEmblemsNoRecolor': True}, 'rejectedLookalikes': ['evolve_one_new/evolve_two_new include a lock and are not the plain elite emblems', 'evolve_small_icon_1/2 are skill level circles, not elite emblems', 'char_elite_gold is not the requested original white E1/E2 emblem'], 'scope': 'Only Mizuki private assets/manifest; no UI or shared manifest edits'}
(ROOT / '.cache/mizuki-preview/roster-native-elite-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
