// server/match/player/economy.js — PlayerState methods: the economy — funds, spending (onSpend), prep-side bond layer
// gains (clamped by layerGainRoom), the shop (onPrice prices, copy-weighted rolls from the shared pool plus the player's
// own 自选 stock — player/diy.js —, freeze) and its intents: g.buy, g.refresh, g.freeze, g.levelUp, g.sell,
// plus the 惊变 ones (g.specialRefresh, g.sellBanteng).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR, layerGainRoom } from '../../../shared/constants.js';
import { freeSlot } from '../board.js';
import { OK, fail } from './common.js';
// 作弊模式 (SP_CHEAT=1,本地测试用): 无限资金 + 商店只出外援。关闭时下面的代码路径与原本完全一致。
import { cheatEnabled, cheatRollOpts, cheatDiyEntries, cheatFunds } from './cheat.js';
import { activeBonds as jbActiveBonds, bondsOfCard, ownedJibianIdsOf } from '../../sim/content/jibianBonds.js';

export class PlayerEconomy {
  addFunds(n, { reason = '' } = {}) {
    if (!Number.isFinite(n) || n === 0) return 0;
    const v = Math.trunc(n);
    const before = this.funds;
    this.funds = Math.max(0, this.funds + v);
    if (v > 0) this.stats.fundsGained += v;
    this.dirty();
    return this.funds - before;
  }

  spend(n) {
    const v = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    // 作弊模式 (SP_CHEAT=1): 不扣钱,但 stats.gold / round.spent 照记 —— 那些是统计与"本回合花了多少"
    // 的账目,顺带还被 onSpend 类效果读取,记零会让这些效果失灵、也可能触发一些自相矛盾的断言。
    if (cheatEnabled(this)) {
      this.stats.gold += v;
      this.round.spent += v;
      cheatFunds(this);
      this.dirty();
      return true;
    }
    if (v > this.funds) {
      // ★ 恶魔契约（惊变, owner 2026-10-16）：「可以把目标生命值当成资金来使用（无法消耗至0）」。
      //   资金不够时用目标生命抵，**保底 1 点**（声明里的「无法消耗至 0」）；不足则照旧买不起。
      //   只在这张卡把 `lpPayment` 打开时生效（由 content 侧的 ON_PICK 打开），没拿卡的人完全不受影响。
      //
      // ★ 2026-10-16 修 bug（玩家反馈「恶魔契约选择后无法 1:1 消耗目标生命当作资金用」）：
      //   原来这一段**只扣 lp、完全不扣 funds** —— 买得起时资金原封不动、全从目标生命里掏，
      //   玩家看到的是「钱没动、命在白掉」，而且根本不是 1:1。
      //   正确口径：**先把手头的资金花掉，差额部分再 1:1 从目标生命扣**（两者相加正好等于 v）。
      if (this.jibianLpPayment()) {
        const short = v - this.funds;
        if (short <= 0 || this.lp - short < 1) return false;
        this.funds = 0;            // 手头的钱全部花掉（原本漏了这一句）
        this.lp -= short;          // 差额 1:1 从目标生命扣
        this.stats.gold += v;
        this.round.spent += v;
        this.dirty();
        return true;
      }
      return false;
    }
    this.funds -= v;
    this.stats.gold += v;
    this.round.spent += v;
    this.dirty();
    return true;
  }

  /**
   * 恶魔契约: whether a payment may fall back on 目标生命 (owner 2026-10-16).
   * 读惊变计数器（持久、随存档序列化）—— 拿卡时 content 侧 ON_PICK 置 1。
   */
  jibianLpPayment() {
    if (!this.jibianHas('jibian_emoxieyue')) return false;
    const n = this.counters && this.counters['jibian:emoxieyue:pay'];
    return Number.isFinite(n) && n > 0;
  }

  /** onSpend, dispatched once a payment's action is complete (buy / refresh / levelUp / reward / effect). */
  _afterSpend(amount, reason) {
    if (!(amount > 0)) return;
    this.m.dispatch(this, 'onSpend', { amount, reason, total: this.stats.gold });
  }

