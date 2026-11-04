// Personal Stronghold equipment in Mizuki. All catalog records, merge recipes,
// tier rolls and effect handlers are reused; transactions never touch old modes.
import { MIZUKI_PHASES as PHASE } from '../../../shared/mizuki-constants.js';
import { itemKey } from '../../match/gamedata.js';
import { SharedPool } from '../../match/pool.js';
import { getDefaultRegistry } from '../../match/effectsMeta.js';
import { pieceBonds } from '../../match/bondsMeta.js';
import { itemMergeRecipe } from '../../../shared/itemMerge.js';
import { validMizukiRosterProgression } from './RosterProgression.js';
import { mizukiEquipmentAvailable, mizukiEquipmentEffectAvailable, mizukiEquipmentPool } from './EquipmentPolicy.js';

const MAX_BAG = 4096, MAX_IDS = 4096;
const copy = (value) => structuredClone(value);
// A standard onMerge handler can grant another item and complete another merge.
// Share only this transient transaction trace across nested cloned drafts; no
// trace is serialized into the player's run checkpoint.
const synthesisTraces = new WeakMap();
function equipmentDraft(player) {
  const draft = copy(player);
  synthesisTraces.set(draft, synthesisTraces.get(player) || []);
  return draft;
}
const integer = (value, min = 0, max = 999999) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (error, detail) => ({ ok: false, error, detail });
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 256;
const outside = new Set([PHASE.PREP, PHASE.ROUTE, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP, PHASE.RECRUIT]);
const hooks = new Set(['onRoundStart', 'onPrepStart', 'onPrepEnd', 'onBattleResult', 'onSold', 'onGain', 'onBuy', 'onIncome', 'onMerge', 'onBattleStart']);
const idsValid = (ids) => ids === undefined || Array.isArray(ids) && ids.length <= MAX_IDS
  && ids.every(validId) && new Set(ids).size === ids.length;

function jsonData(value, depth = 0, count = { left: 65536 }) {
  if (--count.left < 0 || depth > 16) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => jsonData(entry, depth + 1, count));
  return plain(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(value).every((entry) => jsonData(entry, depth + 1, count));
}

