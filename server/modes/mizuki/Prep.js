// Stronghold preparation semantics on RO2's own map coordinates. The shared
// PlayerState/board rules remain unchanged for every other mode.
import { isDir, offsetTile } from '../../sim/dir.js';
import { mizukiTerrainAllows } from '../../../shared/mizukiPlacement.js';
import { summonPlacementGrid } from '../../../shared/summonPlacement.js';
import { attackRangeGrid, deployWithinOwnerRange } from '../../../shared/loadoutRecord.js';
import { resolveOfficialFacility } from './OfficialStageMechanics.js';
import { mizukiActiveToolSpec, mizukiActiveToolSpecs } from './ActiveTools.js';

const HAND = 10, TEMP = 5;
const key = (r, c) => `${r},${c}`;
const free = (slots) => slots.findLastIndex((value) => value == null);
const fail = (error, detail) => ({ error, detail });
export const mizukiOperatorPiece = (unit) => ({ uid: unit.uid, id: unit.chessId, kind: 'chess',
  count: 1, ownerUid: null, items: structuredClone(unit.items || []), name: unit.name,
  position: unit.position, avatar: unit.avatar, operatorId: unit.operatorId });
const included = (player) => player.roster.filter((unit) => player.lineup.includes(unit.uid) && !unit.expedition);
const init = (player) => player.prep ||= { hand: Array(HAND).fill(null), temp: Array(TEMP).fill(null), board: [], tokens: [], tokenSeq: 0 };
const tokenUid = (player) => (player.seat + 1) * 1000000 + ++player.prep.tokenSeq;

// Visible native facilities exist before player deployment even though their
// simulation units are instantiated on battleStart. Hidden instances retain
// their original activation timing and do not reserve an early preparation tile.
export function mizukiPrepFacilityBlocks(level) {
  const blocked = new Set();
  for (const instance of [...(level?.predefines?.characterInsts || []), ...(level?.predefines?.tokenInsts || [])]) {
    if (instance.hidden) continue;
    const def = resolveOfficialFacility(instance);
    const mode = def.raw.originalTileModes?.[def.skill?.prefabId === 'sktok_wpnsts_2' ? 1 : 0];
    if (mode?.options?.buildableType === 0) blocked.add(key(instance.position.row, instance.position.col));
  }
  return blocked;
}

function tokenSpecs(player, source) {
  const out = new Map();
  for (const owner of included(player)) {
    if (!player.prep.board.some((piece) => piece.uid === owner.uid)) continue;
    const def = source.getChess(owner.chessId, { skillIndex: owner.skillIndex, moduleId: owner.moduleId });
    for (const entry of def?.tokens || []) {
      const id = typeof entry === 'string' ? entry : entry.tokenId ?? entry.id;
      const td = source.getToken(id, owner.chessId, def.loadout);
      if (!td || td.raw?.placeable !== true || (Array.isArray(td.sources)
        && !td.sources.some((value) => value === 'talent' || value === 'skill'))) continue;
      const variant = td.raw.variants?.[def.tokenOwner] || td.raw;
      out.set(`${owner.uid}:${id}`, { id, ownerUid: owner.uid, name: td.name || id, position: td.position,
        count: Math.max(1, Math.floor(td.count || 1), Math.floor(variant.stats?.deployLimit || td.raw.deployLimit || 1)), td, owner });
    }
  }
  for (const spec of mizukiActiveToolSpecs(player)) out.set('tool:' + spec.itemId,
    { id: spec.key, toolId: spec.itemId, ownerUid: null, name: spec.name, position: spec.position, count: spec.count });
  return out;
}

