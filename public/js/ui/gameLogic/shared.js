// 从 A 原正文按职责拆分；保持原有行为。
import { UF } from '../../../../shared/constants.js';
import { attackRangeGrid, deployWithinOwnerRange } from '../../../../shared/loadoutRecord.js';
import { rangeTiles, pieceDir } from '../facing.js';

export const isObj = (v) => !!v && typeof v === 'object';

export const int = (v, d = 0) => (Number.isInteger(v) ? v : d);

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const tileKey = (row, col) => `${row},${col}`;

export function sortedPlayers(pub) {
  const list = Array.isArray(pub?.players) ? pub.players.filter(isObj) : [];
  return [...list].sort((a, b) => int(a.seat, 99) - int(b.seat, 99));
}

export const WATER_PLATFORM_ROLE = 'waterPlatform';

export function ownerRangeOk(ctx, piece, row, col) {
  const tokRec = ctx.getToken?.(piece.id);
  if (!deployWithinOwnerRange(tokRec)) return { ok: true };
  const entry = [...ctx.boardAt.values()].find((e) => e.piece && e.piece.uid === piece.ownerUid);
  if (!entry) return { ok: false, code: 'BAD_TARGET', reason: '召唤者尚未部署' };
  let rec = ctx.getChess?.(entry.piece.id) || null;
  if (rec && typeof ctx.chessRecord === 'function') { try { rec = ctx.chessRecord(rec) || rec; } catch { /* the data record */ } }
  const grid = attackRangeGrid(rec);
  if (!Array.isArray(grid) || !grid.length) return { ok: false, code: 'BAD_TILE', reason: '只能部署在召唤者的攻击范围内' };
  const hit = rangeTiles(grid, entry.row, entry.col, pieceDir(entry.piece)).some(([r, c]) => r === row && c === col);
  return hit ? { ok: true } : { ok: false, code: 'BAD_TILE', reason: '只能部署在召唤者的攻击范围内' };
}

export function itemAttaches(item) {
  if (item?.kind === 'consume_on_equip_or_delayed') return !item.isGolden;
  return !(typeof item?.kind === 'string' && item.kind.startsWith('consume_on_equip'));
}

export { UF };
