#!/usr/bin/env node
// Optional local sidecar. No imports of server entrypoints, no gameplay writes.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const METHODS = new Set(['state', 'context', 'catalog', 'events', 'request', 'chat', 'strategy', 'library', 'unit', 'join', 'switchServer', 'watch', 'avatar', 'skin', 'skins', 'portrait', 'voice', 'loadout', 'operatorSettings']);
export function createBridgeServer({ invoke, token = randomBytes(32).toString('hex'), port = 3211 } = {}) {
  if (typeof invoke !== 'function') throw new Error('invoke required');
  const credential = Buffer.from('Bearer ' + token), hosts = new Set(['127.0.0.1:' + port]);
  let inFlight = 0, windowAt = Date.now(), count = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      const json = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
      res.end(json);
    };
    if (!hosts.has(req.headers.host) || req.headers.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) return send(403, { ok: false, error: { code: 'ORIGIN', message: 'Local non-browser clients only' } });
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true, apiVersion: 1, service: 'player-ai-bridge' });
    const auth = Buffer.from(req.headers.authorization || '');
    if (auth.length !== credential.length || !timingSafeEqual(auth, credential)) return send(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
    if (req.method !== 'POST' || req.url !== '/v1/call') return send(404, { ok: false, error: { code: 'NOT_FOUND', message: 'POST /v1/call' } });
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(415, { ok: false, error: { code: 'CONTENT_TYPE', message: 'application/json required' } });
    if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); count = 0; }
    if (++count > 10 || inFlight >= 4) return send(429, { ok: false, error: { code: 'RATE', message: 'At most 10 calls/s and four outstanding calls' } });
    inFlight++;
    let id = null;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { send(413, { ok: false, error: { code: 'TOO_LARGE', message: '64 KiB body limit' } }); req.resume(); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['id', 'method', 'params'].includes(k))) throw Object.assign(new Error('Invalid call envelope'), { code: 'BAD_INPUT' });
      if (body.id !== undefined && !(typeof body.id === 'string' && body.id.length <= 100 || Number.isSafeInteger(body.id))) throw Object.assign(new Error('Invalid id'), { code: 'BAD_INPUT' });
      id = body.id ?? null;
      if (!METHODS.has(body.method)) throw Object.assign(new Error('Unknown method'), { code: 'NO_METHOD' });
      const params = body.params ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw Object.assign(new Error('params must be object'), { code: 'BAD_INPUT' });
      const result = await invoke(body.method, params);
      send(200, { ok: true, id, result });
    } catch (error) {
      if (!res.writableEnded) send(400, { ok: false, id, error: { code: error.code || (error instanceof SyntaxError ? 'BAD_JSON' : 'FAILED'), message: error.message, detail: error.detail ?? null } });
    } finally { inFlight--; }
  });
  server.headersTimeout = 5000; server.requestTimeout = 20000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
  // Tests may use port 0. Production CLI uses an explicit loopback port.
  server.on('listening', () => hosts.add('127.0.0.1:' + server.address().port));
  return { server, token };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = { browser: 'http://127.0.0.1:9222', port: '3211', origin: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!Object.hasOwn(opts, key) || !argv[i + 1]) throw new Error('Usage: node tools/ai-bridge.mjs --origin https://GAME --browser http://127.0.0.1:9222 --port 3211');
    opts[key] = argv[i + 1];
  }
  const endpoint = new URL(opts.browser), origin = new URL(opts.origin).origin, port = Number(opts.port);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Browser debug endpoint must be http://127.0.0.1:PORT');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port');
  if (!['https:', 'http:'].includes(new URL(origin).protocol)) throw new Error('Game origin must use http(s)');
  const browser = await puppeteer.connect({ browserURL: endpoint.origin, protocolTimeout: 20000 });
  let server;
  try {
    const pages = (await browser.pages()).filter(page => { try { return new URL(page.url()).origin === origin; } catch { return false; } });
    const enabled = [];
    for (const page of pages) if (await page.evaluate(() => globalThis.__SP_AI__?.version === 1).catch(() => false)) enabled.push(page);
    if (enabled.length !== 1) throw new Error('Exactly one game tab must explicitly enable __SP_AI__. No game process was modified.');
    const page = enabled[0];
    const call = async (method, params) => {
      if (page.isClosed() || new URL(page.url()).origin !== origin) throw Object.assign(new Error('Game tab unavailable or navigated'), { code: 'NO_CLIENT' });
      const envelope = await page.evaluate(async (method, params) => {
        try {
          const api = globalThis.__SP_AI__;
          if (!api) return { ok: false, error: { code: 'NOT_ENABLED', message: 'AI control is not enabled in this tab' } };
          return { ok: true, result: await api.call(method, params) };
        } catch (e) { return { ok: false, error: { code: e.code || 'FAILED', message: e.message, detail: e.detail ?? null } }; }
      }, method, params);
      if (!envelope.ok) throw Object.assign(new Error(envelope.error.message), envelope.error);
      return envelope.result;
    };
    const bridge = createBridgeServer({ invoke: call, port }); server = bridge.server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    process.stdout.write(JSON.stringify({ baseUrl: 'http://127.0.0.1:' + port, token: bridge.token, gameOrigin: origin, tab: page.url() }) + '\n');
    // Disconnect CDP only; do not close browser, player connection or game server.
    const stop = () => { server.close(); server.closeAllConnections(); browser.disconnect(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    browser.once('disconnected', () => { server.close(); server.closeAllConnections(); });
  } catch (error) { server?.close(); browser.disconnect(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
