// test/ranked.test.js — 排位赛（RANKED）：段位映射、定级标尺、加减分公式（用户标尺锚点）、
// 隐藏分、RankedStore（定级流程 + JSON 持久化）与 lobby 校验（标准开放但不计分、room.state.ranked、
// hello.aid → rank.me 推送）。

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PLACEMENT_MATCHES, PLACEMENT_MAX_POINTS, RANK_BASE_GAIN_MAX, RANKED_DIFFICULTIES,
  isRankedMatch, isDominantWin, layerScore, mmrUpdate, placementPoints, placementTotal, rankDelta, rankLossSettlement, rankOf, UNRANKED,
  performanceScore, DIFFICULTY_BUDGET, PERFORMANCE_TARGETS, PERFORMANCE_WEIGHTS,
} from '../shared/ranks.js';
import { RankedStore } from '../server/rankedStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';

const AID1 = 'a1b2c3d4e5f60718';
const AID2 = '99aa88bb77cc66dd';

// ---------------------------------------------------------------------------------------------------
// 段位映射
// ---------------------------------------------------------------------------------------------------

describe('rankOf mapping', () => {
  test('each small tier is 100 points', () => {
    assert.equal(rankOf(0).label, '黑铁一 0分');
    assert.equal(rankOf(99).label, '黑铁一 99分');
    assert.equal(rankOf(100).label, '黑铁二 0分');
    assert.equal(rankOf(299).label, '黑铁三 99分');
    assert.equal(rankOf(300).label, '青铜一 0分');
    assert.equal(rankOf(899).label, '白银三 99分');
    assert.equal(rankOf(900).label, '黄金一 0分');
    assert.equal(rankOf(1199).label, '黄金三 99分');
    assert.equal(rankOf(1200).label, '白金一 0分');
    assert.equal(rankOf(1499).label, '白金三 99分');
    assert.equal(rankOf(1500).label, '钻石一 0分');
    assert.equal(rankOf(1799).label, '钻石三 99分');
    assert.equal(rankOf(1800).label, '超凡一 0分');
    assert.equal(rankOf(2099).label, '超凡三 99分');
  });

  test('label 带小段小分（钻石二 50分 = 1650）', () => {
    assert.equal(rankOf(1550).label, '钻石一 50分');
    assert.equal(rankOf(1599).label, '钻石一 99分');
    assert.equal(rankOf(1600).label, '钻石二 0分');
    assert.equal(rankOf(1650).label, '钻石二 50分');
    assert.equal(rankOf(1699).label, '钻石二 99分');
    assert.equal(rankOf(1700).label, '钻石三 0分');
  });

  test('immortal brackets then radiant（神话区从神话一 0 分连续计）', () => {
    assert.equal(rankOf(2100).label, '神话一 0分');
    assert.equal(rankOf(2160).label, '神话一 60分');
    assert.equal(rankOf(2199).label, '神话一 99分');
    assert.equal(rankOf(2200).label, '神话二 100分');
    assert.equal(rankOf(2220).label, '神话二 120分');
    assert.equal(rankOf(2299).label, '神话二 199分');
    assert.equal(rankOf(2300).label, '神话三 200分');
    assert.equal(rankOf(2549).label, '神话三 449分');
    assert.equal(rankOf(2550).label, '赋能战魂 450分');
    assert.equal(rankOf(2700).label, '赋能战魂 600分');
    assert.equal(rankOf(99999).label, '赋能战魂 97899分');
    assert.equal(rankOf(2100).globalRanked, true);
    assert.equal(rankOf(2050).globalRanked, false);
  });

  test('gain groups: 下三段 / 中三段 / 上三段', () => {
    assert.equal(rankOf(0).group, 'low');
    assert.equal(rankOf(1199).group, 'low');
    assert.equal(rankOf(1200).group, 'mid');
    assert.equal(rankOf(2099).group, 'mid');
    assert.equal(rankOf(2100).group, 'high');
    assert.equal(rankOf(2550).group, 'high');
  });

  test('icons follow division+tier; radiant and immortal have their own', () => {
    assert.equal(rankOf(0).icon, 'iron_1');
    assert.equal(rankOf(905).icon, 'gold_1');
    assert.equal(rankOf(2250).icon, 'immortal_2');
    assert.equal(rankOf(2600).icon, 'radiant');
    assert.equal(UNRANKED.icon, 'unranked');
  });
});

// ---------------------------------------------------------------------------------------------------
// 定级赛标尺（用户锚点）
// ---------------------------------------------------------------------------------------------------

describe('placement anchors', () => {
  const loss = (difficulty, rounds, layers, assists = 1) =>
    placementPoints({ difficulty, roundsPassed: rounds, layers, assists, win: false });

  test('险境 全败 每把存活 ≤8 ⇒ 黑铁~白银（≤899）', () => {
    for (const rounds of [2, 5, 8]) {
      const total = placementTotal([0, 1, 2].reduce((s) => s + loss('NORMAL', rounds, 100), 0));
      assert.ok(total <= 899, `rounds=${rounds} total=${total} should stay in 黑铁~白银`);
      assert.ok(total >= 0);
    }
    // 勉强打：仍在黑铁区
    const weak = placementTotal(loss('NORMAL', 1, 20, 0) * 3);
    assert.ok(weak <= 299, `weak=${weak} should stay in 黑铁`);
    // 全败但存活 8 回合：白银区（≈696）
    const ok8 = placementTotal(loss('NORMAL', 8, 100) * 3);
    assert.ok(ok8 >= 600 && ok8 <= 899, `ok8=${ok8}`);
  });

  test('绝境 全败 存活 8 ⇒ 至多黄金一（≤999）', () => {
    const total = placementTotal(loss('HARD', 8, 150) * 3);
    assert.ok(total >= 900 && total <= 999, `HARD total=${total} should land 黄金一`);
  });

  test('终极 全败 存活 8 ⇒ 至多黄金三（≤1199）', () => {
    const total = placementTotal(loss('ABYSS', 8, 200) * 3);
    assert.ok(total >= 1100 && total <= 1199, `ABYSS total=${total} should land 黄金三`);
  });

  test('终极 999 盟约 三战全胜全通过 多次协助 ⇒ 超凡三 50 分（2050 上限）', () => {
    const extreme = placementTotal(
      placementPoints({ difficulty: 'ABYSS', roundsPassed: 15, layers: 999, assists: 10, win: true }) * 3);
    assert.equal(extreme, PLACEMENT_MAX_POINTS);
    assert.equal(rankOf(extreme).label, '超凡三 50分');
    assert.equal(rankOf(extreme).points, 2050); // 超凡三 50 分
  });

  test('排位意愿与实际计分资格分离', () => {
    for (const difficulty of ['FUNNY', ...RANKED_DIFFICULTIES, 'UNKNOWN']) {
      assert.equal(isRankedMatch(true, difficulty), RANKED_DIFFICULTIES.includes(difficulty));
      for (const preference of [false, undefined, null, 'true', 1]) {
        assert.equal(isRankedMatch(preference, difficulty), false);
      }
    }
  });

  test('标准模拟没有定级分', () => {
    assert.equal(placementPoints({ difficulty: 'FUNNY', roundsPassed: 15, layers: 999, assists: 10, win: true }), 0);
    assert.ok(!RANKED_DIFFICULTIES.includes('FUNNY'));
  });

  test('layerScore 分段递减', () => {
    assert.equal(Math.round(layerScore(999)), 151);
    assert.ok(layerScore(100) < layerScore(200));
    assert.ok(layerScore(999) < 999 * 0.5); // 远低于线性
  });
});

