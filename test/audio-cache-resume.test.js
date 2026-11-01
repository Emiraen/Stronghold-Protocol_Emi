import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const listeners = new Set(), available = new Set();
globalThis.__bgmCacheResume = { listeners, available };
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/public/js/audio.js') && specifier === './resourceCache.js') return {
    shortCircuit: true,
    url: 'data:text/javascript,' + encodeURIComponent('export const cachedFetch=async url=>{if(!globalThis.__bgmCacheResume.available.has(url))throw new Error("not cached");return new Response(new Uint8Array(8));};export const resourceCache={isCached:url=>globalThis.__bgmCacheResume.available.has(url),subscribe:fn=>{globalThis.__bgmCacheResume.listeners.add(fn);return()=>globalThis.__bgmCacheResume.listeners.delete(fn);}};'),
  };
  return next(specifier, context);
} });
const { audio, installAudio } = await import('../public/js/audio.js');
hook.deregister();
const flush = () => new Promise(resolve => setImmediate(resolve));

test('ordinary in-match BGM starts when its cache completes after an initial silent miss', async () => {
  class Param { setValueAtTime() {} linearRampToValueAtTime() {} setTargetAtTime() {} cancelScheduledValues() {} }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Source extends Node { start() {} stop() {} }
  const ctx = { currentTime: 0, createGain: () => new Gain(), createBufferSource: () => new Source(),
    decodeAudioData(bytes, ok) { ok({ duration: 5 }); } };
  audio.ctx = ctx; audio.master = new Gain(); audio.bgmGain = new Gain(); audio.sfxGain = new Gain();
  const state = { match: { public: { phase: 'COMBAT' } } };
  const url = '/media/bgm/cache-resume';
  const stop = installAudio({ getManifest: () => ({ audio: { bgm: { combat: { loop: url } } } }),
    subscribe: () => () => {}, getState: () => state, selectRoute: () => 'game' });
  try {
    await flush(); await flush();
    assert.equal(audio.bgm, null);
    available.add(url);
    for (const fn of listeners) fn({ cacheRevision: 1 });
    await flush(); await flush();
    assert.equal(audio.bgm?.loopUrl, url);
    const playing = audio.bgm;
    for (const fn of listeners) fn({ cacheRevision: 2 });
    await flush();
    assert.equal(audio.bgm, playing, 'further cache updates leave the same loop running');
  } finally { stop(); audio._fadeOutBgm(); available.clear(); }
  assert.equal(listeners.size, 0);
});
