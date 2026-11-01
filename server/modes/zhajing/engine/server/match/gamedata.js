// server/match/gamedata.js — typed, defaulted view of data/*.json for the match engine.
//
// Every lookup is an own-property lookup (ids come from client intents) that never throws and returns null for
// unknown ids. Tunables come from data/config.json with the documented defaults (research 00-INDEX §2–§8) when a
// key is missing, so a partial data set (tests, data being regenerated) still yields a working match.
//
// No custom balance (DESIGN §14 corrections, research 08 §6): enemy numbers are the official ones — the PRTS
// per-round enemyScale table of data/config.json, the leader pool = bloodPoint per player alive at the fight's start
// (bossPoolShareOf). data/tuning.json only overrides result titles:
//   titles[titleId]                                                { stat?, rule? } merged over config.titles
// (the former enemyHpMul / enemyAtkMul / enemySpeedMul / bossHpMul / flyPlaceholders knobs were removed; a tuning file
// that still carries them is ignored).

import { getConfig, getMode } from '../data.js';
import { isShopItem } from '../sim/simdata.js';
import { standInRecord } from '../../shared/standIn.js';
import { zjBondView, zjEquipCombos } from '../../shared/zjBonds.js';

const own = (map, id) => (map && typeof map === 'object' && typeof id === 'string' && Object.hasOwn(map, id) && map[id] && typeof map[id] === 'object' ? map[id] : null);
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const posIntOr = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

export const DEFAULTS = Object.freeze({
  income: [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12, 12, 12, 12, 12],
  incomeCap: 12,
  chessPrice: { 1: 2, 2: 3, 3: 3, 4: 3, 5: 4, 6: 4 },
  sellPrice: 1,
  refreshPrice: 1,
  poolCopies: { 1: 12, 2: 14, 3: 18, 4: 16, 5: 8, 6: 5 },
  mergeCount: 3,
  goldenCopies: 3,
  itemMergeCount: 2,
  benchSize: 20,   // 用户 2026-10-11：待部署区翻倍（与 shared/constants.js 的 GEO.HAND_SIZE 一致；config economy.benchSize 优先）
  tempSize: 5,
  deployCap: 8,
  equipPerChess: 2,
  maxArtsPerRound: 2,
  rewardOffer: { count: 3, tierOffset: 1, maxTier: 6, price: 0 },
  upgradePrices: [5, 8, 11, 12, 13],
  maxShopLevel: 6,
  shopSlots: { 1: { chess: 3, item: 1 }, 2: { chess: 4, item: 1 }, 3: { chess: 4, item: 1 }, 4: { chess: 5, item: 1 }, 5: { chess: 5, item: 1 }, 6: { chess: 5, item: 1 } },
  defaultBandId: 'band_bldsk',
  defaultStartLp: 28,
  lpCapPerRound: 10,
  bossOvertimeAfter: 150,
  bossOvertimeDrainPerSec: 1,
  hiddenCore: { single: 350, multi: 1200, minTeamLpExclusive: 1, difficulties: ['NORMAL', 'HARD', 'ABYSS'] },
  dp: { init: 10, perSec: 1, max: 99 },
  unite: { maxHelpers: 2, relayBattlefield: false, templates: { 1: 'act1autochess_escaped_single', 2: 'act1autochess_escaped_multi' } },
  timers: { infoCheck: 25, bandDraft: 50, bandTurn: 30, battleCheck: 3, spFirst: 30, spTurn: 16 },
  bans: { FUNNY: { core: 0, addon: 1 }, NORMAL: { core: 3, addon: 4 }, HARD: { core: 3, addon: 4 }, ABYSS: { core: 3, addon: 4 }, ZHAJING: { core: 2, addon: 2 } },
  bandDraft: { skipsPerPlayer: 1, timeoutBandId: 'band_bldsk', duplicatesAllowed: false, simultaneous: false },
  leftoverFundsKeptByBands: ['band_cannot'],
});

/** Game seconds per real second of a battle (forced 2×): combat limits in data are real seconds (combatTimeLimit). */
export const COMBAT_TIME_SCALE = 2;

/**
 * Multiplier of bloodPoint[difficulty] for the shared leader pool (DESIGN §20.10, §25.13.4), from config bossHpScale —
 * each key from the mode's entry first, then the global one; the defaults are the current rule:
 *   solo   `solo` (1: the table value — one player's share);
 *   co-op  `perPlayer` true (the owner's decision of 2026-10-06, adopting PR #209 by @qingjingshenghuo): `coop` (1) × the
 *          players alive when the fight starts — bots and AI 托管 seats count, eliminated and departed seats do not —
 *          at most `aliveFull` (4); a count left out means a full team;
 *          `perPlayer` false: the fixed pool of 0.1.x (「保持固定血量」, restorable with `solo` 0.25): `coop` whatever the
 *          count, × min(alive, aliveFull) / aliveFull with `aliveScaling`.
 * @param {object|null|undefined} modeScale config.modes[modeId].bossHpScale
 * @param {object|null|undefined} cfgScale config.bossHpScale
 * @param {boolean} isSolo
 * @param {number} [aliveCount] alive players at the Final Assault / Hidden Core start (co-op)
 * @returns {number}
 */
export function bossPoolShareOf(modeScale, cfgScale, isSolo, aliveCount) {
  const ms = modeScale && typeof modeScale === 'object' ? modeScale : {};
  const cs = cfgScale && typeof cfgScale === 'object' ? cfgScale : {};
  const pick = (k, d) => (Number.isFinite(ms[k]) && ms[k] > 0 ? ms[k] : Number.isFinite(cs[k]) && cs[k] > 0 ? cs[k] : d);
  const flag = (k, d) => (typeof ms[k] === 'boolean' ? ms[k] : typeof cs[k] === 'boolean' ? cs[k] : d);
  if (isSolo) return pick('solo', 1);
  const full = Math.max(1, Math.floor(pick('aliveFull', 4)));
  const n = Number(aliveCount);
  const alive = Number.isFinite(n) && n >= 1 ? Math.min(full, Math.floor(n)) : full;
  if (flag('perPlayer', true)) return pick('coop', 1) * alive;
  return pick('coop', 1) * (flag('aliveScaling', false) ? alive / full : 1);
}

/** Strip the _a/_b suffix of an item id (the registry key of an item family). */
export const itemKey = (id) => (typeof id === 'string' ? id.replace(/_[ab]$/, '') : '');

/**
 * 隐藏规则（用户 2026-10-12）里「带核心盟约的传说惊变」的目标概率（%）：config modes[*].jibian.noCoreBondLegendWeight，默认 30。
 */
function noCoreBondLegendWeight(j) {
  const v = numOr(j && j.noCoreBondLegendWeight, 30);
  return Math.max(0, Math.min(100, Math.round(v)));
}

