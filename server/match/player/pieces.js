

import { tileKey, boardOrder, freeSlot } from "../board.js";

export class PlayerPieces {
  newPiece(kind, id, extra = {}) {
    return { uid: this.m.nextUid(), kind, id, items: kind === 'chess' ? [] : undefined, count: kind === 'token' ? 1 : undefined, ownerUid: undefined, poolCopies: 0, boughtRound: this.m.round, meta: {}, ...extra };
  }

  find(uid) {
    if (!Number.isInteger(uid)) return null;
    for (let i = 0; i < this.hand.length; i++) {
      const p = this.hand[i];
      if (!p) continue;
      if (p.uid === uid) return { piece: p, area: 'hand', idx: i };
      if (p.items) for (const it of p.items) if (it.uid === uid) return { piece: it, area: 'equipped', holder: p };
    }
    for (let i = 0; i < this.temp.length; i++) {
      const p = this.temp[i];
      if (!p) continue;
      if (p.uid === uid) return { piece: p, area: 'temp', idx: i };
      if (p.items) for (const it of p.items) if (it.uid === uid) return { piece: it, area: 'equipped', holder: p };
    }
    for (const [key, p] of this.board) {
      if (p.uid === uid) return { piece: p, area: 'board', key };
      if (p.items) for (const it of p.items) if (it.uid === uid) return { piece: it, area: 'equipped', holder: p };
    }
    return null;
  }

  allChess() {
    const out = [];
    for (const { piece } of boardOrder(this.board)) if (piece.kind === 'chess') out.push(piece);
    for (const p of this.hand) if (p && p.kind === 'chess') out.push(p);
    for (const p of this.temp) if (p && p.kind === 'chess') out.push(p);
    return out;
  }

  _chessLocations() {
    const out = [];
    for (let i = 0; i < this.temp.length; i++) if (this.temp[i] && this.temp[i].kind === 'chess') out.push({ piece: this.temp[i], area: 'temp', idx: i });
    for (let i = 0; i < this.hand.length; i++) if (this.hand[i] && this.hand[i].kind === 'chess') out.push({ piece: this.hand[i], area: 'hand', idx: i });
    for (const { r, c, piece } of boardOrder(this.board)) if (piece.kind === 'chess') out.push({ piece, area: 'board', key: tileKey(r, c) });
    return out;
  }

  _detach(loc) {
    if (!loc) return;
    if (loc.area === 'hand') this.hand[loc.idx] = null;
    else if (loc.area === 'temp') { this.temp[loc.idx] = null; this._tempDue.delete(loc.piece.uid); }
    else if (loc.area === 'board') this.board.delete(loc.key);
    else if (loc.area === 'equipped') {
      const i = loc.holder.items.indexOf(loc.piece);
      if (i >= 0) loc.holder.items.splice(i, 1);
    }
  }

  stow(piece, { allowTemp = true, toTemp = false, preferIdx = null } = {}) {
    if (!toTemp) {
      if (Number.isInteger(preferIdx) && preferIdx >= 0 && preferIdx < this.hand.length && this.hand[preferIdx] == null) {
        this.hand[preferIdx] = piece;
        return 'hand';
      }
      const i = freeSlot(this.hand);
      if (i >= 0) { this.hand[i] = piece; return 'hand'; }
      if (!allowTemp && piece.kind !== 'item') return null;
    }
    const j = freeSlot(piece.kind === 'item' ? this.temp : this.temp.slice(0, this.gd.tempSize));
    if (j >= 0) { this._putTemp(j, piece); return 'temp'; }
    if (piece.kind === 'item') { this._putTemp(this.temp.length, piece); return 'temp'; }
    return null;
  }

  pieceRoundCount(piece, key) {
    const rc = piece && piece.meta && piece.meta.round;
    return rc && rc.r === this.m.round && Number.isFinite(rc.n[key]) ? rc.n[key] : 0;
  }

  bumpPieceRoundCount(piece, key, n = 1) {
    if (!piece || typeof key !== 'string' || !Number.isFinite(n)) return 0;
    if (!piece.meta || typeof piece.meta !== 'object') piece.meta = {};
    const v = this.pieceRoundCount(piece, key) + n;
    if (!piece.meta.round || piece.meta.round.r !== this.m.round) piece.meta.round = { r: this.m.round, n: {} };
    piece.meta.round.n[key] = v;
    return v;
  }

  returnCopies(piece) {
    if (piece && piece.kind === 'chess' && piece.poolCopies > 0) {
      const base = this.gd.baseIdOf(piece.id);
      this.poolOf(base).give(base, piece.poolCopies);
      piece.poolCopies = 0;
    }
  }

  removeTokensOf(ownerUid) {
    for (const [k, p] of [...this.board]) if (p.kind === 'token' && p.ownerUid === ownerUid) this.board.delete(k);
    for (let i = 0; i < this.hand.length; i++) if (this.hand[i] && this.hand[i].kind === 'token' && this.hand[i].ownerUid === ownerUid) this.hand[i] = null;
    for (let i = 0; i < this.temp.length; i++) if (this.temp[i] && this.temp[i].kind === 'token' && this.temp[i].ownerUid === ownerUid) this.temp[i] = null;
  }

  _liftTokensOf(ownerUid, keep = null) {
    for (const [k, p] of [...this.board]) {
      if (p.kind !== 'token' || p.ownerUid !== ownerUid || p === keep) continue;
      this.board.delete(k);
      if (!this._returnToken(p, null, { allowTemp: true })) this.board.set(k, p); // nowhere to go: it stays put
    }
  }

  _tokenCountOf(ownerUid, tokenId) {
    const mine = (p) => !!p && p.kind === 'token' && p.ownerUid === ownerUid && p.id === tokenId;
    let n = 0;
    for (const p of this.board.values()) if (mine(p)) n += p.count || 1;
    for (const p of this.hand) if (mine(p)) n += p.count || 1;
    for (const p of this.temp) if (mine(p)) n += p.count || 1;
    return n;
  }

  grantTokensFor(owner) {
    const rec = owner && owner.kind === 'chess' ? this.gd.chess(owner.id) : null;
    if (!rec) return;
    // 0.2.0 补位: a chess fielded as its stand-in makes the stand-in's summons — none of the 17 has one (DATA.md §18)
    if (this.fieldsStandIn(rec)) return;
    for (const { tokenId, count } of this.gd.placeableTokens(owner.id, this.loadoutFor(rec))) {
      const missing = count - this._tokenCountOf(owner.uid, tokenId);
      if (missing <= 0) continue;
      const stack = [...this.hand, ...this.temp].find((p) => p && p.kind === 'token' && p.ownerUid === owner.uid && p.id === tokenId);
      if (stack) { stack.count = (stack.count || 1) + missing; continue; }
      const t = this.newPiece('token', tokenId, { count: missing, ownerUid: owner.uid });
      this.stow(t, { allowTemp: true });
    }
  }
}
