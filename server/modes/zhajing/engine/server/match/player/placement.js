// server/match/player/placement.js — PlayerState methods: g.move — placement legality on the deploy field (board.js),
// the summon ranges of 狼群 / 流形 (ownerRange) and the summons an owner's move or re-orientation leaves out of range,
// operator / summon moves onto the board, back to the hand, between hand and temp, swaps and re-orientation in place.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR } from '../../../shared/constants.js';
import { msg, dn } from '../../../shared/i18n.js';
import { tileKey, parseKey, inField, canPlace, placeClass, freeSlot, pieceDir, parseDir, ownerRangeKeys } from '../board.js';
import { attackRangeGrid, loadoutRecord, resolveRecordLoadout } from '../../../shared/loadoutRecord.js';
import { summonPlacementGrid } from '../../../shared/summonPlacement.js';
import { OK, fail } from './common.js';

/**
 * ★ 2026-10-17（用户）：虎狼丸的卫戍特质「<战斗中>部署后不占用可部署位置」——
 * 该干员可以不受最大人数限制（常为 8）。
 *
 * 判定完全由**数据**驱动：特质记录 `data/garrisons.json` 的 `bb.no_deploy_slot`。
 * ⇒ 以后任何干员想要这条，只需给它挂一个 `bb.no_deploy_slot: 1` 的卫戍特质，不用改代码。
 *
 * 实现上**只放行"是否算占位"这一个判断**：`deployCount` 本身不变（它统计棋盘上的 chess 数，
 * 还被 bot 摆位、`deployCap` 视图、审计 `audit.js` 用到 —— 改它会连累那三处）。
 */
export function noDeploySlot(gd, piece) {
  if (!gd || !piece || piece.kind !== 'chess') return false;
  const rec = gd.chess(piece.id);
  if (!rec || !Array.isArray(rec.garrisonIds)) return false;
  for (const gid of rec.garrisonIds) {
    const g = gd.garrison(gid);
    if (g && g.bb && Number(g.bb.no_deploy_slot) > 0) return true;
  }
  return false;
}

export class PlayerPlacement {
  /**
   * g.move {uid, to, dir?}. Pieces: chess / token between board, hand and temp; items only within the hand. `dir`
   * (UP|RIGHT|DOWN|LEFT, absent ⇒ RIGHT; `to.dir` is read when the top-level one is absent) is the facing of a piece
   * moved onto the board — onto its own tile it re-orients the piece in place.
   */
  move(uid, to, dir) {
    const g = this._gate(); if (g) return g;
    const loc = this.find(uid);
    if (!loc || loc.area === 'equipped') return fail(ERR.BAD_TARGET);
    if (!to || typeof to !== 'object') return fail(ERR.BAD_TARGET);
    const piece = loc.piece;
    // ★ 惊变羁绊「伟大封印」：结城理这一回合战死 → 本整备期不能再部署
    try {
      const cid = String(piece.chessId || piece.id || '');
      const banned = Number(piece.greatSealBanRound) || Number((this.mem || {}).greatSealBanRound) || 0;
      const round = Number(this.m.round) || 0;
      if (cid.startsWith('chess_zj_60_5') && banned > 0 && banned === round && to && to.area === 'board') {
        return fail(ERR.BAD_TARGET, '本回合无法再部署结城理');
      }
    } catch { /* 拦截出错就放行 */ }
    // ★ 2026-10-13（用户报的 bug）：一次【成功的】摆位/移动之后派发 onLayout —— 影分身这类
    //   「按场上人数重算盟约」的常驻钩子原来只在回合开始/备战结束/买卖时刷新，摆位时不刷新。
    const done = (r) => {
      if (r && r.ok !== false && !r.error) {
        try { this.m.dispatch(this, 'onLayout', { uid, area: to.area }); } catch { /* 钩子出错不影响摆位本身 */ }
      }
      return r;
    };
    if (to.area === 'board') {
      if (piece.kind === 'item') return fail(ERR.BAD_TARGET, 'items are equipped, not placed');
      const d = parseDir(dir !== undefined ? dir : to.dir);
      if (!d) return fail(ERR.BAD_TARGET, 'bad dir');
      return done(piece.kind === 'token' ? this._moveTokenToBoard(loc, to.row, to.col, d) : this._moveChessToBoard(loc, to.row, to.col, d));
    }
    if (to.area === 'hand') {
      if (!Number.isInteger(to.idx) || to.idx < 0 || to.idx >= this.hand.length) return fail(ERR.BAD_TARGET);
      return done(this._moveToHand(loc, to.idx));
    }
    return fail(ERR.BAD_TARGET);
  }

  _placementOf(piece) {
    const rec = piece.kind === 'token' ? this.gd.token(piece.id) : this.gd.chess(piece.id);
    // a melee chess whose trait reads 「可以放置于远程位」 may use a 高台, whatever its module (shared/highGround.js); a
    // stand-in is placed by its own record (placeClass)
    return placeClass(this, rec);
  }