// ---------------------------------------------------------------------------------------------------
// 常规局加减分
// ---------------------------------------------------------------------------------------------------

describe('rankDelta', () => {
  const base = (over) => ({
    difficulty: 'HARD', pointsBefore: 0, mmr: 1000, humanCount: 4, win: true, alive: true,
    eliminatedRound: null, roundsPassed: 12, layers: 250, assists: 3, hiddenCleared: false,
    dominantStreakBefore: 0, ...over,
  });

  test('绝境胜利：黑铁~白银降低涨幅，黄金及以上按段位进一步收紧', () => {
    const at = (pointsBefore, over = {}) => rankDelta(base({ pointsBefore, ...over })).delta;
    assert.equal(at(0), performanceScore(base({})).calculatedPerformance, '没有旧固定起步，缺伤害/完美按0');
    assert.ok(at(899) >= at(900), '段位修正连续，无黄金门槛断崖');
    assert.equal(at(0), at(2100), '基础分不再受旧段位修正');
    assert.ok(at(1200) <= 50, '绝境白金以上基础加分至多50');
  });

  test('所有段位与难度基础分均不超过50，跳段另计', () => {
    const caps = { NORMAL: RANK_BASE_GAIN_MAX, HARD: RANK_BASE_GAIN_MAX, ABYSS: RANK_BASE_GAIN_MAX };
    for (const pointsBefore of [0, 299, 300, 899, 900, 1199, 1200, 2099, 2100, 2600]) {
      for (const difficulty of RANKED_DIFFICULTIES) {
        for (const humanCount of [1, 4]) for (const mmr of [0, 1000, 3000]) {
          const result = rankDelta(base({ pointsBefore, difficulty, humanCount, mmr,
            roundsPassed: 15, layers: 999, assists: 10, hiddenCleared: true, dominantStreakBefore: 0 }));
          assert.ok(result.delta >= 1 && result.delta <= caps[difficulty], `${pointsBefore}/${difficulty} delta=${result.delta}`);
          assert.equal(result.skipBonus, 0);
        }
      }
    }
    const skip = rankDelta(base({ pointsBefore: 900, difficulty: 'ABYSS', humanCount: 1,
      roundsPassed: 15, layers: 999, assists: 10, dominantStreakBefore: 1 }));
    assert.equal(skip.skipBonus, 100);
    assert.ok(skip.delta - skip.skipBonus <= 50, `skip bonus must not count towards base cap: ${skip.delta}`);
  });

  test('胜利仍保留难度差异；神话/赋能失败扣旧额，其余0', () => {
    const at = (difficulty, pointsBefore, over = {}) => rankDelta(base({ difficulty, pointsBefore, ...over })).delta;
    for (const points of [0, 900, 1200, 2100, 2600]) {
      assert.ok(at('NORMAL', points) < at('HARD', points) && at('HARD', points) < at('ABYSS', points), `wins at ${points}`);
      const loss = { win: false, alive: true };
      for (const difficulty of RANKED_DIFFICULTIES) {
        const expected = points >= 2100 ? { NORMAL: -61, HARD: -44, ABYSS: -33 }[difficulty] : 0;
        const calculated = performanceScore(base({ difficulty, pointsBefore: points, ...loss })).calculatedPerformance;
        assert.equal(at(difficulty, points, loss), Math.min(0, expected + calculated));
      }
    }
  });

  test('存活 <9 回合：神话/赋能扣61/44/33，其余段位0', () => {
    const early = (difficulty, points) =>
      rankDelta(base({ difficulty, pointsBefore: points, alive: false, eliminatedRound: 5, roundsPassed: 4 })).delta;
    for (const points of [0, 900, 1200, 2100, 2600]) {
      const normal = early('NORMAL', points);
      const hard = early('HARD', points);
      const abyss = early('ABYSS', points);
      assert.deepEqual([normal, hard, abyss], points >= 2100 ? [-61, -44, -33] : [0, 0, 0]);
    }
  });

  test('低段个人回合边界8/9：早死归0，不论输赢且不看 eliminatedRound', () => {
    for (const difficulty of RANKED_DIFFICULTIES) {
      for (const rp of [0, 4, 8]) {
        // 输 + 早死
        const lose = rankDelta(base({ difficulty, win: false, alive: false, eliminatedRound: rp + 1, roundsPassed: rp })).delta;
        assert.equal(lose, 0, `${difficulty} lose rp=${rp}`);
        // 团队赢了自己只活 <9 回合（如中途退出后胜利）：不发胜利分
        const win = rankDelta(base({ difficulty, win: true, alive: true, eliminatedRound: null, roundsPassed: rp, layers: 500, assists: 8 })).delta;
        assert.equal(win, 0, `${difficulty} win rp=${rp}`);
        // eliminatedRound ≥9 但 roundsPassed <9：仍按个人通过回合归0
        const late = rankDelta(base({ difficulty, win: false, alive: false, eliminatedRound: 9, roundsPassed: 8 })).delta;
        assert.equal(late, 0, `${difficulty} late-flag rp=8`);
      }
      // 低段恰好通过9回合的失败仍为0，无安慰分。
      const nine = rankDelta(base({ difficulty, win: false, alive: false, eliminatedRound: 9, roundsPassed: 9, layers: 100, assists: 0 })).delta;
      assert.ok(nine >= 0, `${difficulty} rp=9 should not deduct (got ${nine})`);
      // 存活 9 回合的胜利：正常加分
      const win9 = rankDelta(base({ difficulty, roundsPassed: 9, layers: 100 })).delta;
      assert.ok(win9 > 0, `${difficulty} win rp=9 delta=${win9}`);
    }
  });

  test('低段失败但存活 ≥9 回合：0分，无安慰分', () => {
    const d = rankDelta(base({ win: false, roundsPassed: 12, layers: 200, assists: 2 })).delta;
    assert.equal(d, 0);
  });

  test('#31 神话/赋能边界2099/2100/2550与队赢本人亡、早死、败存活', () => {
    const outcomes = [
      { win: false, alive: true, roundsPassed: 12, kind: 'lossSurvived' },
      { win: true, alive: false, roundsPassed: 9, kind: 'lossSurvived' },
      { win: false, alive: false, roundsPassed: 9, kind: 'lossSurvived' },
      { win: false, alive: false, roundsPassed: 8, kind: 'earlyDeath' },
      { win: true, alive: false, roundsPassed: 8, kind: 'earlyDeath' },
      { win: true, alive: true, roundsPassed: 8, kind: 'earlyDeath' },
    ];
    for (const pointsBefore of [0, 2099, 2100, 2550]) {
      for (const difficulty of RANKED_DIFFICULTIES) for (const outcome of outcomes) {
        const result = rankDelta(base({ pointsBefore, difficulty, ...outcome,
          eliminatedRound: 15, layers: 999, assists: 10, dominantStreakBefore: 3 }));
        const loss = pointsBefore >= 2100 ? { NORMAL: 61, HARD: 44, ABYSS: 33 }[difficulty] : 0;
        assert.equal(result.rawLoss, loss); assert.equal(result.actualLoss, loss);
        assert.equal(result.delta, -loss + Math.min(loss, result.calculatedPerformance));
        assert.equal(result.kind, outcome.kind); assert.equal(result.skipBonus, 0);
        assert.equal(result.baseGain, 0); assert.equal(result.shortageBonus, 0);
        assert.equal(result.performance.eligible, outcome.roundsPassed >= 9);
      }
    }
    const standard = rankDelta(base({ pointsBefore: 2550, difficulty: 'FUNNY', win: false }));
    assert.equal(standard.delta, 0); assert.equal(standard.calculatedPerformance, 0);
    assert.equal(standard.shortageBonus, 0);
  });

  test('开局总人数缺1/2/3独立+10/20/30，无人数双倍率；独立也补，旧字段不补', () => {
    const full = rankDelta(base({ mode: 'coop', startingParticipantCount: 4 }));
    for (const count of [1, 2, 3, 4]) {
      const result = rankDelta(base({ mode: 'coop', startingParticipantCount: count, humanCount: 1 }));
      assert.equal(result.baseGain, full.baseGain);
      assert.equal(result.shortageBonus, 10 * (4 - count));
      assert.equal(result.delta, full.delta + 10 * (4 - count));
      assert.equal(rankDelta(base({ mode: 'solo', startingParticipantCount: count })).shortageBonus, 10 * (4 - count));
      assert.equal(rankDelta(base({ startingParticipantCount: count })).shortageBonus, 10 * (4 - count));
    }
    for (const over of [{ humanCount: 1 }, { mode: 'coop', humanCount: 1 },
      { startingHumanCount: 1 }, { mode: 'coop', startingParticipantCount: 0 },
      { mode: 'coop', startingParticipantCount: NaN }, { startingParticipantCount: 1.5 },
      { startingParticipantCount: -1 }]) assert.equal(rankDelta(base(over)).shortageBonus, 0);
    const best = rankDelta(base({ mode: 'coop', startingParticipantCount: 1, difficulty: 'ABYSS',
      mmr: 3000, roundsPassed: 15, layers: 999, assists: 10, hiddenCleared: true,
      rankedDamage: 2_000_000, bossDamage: 500_000, rankedPerfectRounds: 15 }));
    assert.equal(best.baseGain, 50);
    assert.equal(best.delta, 80);
  });

  test('所有失败边界均允许7折败补，61/44/33扣额抵7/14/21且低段0', () => {
    const outcomes = [
      { win: false, alive: true, roundsPassed: 12 },
      { win: true, alive: false, roundsPassed: 12 },
      { win: false, alive: false, roundsPassed: 0 },
      { win: true, alive: false, roundsPassed: 8 },
      { win: true, alive: true, roundsPassed: 8 },
    ];
    for (const difficulty of RANKED_DIFFICULTIES) for (const count of [1, 2, 3, 4]) {
      for (const outcome of outcomes) for (const pointsBefore of [0, 15, 2099, 2100, 2550]) {
        const r = rankDelta(base({ difficulty, startingParticipantCount: count, pointsBefore,
          dominantStreakBefore: 3, ...outcome }));
        const loss = pointsBefore >= 2100 ? { NORMAL: 61, HARD: 44, ABYSS: 33 }[difficulty] : 0;
        assert.equal(r.rawLoss, loss); assert.equal(r.actualLoss, loss);
        assert.equal(r.appliedPerformance, Math.min(loss, r.calculatedPerformance));
        assert.equal(r.shortageBonus, Math.min(loss - r.appliedPerformance, 7 * (4 - count)));
        assert.equal(r.delta, -loss + r.appliedPerformance + r.shortageBonus); assert.ok(r.delta <= 0);
        assert.equal(r.baseGain, 0); assert.equal(r.skipBonus, 0);
      }
    }
  });

  test('实际扣分裁剪：原扣44但仅15积分，败补最多15，delta0不变相加分', () => {
    // 裁剪层独立输入；现行段位规则15积分本身不扣分，不能为测试改变原段位门槛。
    assert.deepEqual(rankLossSettlement(15, 44, 1), { rawLoss: 44, actualLoss: 15, appliedPerformance: 0, shortageBonus: 15, delta: 0 });
    assert.deepEqual(rankLossSettlement(15, 44, 2), { rawLoss: 44, actualLoss: 15, appliedPerformance: 0, shortageBonus: 14, delta: -1 });
    assert.deepEqual(rankLossSettlement(0, 44, 1), { rawLoss: 44, actualLoss: 0, appliedPerformance: 0, shortageBonus: 0, delta: 0 });
    assert.equal(rankLossSettlement(15, 44, undefined).delta, -15);
    assert.equal(rankDelta(base({ pointsBefore: 15, win: false, startingParticipantCount: 1 })).shortageBonus, 0);
  });

  test('跳段：绝境/终极 胜利 + 盟约 ≥200 + 协助 ≥3 连续第 2 次起 +100', () => {
    assert.equal(rankDelta(base({ dominantStreakBefore: 0 })).skipBonus, 0, 'first dominant win: no skip');
    const second = rankDelta(base({ dominantStreakBefore: 1 }));
    assert.equal(second.skipBonus, 100, 'second consecutive dominant win: +100');
    assert.ok(second.delta > rankDelta(base({ dominantStreakBefore: 0 })).delta);
    // 险境胜利即使表现好也不算统治级
    assert.equal(rankDelta(base({ difficulty: 'NORMAL', dominantStreakBefore: 5 })).skipBonus, 0);
    // 统治级判定本身
    assert.ok(isDominantWin({ difficulty: 'HARD', win: true, layers: 200, assists: 3 }));
    assert.ok(!isDominantWin({ difficulty: 'HARD', win: true, layers: 199, assists: 3 }));
    assert.ok(!isDominantWin({ difficulty: 'HARD', win: true, layers: 250, assists: 2 }));
    assert.ok(!isDominantWin({ difficulty: 'HARD', win: false, layers: 250, assists: 3 }));
  });

  test('隐藏分：表现好 → MMR 上升 → 加分上浮，反之下降（±15% 封顶）', () => {
    let mmr = 1000;
    for (let i = 0; i < 30; i++) mmr = mmrUpdate(mmr, { difficulty: 'HARD', roundsPassed: 14, layers: 600, assists: 6, win: true });
    assert.ok(mmr > 1000, `mmr=${mmr}`);
    const boosted = rankDelta(base({ mmr })).delta;
    const neutral = rankDelta(base({ mmr: 1000 })).delta;
    assert.equal(boosted, neutral, 'MMR只更新隐藏分，不修正常规表现分');
    let low = 1000;
    for (let i = 0; i < 30; i++) low = mmrUpdate(low, { difficulty: 'HARD', roundsPassed: 2, layers: 20, assists: 0, win: false });
    const reduced = rankDelta(base({ mmr: low })).delta;
    assert.equal(reduced, neutral);
  });
});

