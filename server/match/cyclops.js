// server/match/cyclops.js — 独眼巨人冲锋 (entertainment_cyclops)：完全独立的娱乐模式规则层。
//
// 隔离原则：本模块所有行为只在 match.isCyclops === true 时生效，普通模式 / entertainment_multi 不经过这里。
// 挂载点（均由调用方以 isCyclops 判断）：
//   * Match 构造（Match.js）：modeId 固定 'mode_cyclops'、全干员池、禁抽关闭、经济装备排除
//   * phases.js startRound：奖励关波次 buildCyclopsBonusWave；afterRoundStart：enterCyclopsHex
//   * player/round.js：利息结算（endPrep 不清零资金，改为下回合发息）
//   * player/economy.js：levelUp 经验制
//
// 独眼巨人的馈赠（馈赠）：
//   * 第 5/10/15 回合进入 CYCLOPS_HEX 阶段（复用 SP_DRAFT 的 UI 语义但独立状态），银→金→彩固定顺序
//   * 3 个槽位各刷一个不同馈赠（同 quality、不同 family），每槽位一次免费刷新
//   * g.cyclopsHex { slot } 选择；g.cyclopsHexReroll { slot } 刷新该槽位（每槽一次）
//   * 全员独立完成选择（各自有 3 槽）即进入 PREP
//
// 奖励关（第 4/8/12/16 回合）：10 只普通猎狗（enemy_1000_gopro_2），不漏怪即胜利；
// 胜利者在 SETTLE 时获赠一件 2/3/4/5 阶随机装备。

import {
  CYCLOPS_BONUS_ENEMY, CYCLOPS_BONUS_COUNT, CYCLOPS_BONUS_ITEM_TIERS, CYCLOPS_HEX_ROUNDS, CYCLOPS_HEX_QUALITIES,
  CYCLOPS_INTEREST_PER, CYCLOPS_INTEREST_RATE, CYCLOPS_INTEREST_CAP, CYCLOPS_BONUS_ROUNDS,
} from '../../shared/constants.js';
import { grantLayersVerified } from './rewardRecovery.js';

/** Independent gift actions yield after failure; never replay economic operations. */
function isolateCyclops(ps, label, apply, m = ps.m) {
  try { return apply(); } catch (error) {
    try {
      if (typeof m?.dispatcher?._report === 'function') m.dispatcher._report('cyclops', label, error);
      else m?.reportError?.(`cyclops:${label}`, error);
    } catch { /* Diagnostics must not block the next independent gift. */ }
    return undefined;
  }
}

const PHASE = { HEX: 'CYCLOPS_HEX', DRAFT: 'CYCLOPS_DRAFT' };

/** 该回合是否独眼巨人冲锋的奖励关（4/8/12/16）。 */
export const isCyclopsBonusRound = (r) => CYCLOPS_BONUS_ROUNDS.includes(r);
/** 该回合是否独眼巨人冲锋的馈赠关（5/10/15）。 */
export const isCyclopsHexRound = (r) => CYCLOPS_HEX_ROUNDS.includes(r);
/** 该回合是否独眼巨人冲锋的选秀关（10）。 */
export const isCyclopsDraftRound = (r) => r === 10;

// ------------------------------------------------------------------------------------------------------------------
// 馈赠定义访问

/** data/cyclops.json 的 hex 列表（构造时由 GameData 提供 raw）。 */
export function cyclopsHexes(raw) {
  const d = raw && typeof raw === 'object' && raw.cyclops && typeof raw.cyclops === 'object' ? raw.cyclops : null;
  return d && Array.isArray(d.hexes) ? d.hexes.filter((h) => h && typeof h.id === 'string' && h.levels && typeof h.levels === 'object') : [];
}

/**
 * 面向玩家的馈赠卡视图。
 * @returns {{ id, family, name, logo, quality, levelName, desc } | null}
 */
export function cyclopsHexCard(hex, quality) {
  if (!hex || !hex.levels || !hex.levels[quality]) return null;
  const lv = hex.levels[quality];
  return {
    id: hex.id, family: hex.family || hex.id, name: hex.name || hex.id, logo: hex.logo || null,
    quality, levelName: lv.name || '', desc: lv.desc || '',
  };
}

/**
 * 一次馈赠的 3 个槽位：同 quality、不同 family 的不同馈赠（去重；不足时允许重复 family 但不重复 id）。
 * @param {object} raw 比对数据
 * @param {Function} rng 已播种 rng
 * @param {string} quality 'silver'|'gold'|'prismatic'
 * @param {Set<string>} takenIds 本局已选过的 hex id（避免重复发同一条；池不足时放开）
 * @returns {Array<object|null>} 长度 3 的卡槽数组（null = 数据不足）
 */
export function cyclopsHexAvailable(card, ps) {
  if (!card || !ps || card.id !== 'cyc_risk') return !!card;
  return card.quality === 'silver' ? ps.lp >= 4 : card.quality === 'prismatic' ? ps.lp >= 7 : true;
}

