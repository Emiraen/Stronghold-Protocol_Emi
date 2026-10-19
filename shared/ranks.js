// shared/ranks.js — 排位赛（RANKED）段位映射与计分公式（服务端权威；客户端用它渲染段位徽章）。
//
// 段位模型（用户标尺）：
//   黑铁/青铜/白银/黄金/白金/钻石/超凡 各 3 小段，每小段 100 分；
//   神话（不朽）区按分数分档：2100–2199 神话一，2200–2299 神话二，2300–2549 神话三；
//   ≥2550 赋能战魂。神话区以上显示 #全服排名。
//   分组：低段 = 黑铁..黄金（<1200），中段 = 白金..超凡（1200–2099），高段 = 神话/赋能（≥2100）。
//
// 定级赛（3 场，只能 险境/绝境/终极）：
//   每场得分 = 难度底分 + 18×存活回合 + 盟约分 + 8×协助(≤10) + 胜场加成；3 场合计夹在 [0, 2050]。
//   标尺锚点：险境全败且每把存活 ≤8 ⇒ 黑铁~白银；绝境同况 ⇒ 至多黄金一；终极同况 ⇒ 至多黄金三；
//   终极 999 盟约层 + 三战全胜全通过 + 多次协助 ⇒ 超凡三 50 分（2050，定级上限）。
//
// 常规局计分（定级后，神话/赋能失败扣分，其余段位不扣分）：
//   神话/赋能个人存活 >=11 回合、其余 >=9 回合即计算表现（死亡/败局也算）：sum(难度预算×六项权重×达成比例)，最终round。
//     所有段位NORMAL/HARD/ABYSS预算25/40/50；存活35%、有效总伤32%、Boss12%、盟约8%、完美8%、协助5%。
//     每项保留小数，合计round后不超过难度预算；无固定起步、段位/MMR修正，总伤包含Boss。
//   失败、个人死亡或未满个人存活门槛：结算前积分 ≥2100 时，险境/绝境/终极原扣额61/44/33；
//     低于2100原扣为0；达标表现全额计入净积分，败补只抵剩余扣分，无跳段；MMR原样。
//   跳段：绝境/终极 胜利、盟约层数 ≥200、协助 ≥3、个人有效伤害 ≥1500万记一次「统治级胜利」；连续 ≥2 次时该场
//     额外 +50，保留旧规则已累计的连胜次数。
//   人数补偿：按开局真人+AI总参赛人数快照，3/2/1人胜局独立+10/20/30，独立模拟也适用。
//     所有失败边界（含本人死亡/早死）补7/14/21，最多抵扣表现计入后的剩余扣分；低段不扣不补。
//     补偿与跳段不占难度基础预算；失败先表现再补偿，回执区分应补/实补/抵扣裁剪。
//     定级不叠补，无总人数快照不补；表现预算与败补额度不变。
//   隐藏分（ELO 式）：期望表现按难度设基准，K=32 更新不变；不参与常规基础分。
//   定级赛期间隐藏分加减更剧烈：赢 +32~+96、输 −96~−32（见 mmrUpdate）。
// 段位展示（rankOf().label，客户端徽章直接渲染）：
//   普通段位「钻石二 50分」（本段内小分）；神话区从「神话一 0 分」连续计（神话一 60分 / 神话二 120分 /
//   赋能战魂 600分）；神话以上由 RankedStore 在 label 尾部追加「#全服排名」；未定级显示「未定级 (x/y)」。

export const RANKED_DIFFICULTIES = ['NORMAL', 'HARD', 'ABYSS'];
/** Ranked preference and actual rating eligibility are separate: standard never changes a profile. */
export const isRankedMatch = (ranked, difficulty) => ranked === true && RANKED_DIFFICULTIES.includes(difficulty);
export const PLACEMENT_MATCHES = 3;
export const PLACEMENT_MAX_POINTS = 2050;   // 超凡三 50 分
export const RADIANT_POINTS = 2550;
export const RANK_BASE_GAIN_MAX = 50;

const CN_NUM = { 1: '一', 2: '二', 3: '三' };

