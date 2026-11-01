import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiTeamExpedition } from '../server/modes/mizuki/TeamExpedition.js';
const ids = ['p0', 'p1', 'p2', 'p3'];
// These identifiers are state-machine fixtures, never a production route graph.
const choices = ['fixture-left', 'fixture-right', 'fixture-boss'];
const create = () => new MizukiTeamExpedition({ players: ids.map((playerId, seat) => ({ playerId, seat })),
  leaderId: 'p0', context: { zoneKey: 'fixture-zone', cursor: null, trace: [] } });
function voteAll(state) { for (const id of ids) assert.equal(state.vote(id, id === 'p3' ? choices[1] : choices[0], choices).ok, true); }
function splitOne(state, id = 'p3') {
  const request = state.requestSplit(id, choices[1], choices);
  assert.equal(request.ok, true);
  assert.equal(state.decideSplit('p0', request.request.id, true, choices).ok, true);
  return state.partyFor(id);
}
test('leader-approved single action produces 1+3 without moving other members', () => {
  const s = create(); voteAll(s);
  const one = splitOne(s); const three = s.partyFor('p0');
  assert.deepEqual(one.memberIds, ['p3']); assert.deepEqual(three.memberIds, ['p0', 'p1', 'p2']);
  assert.equal(s.choice(one.id), choices[1]); assert.equal(s.choice(three.id), choices[0]);
  assert.deepEqual(one.context, three.context);
  one.context.trace.push('fixture-independent'); assert.deepEqual(three.context.trace, []);
});
test('same-destination approved applications form 2+2 before either group starts', () => {
  const s = create(); voteAll(s); s.vote('p2', choices[1], choices);
  const a = s.requestSplit('p2', choices[1], choices), b = s.requestSplit('p3', choices[1], choices);
  assert.equal(s.choice('party-1'), null);
  assert.equal(s.decideSplit('p0', a.request.id, true, choices).ok, true);
  assert.equal(s.startNode(s.partyFor('p2').id, { id: choices[1], type: 'combat' }).ok, false);
  assert.equal(s.decideSplit('p0', b.request.id, true, choices).ok, true);
  assert.deepEqual(s.partyFor('p2').memberIds, ['p2', 'p3']); assert.deepEqual(s.partyFor('p0').memberIds, ['p0', 'p1']);
});
test('only leader decides; denial and duplicate or stale requests cannot move players', () => {
  const s = create(); voteAll(s); const r = s.requestSplit('p3', choices[1], choices);
  const before = s.checkpoint();
  assert.equal(s.decideSplit('p1', r.request.id, true, choices).error, 'NOT_LEADER');
  assert.deepEqual(s.checkpoint(), before);
  assert.equal(s.requestSplit('p3', choices[1], choices).error, 'ALREADY');
  assert.equal(s.decideSplit('p0', r.request.id, false, choices).ok, true);
  assert.equal(s.choice('party-1'), choices[0]); assert.equal(s.parties.size, 1);
  assert.equal(s.decideSplit('p0', r.request.id, true, choices).ok, false);
});
test('unavailable nodes and combat-phase split attempts are rejected atomically', () => {
  const s = create(); voteAll(s);
  assert.equal(s.requestSplit('p3', 'invented-node', choices).ok, false);
  assert.equal(s.startNode('party-1', { id: choices[0], type: 'combat' }).ok, true);
  assert.equal(s.requestSplit('p3', choices[1], choices).error, 'WRONG_PHASE');
  assert.equal(s.vote('p3', choices[1], choices).error, 'WRONG_PHASE');
});
test('earlier party can watch unfinished teammates and waits at the floor boundary', () => {
  const s = create(); voteAll(s); const one = splitOne(s), three = s.partyFor('p0');
  s.startNode(one.id, { id: choices[1], type: 'combat' }); s.startNode(three.id, { id: choices[0], type: 'combat' });
  s.setPhase(one.id, 'COMBAT'); s.setPhase(three.id, 'COMBAT');
  assert.equal(s.canSpectate('p3', three.id), false);
  s.completeNode(one.id, { context: { cursor: choices[1], trace: [choices[1]] } });
  assert.equal(s.canSpectate('p3', three.id), true);
  assert.equal(s.arrive(one.id, { kind: 'floor', key: 'fixture-zone' }).waiting, true);
  assert.equal(s.vote('p3', choices[0], choices).ok, false);
  assert.equal(s.canSpectate('p3', three.id), true);
  s.completeNode(three.id, { context: { cursor: choices[0], trace: [choices[0]] } });
  const result = s.arrive(three.id, { kind: 'floor', key: 'fixture-zone' });
  assert.equal(result.merged, true); assert.deepEqual(s.partyFor('p0').memberIds, ids);
  assert.deepEqual(s.memberContexts.p3.trace, [choices[1]]); assert.deepEqual(s.memberContexts.p0.trace, [choices[0]]);
});
test('Boss cannot start across separated parties and requires all-party rendezvous', () => {
  const s = create(); voteAll(s); const one = splitOne(s), three = s.partyFor('p0');
  assert.equal(s.startNode(one.id, { id: choices[1], type: 'boss' }).error, 'RENDEZVOUS_REQUIRED');
  s.arrive(one.id, { kind: 'boss', key: 'fixture-zone-boss' });
  assert.equal(s.arrive(three.id, { kind: 'boss', key: 'other-boss' }).error, 'OTHER_RENDEZVOUS');
  const gathered = s.arrive(three.id, { kind: 'boss', key: 'fixture-zone-boss' });
  assert.equal(gathered.merged, true);
  for (const id of ids) s.vote(id, choices[2], choices);
  assert.equal(s.startNode(gathered.partyId, { id: choices[2], type: 'boss' }).ok, true);
});
test('checkpoint retains pending approvals and independent progression, rejects duplicate membership', () => {
  const s = create(); voteAll(s); const one = splitOne(s);
  s.setContext(one.id, { zoneKey: 'fixture-zone', cursor: choices[1], trace: [choices[1]] });
  const restored = MizukiTeamExpedition.restore(s.checkpoint());
  assert.deepEqual(restored.checkpoint(), s.checkpoint());
  const bad = s.checkpoint(); bad.parties[0].memberIds.push('p3');
  assert.throws(() => MizukiTeamExpedition.restore(bad), /membership/);
  const pending = create(); voteAll(pending); pending.requestSplit('p3', choices[1], choices);
  assert.equal(MizukiTeamExpedition.restore(pending.checkpoint()).choice('party-1'), null);
});
test('tie uses the leader vote; departed members and pending applications are removed', () => {
  const s = create();
  for (const id of ids) s.vote(id, ['p0', 'p3'].includes(id) ? choices[1] : choices[0], choices);
  assert.equal(s.choice('party-1'), choices[1]);
  const r = s.requestSplit('p3', choices[1], choices);
  assert.equal(r.ok, true); s.removeMember('p3');
  assert.equal(s.requests[0].status, 'cancelled'); assert.equal(s.partyFor('p3'), null);
  assert.equal(s.choice('party-1'), choices[0]); s.removeMember('p0'); assert.equal(s.leaderId, 'p1');
});
test('restore rejects sequence collisions that could replace a party or replay an application', () => {
  const s = create(); voteAll(s); splitOne(s);
  const collision = s.checkpoint(); collision.sequence = 1;
  assert.throws(() => MizukiTeamExpedition.restore(collision), /sequence/);
  const replay = s.checkpoint(); replay.requestSequence = 0;
  assert.throws(() => MizukiTeamExpedition.restore(replay), /sequence/);
  const waiting = s.checkpoint(); waiting.parties[0].phase = 'WAITING';
  assert.throws(() => MizukiTeamExpedition.restore(waiting), /waiting/);
});
