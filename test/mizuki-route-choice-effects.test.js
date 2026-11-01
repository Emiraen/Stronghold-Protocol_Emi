import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { createMizukiRouteEvent, planMizukiRouteEventChoice } from '../server/modes/mizuki/RouteEvents.js';
import { acceptMizukiRouteMission } from '../server/modes/mizuki/RouteMissions.js';
import { mizukiCollectibleSpec } from '../server/modes/mizuki/Collectibles.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const TOPIC = JSON.parse(readFileSync(new URL('../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
function fixture(t, count = 1) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ roomCode: 'MZCH', seed: 812, data: DATA, scheduler,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    send() {}, broadcast() {}, onEnd() {} });
  match.started = true;
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return match;
}
function openEvent(match, eventNumber, sceneIndex = 0, extra = {}) {
  match.partyStates.clear();
  match.currentNode = { id: 'event-' + eventNumber, type: 'event', graphType: 'INCIDENT' };
  match.phase = PHASE.EVENT; match.votes = {};
  const state = { eventKey: 'prts_ro2_event_' + eventNumber, sceneIndex, revision: 0, history: [], restUsed: [], ...extra };
  match.event = { ...createMizukiRouteEvent(match.currentNode, { ...match._routeEventContext(), event: { state } }), votes: {} };
  return match.event;
}
function choose(match, choiceId) {
  for (const player of match._actors()) assert.deepEqual(match.handle(player.playerId, { t: 'g.mizuki.event', choiceId }), { ok: true });
}
const balances = match => ({ dice: match.dice, key: match.key, light: match.light,
  players: match.order.map(player => ({ gold: player.gold, hope: player.hope, life: player.life, maxLife: player.maxLife })) });

for (const [scene, cost, reward] of [[1, 3, 8], [2, 10, 25]]) {
  test('work scene ' + scene + ' requires the full up-front cost for every member', t => {
    const match = fixture(t, 2), [first, second] = match.order;
    first.gold = cost; second.gold = cost - 1;
    const event = openEvent(match, 23, scene);
    assert.equal(event.choices.find(choice => choice.id === 'choice_ro2_trade4_2').available, false);
    assert.equal(planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: 'choice_ro2_trade4_2' }).ok, false);
    const before = balances(match);
    assert.equal(match.handle(first.playerId, { t: 'g.mizuki.event', choiceId: 'choice_ro2_trade4_2' }).error, 'BAD_TARGET');
    assert.deepEqual(balances(match), before);
  });
  test('work scene ' + scene + ' executes both paid outcomes with exact balances', t => {
    const match = fixture(t), player = match.order[0], outcomes = new Set();
    for (let seed = 1; seed < 200 && outcomes.size < 2; seed++) {
      match.seed = seed; player.gold = cost; openEvent(match, 23, scene);
      match.routeMissions.missions = []; match.routeMissions.sequence = 0;
      const mission = acceptMizukiRouteMission(match.routeMissions, { taskId: 'rogue_2_task_014',
        nodeId: 'work-commission', memberIds: ['p0'], seed });
      const plan = planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: 'choice_ro2_trade4_2' });
      assert.equal(plan.ok, true); outcomes.add(plan.effects.gold);
      choose(match, 'choice_ro2_trade4_2');
      assert.equal(player.gold, cost + plan.effects.gold);
      assert.equal(mission.progress, cost);
      if (scene === 1) { assert.equal(match.phase, PHASE.EVENT); assert.equal(match.event.state.sceneIndex, 2); }
      else assert.equal(match.phase, PHASE.ROUTE);
    }
    assert.deepEqual([...outcomes].sort((a, b) => a - b), [-cost, reward - cost]);
  });
}

test('a zero-dice wish remains selectable even when its relic describes a paid dice effect', t => {
  const match = fixture(t); match.dice = 0;
  const event = openEvent(match, 49, 0, { wishRelics: ['rogue_2_relic_grace_71'] });
  assert.equal(event.choices[0].available, true);
  const plan = planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: event.choices[0].id });
  assert.equal(plan.ok, true); assert.deepEqual(plan.effects, {});
  choose(match, event.choices[0].id);
  assert.equal(match.dice, 0);
});

