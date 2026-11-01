import test from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { SharedPool } from '../server/match/pool.js';
import { createRng } from '../server/sim/rng.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { validMizukiEquipmentState, mizukiEquipmentDeployLimit, mizukiEquipmentRules, mizukiEquipmentItemView,
  rollMizukiEquipmentDrop, grantMizukiEquipment, grantMizukiBattleEquipment, equipMizukiEquipment,
  dispatchMizukiEquipmentMeta, planMizukiEquipment } from '../server/modes/mizuki/Equipment.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const gd = new GameData(DATA, 'mode_mizuki');
const HAMMER = 'chess_item_1_01_e_a', SHIELD = 'chess_item_1_02_e_a', COIN = 'chess_item_1_03_e_a';
const operator = (uid = 10001, chessId = 'chess_char_1_02_a') => ({ uid, operatorId: gd.baseIdOf(chessId), chessId,
  promotion: gd.isGolden(chessId) ? 1 : 0, recruitCopies: 1, items: [] });
function player(seat = 0) {
  return { playerId: 'p' + seat, seat, alive: true, left: false, ready: true, hope: 6, gold: 17,
    roster: [operator((seat + 1) * 10000 + 1)], lineup: [(seat + 1) * 10000 + 1], equipmentInventory: [],
    equipmentSeq: 0, layers: {}, metaMessages: [], metaCounters: {} };
}
const allocateUid = (draft) => (draft.seat + 1) * 100000000 + ++draft.equipmentSeq;
function grant(player, id) {
  const result = grantMizukiEquipment(player, id, { gd, allocateUid }); assert.equal(result.ok, true, JSON.stringify(result));
  return result.item.uid;
}
function economic(draft, amount) {
  draft.economicCoinTotal = (draft.economicCoinTotal || 0) + amount;
  const coins = (draft.economicCoinRemainder || 0) + amount;
  draft.hope += Math.floor(coins / 5); draft.economicCoinRemainder = coins % 5; return amount;
}
function options(extra = {}) {
  return { gd, phase: PHASE.PREP, stage: 6, allocateUid, grantEconomicHope: economic,
    contextFactory: (source, draft) => ({ source, rng: createRng(123), round: 1, playerId: draft.playerId,
      bondActive: () => true, bond: (id) => ({ id, active: true }),
      addLayers: (id, amount) => { draft.layers[id] = (draft.layers[id] || 0) + amount; return amount; },
      promote: (uid) => {
        const target = draft.roster.find((unit) => unit.uid === uid);
        const golden = target && gd.goldenIdOf(target.chessId);
        if (!target || target.promotion || !golden) return false;
        target.chessId = golden; target.promotion = 1; target.recruitCopies = 3; return true;
      },
      rollChess: ({ tier, maxTier = 6, filter } = {}) => gd.visibleChess.find((id) => (!tier || gd.tierOf(id) === tier)
        && gd.tierOf(id) <= maxTier && (!filter || filter(id))) || null,
      grantChess: (id) => {
        if (!gd.chess(id)) return null;
        const unit = operator((draft.seat + 1) * 10000 + draft.roster.length + 1, id);
        draft.roster.push(unit); return { ...unit, id, kind: 'chess' };
      },
      offerChess: (ids) => { if (!ids.length) return false; draft.offers = [...(draft.offers || []), ids]; return true; },
      shopSlots: () => (draft.candidates || []).map((id) => ({ kind: 'chess', id, sold: false })),
      setShopSlot: (index, slot) => { if (!draft.candidates?.[index]) return false; if (slot === null) draft.candidates.splice(index, 1); return true; },
      teammates: () => [],
    }), ...extra };
}
function equip(player, uid, extra = {}, opts = options()) {
  return equipMizukiEquipment(player, { itemUid: uid, targetUid: player.roster[0]?.uid, ...extra }, opts);
}

