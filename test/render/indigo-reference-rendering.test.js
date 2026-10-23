import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { UnitView } from '../../public/js/render/units.js';

let fake;
before(() => { fake = installFakePixi(); });
after(() => fake.restore());
const camera = () => presetCamera('prep', { width: 1280, height: 720 });
const variants = [
  ['char_469_indigo', '/assets/spine/op/char_469_indigo/front/char_469_indigo.skel'],
  ['char_469_indigo_2', '/assets/spine/op/char_469_indigo/back/char_469_indigo.skel'],
  ['char_469_indigo@nian#7', '/assets/spine/op/char_469_indigo/char_469_indigo_nian_7/front/char_469_indigo_nian_7.skel'],
];

async function figure(spine, skel, interval = 0) {
  const renders = [], allocations = [], draws = [], freed = [];
  const entry = { skel, anims: { idle: 'Idle' }, animations: { Idle: 1 } };
  const parked = new fake.P.Container();
  const atlas = {
    parked,
    alloc(w, h, { clip }) {
      const slot = { w, h, clip, tex: fake.P.RenderTexture.create({ width: w, height: h }) };
      allocations.push(slot);
      return slot;
    },
    draw(slot, model, transform) { draws.push({ slot, model, transform }); },
    free(slot) { freed.push(slot); },
    park(model) { parked.addChild(model); model.visible = false; },
    unpark(model) { model.parent?.removeChild(model); model.visible = true; },
  };
  let refreshInterval = interval;
  const ctx = fakeViewCtx(fake.P, {
    assets: { spineEntry: () => entry, spine: { acquire: async () => ({ animations: [{ name: 'Idle' }] }), release() {} } },
    renderer: { resolution: 1, render: (model, opts) => renders.push({ model, target: opts.renderTexture }) },
    impostors: atlas,
    impostorInterval: () => refreshInterval,
  });
  const v = new UnitView(ctx, { id: 1, kind: 'op', side: 'ally', defId: 'chess_char_1_17_a', spine, x: 5, y: 10, maxHp: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(v.spineReady);
  return { v, atlas, renders, allocations, draws, freed,
    step: () => v.update(1 / 60, camera(), 1),
    interval: n => { refreshInterval = n; },
  };
}

test('default, elite and skin Indigo models use ordinary direct rendering', async () => {
  for (const [spine, skel] of variants) {
    const { v, renders, allocations, step } = await figure(spine, skel);
    step();
    assert.equal(v.imp, undefined, spine);
    assert.equal(v.actor.spine.parent, v.body, spine);
    assert.ok(v.actor.spine.visible && v.actor.spine.alpha > 0, spine);
    assert.equal(allocations.length, 0);
    assert.equal(renders.length, 0);
    v.destroy();
  }
});

test('crowded Indigo models share the ordinary atlas and return to direct rendering when it is no longer needed', async () => {
  for (const [spine, skel] of variants) {
    const { v, atlas, renders, allocations, draws, freed, step, interval } = await figure(spine, skel, 2);
    v.actor.clipBounds = () => new Map([['Idle', [-50, -100, 50, 0]]]);
    step();
    assert.equal(allocations.length, 1, spine);
    assert.equal(v.imp.slot, allocations[0]);
    assert.equal(v.imp.rt, null, 'the shared atlas does not need a private render target');
    assert.equal(v.actor.spine.parent, atlas.parked);
    assert.equal(draws.length, 1);
    assert.equal(draws[0].model, v.actor.spine);
    assert.equal(renders.length, 0);
    interval(0);
    step();
    assert.equal(v.imp, null);
    assert.equal(v.actor.spine.parent, v.body);
    assert.ok(v.actor.spine.visible);
    assert.deepEqual(freed, allocations);
    v.destroy();
  }
});

test('pending clip bounds keep Indigo visible through direct rendering even in a crowded field', async () => {
  const { v, allocations, renders, step } = await figure(...variants[2], 2);
  v.actor.clipBounds = () => null;
  step();
  assert.equal(v.imp, undefined);
  assert.equal(v.actor.spine.parent, v.body);
  assert.ok(v.actor.spine.visible && v.actor.spine.alpha > 0);
  assert.equal(allocations.length, 0);
  assert.equal(renders.length, 0);
  v.destroy();
});
