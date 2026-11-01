import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiTeamExpedition } from '../server/modes/mizuki/TeamExpedition.js';

const ids = ['p0', 'p1', 'p2', 'p3'];
const choices = ['fixture-left', 'fixture-right'];
function create(targets = ['p3']) {
  const state = new MizukiTeamExpedition({ players: ids.map((playerId, seat) => ({ playerId, seat })),
    leaderId: 'p0', context: { zoneKey: 'fixture-floor', cursor: null } });
  for (const id of ids) state.vote(id, targets.includes(id) ? choices[1] : choices[0], choices);
  const requests = targets.map(id => state.requestSplit(id, choices[1], choices).request);
  for (const request of requests) assert.equal(state.decideSplit('p0', request.id, true, choices).ok, true);
  return state;
}
function propose(state, targets = ['p3']) {
  const response = state.proposeRecall('p0', targets); assert.equal(response.ok, true);
  return state.recalls.find(request => request.id === response.request.id);
}
function pass(state, request) {
  assert.equal(state.voteRecall('p1', request.id, true).ok, true);
  assert.equal(state.voteRecall('p2', request.id, true).ok, true);
  assert.equal(request.status, 'scheduled');
}
function complete(state, playerId) {
  const party = state.partyFor(playerId);
  state.setPhase(party.id, 'COMBAT');
  assert.equal(state.completeNode(party.id, { context: { zoneKey: 'fixture-floor', cursor: playerId } }).ok, true);
  return state.resolveRecalls();
}

test('only leader proposes a unique recall of other branches, without changing membership', () => {
  const state = create(), before = state.checkpoint();
  assert.equal(state.proposeRecall('p1', ['p3']).error, 'NOT_LEADER');
  for (const targetIds of [[], ['p3','p3'], ['p1'], ['p0'], ['outsider']]) assert.equal(state.proposeRecall('p0', targetIds).ok, false);
  assert.deepEqual(state.checkpoint(), before);
  const request = propose(state);
  assert.deepEqual(request.due, { leader: 0, targets: { p3: 0 } });
  assert.equal(state.proposeRecall('p0', ['p3']).error, 'ALREADY');
  assert.deepEqual(state.partyFor('p3').memberIds, ['p3']);
});

test('four-person team ballot needs three yes votes, and a tie does not authorize recall', () => {
  const state = create(), request = propose(state);
  state.voteRecall('p1', request.id, true);
  assert.equal(request.status, 'voting');
  state.voteRecall('p2', request.id, false); state.voteRecall('p3', request.id, false);
  assert.equal(request.status, 'rejected');
  assert.equal(state.respondRecall('p3', request.id, true).ok, false);
  assert.equal(state.voteRecall('outsider', request.id, true).ok, false);
});

test('a majority cannot override target refusal or the absence of consent', () => {
  const state = create(), request = propose(state); pass(state, request);
  state.resolveRecalls();
  assert.notEqual(state.partyFor('p0').id, state.partyFor('p3').id);
  assert.equal(state.partyFor('p0').recallHold, undefined);
  assert.equal(state.respondRecall('p1', request.id, true).ok, false);
  assert.equal(state.respondRecall('p3', request.id, false).ok, true);
  state.resolveRecalls(); assert.equal(request.status, 'rejected');
  assert.notEqual(state.partyFor('p0').id, state.partyFor('p3').id);
});

