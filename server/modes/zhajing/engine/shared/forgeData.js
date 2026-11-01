// shared/forgeData.js — 炸惊模拟「锻造器」的数值表与纯函数。
//
// ★ 服务端（server/match/player/acquire.js 的 forgeTake、战斗侧的 content/forge.js）与客户端
//   （public/js/ui/forge.js 的卡片显示）**共用这一份**，避免两边数值漂移。
//
// 用户 2026-10-14 给的数值：
//   攻击力   普通 +100 · 史诗 +325 · 传说 +799（★ 2026-10-15 用户下调；原 325/799/2000）
//   防御力   普通 +100 · 史诗 +170 · 传说 +300
//   生命     普通 +500 · 史诗 +1200 · 传说 +2500
//   暴击率   普通 +1% · 史诗 +3% · 传说 +6%（★ 2026-10-15 用户下调）
//   吸血     普通 +2% · 史诗 +4% · 传说 +6%（★ 2026-10-15 用户下调）
//   资金     普通 +1 · 史诗 +2 · 传说 +5
//   攻击距离 传说 +1 格（★ 2026-10-15 用户：从「史诗 +1 / 传说 +2」改成只有传说、且只 +1）
//   阻挡数   史诗 +1 · 传说 +2
//   技力需求 传说 −10%
//
// 稀有度「保持最初版的普通史诗传说概率」= 把 data/config.json 里没有单独出现的 rare(25)
// 折进普通（45+25=70），于是 普通 70 / 史诗 20 / 传说 10。

/** 累计击败多少个敌人给一个锻造器（★ 2026-10-15 用户：从「每20个给1个」改成「每40个给1个」）。 */
export const FORGE_KILLS_PER = 40;

/** 三档稀有度 + 权重（百分比）。改这里就能调整手感。 */
export const FORGE_RARITY = Object.freeze([
  Object.freeze({ id: 'normal', weight: 70, name: '普通' }),
  Object.freeze({ id: 'epic', weight: 20, name: '史诗' }),
  Object.freeze({ id: 'legend', weight: 10, name: '传说' }),
]);
const RARITY_ORDER = Object.freeze(FORGE_RARITY.map((r) => r.id));
/** rank 越大越稀有，用来判断「至少史诗」这类门槛。 */
const rankOf = (id) => RARITY_ORDER.indexOf(id);
/** 稀有度 id 是否合法。 */
export const isForgeRarity = (id) => RARITY_ORDER.includes(id);

/**
 * 九种锻造选项。`min` 是它出现的最低稀有度：
 *   普通           攻击力 / 防御力 / 生命 / 暴击率 / 吸血 / 资金
 *   史诗（含以上）  再加 阻挡数
 *   传说           再加 技力需求
 * `unit` 是显示后缀；`value[rarity]` 是每档的实际加成。
 */
export const FORGE_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'atk', min: 'normal', name: '攻击力',
    // ★ 用户 2026-10-14 改：传说档从「+20% 已锻造攻击力（为 0 时 +1500）」改成**固定 +2000** ——
    //   于是它不再引用「已锻造」，卡面上那行「已锻造攻击为 0 时改为 +1500」的小字也跟着消失。
    // ★ 2026-10-15 用户：攻击力 325/799/2000 → 100/325/799（整体下调）
    value: { normal: { v: 100 }, epic: { v: 325 }, legend: { v: 799 } },
    hint: '全体上阵干员攻击力提升',
  }),
  Object.freeze({
    id: 'def', min: 'normal', name: '防御力',
    value: { normal: { v: 100 }, epic: { v: 170 }, legend: { v: 300 } },
    hint: '全体上阵干员防御力提升',
  }),
  Object.freeze({
    id: 'hp', min: 'normal', name: '生命',
    value: { normal: { v: 500 }, epic: { v: 1200 }, legend: { v: 2500 } },
    hint: '全体上阵干员生命上限提升',
  }),
  Object.freeze({
    id: 'crit', min: 'normal', name: '暴击率', unit: '%',
    // ★ 2026-10-15 用户：暴击率 3/6/9% → 1/3/6%
    value: { normal: { v: 1 }, epic: { v: 3 }, legend: { v: 6 } },
    hint: '全体上阵干员暴击率提升',
  }),
  Object.freeze({
    id: 'vamp', min: 'normal', name: '吸血', unit: '%',
    // ★ 2026-10-15 用户：吸血 5/7/12% → 2/4/6%
    value: { normal: { v: 2 }, epic: { v: 4 }, legend: { v: 6 } },
    hint: '造成伤害时按比例回复生命',
  }),
  Object.freeze({
    id: 'gold', min: 'normal', name: '资金',
    value: { normal: { v: 1 }, epic: { v: 2 }, legend: { v: 5 } },
    hint: '立刻获得资金',
  }),
  Object.freeze({
    // ★ 2026-10-15 用户：攻击距离从「史诗 +1 / 传说 +2」改成【只有传说 +1】。
    //   ⇒ 史诗池少一项（8 → 7）· 传说池仍 9 项；距离只有传说掷得到（10% 权重 × 3/9 ⇒ 每次约 3.3%）
    id: 'range', min: 'legend', name: '攻击距离', unit: '格',
    value: { legend: { v: 1 } },
  }),
  Object.freeze({
    id: 'block', min: 'epic', name: '阻挡数',
    value: { epic: { v: 1 }, legend: { v: 2 } },
    hint: '全体上阵干员阻挡数增加',
  }),
  Object.freeze({
    id: 'sp', min: 'legend', name: '技力需求', unit: '%',
    value: { legend: { v: -10 } },
    hint: '全体上阵干员技能所需技力降低',
  }),
]);

