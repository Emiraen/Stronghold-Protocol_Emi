"""Build independently importable, bounded SPPACK03 files from an existing pack and the current catalogue."""
import argparse,collections,datetime,gzip,hashlib,json,pathlib,re,struct,urllib.parse

GROUPS=['required','optional','voice']
def canonical(url):
 p=urllib.parse.urlparse(url).path
 p=re.sub(r'^/(assets|media|fonts)/~[a-f0-9]{16}/',r'/\1/',p)
 if p.startswith('/assets/audio/'):
  p='/media/'+p[len('/assets/audio/'):]
  p=re.sub(r'\.(mp3|m4a|aac|ogg|oga|opus|wav)$','',p,flags=re.I)
 return p

def build(source,manifestFile,output,project,maxBytes=450_000_000,stamp='20261101'):
 assert 1_000_000 <= maxBytes < 500_000_000
 output.mkdir(parents=True,exist_ok=True)
 manifest=json.loads(manifestFile.read_text(encoding='utf8'));packed={}
 with source.open('rb') as old:
  prefix=old.read(12);assert prefix[:8]==b'SPPACK03'
  records=json.loads(old.read(struct.unpack('<I',prefix[8:])[0]))['resources'];offset=old.tell()
  for record in records:packed[canonical(record['url'])]=(record,offset);offset+=record['storedBytes']
  assert offset==source.stat().st_size
  parts=[];coverage=set();newgroups={};reused=0;rebuilt=0
  for group in GROUPS:
   rows=[];seen=set();part=[];payloadBytes=0;headerBytes=0;partNumber=0
   def flush():
    nonlocal part,payloadBytes,headerBytes,partNumber
    if not part:return
    partNumber+=1;name=f'resource-{group}-part-{partNumber:02d}-{stamp}.sprpack';target=output/name
    header=json.dumps({'schema':3,'resources':[r['record'] for r in part]},ensure_ascii=False,separators=(',',':')).encode()
    assert len(header)<16*1024*1024
    prefix=b'SPPACK03'+struct.pack('<I',len(header));total=12+len(header)+payloadBytes;assert total<=maxBytes
    sha=hashlib.sha256();at=12+len(header)
    with target.open('wb') as f:
     for data in [prefix,header]:f.write(data);sha.update(data)
     for row in part:
      record=row['record'];rows.append({**row['item'],'pack':{'file':name,'offset':at,'storedBytes':record['storedBytes'],'encoding':record['encoding'],'total':total}})
      if 'offset' in row:
       old.seek(row['offset']);left=record['storedBytes']
       while left:
        b=old.read(min(1024*1024,left));assert b;f.write(b);sha.update(b);left-=len(b)
      else:f.write(row['data']);sha.update(row['data'])
      at+=record['storedBytes']
    assert target.stat().st_size==at==total
    parts.append({'file':name,'group':group,'bytes':total,'resources':len(part),'sha256':sha.hexdigest()})
    print(json.dumps(parts[-1]),flush=True);part=[];payloadBytes=0;headerBytes=0
   for raw in manifest['groups'][group]:
    key=canonical(raw['url'])
    if key in seen:continue
    seen.add(key);assert key not in coverage,'Duplicate catalogue resource '+key;coverage.add(key)
    item={k:v for k,v in raw.items() if k not in ['pack','transport']};previous=packed.get(key)
    if previous and all(previous[0].get(k)==item.get(k) for k in ['version','bytes','type']):
     record={**previous[0],'url':item['url']};row={'item':item,'record':record,'offset':previous[1]};reused+=1
    else:
     path=urllib.parse.unquote(key)
     candidates=[project/path.lstrip('/')] if path.startswith('/data/') else [project/'public'/path.lstrip('/')]
     if path.startswith('/media/'):candidates=[project/'public/assets/audio'/(path[7:]+e) for e in ['.mp3','.m4a','.aac','.ogg','.oga','.opus','.wav']]
     file=next((p for p in candidates if p.is_file() and p.stat().st_size==item['bytes']),None)
     assert file,'Source missing '+item['url'];data=file.read_bytes();assert hashlib.sha256(data).hexdigest()==item['version']
     compressed=gzip.compress(data,compresslevel=6,mtime=0);encoding='gzip' if len(compressed)<len(data)*.98 else 'identity';body=compressed if encoding=='gzip' else data
     record={**item,'encoding':encoding,'storedBytes':len(body)};row={'item':item,'record':record,'data':body};rebuilt+=1
    estimate=len(json.dumps(record,ensure_ascii=False,separators=(',',':')).encode())+1
    if part and 64+headerBytes+estimate+payloadBytes+record['storedBytes']>maxBytes:flush()
    assert 64+estimate+record['storedBytes']<maxBytes,'Single asset exceeds package cap '+key
    part.append(row);payloadBytes+=record['storedBytes'];headerBytes+=estimate
   flush();newgroups[group]=rows
 manifest.update({'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),
  'source':'complete-split-packs-under-500MB','groups':newgroups,'splitPacks':parts})
 content=json.dumps(manifest,ensure_ascii=False,separators=(',',':')).encode();compressed=gzip.compress(content,compresslevel=9,mtime=0)
 for name in ['resource-preload.json','resource-preload.local.json','resource-preload.json.gz','resource-preload.local.json.gz','resource-preload.runtime.json.gz']:
  (output/name).write_bytes(compressed if name.endswith('.gz') else content)
 report={'format':'SPPACK03','limitBytes':maxBytes,'resources':len(coverage),'bytes':sum(p['bytes'] for p in parts),'parts':parts,'reused':reused,'rebuilt':rebuilt,
  'manifestSHA256':hashlib.sha256(content).hexdigest(),'manifestGzipSHA256':hashlib.sha256(compressed).hexdigest()}
 (output/'split-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
 (output/'导入说明.txt').write_text('每个 .sprpack 都是独立、可直接导入的完整资源分包，每包小于 500 MB。\n在游戏设置的资源预载页面依次导入本目录的所有分包即可。无需合并文件，可按任意顺序导入，重复导入会复用已有资源。\n完整资源共 '+str(len(parts))+' 包、'+str(len(coverage))+' 个条目，包含必需资源、个性化资源及语音。\n',encoding='utf8')
 return report

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--source',type=pathlib.Path,required=True);p.add_argument('--manifest',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--project',type=pathlib.Path,default=pathlib.Path.cwd());p.add_argument('--max-bytes',type=int,default=450_000_000);a=p.parse_args()
 print(json.dumps(build(a.source,a.manifest,a.out,a.project,a.max_bytes)),flush=True)
