import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mizukiLocalAssetUrl, fetchMizukiLocalAsset, mizukiAssets, MizukiImage } from '../public/js/mizukiAssets.js';
import { assets } from '../public/js/assets.js';
import { CachedImage } from '../public/js/ui/cachedImage.js';

test('private local URLs preserve hashed views and reject external or non-art paths',()=>{
 assert.equal(mizukiLocalAssetUrl('/assets/~0123456789/spine/front/a.skel'),'/assets/~0123456789/spine/front/a.skel');
 assert.equal(mizukiLocalAssetUrl('/assets/mizuki/library/a.png?v=1'),'/assets/mizuki/library/a.png?v=1');
 assert.equal(mizukiLocalAssetUrl('https://example.com/assets/a.png'),null);
 assert.equal(mizukiLocalAssetUrl('/assets/../../server/index.js'),null);
 assert.equal(mizukiLocalAssetUrl('/sim/spec.js'),null);
});

test('Mizuki delegates its store and DOM images to the same Stronghold cache',async()=>{
 assert.strictEqual(mizukiAssets,assets);
 assert.strictEqual(mizukiAssets.spine,assets.spine);
 const vnode=MizukiImage({src:'/assets/char/a.png',class:'unchanged-image',portraitPreview:true});
 assert.strictEqual(vnode.type,CachedImage);assert.equal(vnode.props.src,'/assets/char/a.png');assert.equal(vnode.props.class,'unchanged-image');
 const original=globalThis.fetch,calls=[];
 try{
  globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return Response.json({version:1});};
  await fetchMizukiLocalAsset('/data/assets.json',{cache:'no-cache'});
  assert.equal(new URL(calls[0].url).pathname,'/data/assets.json');
  await assert.rejects(fetchMizukiLocalAsset('https://example.com/assets/a.png'),/outside Mizuki/);
  assert.equal(calls.length,1);
 }finally{globalThis.fetch=original;}
 const source=readFileSync(new URL('../public/js/resourceCache.js',import.meta.url),'utf8');
 assert.ok(!source.includes('parsed.origin === globalThis.location?.origin && !deploymentResourceOrigin()'));
 const generated=readFileSync(new URL('../public/js/mizukiNativeApp.js',import.meta.url),'utf8');
 assert.ok(generated.includes("import { loadMizukiLocalImage as loadImageElement } from './mizukiAssets.js'"));
});
