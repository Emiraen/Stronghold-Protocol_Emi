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
const WAITING = 'MIZUKI_WAITING';

// Exercise the real Match, party scopes, original stage adapters and rewards.
// Only the combat clock/result are controlled to make branch timing explicit.
class ControlledCombat {
  constructor(options) {
    this.options = options; this.ticks = 0; this.done = false; this.deployLimit = options.deployLimit;
    this.battle = { grid: new Grid(options.stage, options.rect), rect: options.rect, data: options.data,
      allyUnits: [], enemies: [], players: options.players.map(player => ({ playerId: player.playerId, units: [] })),
      opts: { spawns: [] }, on() {} };
  }
  step() { this.ticks++; }
  snapshot() {
    return { battleId: this.options.battleId, fieldId: this.options.fieldId, tick: this.ticks, t: this.ticks / 30,
      done: this.done, outcome: this.done ? 'victory' : null, units: [], leakedCount: 0, leakDamage: 0,
      progression: { version: 1, players: Object.fromEntries(this.options.players.map(player => [player.playerId,
        { layers: structuredClone(player.layers || {}) }])) },
      covenants: Object.fromEntries(this.options.players.map(player => [player.playerId, []])),
      geometry: { rows: 19, cols: 21, rect: this.options.rect, tiles: [] },
      rosters: Object.fromEntries(this.options.players.map(player => [player.playerId,
        player.units.map(unit => ({ ...unit, deployed: this.ticks > 0 }))])) };
  }
  result() { return this.done ? { outcome: 'victory', leakDamage: 0, leakedCount: 0, perPlayer: {} } : null; }
  fieldMeta() { return { fieldId: this.options.fieldId, kind: this.options.kind, stageId: this.options.stageId, units: [] }; }
  drainEvents() { return []; }
  forceEnd() { this.done = true; }
  dispose() { this.done = true; }
}

function fixture(t, { count = 2, connected = true } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const match = new MizukiMatch({ roomCode: 'FREC', seed: 619, matchNo: 7, matchId: 'mizuki-floor-recall', hostId: 'p0',
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected })),
    data: DATA, scheduler, CombatClass: ControlledCombat, send() {}, broadcast() {}, onEnd() {},
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) } });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, scheduler, errors };
}
const command = (match, playerId, message) => {
  const result = match.handle(playerId, message);
  assert.equal(result.ok, true, JSON.stringify({ playerId, message, result }));
  return result;
};
const phase = (match, playerId) => match.privateView(playerId).mizuki.phase;
const party = (match, playerId) => match.expedition.partyFor(playerId);
const route = (match, playerId) => match.privateView(playerId).mizuki.route.filter(node => node.available);
const ready = (match, ids) => { for (const playerId of ids) command(match, playerId, { t: 'g.mizuki.ready', on: true }); };
const vote = (match, ids, nodeId) => { for (const playerId of ids) command(match, playerId, { t: 'g.mizuki.route', nodeId }); };
const depart = match => command(match, 'p0', { t: 'g.mizuki.routeStart' });

function enterRoute(match) {
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [index, player] of match.order.entries()) command(match, player.playerId,
    { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) command(match, player.playerId,
    { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  assert.equal(phase(match, 'p0'), PHASE.ROUTE);
}

function importBranches(match, { boss = false } = {}) {
  const bossStage = boss && match.stageOptions.find(node => node.available && node.type === 'boss');
  if (boss) assert.ok(bossStage);
  const next = boss ? [{ x: 1, y: 0 }] : null;
  const dungeon = { zones: [
    { id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: next || [{ x: 1, y: 0 }] },
      { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: next || [{ x: 1, y: 1 }] },
      ...(boss ? [{ pos: { x: 1, y: 0 }, type: 'BATTLE_BOSS', stage: bossStage.stageId, next: [] }] : [
        { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
        { pos: { x: 1, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
      ]),
    ] },
    { id: 'zone_2', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] },
  ] };
  command(match, 'p0', { t: 'g.mizuki.importDungeon', dungeon, sourceLabel: 'floor recall native-schema fixture' });
}

function splitAndFight(match, childIds) {
  const choices = route(match, 'p0'); assert.equal(choices.length, 2);
  const leaderIds = match.order.map(player => player.playerId).filter(id => !childIds.includes(id));
  vote(match, leaderIds, choices[0].id); vote(match, childIds, choices[1].id);
  const requests = childIds.map(playerId => command(match, playerId,
    { t: 'g.mizuki.splitRequest', nodeId: choices[1].id }).request);
  for (const request of requests) command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: request.id, approve: true });
  depart(match); ready(match, [...leaderIds, ...childIds]);
  return leaderIds;
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
      const choices = view.rewards.filter(reward => !reward.selected
        && !view.rewards.some(selected => selected.group === reward.group && selected.selected));
      const reward = choices.find(value => value.type !== 'collectible' || !match.collectibles.includes(value.itemId)) || choices[0];
      assert.ok(reward, 'every unfinished reward group remains selectable');
      const result = match.handle(id, { t: 'g.mizuki.reward', rewardId: reward.id });
      assert.ok(result.ok || result.error === 'BAD_TARGET', JSON.stringify(result));
      acted = true;
    }
    if (!acted) break;
  }
  for (const id of ids) assert.notEqual(phase(match, id), PHASE.REWARD);
  skipMizukiRecruit(match, ids);
}

