import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { siteCsp, SIM_WORKER_CSP } from '../server/http/csp.js';
import { narrowDeflateOffer } from '../server/http/websocketCompat.js';
import { isProtectedEastPath, removalProblem, parseManifest, applyPendingUpdate, UPDATE_FORMAT } from '../server/update.js';
import { isRefused, isPlayerFile } from '../tools/package.mjs';

test('East CSP hashes trusted CRLF boot scripts and keeps Win7, configured cross-region sockets and worker isolation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'east-csp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.html'), '<script>\r\nwindow.boot = true;\r\n</script>');
  const csp = siteCsp(root, ['https://east.example:48335', 'http://south.example:3000', 'javascript:bad']);
  const digest = createHash('sha256').update('\nwindow.boot = true;\n').digest('base64');
  assert.ok(csp.includes(`'sha256-${digest}'`));
  assert.ok(csp.includes('https://u75731.nyat.app:48335'));
  assert.ok(csp.includes('wss://east.example:48335'));
  assert.ok(csp.includes('ws://south.example:3000'));
  assert.ok(!csp.includes('javascript:'));
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  assert.ok(SIM_WORKER_CSP.includes("connect-src 'none'"));
  assert.ok(SIM_WORKER_CSP.includes("'unsafe-eval'"));
});

test('only entirely narrow deflate offers fall back, compatible alternatives keep compression', () => {
  assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=8'), true);
  assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits="8", permessage-deflate; server_max_window_bits=8'), true);
  assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=8, permessage-deflate'), false);
  assert.equal(narrowDeflateOffer('permessage-deflate; client_max_window_bits=8'), false);
  assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=15'), false);
});

test('East code packages and update removals protect accounts, leases, live state, announcements and independent art', () => {
  for (const name of ['player-registry.json', 'ranked-profiles.json', 'match-history.json', 'public/announcement.json', 'server/profile-replication-main.json', 'data/profile-pending-secondary.json', '.state/server-3000/index.json', '.static-compressed/index.json', '.env', 'plugins/config.json']) {
    assert.equal(isProtectedEastPath(name), true, name);
    assert.equal(isRefused(name), true, name);
    assert.ok(removalProblem(name), name);
    assert.throws(() => parseManifest(JSON.stringify({ format: UPDATE_FORMAT, app: '0.2.1', files: { [name]: { size: 0, sha256: '0'.repeat(64) } } })), /protected/);
  }
  assert.ok(removalProblem('public/assets/resource-required.sprpack'));
  assert.ok(removalProblem('public/fonts/custom.woff2'));
  assert.equal(isPlayerFile('admin/app.js'), true);
  assert.equal(isRefused('server/profileService.js'), false);
});

test('manual update verifies first, deletes only exact obsolete bytes and preserves locally edited files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'east-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = text => createHash('sha256').update(text).digest('hex');
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'server/new.js'), 'new');
  fs.writeFileSync(path.join(root, 'server/obsolete.js'), 'old');
  fs.writeFileSync(path.join(root, 'server/edited.js'), 'owner edit');
  const files = { 'server/new.js': { size: 3, sha256: sha('new') } };
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ format: UPDATE_FORMAT, app: '0.2.2', files }));
  fs.writeFileSync(path.join(root, 'UPDATE.json'), JSON.stringify({ format: UPDATE_FORMAT, app: '0.2.2', from: ['0.2.1'], count: 1, bytes: 3, files, removed: ['obsolete', 'edited'].map(name => ({ path: `server/${name}.js`, sha256: [sha('old')] })) }));
  const result = applyPendingUpdate(root, { log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.state, 'applied');
  assert.equal(fs.existsSync(path.join(root, 'server/obsolete.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'server/edited.js'), 'utf8'), 'owner edit');
  assert.equal(fs.existsSync(path.join(root, '.update-applied.json')), true);
});
