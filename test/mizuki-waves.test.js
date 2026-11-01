import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';

const route = { motion: 'WALK', start: [9, 9], end: [9, 3],
  checkpoints: [{ type: 'WAIT', time: 100, pos: [9, 9] }] };
const spawn = (extra = {}) => ({ actionType: 'SPAWN', key: 'enemy_1007_slime',
  count: 1, interval: 1, preDelay: 0, routeIndex: 0, ...extra });
const wave = (fragments, extra = {}) => ({ preDelay: 0, postDelay: 0,
  maxTimeWaitingForNextWave: -1, fragments, ...extra });
const fragment = (actions, extra = {}) => ({ preDelay: 0, actions, ...extra });
const create = (officialLevel, options = {}) => new MizukiCombat({
  seed: 42, fieldId: 'mizuki_waves', stageId: 'act1autochess_m02',
  rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, content: 'none',
  players: [{ playerId: 'p1', units: [] }],
  officialLevel: { routes: [route], ...officialLevel }, timeLimit: 600, ...options,
});
const processThrough = (combat, until) => {
  while (!combat.done && combat.time <= until + 1e-9) combat.step();
};

test('official waves choose one weighted alternative per fragment, including empty outcomes; total excludes alternatives', () => {
  const actions = [spawn({ key: '', randomSpawnGroupKey: 'g', weight: 850 }),
    spawn({ randomSpawnGroupKey: 'g', weight: 150 }), spawn({ count: 2 })];
  const level = { waves: [wave([fragment(actions), fragment(actions)])] };
  const a = create(level), b = create(level);
  assert.deepEqual(a.snapshot().officialWaves.selections, b.snapshot().officialWaves.selections);
  const selected = a.officialWaves.selections;
  assert.equal(selected.length, 2);
  assert.equal(a.battle.total, 4 + selected.filter((s) => s.key).length);
  assert.equal(a.battle._pending.filter((p) => p.enemyKey === '').length, 0);
  assert.equal(a.officialWaves.waves[0].fragments[0].actions.length, 2);
  assert.notEqual(a.officialWaves.waves[0].fragments[0], a.officialWaves.waves[0].fragments[1]);
});

test('official fragment preDelay, action preDelay and count/interval accumulate without flattening all fragments', () => {
  const c = create({ waves: [wave([
    fragment([spawn({ preDelay: 2, count: 2, interval: 2 })], { preDelay: 1 }),
    fragment([spawn({ preDelay: 1 })], { preDelay: 3 }),
  ], { preDelay: 2 })] }, { spawns: [spawn({ time: 0 })] });
  assert.equal(c.battle.total, 3, 'legacy flattened spawns must not also run');
  processThrough(c, 4.9);
  assert.equal(c.battle.enemies.length, 0);
  processThrough(c, 5);
  assert.equal(c.battle.enemies.length, 1);
  processThrough(c, 7);
  assert.equal(c.battle.enemies.length, 2);
  processThrough(c, 10.9);
  assert.equal(c.battle.enemies.length, 2);
  processThrough(c, 11);
  assert.equal(c.battle.enemies.length, 3);
  assert.equal(c.snapshot().officialWaves.done, true);
  assert.deepEqual(c.battle.enemies.map((e) => e.deployedAt), [5, 7, 11]);
});

test('next official wave waits for the field to clear, with maxTimeWaitingForNextWave as the upper wait', () => {
  const make = () => create({ waves: [wave([fragment([spawn()])], { maxTimeWaitingForNextWave: 3 }),
    wave([fragment([spawn()])], { preDelay: 1 })] });
  const c = make();
  processThrough(c, 2.9);
  assert.equal(c.snapshot().officialWaves.wave, 0);
  processThrough(c, 3);
  assert.equal(c.snapshot().officialWaves.wave, 1);
  assert.equal(c.battle.enemies.length, 1);
  processThrough(c, 4);
  assert.equal(c.battle.enemies.length, 2);
  const cleared = make();
  processThrough(cleared, 0.5);
  cleared.battle.leak(cleared.battle.enemies[0]);
  processThrough(cleared, 0.6);
  assert.equal(cleared.snapshot().officialWaves.wave, 1);
  processThrough(cleared, 1.6);
  assert.equal(cleared.battle.enemies.filter((e) => e.alive).length, 1);
});

test('official blockFragment holds the next fragment until its own scheduled enemy resolves', () => {
  const c = create({ waves: [wave([fragment([spawn({ blockFragment: true })]),
    fragment([spawn()])])] });
  processThrough(c, 1);
  assert.equal(c.battle.enemies.length, 1);
  assert.equal(c.snapshot().officialWaves.fragment, 0);
  c.battle.leak(c.battle.enemies[0]);
  processThrough(c, 1.1);
  assert.equal(c.snapshot().officialWaves.fragment, 1);
  assert.equal(c.battle.enemies.filter((e) => e.alive).length, 1);
});

