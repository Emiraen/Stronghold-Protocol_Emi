import { t as trA } from '../../../../shared/i18n.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { GEO } from '../../../../shared/constants.js';
import { resolveLoadout } from '../../../../shared/protocol.js';
import { attackRangeGrid } from '../../../../shared/loadoutRecord.js';
import { meleeOnHighGround } from '../../../../shared/highGround.js';
import { itemMergeRecipe } from '../../../../shared/itemMerge.js';
import { rangeTiles, pieceDir } from '../facing.js';
import { isObj, tileKey, WATER_PLATFORM_ROLE, ownerRangeOk, itemAttaches } from './shared.js';
import { fieldTile, boardTileOf } from './camera.js';
import { deployedRecord, deployedModuleId } from './standIn.js';
import { chessLoadout } from './loadout.js';

export function deploySets(stage, field = 'normal', overrides = {}) {
  const melee = new Set();
  const ranged = new Set();
  if (Array.isArray(stage?.rows) || field === 'bossL' || field === 'bossR') {
    for (const [k, cls] of deployMap(stage, { ...(isObj(overrides) ? overrides : {}), field })) { ranged.add(k); if (cls === 'melee') melee.add(k); }
    return { melee, ranged };
  }
  const inField = (r, c) => r >= GEO.FIELD.r0 && r <= GEO.FIELD.r1 && c >= GEO.FIELD.c0 && c <= GEO.FIELD.c1;
  const dt = stage?.deployTiles?.normal;
  if (isObj(dt) && Array.isArray(dt.melee)) {
    for (const t of dt.melee) if (Array.isArray(t) && inField(t[0], t[1])) { melee.add(tileKey(t[0], t[1])); ranged.add(tileKey(t[0], t[1])); }
    for (const t of Array.isArray(dt.rangedOnly) ? dt.rangedOnly : []) if (Array.isArray(t) && inField(t[0], t[1])) ranged.add(tileKey(t[0], t[1]));
  }
  return { melee, ranged };
}

export const OBSTACLE_ROLES = new Set(['crate', 'mound']);

export const PLATFORM_ROLES = new Set(['platform']);

export const hasKeys = (o) => isObj(o) && Object.keys(o).length > 0;

