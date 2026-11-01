import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { normalizeMizukiDungeon, enterMizukiPortalExploration, leaveMizukiPortalExploration } from '../server/modes/mizuki/exploration.js';
import { generateMizukiPortalZone } from '../server/modes/mizuki/RouteGeneration.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';
import { createMizukiRouteEventLedger } from '../server/modes/mizuki/RouteEvents.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const EVENTS = JSON.parse(readFileSync(new URL('../data/mizuki/route-event-source.json', import.meta.url))).events;
const ordinal = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const command = (m, id, message) => { const result = m.handle(id, message);
  assert.equal(result.ok, true, JSON.stringify({ id, message, result })); return result; };
function fixture(t, count = 2) {
  const scheduler = new VirtualScheduler(), errors = [];
  const dungeon = { zones: Object.fromEntries(Array.from({ length: 5 }, (_, index) => ['floor' + (index + 1), {
    id: 'zone_' + (index + 1), zoneType: 'NORMAL', nodes: [
      ...[0, 1].map(y => ({ pos: { x: 0, y }, type: 'INCIDENT', next: [{ x: 1, y }] })),
      ...[0, 1].map(y => ({ pos: { x: 1, y }, type: 'PORTAL', next: [{ x: 2, y }] })),
      ...[0, 1].map(y => ({ pos: { x: 2, y }, type: 'INCIDENT', next: [] })),
    ],
  }])) };
  const match = new MizukiMatch({ roomCode: 'EFLOOR', seed: 619, hostId: 'p0', data: DATA, scheduler, dungeon,
    endingUnlocks: ['ro2_ending_1', 'ro2_ending_2', 'ro2_ending_3', 'ro2_ending_4'],
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    send() {}, broadcast() {}, onEnd() {}, log: { info() {}, warn() {}, error: (...args) => errors.push(args) } });
  t.after(() => { match.dispose(); scheduler.dispose(); assert.deepEqual(errors, []); });
  match.start();
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [i, p] of match.order.entries()) command(match, p.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[i].bandId });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  const routes = match.privateView('p0').mizuki.route; assert.equal(routes.length, 2);
  const childIds = count === 2 ? ['p1'] : ['p2', 'p3'];
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.route', nodeId: routes[childIds.includes(p.playerId) ? 1 : 0].id });
  for (const id of childIds) {
    const request = command(match, id, { t: 'g.mizuki.splitRequest', nodeId: routes[1].id }).request;
    command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: request.id, approve: true });
  }
  assert.equal(match.expedition.parties.size, 2);
  return match;
}
const party = (m, id) => m.expedition.partyFor(id);
function position(m, id, number, { afterPortal = false } = {}) {
  m._withParty(party(m, id), () => {
    const floor = normalizeMizukiDungeon(m.explorationState.dungeon).floors.find(f => f.ordinaryFloor === number && !f.isExtraRegion);
    const first = floor.nodes.find(node => node.depth === 0 && node.index === 0), portal = floor.nodes.find(node => node.depth === 1 && node.index === 0);
    m.explorationState = { ...m.explorationState, zoneKey: floor.key,
      trace: afterPortal ? [first.id, portal.id] : [], cursor: afterPortal ? portal.id : null };
    m.currentNode = null; m.event = null; m.votes = {}; m.phase = PHASE.ROUTE;
    m.route = m._routeOptions(); m._scopeParty.approvedNodeId = null; m.expedition.setContext(m._scopeParty.id, m.explorationState);
  });
}
function assertFloor(m, id, expected) {
  const ownState = m.partyStates.get(party(m, id).id).explorationState;
  assert.equal(m._difficultyAreaCount(ownState), expected);
  assert.equal(m._routeEventContext(ownState).floor, expected);
  m._withParty(party(m, id), () => {
    assert.equal(m._difficultyAreaCount(), expected); assert.equal(m._endingContext().floor, expected);
    const context = m._routeEventContext(); assert.equal(context.floor, expected);
    assert.deepEqual(context.players.map(p => p.playerId), party(m, id).memberIds);
  });
}
function enterIncident(m, id) {
  const current = m.privateView(id).mizuki.route.find(node => node.graphType === 'INCIDENT' && node.available); assert.ok(current);
  for (const member of [...party(m, id).memberIds]) command(m, member, { t: 'g.mizuki.route', nodeId: current.id });
  command(m, 'p0', { t: 'g.mizuki.routeStart' });
  return m.privateView(id).mizuki.event;
}

test('parallel early branch samples events with its own floor while the aggregate leader is on floor four', t => {
  const m = fixture(t); const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    m.seed = Math.imul(seed, 2654435761) >>> 0; m.floorState.eventLedger = createMizukiRouteEventLedger(); position(m, 'p0', 4); position(m, 'p1', 1);
    assert.equal(m._difficultyAreaCount(), 4); assertFloor(m, 'p1', 1);
    const event = enterIncident(m, 'p1'), source = EVENTS.find(value => value.id === event.state.eventKey); assert.ok(source);
    assert.ok(!source.floors.length || source.floors.includes('I'), event.state.eventKey + ' must allow floor I');
    assert.ok(!['prts_ro2_event_43', 'prts_ro2_event_45', 'prts_ro2_event_46'].includes(source.id));
    seen.add(source.id); assertFloor(m, 'p1', 1); assertFloor(m, 'p0', 4);
    assert.equal(m._difficultyAreaCount(), 4);
  }
  assert.deepEqual([...seen].sort(), EVENTS.filter(event => event.floors.includes('I')).map(event => event.id).sort(), 'real entries cover all nine original floor-I event records');
});

