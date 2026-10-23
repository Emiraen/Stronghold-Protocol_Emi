// test/content/feedback3-indom-exits.test.js — 不屈 (owner's decision 2026-10-04, PRTS 卫戍协议：盟约 下半/PRTS盟约记录 不屈
// 修正: "被击倒、撤退、切换<替身>与<本体>时，有(18+0.4×层数)%概率立刻重新部署"; "※“立刻重新部署”的实现方式为：令受益者下次
// 部署的再部署时间和费用归零"): retreats and 傀儡师 switches roll too, not only knock-outs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { DOWN_STATE, FORCED_EXIT } from '../../server/sim/constants.js';

const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const bondOn = (count, layers = 0, tier = null, thresholds = [3, 6, 9]) => ({
  count, active: count >= thresholds[0], tier: tier ?? thresholds.filter((t) => count >= t).length, layers,
});

// ---------------------------------------------------------------------------------------------------------------------
// 不屈 on 撤退 and on 替身 switches

const groundOp = (id, extra = {}) => chessRec({ id, profession: 'WARRIOR', skill: null, bonds: ['indomShip'], stats: { atk: 100, maxHp: 5000, def: 0, respawnTime: 70 }, ...extra });
const spOp = (id) => groundOp(id, { skill: { duration: 5, spCost: 50, initSp: 0, bb: { atk: 1 } } });
const INDOM = (layers, count = 2) => ({ indomShip: bondOn(count, layers, null, [2, 3]) }); // p = min(1, 0.18 + 0.004 × layers)
const GH2 = 'chess_char_5_13_a'; // 归溟幽灵鲨: 傀儡师, a member of 阿戈尔 and 不屈

test('不屈: a 撤退 rolls like a knock-out — at p = 1 it is back at once, free, on its tile (行商\'s withdrawal too); tier 2\'s +5 SP stays a knock-out effect', () => {
  const h = makeBattle({
    defs: { chess: { t_a: groundOp('t_a'), t_b: spOp('t_b'), t_c: groundOp('t_c') } },
    units: [{ chessId: 't_a', row: 10, col: 4 }, { chessId: 't_b', row: 10, col: 6 }, { chessId: 't_c', row: 10, col: 8 }],
    bonds: INDOM(300, 3), autoFinish: false, timeLimit: 60, hooks: ['death', 'deploy'],
  });
  h.step();
  const [a, b] = [h.unit('t_a'), h.unit('t_b')];
  const dp0 = h.b.getPlayer('p1').dp;
  const sp0 = b.skill.sp;
  h.b.retreat(a, { reason: 'retreat' });
  assert.ok(a.alive && a.deployed, 'back at once');
  assert.equal(h.hooksOf('deploy').filter((c) => c.unit === a && !c.initial).length, 1);
  assert.deepEqual([a.tileR, a.tileC], [a.homeR, a.homeC], 'on its tile');
  close(h.b.getPlayer('p1').dp, dp0, 1e-9, 'free');
  close(b.skill.sp, sp0, 1e-9, 'no +5 SP for a retreat');
  h.step(); // (不屈 fires once per unit and instant)
  h.b.retreat(a, { reason: 'merchant' });
  assert.ok(a.alive, '行商\'s automatic withdrawal is a 撤退 too');
  h.step();
  const sp1 = b.skill.sp;
  h.b.dealDamage(null, a, { amount: 1e9, type: 'true' });
  assert.ok(a.alive, 'a knock-out: back too');
  close(b.skill.sp, sp1 + 5, 1e-9, 'a knock-out gives the tier-2 +5 SP');
  checkInvariants(h.b);
});

