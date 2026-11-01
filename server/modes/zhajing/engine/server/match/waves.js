// server/match/waves.js — per-match enemy setup and per-round spawn generation: the OFFICIAL generator decoded from
// the client (`RandomEnemyGenerater`, research 08 §2; DESIGN §14 "Corrections from research 08/09"). No custom balance:
// counts, kinds, timing and stat scaling are the official ones.
//
// Per match (setupMatchWaves):
//   * stage: weighted (stages[id].weight) among mode.stages that are active with weight > 0 — official mode data:
//     标准 (FUNNY) / 入门 = 战场#01 only, 险境 = 8 stages, 绝境 / 终极 = 7 (no 战场#01), weight 50 each, so the match seed
//     picks uniformly (test/match/stagepick.test.js)
//   * factions: `specialEnemyNum` (3) distinct types among the involveRandom ones (FLY/TIMES/ELEMENT/DOT/INVISIBLE/
//     REFLECTION), uniform (shuffle, take 3)
//   * type schedule: each chosen type owns `count` (3) of the `maxLevelCnt` (15) round slots, SPECIAL fills the other 6;
//     the slots are shuffled — typeSlots[r-1] = the ONE type of round r (the briefing shows the 3 types, the order
//     stays hidden)
//   * picks: for every round 1..15, generated now (so the preview and every battle agree): half = r ≤ 7; a weighted
//     (entry.weight) special entry of the round's type and half whose SPECIAL key is not in the mode's
//     inactiveEnemyKeys (attached keys are never filtered); normal / elite = a random attached key
//   * boss: weighted mode.bossWeights; hidden boss: weighted mode.hiddenBossWeights (independent)
// Per round (buildNormalWave / buildBossWave; one composition shared by every player):
//   * every template SPAWN action whose key is a placeholder (N/E/S walk, NF/EF/SF fly) becomes the pick's
//     normal / elite / special key — or is SKIPPED (not spawned, not previewed) when the new key's movement class differs
//     from the placeholder's (ground rounds drop NF/EF/SF, FLY rounds drop N/E/S);
//     n' = clamp(roundHalfEven(f32(f32(n·P(tpl))/f(tpl)) / f32(P(new)/f(new))), 1, 5) per ACTION (P = enemies.json
//     attrPower, f = beFactor), unit i spawning at time + i·max(n·interval/n', 0.05·n·interval) (same window);
//     literal keys (R1 源石虫, leader escorts) and T/TF tokens are kept; 炎佑 (enemy_9012_acloon) is never an enemy
//   * leader / hidden rounds use the pick of their own slot (14, 15; solo 标准 9), so only E or EF escorts spawn
//   * stat scaling: mods = config.modes[m].enemyScale[r] (the PRTS table = the ENEMY effects 攻坚装备 / 补给线 / 急行军,
//     which hit every enemy but 炎佑 — no other multiplier), also for bounty enemies and leader parts; the leader takes
//     the ATK / speed multipliers but never HP (its HP is the shared server pool)
//   * every SpawnSpec = one action ({ time, enemyKey, routeIndex, count, interval, mods, actionIndex, preview }):
//     `mods.slot` (placeholder class) lets 联防 route leaks, `preview` = { gate, start, fly, elite, boss } feeds previewOf
// 炸惊模拟 规则14 敌方惊变（Match 侧，卡与算法在 sim/content/ejibian.js matchJibianPlan）：Match 每轮算一份 plan 传进来
// （buildNormalWave / buildBossWave 的 `{ plan }`；boss 轮两个半场必须共用同一份），templateSpawns 据此改写 ——
//   * 量变→质变 / 质变→量变：出怪量 ×1.4 / ×0.8，叠在规则8 的 ×1.2 上（1.68 / 0.96），随机挑组加减、每组至少留 1 只
//   * 强行顶吗：所有 spawn 的 time 压到最早的一个、interval 归零（actions 同步，悬赏插入与预览才不错位）
//   * 入职测试：每轮 15% 概率把小怪全换成源石虫（领袖 / 部位 / countInTotal = false / 飞行单位不动，数量不变）
// plan = null（没抽到卡，或抽到的都是战场侧的卡）时这一整条路与没有规则14 时逐字节一致。
// Bounties (bountySpawns / withBounties): each bounty unit joins the round template's first `lrsldr` (walker) / `yokai`
// (flyer) action (else action 0), inserted among that action's own units at floor((i+1)·len/(n+1)), and the whole list
// is spread over the action window (client `_InsertSpActionToNormal` + `_CalculateActionPredelay`, decoded).
// 联防 (buildUniteWave): walkers → the escaped template's `lrsldr` action, flyers → `yokai`, tokens → `gopro_2` /
// `lazerd` (else action 0); owner k starts 0.5·k s after the action, units step min(max(W/M, 0.05·W), 5 s) with M the
// largest owner group (client `_CalculateActionPredelayConsiderUid`, decoded).

import { createRng, deriveSeed } from '../sim/rng.js';
// 炸惊模拟 规则14 敌方惊变 的 Match 侧（出怪表）计划：卡 id 与算法在 sim/content/ejibian.js，这里只负责改写 spawns
import { matchJibianPlan, cardsOf, heavenTimeLimit, SLIME_KEY, RUZHI_SLIME_TOTAL, HEAVEN_CUT_GAME_S, HEAVEN_MIN_LIMIT_GAME_S } from '../sim/content/ejibian.js';

const ACLOON = 'enemy_9012_acloon';
const DEFAULT_PLACEHOLDERS = Object.freeze({
  N: { cls: 'normal', fly: false }, E: { cls: 'elite', fly: false }, S: { cls: 'special', fly: false },
  NF: { cls: 'normal', fly: true }, EF: { cls: 'elite', fly: true }, SF: { cls: 'special', fly: true },
});
const MIN_ACTION_INTERVAL_RATIO = 0.05;
/** 联防 timing (client `_CalculateActionPredelayConsiderUid`): owner offset ACTION_INTERVAL_FOR_UID, unit step cap
 * MAX_ACTION_INTERVAL_FOR_UID. */
const UNITE_OWNER_STEP = 0.5;
const UNITE_MAX_UNIT_STEP = 5;

/** Weighted pick of [id, weight] pairs with the rng. */
export function weightedPick(rng, pairs) {
  let total = 0;
  for (const [, w] of pairs) total += Math.max(0, Number(w) || 0);
  if (total <= 0) return pairs.length ? pairs[0][0] : null;
  let r = rng() * total;
  for (const [id, w] of pairs) { r -= Math.max(0, Number(w) || 0); if (r < 0) return id; }
  return pairs[pairs.length - 1][0];
}

/** C# Math.Round(double): banker's rounding (half to even). */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.floor(x + 0.5);
}

const gen = (gd) => (gd.factions.generation && typeof gd.factions.generation === 'object' ? gd.factions.generation : {});
const intOr = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

/** Official movement class of an enemy key (randomEnemyAttributeDict.isFlyEnemy, else its motion). */
export function isFlyKey(gd, key) {
  const e = gd.enemy(key);
  if (!e) return false;
  if (typeof e.isFlyEnemy === 'boolean') return e.isFlyEnemy;
  return !!(e.stats && e.stats.motion === 'FLY');
}

