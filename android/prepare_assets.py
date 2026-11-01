import concurrent.futures, json, os, pathlib, re, shutil, threading, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = ROOT / '.tmp-mod-analysis-20261025/android-full-20261025'
SITE = WORK / 'site'
ORIGINS = ['https://super.emiraen.top:23331', 'https://u75731.nyat.app:48335', 'https://south.emiraen.top']

def fetch_bytes(url, timeout=40):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Stronghold-Android-Builder/1.0', 'Accept-Encoding': 'identity'}), timeout=timeout) as r:
        return r.read()

def canonical(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme and parsed.scheme not in ['http', 'https']:
        return None
    p = re.sub(r'/~[^/]+/', '/', urllib.parse.unquote(parsed.path), count=1)
    if not p.startswith('/') or '..' in pathlib.PurePosixPath(p).parts or chr(92) in p or chr(0) in p:
        return None
    if p.startswith('/media/'):
        p = '/assets/audio/' + p[len('/media/'):]
        if pathlib.PurePosixPath(p).suffix.lower() not in ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav']:
            p += '.mp3'
    return p

def stage_tree(source, prefix='', exclude=None):
    for directory, dirs, files in os.walk(source):
        dirs[:] = [d for d in dirs if not d.startswith('.') and (not exclude or d not in exclude)]
        for name in files:
            p = pathlib.Path(directory) / name
            if p.is_symlink() or p.name.lower() == 'nodedata.js':
                continue
            target = SITE / prefix / p.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copyfile(p, target)

def strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from strings(v)

def main():
    SITE.mkdir(parents=True, exist_ok=True)
    stage_tree(ROOT / 'public', exclude={'dev', 'studio'})
    stage_tree(ROOT / 'data', 'data')
    stage_tree(ROOT / 'shared', 'shared')
    stage_tree(ROOT / 'server/sim', 'sim')
    (SITE / 'data.js').write_text("import {getSimData} from './sim/simdata.js';export function getData(){return getSimData()||{};}export function resetData(){}" + chr(10), encoding='utf-8')
    needed = {}
    for name in ['local-assets.json', 'local-fx.json', 'resource-preload.json', 'resource-preload.runtime.json.gz']:
        output = SITE / 'data' / name
        for origin in ORIGINS:
            try:
                output.write_bytes(fetch_bytes(origin + '/data/' + name))
                print(json.dumps({'manifest': name, 'bytes': output.stat().st_size}), flush=True)
                break
            except Exception as e:
                print(json.dumps({'manifest_source_failed': name, 'origin': origin, 'error': str(e)}), flush=True)
        if not output.exists():
            raise RuntimeError('Public manifest missing: ' + name)
    for name in ['assets.json', 'local-assets.json', 'local-fx.json', 'resource-preload.json']:
        doc = json.loads((SITE / 'data' / name).read_text(encoding='utf-8'))
        if name == 'resource-preload.json':
            for group, entries in doc['groups'].items():
                for entry in entries:
                    p = canonical(entry['url'])
                    if p:
                        needed.setdefault(p, {'source': entry['url'], 'groups': []})['groups'].append(group)
        else:
            for url in strings(doc):
                if url.startswith(('/assets/', '/fonts/', '/media/')):
                    p = canonical(url)
                    if p:
                        needed.setdefault(p, {'source': url, 'groups': []})
    missing = [(p, item) for p, item in needed.items() if not (SITE / p.lstrip('/')).is_file()]
    (WORK / 'resource-plan.json').write_text(json.dumps({'resources': needed, 'missing': missing}, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'resource_files': len(needed), 'missing_files': len(missing), 'missing_samples': missing[:5]}, ensure_ascii=False), flush=True)
    failures = []
    complete = 0
    lock = threading.Lock()
    def task(row):
        nonlocal complete
        p, item = row
        target = SITE / p.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        errors = []
        for origin in ORIGINS:
            try:
                body = fetch_bytes(origin + urllib.parse.quote(p, safe='/@!$&()*+,;=:-._~'), timeout=35)
                if not body or body[:32].lower().startswith((b'<!doctype html', b'<html')):
                    raise RuntimeError('Invalid resource body')
                target.write_bytes(body)
                break
            except Exception as e:
                errors.append(str(e))
        else:
            return {'path': p, 'errors': errors}
        with lock:
            complete += 1
            if complete % 250 == 0:
                print(json.dumps({'downloaded_resources': complete, 'total': len(missing)}), flush=True)
        return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for failure in pool.map(task, missing):
            if failure:
                failures.append(failure)
    report = {'requested': len(needed), 'downloaded': complete, 'failures': failures}
    (WORK / 'resource-download.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'resources_complete': not failures, 'downloaded': complete, 'failures': len(failures)}), flush=True)
    if failures:
        raise RuntimeError('Missing resource files: ' + str(len(failures)))

if __name__ == '__main__':
    main()
