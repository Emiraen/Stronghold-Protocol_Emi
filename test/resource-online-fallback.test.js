import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { identity } from '../public/js/net.js';

test('必要资源无需 IndexedDB 也可进入和按需获取，个性化资源仍须下载', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalServer = identity.getServer();
  const body = 'required-resource';
  const version = createHash('sha256').update(body).digest('hex');
  const item = url => ({ url, version, bytes: body.length, type: 'text/plain' });
  const manifest = { schema: 1, groups: {
    required: [item('/assets/required.txt'), item('/assets/uncached.txt')], optional: [item('/assets/skin.txt')], voice: [item('/assets/voice.txt')],
  } };
  let resourceRequests = 0;
  let corrupt = false;
  globalThis.location = new URL('https://emiraen.top/');
  identity.selectServer('secondary');
  globalThis.fetch = async url => {
    const target = new URL(url, location);
    if (target.pathname.startsWith('/data/resource-preload.')) return Response.json(manifest);
    if (target.pathname.endsWith('.sprpack')) return new Response('', { status: 404 });
    assert.equal(target.origin, 'https://emiraen.top');
    assert.ok(['/assets/required.txt', '/assets/uncached.txt'].includes(target.pathname));
    resourceRequests++;
    return new Response(corrupt ? 'short' : body, { headers: { 'Content-Type': 'text/plain' } });
  };
  try {
    const { resourceCache, cachedFetch, acquireResourceUrl } = await import('../public/js/resourceCache.js?online-fallback-test');
    assert.equal(await resourceCache.ensureSessionReady(), true);
    const [first, second] = await Promise.all([cachedFetch('/assets/required.txt'), cachedFetch('/assets/required.txt')]);
    assert.equal(await first.text(), body);
    assert.equal(await second.text(), body);
    assert.equal(resourceRequests, 1, '并发必要资源请求合并');
    assert.equal(resourceCache.isCached('/assets/required.txt'), false, '不假装已下载到本地');
    for (const url of ['/assets/skin.txt', '/assets/voice.txt']) {
      await assert.rejects(cachedFetch(url), { name: 'ResourceUnavailableError' });
      await assert.rejects(acquireResourceUrl(url), { name: 'ResourceUnavailableError' });
    }
    assert.equal(resourceRequests, 1, '个性化资源不偷偷实时下载');
    corrupt = true;
    assert.equal(await (await cachedFetch('/assets/required.txt')).text(), body, '已经获取的必要资源直接复用，不重复验证');
    await assert.rejects(cachedFetch('/assets/uncached.txt'), /资源内容与清单不符/);
  } finally {
    globalThis.fetch = originalFetch;
    identity.selectServer(originalServer);
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});
