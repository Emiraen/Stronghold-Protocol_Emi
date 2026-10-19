// 从 A 原正文按职责拆分；保持原有行为。
import { layoutPen } from '../../render/pen.js';
import { isObj } from './shared.js';

export const TAG_ORDER = { boss: 0, bounty: 1, escort: 2 };

export const RANK_ORDER = { BOSS: 0, ELITE: 1, NORMAL: 2 };

export function groupEnemies(list, getEnemy = () => null) {
  const map = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (!isObj(e) || typeof e.enemyKey !== 'string') continue;
    const tag = typeof e.tag === 'string' ? e.tag : null;
    const k = `${e.enemyKey}|${tag}`;
    const cur = map.get(k) || { enemyKey: e.enemyKey, tag, count: 0 };
    cur.count += Number.isFinite(e.count) && e.count > 0 ? e.count : 1;
    map.set(k, cur);
  }
  return [...map.values()].map((row) => {
    const en = getEnemy(row.enemyKey);
    return { ...row, name: en?.name || row.enemyKey, rank: en?.rank || 'NORMAL', acTypes: Array.isArray(en?.acTypes) ? en.acTypes : (en?.acType ? [en.acType] : []), fly: en?.stats?.motion === 'FLY' || !!en?.isFlyEnemy };
  }).sort((a, b) => (TAG_ORDER[a.tag] ?? 9) - (TAG_ORDER[b.tag] ?? 9)
    || (RANK_ORDER[a.rank] ?? 9) - (RANK_ORDER[b.rank] ?? 9)
    || b.count - a.count || (a.enemyKey < b.enemyKey ? -1 : 1));
}

export const PEN = Object.freeze({ r0: 14, r1: 18, c0: 7, c1: 13, emptyRow: 16, cap: 50, anchors: Object.freeze({ lower: [15, 7], upper: [18, 7] }) });

export function penZoneTiles(gate) {
  const rows = gate === 'upper' ? [17, 18] : [14, 15];
  const [ar, ac] = PEN.anchors[gate === 'upper' ? 'upper' : 'lower'];
  const out = [];
  for (const r of rows) for (let c = PEN.c0; c <= PEN.c1; c++) if (!(r === ar && c === ac)) out.push([r, c]);
  return out;
}

export function penPlacement(entries, opts = {}) {
  const max = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : PEN.cap;
  const { figures } = layoutPen(Array.isArray(entries) ? entries : [], { stage: opts.stage || null, max });
  const perTile = new Map();
  return figures.map((f, k) => {
    const key = `${f.row},${f.col}`;
    const slot = perTile.get(key) || 0;
    perTile.set(key, slot + 1);
    return { enemyKey: f.enemyKey, gate: f.zone === 'upper' ? 'upper' : 'lower', row: f.row, col: f.col, slot, fly: !!f.fly, elite: !!f.elite, boss: !!f.boss, k };
  });
}

export function previewEnemyKey(e) {
  if (!isObj(e)) return null;
  if (typeof e.enemyKey === 'string' && e.enemyKey) return e.enemyKey;
  const u = isObj(e.unit) ? e.unit : null;
  if (!u || !(e.preview || u.preview)) return null;
  if (u.side !== 'enemy' && u.kind !== 'enemy') return null;
  const k = typeof u.enemyKey === 'string' && u.enemyKey ? u.enemyKey : u.defId;
  return typeof k === 'string' && k ? k : null;
}

export function factionTypes(factions) {
  const out = [];
  for (const f of Array.isArray(factions) ? factions : []) {
    const t = typeof f === 'string' ? f : isObj(f) ? (f.type || f.id || f.key) : null;
    if (typeof t === 'string' && t && !out.includes(t)) out.push(t);
  }
  return out;
}
