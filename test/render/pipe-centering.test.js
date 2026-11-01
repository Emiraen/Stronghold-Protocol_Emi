import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { UNIT } from '../../public/js/render/style.js';
import { pickUnitOf } from '../../public/js/render/app/pick.js';
import { hitTiles, pickBattle } from '../../public/js/render/pick.js';
import { hitRect, bodyKeys, normHitArea } from '../../server/sim/body.js';

const enemies = JSON.parse(fs.readFileSync(new URL('../../data/enemies.json', import.meta.url), 'utf8'));
const waves = JSON.parse(fs.readFileSync(new URL('../../data/waves.json', import.meta.url), 'utf8'));
let fake, UnitView, enemyModelOriginX;
before(async () => {
  fake = installFakePixi();
  ({ UnitView, enemyModelOriginX } = await import('../../public/js/render/units.js'));
});
after(() => fake.restore());
const cam = presetCamera('boss', { width: 1280, height: 720 });
const tick = () => new Promise(resolve => setImmediate(resolve));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, String(a) + ' != ' + b);
async function view(key, x = 10, side = 'enemy') {
  const entry = { skel: '/s/x.skel', atlas: '/s/x.atlas', textures: ['/s/x.png'],
    anims: { idle: 'Idle' }, animations: { Idle: 1 }, bounds: { x: -320, y: -810, width: 1170, height: 870 } };
  const assets = { picture: () => null, image: async () => null, spineEntry: () => entry,
    spine: { acquire: async () => ({ animations: [{ name: 'Idle' }] }), release() {} } };
  const v = new UnitView(fakeViewCtx(fake.P, { assets, cam: () => cam, lookupDef: i => enemies[i.defId] }),
    { id: key, kind: side === 'enemy' ? 'enemy' : 'chess', side, defId: key, spine: key,
      x, y: 3, maxHp: 1000, boss: true, facing: -1 });
  await tick(); await tick();
  assert.ok(v.spineReady);
  return v;
}

test('both pipe variants: model, HUD, shadow and pick box share the hit-area column through both facings', async () => {
  for (const [key, x] of [['enemy_9021_acduml', 10], ['enemy_9021_acduml_2', 9]]) {
    const v = await view(key, x);
    for (const facing of [-1, 1]) {
      v.visFacing = facing;
      v.update(1 / 60, cam, 0);
      const centre = cam.project(10, 3, 0);
      const sc = v.screen.s * UNIT.modelScale * v.modelK;
      close(v.screen.x, centre.x);
      close(v.root.x, centre.x);
      close(v.shadow.x, centre.x);
      close(v.hpBg.x + v.hpBg.width / 2, centre.x);
      close(v.actor.spine.x + enemyModelOriginX(v.info) * sc * facing, 0);
      const pick = pickUnitOf(v, true, enemies[key].hitArea);
      close(pick.body.x, centre.x);
      assert.deepEqual(pick.area, hitRect({ x, y: 3, hitArea: normHitArea(enemies[key].hitArea) }));
      assert.equal(pick.area.x0 + pick.area.x1, 20);
      assert.equal(pickBattle([pick], null, centre.x, v.screen.top + 2)?.ref, v);
      assert.equal(v.x, x, 'no authoritative unit movement');
      assert.equal(v.y, 3);
    }
    v.destroy();
  }
});

test('impostor, direct bypass and return keep one fixed centre, with bone offsets matching the drawing', async () => {
  const v = await view('enemy_9021_acduml_2', 9);
  v._box = { x0: -320, y0: -810, w: 1170, h: 870, over: new Set() };
  v.ctx.renderer = { CONTEXT_UID: 1, resolution: 1, render() {} };
  for (const sc of [0.1, 0.25]) for (const flip of [-1, 1]) {
    v.visFacing = flip;
    v._updateImpostor(sc, flip, 0xffffff, 0, 1);
    close(v.imp.sprite.x + v.modelOriginX * sc * flip, 0);
    v._impBypass(true);
    v._drawDirect(sc, flip, 0xffffff, 0, true);
    close(v.actor.spine.x + v.modelOriginX * sc * flip, 0);
    v._leaveImpostor();
    v._drawDirect(sc, flip, 0xffffff, 0, true);
    close(v.actor.spine.x + v.modelOriginX * sc * flip, 0);
    v.actor.spine.skeleton.findBone = () => ({ matrix: { tx: v.modelOriginX, ty: -50, a: 1, b: 0 } });
    v.actor._applied = true;
    close(v.boneOffset('muzzle').x, 1);
  }
  v.destroy();
});

test('all four real pipe wave templates have centred, identical client/server 5x3 hit regions', () => {
  let count = 0;
  for (const w of Object.values(waves)) for (const spawn of w.spawns || []) {
    if (!['enemy_9021_acduml', 'enemy_9021_acduml_2'].includes(spawn.key)) continue;
    const [y, x] = w.routes[spawn.routeIndex].start;
    const a = enemies[spawn.key].hitArea;
    const client = hitTiles(x, y, a);
    const server = bodyKeys({ x, y, hitArea: normHitArea(a) }).map(k => [Math.floor(k / 21), k % 21]);
    assert.deepEqual(client, server);
    assert.equal(client.length, 15);
    assert.deepEqual([...new Set(client.map(t => t[1]))], [8, 9, 10, 11, 12]);
    assert.deepEqual([...new Set(client.map(t => t[0]))], [3, 4, 5]);
    count++;
  }
  assert.equal(count, 4);
});

test('other enemies and allied units retain their original placement and bone offsets', async () => {
  for (const [key, side] of [['enemy_9013_acstmk', 'enemy'], ['enemy_1007_slime', 'enemy'], ['enemy_9021_acduml_2', 'ally']]) {
    const v = await view(key, 8, side);
    v.update(1 / 60, cam, 0);
    assert.equal(v.modelOriginX, 0);
    assert.equal(v.modelAnchorX, 0);
    assert.equal(v.actor.spine.x, 0);
    close(v.screen.x, cam.project(8, 3, 0).x);
    v.destroy();
  }
});
