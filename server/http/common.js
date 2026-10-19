export const MAX_URL_LENGTH = 4096;

// 仅回收已收到对端FIN的HTTP连接；活动下载及升级后的WS不改变超时。
const HALF_CLOSED_IDLE_MS = 120_000;
export function installHttpSocketCleanup(server, idleMs = HALF_CLOSED_IDLE_MS) {
  server.on('connection', (socket) => {
    socket.once('end', () => {
      if (!socket.parser || socket.destroyed) return;
      // end()可能等待发送队列排空；只限制半关闭后的连续无写入进展时间。
      const onTimeout = () => socket.destroy();
      socket.setTimeout(idleMs, onTimeout);
      socket.once('close', () => socket.off('timeout', onTimeout));
    });
  });
}

// 错误/拒绝升级连接不属于Network，写完拒绝响应后必须自行释放。
export function rejectHttpSocket(socket, status, text) {
  if (socket.destroyed) return;
  const destroy = () => socket.destroy();
  socket.once('error', destroy);
  socket.once('finish', destroy);
  socket.setTimeout(HALF_CLOSED_IDLE_MS, destroy);
  socket.once('close', () => {
    socket.off('error', destroy);
    socket.off('finish', destroy);
    socket.off('timeout', destroy);
  });
  try {
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else destroy();
  } catch { destroy(); }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function errorPage(status, title, detail = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} · 卫戍协议：盟约</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111614;color:#d8e3de;font:16px/1.6 "Noto Sans SC",system-ui,sans-serif}
main{border:1px solid #2c3a35;padding:32px 40px;max-width:520px;text-align:center}h1{margin:0;color:#4ed8af;font-size:56px;letter-spacing:4px}
p{margin:8px 0}a{color:#4ed8af}</style></head><body><main><h1>${status}</h1><p>${escapeHtml(title)}</p>
${detail ? `<p style="opacity:.6">${escapeHtml(detail)}</p>` : ''}<p><a href="/">返回首页 · Back to home</a></p></main></body></html>`;
}

export function sendError(req, res, status, title, detail) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(errorPage(status, title, detail));
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Split an absolute request URL into raw path + query (also accepts absolute-form URLs). */
export function splitUrl(url) {
  let u = url || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { const parsed = new URL(u); u = parsed.pathname + parsed.search; } catch { return null; }
  }
  const q = u.indexOf('?');
  const hashless = (s) => { const h = s.indexOf('#'); return h >= 0 ? s.slice(0, h) : s; };
  return q >= 0 ? { rawPath: hashless(u.slice(0, q)), query: hashless(u.slice(q + 1)) } : { rawPath: hashless(u), query: '' };
}