  /**
   * Where piece may stand on (r, c): the deploy map of its position class (board.js canPlace) and, for a summon whose
   * text reads "只能部署在召唤者攻击范围内" (tokens.json `ownerRange`: 伺夜's 狼群, 缪尔赛思's 流形, Mon3tr's 重构体), a tile of
   * its owner's attack range (summonRange); for one marked `ownerRangeOutside` (凯尔希·思衡托's 战术锚点), a tile outside it
   * (summonExcluded). Jessica's shield instead uses the fixed four-adjacent-tile grid (shared/summonPlacement.js).
   * `owner` = the owner's position after the move being checked ({ key, piece, dir }: a summon swapped
   * with its own owner).
   */
  _legal(piece, r, c, owner = null) {
    if (!canPlace(this.deployMap(), this._placementOf(piece), r, c)) return false;
    const k = tileKey(r, c);
    const range = this.summonRange(piece, owner);
    if (range && !range.has(k)) return false;
    const out = this.summonExcluded(piece, owner);
    return !out || !out.has(k);
  }

  /**
   * The 'r,c' keys of the attack range of a range-bound summon's owner (player report #9 after 0.1.0: 伺夜's tactical
   * point could be placed anywhere; PRTS 狼群 特性 "只能部署在召唤者攻击范围内"): the owner's loadout-resolved range grid
   * (shared/loadoutRecord.js attackRangeGrid — what the deploy wheel previews) rotated by its facing around its board
   * tile (board.js ownerRangeKeys). Jessica's shield uses its four-adjacent-tile placement grid, independent of her
   * facing, skill or module. Null when the piece is not range-bound or its owner is not on the board (the other
   * rules refuse such a placement).
   * @param {any} piece
   * @param {{ key: string, piece: any, dir: string } | null} [owner] the owner's position to use instead of its current one
   * @returns {Set<string> | null}
   */
  summonRange(piece, owner = null) {
    if (!piece || piece.kind !== 'token') return null;
    const grid = summonPlacementGrid(piece.id);
    if (!grid && this.gd.token(piece.id)?.ownerRange !== true) return null;
    return this._ownerRangeOf(piece, owner, grid);
  }

  /**
   * The 'r,c' keys an outside-bound summon may NOT stand on — its owner's attack range (tokens `ownerRangeOutside`: PRTS
   * 战术锚点 "仅可以部署在凯尔希·思衡托攻击范围外的远程位"; 0.2.0 WE2) — or null (not outside-bound, or the owner is off the
   * board). Same range as summonRange.
   * @param {any} piece
   * @param {{ key: string, piece: any, dir: string } | null} [owner]
   * @returns {Set<string> | null}
   */
  summonExcluded(piece, owner = null) {
    if (!piece || piece.kind !== 'token' || this.gd.token(piece.id)?.ownerRangeOutside !== true) return null;
    return this._ownerRangeOf(piece, owner);
  }

  /** The owner's attack or fixed placement range of a summon, or null when its owner is off the board. */
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

  /**
   * Range-bound summons left outside their owner's attack range (the owner re-oriented in place, promoted, its loadout
   * changed, moved with no room to take its summons back) go back onto their stack — a summon still inside stays
   * [ASSUMED: the official moves every summon of a MOVED owner back, PRTS 卫戍协议/帮助 "移动干员时，其所属召唤物全部退场
   * 并重置至手牌区"; an in-place re-orientation keeps the ones it can]. One with no stack and no free hand / temp slot
   * leaves the board: its stack comes back at the next round start like a summon stack removed from temp at a prep
   * deadline (startRound → grantTokensFor, "干员所属召唤物会于下一回合返还"), so no illegal placement reaches the
   * battle. Returns the number taken off the board; a toast names them.
   */
  _liftOutOfRange() {
    const back = [], gone = [], backOut = [], goneOut = [], backAdjacent = [], goneAdjacent = [];
    for (const [k, p] of [...this.board]) {
      if (p.kind !== 'token') continue;
      const range = this.summonRange(p);
      const out = this.summonExcluded(p);
      const inside = !!(out && out.has(k));
      if (!inside && (!range || range.has(k))) continue;
      this.board.delete(k);
      const ok = this._returnToken(p, null, { allowTemp: true });
      const returned = inside ? (ok ? backOut : goneOut) : summonPlacementGrid(p.id) ? (ok ? backAdjacent : goneAdjacent) : (ok ? back : gone);
      returned.push(this.gd.token(p.id)?.name || p.id);
    }
    if (back.length) this.m.toast(this, 'warn', msg('{names}只能部署在召唤者攻击范围内，已退回整备区', { names: back.map(dn) }));
    if (gone.length) this.m.toast(this, 'warn', msg('{names}只能部署在召唤者攻击范围内，整备区已满，下回合返还', { names: gone.map(dn) }));
    // an outside-bound summon (战术锚点) its owner's new range now covers
    if (backOut.length) this.m.toast(this, 'warn', msg('{names}只能部署在召唤者攻击范围外，已退回整备区', { names: backOut.map(dn) }));
    if (goneOut.length) this.m.toast(this, 'warn', msg('{names}只能部署在召唤者攻击范围外，整备区已满，下回合返还', { names: goneOut.map(dn) }));
    if (backAdjacent.length) this.m.toast(this, 'warn', msg('{names}只能部署在召唤者相邻四格，已退回整备区', { names: backAdjacent.map(dn) }));
    if (goneAdjacent.length) this.m.toast(this, 'warn', msg('{names}只能部署在召唤者相邻四格，整备区已满，下回合返还', { names: goneAdjacent.map(dn) }));
    return back.length + gone.length + backOut.length + goneOut.length + backAdjacent.length + goneAdjacent.length;
  }

