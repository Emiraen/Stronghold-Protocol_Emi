import concurrent.futures, json, pathlib, re, urllib.request
from prepare_assets import WORK, SITE

def main():
    css = (WORK / 'webfonts.css').read_text(encoding='utf-8')
    urls = sorted(set(re.findall(r'url\((https://fonts\.gstatic\.com/[^)]+)\)', css)))
    folder = WORK / 'webfonts'
    folder.mkdir(exist_ok=True)
    def download(url):
        name = url.rsplit('/',1)[1]
        output = folder / name
        if not output.is_file():
            with urllib.request.urlopen(url, timeout=45) as response:
                output.write_bytes(response.read())
        return name, output.stat().st_size
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(download, urls))
    for url in urls:
        css = css.replace(url, '/fonts/web/' + url.rsplit('/',1)[1])
    (folder / 'webfonts.css').write_text(css, encoding='utf-8')
    print(json.dumps({'webfont_files':len(results),'bytes':sum(size for _,size in results)}),flush=True)

if __name__ == '__main__': main()
