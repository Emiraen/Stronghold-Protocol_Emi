// Plugin-only HTTP surface; the existing East static server remains the fallback.
import fsp from 'node:fs/promises';
import { sendError } from '../http/common.js';
import { GzipCache, serveFile, serveStaticBuffer } from '../http/files.js';
import { isPackPath, isPluginId, extOf } from '../../shared/plugins/manifest.js';
import { csUrlPart } from '../../shared/plugins/identity.js';
import { PLUGIN_AUDIO_EXTS } from '../../shared/plugins/visual.js';
import { UI_FRAME_CSP } from '../../shared/plugins/ui.js';
import { sameIdentity, statIdentity } from './registry.js';

export function createPluginHttp({ registry, content, visual, contents, log }) {
  const cache = new GzipCache(), tags = new Map();
  const missing = (req,res) => sendError(req,res,404,'页面不存在 · Not found');
  const buffer = (req,res,f,key) => serveStaticBuffer(req,res,f.body, {
    type:f.type || 'application/json; charset=utf-8', tag:f.sha256 || key,
    cacheControl:'public, max-age=31536000, immutable',
  },cache,log);
  return async (req,res,decoded,query) => {
    if (decoded === '/plugins/index.json') { await serveStaticBuffer(req,res,Buffer.from(JSON.stringify(registry.pluginIndex({vanilla:content.cs}))),{},cache,log); return true; }
    if (decoded.startsWith('/cs/')) {
      const m=/^\/cs\/([0-9a-f]{16})\/(.+)$/.exec(decoded);
      if (!m || !isPackPath(m[2])) { missing(req,res); return true; }
      const f=m[1]===csUrlPart(content.cs) && m[2]==='index.json'
        ? {body:Buffer.from(JSON.stringify(content.index)),sha256:content.cs} : contents.file(m[1],m[2]);
      if (f) await buffer(req,res,f,decoded); else missing(req,res);
      return true;
    }
    if (decoded.startsWith('/vs/')) {
      const m=/^\/vs\/([0-9a-f]{16})\/overlay\.json$/.exec(decoded), doc=m && await visual.doc(m[1]);
      if (doc) { await serveStaticBuffer(req,res,doc.body,{},cache,log); } else missing(req,res);
      return true;
    }
    if (decoded.startsWith('/p/')) {
      const [id,hash,...segments]=decoded.slice(3).split('/'), rel=segments.join('/');
      const ok=isPluginId(id) && /^[0-9a-f]{8}$/.test(hash || '') && isPackPath(rel);
      let f=ok ? visual.file(id,rel) : null;
      if (!f && ok && !extOf(rel)) f=PLUGIN_AUDIO_EXTS.map(e=>visual.file(id,rel+e)).filter(Boolean).find(x=>x.urlHashes.has(hash));
      if (f && !f.urlHashes.has(hash)) f=null;
      const st=f && await fsp.lstat(f.abs).catch(()=>null), real=st?.isFile() && await fsp.realpath(f.abs).catch(()=>null);
      if (!st?.isFile() || real !== f?.real || !sameIdentity(statIdentity(st),f)) { visual.noteChanged(); missing(req,res); return true; }
      if (f.frame) res.setHeader('Content-Security-Policy',UI_FRAME_CSP);
      await serveFile(req,res,f.abs,st,'plugins',segments,query,cache,tags,log);
      return true;
    }
    return false;
  };
}
