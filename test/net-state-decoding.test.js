import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../public/js/net.js';

function decoder() { const net = new Net(); net._stateDelta = true; return net; }
const full = (value, k = value.t, e = 1) => ({ t: 'net.state', k, e, n: 1, v: value });
const delta = (p, n = 2, k = 'm.public', e = 1) => ({ t: 'net.delta', k, e, n, b: n - 1, p });
const state = () => ({ t: 'm.public', players: [{ hp: 10, board: [{ uid: 1, gear: ['x'] }] }, { hp: 20 }],
  unchanged: { nested: [1, 2] } });

test('decoded full and sparse states remain isolated from subscriber mutations', () => {
  const net = decoder();
  const first = net._decodeState(full(state()));
  first.players[0].board[0].gear.push('consumer'); first.unchanged.nested[0] = 99;
  const next = net._decodeState(delta([[['players', '1', 'hp'], 19]]));
  assert.deepEqual(next.players[0].board[0].gear, ['x']);
  assert.deepEqual(next.unchanged.nested, [1, 2]);
  next.players[0].board[0].gear.push('changed again'); next.unchanged.nested[1] = 88;
  const latest = net._decodeState(delta([[['players', '0', 'hp'], 8]], 3));
  assert.deepEqual(latest, { ...state(), players: [{ ...state().players[0], hp: 8 }, { hp: 19 }] });
});

test('path copies support sibling edits, deletions, array replacement and root replacement', () => {
  const net = decoder(); net._decodeState(full(state()));
  const next = net._decodeState(delta([
    [['players', '0', 'hp'], 9], [['players', '1', 'hp'], 18], [['players', '0', 'board']],
    [['unchanged', 'nested'], [3, 4]], [['new'], { deep: { a: 1 } }], [['new', 'deep', 'a'], 2],
  ]));
  assert.deepEqual(next.players, [{ hp: 9 }, { hp: 18 }]);
  assert.deepEqual(next.unchanged.nested, [3, 4]); assert.equal(next.new.deep.a, 2);
  const replaced = net._decodeState(delta([[[], { t: 'm.public', value: { x: 1 } }], [['value', 'x'], 2]], 3));
  assert.deepEqual(replaced, { t: 'm.public', value: { x: 2 } });
});

test('array deletion keeps wire patch semantics and normalizes only the stored baseline', () => {
  const net = decoder(); net._decodeState(full(state()));
  const next = net._decodeState(delta([[['unchanged', 'nested', '0']]]));
  assert.equal(Object.hasOwn(next.unchanged.nested, 0), false);
  assert.deepEqual(net._decodeState(delta([], 3)).unchanged.nested, [null, 2]);
});

test('invalid paths and reconstruction failures never alter a retained baseline', () => {
  for (const path of [['__proto__', 'polluted'], ['players', 'constructor'], ['missing', 'hp'], ['players', 0]]) {
    const net = decoder(); net._decodeState(full(state()));
    assert.throws(() => net._decodeState(delta([[['players', '0', 'hp'], 1], [path, 0]])));
    assert.deepEqual(net._stateBases.get('m.public').v, state());
    assert.equal(Object.prototype.polluted, undefined);
  }
  const net = decoder(); net._decodeState(full(state()));
  assert.throws(() => net._decodeState(delta([[['t'], 'wrong']])));
  assert.deepEqual(net._stateBases.get('m.public').v, state());
});

test('independent battle baselines, sequence checks and epoch recovery are unchanged', () => {
  const net = decoder();
  for (const fieldId of ['left', 'right']) net._decodeState(full({ t: 'b.snap', fieldId, hp: 10 }, `b.snap:${fieldId}`));
  assert.deepEqual(net._decodeState(delta([[['hp'], 8]], 2, 'b.snap:left')), { t: 'b.snap', fieldId: 'left', hp: 8 });
  assert.equal(net._stateBases.get('b.snap:right').v.hp, 10);
  assert.throws(() => net._decodeState(delta([], 4, 'b.snap:left')));
  assert.throws(() => net._decodeState(delta([], 2, 'b.snap:right', 2)));
  net._decodeState(full(state(), 'm.public', 2));
  assert.deepEqual([...net._stateBases.keys()], ['m.public']);
});
