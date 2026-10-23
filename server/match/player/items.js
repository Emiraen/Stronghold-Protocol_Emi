import { ERR } from "../../../shared/constants.js";

import { tileKey, inField, parseDir } from "../board.js";

import { offsetTile } from "../../sim/dir.js";

import { itemKey } from "../gamedata.js";
import { itemMergeRecipe } from '../../../shared/itemMerge.js';

import { OK, fail } from "./common.js";
export class PlayerItems {
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
    if (replaceUid != null && !(Number.isInteger(replaceUid) && (target.items || []).some((x) => x.uid === replaceUid))) return fail(ERR.BAD_TARGET, 'replace: not equipped on the target');
    const consume = typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip');
    const mergeRefused = () => {
      // Failed merges must leave the original incoming instance in its original inventory slot.
      this[iloc.area][iloc.idx] = item;
      this.recompute();
      return fail(ERR.BAD_TARGET, '装备未合成，原装备已保留');
    };
    const same = (target.items || []).find((x) => x.id === item.id);
    const recipe = itemMergeRecipe(item.id, id => this.gd.item(id), this.gd.itemMergeCount);
    // Normal 博士投影 stays equipped until next round; merge its twin before applying the delayed effect.
    if (same && recipe?.count === 2 && (!consume || rec.kind === 'consume_on_equip_or_delayed')) {
      this._detach(iloc);
      if (!this._mergeItem(item.id, item, { piece: same, area: 'equipped', holder: target })) return mergeRefused();
      this.checkItemMerges();
      this.recompute();
      return OK;
    }
    if (consume) {
      const key = 'item:' + itemKey(item.id);
      if (!this.m.registry.has(key)) return fail(ERR.BAD_TARGET, 'effect not available');
      const ev = { item, target, golden: !!rec.isGolden, keep: false, error: null, consumed: true };
      this.m.dispatchItem(this, item, target, 'onEquip', ev);
      if (ev.error) return fail(ERR[ev.error] ? ev.error : ERR.BAD_TARGET, typeof ev.detail === 'string' ? ev.detail : undefined);
      // the handler may have destroyed the target (信标) — resolve the item again
      const again = this.find(item.uid);
      if (again && again.area !== 'equipped') this._detach(again);
      if (ev.keep) {
        const holder = this.find(target.uid);
        if (holder && holder.piece.kind === 'chess') this._attach(holder.piece, item, replaceUid);
      }
      this.stats.itemsEquipped++;
      this.checkItemMerges();
      this.recompute();
      return OK;
    }
    this._detach(iloc);
    if (this.completesItemMerge(item.id)) {
      // 未装备同类仍沿用原合成规则，结果回到手牌区。
      if (this._mergeItem(item.id, item)) { this.recompute(); return OK; }
      return mergeRefused();
    }
    this._attach(target, item, replaceUid);
    this.stats.itemsEquipped++;
    this.m.dispatchItem(this, item, target, 'onEquip', { item, target, golden: !!rec.isGolden, consumed: false });
    this.checkItemMerges();
    this.recompute();
    return OK;
  }

  equipCapacity(target) {
    const extra = this.m.isCyclops && this.gd.chess(target.id)?.bonds?.includes('victoriaShip') && this.effects.some(e => e.data?.effectId === 'cyc_victoria' && e.data.quality === 'prismatic') ? 1 : 0;
    return this.gd.equipPerChess + extra;
  }

  _attach(target, item, replaceUid = null) {
    target.items = target.items || [];
    while (target.items.length >= this.equipCapacity(target)) {
      const i = replaceUid != null ? target.items.findIndex((x) => x.uid === replaceUid) : -1;
      const [old] = target.items.splice(i >= 0 ? i : 0, 1);
      replaceUid = null;
      this.m.dispatchItem(this, old, target, 'onDestroy', { item: old, holder: target, reason: 'replace' });
    }
    target.items.push(item);
  }

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
