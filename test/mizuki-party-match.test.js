import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { Grid } from '../server/sim/grid.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const FRAME_MS = 1000 / 30;
// The actual Match/official-stage adapters run here; only battle time/results are
// controlled so readiness isolation does not depend on a stage's clear time.
class ControlledCombat {
  constructor(options) {
    this.options = options; this.ticks = 0; this.done = false; this.outcome = 'victory'; this.deployLimit = options.deployLimit;
    this.battle = { grid: new Grid(options.stage, options.rect), rect: options.rect, data: options.data,
      allyUnits: [], enemies: [], players: options.players.map(player => ({ playerId: player.playerId, units: [] })),
      opts: { spawns: [] }, on() {} };
  }
  step() { this.ticks++; }
  snapshot() {
    return { battleId: this.options.battleId, fieldId: this.options.fieldId, tick: this.ticks, t: this.ticks / 30,
      done: this.done, outcome: this.done ? this.outcome : null, units: [], leakedCount: 0, leakDamage: 0,
      progression: { version: 1, players: Object.fromEntries(this.options.players.map((p) => [p.playerId, { layers: structuredClone(p.layers || {}) }])) },
      covenants: Object.fromEntries(this.options.players.map((p) => [p.playerId, []])),
      geometry: { rows: 19, cols: 21, rect: this.options.rect, tiles: [] },
      rosters: Object.fromEntries(this.options.players.map((p) => [p.playerId, p.units.map((unit) => ({ ...unit, deployed: this.ticks > 0 }))])) };
  }
  result() { return this.done ? { outcome: this.outcome, leakDamage: 0, leakedCount: 0, perPlayer: {} } : null; }
  fieldMeta() { return { fieldId: this.options.fieldId, kind: this.options.kind, stageId: this.options.stageId, units: [] }; }
  drainEvents() { return []; }
  forceEnd() { this.done = true; this.outcome = 'aborted'; }
  dispose() { this.done = true; }
}

function fixture(t, { connected = true, ...extra } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), messages = [], errors = [];
  const match = new MizukiMatch({ roomCode: 'PART', seed: 619, matchNo: 7, matchId: 'mizuki-party-test', hostId: 'p0',
    seats: Array.from({ length: 4 }, (_, seat) => ({ playerId: 'p' + seat, seat, connected })),
    data: DATA, scheduler, CombatClass: ControlledCombat,
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    send: (playerId, message) => messages.push({ playerId, message }), broadcast: (message) => messages.push({ message }),
    onEnd() {}, ...extra });
  t.after(() => { match.dispose(); scheduler.dispose(); }); return { match, scheduler, messages, errors };
}
const command = (match, playerId, message) => { const result = match.handle(playerId, message); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const denied = (match, playerId, message) => { const result = match.handle(playerId, message); assert.notEqual(result.ok, true); assert.ok(result.error); return result; };
const phase = (match, playerId) => match.privateView(playerId).mizuki.phase;
const party = (match, playerId) => match.expedition.partyFor(playerId);
function enterRoute(match) {
  match.start();
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [i, p] of match.order.entries()) command(match, p.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[i].bandId });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE); assert.equal(match.partyStates.size, 1);
  // Region I correctly has one initial node. Party-isolation tests need an
  // explicit native-schema fork rather than assuming the old battle archive.
  importBranchedFloor(match);
}
function nodes(match) {
  const values = match.privateView('p0').mizuki.route.filter((node) => node.available && node.type === 'combat');
  assert.ok(values.length >= 2); return [values[0].id, values[1].id];
}
function votes(match, rightMembers = []) {
  const [left, right] = nodes(match);
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.route', nodeId: rightMembers.includes(p.playerId) ? right : left });
  return { left, right };
}
function split(match, rightMembers) {
  const choices = votes(match, rightMembers);
  const requests = rightMembers.map((playerId) => command(match, playerId, { t: 'g.mizuki.splitRequest', nodeId: choices.right }).request);
  for (const request of requests) command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: request.id, approve: true });
  return choices;
}
const depart = (match) => command(match, 'p0', { t: 'g.mizuki.routeStart' });
const ready = (match, ids) => { for (const playerId of ids) command(match, playerId, { t: 'g.mizuki.ready', on: true }); };

