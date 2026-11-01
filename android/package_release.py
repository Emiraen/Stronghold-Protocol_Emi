"""Assemble stored assets, align and sign the universal APK without changing gameplay."""
import csv, io, json, os, pathlib, secrets, shutil, subprocess, zipfile
from prepare_assets import ROOT, WORK, SITE, canonical

RELEASE = ROOT / 'android/release'
FINAL = RELEASE / 'Stronghold-Protocol-Emi41-20261025-Full-Universal.apk'
TOOLS = WORK / 'sdk/build-tools/35.0.0'
JDK = next((WORK / 'jdk').glob('*/bin'))

def run(args, capture=False):
    env = dict(os.environ, JAVA_HOME=str(JDK.parent))
    env['PATH'] = str(JDK) + os.pathsep + env.get('PATH', '')
    result = subprocess.run([str(a) for a in args], env=env, check=True,
                            text=True, encoding='utf-8', errors='replace',
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None)
    return result.stdout if capture else ''

def signing_key():
    private = ROOT / 'android/.private-signing'
    private.mkdir(exist_ok=True)
    if os.name == 'nt':
        user = subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'], text=True)
        sid = next(csv.reader(io.StringIO(user.strip())))[1]
        run(['icacls', private, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'], capture=True)
    else:
        private.chmod(0o700)
    password = private / 'release.pass'
    key = private / 'release.jks'
    if not password.exists():
        if key.exists():
            raise RuntimeError('Signing password missing; existing key was not modified')
        password.write_text(secrets.token_urlsafe(40), encoding='ascii')
    if not key.exists():
        env_key = 'STRONGHOLD_APK_SIGNING_PASSWORD'
        os.environ[env_key] = password.read_text(encoding='ascii').strip()
        try:
            run([JDK / 'keytool.exe', '-genkeypair', '-keystore', key, '-storetype', 'JKS',
                 '-alias', 'stronghold-release', '-keyalg', 'RSA', '-keysize', '3072',
                 '-validity', '36500', '-dname', 'CN=Stronghold Protocol Emi, OU=Android, O=Emi',
                 '-storepass:env', env_key, '-keypass:env', env_key])
        finally:
            os.environ.pop(env_key, None)
    return key, password

def assemble():
    base = ROOT / 'android/app/build/outputs/apk/release/app-release-unsigned.apk'
    unsigned = WORK / 'full-unsigned.apk'
    index = json.loads((WORK / 'bundle-index.json').read_text(encoding='utf-8'))
    with zipfile.ZipFile(base) as source, zipfile.ZipFile(unsigned, 'w', allowZip64=False, strict_timestamps=False) as target:
        for entry in source.infolist():
            if entry.filename.upper().startswith('META-INF/') and entry.filename.upper().endswith(('.SF', '.RSA', '.DSA', '.EC', 'MANIFEST.MF')):
                continue
            with source.open(entry) as src, target.open(entry, 'w') as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
        target.write(WORK / 'bundle-index.json', 'assets/bundle-index.json', compress_type=zipfile.ZIP_STORED)
        for number, (path, info) in enumerate(sorted(index['files'].items()), 1):
            file = SITE / path.lstrip('/')
            if file.stat().st_size != info['bytes']:
                raise RuntimeError('Staging asset changed: ' + path)
            target.write(file, 'assets/site' + path, compress_type=zipfile.ZIP_STORED)
            if number % 7000 == 0:
                print(json.dumps({'packaged':number,'total':len(index['files'])}), flush=True)
    return unsigned

def verify():
    signatures = run([TOOLS / 'apksigner.bat', 'verify', '--verbose', '--min-sdk-version', '21', FINAL], capture=True)
    print(signatures, flush=True)
    for version in [1, 2, 3]:
        if not any('v' + str(version) + ' scheme' in line and line.endswith('true') for line in signatures.splitlines()):
            raise RuntimeError('Missing APK signature v' + str(version))
    run([TOOLS / 'zipalign.exe', '-c', '-P', '16', '4', FINAL])
    badging = run([TOOLS / 'aapt.exe', 'dump', 'badging', FINAL], capture=True)
    selected = [line for line in badging.splitlines() if line.startswith(('package:', 'sdkVersion:', 'targetSdkVersion:', 'native-code:'))]
    print('\n'.join(selected), flush=True)
    assert "sdkVersion:'21'" in badging
    for abi in ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']:
        assert abi in next(line for line in selected if line.startswith('native-code:'))
    with zipfile.ZipFile(FINAL) as z:
        index = json.loads(z.read('assets/bundle-index.json'))
        entries = {entry.filename:entry for entry in z.infolist()}
        for path, info in index['files'].items():
            entry = entries.get('assets/site' + path)
            assert entry is not None and entry.file_size == info['bytes'], path
            assert entry.compress_type == zipfile.ZIP_STORED, path
        preload = json.loads(z.read('assets/site/data/resource-preload.json'))
        missing = [item['url'] for group in preload['groups'].values() for item in group if canonical(item['url']) not in index['files']]
        assert not missing, missing[:10]
        relics = [p for p in index['files'] if '/relics/' in p and p.endswith('.png')]
        intros = [p for p in index['files'] if p.startswith('/assets/annihilation-intro/')]
        assert len(relics) >= 87 and len(intros) >= 10
        assert '/data/relics.json' in index['files']
        for path in index['files']:
            parts = pathlib.PurePosixPath(path).parts
            assert not any(part.startswith('.') for part in parts), path
            assert not path.endswith(('.jks','.pem','.key','.pass','.env','.sqlite','.db','.log')), path
            assert not path.startswith(('/admin/','/dev/','/studio/')), path
        report = json.loads((WORK / 'bundle-report.json').read_text(encoding='utf-8'))
        report.update(apk=str(FINAL), apk_bytes=FINAL.stat().st_size,
                      android_min='5.0 (API 21)', abis=['armeabi-v7a','arm64-v8a','x86','x86_64'],
                      signatures=['v1','v2','v3'], stored_site_files=len(index['files']),
                      relic_pngs=len(relics), intro_files=len(intros), device_tested=False,
                      gameplay_modified=False, server_restarted=False)
    (RELEASE / 'build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)

def sign(aligned, key, password):
    env_key = 'STRONGHOLD_APK_SIGNING_PASSWORD'
    os.environ[env_key] = password.read_text(encoding='ascii').strip()
    try:
        run([TOOLS / 'apksigner.bat', 'sign', '--ks', key, '--ks-key-alias', 'stronghold-release',
             '--ks-pass', 'env:' + env_key, '--key-pass', 'env:' + env_key,
             '--min-sdk-version', '21', '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
             '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false', '--out', FINAL, aligned])
    finally:
        os.environ.pop(env_key, None)

def main():
    RELEASE.mkdir(exist_ok=True)
    key, password = signing_key()
    unsigned = assemble()
    aligned = WORK / 'full-aligned.apk'
    run([TOOLS / 'zipalign.exe', '-P', '16', '-f', '4', unsigned, aligned])
    sign(aligned, key, password)
    verify()

if __name__ == '__main__': main()
