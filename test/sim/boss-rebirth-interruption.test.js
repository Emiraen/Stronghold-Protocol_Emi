// Real multi-form bosses: HP loss during their authored rebirth must not count the first form as a kill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, checkInvariants } from '../helpers/battleHarness.js';

const BOSSES = [
  'enemy_1512_mcmstr', 'enemy_1516_jakill', 'enemy_1517_xi',
  'enemy_1525_blkswb', 'enemy_1535_wlfmster', 'enemy_1539_reid',
];

function battle(key) {
  const h = makeBattle({ autoFinish: true, timeLimit: 200, enemies: [{ key, mods: { speedMul: 0 } }] });
  h.step();
  return { h, e: h.enemy(key) };
}

for (const key of BOSSES) {
  test(`${key}: repeated HP loss cannot kill it during rebirth or finish the battle before form 2`, () => {
    const { h, e } = battle(key);
    h.b.loseHp(e, e.hp + 1);
    assert.equal(e.form, 'reborn');
    const rebirth = e.findBuff('ab:reborn');
    assert.ok(rebirth && rebirth.timeLeft > 0, 'the real authored rebirth starts');
    const duration = rebirth.timeLeft;
    const end = h.b.time + duration;
    for (let i = 0; i < 5; i++) {
      h.b.loseHp(e, e.s.maxHp * 2);
      assert.equal(e.alive, true, 'life loss cannot turn a rebirth into a real death');
      assert.equal(e.hp, 1);
      h.step();
    }
    assert.equal(e.findBuff('ab:reborn'), rebirth, 'no replacement buff or restarted timer');
    assert.ok(rebirth.timeLeft < duration, 'rebirth continues counting down');
    assert.equal(h.b.finished, false);
    assert.equal(h.b.killed, 0);
    assert.equal(h.b.resolved, 0);
    assert.equal(h.eventsOf('die').length, 0, 'no death event during the transition');
    assert.ok(h.runUntil(() => e.form === 'form2', duration + 1), 'second form is reached');
    assert.ok(h.b.time <= end + h.b.dt * 2, 'repeated losses do not postpone form 2');
    assert.equal(e.alive, true);
    assert.ok(e.hp > 1, 'second form restores its authored HP');
    assert.equal(h.b.finished, false);
    h.b.loseHp(e, e.hp + 1);
    h.step();
    assert.equal(e.alive, false, 'the second form remains normally killable');
    assert.equal(h.b.killed, 1);
    assert.equal(h.b.resolved, 1);
    assert.equal(h.b.finished, true);
    assert.equal(h.result().reason, 'cleared');
    assert.equal(h.b.errorCount, 0);
    checkInvariants(h.b);
  });

  test(`${key}: repeated forced kill callbacks do not reapply first-KO effects`, () => {
    const { h, e } = battle(key);
    h.b.kill(e);
    const first = h.eventsOf('fx').filter((x) => x[4]?.form === 'reborn').length;
    assert.equal(first, 1);
    h.b.kill(e);
    h.b.kill(e);
    assert.equal(e.alive, true);
    assert.equal(h.eventsOf('fx').filter((x) => x[4]?.form === 'reborn').length, first);
    assert.equal(h.b.killed, 0);
    assert.ok(h.runUntil(() => e.form === 'form2', 100));
    h.b.kill(e);
    h.step();
    assert.equal(h.b.killed, 1, 'only the final form is counted');
    assert.equal(h.b.finished, true);
    assert.equal(h.b.errorCount, 0);
    checkInvariants(h.b);
  });
}
