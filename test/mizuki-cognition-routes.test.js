import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMizukiDungeon } from '../server/modes/mizuki/RouteGeneration.js';
import { officialMizukiStageOptions } from '../server/modes/mizuki/official-stages.js';
import { createMizukiRouteShop, refreshMizukiRouteShop } from '../server/modes/mizuki/RouteShop.js';
import { createMizukiRouteEvent, planMizukiRouteEventChoice, rerollMizukiRouteWish } from '../server/modes/mizuki/RouteEvents.js';
import { mizukiCollectiblePool, drawMizukiCollectible } from '../server/modes/mizuki/Collectibles.js';
import { installMizukiActiveTools } from '../server/modes/mizuki/ActiveTools.js';
import { Battle } from '../server/sim/Battle.js';
import { readFileSync } from 'node:fs';
import { createMizukiDriftingCache, planMizukiDriftingCache, validMizukiRouteEvent } from '../server/modes/mizuki/RouteEvents.js';
import { mizukiBattleDriftingCacheDrop, MIZUKI_BATTLE_LOOT_POLICY } from '../server/modes/mizuki/BattleRewards.js';

const stages = officialMizukiStageOptions();
const locked = { exchangeUnlocked: false, expeditionUnlocked: false, portalUnlocked: false, duckBrickUnlocked: false,
  driftingCacheUnlocked: false, shopDiscount: null, wishRerollEnabled: false };
const unlocked = { ...locked, exchangeUnlocked: true, expeditionUnlocked: true, portalUnlocked: true, duckBrickUnlocked: true,
  driftingCacheUnlocked: true, shopDiscount: .4, wishRerollEnabled: true };

test('cognition route gates remove only locked categories and every generated node remains connected', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) for (const cognition of [locked, unlocked]) {
    const dungeon = generateMizukiDungeon({ seed, stageOptions: stages, cognition });
    for (const zone of Object.values(dungeon.zones)) {
      const key = node => (node.pos || node).x + ':' + (node.pos || node).y, nodes = new Map(zone.nodes.map(node => [key(node), node]));
      const first = Math.min(...zone.nodes.map(node => node.pos.x)), last = Math.max(...zone.nodes.map(node => node.pos.x));
      const reached = new Set(zone.nodes.filter(node => node.pos.x === first).map(key));
      for (const node of zone.nodes) {
        if (cognition === locked) assert.ok(!['SACRIFICE', 'EXPEDITION', 'PORTAL'].includes(node.type));
        else seen.add(node.type);
        if (node.pos.x !== last) assert.ok(node.next.length > 0);
        for (const link of node.next) { assert.ok(nodes.has(key(link))); assert.equal(link.x, node.pos.x + 1);
          if (reached.has(key(node))) reached.add(key(link)); }
      }
      assert.equal(reached.size, zone.nodes.length, 'all generated nodes must be reachable');
    }
  }
  for (const type of ['SACRIFICE', 'EXPEDITION', 'PORTAL']) assert.ok(seen.has(type));
  assert.deepEqual(generateMizukiDungeon({ seed: 17, stageOptions: stages }),
    generateMizukiDungeon({ seed: 17, stageOptions: stages, cognition: undefined }), 'old checkpoints retain existing generation');
});

test('native negotiation tiers charge 80/60/40 percent prices while locked cognition cannot discount', () => {
  const node = { id: 'cognition-shop', graphType: 'BATTLE_SHOP' };
  let affected = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const base = { seed, floor: 4, diceId: 'rogue_2_dice_41', dice: 30, gold: 100, collectibles: [] };
    const plain = refreshMizukiRouteShop(createMizukiRouteShop(node, { ...base, cognition: locked }), node, { ...base, cognition: locked });
    assert.equal(plain.ok, true); assert.ok(plain.shop.offers.every(offer => !offer.discount));
    for (const discount of [.8, .6, .4]) {
      const context = { ...base, cognition: { ...unlocked, shopDiscount: discount } };
      const actual = refreshMizukiRouteShop(createMizukiRouteShop(node, context), node, context);
      assert.equal(actual.roll, plain.roll);
      for (const offer of actual.shop.offers.filter(offer => offer.discount)) {
        assert.equal(offer.discount, discount);
        assert.equal(offer.price, Math.max(1, Math.floor(offer.originalPrice * offer.bankMarkup * discount))); affected++;
      }
    }
  }
  assert.ok(affected > 30, 'seeded real rolls must produce discounted purchasable stock');
});