  /**
   * Bond layer gain (prep-side). `requireActive` = "使已激活的【X】层数+N". Returns layers added: at most the room left
   * under BOND_LAYER_CAP (999, shared/constants.js) — a gain at the cap adds 0 and dispatches nothing.
   */
  addLayers(bondId, n, { requireActive = false, reason = '' } = {}) {
    if (bondId === 'soloShip') { delete this.layers[bondId]; return 0; }
    // ★ 2026-10-23 惊变「集中一点」：窗口期内所有叠层只落到层数最高的**已激活**盟约
    const redirect = this.jizhongyidianTarget(bondId);
    if (redirect) { bondId = redirect; requireActive = true; }
    // ★ 惊变羁绊：层数厨（所有盟约 ×2）/ 脚踏实地（附属盟约 ×2 或 ×3）
    n = this.jibianBondLayerBonus(bondId, n);
    if (!this.gd.bond(bondId) || !Number.isFinite(n) || n <= 0) return 0;
    if (requireActive && !(this.bonds[bondId] && this.bonds[bondId].active)) return 0;
    const before = this.layers[bondId] || 0;
    const add = layerGainRoom(before, Math.floor(n), this.gd.bondLayerCap);
    if (add <= 0) return 0;
    this.layers[bondId] = before + add;
    this.recompute();
    this.m.dispatch(this, 'onLayers', { bondId, from: before, to: before + add, reason });
    return add;
  }

  /**
   * 「集中一点」的重定向目标：窗口期内返回"层数最高的已激活盟约"（与 `bondId` 相同或没有激活盟约时返回 null）。
   * @param {string} bondId 本来要加层的盟约
   * @returns {string|null}
   */
  jizhongyidianTarget(bondId) {
    const until = Number(this.counters && this.counters['jibian:jizhongyidian:until']);
    const round = Number(this.m && this.m.round) || 0;
    if (!(until > round)) return null;
    let top = null, best = -1;
    for (const [id, st] of Object.entries(this.bonds || {})) {
      if (!st || !st.active) continue;
      const L = Number(st.layers) || 0;
      if (L > best) { best = L; top = id; }
    }
    return top && top !== bondId ? top : null;
  }

  /**
   * ★ 惊变「？* /）层数/¥）dgxu」(owner 2026-10-16)：把某盟约的层数**直接设为** `n`（可增可减）。
   *   addLayers 只加不减（`if (add <= 0) return 0`），而"层数随机打乱"必须能把层数调低 —— 这里补这个能力。
   *   封顶走 gd.bondLayerCap，派发 onLayers（reason 标出来，其它读 onLayers 的效果照常工作）。
   */
  setLayers(bondId, n, { reason = '' } = {}) {
    if (bondId === 'soloShip') { delete this.layers[bondId]; return 0; }
    if (!this.gd.bond(bondId) || !Number.isFinite(n)) return 0;
    const before = this.layers[bondId] || 0;
    const to = Math.max(0, Math.min(this.gd.bondLayerCap, Math.floor(n)));
    if (to === before) return 0;
    this.layers[bondId] = to;
    this.recompute();
    this.m.dispatch(this, 'onLayers', { bondId, from: before, to, reason });
    return to - before;
  }

  /**
   * 本局已拥有的惊变 effectId 集合（EffectRef.key = `jibian:<id>`）。
   *
   * ★ 2026-10-21 修（用户反馈：凑齐「包邮」后买 5 阶仍照常扣钱）：
   *   匹配赛阶段的效果存在 **`this.effects`**（choices.js applyDefault 写的 EffectRef 列表），
   *   而 `this.playerEffects` 只有战斗用的 player spec 才有（round.js 生成）。
   *   原实现只读 playerEffects ⇒ 永远空集合 ⇒ `jibianBondTier()` 恒为 0，
   *   「包邮」「层数厨」「脚踏实地」三张羁绊全部静默失效。
   *   这里优先读 effects，保留 playerEffects 兜底（战斗侧仍可能有）。
   */
  jibianOwned() {
    return ownedJibianIdsOf(this);
  }

  /** 某个惊变羁绊已达成的档位（0 = 没激活）。 */
  jibianBondTier(bondId) {
    try {
      const act = jbActiveBonds(this.jibianOwned());
      const hit = act.find((a) => a.def.id === bondId);
      return hit ? (hit.def.tiers.indexOf(hit.tier) + 1) : 0;   // 1 起算的档位
    } catch { return 0; }
  }