/** Official attribute power P(k) (float32), enemies.json `attrPower`; derived from the stats when absent. */
export function attrPower(gd, key) {
  const e = gd.enemy(key);
  if (!e) return 0;
  if (typeof e.attrPower === 'number' && Number.isFinite(e.attrPower)) return e.attrPower;
  const s = e.stats || {};
  const f = Math.fround;
  const bf = gen(gd).beFactors || {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  let p = f(f(f(n(s.atk) * (bf.atk ?? 5)) + f(n(s.maxHp) * (bf.hp ?? 1))) + f(n(s.def) * (bf.def ?? 3)));
  p = f(p + f((bf.res ?? 3) * n(s.res)));
  return p;
}

const beFactor = (gd, key) => {
  const v = gd.enemy(key)?.beFactor;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1;
};

/**
 * Units a placeholder action of `n` template enemies becomes (client `_CalculateEnemyCountByBattleEffectiveness`):
 * clamp(roundHalfEven(f32(f32(f32(n·P(t))/f(t)) / f32(P(new)/f(new)))), min, max).
 */
export function replacedCount(gd, tplKey, n, newKey) {
  const g = gen(gd);
  const min = Number.isInteger(g.minReplacedEnemyCount) ? g.minReplacedEnemyCount : 1;
  const max = Number.isInteger(g.maxReplacedEnemyCount) ? g.maxReplacedEnemyCount : 5;
  const f = Math.fround;
  const origin = f(f(n * attrPower(gd, tplKey)) / beFactor(gd, tplKey));
  const unit = f(attrPower(gd, newKey) / beFactor(gd, newKey));
  if (!(unit > 0)) return min;
  const ratio = f(origin / unit);
  return Math.max(min, Math.min(max, roundHalfEven(ratio)));
}

/** Placeholder key → { slot, cls, fly } (factions.generation.placeholders, else built from templateSlots). */
function placeholderMap(gd) {
  const g = gen(gd);
  if (g.placeholders && typeof g.placeholders === 'object') return g.placeholders;
  const out = {};
  const ts = gd.factions.templateSlots && typeof gd.factions.templateSlots === 'object' ? gd.factions.templateSlots : {};
  for (const [slot, key] of Object.entries(ts)) if (DEFAULT_PLACEHOLDERS[slot]) out[key] = { slot, ...DEFAULT_PLACEHOLDERS[slot] };
  return out;
}

const firstHalfMax = (gd) => intOr(gen(gd).firstHalfMaxRound, Math.floor(intOr(gen(gd).maxLevelCnt, 15) / 2));

/** The special entry list (factions.json entries) sorted by key. */
function entryList(gd) {
  const e = gd.factions.entries && typeof gd.factions.entries === 'object' ? Object.values(gd.factions.entries) : [];
  return e.filter((x) => x && typeof x.key === 'string').sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The round pick of a type (client `_GenerateRandomEnemyData`): weighted entry of that type and half whose SPECIAL key
 * is allowed in the mode, plus a random attached normal / elite key (never filtered by the mode).
 * @returns {null | { round: number, type: string, key: string, normal: string|null, elite: string|null, fly: boolean, firstHalf: boolean }}
 */
export function pickRoundEntry(gd, rng, type, round) {
  const half = round <= firstHalfMax(gd);
  const ok = (e) => e.type === type && !!e.firstHalf === half && e.key !== ACLOON && !!gd.enemy(e.key) && !gd.inactiveEnemies.has(e.key);
  let cands = entryList(gd).filter(ok);
  if (!cands.length && type !== 'SPECIAL') return pickRoundEntry(gd, rng, 'SPECIAL', round);
  if (!cands.length) return null;
  const idx = weightedPick(rng, cands.map((e, i) => [i, e.weight ?? 1]));
  const e = cands[Number(idx) || 0];
  const pickKey = (list) => {
    const keys = (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x && x.key)).filter((k) => typeof k === 'string' && gd.enemy(k) && k !== ACLOON);
    return keys.length ? keys[Math.floor(rng() * keys.length)] : null;
  };
  return { round, type: e.type, key: e.key, normal: pickKey(e.N), elite: pickKey(e.E), fly: typeof e.fly === 'boolean' ? e.fly : isFlyKey(gd, e.key), firstHalf: half };
}

/** Round type schedule: each chosen type × its slot count, filled with SPECIAL to maxLevelCnt, shuffled. */
export function makeTypeSchedule(gd, rng, factions) {
  const g = gen(gd);
  const max = intOr(g.maxLevelCnt, 15);
  const fill = typeof g.fillType === 'string' ? g.fillType : (typeof g.alwaysIncludedType === 'string' ? g.alwaysIncludedType : 'SPECIAL');
  const types = gd.factions.types && typeof gd.factions.types === 'object' ? gd.factions.types : {};
  const slots = [];
  for (const t of factions) {
    const n = intOr(types[t]?.count, 3);
    for (let i = 0; i < n && slots.length < max; i++) slots.push(t);
  }
  while (slots.length < max) slots.push(fill);
  rng.shuffle(slots);
  return slots;
}

function scheduleRng(rng) {
  const seed = typeof rng.state === 'function' ? deriveSeed(rng.state(), 'waves:schedule') : Math.floor(rng() * 4294967296);
  return createRng(seed);
}

/**
 * @param {import('./gamedata.js').GameData} gd
 * @param {Function} rng
 * @returns {{ stageId: string|null, factions: string[], bossId: string|null, hiddenBossId: string|null, typeSlots: string[], picks: object[] }}
 *   `factions` also carries the schedule as a non-enumerable `schedule` property ({ typeSlots, picks }), so callers
 *   that keep only the factions array (Match: buildNormalWave(gd, rng, this.factions, r)) get the official rounds.
 */
export function setupMatchWaves(gd, rng) {
  // stage
  const stageIds = Array.isArray(gd.mode.stages) ? gd.mode.stages : [];
  const stagePairs = stageIds.map((id) => [id, gd.stage(id)]).filter(([, s]) => s && s.active !== false && Number(s.weight) > 0).map(([id, s]) => [id, s.weight]);
  let stageId = stagePairs.length ? weightedPick(rng, stagePairs) : null;
  if (!stageId) {
    const any = Object.keys(gd.raw.stages || {}).filter((id) => gd.stage(id) && gd.stage(id).active);
    stageId = any.length ? any.sort()[0] : null;
  }
  // factions
  const types = gd.factions.types && typeof gd.factions.types === 'object' ? gd.factions.types : {};
  const n = Number.isInteger(gen(gd).specialEnemyNum) ? gen(gd).specialEnemyNum : 3;
  const random = Object.values(types).filter((t) => t && t.involveRandom).map((t) => t.type).sort();
  const shuffled = random.slice();
  rng.shuffle(shuffled);
  const chosen = shuffled.slice(0, Math.min(n, shuffled.length));
  const factions = chosen.slice().sort((a, b) => (types[a]?.sortId ?? 9) - (types[b]?.sortId ?? 9));
  // bosses
  const bw = gd.bossWeights(false);
  const bossId = bw.length ? weightedPick(rng, bw) : null;
  const hw = gd.bossWeights(true);
  const hiddenBossId = hw.length && gd.hiddenRound ? weightedPick(rng, hw) : null;
  // the 15-round schedule and picks (own rng stream derived from the setup rng's state: the draws above and whatever
  // the caller draws next from `rng` are unchanged)
  const srng = scheduleRng(rng);
  const typeSlots = makeTypeSchedule(gd, srng, chosen);
  const picks = [null];
  for (let r = 1; r <= typeSlots.length; r++) picks.push(pickRoundEntry(gd, srng, typeSlots[r - 1], r));
  Object.defineProperty(factions, 'schedule', { value: Object.freeze({ typeSlots: typeSlots.slice(), picks }), enumerable: false });
  return { stageId, factions, bossId, hiddenBossId, typeSlots, picks };
}

/**
 * The pick of round r: from a setup object ({ picks }), a factions array carrying the hidden schedule, or — for a plain
 * factions array (tools, tests) — drawn now: the round's type from the schedule's marginal distribution (each faction
 * 3 of 15 slots, SPECIAL the rest), then its entry.
 */
export function roundPick(gd, rng, factionsOrSetup, round) {
  const src = factionsOrSetup;
  const picks = src && !Array.isArray(src) && Array.isArray(src.picks) ? src.picks : (src && src.schedule && Array.isArray(src.schedule.picks) ? src.schedule.picks : null);
  if (picks) return picks[round] ?? null;
  const factions = Array.isArray(src) ? src : (src && Array.isArray(src.factions) ? src.factions : []);
  const g = gen(gd);
  const types = gd.factions.types && typeof gd.factions.types === 'object' ? gd.factions.types : {};
  const max = intOr(g.maxLevelCnt, 15);
  const pairs = factions.map((t) => [t, intOr(types[t]?.count, 3)]);
  const used = pairs.reduce((s, [, w]) => s + w, 0);
  pairs.push([typeof g.fillType === 'string' ? g.fillType : 'SPECIAL', Math.max(1, max - used)]);
  return pickRoundEntry(gd, rng, weightedPick(rng, pairs), round);
}

/** Enemy scale mods for round r (bosses excluded by the caller). */
/** 悬赏怪池：choices.json `cards.bounty` 里所有可出场的敌人 key（去重、跳过 draftExcluded）。 */
export function bountyEnemyKeys(gd) {
  const list = gd && gd.choices && gd.choices.cards && Array.isArray(gd.choices.cards.bounty) ? gd.choices.cards.bounty : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || typeof c.enemyKey !== 'string' || seen.has(c.enemyKey)) continue;
    if (c.draft === false || c.draftExcluded === true) continue;
    if (!gd.enemy(c.enemyKey)) continue;
    seen.add(c.enemyKey);
    out.push(c.enemyKey);
  }
  return out;
}

export function scaleFor(gd, r) {
  return gd.enemyScale(r);
}

/**
 * The spawn mods of a round's scale for a non-leader enemy: HP / ATK / speed, plus `defMul` when the round scales DEF
 * (炸惊模拟 规则2 — the official table has no DEF axis) and `supplyHpMul` when the round has one.
 */
export function roundMods(scale) {
  const m = { hpMul: scale.hpMul, atkMul: scale.atkMul, speedMul: scale.speedMul };
  if (scale.defMul != null) m.defMul = scale.defMul;
  if (scale.supplyHpMul != null) m.supplyHpMul = scale.supplyHpMul;
  return m;
}

/** Slot class of an enemy that has no placeholder slot (literal template keys, bounty adds). */
export function classOf(gd, enemyKey) {
  const e = gd.enemy(enemyKey);
  const fly = isFlyKey(gd, enemyKey);
  const elite = !!(e && e.rank === 'ELITE');
  if (fly) return elite ? 'EF' : 'NF';
  return elite ? 'E' : 'N';
}