test('Duck Lord gold brick unlock changes actual normal and explicit collectible draws', () => {
  const id = 'rogue_2_relic_grace_63';
  assert.equal(mizukiCollectiblePool({ cognition: locked }).includes(id), false);
  assert.equal(mizukiCollectiblePool({ cognition: unlocked }).includes(id), true);
  assert.equal(drawMizukiCollectible({ rng: () => 0, ids: [id], cognition: locked }), null);
  assert.equal(drawMizukiCollectible({ rng: () => 0, ids: [id], cognition: unlocked }), id);
  assert.equal(drawMizukiCollectible({ rng: () => 0, ids: [id] }), id, 'legacy undefined cognition is preserved');
});

test('wish roll one exposes a single paid reroll and recomputes actual awarded relics', () => {
  const node = { id: 'cognition-wish', graphType: 'WISH' };
  let rolled = null;
  for (let seed = 1; seed < 100; seed++) {
    const context = { seed, dice: 2, floor: 2, cognition: unlocked, players: [{ playerId: 'p0', roster: [] }], collectibles: [] };
    const event = createMizukiRouteEvent(node, context);
    const choiceId = event.choices[0].id, input = { ...context, event, choiceId };
    const plan = planMizukiRouteEventChoice(node, input);
    if (plan.roll === 1) { rolled = { input, plan }; break; }
  }
  assert.ok(rolled); assert.equal(rolled.plan.pendingWish.roll, 1); assert.deepEqual(rolled.plan.relics, []);
  assert.equal(rolled.plan.event, undefined); assert.equal(rolled.plan.complete, undefined);
  const { input } = rolled, result = rerollMizukiRouteWish(node, input);
  const saved = structuredClone(input.event); saved.state.pendingWish = { ...rolled.plan.pendingWish, votes: { p0: 'reroll' } };
  assert.equal(validMizukiRouteEvent(JSON.parse(JSON.stringify(saved)), node, input), true);
  const accepted = planMizukiRouteEventChoice(node, { ...input, event: saved, wishDecision: 'accept' });
  assert.equal(accepted.ok, true); assert.equal(accepted.roll, 1); assert.equal(accepted.pendingWish, undefined);
  assert.ok(accepted.relics.length >= 1);
  assert.equal(result.ok, true); assert.equal(result.diceCost, 1); assert.equal(result.pendingWish, null);
  assert.equal(result.wishRerolled, true); assert.ok(result.relics.length >= 1);
  const direct = planMizukiRouteEventChoice(node, { ...input, wishRerolled: true });
  assert.deepEqual(result.relics, direct.relics); assert.equal(result.roll, direct.roll);
  assert.equal(rerollMizukiRouteWish(node, { ...input, dice: 0 }).ok, false);
  assert.equal(rerollMizukiRouteWish(node, { ...input, cognition: locked }).ok, false);
  assert.equal(rerollMizukiRouteWish(node, { ...input, event: { ...input.event, state: { ...input.event.state, wishRerolled: true } } }).ok, false);
  assert.equal(planMizukiRouteEventChoice(node, { ...input, cognition: locked }).pendingWish, undefined);
});

test('strengthened tool squad can really deploy fifteen paid dice across both players and no sixteenth', () => {
  const official = JSON.parse(readFileSync(new URL('../data/mizuki/rogue2.json', import.meta.url)));
  const effect = official.rawTopic.relics.rogue_2_band_18.buffs.find(value => value.key === 'battle_dice_up');
  assert.equal(effect.blackboard.find(value => value.key === 'count').value, 15, 'native count is the total capacity, not a +15 modifier');
  const players = ['p0', 'p1'].map((playerId, seat) => ({ playerId, seat, units: [] }));
  const battle = new Battle({ seed: 1, stageId: 'act1autochess_m02', content: 'none', rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players });
  for (const player of battle.players) player.dp = 999;
  let stock = 20, used = 0;
  const tools = installMizukiActiveTools(battle, players, { id: 'rogue_2_dice_1', maxDiceUses: 15,
    canSpend: () => stock > 0 && used < 15, spend: () => { if (!stock || used >= 15) return false; stock--; used++; return true; } });
  for (let index = 0; index < 15; index++) {
    const seat = index % 2, playerId = 'p' + seat;
    assert.equal(tools.snapshot()[playerId][0].count, 15 - index);
    const result = tools.deploy(playerId, { uid: 900000000 + seat, row: 9, col: 3, dir: 'RIGHT' });
    assert.equal(result.ok, true, 'use ' + index);
    battle.time += 16; battle.emit('tick', { dt: 16 });
  }
  assert.equal(used, 15); assert.equal(stock, 5);
  assert.deepEqual(tools.snapshot(), { p0: [], p1: [] });
  assert.equal(tools.deploy('p0', { uid: 900000000, row: 9, col: 3, dir: 'RIGHT' }).ok, false);
});