export function mizukiPrepLegal(player, piece, row, col, { source, grid, facilityBlocked, collectibles = [], placementDefinitions }) {
  if (!Number.isInteger(row) || !Number.isInteger(col) || !grid.inRect(row, col)) return false;
  if (facilityBlocked?.has(key(row, col))) return false;
  const tool = piece.toolId && mizukiActiveToolSpec(piece.toolId);
  const owner = piece.kind === 'token' && !tool ? player.roster.find((unit) => unit.uid === piece.ownerUid) : null;
  const operator = piece.kind === 'token' ? null : player.roster.find((unit) => unit.uid === piece.uid);
  let definitions = placementDefinitions?.get(piece.uid);
  if (!definitions) {
    const ownerDef = owner && source.getChess(owner.chessId, { skillIndex: owner.skillIndex, moduleId: owner.moduleId });
    const def = tool && tool.key === piece.id ? tool : owner ? source.getToken(piece.id, owner.chessId, ownerDef?.loadout)
      : operator && source.getChess(operator.chessId, { skillIndex: operator.skillIndex, moduleId: operator.moduleId });
    definitions = { ownerDef, def }; placementDefinitions?.set(piece.uid, definitions);
  }
  const { ownerDef, def } = definitions;
  if (!def) return false;
  const allGround = (def.position === 'MELEE' && collectibles.includes('rogue_2_relic_fight_43'))
    || (def.position === 'RANGED' && collectibles.includes('rogue_2_relic_fight_44'));
  if (!mizukiTerrainAllows(def, grid.tile(row, col), allGround) || grid.isObstacle(row, col)) return false;
  if (!owner) return true;
  const placement = player.prep.board.find((unit) => unit.uid === owner.uid);
  if (!placement) return false;
  const fixed = summonPlacementGrid(piece.id);
  const range = attackRangeGrid(ownerDef.raw || ownerDef) || [[0, 0]];
  const bound = fixed || (deployWithinOwnerRange(def.raw || def) ? range : null);
  if (bound && !bound.some(([dr, dc]) => {
    const [r, c] = offsetTile(placement.row, placement.col, dr, dc, placement.dir || 'RIGHT');
    return r === row && c === col;
  })) return false;
  if ((def.raw?.ownerRangeOutside === true || def.ownerRangeOutside === true) && range.some(([dr, dc]) => {
    const [r, c] = offsetTile(placement.row, placement.col, dr, dc, placement.dir || 'RIGHT');
    return r === row && c === col;
  })) return false;
  return true;
}

/** Canonical UID layout. Only current lineup operators enter the hand/board. */
export function syncMizukiPrep(player, context = {}) {
  const prep = init(player), ops = new Map(included(player).map((unit) => [unit.uid, mizukiOperatorPiece(unit)]));
  const occupied = context.occupied || new Set();
  const oldTokens = new Map((prep.tokens || []).map((piece) => [piece.uid, piece]));
  const oldBoard = prep.board || [];
  // Accept operators before summons: legality of a range-bound summon reads its
  // owner's accepted position, and removed token specs must never occupy a tile.
  const seen = new Set();
  prep.board = oldBoard.filter((place) => {
    const piece = ops.get(place.uid);
    if (!piece || (context.grid && !mizukiPrepLegal(player, piece, place.row, place.col, context))
      || seen.has(place.uid) || occupied.has(key(place.row, place.col))
      || (Number.isFinite(context.deployLimit) && seen.size >= context.deployLimit)) return false;
    seen.add(place.uid); occupied.add(key(place.row, place.col)); return true;
  }).map((place) => ({ uid: place.uid, row: place.row, col: place.col, dir: isDir(place.dir) ? place.dir : 'RIGHT' }));
  const specs = context.source ? tokenSpecs(player, context.source) : new Map();
  const tokens = [];
  for (const spec of specs.values()) {
    const prior = [...oldTokens.values()].filter((piece) => piece.ownerUid === spec.ownerUid && piece.id === spec.id);
    const placed = [];
    for (const place of oldBoard) {
      const piece = prior.find((value) => value.uid === place.uid);
      if (!piece || placed.length >= spec.count || seen.has(place.uid) || occupied.has(key(place.row, place.col))
        || (context.grid && !mizukiPrepLegal(player, piece, place.row, place.col, context))) continue;
      placed.push(place); seen.add(place.uid); occupied.add(key(place.row, place.col));
      prep.board.push({ uid: place.uid, row: place.row, col: place.col, dir: isDir(place.dir) ? place.dir : 'RIGHT' });
      tokens.push({ ...piece, count: 1 });
    }
    const left = spec.count - placed.length;
    if (left > 0) {
      const stack = prior.find((piece) => !placed.some((place) => place.uid === piece.uid));
      tokens.push({ uid: stack?.uid || tokenUid(player), kind: 'token', id: spec.id, ownerUid: spec.ownerUid, ...(spec.toolId ? { toolId: spec.toolId } : {}),
        count: left, name: spec.name, position: spec.position, items: [] });
    }
  }
  prep.tokens = tokens;
  const pieces = new Map([...ops, ...tokens.map((piece) => [piece.uid, piece])]);
  prep.board = prep.board.filter((place) => pieces.has(place.uid));
  const placed = new Set(prep.board.map((place) => place.uid));
  const used = new Set(placed);
  const clean = (slots, length) => Array.from({ length }, (_, i) => {
    const uid = slots?.[i]; if (!pieces.has(uid) || used.has(uid)) return null;
    used.add(uid); return uid;
  });
  prep.hand = clean(prep.hand, HAND); prep.temp = clean(prep.temp, TEMP);
  for (const uid of pieces.keys()) if (!used.has(uid)) {
    const h = free(prep.hand), t = free(prep.temp);
    if (h >= 0) prep.hand[h] = uid; else if (t >= 0) prep.temp[t] = uid;
    used.add(uid);
  }
  return { pieces, occupied };
}

