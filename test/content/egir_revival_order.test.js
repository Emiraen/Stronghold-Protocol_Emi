import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';

const egir = (layers = 0) => ({ count: 5, active: true, tier: 2, layers });
const ids = ['egir_head_a', 'egir_first_a', 'egir_second_a', 'egir_third_a', 'egir_fourth_a'];
const chess = Object.fromEntries(ids.map((id) => [id, chessRec({
  id, bonds: ['egirShip'], profession: 'WARRIOR', skill: null,
  stats: { maxHp: 1000, atk: 10, def: 0, cost: 99, respawnTime: 60 },
})]));
const flags = { dpInit: 0, dpPerSec: 0 };
const reviveEvents = (h) => h.eventsOf('fx').filter((e) => e[1] === 'revive' && e[4]?.src === 'bond:egirShip');
const reviveIds = (h) => reviveEvents(h).map((e) => h.b.units.find((u) => u.id === e[4].id)?.defId);
const kill = (h, u) => h.b.dealDamage(null, u, { amount: u.s.maxHp * 2 + 1, type: 'true' });

for (const kind of ['normal', 'unite']) {
  test(`阿戈尔 real opening chain: ${kind} revives three distinct swallowed operators for zero DP`, () => {
    const chainIds = ['chess_char_6_04_a', 'chess_char_5_05_a', 'chess_char_2_07_a', 'chess_char_3_09_a', 'chess_char_1_04_a', 'chess_char_1_01_a'];
    const h = makeBattle({
      kind, units: chainIds.map((chessId, i) => ({ chessId, row: 10, col: 2 + i })),
      bonds: { egirShip: egir() }, flags, hooks: ['death', 'deploy'], autoFinish: false,
    });
    h.b.start();
    const expected = chainIds.slice(2, 5);
    assert.deepEqual(reviveIds(h), expected, '幽灵鲨、海霓、深巡 each use one slot, in swallowed order');
    for (const id of expected) {
      const u = h.unit(id);
      assert.ok(u.alive && u.deployed && u.hp > 0, `${id} returned`);
      kill(h, u);
      assert.equal(u.alive, false, `${id} cannot use a second 阿戈尔 slot`);
    }
    assert.equal(reviveEvents(h).length, 3);
    assert.equal(h.b.getPlayer('p1').dp, 0, 'free revives do not charge or require DP');
    checkInvariants(h.b);
  });

  test(`阿戈尔 opening FIFO: ${kind} follows head's swallowed targets, not bottom-up board positions`, () => {
    const positions = [[12, 3, 'RIGHT'], [12, 4, 'DOWN'], [11, 4, 'DOWN'], [10, 4, 'DOWN'], [9, 4, 'RIGHT']];
    const h = makeBattle({
      kind, defs: { chess }, units: ids.map((chessId, i) => ({ chessId, row: positions[i][0], col: positions[i][1], dir: positions[i][2] })),
      bonds: { egirShip: egir() }, flags, hooks: ['death', 'deploy'], autoFinish: false,
    });
    h.b.start();
    assert.deepEqual(h.hooksOf('death').filter((c) => c.reason === 'killed').map((c) => c.unit.defId), ids.slice(1));
    assert.deepEqual(reviveIds(h), ids.slice(1, 4), 'first swallowed target first, three different targets only');
    for (const id of ids.slice(1, 4)) assert.equal(h.unit(id).alive, true, `${id} returned`);
    assert.equal(h.unit(ids[4]).alive, false, 'the fourth target has no remaining slot');
    assert.equal(h.b.getPlayer('p1').dp, 0);
    checkInvariants(h.b);
  });

  test(`阿戈尔 opening race: ${kind} priority-10 rescue does not consume the saved member's later eligibility`, () => {
    const positions = [[10, 3], [10, 4], [12, 3], [12, 6], [12, 9]];
    let rescued = 0;
    const h = makeBattle({
      kind, defs: { chess }, units: ids.map((chessId, i) => ({ chessId, row: positions[i][0], col: positions[i][1] })),
      bonds: { egirShip: egir() }, flags, hooks: ['death', 'deploy'], autoFinish: false,
      setup(b) {
        b.on('death', (c) => {
          if (c.reason === 'killed' && c.unit.defId === ids[1] && rescued === 0) {
            if (b.redeploy(c.unit, { free: true })) rescued++;
          }
        }, { priority: 10 });
      },
    });
    h.b.start();
    const saved = h.unit(ids[1]);
    assert.equal(rescued, 1, 'a lower-priority saver brought it back during the opening');
    assert.equal(saved.alive, true);
    assert.deepEqual(reviveIds(h), [], '阿戈尔 did not revive a member already standing');
    kill(h, saved);
    assert.equal(saved.alive, true, 'later unanswered death still receives its first 阿戈尔 revival');
    assert.deepEqual(reviveIds(h), [ids[1]]);
    kill(h, saved);
    assert.equal(saved.alive, false, 'same member does not receive 阿戈尔 twice');
    for (const id of ids.slice(2, 4)) {
      const u = h.unit(id);
      kill(h, u);
      assert.equal(u.alive, true, `${id} receives one remaining slot`);
    }
    kill(h, h.unit(ids[4]));
    assert.equal(h.unit(ids[4]).alive, false, 'three total slots remain enforced');
    assert.equal(reviveEvents(h).length, 3);
    assert.equal(h.b.getPlayer('p1').dp, 0);
    checkInvariants(h.b);
  });
}

for (const [layers, seed] of [[0, 1], [100, 7], [10000, 19], [1e9, 2026]]) {
  test(`阿戈尔 layers=${layers}, seed=${seed}: three distinct members once, free even at zero DP`, () => {
    const positions = [[9, 3], [12, 3], [9, 6], [12, 6], [9, 9]];
    const h = makeBattle({
      defs: { chess }, units: ids.map((chessId, i) => ({ chessId, row: positions[i][0], col: positions[i][1] })),
      bonds: { egirShip: egir(layers) }, flags, seed, hooks: ['death', 'deploy'], autoFinish: false,
    });
    h.b.start();
    assert.equal(reviveEvents(h).length, 0, 'isolated starting positions avoid opening knockouts');
    const order = [ids[0], ids[1], ids[0], ids[2], ids[3], ids[4]];
    const alive = [true, true, false, true, false, false];
    for (let i = 0; i < order.length; i++) {
      const u = h.unit(order[i]);
      kill(h, u);
      assert.equal(u.alive, alive[i], `death ${i + 1}: ${order[i]}`);
    }
    assert.deepEqual(reviveIds(h), [ids[0], ids[1], ids[2]], 'A, B and C use the three shared charges once each');
    assert.equal(new Set(reviveIds(h)).size, 3);
    assert.equal(h.b.getPlayer('p1').dp, 0);
    assert.equal(h.b.errorCount, 0);
    checkInvariants(h.b);
  });
}
