// Mizuki-only persistent roster transactions. Match owns socket authorization,
// phase transitions, field rebuilding and checkpoint versioning.
import { MIZUKI_PHASES as PHASE } from '../../../shared/mizuki-constants.js';

const MAX_INVENTORY = 4096, MAX_ITEMS = 8192, MAX_REQUESTS = 4096;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const int = (value) => Number.isSafeInteger(value) && value > 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (error, detail) => ({ ok: false, error, detail });
const copy = (value) => structuredClone(value);

// Equipment is checkpoint data, never a runtime object or a bare item ID.
function jsonData(value, budget = { left: 16384 }, depth = 0) {
  if (--budget.left < 0 || depth > 16) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => jsonData(entry, budget, depth + 1));
  return plain(value) && Object.values(value).every((entry) => jsonData(entry, budget, depth + 1));
}

function itemValid(item, itemExists) {
  return plain(item) && int(item.uid) && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256
    && (item.kind === undefined || item.kind === 'item') && jsonData(item)
    && (!itemExists || itemExists(item.id) === true);
}

/** Explicit out-of-combat phases only; the first pre-battle preparation is excluded. */
export function canDismissMizukiOperator({ phase, completedNodes = 0 } = {}) {
  if (phase === PHASE.PREP) return Number.isInteger(completedNodes) && completedNodes > 0;
  return [PHASE.ROUTE, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP, PHASE.RECRUIT].includes(phase);
}

/** Pure replacement: recruitment promotion retains the owned UID and item instances. */
export function preserveMizukiEquipment(previous, next) {
  if (!plain(next) || !int(next.uid) || (previous && (!plain(previous) || !int(previous.uid)
    || previous.operatorId !== next.operatorId))) throw new TypeError('Invalid Mizuki roster replacement');
  const items = previous ? previous.items ?? [] : next.items ?? [];
  if (!Array.isArray(items) || items.some((item) => !itemValid(item))
    || new Set(items.map((item) => item.uid)).size !== items.length) throw new TypeError('Invalid Mizuki equipment instances');
  return { ...next, uid: previous?.uid ?? next.uid, items: copy(items) };
}

/**
 * Validate persistent equipment and request IDs before restoring a checkpoint.
 * Missing fields mean an older equipment-free save. Present arrays are strict.
 * Pass one seenItemUids set for all players, and a reservedUids set containing
 * every player's operator/token UID, to reject cross-player duplicate ownership.
 * Caller sets are extended only after the complete player validates.
 */
export function validMizukiRosterProgression(player, { itemExists, seenItemUids, reservedUids } = {}) {
  if (!plain(player) || !Array.isArray(player.roster) || player.roster.length > 1024
    || (own(player, 'equipmentInventory') && !Array.isArray(player.equipmentInventory))
    || (player.equipmentInventory?.length || 0) > MAX_INVENTORY
    || (player.prep != null && (!plain(player.prep) || !Array.isArray(player.prep.tokens)))
    || (own(player, 'rosterRequestIds') && (!Array.isArray(player.rosterRequestIds) || player.rosterRequestIds.length > MAX_REQUESTS
      || player.rosterRequestIds.some((id) => typeof id !== 'string' || !id.length || id.length > 128)
      || new Set(player.rosterRequestIds).size !== player.rosterRequestIds.length))) return false;
  const reserved = new Set(reservedUids || []), local = new Set();
  for (const unit of player.roster) {
    if (!plain(unit) || !int(unit.uid)) return false;
    // Duplicate piece UIDs are also rejected, without treating the caller's
    // deliberately reserved operator UID as an item collision.
    if (local.has(unit.uid)) return false;
    local.add(unit.uid); reserved.add(unit.uid);
  }
  for (const token of player.prep?.tokens || []) {
    if (!plain(token) || !int(token.uid)) return false;
    reserved.add(token.uid);
  }
  const items = [...(player.equipmentInventory || [])];
  for (const unit of player.roster) {
    if (own(unit, 'items') && (!Array.isArray(unit.items) || unit.items.length > MAX_INVENTORY)) return false;
    items.push(...(unit.items || []));
    if (items.length > MAX_ITEMS) return false;
  }
  const itemUids = new Set();
  for (const item of items) {
    if (!itemValid(item, itemExists) || reserved.has(item.uid) || itemUids.has(item.uid) || seenItemUids?.has(item.uid)) return false;
    itemUids.add(item.uid);
  }
  for (const uid of itemUids) seenItemUids?.add(uid);
  return true;
}