export class GameData {
  /**
   * @param {Readonly<Record<string, any>>} data server/data.js getData() (may be partial)
   * @param {string} modeId e.g. 'mode_multi_hard'
   */
  constructor(data, modeId) {
    this.raw = data && typeof data === 'object' ? data : {};
    this.config = getConfig(this.raw) || {};
    this.modeId = modeId;
    this.mode = getMode(modeId, this.raw) || {};
    this.economy = this.config.economy && typeof this.config.economy === 'object' ? this.config.economy : {};
    const chess = this.raw.chess && typeof this.raw.chess === 'object' ? this.raw.chess : {};
    this._chess = chess;
    this._items = this.raw.items && typeof this.raw.items === 'object' ? this.raw.items : {};
    this._bonds = this.raw.bonds && typeof this.raw.bonds === 'object' ? this.raw.bonds : {};
    /**
     * visible, shop-eligible base (normal) chess ids. 炸惊模拟 (mode difficulty ZHAJING) uses its own roster instead: the
     * `zhajing: true` records generated from 《卫戍协议-干员名单》, which carry `visible: false` so every other mode's
     * filter keeps excluding them.
     */
    const zhajing = String(this.mode && this.mode.difficulty) === 'ZHAJING' || /zhajing/i.test(String(modeId));
    this.zhajing = zhajing;
    /**
     * 炸惊模拟的盟约覆盖层 (shared/zjBonds.js)：`data/bonds.json` 里带 `zj` 块的盟约，在炸惊下换成合并后的记录
     * （阈值、数值袋、buff、文案…都可能是炸惊专用）。只换 `this._bonds`，`this.raw.bonds` 保持原样，所以其它模式
     * 以及任何直接读原始数据的地方都不受影响。战斗模拟侧另有一份注入（sim 的数据源），两边走同一个合并函数。
     */
    // 装备组合表要先从带 `zj` 块的原始记录里取，合并之后 `zj` 就被丢掉了（bondsMeta.pieceBonds 用它）
    this.zjCombos = zhajing ? zjEquipCombos(this._bonds) : null;
    // 炸惊：合并覆盖块；其它难度：只把 `zj` 键剥掉（记录逐字节等于改动前，也不会把覆盖块漏给客户端）
    this._bonds = zjBondView(this._bonds, { merge: zhajing });
    /**
     * 炸惊模拟 (config.modes[*].diyEnabled === false): the 自选编队 never reaches this difficulty. Its roster is the one
     * above and a 自选 piece is composed outside it, so the seat's picks are ignored outright (player/diy.js setDiy) and
     * nothing of them reaches the shop, the reward offers or `ps.gd`. The 干员调配 screen states it next to its 炸惊
     * switch. Every other mode leaves `diyEnabled` unset and keeps the 自选编队.
     */
    this.diyDisabled = this.mode.diyEnabled === false;
    /**
     * ★ 2026-10-20（owner 反馈「至简会卖3块」）：卫戍特质 `SERVER_CHESS_PRICE` 决定「购买价格为1」，
     *   但 chessPrice() 原来只读 mode.chessPrice / 记录自带 `price`，所以至简（记录 price=3）、
     *   红豆（price=2）依旧按原价卖。这里把「卡片级硬价格」建一张表，chessPrice() 里最高优先级返回。
     */
    this._garrisonPrice = new Map();
    {
      const gr = this.raw.garrisons && typeof this.raw.garrisons === 'object' ? this.raw.garrisons : {};
      for (const cid of Object.keys(chess)) {
        const gids = chess[cid] && Array.isArray(chess[cid].garrisonIds) ? chess[cid].garrisonIds : null;
        if (!gids || !gids.length) continue;
        for (const gid of gids) {
          const g = gr[gid];
          const v = g && g.effectKey === 'SERVER_CHESS_PRICE' ? g.bb && g.bb.price : null;
          if (Number.isFinite(v) && v >= 0) { this._garrisonPrice.set(cid, v); break; }
        }
      }
    }
    this.visibleChess = Object.keys(chess).filter((id) => {
      const c = chess[id];
      // ★ 2026-10-20（owner）：重岳只能由「祀」策略发放，不进卡池 / 商店。
      //   grantOnly 的记录不进 visibleChess ⇒ pool.js 的卡池、刷新、道具商店都拿不到它；
      //   策略发放走 grant(..., { requirePool: false })，不经过这里，所以照常能拿到。
      if (!c || c.isGolden || c.isDiy || c.isHidden || c.grantOnly === true || !Number.isInteger(c.tier)) return false;
      return zhajing ? c.zhajing === true : (c.visible === true && c.zhajing !== true);
    }).sort();
    /**
     * Shop item ids by tier (sim/simdata.js isShopItem: normal EQUIP, not hidden, not effect-only — the special
     * 维式重锤 and 突变细胞 are never sold). Every "shop item" draw uses it: the shop item slot (pool.js), the 道具补给 /
     * 机密商店 cards (choices.js) and the shop-eligible item pools (Match.rollItemId).
     */
    this.shopItemsByTier = {};
    for (const [id, it] of Object.entries(this._items)) {
      if (!isShopItem(it)) continue;
      // ★ 2026-10-23（owner）：炸惊专属装备（S.E.E.S 袖章、谜の假面）不出现在普通/终极商店
      if (it.zjOnly === true && !zhajing) continue;
      (this.shopItemsByTier[it.tier] ||= []).push(id);
    }
    for (const k of Object.keys(this.shopItemsByTier)) this.shopItemsByTier[k].sort();
    this.bondIds = Object.keys(this._bonds).sort((a, b) => (numOr(this._bonds[a].identifier, 99) - numOr(this._bonds[b].identifier, 99)) || (a < b ? -1 : 1));
    this.modeInactiveBonds = new Set(Array.isArray(this.mode.inactiveBondIds) ? this.mode.inactiveBondIds : []);
    /** bandBondIds memo */
    this._bandBonds = new Map();
    this.inactiveEnemies = new Set(Array.isArray(this.mode.inactiveEnemyKeys) ? this.mode.inactiveEnemyKeys : []);
    /** data/tuning.json (titles only, see the header) */
    this.tuning = this.raw.tuning && typeof this.raw.tuning === 'object' ? this.raw.tuning : {};
    /** standIn memo: chess id → composed 补位 record | null */
    this._standIns = new Map();
  }

  /**
   * Leader HP pool multiplier — always 1 (no custom balance). Kept for callers written against the old tuning layer
   * (finalAssault.bossPoolHp); use `bossPoolHp` / `bossPoolShare` for the official pool.
   * @deprecated
   */
  bossHpMul(bossId) { // eslint-disable-line no-unused-vars
    return 1;
  }

  /**
   * Shared leader HP pool (DESIGN §20.10, §25.13.4): ONE pool for every boss field of the match (official tip "最终攻势中，
   * 所有人将一起对敌方领袖造成伤害"; the mirrored copies of a pair field share it — notice 5114 "两侧的敌方领袖共享生命值
   * （敌方领袖的总生命值不变）", which is about those copies). Size = bloodPoint[difficulty] × bossPoolShare: the table value
   * per player alive when the fight starts (the owner's decision of 2026-10-06, PR #209; it replaces the fixed pool of
   * 「保持固定血量」, which config bossHpScale restores — bossPoolShareOf); `aliveCount` omitted ⇒ a full team. Leaders are
   * never scaled by enemyScale ("领袖单位于服务器的生命值加成不受上述加成影响").
   * @param {string} bossId
   * @param {number} [aliveCount] alive players at the Final Assault / Hidden Core start (co-op)
   * @returns {number}
   */
  bossPoolHp(bossId, aliveCount, opts = {}) {
    const boss = this.boss(bossId);
    const diff = this.bloodPointDiff();
    let base = boss && boss.bloodPoint && Number.isFinite(boss.bloodPoint[diff]) ? boss.bloodPoint[diff] : null;
    if (base == null && boss && boss.bloodPoint) base = Object.values(boss.bloodPoint).find((v) => Number.isFinite(v)) ?? null;
    if (base == null) base = 500000;
    // ★ 2026-10-23（owner）：隐秘核心的 Boss 血量单独翻倍（mode.hiddenBossHpMul，默认 2）。
    const hiddenMul = opts && opts.hidden ? Math.max(0, Number((this.mode && this.mode.hiddenBossHpMul) ?? 2) || 2) : 1;
    return Math.max(1, Math.round(base * this.bossPoolHpMul * this.bossPoolShare(aliveCount) * hiddenMul));
  }