test('consenting target waits at the safe boundary while leader finishes, then moves once to leader route', () => {
  const state = create(), leader = state.partyFor('p0'), source = state.partyFor('p3');
  state.setPhase(source.id, 'COMBAT');
  const request = propose(state); pass(state, request);
  state.setPhase(leader.id, 'COMBAT');
  complete(state, 'p3');
  assert.equal(state.respondRecall('p3', request.id, true).ok, true);
  const first = state.resolveRecalls(); assert.equal(first.moved.length, 0);
  assert.equal(source.recallHold.role, 'returning');
  assert.equal(state.choice(source.id), null);
  assert.equal(state.vote('p3', choices[1], choices).ok, false);
  assert.equal(state.canSpectate('p3', leader.id), true);
  state.completeNode(leader.id, { context: { zoneKey: 'fixture-floor', cursor: 'leader-route' } });
  const result = state.resolveRecalls();
  assert.deepEqual(result.moved, [{ playerId: 'p3', fromPartyId: source.id, toPartyId: leader.id }]);
  assert.deepEqual(result.removedPartyIds, [source.id]);
  assert.equal(request.status, 'completed'); assert.equal(state.parties.size, 1);
  assert.equal(state.partyFor('p3').context.cursor, 'leader-route');
  assert.equal(state.memberContexts.p3.cursor, 'p3');
  assert.equal(state.partyFor('p0').recallHold, undefined);
  assert.equal(state.resolveRecalls().changed, false);
});

test('late consent after the leader passes the due node waits for the current node and then joins', () => {
  const state = create(), leader = state.partyFor('p0'), source = state.partyFor('p3');
  state.setPhase(source.id, 'COMBAT');
  const request = propose(state); pass(state, request);
  assert.equal(state.recallPrompt('p3'), null);
  assert.equal(state.respondRecall('p3', request.id, true).error, 'WRONG_PHASE');

  complete(state, 'p0');
  assert.ok(leader.completedNodes > request.due.leader);
  state.setPhase(leader.id, 'COMBAT');
  complete(state, 'p3');
  assert.equal(state.recallPrompt('p3').requestId, request.id);
  assert.equal(state.respondRecall('p3', request.id, true).ok, true);
  assert.equal(state.resolveRecalls().moved.length, 0);
  assert.equal(source.recallHold.role, 'returning');
  assert.equal(state.choice(source.id), null);
  assert.equal(state.vote('p3', choices[1], choices).ok, false);
  assert.equal(leader.phase, 'COMBAT');
  assert.notEqual(state.partyFor('p3').id, leader.id);

  assert.equal(state.completeNode(leader.id, { context: { zoneKey: 'fixture-floor', cursor: 'leader-after-next-node' } }).ok, true);
  const result = state.resolveRecalls();
  assert.deepEqual(result.moved, [{ playerId: 'p3', fromPartyId: source.id, toPartyId: leader.id }]);
  assert.equal(state.partyFor('p3').context.cursor, 'leader-after-next-node');
  assert.equal(request.status, 'completed');
  assert.equal(state.partyFor('p3').recallHold, undefined);
  assert.equal(state.resolveRecalls().moved.length, 0);
});

test('a leader on the route never pulls a target out of its node and joins after its confirmation', () => {
  const state = create(), targetParty = state.partyFor('p3');
  state.setPhase(targetParty.id, 'COMBAT');
  const request = propose(state); pass(state, request);
  complete(state, 'p0');
  assert.equal(state.recallPrompt('p3'), null);
  assert.equal(state.respondRecall('p3', request.id, true).error, 'WRONG_PHASE');
  assert.equal(state.partyFor('p3').phase, 'COMBAT');
  state.completeNode(targetParty.id);
  assert.equal(state.recallPrompt('p3').requestId, request.id);
  assert.equal(state.respondRecall('p3', request.id, true).ok, true);
  assert.equal(state.resolveRecalls().moved.length, 1);
  assert.equal(state.parties.size, 1);
  assert.equal(request.status, 'completed');
});

test('one doctor recalled from a group waits separately while its uninvited partner keeps the branch', () => {
  const state = create(['p2','p3']), original = state.partyFor('p2');
  state.setPhase(original.id, 'COMBAT');
  const request = propose(state, ['p2']); pass(state, request);
  state.setPhase(state.partyFor('p0').id, 'COMBAT');
  complete(state, 'p2');
  assert.equal(state.respondRecall('p2', request.id, true).ok, true);
  const result = state.resolveRecalls();
  assert.deepEqual(result.created, [{ partyId: state.partyFor('p2').id, sourcePartyId: original.id }]);
  assert.deepEqual(original.memberIds, ['p3']); assert.equal(original.recallHold, undefined);
  assert.deepEqual(state.partyFor('p2').memberIds, ['p2']);
  assert.equal(state.partyFor('p2').recallHold.role, 'returning');
  assert.equal(state.vote('p3', choices[1], choices).ok, true);
  assert.equal(state.choice(original.id), choices[1]);
  complete(state, 'p0');
  assert.deepEqual(state.partyFor('p0').memberIds, ['p0','p1','p2']);
  assert.deepEqual(state.partyFor('p3').memberIds, ['p3']);
});