test('不屈: no roll on the 突袭 retreat (it redeploys at once anyway) nor on the 联防 forced exit; a missed roll leaves the withdrawn operator down', () => {
  const h = makeBattle({
    kind: 'unite', defs: { chess: { t_a: groundOp('t_a'), t_b: groundOp('t_b') } },
    units: [{ chessId: 't_a', row: 10, col: 4, carryState: { down: true } }, { chessId: 't_b', row: 10, col: 6 }], bonds: INDOM(300),
    autoFinish: false, timeLimit: 60,
  });
  h.step();
  const a = h.unit('t_a');
  assert.ok(!a.alive && a.removeReason === FORCED_EXIT && h.b.isDown(a), 'the 联防 forced exit is no 撤退: it stays down with its timer');
  const b = h.unit('t_b');
  h.b.retreat(b, { reason: 'raid' });
  assert.ok(!b.alive, 'the 突袭 retreat: 不屈 leaves it to the raid\'s own redeploy');
  // p = 0.18: a seed whose roll misses leaves it down where it stood (§22.15)
  let missed = false;
  for (let seed = 1; seed < 40 && !missed; seed++) {
    const m = makeBattle({
      seed, defs: { chess: { t_a: groundOp('t_a'), t_b: groundOp('t_b') } },
      units: [{ chessId: 't_a', row: 10, col: 4 }, { chessId: 't_b', row: 10, col: 6 }], bonds: INDOM(0), autoFinish: false, timeLimit: 60,
    });
    m.step();
    const x = m.unit('t_a');
    m.b.retreat(x, { reason: 'retreat' });
    if (!x.alive) { missed = true; assert.ok(m.b.isDown(x), 'down on its tile with its timer'); }
  }
  assert.ok(missed, 'a missed roll within 39 seeds at p = 0.18');
});

test('不屈: a 傀儡师 switch to the 替身 rolls — she stays on the field, and a hit makes her next deployment immediate and free', () => {
  const h = makeBattle({ units: [{ chessId: GH2, row: 10, col: 4 }], bonds: INDOM(300), autoFinish: false, timeLimit: 120, captureNoisy: true, hooks: ['deploy'] });
  h.step();
  const u = h.unit(GH2);
  assert.ok(u.ground, 'a ground operator');
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  assert.ok(u.alive && u.trait.doll, 'switched to her 替身, still on the field');
  assert.equal(h.hooksOf('deploy').filter((c) => c.unit === u && !c.initial).length, 0, 'no redeploy for the switch itself');
  assert.equal(u.mem.indomFreeDeploy, true, 'the roll hit: her next deployment is zeroed');
  h.run(2);
  const dp0 = h.b.getPlayer('p1').dp;
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' }); // a lethal hit on the 替身 knocks her out
  assert.ok(u.alive && u.deployed && !u.trait.doll, 'back at once as her 本体');
  close(h.b.getPlayer('p1').dp, dp0, 1e-9, 'free');
  assert.equal(u.mem.indomFreeDeploy, false, 'spent by that deployment');
  checkInvariants(h.b);
});

test('不屈: the switch back to the 本体 rolls too; a zeroed deployment brings her back even when the knock-out roll misses', () => {
  const h = makeBattle({ units: [{ chessId: GH2, row: 10, col: 4 }], bonds: INDOM(300), autoFinish: false, timeLimit: 120, captureNoisy: true });
  h.step();
  const u = h.unit(GH2);
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  u.mem.indomFreeDeploy = false; // forget the first switch's roll: the switch back must roll on its own
  h.runUntil(() => !u.trait.doll, 30);
  assert.ok(u.alive && !u.trait.doll, 'back to her 本体');
  assert.equal(u.mem.indomFreeDeploy, true, 'the switch back rolled (p = 1)');
  // p = 0.18 (no layers): with a zeroed deployment banked she comes back after any knock-out, rolled or not
  for (let seed = 1; seed <= 5; seed++) {
    const m = makeBattle({ seed, defs: { chess: { t_a: groundOp('t_a') } }, units: [{ chessId: 't_a', row: 10, col: 4 }], bonds: INDOM(0), autoFinish: false, timeLimit: 60 });
    m.step();
    const x = m.unit('t_a');
    x.mem.indomFreeDeploy = true;
    m.b.dealDamage(null, x, { amount: 1e9, type: 'true' });
    assert.ok(x.alive && !x.mem.indomFreeDeploy, `seed ${seed}: back at once`);
  }
  checkInvariants(h.b);
});

test('不屈: knock-outs and both withdrawal reasons redeploy with zero DP', () => {
  for (const reason of ['killed', 'retreat', 'merchant']) {
    const h = makeBattle({
      defs: { chess: { t_a: groundOp('t_a') } }, units: [{ chessId: 't_a', row: 10, col: 4 }],
      bonds: INDOM(300), autoFinish: false, timeLimit: 60,
    });
    h.step();
    const u = h.unit('t_a'), ps = h.b.getPlayer('p1');
    ps.dp = 0;
    if (reason === 'killed') h.b.kill(u);
    else h.b.retreat(u, { reason });
    assert.ok(u.alive && u.deployed, `${reason}: no DP gate`);
    assert.equal(ps.dp, 0, `${reason}: no DP charged`);
    assert.equal(u.mem.indomFreeDeploy, false, `${reason}: entitlement spent once`);
    checkInvariants(h.b);
  }
});

