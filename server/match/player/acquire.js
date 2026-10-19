

import { pieceDir, parseDir, mergeTile } from "../board.js";

import { MAX_OFFER_SLOTS } from "./common.js";
import { onMerge } from '../botEmotes.js';
import { itemMergeRecipe } from '../../../shared/itemMerge.js';
export class PlayerAcquire {
  countCopies(baseId) {
    let n = 0;
    for (const loc of this._chessLocations()) {
      const p = loc.piece;
      if (!this.gd.isGolden(p.id) && this.gd.baseIdOf(p.id) === baseId) n++;
    }
    return n;
  }

  completesChessMerge(chessId) {
    const rec = this.gd.chess(chessId);
    if (!rec || rec.isGolden) return false;
    const need = this.gd.mergeCount(chessId);
    if (!(need > 1) || !this.gd.goldenIdOf(chessId)) return false;
    return this.countCopies(this.gd.baseIdOf(chessId)) + 1 >= need;
  }

  acquireChess(chessId, { source = 'grant', toTemp = false, fromPool = true, silent = false } = {}) {
    const rec = this.gd.chess(chessId);
    // a DIY slot is only ever this player's own 自选 piece: a slot it has not filled has no body (甄选干员) to gain
    if (!rec || (rec.isDiy && !rec.diyFor)) return null;
    const base = this.gd.baseIdOf(chessId);
    const need = rec.isGolden ? this.gd.goldenCopies : 1;
    // the shared pool, or this player's stock of a slotted 自选 piece (player/diy.js poolOf)
    const taken = fromPool ? this.poolOf(base).take(base, need, { overdraw: true }) : 0;
    const piece = this.newPiece('chess', chessId, { poolCopies: taken });
    this.round.gainedChess++;
    let owned = piece;
    if (!rec.isGolden && this.completesChessMerge(chessId)) {
      owned = this._mergeChess(base, piece);
      if (!owned) return null;
    } else {
      const where = this.stow(piece, { allowTemp: true, toTemp });
      if (!where) {
        this.returnCopies(piece);
        this.m.toast(this, 'warn', '整备区已满，获得的干员已返还');
        return null;
      }
    }
    this.recompute();
    if (!silent) this.m.dispatch(this, 'onGain', { piece: owned, kind: 'chess', source });
    this.recompute();
    return owned;
  }