export function mizukiPrepView(player, context = {}) {
  // One definition lookup per piece/view, instead of one per legal-map tile.
  // The cache never survives a view, so equipment, loadout, summon and board
  // mutations keep the same invalidation semantics as uncached placement.
  context = { ...context, placementDefinitions: new Map() };
  const { pieces } = syncMizukiPrep(player, context);
  const piece = (uid) => pieces.has(uid) ? structuredClone(pieces.get(uid)) : null;
  const hand = player.prep.hand.map(piece), temp = player.prep.temp.map(piece);
  const board = player.prep.board.map((place) => ({ ...piece(place.uid), ...place }));
  const supplies = [...pieces.values()].filter(value => value.toolId && !board.some(place => place.uid === value.uid)).map(value => structuredClone(value));
  const legalTiles = {};
  if (context.grid) for (const unit of [...hand, ...temp, ...board, ...supplies].filter(Boolean)) {
    const from = board.find((place) => place.uid === unit.uid), tiles = [];
    for (let row = context.grid.rect.r0; row <= context.grid.rect.r1; row++) for (let col = context.grid.rect.c0; col <= context.grid.rect.c1; col++) {
      if (!mizukiPrepLegal(player, unit, row, col, context) || context.otherOccupied?.has(key(row, col))) continue;
      const occupant = board.find((place) => place.row === row && place.col === col && place.uid !== unit.uid);
      if (unit.kind === 'token' && !from && occupant) continue;
      if (!from && unit.kind === 'chess' && occupant?.kind !== 'chess' && context.fieldDeployCount >= context.deployLimit) continue;
      if (from && occupant && !(unit.kind === 'chess' && occupant.ownerUid === unit.uid)
        && !mizukiPrepLegal(player, occupant, from.row, from.col, context)) continue;
      tiles.push([row, col]);
    }
    legalTiles[unit.uid] = tiles;
  }
  return { hand, bench: hand, temp, board, supplies, ...(context.grid ? { legalTiles } : {}),
    fieldId: player.fieldId, controlMode: 'automatic', shopDisabled: true,
    deployCount: player.prep.board.filter((place) => pieces.get(place.uid)?.kind === 'chess').length,
    deployCap: context.deployLimit ?? null };
}