/** Preview pen upper zone anchor row ((18,7); the lower anchor is (15,7)) and the client's row offsets. */
const PEN_UPPER_ROW = 18;
const PREVIEW_ROW_OFFSET = 6;
const PREVIEW_ROW_OFFSET_LEADER = 13;

/**
 * 'upper' | 'lower' preview zone of a route start (client `AutoChessEnemyPreviewManager`, research 08 §4.2): target row =
 * start row + 6 (leader rounds: + 13); the zone is the Manhattan-nearest anchor among those with anchor row ≤ target
 * row — (18,7) upper, (15,7) lower — so only a target row ≥ 18 reaches the upper zone: normal fields row 12 (upper
 * gate (12,10); rows 9–11 lower), boss fields row 5 (rows 2–4 lower: the leaders at (3,x)/(4,x) and the (2,10) gate).
 * A target below row 15 has no zone (the client picks a random pen tile) and is reported 'lower'.
 * @param {number[]|null} start [row, col]
 * @param {boolean} [leader] leader / hidden round (default: a boss-field row, ≤ 8)
 */
export function gateOf(start, leader) {
  const r = Array.isArray(start) ? start[0] : null;
  if (!Number.isFinite(r)) return 'lower';
  const lead = typeof leader === 'boolean' ? leader : r <= 8;
  const target = r + (lead ? PREVIEW_ROW_OFFSET_LEADER : PREVIEW_ROW_OFFSET);
  // both anchors share col 7, so with target ≥ 18 the upper one is always the nearer; below it only (15,7) qualifies
  return target >= PEN_UPPER_ROW ? 'upper' : 'lower';
}

const isLeaderTemplate = (tpl) => !!tpl && (tpl.kind === 'boss' || tpl.kind === 'hidden');

function previewInfo(gd, key, route, boss = false, leader = undefined) {
  const e = gd.enemy(key);
  const start = route && Array.isArray(route.start) ? route.start.slice(0, 2) : null;
  return { gate: gateOf(start, leader), start, fly: isFlyKey(gd, key), elite: !!(e && e.rank && e.rank !== 'NORMAL'), boss };
}

/**
 * The actions of a template with the round pick applied.
 * @param {object|null} [plan] 炸惊模拟 规则14 敌方惊变 的本轮计划（content/ejibian.js matchJibianPlan）：出怪量乘区
 *   countMul、同一时间进场 sameTime、小怪全换源石虫 slime
 * @returns {{ spawns: object[], actions: object[] }} actions[i] = { index, key, tplKey, slot, time, count, tplCount, window, routeIndex, valid,
 *   server } (`server` = client ShouldActionUpToServer: valid, not the leader, no random spawn group)
 */
