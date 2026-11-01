import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { mizukiMutationOptions, mizukiMutationPool, mizukiMutationSpec, mizukiMutationForGrade, getMizukiMutation,
  setMizukiMutationSuppressed, installMizukiNativeMutations, mizukiSanRange, createMizukiMutationState,
  validMizukiMutationState, createMizukiSanCheck, commitMizukiSanCheck, rerollMizukiSanCheck } from '../server/modes/mizuki/NativeMutations.js';

const catalog = createMizukiCatalog(getData({ log: { info() {}, warn() {}, error() {} } }));
const id = (index) => 'rogue_2_mutation_' + index;
function combat(mutation = null, chessId = 'chess_char_1_02_a') {
  const players = [{ playerId: 'p0', units: [{ uid: 101, chessId, mutationId: mutation }] }];
  const c = new MizukiCombat({ fieldId: 'native-mutation-test', seed: 42, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, data: catalog.source, players,
    flags: { dpInit: 999, dpMax: 999 }, spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }] });
  const controller = installMizukiNativeMutations(c.battle, { players });
  const unit = c.battle.getPlayer('p0').units[0];
  return { c, battle: c.battle, controller, unit, players,
    deploy: () => c.command('p0', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'RIGHT' }) };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + ' != ' + b);

test('all nineteen original reaction IDs decode without fabricated combinations', () => {
  assert.equal(mizukiMutationOptions().length, 19);
  assert.deepEqual(mizukiMutationPool(0), [1, 2, 3, 4].map(id));
  assert.deepEqual(mizukiMutationPool(16), [9, 10, 11, 12].map(id));
  assert.deepEqual(mizukiMutationPool(17), [13, 14, 15, 16, 17, 18].map(id));
  assert.deepEqual(mizukiMutationPool(18), mizukiMutationPool(17));
  assert.equal(mizukiMutationForGrade(id(1), 16), id(9));
  assert.equal(mizukiMutationSpec(id(13)).auto, true); assert.equal(mizukiMutationSpec(id(13)).freeze, 15);
  assert.equal(mizukiMutationSpec(id(14)).bleed, 150); assert.equal(mizukiMutationSpec(id(14)).freeze, 15);
  assert.equal(mizukiMutationSpec(id(15)).attributeScale, 0.5); assert.equal(mizukiMutationSpec(id(15)).freeze, 15);
  assert.equal(mizukiMutationSpec(id(16)).auto, true); assert.equal(mizukiMutationSpec(id(16)).bleed, 150);
  assert.equal(mizukiMutationSpec(id(17)).attributeScale, 0.5); assert.equal(mizukiMutationSpec(id(17)).auto, true);
  assert.equal(mizukiMutationSpec(id(18)).attributeScale, 0.5); assert.equal(mizukiMutationSpec(id(18)).bleed, 150);
});

test('official light bands select the correct native sanity dice event at every boundary', () => {
  assert.deepEqual([100, 99, 50, 49, 1, 0].map((light) => mizukiSanRange(light).diceGroupId), [1, 2, 2, 3, 3, 4].map((n) => 'rogue_2_dicegroup_' + n));
  const base = { diceId: 'rogue_2_dice_1', grade: 17, rng: () => 0, zoneId: 'floor-2', players: [] };
  for (const [light, roll, kind, event] of [[100, 5, 'quiet', 2], [100, 6, 'virtue', 1], [99, 3, 'mutation', 4],
    [50, 4, 'quiet', 3], [49, 5, 'mutation', 6], [1, 6, 'quiet', 5], [0, 5, 'mutation', 8], [0, 6, 'mutation', 7]]) {
    const check = createMizukiSanCheck({ ...base, light, roll }); assert.equal(check.kind, kind); assert.equal(check.diceEventId, 'rogue_2_diceEve_' + event);
  }
});

test('pending checks preserve original pool, commit once and retain mutation IDs across restore', () => {
  const players = [{ playerId: 'p0', roster: [{ uid: 1 }, { uid: 2 }] }, { playerId: 'p1', roster: [{ uid: 1 }] }];
  const check = createMizukiSanCheck({ light: 0, diceId: 'rogue_2_dice_1', grade: 17, rng: () => 0, players, zoneId: 'floor-3', roll: 1 });
  assert.equal(check.targets.length, 2); assert.ok(check.targets.every((target) => target.mutationId === id(13)));
  assert.ok(players.every((player) => player.roster.every((unit) => !unit.mutationId)), 'pending/rerolled rolls have no side effects');
  const state = createMizukiMutationState(); assert.deepEqual(commitMizukiSanCheck({ state, check, players }), { ok: true, check });
  assert.equal(validMizukiMutationState(state), true); assert.equal(validMizukiMutationState(structuredClone(state)), true);
  assert.equal(commitMizukiSanCheck({ state, check, players }).error, 'ALREADY');
  assert.equal(players[0].roster.filter((unit) => unit.mutationId === id(13)).length, 2);
  const saved = structuredClone({ state, players }); assert.equal(saved.players[0].roster[0].mutationId, id(13));
});

test('reroll spends one die without applying either pending result', () => {
  const players = [{ playerId: 'p0', roster: [{ uid: 1 }] }];
  const check = createMizukiSanCheck({ light: 49, diceId: 'rogue_2_dice_1', grade: 16, rng: () => 0, players, zoneId: 'floor-2', roll: 1 });
  const reroll = rerollMizukiSanCheck({ check, dice: 2, rng: () => 0.99, players });
  assert.equal(reroll.ok, true); assert.equal(reroll.dice, 1); assert.equal(reroll.check.roll, 6); assert.equal(reroll.check.kind, 'quiet');
  assert.equal(players[0].roster[0].mutationId, undefined);
  assert.equal(rerollMizukiSanCheck({ check, dice: 0, rng: () => 0, players }).error, 'NO_FUNDS');
});