export function mizukiPrepInput(player, context) {
  const view = mizukiPrepView(player, context);
  const placed = new Set(view.board.map(piece => piece.uid));
  return [...view.board, ...player.prep.tokens.filter(piece => piece.toolId && !placed.has(piece.uid))].map((piece) => piece.kind === 'token'
    ? { uid: piece.uid, kind: 'token', tokenId: piece.id, ownerUid: piece.ownerUid, row: piece.row, col: piece.col, dir: piece.dir, abs: true,
      ...(piece.toolId ? { toolId: piece.toolId, count: piece.row == null ? piece.count : 1 } : {}) }
    : { ...structuredClone(player.roster.find((unit) => unit.uid === piece.uid)), row: piece.row, col: piece.col, dir: piece.dir, abs: true,
      items: (piece.items || []).map((item) => typeof item === 'string' ? item : item.id) });
}

export function moveMizukiPrep(player, uid, to, direction, context) {
  const { pieces } = syncMizukiPrep(player, context), prep = player.prep;
  const piece = pieces.get(uid);
  if (!piece || !to || !['board', 'hand'].includes(to.area)) return fail('BAD_TARGET', '只能移动当前编队的干员或所属召唤物。');
  const fromBoard = prep.board.find((place) => place.uid === uid);
  const fromHand = prep.hand.indexOf(uid), fromTemp = prep.temp.indexOf(uid);
  const source = fromBoard ? { area: 'board', ...fromBoard } : fromHand >= 0 ? { area: 'hand', idx: fromHand }
    : fromTemp >= 0 ? { area: 'temp', idx: fromTemp } : { area: 'reserve' };
  if (!fromBoard && fromHand < 0 && fromTemp < 0 && !piece.toolId) return fail('BAD_TARGET', '该棋子当前不在备战区。');
  const dir = direction ?? to.dir ?? fromBoard?.dir ?? 'RIGHT';
  if (!isDir(dir)) return fail('BAD_TARGET', '朝向无效。');
  const snapshot = structuredClone(prep);
  const detach = (loc) => { if (loc.area === 'board') prep.board = prep.board.filter((place) => place.uid !== loc.uid);
    else if (loc.area !== 'reserve') prep[loc.area][loc.idx] = null; };
  const put = (loc, target) => { if (loc.area === 'board') prep.board.push({ uid: target.uid, row: loc.row, col: loc.col, dir: target.dir || loc.dir || 'RIGHT' });
    else prep[loc.area][loc.idx] = target.uid; };
  let occupant, destination;
  if (to.area === 'board') {
    if (!mizukiPrepLegal(player, piece, to.row, to.col, context)) return fail('BAD_TILE', '该棋子不能摆放在此格。');
    if (context.otherOccupied?.has(key(to.row, to.col))) return fail('BAD_TILE', '此格已由同场队友使用。');
    occupant = prep.board.find((place) => place.row === to.row && place.col === to.col);
    destination = { area: 'board', uid, row: to.row, col: to.col, dir };
    const existingOp = occupant && pieces.get(occupant.uid)?.kind === 'chess';
    if (!fromBoard && piece.kind === 'chess' && !existingOp && context.fieldDeployCount >= context.deployLimit) return fail('BOARD_FULL', '作战区人数已满。');
    if (occupant && occupant.uid !== uid && source.area === 'board'
      && !(piece.kind === 'chess' && pieces.get(occupant.uid)?.ownerUid === uid)
      && !mizukiPrepLegal(player, pieces.get(occupant.uid), source.row, source.col, context)) return fail('BAD_TILE', '被交换棋子无法放到原格。');
    if (piece.kind === 'token' && !fromBoard && occupant) return fail('BAD_TILE', '召唤物需要空格。');
  } else {
    const idx = to.idx ?? free(prep.hand);
    if (!Number.isInteger(idx) || idx < 0 || idx >= HAND) return fail('HAND_FULL', '整备区已满。');
    const occupantUid = prep.hand[idx]; occupant = occupantUid == null ? null : { uid: occupantUid };
    if (source.area === 'reserve' && occupant) return fail('HAND_FULL', '此整备格已有单位。');
    destination = { area: 'hand', idx };
    if (occupant && source.area === 'board'
      && !mizukiPrepLegal(player, pieces.get(occupant.uid), source.row, source.col, context)) return fail('BAD_TILE', '被交换棋子无法放到原格。');
  }
  if (occupant?.uid === uid) {
    if (fromBoard) fromBoard.dir = dir;
    syncMizukiPrep(player, context); return { ok: true };
  }
  if (piece.kind === 'token' && fromBoard && to.area === 'hand') {
    const stack = prep.tokens.find((token) => token.uid !== uid && token.ownerUid === piece.ownerUid && token.id === piece.id
      && !prep.board.some((place) => place.uid === token.uid) && prep.hand.includes(token.uid));
    if (!stack && occupant) return fail('HAND_FULL', '整备区已满。');
    detach({ area: 'board', uid });
    if (!stack) prep.hand[destination.idx] = uid;
    syncMizukiPrep(player, context); return { ok: true };
  }
  if (piece.kind === 'token' && piece.count > 1 && to.area === 'board' && !fromBoard) {
    piece.count--;
    const one = { ...piece, uid: tokenUid(player), count: 1 }; prep.tokens.push(one);
    prep.board.push({ ...destination, uid: one.uid });
  } else {
    detach({ ...source, uid });
    if (occupant) { detach(to.area === 'board' ? { area: 'board', uid: occupant.uid } : destination); put(source, { ...pieces.get(occupant.uid), dir: occupant.dir }); }
    put(destination, { ...piece, dir });
  }
  // Original Stronghold: moving an operator withdraws and resets its summons.
  const movedOwners = [piece, occupant && pieces.get(occupant.uid)].filter((unit) => unit?.kind === 'chess');
  for (const owner of movedOwners) prep.board = prep.board.filter((place) => !prep.tokens.some((token) => token.uid === place.uid && token.ownerUid === owner.uid));
  try { syncMizukiPrep(player, context); } catch (error) { player.prep = snapshot; throw error; }
  return { ok: true };
}