function templateSpawns(gd, tpl, round, pick, rng = null, plan = null) {
  const scale = scaleFor(gd, round);
  const ph = placeholderMap(gd);
  const routes = Array.isArray(tpl.routes) ? tpl.routes : [];
  const leader = isLeaderTemplate(tpl);
  const spawns = [];
  const actions = [];
  // wave enemies whose count 规则8 may raise, with the time window their spawns must stay inside
  const spread = [];
  const list = Array.isArray(tpl.spawns) ? tpl.spawns : [];
  // ★ 2026-10-15 入职测试（用户：牌面写「变成 100 只」而实测数量没变）：
  //   先扫一遍【这一轮会被换成源石虫的 spawn】，把它们的原始 count 按比例折成 RUZHI_SLIME_TOTAL 只
  //   —— 最大余数法，且每组至少 1。预扫必须在这里（循环之前）：循环里 `n` 会被 clamp 到 50，单组放不下 100。
  //
  // ★ 2026-10-16 二次修正（owner：① 「100只是最终数量，我有人反馈第三回合出了120只」
  //   ② 「我希望所有的怪出完的时间都要跟原本保持一致」）—— 上一版有两个叠加的 bug：
  //   【bug A】每组的间隔是用**替换前**的 count 算的（`step = window / 原怪count`），而数量随后被折成
  //     100 ⇒ 100 只 × 那个偏大的间隔。实测 R3：源石虫排到第 **1275~1371** 秒，而该轮时限只有 150 秒
  //     ⇒ 绝大多数源石虫整轮**根本不会露面**（玩家反馈的「不少怪整轮没露面」）。现在每组都记住
  //     它**原始的结束时刻** `end`，折完之后把末只压回 `end` 之内（间隔按新数量重算）。
  //   【bug B】折算发生在规则8（`mul`）之前，折出来的 100 只又被 ×1.2 变成 113~120
  //     （玩家反馈的「第三回合出了120只」）。现在源石虫组不进 `spread`，规则8 / 量变 / 质变
  //     都不再动它 —— 总数就是牌面写的那个数。
  //   另外「最终 100」是**整轮总数**：飞行单位换不了（换完与路线对不上），所以它们不参与替换，
  //   折算的目标是 `100 − 本轮飞行单位数`，使整轮合计正好 100。
  const slimeCounts = new Map();
  const slimeEligibleN = [];
  const slimeEnd = new Map();
  /**
   * 整轮"改动前的末只时刻"上界，供入职测试算间隔用；主循环结束后由各组的 `_baseEnd` 求出，
   * 所以这里是 `let`（见下面 `slimeRoundEndCap = Math.max(...spawns.map(s => s._baseEnd))`）。
   */
  let slimeRoundEndCap = 0;
  if (plan && plan.slime && gd.enemy(SLIME_KEY)) {
    const elig = [];
    let flyN = 0;
    let groundN = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) continue;
      const k = s.key ?? s.enemyKey;
      if (typeof k !== 'string' || k === ACLOON) continue;
      if (s.tag === 'boss' || s.tag === 'part' || s.unharmful) continue;
      if (!gd.enemy(k)) continue;
      const n = Math.max(1, Math.min(50, Number.isInteger(s.count) ? s.count : 1));
      const time = Math.max(0, Number(s.time) || 0);
      const interval = Math.max(0, Number(s.interval) || 0);
      const end = time + Math.max(0, n - 1) * interval;   // ★ 这一组原本出完的时刻（要守住的上界）
      if (isFlyKey(gd, k)) { flyN += n; continue; }
      elig.push({ i, n, time, end });
      groundN += n;
    }
    const want = Math.max(0, RUZHI_SLIME_TOTAL - flyN);    // 含飞行在内合计 100
    // ★ 折算必须**永远**发生（owner 2026-10-16：前期回合 elig 少、后期回合 elig 可达 28 组）。
    //   上一版的条件 `elig.length <= target` 在后期回合为假（28 > 100 看似成立，但 R2/R3 这种
    //   "地面只有 2~3 组、飞行占掉十几只"的回合里 target 会被压到比 elig 还小）—— 一旦为假就
    //   **整轮不折**，源石虫数量原样保留又吃 ×1.2，这正是"第三回合出了 120 只"的来源。
    //   现在：先按原始份数摊到各组（每组至少 1），再把每组夹到单组上限 50；超出的份数依次往
    //   "还有余量"的组上补、不够则从余量最多的组上退 —— 合计恒等于 want。
    const target = want;
    if (elig.length && target > 0) {
      const SLIME_GROUP_MAX = 50;                          // 与 _queueSpawn 的单组上限一致
      const raw = elig.map((e) => (e.n * target) / groundN);
      const got = raw.map((v) => Math.max(1, Math.min(SLIME_GROUP_MAX, Math.floor(v))));
      const fill = () => {                                 // 把差额补到/退自还有余量的组
        let rest = target - got.reduce((a, b) => a + b, 0);
        let guard = 0;
        while (rest > 0 && guard++ < 10000) {
          let best = -1;
          for (let k = 0; k < got.length; k++) if (got[k] < SLIME_GROUP_MAX && (best < 0 || got[k] > got[best])) best = k;
          if (best < 0) break;
          got[best] += 1; rest -= 1;
        }
        guard = 0;
        while (rest < 0 && guard++ < 10000) {
          let best = -1;
          for (let k = 0; k < got.length; k++) if (got[k] > 1 && (best < 0 || got[k] > got[best])) best = k;
          if (best < 0) break;
          got[best] -= 1; rest += 1;
        }
      };
      // 先按最大余数法分配，再修正合计 = target。★ 修正时**只允许往还有余量的组上加**：
      //   上一版在"余量落在已封顶的组"时会走"从最大组上退"，把 89 退成了 59（实测 R3）。
      //   由于 target ≤ elig.length × 50 恒成立，逐次补到最大余量组一定能配平。
      const capOf = (k) => Math.min(SLIME_GROUP_MAX, Math.max(1, Math.ceil(raw[k])));
      const base = raw.map((v, k) => Math.max(1, Math.min(capOf(k), Math.floor(v))));
      let rest = target - base.reduce((a, b) => a + b, 0);
      const order = raw.map((v, k) => ({ k, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
      if (rest > 0) {
        for (const o of order) { if (rest <= 0) break; if (base[o.k] >= capOf(o.k)) continue; base[o.k] += 1; rest -= 1; }
        let guard = 0;
        while (rest > 0 && guard++ < 100000) {
          let best = -1;
          for (let k = 0; k < base.length; k++) if (base[k] < capOf(k) && (best < 0 || base[k] > base[best])) best = k;
          if (best < 0) break;
          base[best] += 1; rest -= 1;
        }
      }
      for (let k = 0; k < got.length; k++) got[k] = base[k];
      fill();
      elig.forEach((e, k) => {
        slimeCounts.set(e.i, got[k]);
        slimeEnd.set(e.i, e.end);          // ★ 这一组原本出完的时刻：折完之后末只要压回它之内
      });
    }
  }
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) continue;
    const key0 = s.key ?? s.enemyKey;
    if (typeof key0 !== 'string' || key0 === ACLOON) continue;
    const tag = s.tag ?? null;
    const isBoss = tag === 'boss';
    const isPart = tag === 'part';
    const n = Math.max(1, Math.min(50, Number.isInteger(s.count) ? s.count : 1));
    const interval = Math.max(0, Number(s.interval) || 0);
    const time = Math.max(0, Number(s.time) || 0);
    const routeIndex = Number.isInteger(s.routeIndex) ? s.routeIndex : 0;
    const window = n * interval;
    let key = key0;
    let count = n;
    let step = interval;
    let slimeStats = null;
    let slimeFixed = false;   // ★ 这组已被"入职测试"折成源石虫：规则8 / 量变 / 质变都不许再动它
    const p = !isBoss && !isPart ? ph[key0] : null;
    if (p && pick) {
      const newKey = p.cls === 'special' ? pick.key : p.cls === 'elite' ? pick.elite : pick.normal;
      if (typeof newKey === 'string' && gd.enemy(newKey)) {
        if (isFlyKey(gd, newKey) !== !!p.fly) {
          // the other movement class: not spawned, not sent, not previewed (isValid = false)
          actions.push({ index: i, key: null, tplKey: key0, slot: p.slot ?? s.slot ?? null, time, count: 0, tplCount: n, window, routeIndex, valid: false, server: false });
          continue;
        }
        count = replacedCount(gd, key0, n, newKey);
        step = Math.max(window / count, MIN_ACTION_INTERVAL_RATIO * window);
        key = newKey;
      }
    }
    // 炸惊模拟 规则14 入职测试（ejibian_ruzhiceshi）：这一轮的小怪全变源石虫。领袖 / 部位 / 不计数单位（器物一类
    // countInTotal = false）/ 飞行的都不动 —— 飞行单位换完跟路线对不上（和占位符「类别不符就不出」同一个道理）。
    //
    // ★ 2026-10-15 修正（用户：「有人反馈生成数不是100 只是全部换成了源石虫，然后数值也很垃圾」）：
    //   牌面是「使所有小怪变成 100 只加强版源石虫」，隐藏说明是「源石虫的数值按变之前的怪来」。
    //   原来只换了 key —— 数量保持原样、数值用的是源石虫自己的（550 HP / 130 ATK），两条都没兑现。现在：
    //     ① 数量 = slimeCounts（预扫折出来的分配表，全轮合计恰好 RUZHI_SLIME_TOTAL 只）；
    //     ② 数值 = 被替换那只怪的【基础值】写进 spec.stats，`mods`（roundMods(scale)）照常在其上相乘
    //        ⇒ 最终 = 原怪膨胀后的数值（`def` / `res` 也一并继承，不再吃源石虫的 0）。
    //   顺序很重要：`key` 先换，`gd.enemy(key)` 才是源石虫；原怪的两条读数要在换之前取。
    if (plan && plan.slime && !isBoss && !isPart && !s.unharmful && gd.enemy(SLIME_KEY) && !isFlyKey(gd, key)) {
      const from = gd.enemy(key);
      const newCount = slimeCounts.get(i);
      slimeFixed = true;                                  // ★ 这一组是"折好的源石虫"：不再吃规则8 / 量变 / 质变
      if (Number.isInteger(newCount) && newCount > 0) {
        count = newCount;
        // ★ 2026-10-16 修正（owner：「所有的怪出完的时间都要跟原本保持一致」）：
        //   间隔必须用**折之后的**数量算，并且把末只压回"这一组原本出完的时刻"之内 ——
        //   原式 `window / count` 里的 window 是"原怪 count × 原间隔"，拿它除以 100 会让 100 只排到
        //   时限之外（实测 R3 排到 1275~1371 秒，时限只有 150 秒）。
        //   这里不再套 MIN_ACTION_INTERVAL_RATIO 下限：数量是牌面写死的 100，为了"出完时刻不变"，
        //   该挤密就得挤密（下限只会把末只重新推到时限之外）。
        const end = slimeEnd.get(i);
        const cap = Number.isFinite(end) ? end : slimeRoundEndCap;
        const span = Math.max(0, cap - time);
        step = count > 1 ? span / (count - 1) : 0;
      }
      if (from) {
        // ★ 注意：`gd.enemy()` 返回的是 data/enemies.json 的【原始记录】（gamedata.js `enemy(key)` =
        //   `raw.enemies[key]`），数值挂在 `e.stats` 下；而 spawns.js 拿到的是 `getEnemy()` 走
        //   `normalizeEnemy()` 之后的扁平 EnemyDef（`def.maxHp`）。这里两种形状都认，取到同一组字段。
        const fs = (from.stats && typeof from.stats === 'object') ? from.stats : from;
        slimeStats = {
          maxHp: fs.maxHp ?? fs.hp, atk: fs.atk, def: fs.def, res: fs.res ?? fs.magicResistance,
          moveSpeed: fs.moveSpeed ?? fs.spd, bat: fs.bat ?? fs.baseAttackTime, aspd: fs.aspd ?? fs.attackSpeed,
          rangeRadius: fs.rangeRadius ?? fs.range, massLevel: fs.massLevel ?? fs.mass,
          lpr: fs.lpr ?? from.lpr, blockCnt: fs.blockCnt ?? from.blockCnt,
        };
      }
      key = SLIME_KEY;
    }
    if (!gd.enemy(key)) continue;
    const slot = s.slot || classOf(gd, key);
    const spec = {
      time,
      enemyKey: key,
      routeIndex,
      count,
      interval: count > 1 ? step : 0,
      // the round multipliers are ENEMY effects on every enemy but 炎佑 (aceffect_enemy_1–5 `enemy_attribute_mul`,
      // enemy_exclude = enemy_9012_acloon): leader parts take them all; the leader takes ATK / speed but not HP — its HP
      // is the server pool, "领袖单位于服务器的生命值加成不受上述加成影响" (PRTS 下半). 炸惊模拟 规则3 gives the leader its own
      // ATK multiplier (bossAtkMul, ×2 against the mobs' ×6) and 规则2 adds the DEF axis — the leader's own DEF can be
      // raised apart from the mobs with `bossDefMul`（用户 2026-10-11：小怪 DEF ×3、领袖 DEF 9000 = ×9）。`supplyHpMul`
      // (roundMods) rides
      // along for the 器物 hit-count units, which 补给线 / 补给线II leave out (archetypes.js `times`; also a 频次 enemy's
      // death spawn) — 炸惊模拟 encodes its "the +500% HP does not touch a 频次 unit's hit count" in the same key.
      mods: isBoss
        ? { atkMul: scale.bossAtkMul != null ? scale.bossAtkMul : scale.atkMul, speedMul: scale.speedMul, ...(scale.bossDefMul != null || scale.defMul != null ? { defMul: scale.bossDefMul != null ? scale.bossDefMul : scale.defMul } : {}), slot }
        : { ...roundMods(scale), slot },
      actionIndex: i,
      preview: previewInfo(gd, key, routes[routeIndex], isBoss, leader),
    };
    // 入职测试：逐 spawn 的数值覆盖（见上面那段注释）
    if (slimeStats && key === SLIME_KEY) spec.stats = slimeStats;
    if (slimeFixed) spec.slimeFixed = true;   // 标记：规则8 / 量变 / 质变 / 复制 都不再动这组
    if (tag) spec.tag = tag;
    if (s.unharmful || isPart) spec.countInTotal = false;
    spawns.push(spec);
    // ★ 2026-10-16：把这一组"数量乘区生效**之前**"的出完时刻冻结下来（`_baseEnd`）。
    //   占位符替换已经改过 count / step，所以必须在循环里逐组取，不能回头看模板的原始数据
    //   （实测：拿模板原始数据算会把基线算小 6 倍，兜底压不住）。
    spec._baseEnd = time + Math.max(0, count - 1) * Math.max(0, step);
    // 规则8 only ever grows the wave's own monsters, so the leader and its parts stay out (their count is the boss's own)
    // ★ 2026-10-16：被「入职测试」折成源石虫的组也不进 `spread` —— 它的数量就是牌面写的那个数，
    //   再吃 ×1.2 / ×1.4 就会变成"120 只"（owner 收到的反馈）。
    //   飞行单位同样排除：它们换不了源石虫、但若吃 ×1.2，整轮总数就不再是 100
    //   （实测 R2：飞行 9 → 10，总数 91+10 = 101）。折算的目标已经按"飞行原数"扣过了。
    if (!isBoss && !isPart && !slimeFixed && !(plan && plan.slime && isFlyKey(gd, key))) spread.push({ spec, window: Math.max(count * (count > 1 ? step : 0), step) });
    // client ShouldActionUpToServer: valid, not the leader, no randomSpawnGroupKey — only those units are in the list a
    // bounty is inserted into (the others spawn locally on their own timing)
    actions.push({ index: i, key, tplKey: key0, slot: s.slot ?? null, time, count, tplCount: n, window, routeIndex, valid: true, server: !isBoss && !s.group });
  }
  // ★ 2026-10-16：整轮"数量乘区生效之前"的末只时刻 —— 兜底扫描要把乘区改动压回这个值之内。
  const baselineEnd = spawns.reduce((a, s) => Math.max(a, Number(s._baseEnd) || 0), 0);
  slimeRoundEndCap = baselineEnd;
  // 炸惊模拟 规则8: the wave's total enemy count ×1.2, floored; the extra enemies are drawn at random from the monsters
  // this wave already sends — a random group simply gets a bigger count, its spawns re-spread over the same window (so
  // the wave still ends on time and no new route / preview entry has to be invented).
  // 规则14 量变→质变 / 质变→量变 ride on the same mechanism: ×1.4 / ×0.8 on top of 规则8's ×1.2 (1.68 / 0.96), and a
  // shrinking card takes enemies away the same way — one random group loses one unit, never below one per group (the
  // card can empty neither the wave nor a single action; the 数值 half of both cards is 战场侧, see ejibian.js).
  // ★ 2026-10-15（用户）：多了本轮的 `scale.countMul`（config enemyScale[r].countMul）——
  //   模式级 enemyCountMul 不分回合，要做「第 4 回合起出怪量翻倍」只能靠它。
  //
  // ★ 2026-10-15 二次修正（用户：「出怪数量翻倍 你应该做的是把每个本应该出现的怪复制一波。
  //   我刚刚第一轮出了两只源石虫一只鸟明显不符合我的要求」）：
  //   原来把 `countMul` 直接乘进总数、随机摊到各组 —— 那是「同一批怪变多」（3 只猎狗 → 6 只猎狗，
  //   一起冲过来），玩家要的是「每个 spawn 各复制一份」（3 只 → 先 3 只、过一会儿再来 3 只）。
  //   现在：`countMul` 的【整数部分】= 复制份数（整波原样顺延，time 平移一个波次跨度），
  //   【小数部分】仍留给下面的数量微调（1.2 ⇒ 不复制，只 +20%）。
  // ★ 2026-10-24（owner 敌方惊变「丧尸围城」）：plan.countMul（出怪量 ×2）也要走【整数部分 = 复制份数】这条，
  //   即"每个 spawn 复制一份、时间线不变"，而不是把总数乘进随机几组（那是"同一批怪变多"）。
  const planMul = plan && plan.countMul ? plan.countMul : 1;
  const cmRaw = (scale && scale.countMul != null ? scale.countMul : 1) * planMul;
  const cmReps = Math.max(1, Math.floor(cmRaw));       // 复制份数（含原本那一份）
  const cmFrac = Math.max(0, cmRaw - cmReps + 1);      // 留给数量微调的因子（1.2 → 1.2；2.0 → 1.0）
  const mul = (typeof gd.enemyCountMul === 'number' ? gd.enemyCountMul : 1) * cmFrac;
  // ★ 复制一波，但【时间线与原来完全一致】。（用户 2026-10-15：「我想的出怪量翻倍但是要和原有的
  //   出怪所需时间一致」—— 上一版让第二波从第一波【结束的时刻】开始，整波时长直接翻倍，那是错的。）
  //   现在复制品**不平移 time / interval**：原来 t=0/1/2 各出 1 只，现在 t=0/1/2 各出 2 只，共 6 只，
  //   而这一波的起止时刻一点没变 —— 是「每个时刻成对出现」，不是「拖出一条更长的波」。
  //   只复制模式自己的小怪（leader / part 的 time 由 boss 自己的时间线定）。
  //   复制品不进 `spread`，所以下面的规则8 / 惊变卡数量改动只作用在原件上 —— 两件事互不干扰。
  if (cmReps > 1 && spawns.length) {
    // ★ 2026-10-16：入职测试生效时，**飞行单位也不复制** —— 折算目标已经按"飞行原数"扣过，
    //   飞行再翻倍整轮总数就不再是 100（实测 R4 起：13 只 → 26 只，总数 113）。
    const duplicable = (s) => s.tag !== 'boss' && s.tag !== 'part' && !s.slimeFixed
      && !(plan && plan.slime && isFlyKey(gd, s.enemyKey));
    const baseSpawns = spawns.filter(duplicable);
    // ★ 2026-10-16：actions 也要同步排除"折好的源石虫"那一组 —— 否则 action 被复制，而 spawn 没有，
    //   客户端预览 / 悬赏插入会跟实际出怪错位（并且 R3 的 countMul=2 会把 89 只再复制成 178 只）。
    //   `spread` 恰好就是"参与数量改动的那些组"，用它的 actionIndex 反查最稳。
    //   若入职测试生效，spread 里没有飞行组，飞行 action 也就不会被复制（与上面的 duplicable 一致）。
    const dupIndex = new Set(spread.map((e) => e.spec && e.spec.actionIndex));
    const baseActions = actions.filter((a) => a && a.key && a.index != null && dupIndex.has(a.index));
    for (let rep = 1; rep < cmReps; rep++) {
      for (const s of baseSpawns) spawns.push({ ...s });
      for (const a of baseActions) {
        if (!a || a.count === 0) continue;
        actions.push({ ...a });
      }
    }
  }
  if (mul !== 1 && spread.length && typeof rng === 'function') {
    let total = 0;
    for (const e of spread) total += e.spec.count;
    // floor(total × mul) − total, NOT floor(total × (mul − 1)): 1.2 − 1 = 0.19999999999999996 in binary floating point,
    // so a 10-enemy wave would gain floor(1.9999999999999996) = 1 instead of 2 (10 × 1.2 = 12.000000000000002 → 12).
    const target = Math.max(spread.length, Math.floor(total * mul));
    for (let n = target - total; n > 0; n--) spread[Math.floor(rng() * spread.length)].spec.count += 1;
    for (let n = total - target; n > 0; n--) {
      const cand = spread.filter((e) => e.spec.count > 1);
      if (!cand.length) break;
      cand[Math.floor(rng() * cand.length)].spec.count -= 1;
    }
    for (const e of spread) {
      const c = e.spec.count;
      e.spec.interval = c > 1 ? Math.max(e.window / c, MIN_ACTION_INTERVAL_RATIO * e.window) : 0;
    }
  }
  // ★★ 2026-10-16 通用兜底（owner：「这个出怪时机其他正常的惊变模拟波次也要对齐」）：
  //   不限于入职测试 —— **任何**一波怪的【最后一只】都不得晚于这张出怪表原本的最后一只时刻
  //   `baselineEnd`（= 模板数据的原时间轴）。规则8 的 ×1.2 / 量变→质变 ×1.4 / 质变→量变 ×0.8 /
  //   复制波次 都只改数量，改完之后统一把时间轴压回原版：数量一个不少，只是每组排得更密。
  //   （原版时间轴本身还留了"最后一只走到蓝门"的余量，所以"出完时刻不变"= 难度不变而不再有怪出不完。）
  if (baselineEnd > 0) {
    let maxEnd = 0;
    for (const s of spawns) {
      const c = Math.max(1, Number(s.count) || 1);
      const e = Number(s.time) + (c - 1) * Math.max(0, Number(s.interval) || 0);
      if (e > maxEnd) maxEnd = e;
    }
    if (maxEnd > baselineEnd + 1e-9) {
      for (const s of spawns) {
        const c = Math.max(1, Number(s.count) || 1);
        if (c <= 1) { s.interval = 0; continue; }
        const span = Math.max(0, baselineEnd - Number(s.time));
        s.interval = span / (c - 1);
      }
    }
  }
  // 规则14 强行顶吗（ejibian_qiangxingdingma）：所有怪同一时间进场
  if (plan && plan.sameTime) collapseToSameTime(spawns, actions);
  // ★ 2026-10-19 入职测试最终兜底（owner：「还是不会固定生成100只」）：
  //   前面所有折算都做完了，但改写层（fitSpawnTimeLimit / 单组上限 / 飞行排除）仍可能让合计≠100。
  //   这里按**实际生成的源石虫**再数一次，把差额补到/退自最大的那组（单组上限 50），
  //   并且只在真的不等于 100 时动手 —— 正常情况下这是一次空转。
  if (plan && plan.slime && gd.enemy(SLIME_KEY)) {
    const slimeSpecs = spawns.filter((s) => s && s.slimeFixed === true);
    if (slimeSpecs.length) {
      const others = spawns.reduce((acc, s) => acc + (s && s.slimeFixed !== true && s.countInTotal !== false ? (Number(s.count) || 0) : 0), 0);
      const want = Math.max(0, RUZHI_SLIME_TOTAL - others);
      let have = slimeSpecs.reduce((acc, s) => acc + (Number(s.count) || 0), 0);
      let guard = 0;
      while (have < want && guard++ < 100000) {
        let best = null;
        for (const s of slimeSpecs) if ((Number(s.count) || 0) < 50 && (!best || (Number(s.count) || 0) > (Number(best.count) || 0))) best = s;
        if (!best) break;
        best.count = (Number(best.count) || 0) + 1; have += 1;
      }
      guard = 0;
      while (have > want && guard++ < 100000) {
        let best = null;
        for (const s of slimeSpecs) if ((Number(s.count) || 0) > 1 && (!best || (Number(s.count) || 0) > (Number(best.count) || 0))) best = s;
        if (!best) break;
        best.count = (Number(best.count) || 0) - 1; have -= 1;
      }
      // 数量变了 → 间隔按「这一组原本的出完时刻」重排，保证不会被推出时限
      for (const s of slimeSpecs) {
        const c = Math.max(1, Number(s.count) || 1);
        const end = Number.isFinite(s._slimeEnd) ? s._slimeEnd : slimeRoundEndCap;
        const span = Math.max(0, end - (Number(s.time) || 0));
        s.interval = c > 1 ? span / (c - 1) : 0;
      }
    }
  }
  return { spawns, actions };
}

