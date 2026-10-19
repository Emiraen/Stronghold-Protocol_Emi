// Emi36：真实伤害事件、个人回合结算与评分边界的隔离回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performanceScore, rankDelta, PERFORMANCE_TARGETS, DIFFICULTY_BUDGET } from '../shared/ranks.js';
import { makeBattle, chessRec, enemyRec } from './helpers/battleHarness.js';
import { dealDamage, heal } from '../server/sim/damage.js';
import { lpLoss } from '../server/sim/content/enemies.js';
import { compactResult, resultDigest } from '../server/sim/spec.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { SharedBossPool, CreditPool } from '../server/match/finalAssault.js';
import { getData } from '../server/data.js';
import { RankedStore } from '../server/rankedStore.js';

const full = (difficulty, fraction = 1) => ({ difficulty, survivalRounds: 15, roundsPassed: 15,
  rankedDamage: PERFORMANCE_TARGETS[difficulty].damage * fraction,
  bossDamage: PERFORMANCE_TARGETS[difficulty].boss * fraction,
  layers: 999 * fraction, rankedPerfectRounds: 15 * fraction, assists: 10 * fraction });

test('同一实际metrics六项raw逐项1/1.6/2：未饱和、边界及饱和，统一分母不抵消倍率', () => {
  // 输入使用明确绝对值，不从各难度目标生成，否则会掩盖分母差异。
  const cases = [
    { survivalRounds: 9, rankedDamage: 100_000, bossDamage: 25_000, layers: 100, rankedPerfectRounds: 3, assists: 1 },
    { survivalRounds: 12, rankedDamage: 370_123, bossDamage: 92_531, layers: 333, rankedPerfectRounds: 7, assists: 4 },
    { survivalRounds: 14, rankedDamage: 999_999, bossDamage: 249_999, layers: 998, rankedPerfectRounds: 14, assists: 9 },
    { survivalRounds: 15, rankedDamage: 1_000_000, bossDamage: 250_000, layers: 999, rankedPerfectRounds: 15, assists: 10 },
    { survivalRounds: 30, rankedDamage: 2_000_000, bossDamage: 500_000, layers: 1998, rankedPerfectRounds: 30, assists: 20 },
    { survivalRounds: 9, rankedDamage: 0, bossDamage: 0, layers: 0, rankedPerfectRounds: 0, assists: 0 },
  ];
  for (const d of ['NORMAL', 'HARD', 'ABYSS']) assert.deepEqual(PERFORMANCE_TARGETS[d], { damage: 1_000_000, boss: 250_000 });
  const targetByKey = { survival: 15, damage: 1_000_000, boss: 250_000, layers: 999, perfect: 15, other: 10 };
  const inputByKey = { survival: 'survivalRounds', damage: 'rankedDamage', boss: 'bossDamage', layers: 'layers', perfect: 'rankedPerfectRounds', other: 'assists' };
  for (const metrics of cases) {
    const scores = ['NORMAL', 'HARD', 'ABYSS'].map(difficulty => performanceScore({ ...metrics, difficulty }));
    for (let i = 0; i < 6; i++) {
      const normal = scores[0].items[i];
      assert.equal(normal.normalized, Math.min(1, metrics[inputByKey[normal.key]] / targetByKey[normal.key]));
      for (const [index, ratio] of [[1, 1.6], [2, 2]]) {
        const item = scores[index].items[i];
        assert.equal(item.normalized, normal.normalized, `${normal.key}归一化不能随难度变`);
        assert.ok(Math.abs(item.score - normal.score * ratio) < 1e-12, `${normal.key} 同一绝对指标倍率${ratio}`);
      }
    }
    const raw = scores.map(s => s.items.reduce((sum, item) => sum + item.score, 0));
    for (let i = 0; i < 3; i++) {
      assert.equal(scores[i].calculatedPerformance, Math.round(raw[i]));
      assert.ok(Math.abs(scores[i].calculatedPerformance - raw[i]) <= 0.5 + 1e-12);
    }
    assert.ok(Math.abs(scores[1].calculatedPerformance - scores[0].calculatedPerformance * 1.6) <= 1.3 + 1e-12);
    assert.ok(Math.abs(scores[2].calculatedPerformance - scores[0].calculatedPerformance * 2) <= 1.5 + 1e-12);
  }
});

test('六项单调与难度预算封顶，各项不先取整', () => {
  for (const d of Object.keys(DIFFICULTY_BUDGET)) {
    const s = performanceScore(full(d));
    assert.equal(s.calculatedPerformance, DIFFICULTY_BUDGET[d]);
    assert.equal(s.calculatedPerformance, Math.round(s.items.reduce((sum, i) => sum + i.score, 0)));
    for (const key of ['survivalRounds', 'rankedDamage', 'bossDamage', 'layers', 'rankedPerfectRounds', 'assists']) {
      let previous = 0;
      for (const n of [0, 0.1, 0.5, 1, 2, 100]) {
        const x = performanceScore({ ...full(d), [key]: full(d)[key] * n });
        assert.ok(x.calculatedPerformance >= previous);
        assert.ok(x.items.every(i => i.normalized >= 0 && i.normalized <= 1));
        assert.ok(x.calculatedPerformance <= DIFFICULTY_BUDGET[d]);
        previous = x.calculatedPerformance;
      }
    }
  }
});