// ---------------------------------------------------------------------------------------------------
// RankedStore：定级流程与持久化
// ---------------------------------------------------------------------------------------------------

describe('Emi35 多维单调与合理范围', () => {
  const input = { win: true, alive: true, difficulty: 'NORMAL', pointsBefore: 0, mmr: 1000,
    roundsPassed: 14, layers: 250, assists: 3, hiddenCleared: false };
  test('难度递增、段位递减；回合/盟约/协助/MMR/隐藏逐项单调，基础0..50且有限', () => {
    let checked = 0;
    for (const pointsBefore of [0, 899, 900, 1200, 2099, 2100, 2550, 10000]) {
      for (const difficulty of RANKED_DIFFICULTIES) for (const mmr of [0, 1000, 3000]) {
        for (const roundsPassed of [9, 12, 14, 15]) for (const layers of [0, 100, 250, 999]) {
          for (const assists of [0, 1, 3, 10]) for (const hiddenCleared of [false, true]) {
            const ctx = { ...input, pointsBefore, difficulty, mmr, roundsPassed, layers, assists, hiddenCleared };
            const g = rankDelta(ctx).baseGain;
            assert.ok(Number.isFinite(g) && g >= 0 && g <= 50);
            for (const [field, value] of [['roundsPassed', 15], ['layers', 999], ['assists', 10],
              ['mmr', 3000], ['hiddenCleared', true], ['difficulty', 'ABYSS']]) {
              assert.ok(rankDelta({ ...ctx, [field]: value }).baseGain >= g, field);
            }
            assert.ok(rankDelta({ ...ctx, pointsBefore: pointsBefore + 100 }).baseGain <= g);
            checked++;
          }
        }
      }
    }
    assert.equal(checked, 9216);
    for (const value of [NaN, Infinity, -Infinity, undefined, 'invalid', -100]) {
      const r = rankDelta({ ...input, pointsBefore: value, mmr: value, layers: value, assists: value });
      assert.ok(Number.isFinite(r.delta) && r.baseGain >= 0 && r.baseGain <= 50);
      assert.equal(rankDelta({ ...input, roundsPassed: value }).baseGain, 0);
    }
  });
  test('正常胜落在目标范围，弱胜不被乘法压扁；高表现仍区分', () => {
    for (const pointsBefore of [0, 900, 1200, 2100, 3000]) {
      for (const [difficulty, low, high] of [['NORMAL', 8, 25], ['HARD', 12, 40], ['ABYSS', 16, 50]]) {
        const normal = rankDelta({ ...input, difficulty, pointsBefore }).baseGain;
        const weak = rankDelta({ ...input, difficulty, pointsBefore, roundsPassed: 9, layers: 0, assists: 0, mmr: 0 }).baseGain;
        const strong = rankDelta({ ...input, difficulty, pointsBefore, roundsPassed: 15, layers: 999, assists: 10,
          hiddenCleared: true, mmr: 3000 }).baseGain;
        assert.ok(normal >= low && normal <= high, `${difficulty}/${pointsBefore}: ${normal}`);
        assert.ok(weak >= 5 && strong > normal && normal > weak);
      }
    }
  });
});