/**
 * 强行顶吗：把整轮的出怪压到同一时刻 —— 每个 spawn 的 time 收到最早的一个、组内 interval 归零，`actions` 同步改
 * （悬赏插入 bountyPlan 与客户端预览都读 actions，不同步就会跟实际出怪错位）。
 */
function collapseToSameTime(spawns, actions) {
  let t0 = Infinity;
  for (const s of spawns) {
    const t = Number(s.time);
    if (Number.isFinite(t)) t0 = Math.min(t0, t);
  }
  if (!Number.isFinite(t0)) return;
  for (const s of spawns) { s.time = t0; s.interval = 0; }
  for (const a of actions) { a.time = t0; a.window = 0; }
}

function entriesView(gd, pick) {
  if (!pick) return { ground: null, fly: null };
  const e = gd.factions.entries && gd.factions.entries[pick.key];
  const view = e ? { ...e, pick } : { key: pick.key, type: pick.type, firstHalf: pick.firstHalf, pick };
  return pick.fly ? { ground: null, fly: view } : { ground: view, fly: null };
}

/**
 * Shared composition of a normal round.
 * @param {string[]|object} factions setupMatchWaves().factions (carries the schedule), the setup object, or a plain
 *   factions array (the round's type is then drawn with `rng`)
 * @param {{ plan?: object|null, jibian?: Set<string>|string[]|null }} [opts] 炸惊模拟 规则14 敌方惊变：Match 侧的出怪
 *   改动。`plan` = Match 在 startRound 里算好的一次计划（boss 轮两个半场必须共用同一个）；只给 `jibian`（卡 id）时
 *   这里自己算一份，方便单机工具 / 测试
 * @returns {{ templateId: string|null, spawns: object[], routes: object[], extraRoutes: object[], timeLimit: number,
 *   overrides: object, pick: object|null, entries: { ground: object|null, fly: object|null }, actions: object[] }}
 */
