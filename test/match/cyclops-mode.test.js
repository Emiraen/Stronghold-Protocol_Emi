// test/match/cyclops-mode.test.js — 独眼巨人冲锋 (entertainment_cyclops)：完全独立的娱乐模式规则。
// 隔离原则：本文件所有用例只构造 variant: 'entertainment_cyclops' 的对局；普通模式回归由 emi-entertainment /
// economy / pool 等既有测试守卫（改动前后的失败集合一致，见交付说明）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { getData } from '../../server/data.js';
import { PHASE, CYCLOPS_BONUS_ROUNDS, CYCLOPS_HEX_ROUNDS } from '../../shared/constants.js';
import { applyCyclopsHex, cyclopsInterest, rollCyclopsHexSlots, buildCyclopsBonusWave, cyclopsBonusReward, isCyclopsBonusRound } from '../../server/match/cyclops.js';
import { cyclopsGroupSizes } from '../../shared/playerCapacity.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { buildResult } from '../../server/match/results.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });

function fixture(t, { count = 4, humans = 1, variant = 'entertainment_cyclops', seed = 77, difficulty = 'NORMAL' } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: true });
  const m = new Match({
    mode: 'coop', difficulty, variant,
    seats: Array.from({ length: count }, (_, seat) => ({
      seat, playerId: `p${seat}`, name: `P${seat}`, isBot: seat >= humans, connected: true,
    })),
    data: DATA, seed, scheduler, clientCombat: false, botRehearsal: 0,
    send() {}, broadcast() {}, onEnd() {},
  });
  t.after(() => { m.dispose(); scheduler.dispose(); });
  return m;
}