/** 按 id 取选项（找不到 null）。 */
export const forgeOptionById = (id) => FORGE_OPTIONS.find((o) => o.id === id) || null;

/** 某稀有度可以抽到的选项。 */
export const optionsFor = (rarity) => FORGE_OPTIONS.filter((o) => rankOf(rarity) >= rankOf(o.min));

/** 按权重掷一个稀有度。 */
export function rollRarity(rng = Math.random) {
  const total = FORGE_RARITY.reduce((s, r) => s + r.weight, 0);
  let x = rng() * total;
  for (const r of FORGE_RARITY) {
    x -= r.weight;
    if (x < 0) return r.id;
  }
  return FORGE_RARITY[0].id;
}

/**
 * 抽一组：同一稀有度的三张**不重复**选项（池子不足三个时有多少给多少）。
 * @param {() => number} [rng]
 * @returns {{ rarity: string, picks: string[] }} picks 是选项 id（跨进程传得动）
 */
export function drawForge(rng = Math.random) {
  const rarity = rollRarity(rng);
  const pool = optionsFor(rarity).map((o) => o.id);
  const picks = [];
  while (picks.length < 3 && pool.length) {
    const i = Math.floor(rng() * pool.length);
    picks.push(pool.splice(i, 1)[0]);
  }
  return { rarity, picks };
}

/**
 * 一个选项在某稀有度下**实际贡献**的数值。
 * 传说攻击力是特殊规则：+20% 当前已锻造攻击力；已锻造为 0 时给 floor。
 * @param {object} opt @param {string} rarity @param {Record<string,{total:number,count:number}>} [forged]
 */
export function amountOf(opt, rarity, forged = {}) {
  const e = opt && opt.value ? opt.value[rarity] : null;
  if (!e) return 0;
  const f = forged || {};   // ★ 调用方可能给 null —— 共享模块必须扛住
  if (e.kind === 'forgedPct') {
    const base = Number(f[opt.id] && f[opt.id].total) || 0;
    return base > 0 ? Math.round(base * (e.v / 100)) : e.floor;
  }
  return e.v;
}

/**
 * 把一组抽卡结算进已锻造表（纯函数，不改入参）。
 * @returns {{ forged: object, delta: number }}
 */
export function applyForgePick(forged = {}, optId, rarity) {
  const f = forged || {};
  const opt = forgeOptionById(optId);
  if (!opt || !opt.value[rarity]) return { forged: f, delta: 0 };
  const delta = amountOf(opt, rarity, f);
  const before = f[optId] || { total: 0, count: 0 };
  return {
    forged: { ...f, [optId]: { total: before.total + delta, count: before.count + 1 } },
    delta,
  };
}

/** 已锻造的条目（有叠过的才出现），按 FORGE_OPTIONS 的顺序。 */
/** 已锻造的条目（有叠过的才出现），按 FORGE_OPTIONS 的顺序。`forged` 允许是 null / undefined。 */
export const forgedEntries = (forged) => {
  // ★ 双保险：万一某处（旧客户端缓存、别的地方）直接给了【条目数组】，原样返回，不再二次折算。
  if (Array.isArray(forged)) return forged;
  const f = forged || {};   // ★ 关键：默认值只对 undefined 生效，服务端/组件可能传 null
  return FORGE_OPTIONS.filter((o) => f[o.id] && f[o.id].count > 0)
    .map((o) => ({ id: o.id, name: o.name, unit: o.unit || '', total: f[o.id].total, count: f[o.id].count }));
};