test('WAIT_CURRENT_FRAGMENT_TIME uses the fragment clock, so staggered spawns leave the wait together', () => {
  const c = create({ routes: [{ ...route, checkpoints: [
    { type: 'WAIT_CURRENT_FRAGMENT_TIME', time: 10, position: { row: 0, col: 0 } },
  ] }], waves: [wave([fragment([spawn({ preDelay: 4, count: 2, interval: 3 })])])] });
  processThrough(c, 7.1);
  assert.equal(c.battle.enemies.length, 2);
  assert.equal(c.battle.enemies[0].route.legIdx, 0);
  assert.equal(c.battle.enemies[1].route.legIdx, 0);
  const remaining = c.battle.enemies.map((e) => e.route.waitLeft);
  assert.ok(Math.abs(remaining[0] - remaining[1]) < 1 / 30 + 1e-8);
  processThrough(c, 9.9);
  assert.ok(c.battle.enemies.every((e) => e.route.legIdx === 0));
  processThrough(c, 10.1);
  assert.ok(c.battle.enemies.every((e) => e.route.legIdx === 1));
  assert.equal(c.battle.errorCount, 0);
});

test('official hidden groups stay opt-in, native boxes activate, and missing entities or unbound branches remain explicit', () => {
  const c = create({ enabledHiddenGroups: ['normal'],
    branches: { frosts: { phases: [] }, unknown_trigger: { phases: [] } },
    predefines: { tokenInsts: [{ alias: 'box', hidden: true, position: { row: 9, col: 7 },
      inst: { characterKey: 'trap_065_normbox', level: 1, phase: 'PHASE_0' } }] },
    waves: [wave([fragment([spawn({ hiddenGroup: 'normal' }), spawn({ hiddenGroup: 'raid' }),
      { actionType: 'ACTIVATE_PREDEFINED', key: 'box', count: 1 },
      { actionType: 'ACTIVATE_PREDEFINED', key: 'missing_native_predefine', count: 1 },
      { actionType: 'PREVIEW_ROUTE', key: '', count: 1 }])])] });
  processThrough(c, 0);
  const s = c.snapshot().officialWaves;
  assert.equal(c.battle.total, 1);
  assert.equal(s.skippedHidden, 1);
  assert.deepEqual(s.unsupported.filter((u) => u.code === 'BRANCH_TRIGGERS_UNSUPPORTED')
    .map((u) => u.key).sort(), ['frosts', 'unknown_trigger']);
  assert.ok(s.unsupported.some((u) => u.code === 'PREDEFINED_MISSING' && u.key === 'missing_native_predefine'));
  assert.equal(s.activatedPredefines.find((v) => v.key === 'box').activated, true);
  assert.equal(s.activatedPredefines.find((v) => v.key === 'missing_native_predefine').activated, false);
  assert.equal(s.unsupported.some((u) => u.key === 'box'), false);
  assert.deepEqual(s.branchCalls, []);
  assert.ok(!s.unsupported.some((u) => u.key === 'PREVIEW_ROUTE'));
});

test('official waves keep an empty field open until delayed fragments are actually scheduled', () => {
  const c = create({ waves: [wave([fragment([], { preDelay: 5 }), fragment([spawn()], { preDelay: 2 })])] });
  processThrough(c, 4);
  assert.equal(c.done, false);
  assert.equal(c.snapshot().officialWaves.done, false);
  processThrough(c, 7);
  assert.equal(c.battle.enemies.length, 1);
  assert.equal(c.done, false);
});

test('real official 1-2 and 1-3 choose alternatives and bind their exact native badbox branch keys', () => {
  for (const id of ['1-2', '1-3']) {
    const level = JSON.parse(fs.readFileSync(new URL('../data/mizuki/levels/level_rogue2_' + id + '.json', import.meta.url)));
    const c = create(level);
    const s = c.snapshot().officialWaves;
    assert.ok(s.selections.length > 2);
    const allAlternatives = level.waves.flatMap((w) => w.fragments.flatMap((f) => f.actions))
      .filter((a) => a.actionType === 'SPAWN' && a.key).reduce((n, a) => n + a.count, 0);
    assert.ok(c.battle.total < allAlternatives);
    const branchKeys = Object.keys(level.branches).sort();
    assert.deepEqual(branchKeys, ['trap_068_badbox#1', 'trap_068_badbox#2']);
    assert.deepEqual(c.stageMechanics.waveOptions.supportedBranchKeys.slice().sort(), branchKeys);
    assert.equal(s.unsupported.some((u) => u.code === 'BRANCH_TRIGGERS_UNSUPPORTED'), false);
    assert.deepEqual(s.branchCalls, [], 'bound branches wait for the original box event, not eager expansion');
    assert.ok(c.battle._pending.every((p) => c.battle.data.getEnemy(p.enemyKey)));
    c.step();
    assert.equal(c.battle.errorCount, 0);
  }
});
