import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { VENDOR_FILES } from '../tools/vendor.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('fflate is pinned and its browser ESM has a sustainable vendor source', () => {
  assert.equal(JSON.parse(read('package.json')).dependencies.fflate, '0.8.2');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages[''].dependencies.fflate, '0.8.2');
  assert.equal(lock.packages['node_modules/fflate'].version, '0.8.2');
  assert.ok(VENDOR_FILES.some(([src, dst]) => src === 'node_modules/fflate/esm/browser.js' && dst === 'fflate.module.js'));
  assert.equal(read('public/vendor/fflate.module.js'), read('node_modules/fflate/esm/browser.js'));
});

test('vendored fflate is a standalone ESM with no external module imports', () => {
  const ast = parse(read('public/vendor/fflate.module.js'), { ecmaVersion: 'latest', sourceType: 'module' });
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    assert.notEqual(node.type, 'ImportDeclaration');
    assert.notEqual(node.type, 'ImportExpression');
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') assert.ok(!node.source);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
});

test('vendored browser gzipSync and gunzipSync round-trip actual UTF-8 and binary bytes', async () => {
  const moduleUrl = new URL('public/vendor/fflate.module.js', root);
  assert.ok(fileURLToPath(moduleUrl).endsWith('fflate.module.js'));
  const { gzipSync, gunzipSync } = await import(moduleUrl.href);
  assert.equal(typeof gzipSync, 'function');
  assert.equal(typeof gunzipSync, 'function');
  const text = new TextEncoder().encode('卫戍协议：预载资源解压测试。\n'.repeat(256));
  const binary = Uint8Array.from({ length: 65536 }, (_, i) => (i * 13 + (i >>> 8)) & 255);
  for (const input of [new Uint8Array(), text, binary]) {
    const packed = gzipSync(input, { mtime: 0 });
    assert.equal(packed[0], 0x1f);
    assert.equal(packed[1], 0x8b);
    assert.deepEqual(gunzipSync(packed), input);
  }
});
