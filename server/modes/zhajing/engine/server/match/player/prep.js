// server/match/player/prep.js — PlayerState methods: the gate of every prep intent (_gate: alive, PREP, not ready),
// g.reward (a reward offer's pick), Ready (refused while temp holds pieces) and the resolution of the temp pieces due
// at a prep's deadline.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR, PHASE } from '../../../shared/constants.js';
import { freeSlot } from '../board.js';
import { OK, fail } from './common.js';

export class PlayerPrep {
  _gate({ allowWhenReady = false } = {}) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (this.ready && !allowWhenReady) return fail(ERR.WRONG_PHASE, 'ready');
    return null;
  }

  /**
   * g.reward {idx}: the pick of the first queued offer (promotion reward, a strategy's special refresh, an item offer).
   * A pick is a 招募 like a purchase: a full regular hand refuses it, also when it would complete a merge (PRTS
   * 卫戍协议/帮助 §手牌区, see buy; GitHub #82).
   */
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
      // 2026-10-13 修复（用户复现「定向投放」拿不了 + 服务器内部错误 ×4）：
      // this.m.itemPool 在本仓库从未定义（全服务端只此一处引用）→ 读 .canGain 抛 TypeError → platform 记 ERR.INTERNAL。
      // 池子存在时照旧检查，不存在就放过（装备本无池子限制）。
      const _ip = this.m.itemPool;
      if (_ip && typeof _ip.canGain === 'function' && !_ip.canGain(slot.id)) return fail(ERR.SOLD_OUT);
      if (handFull) return fail(ERR.HAND_FULL);
    } else {
      const rec = this.gd.chess(slot.id);
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET);
      const base = this.gd.baseIdOf(slot.id);
      const need = rec.isGolden ? this.gd.goldenCopies : 1;
      const pool = this.poolOf(base); // the shared pool, or this player's 自选 stock
      if (pool.has(base) && pool.left(base) < need) return fail(ERR.SOLD_OUT);
      if (handFull) return fail(ERR.HAND_FULL);
    }
    const price = Number.isFinite(slot.price) && slot.price > 0 ? Math.trunc(slot.price) : 0;
    if (price > this.funds) return fail(ERR.NO_FUNDS);
    slot.sold = true;
    this.offers.shift();
    if (price > 0) this.spend(price);
    if (slot.kind === 'item') {
      this.acquireItem(slot.id, { source: 'reward' });
      // ★ 2026-10-18（移植 0.3.1 #677；维护者 2026-10-17 按原版游玩记忆确认）：凯瑟琳【定向投放】
      //   每位玩家每局最多**领取一次**突变细胞。领到之后：
      //     ① 记 `band:cathy:cellTaken`，让 bands/meta.js 的 up_shop_add_special_goods 以后不再抽到它；
      //     ② 把已排队、还没点的那些凯瑟琳投放里的突变细胞剔掉（其余选项原样保留，不重抽）。
      //   [ASSUMED] 只算"真的领到手"，只是出现过不算；昆图斯赠送的那份不走这条路径，单独计算。
      if (offer.source === 'band:cathy' && slot.id === 'chess_item_5_08_e_a') {
        this.counters['band:cathy:cellTaken'] = 1;
        for (const pending of this.offers) if (pending.source === 'band:cathy') {
          pending.slots = pending.slots.filter((s) => s.id !== slot.id);
        }
        this.offers = this.offers.filter((pending) => pending.slots.length);
      }
    } else this.acquireChess(slot.id, { source: 'reward' });
    this._afterSpend(price, 'reward');
    this.recompute();
    return OK;
  }

  setReady(on) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (on && this.personalChoice) return fail(ERR.BAD_TARGET, '请先完成教鞭选择'); // i18n-ignore: developer error detail
    if (on && !this.tempEmpty) return fail(ERR.TEMP_NOT_EMPTY);
    if (this.ready === !!on) return OK;
    this.ready = !!on;
    // un-ready: the player can act again, so what overflowed while it was ready is due at this prep's deadline
    if (!on) for (const p of this.temp) if (p && this.tempDue(p) > this.prepsEnded) this._tempDue.set(p.uid, this.prepsEnded);
    this.dirty();
    this.m.onReadyChanged(this);
    return OK;
  }

  /**
   * Prep deadline: every temp piece due at this prep (tempDue ≤ prepsEnded) is resolved — a chess is sold back (its
   * pool copies return, its summons are removed), items are destroyed, the summon stack of an owner still on the board
   * is removed and comes back at the next round start (startRound → grantTokensFor; PRTS "干员所属召唤物会于下一回合
   * 返还"). Pieces that overflowed after the player could no longer act on them (after Ready, at the prep end) are kept
   * for the next prep.
   */
  resolveTemp() {
    let changed = false;
    for (let i = 0; i < this.temp.length; i++) {
      const p = this.temp[i];
      if (!p || this.tempDue(p) > this.prepsEnded) continue;
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
