import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const DUNGEON = { zones: [{ id: 'zone_1', variation: 'rogue_2_variation_8', nodes: [
  { pos: { x: 0, y: 0 }, type: 'WISH', next: [{ x: 1, y: 0 }] },
  { pos: { x: 1, y: 0 }, type: 'WISH', next: [{ x: 2, y: 0 }] },
  { pos: { x: 2, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
] }] };
const command = (match, id, message) => {
  const result = match.handle(id, message);
  assert.equal(result.ok, true, JSON.stringify({ id, message, result })); return result;
};
function fixture(t, seed) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const options = { data: DATA, scheduler, seed, cognition: { totalScore: 22400 }, roomCode: 'VVCH',
    hostId: 'p0', seats: [{ playerId: 'p0', seat: 0, connected: true }, { playerId: 'p1', seat: 1, connected: true }],
    dungeon: structuredClone(DUNGEON), send() {}, broadcast() {}, onEnd() {},
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) } };
  const match = new MizukiMatch(options); t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, options, errors };
}
function restored(t, options, match) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const result = new MizukiMatch({ ...options, scheduler, cognition: { totalScore: 0 } });
  t.after(() => { result.dispose(); scheduler.dispose(); });
  assert.equal(result.restoreCheckpoint(structuredClone(match.exportCheckpoint())), true); return result;
}
function opening(match, recruitSpecial) {
  match.start();
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.strategy', bandId: p.seat ? 'band_cathy' : 'band_amiya' });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  if (recruitSpecial) {
    for (let guard = 0; guard < 8 && match.phase === PHASE.RECRUIT; guard++) for (const p of match.order) {
      if (p.ready) continue;
      const view = match.privateView(p.playerId).mizuki.recruit;
      const choice = !p.roster.length && view.choices.find(value => value.available && value.profession === 'SPECIAL' && value.promotionChessId);
      command(match, p.playerId, { t: 'g.mizuki.recruit', offerId: choice?.offerId || view.skipToken });
    }
    assert.ok(match.order.every(p => p.roster.length === 1 && p.roster[0].profession === 'SPECIAL' && p.roster[0].promotion === 0));
  } else skipMizukiRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE); assert.equal(match.offerSeq, 1);
}
function enterNextWish(match) {
  const node = match.privateView('p0').mizuki.route.find(value => value.available); assert.equal(node.graphType, 'WISH');
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, 'p0', { t: 'g.mizuki.routeStart' }); return node.id;
}
function finishWish(match) {
  assert.equal(match.phase, PHASE.EVENT); const event = match.privateView('p0').mizuki.event;
  const choice = event.choices.find(value => value.available); assert.ok(choice);
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.event', choiceId: choice.id });
  if (match.privateView('p0').mizuki.sanCheck?.check.kind === 'wish') {
    const id = match.privateView('p0').mizuki.sanCheck.id;
    for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.sanVote', id, choice: 'accept' });
  }
  // A real wish reward may itself issue a native voucher. Consume it rather
  // than discarding a valid continuation while checking the variation grant.
  if (match.phase === PHASE.RECRUIT) skipMizukiRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE);
}