test('8/9个人门槛、9后死亡/失败先表现再败补，低段失败净0，无Boss机会0', () => {
  for (const difficulty of Object.keys(DIFFICULTY_BUDGET)) {
    const inp = { ...full(difficulty), pointsBefore: 2500, startingParticipantCount: 1, win: false, alive: false };
    assert.equal(rankDelta({ ...inp, survivalRounds: 8 }).calculatedPerformance, 0);
    const r = rankDelta({ ...inp, survivalRounds: 9 });
    assert.ok(r.calculatedPerformance > 0);
    assert.equal(r.appliedPerformance, Math.min(r.actualLoss, r.calculatedPerformance));
    assert.equal(r.shortageBonus, Math.min(21, r.actualLoss - r.appliedPerformance));
    assert.ok(r.delta <= 0);
    assert.equal(rankDelta({ ...inp, pointsBefore: 2000 }).delta, 0);
    assert.equal(performanceScore({ ...full(difficulty), bossDamage: undefined }).items.find(i => i.key === 'boss').score, 0);
    assert.equal(rankDelta({ ...inp, win: true, alive: false }).delta, rankDelta(inp).delta);
  }
});

function arena(kind = 'normal') {
  return makeBattle({ content: 'none', kind, autoFinish: false, units: [{ chessId: 'test_gun', row: 10, col: 5 }],
    defs: { chess: { test_gun: chessRec({ id: 'test_gun', skill: null }) }, enemies: { enemy_test: enemyRec({ hp: 100, speed: 0 }) } } }).step();
}
const hit = (h, source, target, amount) => dealDamage(h.b, source, target, { amount, type: 'true' });

test('真实Battle：HP伤害排过杀、友伤、死敌重复、治疗刷量；漏怪到联防额度不重置', () => {
  const h = arena(); const ally = h.allies()[0];
  assert.ok(ally, '必须真实部署攻击源才能验证个人归属');
  const enemy = h.spawn('enemy_test', { pos: [9, 10], ownerPlayerId: 'p1' });
  hit(h, ally, enemy, 80); heal(h.b, enemy, enemy, 80); hit(h, ally, enemy, 80);
  assert.equal(h.b._pp('p1').rankedDamage, 100);
  hit(h, ally, enemy, 1000); hit(h, ally, enemy, 1000);
  hit(h, ally, ally, 100);
  assert.equal(h.b._pp('p1').rankedDamage, 100);
  const second = h.spawn('enemy_test', { pos: [9, 10], ownerPlayerId: 'p1' });
  hit(h, ally, second, 60); h.b._recordLeak(second);
  const leak = h.b._pp('p1').leaked.at(-1);
  assert.equal(leak.rankedHpRatio, 0.4);
  const u = arena('unite'); const ue = u.spawn('enemy_test', { pos: [9, 10], rankedHpRatio: leak.rankedHpRatio });
  hit(u, u.allies()[0], ue, 1000);
  assert.equal(u.b._pp('p1').rankedDamage, 40);
  assert.equal(60 + u.b._pp('p1').rankedDamage, 100);
  const legacy = u.spawn('enemy_test', { pos: [9, 10] }); hit(u, u.allies()[0], legacy, 1000);
  assert.equal(u.b._pp('p1').rankedDamage, 40, '旧漏怪无新额度不得推造');
});

test('个人LP事件和compact/digest保留新字段，不复制为团队统计', () => {
  const h = arena(); const e = h.spawn('enemy_test', { pos: [9, 10], ownerPlayerId: 'p1' });
  lpLoss(h.b, 2, '测试', e);
  assert.equal(h.b._pp('p1').leaderLpLoss, 2);
  const res = { perPlayer: { p1: { ...h.b._pp('p1'), rankedDamage: 1.25, damageDealt: 1.25 } } };
  assert.equal(compactResult(res).perPlayer.p1.rankedDamage, 1.25);
  assert.notEqual(resultDigest(res).hash, resultDigest({ perPlayer: { p1: { ...res.perPlayer.p1, leaderLpLoss: 0 } } }).hash);
});

test('生成hook伤害不会被随后重置评分额度', () => {
  const h = arena(); const ally = h.allies()[0];
  h.b.on('enemySpawn', ({ enemy }) => hit(h, ally, enemy, 60));
  const e = h.spawn('enemy_test', { pos: [9, 10] });
  assert.equal(e.rankedHpRemaining, 40);
  hit(h, ally, e, 1000);
  assert.equal(h.b._pp('p1').rankedDamage, 100);
});