  /** Effective price of a shop slot after onPrice modifiers (never negative). */
  priceOf(slot) {
    if (!slot) return 0;
    // ★ 惊变羁绊「包邮」：买 5 阶（二档再加 6 阶）不花钱
    try {
      const ship = this.jibianBondTier('freeship');
      if (ship >= 1 && slot.kind === 'chess') {
        const tier = Number((this.gd.chess(slot.id) || {}).tier) || 0;
        if (tier === 5 || (ship >= 2 && tier === 6)) return 0;
      }
    } catch { /* 羁绊出错不影响买卡 */ }
    const ev = { slot, kind: slot.kind, id: slot.id, price: slot.basePrice };
    this.m.dispatch(this, 'onPrice', ev, { quiet: true });
    const p = Number(ev.price);
    return Number.isFinite(p) ? Math.max(0, Math.round(p)) : slot.basePrice;
  }

  /**
   * 惊变羁绊的层数加成：层数厨（阈值 3）→ 所有盟约 ×2；
   * 脚踏实地（阈值 2 / 3）→ **附属盟约**（非核心）×2 / ×3。两者不叠乘，取较大的那个。
   * @param {string} bondId @param {number} n @returns {number}
   */
  jibianBondLayerBonus(bondId, n) {
    const v = Number(n) || 0;
    if (!(v > 0) || !bondId) return n;
    try {
      const layers = this.jibianBondTier('layers_fan');            // 1 = 已达成
      const steady = this.jibianBondTier('steady');                // 1 或 2 档
      const rec = this.gd && typeof this.gd.bond === 'function' ? this.gd.bond(bondId) : null;
      const isCore = !!(rec && rec.isCore === true);
      let mul = 1;
      if (layers >= 1) mul = 2;
      if (!isCore && steady >= 1) mul = Math.max(mul, steady + 1);  // 一档 ×2、二档 ×3
      return Math.round(v * mul);
    } catch { return n; }
  }

  _rollChessSlot() {
    // 100-seat variant: the roll reads THIS player's own pool (full copy counts, player/rules.js), not the match's
    // shared one.
    //
    // `extra` is this player's 自选 stock and it is NOT optional: a DIY slot is `isDiy`, and `gd.visibleChess`
    // excludes those (`!c.isDiy`), so a slotted 自选 piece is in NO pool's `entries`. Without `extra` the shop can
    // never offer one and the rate is exactly 0 (measured: 0 hits in 100000 rolls) — while the audit has always
    // assumed they can be rolled (audit.js:132, invariants.js:178/184). Copy accounting stays separate: `poolOf(base)`
    // routes these ids to the player's `diyStock` (player/rules.js). `diyRollEntries()` applies both 0.2.0 gates —
    // copies left, and the 调度中心 at the slot's own shopLevel.
    // 作弊模式 (SP_CHEAT=1): 改成只从【本局自选编队选的那 4 个干员】里刷 —— 即"外援"。
    // cheatRollOpts 返回 `{ filter: () => false, extra, tier: 6 }`:filter 把共享池整个排除,
    // extra 就是这几张自选卡;库存仍走 diyStock,所以买了会少、卖回会多,账目依然自洽。
    // chessOf 传 this.gd 的取记录函数,好让 filter 用 isDiy 判断"这张是不是自选卡"。
    const diyExtra = this.diyRollEntries();
    const diyForCheat = cheatDiyEntries(this.diyStock && this.diyStock.entries, this);
    const id = this.pool().roll(this.m.rngShop, {
      maxTier: this.shop.level,
      extra: diyForCheat || diyExtra,
      ...cheatRollOpts(diyForCheat, (cid) => this.gd.chess(cid), this),
    });
    return id ? { kind: 'chess', id, basePrice: this.gd.chessPrice(id), frozen: false, sold: false } : null;
  }

  _rollItemSlot() {
    const id = this.pool().rollItem(this.m.rngShop, this.shop.level);
    return id ? { kind: 'item', id, basePrice: this.gd.itemPrice(id), frozen: false, sold: false } : null;
  }

