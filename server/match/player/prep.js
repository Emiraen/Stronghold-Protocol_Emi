import { ERR, PHASE } from "../../../shared/constants.js";

import { freeSlot } from "../board.js";

import { OK, fail } from "./common.js";
export class PlayerPrep {
  _gate({ allowWhenReady = false } = {}) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (this.ready && !allowWhenReady) return fail(ERR.WRONG_PHASE, 'ready');
    return null;
  }

  pickReward(idx) {
    const g = this._gate(); if (g) return g;
    const offer = this.offers[0];
    if (!offer) return fail(ERR.BAD_TARGET, 'no reward');
    if (!Number.isInteger(idx) || idx < 0 || idx >= offer.slots.length) return fail(ERR.BAD_TARGET);
    const slot = offer.slots[idx];
    if (!slot || slot.sold) return fail(ERR.SOLD_OUT);
    const handFull = freeSlot(this.hand) < 0;
    if (slot.kind === 'item') {
      if (!this.gd.item(slot.id)) return fail(ERR.BAD_TARGET);
      if (!this.m.itemPool.canGain(slot.id)) return fail(ERR.SOLD_OUT);
    } else {
      const rec = this.gd.chess(slot.id);
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET);
      const base = this.gd.baseIdOf(slot.id);
      const need = rec.isGolden ? this.gd.goldenCopies : 1;
      if (this.poolOf(base).has(base) && this.poolOf(base).left(base) < need) return fail(ERR.SOLD_OUT);
      if (handFull && !this.completesChessMerge(slot.id)) return fail(ERR.HAND_FULL);
    }
    const price = Number.isFinite(slot.price) && slot.price > 0 ? Math.trunc(slot.price) : 0;
    if (price > this.funds) return fail(ERR.NO_FUNDS);
    slot.sold = true;
    this.offers.shift();
    if (price > 0) this.spend(price);
    if (slot.kind === 'item') this.acquireItem(slot.id, { source: 'reward' });
    else this.acquireChess(slot.id, { source: 'reward' });
    this._afterSpend(price, 'reward');
    this.recompute();
    return OK;
  }

  setReady(on) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (on && !this.tempEmpty) return fail(ERR.TEMP_NOT_EMPTY);
    if (on && this.personalChoice) return fail(ERR.BAD_TARGET, '请先完成教鞭选择');
    if (this.ready === !!on) return OK;
    this.ready = !!on;
    // un-ready: the player can act again, so what overflowed while it was ready is due at this prep's deadline
    if (!on) for (const p of this.temp) if (p && this.tempDue(p) > this.prepsEnded) this._tempDue.set(p.uid, this.prepsEnded);
    this.dirty();
    this.m.onReadyChanged(this);
    return OK;
  }

  resolveTemp() {
    const unlimitedItems = !this.m.ranked && (this.m.variant === 'entertainment_multi' ||
      this.m.variant === 'entertainment_cyclops' ||
      this.m.variant === 'entertainment_endless');
    let changed = false;
    for (let i = 0; i < this.temp.length; i++) {
      const p = this.temp[i];
      if (!p || (unlimitedItems && p.kind === 'item') || this.tempDue(p) > this.prepsEnded) continue;
      this.temp[i] = null;
      this._tempDue.delete(p.uid);
      changed = true;
      if (p.kind === 'chess') {
        this.removeTokensOf(p.uid);
        this.returnCopies(p);
      }
    }
    if (changed) this.recompute();
  }
}
