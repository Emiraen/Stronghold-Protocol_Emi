#!/usr/bin/env python3
"""Route only cultivation.js to the existing local server; never restart the game."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

CONFIG = Path('/etc/nginx/conf.d/stronghold-emiraen.conf')
MODULE = Path('/opt/Stronghold-Protocol/public/js/screens/cultivation.js')
SERVICE = 'stronghold-secondary.service'
MARKER = '# cultivation-504: exact local module route'
ANCHOR = '# HTTP/static still transit old east; main WS does not.\n'
ROUTE = '''# cultivation-504: exact local module route
# Keep every other HTTP route and the existing WebSocket upstream unchanged.
location = /js/screens/cultivation.js {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
'''


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def atomic_write(target, body):
    st = target.stat()
    fd, temporary = tempfile.mkstemp(prefix=target.name + '.', suffix='.tmp', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, st.st_mode & 0o777)
        os.chown(temporary, st.st_uid, st.st_gid)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    before_pid = run('systemctl', 'show', SERVICE, '--property=MainPID', '--value')
    if before_pid == '0':
        raise RuntimeError('Game service is not running; no changes made')
    with urllib.request.urlopen('http://127.0.0.1:3000/js/screens/cultivation.js', timeout=8) as response:
        if response.status != 200 or response.read() != MODULE.read_bytes():
            raise RuntimeError('Local module response mismatch; no changes made')
    original = CONFIG.read_bytes()
    text = original.decode('utf-8')
    if MARKER in text:
        print(json.dumps({'status': 'already-applied', 'game_pid': before_pid}))
        return
    if text.count(ANCHOR) != 1 or 'location = /js/screens/cultivation.js' in text:
        raise RuntimeError('Unexpected nginx layout; no changes made')
    updated = text.replace(ANCHOR, ROUTE + '\n' + ANCHOR, 1).encode('utf-8')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = Path('/opt/stronghold-release-backups') / ('cultivation-504-' + stamp)
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(CONFIG, backup / CONFIG.name)
    activated = False
    try:
        atomic_write(CONFIG, updated)
        run('nginx', '-t')
        run('nginx', '-s', 'reload')
        activated = True
    except Exception:
        atomic_write(CONFIG, original)
        raise
    finally:
        after_pid = run('systemctl', 'show', SERVICE, '--property=MainPID', '--value')
        result = {'applied': activated, 'backup': str(backup),
                  'game_pid_before': before_pid, 'game_pid_after': after_pid,
                  'game_pid_unchanged': before_pid == after_pid}
        (backup / 'deployment.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result))
    if before_pid != after_pid:
        raise RuntimeError('Game PID changed externally during deployment')


if __name__ == '__main__':
    main()