test('actual Match records route votes until the leader explicitly starts departure', (t) => {
  const { match } = fixture(t); enterRoute(match); const [left] = nodes(match);
  command(match, 'p0', { t: 'g.mizuki.route', nodeId: left });
  denied(match, 'p0', { t: 'g.mizuki.routeStart' });
  for (const playerId of ['p1', 'p2', 'p3']) command(match, playerId, { t: 'g.mizuki.route', nodeId: left });
  assert.ok(match.order.every((p) => phase(match, p.playerId) === PHASE.ROUTE)); assert.equal(match.fields.size, 0);
  denied(match, 'p1', { t: 'g.mizuki.routeStart' }); assert.equal(match.fields.size, 0);
  depart(match); assert.equal(match.fields.size, 4);
  for (const p of match.order) { assert.equal(phase(match, p.playerId), PHASE.PREP); assert.equal(p.fieldId, 'n:' + p.playerId); }
});

test('actual Match requires leader approval before same-destination requests form two parties of two', (t) => {
  const { match } = fixture(t); enterRoute(match); const { right } = votes(match, ['p2', 'p3']);
  const first = command(match, 'p2', { t: 'g.mizuki.splitRequest', nodeId: right }).request;
  const second = command(match, 'p3', { t: 'g.mizuki.splitRequest', nodeId: right }).request;
  denied(match, 'p1', { t: 'g.mizuki.splitDecide', requestId: first.id, approve: true });
  denied(match, 'p0', { t: 'g.mizuki.routeStart' }); assert.equal(match.fields.size, 0);
  command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: first.id, approve: true });
  denied(match, 'p0', { t: 'g.mizuki.routeStart' });
  command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: second.id, approve: true });
  assert.deepEqual(party(match, 'p0').memberIds, ['p0', 'p1']); assert.deepEqual(party(match, 'p2').memberIds, ['p2', 'p3']);
  assert.notEqual(party(match, 'p0').id, party(match, 'p2').id);
  denied(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: second.id, approve: true });
  depart(match);
  assert.equal(match.fields.size, 4);
  assert.equal(match.privateView('p2').mizuki.currentNode.id, right);
  for (const field of match.fields.values()) { assert.equal(field.engine.options.players.length, 1); assert.equal(field.kind, 'normal'); }
});

test('actual Match supports one plus three and starts only the prepared party while other fields stay idle', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); split(match, ['p3']); depart(match);
  assert.deepEqual(party(match, 'p3').memberIds, ['p3']); assert.deepEqual(party(match, 'p0').memberIds, ['p0', 'p1', 'p2']);
  ready(match, ['p3']);
  assert.equal(phase(match, 'p3'), PHASE.COMBAT); assert.equal(phase(match, 'p0'), PHASE.PREP);
  scheduler.advance(FRAME_MS * 2);
  assert.ok(match.fields.get('n:p3').engine.ticks > 0);
  for (const playerId of ['p0', 'p1', 'p2']) assert.equal(match.fields.get('n:' + playerId).engine.ticks, 0, 'unready party battle must not step');
  assert.deepEqual(errors, []);
});

test('actual Match keeps two-party readiness and player-selected strategy/layers independent', (t) => {
  const { match } = fixture(t); enterRoute(match); const choices = split(match, ['p2', 'p3']);
  match.players.get('p0').layers.preciShip = 8; match.players.get('p2').layers.preciShip = 31;
  depart(match); const bands = match.order.map((p) => p.bandId);
  ready(match, ['p0']); assert.equal(phase(match, 'p0'), PHASE.PREP); assert.equal(phase(match, 'p2'), PHASE.PREP);
  ready(match, ['p1']); assert.equal(phase(match, 'p0'), PHASE.COMBAT); assert.equal(phase(match, 'p2'), PHASE.PREP);
  ready(match, ['p2']); assert.equal(phase(match, 'p2'), PHASE.PREP);
  ready(match, ['p3']); assert.equal(phase(match, 'p2'), PHASE.COMBAT);
  assert.equal(match.fields.get('n:p0').engine.options.players[0].layers.preciShip, 8);
  assert.equal(match.fields.get('n:p2').engine.options.players[0].layers.preciShip, 31);
  assert.deepEqual(match.order.map((p) => p.bandId), bands);
  denied(match, 'p2', { t: 'g.mizuki.splitRequest', nodeId: choices.left });
});

test('actual Match wires official stages to production automatic engines after dynamic departure', (t) => {
  const { match, scheduler, errors } = fixture(t, { CombatClass: undefined }); enterRoute(match); split(match, ['p3']); depart(match);
  assert.equal(match.fields.size, 4);
  for (const field of match.fields.values()) {
    assert.equal(field.engine.automatic, true); assert.equal(field.engine.battle.started, false);
    assert.equal(field.engine.snapshot().controlMode, 'automatic');
  }
  ready(match, ['p3']); scheduler.advance(FRAME_MS * 2);
  assert.equal(match.fields.get('n:p3').engine.battle.started, true);
  for (const playerId of ['p0', 'p1', 'p2']) assert.equal(match.fields.get('n:' + playerId).engine.battle.started, false);
  assert.deepEqual(errors, []);
});

