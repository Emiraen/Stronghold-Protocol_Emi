"""Use the existing native FX exporter on original Mizuki UI prefab roots."""
import hashlib
import json
from pathlib import Path
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
# Graphics extraction never reads audio. Avoid eager platform audio imports.
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
import aklz4  # noqa: F401,E402
import fx  # noqa: E402

client = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
destination = ROOT / 'public/assets/mizuki/native-ui-motion'
motion = json.loads((destination / 'manifest.json').read_text(encoding='utf8'))
selected = motion['effectPrefabs']
keys = [Path(record['container'][0]).stem.lower() for record in selected]
fx._init_worker(keys)
env = fx.AssetEnv(client, fx.scan_cabs(client))
warnings = []
exporter = fx.Exporter(env, destination, warnings.append)
entries, missing, sources = {}, [], {}
for record, key in zip(selected, keys):
    relative = record['bundle']
    roots = env.prefabs(relative)
    root = roots.get(key)
    if root is None:
        missing.append({'key': key, 'bundle': relative})
        continue
    entries[key] = exporter.prefab(key, root, relative)
    sources[relative] = hashlib.sha256((client / relative).read_bytes()).hexdigest()

prefix = '/assets/mizuki/native-ui-motion/fx/'
summaries = {key: {field: value[field] for field in ['file', 'bundle', 'nodes', 'particleSystems', 'liveParticles', 'duration', 'looping', 'refs', 'spawn', 'follow'] if field in value} for key, value in entries.items()}
index = {'format': 'fx-index', 'version': fx.INDEX_VERSION, 'set': 'mizuki-original-ui',
    'source': {'root': client.name, 'client': fx.client_version(client), 'bundlesSha256': sources},
    'units': {}, 'projectiles': {}, 'skills': {}, 'skins': {}, 'generic': {'keys': sorted(entries)}, 'prefabs': summaries}
groups = {
    'fx': {'index': {'path': prefix + 'index.json', 'kind': 'FxIndex', 'version': fx.INDEX_VERSION},
        'textures': {'path': prefix + 'textures.json', 'kind': 'FxTextures'}},
    'fx/prefabs': {key: {'path': prefix + value['file'], 'kind': 'FxPrefab'} for key, value in entries.items()},
    'fx/tex': {key: {'path': prefix + value['file'], 'kind': 'Texture2D', 'w': value['w'], 'h': value['h'],
        **({'half': prefix + value['half']} if value.get('half') else {})} for key, value in exporter.textures.items()},
    'fx/mesh': {key: {'path': prefix + value['file'], 'kind': 'FxMesh', 'verts': value['verts']} for key, value in exporter.meshes.items()}}
out = destination / 'fx'
out.mkdir(parents=True, exist_ok=True)
def write(name, data):
    (out / name).write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + chr(10), encoding='utf8')
write('index.json', index)
write('textures.json', {'format': 'fx-textures', 'version': fx.FORMAT_VERSION, 'textures': exporter.textures})
for group in groups.values():
    for value in group.values():
        path = ROOT / 'public' / value['path'].lstrip('/')
        value.update({'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        if value.get('half'):
            half = ROOT / 'public' / value['half'].lstrip('/')
            value.update({'halfBytes': half.stat().st_size, 'halfSha256': hashlib.sha256(half.read_bytes()).hexdigest()})
manifest = {'format': 'fx-manifest', 'version': 1, 'source': 'local-client', 'client': fx.client_version(client),
    'set': 'mizuki-original-ui', 'count': sum(map(len, groups.values())), 'groups': groups,
    'missing': missing, 'warnings': warnings,
    'notice': 'Original UI prefab data. Export does not itself prove every Unity UI shader or Animator behavior is reproduced in a browser.'}
write('manifest.json', manifest)
report = {'requested': len(selected), 'exported': len(entries), 'particleSystems': sum(v['particleSystems'] for v in entries.values()),
    'textures': len(exporter.textures), 'meshes': len(exporter.meshes), 'missing': missing, 'warnings': warnings}
write('extraction-report.json', report)
print(json.dumps(report, ensure_ascii=False))