function assertHealthy(match, scheduler, errors) {
  assert.deepEqual(errors, []); assert.deepEqual(scheduler.errors, []);
  assert.doesNotThrow(() => { match.publicView(); for (const player of match.order) match.privateView(player.playerId); });
}

for (const count of [2, 4]) test(`${count} players: accepted recalls release at floor wait and each final-node ballot advances without leader action`, t => {
  const { match, scheduler, errors } = fixture(t, { count });
  enterRoute(match); importBranches(match);
  const childIds = count === 2 ? ['p1'] : ['p2', 'p3'];
  const leaderIds = splitAndFight(match, childIds);
  finishParty(match, scheduler, leaderIds);
  const request = command(match, 'p0', { t: 'g.mizuki.recallPropose', targetIds: childIds }).request;
  if (count === 4) for (const id of ['p1', 'p2']) command(match, id, { t: 'g.mizuki.recallVote', requestId: request.id, agree: true });
  vote(match, leaderIds, route(match, 'p0')[0].id); depart(match); ready(match, leaderIds);
  finishParty(match, scheduler, childIds);
  for (const id of childIds) command(match, id, { t: 'g.mizuki.recallRespond', requestId: request.id, accept: true });
  for (const id of childIds) assert.equal(party(match, id).recallHold?.role, 'returning');
  assert.equal(phase(match, 'p0'), PHASE.COMBAT, 'consent must never move doctors out of the leader battle');
  finishParty(match, scheduler, leaderIds);
  assert.equal(phase(match, 'p0'), WAITING);
  assert.equal(match.expedition.recalls.find(value => value.id === request.id).status, 'superseded');
  for (const id of childIds) {
    assert.equal(party(match, id).recallHold, undefined);
    assert.equal(phase(match, id), PHASE.ROUTE);
    const nodeId = route(match, id)[0].id;
    vote(match, [id], nodeId);
    assert.equal(phase(match, id), PHASE.PREP, 'a ready 1/1 branch cannot depend on a waiting leader button');
    const battleId = match.fields.get('n:' + id).battleId;
    assert.notEqual(match.handle(id, { t: 'g.mizuki.route', nodeId }).ok, true);
    assert.equal(match.fields.get('n:' + id).battleId, battleId, 'duplicate route packets cannot create another battle');
    ready(match, [id]);
  }
  for (const id of childIds) finishParty(match, scheduler, [id]);
  assert.equal(match.expedition.parties.size, 1);
  assert.deepEqual(party(match, 'p0').memberIds, match.order.map(player => player.playerId));
  for (const player of match.order) {
    assert.equal(phase(match, player.playerId), PHASE.ROUTE);
    assert.equal(match.partyStates.get(party(match, player.playerId).id).explorationState.zoneKey, '1');
  }
  assertHealthy(match, scheduler, errors);
});

test('ordinary leader route still requires confirmation, and a waiting leader cannot bypass missing child ballots', t => {
  const { match, scheduler, errors } = fixture(t, { count: 4 }); enterRoute(match); importBranches(match);
  const choices = route(match, 'p0'); vote(match, ['p0', 'p1', 'p2', 'p3'], choices[0].id);
  assert.equal(match.fields.size, 0); assert.equal(phase(match, 'p0'), PHASE.ROUTE);
  assert.notEqual(match.handle('p2', { t: 'g.mizuki.routeStart' }).ok, true);
  // Change the child choice and split only after the normal confirmation check.
  const leaderIds = splitAndFight(match, ['p2', 'p3']);
  finishParty(match, scheduler, leaderIds);
  vote(match, leaderIds, route(match, 'p0')[0].id); depart(match); ready(match, leaderIds);
  finishParty(match, scheduler, leaderIds); assert.equal(phase(match, 'p0'), WAITING);
  assert.equal(phase(match, 'p2'), PHASE.COMBAT, 'floor arrival never transfers a running branch');
  finishParty(match, scheduler, ['p2', 'p3']);
  const nodeId = route(match, 'p2')[0].id;
  vote(match, ['p2'], nodeId); assert.equal(phase(match, 'p2'), PHASE.ROUTE);
  vote(match, ['p3'], nodeId); assert.equal(phase(match, 'p2'), PHASE.PREP);
  assertHealthy(match, scheduler, errors);
});

