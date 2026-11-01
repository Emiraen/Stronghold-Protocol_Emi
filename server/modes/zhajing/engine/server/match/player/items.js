// server/match/player/items.js — PlayerState methods: items — g.equip (max 2, a 3rd replaces the one the player picks;
// consume-on-equip items), g.art (Arts on a tile, rotated by the facing) and g.destroy (hand / temp items; equipped
// ones are locked).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR } from '../../../shared/constants.js';
import { tileKey, inField, parseDir } from '../board.js';
import { offsetTile } from '../../sim/dir.js';
import { itemKey } from '../gamedata.js';
import { OK, fail } from './common.js';

/**
 * ★ 2026-10-17（用户：「维式战锤系列装备现在可以一个槽位同时装备20个…干员会同时获得这20个战锤的效果」）：
 * 可叠加装备在一件干员身上的**合计**上限（用户：整槽合计最多 20 个，不同战锤共用这份额度）。
 * 哪些装备可叠加由数据里的 `stackMax` 决定（目前只有 10 件维式战锤标了 20）。
 */
const STACK_TOTAL_MAX = 20;

export class PlayerItems {
  /**
   * g.equip {itemUid, targetUid, replaceUid?}. A third item on a carrier with both slots used replaces the equipped item
   * the player picked in the replace dialog (`replaceUid`, research 09 §1.2 UseEquipUp.unloadInstId; absent ⇒ the
   * oldest); the replaced item is destroyed. A `replaceUid` that is not one of the target's equipped items is refused.
   * A consume-on-equip item replaces the same way before it resolves (GitHub #263): the carrier keeps a free slot, and a
   * target its effect refuses (博士投影 on an elite) gets the picked item back — nothing is destroyed.
   */
  equip(itemUid, targetUid, replaceUid = null) {
    const g = this._gate(); if (g) return g;
    const iloc = this.find(itemUid);
    if (!iloc || iloc.piece.kind !== 'item' || (iloc.area !== 'hand' && iloc.area !== 'temp')) return fail(ERR.BAD_TARGET);
    const rec = this.gd.item(iloc.piece.id);
    if (!rec || rec.itemType !== 'EQUIP') return fail(ERR.BAD_TARGET, 'not equipment');
    const tloc = this.find(targetUid);
    if (!tloc || tloc.piece.kind !== 'chess' || tloc.area === 'equipped') return fail(ERR.BAD_TARGET);
    const item = iloc.piece;
    const target = tloc.piece;
    if (this._stackMaxOf(rec) > 0 && this._stackTotal(target) >= STACK_TOTAL_MAX && !this.completesItemMerge(item.id))
      return fail(ERR.BAD_TARGET, 'stack limit reached');
    // 规则7: the 变形同构体 has a slot of its own, so it can never be the item a normal equip replaces
    const incomingMorph = this._isMorphItem(rec);
    if (replaceUid != null) {
      const picked = (target.items || []).find((x) => x.uid === replaceUid);
      if (!(Number.isInteger(replaceUid) && picked)) return fail(ERR.BAD_TARGET, 'replace: not equipped on the target');
      if (!incomingMorph && this._isMorphItem(this.gd.item(picked.id))) return fail(ERR.BAD_TARGET, 'replace: the morph item has its own slot');
    }
    const consume = typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip');
    if (consume) {
      const key = 'item:' + itemKey(item.id);
      if (!this.m.registry.has(key)) return fail(ERR.BAD_TARGET, 'effect not available');
      // a full carrier replaces first, consumables included (PRTS 卫戍协议/帮助 "达到上限强行佩戴会改为替换装备：指定一件已佩戴
      // 装备替换为将要佩戴的装备，并销毁被指定的装备"; GitHub #263): the pick (else the oldest) comes off before the effect —
      // which so sees the carrier without it (its bonds) — and is destroyed once the effect went through, leaving the slot
      // free (the normal 博士投影 then takes it: ev.keep, so it no longer pushes the oldest item out). A refusal puts it back.
      const off = this._takeReplaced(target, replaceUid);
      const ev = { item, target, golden: !!rec.isGolden, keep: false, error: null, consumed: true };
      this.m.dispatchItem(this, item, target, 'onEquip', ev);
      if (ev.error) {
        if (off) target.items.splice(Math.min(off.idx, target.items.length), 0, off.piece);
        return fail(ERR[ev.error] ? ev.error : ERR.BAD_TARGET, typeof ev.detail === 'string' ? ev.detail : undefined);
      }
      if (off) this.m.dispatchItem(this, off.piece, target, 'onDestroy', { item: off.piece, holder: target, reason: 'replace' });
      // the handler may have destroyed the target (信标) — resolve the item again
      const again = this.find(item.uid);
      if (again && again.area !== 'equipped') this._detach(again);
      if (ev.keep) {
        const holder = this.find(target.uid);
        if (holder && holder.piece.kind === 'chess') this._attach(holder.piece, item);
      }
      this.stats.itemsEquipped++;
      this.checkItemMerges();
      this.recompute();
      return OK;
    }
    this._detach(iloc);
    if (this.completesItemMerge(item.id)) {
      // an identical normal copy is already owned (equipped somewhere): merge instead of equipping — the golden
      // item goes to the hand (research 04 §2 "copies in hand and on operators both count")
      if (this._mergeItem(item.id, item)) { this.recompute(); return OK; }
      if (!this.find(item.uid)) this.stow(item, { allowTemp: true });
    }
    this._attach(target, item, replaceUid);
    this.stats.itemsEquipped++;
    this.m.dispatchItem(this, item, target, 'onEquip', { item, target, golden: !!rec.isGolden, consumed: false });
    this.checkItemMerges();
    this.recompute();
    return OK;
  }

