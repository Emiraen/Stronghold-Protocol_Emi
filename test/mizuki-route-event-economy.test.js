import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { createMizukiRouteEvent, planMizukiRouteEventChoice } from '../server/modes/mizuki/RouteEvents.js';
import { acceptMizukiRouteMission } from '../server/modes/mizuki/RouteMissions.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const OFFICIAL = JSON.parse(readFileSync(new URL('../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const SOURCE = JSON.parse(readFileSync(new URL('../data/mizuki/route-event-source.json', import.meta.url), 'utf8'));

function fixture(t, count = 2, { started = true } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ roomCode: 'MZEV', seed: 812, data: DATA, scheduler,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    dungeon: { zones: [{ id: 'zone_1', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] }] },
    send() {}, broadcast() {}, onEnd() {} });
  match.started = started;
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return match;
}

function openEvent(match, eventNumber, graphType = 'ENTERTAINMENT') {
  match.currentNode = { id: 'event-' + eventNumber, type: 'event', graphType };
  match.phase = PHASE.EVENT;
  const state = { eventKey: 'prts_ro2_event_' + eventNumber, sceneIndex: 0, revision: 0, history: [], restUsed: [] };
  match.event = { ...createMizukiRouteEvent(match.currentNode, { ...match._routeEventContext(), event: { state } }), votes: {} };
  return match.event;
}

function choose(match, choiceId) {
  for (const player of match._actors()) {
    assert.deepEqual(match.handle(player.playerId, { t: 'g.mizuki.event', choiceId }), { ok: true });
  }
}

test('exchange event spends hope and equal hope capacity before granting max-life rewards to every player', (t) => {
  const match = fixture(t), first = match.players.get('p0'), second = match.players.get('p1');
  for (const player of [first, second]) {
    player.hope = 4; player.hopeCapacity = 8; player.maxLife = 12;
  }
  first.life = 12; second.life = 10;
  const event = openEvent(match, 18);
  const choice = event.choices.find(value => value.id === 'choice_ro2_exchange_4');
  assert.equal(choice?.available, true);
  const plan = planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: choice.id });
  assert.equal(plan.ok, true);
  assert.equal(plan.effects.hope, -4);
  assert.equal(plan.effects.hopeCapacity, -4);
  assert.equal(plan.effects.lifeMax, 3);
  choose(match, choice.id);
  for (const player of [first, second]) {
    assert.equal(player.hope, 0);
    assert.equal(player.hopeCapacity, 4);
    assert.equal(player.maxLife, 15);
  }
  assert.equal(first.life, 15);
  assert.equal(second.life, 13);
  assert.equal(match.dice, 5);
  assert.equal(match.phase, PHASE.EVENT);
  assert.equal(match.event.state.sceneIndex, 4);
});

test('a hope-capacity exchange remains available at one max life and may exhaust hope capacity to zero', (t) => {
  const match = fixture(t, 1), player = match.players.get('p0');
  player.hope = 4; player.hopeCapacity = 4; player.maxLife = 1; player.life = 1;
  const event = openEvent(match, 18);
  const choice = event.choices.find(value => value.id === 'choice_ro2_exchange_5');
  assert.equal(choice?.available, true);
  const plan = planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: choice.id });
  assert.equal(plan.ok, true);
  choose(match, choice.id);
  assert.equal(player.hope, 0);
  assert.equal(player.hopeCapacity, 0);
  assert.equal(player.life, 1);
  assert.equal(player.maxLife, 1);
  assert.equal(match.dice, 7);
});

const capacityChoices = SOURCE.events.flatMap(event => event.scenes.flatMap((scene, sceneIndex) => scene.choices
  .filter(choice => /希望及等量上限/.test(choice.description || ''))
  .map(choice => ({ event, sceneIndex, choice }))));
assert.equal(capacityChoices.length, 7, 'every original route choice with a hope-capacity cost is covered');
for (const { event: sourceEvent, sceneIndex, choice: sourceChoice } of capacityChoices) {
  test(sourceChoice.id + ' parses and charges the original hope-capacity cost without consuming max life', t => {
    const match = fixture(t, 1), player = match.players.get('p0');
    match.endingUnlocks = ['ro2_ending_1', 'ro2_ending_2'];
    player.hope = 8;player.hopeCapacity = 10;player.life = 1;player.maxLife = 1;
    const choiceId = sourceChoice.rawId || sourceChoice.id;
    const original = OFFICIAL.rawTopic.choices[choiceId].description.replace(/<[^>]*>/g, '');
    assert.equal(sourceChoice.description.startsWith(original.split('，')[0]), true);
    const cost = Number(/消耗(\d+)希望及等量上限/.exec(original)[1]);
    const number = Number(sourceEvent.id.split('_').at(-1));
    const node = { id: 'capacity:' + choiceId, type: 'event', graphType: number === 40 ? 'INCIDENT' : 'ENTERTAINMENT' };
    const history = sceneIndex ? ['choice_ro2_exchange_' + sceneIndex] : [];
    const state = { eventKey: sourceEvent.id, sceneIndex, revision: history.length, history, restUsed: [], dreamChoices: [choiceId] };
    match.currentNode = node;match.phase = PHASE.EVENT;
    match.event = { ...createMizukiRouteEvent(node, { ...match._routeEventContext(), event: { state } }), votes: {} };
    assert.equal(match.event.choices.find(choice => choice.id === choiceId)?.available, true);
    const plan = planMizukiRouteEventChoice(node, { ...match._routeEventContext(), choiceId });
    assert.equal(plan.ok, true);assert.equal(plan.effects.hope, -cost);assert.equal(plan.effects.hopeCapacity, -cost);
    assert.equal(plan.effects.lifeMax || 0, /获得3目标生命上限/.test(original) ? 3 : 0);
    choose(match, choiceId);
    assert.equal(player.hope, 8 - cost);assert.equal(player.hopeCapacity, 10 - cost);
    assert.equal(player.maxLife, 1 + (plan.effects.lifeMax || 0));
    assert.equal(player.life, player.maxLife);assert.equal(player.alive, true);
  });
}

