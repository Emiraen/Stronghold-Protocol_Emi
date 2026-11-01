import test from 'node:test';
import assert from 'node:assert/strict';
import { createMizukiUiSfxController } from '../public/js/mizukiUiSfx.js';

const bank = name => 'mizuki:ui.ON_ROGUELIKE_' + name;
const state = () => ({ runKey: 'run-a', playerId: 'p1', phase: 'MIZUKI_ROUTE', online: true, enabled: true,
  model: { collectibles: [], dice: { count: 3 }, key: 0, exploration: { floor: { key: 'floor-1' } } },
  priv: { tickets: [], routeInventory: {}, routeConsumables: {}, gold: 0, hope: 0, life: 10, shield: 0,
    equipment: { inventory: [{ uid: 'gear-1', id: 'fixture-item' }], equipped: [] } } });
function fixture() {
  const played = [], controller = createMizukiUiSfxController({ audio: { sfx: name => played.push(name) } });
  return { played, controller };
}

test('Mizuki node SFX follow committed gains once and moving owned equipment never sounds like a drop', () => {
  const { controller, played } = fixture(), input = state();
  controller.update(input);
  assert.deepEqual(played, [], 'initial possessions are adopted silently');
  const moved = structuredClone(input);
  moved.priv.equipment.inventory = [];
  moved.priv.equipment.equipped = [{ uid: 'operator-1', items: [{ uid: 'gear-1', id: 'fixture-item' }] }];
  controller.update(moved);
  assert.deepEqual(played, []);
  const resource = structuredClone(moved); resource.priv.gold = 1;
  controller.update(resource); controller.update(structuredClone(resource));
  assert.deepEqual(played, [bank('ITEM')]);
  const collection = structuredClone(resource);
  collection.model.collectibles.push('fixture-collectible');
  collection.priv.tickets.push({ id: 'ticket-1', status: 'available' });
  collection.priv.gold = 2;
  controller.update(collection);
  assert.deepEqual(played, [bank('ITEM'), bank('COLLECTION')], 'one committed reward uses its most specific original sound');
  const ticket = structuredClone(collection); ticket.priv.tickets.push({ id: 'ticket-2', status: 'available' });
  controller.update(ticket);
  assert.deepEqual(played, [bank('ITEM'), bank('COLLECTION'), bank('MAGICCARD')]);
  const consumed = structuredClone(ticket); consumed.priv.gold = 0; consumed.priv.tickets = [];
  controller.update(consumed);
  assert.equal(played.length, 3, 'consumption does not sound like acquisition');
});

test('Mizuki reconnect, run changes and doctor changes adopt current possessions and dice checks silently', () => {
  const { controller, played } = fixture(), input = state();
  controller.update(input);
  controller.update({ ...input, online: false });
  const resumed = structuredClone(input);
  resumed.model.collectibles.push('existing-after-reconnect');
  resumed.model.sanCheck = { id: 'existing-roll', check: { sound: 'ON_ROGUELIKE_DICEGREAT', value: 6 } };
  resumed.priv.gold = 30;
  controller.update(resumed); controller.update(structuredClone(resumed));
  assert.deepEqual(played, []);
  const otherRun = structuredClone(resumed); otherRun.runKey = 'run-b'; otherRun.model.collectibles.push('old-in-new-run');
  controller.update(otherRun);
  const otherDoctor = structuredClone(otherRun); otherDoctor.playerId = 'p2'; otherDoctor.priv.gold = 90;
  controller.update(otherDoctor);
  assert.deepEqual(played, []);
  const gained = structuredClone(otherDoctor); gained.priv.gold++;
  controller.update(gained);
  assert.deepEqual(played, [bank('ITEM')]);
});

test('Mizuki dice SFX use the authoritative check bank and check id, without guessing from the rolled number', () => {
  const { controller, played } = fixture(), input = state();
  controller.update(input);
  const roll = structuredClone(input);
  roll.model.sanCheck = { id: 'roll-1', check: { sound: 'ON_ROGUELIKE_DICENORMAL', value: 6 } };
  controller.update(roll);
  controller.update(structuredClone(roll));
  const sameCheck = structuredClone(roll); sameCheck.model.sanCheck.check.sound = 'ui.ON_ROGUELIKE_DICEGREAT';
  controller.update(sameCheck);
  assert.deepEqual(played, [bank('DICENORMAL')]);
  const unrecognized = structuredClone(roll); unrecognized.model.sanCheck = { id: 'roll-2', check: { sound: 'unknown', value: 6 } };
  controller.update(unrecognized);
  assert.equal(played.length, 1);
  const next = structuredClone(roll); next.model.sanCheck = { id: 'roll-3', check: { sound: 'ui.ON_ROGUELIKE_DICEBAD', value: 6 } };
  controller.update(next);
  assert.deepEqual(played, [bank('DICENORMAL'), bank('DICEBAD')]);
});

test('Mizuki floor transition sounds once upon reaching the route and not when reconnecting to that floor', () => {
  const { controller, played } = fixture(), input = state();
  controller.update(input);
  const entering = structuredClone(input); entering.phase = 'MIZUKI_EVENT'; entering.model.exploration.floor.key = 'floor-2';
  controller.update(entering);
  assert.deepEqual(played, []);
  const route = { ...entering, phase: 'MIZUKI_ROUTE' };
  controller.update(route); controller.update(structuredClone(route));
  assert.deepEqual(played, [bank('CROSTAGE')]);
  controller.update({ ...route, online: false });
  const reconnected = structuredClone(route); reconnected.model.exploration.floor.key = 'floor-3';
  controller.update(reconnected); controller.update(structuredClone(reconnected));
  assert.deepEqual(played, [bank('CROSTAGE')]);
});

test('Mizuki battle resource ticks stay silent and successful node actions use their own original banks', () => {
  const { controller, played } = fixture(), input = state();
  controller.update(input);
  const prep = structuredClone(input); prep.phase = 'PREP'; prep.priv.gold = 5;
  controller.update(prep);
  const combat = structuredClone(prep); combat.phase = 'COMBAT'; combat.priv.gold = 9; combat.priv.hope = 2;
  controller.update(combat);
  controller.update({ ...combat, phase: 'MIZUKI_ROUTE' });
  assert.deepEqual(played, []);
  controller.success('bank', { action: 'deposit' });
  controller.success('bank', { action: 'withdraw' });
  controller.success('shopBattle');
  controller.success('recruit', { offerId: 'ticket:fixture' });
  controller.success('recruit', { offerId: 'normal:fixture' });
  assert.deepEqual(played, [bank('INVESTMENT'), bank('SHOPBATTLE'), bank('MAGICCARD')]);
  controller.update({ ...combat, enabled: false });
  controller.success('bank', { action: 'deposit' });
  assert.equal(played.length, 3);
});
