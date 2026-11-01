import { store } from './store.js';
import { isZhajing } from '../../shared/zhajing-constants.js';

export function zhajingActive() { const s = store.get(); return isZhajing(s.room || s.spectator || s.match?.public); }
export const activeBenchSize = () => zhajingActive() ? 20 : 10;
// Keep both bench rows inside the main version's existing preparation camera.
export const handTile = (idx, size = activeBenchSize()) => ({ row: 7 + (size > 10 ? Math.floor(idx / 10) : 0), col: size > 10 ? idx % 10 : idx });
export const tempTile = (idx, size = activeBenchSize()) => size > 10
  ? idx < 4 ? { row: 9 + idx, col: 0 } : { row: 11 + idx - 4, col: 1 }
  : { row: 8, col: 4 + idx };
export function benchSlot(row, col, size = activeBenchSize()) {
  for (let i = 0; i < size; i++) { const t = handTile(i, size); if (t.row === row && t.col === col) return { area: 'hand', idx: i }; }
  for (let i = 0; i < (size > 10 ? 6 : 5); i++) { const t = tempTile(i, size); if (t.row === row && t.col === col) return { area: 'temp', idx: i }; }
  return null;
}
const stageCache = new WeakMap();
export function zhajingStage(stage) {
  if (!zhajingActive() || !stage?.rows) return stage;
  if (stageCache.has(stage)) return stageCache.get(stage);
  const rows = stage.rows.map(row => [...row]);
  for (let i = 0; i < 20; i++) { const t = handTile(i, 20); rows[t.row][t.col] = 'a'; }
  for (let i = 0; i < 6; i++) { const t = tempTile(i, 20); rows[t.row][t.col] = 'A'; }
  // The boss preparation uses board row − 7, just like the main version.
  for (let i = 0; i < 20; i++) { const t = handTile(i, 20); rows[t.row - 7][t.col] = 'a'; rows[t.row - 7][20 - t.col] = 'a'; }
  const value = { ...stage, rows: rows.map(row => row.join('')) };
  stageCache.set(stage, value); return value;
}