test('combined attribute mutation changes actual stats cost and redeployment, evolution restores all of them', () => {
  const normal = combat(), f = combat(id(17));
  close(f.unit.s.atk, normal.unit.s.atk * 0.5); close(f.unit.s.def, normal.unit.s.def * 0.5);
  close(f.unit.s.maxHp, normal.unit.s.maxHp * 0.5); close(f.unit.base.cost, normal.unit.base.cost * 0.5);
  close(f.unit.base.respawnTime, normal.unit.base.respawnTime * 0.5);
  assert.equal(setMizukiMutationSuppressed(f.unit, true), true); assert.equal(getMizukiMutation(f.unit), id(17));
  close(f.unit.s.atk, normal.unit.s.atk); close(f.unit.base.cost, normal.unit.base.cost);
  setMizukiMutationSuppressed(f.unit, false); close(f.unit.s.atk, normal.unit.s.atk * 0.5);
  assert.equal(installMizukiNativeMutations(f.battle), f.controller, 'installation is idempotent');
});

test('combined freezing applies for native duration once per real deployment and suppresses independently', () => {
  const f = combat(id(14)); assert.equal(f.deploy().ok, true);
  assert.equal(f.unit.s.flags.freeze, true); close(f.unit.findBuff('mizuki:mutation:freeze').duration, 15);
  f.unit.findBuff('mizuki:mutation:freeze').timeLeft = 5;
  f.battle.emit('deploy', { unit: f.unit, move: true }); close(f.unit.findBuff('mizuki:mutation:freeze').timeLeft, 5);
  f.battle.addBuff(f.unit, { key: 'unrelated-status', duration: 20, flags: { disarm: true } });
  setMizukiMutationSuppressed(f.unit, true); assert.equal(f.unit.s.flags.freeze, undefined); assert.equal(f.unit.s.flags.disarm, true);
});

test('bleeding waits one second while injured, resets on healing, and cannot kill', () => {
  const f = combat(id(9)); assert.equal(f.deploy().ok, true);
  f.unit.hp = 200; f.battle.time = 0; f.battle.emit('tick', { dt: 1 / 30 });
  f.battle.time = 0.99; f.battle.emit('tick', { dt: 1 / 30 }); close(f.unit.hp, 200);
  f.battle.time = 1; f.battle.emit('tick', { dt: 1 / 30 }); close(f.unit.hp, 50);
  f.battle.time = 2; f.battle.emit('tick', { dt: 1 / 30 }); close(f.unit.hp, 1); assert.equal(f.unit.alive, true);
  f.unit.hp = f.unit.s.maxHp; f.battle.emit('tick', { dt: 1 / 30 }); f.unit.hp -= 1;
  f.battle.time = 2.5; f.battle.emit('tick', { dt: 1 / 30 }); const hp = f.unit.hp;
  f.battle.time = 3; f.battle.emit('tick', { dt: 1 / 30 }); close(f.unit.hp, hp);
  setMizukiMutationSuppressed(f.unit, true); f.battle.time = 10; f.battle.emit('tick', { dt: 1 / 30 }); close(f.unit.hp, hp);
});

test('combination auto skill ignores ordinary strategy enemy targeting when native skill is ready', () => {
  const f = combat(id(16)); assert.equal(f.deploy().ok, true);
  const skill = f.unit.skill; skill.setTrigger('NEVER'); skill.setSpTotal(skill.spCost);
  const before = skill.activations; f.battle.emit('tick', { dt: 1 / 30 });
  assert.equal(skill.activations, before + 1); assert.equal(skill.lastStart, f.battle.time);
});

test('temporary infection applies a native combined reaction without changing the persistent card', () => {
  const f = combat(); assert.equal(f.deploy().ok, true);
  assert.equal(f.controller.setMutation(f.unit, id(15), { temporary: true }), true);
  assert.equal(getMizukiMutation(f.unit), id(15)); assert.equal(f.players[0].units[0].mutationId, null);
  assert.equal(f.unit.s.flags.freeze, true); assert.equal(f.controller.snapshot()[0].mutationId, id(15));
  setMizukiMutationSuppressed(f.unit, true); assert.equal(f.unit.s.flags.freeze, undefined);
});

test('strengthened reactions decode real boosts, native initial SP and sixty idle stacks', () => {
  assert.equal(mizukiMutationSpec(id(5)).bleed, 300); assert.equal(mizukiMutationSpec(id(5)).lowHpAtk.minAtk, 1.2);
  assert.equal(mizukiMutationSpec(id(6)).idleStack.max, 60); assert.equal(mizukiMutationSpec(id(6)).idleStack.atk, 0.05);
  assert.equal(mizukiMutationSpec(id(7)).freeze, 30); assert.equal(mizukiMutationSpec(id(7)).frozenAtk, 2);
  assert.equal(mizukiMutationSpec(id(8)).attributeScale, 0.25); assert.equal(mizukiMutationSpec(id(8)).initialSp, 80);
  const f = combat(id(6)); assert.equal(f.deploy().ok, true); f.unit.skill.setSpTotal(0);
  const base = f.unit.s.atk; f.battle.emit('tick', { dt: 60 }); close(f.unit.s.atk, base * 4);
  assert.equal(f.unit.findBuff('mizuki:mutation:idle').mods.aspd, -120);
  f.battle.emit('skillEnd', { unit: f.unit }); close(f.unit.s.atk, base);
});