test('drifting cache actually drops only after its cognition unlock with explicit cooperative probabilities', () => {
  for (const type of ['combat', 'elite', 'boss']) {
    const chance = MIZUKI_BATTLE_LOOT_POLICY.driftingCache[type];
    assert.equal(mizukiBattleDriftingCacheDrop({ node: { type }, cognition: locked, rng: () => 0 }), null);
    assert.deepEqual(mizukiBattleDriftingCacheDrop({ node: { type }, cognition: unlocked, rng: () => chance - .00001 }),
      { id: 'rogue_2_treasure', count: 1 });
    assert.equal(mizukiBattleDriftingCacheDrop({ node: { type }, cognition: unlocked, rng: () => chance }), null);
  }
});

test('restoring three spent dice displays twelve remaining and cannot deploy a thirteenth new die', () => {
  const players = ['p0', 'p1'].map((playerId, seat) => ({ playerId, seat, units: [] }));
  const battle = new Battle({ seed: 3, stageId: 'act1autochess_m02', content: 'none', rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players });
  for (const player of battle.players) player.dp = 999;
  let ledger = 3, balance = 30, spentNow = 0;
  const options = { id: 'rogue_2_dice_1', maxDiceUses: 15, usedDiceUses: ledger,
    canSpend: () => ledger < 15 && balance > 0,
    spend: () => { if (ledger >= 15 || balance < 1) return false; ledger++; balance--; spentNow++; return true; } };
  const tools = installMizukiActiveTools(battle, players, options);
  for (let index = 0; index < 12; index++) {
    for (const player of players) assert.equal(tools.snapshot()[player.playerId][0].count, 12 - index);
    const seat = index % 2;
    assert.equal(tools.deploy('p' + seat, { uid: 900000000 + seat, row: 9, col: 3, dir: 'RIGHT' }).ok, true);
    battle.time += 16; battle.emit('tick', { dt: 16 });
  }
  assert.equal(ledger, 15); assert.equal(spentNow, 12); assert.equal(balance, 18);
  assert.deepEqual(tools.snapshot(), { p0: [], p1: [] });
  const dp = battle.getPlayer('p0').dp;
  assert.equal(tools.deploy('p0', { uid: 900000000, row: 9, col: 3, dir: 'RIGHT' }).ok, false);
  assert.equal(battle.getPlayer('p0').dp, dp); assert.equal(balance, 18);
  const rebuilt = installMizukiActiveTools(battle, players, { ...options, usedDiceUses: ledger });
  assert.deepEqual(rebuilt.snapshot(), { p0: [], p1: [] });
  assert.equal(rebuilt.deploy('p1', { uid: 900000001, row: 9, col: 3, dir: 'RIGHT' }).ok, false);
});

test('drifting cache key and successful die grant saved contents, failed die pays two ingots and smashing grants nothing', () => {
  const contents = [mizukiCollectiblePool({ cognition: unlocked })[0]];
  const base = { id: 'cache-a', rng: () => 0, cognition: unlocked, key: 1, dice: 1, contents, collectibles: [] };
  const event = createMizukiDriftingCache(base);
  assert.equal(event.title, '漂流秘匣'); assert.equal(event.choices.length, 3);
  const key = planMizukiDriftingCache({ ...base, choiceId: 'rogue_2_treasure_use_key' });
  assert.equal(key.keyCost, 1); assert.equal(key.diceCost, 0); assert.deepEqual(key.relics, contents);
  for (const [diceId, faces] of [['rogue_2_dice_1', 6], ['rogue_2_dice_4', 8], ['rogue_2_dice_41', 12]]) {
    for (let roll = 1; roll <= faces; roll++) {
      const plan = planMizukiDriftingCache({ ...base, diceId, rng: () => (roll - .5) / faces, choiceId: 'rogue_2_treasure_use_dice' });
      assert.equal(plan.ok, true); assert.equal(plan.roll, roll); assert.equal(plan.diceCost, 1);
      assert.deepEqual(plan.relics, roll >= 5 ? contents : []);
      assert.deepEqual(plan.effects, roll >= 5 ? {} : { gold: 2 });
    }
  }
  const smashed = planMizukiDriftingCache({ ...base, choiceId: 'rogue_2_treasure_leave' });
  assert.deepEqual([smashed.relics, smashed.items, smashed.effects, smashed.diceCost, smashed.keyCost], [[], [], {}, 0, 0]);
  for (const context of [{ key: 0 }, { opened: true }, { cognition: locked }])
    assert.equal(planMizukiDriftingCache({ ...base, ...context, choiceId: 'rogue_2_treasure_use_key' }).ok, false);
  assert.equal(planMizukiDriftingCache({ ...base, dice: 0, choiceId: 'rogue_2_treasure_use_dice' }).ok, false);
});
