import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { compileEffect, Effect } from '../../public/js/render/vfx/effect.js';
import { FrameData, cameraBasis } from '../../public/js/render/vfx/geom.js';

const key = 'wildmn_skill_02_start';
const read = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const descriptor = read('../../public/assets/local/fx/prefabs/' + key + '.json');
const index = read('../../public/assets/local/fx/index.json');
const def = compileEffect(descriptor);
const camera = cameraBasis(30, [0, -5, -10], 900, 40 * Math.PI / 180);
const direction = { RIGHT: [1, 0], UP: [0, 1], LEFT: [-1, 0], DOWN: [0, -1] };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);

for (const [dir, [dx, dy]] of Object.entries(direction)) for (const z of [0, 1]) {
  test(`Wild Mane S2 lance flashes stay in front facing ${dir} at height ${z}`, () => {
    const owner = { id: 7, x: 8, y: 8, z, dir, alive: true, visFacing: dx < 0 ? -1 : 1,
      info: { id: 7, kind: 'op', side: 'ally', spine: 'char_496_wildmn', skillIndex: 1 } };
    const enemy = { id: 8, x: owner.x + 2 * dx, y: owner.y + 2 * dy, z,
      isEnemy: true, alive: true, info: { id: 8, kind: 'enemy' } };
    const effects = [];
    const ofx = { active: true, time: 0, timers: [], ctx: { cam: () => ({ tilt: 30 }) },
      lib: { has: k => k === key, def: k => k === key ? def : null }, ready: k => k === key,
      spawn: (k, place, opts) => {
        const effect = new Effect(def, { seed: 17 });
        effect.place(place); effect.track = opts.track; effects.push(effect);
        return { key: k, alive: true, stop() { this.alive = false; } };
      } };
    const wiring = new FxWiring(ofx); wiring.idx = index;
    assert.equal(wiring.castStart(owner, enemy, 'melee', { skillOn: true }), true);
    assert.equal(effects.length, 1);
    const effect = effects[0];
    const sample = () => {
      for (const node of [7, 8]) {
        const frame = new FrameData();
        const geometry = effect.build({ part: 'ps', node }, camera, frame, 0);
        assert.equal(geometry?.count, 1, 'authored flash is visible');
        const x = frame.quad[0] + 10 - owner.x, y = frame.quad[1] + 9 - owner.y;
        const forward = x * dx + y * dy;
        assert.ok(forward > 0 && forward < 2.6, `flash belongs in the forward two-tile thrust, got ${forward}`);
        // The source keeps a 0.2-tile static offset before its direction helper.
        near(x * -dy + (y - 0.2) * dx, descriptor.nodes[node].pos[1]);
        near(frame.quad[2], -z - 0.25);
      }
    };
    for (let frame = 0; frame < 30; frame++) effect.update(1 / 60);
    sample();
    // Moving the owner carries both flashes without changing their attack side.
    owner.x += 1; owner.y += 1; effect.update(1 / 60); sample();
  });
}

test('Wild Mane pivot adaptation keeps source data, hit effects and unrelated prefabs intact', () => {
  assert.deepEqual(descriptor.nodes[7].particleSystemRenderer.m_Pivot, [1, 0, 0]);
  assert.deepEqual(def.psr[7].pivot, [-1, -0, -0]);
  assert.deepEqual(def.psr[8].pivot, [-1, -0, -0]);
  const ordinary = compileEffect({ ...descriptor, key: 'unrelated-effect' });
  assert.deepEqual(ordinary.psr[7].pivot, [1, 0, 0]);
  const hit = read('../../public/assets/local/fx/prefabs/wildmn_skill_02_hit.json');
  assert.deepEqual(compileEffect(hit).psr[7].pivot, hit.nodes[7].particleSystemRenderer.m_Pivot);
  const attack = read('../../public/assets/local/fx/prefabs/wildmn_attack_01_start.json');
  assert.deepEqual(compileEffect(attack).psr[5].pivot, [-1, -0, -0]);
});
