import test from 'node:test';
import assert from 'node:assert/strict';
import { requestId } from '../public/js/requestId.js';

test('request IDs use native randomUUID with its original receiver when available', () => {
  let calls = 0;
  const source = {
    randomUUID() { assert.equal(this, source); calls++; return 'a0e47869-8b79-4ecd-b112-2a1abbd33886'; },
    getRandomValues() { assert.fail('native UUID support should not invoke a fallback'); },
  };
  assert.equal(requestId(source), 'a0e47869-8b79-4ecd-b112-2a1abbd33886');
  assert.equal(calls, 1);
});

test('HTTP LAN request IDs use getRandomValues when randomUUID is absent or throws', () => {
  let generation = 0;
  const source = {
    getRandomValues(bytes) {
      assert.equal(this, source); assert.ok(bytes instanceof Uint8Array);
      for (let index = 0; index < bytes.length; index++) bytes[index] = generation + index;
      generation++; return bytes;
    },
  };
  const first = requestId(source);
  source.randomUUID = () => { throw new Error('not available on this origin'); };
  const second = requestId(source);
  for (const value of [first, second]) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test('old-browser request IDs remain distinct for actions sharing a timestamp and random value', t => {
  t.mock.method(Date, 'now', () => 123456789);
  t.mock.method(Math, 'random', () => 0.25);
  const unsupported = { randomUUID() { throw Error('unsupported'); }, getRandomValues() { throw Error('unsupported'); } };
  const ids = Array.from({ length: 256 }, (_, index) => requestId(index % 2 ? null : unsupported));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256));
});