  /**
   * The mode's bloodPoint column (config modes[*].bossHpScale.bloodPointKey), or null. The field is part of the official
   * mode schema (every difficulty names one: 'bloodPoint' / 'bloodPointNormal' / 'bloodPointHard' / 'bloodPointAbyss'),
   * and bosses.json keys its own table by the bare difficulty name — so this remake used to ignore the key and read
   * `bloodPoint[this.difficulty]`, which resolves for FUNNY / NORMAL / HARD / ABYSS and silently fell back to the FIRST
   * column (娱乐) for any other difficulty. 炸惊模拟 (difficulty 'ZHAJING') was exactly that case: it asked for the
   * 终极 pool by name and got 娱乐's.
   */
  get bloodPointKey() {
    const k = this.mode.bossHpScale && this.mode.bossHpScale.bloodPointKey;
    return typeof k === 'string' && k ? k : null;
  }

  /**
   * The key `bloodPointKey` names inside a boss's own `bloodPoint` table: 'bloodPointAbyss' → 'ABYSS', a key the table
   * already carries is used as is, and 'bloodPoint' (娱乐's, the only unprefixed one) is the difficulty's own name.
   * Without a `bloodPointKey` the difficulty is used unchanged (the pre-炸惊 behaviour).
   */
  bloodPointDiff() {
    const k = this.bloodPointKey;
    if (!k || k === 'bloodPoint') return this.difficulty;
    return k.startsWith('bloodPoint') ? k.slice('bloodPoint'.length).toUpperCase() : k;
  }

  /**
   * 炸惊模拟 规则3: multiplier of bloodPoint[difficulty] for the leader pool (1 = the table value). Applied BEFORE
   * bossPoolShare, so the per-player co-op scaling is computed on the already-increased HP.
   */
  get bossPoolHpMul() { return Math.max(0, numOr(this.mode.bossHpScale && this.mode.bossHpScale.hpMul, 1)); }

  /**
   * Multiplier of bloodPoint for the leader pool (see bossPoolHp; the rule and the config keys: bossPoolShareOf).
   * @param {number} [aliveCount]
   */
  bossPoolShare(aliveCount) {
    return bossPoolShareOf(this.mode.bossHpScale, this.config.bossHpScale, this.isSolo, aliveCount);
  }

  /** config.titles with the tuning overrides (stat / rule per title id) merged in. */
  get titles() {
    const list = Array.isArray(this.config.titles) ? this.config.titles : [];
    const ov = this.tuning.titles && typeof this.tuning.titles === 'object' ? this.tuning.titles : {};
    return list.map((t) => {
      if (!t || typeof t.id !== 'string' || !Object.hasOwn(ov, t.id) || !ov[t.id] || typeof ov[t.id] !== 'object') return t;
      const o = ov[t.id];
      const out = { ...t };
      if (typeof o.stat === 'string') out.stat = o.stat;
      if (o.rule === 'max' || o.rule === 'min') out.rule = o.rule;
      return out;
    });
  }

  // ---- ids ------------------------------------------------------------------------------------------

  chess(id) { return own(this._chess, id); }
  item(id) { return own(this._items, id); }
  bond(id) { return own(this._bonds, id); }
  band(id) { return own(this.raw.bands, id); }
  garrison(id) { return own(this.raw.garrisons, id); }
  effect(id) { return own(this.raw.effects, id); }
  enemy(key) { return own(this.raw.enemies, key); }

  /** 所有领袖（rank BOSS）的敌人 key —— 惊变「傀儡把戏」换 boss 时用（battle flags 里下发）。 */
  get bossKeys() {
    const out = [];
    for (const [key, rec] of Object.entries((this.raw && this.raw.enemies) || {})) {
      if (rec && String(rec.rank || '').toUpperCase() === 'BOSS') out.push(key);
    }
    return out.sort();
  }
  wave(id) { return own(this.raw.waves, id); }
  stage(id) { return own(this.raw.stages, id); }
  boss(id) { return own(this.raw.bosses, id); }
  token(id) { return own(this.raw.tokens, id); }
  get choices() { return this.raw.choices && typeof this.raw.choices === 'object' ? this.raw.choices : {}; }
  get factions() { return this.raw.factions && typeof this.raw.factions === 'object' ? this.raw.factions : {}; }

  /**
   * The 补位 record of chess `id` (normal or elite; DATA.md §18): shared/standIn.js standInRecord over data/backups.json
   * — the chess's identity (ids, tier, bonds, 特质, price, merge) with its official stand-in's body (stats, range, skills
   * with the backup skill as the default, talents, module, art, `standInFor`). Null for a PRESET / 自选 chess, an unknown
   * id or data without backups.json. Memoized (frozen records).
   * @param {string} id
   * @returns {object|null}
   */
  standIn(id) {
    if (typeof id !== 'string') return null;
    if (this._standIns.has(id)) return this._standIns.get(id);
    const c = this.chess(id);
    const backups = this.raw.backups && typeof this.raw.backups === 'object' ? this.raw.backups : null;
    let rec;
    try { rec = c && backups ? standInRecord(c, backups) : null; } catch { rec = null; }
    if (rec) Object.freeze(rec);
    this._standIns.set(id, rec);
    return rec;
  }

  /** Normal (base) chess id of a chess id (golden → base). */
  baseIdOf(id) {
    const c = this.chess(id);
    if (!c) return typeof id === 'string' ? id.replace(/_b$/, '_a') : null;
    return c.baseId || (c.isGolden ? id.replace(/_b$/, '_a') : id);
  }

  goldenIdOf(id) {
    const c = this.chess(this.baseIdOf(id));
    if (c && c.goldenId && this.chess(c.goldenId)) return c.goldenId;
    const alt = typeof id === 'string' ? id.replace(/_a$/, '_b') : null;
    return alt && this.chess(alt) ? alt : null;
  }

  isGolden(id) { const c = this.chess(id) || this.item(id); return !!(c && c.isGolden); }

  tierOf(id) {
    const c = this.chess(id) || this.item(id);
    return c && Number.isInteger(c.tier) ? c.tier : 1;
  }

  // ---- economy --------------------------------------------------------------------------------------

  /**
   * Per-round income. 炸惊模拟 (mode.income) replaces the global table with n + 6 and drops the cap (mode.incomeCap 0 =
   * no cap), so the table has to be long enough for every round of the mode — a missing entry falls through to the
   * formula below, which is capped only when a positive cap applies.
   */
  income(round) {
    const arr = Array.isArray(this.mode.income) ? this.mode.income : (Array.isArray(this.economy.income) ? this.economy.income : DEFAULTS.income);
    const cap = numOr(this.mode.incomeCap, numOr(this.economy.incomeCap, DEFAULTS.incomeCap));
    const v = arr[round];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    const raw = Math.max(0, 3 + round);
    return cap > 0 ? Math.min(cap, raw) : raw;
  }

  chessPrice(id) {
    const c = this.chess(id);
    const tier = this.tierOf(id);
    // ★ 卫戍「购买价格为1」优先于一切（模式覆盖、记录自带 price）
    const gp = this._garrisonPrice && this._garrisonPrice.get(id);
    if (Number.isFinite(gp)) return gp;
    // 2026-10-14: mode-level override FIRST (zhajing tier-2 price). The chess records carry their own
    // `price`, so the override has to be consulted before that early return; modes without a
    // mode.chessPrice keep the old order and are unchanged.
    const mrow = this.mode.chessPrice && this.mode.chessPrice[tier];
    if (mrow && typeof mrow === 'object') {
      const golden0 = c && c.isGolden;
      return numOr(golden0 ? mrow.golden : mrow.normal, DEFAULTS.chessPrice[tier] ?? 3);
    }
    if (c && Number.isFinite(c.price) && c.price >= 0) return c.price;
    const row = this.economy.chessPrice && this.economy.chessPrice[tier];
    const golden = c && c.isGolden;
    if (row && typeof row === 'object') return numOr(golden ? row.golden : row.normal, DEFAULTS.chessPrice[tier] ?? 3);
    return DEFAULTS.chessPrice[tier] ?? 3;
  }

