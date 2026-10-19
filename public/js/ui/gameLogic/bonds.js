import { t as trA } from '../../../../shared/i18n.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { diyPicks } from './diy.js';
import { isObj, int } from './shared.js';

export function sortBonds(bonds, getBond = () => null) {
  const list = (Array.isArray(bonds) ? bonds : []).filter((b) => isObj(b) && typeof b.bondId === 'string');
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return [...list].sort((a, b) => (
    (a.off ? 1 : 0) - (b.off ? 1 : 0)
    || (b.active ? 1 : 0) - (a.active ? 1 : 0)
    || n(b.layers) - n(a.layers)
    || n(b.count) - n(a.count)
    || n(b.tier) - n(a.tier)
    || (getBond(b.bondId)?.isCore ? 1 : 0) - (getBond(a.bondId)?.isCore ? 1 : 0)
    || (a.bondId < b.bondId ? -1 : a.bondId > b.bondId ? 1 : 0)
  ));
}

export function bondTier(count, thresholds, maxCount = null) {
  const c = Number.isFinite(count) ? count : 0;
  if (Number.isFinite(maxCount) && c > maxCount) return 0;
  let t = 0;
  for (const th of Array.isArray(thresholds) ? thresholds : []) if (c >= th) t += 1;
  return t;
}

export function nextThreshold(count, thresholds) {
  for (const th of Array.isArray(thresholds) ? thresholds : []) if (count < th) return th;
  return null;
}

export function grantedBonds(items, getItem = () => null) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 2) return [];
  const recs = list.map((it) => getItem(typeof it === 'string' ? it : it?.id)).filter(isObj);
  if (!recs.some((r) => r.canGiveBond)) return [];
  const out = [];
  for (const r of recs) if (!r.canGiveBond && typeof r.giveBondId === 'string' && r.giveBondId && !out.includes(r.giveBondId)) out.push(r.giveBondId);
  return out;
}

export function pieceBondIds(chess, items, getItem = () => null) {
  const out = (Array.isArray(chess?.bonds) ? chess.bonds : []).filter((b) => typeof b === 'string');
  for (const b of grantedBonds(items, getItem)) if (!out.includes(b)) out.push(b);
  return out;
}

export function morphPairings(itemRecs, bondRecs, { off = null, carried = null } = {}) {
  const recs = [...(itemRecs || [])].filter(isObj);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const getItem = (id) => byId.get(id) || null;
  const worn = new Set(grantedBonds(carried, getItem));
  const carriedIds = new Set((Array.isArray(carried) ? carried : []).map((it) => (typeof it === 'string' ? it : it?.id)).filter((x) => typeof x === 'string'));
  const famOf = (r) => (typeof r.baseId === 'string' && r.baseId ? r.baseId : r.id);
  /** bondId → family id → { id, name, tier, order, ids } */
  const groups = new Map();
  recs.forEach((r, order) => {
    if (r.canGiveBond || typeof r.giveBondId !== 'string' || !r.giveBondId) return;
    let g = groups.get(r.giveBondId);
    if (!g) groups.set(r.giveBondId, (g = new Map()));
    const fam = famOf(r);
    const e = g.get(fam);
    if (e) { e.ids.push(r.id); return; }
    g.set(fam, { id: fam, name: typeof r.name === 'string' && r.name ? r.name : fam, tier: int(r.tier, 99), order, ids: [r.id] });
  });
  const out = [];
  for (const b of bondRecs || []) {
    const g = isObj(b) ? groups.get(b.bondId) : null;
    if (!g) continue;
    const bondWorn = worn.has(b.bondId);
    const items = [...g.values()].sort((x, y) => (x.tier - y.tier) || (x.order - y.order))
      .map((e) => ({ id: e.id, name: e.name, worn: bondWorn && e.ids.some((id) => carriedIds.has(id)) }));
    out.push({ bondId: b.bondId, name: typeof b.name === 'string' && b.name ? b.name : b.bondId, off: !!(off && typeof off.has === 'function' && off.has(b.bondId)), worn: bondWorn, items });
  }
  return out;
}

