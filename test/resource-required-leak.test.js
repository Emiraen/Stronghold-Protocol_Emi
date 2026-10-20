import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

test('required leak audio prefers local cache and can fall back to the game server; optional BGM cannot', async () => {
  const oldFetch = globalThis.fetch;
  const oldLocation = globalThis.location;
  const origin = 'https://game.example';
  const leakPath = '/assets/audio/sfx/battle/b_ui/b_ui_alarmenter.mp3';
  const leakBody = Buffer.from('required leak audio');
  const bgmBody = Buffer.from('optional battle music');
  const item = (url, body) => ({
    url, version: createHash('sha256').update(body).digest('hex'), bytes: body.length, type: 'audio/mpeg',
  });
  const manifest = { schema: 1, groups: {
    required: [item(leakPath, leakBody)],
    optional: [item('/assets/local/audio/bgm/sand_bgm1.mp3', bgmBody)],
    voice: [],
  } };
  const requests = [];
  globalThis.location = new URL(origin + '/');
  globalThis.fetch = async (input) => {
    const url = new URL(input, location);
    requests.push(url);
    if (url.pathname.startsWith('/data/resource-preload.')) return Response.json(manifest);
    if (url.pathname.endsWith('.sprpack')) return new Response('', { status: 404 });
    assert.equal(url.origin, origin, 'required leak is fetched from this game server');
    assert.equal(url.pathname, '/media/sfx/battle/b_ui/b_ui_alarmenter');
    return new Response(leakBody, { headers: { 'Content-Type': 'audio/mpeg' } });
  };
  try {
    const { cachedFetch } = await import('../public/js/resourceCache.js?required-leak-audio');
    const response = await cachedFetch(leakPath);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), leakBody);
    assert.equal(requests.filter(url => url.pathname.startsWith('/media/')).length, 1);
    await assert.rejects(cachedFetch('/assets/local/audio/bgm/sand_bgm1.mp3'), { name: 'ResourceUnavailableError' });
    assert.equal(requests.filter(url => url.pathname.startsWith('/media/')).length, 1,
      'unpreloaded optional battle BGM is not fetched during playback');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  }
});
