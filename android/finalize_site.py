import json, mimetypes, pathlib, re, shutil, urllib.parse
from prepare_assets import ROOT, WORK, SITE, canonical

MAIN = 'https://super.emiraen.top:23331'
SECONDARY = 'https://emiraen.top'
def replace_once(source, old, new, label):
    if source.count(old) != 1:
        raise RuntimeError('Unexpected client anchor: ' + label)
    return source.replace(old, new, 1)

def main():
    webfonts = WORK / 'webfonts'
    if not (webfonts / 'webfonts.css').is_file():
        raise RuntimeError('Download the public webfonts before finalizing')
    shutil.copytree(webfonts, SITE / 'fonts/web', dirs_exist_ok=True)
    for name in ['sp-ws-check-20261014.html', 'legacy-migration.html']:
        (SITE / name).unlink(missing_ok=True)
    aliases = {}
    preload = json.loads((SITE / 'data/resource-preload.json').read_text(encoding='utf-8'))
    for group, entries in preload['groups'].items():
        for entry in entries:
            target = canonical(entry['url'])
            if not target or not (SITE / target.lstrip('/')).is_file():
                raise RuntimeError('Missing packaged resource: ' + entry['url'])
            raw = urllib.parse.unquote(urllib.parse.urlsplit(entry['url']).path)
            if raw != target:
                aliases[raw] = target
            if target.startswith('/assets/audio/'):
                stem = '/media/' + target[len('/assets/audio/'):]
                for suffix in ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav']:
                    if stem.endswith(suffix): stem = stem[:-len(suffix)]; break
                aliases[stem] = target
    for path in (SITE / 'assets/audio').rglob('*'):
        if path.is_file():
            target = '/' + path.relative_to(SITE).as_posix()
            aliases.setdefault('/media/' + path.relative_to(SITE / 'assets/audio').with_suffix('').as_posix(), target)
    origins = [MAIN, SECONDARY, 'https://south.emiraen.top', 'https://u75731.nyat.app:48335', 'https://cdn.emiraen.top']
    paths = sorted(set('/' + p.relative_to(SITE).as_posix() for p in SITE.rglob('*') if p.is_file()) | {'/apk-bootstrap.js'})
    config = {'paths': paths, 'aliases': aliases, 'origins': origins, 'main': MAIN, 'secondary': SECONDARY}
    bootstrap = r"""(function(){'use strict';
const config=CONFIG;
const paths=new Set(config.paths),aliases=config.aliases;
function local(url){try{const u=new URL(String(url),location.href);if(u.origin!==location.origin&&!config.origins.includes(u.origin))return null;let p=decodeURIComponent(u.pathname).replace(/\/~[^/]+\//,'/');p=aliases[p]||p;return paths.has(p)?new URL(p,location.origin).href:null;}catch(e){return null;}}
Object.defineProperty(globalThis,'__STRONGHOLD_APK__',{value:Object.freeze({local,main:config.main,secondary:config.secondary}),configurable:false});
const token=new URLSearchParams(location.search).get('native');if(token){sessionStorage.setItem('apkNativeToken',token);history.replaceState(history.state,'',location.pathname+location.hash);}
const probeToken=token||sessionStorage.getItem('apkNativeToken');if(probeToken)fetch('/__apk/ready?token='+encodeURIComponent(probeToken)).catch(function(){});
})();""".replace('CONFIG', json.dumps(config, ensure_ascii=False, separators=(',', ':')))
    (SITE / 'apk-bootstrap.js').write_text(bootstrap, encoding='utf-8')
    index = (ROOT / 'public/index.html').read_text(encoding='utf-8')
    index = replace_once(index, '<head>', '<head>\n  <script src="/apk-bootstrap.js"></script>', 'head')
    index = index.replace('initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover', 'initial-scale=1, viewport-fit=cover')
    index = re.sub(r'<link[^>]+rel="(?:preconnect|dns-prefetch)"[^>]*>', '', index)
    index = re.sub(r'<link\s+rel="stylesheet"\s+media="print"\s+onload="this.media=\'all\'"\s+href="https://fonts\.googleapis\.com/[^\"]+"\s*/>', '<link rel="stylesheet" href="/fonts/web/webfonts.css" />', index)
    if 'fonts.googleapis.com' in index:
        raise RuntimeError('An external webfont link remains')
    (SITE / 'index.html').write_text(index, encoding='utf-8')
    servers = (ROOT / 'public/js/servers.js').read_text(encoding='utf-8')
    servers = replace_once(servers, "return entry.origin.replace(/^http/, 'ws') + '/ws';", "const origin = globalThis.__STRONGHOLD_APK__ && entry.id === 'main' ? globalThis.__STRONGHOLD_APK__.main : entry.origin;\n  return origin.replace(/^http/, 'ws') + '/ws';", 'server socket')
    (SITE / 'js/servers.js').write_text(servers, encoding='utf-8')
    resource = (ROOT / 'public/js/resourceCache.js').read_text(encoding='utf-8')
    resource = replace_once(resource, 'export async function fetchResourceData(url, options = {}, { requiredOnline = false } = {}) {', "export async function fetchResourceData(url, options = {}, { requiredOnline = false } = {}) {\n  const bundled = globalThis.__STRONGHOLD_APK__?.local(url);\n  if (bundled) return fetch(bundled, { ...options, credentials: 'same-origin', mode: 'same-origin' });", 'resource fetch')
    resource = replace_once(resource, 'async function fetchManifest() {', "async function fetchManifest() {\n  if (globalThis.__STRONGHOLD_APK__) return fetch('/data/resource-preload.json').then(response => response.json());", 'manifest')
    resource = replace_once(resource, 'async function ensureSessionReady() {', "async function ensureSessionReady() {\n  if (globalThis.__STRONGHOLD_APK__) return ensureReady();", 'session ready')
    resource = replace_once(resource, 'async function prefetchRequired(urls, { priority = 1 } = {}) {', "async function prefetchRequired(urls, { priority = 1 } = {}) {\n  if (globalThis.__STRONGHOLD_APK__) return urls.filter(Boolean).every(url => !!globalThis.__STRONGHOLD_APK__.local(url));", 'prefetch')
    resource = replace_once(resource, 'export async function cachedFetch(url, opts = {}) {', "export async function cachedFetch(url, opts = {}) {\n  const bundled = globalThis.__STRONGHOLD_APK__?.local(url);\n  if (bundled) return fetch(bundled, opts);", 'cached fetch')
    resource = replace_once(resource, 'export async function acquireResourceUrl(url, { cachedOnly = false } = {}) {', "export async function acquireResourceUrl(url, { cachedOnly = false } = {}) {\n  const bundled = globalThis.__STRONGHOLD_APK__?.local(url);\n  if (bundled) return { url: bundled, release() {} };", 'resource urls')
    resource = replace_once(resource, '      // Let foreground image reads enter IndexedDB before the startup-wide cache scan.', "      if (globalThis.__STRONGHOLD_APK__) {\n        for (const item of entries.values()) if (globalThis.__STRONGHOLD_APK__.local(item.url)) { complete.add(item.key); savedBytes.set(item.key, item.bytes); }\n        progress(); ready = state.required.done === state.required.total; checkedRevision = revision; state.source = 'APK 内置全资源，无需重复下载。'; state.cacheRevision++; return ready;\n      }\n      // Let foreground image reads enter IndexedDB before the startup-wide cache scan.", 'inventory')
    resource = resource.replace('isCached(url) { const item = localItem(url);', 'isCached(url) { if (globalThis.__STRONGHOLD_APK__?.local(url)) return true; const item = localItem(url);')
    (SITE / 'js/resourceCache.js').write_text(resource, encoding='utf-8')
    guard = (ROOT / 'public/js/ui/buildGuard.js').read_text(encoding='utf-8')
    guard = replace_once(guard, 'export function startBuildGuard(o = {}) {', "export function startBuildGuard(o = {}) {\n  if (globalThis.__STRONGHOLD_APK__) return { stop() {}, check: async () => ({ status: 'current', build: 'apk-Emi41-20261025' }), stale: () => false, known: () => 'apk-Emi41-20261025' };", 'apk build guard')
    (SITE / 'js/ui/buildGuard.js').write_text(guard, encoding='utf-8')
    files = {}
    types = {'.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.css':'text/css', '.html':'text/html', '.atlas':'text/plain', '.skel':'application/octet-stream', '.wasm':'application/wasm', '.obj':'text/plain', '.ogg':'audio/ogg', '.mp3':'audio/mpeg'}
    for path in SITE.rglob('*'):
        if path.is_file():
            rel = '/' + path.relative_to(SITE).as_posix()
            files[rel] = {'bytes': path.stat().st_size, 'mime': types.get(path.suffix.lower(), mimetypes.guess_type(path.name)[0] or 'application/octet-stream')}
    index = {'files': files, 'aliases': aliases}
    (WORK / 'bundle-index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    report = {'client_version':'0.2.1', 'emi_build':41, 'files':len(files), 'bytes':sum(f['bytes'] for f in files.values()), 'preload_entries':sum(len(entries) for entries in preload['groups'].values()), 'preload_missing':0, 'aliases':len(aliases), 'main_server':MAIN, 'secondary_server':SECONDARY}
    (WORK / 'bundle-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))

if __name__ == '__main__': main()