export function validMizukiPrep(prep, player) {
  if (prep == null) return true;
  if (!Array.isArray(prep.hand) || prep.hand.length !== HAND || !Array.isArray(prep.temp) || prep.temp.length !== TEMP
    || !Array.isArray(prep.board) || prep.board.length > 128 || !Array.isArray(prep.tokens) || prep.tokens.length > 128
    || prep.board.some((place) => !place || typeof place !== 'object' || Array.isArray(place))
    || prep.tokens.some((token) => !token || typeof token !== 'object' || Array.isArray(token))
    || !Number.isInteger(prep.tokenSeq) || prep.tokenSeq < 0 || prep.tokenSeq > 999999) return false;
  if (new Set(prep.tokens.map((token) => token.uid)).size !== prep.tokens.length) return false;
  const ids = new Set([...player.lineup, ...prep.tokens.map((token) => token.uid)]);
  const placed = new Set();
  for (const uid of [...prep.hand, ...prep.temp, ...prep.board.map((place) => place.uid)]) {
    if (uid == null) continue; if (!ids.has(uid) || placed.has(uid)) return false; placed.add(uid);
  }
  return prep.board.every((place) => Number.isInteger(place.row) && Number.isInteger(place.col) && isDir(place.dir))
    && prep.tokens.every((token) => token.kind === 'token' && typeof token.id === 'string'
      && Number.isInteger(token.uid) && token.uid > (player.seat + 1) * 1000000
      && token.uid <= (player.seat + 1) * 1000000 + prep.tokenSeq
      && (token.toolId ? token.ownerUid == null && mizukiActiveToolSpec(token.toolId)?.key === token.id
        && player.routeInventory?.[token.toolId] > 0 : player.lineup.includes(token.ownerUid))
      && Number.isInteger(token.count) && token.count > 0 && token.count <= 100
      && Array.isArray(token.items) && token.items.length === 0);
}