/** 累计的数值文本，例如 `+1124` / `+9%` / `+2格` / `-10%`。 */
export function forgedText(e) {
  const sign = e.total > 0 ? '+' : '';
  return `${sign}${e.total}${e.unit}`;
}

/** 已锻造的项数（徽标用）。 */
export const forgedCount = (forged) => forgedEntries(forged).length;

/** 一个选项在某稀有度下的数值文本，例如 `+325` / `+15%` / `+2格`。 */
export function valueText(opt, rarity) {
  const e = opt.value[rarity];
  if (!e) return '—';
  if (e.kind === 'forgedPct') return `+${e.v}%`;
  const sign = e.v > 0 ? '+' : '';
  return `${sign}${e.v}${opt.unit || ''}`;
}

/** 数值下面那行小字（只有传说攻击力有：已锻造为 0 时的保底）。 */
export function valueNote(opt, rarity) {
  const e = opt.value[rarity];
  return e && e.kind === 'forgedPct' ? `已锻造攻击为 0 时改为 +${e.floor}` : null;
}

/**
 * 已锻造表 → **战斗输入用的扁平数值**（服务端算一次，战斗侧直接铺到干员身上）。
 * 九个选项里 7 个走引擎的加算键，`crit` / `vamp` 引擎没有，由 content/forge.js 用钩子实现。
 *
 * ★ 2026-10-16：「技力需求」由**固定减法**改成**倍率**（owner 选的方案 A）。
 *   原来把 `-10`（卡面写的是 **-10%**）当成 `spCostFlat` 交给引擎，而 skills.js 的算法是
 *     `spCost = floor(baseSpCost * spCostMul + spCostFlat)`
 *   —— 那是**绝对减法**。于是 spCost ≤ 10 的干员被减到 0 并被 clamp 住：
 *     `spCost = 0` ⇒ 快照里 `spMax = 0` ⇒ 客户端 `units.js` 的 `showSp` 要求 `spMax > 0`
 *     ⇒ **技力条消失**；同时引擎对 `spCost <= 0` 走"免费技能"分支（charges 直接拉满）
 *     ⇒ 玩家看到的「开不出技能」。实测受影响的棋子有 42 个（华法琳 4 · 古米/风笛/泥岩 5 ·
 *     至简/夕/塑心 6 · 灵知 7 · 史尔特尔/塞雷娅/山 8 · 莎草 9 …）。
 *   现在按百分比语义换算成倍率（-10 ⇒ ×0.9），由 content/forge.js 写进 `skill.spCostMul`
 *   —— 与盟友特质 `sp_ratio` 同一条通道（bonds/addon/battle.js 的 suntSpCost）。
 *   顺带修掉另一个偏离：20 技力的干员原来被砍成 10（偏强一倍），现在正确变成 18。
 *
 *   `sp` 仍保留在返回值里（供旧存档 / 在途对局读），但战斗侧已不再使用它。
 */
export function forgeBattleMods(forged) {
  const f = forged || {};
  const g = (id) => Number(f[id] && f[id].total) || 0;
  const spPct = g('sp');                       // 卡面单位是 %（-10 ⇒ 需求降 10%）
  return {
    atk: g('atk'),      // → atkFlat
    def: g('def'),      // → defFlat
    hp: g('hp'),        // → hpFlat
    crit: g('crit'),    // 暴击率 %（content/forge.js 钩子）
    vamp: g('vamp'),    // 吸血 %（content/forge.js 钩子）
    range: g('range'),  // → rangeExtend（格）
    block: g('block'),  // → blockCnt
    sp: spPct,          // 兼容旧读法（不再被战斗侧使用）
    // → skill.spCostMul：0.9 = 需求降 10%。夹在 [0.1, 1]，纯防御（数据写坏也不至于把技力变成 0）
    spMul: spPct ? Math.min(1, Math.max(0.1, 1 + spPct / 100)) : 1,
  };
}

/** 战斗用的扁平数值是否全为 0（不需要挂任何东西）。 */
export const forgeModsEmpty = (m) => !m || !(m.atk || m.def || m.hp || m.crit || m.vamp || m.range || m.block ||
  (m.spMul && m.spMul !== 1) || m.sp);