describe('RankedStore', () => {
  test('#31 真实RankedStore负delta降段与summary，无2100保护、下局按新分界', () => {
    for (const before of [2099, 2100, 2550]) for (const difficulty of RANKED_DIFFICULTIES) {
      for (const outcome of [
        { teamWin: false, alive: true, roundsPassed: 12 },
        { teamWin: true, alive: false, roundsPassed: 9 },
        { teamWin: true, alive: true, roundsPassed: 8 },
      ]) {
        const store = new RankedStore({ file: null, now: () => 500 });
        const p = store.ensure(AID1, '高段测试');
        Object.assign(p, { placementDone: true, placementPlayed: 3, points: before,
          mmr: 1234, matches: 3, dominantStreak: 2 });
        const info = store.settleMatch({ aid: AID1, name: p.name },
          { difficulty, mode: 'coop', startingParticipantCount: 1, humanCount: 1, teamWin: outcome.teamWin, hiddenCleared: true },
          { ...outcome, eliminatedRound: 15, layers: 999, assists: 10 });
        const raw = before >= 2100 ? { NORMAL: 61, HARD: 44, ABYSS: 33 }[difficulty] : 0;
        const expected = Math.min(0, -raw + info.calculatedPerformance + 21);
        assert.equal(info.delta, expected);
        assert.equal(info.after, Math.max(0, before + expected));
        assert.equal(info.skipBonus, 0);
        assert.equal(info.baseGain, 0);
        assert.equal(info.shortageBonus, Math.min(raw - info.appliedPerformance, 21));
        assert.equal(info.rawLoss, before >= 2100 ? { NORMAL: 61, HARD: 44, ABYSS: 33 }[difficulty] : 0);
        assert.equal(info.actualLoss, info.rawLoss);
        assert.equal(p.dominantStreak, 0);
        assert.equal(p.mmr, mmrUpdate(1234, { difficulty, roundsPassed: outcome.roundsPassed,
          layers: 999, assists: 10, win: outcome.teamWin }));
        const summary = store.summary(AID1);
        assert.equal(summary.points, info.after);
        assert.equal(summary.rank.icon, info.iconAfter);
        assert.equal(summary.rank.label, info.tierAfter);
        assert.equal(summary.globalRank, info.after >= 2100 ? 1 : null);
        if (before === 2100 && info.after < 2100) {
          assert.equal(info.iconAfter, 'ascendant_3');
          assert.equal(summary.rank.label.includes('#'), false);
          const next = store.settleMatch({ aid: AID1, name: p.name },
            { difficulty, humanCount: 4, teamWin: false },
            { alive: false, roundsPassed: 0, layers: 0, assists: 0 });
          assert.equal(next.delta, 0);
          assert.equal(next.after, info.after);
        }
        if (before === 2550) assert.equal(info.iconAfter, info.after < 2550 ? 'immortal_3' : 'radiant');
      }
    }
  });

  test('标准局防御结算：不建档、不改定级/积分/MMR/统计、不触发 root 奖励或保存', () => {
    for (const state of ['new', 'placement', 'placed', 'root']) {
      const store = new RankedStore({ file: null, now: () => 9999 });
      if (state !== 'new') {
        const p = store.ensure(AID1, state === 'root' ? 'root' : '博士');
        Object.assign(p, { points: 1650, mmr: 1234, placementPlayed: 2, placementScore: 700,
          placementDone: state === 'placed', wins: 1, losses: 1, matches: state === 'root' ? 0 : 2,
          dominantStreak: 1, lastActive: 100 });
      }
      const before = structuredClone([...store.profiles]);
      let saves = 0;
      store.save = () => saves++;
      for (const teamWin of [true, false]) for (const roundsPassed of [0, 15]) {
        const info = store.settleMatch({ aid: AID1, name: 'root', debugAuthorized: true },
          { difficulty: 'FUNNY', humanCount: 1, teamWin, hiddenCleared: true },
          { alive: teamWin, eliminatedRound: teamWin ? null : 1, roundsPassed, layers: 999, assists: 10 });
        assert.equal(info, null);
        assert.deepEqual([...store.profiles], before, state);
      }
      assert.equal(saves, 0);
    }
  });

  test('三场定级 → placementDone，分数 = placementTotal', () => {
    const store = new RankedStore({ file: null });
    const match = { difficulty: 'NORMAL', humanCount: 4, teamWin: false, hiddenCleared: false };
    let info = null;
    for (let i = 0; i < PLACEMENT_MATCHES; i++) {
      info = store.settleMatch({ aid: AID1, name: '博士' }, match,
        { alive: false, eliminatedRound: 7, roundsPassed: 6, layers: 80, assists: 1 });
    }
    assert.equal(info.placementDone, true);
    assert.equal(info.after, info.before === 0 ? info.after : info.after);
    assert.ok(info.after >= 0 && info.after <= 899, `placement after=${info.after}`);
    const p = store.profile(AID1);
    assert.equal(p.placementPlayed, 3);
    assert.equal(p.losses, 3);
    assert.equal(store.summary(AID1).ranked, true);
  });

  test('特批一把定级（root/emiraen）：单场表现分 ×3 落段', () => {
    const store = new RankedStore({ file: null });
    const match = { difficulty: 'HARD', humanCount: 1, teamWin: true, hiddenCleared: true };
    const row = { alive: true, eliminatedRound: null, roundsPassed: 12, layers: 200, assists: 5 };
    const single = placementPoints({
      difficulty: 'HARD', roundsPassed: row.roundsPassed, layers: row.layers,
      assists: row.assists, win: true,
    });
    // 无档案时 summary 按名字判定定级场数 = 1（root 的 +2000 首场特权见专项测试，这里用 emiraen 避开）
    assert.equal(store.summary(AID2, 'root', true).placementMatches, 1);
    const info = store.settleMatch({ aid: AID2, name: 'emiraen' }, match, row);
    assert.equal(info.bonus, 0);
    assert.equal(info.placementDone, true, '1 场即落段');
    assert.equal(info.placementPlayed, 1);
    assert.equal(info.placementMatches, 1);
    const expected = placementTotal(single * 3);
    assert.equal(info.after, expected, `after=${info.after} expected(单场×3)=${expected}`);
    assert.equal(store.profile(AID2).points, expected);
    // 普通玩家不受影响：仍是 3 场、单场分不 ×3
    const s2 = new RankedStore({ file: null });
    const i2 = s2.settleMatch({ aid: AID1, name: '博士' }, match, row);
    assert.equal(i2.placementDone, false);
    assert.equal(s2.profile(AID1).points, 0);
    assert.equal(store.summary(AID2).ranked, true);
  });

  test('summary label：神话以上小分后带 #全服排名；未定级带进度；2100 以下不带 #', () => {
    const store = new RankedStore({ file: null });
    const p1 = store.ensure(AID1, '甲'); p1.placementDone = true; p1.points = 2160; p1.lastActive = 1;
    const p2 = store.ensure(AID2, '乙'); p2.placementDone = true; p2.points = 2400; p2.lastActive = 2;
    assert.equal(store.summary(AID1).rank.label, '神话一 60分 #2');
    assert.equal(store.summary(AID2).rank.label, '神话三 300分 #1');
    // 2100 以下不追加 #
    p1.points = 1650;
    assert.equal(store.summary(AID1).rank.label, '钻石二 50分');
    // 未定级：已完成/总数
    const p3 = store.ensure('c1c1c1c1c1c1c1c1', '丙');
    p3.placementPlayed = 2;
    assert.equal(store.summary('c1c1c1c1c1c1c1c1').rank.label, '未定级 (2/3)');
  });

  test('settleMatch tierBefore/tierAfter：未定级进度 → 落段带小分', () => {
    const store = new RankedStore({ file: null });
    const match = { difficulty: 'HARD', humanCount: 4, teamWin: false, hiddenCleared: false };
    const row = { alive: false, eliminatedRound: 7, roundsPassed: 6, layers: 80, assists: 1 };
    const i1 = store.settleMatch({ aid: AID1, name: '博士' }, match, row);
    assert.equal(i1.tierAfter, '未定级 (1/3)');
    assert.equal(i1.tierBefore, '未定级');
    const i2 = store.settleMatch({ aid: AID1, name: '博士' }, match, row);
    assert.equal(i2.tierBefore, '未定级 (1/3)');
    assert.equal(i2.tierAfter, '未定级 (2/3)');
    const i3 = store.settleMatch({ aid: AID1, name: '博士' }, match, row);
    assert.equal(i3.tierAfter, rankOf(i3.after).label);
    assert.ok(!i3.tierAfter.includes('未定级'), `落段后 tierAfter=${i3.tierAfter}`);
  });

  test('定级赛隐藏分更剧烈：赢 +32~+96、输 −96~−32；常规局仍 ≤±32', () => {
    const perf = { difficulty: 'HARD', roundsPassed: 10, layers: 100, assists: 2, win: true };
    const gain = mmrUpdate(1000, perf, { placement: true }) - 1000;
    assert.ok(gain >= 32 && gain <= 96, `placement win mmr delta=${gain}`);
    const loss = mmrUpdate(1000, { ...perf, win: false }, { placement: true }) - 1000;
    assert.ok(loss <= -32 && loss >= -96, `placement loss mmr delta=${loss}`);
    const normal = mmrUpdate(1000, perf) - 1000;
    assert.ok(Math.abs(normal) <= 32, `normal mmr delta=${normal}`);
    // store 层：定级赛胜利后 MMR 上涨幅度 ≥ 32
    const store = new RankedStore({ file: null });
    store.settleMatch({ aid: AID1, name: '博士' }, { difficulty: 'HARD', humanCount: 4, teamWin: true, hiddenCleared: false },
      { alive: true, eliminatedRound: null, roundsPassed: 12, layers: 200, assists: 5 });
    assert.ok(store.profile(AID1).mmr - 1000 >= 32, `mmr=${store.profile(AID1).mmr}`);
  });

  test('同名选择共享旧 aid，不搬迁或忽略大小写', () => {
    const store = new RankedStore({ file: null });
    const players = new PlayerStore({ file: null });
    const p = store.ensure(AID1, 'root'); p.placementDone = true; p.points = 1650;
    const newcomer = 'ffff0000ffff0000ffff0000ffff0000';
    assert.equal(players.resolveName('root', newcomer, { ranked: store }), AID1);
    assert.equal(players.resolveName('Root', newcomer, { ranked: store }), newcomer);
    assert.equal(store.profile(AID1), p);
    assert.equal(store.profile(newcomer), null);
    assert.equal(store.summary(AID1).rank.label, '钻石二 50分');
  });

  test('root 首场排位不论输赢 +2000；第二场起不再加', () => {
    const store = new RankedStore({ file: null });
    // 首场：定级赛（root 一把定级）输了也 +2000
    const i1 = store.settleMatch({ aid: AID1, name: 'root', debugAuthorized: true },
      { difficulty: 'HARD', humanCount: 1, teamWin: false, hiddenCleared: false },
      { alive: false, eliminatedRound: 5, roundsPassed: 4, layers: 50, assists: 0 });
    const p1 = store.profile(AID1);
    assert.equal(i1.bonus, 2000);
    assert.equal(i1.placementDone, true, 'root 一把定级');
    const single = placementPoints({ difficulty: 'HARD', roundsPassed: 4, layers: 50, assists: 0, win: false });
    assert.equal(p1.points, placementTotal(single * 3) + 2000, `points=${p1.points}`);
    // 第二场：无 bonus
    const i2 = store.settleMatch({ aid: AID1, name: 'root', debugAuthorized: true },
      { difficulty: 'HARD', humanCount: 1, teamWin: true, hiddenCleared: false },
      { alive: true, eliminatedRound: null, roundsPassed: 12, layers: 100, assists: 2 });
    assert.equal(i2.bonus, 0);
    // 普通玩家永远没有 bonus
    const i3 = new RankedStore({ file: null }).settleMatch({ aid: AID2, name: '路人' },
      { difficulty: 'HARD', humanCount: 4, teamWin: true, hiddenCleared: false },
      { alive: true, eliminatedRound: null, roundsPassed: 12, layers: 100, assists: 2 });
    assert.equal(i3.bonus, 0);
  });

  test('常规局：低段早死不扣分；胜利加分；rank.me 摘要', () => {
    const store = new RankedStore({ file: null });
    // 快速完成定级（三场大胜）
    const strong = { difficulty: 'ABYSS', humanCount: 4, teamWin: true, hiddenCleared: true };
    for (let i = 0; i < 3; i++) {
      store.settleMatch({ aid: AID1, name: '博士' }, strong, { alive: true, eliminatedRound: null, roundsPassed: 15, layers: 700, assists: 6 });
    }
    const p = store.profile(AID1);
    assert.equal(p.placementDone, true);
    assert.ok(p.points > 0);
    // 第 9 回合前死亡 ⇒ 段位分不变
    const bad = store.settleMatch({ aid: AID1, name: '博士' }, { difficulty: 'NORMAL', humanCount: 4, teamWin: false, hiddenCleared: false },
      { alive: false, eliminatedRound: 4, roundsPassed: 3, layers: 30, assists: 0 });
    assert.equal(bad.delta, 0, 'early death does not deduct ranked points');
    assert.equal(bad.before, bad.after, 'early death preserves ranked points');
    assert.ok(bad.iconAfter);
    // 胜利加分
    const good = store.settleMatch({ aid: AID1, name: '博士' }, strong,
      { alive: true, eliminatedRound: null, roundsPassed: 14, layers: 400, assists: 4 });
    assert.ok(good.delta > 0);
    // summary 形状
    const s = store.summary(AID1);
    assert.ok(s.rank && typeof s.rank.label === 'string');
    assert.ok(s.globalRank === null || Number.isInteger(s.globalRank), 'globalRank: null or integer');
  });

  test('全服排名：神话区以上才有，按分数排序', () => {
    const store = new RankedStore({ file: null });
    const m = { difficulty: 'HARD', humanCount: 4, teamWin: true, hiddenCleared: false };
    for (const aid of [AID1, AID2]) {
      for (let i = 0; i < 3; i++) {
        store.settleMatch({ aid, name: aid === AID1 ? '甲' : '乙' }, m,
          { alive: true, eliminatedRound: null, roundsPassed: 14, layers: 900, assists: 8 });
      }
    }
    // 两人都在神话区（定级分 ~1800+）？ 若未到 2100 则 globalRank 应为 null
    const g1 = store.globalRank(AID1);
    const p1 = store.profile(AID1);
    if (p1.points < 2100) assert.equal(g1, null);
    else assert.ok(g1 >= 1 && g1 <= 2);
    // 手动抬到神话区验证排名
    p1.points = 2400;
    store.profile(AID2).points = 2500;
    assert.equal(store.globalRank(AID1), 2);
    assert.equal(store.globalRank(AID2), 1);
  });

  test('JSON 持久化往返', () => {
    const tmp = fs.mkdtempSync(path.join(process.env.EMI_TEST_TMP || os.tmpdir(), 'ranked-'));
    const file = path.join(tmp, 'ranked.json');
    const a = new RankedStore({ file });
    for (let i = 0; i < 3; i++) {
      a.settleMatch({ aid: AID1, name: '博士' }, { difficulty: 'HARD', humanCount: 4, teamWin: true, hiddenCleared: false },
        { alive: true, eliminatedRound: null, roundsPassed: 13, layers: 400, assists: 4 });
    }
    const p = a.profile(AID1);
    const b = new RankedStore({ file });
    assert.deepEqual(b.profile(AID1), p);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('aid 缺失/非法不建档案', () => {
    const store = new RankedStore({ file: null });
    assert.equal(store.profile('nope'), null);
    // ensure 只接受字符串 aid（调用方保证）；summary 未注册返回未定级（带 0/进度）
    const s = store.summary(AID2);
    assert.equal(s.ranked, false);
    assert.equal(s.rank.label, '未定级 (0/3)');
  });
});

// ---------------------------------------------------------------------------------------------------
// 服务器集成：hello.aid → rank.me；排位房间校验
// ---------------------------------------------------------------------------------------------------

describe('真实 Match 排位结算防线', () => {
  const data = getData({ log: { warn() {}, error() {}, info() {} } });
  function finish(store, difficulty, ranked, { victory = true, early = false } = {}) {
    const frames = [];
    let summary;
    const m = new Match({ roomCode: 'TEST', mode: 'solo', difficulty, ranked, rankedStore: store,
      data, seed: 7, scheduler: new VirtualScheduler(), botRehearsal: 0,
      seats: [{ seat: 0, playerId: 'p_test', name: '博士', aid: AID1, isBot: false, connected: true }],
      send: (_, msg) => { frames.push(msg); return true; }, broadcast() {}, onEnd: (s) => { summary = s; } });
    try {
      m.start();
      m.round = 14;
      // 本用例隔离finish管线：显式提供个人已完成回合，真实事件另有专项用例。
      m.players.get('p_test').stats.survivalRounds = early ? 4 : 14;
      if (early) m.players.get('p_test').eliminate(5);
      m.finish({ victory, reason: victory ? 'victory' : 'defeat' });
      m.finish({ victory });
      assert.equal(m.errorCount, 0);
      assert.ok(summary.players.length === 1);
      assert.ok(frames.some((f) => f.t === 'm.result'));
      return { summary, frames, ranked: m.ranked };
    } finally { m.dispose(); }
  }

  for (const difficulty of RANKED_DIFFICULTIES) {
    test(`${difficulty}：真实 finish 完成三场定级、常规胜利加分与早死扣分`, () => {
      const store = new RankedStore({ file: null });
      for (let i = 1; i <= 3; i++) {
        const { summary, frames, ranked } = finish(store, difficulty, true);
        assert.equal(ranked, true);
        const info = summary.players[0].rank;
        assert.equal(info.kind, 'placement');
        assert.equal(info.placementPlayed, i);
        assert.equal(info.placementDone, i === 3);
        assert.equal(store.profile(AID1).matches, i, '重复 finish 不重复计分');
        assert.ok(frames.some((f) => f.t === 'rank.me'));
      }
      const p = store.profile(AID1);
      assert.ok(p.points > 0);
      assert.ok(p.mmr > 1000);
      const before = p.points;
      const win = finish(store, difficulty, true).summary.players[0].rank;
      assert.ok(win.delta > 0);
      assert.equal(p.points, before + win.delta);
      const loss = finish(store, difficulty, true, { victory: false, early: true }).summary.players[0].rank;
      const expected = loss.before >= 2100 ? { NORMAL: -40, HARD: -23, ABYSS: -12 }[difficulty] : 0;
      assert.equal(loss.delta, expected);
      assert.equal(loss.after, loss.before + expected);
      assert.equal(p.matches, 5);
      assert.equal(p.wins, 4);
      assert.equal(p.losses, 1);
    });
    test(`${difficulty}：取消排位不改档案也不发排位更新`, () => {
      const store = new RankedStore({ file: null });
      const { summary, frames, ranked } = finish(store, difficulty, false);
      assert.equal(ranked, false);
      assert.equal(store.size, 0);
      assert.equal(Object.hasOwn(summary.players[0], 'rank'), false);
      assert.equal(frames.some((f) => f.t === 'rank.me'), false);
    });
  }

  test('FUNNY：即使 ranked=true，胜负/早死均不建档，不改已有完整档案，不发 rank.me', () => {
    const store = new RankedStore({ file: null });
    for (const existing of [false, true]) {
      if (existing) {
        Object.assign(store.ensure(AID1, '博士'), { points: 1650, mmr: 1300, placementDone: true,
          placementPlayed: 3, placementScore: 1650, matches: 5, wins: 4, losses: 1, dominantStreak: 2, lastActive: 100 });
      }
      const before = structuredClone([...store.profiles]);
      for (const victory of [true, false]) {
        const { summary, frames, ranked } = finish(store, 'FUNNY', true, { victory, early: !victory });
        assert.equal(ranked, false);
        assert.deepEqual([...store.profiles], before);
        assert.equal(Object.hasOwn(summary.players[0], 'rank'), false);
        assert.equal(frames.some((f) => f.t === 'rank.me'), false);
      }
    }
  });

  test('绕过构造器或直接调用 _settleRanked，标准与非排位仍不调用存储结算', () => {
    for (const [difficulty, ranked] of [['FUNNY', true], ['HARD', false]]) {
      let calls = 0;
      const context = { difficulty, ranked, rankedStore: { settleMatch() { calls++; } },
        players: new Map([['p', { playerId: 'p', aid: AID1, isBot: false }]]) };
      const result = { players: [{ playerId: 'p' }] };
      Match.prototype._settleRanked.call(context, result);
      assert.equal(calls, 0);
      assert.equal(Object.hasOwn(result.players[0], 'rank'), false);
    }
  });
});

describe('Emi35 开局快照、定级与持久化防重复', () => {
  const data = getData({ log: { info() {}, warn() {}, error() {} } });
  test('真实Match：3真人1AI/1真人3AI满员无补，1真人1AI补20，独立单人补30；淘汰观众重连不改快照', () => {
    for (const mode of ['coop', 'solo']) for (const [count, humans] of [[4, 3], [4, 1], [2, 1], [3, 2], [1, 1]]) {
      const store = new RankedStore({ file: null });
      Object.assign(store.ensure(AID1, '测试'), { placementDone: true, points: 1200, matches: 3 });
      const seats = Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p${seat}`, name: '测试',
        aid: seat === 0 ? AID1 : null, isBot: seat >= humans, connected: true }));
      const m = new Match({ mode, difficulty: 'HARD', ranked: true, rankedStore: store, data,
        scheduler: new VirtualScheduler(), botRehearsal: 0, seats, send() { return true; }, broadcast() {}, onEnd() {} });
      try {
        m.start(); m.round = 14;
        m.players.get('p0').stats.survivalRounds = 14;
        if (humans > 1) m.onDisconnect('p1');
        if (humans > 2) m.onLeave('p2');
        if (count > humans) m.players.get(`p${count - 1}`).eliminate(5);
        m.addObserver('observer-only');
        assert.equal(m.startingParticipantCount, count);
        assert.throws(() => { m.startingParticipantCount = 1; }, TypeError);
        m.finish({ victory: true });
        const info = m.lastResultMsg.players.find((p) => p.playerId === 'p0').rank;
        assert.equal(m.lastResultMsg.startingParticipantCount, count);
        assert.equal(info.startingParticipantCount, count);
        assert.equal(info.shortageBonus, 10 * (4 - count));
        assert.equal(info.delta, info.baseGain + info.shortageBonus + info.skipBonus);
        const before = structuredClone(store.profile(AID1));
        m.finish({ victory: true });
        m._settleRanked(m.lastResultMsg);
        m.onReconnect('p0');
        assert.deepEqual(store.profile(AID1), before);
        assert.equal(m.errorCount, 0);
      } finally { m.dispose(); }
    }
  });
  test('真实早死败补与history保留实际扣额，重复结算重连不重补；旧history不推造', () => {
    const store = new RankedStore({ file: null });
    const history = new HistoryStore({ file: null });
    const seats = [{ seat: 0, playerId: 'p0', aid: AID1, name: '测试', isBot: false }];
    Object.assign(store.ensure(AID1, '测试'), { placementDone: true, points: 2550, mmr: 1234, matches: 3, dominantStreak: 2 });
    const m = new Match({ mode: 'solo', difficulty: 'HARD', ranked: true, rankedStore: store, data, seats,
      scheduler: new VirtualScheduler(), botRehearsal: 0, send() { return true; }, broadcast() {},
      onEnd(summary) { history.record({ matchId: 'dddddddddddddddddddddddddddddddd', seats, ranked: true, summary }); } });
    try {
      m.start(); m.round = 14; m.players.get('p0').eliminate(5); m.finish({ victory: false });
      const info = m.lastResultMsg.players[0].rank;
      assert.equal(info.rawLoss, 44); assert.equal(info.actualLoss, 44);
      assert.equal(info.shortageBonus, 21); assert.equal(info.delta, -23); assert.equal(info.after, 2527);
      const before = structuredClone(store.profile(AID1));
      m.finish({ victory: false }); m._settleRanked(m.lastResultMsg); m.onReconnect('p0');
      assert.deepEqual(store.profile(AID1), before);
      const saved = history.detail(AID1, history.list(AID1)[0].matchId).result;
      assert.equal(saved.startingParticipantCount, 1); assert.deepEqual(saved.players[0].rank, info);
      assert.equal(m.errorCount, 0);
    } finally { m.dispose(); }
    const oldRank = { kind: 'lossSurvived', before: 2550, after: 2506, delta: -44 };
    history.record({ matchId: 'cccccccccccccccccccccccccccccccc', seats, ranked: true,
      summary: { difficulty: 'HARD', players: [{ playerId: 'p0', rank: oldRank }] } });
    const old = history.detail(AID1, 'cccccccccccccccccccccccccccccccc').result;
    assert.equal(Object.hasOwn(old, 'startingParticipantCount'), false);
    assert.deepEqual(old.players[0].rank, oldRank);
  });
  test('无快照旧结算调用补0，不能使用旧真人数或结算人数虚构快照', () => {
    const store = new RankedStore({ file: null });
    Object.assign(store.ensure(AID1, '测试'), { placementDone: true, points: 2550, matches: 3 });
    const info = store.settleMatch({ aid: AID1, name: '测试' },
      { difficulty: 'HARD', startingHumanCount: 1, humanCount: 1, teamWin: false },
      { alive: false, roundsPassed: 0, layers: 0, assists: 0 });
    assert.equal(info.shortageBonus, 0); assert.equal(info.delta, -44); assert.equal(info.startingParticipantCount, null);
  });
  test('定级胜局不加缺人分，MMR与定级公式完全保留', () => {
    const store = new RankedStore({ file: null });
    const row = { alive: true, roundsPassed: 14, layers: 250, assists: 3 };
    const perf = { difficulty: 'HARD', ...row, win: true };
    let expectedMmr = 1000;
    for (let i = 1; i <= 3; i++) {
      expectedMmr = mmrUpdate(expectedMmr, perf, { placement: true });
      const info = store.settleMatch({ aid: AID1, name: '测试' },
        { difficulty: 'HARD', mode: 'coop', startingParticipantCount: 1, teamWin: true }, row);
      assert.equal(info.shortageBonus, 0);
      assert.equal(info.baseGain, 0);
      assert.equal(store.profile(AID1).mmr, expectedMmr);
      assert.equal(store.profile(AID1).placementScore, i * placementPoints(perf));
      if (i === 3) assert.equal(info.after, placementTotal(3 * placementPoints(perf)));
    }
  });
  test('工作区临时持久化：重复finish/重复同结果不重补，重载保持精确分与历史细项', () => {
    assert.ok(process.env.EMI_TEST_TMP, '本用例必须显式指定工作区临时目录');
    const tmp = fs.mkdtempSync(path.join(process.env.EMI_TEST_TMP, 'emi35-persist-'));
    const file = path.join(tmp, 'ranked.json');
    const historyFile = path.join(tmp, 'history.json');
    const store = new RankedStore({ file });
    const history = new HistoryStore({ file: historyFile });
    const seats = [{ seat: 0, playerId: 'p0', name: '测试', aid: AID1, isBot: false, connected: true }];
    Object.assign(store.ensure(AID1, '测试'), { placementDone: true, points: 1200, matches: 3, dominantStreak: 1 });
    const m = new Match({ roomCode: 'TEST', mode: 'coop', difficulty: 'ABYSS', ranked: true, rankedStore: store,
      data, scheduler: new VirtualScheduler(), botRehearsal: 0, seats, send() { return true; }, broadcast() {},
      onEnd(summary) { history.record({ matchId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', ranked: true, seats, summary }); } });
    try {
      m.start(); m.round = 14;
      const ps = m.players.get('p0');
      ps.activatedLayers = () => 250; ps.stats.assists = 3; ps.stats.survivalRounds = 14;
      m.finish({ victory: true });
      const info = m.lastResultMsg.players[0].rank;
      assert.equal(info.shortageBonus, 30); assert.equal(info.skipBonus, 100);
      assert.equal(info.delta, info.baseGain + 130);
      const saved = fs.readFileSync(file, 'utf8');
      m.finish({ victory: true }); m._settleRanked(m.lastResultMsg);
      assert.equal(fs.readFileSync(file, 'utf8'), saved);
      assert.deepEqual(new RankedStore({ file }).profile(AID1), store.profile(AID1));
      const recovered = new HistoryStore({ file: historyFile });
      assert.equal(recovered.list(AID1).length, 1);
      const historical = recovered.detail(AID1, recovered.list(AID1)[0].matchId).result;
      assert.equal(historical.startingParticipantCount, 1);
      assert.deepEqual(historical.players[0].rank, info);
    } finally { m.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('ranked lobby integration', () => {
  let srv = null;
  let pool = null;
  const open = new Set();

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, admin: false,
      ranked: new RankedStore({ file: null }), players: new PlayerStore({ file: null }), history: new HistoryStore({ file: null }) });
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    pool = {
      async player(name, aid) {
        const c = await TestClient.connect(url);
        open.add(c);
        const w = await c.hello(name, null, aid ? { aid } : {});
        c.id = w.playerId;
        return c;
      },
    };
  });

  after(async () => {
    for (const c of open) { try { await c.close(); } catch { /* ignore */ } }
    await srv?.close();
  });

  test('hello.aid ⇒ rank.me 推送（未定级，label 带进度）', async () => {
    const c = await pool.player('博士', AID1);
    const msg = await c.waitFor('rank.me');
    assert.equal(msg.ranked, false);
    assert.equal(msg.rank.label, '未定级 (0/3)');
    assert.equal(msg.placementMatches, 3);
  });

  test('开启排位意愿仍可创建标准房并自由切换全部难度', async () => {
    const c = await pool.player('房主', AID1);
    const created = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', ranked: true });
    assert.equal(created.t, 'ok');
    const initial = await c.waitFor('room.state');
    assert.equal(initial.ranked, true);
    assert.equal(initial.difficulty, 'FUNNY');
    for (const difficulty of ['HARD', 'FUNNY', 'NORMAL', 'ABYSS']) {
      assert.equal((await c.request({ t: 'room.setDifficulty', difficulty })).t, 'ok');
      const state = await c.waitFor('room.state', (m) => m.difficulty === difficulty);
      assert.equal(state.ranked, true, '切换难度保留排位意愿');
    }
    await c.request({ t: 'room.leave' });
  });

  test('普通房间不带 ranked 标志', async () => {
    const c = await pool.player('路人');
    await c.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    const state = await c.waitFor('room.state');
    assert.equal(state.ranked, false);
    await c.request({ t: 'room.leave' });
  });

  test('排位对局开始：aid 随座位传入 Match（startMatch 不丢 aid 的回归）', async () => {
    // 直接用 Lobby + 桩 MatchClass 验证座位映射（真实对局需要客户端打完整局，这里只测管线）
    const { Lobby } = await import('../server/lobby.js');
    const { SessionRegistry } = await import('../server/net.js');
    const store = new RankedStore({ file: null });
    let capturedSeats = null;
    let matchNo = 0;
    class StubMatch {
      constructor(opts) { capturedSeats = opts.seats; this.ranked = opts.ranked; this.rankedStore = opts.rankedStore; matchNo += 1; }
      start() {}
    }
    const registry = new SessionRegistry();
    const lobby = new Lobby({ registry, log: { info() {}, warn() {}, error() {} }, MatchClass: StubMatch, ranked: store });
    const session = registry.create('回归者');
    session.aid = AID1;
    const res = lobby.create(session, { mode: 'solo', difficulty: 'HARD', ranked: true });
    assert.equal(res.ok !== false && res.error == null, true, 'room created');
    const start = lobby.startMatch(lobby.roomOf(session));
    assert.equal(start.error == null, true, 'match started');
    assert.ok(Array.isArray(capturedSeats), 'Match received seats');
    const seat = capturedSeats.find((s) => s.playerId === session.playerId);
    assert.ok(seat, 'human seat present');
    assert.equal(seat.aid, AID1, 'seat carries the ranked aid (startMatch must not drop it)');
  });
});
