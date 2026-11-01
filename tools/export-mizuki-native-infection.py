"""Export original gene assimilation configuration from the installed client."""
import hashlib
import json
from pathlib import Path
import sys
import types

ROOT=Path.cwd()
sys.path.insert(0,str(ROOT/'tools/local-extract'))
sys.modules.setdefault('fmod_toolkit',types.ModuleType('fmod_toolkit'))
sys.modules['numpy']=None
import aklz4
import fx

CLIENT=Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
OUT=ROOT/'.cache/mizuki-native-rules/infection-config'
OUT.mkdir(parents=True,exist_ok=True)
env=fx.AssetEnv(CLIENT,json.loads((ROOT/'.cache/mizuki-native-rules/client-cab-map.json').read_text('utf8')))
hits=[]
for bundle in ['battle/[pack]common.ab','battle/prefabs/[uc]envsystems.ab','config/buff_template_holder.ab']:
    try:
        files=env.load_rel(bundle)
    except Exception as error:
        print(json.dumps({'bundle':bundle,'error':str(error)}))
        continue
    for sf in files:
        for obj in sf.objects.values():
            if obj.type.name!='MonoBehaviour':
                continue
            tree=env.tt(obj)
            script_file,script=env.resolve(sf,tree.get('m_Script',{}))
            klass=env.tt(script).get('m_ClassName','') if script else ''
            go_file,go=env.resolve(sf,tree.get('m_GameObject',{}))
            name=env.tt(go).get('m_Name','') if go else tree.get('m_Name','')
            if klass=='Rogue2InfectionManager' or any(key in name.lower() for key in ['rogue_2_infect','rogue_2_ascen','rogue2_infect']):
                path=OUT/(str(obj.path_id)+'.json')
                path.write_text(json.dumps(tree,ensure_ascii=False,indent=2),encoding='utf8')
                body=obj.get_raw_data()
                (OUT/(str(obj.path_id)+'.bin')).write_bytes(body)
                hit={'bundle':bundle,'serializedFile':sf.name,'pathId':str(obj.path_id),'class':klass,'name':name,
                     'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body),'file':str(path),'native':tree}
                hits.append(hit)
                print(json.dumps(hit,ensure_ascii=False))
(OUT/'manifest.json').write_text(json.dumps(hits,ensure_ascii=False,indent=2),encoding='utf8')
