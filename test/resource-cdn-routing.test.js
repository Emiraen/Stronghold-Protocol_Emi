import test from 'node:test';
import assert from 'node:assert/strict';
import { identity } from '../public/js/net.js';

const CDN = 'https://cdn.emiraen.top';
const DIRECT = 'https://u75731.nyat.app:48335';
const SOUTH = 'https://south.emiraen.top';
const SOUTH_HTTP = 'http://120.24.21.224:3000';
const MAIN = 'https://super.emiraen.top:23331';
const PAGE = 'https://emiraen.top';
let serial = 0;

async function scenario(fetcher, run, origin = PAGE) {
  const before = { fetch: globalThis.fetch, location: globalThis.location, timeout: globalThis.setTimeout, server: identity.getServer() };
  const calls = [];
  globalThis.location = new URL(origin + '/');
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input, location);
    calls.push({ url, options });
    return fetcher(url, options, calls.length);
  };
  try {
    const module = await import(`../public/js/resourceCache.js?cdn-routing=${++serial}`);
    return await run(module, calls);
  } finally {
    globalThis.fetch = before.fetch;
    globalThis.setTimeout = before.timeout;
    identity.selectServer(before.server);
    if (before.location === undefined) delete globalThis.location;
    else globalThis.location = before.location;
  }
}

test('preload prefers South and keeps canonical Win7 alias and query/Range options', async () => {
  await scenario(async () => new Response('direct'), async (m, calls) => {
    assert.equal(m.CDN_RESOURCE_ORIGIN, CDN);
    assert.equal(m.win7ResourceUrl('/assets/test.bin?v=1#ignored'), DIRECT + '/assets/test.bin?v=1');
    const response = await m.fetchResourceData('/assets/test.bin?v=1', {
      headers: { Range: 'bytes=12-31' }, credentials: 'include', cache: 'no-store',
    });
    assert.equal(await response.text(), 'direct');
    assert.deepEqual(calls.map(c => c.url.origin), [SOUTH]);
    assert.equal(calls[0].url.pathname + calls[0].url.search, '/assets/test.bin?v=1');
    assert.equal(new Headers(calls[0].options.headers).get('Range'), 'bytes=12-31');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.mode, 'cors');
  });
});

test('404, server error, and network failure fall back South -> direct -> main', async () => {
  for (const failure of [404, 500, 'network']) {
    await scenario(async (url) => {
      if (url.origin === MAIN) return new Response('main');
      if (failure === 'network') throw new TypeError('mock network failure');
      return new Response('', { status: failure });
    }, async (m, calls) => {
      assert.equal(await (await m.fetchResourceData('/assets/voice.bin?pack=3', { headers: { Range: 'bytes=3-9' } })).text(), 'main');
      assert.deepEqual(calls.map(c => c.url.origin), [SOUTH, DIRECT, MAIN]);
      for (const call of calls) {
        assert.equal(call.url.pathname + call.url.search, '/assets/voice.bin?pack=3');
        assert.equal(new Headers(call.options.headers).get('Range'), 'bytes=3-9');
      }
    });
  }
});

test('rebuilt range packs use the current South host before a stale direct pack', async () => {
  await scenario(async url => new Response(url.origin === SOUTH ? 'south' : '', { status: url.origin === SOUTH ? 200 : 404 }), async (m, calls) => {
    assert.equal(await (await m.fetchResourceData('/assets/resource-voice.sprpack')).text(), 'south');
    assert.deepEqual(calls.map(c => c.url.origin), [SOUTH]);
  });
});

test('manual preload retries recovered South after a foreground circuit break instead of returning game 404', async () => {
  let recovered = false;
  await scenario(async url => {
    if (url.origin === SOUTH) {
      if (recovered) return new Response('mesh');
      throw new TypeError('transient connection failure');
    }
    return new Response('', { status: 404 });
  }, async (m, calls) => {
    const path = '/assets/local/fx/mesh/model2_01-d3b9e3a1.json';
    assert.equal((await m.fetchResourceData(path)).status, 404);
    recovered = true;
    assert.equal(await (await m.fetchResourceData(path, {}, { preload: true })).text(), 'mesh');
    assert.deepEqual(calls.map(call => call.url.origin), [SOUTH, MAIN, SOUTH]);
  });
});