  /**
   * Attach an item. With both slots used the item `replaceUid` names (the player's pick) is replaced, else the oldest;
   * the replaced item is destroyed.
   * 炸惊模拟 规则7 (GameData.morphEquipSlot): the 变形同构体 — the only EQUIP record with `canGiveBond` — does not use an
   * ordinary slot. It has a third slot of its own: equipping one never pushes a normal item out, a second one replaces
   * the first, and a normal item never takes the morph slot (a full carrier replaces among its two ordinary items).
   */
  _attach(target, item, replaceUid = null) {
    target.items = target.items || [];
    if (this._isMorphItem(this.gd.item(item.id))) {
      const at = target.items.findIndex((x) => this._isMorphItem(this.gd.item(x.id)));
      if (at >= 0) {
        const [old] = target.items.splice(at, 1);
        this.m.dispatchItem(this, old, target, 'onDestroy', { item: old, holder: target, reason: 'replace' });
      }
      target.items.push(item);
      return;
    }
    // ★ 可叠加装备（维式战锤系列）：已有同 id 的一叠，且合计没到 20 → 直接压进这一叠，
    //   不占新槽、不驱逐任何东西。合成本身仍走 acquire.js 的 upgradeChessId（用户选 B：合成优先）。
    //   ★ 满了（合计 20）就**直接不收**，绝不走下面的驱逐循环 —— 否则会一条条吃掉已有的叠加
    //   （实测：混搭 15+10 时会从第一叠开始被逐条剔掉，只剩 10 条）。
    if (this._stackMaxOf(this.gd.item(item.id)) > 0) {
      if (this._stackTotal(target) >= STACK_TOTAL_MAX) return;
      const grp = this._stackGroupOf(this.gd.item(item.id));
      const has = target.items.some((x) => {
        const r = this.gd.item(x.id);
        return grp ? (this._stackGroupOf(r) || x.id) === grp : x.id === item.id;
      });
      if (has) { target.items.push(item); return; }
    }
    while (this._normalSlots(target).length >= this.gd.equipPerChess) {
      const idxs = this._normalSlotIndexes(target);
      let at = idxs[0];
      if (replaceUid != null) {
        const pick = idxs.find((i) => target.items[i].uid === replaceUid);
        if (pick != null) at = pick;
      }
      const [old] = target.items.splice(at, 1);
      replaceUid = null;
      this.m.dispatchItem(this, old, target, 'onDestroy', { item: old, holder: target, reason: 'replace' });
    }
    target.items.push(item);
  }