export function validMizukiEquipmentState(player, { gd } = {}) {
  if (!player || !validMizukiRosterProgression(player, { itemExists: gd ? (id) => !!gd.item(id) : undefined })) return false;
  for (const key of ['equipmentSeq', 'equipmentBattlesCompleted', 'equipmentPendingFunds', 'equipmentOfferSeq']) {
    if (player[key] !== undefined && !integer(player[key])) return false;
  }
  for (const key of ['equipmentDeployCapMin', 'equipmentDeployCapBonus']) {
    if (player[key] !== undefined && !integer(player[key], 0, 12)) return false;
  }
  if (!idsValid(player.equipmentRequestIds) || !idsValid(player.equipmentBattleIds) || !idsValid(player.equipmentHookIds)) return false;
  if (player.equipmentBattleIds && player.equipmentBattleIds.length !== (player.equipmentBattlesCompleted || 0)) return false;
  if (player.equipmentEffects !== undefined && (!Array.isArray(player.equipmentEffects) || player.equipmentEffects.length > MAX_IDS
    || !jsonData(player.equipmentEffects) || player.equipmentEffects.some((ref) => !validId(ref?.id) || !/^effect:[A-Za-z0-9_.:#-]+$/.test(ref.key))
    || new Set(player.equipmentEffects.map((ref) => ref.id)).size !== player.equipmentEffects.length)) return false;
  if (player.equipmentOffers !== undefined && (!Array.isArray(player.equipmentOffers) || player.equipmentOffers.length > MAX_IDS
    || !jsonData(player.equipmentOffers) || new Set(player.equipmentOffers.map((offer) => offer?.id)).size !== player.equipmentOffers.length
    || player.equipmentOffers.some((offer) => !validId(offer?.id) || !['chess', 'item'].includes(offer.kind)
      || !Array.isArray(offer.choices) || !offer.choices.length || offer.choices.length > 32
      || offer.choices.some((id) => !validId(id)) || new Set(offer.choices).size !== offer.choices.length
      || !/^(item|band|garrison|bond|effect|global):[A-Za-z0-9_.:#-]+$/.test(offer.source) || !integer(offer.createdRound, 1)
      || offer.pick !== 1 || !plain(offer.grantOpts) || !jsonData(offer.grantOpts)))) return false;
  return true;
}

export function mizukiEquipmentDeployLimit(player, { gd, baseLimit = gd?.deployCap || 8 } = {}) {
  return Math.min(9, Math.max(1, Math.trunc(baseLimit) + (player.equipmentDeployCapBonus || 0), player.equipmentDeployCapMin || 0));
}

export function mizukiEquipmentRules({ gd } = {}) {
  return { version: 1, ownership: 'player', battlesPerDrop: 2, equipPerOperator: gd?.equipPerChess || 2, boardDeployLimitMax: 9,
    maxInventory: MAX_BAG, consumableTiming: 'immediate', projectionTiming: 'immediate',
    dropRule: '原卫戍分阶池按阶段抽取，每人完成两场战斗固定获得一件；联防包含在同一场内。',
    fundsRule: '原卫戍资金由模式经济接口换算为希望；不改变肉鸽源石锭。' };
}

export function mizukiEquipmentItemView(item, { gd } = {}) {
  const record = gd?.item(item?.id);
  return record ? { ...copy(item), name: record.name, description: record.desc || '', iconId: record.iconId || record.id,
    tier: record.tier, isGolden: !!record.isGolden, itemType: record.itemType, category: record.category,
    kind: 'item', effectKind: record.kind, consumable: !!record.kind?.startsWith('consume_on_equip'),
    disabled: !mizukiEquipmentAvailable(gd, item.id),
    disabledReason: mizukiEquipmentAvailable(gd, item.id) ? null : '此道具在水月肉鸽中禁用。',
    effects: copy(record.buffs || []), merge: itemMergeRecipe(item.id, (id) => gd.item(id), gd.itemMergeCount) } : null;
}

/** Same tier shares and eligible item lists used by the original item slot. */
export function rollMizukiEquipmentDrop({ gd, rng, stage = 1 } = {}) {
  if (!gd || typeof rng !== 'function' || !integer(stage, 1)) return null;
  const level = Math.min(gd.maxShopLevel || 6, stage);
  return new SharedPool(gd).rollItem(rng, level, mizukiEquipmentPool(gd));
}

function allItems(player) {
  return [...(player.equipmentInventory || []), ...player.roster.flatMap((unit) => unit.items || [])];
}
function usedUids(player) {
  return new Set([...allItems(player).map((item) => item.uid), ...player.roster.map((unit) => unit.uid),
    ...(player.prep?.tokens || []).map((token) => token.uid)]);
}
function takeItem(player, uid) {
  let index = (player.equipmentInventory || []).findIndex((item) => item.uid === uid);
  if (index >= 0) return player.equipmentInventory.splice(index, 1)[0];
  for (const holder of player.roster) {
    index = (holder.items || []).findIndex((item) => item.uid === uid);
    if (index >= 0) return holder.items.splice(index, 1)[0];
  }
  return null;
}
function cleanPrep(player, uid) {
  if (!player.prep) return;
  const removed = new Set([uid, ...(player.prep.tokens || []).filter((token) => token.ownerUid === uid).map((token) => token.uid)]);
  for (const area of ['hand', 'temp']) player.prep[area] = (player.prep[area] || []).map((id) => removed.has(id) ? null : id);
  player.prep.board = (player.prep.board || []).filter((place) => !removed.has(place.uid));
  player.prep.tokens = (player.prep.tokens || []).filter((token) => !removed.has(token.uid));
}
function normalize(player) {
  player.equipmentInventory ||= []; player.equipmentEffects ||= [];
  player.equipmentRequestIds ||= []; player.equipmentHookIds ||= [];
  player.metaCounters ||= {}; player.metaMessages ||= [];
}

function newEquipmentItem(player, id, allocateUid) {
  const uid = allocateUid?.(player);
  if (!integer(uid, 1, Number.MAX_SAFE_INTEGER) || usedUids(player).has(uid)) throw new Error('道具编号冲突。');
  return { uid, id, kind: 'item', meta: {} };
}

/** Use the standard recipe and create a fresh advanced instance in the bag.
 * Worn materials are eligible in this mode, including materials on reserves.
 * No unequip/onDestroy effect runs: the standard synthesis consumes copies. */
function mergeItems(player, { gd, allocateUid, onMerge }) {
  const trace = synthesisTraces.get(player) || [], begin = trace.length;
  synthesisTraces.set(player, trace);
  try {
  for (let guard = 0; guard < MAX_BAG; guard++) {
    let changed = false;
    for (const id of new Set(allItems(player).map((item) => item.id))) {
      if (!mizukiEquipmentAvailable(gd, id)) continue;
      const recipe = itemMergeRecipe(id, (key) => gd.item(key), gd.itemMergeCount);
      if (!recipe || !mizukiEquipmentAvailable(gd, recipe.upgradeId)) continue;
      const twins = allItems(player).filter((item) => item.id === id).sort((a, b) => a.uid - b.uid).slice(0, recipe.count);
      if (twins.length !== recipe.count) continue;
      if (player.equipmentInventory.length - twins.filter((item) => player.equipmentInventory.includes(item)).length + 1 > MAX_BAG) {
        // As in the original merge transaction, a result with nowhere to go
        // must leave every material in its original holder/inventory slot.
        continue;
      }
      const item = newEquipmentItem(player, recipe.upgradeId, allocateUid);
      for (const item of twins) takeItem(player, item.uid);
      player.equipmentInventory.push(item);
      const event = { kind: 'item', piece: copy(item), itemId: id, consumed: twins.map((value) => value.uid) };
      trace.push(event); onMerge?.(player, copy(event));
      changed = true; break;
    }
    if (!changed) {
      const events = trace.slice(begin).map(copy);
      return { merged: events.map((event) => copy(event.piece)), events };
    }
  }
  throw new Error('Equipment merge limit exceeded');
  } catch (error) {
    trace.length = begin;
    throw error;
  }
}

export function grantMizukiEquipment(player, itemId, options = {}) {
  const { gd, allocateUid } = options;
  if (gd?.item(itemId) && !mizukiEquipmentAvailable(gd, itemId)) return fail('BAD_TARGET', '此道具在水月肉鸽中禁用。');
  if (!gd?.item(itemId) || !validMizukiEquipmentState(player, { gd })) {
    return fail('BAD_TARGET', '道具记录或个人装备区无效。');
  }
  const draft = equipmentDraft(player); normalize(draft);
  let item, synthesis;
  try {
    item = newEquipmentItem(draft, itemId, allocateUid); draft.equipmentInventory.push(item);
    synthesis = mergeItems(draft, options);
    if (draft.equipmentInventory.length > MAX_BAG) return fail('HAND_FULL', '个人装备区已满，道具发放未完成。');
  } catch (error) { return fail('BAD_TARGET', error.message); }
  if (!validMizukiEquipmentState(draft, { gd })) return fail('BAD_TARGET', '装备发放校验失败。');
  // Return the live result, like Stronghold acquireItem, not the consumed input.
  for (const event of synthesis.events) if (event.consumed.includes(item.uid)) item = event.piece;
  Object.assign(player, draft); return { ok: true, item: copy(item), ...synthesis };
}

/** Idempotent personal battle accounting; caller invokes after final rescue settlement. */
export function grantMizukiBattleEquipment(player, options = {}) {
  const { battleId, stage = 1, gd, rng } = options;
  if (!gd?.item || !validId(battleId) || !validMizukiEquipmentState(player, { gd }) || player.alive === false || player.left) return fail('BAD_TARGET', '作战掉落归属无效。');
  if ((player.equipmentBattleIds || []).includes(battleId)) return { ok: true, repeated: true, battleCount: player.equipmentBattlesCompleted || 0, dropped: false };
  if ((player.equipmentBattleIds?.length || 0) >= MAX_IDS) return fail('BAD_TARGET', '本局作战记录已满。');
  const draft = equipmentDraft(player); normalize(draft);
  draft.equipmentBattlesCompleted = (draft.equipmentBattlesCompleted || 0) + 1;
  draft.equipmentBattleIds = [...(draft.equipmentBattleIds || []), battleId];
  const dropped = draft.equipmentBattlesCompleted % 2 === 0;
  let reward = null;
  if (dropped) {
    const itemId = rollMizukiEquipmentDrop({ gd, rng, stage });
    if (!itemId) return fail('BAD_TARGET', '原卫戍装备池为空，未跳过应得掉落。');
    reward = grantMizukiEquipment(draft, itemId, options);
    if (!reward.ok) return reward;
  }
  Object.assign(player, draft);
  return { ok: true, battleCount: draft.equipmentBattlesCompleted, dropped, ...(reward ? reward : {}) };
}

function pieceView(player, unit) {
  const place = player.prep?.board?.find((value) => value.uid === unit.uid);
  return { ...unit, id: unit.chessId || unit.operatorId || unit.id, kind: 'chess', golden: !!unit.promotion,
    area: place ? 'board' : 'hand', ...(place ? { row: place.row, col: place.col, dir: place.dir } : {}) };
}

/** Factory callbacks must bind mutations to `draft`, never the original player.
 * The module supplies actual personal inventory, effects and deployment writes;
 * the caller supplies its real recruitment, promotion, choice and teammate IO. */
function contextFor(draft, source, hook, options, writes) {
  const { gd, contextFactory, grantEconomicHope } = options;
  const supplied = contextFactory?.(source, draft, hook) || {};
  const pieces = () => draft.roster.map((unit) => pieceView(draft, unit));
  const find = (uid) => pieces().find((unit) => unit.uid === uid) || allItems(draft).find((item) => item.uid === uid) || null;
  const effective = (value) => value !== false && value !== null && value !== undefined && value !== 0 && value?.ok !== false;
  const changed = (value) => { if (effective(value)) writes.count++; return value; };
  const ctx = { ...supplied, gd, data: gd.raw, source, hook, playerId: draft.playerId, seat: draft.seat,
    board: () => pieces().filter((unit) => unit.area === 'board'), hand: () => pieces().filter((unit) => unit.area !== 'board'), temp: () => [],
    piece: find, chessRecord: (id) => gd.chess(id),
    pieceBonds: (uid, fallback) => { const unit = pieces().find((entry) => entry.uid === uid) || fallback; return unit ? pieceBonds(gd, unit) : []; },
    shopLevel: () => options.stage || supplied.shopLevel?.() || gd.maxShopLevel || 6,
    counter: (key) => draft.metaCounters[key] || 0,
    setCounter: (key, value) => { if (validId(key) && Number.isFinite(value)) draft.metaCounters[key] = value; return draft.metaCounters[key] || 0; },
    incCounter: (key, amount = 1) => { if (!validId(key) || !Number.isFinite(amount)) return 0; return draft.metaCounters[key] = (draft.metaCounters[key] || 0) + amount; },
    addFunds: (amount, reason = 'item') => {
      if (!(Number.isFinite(amount) && amount > 0)) return 0;
      if (typeof grantEconomicHope !== 'function') throw new Error('Equipment requires grantEconomicHope');
      return changed(grantEconomicHope(draft, Math.trunc(amount), { reason }));
    },
    addPendingFunds: (amount) => {
      if (!(Number.isFinite(amount) && amount > 0)) return 0;
      const n = Math.trunc(amount); draft.equipmentPendingFunds = (draft.equipmentPendingFunds || 0) + n; return changed(n);
    },
    setDeployCapAtLeast: (amount) => {
      if (!integer(amount, 1, 12)) return false;
      const before = draft.equipmentDeployCapMin || 0;
      draft.equipmentDeployCapMin = Math.max(before, amount);
      if (draft.equipmentDeployCapMin > before) writes.count++;
      return mizukiEquipmentDeployLimit(draft, { gd, baseLimit: options.baseLimit });
    },
    addDeployCap: (amount) => {
      if (!integer(amount, 1, 12) || (draft.equipmentDeployCapBonus || 0) + amount > 12) return false;
      draft.equipmentDeployCapBonus = (draft.equipmentDeployCapBonus || 0) + amount; return changed(amount);
    },
    addEffect: (ref) => {
      if (!mizukiEquipmentEffectAvailable(ref)) return null;
      if (!validId(ref?.id) || !/^effect:[A-Za-z0-9_.:#-]+$/.test(ref?.key) || !jsonData(ref)) return null;
      const existing = draft.equipmentEffects.find((value) => value.id === ref.id);
      if (!existing && draft.equipmentEffects.length >= MAX_IDS) return null;
      if (existing) Object.assign(existing, copy(ref)); else draft.equipmentEffects.push(copy(ref));
      return changed(existing || draft.equipmentEffects.at(-1));
    },
    removeEffect: (id) => {
      const index = draft.equipmentEffects.findIndex((ref) => ref.id === id); if (index < 0) return false;
      draft.equipmentEffects.splice(index, 1); return changed(true);
    },
    effects: () => copy(draft.equipmentEffects),
    reportError: (_label, error) => { throw error; },
    destroyPiece: (uid) => {
      if (takeItem(draft, uid)) return changed(true);
      const index = draft.roster.findIndex((unit) => unit.uid === uid); if (index < 0) return false;
      const unit = draft.roster[index];
      if (draft.equipmentInventory.length + (unit.items?.length || 0) > MAX_BAG) return false;
      draft.equipmentInventory.push(...(unit.items || [])); draft.roster.splice(index, 1);
      draft.lineup = (draft.lineup || []).filter((id) => id !== uid); cleanPrep(draft, uid); return changed(true);
    },
    grantItem: (id) => {
      const result = grantMizukiEquipment(draft, id, options); return result.ok ? changed(result.item) : null;
    },
    upgradeItem: (uid) => {
      const item = allItems(draft).find((value) => value.uid === uid), rec = gd.item(item?.id);
      const upgradeId = rec?.upgradeChessId || rec?.goldenId;
      if (!item || rec.isGolden || !mizukiEquipmentAvailable(gd, item.id) || !mizukiEquipmentAvailable(gd, upgradeId)) return false;
      item.id = upgradeId; return changed(true);
    },
    toast: (message) => { draft.metaMessages.push(String(message)); draft.metaMessages = draft.metaMessages.slice(-20); },
  };
  // These callbacks are real mode IO, instrumented so a failed target/empty
  // offer never eats a consumable merely because its old handler returned void.
  for (const key of ['grantChess', 'promote', 'transform', 'offerChess', 'offerItems', 'offerBountyChoice', 'addBounty', 'addLayers', 'setShopSlot']) {
    const fn = supplied[key];
    ctx[key] = (...args) => {
      if (typeof fn !== 'function') throw new Error('Equipment context missing ' + key);
      const value = fn(...args);
      if (effective(value)) { writes.methods ||= {}; writes.methods[key] = (writes.methods[key] || 0) + 1; }
      return changed(value);
    };
  }
  return ctx;
}

function callHandler(draft, item, holder, hook, event, options, writes) {
  if (!mizukiEquipmentAvailable(options.gd, item?.id)) return false;
  const registry = options.registry || getDefaultRegistry(), key = 'item:' + itemKey(item.id);
  const handler = registry.get(key), fn = handler?.[hook];
  if (typeof fn !== 'function') return false;
  const source = { kind: 'item', key, piece: item, holder, item: options.gd.item(item.id) };
  let ctx = contextFor(draft, source, hook, options, writes);
  // User requested every consume-on-equip effect immediately. Retain the real
  // original promotion handler by presenting this one mode's normal projection
  // with its existing immediate counterpart's buff, keeping its actual item UID.
  const record = options.gd.item(item.id);
  if (hook === 'onEquip' && record?.buffs?.some((buff) => buff.key === 'equip_round_start_upgrade_char')) {
    const original = ctx.gd;
    const override = Object.create(original);
    override.item = (id) => id === item.id ? { ...record, buffs: [{ key: 'use_equip_upgrade_char', bb: {}, bbStr: {} }] } : original.item(id);
    ctx = { ...ctx, gd: override };
  }
  if (hook === 'onEquip' && record?.buffs?.some((buff) => buff.key === 'use_equip_reward_char_chess')) {
    // Legacy drafts can still contain two copies aggregated on one entry.
    // New recruitment and restored saves expose both real pieces directly.
    const target = draft.roster.find((unit) => unit.uid === holder?.uid);
    if (target && !target.promotion && target.recruitCopies >= 2) {
      const hand = ctx.hand;
      ctx = { ...ctx, hand: () => [...hand(), pieceView(draft, target)] };
    }
  }
  fn.call(handler, ctx, event); return true;
}

/** Read-only intent validation. Applying always repeats this ownership check. */
export function planMizukiEquipment(player, intent = {}, options = {}) {
  const { gd, phase, actorId } = options;
  if (actorId !== undefined && actorId !== player?.playerId) return fail('BAD_TARGET', '只能使用自己的装备。');
  if (!outside.has(phase) || player?.alive === false || player?.left) return fail('WRONG_PHASE', '请在存活且非作战的整备阶段使用道具。');
  if (!validMizukiEquipmentState(player, { gd }) || !integer(intent.itemUid, 1, Number.MAX_SAFE_INTEGER)
    || !integer(intent.targetUid, 1, Number.MAX_SAFE_INTEGER)) return fail('BAD_TARGET', '装备或干员状态无效。');
  if (intent.requestId !== undefined && (!validId(intent.requestId) || (player.equipmentRequestIds || []).includes(intent.requestId)
    || (player.equipmentRequestIds?.length || 0) >= MAX_IDS)) return fail('BAD_TARGET', '操作编号无效或已处理。');
  const originalItem = player.equipmentInventory?.find((item) => item.uid === intent.itemUid);
  const originalHolder = player.roster.find((unit) => unit.uid === intent.targetUid);
  const record = gd?.item(originalItem?.id);
  if (!originalItem || !originalHolder || !record || record.itemType !== 'EQUIP') return fail('BAD_TARGET', '道具或目标不属于当前玩家。');
  if (!mizukiEquipmentAvailable(gd, originalItem.id)) return fail('BAD_TARGET', '此道具在水月肉鸽中禁用。');
  const consume = record.kind?.startsWith('consume_on_equip');
  const capacity = gd.equipPerChess || 2;
  if (intent.replaceUid != null && !(originalHolder.items || []).some((item) => item.uid === intent.replaceUid)) return fail('BAD_TARGET', '替换装备不在目标干员身上。');
  const recipe = itemMergeRecipe(originalItem.id, (id) => gd.item(id), gd.itemMergeCount);
  const merge = !!recipe && (!consume || record.kind === 'consume_on_equip_or_delayed')
    && allItems(player).filter((item) => item.id === originalItem.id).length >= recipe.count;
  if (!consume && !merge && (originalHolder.items?.length || 0) >= capacity && intent.replaceUid == null) return fail('HAND_FULL', '装备槽已满，请选择要替换的装备。');
  return { ok: true, itemUid: intent.itemUid, targetUid: intent.targetUid, itemId: originalItem.id,
    consumable: !!consume, merge, capacity, replaceUid: intent.replaceUid ?? null, requestId: intent.requestId ?? null };
}

export const mizukiEquipmentEligibility = planMizukiEquipment;

/** One synchronous atomic transaction over cloned personal state. */
export function equipMizukiEquipment(player, intent = {}, options = {}) {
  const plan = planMizukiEquipment(player, intent, options);
  if (!plan.ok) return plan;
  const { gd } = options, record = gd.item(plan.itemId), consume = plan.consumable;
  const draft = equipmentDraft(player); normalize(draft);
  if (plan.merge) {
    try {
      const synthesis = mergeItems(draft, options);
      if (!synthesis.events.some((event) => event.consumed.includes(intent.itemUid))) return fail('HAND_FULL', '合成结果无处存放，所有装备均已保留。');
      draft.ready = false;
      if (intent.requestId !== undefined) draft.equipmentRequestIds.push(intent.requestId);
      if (!validMizukiEquipmentState(draft, { gd })) return fail('BAD_TARGET', '装备合成状态校验失败。');
      Object.assign(player, draft); return { ok: true, consumed: false, itemUid: intent.itemUid, targetUid: intent.targetUid,
        ...synthesis, deployLimit: mizukiEquipmentDeployLimit(player, { gd, baseLimit: options.baseLimit }) };
    } catch (error) { return fail('BAD_TARGET', '装备未合成，原装备已保留：' + error.message); }
  }
  const holder = draft.roster.find((unit) => unit.uid === intent.targetUid), item = takeItem(draft, intent.itemUid);
  const writes = { count: 0 }, event = { item, target: pieceView(draft, holder), golden: !!record.isGolden, keep: false, error: null, consumed: !!consume };
  try {
    if (consume) {
      if (!callHandler(draft, item, event.target, 'onEquip', event, options, writes)) return fail('BAD_TARGET', '原道具效果处理器不存在。');
      if (event.error) return fail(event.error, event.detail || '道具无有效目标，未消耗。');
      if (event.keep) return fail('BAD_TARGET', '消耗道具未完成即时效果，未消耗。');
      if (!writes.count || event.consumed === false) return fail('BAD_TARGET', '道具无有效目标或收益，未消耗。');
      if (record.buffs?.some((buff) => buff.key === 'use_equip_recruit_new_char_and_give_char_to_player_most_bond')
        && !writes.methods?.offerChess) return fail('BAD_TARGET', '没有可供选择的替换干员，原干员和道具均已保留。');
    } else {
      holder.items ||= [];
      if (intent.replaceUid != null) {
        const removed = takeItem(draft, intent.replaceUid);
        callHandler(draft, removed, pieceView(draft, holder), 'onDestroy', { item: removed, holder: pieceView(draft, holder), reason: 'replace' }, options, writes);
      }
      holder.items.push(item);
      callHandler(draft, item, pieceView(draft, holder), 'onEquip', event, options, writes);
      if (event.error) return fail(event.error, event.detail);
    }
    const synthesis = mergeItems(draft, options);
    draft.ready = false;
    if (intent.requestId !== undefined) draft.equipmentRequestIds.push(intent.requestId);
    if (!validMizukiEquipmentState(draft, { gd })) return fail('BAD_TARGET', '道具效果状态校验失败，未消耗。');
    Object.assign(player, draft); return { ok: true, consumed: !!consume, itemUid: item.uid, targetUid: holder.uid, ...synthesis,
      deployLimit: mizukiEquipmentDeployLimit(player, { gd, baseLimit: options.baseLimit }) };
  } catch (error) { return fail('BAD_TARGET', '道具效果未完成，未消耗：' + error.message); }
}

/** Lifecycle uses original item/effect handlers and persistent personal state.
 * executionId is the caller's stable node/prep identity, preventing repeats. */
export function dispatchMizukiEquipmentMeta(player, options = {}) {
  const { gd, hook, executionId, event = {} } = options;
  if (!hooks.has(hook) || !validMizukiEquipmentState(player, { gd })) return fail('BAD_TARGET', '装备触发状态无效。');
  const id = executionId == null ? null : hook + ':' + executionId;
  if (id !== null && (!validId(id) || (player.equipmentHookIds || []).includes(id))) return { ok: true, repeated: true, dispatched: 0 };
  const draft = equipmentDraft(player); normalize(draft);
  if (id && draft.equipmentHookIds.length >= MAX_IDS) return fail('BAD_TARGET', '装备触发记录已满。');
  const registry = options.registry || getDefaultRegistry(), writes = { count: 0 };
  const snapshot = draft.roster.flatMap((unit) => (unit.items || []).map((item) => ({ uid: item.uid, holderUid: unit.uid })));
  const effects = draft.equipmentEffects.map((ref) => ref.id); let dispatched = 0;
  try {
    if (hook === 'onRoundStart' && draft.equipmentPendingFunds > 0 && draft.alive !== false && !draft.left) {
      contextFor(draft, null, hook, options, writes).addFunds(draft.equipmentPendingFunds, 'item:pending');
      draft.equipmentPendingFunds = 0;
    }
    for (const row of snapshot) {
      const holder = draft.roster.find((unit) => unit.uid === row.holderUid);
      const item = holder?.items?.find((value) => value.uid === row.uid);
      if (!holder || !item || draft.alive === false || draft.left) continue;
      if (callHandler(draft, item, pieceView(draft, holder), hook, event, options, writes)) dispatched++;
    }
    for (const refId of effects) {
      const ref = draft.equipmentEffects.find((value) => value.id === refId); if (!ref || !mizukiEquipmentEffectAvailable(ref)) continue;
      const handler = registry.get(ref.key);
      if ((draft.alive === false || draft.left) && !handler?.afterElimination) continue;
      if (typeof handler?.[hook] !== 'function') continue;
      const source = { kind: 'effect', key: ref.key, ref };
      handler[hook](contextFor(draft, source, hook, options, writes), event); dispatched++;
    }
    const synthesis = mergeItems(draft, options);
    if (id) draft.equipmentHookIds.push(id);
    if (!validMizukiEquipmentState(draft, { gd })) return fail('BAD_TARGET', '装备触发结果无效。');
    Object.assign(player, draft); return { ok: true, dispatched, ...synthesis };
  } catch (error) { return fail('BAD_TARGET', '装备触发未完成：' + error.message); }
}