export function buildNormalWave(gd, rng, factions, round, opts = {}) {
  const rc = gd.roundCfg(round);
  const templateId = rc && typeof rc.template === 'string' ? rc.template : null;
  const tpl = templateId ? gd.wave(templateId) : null;
  // 惊变「天堂制造」：战斗阶段 −40s（游戏秒 80）。这里算出来的时限会写进 Battle 与客户端倒计时。
  const timeLimit = heavenTimeLimit({ flags: opts.flags || { enemyJibian: opts.jibian } }, gd.combatTimeLimit(round));
  if (!tpl) return { templateId, spawns: [], routes: [], extraRoutes: [], timeLimit, overrides: {}, pick: null, entries: { ground: null, fly: null }, actions: [] };
  const plan = opts.plan || (opts.jibian ? matchJibianPlan(rng, round, opts.jibian) : null);
  const pick = roundPick(gd, rng, factions, round);
  const { spawns, actions } = templateSpawns(gd, tpl, round, pick, rng, plan);
  fitSpawnTimeLimit(spawns, timeLimit, gd.combatTimeLimit(round));
  return {
    templateId,
    spawns,
    routes: Array.isArray(tpl.routes) ? tpl.routes : [],
    extraRoutes: Array.isArray(tpl.extraRoutes) ? tpl.extraRoutes : [],
    timeLimit,
    overrides: tpl.overrides && typeof tpl.overrides === 'object' ? tpl.overrides : {},
    pick,
    entries: entriesView(gd, pick),
    actions,
  };
}

/**
 * 整轮出怪压进时限（2026-10-16）：时限被砍短时（惊变「天堂制造」−40s），整轮**按比例快进** ——
 * `t' = t × ratio`、`interval' = interval × ratio`，`ratio = 新时限 / 原时限`。
 *
 * 为什么不是"只在末只越界时把尾巴压平"：那样新时限根本没用上 —— 实测 R1 末只 15s、R12 末只 60s，
 * 砍到 190 之後剩下一百多秒是空的，玩家感觉不到这张卡。按比例缩才是"同一场战斗被快进"：
 * 相对间距不变，只是整条时间轴被压到新时限之内（怪更早到、压力更高）。
 *
 * 上限 1（绝不拉长）；下限 0.5：压缩到一半已经很极端，再小会把回合初的怪挤成一坨，
 * 剩下的时间不足（那时"有些怪还没出场、时间就到了"本身就是这张卡的效果）。
 * @param {object[]} spawns 会被原地改写
 * @param {number} timeLimit 生效后的时限（游戏秒）
 * @param {number} [baseLimit] 未削过的时限（游戏秒）；不给则用 `spawns` 自己的末只
 */
function fitSpawnTimeLimit(spawns, timeLimit, baseLimit = 0) {
  const lim = Number(timeLimit);
  if (!Array.isArray(spawns) || !spawns.length || !Number.isFinite(lim) || lim <= 0) return;
  const base = Number(baseLimit) > 0 ? Number(baseLimit) : 0;
  const ref = base > 0 ? base : (() => {
    let end = 0;
    for (const s of spawns) {
      const c = Math.max(1, Number(s.count) || 1);
      end = Math.max(end, (Number(s.time) || 0) + (c - 1) * Math.max(0, Number(s.interval) || 0));
    }
    return end;
  })();
  if (!(ref > 0)) return;
  const ratio = Math.max(0.5, Math.min(1, lim / ref));
  if (ratio >= 1) return;                       // 时限没变短：一个字节都不动
  for (const s of spawns) {
    s.time = Math.max(0, Number(s.time) || 0) * ratio;
    if ((Number(s.count) || 1) > 1) s.interval = Math.max(0, Number(s.interval) || 0) * ratio;
  }
}

/**
 * Boss / hidden round template for one boss field; escorts follow the pick of the round's own slot.
 * @param {{ bossId: string, solo: boolean, plan?: object|null, jibian?: Set<string>|string[]|null }} opts solo → `_s`
 *   template (lone player or solo mode); `plan` / `jibian` = 炸惊模拟 规则14 的 Match 侧出怪改动（两个半场必须传同一个
 *   `plan`，见 buildNormalWave）
 */
