import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resourceBrowserHarness, resourceTestChrome } from './helpers/resourceCacheBrowser.js';

test('Mizuki FX reads an existing lossless WebP cache record without resource network IO',
  {skip:resourceTestChrome?false:'requires local Chrome'},async()=>{
  const harness=await resourceBrowserHarness();
  const raw='original PNG bytes',webp='cached lossless WEBP bytes';
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const item={url:'/assets/mizuki/fx/texture.png',version:sha(raw),bytes:Buffer.byteLength(raw),type:'image/png',
    transport:{version:sha(webp),bytes:Buffer.byteLength(webp),type:'image/webp'}};
  try {
    const result=await harness.run({manifest:{schema:1,groups:{required:[item],optional:[],voice:[]}},bodies:{}},async()=>{
      const f=globalThis.resourceFixture,item=f.config.manifest.groups.required[0];
      await f.put(item,'cached lossless WEBP bytes',{transport:item.transport,blob:new Blob(['cached lossless WEBP bytes'],{type:'image/webp'})});
      await f.resourceCache.ensureSessionReady();await f.resourceCache.check();
      const {createMizukiFxFetch}=await import('/public/js/mizukiFx.js');
      f.resetIo();
      const request=createMizukiFxFetch({groups:{'fx/tex':{texture:{path:item.url,bytes:item.bytes,sha256:item.version}}}});
      const response=await request(item.url);
      return {text:await response.text(),type:response.headers.get('Content-Type'),requests:f.requests,cached:f.resourceCache.isCached(item.url)};
    });
    assert.equal(result.text,webp);assert.equal(result.type,'image/webp');
    assert.deepEqual(result.requests,[]);assert.equal(result.cached,true);
  }finally{await harness.close();}
});