test('header timeout falls through and circuit breaker skips only failing origin', async () => {
  const nativeTimeout = globalThis.setTimeout;
  await scenario(async (url, options) => {
    if (url.origin !== SOUTH) return new Response('direct');
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }, async (m, calls) => {
    globalThis.setTimeout = (callback, ms, ...args) => nativeTimeout(callback, ms === 2000 ? 1 : ms, ...args);
    assert.equal(await (await m.fetchResourceData('/assets/first.bin')).text(), 'direct');
    assert.equal(await (await m.fetchResourceData('/assets/second.bin')).text(), 'direct');
    assert.deepEqual(calls.map(c => c.url.origin), [SOUTH, DIRECT, DIRECT]);
  });
});

test('caller abort stops every fallback including already-aborted and body cancellation', async () => {
  const controller = new AbortController();
  await scenario(async (url, options) => {
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    throw options.signal.reason;
  }, async (m, calls) => {
    await assert.rejects(m.fetchResourceData('/assets/cancel.bin', { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(calls.map(c => c.url.origin), [SOUTH]);
    await assert.rejects(m.fetchResourceData('/assets/again.bin', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls.length, 1);
  });
  const streaming = new AbortController();
  let transportSignal;
  await scenario(async (url, options) => { transportSignal = options.signal; return new Response('stream'); }, async m => {
    const response = await m.fetchResourceData('/assets/body.bin', { signal: streaming.signal });
    assert.equal(transportSignal.aborted, false);
    streaming.abort();
    assert.equal(transportSignal.aborted, true);
    await response.body.cancel();
  });
});

test('foreground required resources use South then East regardless of stored game selection', async () => {
  for (const server of ['main', 'secondary']) {
    await scenario(async (url, options, count) => new Response(count === 1 ? '' : 'peer', { status: count === 1 ? 404 : 200 }), async (m, calls) => {
      identity.selectServer(server);
      assert.equal(await (await m.fetchResourceData('/assets/ranks/gold_1.png', {}, { requiredOnline: true })).text(), 'peer');
      assert.deepEqual(calls.map(c => c.url.origin), [SOUTH, MAIN]);
    });
  }
});

test('old CDN/direct rank art does not mask current rank art', async () => {
  await scenario(async url => new Response(url.origin === MAIN ? 'current rank' : '', { status: url.origin === MAIN ? 200 : 404 }), async (m, calls) => {
    assert.equal(await (await m.fetchResourceData('/assets/ranks/immortal_3.png')).text(), 'current rank');
    assert.deepEqual(calls.map(c => c.url.origin), [SOUTH, MAIN]);
  });
});

test('installed development and LAN builds use their own shipped resources without production source changes', async () => {
  await scenario(async () => new Response('direct'), async (m, calls) => {
    assert.equal(await (await m.fetchResourceData('/assets/local.bin')).text(), 'direct');
    assert.deepEqual(calls.map(c => c.url.origin), ['http://127.0.0.1:3100']);
    assert.equal(calls[0].options.mode, 'same-origin');
  }, 'http://127.0.0.1:3100');
});

test('public HTTP game deployments preload from the South resource server with direct fallback', async () => {
  for (const origin of ['http://121.199.43.133:3000', 'http://103.205.254.65:3000']) {
    await scenario(async (url, options, count) => new Response(count === 1 ? '' : 'direct', { status: count === 1 ? 404 : 200 }), async (m, calls) => {
      assert.equal(await (await m.fetchResourceData('/assets/operator.bin?v=2')).text(), 'direct');
      assert.deepEqual(calls.map(call => call.url.origin), [SOUTH, DIRECT]);
      assert.ok(calls.every(call => call.url.search === '?v=2'));
    }, origin);
  }
});

test('public HTTPS game deployments use the South TLS endpoint without mixed content', async () => {
  await scenario(async () => new Response('south'), async (m, calls) => {
    assert.equal(await (await m.fetchResourceData('/assets/operator.bin')).text(), 'south');
    assert.deepEqual(calls.map(call => call.url.origin), [SOUTH]);
  }, 'https://121.199.43.133:3000');
});

test('public IP pages use East catalogues and South resources despite retired game selection', async () => {
  const manifest = { schema: 1, groups: { required: [], optional: [], voice: [] } };
  await scenario(async url => url.pathname.startsWith('/data/') ? Response.json(manifest) : new Response('game'), async (m, calls) => {
    identity.selectServer('secondary');
    await m.resourceCache.ensureSessionReady();
    await m.resourceCache.prefetchRequired([], { priority: 2 });
    assert.deepEqual(calls.map(call => call.url.href), [MAIN + '/data/resource-preload.runtime.json.gz']);
    assert.equal(await (await m.fetchResourceData('/assets/operator.bin', {}, { requiredOnline: true })).text(), 'game');
    assert.deepEqual(calls.map(call => call.url.origin), [MAIN, SOUTH]);
  }, 'http://121.199.43.133:3000');
});

test('game manifest stays no-cache and CDN/direct aliases share canonical managed item', async () => {
  const manifest = { schema: 1, groups: { required: [], optional: [{
    url: '/assets/test-canonical.bin', version: 'a'.repeat(64), bytes: 4, type: 'application/octet-stream',
  }], voice: [] } };
  await scenario(async () => Response.json(manifest), async (m, calls) => {
    await m.resourceCache.ensureSessionReady();
    await m.resourceCache.prefetchRequired([], { priority: 2 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, MAIN);
    assert.equal(calls[0].url.pathname, '/data/resource-preload.runtime.json.gz');
    assert.equal(calls[0].options.cache, 'no-cache');
    for (const origin of [PAGE, CDN, DIRECT, SOUTH, SOUTH_HTTP]) {
      assert.equal(m.resourceCache.isManaged(origin + '/assets/test-canonical.bin'), true);
      assert.equal(m.resourceCache.isOptional(origin + '/assets/test-canonical.bin'), true);
    }
  });
});

test('manual mode assets and in-match essential delivery both prefer South', async () => {
  const paths = [
    '/assets/mizuki/native-maps/ro2_n_1_4.json', '/assets/mizuki/native-audio/tracks/default.ogg',
    '/assets/mizuki/native-sfx/attack.mp3', '/assets/local/scene/board.json',
    '/assets/local/map/ro2_n_1_4.json', '/assets/local/mesh/trap_110/mesh.bin',
    '/assets/local/spine/enemy/enemy_1.atlas', '/assets/audio/sfx/battle/attack.mp3',
    '/media/sfx/battle/attack', '/media/bgm/default',
  ];
  for (const requiredOnline of [false, true]) {
    await scenario(async url => new Response(url.origin), async (m, calls) => {
      identity.selectServer('main');
      for (const path of paths) {
        const response = await m.fetchResourceData(path + '?__resourceVersion=current', { headers: { Range: 'bytes=1-9' } }, { requiredOnline });
        assert.equal(await response.text(), SOUTH);
      }
      assert.equal(calls.length, paths.length);
      assert.ok(calls.every(call => call.url.origin === SOUTH));
      assert.ok(calls.every(call => call.url.search === '?__resourceVersion=current'));
      assert.ok(calls.every(call => new Headers(call.options.headers).get('Range') === 'bytes=1-9'));
    });
  }
});

test('synchronized game index enforces map, enemy and SFX required while BGM stays optional', async () => {
  const maps = [
    '/assets/local/map/board.json', '/assets/local/scene/board.json',
    ...['map_autochess_bkg', 's_background_common', 's_common_box_01', 's_wind_device', 'trap_110'].map(name => `/assets/local/mesh/${name}/mesh.bin`),
    '/assets/local/spine/enemy/enemy_1.atlas', '/assets/spine/enemy/enemy_2.skel',
    '/assets/mizuki/library/spines/enemy_3.skel',
    '/assets/mizuki/native-maps/map.json', '/assets/mizuki/native-board/board.json',
    '/assets/mizuki/native-reflections/board.png', '/assets/mizuki/native-sfx/attack.mp3',
    '/assets/audio/sfx/battle/attack.mp3', '/assets/local/audio/sfx/attack.ogg',
    '/media/sfx/battle/attack-2', '/assets/mizuki/native-audio/manifest.json',
  ];
  const bgm = [
    '/assets/audio/bgm/default.mp3', '/assets/local/audio/bgm/default.ogg', '/media/bgm/other',
    '/assets/mizuki/native-audio/tracks/default.ogg',
  ];
  const item = url => ({ url, version: 'b'.repeat(64), bytes: 4, type: 'application/octet-stream' });
  const current = { schema: 1, groups: { required: bgm.map(item), optional: maps.map(item), voice: [] } };
  await scenario(async () => Response.json(current), async (m, calls) => {
    await m.resourceCache.ensureSessionReady();
    await m.resourceCache.prefetchRequired([], { priority: 2 });
    assert.deepEqual(calls.map(call => call.url.href), [MAIN + '/data/resource-preload.runtime.json.gz']);
    for (const path of maps) {
      assert.equal(m.resourceCache.isManaged(path), true, path);
      assert.equal(m.resourceCache.isOptional(path), false, path);
    }
    for (const path of bgm) {
      assert.equal(m.resourceCache.isManaged(path), true, path);
      assert.equal(m.resourceCache.isOptional(path), true, path);
    }
  });
});

test('unavailable game indexes fall back to South without blocking on a plain index first', async () => {
  const manifest = { schema: 1, groups: { required: [], optional: [], voice: [] } };
  await scenario(async url => url.origin !== SOUTH ? new Response('', { status: 503 }) : Response.json(manifest), async (m, calls) => {
    identity.selectServer('secondary');
    await m.resourceCache.ensureSessionReady();
    await m.resourceCache.prefetchRequired([], { priority: 2 });
    assert.deepEqual(calls.map(call => call.url.origin), [MAIN, SOUTH]);
    assert.ok(calls.every(call => call.url.pathname === '/data/resource-preload.runtime.json.gz'));
  });
});

test('native map literal and percent-encoded bracket paths share their pack/cache aliases without decoding reserved slashes', async () => {
  const paths = [
    '/assets/mizuki/native-board/map/fx/%5Bopt%5Dmerged_textures.webp',
    '/assets/mizuki/native-board/map/fx/%5Bucp%5Dmerged_textures.webp',
    '/assets/mizuki/native-reflections/map/%5bopt%5dreflection.webp',
    '/assets/mizuki/native-maps/%5Bucp%5Dboard.json',
    '/assets/local/map/%5Bopt%5D/board.json',
    '/assets/local/scene/%5Bucp%5D/scene.json',
  ];
  const item = url => ({ url, version: 'c'.repeat(64), bytes: 4, type: 'application/octet-stream' });
  const manifest = { schema: 1, groups: { required: [...paths.map(item), item('/assets/mizuki/native-maps/a%2Fb.json')], optional: [], voice: [] } };
  await scenario(async () => Response.json(manifest), async m => {
    await m.resourceCache.prefetchRequired([], { priority: 2 });
    for (const path of paths) {
      const literal = path.replace(/%5b/ig, '[').replace(/%5d/ig, ']');
      for (const origin of ['', PAGE, DIRECT, CDN, SOUTH, SOUTH_HTTP]) {
        assert.equal(m.resourceCache.isManaged(origin + literal), true, origin + literal);
        assert.equal(m.resourceCache.isManaged(origin + path), true, origin + path);
        assert.equal(m.resourceCache.isOptional(origin + literal), false, origin + literal);
      }
    }
    assert.equal(m.resourceCache.isManaged('/assets/mizuki/native-maps/a%2Fb.json'), true);
    assert.equal(m.resourceCache.isManaged('/assets/mizuki/native-maps/a/b.json'), false);
  });
});
