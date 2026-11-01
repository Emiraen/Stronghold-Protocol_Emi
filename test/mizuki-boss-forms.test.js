import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakePixi, fakeViewCtx } from './render/fakepixi.js';
import { presetCamera } from '../public/js/render/projection.js';
import { mizukiSpineEntry } from '../public/js/mizukiSpine.js';
import { parseSkel } from '../tools/assets/skel.mjs';
import { UF, ANIM } from '../shared/constants.js';

test('real paranoid bubble clips switch through recovery to form two and reconnect to the correct model', async t => {
  const fake = installFakePixi(); t.after(() => fake.restore());
  const { UnitView, FORMS } = await import('../public/js/render/units.js');
  const id = 'enemy_2037_sygirl';
  const parsed = parseSkel(readFileSync(new URL('../public/assets/mizuki/library/spines/enemy_2037_sygirl/enemy_2037_sygirl.skel', import.meta.url)));
  const entry = { ...mizukiSpineEntry(id, {}), animations: parsed.durations };
  const cam = () => presetCamera('normal', { width: 1280, height: 720 });
  const ctx = fakeViewCtx(fake.P, { cam, assets: { picture: () => null, image: async () => null, spineEntry: () => entry,
    spine: { acquire: async () => ({ animations: parsed.animations.map(name => ({ name })) }), release() {} } } });
  const create = async form => {
    const v = new UnitView(ctx, { id: 9, side: 'enemy', kind: 'enemy', defId: id, spine: id, x: 2, y: 2, maxHp: 1000, form });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    t.after(() => v.destroy()); assert.ok(v.actor); return v;
  };
  for (const spec of Object.values(FORMS[id])) for (const name of [spec.change, spec.end, spec.roles.idle, spec.roles.move?.loop, spec.roles.die])
    if (name) assert.ok(parsed.animations.includes(name), name);
  const v = await create(null);
  assert.equal(v.actor.current, 'C1_Idle');
  v.sync({ x: 2, y: 2, hp: 1000, maxHp: 1000, flags: UF.FLYING, anim: ANIM.IDLE }, 0);
  assert.equal(v.flying, true);
  v.sync({ x: 2, y: 2, hp: 1, maxHp: 1000, flags: UF.STUNNED, anim: ANIM.STUN }, 1);
  v.setForm('reborn', { dur: 20 }); assert.equal(v.actor.current, 'C1_Die');
  for (let frame = 1; frame <= 20 * 60; frame++) v.update(1 / 60, cam(), 1 + frame / 60);
  v.sync({ x: 2, y: 2, hp: 1000, maxHp: 1000, flags: 0, anim: ANIM.IDLE }, 21);
  v.setForm('form2');
  for (let frame = 1; frame <= 6; frame++) v.update(1 / 60, cam(), 21 + frame / 60);
  assert.equal(v.actor.current, 'C2_Idle');
  assert.equal(v.flying, false);
  const reconnected = await create('form2');
  reconnected.sync({ x: 2, y: 2, hp: 1000, maxHp: 1000, flags: 0, anim: ANIM.IDLE }, 22);
  assert.equal(reconnected.actor.current, 'C2_Idle');
  assert.equal(reconnected.flying, false);
});
