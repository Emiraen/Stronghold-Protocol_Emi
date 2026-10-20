import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { FxLibrary } from '../../public/js/render/vfx/library.js';

const operator = (id, spine, defId = 'chess_char_1_17') => ({
  id, x: 1, y: 2, z: 0, alive: true,
  info: { id, kind: 'op', side: 'ally', defId, spine },
});

function wiring() {
  const spawned = [];
  const w = new FxWiring({
    active: true, time: 0, timers: [],
    lib: { has: () => true, def: () => null },
    ready: () => true,
    spawn: (...args) => { spawned.push(args); return { alive: true, stop() {} }; },
  }, { unitKey: (info) => [info.diy?.charId, info.spine].filter(Boolean) });
  const attack = { class: 'RangedAttack', cast: [{ effects: ['amiya_cast'] }] };
  w.idx = {
    units: {
      char_469_indigo: { modes: [{ name: 'Default', attack }] },
      char_469_indigo_1: { modes: [{ name: 'Default', attack }] },
      'char_469_indigo@winter#1': { modes: [{ name: 'Default', attack }] },
      char_002_amiya: { modes: [{ name: 'Default', attack }] },
    },
    projectiles: {}, skins: {}, prefabs: {},
    generic: { birth: { char: 'birth' }, die: { char: 'die' }, status: { stun: 'stun' } },
  };
  return { w, spawned };
}

test('Indigo promotions, skins and chess identity never resolve optional effects', () => {
  const { w } = wiring();
  const views = [
    operator(1, 'char_469_indigo'),
    operator(2, 'char_469_indigo_1'),
    operator(3, 'char_469_indigo_2'),
    operator(4, 'char_469_indigo@winter#1'),
    operator(5, 'char_469_indigo_epoque#2'),
    operator(6, null),
    // A candidate preceding Indigo must not cause an unrelated official fallback.
    operator(7, 'char_002_amiya'),
    { ...operator(8, null, 'custom'), info: { id: 8, kind: 'op', diy: { charId: 'char_469_indigo_2' } } },
  ];
  for (const v of views) {
    assert.equal(w.unitKeyOf(v), null, String(v.id));
    assert.equal(w.keyCache.get(v.id), null, 'disabled resolution is cached');
    assert.equal(w.skills.of(v), null);
    assert.equal(w.talents.of(v), null);
    assert.equal(w.funnels.of(v), null);
  }
  assert.deepEqual(w.keysFor(views, false), [], 'no Indigo skills, charges, talents or shots preload');
});

test('Indigo combat events leave the renderer procedural fallback enabled', () => {
  const { w, spawned } = wiring();
  const v = operator(1, 'char_469_indigo@winter#1');
  const enemy = { id: 20, x: 4, y: 2, z: 0, isEnemy: true, info: { id: 20, kind: 'enemy' } };
  assert.equal(w.castStart(v, enemy, 'arts'), false);
  assert.equal(w.attack(v, enemy, 'arts', 0), false);
  assert.equal(w.skill(v, true), false);
  assert.equal(w.simFx('charge', v.x, v.y, { id: v.id }), false);
  assert.equal(w.deploy(v), false);
  assert.equal(w.spawned(v), false);
  assert.equal(w.status(v, 'stun', true), false);
  assert.equal(w.death(v), false);
  w.sync([v]);
  assert.deepEqual(spawned, [], 'optional layer draws no Indigo effects');
});

test('other operators keep their optional unit and preload paths', () => {
  const { w } = wiring();
  const amiya = operator(30, 'char_002_amiya', 'chess_char_other');
  assert.equal(w.unitKeyOf(amiya), 'char_002_amiya');
  assert.deepEqual(w.keysFor([amiya], false), ['amiya_cast']);
  assert.equal(w._proceduralOnly(operator(31, 'char_469_indigox', 'other')), false);
});

test('Indigo prefab and projectile keys cannot load even from an installed optional pack', async () => {
  const blocked = ['indigo_attack_charge_01', 'indigo_skill_loop', 'projectile_chr_indigo', 'projectile_chr_indigo_1'];
  const fetched = [];
  const lib = new FxLibrary({
    list: { groups: { 'fx/prefabs': Object.fromEntries([...blocked, 'amiya_cast'].map((k) => [k, { path: `/fx/${k}.json` }])) } },
    fetch: async (url) => { fetched.push(url); throw new Error('a disabled prefab must not fetch'); },
  });
  await lib.init();
  for (const k of blocked) {
    assert.equal(lib.has(k), false);
    assert.equal(lib.ready(k), false);
    assert.equal(await lib.load(k), null);
  }
  assert.equal(lib.has('amiya_cast'), true);
  assert.deepEqual(fetched, []);
});
