import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createStaticHandler } from '../server/http/static.js';
import { createRequestHandler } from '../server/http/routes.js';
import { acceptsGzip, preferredEncoding } from '../server/http/files.js';

const log = { error() {}, debug() {} };
const request = (port, url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: url, headers, method }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  }); req.on('error', reject); req.end();
});
const decoded = res => res.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(res.body)
  : res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.body;

test('HTTP encoding negotiation keeps gzip/identity fallback and respects explicit q=0', () => {
  assert.equal(preferredEncoding('gzip, deflate, br'), 'br');
  assert.equal(preferredEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(preferredEncoding('br;q=.2, gzip;q=.9'), 'gzip');
  assert.equal(preferredEncoding('br;q=0, gzip;q=0, *;q=1'), null);
  assert.equal(preferredEncoding(undefined), null);
  assert.equal(acceptsGzip('br'), false);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip('gzip;q=0'), false);
});

test('real HTTP static Brotli, gzip, HEAD, validators, concurrency and Range retain identical content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'east-http-'));
  const data = Buffer.from(JSON.stringify({ units: Array.from({ length: 2000 }, (_, uid) => ({ uid, name: `干员 ${uid}`, hp: 100, skill: 'sample' })) }));
  const large = Buffer.alloc((8 << 20) + 512, 'streamed-content|');
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'state.json'), data);
  await fs.writeFile(path.join(root, 'large.txt'), large);
  await fs.writeFile(path.join(root, 'assets', 'test.svg'), data);
  const serve = createStaticHandler({ publicDir: root, dataDir: root, sharedDir: root, log });
  const server = http.createServer((req, res) => serve(req, res, req.url, '').catch(e => { res.destroy(e); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const plain = await request(port, '/state.json');
    const gzip = await request(port, '/state.json', { 'Accept-Encoding': 'gzip' });
    const br = await request(port, '/state.json', { 'Accept-Encoding': 'br, gzip' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(decoded(br), data); assert.deepEqual(decoded(gzip), data); assert.deepEqual(plain.body, data);
    assert.notEqual(br.headers.etag, gzip.headers.etag); assert.notEqual(br.headers.etag, plain.headers.etag);
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal((await request(port, '/state.json', { 'Accept-Encoding': 'br', 'If-None-Match': br.headers.etag })).status, 304);
    assert.equal((await request(port, '/state.json', { 'Accept-Encoding': 'gzip', 'If-None-Match': br.headers.etag })).status, 200);
    const head = await request(port, '/state.json', { 'Accept-Encoding': 'br' }, 'HEAD');
    assert.equal(head.headers['content-length'], String(br.body.length)); assert.equal(head.body.length, 0);
    const many = await Promise.all(Array.from({ length: 4 }, () => request(port, '/state.json', { 'Accept-Encoding': 'br' })));
    for (const res of many) assert.deepEqual(decoded(res), data);
    const range = await request(port, '/state.json', { 'Accept-Encoding': 'br, gzip', Range: 'bytes=2-17' });
    assert.equal(range.status, 206); assert.equal(range.headers['content-encoding'], undefined); assert.deepEqual(range.body, data.subarray(2, 18));
    const streamed = await request(port, '/large.txt', { 'Accept-Encoding': 'br' });
    assert.deepEqual(decoded(streamed), large);
    const asset = await request(port, '/assets/test.svg', { 'Accept-Encoding': 'br' });
    const oldStat = await fs.stat(path.join(root, 'assets', 'test.svg'));
    const changed = Buffer.from(data); changed[30] = changed[30] === 65 ? 66 : 65;
    await fs.writeFile(path.join(root, 'assets', 'test.svg'), changed);
    await fs.utimes(path.join(root, 'assets', 'test.svg'), oldStat.atime, oldStat.mtime);
    const updated = await request(port, '/assets/test.svg', { 'Accept-Encoding': 'br', 'If-None-Match': asset.headers.etag });
    assert.equal(updated.status, 200); assert.notEqual(updated.headers.etag, asset.headers.etag); assert.deepEqual(decoded(updated), changed);
  } finally { await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); }
});

test('only public JSON is conditionally cached; changed announcement and directory invalidate immediately', async () => {
  let notice = { title: '服务器公告', content: '连接信息'.repeat(400), updatedAt: 1 };
  let directory = { current: 'main', servers: [{ id: 'main', load: 'idle', origin: 'http://localhost' }] };
  const handler = createRequestHandler({ serveStatic: (_req, res) => res.end(), startedAt: Date.now(),
    network: { connectionCount: 0 }, registry: { size: 0 }, lobby: { ranked: { size: 0 }, stats: () => ({}) },
    log, announcement: () => notice, directory: () => directory });
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const first = await request(port, '/announcement.json', { 'Accept-Encoding': 'br' });
    assert.equal(first.headers['content-encoding'], 'br'); assert.deepEqual(JSON.parse(decoded(first)), notice);
    const cached = await request(port, '/announcement.json', { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag });
    assert.equal(cached.status, 304); assert.equal(cached.body.length, 0); assert.equal(cached.headers['cache-control'], 'no-cache');
    notice = { ...notice, content: notice.content + '更新', updatedAt: 2 };
    const updated = await request(port, '/announcement.json', { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag });
    assert.equal(updated.status, 200); assert.deepEqual(JSON.parse(decoded(updated)), notice);
    const dir = await request(port, '/api/servers');
    assert.equal((await request(port, '/api/servers', { 'If-None-Match': dir.headers.etag })).status, 304);
    directory = { ...directory, servers: [{ ...directory.servers[0], load: 'busy' }] };
    const dirChanged = await request(port, '/api/servers', { 'If-None-Match': dir.headers.etag });
    assert.equal(dirChanged.status, 200); assert.deepEqual(JSON.parse(dirChanged.body), directory);
    assert.equal((await request(port, '/healthz')).headers['cache-control'], 'no-store');
  } finally { await new Promise(r => server.close(r)); }
});
