"""Read-only original gene projectile and its referenced particle effect."""
import json
from pathlib import Path
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
sys.modules['numpy'] = None
import fx

CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
env = fx.AssetEnv(CLIENT, json.loads((ROOT / '.cache/mizuki-native-rules/client-cab-map.json').read_text('utf8')))
roots = env.prefabs(fx.PROJECTILES)
key = 'projectile_rogue_2_enroll_3_infection'
if key not in roots:
    raise KeyError({'key': key, 'candidates': [name for name in roots if 'infect' in name.lower()]})
result = {'key': key, 'bundle': fx.PROJECTILES, 'components': [], 'effects': []}
stack = [roots[key]]
while stack:
    go = stack.pop()
    tree = env.tt(go)
    for entry in tree.get('m_Component', []):
        sf, obj = env.resolve(go.assets_file, entry.get('component'))
        if obj is None or sf == 'builtin' or obj.type.name != 'MonoBehaviour':
            continue
        data = env.tt(obj)
        result['components'].append({'node': tree.get('m_Name'), 'class': env.script(obj)[1], 'native': data})
        if isinstance(data.get('_mainEffect'), str):
            result['effects'].append(data['_mainEffect'])
    stack.extend(fx.go_children(env, go))
out = ROOT / '.cache/mizuki-native-rules/infection-projectile.json'
out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(result, ensure_ascii=False))
