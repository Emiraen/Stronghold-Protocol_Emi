import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { UF } from '../../shared/constants.js';

let fake, UnitView;
before(async () => {
  fake = installFakePixi();
  ({ UnitView } = await import('../../public/js/render/units.js'));
});
after(() => fake.restore());
const cam = () => presetCamera('normal', { width: 1280, height: 720 });
const state = (flags) => ({ x: 5, y: 10, hp: 1000, maxHp: 1000, sp: 0, spMax: 0, flags, anim: 0 });
function view(motion) {
  return new UnitView(fakeViewCtx(fake.P, { cam }), {
    id: 1, side: 'enemy', kind: 'enemy', defId: 'enemy_test', motion,
    tier: 1, x: 5, y: 10, maxHp: 1000, dir: 'RIGHT',
  });
}

test('UnitView lands a static flyer when its snapshot clears FLYING', () => {
  const v = view('FLY');
  v.sync(state(UF.FLYING), 1); assert.equal(v.flying, true);
  v.sync(state(0), 2); assert.equal(v.flying, false);
  v.sync(state(UF.FLYING), 3); assert.equal(v.flying, true);
  v.destroy();
});

test('UnitView follows hovering WALK snapshots and preserves initial info fallback without flags', () => {
  const v = view('WALK'), legacy = view('FLY');
  v.sync(state(UF.FLYING), 1); assert.equal(v.flying, true);
  v.sync(state(0), 2); assert.equal(v.flying, false);
  const old = state(); delete old.flags;
  legacy.sync(old, 1); assert.equal(legacy.flying, true);
  v.sync(old, 3); assert.equal(v.flying, false);
  v.destroy(); legacy.destroy();
});