const DIVISIONS = [
  { key: 'iron', cn: '黑铁', from: 0 },
  { key: 'bronze', cn: '青铜', from: 300 },
  { key: 'silver', cn: '白银', from: 600 },
  { key: 'gold', cn: '黄金', from: 900 },
  { key: 'platinum', cn: '白金', from: 1200 },
  { key: 'diamond', cn: '钻石', from: 1500 },
  { key: 'ascendant', cn: '超凡', from: 1800 },
  { key: 'immortal', cn: '神话', from: 2100 },
  { key: 'radiant', cn: '赋能战魂', from: RADIANT_POINTS },
];

/** 未定级视图。 */
export const UNRANKED = Object.freeze({
  division: null, divisionName: '未定级', tier: null, group: null,
  icon: 'unranked', label: '未定级', points: 0, globalRanked: false,
});

/**
 * 分数 → 段位视图。label 为完整展示串，含当前小段小分：
 *   普通段位按本段内小分（如 1550 ⇒「钻石二 50分」）；
 *   神话及以上从「神话一 0 分」起连续计分（小分 = 分数 − 2100）：
 *   2160 ⇒「神话一 60分」，2220 ⇒「神话二 120分」，2700 ⇒「赋能战魂 600分」。
 *   #全服排名后缀由 RankedStore.summary / settleMatch 追加（rankOf 本身不知道全服排名）。
 * @param {number} points @returns {{ division: string|null, divisionName: string, tier: number|null,
 *   group: 'low'|'mid'|'high'|null, icon: string, label: string, points: number, globalRanked: boolean }}
 */
export function rankOf(points) {
  const p = Math.max(0, Math.floor(Number(points) || 0));
  let div = DIVISIONS[0];
  for (const d of DIVISIONS) if (p >= d.from) div = d;
  const group = p >= 2100 ? 'high' : p >= 1200 ? 'mid' : 'low';
  if (p >= 2100) {
    const sub = p - 2100; // 神话区连续计分（神话一 0 分起）
    if (div.key === 'radiant') {
      return { division: 'radiant', divisionName: div.cn, tier: null, group, icon: 'radiant', label: `赋能战魂 ${sub}分`, points: p, globalRanked: true };
    }
    const tier = p < 2200 ? 1 : p < 2300 ? 2 : 3;
    return { division: 'immortal', divisionName: div.cn, tier, group, icon: `immortal_${tier}`, label: `神话${CN_NUM[tier]} ${sub}分`, points: p, globalRanked: true };
  }
  const tier = Math.min(3, Math.floor((p - div.from) / 100) + 1);
  const sub = (p - div.from) % 100; // 本小段（100 分一档）内的小分
  return { division: div.key, divisionName: div.cn, tier, group, icon: `${div.key}_${tier}`, label: `${div.cn}${CN_NUM[tier]} ${sub}分`, points: p, globalRanked: false };
}

/** 由实际 rankOf 映射生成积分边界，避免客户端维护另一份段位表。 */
export function rankBoundaries() {
  const rows = [];
  for (let points = 0; points <= RADIANT_POINTS; points++) {
    const rank = rankOf(points);
    const previous = rows.at(-1);
    if (previous?.icon === rank.icon) continue;
    if (previous) previous.to = points - 1;
    rows.push({ icon: rank.icon, label: rank.label.replace(/ \d+分$/, ''), from: points, to: null });
  }
  return rows;
}

// ---- 计分公式（服务端调用；导出以便测试） ----------------------------------------------------------

const DIFF_BASE = { NORMAL: 30, HARD: 90, ABYSS: 160 };
const DIFF_WIN = { NORMAL: 50, HARD: 65, ABYSS: 80 };
export const DIFFICULTY_BUDGET = Object.freeze({ NORMAL: 25, HARD: 40, ABYSS: 50 });
// 本轮配置的固定个人贡献目标，非官方实测；所有难度共用，不按人数缩小。
// 难度仅通过每项预算25/40/50影响表现评分，分母不得同步放大抵消倍率。
const COMMON_DAMAGE_TARGETS = Object.freeze({ damage: 1_000_000, boss: 250_000 });
export const PERFORMANCE_TARGETS = Object.freeze({
  NORMAL: COMMON_DAMAGE_TARGETS,
  HARD: COMMON_DAMAGE_TARGETS,
  ABYSS: COMMON_DAMAGE_TARGETS,
});
export const PERFORMANCE_WEIGHTS = Object.freeze({ survival: 0.35, damage: 0.32, boss: 0.12, layers: 0.08, perfect: 0.08, other: 0.05 });
const bounded = (v, max, fallback = 0) => {
  const n = Number(v);
  return Math.max(0, Math.min(max, Number.isFinite(n) ? n : fallback));
};
const DIFF_LOSS = { NORMAL: 55, HARD: 40, ABYSS: 30 };
const RANK_LOSS_FLOOR = 30;
const MMR_K = 32;
const MMR_START = 1000;
const MMR_MAX = 3000;

