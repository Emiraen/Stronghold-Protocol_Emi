import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { FxLibrary } from '../../public/js/render/vfx/library.js';

const operator = (id, spine, defId = 'chess_char_1_17_a') => ({
  id, x: 1, y: 2, z: 0, alive: true,
  info: { id, kind: 'op', side: 'ally', defId, spine },
});
const CAST = 'indigo_attack_01_start';

function wiring({ installed = true, ready = true } = {}) {
  const spawned = [];
  const available = new Set(installed ? [CAST, 'birth'] : []);
  const w = new FxWiring({
    active: true, time: 0, timers: [],
    lib: { has: key => available.has(key), def: () => null },
    ready: key => ready && available.has(key),
    spawn: (key, ...args) => {
      if (!ready || !available.has(key)) return null;
      spawned.push([key, ...args]);
      return { key, alive: true, stop() { this.alive = false; } };
    },
  }, { unitKey: info => [info.diy?.charId, info.spine].filter(Boolean) });
  const attack = { class: 'RangedAttack', cast: [{ effects: [CAST], oneshot: true }] };
  w.idx = {
    units: {
      char_469_indigo: { modes: [{ name: 'Default', attack }] },
      'char_469_indigo@nian#7': { modes: [{ name: 'Default', attack }] },
    },
    projectiles: {}, skins: {}, prefabs: {},
    generic: { birth: { char: 'birth' } },
  };
  return { w, spawned };
}

test('Indigo default, promotion and skin resolve ordinary official effects and preload keys', () => {
  const { w } = wiring();
  const views = [
    [operator(1, 'char_469_indigo'), 'char_469_indigo'],
    [operator(2, 'char_469_indigo_1'), 'char_469_indigo'],
    [operator(3, 'char_469_indigo_2'), 'char_469_indigo'],
    [operator(4, 'char_469_indigo@nian#7'), 'char_469_indigo@nian#7'],
    [{ ...operator(5, null, 'custom'), info: { id: 5, kind: 'op', diy: { charId: 'char_469_indigo_2' } } }, 'char_469_indigo'],
  ];
  for (const [v, key] of views) assert.equal(w.unitKeyOf(v), key);
  assert.deepEqual(w.keysFor(views.map(([v]) => v), false), [CAST]);
  assert.equal(w.unitKeyOf(operator(6, 'char_469_indigox', 'custom')), null, 'unknown models retain ordinary missing-index handling');
});

test('Indigo official casts and deployment draw when installed; missing or undecoded resources preserve procedural fallback', () => {
  const enemy = { id: 20, x: 4, y: 2, z: 0, isEnemy: true, info: { id: 20, kind: 'enemy' } };
  for (const config of [{ installed: true, ready: true }, { installed: false, ready: false }, { installed: true, ready: false }]) {
    const { w, spawned } = wiring(config);
    const v = operator(1, 'char_469_indigo@nian#7');
    const drawn = config.installed && config.ready;
    assert.equal(w.castStart(v, enemy, 'arts'), drawn);
    assert.equal(w.deploy(v), drawn);
    assert.deepEqual(spawned.map(([key]) => key), drawn ? [CAST, 'birth'] : []);
  }
});

test('installed Indigo prefabs and projectile keys load without an operator-specific blacklist', async () => {
  const keys = ['indigo_attack_charge_01_start', 'indigo_skill_02_buff_01', 'projectile_chr_indigo', 'projectile_chr_indigo_1'];
  const fetched = [];
  const lib = new FxLibrary({
    list: { groups: { 'fx/prefabs': Object.fromEntries(keys.map(key => [key, { path: `/fx/${key}.json` }])) } },
    fetch: async url => {
      fetched.push(url);
      return { ok: true, json: async () => ({ key: url.slice(4, -5), nodes: [], materials: [], textures: [], meshes: [], refs: [] }) };
    },
  });
  await lib.init();
  for (const key of keys) {
    assert.equal(lib.has(key), true);
    const def = await lib.load(key);
    assert.equal(def?.key, key);
    assert.equal(lib.def(key), def);
    assert.equal(lib.complete(key), true, 'the intentionally empty fixture has loaded completely');
  }
  assert.deepEqual(fetched, keys.map(key => `/fx/${key}.json`));
  assert.equal(lib.has('not_in_manifest'), false);
  assert.equal(await lib.load('not_in_manifest'), null);
});