/** 真人代答：infoReady / 策略 / ready / （可选）海克斯选槽。单人局各阶段无计时，需代发。 */
function autoAnswerHumans(m, { hex = true } = {}) {
  if (m.phase === PHASE.INFO_CHECK) {
    for (const ps of m.order) if (!ps.isBot && !ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' });
  }
  if (m.phase === PHASE.BAND_DRAFT && m.draft) {
    for (const ps of m.order) {
      if (ps.isBot || !ps.alive || ps.left) continue;
      if (m.draftTurn && m.draftTurn(ps.playerId) === ps.playerId) {
        m.handle(ps.playerId, { t: 'g.band', bandId: m.defaultBand(ps.playerId) });
      }
    }
  }
  if (m.phase === PHASE.PREP) {
    for (const ps of m.order) {
      if (ps.isBot || !ps.alive || ps.left || ps.ready) continue;
      if (ps.tempEmpty) m.handle(ps.playerId, { t: 'g.ready', ready: true });
    }
  }
  if (hex && m.phase === PHASE.CYCLOPS_HEX && m.cyclops) {
    for (const ps of m.order) {
      if (ps.isBot || !ps.alive || ps.left) continue;
      const st = m.cyclops.state.get(ps.playerId);
      if (st && st.picked == null) m.handle(ps.playerId, { t: 'g.cyclopsHex', slot: 0 });
    }
  }
}

test('cyclops 基础：modeId / 全干员池 / 分组 / 不禁抽 / 经济装备排除', (t) => {
  const m = fixture(t);
  assert.equal(m.isCyclops, true);
  assert.equal(m.modeId, 'mode_cyclops');
  assert.equal(m.ranked, false);
  assert.equal(m.gd.lastRound, 21);
  assert.equal(m.gd.bossRound, 21);
  // 怪属性 R19 封顶：R20-R21 与 R19 相同（模板/数值前移后封顶点从 R16 平移到 R19）
  const s16 = m.gd.enemyScale(19);
  for (const r of [20, 21]) {
    const s = m.gd.enemyScale(r);
    assert.equal(s.atkMul, s16.atkMul, `R${r} 攻击沿 R19 封顶`);
    assert.equal(s.hpMul, s16.hpMul, `R${r} 生命沿 R19 封顶`);
  }
  // 舟铲铲沿用普通模式可见干员池，商店池与选秀候选均不额外放宽或过滤。
  const normal = new (m.gd.constructor)(DATA, 'mode_multi_normal');
  assert.deepEqual(m.gd.visibleChess, normal.visibleChess, '舟铲铲候选池与普通模式完全一致');
  assert.equal(m.gd.visibleChess.length, normal.visibleChess.length);
  assert.ok(!m.pool.has('chess_char_1_05_a'), '普通模式 hidden 干员不入舟铲铲池');
  // 经济装备排除
  assert.ok(!m.gd.shopItemsByTier[1].some((id) => id.startsWith('chess_item_1_03')), '盟约之币被排除');
  assert.ok(!m.gd.shopItemsByTier[2].some((id) => id.startsWith('chess_item_2_05') || id.startsWith('chess_item_2_07')), '玩偶系被排除');
  assert.ok(!m.gd.shopItemsByTier[3].some((id) => id.startsWith('chess_item_3_12')), '骑士储蓄罐被排除');
  // 无禁抽
  assert.deepEqual(m.disabledBonds, []);
  assert.deepEqual(m.bannedChess, []);
  // 普通模式装备池仍不受舟铲铲的经济装备排除规则影响
  assert.ok(normal.shopItemsByTier[1].some((id) => id.startsWith('chess_item_1_03')));
  assert.ok(!normal.visibleChess.includes('chess_char_1_05_a'), '普通模式 hidden 干员仍不入池');
});

test('舟铲铲四档难度：显示、结算、实际波次和Boss血池随选择变化，奖励关完全一致', (t) => {
  const original = JSON.stringify(DATA.config.modes);
  const matches = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'].map((difficulty) => fixture(t, { difficulty }));
  const normal = matches[1];
  for (const m of matches) {
    const difficulty = m.opts.difficulty;
    assert.equal(m.difficulty, difficulty);
    assert.equal(m.gd.difficulty, difficulty);
    assert.equal(m.publicView().difficulty, difficulty);
    assert.equal(buildResult(m, { victory: false, hiddenCleared: false, reason: 'defeat' }).difficulty, difficulty);
    assert.equal(m.gd.lastRound, 21);
    assert.equal(m.gd.bossRound, 21);
    assert.equal(m.ranked, false);
    for (const round of [20, 21]) assert.deepEqual(m.gd.enemyScale(round), m.gd.enemyScale(19));
    for (const round of CYCLOPS_BONUS_ROUNDS) {
      const wave = buildCyclopsBonusWave(m.gd, round);
      assert.deepEqual(wave, buildCyclopsBonusWave(normal.gd, round), `${difficulty} R${round}奖励关全部参数不变`);
      assert.equal(wave.spawns.length, 1);
      assert.equal(wave.spawns[0].enemyKey, 'enemy_1000_gopro_2');
      assert.equal(wave.spawns[0].count, 10);
      for (const roll of [0, 0.3, 0.6, 0.99]) {
        assert.equal(cyclopsBonusReward(m.gd, () => roll, null, round), cyclopsBonusReward(normal.gd, () => roll, null, round));
      }
    }
    const scale = m.gd.enemyScale(10);
    const wave = buildNormalWave(m.gd, m.rngWaves, m.factions, 10);
    assert.ok(wave.spawns.length > 0);
    for (const spawn of wave.spawns) {
      assert.equal(spawn.mods.hpMul, scale.hpMul);
      assert.equal(spawn.mods.atkMul, scale.atkMul);
      assert.equal(spawn.mods.speedMul, scale.speedMul);
    }
    for (const [bossId, boss] of Object.entries(DATA.bosses)) {
      if (Number.isFinite(boss.bloodPoint?.[difficulty])) {
        assert.equal(m.gd.bossPoolHp(bossId, 4), Math.max(1, Math.round(boss.bloodPoint[difficulty] * 0.75 * 4)));
      }
    }
  }
  const hpAt10 = matches.map((m) => m.gd.enemyScale(10).hpMul);
  assert.ok(hpAt10[0] < hpAt10[1] && hpAt10[1] < hpAt10[2] && hpAt10[2] < hpAt10[3], '四档普通波次实际生命值递增');
  assert.equal(matches[3].gd.enemyScale(10).speedMul, 1.15);
  for (let round = 1; round <= 21; round++) {
    const old = DATA.config.modes.mode_cyclops.enemyScale[round];
    assert.deepEqual(normal.gd.enemyScale(round), { hpMul: old.hp, atkMul: old.atk, speedMul: old.speed }, `险境R${round}保持原值`);
  }
  assert.equal(JSON.stringify(DATA.config.modes), original, '不同难度对局不修改共享配置');
});

test('舟铲铲难度缺省与非法值回退险境，普通模式难度和强度保持配置值', (t) => {
  for (const difficulty of [null, 'invalid']) {
    const m = fixture(t, { difficulty });
    assert.equal(m.difficulty, 'NORMAL');
    assert.deepEqual(m.gd.enemyScale(10), { hpMul: 1.152, atkMul: 0.968, speedMul: 1 });
  }
  for (const difficulty of ['FUNNY', 'NORMAL', 'HARD', 'ABYSS']) {
    const m = fixture(t, { difficulty, variant: 'standard' });
    assert.equal(m.difficulty, difficulty);
    const scale = DATA.config.modes[`mode_multi_${difficulty.toLowerCase()}`].enemyScale[10];
    assert.deepEqual(m.gd.enemyScale(10), { hpMul: scale.hp, atkMul: scale.atk, speedMul: scale.speed });
  }
});

test('cyclops 分组：1-8 人每 4 人一组', () => {
  assert.deepEqual(cyclopsGroupSizes(1), [1]);
  assert.deepEqual(cyclopsGroupSizes(3), [3]);
  assert.deepEqual(cyclopsGroupSizes(4), [4]);
  assert.deepEqual(cyclopsGroupSizes(6), [4, 2]);
  assert.deepEqual(cyclopsGroupSizes(8), [4, 4]);
  assert.throws(() => cyclopsGroupSizes(9));
});

test('cyclops 每人 LP +10（策略基础血量之上）', (t) => {
  const m = fixture(t, { count: 2, humans: 0, seed: 11 });
  m.start();
  m.sched.advance(60_000); // 走完策略选择
  for (const ps of m.order) {
    const band = ps.bandId ? DATA.bands[ps.bandId] : null;
    const base = band && Number.isInteger(band.totalHp) ? band.totalHp : 28;
    assert.equal(ps.lp, base + 10, `${ps.playerId} LP = 策略血量 ${base} + 10`);
  }
});

test('经济馈赠银金效果削弱且金阶明显更强', (t) => {
  const m = fixture(t, { count: 1, humans: 1 });
  const ps = m.players.get('p0');
  const card = (id, quality) => ({ id, family: id.slice(4), quality, name: id, levelName: quality, logo: null, desc: '' });
  applyCyclopsHex(m, ps, card('cyc_economy', 'silver'));
  const silverEconomy = ps.effects.at(-1).params;
  assert.deepEqual({ now: 0, per: silverEconomy.roundIncome, win: silverEconomy.winBonus }, { now: 0, per: 1, win: 1 });
  applyCyclopsHex(m, ps, card('cyc_economy', 'gold'));
  const goldEconomy = ps.effects.at(-1).params;
  assert.equal(ps.funds, 15, '金阶即时金币已降低至 15');
  assert.equal(goldEconomy.roundIncome, 3);
  assert.ok(goldEconomy.roundIncome > silverEconomy.roundIncome);
  assert.ok(ps.effects.every((e) => e.iconKind === 'cyclops'));

  applyCyclopsHex(m, ps, card('cyc_refresh', 'silver'));
  const silverRefresh = ps.effects.at(-1).params.freeChance;
  applyCyclopsHex(m, ps, card('cyc_refresh', 'gold'));
  assert.deepEqual([silverRefresh, ps.effects.at(-1).params.freeChance], [0.1, 0.25]);

  applyCyclopsHex(m, ps, card('cyc_bounty', 'silver'));
  const silverBounty = ps.effects.at(-1).params.killChance;
  applyCyclopsHex(m, ps, card('cyc_bounty', 'gold'));
  assert.equal(silverBounty, 0.1);
  assert.equal(ps.effects.at(-1).params.winPerEnemy, 1);

  applyCyclopsHex(m, ps, card('cyc_streak', 'silver'));
  const silverStreak = ps.effects.at(-1).params.win;
  applyCyclopsHex(m, ps, card('cyc_streak', 'gold'));
  assert.deepEqual([silverStreak, ps.effects.at(-1).params.win], [1, 2]);
});

test('银阶盟约馈赠只赠送1–3阶干员，彩阶仍可赠送高阶', (t) => {
  const m = fixture(t, { count: 1 });
  const ps = m.players.get('p0');
  const families = ['victoria', 'sargon', 'yan', 'kjerag', 'laterano', 'egir', 'siracusa', 'kazimierz'];
  let expectedMax = 3;
  let rolls = 0;
  ps.pool = { roll(rng, { maxTier, filter }) {
    rolls++;
    assert.equal(maxTier, expectedMax);
    const candidates = m.gd.visibleChess.filter(filter);
    assert.ok(candidates.length > 0, '各盟约有可赠送的合法候选');
    for (const id of candidates) assert.ok(m.gd.chess(id).tier <= expectedMax);
    for (const id of m.gd.visibleChess.filter((id) => m.gd.chess(id).tier > expectedMax)) assert.equal(filter(id), false);
    return candidates[0];
  } };
  const awarded = [];
  ps.acquireChess = (id) => { awarded.push(id); };
  ps.acquireItem = () => null;
  for (const family of families) {
    const hex = DATA.cyclops.hexes.find((h) => h.family === family);
    assert.match(hex.levels.silver.desc, /1名随机三阶及以下/);
    applyCyclopsHex(m, ps, { id: hex.id, family, quality: 'silver', name: hex.name, levelName: hex.levels.silver.name });
  }
  assert.equal(awarded.length, families.length);
  assert.ok(awarded.every((id) => m.gd.chess(id).tier <= 3));
  expectedMax = 6;
  applyCyclopsHex(m, ps, { id: 'cyc_victoria', family: 'victoria', quality: 'prismatic' });
  assert.ok(m.gd.chess(awarded.at(-1)).tier >= 4);
  assert.equal(rolls, families.length + 1);
});

test('舟铲铲连胜连败：2/4/6场升档、切换重计、下次备战到账且不重复结算', (t) => {
  const m = fixture(t, { count: 1 });
  const ps = m.players.get('p0');
  ps.lp = 100;
  const outcomes = [true, true, true, true, true, true, true, false, false, false, false, false, false, true];
  const bonuses = [0, 1, 1, 2, 2, 3, 3, 0, 1, 1, 2, 2, 3, 0];
  for (let i = 0; i < outcomes.length; i++) {
    m.round = i + 1;
    const won = outcomes[i];
    ps.pendingFunds = 0;
    m.lastResults.set(ps.playerId, { perfect: won, leaked: won ? [] : [{ counted: true }], killed: 0, total: 10, coins: 0, layerGains: {} });
    m.settle(null, null);
    assert.equal(ps.pendingFunds, bonuses[i], `第${i + 1}场奖励`);
    assert.equal(ps.cyclopsStreak, i < 7 ? i + 1 : i < 13 ? -(i - 6) : 1);
    m.settle(null, null);
    assert.equal(ps.pendingFunds, bonuses[i], '重复结算不重复发奖');
    const before = ps.funds;
    const interest = cyclopsInterest(before);
    ps.startRound(i + 2);
    assert.equal(ps.funds - before, m.gd.income(i + 2) + interest + bonuses[i]);
    assert.equal(ps.pendingFunds, 0);
  }
  m.round++;
  m.lastResults.set(ps.playerId, { synthetic: true, perfect: true, leaked: [], coins: 0, layerGains: {} });
  m.settle(null, null);
  assert.equal(ps.cyclopsStreak, 1, '占位战果不积累连胜');
  assert.equal(ps.pendingFunds, 0);
});

test('普通模式不获得舟铲铲连胜奖励', (t) => {
  const m = fixture(t, { count: 1, variant: 'standard' });
  const ps = m.players.get('p0');
  ps.lp = 100;
  for (let round = 1; round <= 6; round++) {
    m.round = round;
    m.lastResults.set(ps.playerId, { perfect: true, leaked: [], coins: 0, layerGains: {} });
    m.settle(null, null);
    assert.equal(ps.pendingFunds, 0);
    assert.equal(ps.cyclopsStreak, 0);
  }
});

test('存款利息：≤50 每 10 金 +1/回合，50 封顶', () => {
  assert.equal(cyclopsInterest(0), 0);
  assert.equal(cyclopsInterest(5), 0);
  assert.equal(cyclopsInterest(10), 1);
  assert.equal(cyclopsInterest(25), 2);
  assert.equal(cyclopsInterest(50), 5);
  assert.equal(cyclopsInterest(80), 5, '超过 50 不再增长');
  assert.equal(cyclopsInterest(200), 5);
});

test('奖励关波次：10 只普通猎狗；装备掉落 1-5 阶且按阶递减', (t) => {
  const m = fixture(t);
  const wave = buildCyclopsBonusWave(m.gd, 4);
  assert.equal(wave.spawns.length, 1);
  assert.equal(wave.spawns[0].enemyKey, 'enemy_1000_gopro_2');
  assert.equal(wave.spawns[0].count, 10);
  assert.ok(isCyclopsBonusRound(4) && isCyclopsBonusRound(8) && isCyclopsBonusRound(12) && isCyclopsBonusRound(16));
  assert.ok(!isCyclopsBonusRound(5));

  const gotTiers = new Map();
  const rng = () => 0;
  for (let tier = 1; tier <= 5; tier++) {
    const gd = { roundCfg: () => ({ bonusItemTiers: [tier] }), shopItemsByTier: { [tier]: [`item_${tier}`] } };
    assert.equal(cyclopsBonusReward(gd, rng, null, 4), `item_${tier}`, `tier ${tier} included`);
    gotTiers.set(tier, 0);
  }
  const pools = Object.fromEntries([1, 2, 3, 4, 5].map((tier) => [tier, [`item_${tier}`]]));
  const gd = { roundCfg: () => ({}), shopItemsByTier: pools };
  for (let i = 0; i < 15; i++) {
    const tier = Number(cyclopsBonusReward(gd, () => (i + 0.25) / 15, null, 4).split('_')[1]);
    gotTiers.set(tier, (gotTiers.get(tier) || 0) + 1);
  }
  assert.ok(gotTiers.get(1) > gotTiers.get(2) && gotTiers.get(2) > gotTiers.get(3)
    && gotTiers.get(3) > gotTiers.get(4) && gotTiers.get(4) > gotTiers.get(5), `概率递减：${JSON.stringify([...gotTiers])}`);
});

test('海克斯：三槽位不同 family、品质顺序 银→金→彩、已选去重', () => {
  const rng = { shuffle: (a) => a.sort(() => 0.5 - Math.random()), };
  for (const q of ['silver', 'gold', 'prismatic']) {
    const slots = rollCyclopsHexSlots(DATA, rng, q);
    assert.equal(slots.length, 3);
    assert.ok(slots.every((c) => c && c.id), `${q}: 3 槽都有卡`);
    const fams = slots.map((c) => c.family);
    assert.equal(new Set(fams).size, 3, `${q}: 三个不同 family`);
  }
  // 去重：已选过的不再出现
  const taken = new Set(['cyc_victoria']);
  const slots = rollCyclopsHexSlots(DATA, rng, 'silver', taken);
  assert.ok(!slots.some((c) => c.id === 'cyc_victoria'));
});

test('完整流程：21 回合（R21 最终攻势）、5/10/15 海克斯、R10 选秀、超时自动选', (t) => {
  // 全 AI：验证 AI 随机选择馈赠、R10 选秀与 R21 boss 战流程。
  // 注：VirtualScheduler 一次 advance 可能跨过整个 CYCLOPS_HEX / CYCLOPS_DRAFT 阶段，故以结果状态为准。
  const m = fixture(t, { count: 4, humans: 0, seed: 42 });
  const scheduler = m.sched;
  m.start();
  let sawFinalAssault = false;
  let sawDraft = false;
  for (let guard = 0; guard < 60000 && !m.ended; guard++) {
    if (m.phase === PHASE.FINAL_ASSAULT) sawFinalAssault = true;
    if (m.phase === PHASE.CYCLOPS_DRAFT) sawDraft = true;
    scheduler.advance(100);
  }
  assert.ok(m.ended, '对局结束');
  assert.equal(m.round, 21, '打到第 21 回合 boss 战');
  assert.ok(sawFinalAssault, 'R21 进入最终攻势');
  assert.ok(sawDraft, 'R10 进入选秀');
  assert.ok(m.bossPool || m.phase === PHASE.RESULT, 'boss 血池已建立（或已结算）');
  for (const ps of m.order) {
    const hexes = ps.cyclopsHexes || [];
    assert.equal(hexes.length, 3, `${ps.playerId} 自动获得 3 次海克斯`);
    assert.deepEqual(hexes.map((h) => h.quality), ['silver', 'gold', 'prismatic'], '品质顺序 银→金→彩');
  }
  assert.equal(m.errorCount, 0, '零引擎错误');
});

test('选秀环节：10 项干员+装备捆绑、LP 低者先选、每人一项、选取后移除', (t) => {
  const m = fixture(t, { count: 2, humans: 2, seed: 9 });
  const scheduler = m.sched;
  m.start();
  const auto = (opts = {}) => autoAnswerHumans(m, opts);
  for (let guard = 0; guard < 3000; guard++) {
    auto();
    if (m.phase === PHASE.BATTLE_CHECK) break;
    scheduler.advance(2000);
  }
  for (const ps of m.order) ps.lp = 999;
  for (let guard = 0; guard < 30000; guard++) {
    auto({ hex: true });
    if (m.round === 10) break;
    if (m.ended) assert.fail('对局提前结束');
    scheduler.advance(100);
  }
  // R10 到达：p1 设更低 LP → 选秀先手（选秀顺序在 enterCyclopsDraft 时读取当前 LP）
  m.players.get('p1').lp = 10;
  for (let guard = 0; guard < 30000; guard++) {
    auto({ hex: true });
    if (m.phase === PHASE.CYCLOPS_DRAFT) break;
    if (m.ended) assert.fail('对局提前结束');
    scheduler.advance(100);
  }
  assert.equal(m.phase, PHASE.CYCLOPS_DRAFT, '进入选秀');
  assert.equal(m.round, 10);
  const c = m.cyclops;
  // 顺序：LP 低者先选
  assert.equal(c.order[0], 'p1', 'p1 LP 低先选');
  assert.equal(c.order[1], 'p0');
  const mine = m._cyclopsDraftPoolOf(m.players.get('p0'));
  assert.equal(mine.items.length, 10, '10 个选项');
  assert.ok(mine.items.every((o) => o.chessId && o.itemId), '每项含干员+装备');
  // 非当前玩家不能选
  assert.equal(m.handle('p0', { t: 'g.cyclopsDraft', idx: 0 }).error, 'NOT_YOUR_TURN');
  // p1（先手）选第 0 项
  const before0 = m.players.get('p1');
  const gotBefore = before0.stats.buys; // 仅作标记
  assert.equal(m.handle('p1', { t: 'g.cyclopsDraft', idx: 0 }).ok, true);
  assert.equal(c.taken[`g:${mine.groupId}:0`], 'p1', '选项 0 记入 taken');
  // 已被占用的项不能再选
  assert.equal(m.handle('p0', { t: 'g.cyclopsDraft', idx: 0 }).error, 'SOLD_OUT');
  // p0 选第 1 项
  assert.equal(m.handle('p0', { t: 'g.cyclopsDraft', idx: 1 }).ok, true);
  // 全员选完 → 进入 PREP
  for (let guard = 0; guard < 50; guard++) {
    if (m.phase === PHASE.PREP) break;
    scheduler.advance(2000);
  }
  assert.equal(m.phase, PHASE.PREP, '选秀完成后进入休整');
  assert.equal(m.errorCount, 0);
});

test('奖励关分级掉落：击杀数决定赠品数、奖励关无联防', (t) => {
  const m = fixture(t, { count: 2, humans: 2, seed: 7 });
  const scheduler = m.sched;
  m.start();
  const auto = () => autoAnswerHumans(m, { hex: true });
  for (let guard = 0; guard < 3000; guard++) {
    auto();
    if (m.phase === PHASE.BATTLE_CHECK) break;
    scheduler.advance(2000);
  }
  for (const ps of m.order) ps.lp = 999;
  // 走到 R4（奖励关）PREP
  for (let guard = 0; guard < 30000; guard++) {
    auto();
    if (m.round === 4 && m.phase === PHASE.PREP) break;
    if (m.ended) assert.fail('提前结束');
    scheduler.advance(100);
  }
  assert.equal(m.round, 4, '到达 R4 奖励关');
  assert.equal(m.wave.spawns[0].enemyKey, 'enemy_1000_gopro_2');
  assert.equal(m.wave.spawns[0].count, 10);
  // 伪造 R4 战斗结果：p0 全杀（10/10 → 2 件），p1 只杀 3（<5 → 0 件）
  const itemsBefore0 = countItems(m, 'p0');
  const itemsBefore1 = countItems(m, 'p1');
  m.lastResults = new Map([
    ['p0', { leaked: [], perfect: true, coins: 0, killed: 10, total: 10, damageDealt: 0, layerGains: {}, synthetic: false }],
    ['p1', { leaked: [{ enemyKey: 'enemy_1000_gopro_2', counted: true }], perfect: false, coins: 0, killed: 3, total: 10, damageDealt: 0, layerGains: {}, synthetic: false }],
  ]);
  // 直接调 settle（绕过战斗），验证奖励关不触发联防（p1 漏 1 只且 p0 perfect → 普通回合会联防）
  m.phase = 'COMBAT';
  m.settle(null, null);
  assert.equal(m.phase === 'UNITE' || !!m.unitePlan, false, '奖励关不触发联防');
  // p0 拿到 2 件、p1 拿到 0 件（品阶 2-5）
  const gained0 = countItems(m, 'p0') - itemsBefore0;
  const gained1 = countItems(m, 'p1') - itemsBefore1;
  assert.equal(gained0, 2, `全杀得 2 件（实际 ${gained0}）`);
  assert.equal(gained1, 0, `击杀 3 只无赠品（实际 ${gained1}）`);
  assert.equal(m.errorCount, 0);
});

/** 统计玩家手上+板上的装备数。 */
function countItems(m, pid) {
  const ps = m.players.get(pid);
  let n = 0;
  for (const p of ps.hand) if (p && p.kind === 'item') n++;
  for (const p of ps.temp) if (p && p.kind === 'item') n++;
  for (const p of ps.board.values()) n += (p.items || []).length;
  return n;
}

test('真人海克斯交互：选择与单槽刷新', (t) => {
  // 2 真人：策略选定后把 LP 拉满（_applyBand 会以策略血量覆盖，须在其后再设），保证撑到 R5。
  const m = fixture(t, { count: 2, humans: 2, seed: 9 });
  const scheduler = m.sched;
  m.start();
  for (let guard = 0; guard < 2000; guard++) {
    autoAnswerHumans(m);
    if (m.phase === PHASE.BATTLE_CHECK) break;
    if (m.ended) assert.fail('对局提前结束（策略阶段）');
    scheduler.advance(2000);
  }
  for (const ps of m.order) ps.lp = 999;
  // 小步长推进，确保采样到 CYCLOPS_HEX（2s 的 ROUND_START 后必然进入）；本用例不代选海克斯
  for (let guard = 0; guard < 20000; guard++) {
    autoAnswerHumans(m, { hex: false });
    if (m.phase === PHASE.CYCLOPS_HEX) break;
    if (m.ended) assert.fail('对局提前结束');
    scheduler.advance(100);
  }
  assert.equal(m.phase, PHASE.CYCLOPS_HEX);
  assert.equal(m.round, 5);
  assert.equal(m.cyclops.turnSeconds, 25, '馈赠选择固定 25 秒，不占用备战时长');
  assert.equal(m.cyclops.deadline - scheduler.now(), 25_000, '馈赠阶段独立计时 25 秒');
  const p0 = m.players.get('p0');
  const st = m.cyclops.state.get('p0');
  const before = st.slots[0] && st.slots[0].id;
  // 刷新槽 0
  assert.equal(m.handle('p0', { t: 'g.cyclopsHexReroll', slot: 0 }).ok, true);
  assert.equal(st.rerolls[0], false, '槽 0 刷新机会已用');
  assert.equal(m.handle('p0', { t: 'g.cyclopsHexReroll', slot: 0 }).error, 'ALREADY', '二次刷新被拒');
  // 槽 1 未刷仍可用
  assert.equal(m.handle('p0', { t: 'g.cyclopsHexReroll', slot: 1 }).ok, true);
  // 无效槽位
  assert.equal(m.handle('p0', { t: 'g.cyclopsHex', slot: 9 }).error, 'BAD_TARGET');
  // 选择槽 0
  const picked = st.slots[0];
  assert.equal(m.handle('p0', { t: 'g.cyclopsHex', slot: 0 }).ok, true);
  assert.equal(st.picked, 0);
  assert.ok(p0.cyclopsHexes.some((h) => h.id === picked.id), '选择计入已选列表');
  assert.equal(m.handle('p0', { t: 'g.cyclopsHex', slot: 1 }).error, 'ALREADY', '重复选择被拒');
  // 未选玩家在 25 秒截止时从自己的候选槽位随机获得馈赠并进入 PREP
  const p1State = m.cyclops.state.get('p1');
  const p1Cards = p1State.slots.filter(Boolean).map((card) => card.id);
  scheduler.advance(m.cyclops.deadline - scheduler.now());
  for (let guard = 0; guard < 50; guard++) {
    if (m.phase === PHASE.PREP) break;
    scheduler.advance(100);
  }
  assert.equal(m.phase, PHASE.PREP, '馈赠选择完成后进入休整');
  assert.ok(p1Cards.includes(m.players.get('p1').cyclopsHexes.at(-1).id), '超时选择来自本人候选槽位');
  assert.equal(m.errorCount, 0);
});

test('升级经济：仍为2金买1经验、升级经验门槛降低25%并向上取整', (t) => {
  const m = fixture(t, { count: 2, humans: 2, seed: 5 });
  const scheduler = m.sched;
  m.start();
  for (let guard = 0; guard < 500; guard++) {
    if (m.phase === PHASE.PREP) break;
    scheduler.advance(2000);
  }
  const p0 = m.players.get('p0');
  // 普通升级价 [5,8,11,12,13] × 2 经验系数 × 75%，向上取整 → [8,12,17,18,20]
  const expected = [8, 12, 17, 18, 20];
  for (let level = 1; level <= expected.length; level++) {
    assert.equal(p0._cyclopsExpNeeded(level), expected[level - 1], `${level}→${level + 1} 经验门槛`);
    assert.equal(expected[level - 1], Math.ceil([5, 8, 11, 12, 13][level - 1] * 2 * 0.75));
  }
  // 每次升级按钮仍购买 1 经验（2 金）；不足 2 金时拒绝
  p0.funds = 1;
  assert.equal(m.handle('p0', { t: 'g.levelUp' }).error, 'NO_FUNDS');
  p0.funds = 2;
  assert.equal(m.handle('p0', { t: 'g.levelUp' }).ok, true);
  assert.equal(p0.shop.level, 1, '只买经验不升级');
  assert.equal(p0.shop.exp, 1);
  assert.equal(p0.funds, 0, '1 经验花 2 金');
  // 独立验证完整升级门槛成本
  p0.shop.exp = 0;
  // 8 次购买得到 8 经验并自动升级，总成本 16 金（原需 20 金）
  p0.funds = 16;
  for (let i = 0; i < 8; i++) assert.equal(m.handle('p0', { t: 'g.levelUp' }).ok, true);
  assert.equal(p0.shop.level, 2, '经验满 8 自动升级');
  assert.equal(p0.shop.exp, 0, '升级后经验清零');
  assert.equal(p0.funds, 0, '1→2 级成本从 20 金降低到 16 金');
  // 钱不够时拒绝
  p0.funds = 1;
  assert.equal(m.handle('p0', { t: 'g.levelUp' }).error, 'NO_FUNDS');
  // 连升测试：一路买到满级
  p0.funds = 300;
  let guard = 0;
  while (p0.shop.level < 6 && guard++ < 300) m.handle('p0', { t: 'g.levelUp' });
  assert.equal(p0.shop.level, 6, '可一路买到满级');
  assert.equal(p0.shop.exp, 0, '满级后经验清零');
  assert.equal(m.handle('p0', { t: 'g.levelUp' }).error, 'MAX_LEVEL', '满级后拒绝');
  assert.equal(m.errorCount, 0);
});

test('资金保留与利息：回合结束不清零、下回合发息', (t) => {
  const m = fixture(t, { count: 2, humans: 2, seed: 3 });
  const scheduler = m.sched;
  m.start();
  for (let guard = 0; guard < 500; guard++) {
    if (m.phase === PHASE.PREP && m.round >= 2) break;
    scheduler.advance(2000);
  }
  const p0 = m.players.get('p0');
  p0.funds = 30;
  // 结束本回合 prep（直接调 endPrep 模拟全员就绪）
  for (const ps of m.alivePlayers()) ps.setReady(true);
  for (let guard = 0; guard < 2000; guard++) {
    if (m.phase === PHASE.PREP && m.round === 3) break;
    if (m.ended) break;
    scheduler.advance(2000);
  }
  // R2 结束时未花的 30 金保留（未因 endPrep 清零），R3 开始发放利息 3
  assert.ok(p0.funds >= 30, `资金保留且含利息（实际 ${p0.funds}）`);
  assert.equal(m.errorCount, 0);
});
