import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webgl2Available } from '../public/js/render/board3d/load.js';

test('WebGL2 probe retries without performance caveat on usable devices', () => {
  const old = globalThis.document;
  const calls = [];
  globalThis.document = { createElement() { return { getContext(kind, attrs) { calls.push(attrs); return attrs?.failIfMajorPerformanceCaveat ? null : { getExtension() { return null; } }; } }; } };
  try { assert.equal(webgl2Available(false), true); assert.equal(calls.length, 2); }
  finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
});