  /**
   * Reroll the shop. keepFrozen → frozen unsold slots survive (round start); otherwise everything is rerolled
   * (manual refresh). Slot counts follow the current level.
   */
  rollShop({ keepFrozen = false } = {}) {
    const { chess: nChess, item: nItem } = this.gd.shopSlots(this.shop.level);
    const old = this.shop.slots;
    const layout = this.shop.layout || { chess: old.length, item: 0 };
    const oldChess = old.slice(0, layout.chess);
    const oldItems = old.slice(layout.chess);
    const keep = (s, kind) => (keepFrozen && s && s.kind === kind && !s.sold && s.frozen ? { ...s } : null);
    // frozen slots keep their position; sold / empty / unfrozen positions are rerolled
    const slots = [];
    for (let i = 0; i < nChess; i++) slots.push(keep(oldChess[i], 'chess') ?? this._rollChessSlot());
    for (let i = 0; i < nItem; i++) slots.push(keep(oldItems[i], 'item') ?? this._rollItemSlot());
    this.shop.slots = slots;
    this.shop.layout = { chess: nChess, item: nItem };
    for (const s of slots) if (s) s.frozen = this.shop.frozen;
    this.dirty();
  }

  /**
   * The 调度中心's upgrade opens the new level's extra slots at once, each with a new card drawn at the new level; the
   * cards already shown stay where they are (chess slots keep their index, the item slot stays after them). Official: the
   * tutorial's 休整期 page 「升级：…升级后将出现更多的商品栏位、可调度干员以及新装备」; the community report of 2026-10-06
   * (item 19) 「升级商店获得新的商店位时用新卡补上，而不是空着」. Until 0.2.0 the extra slots waited for the next roll (a
   * refresh or the round start). [ASSUMED] the new card follows the freeze toggle, as a manual refresh's cards do.
   */
  _openLevelSlots() {
    const { chess: nChess, item: nItem } = this.gd.shopSlots(this.shop.level);
    const old = this.shop.slots;
    const layout = this.shop.layout || { chess: old.length, item: 0 };
    if (nChess <= layout.chess && nItem <= layout.item) return;
    const chess = old.slice(0, layout.chess);
    const items = old.slice(layout.chess);
    const fresh = (s) => { if (s) s.frozen = this.shop.frozen; return s; };
    while (chess.length < nChess) chess.push(fresh(this._rollChessSlot()));
    while (items.length < nItem) items.push(fresh(this._rollItemSlot()));
    this.shop.slots = [...chess, ...items];
    this.shop.layout = { chess: chess.length, item: items.length };
  }

  /** Combat start: unfrozen slots are emptied (research 01 A1). */
  clearUnfrozenShop() {
    this.shop.slots = this.shop.slots.map((s) => (s && s.frozen && !s.sold ? s : null));
    this.dirty();
  }

  /**
   * g.buy {slot}. A full regular hand refuses every purchase, also one whose copy would complete a merge at once (PRTS
   * 卫戍协议/帮助 §手牌区 "当常规手牌区全满无空位时，玩家将无法执行使手牌溢出的操作" — "例如招募/购入等通常情况下会增加手牌的
   * 操作"; BWIKI 盟约 "当整备区达到上限后将无法进行涉及到整备区的操作（购买、撤回等）"; GitHub #82: the reporter's first-hand
   * check in the official game, "哪怕是已经有了两个相同干员情况"). Until 0.1.3 such a purchase was let through.
   */
  /**
   * 买得起吗 —— 三道资金闸门(买/刷新/升级)都过这一个判据,免得漏掉任何一处。
   *
   * 作弊模式 (SP_CHEAT=1) 恒为真:这就是"无限金钱"。之所以还要这道闸门而不是直接把 funds 设成天文数字,
   * 是因为那样会污染 `serialize()` 里的存档、以及所有读 funds 的统计与效果;闸门放行更干净,
   * 而且 `spend()` 在作弊模式下也不下减 funds,所以连"卖东西返钱"之类的账目都不会出现负数。
   */
  canAfford(price) {
    if (cheatEnabled()) return true;
    if (this.funds >= price) return true;
    // ★ 恶魔契约（惊变, owner 2026-10-16）：资金不足时看目标生命能不能补上（保底 1 点）。
    //   买/刷新/升级三道闸门共用这里，所以放行一次就三处都通 —— 与 spend() 的判定逐字对应。
    if (this.jibianLpPayment()) {
      const short = price - this.funds;
      if (short > 0 && this.lp - short >= 1) return true;
    }
    return false;
  }