test('party checkpoints restore grouping, independent routes and preparation with fresh battle identities', (t) => {
  const { match } = fixture(t); enterRoute(match); const chosen = split(match, ['p2', 'p3']); depart(match);
  match.players.get('p0').layers.preciShip = 8; match.players.get('p2').layers.preciShip = 31;
  const oldIds = [...match.fields.values()].map((field) => field.battleId), doc = match.exportCheckpoint();
  const restored = fixture(t, { connected: false }).match;
  assert.equal(restored.restoreCheckpoint(JSON.parse(JSON.stringify(doc))), true);
  assert.deepEqual(party(restored, 'p0').memberIds, ['p0', 'p1']); assert.deepEqual(party(restored, 'p2').memberIds, ['p2', 'p3']);
  assert.equal(restored.privateView('p0').mizuki.currentNode.id, chosen.left);
  assert.equal(restored.privateView('p2').mizuki.currentNode.id, chosen.right);
  assert.equal(restored.players.get('p0').layers.preciShip, 8); assert.equal(restored.players.get('p2').layers.preciShip, 31);
  assert.equal(restored.fields.size, 4); assert.ok(restored.order.every((p) => !p.ready && !p.connected));
  assert.ok([...restored.fields.values()].every((field) => !oldIds.includes(field.battleId)));
  assert.ok(restored.order.every((p) => phase(restored, p.playerId) === PHASE.PREP));
});

test('party checkpoints rewind only active combat and reject corrupt memberships or foreign votes', (t) => {
  const { match } = fixture(t); enterRoute(match); split(match, ['p3']); depart(match);
  const originalHope = match.players.get('p3').hope; ready(match, ['p3']); match.players.get('p3').hope = 1;
  const doc = match.exportCheckpoint();
  assert.equal(doc.players.find((p) => p.playerId === 'p3').hope, originalHope);
  assert.ok(doc.mizuki.partyStates.every(([, state]) => state.phase === PHASE.PREP));
  const restored = fixture(t).match; assert.equal(restored.restoreCheckpoint(structuredClone(doc)), true);
  assert.equal(phase(restored, 'p3'), PHASE.PREP); assert.equal(phase(restored, 'p0'), PHASE.PREP);
  for (const corrupt of [
    (bad) => { bad.mizuki.expedition.parties[0].memberIds.push('p3'); },
    (bad) => { bad.mizuki.partyStates.push(structuredClone(bad.mizuki.partyStates[0])); },
    (bad) => { bad.mizuki.partyStates[0][1].votes.p3 = bad.mizuki.partyStates[0][1].route[0].id; },
    (bad) => { bad.mizuki.partyStates[0][1].phase = PHASE.COMBAT; },
  ]) { const bad = structuredClone(doc); corrupt(bad); assert.equal(fixture(t).match.restoreCheckpoint(bad), false); }
});

function importBranchedFloor(match, { boss = false } = {}) {
  const bossStage = match.stageOptions.find((node) => node.available && node.type === 'boss');
  if (boss) assert.ok(bossStage);
  const next = boss ? [{ x: 1, y: 0 }] : [];
  const dungeon = { zones: [
    { id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next },
      { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next },
      ...(boss ? [{ pos: { x: 1, y: 0 }, type: 'BATTLE_BOSS', stage: bossStage.stageId, next: [] }] : []),
    ] },
    { id: 'zone_2', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] }] },
  ] };
  command(match, 'p0', { t: 'g.mizuki.importDungeon', dungeon, sourceLabel: 'native-schema rendezvous fixture' });
}
function finishParty(match, scheduler, ids) {
  const partyId = party(match, ids[0]).id;
  for (const field of match.fields.values()) if (field.partyId === partyId) field.engine.done = true;
  scheduler.advance(FRAME_MS * 2);
  for (const id of ids) assert.equal(phase(match, id), PHASE.REWARD);
  for (let turn = 0; turn < 32; turn++) {
    let acted = false;
    for (const id of ids) {
      const view = match.privateView(id).mizuki;
      if (view.phase !== PHASE.REWARD || view.ready) continue;
      const choices = view.rewards.filter(value => !value.selected
        && !view.rewards.some(selected => selected.group === value.group && selected.selected));
      const reward = choices.find(value => value.type !== 'collectible' || !match.collectibles.includes(value.itemId)) || choices[0];
      assert.ok(reward);
      const result = match.handle(id, { t: 'g.mizuki.reward', rewardId: reward.id });
      assert.ok(result.ok || result.error === 'BAD_TARGET', JSON.stringify(result)); acted = true;
    }
    if (!acted) break;
  }
  for (const id of ids) assert.equal(phase(match, id), PHASE.RECRUIT);
  skipMizukiRecruit(match, ids);
}

