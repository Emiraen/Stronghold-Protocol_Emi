import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';

function setup(layers = 300, dp = 99) {
  const h = makeBattle({
    defs: { chess: { t_indom: chessRec({ id: 't_indom', profession: 'WARRIOR', skill: null, bonds: ['indomShip'],
      stats: { maxHp: 5000, def: 0, respawnTime: 70 } }) } },
    units: [{ chessId: 't_indom', row: 10, col: 4 }],
    bonds: { indomShip: { count: 2, active: true, tier: 1, layers } },
    autoFinish: false, timeLimit: 60, hooks: ['death', 'deploy'],
  });
  h.step();
  h.b.getPlayer('p1').dp = dp;
  return { h, u: h.unit('t_indom'), ps: h.b.getPlayer('p1') };
}

for (const layers of [205, 206, 300]) for (const dp of [0, 99]) {
  test(`不屈 guaranteed: ${layers} layers, ${dp} DP, separate lethal hits in one tick all revive free`, () => {
    const { h, u, ps } = setup(layers, dp);
    h.b.rng = () => 0.999999;
    const time = h.b.time;
    for (let i = 0; i < 3; i++) {
      h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
      assert.ok(u.alive && u.deployed, `lethal hit ${i + 1}: redeployed`);
      assert.equal(u.hp, u.s.maxHp);
      assert.equal(h.b.time, time);
      assert.equal(ps.dp, dp, 'no deployment charge');
      assert.equal(u.mem.indomFreeDeploy, false, 'only this deployment consumed');
      checkInvariants(h.b);
    }
    assert.equal(h.b.errorCount, 0);
  });
}

test('不屈: a single lethal hit revives free across physical, arts, true damage and direct kill', () => {
  for (const kind of ['phys', 'arts', 'true', 'kill', 'hpLoss']) {
    const { h, u, ps } = setup();
    h.b.rng = () => 0.999999;
    if (kind === 'kill') h.b.kill(u);
    else if (kind === 'hpLoss') h.b.loseHp(u, 1e9);
    else h.b.dealDamage(null, u, { amount: 1e9, type: kind });
    assert.ok(u.alive && u.deployed, `${kind}: redeployed`);
    assert.equal(u.hp, u.s.maxHp);
    assert.equal(ps.dp, 99);
    checkInvariants(h.b);
  }
});

test('不屈: lethal deployment callback preserves the new free deployment until automatic retry', () => {
  const { h, u, ps } = setup();
  let nestedDeaths = 0;
  h.b.on('deploy', ({ unit, initial }) => {
    if (unit === u && !initial && nestedDeaths++ === 0) h.b.kill(u);
  }, { priority: 20 });
  h.b.kill(u);
  assert.ok(!u.alive && h.b.isDown(u), 'nested death is deferred, not recursively redeployed');
  assert.equal(u.mem.indomFreeDeploy, true, 'outer deployment cannot clear the new entitlement');
  assert.equal(u.respawnAt, h.b.time);
  h.b._checkRedeploys();
  assert.ok(u.alive && u.deployed, 'automatic retry redeploys');
  assert.equal(u.mem.indomFreeDeploy, false);
  assert.equal(ps.dp, 99);
  assert.equal(h.b.errorCount, 0);
  checkInvariants(h.b);
});

test('不屈: persistent lethal deployment callbacks remain bounded and do not lose the pending revival', () => {
  const { h, u, ps } = setup();
  let callbacks = 0;
  const hook = h.b.on('deploy', ({ unit, initial }) => {
    if (unit === u && !initial) { callbacks++; h.b.kill(u); }
  }, { priority: 20 });
  h.b.kill(u);
  assert.equal(callbacks, 1, 'no recursive deployment loop');
  assert.equal(h.b.errorCount, 0);
  assert.equal(u.mem.indomFreeDeploy, true);
  assert.equal(ps.dp, 99);
  h.b.off(hook);
  h.b._checkRedeploys();
  assert.ok(u.alive && u.deployed);
  assert.equal(ps.dp, 99);
  checkInvariants(h.b);
});

test('不屈: a later independent death rolls again below guaranteed probability', () => {
  const { h, u, ps } = setup(0);
  let rolls = 0;
  h.b.rng = () => rolls++ === 0 ? 0 : 0.999999;
  h.b.kill(u);
  assert.ok(u.alive, 'first roll succeeded');
  h.b.kill(u);
  assert.equal(rolls, 2, 'second death must have its own roll');
  assert.ok(!u.alive && h.b.isDown(u), 'failed roll stays down');
  assert.equal(u.mem.indomFreeDeploy, false);
  assert.ok(u.respawnAt > h.b.time);
  assert.equal(ps.dp, 99);
  checkInvariants(h.b);
});

test('不屈: one lethal hit still publishes a complete redeployment when skill reset throws', () => {
  const { h, u, ps } = setup();
  const reset = u.skill.reset;
  const deploys = h.eventsOf('deploy').length;
  const hooks = h.hooksOf('deploy').filter((c) => c.unit === u && !c.initial).length;
  u.skill.reset = () => { throw new Error('injected skill reset failure'); };
  try { h.b.kill(u); } finally { u.skill.reset = reset; }
  assert.ok(u.alive && u.deployed && u.hp > 0);
  assert.equal(h.eventsOf('deploy').length, deploys + 1, 'client receives the revival, not only die');
  assert.equal(h.hooksOf('deploy').filter((c) => c.unit === u && !c.initial).length, hooks + 1);
  assert.equal(u.mem.indomFreeDeploy, false, 'the successful deployment consumes the free entitlement');
  assert.equal(ps.dp, 99);
  assert.ok(h.b.errors.some((e) => e.label === 'deploy:skill.reset' && e.who === 't_indom'));
  h.b._checkRedeploys();
  assert.equal(h.eventsOf('deploy').length, deploys + 1, 'no second grant after success');
  checkInvariants(h.b);
});

test('不屈: a throw before deployment keeps the pending free retry and later death callbacks run', () => {
  const { h, u, ps } = setup();
  const redeploy = h.b.redeploy;
  let calls = 0, laterDeaths = 0;
  h.b.redeploy = function (...args) {
    if (calls++ === 0) throw new Error('injected redeploy failure');
    return redeploy.apply(this, args);
  };
  h.b.on('death', ({ unit }) => { if (unit === u) laterDeaths++; }, { priority: -10 });
  h.b.kill(u);
  assert.equal(laterDeaths, 1);
  assert.ok(!u.alive && u.mem.indomFreeDeploy);
  assert.equal(u.respawnAt, h.b.time);
  assert.ok(h.b.errors.some((e) => e.label === 'bond:indom:redeploy' && e.who === 't_indom'));
  h.b._checkRedeploys();
  assert.ok(u.alive && u.deployed);
  assert.equal(calls, 2, 'retry only while the unit has not actually redeployed');
  assert.equal(ps.dp, 99);
  checkInvariants(h.b);
});

test('不屈: an exception after a successful deployment never grants a duplicate revival', () => {
  const { h, u, ps } = setup();
  const redeploy = h.b.redeploy;
  let calls = 0;
  h.b.redeploy = function (...args) {
    calls++;
    redeploy.apply(this, args);
    throw new Error('injected after successful deployment');
  };
  h.b.kill(u);
  assert.ok(u.alive && u.deployed && !u.mem.indomFreeDeploy);
  h.b._checkRedeploys();
  assert.equal(calls, 1);
  assert.equal(ps.dp, 99);
  checkInvariants(h.b);
});