export function buildBossWave(gd, rng, factions, round, { bossId, solo, plan = null, jibian = null }) {
  const rc = gd.roundCfg(round);
  const map = rc && rc.bossTemplates && typeof rc.bossTemplates === 'object' ? rc.bossTemplates : {};
  let templateId = typeof map[bossId] === 'string' ? map[bossId] : null;
  if (!templateId) {
    const first = Object.values(map).find((v) => typeof v === 'string');
    templateId = first || null;
  }
  if (templateId && solo && !/_s$/.test(templateId) && gd.wave(`${templateId}_s`)) templateId = `${templateId}_s`;
  if (templateId && !solo && /_s$/.test(templateId) && gd.wave(templateId.replace(/_s$/, ''))) templateId = templateId.replace(/_s$/, '');
  const tpl = templateId ? gd.wave(templateId) : null;
  if (!tpl) return { templateId, spawns: [], routes: [], extraRoutes: [], timeLimit: Infinity, overrides: {}, pick: null, entries: { ground: null, fly: null }, actions: [] };
  const jp = plan || (jibian ? matchJibianPlan(rng, round, jibian) : null);
  const pick = roundPick(gd, rng, factions, round);
  const { spawns, actions } = templateSpawns(gd, tpl, round, pick, rng, jp);
  // ★ 2026-10-23（owner）敌方惊变「全军出击」：boss 战里生成的小怪全部换成随机悬赏怪（领袖保留）。
  if (jibian && cardsOf({ flags: { enemyJibian: jibian } }).has('ejibian_quanjunchuji')) {
    const keys = bountyEnemyKeys(gd);
    if (keys.length) {
      const scale = scaleFor(gd, round);
      const routes = Array.isArray(tpl.routes) ? tpl.routes : [];
      for (const sp of spawns) {
        const e = gd.enemy(sp.enemyKey);
        const keep = sp.tag === 'boss' || !!(sp.preview && sp.preview.boss) || sp.enemyKey === bossId
          || (e && String(e.rank || '').toUpperCase() === 'BOSS');
        if (keep) continue;
        const key = keys[Math.max(0, Math.min(keys.length - 1, Math.floor(rng() * keys.length)))];
        sp.enemyKey = key;
        sp.mods = { ...(sp.mods || {}), ...roundMods(scale), slot: classOf(gd, key) };
        sp.preview = previewInfo(gd, key, routes[sp.routeIndex] || null, false);
        sp.tag = 'bounty';
      }
    }
  }
  // ★ BOSS / 隐秘核心轮的「天堂制造」：boss 轮的时限本来是 Infinity（打不完不结束，只有 120s 倒计时），
  //   所以按**出怪表自己的时间轴**减 40s（游戏秒 80）—— 不减的话杀到第 13 回合才抽到这张卡会"毫无感觉"。
  //   压缩同样按比例，出怪一个不少、只是整体提前。
  let bossLimit = Infinity;
  // 卡 id 从 `jibian` 取（Set / 数组 / 单张字符串都行；`plan` 只是"本轮改写计划"，不含卡 id）
  if (jibian && cardsOf({ flags: { enemyJibian: jibian } }).has('ejibian_tiantangzhizao')) {
    let end = 0;
    for (const s of spawns) {
      const c = Math.max(1, Number(s.count) || 1);
      end = Math.max(end, (Number(s.time) || 0) + (c - 1) * Math.max(0, Number(s.interval) || 0));
    }
    if (end > 0) bossLimit = Math.max(HEAVEN_MIN_LIMIT_GAME_S, end - HEAVEN_CUT_GAME_S);
  }
  if (Number.isFinite(bossLimit)) fitSpawnTimeLimit(spawns, bossLimit);
  return {
    templateId,
    spawns,
    routes: Array.isArray(tpl.routes) ? tpl.routes : [],
    extraRoutes: Array.isArray(tpl.extraRoutes) ? tpl.extraRoutes : [],
    timeLimit: Infinity,
    overrides: tpl.overrides && typeof tpl.overrides === 'object' ? tpl.overrides : {},
    pick,
    entries: entriesView(gd, pick),
    actions,
  };
}

/** Boss-field column that splits the left (L) and the right (R) player's half (the goals are at cols 2–3 / 17). */
const BOSS_MID_COL = 10;

/**
 * Route index of the first template route with the requested motion (fallback 0). `side` ('L' | 'R') prefers a route
 * that ends on that player's half of a boss field (pair templates route to both goals).
 */
export function routeByMotion(routes, fly, side = null) {
  const ok = (r) => r && (fly ? r.motion === 'FLY' : r.motion !== 'FLY' && r.motion !== 'E_NUM');
  if (side === 'L' || side === 'R') {
    const j = routes.findIndex((r) => ok(r) && Array.isArray(r.end) && (side === 'R' ? r.end[1] > BOSS_MID_COL : r.end[1] < BOSS_MID_COL));
    if (j >= 0) return j;
  }
  const i = routes.findIndex(ok);
  return i >= 0 ? i : 0;
}

/**
 * The template action an added enemy joins (client `_GetSpEnemyActionData`): the first SPAWN action of the round's
 * ORIGINAL template whose key is the normal placeholder of the enemy's movement class (`templateEnemyNormal` /
 * `…NormalFly`; tokens `templateEnemyToken` / `…TokenFly`), else the first SPAWN action.
 */
function hostAction(gd, wave, { fly, token = false }) {
  const tpl = wave && wave.templateId ? gd.wave(wave.templateId) : null;
  const list = tpl && Array.isArray(tpl.spawns) ? tpl.spawns : [];
  const ts = gd.factions.templateSlots || {};
  const want = token ? ts[fly ? 'TF' : 'T'] : ts[fly ? 'NF' : 'N'];
  let first = -1;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) continue;
    if (first < 0) first = i;
    if ((s.key ?? s.enemyKey) === want) return { index: i, s };
  }
  return first >= 0 ? { index: first, s: list[first] } : null;
}

/**
 * Bounty spawns for one player's battle (悬赏 / 战术特训 / 教鞭 / “神秘顾客”): kill bounties pay the killer (Battle
 * bounty), perfect bounties are paid by the match at settlement. No bounty-specific stat change (the solo 70 % is the
 * global base already in enemyScale). Client timing (`GenerateSelfBattleEnemyData` → `_GetSpEnemyActionData` →
 * `_InsertSpActionToNormal` → `_CalculateActionPredelay`, decoded): every bounty unit joins the ORIGINAL template's
 * first `lrsldr` (walker) / `yokai` (flyer) action (else action 0); the n bounty units of a host action are INSERTED
 * among its own n' units — unit i at index floor((i+1)·len/(n+1)), len = the list length so far — (the bounty list
 * alone when the host spawns nothing, e.g. a walker bounty in a FLY round), then the whole list is spread over the
 * action window: unit j at preDelay + j·max(W/total, 0.05·W). Returned here: the bounty specs only (a bounty's
 * consecutive units share a spec); the host action's own units are NOT re-timed — `withBounties` gives the exact
 * combined list. Bounties of several battles (`rounds` > 1: "接下来两场作战", and the multi-round cards, which last
 * choices.js MULTI_ROUND_BOUNTY_BATTLES) spawn in every battle of the player while they last — the Final Assault and the
 * Hidden Core included (`side`: the player's half of the boss field, see routeByMotion).
 * @param {Array<{ id: string, card: object }>} bounties
 */
export function bountySpawns(gd, round, wave, bounties, playerId, { solo = false, side = null } = {}) { // eslint-disable-line no-unused-vars
  return bountyPlan(gd, round, wave, bounties, playerId, side).specs;
}

/** Runs of consecutive equal markers: [{ v, start, len }]. */
function runsOf(list) {
  const out = [];
  for (let j = 0; j < list.length; j++) {
    const last = out[out.length - 1];
    if (last && last.v === list[j]) last.len++;
    else out.push({ v: list[j], start: j, len: 1 });
  }
  return out;
}

function bountyPlan(gd, round, wave, bounties, playerId, side) {
  const scale = scaleFor(gd, round);
  const routes = (wave && wave.routes) || [];
  const acts = Array.isArray(wave && wave.actions) ? wave.actions : [];
  const leader = isLeaderTemplate(wave && wave.templateId ? gd.wave(wave.templateId) : null);
  const groups = new Map(); // host action index → { host, items: [{ b, c, fly, count }] }
  for (const b of bounties || []) {
    const c = b && b.card ? b.card : {};
    if (!gd.enemy(c.enemyKey)) continue;
    const fly = isFlyKey(gd, c.enemyKey);
    const host = hostAction(gd, wave, { fly });
    const key = host ? host.index : -1;
    if (!groups.has(key)) groups.set(key, { host, items: [] });
    groups.get(key).items.push({ b, c, fly, count: Math.max(1, Math.min(20, Number.isInteger(c.count) ? c.count : 1)) });
  }
  const specs = [];
  const retime = new Map(); // host action index → { time, step, ownRuns: [{ start, len }] }
  const OWN = 0;
  for (const { host, items } of groups.values()) {
    const hs = host ? host.s : null;
    const time = hs ? Math.max(0, Number(hs.time) || 0) : 4;
    const window = hs ? Math.max(1, Number.isInteger(hs.count) ? hs.count : 1) * Math.max(0, Number(hs.interval) || 0) : 0;
    const act = host ? acts.find((a) => a.index === host.index) : null;
    // the host's own units: only a server-sent action has any (a leader / random-group / invalid host spawns the
    // bounty list alone over its window — client _InsertSpActionToNormal finds no normal list for it)
    const own = act && act.valid && act.server !== false ? act.count : 0;
    const sp = [];
    for (const it of items) for (let k = 0; k < it.count; k++) sp.push(it);
    // _InsertSpActionToNormal: insert the bounty units among the action's own units (list.Insert(FloorToInt(...)))
    let list;
    if (own > 0) {
      list = new Array(own).fill(OWN);
      for (let i = 0; i < sp.length; i++) list.splice(Math.floor(((i + 1) * list.length) / (sp.length + 1)), 0, sp[i]);
    } else {
      list = sp.slice();
    }
    const step = window > 0 ? Math.max(window / list.length, MIN_ACTION_INTERVAL_RATIO * window) : 0;
    const runs = runsOf(list);
    if (host && own > 0) retime.set(host.index, { time, step, ownRuns: runs.filter((r) => r.v === OWN) });
    for (const run of runs) {
      if (run.v === OWN) continue;
      const { b, c, fly } = run.v;
      let routeIndex = hs && Number.isInteger(hs.routeIndex) ? hs.routeIndex : routeByMotion(routes, fly, side);
      const r = routes[routeIndex];
      const motionOk = r && (fly ? r.motion === 'FLY' : r.motion !== 'FLY' && r.motion !== 'E_NUM');
      const sideOk = !(side === 'L' || side === 'R') || (r && Array.isArray(r.end) && (side === 'R' ? r.end[1] > BOSS_MID_COL : r.end[1] < BOSS_MID_COL));
      if (!motionOk || !sideOk) routeIndex = routeByMotion(routes, fly, side);
      const spec = {
        time: time + run.start * step,
        enemyKey: c.enemyKey,
        routeIndex,
        count: run.len,
        interval: run.len > 1 ? step : 0,
        mods: { ...roundMods(scale), slot: classOf(gd, c.enemyKey), bountyId: b.id },
        tag: 'bounty',
        ownerPlayerId: playerId,
        preview: previewInfo(gd, c.enemyKey, routes[routeIndex], false, leader),
      };
      if (host) spec.actionIndex = host.index;
      if (c.payout !== 'perfect' && Number(c.coin) > 0) spec.bounty = { coins: Math.trunc(c.coin), ownerPlayerId: playerId };
      specs.push(spec);
    }
  }
  return { specs, retime };
}

