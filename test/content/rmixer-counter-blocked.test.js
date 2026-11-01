// Regression: S3 counter selection must include enemies blocked at the edge of its contact radius.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { bodyInRange } from '../../server/sim/body.js';

const NORMAL = 'chess_char_4_01_a';
const ELITE = 'chess_char_4_01_b';
const SIRA6 = { siracusaShip: { count: 6, active: true, tier: 2, layers: 143 } };
function setup({ id = NORMAL, moduleId, bonds, extraUnits = [] } = {}) {
  const h = makeBattle({
    defs: { enemies: { e_dummy: enemyRec({ key: 'e_dummy', hp: 1e8, atk: 400, def: 0, res: 0, speed: 0, bat: 1 }) } },
    units: [{ chessId: id, row: 10, col: 4, dir: 'RIGHT', skillIndex: 2, moduleId, items: [] }, ...extraUnits],
    bonds, timeLimit: 120, autoFinish: false, hooks: ['attack', 'damaged', 'ammoUsed'], captureNoisy: true,
  });
  h.step();
  const u = h.unit(id);
  assert.equal(u.skill.id, 'skchr_rmixer_3');
  assert.ok(u.skill.activate('test', { free: true }));
  return { h, u };
}
function spawn(h, pos, block = false) {
  const e = h.spawn('e_dummy', { pos });
  if (block) assert.equal(h.b._checkBlock(e), true, 'real contact blocking succeeds');
  h.b.applyStatus(e, 'stun', { duration: 60 }); // no unrelated attacks while advancing the counter interval
  h.b._buildEnemyIndex();
  return e;
}
function hit(h, u, source = null) {
  h.b.dealDamage(source, u, { amount: 10, type: 'true', canDodge: false });
  h.b.projectiles.update(1); // settle only this volley, without creating another enemy attack
}
function attacks(h, u) { return h.hooksOf('attack').filter((c) => c.attacker === u); }
function clean(h) { assert.equal(h.b.errorCount, 0, JSON.stringify(h.b.errors)); checkInvariants(h.b); }

for (const [label, options] of [
  ['normal', {}],
  ['elite default module', { id: ELITE }],
  ['elite SPT-Y', { id: ELITE, moduleId: 'uniequip_003_rmixer' }],
  ['elite no module', { id: ELITE, moduleId: 'none' }],
]) test('rmixer S3: ' + label + ' counters its rear contact-edge blocker outside the skill grid', () => {
  const { h, u } = setup(options);
  const e = spawn(h, [10, 3.3], true);
  assert.equal(e.blockedBy, u);
  assert.equal(bodyInRange(e, u.rangeKeys), false, 'contact radius reaches outside the S3 range');
  const hp = e.hp, ammo = u.skill.ammoLeft;
  hit(h, u, e);
  assert.ok(e.hp < hp, 'blocked attacker takes counter damage');
  assert.equal(u.skill.ammoLeft, ammo - 1, 'one volley costs one bullet');
  assert.deepEqual(attacks(h, u).at(-1).targets, [e]);
  clean(h);
});

test('rmixer S3: blocked attacker comes first, at most three distinct enemies per volley', () => {
  for (const col of [3.3, 4.4]) {
    const { h, u } = setup();
    const attacker = spawn(h, [10, col], true);
    for (const pos of [[10, 5], [9, 5], [11, 5], [10, 6]]) spawn(h, pos);
    h.b._buildEnemyIndex();
    const ammo = u.skill.ammoLeft;
    hit(h, u, attacker);
    const volley = attacks(h, u).at(-1);
    assert.ok(volley, 'counter emits a real attack');
    assert.equal(volley.targets[0], attacker, 'attacker first even outside the grid');
    assert.equal(volley.targets.length, 3, 'counter max-target cap remains three');
    assert.equal(new Set(volley.targets).size, 3, 'an in-range blocker is not appended twice');
    assert.equal(u.skill.ammoLeft, ammo - 1);
    clean(h);
  }
});

test('rmixer S3: untargetable blocked enemies are not added by the blocker fallback', () => {
  const { h, u } = setup();
  const e = spawn(h, [10, 3.3], true);
  h.b.addBuff(e, { key: 'test:untargetable', flags: { untargetable: true } });
  const hp = e.hp, ammo = u.skill.ammoLeft;
  hit(h, u, e);
  assert.equal(e.hp, hp);
  assert.equal(attacks(h, u).length, 0);
  assert.equal(u.skill.ammoLeft, ammo - 1, 'target-less counter still consumes one bullet');
  clean(h);
});