export const HARMONY_BOND = 'maniShip';

export function harmonyMembers(priv, getChess = () => null) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(priv?.board) ? priv.board : []) {
    if (p?.kind !== 'chess') continue;
    const c = getChess(p.id);
    if (!Array.isArray(c?.bonds) || !c.bonds.includes(HARMONY_BOND)) continue;
    const base = c.baseId || (typeof p.id === 'string' ? p.id.replace(/_b$/, '_a') : p.id);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ id: base, name: getChess(base)?.name || c.name || base });
  }
  return out;
}

export function bondMembers(bond, priv, banned = [], getChess = () => null, getItem = () => null, pieceRecord = null) {
  const bannedSet = banned instanceof Set ? banned : new Set(Array.isArray(banned) ? banned : []);
  const members = Array.isArray(bond?.visibleMembers) && bond.visibleMembers.length ? bond.visibleMembers : (Array.isArray(bond?.members) ? bond.members : []);
  const baseOf = (id) => getChess(id)?.baseId || (typeof id === 'string' ? id.replace(/_b$/, '_a') : id);
  const onBoard = new Set();
  const owned = new Set();
  const inHand = new Set();
  const memberSet = new Set(members);
  /** base id → { on: on the board?, hand: in the hand?, items: the wearer's item ids } — operators of the player that join this bond through 变形同构体 */
  const granted = new Map();
  const grants = (p) => typeof bond?.bondId === 'string' && grantedBonds(p.items, getItem).includes(bond.bondId);
  const recOf = (p) => (pieceRecord ? pieceRecord(p) : getChess(p.id));
  /** a composed 自选 record whose operator carries this bond */
  const diyOfBond = (rec) => isObj(rec) && typeof rec.diyFor === 'string' && Array.isArray(rec.bonds) && rec.bonds.includes(bond?.bondId);
  /** slot base id → { on, hand, owned, rec, pick } — the player's 自选 pieces and picks whose operator carries this bond */
  const diy = new Map();
  const diyOf = (p, on, hand) => {
    const rec = recOf(p);
    if (!diyOfBond(rec)) return false;
    const g = diy.get(rec.diyFor);
    if (g) { g.on = g.on || on; g.hand = g.hand || hand; return true; }
    // the row draws the normal form, as a member row its base chess (an elite copy is the same member)
    const pick = isObj(p.diy) && typeof p.diy.charId === 'string' ? p.diy : null;
    const normal = rec.isGolden ? recOf(pick ? { kind: 'chess', id: rec.diyFor, diy: pick } : { kind: 'chess', id: rec.diyFor }) : rec;
    diy.set(rec.diyFor, { on, hand, owned: true, rec: diyOfBond(normal) && normal.diyFor === rec.diyFor ? normal : rec, pick });
    return true;
  };
  const itemIds = (p) => p.items.map((it) => (typeof it === 'string' ? it : it?.id)).filter((x) => typeof x === 'string');
  for (const p of Array.isArray(priv?.board) ? priv.board : []) {
    if (p?.kind !== 'chess') continue;
    const base = baseOf(p.id);
    onBoard.add(base); owned.add(base);
    if (diyOf(p, true, false)) continue;
    if (!memberSet.has(base) && !granted.has(base) && grants(p)) granted.set(base, { on: true, hand: false, items: itemIds(p) });
  }
  for (const [list, hand] of [[priv?.hand, true], [priv?.temp, false]]) {
    for (const p of Array.isArray(list) ? list : []) {
      if (p?.kind !== 'chess') continue;
      const base = baseOf(p.id);
      owned.add(base);
      if (hand) inHand.add(base);
      if (diyOf(p, false, hand)) continue;
      if (memberSet.has(base) || !grants(p)) continue;
      const g = granted.get(base);
      if (!g) granted.set(base, { on: false, hand, items: itemIds(p) });
      else if (hand) g.hand = true;
    }
  }
  // the player's picks not owned (the slot's record through the own getter: gameLogic/diy.js diyGetter) — rows like an
  // unowned member's (counted by neither 在场 nor the 成员 header)
  for (const slotId of Object.keys(diyPicks(priv))) {
    if (diy.has(slotId)) continue;
    const rec = recOf({ kind: 'chess', id: slotId });
    if (diyOfBond(rec) && rec.diyFor === slotId) diy.set(slotId, { on: false, hand: false, owned: false, rec, pick: null });
  }
  const diyBanned = new Set(Array.isArray(priv?.diyBanned) ? priv.diyBanned : []);
  const rows = members.map((id) => {
    const c = getChess(id);
    return { id, tier: c?.tier ?? 0, name: c?.name ?? id, onBoard: onBoard.has(id), owned: owned.has(id), inHand: inHand.has(id), banned: bannedSet.has(id) };
  });
  for (const [id, g] of granted) {
    const c = getChess(id);
    rows.push({ id, tier: c?.tier ?? 0, name: c?.name ?? id, onBoard: g.on, owned: true, inHand: g.hand, banned: false, granted: true, items: g.items });
  }
  for (const [id, g] of diy) {
    rows.push({ id, tier: g.rec.tier ?? 0, name: g.rec.name ?? id, onBoard: g.on, owned: g.owned, inHand: g.hand, banned: bannedSet.has(id) || diyBanned.has(id), diy: true, rec: g.rec, ...(g.pick ? { pick: g.pick } : {}) });
  }
  return rows.sort((a, b) => (b.onBoard - a.onBoard) || (b.owned - a.owned) || (a.tier - b.tier) || (a.id < b.id ? -1 : 1));
}

