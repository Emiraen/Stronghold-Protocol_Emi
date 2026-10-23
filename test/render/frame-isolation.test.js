import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameGuard } from '../../public/js/render/frameGuard.js';

test('one failing model does not stop other models, FX ageing or atlas flushing', () => {
  const errors = [], ran = [];
  const guard = createFrameGuard(() => ({ resolution: 2, canvas: [1560, 720] }), { report: (...args) => errors.push(args), warn() {} });
  const bad = { id: 1, info: { defId: 'chess_char_1_17_a', skin: 'char_469_indigo@nian#7' } };
  for (let frame = 0; frame < 3; frame++) {
    assert.equal(guard('unit', bad, () => { throw new Error('bad pose'); }), false);
    guard('unit', { id: 2 }, () => ran.push('other'));
    guard('fx', null, () => ran.push('fx'));
    guard('atlas', null, () => ran.push('atlas'));
  }
  assert.deepEqual(ran, Array.from({ length: 3 }, () => ['other', 'fx', 'atlas']).flat());
  assert.equal(errors.length, 1, 'a persistent identical model failure is recorded once');
  assert.deepEqual(JSON.parse(errors[0][2]), { step: 'unit', id: 1, unit: bad.info.defId, skin: bad.info.skin, resolution: 2, canvas: [1560, 720] });
  assert.equal(guard('unit', bad, () => ran.push('recovered')), true);
});

test('failures in separate models and stages retain their own diagnostic', () => {
  const errors = [];
  const guard = createFrameGuard(() => ({}), { report: (...args) => errors.push(args), warn() {} });
  const a = {}, b = {};
  const fail = () => { throw new Error('same'); };
  guard('unit', a, fail); guard('unit', b, fail); guard('fx', null, fail); guard('atlas', null, fail);
  guard('unit', a, fail); guard('fx', null, fail);
  assert.equal(errors.length, 4);
});

test('diagnostic failures cannot stop subsequent frame work', () => {
  const fail = () => { throw new Error('failed'); };
  const guard = createFrameGuard(fail, { report: fail, warn: fail });
  let advanced = false;
  assert.equal(guard('unit', {}, fail), false);
  guard('fx', null, () => { advanced = true; });
  assert.equal(advanced, true);
});