test('equipment drop stage roll reuses the exact original pool and exposes the original item effects', () => {
  for (const stage of [1, 2, 4, 6]) {
    const a = createRng(19), b = createRng(19), pool = new SharedPool(gd);
    for (let i = 0; i < 100; i++) assert.equal(rollMizukiEquipmentDrop({ gd, rng: a, stage }), pool.rollItem(b, stage));
  }
  const low = createRng(21), high = createRng(21), highTiers = new Set();
  for (let i = 0; i < 1000; i++) {
    assert.equal(gd.item(rollMizukiEquipmentDrop({ gd, rng: low, stage: 1 })).tier, 1);
    highTiers.add(gd.item(rollMizukiEquipmentDrop({ gd, rng: high, stage: 6 })).tier);
  }
  assert.deepEqual([...highTiers].sort(), [1, 2, 3, 4, 5, 6]);
  const view = mizukiEquipmentItemView({ uid: 1, id: SHIELD, kind: 'item' }, { gd });
  assert.equal(view.iconId, gd.item(SHIELD).iconId); assert.deepEqual(view.effects, gd.item(SHIELD).buffs);
  assert.equal(mizukiEquipmentRules({ gd }).equipPerOperator, gd.equipPerChess);
});

test('each personal second completed battle drops once and duplicate settlements cannot increment progress', () => {
  const a = player(), b = player(1), opts = { gd, rng: createRng(31), stage: 1, allocateUid };
  assert.deepEqual(grantMizukiBattleEquipment(a, { ...opts, battleId: 'battle-1' }), { ok: true, battleCount: 1, dropped: false });
  assert.equal(grantMizukiBattleEquipment(a, { ...opts, battleId: 'battle-1' }).repeated, true);
  const drop = grantMizukiBattleEquipment(a, { ...opts, battleId: 'battle-2' });
  assert.equal(drop.dropped, true); assert.equal(a.equipmentInventory.length, 1);
  assert.equal(a.equipmentBattlesCompleted, 2); assert.equal(b.equipmentBattlesCompleted, undefined);
  assert.equal(drop.item.uid, 100000001); assert.equal(validMizukiEquipmentState(a, { gd }), true);
  const before = structuredClone(a); grantMizukiBattleEquipment(a, { ...opts, battleId: 'battle-2' }); assert.deepEqual(a, before);
  b.alive = false; assert.equal(grantMizukiBattleEquipment(b, { ...opts, battleId: 'battle-1' }).ok, false);
});

test('invalid UID allocation and exhausted inventory leave the entire drop transaction available for retry', () => {
  const p = player(), before = structuredClone(p);
  assert.equal(grantMizukiEquipment(p, HAMMER, { gd, allocateUid: () => p.roster[0].uid }).ok, false); assert.deepEqual(p, before);
  grantMizukiBattleEquipment(p, { gd, rng: createRng(1), battleId: 'one', stage: 1, allocateUid });
  const counted = structuredClone(p);
  assert.equal(grantMizukiBattleEquipment(p, { gd, rng: createRng(1), battleId: 'two', stage: 1, allocateUid: () => -1 }).ok, false);
  assert.deepEqual(p, counted); assert.equal(p.equipmentBattleIds.includes('two'), false);
});

test('passive equipment stays on its owner, uses original slot cap, and validates replacement and request ownership', () => {
  const p = player(), hammer = grant(p, HAMMER), shield = grant(p, SHIELD);
  assert.equal(equip(p, hammer, { requestId: 'equip-hammer' }).ok, true);
  assert.equal(equip(p, shield).ok, true); assert.equal(p.roster[0].items.length, gd.equipPerChess);
  const newItem = grant(p, 'chess_item_1_05_e_a'), full = structuredClone(p);
  assert.equal(equip(p, newItem).error, 'HAND_FULL'); assert.deepEqual(p, full);
  assert.equal(equip(p, newItem, { replaceUid: shield, requestId: 'equip-hammer' }).ok, false); assert.deepEqual(p, full);
  assert.equal(equip(p, newItem, { replaceUid: shield, requestId: 'replace-shield' }).ok, true);
  assert.equal(p.roster[0].items.some((item) => item.uid === shield), false);
  assert.equal(p.equipmentInventory.some((item) => item.uid === shield), false, 'original replacement destroys the displaced item');
  assert.equal(equip(p, hammer, {}, options({ actorId: 'p1' })).ok, false);
  const bag = grant(p, 'chess_item_2_01_e_a'), before = structuredClone(p);
  assert.equal(equip(p, bag, {}, options({ phase: PHASE.COMBAT })).ok, false); assert.deepEqual(p, before);
  assert.equal(equipMizukiEquipment(p, { itemUid: bag, targetUid: 20001 }, options()).ok, false);
});

