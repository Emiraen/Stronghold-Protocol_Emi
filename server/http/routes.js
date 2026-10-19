// HTTP 请求入口；保留原 index 的安全头、方法限制和健康检查。
import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './build.js';
import { MAX_URL_LENGTH, splitUrl, sendError, sendJson } from './common.js';
import { createPublicJsonResponder } from './publicJson.js';
import { SIM_WORKER_CSP } from './csp.js';

function trafficAllowed(req, trustProxy) {
  if (trustProxy === false) return true;
  const raw = String(req?.headers?.['cf-connecting-ip'] || req?.headers?.['x-real-ip'] || req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (!raw) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.|::1$|fc|fd|fe80)/i.test(raw);
}

export function healthReport({ startedAt, network, registry, lobby, content = null, traffic, assetIndex, views, trusted }, withTraffic = false) {
  const report = { ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now()-startedAt)/1000), build: buildTag(), sockets: network.connectionCount, sessions: registry.size, ...lobby.stats() };
  if (content) report.content = { vanilla: content.cs, sets: contentSets(lobby), ...pluginCount(lobby) };
  if (trusted && Object.keys(trusted).length) report.plugins = trusted;
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}
const contentSets = (lobby) => new Set([...lobby.rooms.values()].map(r => r.contentSet || 'vanilla')).size;
const pluginCount = (lobby) => ({ plugins: [...lobby.rooms.values()].reduce((n,r)=>n+(Array.isArray(r.plugins)?r.plugins.length:0),0) });

export function createRequestHandler({ serveStatic, startedAt, network, registry, lobby, log, directory, profileRpc, pageEntry, announcement, studio = null, csp = null, traffic = null, trustProxy = 'auto' }) {
  const sendPublicJson = createPublicJsonResponder();
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (parts.rawPath === '/api/profile-service' && profileRpc) {
      await profileRpc(req, res);
      return;
    }
    if (studio && studio.handles(parts.rawPath)) { await studio.handle(req,res,parts.rawPath,parts.query); return; }
    // 只为公开压缩资源包允许跨域 Range；不放开档案/API或凭据请求。
    if (/^\/assets\/resource-(required(?:-lossless)?|optional|voice)\.sprpack$/.test(parts.rawPath)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '600' });
        res.end();
        return;
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/announcement.json' && announcement) {
      await sendPublicJson(req, res, parts.rawPath, announcement());
      return;
    }
    if (parts.rawPath === '/api/servers' && directory) {
      await sendPublicJson(req, res, parts.rawPath, typeof directory === 'function' ? directory() : directory);
      return;
    }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, {
        ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        build: buildTag(),
        sockets: network.connectionCount, sessions: registry.size, ranked: lobby.ranked.size, ...lobby.stats(),
        ...(new URLSearchParams(parts.query).get('traffic') === '1' && traffic && trafficAllowed(req, trustProxy) ? { traffic: traffic.snapshot() } : {}),
      });
      return;
    }
    const entry = pageEntry?.();
    if (entry && ['/', '/index.html'].includes(parts.rawPath)) {
      // 统一 HTML 入口，保留邀请参数；WS、RPC、健康检查不重定向。
      const destination = new URL('/', entry);
      destination.search = parts.query ? '?' + parts.query : '';
      res.writeHead(302, { Location: destination.href, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    traffic?.meter(res, (req.url || '/').split('?')[0]);
    let requestPath = (req.url || '').split('?')[0];
    try { requestPath = decodeURIComponent(requestPath); } catch { /* static handler reports malformed paths */ }
    if (requestPath === '/js/battle/simWorker.js') res.setHeader('Content-Security-Policy', SIM_WORKER_CSP);
    else if (csp) res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