test('an unaffordable current hope-capacity trade rejects the entire party transaction', t => {
  const match = fixture(t), [first, second] = match.order;
  for (const player of match.order) Object.assign(player, { hope: 4, hopeCapacity: 8, life: 1, maxLife: 1 });
  const event = openEvent(match, 18), choiceId = 'choice_ro2_exchange_4';
  assert.equal(event.choices.find(choice => choice.id === choiceId)?.available, true);
  assert.deepEqual(match.handle(first.playerId, { t: 'g.mizuki.event', choiceId }), { ok: true });
  second.hope = 3;
  const before = structuredClone({ players: match.order, dice: match.dice, key: match.key, light: match.light, collectibles: match.collectibles });
  assert.equal(match.handle(second.playerId, { t: 'g.mizuki.event', choiceId }).error, 'BAD_TARGET');
  assert.deepEqual({ players: match.order, dice: match.dice, key: match.key, light: match.light, collectibles: match.collectibles }, before);
  assert.equal(match.privateView(second.playerId).mizuki.event.choices.find(choice => choice.id === choiceId)?.available, false);
  assert.deepEqual(match.votes, { [first.playerId]: choiceId });
  const context = match._routeEventContext();
  context.players = [{ ...context.players[0], hope: 4, hopeCapacity: 3 }];
  assert.equal(planMizukiRouteEventChoice(match.currentNode, { ...context, choiceId }).ok, false, 'capacity must cover the cost independently');
});

test('a committed hope-capacity exchange restores without consuming resources or granting max life twice', t => {
  const match = fixture(t, 1, { started: false }), command = message => {
    assert.deepEqual(match.handle('p0', message), { ok: true });
  };
  match.start();
  command({ t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  command({ t: 'g.mizuki.strategy', bandId: 'band_amiya' });
  command({ t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  command({ t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  command({ t: 'g.mizuki.importDungeon', dungeon: { zones: [{ id: 'zone_1', nodes: [
    { pos: { x: 0, y: 0 }, type: 'ENTERTAINMENT', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
  ] }] } });
  const player = match.players.get('p0');
  Object.assign(player, { hope: 4, hopeCapacity: 8, life: 1, maxLife: 1 });
  const route = match.privateView('p0').mizuki.route.find(node => node.available);assert.ok(route);
  command({ t: 'g.mizuki.route', nodeId: route.id });command({ t: 'g.mizuki.routeStart' });
  match._withParty(match.expedition.partyFor('p0'), () => {
    const state = { eventKey: 'prts_ro2_event_18', sceneIndex: 0, revision: 0, history: [], restUsed: [], dreamChoices: ['choice_ro2_exchange_4'] };
    match.event = { ...createMizukiRouteEvent(match.currentNode, { ...match._routeEventContext(), event: { state } }), votes: {} };
    match.votes = {};
  });
  command({ t: 'g.mizuki.event', choiceId: 'choice_ro2_exchange_4' });
  assert.deepEqual([player.hope, player.hopeCapacity, player.life, player.maxLife], [0, 4, 4, 4]);
  const doc = structuredClone(match.exportCheckpoint());assert.ok(doc);
  const restored = fixture(t, 1, { started: false });
  assert.equal(restored.restoreCheckpoint(doc), true);
  const recovered = restored.players.get('p0');
  assert.deepEqual([recovered.hope, recovered.hopeCapacity, recovered.life, recovered.maxLife], [0, 4, 4, 4]);
  assert.equal(restored.privateView('p0').mizuki.hopeCapacity, 4);
  const before = structuredClone(restored.exportCheckpoint());
  assert.equal(restored.handle('p0', { t: 'g.mizuki.event', choiceId: 'choice_ro2_exchange_4' }).error, 'BAD_TARGET');
  assert.deepEqual(restored.exportCheckpoint(), before);
});

test('spend-all-gold event empties each balance and advances the gold commission by the exact total spent', (t) => {
  const match = fixture(t), first = match.players.get('p0'), second = match.players.get('p1');
  first.gold = 2; second.gold = 7;
  const mission = acceptMizukiRouteMission(match.routeMissions, { taskId: 'rogue_2_task_014', nodeId: 'commission',
    memberIds: ['p0', 'p1'], seed: match.seed });
  assert.ok(mission);
  const event = openEvent(match, 12, 'INCIDENT');
  const choice = event.choices.find(value => value.id === 'choice_ro2_5_1');
  assert.equal(choice?.available, true);
  const plan = planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: choice.id });
  assert.equal(plan.ok, true);
  assert.equal(plan.effects.allGold, true);
  assert.equal(plan.goldSpent, 9);
  choose(match, choice.id);
  assert.equal(first.gold, 0);
  assert.equal(second.gold, 0);
  assert.equal(mission.progress, 9);
  assert.equal(mission.status, 'active');
});
