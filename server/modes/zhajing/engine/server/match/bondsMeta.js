// server/match/bondsMeta.js — bond member counting, activation tiers and persistent layers (DESIGN §6.3,
// research 02 §2.1–§2.2).
//
// Counting modes (data/bonds.json `countMode`):
//   BOARD            distinct base chess (normal/elite of one operator count once) on the board carrying the bond
//   BOARD_AND_DECK   BOARD + the hand (整备区; the 5 temporary slots do not count) — 远见 / 奇迹 / 投资人
//   BOARD_ALL_CHESS  every elite (精锐) chess on the board, duplicates included — 绝技 (thresholdTemplate *_golden)
// Membership = the chess's own `bonds` + bonds granted by 变形同构体 (an item with `canGiveBond`) worn together with
// an item that has a `giveBondId` (research 02 §2.1).
// Special rules:
//   调和 (maniShip): while active, every CORE bond that already has ≥ 1 real member on the board gets count +1
//                    (one +1 total, research 02 §2.1 [ASSUMED]). Such a state carries `harmony: 1` — the views send it
//                    (bondList: m.private bonds, m.public players[].bonds), so the client's bond popup can say where the
//                    extra count comes from without re-deriving the rule (DESIGN §21.26); the battle input does not
//                    (bondSnapshot).
//   助力 (deputShip): tier 1 needs `thresholds[0]` distinct operators; the upper tiers count operators that differ
//                    in name OR elite state (PRTS 修正).
//   独行 (soloShip, count_threshold_downward): active iff 1 ≤ count ≤ maxCount (distinct 独行 operators).
//   Bonds in the mode's static inactive list (FUNNY) never activate and are omitted from computeBonds (the battle
//                    input never sees them); the views list the ones the player has members of as `off: true`
//                    (offBondCounts → bondList: count only, never active, after the others) so the strip can say
//                    本局禁用 (community reports 「投资人…不生效」 / 「…不会触发斯卡蒂与异德的突袭」, 0.1.3).
// `tier` = number of thresholds reached (downward: 1 when active); `active = tier ≥ 1`.
// Layers (`ps.layers[bondId]`) persist the whole match; they are reported for every bond but only matter while active.

import { layerGainRoom } from '../../shared/constants.js';
import { equipComboBonds } from '../../shared/zjBonds.js';

export const HARMONY_BOND = 'maniShip';
export const DEPUTY_BOND = 'deputShip';

// ---- 缓存 (2026-10-11) ---------------------------------------------------------------------------------
//
// 服务端 CPU 画像（_garrison-list/cpu-profile.mjs，10 座炸惊整局）显示：本文件占**全部服务端 CPU 的 25%**
// —— 单笔最大的是 pieceBonds 7.1%、thresholdsOf 4.6%、computeBonds 4.6%、membership 2.7%。原因有两层：
//   * `thresholdsOf` 每次调用都 filter+sort 出一个新数组，而 `tierFor` 对**每个盟约**都要问一次；
//   * `recompute()` 有 ~35 个调用点（买金币、买东西、移动、升级、结算…），其中大多数并不改变盟约，
//     但每次都从头扫一遍棋盘/手牌、重建 Set、再对全部盟约算一遍 tier。
//
// 缓存策略（三个都是「数据是冻结的、输入相同则输出相同」的纯函数，所以缓存不改变任何结果）：
//   * thresholdsOf：按记录对象本身缓存（WeakMap；炸惊的合并视图每个 gd 一份，互不串味）
//   * pieceBonds：按 (棋子 id, 装备 id 串) 缓存 —— 返回的数组调用方只读（现调用点都是 for..of / Set / some）
//   * computeBonds：按「真正影响盟约的输入」的指纹缓存（棋盘棋子与装备、手牌、层数、计数加成）
//
// 关掉缓存做对照（验收脚本 verify-bonds-cache.mjs 就是这么逐帧比对「有缓存 = 无缓存」）：
//   SP_NO_BOND_CACHE=1
const CACHE_OFF = (() => {
  try { return /^(1|true|yes)$/i.test(String(process.env.SP_NO_BOND_CACHE || '')); } catch { return false; }
})();

