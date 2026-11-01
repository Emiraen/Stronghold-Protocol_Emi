import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../server/sim/Battle.js';
import { applyMizukiEvolutionReward, installMizukiNativeInfection } from '../server/modes/mizuki/NativeInfection.js';
import { getMizukiMutation } from '../server/modes/mizuki/NativeMutations.js';
import { holdProtect } from '../server/sim/content/kits/shared/tier1.js';

const mutation = (n) => 'rogue_2_mutation_' + n;
function setup(specs, { grade = 16, players: playerSpecs = null, ...options } = {}) {
  const playerInputs = playerSpecs ?? [{ playerId: 'p1', seat: 0, units: specs.map((s, i) => ({
    uid: i + 1, chessId: 'chess_char_1_02_a', abs: true, dir: 'RIGHT', ...s,
  })) }];
  const b = new Battle({ seed: 91, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: playerInputs, content: 'none',
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }],
    timeLimit: 180, flags: { dpInit: 999, dpMax: 999 } });
  const controller = installMizukiNativeInfection(b, { grade, players: playerInputs, ...options });
  const units = b.allyUnits.filter((unit) => unit.kind === 'op');
  return { b, controller, units, inputs: playerInputs, deploy: (index) => b._deploy(units[index]) };
}
const view = (c, u) => c.snapshot().units.find((entry) => entry.unitId === u.id);

test('original gene rewards permanently evolve affected roster cards without touching normal cards or equipment', () => {
  const players = [{ playerId: 'p1', roster: [{ uid: 1 }, { uid: 2, mutationId: mutation(3), equipment: ['a'] }] },
    { playerId: 'p2', roster: [{ uid: 1, mutationId: mutation(16) }, { uid: 2, mutationId: mutation(19) }] }];
  const single = applyMizukiEvolutionReward(players, 'rogue_2_pill', { pick: (list) => list[1] });
  assert.deepEqual(single.changes, [{ playerId: 'p2', uid: 1, before: mutation(16), mutationId: mutation(19) }]);
  assert.equal(players[0].roster[1].mutationId, mutation(3));
  const all = applyMizukiEvolutionReward(players, 'rogue_2_bigpill');
  assert.deepEqual(all.changes, [{ playerId: 'p1', uid: 2, before: mutation(3), mutationId: mutation(19) }]);
  assert.deepEqual(players[0].roster[1].equipment, ['a']);
  assert.equal(players[0].roster[0].mutationId, undefined);
  assert.deepEqual(applyMizukiEvolutionReward(players, 'rogue_2_bigpill'), { ok: false, error: 'NO_TARGET' });
  assert.deepEqual(applyMizukiEvolutionReward(players, 'invented'), { ok: false, error: 'BAD_ITEM' });
});

test('N15 has no gene infection; the original gene collectible also enables it below N16', () => {
  const specs = [{ row: 10, col: 5, mutationId: mutation(9) }, { row: 10, col: 6 }];
  const low = setup(specs, { grade: 15 });
  low.deploy(0); low.deploy(1);
  assert.equal(low.controller.enabled, false);
  assert.equal(getMizukiMutation(low.units[1]), null);
  const item = setup(specs, { grade: 15, collectibles: ['rogue_2_relic_fight_159'] });
  item.deploy(0); item.deploy(1);
  assert.equal(getMizukiMutation(item.units[1]), mutation(9));
});

test('permanent evolution protects roster cards below N16 without enabling gene propagation', () => {
  const s = setup([{ row: 10, col: 5, mutationId: mutation(19) }, { row: 10, col: 6 }], { grade: 0 });
  s.deploy(0); s.deploy(1);
  assert.equal(s.controller.enabled, false); assert.equal(view(s.controller, s.units[0]).evolved, true);
  assert.equal(s.units[0].s.physTakenMul, .65); assert.equal(s.units[0].s.defIgnorePct, .35);
  assert.equal(getMizukiMutation(s.units[1]), null);
  s.b.kill(s.units[0]); s.deploy(0); assert.equal(s.units[0].s.physTakenMul, .65);
});

test('original eight-cell order infects exactly two existing normal operators and evolves the host', () => {
  const s = setup([{ row: 10, col: 6, mutationId: mutation(12) },
    { row: 9, col: 6 }, { row: 11, col: 6 }, { row: 11, col: 5 }]);
  s.deploy(1); s.deploy(2); s.deploy(3); s.deploy(0);
  assert.equal(getMizukiMutation(s.units[3]), mutation(12));
  assert.equal(getMizukiMutation(s.units[2]), mutation(12));
  assert.equal(getMizukiMutation(s.units[1]), null);
  const host = view(s.controller, s.units[0]);
  assert.equal(host.remaining, 0); assert.equal(host.evolved, true);
  assert.equal(s.units[0]._mizukiMutationSuppressed, true);
  assert.equal(s.units[0].s.hpMul, undefined);
  assert.equal(s.units[0].s.maxHp, s.units[0].base.maxHp);
  assert.equal(s.units[2].s.maxHp, s.units[2].base.maxHp * .5);
  assert.equal(s.inputs[0].units[2].mutationId, undefined);
});