/** 盟约层数 → 定级分（分段递减：前 120 层 0.5/层 … 999 层共 ~151）。 */
export function layerScore(layers) {
  const L = Math.max(0, Math.min(999, Math.floor(Number(layers) || 0)));
  return 0.5 * Math.min(L, 120) + 0.25 * Math.min(Math.max(L - 120, 0), 180)
    + 0.1 * Math.min(Math.max(L - 300, 0), 300) + 0.04 * Math.max(L - 600, 0);
}

/**
 * 定级赛单场得分。
 * @param {{ difficulty: string, roundsPassed: number, layers: number, assists: number, win: boolean }} inp
 */
export function placementPoints(inp) {
  const d = DIFF_BASE[inp.difficulty];
  if (d == null) return 0;
  const pm = d
    + 18 * Math.max(0, Math.min(15, Math.floor(inp.roundsPassed || 0)))
    + layerScore(inp.layers)
    + 8 * Math.max(0, Math.min(10, Math.floor(inp.assists || 0)))
    + (inp.win ? (DIFF_WIN[inp.difficulty] || 0) : 0);
  return Math.max(0, Math.round(pm));
}

/** 定级总分夹取。 */
export function placementTotal(sum) {
  return Math.max(0, Math.min(PLACEMENT_MAX_POINTS, Math.round(Number(sum) || 0)));
}

const shortageWinBonus = (count) => Number.isInteger(count) && count >= 1 && count < 4 ? 10 * (4 - count) : 0;

/** 先全额计入个人表现，再败补抵剩余扣分；仅败补受剩余扣分限制。 */
export function rankLossSettlement(pointsBefore, rawLoss, startingParticipantCount, calculatedPerformance = 0) {
  rawLoss = bounded(rawLoss, Number.MAX_SAFE_INTEGER);
  const actualLoss = Math.min(bounded(pointsBefore, Number.MAX_SAFE_INTEGER), rawLoss);
  const appliedPerformance = bounded(calculatedPerformance, RANK_BASE_GAIN_MAX);
  const requestedShortageBonus = shortageWinBonus(startingParticipantCount) * 0.7;
  const shortageBonus = Math.min(Math.max(0, actualLoss - appliedPerformance), requestedShortageBonus);
  return { rawLoss, actualLoss, appliedPerformance, shortageBonus, requestedShortageBonus,
    cappedShortageBonus: requestedShortageBonus - shortageBonus, delta: appliedPerformance + shortageBonus - actualLoss };
}

/** 各项保留小数，求和后只取整一次。缺失的新统计为0，不从团队或旧伤害推造。 */
export function performanceScore(inp) {
  const budget = DIFFICULTY_BUDGET[inp.difficulty] || 0;
  const targets = PERFORMANCE_TARGETS[inp.difficulty];
  const survivalRounds = Math.floor(bounded(inp.survivalRounds ?? inp.roundsPassed, 15));
  const eligible = survivalRounds >= (inp.pointsBefore >= 2100 ? 11 : 9);
  const normalized = {
    survival: survivalRounds / 15,
    damage: targets ? bounded(inp.rankedDamage, targets.damage) / targets.damage : 0,
    boss: targets ? bounded(inp.bossDamage, targets.boss) / targets.boss : 0,
    layers: bounded(inp.layers, 999) / 999,
    perfect: bounded(inp.rankedPerfectRounds, 15) / 15,
    other: bounded(inp.assists, 10) / 10,
  };
  const items = Object.entries(PERFORMANCE_WEIGHTS).map(([key, weight]) => ({ key, weight,
    normalized: normalized[key], score: eligible ? budget * weight * normalized[key] : 0 }));
  const calculatedPerformance = bounded(Math.round(items.reduce((sum, item) => sum + item.score, 0)), budget);
  return { budget, survivalRounds, eligible, items, calculatedPerformance };
}

