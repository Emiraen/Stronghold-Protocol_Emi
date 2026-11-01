import test from 'node:test';
import assert from 'node:assert/strict';
import { identity } from '../public/js/net.js';

const MAIN = 'https://super.emiraen.top:23331', PEER = 'https://emiraen.top', SOUTH = 'https://south.emiraen.top';
let serial = 0;
async function scenario(fetcher, run) {
  const original = { fetch: globalThis.fetch, location: globalThis.location, timeout: globalThis.setTimeout, server: identity.getServer() };
  const calls = [];
  globalThis.location = new URL(PEER);
  identity.selectServer('main');
  globalThis.setTimeout = (callback, ms, ...args) => original.timeout(callback, [2000, 3000, 15000].includes(ms) ? 15 : ms, ...args);
  globalThis.fetch = async (url, options) => { calls.push(new URL(url)); return fetcher(new URL(url), options, calls.length); };
  try { await run(await import('../public/js/resourceCache.js?required-delivery=' + ++serial), calls); }
  finally {
    globalThis.fetch = original.fetch; globalThis.setTimeout = original.timeout;
    identity.selectServer(original.server);
    if (original.location === undefined) delete globalThis.location; else globalThis.location = original.location;
  }
}

test('essential maps and manual preloads use the South resource server', async () => {
  await scenario(async url => new Response(url.origin), async (m, calls) => {
    assert.equal(await (await m.fetchResourceData('/assets/mizuki/native-board/map.png', {}, { requiredOnline: true })).text(), SOUTH);
    assert.equal(await (await m.fetchResourceData('/assets/resource-required-lossless.sprpack', {}, { preload: true })).text(), SOUTH);
    assert.deepEqual(calls.map(url => url.origin), [SOUTH, SOUTH]);
  });
});

test('fast headers with a stalled essential body fail over and cancel the old transfer', async () => {
  let cancelled = false;
  await scenario(async (url, options) => {
    if (url.origin !== SOUTH) return new Response('complete texture');
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('incomplete'));
      options.signal.addEventListener('abort', () => { cancelled = true; controller.error(options.signal.reason); }, { once: true });
    } }));
  }, async (m, calls) => {
    assert.equal(await (await m.fetchResourceData('/assets/spine/op/texture.png', {}, { requiredOnline: true })).text(), 'complete texture');
    assert.deepEqual(calls.map(url => url.origin), [SOUTH, MAIN]);
    assert.equal(cancelled, true);
    assert.equal(await (await m.fetchResourceData('/assets/skill/icon.png', {}, { requiredOnline: true })).text(), 'complete texture');
    assert.equal(calls.at(-1).origin, MAIN, 'other essential downloads skip the failing source briefly');
  });
});

test('missing essential files fall back from South to East, preserving version and Range', async () => {
  await scenario(async (url, options) => {
    assert.equal(new Headers(options.headers).get('Range'), 'bytes=2-9');
    return new Response(url.origin === MAIN ? 'source' : '', { status: url.origin === MAIN ? 200 : 404 });
  }, async (m, calls) => {
    const response = await m.fetchResourceData('/assets/mizuki/native-maps/map.json?__resourceVersion=new', { headers: { Range: 'bytes=2-9' } }, { requiredOnline: true });
    assert.equal(await response.text(), 'source');
    assert.deepEqual(calls.map(url => url.origin), [SOUTH, MAIN]);
    assert.ok(calls.every(url => url.search === '?__resourceVersion=new'));
  });
});

test('caller cancellation during an essential body never starts another source', async () => {
  const cancel = new AbortController();
  await scenario(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    queueMicrotask(() => cancel.abort(new DOMException('caller cancelled', 'AbortError')));
  } })), async (m, calls) => {
    await assert.rejects(m.fetchResourceData('/assets/map.png', { signal: cancel.signal }, { requiredOnline: true }), { name: 'AbortError' });
    assert.equal(calls.length, 1);
  });
});

test('essential response exposes decoded body without stale HTTP compression headers', async () => {
  await scenario(async () => new Response('decoded audio', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '9', 'Content-Type': 'audio/wav' } }), async m => {
    const response = await m.fetchResourceData('/media/sfx/attack', {}, { requiredOnline: true });
    assert.equal(await response.text(), 'decoded audio');
    assert.equal(response.headers.has('Content-Encoding'), false);
    assert.equal(response.headers.has('Content-Length'), false);
    assert.equal(response.headers.get('Content-Type'), 'audio/wav');
  });
});

test('automatic art catalogues use East without probing the preload host', async () => {
  await scenario(async url => Response.json({ source: url.origin }), async (m, calls) => {
    for (const name of ['assets', 'local-assets', 'skins', 'local-fx']) {
      const response = await m.fetchResourceData('/data/' + name + '.json');
      assert.equal((await response.json()).source, MAIN);
    }
    assert.deepEqual(calls.map(url => url.origin), [MAIN, MAIN, MAIN, MAIN]);
  });
});

test('one missing file never disables the resource source for the following resource', async () => {
  await scenario(async url => new Response(url.pathname.includes('missing') ? '' : 'present', { status: url.pathname.includes('missing') ? 404 : 200 }), async (m, calls) => {
    assert.equal((await m.fetchResourceData('/assets/missing.png', {}, { requiredOnline: true })).status, 404);
    assert.equal(await (await m.fetchResourceData('/assets/present.png', {}, { requiredOnline: true })).text(), 'present');
    assert.deepEqual(calls.map(url => url.origin), [SOUTH, MAIN, SOUTH]);
  });
});
