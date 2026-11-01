#!/usr/bin/env python3
"""Export exact RO2 BGM banks from the installed client, without lossy encoding.

Requires UnityPy, aklz4 and fmod_toolkit.  Levels select bgmEvent; the original
audio_data bank/alias records select intro/loop; exact bundle containers select
AudioClips.  No filename guess is accepted without a matching native container.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
CLIENT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows')
DEST = ROOT / 'public/assets/mizuki/native-audio'
PREFIX = '/assets/mizuki/native-audio/'
DATA_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/audio_data.json'
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
if not __import__('importlib.util', fromlist=['find_spec']).find_spec('aklz4'):
    sys.path.append(str(ROOT / '.cache/mizuki-native-fx/venv311/Lib/site-packages'))
import fx  # noqa: E402
from UnityPy.helpers.ResourceReader import get_resource_data  # noqa: E402


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf8')


def audio_bytes(clip):
    if clip.m_AudioData:
        return bytes(clip.m_AudioData)
    resource = clip.m_Resource
    if not resource:
        raise ValueError(clip.m_Name + ': no native audio resource')
    return get_resource_data(resource.m_Source, clip.object_reader.assets_file, resource.m_Offset, resource.m_Size)


def resolve_bank(data, name):
    banks = {entry['name']: (index, entry) for index, entry in enumerate(data['bgmBanks'])}
    aliases = data.get('bankAlias', {})
    chain, seen = [], set()
    while name not in banks:
        if name in seen or not isinstance(aliases.get(name), str):
            raise ValueError('Unresolved original BGM bank: ' + name)
        seen.add(name)
        chain.append({'from': name, 'to': aliases[name]})
        name = aliases[name]
    index, entry = banks[name]
    return entry, {'jsonPointer': '/bgmBanks/' + str(index), 'aliases': chain, 'record': entry}


def find_clip(env, asset):
    normalized = asset.replace('\\', '/').lower()
    if not normalized.startswith('audio/sound_beta_2/') or '..' in normalized:
        raise ValueError('Invalid original audio asset path: ' + asset)
    target = PurePosixPath(normalized)
    # This candidate only avoids loading unrelated albums.  Its exact container
    # must match the original bank asset; the candidate's name never proves it.
    stem = re.sub(r'_(intro|loop)$', '', target.name)
    candidate = CLIENT / str(target.parent) / (stem + '.ab')
    candidates = [candidate] if candidate.is_file() else []
    candidates.extend(path for path in sorted((CLIENT / str(target.parent)).glob('*.ab')) if path != candidate)
    wanted = 'dyn/' + normalized
    for bundle in candidates:
        bundle_name = bundle.relative_to(CLIENT).as_posix()
        for serialized in env.load_rel(bundle_name):
            for container, pointer in (getattr(serialized, 'container', None) or {}).items():
                if str(PurePosixPath(container.lower()).with_suffix('')) != wanted:
                    continue
                obj = pointer.deref() if hasattr(pointer, 'deref') else pointer
                if obj.type.name != 'AudioClip':
                    raise ValueError(asset + ': exact container is not an AudioClip')
                return bundle_name, container, obj
    raise ValueError('Exact native AudioClip container not found: ' + asset)


def switch_evidence(value, path=''):
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            pointer = path + '/' + key.replace('~', '~0').replace('/', '~1')
            if key != 'bgmEvent' and (re.search(r'bgm|music', key, re.I) or
                                      isinstance(child, str) and re.search(r'bgm|music', child, re.I)):
                found.append({'jsonPointer': pointer, 'value': child})
            found.extend(switch_evidence(child, pointer))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(switch_evidence(child, path + '/' + str(index)))
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio-data', type=Path, default=ROOT / '.cache/mizuki-native-audio/audio_data.json')
    parser.add_argument('--system-only', action='store_true', help='Append original menu/map banks without rewriting stage audio')
    args = parser.parse_args()
    if not args.audio_data.exists():
        args.audio_data.parent.mkdir(parents=True, exist_ok=True)
        args.audio_data.write_bytes(urllib.request.urlopen(DATA_URL, timeout=60).read())
    source_bytes = args.audio_data.read_bytes()
    audio_data = json.loads(source_bytes)
    levels_dir = ROOT / 'data/mizuki/levels'
    index_bytes = (levels_dir / 'index.json').read_bytes()
    level_index = json.loads(index_bytes)
    if len(level_index['levelsById']) != 60 or len(level_index['stagesById']) != 97:
        raise ValueError('Expected the complete 60-level / 97-stage source index')
    env = fx.AssetEnv(CLIENT, json.loads((ROOT / '.cache/mizuki-native-rules/client-cab-map.json').read_text(encoding='utf8')))
    previous = json.loads((DEST / 'manifest.json').read_text(encoding='utf8')) if args.system_only else {}
    tracks, events = previous.get('tracks', {}), previous.get('events', {})
    levels, stages = previous.get('levels', {}), previous.get('stages', {})
    bundles, groups = previous.get('bundlesSha256', {}), previous.get('groups', {'audio': {}})

    def save(relative, blob, kind):
        target = DEST / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        record = {'path': PREFIX + relative, 'bytes': len(blob), 'sha256': sha(blob), 'kind': kind}
        groups['audio'][relative] = record
        return record

    def export_track(asset):
        if asset is None:
            return None
        if asset in asset_urls:
            return asset_urls[asset]
        bundle, container, obj = find_clip(env, asset)
        raw_bundle = (CLIENT / bundle).read_bytes()
        bundles[bundle] = sha(raw_bundle)
        clip = obj.read()
        name = clip.m_Name
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', name):
            raise ValueError('Unsafe native AudioClip name: ' + name)
        original = audio_bytes(clip)
        encoded = save('original/' + name + '.fsb', original, 'OriginalAudioResource')
        raw = save('original/' + name + '.bin', obj.get_raw_data(), 'OriginalSerializedAudioClip')
        tree = save('source/' + name + '.json', (json.dumps(env.tt(obj), ensure_ascii=False,
                    separators=(',', ':'), allow_nan=False) + '\n').encode('utf8'), 'AudioClipTypeTree')
        samples = clip.samples
        if len(samples) != 1:
            raise ValueError(name + ': expected one native sample, got ' + str(len(samples)))
        decoded_name, decoded = next(iter(samples.items()))
        if decoded[:4] != b'RIFF':
            raise ValueError(name + ': expected native PCM WAV decoder output, got ' + decoded_name)
        with wave.open(io.BytesIO(decoded), 'rb') as pcm:
            params = pcm.getparams()
        if params.nchannels != clip.m_Channels or params.framerate != clip.m_Frequency:
            raise ValueError(name + ': decoding changed source channel count or sample rate')
        if params.sampwidth * 8 != clip.m_BitsPerSample:
            raise ValueError(name + ': decoding changed source bit depth')
        tolerance = max(2 / params.framerate, 0.002)
        if abs(params.nframes / params.framerate - clip.m_Length) > tolerance:
            raise ValueError(name + ': decoded audio duration differs from original AudioClip')
        playable = save('tracks/' + name + '.wav', decoded, 'PCM_WAV')
        url = playable['path']
        tracks[url] = {**playable, 'asset': asset, 'sampleRate': params.framerate,
                       'channels': params.nchannels, 'bitsPerSample': params.sampwidth * 8,
                       'frames': params.nframes, 'duration': params.nframes / params.framerate,
                       'codec': 'PCM_S16LE' if params.sampwidth == 2 else 'PCM',
                       'originalCompressionFormat': int(clip.m_CompressionFormat),
                       'originalResourceMagic': original[:4].decode('ascii', 'replace'),
                       'sourceBundle': bundle, 'sourceBundleSha256': bundles[bundle],
                       'container': container, 'pathId': str(obj.path_id),
                       'cab': obj.assets_file.name, 'original': encoded, 'rawObject': raw, 'typeTree': tree,
                       'quality': 'Original encoded resource retained; decoded to source-rate/source-channel/source-bit-depth PCM without lossy re-encoding.'}
        asset_urls[asset] = url
        print(json.dumps({'track': name, 'sampleRate': params.framerate, 'channels': params.nchannels,
                          'bits': params.sampwidth * 8, 'seconds': tracks[url]['duration']}, ensure_ascii=False), flush=True)
        return url

    asset_urls = {entry['asset']: url for url, entry in tracks.items()}
    for level_id, metadata in ([] if args.system_only else level_index['levelsById'].items()):
        raw_level = (levels_dir / metadata['file']).read_bytes()
        if sha(raw_level) != metadata['sha256'] or len(raw_level) != metadata['bytes']:
            raise ValueError('Original level source mismatch: ' + level_id)
        level = json.loads(raw_level)
        event = level['bgmEvent']
        bank_name = 'battle.ON_GAME_READY.' + event
        if event not in events:
            bank, evidence = resolve_bank(audio_data, bank_name)
            events[event] = {'bgmEvent': event, 'bank': bank['name'],
                             'intro': export_track(bank.get('intro')), 'loop': export_track(bank['loop']),
                             'volume': bank.get('volume'), 'crossfade': bank.get('crossfade'),
                             'delay': bank.get('delay'), 'fadeStyleId': bank.get('fadeStyleId'),
                             'evidence': evidence}
        levels[level_id] = {**events[event], 'levelId': level_id,
                            'evidence': {'bgmEventField': '/bgmEvent', 'file': metadata['file'],
                                         'sha256': metadata['sha256'], 'bytes': metadata['bytes'],
                                         'bankEvidence': events[event]['evidence'],
                                         'switchFields': switch_evidence(level)}}
    for stage_id, metadata in level_index['stagesById'].items():
        stages[stage_id] = levels[metadata['levelId']]
    system_events = {}
    for event in ['BACKGROUND', 'MAPHIGH', 'MAPLOW', 'DEEPMAPHIGH', 'DEEPMAPLOW', 'VARIATIONHIGH', 'VARIATIONLOW']:
        bank, evidence = resolve_bank(audio_data, 'sys.ON_ROGUELIKE_' + event + '.rogue_2')
        system_events[event] = {'bgmEvent': bank['name'], 'bank': bank['name'],
                                'intro': export_track(bank.get('intro')), 'loop': export_track(bank['loop']),
                                'volume': bank.get('volume'), 'crossfade': bank.get('crossfade'),
                                'delay': bank.get('delay'), 'fadeStyleId': bank.get('fadeStyleId'),
                                'evidence': evidence}
    selected = {'source': {'url': DATA_URL, 'sha256': sha(source_bytes), 'bytes': len(source_bytes),
                           'kind': 'original-gamedata-mirror',
                           'note': 'Same raw-data source as the canonical level import. Audio media itself is extracted from the installed local client; table revision is recorded and not asserted to be the client build.'},
                'banks': {event: value['evidence'] for event, value in {**events, **system_events}.items()},
                'levelIndex': {'file': 'data/mizuki/levels/index.json', 'sha256': sha(index_bytes), 'bytes': len(index_bytes)}}
    save('source/bank-evidence.json', (json.dumps(selected, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf8'), 'OriginalBgmBankEvidence')
    manifest = {'version': 1, 'format': 'mizuki-native-audio', 'source': 'local-client',
                'client': fx.client_version(CLIENT), 'audioDataSource': selected['source'],
                'levelIndex': selected['levelIndex'], 'bundlesSha256': bundles,
                'events': events, 'levels': levels, 'stages': stages, 'tracks': tracks,
                'systemEvents': system_events,
                'defaults': {'background': system_events['BACKGROUND'], 'route': system_events['MAPHIGH']},
                'groups': groups, 'missing': [], 'warnings': [],
                'notice': 'Battle BGM follows each original level bgmEvent; menu/map defaults use their original sys.ON_ROGUELIKE banks. Audio bytes originate in the installed client and original encoded resources are retained.'}
    write(DEST / 'manifest.json', manifest)
    print(json.dumps({'stages': len(stages), 'levels': len(levels), 'events': len(events),
                      'tracks': len(tracks), 'bundles': len(bundles), 'files': len(groups['audio']),
                      'systemEvents': len(system_events),
                      'missing': [], 'warnings': []}), flush=True)


if __name__ == '__main__':
    main()
