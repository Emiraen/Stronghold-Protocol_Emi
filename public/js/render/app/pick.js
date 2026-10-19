// 从 A 原正文按职责拆分；保持原有行为。
import { hitRectAt } from '../pick.js';

export const PIECE_DIRS = new Set(['UP', 'RIGHT', 'DOWN', 'LEFT']);

export const pieceDirOf = (piece) => (typeof piece?.dir === 'string' && PIECE_DIRS.has(piece.dir.toUpperCase()) ? piece.dir.toUpperCase() : undefined);

export function pickUnitOf(v, walks = false, hitArea = null) {
  // a knocked-out operator lying on its tile waiting to redeploy (b.snap `down`, user playtest #4 item 9) is on that tile
  // too: a press there selects it; other dead / dying views are gone
  if (!v || v.destroyed || (v.alive === false && !v.down)) return null;
  if (Number.isFinite(v.alpha) && v.alpha < 0.05) return null;
  const sc = v.screen;
  const body = walks && sc && sc.s > 0 && !v.culled ? { x: sc.x, top: Number.isFinite(sc.top) ? sc.top : sc.y, feet: sc.y, s: sc.s } : null;
  const tile = walks ? null : { row: Math.round(v.y), col: Math.round(v.x) };
  // a huge boss (data `hitArea`): its hit area on the ground and a body box as wide as it are pickable (render/pick.js)
  const area = walks && !v.flying ? hitRectAt(v.x, v.y, hitArea) : null;
  if (area && body) body.hw = hitArea.w / 2;
  return { tile, x: v.x, y: v.y, fly: walks && !!v.flying, body, area, depth: v.root && !v.root.destroyed ? v.root.zIndex : 0, ref: v };
}
