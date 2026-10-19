import { ERR } from "../../../shared/constants.js";

import { tileKey, parseKey, inField, canPlace, placeClass, freeSlot, pieceDir, parseDir, ownerRangeKeys } from "../board.js";
import { attackRangeGrid, loadoutRecord, resolveRecordLoadout, deployWithinOwnerRange } from "../../../shared/loadoutRecord.js";
import { offsetTile } from "../../sim/dir.js";
import { summonPlacementGrid } from "../../../shared/summonPlacement.js";

import { OK, fail } from "./common.js";
export class PlayerPlacement {
  move(uid, to, dir) {
    const g = this._gate(); if (g) return g;
    const loc = this.find(uid);
    if (!loc || loc.area === 'equipped') return fail(ERR.BAD_TARGET);
    if (!to || typeof to !== 'object') return fail(ERR.BAD_TARGET);
    const piece = loc.piece;
    if (to.area === 'board') {
      if (piece.kind === 'item') return fail(ERR.BAD_TARGET, 'items are equipped, not placed');
      const d = parseDir(dir !== undefined ? dir : to.dir);
      if (!d) return fail(ERR.BAD_TARGET, 'bad dir');
      return piece.kind === 'token' ? this._moveTokenToBoard(loc, to.row, to.col, d) : this._moveChessToBoard(loc, to.row, to.col, d);
    }
    if (to.area === 'hand') {
      if (!Number.isInteger(to.idx) || to.idx < 0 || to.idx >= this.hand.length) return fail(ERR.BAD_TARGET);
      return this._moveToHand(loc, to.idx);
    }
    return fail(ERR.BAD_TARGET);
  }

  _placementOf(piece) {
    const rec = piece.kind === 'token' ? this.gd.token(piece.id) : this.gd.chess(piece.id);
    // 钩索师 may use ground and high-ground tiles, regardless of promotion or equipped module.
    return placeClass(this, rec);
  }

  _legal(piece, r, c, owner = null) {
    if (!canPlace(this.deployMap(), this._placementOf(piece), r, c)) return false;
    const k = tileKey(r, c);
    const range = this.summonRange(piece, owner);
    if (range && !range.has(k)) return false;
    const out = this.summonExcluded(piece, owner);
    return !out || !out.has(k);
  }

  summonRange(piece, owner = null) {
    if (!piece || piece.kind !== 'token') return null;
    const grid = summonPlacementGrid(piece.id);
    if (!grid && this.gd.token(piece.id)?.ownerRange !== true) return null;
    return this._ownerRangeOf(piece, owner, grid);
  }

  _liftOutOfRange() {
    const back = [], gone = [], backAdjacent = [], goneAdjacent = [];
    for (const [k, p] of [...this.board]) {
      if (p.kind !== 'token') continue;
      const range = this.summonRange(p);
      const out = this.summonExcluded(p);
      if ((!range || range.has(k)) && (!out || !out.has(k))) continue;
      this.board.delete(k);
      const ok = this._returnToken(p, null, { allowTemp: true });
      const returned = summonPlacementGrid(p.id) ? (ok ? backAdjacent : goneAdjacent) : (ok ? back : gone);
      returned.push(this.gd.token(p.id)?.name || p.id);
    }
    if (back.length) this.m.toast(this, 'warn', `${back.join('、')}只能部署在召唤者攻击范围内，已退回整备区`);
    if (gone.length) this.m.toast(this, 'warn', `${gone.join('、')}只能部署在召唤者攻击范围内，整备区已满，下回合返还`);
    if (backAdjacent.length) this.m.toast(this, 'warn', `${backAdjacent.join('、')}只能部署在召唤者相邻四格，已退回整备区`);
    if (goneAdjacent.length) this.m.toast(this, 'warn', `${goneAdjacent.join('、')}只能部署在召唤者相邻四格，整备区已满，下回合返还`);
    return back.length + gone.length + backAdjacent.length + goneAdjacent.length;
  }

  _roomForOutOfRange(owner, ownerKey, dir) {
    const at = { key: ownerKey, piece: owner, dir };
    const stacks = [...this.hand, ...this.temp].filter((p) => p && p.kind === 'token' && p.ownerUid === owner.uid);
    const needSlot = new Set();
    for (const [k, p] of this.board) {
      if (p.kind !== 'token' || p.ownerUid !== owner.uid || stacks.some((s) => s.id === p.id)) continue;
      const range = this.summonRange(p, at);
      const out = this.summonExcluded(p, at);
      if ((range && !range.has(k)) || (out && out.has(k))) needSlot.add(p.id);
    }
    return needSlot.size <= [...this.hand, ...this.temp].filter((p) => p == null).length;
  }