test('original two-copy recipe merges an equipped twin and a bag item into the original golden record in the bag', () => {
  const p = player(), first = grant(p, HAMMER); assert.equal(equip(p, first).ok, true);
  const second = grantMizukiEquipment(p, HAMMER, { gd, allocateUid }); assert.equal(second.ok, true);
  assert.deepEqual(p.roster[0].items, []); assert.equal(p.equipmentInventory.length, 1);
  assert.equal(p.equipmentInventory[0].id, gd.item(HAMMER).goldenId);
  assert.notEqual(p.equipmentInventory[0].uid, first, 'standard synthesis creates a fresh instance');
  assert.equal(p.equipmentInventory[0].uid, second.item.uid); assert.equal(second.merged.length, 1);
});

test('original coin and savings consumables grant converted Stronghold funds without changing roguelike ingots', () => {
  const p = player(), coin = grant(p, COIN), initialGold = p.gold;
  const result = equip(p, coin, { requestId: 'coin' }); assert.equal(result.ok, true); assert.equal(result.consumed, true);
  assert.equal(p.economicCoinTotal, 1); assert.equal(p.economicCoinRemainder, 1); assert.equal(p.hope, 6); assert.equal(p.gold, initialGold);
  const savings = grant(p, 'chess_item_3_12_e_a'); assert.equal(equip(p, savings).ok, true);
  assert.ok(p.economicCoinTotal >= 2 && p.economicCoinTotal <= 7); assert.equal(p.gold, initialGold);
  const before = structuredClone(p); assert.equal(equip(p, coin, { requestId: 'coin' }).ok, false); assert.deepEqual(p, before);
});

test('identity card executes the original per-bond layer handler and no-bond target retains the consumable', () => {
  const p = player(), uid = grant(p, 'chess_item_1_04_e_a');
  assert.equal(equip(p, uid).ok, true);
  for (const bond of gd.chess(p.roster[0].chessId).bonds) assert.equal(p.layers[bond], 3);
  const noBondsGd = Object.create(gd); noBondsGd.chess = (id) => ({ ...gd.chess(id), bonds: [] });
  const another = grant(p, 'chess_item_1_04_e_a'), before = structuredClone(p);
  assert.equal(equip(p, another, {}, options({ gd: noBondsGd })).ok, false); assert.deepEqual(p, before);
});

test('deployment document changes the preparation limit immediately and an already satisfied cap does not eat another copy', () => {
  const p = player(), document = grant(p, 'chess_item_6_08_e_a');
  assert.equal(equip(p, document).ok, true); assert.equal(p.equipmentDeployCapMin, gd.item('chess_item_6_08_e_a').params.count);
  assert.equal(mizukiEquipmentDeployLimit(p, { gd, baseLimit: 6 }), 9);
  const another = grant(p, 'chess_item_6_08_e_a'), before = structuredClone(p);
  assert.equal(equip(p, another).ok, false); assert.deepEqual(p, before);
});

test('both original projection qualities promote immediately in this mode and preserve operator UID and equipped instances', () => {
  for (const id of ['chess_item_5_06_e_a', 'chess_item_5_06_e_b']) {
    const p = player(), hammer = grant(p, HAMMER); assert.equal(equip(p, hammer).ok, true);
    const uid = p.roster[0].uid, projection = grant(p, id); assert.equal(equip(p, projection).ok, true);
    assert.equal(p.roster[0].promotion, 1); assert.equal(p.roster[0].uid, uid);
    assert.deepEqual(p.roster[0].items, [{ uid: hammer, id: HAMMER, kind: 'item', meta: {} }]);
    const invalid = grant(p, id), before = structuredClone(p);
    assert.equal(equip(p, invalid).ok, false); assert.deepEqual(p, before);
  }
});

