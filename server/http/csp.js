import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SIM_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; object-src 'none'";
const assetOrigin = 'https://u75731.nyat.app:48335';
const digest = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
export function siteCsp(publicDir, origins = []) {
  const hashes = new Set();
  // Only hash trusted files present at process boot, never request or plugin text.
  for (const rel of ['index.html', 'studio/index.html', 'studio/console.html', 'dev/game-mock.html', 'dev/render-demo.html', 'dev/battle-perf.html', 'dev/uikit.html', 'dev/sim-check.html']) {
    let html;
    try { html = fs.readFileSync(path.join(publicDir, rel), 'utf8').replaceAll('\r\n', '\n'); } catch { continue; }
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc\s*=/i.test(match[1])) hashes.add(digest(match[2]));
    for (const match of html.matchAll(/\bon(?:error|load)\s*=\s*"([^"]*)"/gi)) hashes.add(digest(match[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"')));
  }
  // The default page policy stays self-contained; optional deployment origins are
  // added only when the caller explicitly supplies them (for example cross-region WS).
  const connections = new Set(["'self'"]);
  if (origins.length) connections.add(assetOrigin);
  for (const value of origins) {
    try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) continue; connections.add(url.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; connections.add(url.origin); } catch { /* Relative main URL uses self. */ }
  }
  return `default-src 'self'; script-src 'self' 'unsafe-hashes' ${[...hashes].join(' ')}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: ${assetOrigin} https://fonts.gstatic.com; img-src 'self' data: blob: ${assetOrigin}; media-src 'self' blob: ${assetOrigin}; connect-src ${[...connections].join(' ')}; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'`;
}