export function rollCyclopsHexSlots(raw, rng, quality, takenIds = new Set(), ps = null) {
  const all = cyclopsHexes(raw).filter(h => cyclopsHexAvailable(cyclopsHexCard(h, quality), ps));
  if (!all.length) return [null, null, null];
  const fresh = all.filter((h) => !takenIds.has(h.id) && cyclopsHexCard(h, quality));
  const pool = fresh.length >= 3 ? fresh : all.filter((h) => cyclopsHexCard(h, quality));
  if (!pool.length) return [null, null, null];
  const shuffled = rng.shuffle(pool.slice());
  const out = [];
  const families = new Set();
  // 先保证 family 不同
  for (const h of shuffled) {
    if (out.length >= 3) break;
    const fam = h.family || h.id;
    if (families.has(fam)) continue;
    families.add(fam);
    out.push(cyclopsHexCard(h, quality));
  }
  // 不足 3 个时放开 family 限制补齐（不同 id）
  for (const h of shuffled) {
    if (out.length >= 3) break;
    if (out.some((c) => c && c.id === h.id)) continue;
    out.push(cyclopsHexCard(h, quality));
  }
  // A depleted definition set may repeat an eligible card; health-gated cards are never used as padding.
  const available = out.slice();
  while (out.length < 3) out.push(available.length ? { ...available[out.length % available.length] } : null);
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// 奖励关波次

/**
 * 奖励关专用波次：借用该回合模板的路由与时间限制，敌人全部替换为 10 只普通猎狗。
 * 与 buildNormalWave 的占位符替换不同——这里直接构造 spawns（literal key 不经过 pick 替换）。
 * @param {object} gd GameData
 * @returns {{ templateId, spawns, routes, extraRoutes, timeLimit, overrides, pick: null, entries, actions }}
 */
export function buildCyclopsBonusWave(gd, round) {
  const rc = gd.roundCfg(round);
  const templateId = rc && typeof rc.template === 'string' ? rc.template : null;
  const tpl = templateId ? gd.wave(templateId) : null;
  const timeLimit = gd.combatTimeLimit(round);
  const routes = tpl && Array.isArray(tpl.routes) ? tpl.routes : [];
  if (!tpl) {
    return { templateId, spawns: [], routes, extraRoutes: [], timeLimit, overrides: {}, pick: null, entries: { ground: null, fly: null }, actions: [] };
  }
  const scale = gd.enemyScale(round);
  const walkRoute = routes.findIndex((r) => r && r.motion !== 'FLY' && r.motion !== 'E_NUM');
  const routeIndex = walkRoute >= 0 ? walkRoute : 0;
  const spawns = [{
    time: 3,
    enemyKey: CYCLOPS_BONUS_ENEMY,
    routeIndex,
    count: CYCLOPS_BONUS_COUNT,
    interval: 1.5,
    mods: { hpMul: scale.hpMul, atkMul: scale.atkMul, speedMul: scale.speedMul, slot: 'N' },
    actionIndex: 0,
    preview: { gate: 'lower', start: routes[routeIndex] && Array.isArray(routes[routeIndex].start) ? routes[routeIndex].start : null, fly: false, elite: false, boss: false },
  }];
  return {
    templateId,
    spawns,
    routes,
    extraRoutes: Array.isArray(tpl.extraRoutes) ? tpl.extraRoutes : [],
    timeLimit,
    overrides: tpl.overrides && typeof tpl.overrides === 'object' ? tpl.overrides : {},
    pick: null,
    entries: { ground: null, fly: null },
    actions: [{ index: 0, key: CYCLOPS_BONUS_ENEMY, tplKey: CYCLOPS_BONUS_ENEMY, slot: 'N', time: 3, count: CYCLOPS_BONUS_COUNT, tplCount: CYCLOPS_BONUS_COUNT, window: CYCLOPS_BONUS_COUNT * 1.5, routeIndex, valid: true, server: true }],
  };
}

/**
 * 奖励关结算：不漏怪（counted === 0）即胜利，赠送随机装备（1-5 阶，低阶概率更高）。
 * @returns {string|null} 装备 id 或 null
 */
export function cyclopsBonusReward(gd, rng, itemPool, round) {
  const rc = gd.roundCfg(round);
  const configuredTiers = Array.isArray(rc && rc.bonusItemTiers)
    ? rc.bonusItemTiers.map(Number).filter((t) => Number.isInteger(t) && t >= 1 && t <= 5)
    : [];
  const tierPool = configuredTiers.length ? configuredTiers : [...CYCLOPS_BONUS_ITEM_TIERS];
  const tiers = [...new Set(tierPool)].sort((a, b) => a - b);
  const pools = tiers.map((tier) => ({
    tier,
    ids: (gd.shopItemsByTier[tier] || []).filter((id) => !itemPool || itemPool.canGain(id)),
  })).filter((entry) => entry.ids.length);
  if (!pools.length) return null;
  const totalWeight = pools.reduce((sum, entry, index) => sum + (pools.length - index), 0);
  let roll = rng() * totalWeight;
  let selected = pools.at(-1);
  for (let i = 0; i < pools.length; i++) {
    roll -= pools.length - i;
    if (roll < 0) { selected = pools[i]; break; }
  }
  return selected.ids[Math.floor(rng() * selected.ids.length)] || null;
}

// ------------------------------------------------------------------------------------------------------------------
// 经济：存款利息

/**
 * 回合开始时的利息（存于上回合结束时的资金）：
 * 资金 ≤ 50 时，每满 10 金币 +1/回合，上限 5（=50 资金满息）；> 50 不再增长。
 * @param {number} funds 结算时的资金
 * @returns {number}
 */
export function cyclopsInterest(funds) {
  if (!Number.isFinite(funds) || funds <= 0) return 0;
  const capped = Math.min(funds, CYCLOPS_INTEREST_PER * CYCLOPS_INTEREST_CAP);
  return Math.floor(capped / CYCLOPS_INTEREST_PER) * CYCLOPS_INTEREST_RATE;
}

/**
 * 利息上限（供 馈赠「存款利息」族扩展）。
 * @param {number} funds @param {number} capBonus 上限加值 @param {number} perBonus 档位加值
 */
export function cyclopsInterestWith(funds, { capBonus = 0, perBonus = 0, uncapped = false } = {}) {
  if (!Number.isFinite(funds) || funds <= 0) return 0;
  if (uncapped) return Math.floor(funds / CYCLOPS_INTEREST_PER) * CYCLOPS_INTEREST_RATE;
  const cap = CYCLOPS_INTEREST_CAP + Math.max(0, capBonus);
  const per = CYCLOPS_INTEREST_PER - Math.min(0, 0) + Math.max(0, perBonus); // perBonus 直接加在档位上
  const capped = Math.min(funds, per * cap);
  return Math.floor(capped / per) * CYCLOPS_INTEREST_RATE;
}

export { PHASE as CYCLOPS_PHASE };

// ------------------------------------------------------------------------------------------------------------------
// R10 选秀环节
//
// 10 个选项 = 10 组「1 干员 + 1 装备」捆绑；每名玩家各领走一组（每人 1 干员 + 1 装备），选完即从公共列表移除。
// 选取顺序：当前 LP 低者先选（LP 相同按座位号）；轮到即选（无计时等待，超时由阶段 deadline 兜底自动选剩余第一项）。

/**
 * 生成选秀池：10 组 { chessId, itemId }。
 * 干员从该玩家所在共享池有余额的干员中按品阶权重抽（高品阶稀有）；装备从 2-5 阶可获取装备中抽。
 * @param {object} m Match
 * @param {object} ps 第一视角玩家（用其池；同组玩家共享池）
 * @returns {Array<{chessId: string, itemId: string}>}
 */
export function rollCyclopsDraftPool(m, ps) {
  const gd = ps.gd || m.gd;
  const rng = m.rngDraft;
  const pool = [];
  // 品阶权重：T1:18 T2:16 T3:14 T4:12 T5:6 T6:4（近似云顶选秀费用曲线；全池含 hidden）
  const tierPairs = [[1, 18], [2, 16], [3, 14], [4, 12], [5, 6], [6, 4]];
  const itemsByTier = {};
  for (const t of CYCLOPS_BONUS_ITEM_TIERS) {
    itemsByTier[t] = (gd.shopItemsByTier[t] || []).filter((id) => m.itemPool.canGain(id));
  }
  for (let i = 0; i < 10; i++) {
    // 干员：按品阶权重选 tier，再从该 tier 有余额的干员中均匀抽
    const tier = weightedTier(rng, tierPairs);
    const chessId = ps.pool.roll(rng, { maxTier: 6, filter: (cid, e) => e.tier === tier })
      || ps.pool.roll(rng, { maxTier: 6 });
    // 装备：2-5 阶均匀
    const tiers = Object.keys(itemsByTier).map(Number).filter((t) => itemsByTier[t].length);
    const itTier = tiers.length ? tiers[Math.floor(rng() * tiers.length)] : null;
    const list = itTier ? itemsByTier[itTier] : [];
    const itemId = list.length ? list[Math.floor(rng() * list.length)] : null;
    if (chessId && itemId) pool.push({ chessId, itemId });
  }
  return pool;
}

function weightedTier(rng, pairs) {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let r = rng() * total;
  for (const [t, w] of pairs) { r -= w; if (r < 0) return t; }
  return pairs[pairs.length - 1][0];
}

/**
 * 选秀选取顺序：LP 升序（低者先选），同 LP 按座位。
 * @param {Array<object>} alivePlayers
 */
export function cyclopsDraftOrder(alivePlayers) {
  return alivePlayers.slice().sort((a, b) => (a.lp - b.lp) || (a.seat - b.seat));
}

// ------------------------------------------------------------------------------------------------------------------
// 馈赠效果应用（prep 侧可执行的核心部分）
//
// 盟约馈赠写入 EffectRef，由独立 cyclops 战斗模块消费；干员和装备走既有获取入口。
// 经济、装备、战绩和赌徒的持续效果在真实战斗结算时执行。
// 通用盟约由用户选择，超时自动选择时回退至当前最高层盟约。
// 战斗效果由 server/sim/content/cyclops.js 消费；经济与回合效果由本模块的结算函数消费。

/** 盟约族 hex id → bondId。 */
const HEX_BOND = {
  cyc_victoria: 'victoriaShip', cyc_sargon: 'sargonShip', cyc_yan: 'yanShip', cyc_kjerag: 'kjeragShip',
  cyc_laterano: 'lateranoShip', cyc_egir: 'egirShip', cyc_siracusa: 'siracusaShip', cyc_kazimierz: 'kazimierzShip',
};

/** 盟约族的层数赠送量。 */
const BOND_HEX_LAYERS = { silver: 20, gold: 60, prismatic: 120 };

/**
 * 应用一个馈赠卡到玩家（prep 侧；由 MatchPhases._cyclopsPick 调用）。
 * @param {object} m Match
 * @param {object} ps PlayerState
 * @param {{ id, family, quality, name, levelName }} card
 */
export function applyCyclopsHex(m, ps, card) {
  if (!m.isCyclops || !card || !card.id || !cyclopsHexAvailable(card, ps)) return false;
  normalizeCyclopsGiftHooks(ps);
  const q = card.quality;
  const gd = ps.gd || m.gd;

  // --- 盟约族：加层 + 战斗增益 + 干员/装备赠送 ---
  const bondId = HEX_BOND[card.id];
  if (bondId && gd.bond(bondId)) {
    ps.addLayers(bondId, BOND_HEX_LAYERS[q] || 30, { requireActive: false, reason: 'cyclops' });
    // 战斗数值统一由 cyclops content 按当前层数实时计算。
    // 展示：所有已选馈赠一律进 effects 侧栏（iconKind 'cyclops'，logo 按族、描边按品质）
    ps.effects.push({
      id: `cyclops:${card.id}#${m.nextUid()}`, key: `choice:${card.id}`, name: card.levelName || card.name,
      desc: card.desc || '', iconKind: 'cyclops', iconId: card.logo || card.id, battle: true,
      data: { effectId: card.id, tacticKind: 'cyclops', quality: q, family: card.family },
      counter: CYCLOPS_HEX_QUALITIES.indexOf(q) + 1,
      counterText: `${q === 'silver' ? '银' : q === 'gold' ? '金' : '彩'}阶馈赠`,
      params: {},
    });
    normalizeCyclopsGiftHooks(ps);
    ps.dirty();
    // 干员 / 装备赠送
    if (q === 'silver') {
      _grantRandomBondChess(m, ps, bondId, 1, 1, 3);
      if (card.id === 'cyc_victoria') _grantRandomItem(m, ps, 1, 1);
    } else if (q === 'prismatic') {
      _grantRandomBondChess(m, ps, bondId, 1, 4);
      if (card.id === 'cyc_victoria') _grantRandomItem(m, ps, 1, 5);
    }
    cyclopsVictoriaRewards(m, ps);
    ps.recompute();
    return;
  }

  // --- 经济运营族：立即金币 + 每回合收入 EffectRef ---
  if (card.id === 'cyc_economy') {
    const table = { silver: { now: 0, per: 1, win: 1 }, gold: { now: 15, per: 3, win: 0 }, prismatic: { now: 30, per: 6, win: 0 } }[q] || { now: 0, per: 1, win: 0 };
    if (table.now) ps.addFunds(table.now, { reason: 'cyclops' });
    _addCyclopsHook(m, ps, card, { roundIncome: table.per, winBonus: table.win, ...(q === 'prismatic' ? { interestCap: 8 } : {}) });
    return;
  }

  // --- 存款利息族：利息上限/结算强化 ---
  if (card.id === 'cyc_interest') {
    const table = { silver: { capBonus: 1 }, gold: { interestCap: 8, percent: 0.025, percentCap: 3 }, prismatic: { interestCap: 10, percent: 0.05, percentCap: 8 } }[q] || {};
    _addCyclopsHook(m, ps, card, table);
    return;
  }

  // --- 调度网络族：银阶阶段返还、金阶定向征召、彩阶概率免单 ---
  if (card.id === 'cyc_refresh') {
    const table = refreshGiftParams(q);
    _addCyclopsHook(m, ps, card, table);
    return;
  }

  // --- 战斗赏金族：击杀/胜利掉金 ---
  if (card.id === 'cyc_bounty') {
    const table = { silver: { killChance: 0.1, coinCap: 5 }, gold: { winBase: 4, winEvery: 5, winCap: 8 }, prismatic: { killChance: 1, eliteX2: true, coinCap: 15 } }[q] || {};
    _addCyclopsHook(m, ps, card, table);
    return;
  }

  // --- 战绩滚雪球族：连胜/连败金币 ---
  if (card.id === 'cyc_streak') {
    const table = { silver: { lose: 1 }, gold: { comeback: 8 }, prismatic: { lose: 4, win: 3, stackCap: 5, equipmentCap: 2 } }[q] || {};
    _addCyclopsHook(m, ps, card, table);
    return;
  }

  // --- 绝境赌徒族：立即代价换收益 ---
  if (card.id === 'cyc_risk') {
    if (q === 'silver') {
      ps.addFunds(10, { reason: 'cyclops' });
      const bonds = gd.bondIds.filter((b) => gd.bond(b)?.isCore);
      if (bonds.length) ps.addLayers(bonds[Math.floor(m.rngMeta() * bonds.length)], 3, { requireActive: false, reason: 'cyclops' });
      _addCyclopsHook(m, ps, card, { drainRounds: 3, drainAmount: 1 });
    } else if (q === 'gold') {
      // Current prices start at 2: use tier, not the nonexistent 1-coin price.
      let sacrificed = 0;
      for (let i = 0; i < ps.hand.length; i++) {
        const p = ps.hand[i];
        const rec = p?.kind === 'chess' ? gd.chess(p.id) : null;
        if (sacrificed < 3 && rec?.tier === 1 && !rec.isGolden) {
          cyclopsSacrificePiece(ps, ps.find(p.uid));
          ps.addFunds(3, { reason: 'cyclops' });
          sacrificed++;
        }
      }
      _addCyclopsHook(m, ps, card, { sacrificeUntil: m.round + 2 });
    } else {
      ps.lp -= 6;
      ps.addFunds(25, { reason: 'cyclops' });
      const target = gd.bondIds.filter(b => gd.bond(b)?.isCore && ps.bonds[b]?.active)
        .sort((a, b) => (ps.layers[b] || 0) - (ps.layers[a] || 0))[0];
      if (target) ps.addLayers(target, 8, { requireActive: false, reason: 'cyclops' });
      _grantRandomItem(m, ps, 1, 4 + Math.floor(m.rngMeta() * 2));
      _addCyclopsHook(m, ps, card, { bloodTrade: true, bloodUses: 0, bloodMax: 3, bloodMin: 4, bloodFunds: 12 });
    }
    return;
  }

  // --- 装备整备族 ---
  if (card.id === 'cyc_morph') {
    if (q === 'silver') _addCyclopsHook(m, ps, card, { splash: 0.05 });
    else if (q === 'gold') _addCyclopsHook(m, ps, card, { reforge: true, upgradeChance: 0.25, reforgeLimit: 2, maxTier: 5 });
    else {
      // 复制场上品质最高的 1 件装备
      let best = null;
      for (const p of ps.board.values()) {
        for (const it of p.items || []) {
          const rec = gd.item(it.id);
          if (rec?.itemType === 'EQUIP' && !rec.isGolden && rec.tier >= 1 && rec.tier <= 5 && (!best || rec.tier > best.tier)) best = rec;
        }
      }
      if (best) ps.acquireItem(best.id, { source: 'cyclops' });
      _addCyclopsHook(m, ps, card, { copyEquipped: true, copyEvery: 2, copyMax: 3, copyGiven: 0, copyRounds: 0, maxTier: 5 });
    }
    return;
  }

  // --- 通用盟约徽记族：选定当前层数最高的盟约 ---
  if (card.id === 'cyc_universal') {
    const layers = Object.entries(ps.layers).filter(([b, n]) => gd.bond(b) && n > 0).sort((a, b) => b[1] - a[1]);
    const target = card.bondId && gd.bond(card.bondId) ? card.bondId : layers[0] ? layers[0][0] : gd.bondIds[0];
    if (target) {
      const add = { silver: 18, gold: 40, prismatic: 80 }[q] || 18;
      ps.addLayers(target, add, { requireActive: false, reason: 'cyclops' });
      if (q === 'prismatic') {
        _grantRandomBondChess(m, ps, target, 1, 1, 4);
        _addCyclopsHook(m, ps, card, { perRoundLayers: 2, bondId: target, layerMultiplier: 1.5 });
      } else {
        const countBonus = q === 'gold' ? 1 : 0;
        if (countBonus) ps.bondCountBonus[target] = (ps.bondCountBonus[target] || 0) + countBonus;
        _addCyclopsHook(m, ps, card, { bondId: target, layersAdded: add, countBonus, layerMultiplier: q === 'gold' ? 1.3 : 1.2 });
        if (countBonus) ps.recompute();
      }
    }
    return;
  }
}

/** 挂一个 cyclops 经济/战斗钩子 EffectRef（非战斗效果，标记 battle:false）。 */
function _addCyclopsHook(m, ps, card, params) {
  const q = card.quality;
  ps.effects.push({
    id: `cyclops:hook:${card.id}#${m.nextUid()}`, key: `effect:cyclops_${card.family}`, name: card.levelName || card.name,
    desc: card.desc || '', iconKind: 'cyclops', iconId: card.logo || card.id, battle: false,
    counter: CYCLOPS_HEX_QUALITIES.indexOf(q) + 1,
    counterText: `${q === 'silver' ? '银' : q === 'gold' ? '金' : '彩'}阶馈赠`,
    params: { quality: q, ...params },
    data: { effectId: card.id, tacticKind: 'cyclops', family: card.family, quality: q },
  });
  normalizeCyclopsGiftHooks(ps);
  ps.dirty();
}

export function cyclopsHooks(ps, id = null) {
  const out = [];
  for (const e of normalizeCyclopsGiftHooks(ps)) isolateCyclops(ps, 'hooks:filter', () => { if (!id || e.data.effectId === id) out.push(e); });
  return out;
}

const GIFT_RULES = 3;
const REFRESH_GIFT_RULES = 3;
const count = (n, cap = Number.MAX_SAFE_INTEGER) => Number.isFinite(n) ? Math.min(cap, Math.max(0, Math.trunc(n))) : 0;

/** Update old saved parameters before display, income or simulation; already paid rewards are never reclaimed. */
export function normalizeCyclopsGiftHooks(ps) {
  if (!ps.m?.isCyclops) return [];
  const refs = [];
  let changed = false, bondsChanged = false;
  for (const e of ps.effects) isolateCyclops(ps, 'normalize:effect', () => {
    if (!(e.data?.tacticKind === 'cyclops' || e.data?.effectId?.startsWith('cyc_'))) return;
    const old = e.params || {}, q = e.data?.quality || old.quality, id = e.data.effectId;
    if (!CYCLOPS_HEX_QUALITIES.includes(q)) return;
    if (old.giftRules === GIFT_RULES) { refs.push(e); return; }
    // Finish fallible presentation construction before publishing normalized parameters.
    const card = cyclopsHexCard(cyclopsHexes(ps.gd?.raw).find(h => h.id === id), q);
    let p;
    let bonusUpdate = null;
    switch (id) {
      case 'cyc_economy': p = { roundIncome: q === 'silver' ? 1 : q === 'gold' ? 3 : 6, winBonus: q === 'silver' ? 1 : 0, ...(q === 'prismatic' ? { interestCap: 8 } : {}) }; break;
      case 'cyc_interest': p = { silver: { capBonus: 1 }, gold: { interestCap: 8, percent: 0.025, percentCap: 3 }, prismatic: { interestCap: 10, percent: 0.05, percentCap: 8 } }[q]; break;
      case 'cyc_refresh': p = { ...refreshGiftParams(q), paidRound: old.paidRound, roundPaid: count(old.roundPaid, 3), rebated: !!old.rebated, paidRefreshes: count(old.paidRefreshes), recruitRound: old.recruitRound, roundRecruits: count(old.roundRecruits, 2) }; break;
      case 'cyc_bounty': p = { silver: { killChance: 0.1, coinCap: 5 }, gold: { winBase: 4, winEvery: 5, winCap: 8 }, prismatic: { killChance: 1, eliteX2: true, coinCap: 15 } }[q]; break;
      case 'cyc_streak': p = { ...(q === 'silver' ? { lose: 1 } : q === 'gold' ? { comeback: 8 } : { lose: 4, win: 3, stackCap: 5, equipmentCap: 2 }), winStacks: count(old.winStacks, 5), equipmentGiven: count(old.equipmentGiven, 2) }; break;
      case 'cyc_risk': p = q === 'silver' ? { drainRounds: count(old.drainRounds, 3), drainAmount: 1 } : q === 'gold' ? { sacrificeUntil: old.sacrificeUntil, usedRound: old.usedRound, sacrificeMul: 2, sacrificeCap: 8 } : { bloodTrade: true, bloodUses: count(old.bloodUses, 3), bloodMax: 3, bloodMin: 4, bloodFunds: 12, usedRound: old.usedRound }; break;
      case 'cyc_morph': p = q === 'silver' ? { splash: 0.05 } : q === 'gold' ? { reforge: true, upgradeChance: 0.25, reforgeLimit: 2, maxTier: 5 } : { copyEquipped: true, copyEvery: 2, copyMax: 3, copyGiven: count(old.copyGiven, 3), copyRounds: count(old.copyRounds, 2), maxTier: 5 }; break;
      case 'cyc_universal': {
        const bonus = q === 'gold' ? 1 : 0;
        if (old.bondId && count(old.countBonus) !== bonus) {
          bonusUpdate = { bondId: old.bondId, value: Math.max(0, (ps.bondCountBonus?.[old.bondId] || 0) - count(old.countBonus) + bonus) };
        }
        p = { bondId: old.bondId, layersAdded: old.layersAdded, countBonus: bonus, requireMember: true, layerMultiplier: q === 'silver' ? 1.2 : q === 'gold' ? 1.3 : 1.5, ...(q === 'prismatic' ? { perRoundLayers: 2 } : {}) };
        if (old.bondId) p[`remainder:${old.bondId}`] = Math.max(0, Math.min(0.999999999, Number(old[`remainder:${old.bondId}`]) || 0));
        break;
      }
      case 'cyc_victoria': p = { ...old, rewardStartLayers: Number.isFinite(old.rewardStartLayers) ? old.rewardStartLayers : Math.max(0, ps.layers?.victoriaShip || 0), rewardPaid: count(old.rewardPaid ?? old.paid, q === 'gold' ? 3 : 5), rewardRound: old.rewardRound }; break;
      default: p = { ...old }; break;
    }
    const params = { ...p, quality: q, giftRules: GIFT_RULES };
    if (card) { e.name = card.levelName || card.name; e.desc = card.desc; }
    if (bonusUpdate) {
      ps.bondCountBonus ||= {};
      ps.bondCountBonus[bonusUpdate.bondId] = bonusUpdate.value;
      bondsChanged = true;
    }
    e.params = params;
    changed = true;
    refs.push(e);
  });
  if (bondsChanged) isolateCyclops(ps, 'normalize:recompute', () => ps.recompute());
  if (changed) isolateCyclops(ps, 'normalize:dirty', () => ps.dirty());
  return refs;
}

function refreshGiftParams(quality) {
  const params = {
    silver: { rebateEvery: 3 },
    gold: { recruitEvery: 5, recruitLimit: 2 },
    prismatic: { freeChance: 0.7 },
  }[quality] || {};
  return { refreshRules: REFRESH_GIFT_RULES, ...params };
}

/** Migrate selected gifts when first used, including restored matches with the old silver/gold free-chance params. */
export function cyclopsRefreshHooks(ps) {
  return cyclopsHooks(ps, 'cyc_refresh');
}

/** Only genuinely paid manual refreshes advance these counters; free rounds and stored free uses do not. */
export function cyclopsPaidRefreshRewards(m, ps, price, hooks = cyclopsRefreshHooks(ps)) {
  if (!m.isCyclops || !(price > 0)) return;
  for (const e of hooks) isolateCyclops(ps, 'paidRefresh:gift', () => {
    const p = e.params || {};
    if (p.rebateEvery > 0) {
      if (p.paidRound !== m.round) {
        p.paidRound = m.round;
        p.roundPaid = 0;
        p.rebated = false;
      }
      p.roundPaid = Math.min(p.rebateEvery, (Number.isFinite(p.roundPaid) ? Math.max(0, Math.trunc(p.roundPaid)) : 0) + 1);
      if (!p.rebated && p.roundPaid >= p.rebateEvery) {
        p.rebated = true;
        ps.addFunds(1, { reason: 'cyclops_refresh_rebate' });
      }
    }
    if (p.recruitEvery > 0) {
      p.paidRefreshes = Math.min(Number.MAX_SAFE_INTEGER, count(p.paidRefreshes) + 1);
      if (p.recruitRound !== m.round) { p.recruitRound = m.round; p.roundRecruits = 0; }
      if (p.paidRefreshes < p.recruitEvery || p.roundRecruits >= p.recruitLimit) return;
      const gd = ps.gd;
      const bond = gd.bondIds.filter(id => ps.bonds[id]?.active)
        .sort((a, b) => (ps.layers[b] || 0) - (ps.layers[a] || 0))[0];
      const eligible = id => { const c = gd.chess(id); return c && c.tier >= 1 && c.tier <= 3; };
      const id = (bond && ps.pool.roll(m.rngMeta, {
        maxTier: 3, filter: id => eligible(id) && gd.chess(id).bonds?.includes(bond),
      })) || ps.pool.roll(m.rngMeta, { maxTier: 3, filter: eligible });
      // Exhausted pools retain the earned reward until an eligible copy becomes available.
      if (id) {
        // Reserve this entitlement before a call that may commit and then throw. No ambiguous replay.
        p.paidRefreshes -= p.recruitEvery;
        p.roundRecruits++;
        if (!ps.acquireChess(id, { source: 'cyclops' })) { p.paidRefreshes += p.recruitEvery; p.roundRecruits--; }
      }
    }
  }, m);
}

/** 商店刷新优惠统一抽取一次；单条、保底与叠加后的免费概率均不超过 70%。 */
export function cyclopsRefreshChance(hooks) {
  let combined = 0;
  for (const e of hooks) {
    const p = e.params || {};
    // 兼容旧存档的永久免费标记，但不再生成旧 extraChance 的免费次数。
    const base = p.refreshFree ? 0.7 : Math.max(0, Number(p.freeChance) || 0);
    if (!(base > 0)) continue;
    const misses = Number.isFinite(p.misses) ? Math.max(0, Math.trunc(p.misses)) : 0;
    const rawPity = Number(p.pity);
    const pity = Number.isFinite(rawPity) ? Math.max(0, rawPity) : 0;
    const chance = Math.min(0.7, base + misses * pity);
    combined += (1 - combined) * chance;
  }
  return Math.min(0.7, combined);
}

export function cyclopsLayerGain(ps, bondId, n) {
  let value = n;
  for (const e of cyclopsHooks(ps, 'cyc_universal')) isolateCyclops(ps, 'layerGain:modifier', () => {
    if (e.params.bondId !== bondId || !(e.params.layerMultiplier > 1)) return;
    const key = `remainder:${bondId}`;
    const extra = n * (e.params.layerMultiplier - 1) + (e.params[key] || 0);
    const whole = Math.floor(extra + 1e-9);
    e.params[key] = extra - whole;
    value += whole;
  });
  return value;
}

function cyclopsGrantExclusive(m, ps) {
  const list = Object.values(ps.gd.raw.items || {}).filter(it => it.itemType === 'EQUIP' && !it.isGolden && it.tier === 6 && !it.shopExcluded && m.itemPool.canGain(it.id));
  if (list.length) return ps.acquireItem(list[Math.floor(m.rngMeta() * list.length)].id, { source: 'cyclops', deferMerge: true });
  return _grantRandomItem(m, ps, 1, 5);
}

export function cyclopsVictoriaRewards(m, ps) {
  if (!m.isCyclops) return;
  for (const e of cyclopsHooks(ps, 'cyc_victoria')) isolateCyclops(ps, 'victoria:gift', () => {
    const q = e.data.quality;
    const layers = ps.layers.victoriaShip || 0;
    if (q === 'silver') return;
    const p = e.params, limit = q === 'gold' ? 3 : 5;
    const due = Math.min(limit, Math.floor(Math.max(0, layers - p.rewardStartLayers) / (q === 'gold' ? 100 : 40)));
    if (p.rewardPaid >= due || p.rewardRound === m.round) return;
    const oldRound = p.rewardRound;
    // Ambiguous post-commit errors must not offer the same reward again on the next layer event.
    p.rewardPaid++; p.rewardRound = m.round;
    const awarded = q === 'gold' ? cyclopsGrantExclusive(m, ps) : _grantRandomItem(m, ps, 1, 2 + Math.floor(m.rngMeta() * 4));
    if (awarded) isolateCyclops(ps, 'victoria:dirty', () => ps.dirty(), m);
    else { p.rewardPaid--; p.rewardRound = oldRound; }
  }, m);
}

function cyclopsSacrificePiece(ps, loc) {
  if (!loc) return;
  const piece = loc.piece;
  ps._detach(loc);
  ps.removeTokensOf(piece.uid);
  for (const it of piece.items || []) ps.stow(it, { allowTemp: true });
  piece.items = [];
  ps.returnCopies(piece);
}

export function cyclopsRiskAction(m, ps, uid = null) {
  const gate = ps._gate(); if (gate) return gate;
  const refs = cyclopsHooks(ps, 'cyc_risk');
  const ref = refs.find(e => uid == null ? e.params.bloodTrade : e.params.sacrificeUntil >= m.round);
  if (!ref || ref.params.usedRound === m.round) return { ok: false, error: 'BAD_TARGET' };
  if (uid == null) {
    const cost = Math.max(ref.params.bloodMin, Math.ceil(ps.lp * 0.1));
    if (ps.lp <= cost || ref.params.bloodUses >= ref.params.bloodMax) return { ok: false, error: 'BAD_TARGET' };
    ps.lp -= cost;
    ps.addFunds(ref.params.bloodFunds, { reason: 'cyclops' });
    ref.params.bloodUses++;
  } else {
    const loc = ps.find(uid);
    if (!loc || loc.piece.kind !== 'chess' || !['hand', 'temp', 'board'].includes(loc.area)) return { ok: false, error: 'BAD_TARGET' };
    const gain = Math.min(ref.params.sacrificeCap, ps.gd.chessPrice(loc.piece.id) * ref.params.sacrificeMul);
    cyclopsSacrificePiece(ps, loc);
    ps.addFunds(gain, { reason: 'cyclops' });
    ps.checkItemMerges();
  }
  ref.params.usedRound = m.round;
  ps.recompute(); m.markPublic();
  return { ok: true };
}

/** 每场真实个人战斗只结算一次，由 settle 的回合幂等锁保护。 */
export function settleCyclopsHexes(m, ps, result, won, previousStreak = 0) {
  if (!m.isCyclops || result.synthetic) return;
  const bank = ps.funds;
  const hooks = cyclopsHooks(ps);
  for (const e of hooks) isolateCyclops(ps, 'settle:remainder', () => {
    if (e.data.effectId !== 'cyc_universal') return;
    const p = e.params;
    const gained = result.layerGains?.[p.bondId] || 0;
    if (!(gained > 0) || ps.layers[p.bondId] >= 999) return;
    const key = `remainder:${p.bondId}`, previous = p[key] || 0;
    const base = Math.ceil((gained - previous) / p.layerMultiplier - 1e-9);
    p[key] = Math.max(0, base * p.layerMultiplier + previous - gained);
  }, m);
  for (const e of hooks) isolateCyclops(ps, 'settle:gift', () => {
    const p = e.params || {};
    switch (e.data.effectId) {
      case 'cyc_economy': ps.addFunds((p.roundIncome || 0) + (won ? p.winBonus || 0 : 0), { reason: 'cyclops' }); break;
      case 'cyc_interest': if (p.percent) ps.addFunds(Math.min(Math.floor(bank * p.percent), p.percentCap ?? Infinity), { reason: 'cyclops' }); break;
      case 'cyc_bounty': {
        const killed = Math.max(0, result.cyclopsKills?.cyc_bounty || 0);
        if (won && p.winEvery && killed > 0) ps.addFunds(Math.min(p.winCap, p.winBase + Math.floor(killed / p.winEvery)), { reason: 'cyclops' });
        break;
      }
      case 'cyc_streak': {
        if (isCyclopsBonusRound(m.round)) break;
        if (e.data.quality === 'prismatic') {
          if (ps.cyclopsStreak >= 2) {
            p.winStacks = Math.min(p.stackCap, p.winStacks + 1);
            isolateCyclops(ps, 'settle:streak:funds', () => ps.addFunds(p.win, { reason: 'cyclops' }), m);
          } else if (ps.cyclopsStreak <= -2) isolateCyclops(ps, 'settle:streak:funds', () => ps.addFunds(p.lose, { reason: 'cyclops' }), m);
          if (won && p.equipmentGiven < p.equipmentCap) {
            p.equipmentGiven++;
            if (!_grantRandomItem(m, ps, 1, 2 + Math.floor(m.rngMeta() * 3))) p.equipmentGiven--;
          }
        } else if (e.data.quality === 'gold') {
          if (won && previousStreak <= -2) ps.addFunds(p.comeback, { reason: 'cyclops' });
        } else if (ps.cyclopsStreak <= -2) ps.addFunds(p.lose, { reason: 'cyclops' });
        break;
      }
      case 'cyc_risk': if (p.drainRounds > 0) { ps.lp = Math.max(1, ps.lp - p.drainAmount); p.drainRounds--; } break;
      case 'cyc_universal': if (p.perRoundLayers) grantLayersVerified(m, ps, p.bondId, p.perRoundLayers, { reason: 'cyclops' }, { source: 'cyclops', hook: 'settle:universal' }); break;
      case 'cyc_morph': {
        if (p.reforge) {
          const eligible = [];
          for (const it of [...ps.hand, ...ps.temp]) isolateCyclops(ps, 'settle:reforge:eligible', () => {
            const rec = it?.kind === 'item' ? ps.gd.item(it.id) : null;
            if (rec?.itemType === 'EQUIP' && rec.tier < p.maxTier && !rec.kind?.startsWith('consume_on_equip')) eligible.push(it);
          });
          m.rngMeta.shuffle(eligible);
          for (const item of eligible.slice(0, p.reforgeLimit)) isolateCyclops(ps, 'settle:reforge:item', () => {
            const rec = ps.gd.item(item.id);
            if (!rec || rec.itemType !== 'EQUIP' || rec.kind?.startsWith('consume_on_equip')) return;
            const tier = Math.min(p.maxTier, rec.tier + (m.rngMeta() < p.upgradeChance ? 1 : 0));
            const candidates = (ps.gd.shopItemsByTier[tier] || []).map(id => {
              const base = ps.gd.item(id);
              return rec.isGolden ? base?.goldenId || base?.upgradeChessId : id;
            }).filter(id => { const candidate = ps.gd.item(id); return candidate?.itemType === 'EQUIP' && !candidate.kind?.startsWith('consume_on_equip') && !!candidate.isGolden === !!rec.isGolden && m.itemPool.canGain(id); });
            if (candidates.length) item.id = candidates[Math.floor(m.rngMeta() * candidates.length)];
          }, m);
        }
        if (p.copyEquipped) {
          p.copyRounds = Math.min(p.copyEvery, p.copyRounds + 1);
          if (p.copyRounds < p.copyEvery || p.copyGiven >= p.copyMax) break;
          const items = [];
          for (const unit of ps.board.values()) isolateCyclops(ps, 'settle:copy:unit', () => {
            if (unit?.kind !== 'chess') return;
            for (const it of unit.items || []) isolateCyclops(ps, 'settle:copy:item', () => {
              const rec = ps.gd.item(it.id);
              if (rec?.itemType === 'EQUIP' && !rec.isGolden && rec.tier >= 2 && rec.tier <= p.maxTier && !rec.kind?.startsWith('consume_on_equip')) items.push(it);
            }, m);
          }, m);
          if (items.length) {
            const id = items[Math.floor(m.rngMeta() * items.length)].id, oldRounds = p.copyRounds;
            p.copyGiven++; p.copyRounds = 0;
            if (!ps.acquireItem(id, { source: 'cyclops', deferMerge: true })) { p.copyGiven--; p.copyRounds = oldRounds; }
          }
        }
        break;
      }
    }
  }, m);
  // 击杀永久成长来自模拟器逐次击杀事件，跨回合保留，达到上限后不再增长。
  for (const e of hooks) isolateCyclops(ps, 'settle:kills', () => {
    if (!['cyc_egir', 'cyc_laterano', 'cyc_siracusa'].includes(e.data.effectId)) return;
    const delta = result.cyclopsKills?.[e.data.effectId] || 0;
    if (delta) e.params.kills = Math.min(e.data.effectId === 'cyc_egir' ? 15 : 12, (e.params.kills || 0) + delta);
  }, m);
  isolateCyclops(ps, 'settle:victoria', () => cyclopsVictoriaRewards(m, ps), m);
  isolateCyclops(ps, 'settle:merges', () => ps.checkItemMerges(), m);
  isolateCyclops(ps, 'settle:dirty', () => ps.dirty(), m);
}

/** 从指定品阶范围赠送随机盟约干员。 */
function _grantRandomBondChess(m, ps, bondId, count = 1, minTier = 1, maxTier = 6) {
  const gd = ps.gd || m.gd;
  for (let i = 0; i < count; i++) {
    const id = ps.pool.roll(m.rngMeta, {
      maxTier,
      filter: (cid) => {
        const c = gd.chess(cid);
        return !!(c && Array.isArray(c.bonds) && c.bonds.includes(bondId) && c.tier >= minTier && c.tier <= maxTier);
      },
    });
    if (id) ps.acquireChess(id, { source: 'cyclops' });
  }
}

/** 赠送随机装备（lo..hi 阶）。 */
function _grantRandomItem(m, ps, count = 1, tier = 2) {
  const gd = ps.gd || m.gd;
  let awarded = 0;
  for (let i = 0; i < count; i++) {
    const list = (gd.shopItemsByTier[tier] || []).filter((id) => m.itemPool.canGain(id));
    if (!list.length) continue;
    const id = list[Math.floor(m.rngMeta() * list.length)];
    if (id && ps.acquireItem(id, { source: 'cyclops' })) awarded++;
  }
  return awarded;
}