test('persistent and next-preparation dolls execute original effects once per preparation and keep ingots separate', () => {
  const p = player(), recurring = grant(p, 'chess_item_2_05_e_a'), delayed = grant(p, 'chess_item_2_07_e_a');
  assert.equal(equip(p, recurring).ok, true); assert.equal(equip(p, delayed).ok, true);
  assert.equal(p.equipmentEffects[0].key, 'effect:builtin_round_coin'); assert.equal(p.equipmentPendingFunds, 2);
  const prep = { ...options(), hook: 'onRoundStart', executionId: 'node-2' };
  assert.equal(dispatchMizukiEquipmentMeta(p, prep).ok, true); assert.equal(p.economicCoinTotal, 3);
  const before = structuredClone(p); assert.equal(dispatchMizukiEquipmentMeta(p, prep).repeated, true); assert.deepEqual(p, before);
  assert.equal(dispatchMizukiEquipmentMeta(p, { ...prep, executionId: 'node-3' }).ok, true); assert.equal(p.economicCoinTotal, 4);
  assert.equal(p.equipmentPendingFunds, 0); assert.equal(p.gold, 17);
});

test('original recruitment consumers use real candidate and choice callbacks while empty candidates preserve the item', () => {
  const p = player(), emergency = grant(p, 'chess_item_2_02_e_a'), empty = structuredClone(p);
  assert.equal(equip(p, emergency).ok, false); assert.deepEqual(p, empty);
  p.candidates = [gd.visibleChess[0]]; assert.equal(equip(p, emergency).ok, true);
  assert.equal(p.roster.length, 2); assert.deepEqual(p.candidates, []);
  const communicator = grant(p, 'chess_item_2_06_e_a'); assert.equal(equip(p, communicator).ok, true); assert.equal(p.roster.length, 3);
  const pager = grant(p, 'chess_item_4_01_e_a'); assert.equal(equip(p, pager).ok, true); assert.ok(p.offers[0].length > 0);
  assert.equal(new Set(p.offers[0]).size, p.offers[0].length);
});

test('beacon uses the original destructive replacement and returns all attached equipment before the free choice', () => {
  const p = player(), hammer = grant(p, HAMMER); assert.equal(equip(p, hammer).ok, true);
  const beacon = grant(p, 'chess_item_5_04_e_a'); assert.equal(equip(p, beacon).ok, true);
  assert.deepEqual(p.roster, []); assert.deepEqual(p.lineup, []);
  assert.equal(p.equipmentInventory[0].uid, hammer); assert.ok(p.offers[0].length > 0);
});

test('empty beacon replacement pool rolls its target destruction back and preserves the consumable', () => {
  const p = player(), beacon = grant(p, 'chess_item_5_04_e_a'), before = structuredClone(p);
  const opts = options(), base = opts.contextFactory;
  opts.contextFactory = (...args) => ({ ...base(...args), rollChess: () => null });
  assert.equal(equip(p, beacon, {}, opts).ok, false); assert.deepEqual(p, before);
});

test('mimic reads two-copy roster progress through the original third-copy handler', () => {
  const p = player(); p.roster[0].recruitCopies = 2;
  const mimic = grant(p, 'chess_item_5_05_e_a'), opts = options(), base = opts.contextFactory;
  let chosen;
  opts.contextFactory = (source, draft, hook) => ({ ...base(source, draft, hook),
    rollChess: () => { throw new Error('two copies must use the original third-copy path'); },
    grantChess: (id) => {
      chosen = id; draft.roster[0].recruitCopies = 3; draft.roster[0].promotion = 1;
      draft.roster[0].chessId = gd.goldenIdOf(id); return draft.roster[0];
    } });
  assert.equal(equip(p, mimic, {}, opts).ok, true); assert.equal(chosen, gd.baseIdOf(p.roster[0].operatorId));
  assert.equal(p.roster[0].promotion, 1);
});

test('read-only equipment plans do not consume items and restored offers require bounded distinct choices', () => {
  const p = player(), uid = grant(p, HAMMER), before = structuredClone(p);
  const plan = planMizukiEquipment(p, { itemUid: uid, targetUid: p.roster[0].uid, requestId: 'plan' }, options());
  assert.equal(plan.ok, true); assert.equal(plan.consumable, false); assert.deepEqual(p, before);
  p.equipmentOffers = [{ id: 'mzeo:0:1', kind: 'chess', choices: [gd.visibleChess[0]], source: 'item:test', createdRound: 1, pick: 1, grantOpts: {} }];
  assert.equal(validMizukiEquipmentState(p, { gd }), true);
  p.equipmentOffers[0].choices.push(gd.visibleChess[0]); assert.equal(validMizukiEquipmentState(p, { gd }), false);
});