  _mergeChess(baseId, incoming) {
    const need = this.gd.mergeCount(baseId);
    const goldenId = this.gd.goldenIdOf(baseId);
    if (!(need > 1) || !goldenId) return null;
    const locs = this._chessLocations().filter((l) => !this.gd.isGolden(l.piece.id) && this.gd.baseIdOf(l.piece.id) === baseId);
    const consumed = [];
    if (incoming) consumed.push({ piece: incoming, area: 'new' });
    for (const l of locs) { if (consumed.length >= need) break; consumed.push(l); }
    if (consumed.length < need) return null;
    let copies = 0;
    const items = [];
    for (const l of consumed) {
      copies += l.piece.poolCopies || 0;
      if (l.area !== 'new') this._detach(l);
      this.removeTokensOf(l.piece.uid);
      for (const it of l.piece.items || []) items.push(it);
      l.piece.items = [];
    }
    copies += this.poolOf(baseId).take(baseId, Math.max(0, this.gd.goldenCopies - copies), { overdraw: true });
    const elite = this.newPiece('chess', goldenId, { poolCopies: copies });
    // this round's per-piece counters: the highest of the copies' (an elite made from 拉普兰德 that already saw their
    // first refresh this round does not fire again this round — [ASSUMED] conservative, pieceRoundCount)
    for (const l of consumed) {
      const rc = l.piece.meta && l.piece.meta.round;
      if (rc && rc.r === this.m.round) for (const [k, v] of Object.entries(rc.n)) this.bumpPieceRoundCount(elite, k, Math.max(0, v - this.pieceRoundCount(elite, k)));
    }
    const deployed = consumed.filter((l) => l.key && !this.board.has(l.key)).map((l) => ({ key: l.key, dir: pieceDir(l.piece) }));
    const toTile = (t) => { elite.dir = parseDir(t.dir) || 'RIGHT'; this.board.set(t.key, elite); return 'board'; };
    const tile = mergeTile(deployed, (r, c) => this._legal(elite, r, c));
    let where = tile ? toTile(tile) : this.stow(elite, { allowTemp: true });
    // hand and temp full and no deployed tile legal for it (a terrain change not re-checked yet): it stays on the first
    // deployed copy's tile rather than being lost, like a piece _evictIllegal finds no room for
    if (!where && deployed.length) where = toTile(mergeTile(deployed));
    for (const it of items) {
      if (this.stow(it, { allowTemp: true })) continue;
      if (where && elite.items.length < this.equipCapacity(elite)) { elite.items.push(it); continue; }
      this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: returned item ${it.id} destroyed (no space)`);
    }
    // the returned equipment follows the auto-merge rule like any other gain ("已拥有2件同一初始装备时…自动合并")
    this.checkItemMerges();
    // deployed like any operator placed by hand: its manually deployable summons join the hand (after the returned
    // equipment, which would be lost in temp — a summon stack removed there comes back at the next round start)
    if (where === 'board') this.grantTokensFor(elite);
    if (!where) {
      this.poolOf(baseId).give(baseId, copies);
      this.m.toast(this, 'warn', '整备区已满，晋升的精锐干员无法放入');
      this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: merge result dropped (hand+temp full)`);
      this.recompute();
      return null;
    }
    this.stats.merges++;
    this.pushRewardOffer('merge');
    const rec = this.gd.chess(goldenId);
    this.m.tickerFor('GOLDEN_CHAR', [this.name, rec ? this.fieldRecord(rec).name : goldenId], { playerId: this.playerId });
    this.m.dispatch(this, 'onMerge', { kind: 'chess', piece: elite, baseId, consumed: consumed.map((l) => l.piece.uid), area: where });
    onMerge(this.m, this, { kind: 'chess' });
    return elite;
  }

  promote(piece) {
    if (!piece || piece.kind !== 'chess' || this.gd.isGolden(piece.id)) return false;
    const goldenId = this.gd.goldenIdOf(piece.id);
    if (!goldenId) return false;
    const base = this.gd.baseIdOf(piece.id);
    const extra = Math.max(0, this.gd.goldenCopies - (piece.poolCopies || 0));
    piece.poolCopies = (piece.poolCopies || 0) + this.poolOf(base).take(base, extra, { overdraw: true });
    piece.id = goldenId;
    this.recompute();
    // an elite on the board tops its summon stacks up to the elite's deploy limit, like an elite merged onto a tile
    // (_mergeChess → grantTokensFor): 麦哲伦 / 令 3 → 4, 望 6 → 7 with their modules (0.2.0 review round 17)
    if ([...this.board.values()].includes(piece)) this.grantTokensFor(piece);
    return true;
  }

  transformChess(piece, newId) {
    const loc = this.find(piece.uid);
    if (!loc || loc.piece.kind !== 'chess' || !this.gd.chess(newId)) return null;
    // 原干员销毁: off its tile / slot, its summons removed, its copies back to the pool
    this._detach(loc);
    this.removeTokensOf(piece.uid);
    const items = piece.items || [];
    piece.items = [];
    this.returnCopies(piece);
    // its equipment comes off first (the returned pair auto-merges, which may free a slot for the gain)
    const left = items.filter((it) => !this.stow(it, { allowTemp: true }));
    this.checkItemMerges();
    // 获得一名…干员: gained like any other gained operator
    const np = this.acquireChess(newId, { source: 'transform' });
    for (const it of left) {
      if (this.stow(it, { allowTemp: true })) continue;
      if (np && this.find(np.uid) && np.items.length < this.equipCapacity(np)) { np.items.push(it); continue; }
      this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: returned item ${it.id} destroyed (no space)`);
    }
    if (left.length) this.checkItemMerges();
    this.recompute();
    return np;
  }

  upgradeItem(piece) {
    const rec = this.gd.item(piece.id);
    if (!rec || rec.isGolden) return false;
    const gid = rec.upgradeChessId || rec.goldenId;
    if (!gid || !this.gd.item(gid)) return false;
    if (this.m.itemPool.left(piece.id) < 1) return false;
    piece.id = gid;
    this.recompute();
    return true;
  }

  pushRewardOffer(source = 'merge', { tier = null, ids = null, label = null } = {}) {
    const ro = this.gd.rewardOffer();
    const t = Number.isInteger(tier) ? tier : Math.min(this.shop.level + ro.tierOffset, ro.maxTier);
    // an offer never shows one operator twice, whoever built the list (user playtest #6 item 19)
    let list = Array.isArray(ids) ? [...new Set(ids)].filter((id) => this.gd.chess(id)) : null;
    if (!list) {
      list = [];
      const fresh = (id) => !list.includes(id);
      for (let i = 0; i < ro.count; i++) {
        let id = null;
        for (let tt = t; tt >= 1 && !id; tt--) id = this.pool.roll(this.m.rngShop, { tier: tt, filter: fresh, extra: this.diyRollEntries() });
        if (id) list.push(id);
      }
    }
    if (!list.length) return null;
    const offer = { tier: t, source, label: typeof label === 'string' && label ? label : null, slots: list.slice(0, MAX_OFFER_SLOTS).map((id) => ({ kind: 'chess', id, price: ro.price, sold: false })) };
    this.offers.push(offer);
    this.dirty();
    return offer;
  }

  pushItemOffer(ids, { source = 'effect', tier = null, label = null } = {}) {
    const list = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => this.gd.item(id) && this.m.itemPool.canGain(id)).slice(0, MAX_OFFER_SLOTS);
    if (!list.length) return null;
    const offer = { tier: Number.isInteger(tier) ? tier : null, source, label: typeof label === 'string' && label ? label : null, slots: list.map((id) => ({ kind: 'item', id, price: 0, sold: false })) };
    this.offers.push(offer);
    this.dirty();
    return offer;
  }

  _itemMergeable(id) {
    return !!itemMergeRecipe(id, itemId => this.gd.item(itemId), this.gd.itemMergeCount);
  }

  _itemLocations(id) {
    const out = [];
    for (let i = 0; i < this.temp.length; i++) if (this.temp[i] && this.temp[i].kind === 'item' && this.temp[i].id === id) out.push({ piece: this.temp[i], area: 'temp', idx: i });
    for (let i = 0; i < this.hand.length; i++) if (this.hand[i] && this.hand[i].kind === 'item' && this.hand[i].id === id) out.push({ piece: this.hand[i], area: 'hand', idx: i });
    return out;
  }

  completesItemMerge(id) {
    if (!this._itemMergeable(id)) return false;
    const rec = this.gd.item(id);
    const n = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : this.gd.itemMergeCount;
    return this._itemLocations(id).length + 1 >= n;
  }

  acquireItem(itemId, { source = 'grant', toTemp = false, silent = false, deferMerge = false } = {}) {
    const rec = this.gd.item(itemId);
    if (!rec) return null;
    if (!this.m.itemPool.canGain(itemId)) {
      // 池余量守恒修复（2026-10-14）：金色件需 2 份容量而池仅剩 1 份时，降格为普通件发放（占 1 份），
      // 而不是整件静默丢弃 —— 玩家至少拿到普通件可后续自行合成；普通件也放不下时才维持原"库存不足"。
      const baseId = this.gd.baseIdOf(itemId);
      const fallback = rec.isGolden && baseId !== itemId && this.m.itemPool.canGain(baseId) ? baseId : null;
      if (!fallback) {
        this.m.toast(this, 'warn', '装备库存不足');
        return null;
      }
      itemId = fallback;
    }
    let piece = this.newPiece('item', itemId);
    // A prep-end grant may sit beside an identical copy until the next prep. The invariant counts only copies
    // without this mark, so the fight that is about to start is not reported as a missed merge.
    if (deferMerge) piece.deferMerge = true;
    if (!deferMerge && this.completesItemMerge(itemId)) {
      piece = this._mergeItem(itemId, piece);
      if (!piece) return null;
    } else if (!this.stow(piece, { allowTemp: true, toTemp })) {
      this.m.toast(this, 'warn', '整备区已满，获得的装备已销毁');
      return null;
    }
    this.recompute();
    if (!silent) this.m.dispatch(this, 'onGain', { piece, kind: 'item', source });
    return piece;
  }

  _mergeItem(itemId, incoming = null, equipped = null) {
    const recipe = itemMergeRecipe(itemId, id => this.gd.item(id), this.gd.itemMergeCount);
    if (!recipe) return null;
    const need = recipe.count;
    const locs = equipped ? [equipped] : this._itemLocations(itemId);
    const consumed = incoming ? [{ piece: incoming, area: 'new' }] : [];
    for (const l of locs) { if (consumed.length >= need) break; consumed.push(l); }
    if (consumed.length < need) return null;
    const gid = recipe.upgradeId;
    // 池余量守恒修复（2026-10-14）：合成前校验金色件的池容量；不足时不消耗任何件（防 2 件销毁 + 金件丢失）。
    // 普通 N 件合并释放 N 份、金色占 2 份 —— N=2 时净平衡，canGain 必然放行；异常数据下宁可不合也不丢件。
    if (gid && !this.m.itemPool.canGain(gid)) {
      this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: merge ${itemId} skipped (item pool exhausted for ${gid})`);
      return null;
    }
    for (const l of consumed) {
      if (l.area === 'equipped') l.idx = l.holder.items.indexOf(l.piece);
      if (l.area !== 'new') this._detach(l);
    }
    const golden = this.newPiece('item', gid);
    if (!this.stow(golden, { allowTemp: true })) {
      // 守恒兜底（2026-10-14）：stow 失败（理论上 temp 越界兜底后不可达）时返还已消耗件，而不是销毁
      this.m.toast(this, 'warn', '整备区已满，装备未合成');
      const back = [];
      for (const l of consumed) if (l.area !== 'new') back.push(l);
      for (const l of back) {
        if (l.area === 'equipped') l.holder.items.splice(Math.max(0, l.idx), 0, l.piece);
        else this[l.area][l.idx] = l.piece;
      }
      return null;
    }
    this.stats.itemMerges++;
    this.m.dispatch(this, 'onMerge', { kind: 'item', piece: golden, itemId, consumed: consumed.map((l) => l.piece.uid) });
    return golden;
  }

  checkItemMerges() {
    for (let guard = 0; guard < 20; guard++) {
      const counts = new Map();
      const scan = (p) => { if (p && p.kind === 'item' && this._itemMergeable(p.id)) counts.set(p.id, (counts.get(p.id) || 0) + 1); };
      for (const p of this.hand) scan(p);
      for (const p of this.temp) scan(p);
      let did = false;
      for (const [id, n] of counts) {
        const rec = this.gd.item(id);
        const need = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : this.gd.itemMergeCount;
        if (n >= need) { if (this._mergeItem(id, null)) did = true; break; }
      }
      if (!did) return;
    }
  }
}