/** 每个 gd（每局一份数据视图）一套缓存；键是对象而不是 id，所以不同对局之间不会串。 */
const caches = new WeakMap();
function cacheFor(gd) {
  let c = caches.get(gd);
  if (!c) { c = { piece: new Map(), bonds: new WeakMap() }; caches.set(gd, c); }
  return c;
}
/** thresholdsOf 只认记录对象，与 gd 无关（数据冻结）→ 一个进程级 WeakMap 就够。 */
const thresholdsCache = new WeakMap();
/** pieceBonds 的组合上限（一局里棋子×装备组合远小于它；到顶就不再写入，只读旧的和新算的）。 */
const PIECE_CACHE_MAX = 8192;

/** 命中率统计（只加计数器，成本远小于省下的活；`bondCacheStats()` 给画像/验收脚本读）。 */
const stats = { bonds: 0, bondsHit: 0, piece: 0, pieceHit: 0, thresholds: 0, thresholdsHit: 0 };
/** @returns {{ bonds: number, bondsHit: number, piece: number, pieceHit: number, thresholds: number, thresholdsHit: number }} */
export function bondCacheStats() { return { ...stats }; }
/** 清零统计（画像脚本在一次对局开始前调用）。 */
export function resetBondCacheStats() { for (const k of Object.keys(stats)) stats[k] = 0; }

/**
 * Bonds of a chess piece: own bonds ∪ bonds granted by 变形同构体 pairings.
 * @param {import('./gamedata.js').GameData} gd
 * @param {{ id: string, items?: Array<{ id: string }> }} piece
 * @returns {string[]} 只读（缓存命中时会返回同一个数组）
 */
export function pieceBonds(gd, piece) {
  if (CACHE_OFF) return pieceBondsUncached(gd, piece);
  const items = Array.isArray(piece.items) && piece.items.length ? piece.items : null;
  const sig = items ? `${piece.id}\u0001${items.map((it) => (it && it.id) || '').join(',')}` : String(piece.id);
  const c = cacheFor(gd).piece;
  stats.piece++;
  const hit = c.get(sig);
  if (hit) { stats.pieceHit++; return hit; }
  const v = pieceBondsUncached(gd, piece);
  if (c.size < PIECE_CACHE_MAX) c.set(sig, v);
  return v;
}