  /**
   * Whether every range-bound summon of `owner` that the range from (ownerKey, dir) leaves out can go back onto its
   * stack or into a free hand / temp slot (_reorient refuses otherwise: the player's own re-orientation never costs a
   * summon, like withdrawing one into a full hand gives HAND_FULL).
   */
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
    // ★ 2026-10-17（用户录屏：「部署虎狼丸后拿其他干员拖动替换，突破部署上限」）：
    //   旧写法把人数检查包在 `if (!occ || occ.kind !== 'chess')` 里 —— 理由是"替换净额为 0 不用查"。
    //   但 `deployCount` 现在**排除**带 no-deploy-slot 的干员（虎狼丸），所以「虎狼丸 → 普通干员」的替换
    //   净额是 +1 却完全不检查，反复操作就能把整个棋盘铺满（录屏里 剩余可放置=0 却站着 14+ 人）。
    //   现在两条路径都查，并扣掉"被替换者本来是否计入"。
    {
      const occCounted = !!occ && occ.kind === 'chess' && !noDeploySlot(this.gd, occ);
      const projected = this.deployCount - (occCounted ? 1 : 0);
      if (projected >= this.deployCap && !noDeploySlot(this.gd, piece)) return fail(ERR.BOARD_FULL);
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

  /**
   * In-place re-orientation (g.move onto the piece's own tile with a new direction). An owner's range-bound summons the
   * new range leaves out go back onto their stack (recompute → _liftOutOfRange); HAND_FULL (nothing changes) when one
   * of them would have nowhere to go.
   */
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

  /** Put a piece into the container slot described by `loc` (hand/temp idx), or anywhere free. */
  _putBack(loc, piece) {
    if (loc.area === 'hand' && this.hand[loc.idx] == null) { this.hand[loc.idx] = piece; return true; }
    if (loc.area === 'temp' && this.temp[loc.idx] == null) { this._putTemp(loc.idx, piece); return true; }
    return !!this.stow(piece, { allowTemp: true });
  }

  /**
   * A board token goes back to the hand: merge into its owner's stack, else occupy a free slot. `allowTemp: false`
   * (the player's own withdrawal): a summon stack is a card, so with a full hand and no stack to join it is refused
   * like any other card (research 01 A1) instead of overflowing into temp.
   */
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
    if (loc.area === 'board') {
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
        // ★ 2026-10-21 修（玩家反馈「虎狼丸无限部署」）：这是「把场上的干员拖到整备区、和里面的干员换人」——
        //   净额**不是 0**：被换下场的虎狼丸不计入部署数（no_deploy_slot），换上来的普通干员计入，
        //   于是每换一次就多占一个位置。配合「虎狼丸不占位可以直接再放上场」，反复循环就能把整块场地铺满。
        //   与 hand/temp→board 的替换（2026-10-17 那次修）对称地查一次上限：
        //   projected = 当前部署数 − 下场者是否计数 + 上场者是否计数。
        {
          const pieceCounted = !noDeploySlot(this.gd, piece);
          const occCounted = !noDeploySlot(this.gd, occ);
          const projected = this.deployCount - (pieceCounted ? 1 : 0) + (occCounted ? 1 : 0);
          if (projected > this.deployCap) return fail(ERR.BOARD_FULL);
        }
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

  /** hand/temp → hand slot: move into an empty slot or swap with the occupant. */
  _swapContainers(loc, idx) {
    const piece = loc.piece;
    const occ = this.hand[idx];
    this._detach(loc);
    this.hand[idx] = piece;
    if (occ) {
      if (loc.area === 'hand') this.hand[loc.idx] = occ;
      else this._putTemp(loc.idx, occ);
    }
    this.recompute();
    return OK;
  }
}