test('one normal deployment credits every nearby original host and does not create a new host', () => {
  const s = setup([{ row: 10, col: 5, mutationId: mutation(10) },
    { row: 10, col: 7, mutationId: mutation(9) }, { row: 10, col: 6 }, { row: 11, col: 6 }, { row: 12, col: 6 }]);
  s.deploy(0); s.deploy(1); s.deploy(2);
  assert.equal(view(s.controller, s.units[0]).remaining, 1);
  assert.equal(view(s.controller, s.units[1]).remaining, 1);
  assert.equal(view(s.controller, s.units[2]).original, false);
  // Native field blackboard is taken from the first originally affected card.
  assert.equal(getMizukiMutation(s.units[1]), mutation(10));
  assert.equal(getMizukiMutation(s.units[2]), mutation(10));
  s.deploy(3);
  assert.equal(view(s.controller, s.units[0]).evolved, true);
  assert.equal(view(s.controller, s.units[1]).evolved, true);
  s.deploy(4);
  assert.equal(getMizukiMutation(s.units[4]), null);
});

test('N17 combination reaction is inherited with all components and disappears on evolution', () => {
  const s = setup([{ row: 10, col: 5, mutationId: mutation(15) },
    { row: 10, col: 6 }, { row: 11, col: 6 }], { grade: 17 });
  s.deploy(0); assert.equal(s.units[0].s.flags.freeze, true);
  s.deploy(1);
  assert.equal(s.units[1].s.flags.freeze, true);
  assert.equal(s.units[1].s.maxHp, s.units[1].base.maxHp * .5);
  s.deploy(2);
  assert.equal(s.units[0].s.flags.freeze, undefined);
  assert.equal(s.units[0].s.maxHp, s.units[0].base.maxHp);
  assert.equal(s.units[0].base.respawnTime, s.units[1].base.respawnTime * 2);
});

test('evolution changes real physical/arts damage, ignores 35% DEF/RES, and shares strongest protection', () => {
  const s = setup([{ row: 10, col: 5, mutationId: mutation(10) }, { row: 10, col: 6 }, { row: 11, col: 6 }]);
  s.deploy(0); s.deploy(1); s.deploy(2);
  const host = s.units[0];
  assert.equal(host.s.defIgnorePct, .35); assert.equal(host.s.resIgnorePct, .35);
  assert.equal(host.s.physTakenMul, .65); assert.equal(host.s.artsTakenMul, .65);
  assert.equal(host.s.trueTakenMul, 1); assert.equal(host.s.elementalTakenMul, 1);
  const before = host.hp; s.b.dealDamage(null, host, { amount: 100, type: 'arts', canDodge: false });
  assert.ok(Math.abs(before - host.hp - 100 * (1 - host.s.res / 100) * .65) < 1e-7);
  holdProtect(s.b, host, .5, 5, host);
  assert.equal(host.s.physTakenMul, .5);
  const enemy = s.b.spawnEnemy('enemy_1007_slime');
  enemy.base.def = 400; enemy.base.res = 40; enemy.base.maxHp = 10000; enemy.markDirty(); enemy.hp = enemy.s.maxHp;
  const hp1 = enemy.hp; s.b.dealDamage(host, enemy, { amount: 1000, type: 'phys', canDodge: false });
  assert.ok(Math.abs(hp1 - enemy.hp - 740) < 1e-7);
  const hp2 = enemy.hp; s.b.dealDamage(host, enemy, { amount: 1000, type: 'arts', canDodge: false });
  assert.ok(Math.abs(hp2 - enemy.hp - 740) < 1e-7);
});

test('evolution and successful infection counts survive death/redeployment within the same battle', () => {
  const s = setup([{ row: 10, col: 5, mutationId: mutation(10) }, { row: 10, col: 6 }, { row: 11, col: 6 }]);
  s.deploy(0); s.deploy(1); s.b.kill(s.units[0]); s.deploy(0);
  assert.equal(view(s.controller, s.units[0]).remaining, 1);
  s.deploy(2); s.b.kill(s.units[0]); s.deploy(0);
  assert.equal(view(s.controller, s.units[0]).evolved, true);
  assert.equal(s.units[0].s.physTakenMul, .65);
  assert.equal(s.units[0].s.defIgnorePct, .35);
  s.b.kill(s.units[1]); s.deploy(1);
  assert.equal(view(s.controller, s.units[0]).remaining, 0);
  assert.equal(view(s.controller, s.units[1]).infected, true);
});

test('two players share native infection range while roster, UID and original mutations remain separate', () => {
  const players = [{ playerId: 'p1', seat: 0, units: [{ uid: 1, chessId: 'chess_char_1_02_a', abs: true, row: 10, col: 5, mutationId: mutation(10) }] },
    { playerId: 'p2', seat: 1, units: [{ uid: 1, chessId: 'chess_char_1_02_a', abs: true, row: 10, col: 6 },
      { uid: 2, chessId: 'chess_char_1_02_a', abs: true, row: 11, col: 6 }] }];
  const s = setup([], { players }); s.deploy(0); s.deploy(1); s.deploy(2);
  assert.equal(view(s.controller, s.units[0]).evolved, true);
  assert.equal(view(s.controller, s.units[1]).ownerId, 'p2');
  assert.equal(players[0].units[0].mutationId, mutation(10));
  assert.equal(players[1].units[0].mutationId, undefined);
  assert.equal(installMizukiNativeInfection(s.b, { grade: 16 }), s.controller);
});