  buy(slotIdx) {
    const g = this._gate(); if (g) return g;
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= this.shop.slots.length) return fail(ERR.BAD_TARGET);
    const slot = this.shop.slots[slotIdx];
    if (!slot) return fail(ERR.BAD_TARGET);
    if (slot.sold) return fail(ERR.SOLD_OUT);
    const price = this.priceOf(slot);
    if (!this.canAfford(price)) return fail(ERR.NO_FUNDS);
    const handFull = freeSlot(this.hand) < 0;
    let piece;
    if (slot.kind === 'chess') {
      const rec = this.gd.chess(slot.id);
      // a DIY slot sells only as this player's own 自选 piece (a slotted slot's record carries `diyFor`)
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET);
      const base = this.gd.baseIdOf(slot.id);
      const need = rec.isGolden ? this.gd.goldenCopies : 1;
      const pool = this.poolOf(base);
      if (pool.has(base) && pool.left(base) < need) return fail(ERR.SOLD_OUT);
      if (handFull) return fail(ERR.HAND_FULL);
      this.spend(price);
      slot.sold = true;
      piece = this.acquireChess(slot.id, { source: 'buy' });
    } else {
      if (!this.gd.item(slot.id)) return fail(ERR.BAD_TARGET);
      if (handFull) return fail(ERR.HAND_FULL);
      this.spend(price);
      slot.sold = true;
      piece = this.acquireItem(slot.id, { source: 'buy' });
    }
    this.stats.buys++;
    this.round.buys++;
    this.m.dispatch(this, 'onBuy', { piece, slot, price, kind: slot.kind });
    this._afterSpend(price, 'buy');
    this.recompute();
    return OK;
  }

  refresh() {
    const g = this._gate(); if (g) return g;
    const free = this.shop.freeRefreshes > 0;
    const price = free ? 0 : this.gd.refreshPrice;
    if (!free && !this.canAfford(price)) return fail(ERR.NO_FUNDS);
    if (free) this.shop.freeRefreshes--;
    else this.spend(price);
    this.rollShop({ keepFrozen: false });
    this.stats.refreshes++;
    this.round.refreshes++;
    this.m.dispatch(this, 'onRefresh', { slots: this.shop.slots, free, price });
    this._afterSpend(price, 'refresh');
    this.dirty();
    return OK;
  }

  /**
   * 惊变「维多利亚的秘密」(用户 2026-10-12)：本回合的那一次**特殊刷新**（客户端商店栏的按钮 → C2S `g.specialRefresh`）。
   * 资格 = 持有这张卡 + 本回合的次数还没用掉；通过后把"待消费"标记写下再走一次**免费**的普通刷新 ——
   * jibian.js 的 HOOKS.onRefresh 会消费这个标记，把该次商店换成"只出【维多利亚】、无视商店等级"的槽位。
   * 计数器键与 server/sim/content/jibian.js 的 K 一致（那边是这张卡的实现，这边只做资格校验；改动要同步）。
   */
  specialRefresh() {
    const g = this._gate(); if (g) return g;
    // ★ owner 2026-10-16：「神秘」商店 也走这个按钮（客户端按钮只看 priv.spRefresh > 0）。
    //   两张卡共用入口，按持有情况分别校验与消耗；都没拿/都没次数就照旧报错。
    const hasVic = this.jibianHas('jibian_weiduoliyademimi');
    const hasMys = this.jibianHas('jibian_shenmishangdian');
    if (!hasVic && !hasMys) return fail(ERR.BAD_MSG, 'no special refresh card');
    const mysLeft = this.jibianMysticRefreshLeft();
    const useMys = hasMys && mysLeft > 0 && !(hasVic && this.jibianSpecialRefreshLeft() > 0);
    if (useMys) {
      this.counters['jibian:shenmishangdian:charge'] = mysLeft - 1;
      this.counters['jibian:shenmishangdian:pending'] = 1;
    } else {
      if (this.jibianSpecialRefreshLeft() < 1) return fail(ERR.ALREADY, 'no special refresh left this round');
      this.counters['jibian:weiduoliyademimi:charge'] = this.jibianSpecialRefreshLeft() - 1;
      this.counters['jibian:weiduoliyademimi:pending'] = 1;
    }
    this.shop.freeRefreshes += 1;                 // 特殊刷新本身免费（onRefresh 里再改槽位）
    return this.refresh();
  }

  /**
   * 惊变「”神秘“商店」(owner 2026-10-16)：**独立**的特殊刷新入口 → C2S `g.mysticRefresh`。
   *
   * ★ 为什么独立：它和「维多利亚的秘密」语义不同（一个无视商店等级、一个只出维多利亚干员），
   *   而且**两张卡可以同时持有** —— 共用一个按钮 + 一个 C2S 时，两边都有次数就只能用其中一个
   *   （旧实现里神秘商店被静默让给了维多利亚），玩家没法分别发动。
   */
  mysticRefresh() {
    const g = this._gate(); if (g) return g;
    if (!this.jibianHas('jibian_shenmishangdian')) return fail(ERR.BAD_MSG, 'no 神秘商店');
    const left = this.jibianMysticRefreshLeft();
    if (left < 1) return fail(ERR.ALREADY, 'no mystic refresh left');
    this.counters['jibian:shenmishangdian:charge'] = left - 1;
    this.counters['jibian:shenmishangdian:pending'] = 1;   // onRefresh 消费：无视商店等级
    this.shop.freeRefreshes += 1;                          // 特殊刷新本身免费
    return this.refresh();
  }

  /** 玩家手里有没有某张惊变卡（ref 的 key 是 `jibian:<effectId>`）。 */
  jibianHas(effectId) {
    return Array.isArray(this.effects) && this.effects.some((e) => e && e.key === `jibian:${effectId}`);
  }

  /**
   * 惊变「神秘」商店：还剩几次特殊刷新（0 = 没有这张卡 / 次数用完了）。
   * 计数器 `jibian:shenmishangdian:charge` 由 content 侧维护（拿卡 +1、每 3 回合 +1），这里只读。
   */
  jibianMysticRefreshLeft() {
    if (!this.jibianHas('jibian_shenmishangdian')) return 0;
    const n = this.counters && this.counters['jibian:shenmishangdian:charge'];
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** 惊变「维多利亚的秘密」本回合还剩几次特殊刷新（0 = 没有这张卡，或本回合已经用完）。 */
  jibianSpecialRefreshLeft() {
    if (!this.jibianHas('jibian_weiduoliyademimi')) return 0;
    const n = this.counters && this.counters['jibian:weiduoliyademimi:charge'];
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /**
   * 惊变「板藤」(用户 2026-10-12)：商店栏的「出售板藤」键位 → C2S `g.sellBanteng`。
   * 卖价 = 计数器 `jibian:banteng:value`（起价 4、每回合 +4，由 server/sim/content/jibian.js 维护）；套现后这张卡
   * 消失（按钮跟着不见）。这条卡**不再发那件卖不掉的装备** —— 引擎的 sell() 只接受 kind==='chess' 的棋子。
   * 计数器键与 sim/content/jibian.js 的 K 一致（那边是这张卡的实现，这边只做资格校验；改动要同步）。
   */
  sellBanteng() {
    const g = this._gate(); if (g) return g;
    const price = this.jibianBantengValue();
    if (!(price > 0)) return fail(ERR.BAD_MSG, 'no 板藤');
    this.counters['jibian:banteng:value'] = 0;
    const i = Array.isArray(this.effects) ? this.effects.findIndex((e) => e && e.key === 'jibian:jibian_banteng') : -1;
    if (i >= 0) this.effects.splice(i, 1);
    this.addFunds(price, { reason: 'sell' });
    this.m.toast(this, 'info', `出售板藤：+${price} 资金`);
    this.dirty();
    return OK;
  }

  /**
   * 惊变「死亡回归」(owner 2026-10-16)：商店栏的按键 → C2S `g.deathReturn`。
   *
   * 口径（owner 原话）：「按下按钮后使该玩家目标生命降为 0 且立刻淘汰，3s 后全体玩家重新进入该回合整备阶段，
   * 此玩家恢复扣除的目标生命，并把效果改为『你激怒了某位大人，她不再保护你』，然后此惊变失效」。
   *
   * ★ 刻意**不调用 eliminate()**：那个函数会把棋盘/手牌/临时区的棋子全部还回卡池、清空商店与资金
   *   （round.js eliminate），对"假淘汰"来说等于真破产。这里只标记 alive=false（保留棋子），
   *   3 秒后 startRound(同一回合) 会把他恢复（startRound 只处理 alivePlayers，所以先把 alive 置回 true）。
   */
  deathReturn() {
    const g = this._gate(); if (g) return g;
    if (!this.jibianHas('jibian_siwanghuigui')) return fail(ERR.BAD_MSG, 'no 死亡回归');
    if (this.alive === false) return fail(ERR.ALREADY, 'already out');
    if (!this.deathReturnTrigger({ auto: false })) return fail(ERR.ALREADY, 'already used');
    return OK;
  }

  /**
   * 「死亡回归」的**共用触发**（按钮 / 被淘汰自动）：
   * 标记一次性、记下要回到的回合与被扣的生命、广播、排 3 秒后的回退。
   *
   * @param {{ auto?: boolean }} [o] `auto` = 由 settle 的淘汰判定调用（那时 lp 已经是 0）
   * @returns {boolean} 是否真的触发了
   */
  deathReturnTrigger(o = {}) {
    const key = 'jibian:siwanghuigui:used';
    if (this.counters && this.counters[key] > 0) return false;   // 仅一次
    if (this.counters) this.counters[key] = 1;
    this._deathReturnRound = this.m.round;
    // 被淘汰自动触发时 lp 已经是 0（结算里先降后判），此时没有"被扣的生命"可恢复，
    // 回退后给一个保底 1（_deathReturnRewind 里还有 +3 的保底）。
    this._deathReturnLp = Math.max(0, Number(this.lp) || 0);
    this.alive = false;
    this.ready = false;
    this.lp = 0;
    this.dirty();
    this.m.deathReturnAnnounce(this, { auto: o && o.auto === true });
    this.m.setDeadline(3, () => this.m._deathReturnRewind(this), { silent: this.m.soloUntimed });
    return true;
  }

  /** 板藤当前卖价（没有这张卡 / 计数器缺失 → 0）。商店栏的「出售板藤」键位用它显示金额。 */
  jibianBantengValue() {
    if (!this.jibianHas('jibian_banteng')) return 0;
    const n = this.counters && this.counters['jibian:banteng:value'];
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /**
   * 惊变「高卢银行支票」(用户 2026-10-13)：商店栏的「提现」键位 → C2S `g.cashCheque`。
   *
   * ★ 2026-10-17（用户：「其实是在原有的基础上增加或减少 不是变成10或-10」）：金额是**相对资金的增减量**，
   * 可以是 +10 / 0 / -10 / +100 —— 所以这里**不钳正数**，负数必须真的扣钱（资金不会低于 0，
   * `addFunds` 内部就是 `Math.max(0, funds + v)`）。原来 `n > 0 ? … : 0` 把 -10 变成 0，
   * 那张卡就变成纯粹的白给（掷到 -10 与掷到 0 不可区分，唯一的惩罚档消失）。
   *
   * 0 = 这次什么都没抽到：按钮置灰、这里再拒一次（不消耗卡，下个整备阶段重掷）。
   * 提现后这张卡被兑现掉（按钮跟着不见），概率与增量一并清回初始。
   * 计数器键与 sim/content/jibian.js 的 K 一致（那边是这张卡的实现，这边只做资格校验；改动要同步）。
   */
  cashCheque() {
    const g = this._gate(); if (g) return g;
    const amount = this.jibianChequeValue();
    if (amount === 0) return fail(ERR.BAD_MSG, 'cheque: nothing to cash');
    this.counters['jibian:gaoluzhipiao:value'] = 0;
    this.counters['jibian:gaoluzhipiao:w10'] = 33;
    this.counters['jibian:gaoluzhipiao:w0'] = 33;
    this.counters['jibian:gaoluzhipiao:wm10'] = 33;
    const i = Array.isArray(this.effects) ? this.effects.findIndex((e) => e && e.key === 'jibian:jibian_gaoluzhipiao') : -1;
    if (i >= 0) this.effects.splice(i, 1);
    this.addFunds(amount, { reason: 'jibian' });
    this.m.toast(this, 'info', `提现高卢银行支票：${amount > 0 ? '+' : ''}${amount} 资金`);
    this.dirty();
    return OK;
  }

  /**
   * 高卢银行支票本次的提现金额（没有这张卡 / 计数器缺失 → 0）。
   * 商店栏的「提现」键位用它判断显不显示与禁不禁用；**负数照原样返回**（那是要扣的钱）。
   */
  jibianChequeValue() {
    if (!this.jibianHas('jibian_gaoluzhipiao')) return 0;
    const n = this.counters && this.counters['jibian:gaoluzhipiao:value'];
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  freeze() {
    const g = this._gate(); if (g) return g;
    this.shop.frozen = !this.shop.frozen;
    for (const s of this.shop.slots) if (s && !s.sold) s.frozen = this.shop.frozen;
    this.dirty();
    return OK;
  }

  levelUp() {
    const g = this._gate(); if (g) return g;
    if (this.shop.level >= this.gd.maxShopLevel) return fail(ERR.MAX_LEVEL);
    const price = Math.max(0, this.shop.upgradePrice);
    if (!this.canAfford(price)) return fail(ERR.NO_FUNDS);
    this.spend(price);
    this.shop.level++;
    this.shop.upgradePrice = this.gd.upgradeBase(this.shop.level) ?? 0;
    this._openLevelSlots();
    this.m.tickerFor('SHOP_LEVEL', [this.name, String(this.shop.level)], { playerId: this.playerId, param: String(this.shop.level) });
    this.m.dispatch(this, 'onLevelUp', { level: this.shop.level, price });
    // 炸惊模拟 规则4: reaching one of the mode's gift levels hands the player a free 变形同构体 (which 规则7 gives its own
    // third equip slot) — granted like any other item, so it merges into the 精锐 copy when a second one arrives
    const gift = this.gd.shopGift;
    if (gift && gift.levels.includes(this.shop.level)) this.acquireItem(gift.itemId, { source: 'shopLevel' });
    this._afterSpend(price, 'levelUp');
    this.dirty();
    return OK;
  }

  sell(uid) {
    const g = this._gate(); if (g) return g;
    // ★ 2026-10-15（用户，惊变「红松骑士团」）：选了那张卡的【本回合】不能出售干员。
    //   计数器里存的是「禁用是在第几回合发生的」，跨回合自然失效 ⇒ 不必在 onRoundStart 清理。
    //   键与 server/sim/content/jibian.js 的 K.pinusNoSell 一致（那边写 P + 'hongsongqishituan:nosell'）。
    // ★ 2026-10-24 修：`ps.round` 是【本回合统计对象】（{sells,…}），不是回合号 —— 原来拿它和
    //   计数器里的回合号比较永远不相等，所以「本回合不能出售」从来没生效过。回合号在 `this.m.round`。
    if (this.counters && this.counters['jibian:hongsongqishituan:nosell'] === this.m.round) {
      this.m.toast(this, 'warn', '红松骑士团：本回合不能出售干员');
      return fail(ERR.BAD_MSG, 'selling is disabled this round (红松骑士团)');
    }
    const loc = this.find(uid);
    if (!loc) return fail(ERR.BAD_TARGET);
    if (loc.piece.kind !== 'chess') return fail(ERR.BAD_TARGET, loc.piece.kind === 'item' ? 'items cannot be sold' : 'tokens cannot be sold');
    const piece = loc.piece;
    // ★ 2026-10-22（owner）：装备放不下时**不再拒绝出售**（一个干员叠了好几把锤子时手牌放不下，玩家就卖不掉了）。
    //   现在照常卖：能放进手牌/整备区的照放，放不下的按该装备的 price 折算成资金，并弹一条提示。
    // ★ 2026-10-22（owner）：放不下的装备**直接销毁**（不折算资金）——只是为了让干员能卖出去。
    const itemList = piece.items || [];
    this._detach(loc);
    this.removeTokensOf(piece.uid);
    let itemDestroyed = 0;
    for (const it of itemList) {
      if (this.stow(it, { allowTemp: true })) continue;
      itemDestroyed++;
    }
    piece.items = [];
    if (itemDestroyed > 0) this.m.toast(this, 'warn', `装备放不下：${itemDestroyed} 件已销毁`);
    this.returnCopies(piece);
    const ev = { piece, gain: this.gd.sellPrice(piece.id) };
    this.m.dispatch(this, 'onSold', ev);
    const gain = Number.isFinite(ev.gain) ? Math.max(0, Math.trunc(ev.gain)) : 1;
    this.addFunds(gain, { reason: 'sell' });
    this.stats.sells++;
    this.round.sells++;
    this.checkItemMerges();
    this.recompute();
    return OK;
  }
}