/**
 * A player's full spawn list for the round, exactly like the client: the wave's specs (copied; the own units of an
 * action that bounties join are re-timed around the inserted bounty units — one spec per run of consecutive own units)
 * followed by the bounty specs. Use it instead of `[...wave.spawns, ...bountySpawns(…)]`, which keeps the host
 * action's own spacing.
 */
export function withBounties(gd, round, wave, bounties, playerId, { side = null } = {}) {
  const { specs, retime } = bountyPlan(gd, round, wave, bounties, playerId, side);
  const out = [];
  for (const s of wave.spawns || []) {
    const rt = s.tag !== 'bounty' && Number.isInteger(s.actionIndex) ? retime.get(s.actionIndex) : null;
    if (!rt) { out.push({ ...s, mods: s.mods ? { ...s.mods } : undefined }); continue; }
    for (const run of rt.ownRuns) {
      out.push({ ...s, mods: s.mods ? { ...s.mods } : undefined, time: rt.time + run.start * rt.step, count: run.len, interval: run.len > 1 ? rt.step : 0 });
    }
  }
  return out.concat(specs);
}

/**
 * nextEnemies preview (m.private.nextEnemies): one entry per spawn action (research 08 §4.2 input), in spawn order:
 * `{ enemyKey, count, gate: 'upper'|'lower', t, fly, elite, boss, source: 'wave'|'bounty', tag, start? }` — `tag` 'boss' /
 * 'bounty' / null kept for the drawer's grouping; Σ count = the enemies of the round (HUD). Boss parts are omitted.
 * The client places the models in the gate's pen zone (≤ 50 shown, elites and bosses always) — except a leader: its
 * entry carries its spawn tile `start` ([row, col] on the boss field) and the Final Assault / Hidden Core prep shows it
 * standing there (render/app.js, community report #12; display only).
 */
export function previewOf(spawns) {
  const out = [];
  let seq = 0;
  for (const s of spawns || []) {
    if (!s || typeof s.enemyKey !== 'string' || s.tag === 'part') continue;
    const tag = s.tag === 'boss' ? 'boss' : s.tag === 'bounty' ? 'bounty' : null;
    const pv = s.preview && typeof s.preview === 'object' ? s.preview : {};
    out.push({
      enemyKey: s.enemyKey,
      count: Math.max(1, Math.trunc(Number(s.count) || 1)),
      gate: pv.gate === 'upper' ? 'upper' : 'lower',
      t: Math.max(0, Number(s.time) || 0),
      fly: !!pv.fly,
      elite: !!pv.elite || tag === 'boss',
      boss: tag === 'boss',
      source: tag === 'bounty' ? 'bounty' : 'wave',
      tag,
      ...(tag === 'boss' && Array.isArray(pv.start) && pv.start.length >= 2 && pv.start.every(Number.isFinite) ? { start: [pv.start[0], pv.start[1]] } : {}),
      _seq: seq++,
    });
  }
  out.sort((a, b) => a.t - b.t || a._seq - b._seq);
  for (const e of out) delete e._seq;
  return out;
}

/**
 * 联防 spawns from the union of leaked enemies (research 08 §5; client `GenerateHelpBattleEnemyData` /
 * `_GetSpEnemyActionData` / `_CalculateActionPredelayConsiderUid`, decoded): every leak becomes a 1-unit action on the
 * route of the escaped template's host action — walkers the first `lrsldr` action, flyers `yokai`, tokens (enemies
 * only ever summoned — enemies.json tokenOnly, or `isToken` on the leak) `gopro_2` / `lazerd`, else action 0; elites
 * and specials are NOT routed through the E / S actions. Per host action the units are grouped by owner (source
 * player, first-leak order); with W = count·interval of the host action and M = the largest owner group,
 * step = min(max(W / M, 0.05·W), MAX_ACTION_INTERVAL_FOR_UID 5 s), and unit i of the k-th owner spawns at
 * preDelay + k·ACTION_INTERVAL_FOR_UID (0.5 s) + i·step.
 * @param {Array<{ enemyKey: string, mods: object|null, sourcePlayerId: string, bounty?: object|null, isToken?: boolean }>} leaked
 * @param {number} helperCount 1 | 2
 * @returns {{ templateId: string|null, spawns: object[], routes: object[] }}
 */
export function buildUniteWave(gd, leaked, helperCount, timeLimit) { // eslint-disable-line no-unused-vars
  const templates = gd.unite.templates;
  const templateId = templates[String(helperCount)] || templates[helperCount] || null;
  const tpl = templateId ? gd.wave(templateId) : null;
  const routes = tpl && Array.isArray(tpl.routes) ? tpl.routes : [];
  const ts = gd.factions.templateSlots || {};
  const list = tpl && Array.isArray(tpl.spawns) ? tpl.spawns : [];
  const isSpawn = (s) => s && !(s.action && String(s.action).toUpperCase() !== 'SPAWN');
  /** client `_GetSpEnemyActionData`: the first action whose key is the class placeholder, else action 0 */
  const hostIndex = (fly, token) => {
    const want = token ? ts[fly ? 'TF' : 'T'] : ts[fly ? 'NF' : 'N'];
    for (let i = 0; i < list.length; i++) if (isSpawn(list[i]) && (list[i].key ?? list[i].enemyKey) === want) return i;
    return list.length ? 0 : -1;
  };
  const groups = new Map(); // host action index → Map(owner → leaks), insertion order
  const flyOf = new Map();
  for (const l of leaked || []) {
    if (!l || !gd.enemy(l.enemyKey)) continue;
    const fly = isFlyKey(gd, l.enemyKey);
    const token = l.isToken === true || gd.enemy(l.enemyKey).tokenOnly === true;
    const idx = hostIndex(fly, token);
    if (!groups.has(idx)) { groups.set(idx, new Map()); flyOf.set(idx, fly); }
    const owners = groups.get(idx);
    const owner = l.sourcePlayerId ?? '';
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(l);
  }
  const spawns = [];
  for (const [idx, owners] of groups) {
    const a = idx >= 0 ? list[idx] : null;
    const t0 = a ? Math.max(0, Number(a.time) || 0) : 3;
    const window = a ? Math.max(1, Number.isInteger(a.count) ? a.count : 1) * Math.max(0, Number(a.interval) || 0) : 40;
    let most = 1;
    for (const units of owners.values()) most = Math.max(most, units.length);
    const step = Math.min(Math.max(window / most, MIN_ACTION_INTERVAL_RATIO * window), UNITE_MAX_UNIT_STEP);
    let routeIndex = a && Number.isInteger(a.routeIndex) ? a.routeIndex : routeByMotion(routes, flyOf.get(idx));
    if (routeIndex < 0 || routeIndex >= routes.length) routeIndex = 0;
    let k = 0;
    for (const units of owners.values()) {
      const start = t0 + k * UNITE_OWNER_STEP;
      units.forEach((l, i) => {
        const spec = {
          time: start + i * step, enemyKey: l.enemyKey, routeIndex, count: 1, interval: 0,
          mods: l.mods ? { ...l.mods } : { slot: classOf(gd, l.enemyKey) }, sourcePlayerId: l.sourcePlayerId,
          preview: previewInfo(gd, l.enemyKey, routes[routeIndex]),
        };
        if (idx >= 0) spec.actionIndex = idx;
        if (l.bounty && l.bounty.coins > 0) spec.bounty = { coins: l.bounty.coins, ownerPlayerId: l.bounty.ownerPlayerId ?? l.sourcePlayerId };
        if (l.tag === 'bounty') spec.tag = 'bounty';
        spawns.push(spec);
      });
      k++;
    }
  }
  // ★ 2026-10-28（owner：按设计不该有时间到还没出场的怪）：模板的 spawn time 可能超过联防时限，
  //   导致 _timeout 把未出场单位记成 unspawned 扣血。这里把所有出场时间等比压进 timeLimit - 3 秒内。
  const limit = Math.max(1, Number(timeLimit) || 60);
  const cap = Math.max(0.5, limit - 3);
  let maxT = 0;
  for (const s of spawns) maxT = Math.max(maxT, Number(s.time) || 0);
  if (maxT > cap) {
    const k = cap / maxT;
    for (const s of spawns) s.time = Math.max(0, Math.round((Number(s.time) || 0) * k * 100) / 100);
  }
  spawns.sort((a, b) => a.time - b.time);
  return { templateId, spawns, routes };
}