  summonRangeTiles(piece) {
    if (!piece || piece.kind !== 'token') return null;
    const placementGrid = summonPlacementGrid(piece.id);
    if (!placementGrid && !deployWithinOwnerRange(this.gd.token(piece.id))) return null;
    let okey = null;
    let owner = null;
    for (const [k, p] of this.board) {
      if (p.uid === piece.ownerUid) { okey = k; owner = p; break; }
    }
    if (!owner) return [];
    const rec = this.gd.chess(owner.id);
    if (!rec) return [];
    const grid = placementGrid || attackRangeGrid(loadoutRecord(rec, resolveRecordLoadout(rec, this.loadoutFor(rec)))) || [[0, 0]];
    const [or0, oc0] = parseKey(okey);
    const out = [];
    for (const [dr, dc] of grid) {
      const [tr, tc] = offsetTile(or0, oc0, dr, dc, pieceDir(owner));
      if (inField(tr, tc)) out.push([tr, tc]);
    }
    return out;
  }

  _moveChessToBoard(loc, r, c, dir = 'RIGHT') {
    const piece = loc.piece;
    if (!inField(r, c) || !this._legal(piece, r, c)) return fail(ERR.BAD_TILE);
    const key = tileKey(r, c);
    const occ = this.board.get(key) || null;
    if (occ === piece) return this._reorient(piece, dir);
    if (loc.area === 'board') {
      // board → board: move or swap (the occupant must be legal on the source tile and keeps its own facing); an
      // operator that changes its tile takes its summons off the board (back onto their stacks, _liftTokensOf) — its
      // own summon swapped onto its old tile included, so that one needs no tile check
      if (occ) {
        const [sr, sc] = parseKey(loc.key);
        const ownSummon = occ.kind === 'token' && occ.ownerUid === piece.uid;
        if (!ownSummon && !this._legal(occ, sr, sc)) return fail(ERR.BAD_TILE);
        this.board.set(loc.key, occ);
        if (occ.kind === 'chess') this._liftTokensOf(occ.uid);
      } else {
        this.board.delete(loc.key);
      }
      piece.dir = dir;
      this.board.set(key, piece);
      this._liftTokensOf(piece.uid);
      this.recompute();
      return OK;
    }
    // hand/temp → board
    if (!occ || occ.kind !== 'chess') {
      if (this.deployCount >= this.deployCap) return fail(ERR.BOARD_FULL);
    }
    this._detach(loc);
    if (occ) {
      this.board.delete(key);
      if (occ.kind === 'chess') {
        this.removeTokensOf(occ.uid);
        this._putBack(loc, occ);
      } else {
        this._returnToken(occ, loc);
      }
    }
    piece.dir = dir;
    this.board.set(key, piece);
    this.grantTokensFor(piece);
    this.recompute();
    return OK;
  }

  _reorient(piece, dir) {
    if (pieceDir(piece) === dir) return OK;
    if (piece.kind === 'chess') {
      const loc = this.find(piece.uid);
      if (loc && loc.area === 'board' && !this._roomForOutOfRange(piece, loc.key, dir)) return fail(ERR.HAND_FULL);
    }
    piece.dir = dir;
    this.recompute();
    return OK;
  }

  _putBack(loc, piece) {
    if (loc.area === 'hand' && this.hand[loc.idx] == null) { this.hand[loc.idx] = piece; return true; }
    if (loc.area === 'temp' && this.temp[loc.idx] == null) { this._putTemp(loc.idx, piece); return true; }
    return !!this.stow(piece, { allowTemp: true });
  }

  _returnToken(tok, preferLoc = null, { allowTemp = true } = {}) {
    const stack = [...this.hand, ...this.temp].find((p) => p && p.kind === 'token' && p.ownerUid === tok.ownerUid && p.id === tok.id);
    if (stack) { stack.count = (stack.count || 1) + (tok.count || 1); return true; }
    tok.count = tok.count || 1;
    if (preferLoc && preferLoc.area === 'hand' && this.hand[preferLoc.idx] == null) { this.hand[preferLoc.idx] = tok; return true; }
    return !!this.stow(tok, { allowTemp });
  }