const data = getData({ log: { info() {}, warn() {}, error() {} } });
function match() {
  return new Match({ mode: 'coop', difficulty: 'HARD', ranked: true, rankedStore: new RankedStore({ file: null }), data,
    scheduler: new VirtualScheduler(), botRehearsal: 0, seats: [0, 1].map(seat => ({ seat, playerId: `p${seat}`, name: '测试', isBot: false })),
    send() { return true; }, broadcast() {}, onEnd() {} });
}
const personal = (extra = {}) => ({ rankedStatsValid: true, perfect: true, leaked: [], killed: 0, damageDealt: 12.5,
  rankedDamage: 12.5, leaderLpLoss: 0, ...extra });

test('真实Match结算：个人无漏怪/领袖扣血才完美，联防只算一回合，淘汰后统计保留且重复不叠', () => {
  const m = match();
  try {
    m.start();
    // 隔离结算事件，初始化为正常开战生命；无需跳过真实伤害或统计事件。
    for (const ps of m.order) ps.lp = 20;
    for (let round = 1; round <= 9; round++) {
      m.round = round;
      m.lastResults = new Map([['p0', personal({ leaderLpLoss: round === 2 ? 1 : 0 })],
        ['p1', personal({ leaked: round === 3 ? [{ counted: true }] : [] })]]);
      const unite = { perPlayer: { p0: personal({ rankedDamage: 7.5 }) } };
      m.settle(null, unite);
      const previous = structuredClone(m.players.get('p0').stats);
      m.settle(null, unite);
      assert.deepEqual(m.players.get('p0').stats, previous);
    }
    const p0 = m.players.get('p0'), p1 = m.players.get('p1');
    assert.equal(p0.stats.survivalRounds, 9); assert.equal(p1.stats.survivalRounds, 9);
    assert.equal(p0.stats.rankedPerfectRounds, 8); assert.equal(p1.stats.rankedPerfectRounds, 8);
    assert.equal(p0.stats.rankedDamage, 180); assert.equal(p1.stats.rankedDamage, 112.5);
    p0.eliminate(10); m.round = 10;
    m.lastResults = new Map([['p0', personal({ rankedDamage: 3.25 })], ['p1', personal({ synthetic: true, rankedStatsValid: false })]]);
    m.settle(null, null);
    assert.equal(p1.stats.survivalRounds, 9, '占位结果不增加真实存活');
    assert.equal(p1.stats.rankedPerfectRounds, 8, '占位结果不增加完美');
    m.finish({ victory: false });
    const row = m.lastResultMsg.players.find(p => p.playerId === 'p0');
    assert.equal(row.stats.survivalRounds, 9); assert.equal(row.stats.rankedDamage, 183.25, '退出仍保留本回合已产生的个人伤害');
    assert.ok(performanceScore({ difficulty: 'HARD', ...row.stats }).calculatedPerformance > 0);
  } finally { m.dispose(); }
});

test('Emi36 Boss完美事件：无领袖扣血且胜利才完美，失败/占位/超时不发，重复结算不叠', () => {
  for (const reason of ['cleared', 'defeat', 'synthetic', 'overtime', 'leaderLoss']) {
    const m = match();
    try {
      m.start(); for (const ps of m.order) ps.lp = 20;
      m.round = m.gd.bossRound; m.startFinalAssault(false);
      m._finalEnding = reason === 'defeat' ? 'defeat' : 'cleared';
      m.overtimeApplied = reason === 'overtime' ? 1 : 0;
      const res = { synthetic: reason === 'synthetic', perPlayer: Object.fromEntries(m.order.map(ps =>
        [ps.playerId, personal({ leaderLpLoss: reason === 'leaderLoss' && ps.playerId === 'p0' ? 1 : 0 })])) };
      m._finishFinal(false, () => res);
      const p0 = m.players.get('p0');
      assert.equal(p0.stats.rankedPerfectRounds, reason === 'cleared' ? 1 : 0, reason);
      if (reason === 'leaderLoss') assert.equal(m.players.get('p1').stats.rankedPerfectRounds, 1, '不把别人的领袖扣血复制到本阵地');
      const before = structuredClone(p0.stats);
      m._finishFinal(false, () => res);
      assert.deepEqual(p0.stats, before);
    } finally { m.dispose(); }
  }
});

test('真实Match Boss已确认个人credit归属，不重复累计，接管重模拟不重记', () => {
  const m = match();
  try {
    m.start(); m.round = m.gd.bossRound; m.startFinalAssault(false);
    const pool = m.bossPool;
    pool.damage('p0', 100.25); pool.damage('p1', 50.5);
    assert.equal(m.players.get('p0').stats.bossDamage, 100.25);
    assert.equal(m.players.get('p0').stats.rankedDamage, 100.25);
    assert.equal(m.players.get('p1').stats.rankedDamage, 50.5);
    const wrapper = new CreditPool(pool, { acked: 150.75 });
    wrapper.damage('p0', 100.25); wrapper.damage('p1', 50.5);
    assert.equal(m.players.get('p0').stats.rankedDamage, 100.25);
    const p = new SharedBossPool(100); p.damage('p0', 1000); p.damage('p0', 1000);
    assert.equal(p.byPlayer.get('p0'), 100);
  } finally { m.dispose(); }
});