test('explicit floor context and party scopes do not leak in either direction across every ordinary floor pair', t => {
  const m = fixture(t);
  for (const leaderFloor of [1, 2, 4, 5]) for (const childFloor of [1, 2, 3, 4, 5]) {
    position(m, 'p0', leaderFloor); position(m, 'p1', childFloor);
    assertFloor(m, 'p1', childFloor); assertFloor(m, 'p0', leaderFloor);
    const event = enterIncident(m, 'p1'), source = EVENTS.find(value => value.id === event.state.eventKey);
    assert.ok(!source.floors.length || source.floors.includes(ordinal[childFloor]));
    assert.equal(m._difficultyAreaCount(), leaderFloor);
  }
});

test('real recall moves an early doctor to the leader context and never keeps the old source floor for later events', t => {
  const m = fixture(t); position(m, 'p0', 4); position(m, 'p1', 1); assertFloor(m, 'p1', 1);
  const request = command(m, 'p0', { t: 'g.mizuki.recallPropose', targetIds: ['p1'] }).request;
  command(m, 'p1', { t: 'g.mizuki.recallRespond', requestId: request.id, accept: true });
  assert.equal(party(m, 'p1').id, party(m, 'p0').id); assertFloor(m, 'p1', 4);
  const event = enterIncident(m, 'p1'), source = EVENTS.find(value => value.id === event.state.eventKey);
  assert.ok(!source.floors.length || source.floors.includes('IV')); assertFloor(m, 'p1', 4);
});

test('a recalled doctor detached while leader is inside a node preserves its own early context until joining', t => {
  const m = fixture(t, 4); position(m, 'p0', 4); position(m, 'p2', 1);
  const sourcePartyId = party(m, 'p2').id;
  const request = command(m, 'p0', { t: 'g.mizuki.recallPropose', targetIds: ['p2'] }).request;
  command(m, 'p1', { t: 'g.mizuki.recallVote', requestId: request.id, agree: true });
  command(m, 'p3', { t: 'g.mizuki.recallVote', requestId: request.id, agree: true });
  enterIncident(m, 'p0'); command(m, 'p2', { t: 'g.mizuki.recallRespond', requestId: request.id, accept: true });
  assert.notEqual(party(m, 'p2').id, sourcePartyId); assert.notEqual(party(m, 'p2').id, party(m, 'p0').id);
  assertFloor(m, 'p2', 1); assertFloor(m, 'p3', 1); assertFloor(m, 'p0', 4);
  position(m, 'p0', 4);
  assert.equal(party(m, 'p2').id, party(m, 'p0').id); assertFloor(m, 'p2', 4); assertFloor(m, 'p3', 1);
});

test('an early branch portal inherits its source floor and restores it after the leader has advanced', t => {
  const m = fixture(t); position(m, 'p0', 5); position(m, 'p1', 2, { afterPortal: true });
  m._withParty(party(m, 'p1'), () => {
    const zone = generateMizukiPortalZone({ seed: 17, stageOptions: m.stageOptions, returnZoneKey: m.explorationState.zoneKey });
    m.explorationState = enterMizukiPortalExploration(m.explorationState, zone);
    m.expedition.setContext(m._scopeParty.id, m.explorationState);
  });
  assertFloor(m, 'p1', 2); assertFloor(m, 'p0', 5);
  const portalState = m.partyStates.get(party(m, 'p1').id).explorationState;
  assert.ok(portalState.zoneKey.startsWith('portal_'));
  m._withParty(party(m, 'p1'), () => {
    const floor = normalizeMizukiDungeon(m.explorationState.dungeon).floors.find(f => f.key === m.explorationState.zoneKey);
    const path = []; let node = floor.nodes.find(value => !floor.edges.some(edge => edge.to === value.id));
    while (node) { path.push(node.id); node = floor.nodes.find(value => value.id === node.next[0]); }
    assert.equal(floor.nodes.find(node => node.id === path.at(-1)).type, 'BATTLE_BOSS');
    m.explorationState = leaveMizukiPortalExploration({ ...m.explorationState, trace: path, cursor: path.at(-1) });
    m.expedition.setContext(m._scopeParty.id, m.explorationState);
    m.route = m._routeOptions();
  });
  assertFloor(m, 'p1', 2); assertFloor(m, 'p0', 5);
  const event = enterIncident(m, 'p1'), source = EVENTS.find(value => value.id === event.state.eventKey);
  assert.ok(!source.floors.length || source.floors.includes('II')); assertFloor(m, 'p1', 2);
});