  _moveTokenToBoard(loc, r, c, dir = 'RIGHT') {
    const piece = loc.piece;
    if (!inField(r, c)) return fail(ERR.BAD_TILE);
    const key = tileKey(r, c);
    const occ = this.board.get(key) || null;
    // a summon dragged onto its own owner swaps with it: a range-bound one must be inside the owner's range from the
    // tile the owner takes (the summon's, with the owner's facing)
    const ownerAfter = loc.area === 'board' && occ && occ !== piece && occ.uid === piece.ownerUid ? { key: loc.key, piece: occ, dir: pieceDir(occ) } : null;
    if (!this._legal(piece, r, c, ownerAfter)) return fail(ERR.BAD_TILE);
    if (occ === piece) return this._reorient(piece, dir);
    // summons limited to their summoner's attack range (狼群 / 流形) may only stand on a tile it covers
    const rangeTiles = this.summonRangeTiles(piece);
    const inOwnerRange = () => rangeTiles == null || rangeTiles.some(([tr, tc]) => tr === r && tc === c);
    if (loc.area === 'board') {
      if (!inOwnerRange()) return fail(ERR.BAD_TILE, 'outside summoner range');
      // board → board: move or swap; an operator swapped onto the summon's old tile changed its tile, so its other
      // summons go back onto their stacks like any moved operator (_liftTokensOf; the summon just placed stays)
      if (occ) {
        const [sr, sc] = parseKey(loc.key);
        if (!this._legal(occ, sr, sc)) return fail(ERR.BAD_TILE);
        this.board.set(loc.key, occ);
      } else {
        this.board.delete(loc.key);
      }
      piece.dir = dir;
      this.board.set(key, piece);
      if (occ && occ.kind === 'chess') this._liftTokensOf(occ.uid, piece);
      this.recompute();
      return OK;
    }
    if (occ) return fail(ERR.BAD_TILE, 'occupied');
    // owner must be on the board for its summons to be deployable
    const owner = [...this.board.values()].find((p) => p.uid === piece.ownerUid);
    if (!owner) return fail(ERR.BAD_TARGET, 'owner not deployed');
    if (!inOwnerRange()) return fail(ERR.BAD_TILE, 'outside summoner range');
    if ((piece.count || 1) > 1) {
      piece.count -= 1;
      const one = this.newPiece('token', piece.id, { count: 1, ownerUid: piece.ownerUid, dir });
      this.board.set(key, one);
    } else {
      this._detach(loc);
      piece.count = 1;
      piece.dir = dir;
      this.board.set(key, piece);
    }
    this.recompute();
    return OK;
  }

  _moveToHand(loc, idx) {
    const piece = loc.piece;
    const occ = this.hand[idx];
    if (occ === piece) return OK;
    if (piece.kind === 'token') {
      if (loc.area !== 'board') {
        // hand/temp token stack: plain slot move / swap inside the containers
        return this._swapContainers(loc, idx);
      }
      this.board.delete(loc.key);
      if (!this._returnToken(piece, occ == null ? { area: 'hand', idx } : null, { allowTemp: false })) {
        this.board.set(loc.key, piece);
        return fail(ERR.HAND_FULL);
      }
      this.recompute();
      return OK;
    }
    if (loc.area === 'board') {
      // withdraw (撤退): to an empty slot, or swap with a chess occupant (which takes the board tile). The piece's own
      // summon stacks leave the hand with it, so a slot holding one counts as free (a full hand nets zero cards)
      const ownStack = (p) => !!p && p.kind === 'token' && p.ownerUid === piece.uid;
      if (occ == null || ownStack(occ)) {
        this.board.delete(loc.key);
        this.removeTokensOf(piece.uid);
        this.hand[idx] = piece;
      } else if (occ.kind === 'chess') {
        const [sr, sc] = parseKey(loc.key);
        if (!this._legal(occ, sr, sc)) return fail(ERR.BAD_TILE);
        // the bench card takes the withdrawn piece's tile with that tile's facing
        occ.dir = pieceDir(piece);
        this.board.set(loc.key, occ);
        this.hand[idx] = piece;
        this.removeTokensOf(piece.uid);
        this.grantTokensFor(occ);
      } else {
        let j = freeSlot(this.hand);
        if (j < 0) j = this.hand.findIndex(ownStack);
        if (j < 0) return fail(ERR.HAND_FULL);
        this.board.delete(loc.key);
        this.removeTokensOf(piece.uid);
        this.hand[j] = piece;
      }
      this.recompute();
      return OK;
    }
    return this._swapContainers(loc, idx);
  }

  _swapContainers(loc, idx) {
    const piece = loc.piece;
    const occ = this.hand[idx];
    if (loc.area === 'temp' && loc.idx >= this.gd.tempSize && occ && occ.kind !== 'item') return fail(ERR.HAND_FULL);
    this._detach(loc);
    this.hand[idx] = piece;
    if (occ) {
      if (loc.area === 'hand') this.hand[loc.idx] = occ;
      else this._putTemp(loc.idx, occ);
    }
    this.recompute();
    return OK;
  }
  summonExcluded(piece, owner = null) {
    if (!piece || piece.kind !== 'token' || this.gd.token(piece.id)?.ownerRangeOutside !== true) return null;
    return this._ownerRangeOf(piece, owner);
  }
  _ownerRangeOf(piece, owner = null, placementGrid = null) {
    let at = owner;
    if (!at) for (const [key, p] of this.board) if (p.uid === piece.ownerUid && p.kind === 'chess') { at = { key, piece: p, dir: pieceDir(p) }; break; }
    const chess = at && this.gd.chess(at.piece.id);
    if (!chess) return null;
    const rec = this.fieldRecord(chess); // 0.2.0 补位: a stand-in's own range (its backup selection)
    const grid = placementGrid || attackRangeGrid(loadoutRecord(rec, resolveRecordLoadout(rec, this.loadoutFor(chess)))) || rec.rangeGrid;
    const [r, c] = parseKey(at.key);
    return ownerRangeKeys(grid, r, c, at.dir);
  }
}
