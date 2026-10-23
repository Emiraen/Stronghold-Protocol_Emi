import { ERR, layerGainRoom, CYCLOPS_EXP_PRICE, CYCLOPS_EXP_PRICE_SCALE, CYCLOPS_EXP_NEED_SCALE } from "../../../shared/constants.js";

import { freeSlot } from "../board.js";

import { OK, fail } from "./common.js";
import { cyclopsLayerGain, cyclopsVictoriaRewards, cyclopsRefreshChance, cyclopsRefreshHooks, cyclopsPaidRefreshRewards } from '../cyclops.js';
import { isolateRewardStep } from '../rewardRecovery.js';
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
    if (v > this.funds) return false;
    this.funds -= v;
    this.stats.gold += v;
    this.round.spent += v;
    this.dirty();
    return true;
  }

  _afterSpend(amount, reason) {
    if (!(amount > 0)) return;
    this.m.dispatch(this, 'onSpend', { amount, reason, total: this.stats.gold });
  }

  addLayers(bondId, n, { requireActive = false, reason = '', receipt = null } = {}) {
    if (receipt) receipt.stage = 'preflight';
    if (!this.gd.bond(bondId) || !Number.isFinite(n) || n <= 0) {
      if (receipt) receipt.noop = 'invalid';
      return 0;
    }
    if (requireActive && !(this.bonds[bondId] && this.bonds[bondId].active)) {
      if (receipt) receipt.noop = 'inactive';
      return 0;
    }
    const before = this.layers[bondId] || 0;
    // Cyclops modifiers may consume fractional remainders before the layer write; never blindly replay them.
    if (receipt && this.m.isCyclops) receipt.stage = 'preparing';
    const add = layerGainRoom(before, Math.floor(this.m.isCyclops ? cyclopsLayerGain(this, bondId, n) : n), this.m.isEndless ? Infinity : undefined);
    if (add <= 0) {
      if (receipt) receipt.noop = 'no-layer-room';
      return 0;
    }
    if (receipt) receipt.stage = 'committing';
    this.layers[bondId] = before + add;
    if (receipt) receipt.stage = 'committed';
    isolateRewardStep(this.m, `layers:${bondId}:recompute`, () => this.recompute());
    isolateRewardStep(this.m, `layers:${bondId}:onLayers`, () =>
      this.m.dispatch(this, 'onLayers', { bondId, from: before, to: before + add, reason }));
    isolateRewardStep(this.m, `layers:${bondId}:victoria`, () => cyclopsVictoriaRewards(this.m, this));
    return add;
  }

  priceOf(slot) {
    if (!slot) return 0;
    const ev = { slot, kind: slot.kind, id: slot.id, price: slot.basePrice };
    this.m.dispatch(this, 'onPrice', ev, { quiet: true });
    const p = Number(ev.price);
    return Number.isFinite(p) ? Math.max(0, Math.round(p)) : slot.basePrice;
  }

  _rollChessSlot() {
    // the slotted 自选 pieces join the draw once the 调度中心 reaches their slot's level (player/diy.js diyRollEntries)
    const id = this.pool.roll(this.m.rngShop, { maxTier: this.shop.level, extra: this.diyRollEntries() });
    return id ? { kind: 'chess', id, basePrice: this.gd.chessPrice(id), frozen: false, sold: false } : null;
  }

  _rollItemSlot() {
    const id = this.pool.rollItem(this.m.rngShop, this.shop.level, this.m.itemPool);
    return id ? { kind: 'item', id, basePrice: this.gd.itemPrice(id), frozen: false, sold: false } : null;
  }

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

  clearUnfrozenShop() {
    this.shop.slots = this.shop.slots.map((s) => (s && s.frozen && !s.sold ? s : null));
    this.dirty();
  }

  buy(slotIdx) {
    const g = this._gate(); if (g) return g;
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= this.shop.slots.length) return fail(ERR.BAD_TARGET);
    const slot = this.shop.slots[slotIdx];
    if (!slot) return fail(ERR.BAD_TARGET);
    if (slot.sold) return fail(ERR.SOLD_OUT);
    const price = this.priceOf(slot);
    if (this.funds < price) return fail(ERR.NO_FUNDS);
    const handFull = freeSlot(this.hand) < 0;
    let piece;
    if (slot.kind === 'chess') {
      const rec = this.gd.chess(slot.id);
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET);
      const base = this.gd.baseIdOf(slot.id);
      const need = rec.isGolden ? this.gd.goldenCopies : 1;
      if (this.poolOf(base).has(base) && this.poolOf(base).left(base) < need) return fail(ERR.SOLD_OUT);
      if (handFull && !this.completesChessMerge(slot.id)) return fail(ERR.HAND_FULL);
      this.spend(price);
      slot.sold = true;
      piece = this.acquireChess(slot.id, { source: 'buy' });
    } else {
      if (!this.gd.item(slot.id)) return fail(ERR.BAD_TARGET);
      if (!this.m.itemPool.canGain(slot.id)) return fail(ERR.SOLD_OUT);
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
    const hooks = cyclopsRefreshHooks(this);
    const stored = this.shop.freeRefreshes > 0;
    if (!stored && this.funds < this.gd.refreshPrice) return fail(ERR.NO_FUNDS);
    const chances = hooks.filter(e => e.params?.refreshFree || e.params?.freeChance > 0);
    const chance = stored ? 0 : cyclopsRefreshChance(chances);
    const triggered = chance > 0 && this.m.rngMeta() < chance;
    const free = stored || triggered;
    const price = free ? 0 : this.gd.refreshPrice;
    // 有限免费次数独立消耗，不抽取概率，也不累计或重置概率馈赠的保底。
    if (!stored) for (const e of chances) {
      const misses = Number.isFinite(e.params.misses) ? Math.max(0, Math.trunc(e.params.misses)) : 0;
      e.params.misses = triggered ? 0 : Math.min(Number.MAX_SAFE_INTEGER, misses + 1);
    }
    if (stored) this.shop.freeRefreshes--;
    else if (price) this.spend(price);
    this.rollShop({ keepFrozen: false });
    this.stats.refreshes++;
    this.round.refreshes++;
    this.m.dispatch(this, 'onRefresh', { slots: this.shop.slots, free, price });
    this._afterSpend(price, 'refresh');
    cyclopsPaidRefreshRewards(this.m, this, price, hooks);
    this.dirty();
    return OK;
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
    // 舟铲铲之战：升级按钮仍为 2 金币购买 1 经验，经验攒满自动升级（可连升）
    if (this.m.isCyclops) return this._cyclopsBuyExp(1);
    const price = Math.max(0, this.shop.upgradePrice);
    if (this.funds < price) return fail(ERR.NO_FUNDS);
    this.spend(price);
    this.shop.level++;
    this.shop.upgradePrice = this.gd.upgradeBase(this.shop.level) ?? 0;
    this.m.tickerFor('SHOP_LEVEL', [this.name, String(this.shop.level)], { playerId: this.playerId, param: String(this.shop.level) });
    this.m.dispatch(this, 'onLevelUp', { level: this.shop.level, price });
    this._afterSpend(price, 'levelUp');
    this.dirty();
    return OK;
  }

  /** 舟铲铲升级门槛为普通模式的 75%，向上取整；每经验仍花 2 金币。 */
  _cyclopsExpNeeded(level) {
    const base = Math.max(1, this.gd.upgradeBase(level) ?? 1);
    return Math.max(1, Math.ceil(base * CYCLOPS_EXP_PRICE_SCALE * CYCLOPS_EXP_NEED_SCALE));
  }

  /** 舟铲铲之战：购买 n 点经验（每点 2 金币）。经验攒满后自动升级并结转余量。 */
  _cyclopsBuyExp(n) {
    let bought = Math.max(1, Math.trunc(n));
    const cost = bought * CYCLOPS_EXP_PRICE;
    if (this.funds < cost) return fail(ERR.NO_FUNDS);
    let exp = (this.shop.exp || 0) + bought;
    this.spend(cost);
    let levels = 0;
    // 连续升级：经验足够下一级就升（结转余量）
    while (this.shop.level < this.gd.maxShopLevel && exp >= this._cyclopsExpNeeded(this.shop.level)) {
      exp -= this._cyclopsExpNeeded(this.shop.level);
      this.shop.level++;
      levels++;
    }
    if (this.shop.level >= this.gd.maxShopLevel) exp = 0; // 满级后经验清零
    this.shop.exp = exp;
    if (levels > 0) {
      this.m.tickerFor('SHOP_LEVEL', [this.name, String(this.shop.level)], { playerId: this.playerId, param: String(this.shop.level) });
      this.m.dispatch(this, 'onLevelUp', { level: this.shop.level, price: cost });
    }
    this._afterSpend(cost, 'buyExp');
    this.dirty();
    return OK;
  }

  sell(uid) {
    const g = this._gate(); if (g) return g;
    const loc = this.find(uid);
    if (!loc) return fail(ERR.BAD_TARGET);
    if (loc.piece.kind !== 'chess') return fail(ERR.BAD_TARGET, loc.piece.kind === 'item' ? 'items cannot be sold' : 'tokens cannot be sold');
    const piece = loc.piece;
    // Returned equipment always has persistent overflow storage.
    this._detach(loc);
    this.removeTokensOf(piece.uid);
    for (const it of piece.items || []) {
      if (!this.stow(it, { allowTemp: true })) this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: item ${it.id} lost on sell (no space)`);
    }
    piece.items = [];
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