test('wish grants capacity relic once and never applies an unawarded preview heal', t => {
  const match = fixture(t), player = match.order[0];
  const run = (relicId, acceptRoll, verify) => {
    for (let seed = 1; seed < 200; seed++) {
      match.seed = seed; match.collectibles = []; player.life = 1; player.maxLife = 20; match.squadCapacity = 6;
      const event = openEvent(match, 49, 0, { wishRelics: [relicId] });
      const plan = planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: event.choices[0].id });
      if (!acceptRoll(plan)) continue;
      assert.deepEqual(plan.effects, {}); choose(match, event.choices[0].id); verify(plan); return;
    }
    assert.fail('required deterministic wish outcome not found');
  };
  run('rogue_2_relic_grace_1', plan => plan.roll > 1 && plan.roll < 6, () => {
    assert.ok(match.collectibles.includes('rogue_2_relic_grace_1')); assert.equal(match.squadCapacity, 7);
  });
  run('rogue_2_relic_grace_53', plan => plan.roll === 1 && !plan.pendingWish
    && plan.relics.every(id => !(TOPIC.relics[id]?.buffs || []).some(effect => effect.key === 'immediate_reward')), () => assert.equal(player.life, 1));
});

for (const taskId of ['rogue_2_task_003', 'rogue_2_task_004', 'rogue_2_task_005', 'rogue_2_task_014']) {
  test('accepting ' + taskId + ' starts at zero progress without paying its objective', t => {
    const match = fixture(t); match.dice = 0; match.key = 0; match.light = 10; match.order[0].gold = 0;
    const event = openEvent(match, 53, 0, { missionIds: [taskId] });
    assert.equal(event.choices.find(choice => choice.id === 'choice_ro2_task_1').available, true);
    const before = balances(match); choose(match, 'choice_ro2_task_1');
    assert.deepEqual(balances(match), before);
    const mission = match.routeMissions.missions.find(value => value.taskId === taskId);
    assert.ok(mission); assert.equal(mission.progress, 0); assert.equal(mission.status, 'active');
    match._routeMissionProgress({ lightGained: 1, keysSpent: 1, diceSpent: 1, goldSpent: 1 });
    assert.equal(mission.progress, 1);
  });
}

test('exhausted commission categories expose no empty accept action and retain leave', t => {
  const match = fixture(t);
  for (const task of Object.values(TOPIC.taskData).filter(value => value.taskRarity === 'SUPER_RARE'))
    assert.ok(acceptMizukiRouteMission(match.routeMissions, { taskId: task.taskId, nodeId: 'accepted:' + task.taskId, memberIds: ['p0'], seed: match.seed }));
  match.currentNode = { id: 'exhausted-mission', type: 'event', graphType: 'MISSION' }; match.phase = PHASE.EVENT;
  match.event = { ...createMizukiRouteEvent(match.currentNode, { ...match._routeEventContext(), event: null }), votes: {} };
  assert.equal(match.event.choices.some(choice => choice.id === 'choice_ro2_task_1'), false);
  assert.ok(match.event.choices.some(choice => choice.id === 'choice_ro2_task_4'));
  assert.equal(planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: 'choice_ro2_task_1' }).ok, false);
});

test('liar book event grants the book and exactly one roll-dependent random collectible', t => {
  const match = fixture(t), rarities = new Set();
  for (let seed = 1; seed < 200 && rarities.size < 2; seed++) {
    match.seed = seed; match.collectibles = []; openEvent(match, 30);
    const plan = planMizukiRouteEventChoice(match.currentNode, { ...match._routeEventContext(), choiceId: 'choice_ro2_liar1_1' });
    assert.equal(plan.relics.length, 2); assert.ok(plan.relics.includes('rogue_2_relic_grace_60'));
    const randomId = plan.relics.find(id => id !== 'rogue_2_relic_grace_60');
    assert.equal(mizukiCollectibleSpec(randomId).rarity, plan.roll > 5 ? 2 : 0); rarities.add(mizukiCollectibleSpec(randomId).rarity);
    choose(match, 'choice_ro2_liar1_1'); assert.deepEqual([...match.collectibles].sort(), [...plan.relics].sort());
  }
  assert.deepEqual([...rarities].sort(), [0, 2]);
});