test('a mixed consent request moves only accepted doctors', () => {
  const state = create(['p2','p3']), request = propose(state, ['p2','p3']); pass(state, request);
  state.respondRecall('p2', request.id, true); state.respondRecall('p3', request.id, false);
  const result = state.resolveRecalls();
  assert.deepEqual(result.moved.map(value => value.playerId), ['p2']);
  assert.equal(request.status, 'completed');
  assert.notEqual(state.partyFor('p3').id, state.partyFor('p0').id);
});

test('floor and Boss mandatory rendezvous supersede recalls and release held doctors', () => {
  for (const kind of ['floor','boss']) {
    const state = create(), request = propose(state); pass(state, request);
    state.setPhase(state.partyFor('p0').id, 'COMBAT');
    state.respondRecall('p3', request.id, true); state.resolveRecalls();
    assert.equal(state.partyFor('p3').recallHold.role, 'returning');
    const result = state.arrive(state.partyFor('p3').id, { kind, key: 'fixture-rendezvous' });
    assert.equal(result.ok, true); assert.equal(request.status, 'superseded');
    assert.equal(state.partyFor('p0').recallHold, undefined);
    assert.equal(state.proposeRecall('p0', ['p3']).error, 'WRONG_PHASE');
    complete(state, 'p0');
    assert.equal(state.arrive(state.partyFor('p0').id, { kind, key: 'fixture-rendezvous' }).merged, true);
  }
});

test('recall ballot and held branch checkpoint roundtrip, old saves work and forged consent is rejected', () => {
  const state = create(), request = propose(state); pass(state, request);
  state.setPhase(state.partyFor('p0').id, 'COMBAT');
  state.respondRecall('p3', request.id, true); state.resolveRecalls();
  assert.equal(state.partyFor('p3').recallHold.role, 'returning');
  const doc = state.checkpoint(), restored = MizukiTeamExpedition.restore(doc);
  assert.deepEqual(restored.view(), state.view());
  complete(restored, 'p0'); assert.equal(restored.parties.size, 1);
  const variants = [
    value => { value.recallSequence = 0; },
    value => { value.recalls[0].responses.p3 = false; },
    value => { value.recalls[0].votes = { p0: true }; },
    value => { value.recalls[0].due.targets.p3 = -1; },
    value => { value.recalls[0].returnedIds = ['p1']; },
    value => { value.recalls[0].electorate.push('p3'); },
    value => { value.recalls[0].targetIds = ['p3','p3']; },
  ];
  for (const mutate of variants) { const invalid = structuredClone(doc); mutate(invalid); assert.throws(() => MizukiTeamExpedition.restore(invalid)); }
  const legacy = create().checkpoint(); delete legacy.recalls; delete legacy.recallSequence;
  assert.deepEqual(MizukiTeamExpedition.restore(legacy).recalls, []);
});

test('leaving cancels an outstanding appointment and never strands the waiting branch', () => {
  const state = create(), request = propose(state); pass(state, request);
  state.setPhase(state.partyFor('p0').id, 'COMBAT');
  state.respondRecall('p3', request.id, true); state.resolveRecalls();
  assert.equal(state.partyFor('p3').recallHold.role, 'returning');
  state.removeMember('p3');
  assert.equal(request.status, 'cancelled'); assert.equal(state.partyFor('p0').recallHold, undefined);
  assert.doesNotThrow(() => MizukiTeamExpedition.restore(state.checkpoint()));
});