export function memberHeadCount(rows, countsHand = false) {
  let n = 0;
  for (const r of Array.isArray(rows) ? rows : []) if (r && (r.onBoard || (countsHand && r.inHand))) n++;
  return n;
}

export function bannedPerBond(bonds, bannedChess) {
  const banned = new Set(Array.isArray(bannedChess) ? bannedChess : []);
  const out = new Map();
  for (const b of Array.isArray(bonds) ? bonds : []) {
    if (!isObj(b)) continue;
    const members = Array.isArray(b.visibleMembers) ? b.visibleMembers : [];
    out.set(b.bondId, members.filter((id) => banned.has(id)).length);
  }
  return out;
}

export function disabledBondSets(pub, staticInactive = []) {
  const off = new Set(Array.isArray(staticInactive) ? staticInactive : []);
  const src = Array.isArray(pub?.drawnDisabledBonds) ? pub.drawnDisabledBonds : Array.isArray(pub?.disabledBonds) ? pub.disabledBonds : [];
  const drawn = new Set(src.filter((b) => typeof b === 'string' && !off.has(b)));
  return { drawn, off };
}

export function briefingBondTip(name, state, bannedN = 0) {
  if (state === 'off') return trA("{name}：本局禁用（该盟约不会激活）", { "name": (name) });
  if (state === 'drawn' || bannedN > 0) return trA("{p0}：部分盟约所含干员阵容不完整{p1}", { "p0": (name), "p1": (bannedN ? `（${bannedN} 名干员无法出现）` : '') });
  return name;
}

export function modeOffBonds(mode) {
  const list = isObj(mode) && Array.isArray(mode.inactiveBondIds) ? mode.inactiveBondIds : [];
  return new Set(list.filter((b) => typeof b === 'string'));
}

export function bandOffBonds(band, off) {
  if (!(off instanceof Set) || !off.size || !Array.isArray(band?.bondIds)) return [];
  return band.bondIds.filter((b) => typeof b === 'string' && off.has(b));
}

export function bandOffLine(names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n);
  return list.length ? trA("本局禁用{names}盟约，此策略效果可能无法发挥", { "names": (list.map((n) => `【${n}】`).join('')) }) : '';
}