  /**
   * A consume-on-equip item on a full carrier: take the item `replaceUid` names (else the oldest) off `target` — not yet
   * destroyed — and return { piece, idx } (null while a slot is free). 规则7: only the ordinary slots are counted/taken.
   */
  _takeReplaced(target, replaceUid = null) {
    target.items = target.items || [];
    const idxs = this._normalSlotIndexes(target);
    if (idxs.length < this.gd.equipPerChess) return null;
    let idx = idxs[0];
    if (replaceUid != null) {
      const pick = idxs.find((i) => target.items[i].uid === replaceUid);
      if (pick != null) idx = pick;
    }
    const [piece] = target.items.splice(idx, 1);
    return { piece, idx };
  }

  /** 规则7: is this item record the 变形同构体 — the EQUIP that grants a bond from the item paired with it? */
  _isMorphItem(rec) { return !!(this.gd.morphEquipSlot && rec && rec.canGiveBond === true); }

  /**
   * ★ 2026-10-17（用户：「维式战锤系列装备现在可以一个槽位同时装备20个…干员会同时获得这20个战锤的效果」）：
   *   可叠加装备（`stackMax > 0`，目前只有 10 件维式战锤）的叠加规则：
   *     · **同一个 id 的多件只算一个普通槽位**（`_normalSlots` 按 id 去重）；
   *     · 一件干员身上**所有可叠加物品的件数合计**不超过 `STACK_TOTAL_MAX`（用户：整槽合计最多 20 个）；
   *     · **合成仍然优先**（用户选 B）：2 个普通锤依旧走 `upgradeChessId` 合成精锐，不走叠加 ——
   *       合成分支在 `acquire.js`，早于 `_attach`，所以这里只要"满了才有得叠"就是对的。
   *   非叠加物品（绝大多数）完全不受影响：它们各自占一格，行为与以前逐字节相同。
   */
  _stackMaxOf(rec) {
    // ★ 2026-10-26（反馈：「非炸惊也装备了三个装备」）：叠加/同系列共格是**炸惊专属**规则，
    //   普通难度必须回到「每格一件、最多 equipPerChess 件」，否则 3 把同系列锤会挤进 1 格。
    if (!this.gd.zhajing) return 0;
    const n = Number(rec && rec.stackMax);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /**
   * ★ 2026-10-17（用户：「我想要的是同系列也可以重叠」）：同一**系列**共用一个槽位/一叠。
   *   数据里的 stackGroup（目前 10 件维式战锤都是 ickiHammer）—— 重锤 / 战栗 / 坚固 / 加速 / 灼燃
   *   全部压进同一格，整叠合计仍受 STACK_TOTAL_MAX(20) 限制。
   */
  _stackGroupOf(rec) {
    if (this._stackMaxOf(rec) <= 0) return null;
    const g = rec && rec.stackGroup;
    return typeof g === 'string' && g ? g : null;
  }

  /** 这件干员身上所有「可叠加物品」的件数合计。 */
  _stackTotal(piece) {
    const items = piece && Array.isArray(piece.items) ? piece.items : [];
    let n = 0;
    for (const x of items) if (this._stackMaxOf(this.gd.item(x.id)) > 0) n++;
    return n;
  }

  /** The items of `piece` sitting in its ordinary slots (the morph item's own slot excluded). 可叠加的同 id 只算一个。 */
  _normalSlots(piece) {
    const items = piece && Array.isArray(piece.items) ? piece.items : [];
    const seen = new Set();
    const out = [];
    for (const x of items) {
      if (this._isMorphItem(this.gd.item(x.id))) continue;
      const rec = this.gd.item(x.id);
      const grp = this._stackGroupOf(rec) || (this._stackMaxOf(rec) > 0 ? x.id : null);
      if (grp) {
        if (seen.has(grp)) continue;       // 同一系列只算一格
        seen.add(grp);
      }
      out.push(x);
    }
    return out;
  }

  /** Indexes in `piece.items` of the ordinary-slot items, in equip order. 可叠加的同 id 只取第一件。 */
  _normalSlotIndexes(piece) {
    const items = piece && Array.isArray(piece.items) ? piece.items : [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      if (this._isMorphItem(this.gd.item(items[i].id))) continue;
      const rec = this.gd.item(items[i].id);
      const grp = this._stackGroupOf(rec) || (this._stackMaxOf(rec) > 0 ? items[i].id : null);
      if (grp) {
        if (seen.has(grp)) continue;
        seen.add(grp);
      }
      out.push(i);
    }
    return out;
  }

  /** Room for `item` on `piece` without evicting anything (规则7: the morph item's slot holds at most one). */
  _itemRoomFor(piece, item) {
    const items = piece && Array.isArray(piece.items) ? piece.items : [];
    if (this._isMorphItem(this.gd.item(item && item.id))) return !items.some((x) => this._isMorphItem(this.gd.item(x.id)));
    return this._normalSlots(piece).length < this.gd.equipPerChess;
  }

  /** g.art {itemUid, row, col, dir?}: the Art's range grid is rotated by `dir` (absent ⇒ RIGHT). */
  useArt(itemUid, row, col, dir) {
    const g = this._gate(); if (g) return g;
    const d = parseDir(dir);
    if (!d) return fail(ERR.BAD_TARGET, 'bad dir');
    const loc = this.find(itemUid);
    if (!loc || loc.piece.kind !== 'item' || (loc.area !== 'hand' && loc.area !== 'temp')) return fail(ERR.BAD_TARGET);
    const rec = this.gd.item(loc.piece.id);
    if (!rec || rec.itemType !== 'MAGIC') return fail(ERR.BAD_TARGET, 'not an art');
    if (!inField(row, col)) return fail(ERR.BAD_TILE);
    if (this.round.arts >= this.gd.maxArtsPerRound) return fail(ERR.BAD_TARGET, 'art limit');
    const key = 'item:' + itemKey(loc.piece.id);
    if (!this.m.registry.has(key)) return fail(ERR.BAD_TARGET, 'effect not available');
    const grid = Array.isArray(rec.rangeGrid) && rec.rangeGrid.length ? rec.rangeGrid : [[0, 0]];
    const targets = [];
    for (const [dr, dc] of grid) {
      const [tr, tc] = offsetTile(row, col, dr, dc, d);
      const p = this.board.get(tileKey(tr, tc));
      if (p) targets.push(p);
    }
    const ev = { item: loc.piece, row, col, dir: d, targets, error: null, used: true };
    this.m.dispatchItem(this, loc.piece, null, 'onArt', ev);
    if (ev.error) return fail(ERR[ev.error] ? ev.error : ERR.BAD_TARGET, typeof ev.detail === 'string' ? ev.detail : undefined);
    if (ev.used !== false) {
      const again = this.find(itemUid);
      if (again) this._detach(again);
      this.round.arts++;
    }
    this.recompute();
    return OK;
  }

  /**
   * g.destroy {uid}: an item in the hand / temp (Arts included). Equipped items are locked (research 04 §2 / addendum:
   * they leave the operator only on promotion, merge or sale); replacing one is g.equip's `replaceUid`.
   */
  destroy(uid) {
    const g = this._gate(); if (g) return g;
    const loc = this.find(uid);
    if (!loc || loc.piece.kind !== 'item') return fail(ERR.BAD_TARGET, 'only items can be destroyed');
    if (loc.area === 'equipped') return fail(ERR.BAD_TARGET, 'equipped items are locked');
    this._detach(loc);
    this.m.dispatchItem(this, loc.piece, loc.holder || null, 'onDestroy', { item: loc.piece, holder: loc.holder || null, reason: 'player' });
    this.recompute();
    return OK;
  }
}
