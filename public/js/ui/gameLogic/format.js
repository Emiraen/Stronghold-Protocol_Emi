import { langInfo } from '../../../../shared/i18n.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { isObj, clamp, tileKey } from './shared.js';

export const STATUS_META = Object.freeze({
  acting: { glyph: 'dots', text: '行动中', tone: 'lo' },
  ready: { glyph: 'check', text: '已就绪', tone: 'mint' },
  deciding: { glyph: 'hourglass', text: '决策中', tone: 'gold' },
  combat: { glyph: 'sword', text: '作战中', tone: 'orange' },
  done: { glyph: 'check', text: '作战结束', tone: 'mint' },
  helping: { glyph: 'shield', text: '联防中', tone: 'orange' },
  left: { glyph: 'exit', text: '已离开', tone: 'red' },
  dead: { glyph: 'close', text: '已淘汰', tone: 'red' },
});

export function snapHud(snap) {
  if (!isObj(snap)) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  let boss = null;
  if (isObj(snap.boss) && Number.isFinite(snap.boss.hp)) boss = { hp: snap.boss.hp, max: n(snap.boss.max) ?? n(snap.boss.maxHp) };
  return { killed: n(snap.killed), total: n(snap.total), dp: n(snap.dp), boss };
}

export function bossFrac(bossHp) {
  if (!isObj(bossHp)) return null;
  const hp = Number(bossHp.hp);
  const max = Number(bossHp.max ?? bossHp.maxHp);
  if (!Number.isFinite(hp) || !Number.isFinite(max) || max <= 0) return null;
  return clamp(hp / max, 0, 1);
}

export function bossPctText(frac) {
  if (frac == null || !Number.isFinite(frac)) return null;
  const pct = clamp(frac, 0, 1) * 100;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct > 0 && pct < 0.05) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

export const hasFlag = (flags, bit) => (Number(flags) & bit) !== 0;

export function attackInterval(bat, aspd = 100) {
  const b = Number(bat);
  const a = Number(aspd) > 0 ? Number(aspd) : 100;
  if (!Number.isFinite(b) || b <= 0) return null;
  return b * 100 / a;
}

export function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const units = langInfo()?.numberUnits;
  if (!units) {
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(Math.abs(n) >= 1e10 ? 0 : 1)}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(Math.abs(n) >= 1e7 ? 0 : 1)}M`;
    if (Math.abs(n) >= 1e5) return `${Math.round(n / 1e3)}K`;
    return Math.round(n).toLocaleString('en-US');
  }
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 1)}${units[1]}`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)}${units[0]}`;
  return Math.round(n).toLocaleString('en-US');
}

export function rangeGridBox(grid, mirror = false) {
  const cells = new Set();
  let minR = 0; let maxR = 0; let minC = 0; let maxC = 0;
  for (const g of Array.isArray(grid) ? grid : []) {
    if (!Array.isArray(g) || !Number.isFinite(g[0]) || !Number.isFinite(g[1])) continue;
    const r = g[0];
    const c = mirror ? -g[1] : g[1];
    cells.add(tileKey(r, c));
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  return { rows: maxR - minR + 1, cols: maxC - minC + 1, r0: maxR, c0: minC, cells, self: [0, 0] };
}