  sellPrice(id) {
    const c = this.chess(id);
    if (c && Number.isFinite(c.sellPrice) && c.sellPrice >= 0) return c.sellPrice;
    const tier = this.tierOf(id);
    const row = this.economy.chessSell && this.economy.chessSell[tier];
    if (row && typeof row === 'object') return numOr(c && c.isGolden ? row.golden : row.normal, DEFAULTS.sellPrice);
    return DEFAULTS.sellPrice;
  }

  itemPrice(id) {
    const it = this.item(id);
    return it && Number.isFinite(it.price) && it.price >= 0 ? it.price : 2;
  }

  get refreshPrice() { return Math.max(0, numOr(this.economy.refreshPrice, DEFAULTS.refreshPrice)); }
  // 用户 2026-10-11：待部署区翻倍**只在炸惊模式生效** —— 模式自己的 `benchSize` 优先（炸惊 = 20），
  // 其余难度回落到全局 economy.benchSize（10）。
  get benchSize() {
    const mode = Number(this.mode && this.mode.benchSize);
    if (Number.isInteger(mode) && mode > 0) return mode;
    return posIntOr(this.economy.benchSize, DEFAULTS.benchSize);
  }
  get tempSize() { return posIntOr(this.economy.tempSize, DEFAULTS.tempSize); }
  get deployCap() { return posIntOr(this.economy.deployCap, DEFAULTS.deployCap); }
  get equipPerChess() { return posIntOr(this.mode.equipPerChess, posIntOr(this.economy.equipPerChess, DEFAULTS.equipPerChess)); }
  /**
   * 炸惊模拟 规则7: the 变形同构体 (the one EQUIP record with `canGiveBond`) does not use an ordinary equip slot — it
   * opens a third slot of its own that takes nothing else. Off ⇒ the item competes for the ordinary slots as before.
   */
  get morphEquipSlot() { return this.mode.morphEquipSlot === true; }
  get maxArtsPerRound() { return posIntOr(this.economy.maxArtsPerRound, DEFAULTS.maxArtsPerRound); }
  get goldenCopies() { return posIntOr(this.economy.goldenCopies, DEFAULTS.goldenCopies); }
  get itemMergeCount() { return posIntOr(this.economy.itemMergeCount, DEFAULTS.itemMergeCount); }
  get leftoverKeptBands() { return Array.isArray(this.economy.leftoverFundsKeptByBands) ? this.economy.leftoverFundsKeptByBands : DEFAULTS.leftoverFundsKeptByBands; }
  /**
   * 炸惊模拟 规则10: funds are never cleared at the end of a round (mode.leftoverFundsKept), for EVERY band — the
   * 坎诺特 band's `leftoverKeptBands` list is what normally unlocks that. Read by PlayerRound.endPrep.
   */
  get leftoverFundsKept() { return this.mode.leftoverFundsKept === true; }
  /**
   * 炸惊模拟 规则10 利息: { capital, interest, max } — at round start, funds ≥ capital pays
   * min(max, ⌊funds / capital⌋ × interest) extra income (same shape as the 坎诺特 band's `coin_carry_over`, whose
   * defaults are { 5, 1, 1 }); `capped` tells the client whether the bonus sits at `max` (利息封顶). Null when the
   * mode has no interest rule.
   */
  get interest() {
    const i = this.mode.interest;
    if (!i || typeof i !== 'object') return null;
    const capital = posIntOr(i.capital, 5);
    const interest = Math.max(0, numOr(i.interest, 1));
    const max = Math.max(0, numOr(i.max, 1));
    if (interest <= 0) return null;
    return { capital, interest, max };
  }
  /** 炸惊模拟 规则4: { levels, itemId } — the shop levels that hand the player a free item (变形同构体). */
  get shopGift() {
    const g = this.mode.shopGift;
    if (!g || typeof g !== 'object') return null;
    const levels = Array.isArray(g.levels) ? g.levels.filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!levels.length || typeof g.itemId !== 'string' || !this.item(g.itemId)) return null;
    return { levels, itemId: g.itemId };
  }
  /** 炸惊模拟 规则8: per-wave enemy-count multiplier (1.2 = +20%, floored); 1 = off. */
  get enemyCountMul() { return Math.max(1, numOr(this.mode.enemyCountMul, 1)); }
  /** 炸惊模拟 规则1: per-bond layer cap of this mode (null ⇒ the global BOND_LAYER_CAP). */
  get bondLayerCap() { return posIntOr(this.mode.bondLayerCap, null); }
  /** 炸惊模拟 规则9: { hp, def, atk } multipliers on every deployed operator (null when off). */
  get allyScale() {
    const a = this.mode.allyScale;
    if (!a || typeof a !== 'object') return null;
    const hp = Math.max(0, numOr(a.hp, 1)), def = Math.max(0, numOr(a.def, 1)), atk = Math.max(0, numOr(a.atk, 1));
    if (hp === 1 && def === 1 && atk === 1) return null;
    return { hp, def, atk };
  }
  get defaultBandId() { return typeof this.economy.defaultBandId === 'string' ? this.economy.defaultBandId : DEFAULTS.defaultBandId; }
  get defaultStartLp() { return posIntOr(this.economy.defaultStartLp, DEFAULTS.defaultStartLp); }

  /**
   * The free-operator offer a merge pays (economy.rewardOffer, overridable per mode). The classic rule is
   * `tierOffset` 1: the offer's tier is min(shopLevel + 1, maxTier). 炸惊模拟 规则13 replaces that with
   * `tierWeights` — a fixed per-tier weight table (1→6, decreasing) — and `sameBond`, which requires every candidate
   * to share at least one bond with the operator that was just merged.
   * `tierWeightsByLevel` (用户 2026-10-13, 炸惊) — 每个商店等级各自一张权重表（`{ "3": { "4": 70, "5": 30 } }`）；
   * 有这一档时优先用它，没有则回落到 `tierWeights`。方案 D：「保底 L+1 阶 70% / L+2 阶 30%，封顶 6 阶时 100%」。
   */
  rewardOffer() {
    const r = this.economy.rewardOffer && typeof this.economy.rewardOffer === 'object' ? this.economy.rewardOffer : {};
    const mo = this.mode.rewardOffer && typeof this.mode.rewardOffer === 'object' ? this.mode.rewardOffer : {};
    const g = (k) => (mo[k] !== undefined ? mo[k] : r[k]);
    const maxTier = posIntOr(g('maxTier'), DEFAULTS.rewardOffer.maxTier);
    const parse = (rawW) => {
      if (!rawW || typeof rawW !== 'object') return null;
      const out = [];
      for (let t = 1; t <= maxTier; t++) {
        const w = Math.max(0, numOr(rawW[String(t)] ?? rawW[t], 0));
        if (w > 0) out.push([t, w]);
      }
      return out.length ? out : null;
    };
    const tierWeights = parse(g('tierWeights'));
    const rawByLevel = g('tierWeightsByLevel');
    let tierWeightsByLevel = null;
    if (rawByLevel && typeof rawByLevel === 'object') {
      const out = {};
      for (const [lv, w] of Object.entries(rawByLevel)) {
        const level = Number(lv);
        const parsed = parse(w);
        if (Number.isInteger(level) && level >= 1 && parsed) out[level] = parsed;
      }
      if (Object.keys(out).length) tierWeightsByLevel = out;
    }
    return {
      count: posIntOr(g('count'), DEFAULTS.rewardOffer.count),
      tierOffset: Number.isInteger(g('tierOffset')) ? g('tierOffset') : DEFAULTS.rewardOffer.tierOffset,
      maxTier,
      price: Math.max(0, numOr(g('price'), 0)),
      sameBond: g('sameBond') === true,
      tierWeights,
      tierWeightsByLevel,
    };
  }

  /** Copies of a base chess in the shared pool. */
  poolCopies(baseId) {
    const ov = this.economy.poolCopiesOverrides;
    if (ov && typeof ov === 'object' && Number.isInteger(ov[baseId]) && ov[baseId] >= 0) return ov[baseId];
    const tier = this.tierOf(baseId);
    const pc = this.economy.poolCopies;
    const v = pc && typeof pc === 'object' ? pc[tier] : undefined;
    return Number.isInteger(v) && v >= 0 ? v : (DEFAULTS.poolCopies[tier] ?? 10);
  }

  /**
   * 同一名干员在**本模式棋库**里的记录 id。
   *
   * 炸惊模拟的棋库是另一套记录（`chess_zj_*`，`baseId` 指向自己），而 data/choices.json 的奖池是按**普通** id 写死的：
   * 松果池（野鬃 / 灰毫 / 远牙，`pool_char_pinus`，焰尾的特质发放）与歌蕾蒂娅池（斯卡蒂 / 幽灵鲨 / 深巡，
   * `pool_chess_glady`）。炸惊里直接发普通记录会得到一个同名、但 `baseId` 不同的棋子 —— 它跟炸惊的同名卡**永远合不了
   * 精锐**（玩家反馈「三个灰毫放在一起没精锐」，用户 2026-10-22）。发放前用它换成本模式棋库里的同一名干员
   * （按 charId + 是否精锐配对）；本模式没有对应记录、本来就属于本模式棋库、或不是炸惊时原样返回。
   * @param {string} id
   * @returns {string}
   */
  chessInRoster(id) {
    const rec = this.chess(id);
    if (!rec || !this.zhajing || rec.zhajing === true || !rec.charId) return id;
    if (!this._zjByChar) {
      const m = new Map();
      for (const [cid, c] of Object.entries(this._chess)) {
        if (!c || c.zhajing !== true || !c.charId) continue;
        m.set(`${c.charId}|${c.isGolden ? 1 : 0}`, cid);
      }
      this._zjByChar = m;
    }
    return this._zjByChar.get(`${rec.charId}|${rec.isGolden ? 1 : 0}`) || id;
  }

  /** Copies needed to merge (0 = never merges: golden chess). */
  mergeCount(id) {
    const c = this.chess(id);
    if (!c || c.isGolden) return 0;
    if (Number.isInteger(c.upgradeNum) && c.upgradeNum > 0) return c.upgradeNum;
    const ov = this.economy.mergeCountOverrides;
    if (ov && Number.isInteger(ov[id])) return ov[id];
    return posIntOr(this.economy.mergeCount, DEFAULTS.mergeCount);
  }

  // ---- mode -----------------------------------------------------------------------------------------

  get isSolo() { return this.mode.type === 'SINGLE' || /^mode_single_/.test(this.modeId || ''); }
  get difficulty() { return this.mode.difficulty || (this.modeId ? String(this.modeId).split('_').pop().toUpperCase() : 'NORMAL'); }
  get lastRound() {
    if (Number.isInteger(this.mode.lastRound) && this.mode.lastRound > 0) return this.mode.lastRound;
    return this.modeId === 'mode_single_funny' ? 9 : 14;
  }
  get bossRound() { return Number.isInteger(this.mode.bossRound) && this.mode.bossRound > 0 ? this.mode.bossRound : this.lastRound; }
  get hiddenRound() { return Number.isInteger(this.mode.hiddenRound) && this.mode.hiddenRound > 0 ? this.mode.hiddenRound : null; }
  get maxShopLevel() { return posIntOr(this.mode.maxShopLevel, DEFAULTS.maxShopLevel); }

  roundCfg(r) {
    const rounds = this.mode.rounds;
    return rounds && typeof rounds === 'object' && rounds[String(r)] && typeof rounds[String(r)] === 'object' ? rounds[String(r)] : null;
  }

  spRounds() {
    // ★ 2026-10-17（用户：「还是有惊变阶段 帮我跳过下」）：`SP_ZHAJING_SKIP_SP=1` 时**没有特殊阶段回合**。
    //
    //   为什么必须改这里而不是只改 spPhaseKind：特殊阶段的**入口**是
    //   `server/match/match/phases.js:495` 的 `if (this.gd.spRounds().includes(this.round)) this.enterSpDraft(...)`。
    //   `spPhaseKind` 只在"已经进 SpDraft 之后"决定抽哪个家族 —— 只把它清成 null，会落到 choices.js:156 的
    //   **加权抽**分支，`sch.families` 里本身就含 jibian ⇒ 仍然会冒出惊变（第一版就踩了这个坑）。
    //   清空 `spRounds` 才是"这些回合根本不进特殊阶段"。
    //
    //   副作用（都是想要的）：`views.js:128` 的 `spRound` 随之为 false，客户端的特殊阶段 UI 也不出现。
    //   不动 `mode.spRounds` 本身，所以 config.json 与其它读取方（客户端 mode 卡面）保持原样。
    if (process.env.SP_ZHAJING_SKIP_SP) return [];
    return Array.isArray(this.mode.spRounds) ? this.mode.spRounds.filter((n) => Number.isInteger(n)) : [];
  }

  /**
   * 炸惊模拟 规则5/6: which special phase a 机变 round runs — 'jibian' (惊变阶段, rounds 1 and 7: three 惊变 cards, pick
   * one) or 'express' (企鹅物流的快递, rounds 3/6/9, which replaces 悬赏决策: six equips, repeats allowed). null ⇒ the
   * ordinary weighted draw over choices.json's families.
   * @param {number} round
   */
  spPhaseKind(round) {
    // ★ 2026-10-17（用户：「让我进入没有惊变阶段的炸惊模拟」）：`SP_ZHAJING_SKIP_SP=1` 时跳过炸惊的特殊阶段
    //   （惊变 / 企鹅物流的快递 / 悬赏决策），全部走 choices.json 家族加权抽 —— 即「没有惊变阶段的炸惊模拟」。
    //   只影响 `spPhaseKind` 的返回值：`spRounds`（哪些回合算特殊阶段）不动，所以回合数、经济、敌人数值全不变。
    //   默认关闭 ⇒ 生产服务器与任何分发包行为完全不变。
    if (!process.env.SP_ZHAJING_SKIP_SP) return this._spPhaseKind(round);
    return null;
  }

  /** The unmodified 特殊阶段 lookup (`spPhaseKind` without the dev skip). */
  _spPhaseKind(round) {
    const map = this.mode.spPhaseKinds;
    const v = map && typeof map === 'object' ? map[String(round)] : null;
    return typeof v === 'string' && v ? v : null;
  }

  /**
   * 规则6: the equips the 企鹅物流的快递 phase offers — the items carrying a `giveBondId`, i.e. the ones that turn a
   * 变形同构体 wearer into a member of their bond (转职). Repeatable, so the draw is with replacement.
   */
  expressPool() {
    const list = this.mode.expressPool;
    if (!Array.isArray(list)) return [];
    const groups = this.expressGroups();
    // 用户 2026-10-11：维多利亚战锤合并成一格 —— 组标记（"group:xxx"）本身没有 item 记录，要按组放行
    return list.filter((id) => typeof id === 'string' && (this.item(id) || Array.isArray(groups[id])));
  }

  /**
   * 规则6（用户 2026-10-11）：快递池里的「组合格」—— `{ "group:victoriaHammer": [五种战锤 id] }`。
   * 抽中这一格之后再在组内随机一种投放到前台，于是几种战锤的合计概率和其它单件装备完全一样。
   */
  expressGroups() {
    const g = this.mode.expressGroups;
    return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
  }

  /** 规则6: how many equips the 快递 phase offers at once (default 6). */
  expressCards() { return posIntOr(this.mode.expressCards, 6); }

  /**
   * 规则5: the 惊变阶段's own rules — `cards` offered, `rarityWeights` (普通 45 / 稀有 25 / 史诗 20 / 传说 10, rolled FIRST, then a
   * random card of that rarity), `rerolls` (one reroll of a single 惊变) and `pool` (the cards themselves; empty until
   * the card list is supplied, and an empty pool makes the phase fall through to the prep).
   */
  jibian() {
    const j = this.mode.jibian;
    if (!j || typeof j !== 'object') return null;
    const weights = [];
    const w = j.rarityWeights && typeof j.rarityWeights === 'object' ? j.rarityWeights : {};
    // ★ 2026-10-25（owner）：我方惊变新增「隐秘」档位 —— 权重键与卡面 rarity 都可能出现 'hidden'，
    //   这里必须把它放行，否则 gd.jibian() 会把隐秘档权重丢掉、抽卡时又回落整池，卡面品质与卡不符。
    for (const r of ['normal', 'rare', 'epic', 'legend', 'hidden']) {
      const v = Math.max(0, numOr(w[r], 0));
      if (v > 0) weights.push([r, v]);
    }
    const pool = Array.isArray(j.pool) ? j.pool.filter((c) => c && typeof c === 'object') : [];
    const base = weights.length ? weights : [['normal', 35], ['rare', 30], ['epic', 20], ['legend', 10], ['hidden', 5]];
    return {
      cards: posIntOr(j.cards, 3),
      rerolls: Math.max(0, Math.trunc(numOr(j.rerolls, 1))),
      rarityWeights: base,
      /**
       * 隐藏规则（用户 2026-10-12，不上界面）：**没有激活任何核心盟约**的玩家（8 条核心；投资人 / 迅捷 / 精准这类
       * 附加盟约不算），抽惊变时**「带核心盟约的传说惊变」**（卡上 `bond` 指向 isCore 盟约的那些传说卡）的抽取
       * 概率提升到 `noCoreBondLegendWeight`（默认 30%）。**只对这一类生效**：其余卡仍按 rarityWeights 抽。
       * 判定在 Match._jibianNoCore，抽取在 choices.jibianDraftCards。
       */
      noCoreBondLegendWeight: noCoreBondLegendWeight(j),
      pool,
    };
  }

  /**
   * 炸惊模拟 规则14: the 敌方惊变 drawn automatically before round `round` (1) starts — ONE card for the whole room, a
   * match-long global enemy buff. `rarityWeights` are the 惊变阶段's own (普通 45 / 稀有 25 / 史诗 20 / 传说 10, rolled FIRST, then
   * a card of that rarity), `pool` the cards themselves (empty until the card list is supplied — an empty pool skips the
   * reveal and the round starts as before), and the reveal runs `flickerMs` of rolling then `resultMs` of the zoomed
   * result. null ⇒ the mode has no 敌方惊变 (every other difficulty).
   */
  enemyJibian() {
    // ★ 2026-10-17（用户：「还是有敌方惊变」）：`SP_ZHAJING_SKIP_SP=1` 时**连敌方惊变一起跳过**。
    //
    //   敌方惊变（规则14）与"惊变阶段"是**两套独立机制**：阶段是 `spRounds`/`spPhaseKind` 的抽卡，
    //   而敌方惊变是这里读 `mode.enemyJibian` 的**回合开场全局敌人增益**（`rounds` 默认 [1, 6]，
    //   由 phases.js 在回合开始时抽一张）。只清 `spRounds` 挡不住它 —— 所以这个开关要同时管住两处。
    //   返回 null = 「这个模式没有敌方惊变」（与其它难度同款），揭晓动画与增益都不出现，回合照常开始。
    //   默认关闭 ⇒ 生产服务器与任何分发包行为完全不变。
    if (process.env.SP_ZHAJING_SKIP_SP) return null;
    const j = this.mode.enemyJibian;
    if (!j || typeof j !== 'object' || j.enabled === false) return null;
    const weights = [];
    const w = j.rarityWeights && typeof j.rarityWeights === 'object' ? j.rarityWeights : {};
    for (const r of ['normal', 'rare', 'epic', 'legend']) {
      const v = Math.max(0, numOr(w[r], 0));
      if (v > 0) weights.push([r, v]);
    }
    const pool = Array.isArray(j.pool) ? j.pool.filter((c) => c && typeof c === 'object') : [];
    // 用户 2026-10-11：「1.6回合抽取敌方惊变」= 第 1 与第 6 回合各出一次（`rounds`）；`round` 保留兼容旧配置。
    const round = Math.max(1, Math.trunc(numOr(j.round, 1)));
    const rounds = Array.isArray(j.rounds)
      ? [...new Set(j.rounds.map((n) => Math.trunc(numOr(n, 0))).filter((n) => n >= 1))].sort((a, b) => a - b)
      : [];
    // ★ 2026-10-24（owner）：隐秘惊变（隐秘核心战前的专属阶段，保底一张「隐秘」稀有度卡）。
    //   注意这里是**清洗后的视图**，config 里新加的字段必须在这里显式透传，否则 phases/bossRounds 读不到。
    const hiddenRaw = j.hidden && typeof j.hidden === 'object' ? j.hidden : null;
    const hidden = hiddenRaw ? {
      enabled: hiddenRaw.enabled !== false,
      label: typeof hiddenRaw.label === 'string' && hiddenRaw.label ? hiddenRaw.label : '隐秘惊变',
      pool: Array.isArray(hiddenRaw.pool) ? hiddenRaw.pool.filter((c) => c && typeof c === 'object') : [],
      flickerMs: Math.max(0, Math.trunc(numOr(hiddenRaw.flickerMs, numOr(j.flickerMs, 3000)))),
      resultMs: Math.max(0, Math.trunc(numOr(hiddenRaw.resultMs, numOr(j.resultMs, 3000)))),
    } : null;
    return {
      round,
      rounds: rounds.length ? rounds : [round],
      rarityWeights: weights.length ? weights : [['normal', 45], ['rare', 25], ['epic', 20], ['legend', 10]],
      pool,
      flickerMs: Math.max(0, Math.trunc(numOr(j.flickerMs, 3000))),
      resultMs: Math.max(0, Math.trunc(numOr(j.resultMs, 3000))),
      hidden,
    };
  }

  upgradePrices() {
    const arr = Array.isArray(this.mode.upgradePrices) ? this.mode.upgradePrices : DEFAULTS.upgradePrices;
    return arr.map((v) => Math.max(0, numOr(v, 99)));
  }

  /** Base price to go from `level` to level+1 (null at max). */
  upgradeBase(level) {
    if (level >= this.maxShopLevel) return null;
    const arr = this.upgradePrices();
    return arr[level - 1] ?? 99;
  }

  shopSlots(level) {
    const s = this.mode.shopSlots && this.mode.shopSlots[String(level)];
    const d = DEFAULTS.shopSlots[level] || DEFAULTS.shopSlots[6];
    if (!s || typeof s !== 'object') return { ...d };
    const chess = Number.isInteger(s.chess) && s.chess >= 0 ? s.chess : d.chess;
    const item = Number.isInteger(s.item) && s.item >= 0 ? s.item : d.item;
    return { chess: Math.min(chess, 8), item: Math.min(item, 4) };
  }

  /** Real-second prep timer for round r (null = untimed). */
  prepTime(r) {
    const rc = this.roundCfg(r);
    if (!rc) return this.isSolo ? null : 90;
    const v = rc.prepTime;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /** The round level's `maxPlayTime` (config rounds[r].combatTimeLimit) as data gives it — REAL seconds. */
  combatTimeLimitReal(r) {
    const rc = this.roundCfg(r);
    const v = rc ? rc.combatTimeLimit : undefined;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    const m = this.mode.combatTimeLimit && this.mode.combatTimeLimit[String(r)];
    return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 60;
  }

  /**
   * Combat time limit of round r in GAME seconds (what the Battle and 联防 use): maxPlayTime × the forced battle speed
   * (config.combatTimeScale, default COMBAT_TIME_SCALE 2). `maxPlayTime` counts real seconds of the 2× battle: read
   * as game seconds, the rounds' own spawn schedules would not fit (R2 spawns its last flyer at 43 s of a 45 s limit,
   * R3 at 62 s of 55 s — enemies that can never be killed, or never spawn), while × 2 every limit is ≈ the last spawn +
   * one flyer crossing (R2 43 + 44 ≈ 90, R3 62 + 44 ≈ 110, R5 38 + 67 ≈ 110). docs/BALANCE.md §2.1.
   */
  combatTimeLimit(r) {
    return this.combatTimeLimitReal(r) * this.combatTimeScale;
  }

  /** Game seconds per real second of a battle (config.combatTimeScale, default COMBAT_TIME_SCALE 2). */
  get combatTimeScale() {
    const k = numOr(this.config.combatTimeScale, COMBAT_TIME_SCALE);
    return k > 0 ? k : COMBAT_TIME_SCALE;
  }

  /**
   * The boss round level's `maxPlayTime` (config rounds[r].levelMaxPlayTime, 120) in REAL seconds — the countdown of
   * the Final Assault / Hidden Core. It is not a hard stop there ("计时结束后战斗仍然会继续", research 01 §10); null
   * when the data has none.
   */
  bossLevelTime(r) {
    const rc = this.roundCfg(r);
    const v = rc ? rc.levelMaxPlayTime : undefined;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * Official enemy multipliers of round r (config enemyScale: the PRTS table + 终极 speed ×1.15 from R3). `supplyHpMul`
   * (only when ≠ 1: co-op 终极 R5–R15) = the share of hpMul from 补给线 / 补给线II (config `supplyHp`), effects whose
   * `enemy_exclude` leaves out the 14 器物 hit-count keys — they take hpMul / supplyHpMul (archetypes.js `times`).
   */
  baseEnemyScale(r) {
    const e = this.mode.enemyScale && this.mode.enemyScale[String(r)];
    if (!e || typeof e !== 'object') return { hpMul: 1, atkMul: 1, speedMul: 1 };
    const supply = numOr(e.supplyHp, 1);
    // 炸惊模拟 规则2 adds the missing DEF axis (the official table only has hp / atk / speed) and 规则3 overrides the
    // leader's ATK: the leader takes atkMul but not hpMul (its HP is the shared pool), so its ATK needs its own key.
    const def = numOr(e.def, 1);
    const bossAtk = numOr(e.bossAtk, numOr(this.mode.bossHpScale && this.mode.bossHpScale.atkMul, null));
    // 用户 2026-10-11：领袖的防御可以和小怪分开 —— 小怪 def ×3（e.def），领袖 `bossDef`（缺省时给绝对防御
    // `mode.bossHpScale.def` ÷ 该 boss 的基础防御，做不到就退回 e.def 外的 9 倍由数据显式给出）。
    const bossDef = numOr(e.bossDef, null);
    // ★ 2026-10-13 炸惊（mode.enemyResMul）：敌人**法术抗性**的模式级倍率 —— 只对配了这个开关的模式生效
    //（普通模式没有该字段 → resMul = 1 → 行为与改动前逐字节一致）。upTo 表达「≤该值才乘，>该值保持原样」。
    const rm = this.mode.enemyResMul || null;
    const resMul = rm ? Math.max(0, numOr(rm.mul, 1)) : 1;
    const resUpTo = rm && rm.upTo != null && Number.isFinite(Number(rm.upTo)) ? Number(rm.upTo) : null;
    return {
      hpMul: Math.max(0.01, numOr(e.hp, 1)),
      atkMul: Math.max(0, numOr(e.atk, 1)),
      speedMul: Math.max(0.01, numOr(e.speed, 1)),
      ...(def !== 1 ? { defMul: Math.max(0, def) } : {}),
      ...(bossAtk != null ? { bossAtkMul: Math.max(0, bossAtk) } : {}),
      ...(bossDef != null ? { bossDefMul: Math.max(0, bossDef) } : {}),
      ...(supply > 0 && supply !== 1 ? { supplyHpMul: supply } : {}),
      ...(resMul !== 1 ? { resMul, ...(resUpTo != null ? { resUpTo } : {}) } : {}),
      // ★ 2026-10-15（用户）：按回合的出怪量乘区 —— `enemyScale[r].countMul`。
      //   原来出怪量只有模式级的 `enemyCountMul`（不分回合），要「第 4 回合起翻倍」就得有这一项。
      //   waves.js 的 templateSpawns 里已经拿着本轮的 `scale`，所以只是把它透出来。
      ...(e.countMul != null && Number.isFinite(Number(e.countMul))
        ? { countMul: Math.max(0, Number(e.countMul)) } : {}),
    };
  }

  /** Enemy multipliers of round r = the official table (baseEnemyScale; no custom multiplier). */
  enemyScale(r) {
    return this.baseEnemyScale(r);
  }

  timer(key) {
    const t = this.config.timers && this.config.timers[key];
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULTS.timers[key] ?? 10;
  }

  get lpCapPerRound() { return posIntOr(this.config.lpCapPerRound, DEFAULTS.lpCapPerRound); }
  /**
   * Boss overtime (`bossTurnHpReduceTime` 150 / 1 LP per second): a server turn timer of turnInfoDataDict like
   * prepPhaseTime, so REAL seconds on the same clock as the boss level's 120 s maxPlayTime (combat limits are real
   * seconds, docs/BALANCE.md §2.1) — the level countdown runs out first, the battle continues, and the merged team LP
   * drains 1 per real second from the 150 s mark (research 01 §10, 06 §11.7). Read as game seconds the drain would
   * start at 75 real s (45 s before the countdown ends) at 2 LP per real second.
   */
  get bossOvertimeAfterReal() { return Math.max(0, numOr(this.config.bossOvertimeAfter, DEFAULTS.bossOvertimeAfter)); }
  /** Team LP drained per REAL second of overtime. */
  get bossOvertimeDrainReal() { return Math.max(0, numOr(this.config.bossOvertimeDrainPerSec, DEFAULTS.bossOvertimeDrainPerSec)); }
  /** Overtime start in GAME seconds of a boss field clock (150 real s × the forced 2× = 300). */
  get bossOvertimeAfter() { return this.bossOvertimeAfterReal * this.combatTimeScale; }
  /** Team LP drained per GAME second of overtime (1 per real second = 0.5 per game second). */
  get bossOvertimeDrain() { return this.bossOvertimeDrainReal / this.combatTimeScale; }
  /**
   * Team LP the overtime drain has taken when a boss field clock reads `gt` game seconds: bossOvertimeDrainReal per
   * whole REAL second past bossOvertimeAfterReal (the first point at 151 real s).
   */
  bossOvertimeDue(gt) {
    const over = (Number(gt) || 0) / this.combatTimeScale - this.bossOvertimeAfterReal;
    return over >= 1 ? Math.floor(over) * this.bossOvertimeDrainReal : 0;
  }
  get dp() {
    const d = this.config.dp && typeof this.config.dp === 'object' ? this.config.dp : {};
    const out = { dpInit: numOr(d.init, 10), dpPerSec: numOr(d.perSec, 1), dpMax: numOr(d.max, 99) };
    // ★ 2026-10-13（用户·炸惊）：单次伤害上限 / 攻速上限按模式可关（mode.damageCap / mode.aspdCap，0 = 取消）。
    //   普通模式没写这两个字段 → out 里不带它们 → damage.js / units.js 回落到原来的全局上限 ✓ 行为不变。
    if (Number.isFinite(this.mode && this.mode.damageCap)) out.damageCap = this.mode.damageCap;
    if (Number.isFinite(this.mode && this.mode.aspdCap)) out.aspdCap = this.mode.aspdCap;
    // ★ 2026-10-24：傀儡把戏要在战场里随机换 boss —— 把领袖 key 表随 flags 下发
    if (this.zhajing && Array.isArray(this.bossKeys) && this.bossKeys.length) out.bossKeys = this.bossKeys;
    return out;
  }
  get unite() {
    const u = this.config.unite && typeof this.config.unite === 'object' ? this.config.unite : {};
    return {
      maxHelpers: posIntOr(u.maxHelpers, DEFAULTS.unite.maxHelpers),
      // 100-seat 阶段 2: fight the relay as a second battlefield (true) or resolve it atomically (false).
      // data/config.json can override; absent means false — the atomic path that shipped before this toggle.
      relayBattlefield: u.relayBattlefield === true,
      templates: u.templates && typeof u.templates === 'object' ? u.templates : DEFAULTS.unite.templates,
    };
  }
  get hiddenCore() {
    const h = this.config.hiddenCore && typeof this.config.hiddenCore === 'object' ? this.config.hiddenCore : {};
    return {
      single: numOr(h.single, DEFAULTS.hiddenCore.single),
      multi: numOr(h.multi, DEFAULTS.hiddenCore.multi),
      minTeamLpExclusive: numOr(h.minTeamLpExclusive, DEFAULTS.hiddenCore.minTeamLpExclusive),
      difficulties: Array.isArray(h.difficulties) ? h.difficulties : DEFAULTS.hiddenCore.difficulties,
    };
  }
  bans(difficulty) {
    const b = this.config.bans && this.config.bans[difficulty];
    const d = DEFAULTS.bans[difficulty] || { core: 0, addon: 0 };
    if (!b || typeof b !== 'object') return { ...d };
    return { core: Number.isInteger(b.core) && b.core >= 0 ? b.core : d.core, addon: Number.isInteger(b.addon) && b.addon >= 0 ? b.addon : d.addon };
  }
  get bandDraft() {
    const b = this.config.bandDraft && typeof this.config.bandDraft === 'object' ? this.config.bandDraft : {};
    return {
      skipsPerPlayer: Number.isInteger(b.skipsPerPlayer) && b.skipsPerPlayer >= 0 ? b.skipsPerPlayer : DEFAULTS.bandDraft.skipsPerPlayer,
      timeoutBandId: typeof b.timeoutBandId === 'string' && this.band(b.timeoutBandId) ? b.timeoutBandId : this.defaultBandId,
      // Whether two players may take the SAME strategy in one draft. `data/config.json` has declared
      // `duplicatesAllowed: true` all along, but nothing ever read it — the code kept enforcing 「队友已选」 while the
      // data said otherwise. Read here so the declaration takes effect; phases.bandTaken and the client's draft screen
      // both consult this single value.
      duplicatesAllowed: typeof b.duplicatesAllowed === 'boolean' ? b.duplicatesAllowed : DEFAULTS.bandDraft.duplicatesAllowed,
      // 100-seat variant: EVERYONE PICKS AT THE SAME TIME instead of one turn after another. A 100-seat room taking
      // turns at BAND_TURN_SECONDS each would spend up to ~50 minutes on this screen; simultaneously it is ONE shared
      // countdown. No turns means no 「队友已选」 pressure either, so `bandDraft` in data/config.json pairs this with
      // `duplicatesAllowed: true`. `bandSkips` (取消跳过) goes away with the turn order: a skip only ever meant
      // 「pass my turn to the next player」.
      simultaneous: typeof b.simultaneous === 'boolean' ? b.simultaneous : DEFAULTS.bandDraft.simultaneous,
    };
  }

  /** Bosses weights for the boss round / hidden round. */
  bossWeights(hidden = false) {
    const w = hidden ? this.mode.hiddenBossWeights : this.mode.bossWeights;
    return w && typeof w === 'object' ? Object.entries(w).filter(([id, v]) => this.boss(id) && Number(v) > 0) : [];
  }

  /** Band usable in this mode type. */
  bandAllowed(bandId) {
    const b = this.band(bandId);
    if (!b) return false;
    // ★ 2026-10-19 惊变专属策略（data/bands.json zjOnly: true，例如「祀」）：只在炸惊模拟里出现
    if (b.zjOnly === true && !this.zhajing) return false;
    const list = Array.isArray(b.modeTypeList) ? b.modeTypeList : null;
    if (!list) return true;
    return list.includes(this.isSolo ? 'SINGLE' : 'MULTI');
  }

  bandIds() {
    const bands = this.raw.bands && typeof this.raw.bands === 'object' ? this.raw.bands : {};
    return Object.keys(bands).filter((id) => this.bandAllowed(id)).sort((a, b) => numOr(bands[a].sortId, 99) - numOr(bands[b].sortId, 99) || (a < b ? -1 : 1));
  }

  startLp(bandId) {
    const b = this.band(bandId);
    return b && Number.isInteger(b.totalHp) && b.totalHp > 0 ? b.totalHp : this.defaultStartLp;
  }

  /**
   * The bonds a strategy's mechanic is built around (DESIGN §21.26): bands.json `bondIds`, written at build time by
   * shared/bandBonds.js from the band's own text and blackboards (潘格尼尼 → 拉特兰, 克莱门莎 → 阿戈尔, 玛恩纳 → 卡西米尔 …) —
   * the field the strategy draft's 本局禁用 mark reads too. Known bond ids in data order; [] for an unknown band, one tied to
   * no bond (华法琳, 阿米娅 …) or data without the field. The bot never picks a strategy tied to a bond the mode switches
   * off (bot.js botPickBand).
   * @param {string} bandId
   * @returns {string[]}
   */
  bandBondIds(bandId) {
    if (this._bandBonds.has(bandId)) return this._bandBonds.get(bandId);
    const listed = this.band(bandId)?.bondIds;
    const set = new Set(Array.isArray(listed) ? listed : []);
    const out = Object.freeze(this.bondIds.filter((id) => set.has(id)));
    this._bandBonds.set(bandId, out);
    return out;
  }

  /**
   * Placeable (hand) tokens a chess sends to the hand when placed on the board: [{ tokenId, count }] — its manually
   * deployable summons (tokens.json `placeable`: 医疗探机, 诅咒娃娃, 海嗣, 狼群, 流形, 爬行号·防护单元; user playtest #6)
   * that the chess makes under `loadout` ({ skillIndex } from shared/protocol.js resolveLoadout; absent ⇒ its default
   * skill): the owner variant's `sources` (`bySkill[skillIndex]` for a non-default skill) name a talent or a skill —
   * 赫默 / 巫恋 on S1 make no drone / doll. `count` = the summon's deploy limit (PRTS 卫戍协议/帮助 "根据召唤物部署数量
   * 上限（非初始持有量），发送等量召唤物至手牌区": 凯瑟琳 2 of her 3 devices).
   */
  placeableTokens(chessId, loadout = null) {
    const c = this.chess(chessId);
    if (!c || !Array.isArray(c.tokens)) return [];
    const out = [];
    for (const tid of c.tokens) {
      const t = this.token(tid);
      if (!t || t.kind !== 'summon' || t.placeable !== true) continue;
      const vs = t.variants && typeof t.variants === 'object' ? t.variants : {};
      const v = vs[chessId] ?? vs[String(chessId).replace(/_b$/, '_a')] ?? null;
      if (v) {
        const alt = loadout && Number.isInteger(loadout.skillIndex) && v.bySkill ? v.bySkill[loadout.skillIndex] : null;
        const src = Array.isArray(alt?.sources) ? alt.sources : Array.isArray(v.sources) ? v.sources : [];
        if (!src.includes('talent') && !src.includes('skill')) continue;
      }
      const count = posIntOr(v?.stats?.deployLimit, posIntOr(t.deployLimit, 1));
      out.push({ tokenId: tid, count: Math.min(count, 9) });
    }
    return out;
  }
}
