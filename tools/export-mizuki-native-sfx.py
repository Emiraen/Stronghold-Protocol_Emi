#!/usr/bin/env python3
"""Restore the mode's complete selected SFX banks from exact native containers.

Run build-mizuki-native-sfx-selection.mjs first. Existing SFX remain in place;
missing native clips are decoded at their original PCM format, with the encoded
FSB bytes retained. The final manifest is written only from files that exist.
"""
from pathlib import Path
from collections import defaultdict
from urllib.parse import quote, unquote
import argparse
import gc
import hashlib
import io
import json
import sys
import wave

ROOT = Path(__file__).resolve().parent.parent
TASK = ROOT / '.cache/mizuki-native-sfx'
DEST = ROOT / 'public/assets/mizuki/native-sfx'
PREFIX = '/assets/mizuki/native-sfx/'
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
import aklz4  # noqa: F401
import UnityPy
from UnityPy.helpers.ResourceReader import get_resource_data


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')


def encoded_url(url):
    return quote(unquote(url), safe='/_.-')


def file_record(path, url, kind, **metadata):
    data = path.read_bytes()
    return {'path': encoded_url(url), 'bytes': len(data), 'sha256': digest(data), 'kind': kind, **metadata}


def audio_bytes(clip):
    if clip.m_AudioData:
        return bytes(clip.m_AudioData)
    if not clip.m_Resource:
        raise ValueError('AudioClip has no native audio resource')
    resource = clip.m_Resource
    return get_resource_data(resource.m_Source, clip.object_reader.assets_file, resource.m_Offset, resource.m_Size)


def export(selection):
    index = read(TASK / 'client-sfx-containers.json')
    client = Path(index['root'])
    records_path = TASK / 'native-export-records.json'
    records = read(records_path) if records_path.exists() else {}
    by_bundle = defaultdict(list)
    for asset, entry in selection['resources'].items():
        canonical = ROOT / 'public' / unquote(entry['canonicalUrl']).lstrip('/')
        if canonical.is_file():
            continue
        previous = records.get(asset)
        if previous and (ROOT / 'public' / unquote(previous['path']).lstrip('/')).is_file():
            continue
        native = entry.get('nativeContainer')
        if native:
            by_bundle[native['bundle']].append((asset, entry, native))
    print(json.dumps({'nativeClips': sum(map(len, by_bundle.values())), 'bundles': len(by_bundle)}), flush=True)
    failures = []
    for number, (bundle, entries) in enumerate(sorted(by_bundle.items()), 1):
        env = UnityPy.load(str(client / bundle))
        bundle_sha = digest((client / bundle).read_bytes())
        completed = 0
        for asset, entry, native in entries:
            try:
                pointer = env.container[native['container']]
                obj = pointer.deref() if hasattr(pointer, 'deref') else pointer
                if obj.type.name != 'AudioClip' or str(obj.path_id) != str(native['pathId']):
                    raise ValueError('native container identity changed')
                clip = obj.read()
                original = audio_bytes(clip)
                samples = clip.samples
                if len(samples) != 1:
                    raise ValueError('expected a single native sound sample')
                decoded = next(iter(samples.values()))
                if decoded[:4] != b'RIFF':
                    raise ValueError('native decoder did not return PCM WAV')
                with wave.open(io.BytesIO(decoded), 'rb') as pcm:
                    params = pcm.getparams()
                if params.nchannels != clip.m_Channels or params.framerate != clip.m_Frequency:
                    raise ValueError('decoded channel count or sample rate differs from source')
                if params.sampwidth * 8 != clip.m_BitsPerSample:
                    raise ValueError('decoded PCM bit depth differs from source')
                relative = Path(entry['canonicalPath']).with_suffix('.wav').as_posix()
                playable = DEST / 'tracks' / relative
                playable.parent.mkdir(parents=True, exist_ok=True)
                playable.write_bytes(decoded)
                original_relative = Path(entry['canonicalPath']).with_suffix('.fsb').as_posix()
                original_path = DEST / 'raw' / original_relative
                original_path.parent.mkdir(parents=True, exist_ok=True)
                original_path.write_bytes(original)
                original_record = file_record(original_path, PREFIX + 'raw/' + original_relative,
                                              'OriginalAudioResource', type='application/octet-stream')
                records[asset] = file_record(playable, PREFIX + 'tracks/' + relative, 'PCM_WAV', type='audio/wav',
                    asset=entry['asset'], sampleRate=params.framerate, channels=params.nchannels,
                    bitsPerSample=params.sampwidth * 8, frames=params.nframes,
                    duration=params.nframes / params.framerate,
                    originalCompressionFormat=int(clip.m_CompressionFormat), original=original_record,
                    source={'bundle': bundle, 'sha256': bundle_sha, 'container': native['container'],
                            'pathId': native['pathId'], 'cab': native['cab']})
                completed += 1
            except Exception as exc:
                failure = {'asset': entry['asset'], 'bundle': bundle, 'error': str(exc)}
                failures.append(failure)
                print(json.dumps({'failed': failure}, ensure_ascii=False), flush=True)
        save(records_path, records)
        print(json.dumps({'bundle': bundle, 'progress': f'{number}/{len(by_bundle)}',
                          'clips': completed, 'totalClips': len(records)}, ensure_ascii=False), flush=True)
        del env
        gc.collect()
    save(TASK / 'native-export-failures.json', failures)
    return records


