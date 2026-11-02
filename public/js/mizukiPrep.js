import { GEO } from '../../shared/constants.js';
import { mizukiTerrainAllows } from '../../shared/mizukiPlacement.js';
export const MIZUKI_PREP_SHIFT = 2;
export const MIZUKI_GEO = { ...GEO, HAND_ROW: 0, TEMP_ROW: 1, FIELD: { r0: 2, r1: 18, c0: 0, c1: 20 } };
export function createMizukiPrepMoveQueue(limit = 16) {
  let tail = Promise.resolve(), size = 0;
  return {
    get size() { return size; },
    enqueue(send) {
      if (size >= limit) return null;
      size += 1;
      const request = tail.then(send);
      tail = request.catch(() => {});
      return request.finally(() => { size -= 1; });
    },
  };
}
export function mizukiPrepStage(stage, rect) {
  const rows = Array.from({ length: 19 }, () => '#'.repeat(21));
  for (let row = rect.r0; row <= rect.r1; row++) if (stage.rows[row]) rows[row + MIZUKI_PREP_SHIFT] = stage.rows[row];
  rows[0] = 'a'.repeat(10) + '#'.repeat(11);
  rows[1] = '#'.repeat(4) + 'A'.repeat(5) + '#'.repeat(12);
  return { ...stage, id: stage.id + ':mizuki-prep', nativeMapRows:stage.originalSize?.rows || stage.originalSize?.[0] || stage.rows.length, rows, tiles: { ...stage.tiles, a: { tileKey: 'tile_achand', height: 'HIGH' }, A: { tileKey: 'tile_achand', height: 'HIGH' } } };
}
export function mizukiPrepRenderState(prep, peers = []) {
  return { ...prep, hand: prep.hand || prep.bench || [], temp: prep.temp || [],
    board: [...(prep.board || []), ...peers].map(piece => ({ ...piece, row: piece.row + MIZUKI_PREP_SHIFT })) };
}

export function mizukiPrepMoveCanPredict(prep, move) {
  const piece = [...(prep?.board || []), ...(prep?.hand || prep?.bench || []), ...(prep?.temp || []), ...(prep?.supplies || [])]
    .find(value => (value && typeof value === 'object' ? value.uid : value) === move?.uid);
  if (piece == null) return false;
  if (piece.kind !== 'token') return true;
  const fromBoard = (prep?.board || []).some(value => value?.uid === move.uid);
  // Splitting a stack allocates a server UID; returning a token may merge it
  // into another stack. Neither operation can retain the requested UID locally.
  return move?.to?.area === 'board' && (fromBoard || !(piece.count > 1));
}

