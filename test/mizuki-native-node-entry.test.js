import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { acceptMizukiRouteMission } from '../server/modes/mizuki/RouteMissions.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const categories = ['BATTLE_NORMAL', 'BATTLE_ELITE', 'BATTLE_BOSS', 'REST', 'INCIDENT', 'ENTERTAINMENT',
  'UNKNOWN', 'WISH', 'SACRIFICE', 'EXPEDITION', 'BATTLE_SHOP', 'PORTAL', 'MISSION'];
const stages = { BATTLE_NORMAL: 'ro2_n_1_1', BATTLE_ELITE: 'ro2_e_1_1', BATTLE_BOSS: 'ro2_b_1' };
function fixture(t, type, count = 1, start = true) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ roomCode: 'MZND', seed: 812, data: DATA, scheduler,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    dungeon: { zones: [{ id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type, ...(stages[type] ? { stage: stages[type] } : {}), next: [{ x: 1, y: 0 }] },
      { pos: { x: 1, y: 0 }, type: 'REST', next: [] },
    ] }] }, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  if (!start) return match;
  match.start();
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [index, p] of match.order.entries()) command(match, p.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  return match;
}
function command(match, playerId, message) { assert.deepEqual(match.handle(playerId, message), { ok: true }); }
function enter(match, nodeId = match.privateView('p0').mizuki.route[0].id) {
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.route', nodeId });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
}
function choose(match, choiceId) {
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.event', choiceId });
}

for (const count of [1, 4]) for (const type of categories) test(count + ' players can enter native ' + type + ' through actual route commands', t => {
  const match = fixture(t, type, count);
  const node = match.privateView('p0').mizuki.exploration.nodes.find(value => value.available);
  assert.ok(node); assert.equal(node.disabledReason, null);
  enter(match, node.id);
  const expected = stages[type] ? PHASE.PREP : type === 'BATTLE_SHOP' ? PHASE.SHOP : PHASE.EVENT;
  for (const player of match.order) {
    const view = match.privateView(player.playerId).mizuki;
    assert.equal(view.phase, expected);
    assert.equal(view.currentNode.graphType, type);
    if (expected === PHASE.EVENT) assert.ok(view.event.choices.some(choice => choice.available));
    if (expected === PHASE.SHOP) assert.ok(view.shop.offers.length > 0);
    if (expected === PHASE.PREP) assert.ok(view.prep);
  }
});

test('portal event pays a key, enters the real excursion, restores it, and returns to the original successor', t => {
  const match = fixture(t, 'PORTAL'); match.key = 1; enter(match);
  const origin = match.privateView('p0').mizuki.exploration.floor.key;
  choose(match, 'choice_ro2_teleport_1');
  assert.equal(match.key, 0); assert.equal(match.privateView('p0').mizuki.event.state.sceneIndex, 1);
  choose(match, 'choice_ro2_teleport_3');
  const party = match.expedition.partyFor('p0'), state = match.partyStates.get(party.id);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.ROUTE); assert.ok(state.explorationState.portalReturn);
  const checkpoint = structuredClone(match.exportCheckpoint()), restored = fixture(t, 'PORTAL', 1, false);
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  const restoredParty = restored.expedition.partyFor('p0');
  restored._withParty(restoredParty, () => {
    for (let guard = 0; guard < 8 && restored.explorationState.portalReturn; guard++) {
      const node = restored.route[0]; assert.ok(node);
      restored._enterNode(node); restored._completeNode();
    }
    assert.equal(restored.explorationState.portalReturn, undefined);
    assert.equal(restored.explorationState.zoneKey, origin);
    assert.equal(restored.route[0].graphType, 'REST');
  });
});

test('merchant purchases issue a usable ticket and return every player to the same shop before leaving', t => {
  const match = fixture(t, 'BATTLE_SHOP', 4); for (const p of match.order) p.gold = 99; enter(match);
  const offer = match.privateView('p0').mizuki.shop.offers.find(value => value.type === 'recruitTicket'); assert.ok(offer);
  command(match, 'p0', { t: 'g.mizuki.buy', offerId: offer.id });
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.RECRUIT);
  assert.ok(match.privateView('p0').mizuki.recruit.choices.length > 0);
  skipMizukiRecruit(match);
  for (const p of match.order) assert.equal(match.privateView(p.playerId).mizuki.phase, PHASE.SHOP);
  assert.equal(match.players.get('p0').gold, 99 - offer.price);
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.ready', on: true });
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.ROUTE);
  assert.equal(match.privateView('p0').mizuki.route[0].graphType, 'REST');
});

test('a completed commission claim grants its chosen resource then restores the route for all members', t => {
  const match = fixture(t, 'MISSION', 4);
  const mission = acceptMizukiRouteMission(match.routeMissions, { taskId: 'rogue_2_task_004', nodeId: 'earlier-mission',
    memberIds: match.order.map(p => p.playerId), seed: match.seed });
  match._routeMissionProgress({ keysSpent: 3 }); assert.equal(mission.status, 'complete');
  command(match, 'p0', { t: 'g.mizuki.missionClaim', missionId: mission.id });
  const view = match.privateView('p0').mizuki, reward = view.event.choices.find(choice => choice.available); assert.ok(reward);
  choose(match, reward.id);
  if (match.privateView('p0').mizuki.phase === PHASE.RECRUIT) skipMizukiRecruit(match);
  assert.equal(mission.status, 'claimed'); assert.equal(mission.picks.length, 1);
  for (const p of match.order) assert.equal(match.privateView(p.playerId).mizuki.phase, PHASE.ROUTE);
});

test('a relic exchange removes the selected collectible and commits one replacement before returning to route', t => {
  const match = fixture(t, 'SACRIFICE'); match.collectibles = ['rogue_2_relic_fight_1']; enter(match);
  choose(match, 'choice_ro2_sacrifice_1');
  const event = match.privateView('p0').mizuki.event, choice = event.choices.find(value => value.id.startsWith('sacrifice:')); assert.ok(choice);
  choose(match, choice.id);
  assert.equal(match.collectibles.includes('rogue_2_relic_fight_1'), false); assert.equal(match.collectibles.length, 1);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.ROUTE);
});