def retain_source_evidence(records):
    """Keep encoded extraction evidence outside the runtime file inventory."""
    changed = False
    for record in records.values():
        original = record.get('original')
        if not original or not original['path'].startswith(PREFIX + 'original/'):
            continue
        relative = unquote(original['path'][len(PREFIX + 'original/'):])
        previous = (DEST / 'original' / relative).resolve()
        target = (DEST / 'raw' / relative).resolve()
        if not previous.is_relative_to((DEST / 'original').resolve()) or not target.is_relative_to((DEST / 'raw').resolve()):
            raise ValueError('encoded evidence path escapes the mode resource directory')
        if previous.is_file():
            if target.exists():
                raise FileExistsError(f'encoded evidence target already exists: {target}')
            target.parent.mkdir(parents=True, exist_ok=True)
            previous.rename(target)
        if not target.is_file():
            raise FileNotFoundError(f'encoded evidence is missing: {target}')
        original['path'] = encoded_url(PREFIX + 'raw/' + relative)
        changed = True
    if changed:
        save(TASK / 'native-export-records.json', records)


def finalize(selection, records):
    retain_source_evidence(records)
    replacements, files, assets, missing = {}, {}, {}, []
    for asset, entry in selection['resources'].items():
        canonical = ROOT / 'public' / unquote(entry['canonicalUrl']).lstrip('/')
        if canonical.is_file():
            record = file_record(canonical, entry['canonicalUrl'], 'ExistingSFX', type='audio/mpeg', asset=entry['asset'])
        else:
            record = records.get(asset)
            if not record or not (ROOT / 'public' / unquote(record['path']).lstrip('/')).is_file():
                missing.append({'asset': entry['asset'], 'canonicalPath': entry['canonicalPath']})
                continue
        url = record['path']
        files[url] = record
        replacements[entry['url']] = url
        replacements[entry['canonicalUrl']] = url
        assets[asset] = {'asset': entry['asset'], 'canonicalPath': entry['canonicalPath'], 'path': url}

    def rewrite(value):
        if isinstance(value, str):
            return replacements.get(value, value)
        if isinstance(value, dict):
            return {key: rewrite(child) for key, child in value.items()}
        if isinstance(value, list):
            return [rewrite(child) for child in value]
        return value

    decoded_clips = sum(record.get('kind') == 'PCM_WAV' for record in files.values())
    report = {**selection['report'], 'playableResources': len(assets),
              'nativeDecodedClips': decoded_clips, 'indexedFiles': len(files), 'missing': missing}
    manifest = {'schema': 1, 'format': 'mizuki-native-sfx',
        'source': {**selection['source'], 'nativeClient': read(TASK / 'client-sfx-containers.json')['client'],
                   'quality': 'Existing SFX preserved. Missing clips decoded from exact native containers without lossy encoding; original encoded resources retained.'},
        'audio': rewrite(selection['audio']), 'files': files, 'assets': assets,
        'banks': rewrite(selection['banks']), 'unitEvidence': selection['unitEvidence'],
        'coverage': report, 'missing': missing}
    save(TASK / 'export-report.json', report)
    if missing:
        save(TASK / 'manifest-incomplete.json', manifest)
        print(json.dumps({'incomplete': missing, 'playableResources': len(assets)}, ensure_ascii=False), flush=True)
        return 1
    save(DEST / 'manifest.json', manifest)
    print(json.dumps({'complete': True, 'playableResources': len(assets), 'nativeDecodedClips': decoded_clips,
                      'indexedFiles': len(files), 'mappedUnits': len(manifest['audio']['sfx']['units'])}), flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--finalize-only', action='store_true')
    args = parser.parse_args()
    selection = read(TASK / 'selection.json')
    records = read(TASK / 'native-export-records.json') if args.finalize_only else export(selection)
    return finalize(selection, records)


if __name__ == '__main__':
    sys.exit(main())