/**
 * 常规局计分：基础分 0..50，delta 含开局缺人补偿和跳段奖励；败补只抵实际扣分。
 * @param {{ difficulty: string, pointsBefore: number, mmr: number, mode?: string, startingParticipantCount?: number,
 *           win: boolean, alive: boolean, eliminatedRound?: number|null, roundsPassed: number,
 *           layers: number, assists: number, hiddenCleared?: boolean, dominantStreakBefore?: number }} inp
 * @returns {{ delta: number, kind: 'win'|'lossSurvived'|'earlyDeath', skipBonus: number, baseGain: number, shortageBonus: number }}
 */
export function rankDelta(inp) {
  const performance = performanceScore(inp);
  const calculatedPerformance = performance.calculatedPerformance;
  const empty = { baseGain: 0, calculatedPerformance, appliedPerformance: 0, performance,
    shortageBonus: 0, skipBonus: 0, rawLoss: 0, actualLoss: 0 };
  if (!DIFFICULTY_BUDGET[inp.difficulty]) return { ...empty, delta: 0, kind: 'lossSurvived' };
  const points = bounded(inp.pointsBefore, Number.MAX_SAFE_INTEGER);
  const earlyDeath = !performance.eligible;
  const rawLoss = points >= 2100 ? Math.max(RANK_LOSS_FLOOR, Math.round(DIFF_LOSS[inp.difficulty] * 1.1)) : 0;
  // 个人死亡/早死仍走失败结算；神话/赋能满11回合、其余满9回合才计入表现分。
  if (earlyDeath || !inp.win || !inp.alive) return {
    ...empty, ...rankLossSettlement(points, rawLoss, inp.startingParticipantCount, calculatedPerformance),
    kind: earlyDeath ? 'earlyDeath' : 'lossSurvived',
  };
  const shortageBonus = shortageWinBonus(inp.startingParticipantCount);
  // 保留连续两场要求，个人死亡或未达到存活门槛不触发跳段。
  const skipBonus = isDominantWin(inp) && (inp.dominantStreakBefore || 0) >= 1 ? 50 : 0;
  return { ...empty, delta: calculatedPerformance + shortageBonus + skipBonus, kind: 'win',
    baseGain: calculatedPerformance, appliedPerformance: calculatedPerformance, shortageBonus, skipBonus };
}

/** 统治级胜利判定（跳段条件，不含连胜本身）。 */
export function isDominantWin({ difficulty, win, layers, assists, rankedDamage }) {
  return !!win && (difficulty === 'HARD' || difficulty === 'ABYSS') && (layers || 0) >= 200 && (assists || 0) >= 3
    && (rankedDamage || 0) >= 15_000_000;
}

/**
 * 隐藏分（ELO 式）更新：实际表现对难度基准的偏离，K=32（封顶 ±32）。
 * 定级赛（opts.placement=true）加减更剧烈：赢 +32~+96、输 −96~−32，表现好坏决定区间内位置
 * （赢必加、输必扣，幅度最高为常规局的 3 倍）。
 * @param {number} mmr @param {{ difficulty: string, roundsPassed: number, layers: number, assists: number, win: boolean }} inp
 * @param {{ placement?: boolean }} [opts]
 */
export function mmrUpdate(mmr, inp, opts = {}) {
  const expected = { NORMAL: 7.5, HARD: 8.5, ABYSS: 9.5 }[inp.difficulty] ?? 8;
  const actual = Math.max(0, Math.min(15, Math.floor(inp.roundsPassed || 0)))
    + Math.max(0, Math.min(999, Math.floor(inp.layers || 0))) / 150
    + Math.max(0, Math.min(10, Math.floor(inp.assists || 0))) / 3
    + (inp.win ? 2 : 0);
  const dev = Math.max(-1, Math.min(1, (actual - expected) / 5));
  const shift = opts.placement
    ? Math.round(inp.win ? 64 + 32 * dev : -64 + 32 * dev)
    : MMR_K * dev;
  return Math.max(0, Math.min(MMR_MAX, Math.round((Number(mmr) || MMR_START) + shift)));
}

/** 段位图标 URL（public/assets/ranks/<icon>.png）。 */
export function rankIconUrl(icon) {
  return `/assets/ranks/${encodeURIComponent(String(icon || 'unranked'))}.png`;
}