test('actual Match waits for the slow party at a floor exit then merges into the next original floor with independent layers', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); importBranchedFloor(match);
  match.players.get('p0').layers.preciShip = 7; match.players.get('p2').layers.preciShip = 23;
  split(match, ['p2', 'p3']); depart(match); ready(match, ['p0', 'p1', 'p2', 'p3']);
  finishParty(match, scheduler, ['p0', 'p1']);
  assert.equal(phase(match, 'p0'), 'MIZUKI_WAITING'); assert.equal(phase(match, 'p2'), PHASE.COMBAT);
  assert.equal(match.expedition.parties.size, 2); assert.equal(match.expedition.barrier.kind, 'floor');
  const waiting = fixture(t).match; assert.equal(waiting.restoreCheckpoint(match.exportCheckpoint()), true);
  assert.equal(phase(waiting, 'p0'), 'MIZUKI_WAITING'); assert.equal(phase(waiting, 'p2'), PHASE.PREP);
  finishParty(match, scheduler, ['p2', 'p3']);
  assert.equal(match.expedition.parties.size, 1); assert.equal(match.partyStates.size, 1);
  assert.equal(phase(match, 'p0'), PHASE.ROUTE); assert.equal(phase(match, 'p2'), PHASE.ROUTE);
  for (const player of match.order) { const state = match.partyStates.get(party(match, player.playerId).id); assert.equal(state.explorationState.zoneKey, '1'); assert.deepEqual(state.explorationState.trace, []); }
  assert.deepEqual(match.privateView('p0').mizuki.route.map((node) => node.id), ['mzgraph:1:0:0']);
  assert.equal(match.players.get('p0').layers.preciShip, 7); assert.equal(match.players.get('p2').layers.preciShip, 23);
  assert.equal(match.fields.size, 0); assert.deepEqual(errors, []);
});

test('actual Match forces a Boss rendezvous and pairs the merged four doctors into two independent-layer fields', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); importBranchedFloor(match, { boss: true });
  match.players.get('p0').layers.preciShip = 7; match.players.get('p1').layers.preciShip = 23;
  split(match, ['p2', 'p3']); depart(match); ready(match, ['p0', 'p1', 'p2', 'p3']);
  finishParty(match, scheduler, ['p0', 'p1']);
  const bossId = match.privateView('p0').mizuki.route.find((node) => node.type === 'boss').id;
  for (const id of ['p0', 'p1']) command(match, id, { t: 'g.mizuki.route', nodeId: bossId });
  depart(match); assert.equal(phase(match, 'p0'), 'MIZUKI_WAITING'); assert.equal(phase(match, 'p2'), PHASE.COMBAT);
  finishParty(match, scheduler, ['p2', 'p3']);
  for (const id of ['p2', 'p3']) command(match, id, { t: 'g.mizuki.route', nodeId: bossId });
  assert.equal(phase(match, 'p0'), PHASE.PREP, 'the last branch ballot releases the waiting Boss rendezvous');
  assert.equal(match.expedition.parties.size, 1); assert.equal(match.fields.size, 2);
  assert.deepEqual([...match.fields.values()].map((field) => field.players), [['p0', 'p1'], ['p2', 'p3']]);
  for (const field of match.fields.values()) { assert.equal(field.kind, 'boss'); assert.equal(field.engine.options.flags.layerGainsEnabled, false); }
  const first = match.fields.get('b:p0:p1');
  assert.equal(first.engine.options.players[0].layers.preciShip, 7); assert.equal(first.engine.options.players[1].layers.preciShip, 23);
  ready(match, ['p0', 'p1', 'p2', 'p3']);
  for (const field of match.fields.values()) field.engine.done = true; scheduler.advance(FRAME_MS * 2);
  assert.equal(phase(match, 'p0'), PHASE.REWARD); assert.equal(match.players.get('p0').layers.preciShip, 7); assert.equal(match.players.get('p1').layers.preciShip, 23);
  assert.deepEqual(errors, []);
});

test('leaving the only member of a running party removes its fields and cannot keep another party in COMBAT', (t) => {
  const { match, scheduler } = fixture(t); enterRoute(match); split(match, ['p3']); depart(match); ready(match, ['p3']);
  scheduler.advance(FRAME_MS * 2); const removed = party(match, 'p3').id;
  assert.equal(match.phase, PHASE.COMBAT); match.onLeave('p3');
  assert.equal(match.partyStates.has(removed), false); assert.equal(match.fields.has('n:p3'), false);
  assert.equal(match.phase, PHASE.PREP); assert.equal(phase(match, 'p0'), PHASE.PREP);
});