test('consumable errors rollback all personal inventory roster economy and effects without swallowing the original item', () => {
  const p = player(), coin = grant(p, COIN), before = structuredClone(p);
  const faulty = options({ grantEconomicHope: (draft) => { draft.hope += 100; throw new Error('controlled failure'); } });
  assert.equal(equip(p, coin, {}, faulty).ok, false); assert.deepEqual(p, before);
  const corrupt = structuredClone(p); corrupt.equipmentInventory[0].uid = corrupt.roster[0].uid;
  assert.equal(validMizukiEquipmentState(corrupt, { gd }), false);
  const invalidEffects = structuredClone(p); invalidEffects.equipmentEffects = [{ id: 'x', key: 'effect:evil', params: { amount: Infinity } }];
  assert.equal(validMizukiEquipmentState(invalidEffects, { gd }), false);
});

test('original strategy item and operator offers retain only known source families', () => {
  for (const kind of ['chess', 'item']) for (const source of ['item', 'band', 'garrison', 'bond', 'effect', 'global']) {
    const p = player();
    p.equipmentOffers = [{ id: 'choice:1', kind, choices: [kind === 'chess' ? gd.visibleChess[0] : HAMMER],
      source: source + ':native.test_01', createdRound: 1, pick: 1, grantOpts: {} }];
    assert.equal(validMizukiEquipmentState(p, { gd }), true);
    p.equipmentOffers[0].source = 'unknown:native'; assert.equal(validMizukiEquipmentState(p, { gd }), false);
  }
});

test('original deferred effects receive buy income and preparation-start hooks exactly once', () => {
  const p = player(); p.equipmentEffects = [{ id: 'native:1', key: 'effect:native_test', params: {} }];
  const registry = { get: () => Object.fromEntries(['onBuy', 'onIncome', 'onPrepStart'].map((hook) =>
    [hook, (ctx) => ctx.incCounter(hook)])) };
  for (const hook of ['onBuy', 'onIncome', 'onPrepStart']) {
    const opts = { ...options({ registry }), hook, executionId: 'native:2' };
    assert.equal(dispatchMizukiEquipmentMeta(p, opts).ok, true);
    assert.equal(dispatchMizukiEquipmentMeta(p, opts).repeated, true);
    assert.equal(p.metaCounters[hook], 1);
  }
});

test('eliminated owners never receive pending funds while explicitly allowed delayed gifts still execute', () => {
  const p = player(); p.alive = false; p.equipmentPendingFunds = 4;
  p.equipmentEffects = [{ id: 'native:income', key: 'effect:round_coin', params: {} },
    { id: 'native:gift', key: 'effect:builtin_gift', params: {} }];
  const registry = { get: (key) => ({ afterElimination: key === 'effect:builtin_gift',
    onRoundStart: (ctx) => ctx.incCounter(key) }) };
  assert.equal(dispatchMizukiEquipmentMeta(p, { ...options({ registry }), hook: 'onRoundStart', executionId: 'eliminated:round2' }).ok, true);
  assert.equal(p.equipmentPendingFunds, 4); assert.equal(p.hope, 6); assert.equal(p.gold, 17);
  assert.equal(p.economicCoinTotal, undefined); assert.equal(p.metaCounters['effect:round_coin'], undefined);
  assert.equal(p.metaCounters['effect:builtin_gift'], 1);
});

test('mode-local equipment transactions never mutate the original item metadata or old-mode rule records', () => {
  const before = JSON.stringify(DATA.items), p = player(), uid = grant(p, 'chess_item_5_06_e_a');
  assert.equal(equip(p, uid).ok, true); assert.equal(JSON.stringify(DATA.items), before);
  assert.equal(gd.item('chess_item_5_06_e_a').buffs[0].key, 'equip_round_start_upgrade_char');
});
