import concurrent.futures, json, pathlib, urllib.request, zipfile, xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = ROOT / '.tmp-mod-analysis-20261025/android-full-20261025'
DOWNLOADS = WORK / 'downloads'
DOWNLOADS.mkdir(parents=True, exist_ok=True)

def get(url, target):
    path = DOWNLOADS / target
    if path.exists() and path.stat().st_size:
        return path
    temp = path.with_suffix(path.suffix + '.part')
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Stronghold-Android-Build/1.0'}), timeout=90) as response, temp.open('wb') as out:
        while block := response.read(1024 * 1024):
            out.write(block)
    temp.replace(path)
    print(json.dumps({'downloaded': target, 'bytes': path.stat().st_size}), flush=True)
    return path

def extract(archive, directory):
    target = WORK / directory
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        z.extractall(target)
    return target

if __name__ == '__main__':
    metadata = ET.fromstring(urllib.request.urlopen('https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml', timeout=30).read())
    version = metadata.findtext('.//release')
    (WORK / 'runtime.json').write_text(json.dumps({'geckoview': version}), encoding='utf-8')
    tasks = [
        ('https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip', 'jdk17.zip', 'jdk'),
        ('https://dl.google.com/android/repository/build-tools_r35_windows.zip', 'build-tools.zip', 'build-tools'),
        ('https://dl.google.com/android/repository/platform-35_r02.zip', 'platform.zip', 'platform'),
        ('https://dl.google.com/android/repository/platform-tools-latest-windows.zip', 'platform-tools.zip', 'platform-tools'),
        (f'https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/{version}/geckoview-{version}.aar', 'geckoview.aar', None),
    ]
    def task(row):
        url, name, directory = row
        archive = get(url, name)
        if directory:
            extract(archive, directory)
        elif name == 'geckoview.aar':
            with zipfile.ZipFile(archive) as z:
                print('GECKO_MANIFEST', z.read('AndroidManifest.xml').decode('utf-8', 'replace'), flush=True)
                print('GECKO_ABIS', sorted({p.split('/')[1] for p in z.namelist() if p.startswith('jni/') and p.endswith('.so')}), flush=True)
        return name
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        for result in pool.map(task, tasks):
            print('READY', result, flush=True)