export function stageOverrides(priv, getEffect = () => null) {
  const deviceOverrides = {};
  const tileOverrides = {};
  if (isObj(priv?.deviceOverrides) || isObj(priv?.tileOverrides)) {
    for (const [k, v] of Object.entries(isObj(priv.deviceOverrides) ? priv.deviceOverrides : {})) deviceOverrides[k] = !!v;
    for (const [k, v] of Object.entries(isObj(priv.tileOverrides) ? priv.tileOverrides : {})) if (typeof v === 'string') tileOverrides[k] = v;
    return { deviceOverrides, tileOverrides };
  }
  for (const e of Array.isArray(priv?.effects) ? priv.effects : []) {
    // picked 机变 cards: 'choice:<effectId>#<n>' (sim/content/choices.js refIdFor) or '<effectId>#<n>' (choices.js
    // addRef); band / builtin entries (no '#<n>', other prefixes) are not picks
    const m = typeof e?.id === 'string' ? /^(?:choice:)?([^:#]+)#\d+$/.exec(e.id) : null;
    if (!m) continue;
    const eff = getEffect(m[1]);
    for (const b of Array.isArray(eff?.buffs) ? eff.buffs : []) {
      if (b?.key !== 'auto_chess_change_map' || !isObj(b.bb)) continue;
      for (const [alias, v] of Object.entries(b.bb)) if (alias.includes('#')) deviceOverrides[alias] = Number(v) !== 0;
    }
  }
  return { deviceOverrides, tileOverrides };
}

export function deployMap(stage, { deviceOverrides = {}, tileOverrides = {}, field = 'normal' } = {}) {
  const F = GEO.FIELD;
  const inField = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= F.r0 && r <= F.r1 && c >= F.c0 && c <= F.c1;
  const map = new Map();
  const rows = Array.isArray(stage?.rows) ? stage.rows : null;
  const legend = isObj(stage?.tiles) ? stage.tiles : {};
  for (let r = F.r0; r <= F.r1; r++) {
    for (let c = F.c0; c <= F.c1; c++) {
      const [sr, sc] = fieldTile(field, r, c);
      const line = rows && typeof rows[sr] === 'string' ? rows[sr] : null;
      let cls = null;
      if (line) {
        const g = line[sc];
        const t = g != null && Object.hasOwn(legend, g) ? legend[g] : null;
        if (t && t.special !== 'deepsea') {
          const b = t.buildable;
          if (t.height === 'LOW' && (b === 'ALL' || b === 'MELEE')) cls = 'melee';
          else if ((t.height === 'HIGH' && (b === 'ALL' || b === 'RANGED')) || (t.height === 'LOW' && b === 'RANGED')) cls = 'ranged';
        }
      } else if (!stage) cls = c === 9 ? null : 'melee';
      if (cls) map.set(tileKey(r, c), cls);
    }
  }
  for (const d of Array.isArray(stage?.devices) ? stage.devices : []) {
    if (!isObj(d) || !Array.isArray(d.pos)) continue;
    const [r, c] = boardTileOf(field, d.pos[0], d.pos[1]);
    if (!inField(r, c)) continue;
    let active;
    if (d.alias != null && isObj(deviceOverrides) && Object.hasOwn(deviceOverrides, d.alias)) active = !!deviceOverrides[d.alias];
    else if (typeof d.active === 'boolean') active = d.active;
    else active = !d.hidden;
    if (!active) continue;
    if (OBSTACLE_ROLES.has(d.role)) map.delete(tileKey(r, c));
    else if (PLATFORM_ROLES.has(d.role)) map.set(tileKey(r, c), 'ranged');
    else if (d.role === WATER_PLATFORM_ROLE) map.set(tileKey(r, c), 'melee');
  }
  for (const [k, v] of Object.entries(isObj(tileOverrides) ? tileOverrides : {})) {
    const [r, c] = String(k).split(',').map(Number);
    if (!inField(r, c)) continue;
    if (v === 'melee' || v === 'ranged') map.set(tileKey(r, c), v);
    else if (v === 'none') map.delete(tileKey(r, c));
  }
  return map;
}

export function effectiveStage(stage, overrides = {}) {
  const dev = isObj(overrides?.deviceOverrides) ? overrides.deviceOverrides : {};
  const tiles = isObj(overrides?.tileOverrides) ? overrides.tileOverrides : {};
  if (!isObj(stage) || (!hasKeys(dev) && !hasKeys(tiles))) return stage;
  const devices = (Array.isArray(stage.devices) ? stage.devices : []).map((d) => (
    isObj(d) && d.alias != null && Object.hasOwn(dev, d.alias) ? { ...d, active: !!dev[d.alias] } : d));
  const map = deployMap(stage, { deviceOverrides: dev, tileOverrides: tiles });
  const melee = [];
  const rangedOnly = [];
  for (const [k, cls] of map) {
    const [r, c] = k.split(',').map(Number);
    (cls === 'melee' ? melee : rangedOnly).push([r, c]);
  }
  const deployTiles = { ...(isObj(stage.deployTiles) ? stage.deployTiles : {}), normal: { melee, rangedOnly } };
  return { ...stage, devices, deployTiles };
}

export function indexPieces(priv) {
  const map = new Map();
  (Array.isArray(priv?.board) ? priv.board : []).forEach((p) => {
    if (isObj(p) && Number.isInteger(p.uid)) map.set(p.uid, { piece: p, area: 'board', row: p.row, col: p.col });
  });
  (Array.isArray(priv?.hand) ? priv.hand : []).forEach((p, idx) => {
    if (isObj(p) && Number.isInteger(p.uid)) map.set(p.uid, { piece: p, area: 'hand', idx });
  });
  (Array.isArray(priv?.temp) ? priv.temp : []).forEach((p, idx) => {
    if (isObj(p) && Number.isInteger(p.uid)) map.set(p.uid, { piece: p, area: 'temp', idx });
  });
  return map;
}

export function placementContext({ priv, stage, editable, field = 'normal', getChess = () => null, getToken = () => null, getItem = () => null, getEffect = () => null, chessRecord = null, backups = null }) {
  const pieces = indexPieces(priv);
  const boardAt = new Map();
  for (const e of pieces.values()) if (e.area === 'board') boardAt.set(tileKey(e.row, e.col), e);
  const handAt = new Map();
  for (const e of pieces.values()) if (e.area === 'hand') handAt.set(e.idx, e);
  const cap = Number.isInteger(priv?.deployCap) ? priv.deployCap : 8;
  let deployed = 0;
  for (const e of pieces.values()) if (e.area === 'board' && e.piece.kind === 'chess') deployed += 1;
  const count = Number.isInteger(priv?.deployCount) ? priv.deployCount : deployed;
  const ov = stageOverrides(priv, getEffect);
  // Both fields derive from the legend + active devices; apply per-player overrides after devices like the server.
  const deploy = deploySets(stage, field, ov);
  return { priv, pieces, boardAt, handAt, deploy, cap, count, field, editable: !!editable, getChess, getToken, getItem, getEffect, chessRecord, backups };
}

export function piecePosition(ctx, piece) {
  if (!isObj(piece)) return null;
  if (piece.kind === 'chess') {
    const original = ctx.getChess(piece.id);
    const rec = ctx.chessRecord ? ctx.chessRecord(original) : deployedRecord(original, ctx.priv, ctx.getChess, ctx.backups);
    let moduleId = null;
    try { moduleId = deployedModuleId(original, ctx.priv, ctx.getChess, ctx.backups); } catch { moduleId = null; }
    if (meleeOnHighGround(rec, moduleId)) return 'ALL';
    return rec?.position === 'MELEE' ? 'MELEE' : 'RANGED';
  }
  // tokens: MELEE → ground only; RANGED / ALL → any deployable tile
  if (piece.kind === 'token') return ctx.getToken(piece.id)?.position === 'MELEE' ? 'MELEE' : 'RANGED';
  return null;
}

export function tileAllows(ctx, piece, row, col) {
  const pos = piecePosition(ctx, piece);
  if (!pos) return false;
  const k = tileKey(row, col);
  return pos === 'MELEE' ? ctx.deploy.melee.has(k) : ctx.deploy.ranged.has(k);
}

export function summonRange(ctx, piece, owner = null) {
  if (!isObj(piece) || piece.kind !== 'token' || ctx?.getToken?.(piece.id)?.ownerRange !== true) return null;
  let at = owner;
  if (!at) for (const e of ctx.boardAt.values()) if (e.piece.uid === piece.ownerUid && e.piece.kind === 'chess') { at = e; break; }
  const rec = at && ctx.getChess(at.piece.id);
  if (!rec) return null;
  let grid = null;
  try { grid = attackRangeGrid((ctx.chessRecord ? ctx.chessRecord(rec) : deployedRecord(rec, ctx.priv, ctx.getChess, ctx.backups)) || rec); } catch { /* the data grid */ }
  return new Set(rangeTiles(grid || rec.rangeGrid, at.row, at.col, pieceDir(at.piece)).map(([r, c]) => tileKey(r, c)));
}

export function unitAllowed(ctx, piece, row, col, owner = null) {
  if (!tileAllows(ctx, piece, row, col)) return false;
  const range = summonRange(ctx, piece, owner);
  return !range || range.has(tileKey(row, col));
}

export function canPlace(ctx, uid, target) {
  const no = (code, reason) => ({ ok: false, code, reason });
  if (!ctx || !ctx.editable) return no('WRONG_PHASE', trA("当前阶段无法进行该操作"));
  const src = ctx.pieces.get(uid);
  if (!src) return no('BAD_TARGET', trA("找不到该单位"));
  if (!isObj(target)) return no('BAD_TILE', trA("无法部署在该位置"));
  const piece = src.piece;
  const isMagic = piece.kind === 'item' && ctx.getItem(piece.id)?.itemType === 'MAGIC';

  if (target.area === 'hand') {
    const idx = target.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) return no('BAD_TILE', trA("无法放置在该位置"));
    if (src.area === 'hand' && src.idx === idx) return no('ALREADY', trA("位置未变化"));
    const occ = ctx.handAt.get(idx);
    if (!occ) return { ok: true, action: 'move' };
    if (piece.kind === 'item') {
      if (occ.piece.kind === 'chess') return isMagic ? no('BAD_TARGET', trA("该道具需要放置在战场上使用")) : equipCheck(ctx, piece, occ.piece);
      if (src.area === 'temp' && src.idx >= GEO.TEMP_SIZE && occ.piece.kind !== 'item') return no('HAND_FULL', trA("道具溢出区只能存放道具"));
      return { ok: true, action: 'swap' };
    }
    if (src.area === 'board') {
      if (piece.kind === 'token') return { ok: true, action: 'move' }; // back onto its stack
      if (occ.piece.kind === 'chess') {
        if (!tileAllows(ctx, occ.piece, src.row, src.col)) return no('BAD_TILE', trA("交换后的单位无法部署在原位置"));
        return { ok: true, action: 'swap' };
      }
      // 撤退会移除自己的召唤物栈，其 hand 格也可容纳撤回的干员。
      const free = [...Array(GEO.HAND_SIZE).keys()].some((i) => {
        const p = ctx.handAt.get(i)?.piece;
        return !p || (p.kind === 'token' && p.ownerUid === piece.uid);
      });
      return free ? { ok: true, action: 'move' } : no('HAND_FULL', trA("整备区已满"));
    }
    return { ok: true, action: 'swap' };
  }

  if (target.area === 'board') {
    const { row, col } = target;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return no('BAD_TILE', trA("无法部署在该位置"));
    const inField = row >= GEO.FIELD.r0 && row <= GEO.FIELD.r1 && col >= GEO.FIELD.c0 && col <= GEO.FIELD.c1;
    if (!inField) return no('BAD_TILE', trA("无法部署在该位置"));
    const occ = ctx.boardAt.get(tileKey(row, col));
    if (piece.kind === 'item') {
      if (isMagic) return { ok: true, action: 'art' };
      if (!occ) return no('BAD_TARGET', trA("请将装备拖拽至干员身上"));
      return equipCheck(ctx, piece, occ.piece);
    }
    // its own tile: re-orient in place through the direction wheel (research 09 §1.2)
    if (src.area === 'board' && src.row === row && src.col === col) return { ok: true, action: 'orient' };
    if (!tileAllows(ctx, piece, row, col)) {
      const deployable = ctx.deploy.ranged.has(tileKey(row, col));
      return no('BAD_TILE', deployable && piecePosition(ctx, piece) === 'MELEE' ? trA("近战单位只能部署在地面") : trA("无法部署在该位置"));
    }
    // a range-bound summon (战术点): inside its owner's attack range — seen from the summon's old tile when it is
    // dropped onto its own owner (the two swap)
    const ownerSwap = src.area === 'board' && occ && occ.piece.uid === piece.ownerUid ? { row: src.row, col: src.col, piece: occ.piece } : null;
    const range = summonRange(ctx, piece, ownerSwap);
    if (range && !range.has(tileKey(row, col))) return no('BAD_TILE', trA("只能部署在召唤者攻击范围内"));
    if (src.area === 'board') {
      // A displaced summon belonging to the moving operator returns to hand; other occupants must fit the source tile.
      const ownSummon = occ && occ.piece.kind === "token" && occ.piece.ownerUid === piece.uid;
      if (occ && !ownSummon && !tileAllows(ctx, occ.piece, src.row, src.col)) return no("BAD_TILE", trA("交换后的单位无法部署在原位置"));
      if (occ && !ownSummon && occ.piece.kind === "token") {
        const swapped = ownerRangeOk(ctx, occ.piece, src.row, src.col);
        if (!swapped.ok) return no(swapped.code, swapped.reason);
      }
      if (piece.kind === "token") {
        const rr = ownerRangeOk(ctx, piece, row, col);
        if (!rr.ok) return no(rr.code, rr.reason);
      }
      return { ok: true, action: occ ? 'swap' : 'move' };
    }
    if (piece.kind === 'token') {
      if (occ) return no('BAD_TILE', trA("该位置已有单位"));
      const ownerDeployed = [...ctx.boardAt.values()].some((e) => e.piece.uid === piece.ownerUid);
      if (Number.isInteger(piece.ownerUid) && !ownerDeployed) return no('BAD_TARGET', trA("召唤者尚未部署"));
      const rr = ownerRangeOk(ctx, piece, row, col);
      if (!rr.ok) return no(rr.code, rr.reason);
      return { ok: true, action: 'move' };
    }
    if ((!occ || occ.piece.kind !== 'chess') && ctx.count >= ctx.cap) return no('BOARD_FULL', trA("已达到部署上限"));
    return { ok: true, action: occ ? 'swap' : 'move' };
  }
  return no('BAD_TILE', trA("无法放置在该位置"));
}

export function equipCheck(ctx, itemPiece, targetPiece) {
  const item = ctx.getItem(itemPiece.id);
  if (item?.itemType === 'MAGIC') return { ok: false, code: 'BAD_TARGET', reason: '该道具需要放置在战场上使用' };
  if (!isObj(targetPiece) || targetPiece.kind !== 'chess') return { ok: false, code: 'BAD_TARGET', reason: '装备只能配发给干员' };
  return { ok: true, action: 'equip' };
}

export function equipMerges(ctx, uid, itemMergeCount = 2, targetPiece = null) {
  const piece = ctx?.pieces?.get(uid)?.piece;
  if (!isObj(piece) || piece.kind !== 'item') return false;
  const rec = ctx.getItem?.(piece.id);
  if (!rec || rec.itemType !== 'EQUIP') return false;
  if (typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip')
    && !(rec.kind === 'consume_on_equip_or_delayed' && !rec.isGolden)) return false;
  const recipe = itemMergeRecipe(piece.id, ctx.getItem, itemMergeCount);
  if (!recipe) return false;
  if (recipe.count === 2 && targetPiece?.kind === 'chess' && targetPiece.items?.some((x) => x.id === piece.id)) return true;
  let have = 0;
  for (const e of ctx.pieces.values()) {
    const p = e.piece;
    if ((e.area === 'hand' || e.area === 'temp') && !e.equipped && p.uid !== uid && p.kind === 'item' && p.id === piece.id) have += 1;
  }
  return have + 1 >= recipe.count;
}

export function boardTargets(ctx, uid) {
  const legal = [];
  const illegal = [];
  if (!ctx?.pieces?.get(uid)) return { legal, illegal };
  for (let r = GEO.FIELD.r0; r <= GEO.FIELD.r1; r++) {
    for (let c = GEO.FIELD.c0; c <= GEO.FIELD.c1; c++) {
      const k = tileKey(r, c);
      if (!ctx.deploy.ranged.has(k) && !ctx.boardAt.has(k)) continue; // never-deployable scenery
      (canPlace(ctx, uid, { area: 'board', row: r, col: c }).ok ? legal : illegal).push([r, c]);
    }
  }
  return { legal, illegal };
}

export function dropIntent(ctx, uid, target) {
  const res = canPlace(ctx, uid, target);
  if (!res.ok) return null;
  if (res.action === 'art') return { t: 'g.art', fields: { itemUid: uid, row: target.row, col: target.col } };
  if (res.action === 'equip') {
    const occ = target.area === 'hand' ? ctx.handAt.get(target.idx) : ctx.boardAt.get(tileKey(target.row, target.col));
    // both slots used: the replace dialog picks the equipped item to destroy (g.equip replaceUid) — unless the item is
    // consumed on equip, or it completes an item merge (the server merges it instead of equipping: nothing replaced)
    const full = Array.isArray(occ?.piece?.items) && occ.piece.items.length >= 2
      && itemAttaches(ctx.getItem(ctx.pieces.get(uid)?.piece?.id)) && !equipMerges(ctx, uid, 2, occ.piece);
    return { t: 'g.equip', fields: { itemUid: uid, targetUid: occ.piece.uid }, confirmReplace: full };
  }
  const to = target.area === 'hand' ? { area: 'hand', idx: target.idx } : { area: 'board', row: target.row, col: target.col };
  return { t: 'g.move', fields: { uid, to } };
}

export function dropFailureReason(ctx, uid, tile) {
  if (!ctx?.editable || !ctx.pieces?.get(uid) || !isObj(tile)) return null;
  let target = null;
  if (tile.area === 'board') target = { area: 'board', row: tile.row, col: tile.col };
  else if (tile.area === 'hand') target = { area: 'hand', idx: Number.isInteger(tile.idx) ? tile.idx : tile.col };
  else if (tile.area === 'temp') return ctx.pieces.get(uid).area === 'temp' ? null : trA("临时整备区无法放入单位");
  else if (Number.isInteger(tile.row) && tile.row >= GEO.FIELD.r0 && tile.row <= GEO.FIELD.r1) return trA("无法部署在该位置");
  else return null;
  const res = canPlace(ctx, uid, target);
  if (res.ok || res.code === 'ALREADY') return null;
  return res.reason || trA("无法放置在该位置");
}
