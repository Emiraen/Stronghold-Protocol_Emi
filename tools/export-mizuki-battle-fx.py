from pathlib import Path
import sys,json,hashlib,types,re
ROOT=Path.cwd()
sys.path[:0]=[str(ROOT/'tools/local-extract')]
if sys.version_info.minor>=14: sys.path.insert(1,str(ROOT/'.tmp-mod-analysis-20261025/pipe-render-hotfix-20261025/pydeps'))
# Graphics-only extraction never calls AudioClipConverter. Its eager import loads
# this machine's crashing experimental Numpy build through fmod_toolkit.
sys.modules['fmod_toolkit']=types.ModuleType('fmod_toolkit')
import aklz4,fx
KEYS = ['bolt_attack_01_hit', 'bolt_attack_01_trail', 'bolt_buff_01_start', 'bow_birth_01_start', 'common_firemagic_hit_01', 'curse_buff_01_start', 'curse_buff_02_start', 'enemy_atkspd_attack_buff_01', 'enemy_atkspd_attack_hit', 'enemy_atkspd_attack_start_01', 'enemy_atkspd_attack_start_02', 'enemy_atkspd_attack_trail_01', 'enemy_atkspd_buff_01', 'enemy_atkspd_buff_02', 'enemy_dsuply_attack_hit_01', 'enemy_dsuply_attack_start_01', 'enemy_dsuply_attack_trail_01', 'enemy_dsuply_buff_01', 'enemy_dzomg_born_01', 'enemy_dzoms_born_01', 'enemy_merbow_buff_01', 'enemy_merbow_buff_02', 'enemy_nhkodo_attack_01_start', 'enemy_nhkodo_attack_02_hit', 'enemy_nhkodo_attack_02_start', 'enemy_sybox_die', 'enemy_sybox_start', 'icer_birth_01_start', 'icer_buff_02_start', 'map_eruption_03', 'obsv_buff_01_range', 'rageth_attack_01_hit', 'rageth_attack_01_trail', 'supply_buff_01_start', 'supply_buff_01_start_02', 'supply_buff_02_start', 'trap_037_airsup_buff', 'trap_038_dsbell_buff_01', 'trap_038_dsbell_buff_02', 'trap_038_dsbell_buff_03', 'trap_038_dsbell_buff_04', 'trap_latelan_char_01', 'trap_latelan_char_01_start', 'trap_latelan_char_attack_01', 'trap_latelan_char_charging_01', 'trap_latelan_enemy_01', 'trap_latelan_enemy_01_start', 'trap_latelan_enemy_attack_01', 'trap_latelan_enemy_charging_01']
KEYS += ['demonk_attack_01_start', 'demonk_attack_01_hit']
KEYS += ['common_hit_01', 'common_magic_hit_01', 'common_heal_hit_01', 'common_enemy_hit_01',
    'common_cuting_hit_01', 'common_ranger_hit_01', 'common_char_die_01', 'common_enemy_die_01',
    'common_char_birth_01', 'buff_stun', 'buff_autochess_frozen', 'buff_cold', 'buff_sleep',
    'buff_burn', 'buff_silence', 'buff_slowdown', 'buff_sluggish', 'common_buff_fear',
    'common_levitate_01', 'common_root_01', 'common_stealth', 'common_shield_01', 'buff_weak',
    'buff_defdown', 'buff_magic_resistance_down', 'buff_attack_speed_reduction_01',
    'common_disarm_01', 'common_invincible_01', 'buff_poison',
    'enemy_mershd_buff_01', 'enemy_mershd_buff_02', 'enemy_mershd_attack_01_start', 'enemy_mershd_attack_01_hit',
    'enemy_defspd_buff_01', 'enemy_defspd_buff_02', 'enemy_defspd_attack_buff_01', 'enemy_defspd_skill_buff_01',
    'enemy_merlgd_buff_01', 'enemy_merlgd_buff_02', 'enemy_merlgd_attack_buff_01', 'enemy_merlgd_attack_hit',
    'enemy_merlgd_attack_start_01', 'enemy_merlgd_attack_start_02', 'enemy_merlgd_attack_start_03']
KEYS += ['buff_ fragile_01']  # Original prefab key includes the space.
KEYS += ['rogue_2_infect_trail', 'rogue_2_infect_hit', 'rogue_2_infect_birth', 'rogue_2_soar_buff']
KEYS += ['wind_buff_01', 'endmy_sgwlf_skill_start', 'endmy_sgwlf_skill_range', 'endmy_sgwlf_skill_buff',
    'frstar2_attack_01_hit', 'frstar2_attack_01_trail', 'flwitch_skill_02_range',
    'flsnip_skill_01_trail', 'flsnip_attack_01_trail', 'flsnip_skill_01_hit', 'flsnip_attack_01_hit',
    'enemy_dusocr_2_attack_01_trail_die', 'enemy_duspfr_2_die_01_hit']
# Literal original FX references from newly implemented Water Moon enemy hooks.
# The source client remains authoritative: export_fx rejects absent prefab keys.
for file in (ROOT/'server/modes/mizuki').glob('native-*.js'):
    KEYS.extend(re.findall(r"['\"]((?:enemy_(?![0-9])|snslime_|sotidp_|sotiwz_|buff_curse_)[^'\"]+)['\"]",file.read_text(encoding='utf8')))
KEYS = sorted(set(KEYS))
if __name__=='__main__':
    out=ROOT/'public/assets/mizuki'
    manifest=ROOT/'.cache/mizuki-native-fx/local-fx.json'
    source=Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
    fx.export_fx(source,out,{},print,keys=KEYS,jobs=1,root=ROOT,fx_manifest=manifest)
    listing=json.loads(manifest.read_text(encoding='utf-8'))
    for group in listing['groups'].values():
        for entry in group.values():
            for field in ['path','half']:
                if field in entry: entry[field]=entry[field].replace('/assets/local/fx/','/assets/mizuki/fx/')
            file=ROOT/'public'/entry['path'].lstrip('/')
            if file.exists():
                entry['sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
                entry['bytes']=file.stat().st_size
            if entry.get('half'):
                half=ROOT/'public'/entry['half'].lstrip('/')
                entry['halfSha256']=hashlib.sha256(half.read_bytes()).hexdigest()
                entry['halfBytes']=half.stat().st_size
    listing['notice']='Original Unity particle, mesh, material and clip data. Browser runtime supports its documented subset; no rendered image is a full Unity-shader fidelity claim.'
    (out/'fx/manifest.json').write_text(json.dumps(listing,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    index=json.loads((out/'fx/index.json').read_text())
    summary={'keysRequested':KEYS,'keysExported':list(index['prefabs']),'groups':{k:len(v)for k,v in listing['groups'].items()},'prefabs':index['prefabs']}
    (ROOT/'.cache/mizuki-native-fx/extraction-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'ok':True,'keys':summary['keysExported'],'groups':summary['groups']}))