for (const scenario of [
  { seed: 20, relicId: 'rogue_2_relic_grace_70', sourceItemId: 'rogue_2_recruit_ticket_temp_6_up', promotion: false },
  { seed: 49, relicId: 'rogue_2_relic_grace_44', sourceItemId: 'rogue_2_upgrade_ticket_special', promotion: true },
]) {
  test('natural variation-eight ' + scenario.sourceItemId + ' restores and actually recruits before the original wish resumes', t => {
    const f = fixture(t, scenario.seed); opening(f.match, scenario.promotion);
    const firstNode = enterNextWish(f.match);
    assert.equal(f.match.phase, PHASE.RECRUIT); assert.equal(f.match.continuation, 'event');
    assert.equal(f.match.event.state.eventKey, 'prts_ro2_event_49'); assert.equal(f.match.event.id, firstNode);
    assert.equal(f.match.collectibles.filter(id => id === scenario.relicId).length, 1);
    const tickets = new Map(f.match.order.map(p => {
      const ticket = p.tickets.find(value => value.sourceItemId === scenario.sourceItemId && value.status === 'available');
      assert.ok(ticket); assert.ok(p.recruit.ticketIds.includes(ticket.id));
      return [p.playerId, ticket.id];
    }));
    const loaded = restored(t, f.options, f.match);
    assert.equal(loaded.event.id, firstNode); assert.equal(loaded.continuation, 'event');
    assert.equal(loaded.floorState.variations['0'].wishGranted, true);
    const accepted = [];
    for (const p of loaded.order) {
      const view = loaded.privateView(p.playerId).mizuki.recruit, ticket = view.ticket;
      assert.equal(ticket.id, tickets.get(p.playerId)); assert.equal(ticket.sourceItemId, scenario.sourceItemId);
      const before = { count: p.roster.length, hope: p.hope, uid: p.roster[0]?.uid };
      const choice = view.choices.find(value => value.available); assert.ok(choice); assert.equal(choice.hopeCost, 0);
      if (scenario.promotion) {
        assert.equal(ticket.promotionOnly, true); assert.deepEqual(ticket.allowedProfessions, ['SPECIAL']);
        assert.equal(choice.profession, 'SPECIAL'); assert.equal(choice.canUpgrade, true);
      } else { assert.equal(choice.rarity, 6); assert.equal(ticket.directPromotion, true); }
      command(loaded, p.playerId, { t: 'g.mizuki.recruit', offerId: choice.offerId });
      const unit = p.roster.find(value => value.operatorId === choice.operatorId); assert.ok(unit);
      assert.equal(unit.promotion, 1); assert.equal(unit.chessId, choice.promotionChessId);
      assert.equal(p.hope, before.hope); assert.equal(p.roster.length, before.count + (scenario.promotion ? 0 : 1));
      if (scenario.promotion) assert.equal(unit.uid, before.uid);
      assert.equal(p.tickets.find(value => value.id === ticket.id).status, 'used');
      accepted.push([p.playerId, choice.offerId]);
    }
    assert.equal(loaded.phase, PHASE.EVENT); assert.equal(loaded.event.id, firstNode);
    assert.equal(loaded.event.state.sceneIndex, 0); assert.equal(loaded.event.state.eventKey, 'prts_ro2_event_49');
    const count = loaded.order.map(p => p.roster.length), hope = loaded.order.map(p => p.hope);
    for (const [id, offerId] of accepted) assert.notEqual(loaded.handle(id, { t: 'g.mizuki.recruit', offerId }).ok, true);
    assert.deepEqual(loaded.order.map(p => p.roster.length), count); assert.deepEqual(loaded.order.map(p => p.hope), hope);
    const atWish = restored(t, f.options, loaded);
    assert.equal(atWish.phase, PHASE.EVENT); assert.equal(atWish.event.id, firstNode);
    finishWish(atWish);
    const afterWish = restored(t, f.options, atWish); assert.equal(afterWish.phase, PHASE.ROUTE);
    const oldTicketIds = afterWish.order.map(p => p.tickets.filter(value => value.sourceItemId === scenario.sourceItemId).map(value => value.id));
    enterNextWish(afterWish);
    assert.equal(afterWish.phase, PHASE.EVENT, 'a second wish in the same variation does not reissue the first-wish voucher');
    assert.deepEqual(afterWish.order.map(p => p.tickets.filter(value => value.sourceItemId === scenario.sourceItemId).map(value => value.id)), oldTicketIds);
    assert.equal(afterWish.collectibles.filter(id => id === scenario.relicId).length, 1);
    finishWish(afterWish);
    const final = restored(t, f.options, afterWish); assert.equal(final.phase, PHASE.ROUTE);
    for (const p of final.order) assert.ok(p.tickets.every(ticket => ticket.status !== 'available'));
    assert.deepEqual(f.errors, []);
  });
}