test('不屈: a zero-DP 傀儡师 consumes her banked free deployment when the 替身 is knocked out', () => {
  const h = makeBattle({ units: [{ chessId: GH2, row: 10, col: 4 }], bonds: INDOM(300), autoFinish: false, timeLimit: 120 });
  h.step();
  const u = h.unit(GH2), ps = h.b.getPlayer('p1');
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  assert.ok(u.alive && u.trait.doll && u.mem.indomFreeDeploy);
  h.run(2);
  ps.dp = 0;
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  assert.ok(u.alive && u.deployed && !u.trait.doll);
  assert.equal(ps.dp, 0);
  assert.equal(u.mem.indomFreeDeploy, false);
  checkInvariants(h.b);
});

test('不屈: a refused immediate deployment retains zero time and cost for the next automatic attempt', () => {
  const h = makeBattle({
    defs: { chess: { t_a: groundOp('t_a') } }, units: [{ chessId: 't_a', row: 10, col: 4 }],
    bonds: INDOM(300), autoFinish: false, timeLimit: 60,
  });
  h.step();
  const u = h.unit('t_a'), ps = h.b.getPlayer('p1');
  ps.dp = 0;
  const deploy = h.b._deploy;
  let refused = 0;
  h.b._deploy = function (unit, opts) {
    if (unit === u && refused++ === 0) return false;
    return deploy.call(this, unit, opts);
  };
  try { h.b.kill(u); } finally { h.b._deploy = deploy; }
  assert.equal(refused, 1, 'the immediate attempt reached deployment');
  assert.ok(!u.alive && h.b.isDown(u));
  assert.equal(u.mem.indomFreeDeploy, true, 'failed attempt did not spend the entitlement');
  assert.equal(u.respawnAt, h.b.time, 'no ordinary redeployment delay');
  assert.equal(ps.dp, 0);
  assert.notEqual(h.b._downState(u), DOWN_STATE.WAIT_DP, 'free deployment never waits for DP');
  h.b._checkRedeploys();
  assert.ok(u.alive && u.deployed, 'automatic retry needs neither DP nor another death event');
  assert.equal(ps.dp, 0);
  assert.equal(u.mem.indomFreeDeploy, false);
  checkInvariants(h.b);
});

test('不屈: a banked free deployment overrides an explicitly paid redeploy', () => {
  const h = makeBattle({
    defs: { chess: { t_a: groundOp('t_a') } }, units: [{ chessId: 't_a', row: 10, col: 4 }],
    bonds: INDOM(300), autoFinish: false, timeLimit: 60,
  });
  h.step();
  const u = h.unit('t_a'), ps = h.b.getPlayer('p1');
  h.b.retreat(u, { reason: 'raid' }); // does not roll or immediately redeploy
  u.mem.indomFreeDeploy = true;
  ps.dp = 0;
  assert.equal(h.b.redeploy(u, { free: false }), true);
  assert.ok(u.alive && u.deployed);
  assert.equal(ps.dp, 0);
  assert.equal(u.mem.indomFreeDeploy, false);
  checkInvariants(h.b);
});

test('不屈 payment regression: ordinary paid redeployment charges once and refused attempts charge nothing', () => {
  const h = makeBattle({
    defs: { chess: { t_a: groundOp('t_a') } }, units: [{ chessId: 't_a', row: 10, col: 4 }],
    autoFinish: false, timeLimit: 60,
  });
  h.step();
  const u = h.unit('t_a'), ps = h.b.getPlayer('p1');
  h.b.retreat(u);
  ps.dp = 0;
  assert.equal(h.b.redeploy(u, { free: false }), false, 'ordinary deployment needs DP');
  assert.equal(ps.dp, 0);
  ps.dp = u.base.cost + 7;
  const deploy = h.b._deploy;
  h.b._deploy = () => false;
  try { assert.equal(h.b.redeploy(u, { free: false }), false); } finally { h.b._deploy = deploy; }
  assert.equal(ps.dp, u.base.cost + 7, 'failed deployment refunds the charge');
  assert.equal(h.b.redeploy(u, { free: false }), true);
  assert.equal(ps.dp, 7, 'ordinary successful deployment still pays its base cost');
  checkInvariants(h.b);
});
