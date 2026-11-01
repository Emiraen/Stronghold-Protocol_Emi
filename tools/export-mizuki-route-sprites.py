"""Resolve original NodeViewData line sprites, including external sprite packs."""
import hashlib
import json
from pathlib import Path
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
import aklz4  # noqa: E402,F401
import fx  # noqa: E402

client = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
bundle = 'ui/rglktopic/rogue_2.ab'
output = ROOT / 'public/assets/mizuki/native-ui-motion/route-sprites'
output.mkdir(parents=True, exist_ok=True)
env = fx.AssetEnv(client, fx.scan_cabs(client, dirs=('spritepack', 'refs', 'anon', 'pkgrps', 'ui', 'arts')))
files = env.load_rel(bundle)
sf = next(sf for sf in files if -6508383265232094159 in sf.objects)
view = env.tt(sf.objects[-6508383265232094159])
records = {}
for field in ('_lineImg', '_lineLockedImg', '_lineHiddenImg'):
    pointer = view[field]
    target, obj = env.resolve(sf, pointer)
    if obj is None or target == 'builtin' or obj.type.name != 'Sprite':
        raise RuntimeError(f'Unresolved original {field}: {pointer}')
    sprite = obj.read()
    # UnityPy image resolves the atlas/texture through its Environment. Load only
    # original PPtrs first so dependency resolution never silently uses a substitute.
    tree = env.tt(obj)
    atlas = tree.get('m_SpriteAtlas')
    if atlas and atlas.get('m_PathID'):
        af, ao = env.resolve(target, atlas)
        if ao is None:
            raise RuntimeError(f'Unresolved original atlas: {field}')
        for _, render in env.tt(ao).get('m_RenderDataMap', []):
            for key in ('texture', 'alphaTexture'):
                ptr = render.get(key)
                if ptr and ptr.get('m_PathID'):
                    if env.resolve(af, ptr)[1] is None:
                        raise RuntimeError(f'Unresolved original atlas texture: {field}')
    for key in ('texture', 'alphaTexture'):
        ptr = tree.get('m_RD', {}).get(key)
        if ptr and ptr.get('m_PathID') and env.resolve(target, ptr)[1] is None:
            raise RuntimeError(f'Unresolved original sprite texture: {field}')
    img = sprite.image
    filename = field[1:] + '.png'
    path = output / filename
    img.save(path)
    records[field] = {'name': sprite.m_Name, 'kind': 'Sprite',
        'pathId': str(obj.path_id), 'pointer': {'m_FileID': pointer['m_FileID'], 'm_PathID': str(pointer['m_PathID'])},
        'path': '/assets/mizuki/native-ui-motion/route-sprites/' + filename,
        'w': img.width, 'h': img.height, 'bytes': path.stat().st_size,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
manifest = {'version': 1, 'sourceBundle': bundle,
    'sourceSha256': hashlib.sha256((client / bundle).read_bytes()).hexdigest(),
    'note': 'Original Sprite images resolved from NodeViewData PPtrs; no authored line or dash texture.',
    'sprites': records}
(output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + chr(10), encoding='utf8')
print(json.dumps(manifest, ensure_ascii=False))