/** Public view omits the unassigned bag; private callers explicitly request it. */
export function mizukiEquipmentView(player, { includeInventory = false } = {}) {
  const view = { equipped: player.roster.map((unit) => ({ uid: unit.uid, items: copy(unit.items || []) })) };
  if (includeInventory) view.inventory = copy(player.equipmentInventory || []);
  return view;
}

function removedPrep(prep, uid) {
  if (prep == null) return prep;
  if (!plain(prep) || !['hand', 'temp', 'board', 'tokens'].every((key) => Array.isArray(prep[key]))
    || [...prep.hand, ...prep.temp].some((id) => id !== null && !int(id))
    || prep.board.some((place) => !plain(place) || !int(place.uid))) return null;
  const removed = new Set([uid, ...prep.tokens.filter((token) => token?.ownerUid === uid).map((token) => token.uid)]);
  try {
    return { ...copy(prep),
      hand: prep.hand.map((id) => removed.has(id) ? null : id),
      temp: prep.temp.map((id) => removed.has(id) ? null : id),
      board: prep.board.filter((place) => !removed.has(place.uid)).map(copy),
      tokens: prep.tokens.filter((token) => !removed.has(token.uid) && token.ownerUid !== uid).map(copy) };
  } catch { return null; }
}

/**
 * Atomic in-place dismissal. Match must supply its authenticated player object
 * and gate with canDismissMizukiOperator; phase/actorId also permit defence in depth.
 * Original Stronghold sell returns attached item instances before removal. Here
 * the returned items enter equipmentInventory, with no item-destroying overflow.
 */
export function dismissMizukiOperator(player, uid, { hopeRefund = 1, phase, completedNodes = 0, actorId, requestId } = {}) {
  if (actorId !== undefined && actorId !== player?.playerId) return fail('BAD_TARGET', '只能遣散自己的干员。');
  if (phase !== undefined && !canDismissMizukiOperator({ phase, completedNodes })) return fail('BAD_PHASE', '当前阶段不能遣散干员。');
  if (!int(uid) || !validMizukiRosterProgression(player) || !Array.isArray(player.lineup)
    || !Number.isSafeInteger(player.hope) || player.hope < 0 || !Number.isSafeInteger(hopeRefund) || hopeRefund < 0
    || player.hope + hopeRefund > 9999
    || !Number.isSafeInteger(player.hope + hopeRefund)
    || new Set(player.lineup).size !== player.lineup.length
    || player.lineup.some((id) => !player.roster.some((unit) => unit.uid === id))) return fail('BAD_TARGET', '干员或装备状态无效。');
  if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.length || requestId.length > 128)) {
    return fail('BAD_TARGET', '操作编号无效。');
  }
  if (requestId !== undefined && (player.rosterRequestIds || []).includes(requestId)) return fail('BAD_TARGET', '该操作已经处理。');
  if (requestId !== undefined && (player.rosterRequestIds?.length || 0) >= MAX_REQUESTS) return fail('BAD_TARGET', '本局操作记录已满。');
  const unit = player.roster.find((entry) => entry.uid === uid);
  if (!unit) return fail('BAD_TARGET', '该干员不属于当前玩家或已被遣散。');
  const items = copy(unit.items || []);
  if ((player.equipmentInventory?.length || 0) + items.length > MAX_INVENTORY) return fail('HAND_FULL', '装备区已满，干员及装备均已保留。');
  const prep = removedPrep(player.prep, uid);
  if (player.prep != null && prep === null) return fail('BAD_TARGET', '整备状态无效。');
  const draft = { ...player, roster: player.roster.filter((entry) => entry.uid !== uid),
    lineup: player.lineup.filter((id) => id !== uid), equipmentInventory: [...(player.equipmentInventory || []), ...items],
    hope: player.hope + hopeRefund, ready: false,
    ...(player.prep == null ? {} : { prep }),
    ...(requestId === undefined ? {} : { rosterRequestIds: [...(player.rosterRequestIds || []), requestId] }) };
  if (!validMizukiRosterProgression(draft)) return fail('BAD_TARGET', '装备归还校验失败，未作更改。');
  // Every allocation/validation has completed. Commit only the transaction fields.
  for (const key of ['roster', 'lineup', 'equipmentInventory', 'hope', 'ready']) player[key] = draft[key];
  if (player.prep != null) player.prep = prep;
  if (requestId !== undefined) player.rosterRequestIds = draft.rosterRequestIds;
  return { ok: true, returnedItems: copy(items), dismissedUid: uid, hopeRefund };
}
