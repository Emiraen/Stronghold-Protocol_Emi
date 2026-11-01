import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceMizukiProjectile, createMizukiFxFetch, attachMizukiFx } from '../public/js/mizukiFx.js';
import { mizukiRouteParticleKey } from '../public/js/mizukiRouteFx.js';
const base = new URL('../public/assets/mizuki/native-ui-motion/', import.meta.url);
const original = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
const types = JSON.parse(readFileSync(new URL('node-types.json', base), 'utf8'));

test('route particles follow original exact enum mapping without adding particles to shop or unknown', () => {
  assert.equal(mizukiRouteParticleKey('BATTLE_NORMAL', original, types), 'uieff_roguelike_2_purple');
  assert.equal(mizukiRouteParticleKey('BATTLE_ELITE', original, types), 'uieff_roguelike_2_pink');
  assert.equal(mizukiRouteParticleKey('BATTLE_BOSS', original, types), 'uieff_roguelike_2_splashing');
  assert.equal(mizukiRouteParticleKey('BATTLE_SHOP', original, types), 'uieff_roguelike_2_green');
  assert.equal(mizukiRouteParticleKey('SHOP', original, types), null);
  assert.equal(mizukiRouteParticleKey('UNKNOWN', original, types), null);
  assert.equal(mizukiRouteParticleKey('MADE_UP_TYPE', original, types), null);
  for (const row of original.nodeViewData[0].particles) assert.equal(mizukiRouteParticleKey(row.type, original, types), row.key);
});
test('mode-private fetch validates exact listed resource bytes and hash, rejects unlisted files and preserves shared fallback', async () => {
  const path = '/assets/mizuki/fx/test.json', body = '{"original":true}';
  const record = { path, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  const manifest = { groups: { 'fx/prefabs': { test: record } } };
  const urls = [];
  const fetchFn = async url => { urls.push(url); return new Response(body); };
  const scoped = createMizukiFxFetch(manifest, { fetchFn, fallback: async url => new Response('shared:'+url) });
  assert.equal(await (await scoped(path)).text(), body);
  assert.deepEqual(urls, [path]);
  assert.equal(await (await scoped('/assets/official-fx/shared.json')).text(), 'shared:/assets/official-fx/shared.json');
  await assert.rejects(scoped('/assets/mizuki/fx/not-in-manifest.json'), /Unlisted/);
  const corrupted = createMizukiFxFetch(manifest, { fetchFn: async () => new Response('corrupt') });
  await assert.rejects(corrupted(path), /integrity mismatch/);
  const wrongSize = createMizukiFxFetch({groups:{'fx/prefabs':{test:{...record,bytes:record.bytes+1}}}}, {fetchFn});
  await assert.rejects(wrongSize(path), /integrity mismatch/);
});
test('tracking projectile moves at authoritative speed toward updated target without overshoot', () => {
  const first = advanceMizukiProjectile({x:0,y:0}, {x:10,y:0}, 10, .2);
  assert.deepEqual(first,{x:2,y:0,reached:false});
  const second = advanceMizukiProjectile(first,{x:2,y:10},10,.2);
  assert.deepEqual(second,{x:2,y:2,reached:false});
  const end = advanceMizukiProjectile(second,{x:2,y:3},10,1);
  assert.deepEqual(end,{x:2,y:3,reached:true});
});

test('mode-private half textures require their own original bytes and hash', async () => {
  const path = '/assets/mizuki/fx/texture.png', half = '/assets/mizuki/fx/texture.half.png';
  const mainBody = 'original full texture', halfBody = 'original half texture';
  const digest = body => createHash('sha256').update(body).digest('hex');
  const record = { path, bytes: Buffer.byteLength(mainBody), sha256: digest(mainBody), half, halfBytes: Buffer.byteLength(halfBody), halfSha256: digest(halfBody) };
  const manifest = { groups: { 'fx/textures': { texture: record } } };
  const fetchFn = async url => new Response(url === half ? halfBody : mainBody);
  const scoped = createMizukiFxFetch(manifest, { fetchFn });
  assert.equal(await (await scoped(half)).text(), halfBody);
  await assert.rejects(createMizukiFxFetch(manifest, { fetchFn: async () => new Response(mainBody) })(half), /integrity mismatch/);
  const wrongSize = { groups: { 'fx/textures': { texture: { ...record, halfBytes: record.halfBytes + 1 } } } };
  await assert.rejects(createMizukiFxFetch(wrongSize, { fetchFn })(half), /integrity mismatch/);
});

test('attaching a battle does not preload every mode effect and requests only a used effect', async () => {
  const { FxLibrary } = await import('../public/js/render/vfx/library.js');
  const keys = Array.from({length:40}, (_,i) => 'mode_effect_'+i);
  const manifest = {groups:{'fx/prefabs':Object.fromEntries(keys.map(key=>[key,{path:'/assets/mizuki/fx/'+key+'.json'}]))}};
  const fetched=[],preloaded=[],original=FxLibrary.prototype.preload;
  FxLibrary.prototype.preload=async function(values){preloaded.push([...values]);return 0;};
  try {
    const old={groups:{'fx/prefabs':{}},init:async()=>true,index:async()=>({}),destroy(){}};
    const ofx={lib:old,ctx:{assets:{}},pool:new Map(),clear(){},setTier(value){this.tier=value;},
      spawn(key){this.lib.request(key);return null;},stats:()=>({})};
    const raw={debug:{ofx,wiring:{clear(){}},board3d:{},views:new Map(),tiles:{heightAt:()=>0}},
      enterBattle(){},pushSnapshot(){},pushEvents(){},setSettings(){},destroy(){}};
    const state=await attachMizukiFx(raw,{settings:{officialFx:'full'},fetchFn:async url=>{fetched.push(url);return Response.json(manifest);}});
    assert.equal(state.available,true);assert.deepEqual(preloaded,[]);
    assert.deepEqual(fetched,['/assets/mizuki/fx/manifest.json']);
    state.play({key:keys[17],x:1,y:1});await Promise.resolve();
    assert.deepEqual(preloaded,[[keys[17]]]);
    raw.setSettings({officialFx:'lite'});await Promise.resolve();
    assert.ok(preloaded.every(values=>values.length===1&&values[0]===keys[17]));
    raw.destroy();
  } finally {FxLibrary.prototype.preload=original;}
});
