import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { siteCsp, SIM_WORKER_CSP } from '../server/http/csp.js';
import { createRequestHandler } from '../server/http/routes.js';

const CDN = 'https://cdn.emiraen.top';
const origins = ['https://super.emiraen.top:23331', 'https://emiraen.top'];
const directive = (csp, key) => csp.split(';').map(x => x.trim()).find(x => x.startsWith(key + ' '));

test('page preconnects only to the direct resource host', () => {
  const page = readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.match(page, /<link rel="dns-prefetch" href="https:\/\/u75731\.nyat\.app:48335"\s*\/>/);
  assert.match(page, /<link rel="preconnect" href="https:\/\/u75731\.nyat\.app:48335" crossorigin\s*\/>/);
  assert.ok(!page.includes('crossorigin="use-credentials"'));
});

test('production site CSP permits exact CDN only for resource IO', () => {
  const csp = siteCsp(path.resolve('public'), origins);
  for (const key of ['connect-src', 'img-src', 'media-src', 'font-src']) {
    assert.ok(directive(csp, key).split(/\s+/).includes(CDN), key);
    assert.ok(!directive(csp, key).includes('*.emiraen.top'), 'no wildcard origins');
  }
  for (const key of ['script-src', 'worker-src', 'frame-src']) assert.ok(!directive(csp, key).includes(CDN), key);
  assert.match(SIM_WORKER_CSP, /connect-src 'none'/);
  assert.ok(!SIM_WORKER_CSP.includes(CDN));
});

test('simulation worker retains restrictive CSP even when page policy allows CDN', async () => {
  const csp = siteCsp(path.resolve('public'), origins);
  const handler = createRequestHandler({ csp, log: console, serveStatic: async (req, res) => { res.end('ok'); } });
  for (const url of ['/index.html', '/js/battle/simWorker.js', '/js/battle/sim%57orker.js']) {
    const headers = {};
    const res = new Writable({ write(chunk, encoding, done) { done(); } });
    res.setHeader = (key, value) => { headers[key.toLowerCase()] = value; };
    const finished = once(res, 'finish');
    handler({ url, method: 'GET', headers: {} }, res);
    await finished;
    assert.equal(headers['content-security-policy'], url === '/index.html' ? csp : SIM_WORKER_CSP);
  }
});