export function applyPendingPrepMoves(prep, moves = []) {
  const next = { ...prep, hand: [...(prep?.hand || prep?.bench || [])], temp: [...(prep?.temp || [])],
    board: [...(prep?.board || [])], supplies: (prep?.supplies || []).filter(Boolean) };
  const uidOf = piece => piece && typeof piece === 'object' ? piece.uid : piece;
  const atSlot = (piece, target, dir) => {
    if (target.area === 'hand' && (!piece || typeof piece !== 'object'
      || !Object.keys(piece).some(key => !['uid', 'row', 'col', 'dir'].includes(key)))) return uidOf(piece);
    const value = piece && typeof piece === 'object' ? { ...piece } : { uid: piece };
    if (target.area === 'board') return { ...value, row: target.row, col: target.col, dir: dir || value.dir || 'RIGHT' };
    if (!piece || typeof piece !== 'object') return piece;
    delete value.row; delete value.col;
    return value;
  };
  for (const move of moves) {
    const uid = move?.uid, target = move?.to;
    if (!Number.isInteger(uid) || !target || !['board', 'hand'].includes(target.area)) continue;
    if (!mizukiPrepMoveCanPredict(next, move)) continue;
    const fromBoardIndex = next.board.findIndex(piece => piece.uid === uid);
    const handIndex = next.hand.findIndex(piece => uidOf(piece) === uid), tempIndex = next.temp.findIndex(piece => uidOf(piece) === uid);
    const source = fromBoardIndex >= 0 ? { area: 'board', index: fromBoardIndex, piece: next.board[fromBoardIndex] }
      : handIndex >= 0 ? { area: 'hand', index: handIndex, piece: next.hand[handIndex] }
        : tempIndex >= 0 ? { area: 'temp', index: tempIndex, piece: next.temp[tempIndex] }
          : { area: 'supplies', index: next.supplies.findIndex(piece => piece?.uid === uid) };
    if (source.index < 0) continue;
    if (source.area === 'supplies') source.piece = next.supplies[source.index];
    if (target.area === 'hand' && (!Number.isInteger(target.idx) || target.idx < 0 || target.idx >= next.hand.length)) continue;
    if (target.area === 'board' && (!Number.isInteger(target.row) || !Number.isInteger(target.col))) continue;
    const occupantIndex = target.area === 'board'
      ? next.board.findIndex(piece => piece.row === target.row && piece.col === target.col && piece.uid !== uid)
      : next.hand.findIndex((value, index) => index === target.idx && value != null && uidOf(value) !== uid);
    const occupant = occupantIndex >= 0 ? (target.area === 'board' ? next.board[occupantIndex] : next.hand[occupantIndex]) : null;
    if (occupant && source.area === 'supplies' && !next.hand.some(value => value == null)) continue;
    if (source.area === 'board') next.board = next.board.filter(piece => piece.uid !== uid);
    else if (source.area === 'supplies') next.supplies.splice(source.index, 1);
    else next[source.area][source.index] = null;
    if (occupant) {
      if (target.area === 'board') next.board = next.board.filter(piece => piece.uid !== uidOf(occupant));
      else next.hand[target.idx] = null;
      if (source.area === 'board') next.board.push(atSlot(occupant, { area: 'board', row: source.piece.row, col: source.piece.col }));
      else if (source.area === 'hand' || source.area === 'temp') next[source.area][source.index] = atSlot(occupant, source);
      else {
        const free = next.hand.findIndex(value => value == null);
        if (free >= 0) next.hand[free] = atSlot(occupant, { area: 'hand' });
      }
    }
    if (target.area === 'board') next.board.push(atSlot(source.piece, target, move.dir));
    else next.hand[target.idx] = atSlot(source.piece, target);
    // Supplies are a list of unplaced tools, not fixed slots. Keep it dense
    // and avoid a second copy when a tool is moved into hand or onto the board.
    next.supplies = next.supplies.filter(piece => piece.uid !== uid);
  }
  if (prep?.bench) next.bench = next.hand;
  return next;
}

export function mizukiPrepTarget(target) {
  return target?.area === 'board' ? { area: 'board', row: target.row - MIZUKI_PREP_SHIFT, col: target.col } : target;
}
export function mizukiCanPlace(prep, geometry, uid, renderedTarget, peerBoards = []) {
  const pieces = [...(prep?.hand || prep?.bench || []), ...(prep?.temp || []), ...(prep?.board || []), ...(prep?.supplies || [])].filter(Boolean);
  const piece = pieces.find(item => item.uid === uid);
  if (!piece) return false;
  const target = mizukiPrepTarget(renderedTarget);
  if (target?.area === 'hand') return Number.isInteger(target.idx) && target.idx >= 0 && target.idx < 10;
  if (target?.area !== 'board') return false;
  if (Object.prototype.hasOwnProperty.call(prep.legalTiles || {}, uid)) {
    return prep.legalTiles[uid].some(([row, col]) => row === target.row && col === target.col);
  }
  const tile = geometry?.tiles?.find(item => item.row === target.row && item.col === target.col);
  if (!mizukiTerrainAllows(piece, tile, piece.buildableAll)) return false;
  return !peerBoards.some(item => item.row === target.row && item.col === target.col);
}