test('rmixer S3: out-of-range enemies not blocked by this operator are not added', () => {
  for (const otherBlocker of [false, true]) {
    const { h, u } = setup({ extraUnits: otherBlocker ? [{ chessId: 'chess_char_1_02_a', row: 10, col: 3 }] : [] });
    const e = spawn(h, [10, 3.3], otherBlocker);
    if (otherBlocker) assert.notEqual(e.blockedBy, u);
    else assert.equal(e.blockedBy, null);
    const hp = e.hp;
    hit(h, u, e);
    assert.equal(e.hp, hp);
    assert.equal(attacks(h, u).length, 0);
    clean(h);
  }
});

test('rmixer S3: disarm and the actual-interval counter cooldown still prevent extra volleys', () => {
  const { h, u } = setup();
  const e = spawn(h, [10, 3.3], true);
  const ammo = u.skill.ammoLeft;
  h.b.addBuff(u, { key: 'test:disarm', flags: { disarm: true } });
  hit(h, u, e);
  assert.equal(u.skill.ammoLeft, ammo);
  h.b.removeBuff(u, 'test:disarm');
  hit(h, u, e);
  assert.equal(u.skill.ammoLeft, ammo - 1);
  const hp = e.hp;
  hit(h, u, e);
  assert.equal(u.skill.ammoLeft, ammo - 1, 'same-time second hit does not counter');
  assert.equal(e.hp, hp);
  const gap = u.s.interval * u.skill.bb.base_attack_time;
  h.run(gap + 0.05);
  hit(h, u, e);
  assert.equal(u.skill.ammoLeft, ammo - 2);
  assert.equal(attacks(h, u).length, 2);
  clean(h);
});

test('rmixer S3: active layered Siracusa lineup and no equipment still damages a rear blocked attacker', () => {
  const { h, u } = setup({ bonds: SIRA6, extraUnits: [
    { chessId: 'chess_char_3_19_a', row: 9, col: 6 },
    { chessId: 'chess_char_2_16_a', row: 9, col: 7 },
    { chessId: 'chess_char_4_10_a', row: 11, col: 7 },
    { chessId: 'chess_char_3_18_b', row: 12, col: 7 },
    { chessId: 'chess_char_5_10_b', row: 12, col: 8 },
    { chessId: 'chess_char_4_16_a', row: 12, col: 9 },
  ] });
  assert.equal(h.b.players[0].bonds.siracusaShip.active, true);
  assert.equal(h.b.players[0].bonds.siracusaShip.layers, 143);
  assert.equal(u.items.length, 0);
  const e = spawn(h, [10, 3.3], true), hp = e.hp;
  hit(h, u, e);
  assert.ok(e.hp < hp, 'no-item S3 counter still deals physical damage in the Siracusa lineup');
  assert.equal(attacks(h, u).length, 1);
  clean(h);
});


test('rmixer S3: natural enemy attacks repeatedly trigger damaging counters at the rear block edge', () => {
  for (const id of [NORMAL, ELITE]) {
    const { h, u } = setup({ id });
    const e = h.spawn('e_dummy', { pos: [10, 3.3] });
    assert.equal(e.blockedBy, null, 'no manual block is assigned');
    const hp = e.hp, ammo = u.skill.ammoLeft;
    h.run(3); // the normal enemy AI establishes the block and attacks the S3 operator
    assert.equal(e.blockedBy, u, 'the AI establishes real rear-edge contact blocking');
    const volleys = attacks(h, u);
    const enemyAttacks = h.hooksOf('attack').filter((c) => c.attacker === e);
    assert.ok(enemyAttacks.length >= 2, id + ': repeated natural enemy attacks');
    assert.ok(volleys.length >= 2, id + ': repeated damaging counter volleys');
    assert.ok(e.hp < hp && u.stats.dmg > 0, id + ': the counters remove enemy HP');
    assert.equal(ammo - u.skill.ammoLeft, volleys.length, 'one bullet per real counter volley');
    assert.ok(volleys.every((c) => c.targets.length === 1 && c.targets[0] === e));
    clean(h);
  }
});