test('Boss waiting rendezvous accepts the last branch ballot and enters the merged Boss preparation', t => {
  const { match, scheduler, errors } = fixture(t, { count: 4 }); enterRoute(match); importBranches(match, { boss: true });
  const leaderIds = splitAndFight(match, ['p2', 'p3']);
  finishParty(match, scheduler, leaderIds);
  const bossId = route(match, 'p0').find(node => node.type === 'boss').id;
  vote(match, leaderIds, bossId); depart(match);
  assert.equal(phase(match, 'p0'), WAITING); assert.equal(match.expedition.barrier.kind, 'boss');
  finishParty(match, scheduler, ['p2', 'p3']);
  vote(match, ['p2'], bossId); assert.equal(phase(match, 'p2'), PHASE.ROUTE);
  vote(match, ['p3'], bossId);
  assert.equal(match.expedition.parties.size, 1);
  for (const player of match.order) assert.equal(phase(match, player.playerId), PHASE.PREP);
  assert.equal(match.fields.size, 2);
  for (const field of match.fields.values()) { assert.equal(field.kind, 'boss'); assert.equal(field.players.length, 2); }
  assertHealthy(match, scheduler, errors);
});

for (const action of ['onDisconnect', 'onLeave']) test(`waiting leader releases a ready branch when its missing voter ${action === 'onLeave' ? 'leaves' : 'disconnects'}`, t => {
  const { match, scheduler, errors } = fixture(t, { count: 4 }); enterRoute(match); importBranches(match);
  const leaderIds = splitAndFight(match, ['p2', 'p3']);
  finishParty(match, scheduler, leaderIds);
  vote(match, leaderIds, route(match, 'p0')[0].id); depart(match); ready(match, leaderIds);
  finishParty(match, scheduler, leaderIds); finishParty(match, scheduler, ['p2', 'p3']);
  assert.equal(phase(match, 'p0'), WAITING);
  vote(match, ['p2'], route(match, 'p2')[0].id); assert.equal(phase(match, 'p2'), PHASE.ROUTE);
  match[action]('p3');
  assert.equal(phase(match, 'p2'), PHASE.PREP);
  assert.ok(match.fields.has('n:p2'));
  assertHealthy(match, scheduler, errors);
});

for (const connected of [true, false]) test(`old 1/1-vote floor checkpoint unlocks ${connected ? 'during online restore' : 'when the branch reconnects'}`, t => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); importBranches(match);
  const leaderIds = splitAndFight(match, ['p1']);
  finishParty(match, scheduler, leaderIds);
  vote(match, leaderIds, route(match, 'p0')[0].id); depart(match); ready(match, leaderIds);
  finishParty(match, scheduler, leaderIds); finishParty(match, scheduler, ['p1']);
  assert.equal(phase(match, 'p0'), WAITING); assert.equal(phase(match, 'p1'), PHASE.ROUTE);
  const child = party(match, 'p1'), nodeId = route(match, 'p1')[0].id;
  const doc = structuredClone(match.exportCheckpoint());
  // This is the exact persisted pre-fix deadlock: valid route plus all votes,
  // without a callable leader departure control on the waiting screen.
  doc.mizuki.expedition.parties.find(value => value.id === child.id).votes = { p1: nodeId };
  doc.mizuki.partyStates.find(([id]) => id === child.id)[1].votes = { p1: nodeId };
  const restored = fixture(t, { connected });
  assert.equal(restored.match.restoreCheckpoint(doc), true);
  if (!connected) {
    assert.equal(phase(restored.match, 'p1'), PHASE.ROUTE);
    restored.match.onReconnect('p1');
  }
  assert.equal(phase(restored.match, 'p1'), PHASE.PREP);
  assert.ok(restored.match.fields.has('n:p1'));
  assert.equal(phase(restored.match, 'p0'), WAITING);
  assertHealthy(match, scheduler, errors);
  assertHealthy(restored.match, restored.scheduler, restored.errors);
});
