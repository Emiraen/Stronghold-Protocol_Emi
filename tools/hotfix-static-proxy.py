#!/usr/bin/env python3
"""Remove cross-region static requests without changing APIs or game processes."""
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request

CONFIG = Path('/etc/nginx/conf.d/stronghold-emiraen.conf')
SNIPPET = Path('/etc/nginx/snippets/stronghold-local-static-proxy.conf')
SERVICE = 'stronghold-secondary.service'
MARKER = '# static-504: local application resource routes'
ANCHOR = '# HTTP/static still transit old east; main WS does not.\n'
PREFIXES = ('/js/', '/css/', '/vendor/', '/shared/', '/sim/', '/data/',
            '/i18n/', '/fonts/', '/icons/', '/packs/', '/guide/')
EXACT = ('/data.js', '/manifest.json', '/announcement.json', '/legacy-migration.html')
CHECKS = ('/js/net.js', '/js/servers.js', '/js/resourceCache.js',
          '/js/screens/title.js', '/js/screens/cultivation.js',
          '/js/ui/resourcePreload.js', '/js/ui/pluginTag.js',
          '/shared/plugins/dataUtils.js', '/shared/plugins/errors.js',
          '/shared/plugins/notices.js', '/css/east-floating-panels.css',
          '/sim/content/annihilationDevices.js', '/data.js',
          '/vendor/preact.module.js', '/manifest.json', '/data/resource-preload.json')
PROXY = b'''# Application static routes only; preserve Node validation and response headers.
proxy_pass http://stronghold_game_backend;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_connect_timeout 3s;
proxy_read_timeout 60s;
proxy_buffering on;
'''


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=20).stdout.strip()


def atomic_write(target, body):
    stat = target.stat() if target.exists() else None
    fd, name = tempfile.mkstemp(prefix=target.name + '.', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, (stat.st_mode & 0o777) if stat else 0o644)
        if stat:
            os.chown(name, stat.st_uid, stat.st_gid)
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def check(base, route):
    request = urllib.request.Request(base + route, method='HEAD')
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return {'path': route, 'status': response.status,
                    'type': response.headers.get('Content-Type', '')}
    except urllib.error.HTTPError as error:
        return {'path': route, 'status': error.code}


def check_all(base):
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(lambda route: check(base, route), CHECKS))
    if any(row['status'] != 200 for row in rows):
        raise RuntimeError('Resource check failed: ' + json.dumps(rows))
    for row in rows:
        if row['path'].endswith('.js') and 'javascript' not in row['type']:
            raise RuntimeError('Unexpected script MIME: ' + json.dumps(row))
    return rows


def protected_blocks(text):
    return [re.search(r'location = ' + re.escape(route) + r' \{[^}]*\}', text).group(0)
            for route in ('/ws', '/api/servers', '/api/profile-service')]


def main():
    pid_before = run('systemctl', 'show', SERVICE, '--property=MainPID', '--value')
    if pid_before == '0':
        raise RuntimeError('Game is not running; no changes made')
    original = CONFIG.read_bytes()
    text = original.decode('utf-8')
    if MARKER in text:
        print(json.dumps({'status': 'already-applied', 'game_pid': pid_before}))
        return
    if text.count(ANCHOR) != 1 or not re.search(r'upstream stronghold_game_backend\s*\{\s*server 127\.0\.0\.1:3000;', text):
        raise RuntimeError('Unexpected proxy configuration; no changes made')
    old_snippet = SNIPPET.read_bytes() if SNIPPET.exists() else None
    if old_snippet is not None and old_snippet != PROXY:
        raise RuntimeError('Unexpected preexisting snippet; no changes made')
    routes = []
    for kind, paths in (('^~', PREFIXES), ('=', EXACT)):
        for route in paths:
            if re.search(r'location\s+(?:(?:\^~|=)\s+)?' + re.escape(route) + r'\s*\{', text):
                raise RuntimeError('Conflicting location: ' + route)
            routes.append('location ' + kind + ' ' + route + ' {\n    include ' + str(SNIPPET) + ';\n}\n')
    updated = text.replace(ANCHOR, MARKER + '\n' + ''.join(routes) + '\n' + ANCHOR, 1)
    if protected_blocks(text) != protected_blocks(updated):
        raise RuntimeError('Protected routes changed; no changes made')
    check_all('http://127.0.0.1:3000')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = Path('/opt/stronghold-release-backups') / ('static-504-' + stamp)
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(CONFIG, backup / CONFIG.name)
    if SNIPPET.exists():
        shutil.copy2(SNIPPET, backup / SNIPPET.name)
    shutil.copy2(Path(__file__), backup / 'hotfix-static-proxy.py')
    activated = False
    try:
        atomic_write(SNIPPET, PROXY)
        atomic_write(CONFIG, updated.encode('utf-8'))
        run('nginx', '-t')
        run('nginx', '-s', 'reload')
        activated = True
        results = check_all('https://emiraen.top')
        if check('https://emiraen.top', '/sim/nodedata.js')['status'] != 404:
            raise RuntimeError('Private simulation module must remain inaccessible')
    except Exception:
        atomic_write(CONFIG, original)
        if activated:
            run('nginx', '-t')
            run('nginx', '-s', 'reload')
        if old_snippet is None:
            SNIPPET.unlink(missing_ok=True)
        else:
            atomic_write(SNIPPET, old_snippet)
        print(json.dumps({'rolled_back': True, 'backup': str(backup)}), flush=True)
        raise
    pid_after = run('systemctl', 'show', SERVICE, '--property=MainPID', '--value')
    result = {'applied': True, 'backup': str(backup), 'resources': results,
              'api_and_ws_routes_unchanged': True, 'private_module_status': 404,
              'game_pid_before': pid_before, 'game_pid_after': pid_after,
              'game_pid_unchanged': pid_before == pid_after}
    (backup / 'deployment.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result), flush=True)
    if pid_before != pid_after:
        raise RuntimeError('Game PID changed externally during the update')


if __name__ == '__main__':
    main()