/** 未缓存的实现（`pieceBonds` 的每一步都在这里）。 */
function pieceBondsUncached(gd, piece) {
  const c = gd.chess(piece.id);
  const out = c && Array.isArray(c.bonds) ? c.bonds.slice() : [];
  const items = Array.isArray(piece.items) ? piece.items : [];
  if (items.length) {
    const recs = items.map((it) => gd.item(it.id)).filter(Boolean);
    // ★ 2026-10-20（owner 反馈「袖章单独装配没给 S.E.E.S 盟约」）：
    //   ① 原来整段被 `items.length >= 2` 挡住 —— 只戴 1 件（袖章自己）时压根不跑；
    //   ② 循环里 `if (r.canGiveBond) continue;` 又把袖章自己跳过（它 canGiveBond:true 且 giveBondId:'seesShip'）。
    //   现在：只要身上有 canGiveBond 的装备（变形同构体 / “S.E.E.S”袖章），就把**所有** giveBondId 都算上，
    //   包括那件装备自己写的那条。
    if (recs.some((r) => r.canGiveBond)) {
      for (const r of recs) {
        if (typeof r.giveBondId === 'string' && gd.bond(r.giveBondId) && !out.includes(r.giveBondId)) out.push(r.giveBondId);
      }
    }
    // 炸惊模拟：装备组合激活盟约（shared/zjBonds.js zjEquipCombos；gd.zjCombos 只在炸惊下非空）
    // 组合表允许**单件**（S.E.E.S 袖章就是一件）。
    if (Array.isArray(gd.zjCombos) && gd.zjCombos.length) {
      for (const id of equipComboBonds(items.map((it) => it.id), gd.zjCombos)) if (gd.bond(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Who carries which bond (computeBonds' and offBondCounts' shared first step): bondId → Set(baseId) on the board / in
 * the hand (the 5 temporary slots never count), bondId → Set(baseId|golden) on the board, and the elite chess on the board.
 */
function membership(gd, ps) {
  const boardChess = [];
  for (const p of ps.board.values()) if (p && p.kind === 'chess') boardChess.push(p);
  const handChess = ps.hand.filter((p) => p && p.kind === 'chess');
  const onBoard = new Map();
  const onBoardVariant = new Map();
  const inHand = new Map();
  const allOnBoard = new Map();
  const add = (m, bond, key) => { let s = m.get(bond); if (!s) m.set(bond, (s = new Set())); s.add(key); };
  // ★ 2026-10-23：惊变「Belua multorum es capitums.」——持卡玩家的【若叶睦】同时算【调和】成员。
  const belua = hasJibian(ps, 'jibian_duoshouyeshou');
  const bondsOfBoard = (p) => {
    const list = pieceBonds(gd, p);
    if (belua && /^(?:chess_zj_)?mortis_/i.test(gd.baseIdOf(p.id))) return list.includes('maniShip') ? list : [...list, 'maniShip'];
    return list;
  };
  for (const p of boardChess) {
    const base = gd.baseIdOf(p.id);
    const golden = gd.isGolden(p.id);
    for (const b of bondsOfBoard(p)) { add(onBoard, b, base); add(onBoardVariant, b, `${base}|${golden ? 1 : 0}`); allOnBoard.set(b, (allOnBoard.get(b) || 0) + 1); }
  }
  for (const p of handChess) {
    const base = gd.baseIdOf(p.id);
    for (const b of pieceBonds(gd, p)) add(inHand, b, base);
  }
  return { onBoard, onBoardVariant, inHand, allOnBoard, goldenOnBoard: boardChess.filter((p) => gd.isGolden(p.id)).length };
}

/** 突袭的 bondId —— 「炎国人会飞」要往它里面加人。 */
const RAID_BOND = 'raidShip';
/** 会改动盟约【人数】的惊变卡（进 computeBonds 的缓存指纹；以后再有同类卡加到这里即可）。 */
const COUNT_AFFECTING_JIBIAN = Object.freeze(['jibian_yanrenhuifei', 'jibian_duoshouyeshou']);

/**
 * 该玩家有没有选到惊变 `effectId`（备战侧）。战斗侧对应 support/index.js 的 `hasJibian`。
 * 不抛：`ps.jibianHas` 不在时按「没选」算。
 */
function hasJibian(ps, effectId) {
  return !!(ps && typeof ps.jibianHas === 'function' && ps.jibianHas(effectId));
}

/** A bond's member count by its counting mode (before 调和's +1), with the effects' per-bond count bonus. */
function rawCount(gd, id, mem, ps) {
  const bond = gd.bond(id);
  let count;
  if (bond.countMode === 'BOARD_ALL_CHESS' || bond.thresholdTemplate === 'count_threshold_upward_golden') {
    count = mem.goldenOnBoard;
  } else if (bond.countMode === 'BOARD_DUPLICATES') {
    // 炸惊模拟：同名干员的重复个体也计入（用户 2026-10-13 的需求）。**注意：阿戈尔后来改回 BOARD**
    //   （用户 2026-10-14「我要的就是六名不同」），所以现在【只有非阿戈尔的盟约】可能命中这条。
    count = mem.allOnBoard.get(id) || 0;
  } else if (bond.countMode === 'BOARD_AND_DECK') {
    const s = new Set([...(mem.onBoard.get(id) || []), ...(mem.inHand.get(id) || [])]);
    count = s.size;
  } else {
    count = (mem.onBoard.get(id) || new Set()).size;
    // ★ 2026-10-14 惊变「炎国人会飞」(jibian_yanrenhuifei)：选了这张卡时，场上的【炎】干员
    //   也算【突袭】成员。战斗侧 support/index.js 的 isMember 做的是同一件事 —— 但它只在
    //   **突袭已经激活** 之后才有意义，而激活与否由这里的人数决定，所以两边必须一起改：
    //   只改战斗侧 ⇒ 人数永远是 0 ⇒ 突袭从不激活 ⇒ 那张卡一次也不会生效（用户 2026-10-14 报的「突袭呢」）。
    if (id === RAID_BOND && hasJibian(ps, 'jibian_yanrenhuifei')) {
      const yan = mem.onBoard.get('yanShip') || new Set();
      const raid = mem.onBoard.get(id) || new Set();
      count = new Set([...raid, ...yan]).size;
    }
  }
  const bonus = ps.bondCountBonus || {};
  return Math.max(0, count + (Number.isInteger(bonus[id]) ? bonus[id] : 0));
}

const layersIn = (ps, id) => {
  const v = ps.layers && ps.layers[id];
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * Compute every bond's state for a player. `harmony` (only present when it applies) = the +1 that 调和 added to `count`.
 *
 * 带缓存：`recompute()` 在 ~35 个地方被调用，其中大多数不改变盟约（买金币、买东西、移动、升级…），此时输入指纹
 * 不变就直接返回上一次的结果对象 —— 于是整段 membership + 全盟约 tier 计算都省掉。结果只被读（views 的
 * bondList / bondsWithGains / bondSnapshot 都是读或先拷贝），所以复用同一个对象是安全的。
 * @param {import('./gamedata.js').GameData} gd
 * @param {{ board: Map<string, any>, hand: Array<any>, layers: Record<string, number>, bondCountBonus?: Record<string, number> }} ps
 * @returns {Record<string, { count: number, active: boolean, tier: number, layers: number, harmony?: number }>}
 */
export function computeBonds(gd, ps) {
  if (CACHE_OFF) return computeBondsUncached(gd, ps);
  const c = cacheFor(gd).bonds;
  const sig = bondSignature(ps);
  stats.bonds++;
  const hit = c.get(ps);
  if (hit && hit.sig === sig) { stats.bondsHit++; return hit.value; }
  const value = computeBondsUncached(gd, ps);
  c.set(ps, { sig, value });
  return value;
}

/**
 * 强制重算，不走缓存。审计（invariants.js 比对 ps.bonds 与"现算一遍"）必须用它 ——
 * 否则两边都会命中同一份缓存，那个不变量就恒真、查不出任何问题。
 */
export function computeBondsFresh(gd, ps) { return computeBondsUncached(gd, ps); }

/**
 * 「真正影响盟约结果」的输入指纹：棋盘上每只棋子的 id 与装备、手牌里的棋子、层数、计数加成。
 * 顺序就是 Map / 数组本身的顺序，所以同一状态一定得到同一个指纹；只要有一项变了指纹就变。
 */
function bondSignature(ps) {
  let s = '';
  for (const p of ps.board.values()) {
    if (!p || p.kind !== 'chess') continue;
    s += p.id + ',';
    const items = p.items;
    if (items && items.length) for (const it of items) s += ((it && it.id) || '') + ',';
    s += ';';
  }
  s += '#';
  for (const p of ps.hand) if (p && p.kind === 'chess') s += p.id + ',';
  s += '#';
  const layers = ps.layers;
  if (layers) for (const k of Object.keys(layers)) { const v = layers[k]; if (v) s += k + ':' + v + ','; }
  s += '#';
  const bonus = ps.bondCountBonus;
  if (bonus) for (const k of Object.keys(bonus)) { const v = bonus[k]; if (v) s += k + ':' + v + ','; }
  // ★ 会影响【人数】的惊变卡也必须进指纹，否则选到卡之后 board/hand/layers 都没变、
  //   缓存会直接把旧结果还回来（「炎国人会飞」就是这样：光修 rawCount 也会被缓存挡住）。
  s += '#j:';
  for (const id of COUNT_AFFECTING_JIBIAN) if (hasJibian(ps, id)) s += id + ',';
  return s;
}

/** 未缓存的实现（`computeBonds` 的全部工作都在这里）。 */
function computeBondsUncached(gd, ps) {
  const mem = membership(gd, ps);
  const { onBoard, onBoardVariant } = mem;

  /** @type {Record<string, { count: number, active: boolean, tier: number, layers: number, harmony?: number }>} */
  const out = {};
  const layersOf = (id) => layersIn(ps, id);
  const bonus = ps.bondCountBonus || {};
  const bonusOf = (id) => (Number.isInteger(bonus[id]) ? bonus[id] : 0);

  // first pass: raw counts
  const raw = {};
  for (const id of gd.bondIds) {
    if (gd.modeInactiveBonds.has(id)) continue;
    raw[id] = rawCount(gd, id, mem, ps);
  }
  // 调和: +`bb.count` (base 1; 炸惊 2) to core bonds with ≥ 1 real board member while it is active
  const harmony = gd.bond(HARMONY_BOND);
  const harmonyActive = harmony && raw[HARMONY_BOND] != null && tierFor(harmony, raw[HARMONY_BOND]) >= 1;
  const harmonyAdd = Math.max(0, Math.floor(Number(harmony && harmony.bb && harmony.bb.count) || 1));
  for (const id of Object.keys(raw)) {
    const bond = gd.bond(id);
    const harmonyBonus = harmonyActive && bond.isCore && (onBoard.get(id)?.size ?? 0) >= 1 ? harmonyAdd : 0;
    const count = raw[id] + harmonyBonus;
    let tier = tierFor(bond, count);
    if (id === DEPUTY_BOND && tier >= 1) {
      // upper tiers: operators differing in name OR elite state
      const variants = (onBoardVariant.get(id)?.size ?? 0) + bonusOf(id);
      const th = thresholdsOf(bond);
      let t = 1;
      for (let i = 1; i < th.length; i++) if (variants >= th[i]) t = i + 1;
      tier = t;
    }
    out[id] = { count, active: tier >= 1, tier, layers: layersOf(id) };
    if (harmonyBonus) out[id].harmony = harmonyBonus;
  }
  return out;
}

/**
 * The bonds this mode never activates (the static inactive list — 标准模拟's 拉特兰 阿戈尔 卡西米尔 灵巧 奥术 奇迹 投资人 突袭
 * 独行 绝技) that the player has members of, counted like computeBonds would (投资人 / 奇迹 with the hand): { [bondId]:
 * { count, layers } }, null when the mode switches nothing off. Only the views use it (bondList `off`) — the strip shows
 * such a bond as a grey 本局禁用 disc instead of leaving the player to wonder why it does nothing (0.1.3).
 * @param {import('./gamedata.js').GameData} gd
 * @param {{ board: Map<string, any>, hand: Array<any>, layers: Record<string, number>, bondCountBonus?: Record<string, number> }} ps
 * @returns {Record<string, { count: number, layers: number }>|null}
 */
export function offBondCounts(gd, ps) {
  if (!gd.modeInactiveBonds || !gd.modeInactiveBonds.size) return null;
  const mem = membership(gd, ps);
  let out = null;
  for (const id of gd.bondIds) {
    if (!gd.modeInactiveBonds.has(id)) continue;
    const count = rawCount(gd, id, mem, ps);
    if (!(count > 0)) continue;
    (out ??= {})[id] = { count, layers: layersIn(ps, id) };
  }
  return out;
}

/**
 * Ascending member-count thresholds of a bond (fallback: activeCount). 按记录对象缓存 —— 原来每次调用都要
 * filter+sort 出一个新数组，而 `tierFor` 对每个盟约、每次 recompute 都要问一次（画像里占 4.6%）。
 * 返回的数组只读。
 */
export function thresholdsOf(bond) {
  if (CACHE_OFF || !bond || typeof bond !== 'object') return thresholdsOfUncached(bond);
  stats.thresholds++;
  const hit = thresholdsCache.get(bond);
  if (hit) { stats.thresholdsHit++; return hit; }
  const v = thresholdsOfUncached(bond);
  thresholdsCache.set(bond, v);
  return v;
}

/** 未缓存的实现。 */
function thresholdsOfUncached(bond) {
  if (Array.isArray(bond.thresholds) && bond.thresholds.length) return bond.thresholds.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (Number.isFinite(bond.activeCount)) return [bond.activeCount];
  return [2];
}

/** Tier for a member count (downward bonds: 1 while 1 ≤ count ≤ maxCount). */
export function tierFor(bond, count) {
  const th = thresholdsOf(bond);
  if (bond.thresholdTemplate === 'count_threshold_downward') {
    const max = Number.isFinite(bond.maxCount) ? bond.maxCount : th[0];
    return count >= th[0] && count <= max ? 1 : 0;
  }
  let t = 0;
  for (const n of th) if (count >= n) t++;
  return t;
}

/** Σ layers over active bonds (hidden-core check, 不朽盟约 title). */
export function activatedLayers(bonds) {
  let n = 0;
  for (const b of Object.values(bonds || {})) if (b.active) n += b.layers || 0;
  return n;
}

/**
 * View list for m.private / m.public: bonds with members or layers, active first, then layers desc, then data order.
 * An entry whose count includes 调和's +1 carries `harmony: 1` (both views; absent otherwise). `off` (offBondCounts): the
 * mode-off bonds the player has members of follow, in data order, as `{ bondId, count, active: false, tier: 0, layers,
 * off: true }` — the strip's grey 本局禁用 discs; never in computeBonds, so never in the battle input.
 * @param {import('./gamedata.js').GameData} gd
 * @param {ReturnType<typeof computeBonds>} bonds
 * @param {{ full?: boolean, off?: ReturnType<typeof offBondCounts> }} [opts] full → include thresholds/countsHand (m.private)
 */
/** gd → (bondId → 序号) 的缓存：bondList 每次调用都要这张表，而 gd 在进程内共享（用户 2026-10-13 审计）。 */
const BOND_ORDER = new WeakMap();

export function bondList(gd, bonds, { full = false, off = null } = {}) {
  // bondIds → 序号 的表：原来每次调用都新建一个 Map（每条 publicView 的每一行都会调用 → 100 座时每帧上百次）。
  // gd 在进程内是共享的，用 WeakMap 记住即可（用户 2026-10-13 审计）。
  let order = BOND_ORDER.get(gd);
  if (!order) { order = new Map(gd.bondIds.map((id, i) => [id, i])); BOND_ORDER.set(gd, order); }
  const list = [];
  const extras = (e) => {
    if (!full) return e;
    const bond = gd.bond(e.bondId);
    e.thresholds = bond ? thresholdsOf(bond) : [];
    e.countsHand = !!(bond && bond.countMode === 'BOARD_AND_DECK');
    return e;
  };
  for (const [bondId, b] of Object.entries(bonds || {})) {
    if (!(b.count > 0 || b.layers > 0 || b.active)) continue;
    const e = { bondId, count: b.count, active: b.active, tier: b.tier, layers: b.layers };
    if (b.harmony > 0) e.harmony = b.harmony;
    list.push(extras(e));
  }
  list.sort((a, b) => (b.active - a.active) || (b.layers - a.layers) || ((order.get(a.bondId) ?? 99) - (order.get(b.bondId) ?? 99)));
  if (off) {
    for (const bondId of gd.bondIds) {
      const o = off[bondId];
      if (!o || !(o.count > 0) || (bonds && bonds[bondId])) continue;
      list.push(extras({ bondId, count: o.count, active: false, tier: 0, layers: Number.isFinite(o.layers) && o.layers > 0 ? o.layers : 0, off: true }));
    }
  }
  return list;
}

/**
 * The bond states the views show (m.private / m.public players[].bonds, DESIGN §20.15): `bonds` with this round's
 * IN_BATTLE gains of a finished normal battle (`gains` = the result's layerGains, PlayerState.pendingLayerGains, set
 * when the COMBAT phase ends) added the way settle() will add them — at most up to BOND_LAYER_CAP — so the strip of a
 * player (and of a teammate watching him) keeps the layers his battle reached through the 联防 until the settlement
 * makes them persistent. `bonds` itself when there is nothing to add; the persistent state is never touched.
 * @param {ReturnType<typeof computeBonds>} bonds
 * @param {Record<string, number>|null|undefined} gains
 */
export function bondsWithGains(bonds, gains, cap) {
  if (!gains || typeof gains !== 'object') return bonds;
  let out = null;
  for (const [id, n] of Object.entries(gains)) {
    const b = bonds && bonds[id];
    if (!b) continue;
    const add = layerGainRoom(b.layers, Math.floor(Number(n) || 0), cap);
    if (!(add > 0)) continue;
    if (!out) out = { ...bonds };
    out[id] = { ...b, layers: (b.layers || 0) + add };
  }
  return out || bonds;
}

/** Snapshot for PlayerBattleInput.bonds: { [bondId]: { count, active, tier, layers } } (plain copy). */
export function bondSnapshot(bonds) {
  const o = {};
  for (const [id, b] of Object.entries(bonds || {})) o[id] = { count: b.count, active: b.active, tier: b.tier, layers: b.layers };
  return o;
}
