#!/usr/bin/env node
// Index installed LAN resources without downloading or replacing any art.
// node tools/build-local-resource-preload.mjs [--root path]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { splitHashedPath } from '../shared/assetPaths.js';
import { AUDIO_EXTS } from '../shared/media.js';
const args=process.argv.slice(2);
if(args.length && (args.length!==2||args[0]!=='--root'))throw Error('Usage: node tools/build-local-resource-preload.mjs [--root path]');
const root=path.resolve(args[1]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const input=path.join(root,'data/resource-preload.json'),target=path.join(root,'data/resource-preload.local.json');
const original=JSON.parse(await fsp.readFile(input,'utf8'));
if(original.schema!==1||!['required','optional','voice'].every(group=>Array.isArray(original.groups?.[group])))throw Error('Invalid source preload manifest');
const mime={'.png':'image/png','.webp':'image/webp','.gif':'image/gif','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp3':'audio/mpeg','.ogg':'audio/ogg','.oga':'audio/ogg','.opus':'audio/ogg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.json':'application/json','.atlas':'text/plain','.skel':'application/octet-stream','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf'};
const stat=file=>{try{return fs.statSync(file).isFile()?fs.statSync(file):null;}catch{return null;}};
function resolveInstalled(url){
 let parsed;try{parsed=new URL(url,'http://localhost');}catch{return null;}
 let pathname;try{pathname=decodeURIComponent(splitHashedPath(parsed.pathname).path);}catch{return null;}
 if(pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').some(part=>part==='..'||part==='.'||part.startsWith('.')))return null;
 if(pathname.startsWith('/media/')){
  const parts=pathname.slice('/media/'.length).split('/').filter(Boolean);if(!parts.length||pathname.endsWith('/'))return null;
  const last=parts.pop(),given=path.extname(last).toLowerCase(),wanted=AUDIO_EXTS.includes(given)?given:'',stem=wanted?last.slice(0,-wanted.length):last;
  const extensions=wanted?[wanted,...AUDIO_EXTS.filter(ext=>ext!==wanted)]:AUDIO_EXTS;
  for(const ext of extensions){const file=path.join(root,'public/assets/audio',...parts,stem+ext),info=stat(file);if(info)return{file,info};}return null;
 }
 const base=pathname.startsWith('/data/')||pathname.startsWith('/shared/')?root:path.join(root,'public');
 const file=path.resolve(base,'.'+pathname);if(!file.startsWith(base+path.sep))return null;
 const info=stat(file);return info?{file,info}:null;
}
const hashes=new Map();
async function fingerprint(file){
 if(!hashes.has(file))hashes.set(file,(async()=>{const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');})());
 return hashes.get(file);
}
const groups={required:[],optional:[],voice:[]},missing=[],changed=[],tasks=[];
for(const group of Object.keys(groups))for(const entry of original.groups[group]){
 const installed=resolveInstalled(entry.url);
 if(!installed){missing.push({group,url:entry.url});continue;}
 tasks.push({group,entry,...installed});
}
let next=0;
await Promise.all(Array.from({length:8},async()=>{while(next<tasks.length){const task=tasks[next++],version=await fingerprint(task.file),bytes=task.info.size,type=mime[path.extname(task.file).toLowerCase()]||task.entry.type;
 const entry={url:task.entry.url,version,bytes,type};groups[task.group].push(entry);
 if(version!==task.entry.version||bytes!==task.entry.bytes)changed.push({group:task.group,url:task.entry.url,previousBytes:task.entry.bytes,bytes});
}}));
for(const list of Object.values(groups))list.sort((a,b)=>a.url.localeCompare(b.url));
const generatedAt=new Date().toISOString(),doc={schema:1,localInstallation:true,generatedAt,source:'installed-local-files',groups};
const backup=path.join(root,'.cache/mizuki-local-resources-fix-20261028/before/data/resource-preload.local.json');
if(fs.existsSync(target)&&!fs.existsSync(backup)){await fsp.mkdir(path.dirname(backup),{recursive:true});await fsp.copyFile(target,backup);}
await fsp.writeFile(target,JSON.stringify(doc));
const report={generatedAt,root,source:input,target,sourceUnchanged:true,groups:Object.fromEntries(Object.keys(groups).map(group=>[group,{source:original.groups[group].length,installed:groups[group].length,missing:missing.filter(x=>x.group===group).length,updated:changed.filter(x=>x.group===group).length}])),uniqueFilesHashed:hashes.size,missing,changed};
const reportFile=path.join(root,'.cache/mizuki-local-resources-fix-20261028/local-manifest-build.json');await fsp.mkdir(path.dirname(reportFile),{recursive:true});await fsp.writeFile(reportFile,JSON.stringify(report,null,2));
console.log(JSON.stringify({target,groups:report.groups,uniqueFilesHashed:hashes.size,report:reportFile}));
