import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { createMizukiRouteEvent } from '../server/modes/mizuki/RouteEvents.js';
import { validMizukiRecruitTicket } from '../server/modes/mizuki/Recruitment.js';
import { acceptMizukiRouteMission } from '../server/modes/mizuki/RouteMissions.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const copy = value => structuredClone(value);

function fixture(t, type = 'BATTLE_SHOP', { start = true, seed = 722, enter = true } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const options = { scheduler, data: DATA, roomCode: 'SRCT', hostId: 'p0', seed,
    seats: [{ playerId: 'p0', seat: 0, connected: true }],
    dungeon: { zones: [{ id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type, next: [{ x: 1, y: 0 }] },
      { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
    ] }] }, log: { info() {}, warn() {}, error() {} }, send() {}, broadcast() {}, onEnd() {} };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); });
  if (!start) return match;
  match.start();
  command(match, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  command(match, { t: 'g.mizuki.strategy', bandId: 'band_amiya' });
  command(match, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  command(match, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  const choices = match.privateView('p0').mizuki.recruit.choices;
  const choice = choices.find(value => value.available && value.hopeCost === 0) || choices.find(value => value.available);
  assert.ok(choice); command(match, { t: 'g.mizuki.recruit', offerId: choice.offerId });
  skipMizukiRecruit(match); assert.equal(match.phase, PHASE.ROUTE);
  const player = match.players.get('p0');
  player.hope = 100; player.hopeCapacity = 100; player.gold = 100;
  if (!enter) return match;
  const node = match.privateView('p0').mizuki.route.find(value => value.available);
  assert.ok(node); command(match, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, { t: 'g.mizuki.routeStart' });
  assert.equal(match.privateView('p0').mizuki.phase, type === 'BATTLE_SHOP' ? PHASE.SHOP : PHASE.EVENT);
  return match;
}

function command(match, message) {
  const result = match.handle('p0', message);
  assert.equal(result.ok, true, JSON.stringify({ message, result }));
  return result;
}

function recover(t, match, type) {
  const document = copy(match.exportCheckpoint());
  assert.ok(document);
  return recoverDocument(t, match, type, document);
}

function recoverDocument(t, match, type, document) {
  const recovered = fixture(t, type, { start: false, seed: match.seed });
  assert.equal(recovered.restoreCheckpoint(document), true, 'a legitimately awarded source ticket must restore');
  assert.equal(recovered.privateView('p0').mizuki.phase, PHASE.RECRUIT);
  assert.deepEqual(recovered.players.get('p0').tickets, document.players.find(value => value.playerId === 'p0').tickets);
  return recovered;
}

function renamePendingTicket(document, previousId, nextId) {
  const player = document.players.find(value => value.playerId === 'p0');
  const ticket = player.tickets.find(value => value.id === previousId);
  assert.ok(ticket); ticket.id = nextId;
  assert.ok(player.recruit.ticketIds.includes(previousId));
  player.recruit.ticketIds = player.recruit.ticketIds.map(value => value === previousId ? nextId : value);
  for (const key of ['activeTicketId', 'ticketId', 'selectedTicketId'])
    if (player.recruit[key] === previousId) player.recruit[key] = nextId;
  return ticket;
}

function eventTicket(match) {
  match._withParty(match.expedition.partyFor('p0'), () => {
    const state = { eventKey: 'prts_ro2_event_3', sceneIndex: 0, revision: 0, history: [], restUsed: [] };
    match.event = { ...createMizukiRouteEvent(match.currentNode, { ...match._routeEventContext(), event: { state } }), votes: {} };
    match.votes = {};
  });
  command(match, { t: 'g.mizuki.event', choiceId: 'choice_ro2_recruit1_1' });
  const player = match.players.get('p0');
  return player.tickets.find(value => value.id === player.recruit.activeTicketId);
}

function buySourceTicket(match, itemId) {
  const player = match.players.get('p0');
  // Put a real original ticket in one existing merchant slot; purchase, item
  // grant, opening and continuation still use the actual command pipeline.
  const offer = player.shop.offers.find(value => value.type === 'recruitTicket' && !value.sold);
  assert.ok(offer); offer.itemId = itemId;
  const goldBefore = player.gold;
  command(match, { t: 'g.mizuki.buy', offerId: offer.offerId });
  assert.equal(player.gold, goldBefore - offer.price);
  assert.equal(offer.sold, true);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.RECRUIT);
  const ticket = player.tickets.find(value => value.id === player.recruit.activeTicketId);
  assert.ok(ticket); assert.equal(ticket.sourceItemId, itemId);
  assert.equal(validMizukiRecruitTicket(ticket, { catalog: match.fullCatalog }), true, 'native source flags remain a valid opened ticket');
  return ticket;
}

for (const [name, itemId, expected] of [
  ['ordinary profession', 'rogue_2_recruit_ticket_pioneer', { kind: 'normal', professions: ['PIONEER'] }],
  ['double profession', 'rogue_2_recruit_ticket_double_1', { kind: 'normal', professions: ['WARRIOR', 'PIONEER'] }],
  ['quadruple profession', 'rogue_2_recruit_ticket_quad_melee', { kind: 'normal', professions: ['WARRIOR', 'TANK', 'SPECIAL', 'PIONEER'] }],
  ['full roster', 'rogue_2_recruit_ticket_all', { kind: 'advanced', professions: [] }],
  ['temporary promoted five star', 'rogue_2_recruit_ticket_temp_5_up', { kind: 'advanced', professions: [], temporary: true }],
]) {
  test(name + ' source voucher buys, restores and actually recruits through the original continuation', t => {
    const match = fixture(t);
    const ticket = buySourceTicket(match, itemId);
    assert.equal(ticket.kind, expected.kind); assert.deepEqual(ticket.preferredProfessions, expected.professions);
    if (expected.temporary) {
      assert.equal(ticket.freeHope, true); assert.equal(ticket.directPromotion, true);
      assert.equal(ticket.randomCandidateCount, 1); assert.equal(ticket.candidates.length, 1);
    }
    const restored = recover(t, match, 'BATTLE_SHOP'), player = restored.players.get('p0');
    const view = restored.privateView('p0').mizuki.recruit;
    const choice = view.choices.find(value => value.available); assert.ok(choice);
    if (expected.temporary) { assert.equal(choice.rarity, 5); assert.equal(choice.hopeCost, 0); }
    const beforeHope = player.hope, beforeCount = player.roster.length;
    command(restored, { t: 'g.mizuki.recruit', offerId: choice.offerId });
    assert.equal(player.hope, beforeHope - choice.hopeCost);
    assert.equal(player.roster.length, beforeCount + 1);
    const unit = player.roster.find(value => value.operatorId === choice.operatorId); assert.ok(unit);
    if (expected.temporary) { assert.equal(unit.promotion, 1); assert.equal(unit.chessId, choice.promotionChessId); }
    assert.equal(player.tickets.find(value => value.id === ticket.id).status, 'used');
    assert.equal(restored.privateView('p0').mizuki.phase, PHASE.SHOP);
    const after = copy(player.roster), hopeAfter = player.hope;
    assert.notEqual(restored.handle('p0', { t: 'g.mizuki.recruit', offerId: choice.offerId }).ok, true);
    assert.deepEqual(player.roster, after); assert.equal(player.hope, hopeAfter);
  });
}

test('native promotion voucher restores its real owner and upgrades the existing UID for free', t => {
  const match = fixture(t), player = match.players.get('p0');
  const operator = match.fullCatalog.operators.find(value => value.profession === 'PIONEER' && value.rarity === 4 && value.promotionChessId);
  assert.ok(operator); const unit = match._grantMetaChess(player, operator.operatorId); assert.ok(unit);
  const ticket = buySourceTicket(match, 'rogue_2_upgrade_ticket_pioneer');
  assert.equal(ticket.promotionOnly, true); assert.equal(ticket.freeHope, true);
  assert.deepEqual(ticket.allowedProfessions, ['PIONEER']);
  const restored = recover(t, match, 'BATTLE_SHOP'), recovered = restored.players.get('p0');
  const choice = restored.privateView('p0').mizuki.recruit.choices.find(value => value.operatorId === operator.operatorId);
  assert.ok(choice?.available); assert.equal(choice.canUpgrade, true); assert.equal(choice.hopeCost, 0);
  const count = recovered.roster.length, hope = recovered.hope;
  command(restored, { t: 'g.mizuki.recruit', offerId: choice.offerId });
  assert.equal(recovered.roster.length, count); assert.equal(recovered.hope, hope);
  const promoted = recovered.roster.find(value => value.uid === unit.uid);
  assert.equal(promoted.promotion, 1); assert.equal(promoted.chessId, operator.promotionChessId);
  assert.equal(recovered.tickets.find(value => value.id === ticket.id).status, 'used');
  assert.equal(restored.privateView('p0').mizuki.phase, PHASE.SHOP);
});

test('an original two profession event voucher restores and actually recruits before completing its event', t => {
  const match = fixture(t, 'INCIDENT'), player = match.players.get('p0');
  const beforeGold = player.gold;
  const ticket = eventTicket(match);
  assert.equal(player.gold, beforeGold - 2);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.RECRUIT);
  assert.ok(ticket); assert.equal(ticket.preferredProfessions.length, 2);
  assert.equal(validMizukiRecruitTicket(ticket, { catalog: match.fullCatalog }), true);
  const restored = recover(t, match, 'INCIDENT'), recovered = restored.players.get('p0');
  const choice = restored.privateView('p0').mizuki.recruit.choices.find(value => value.available); assert.ok(choice);
  const beforeCount = recovered.roster.length, beforeHope = recovered.hope;
  command(restored, { t: 'g.mizuki.recruit', offerId: choice.offerId });
  assert.equal(recovered.roster.length, beforeCount + 1); assert.equal(recovered.hope, beforeHope - choice.hopeCost);
  assert.equal(recovered.tickets.find(value => value.id === ticket.id).status, 'used');
  assert.equal(restored.privateView('p0').mizuki.phase, PHASE.ROUTE);
});

for (const [origin, nodeType, receive] of [
  ['mzsource', 'BATTLE_SHOP', match => buySourceTicket(match, 'rogue_2_recruit_ticket_pioneer')],
  ['mzevent', 'INCIDENT', eventTicket],
]) {
  test('legacy ' + origin + ' voucher restores all references and then actually recruits', t => {
    const match = fixture(t, nodeType), ticket = receive(match);
    const seq = /^mz(\d+)p/.exec(ticket.id)?.[1]; assert.ok(seq);
    const legacyId = origin + ':' + seq + ':0';
    const document = copy(match.exportCheckpoint());
    const renamed = renamePendingTicket(document, ticket.id, legacyId);
    assert.equal(validMizukiRecruitTicket(renamed, { catalog: match.fullCatalog }), true);
    const restored = recoverDocument(t, match, nodeType, document), player = restored.players.get('p0');
    const recruit = restored.privateView('p0').mizuki.recruit;
    assert.equal(recruit.activeTicketId, legacyId); assert.equal(recruit.ticket.id, legacyId);
    assert.ok(recruit.skipToken.includes(legacyId));
    assert.ok(recruit.refreshToken.includes(legacyId));
    const choice = recruit.choices.find(value => value.available); assert.ok(choice);
    assert.ok(choice.offerId.includes(legacyId), 'new offer tokens are rebuilt from the legacy owner ticket');
    const before = player.roster.length, hope = player.hope;
    command(restored, { t: 'g.mizuki.recruit', offerId: choice.offerId });
    assert.equal(player.roster.length, before + 1); assert.equal(player.hope, hope - choice.hopeCost);
    assert.equal(player.tickets.find(value => value.id === legacyId).status, 'used');
    assert.equal(restored.privateView('p0').mizuki.phase, nodeType === 'BATTLE_SHOP' ? PHASE.SHOP : PHASE.ROUTE);
  });
}

test('source voucher restore rejects foreign ownership and substring lookalikes with otherwise consistent references', t => {
  const match = fixture(t), ticket = buySourceTicket(match, 'rogue_2_recruit_ticket_pioneer');
  const seq = /^mz(\d+)p/.exec(ticket.id)?.[1]; assert.ok(seq);
  for (const id of ['mz' + seq + 'p1tsource', 'mzsource:' + seq + ':1', 'mzevent:' + seq + ':1', 'mzmission:' + seq + ':1',
    'untrustedp0t', 'mz' + seq + 'p1tsourcep0t', 'mzsource:' + seq + ':0:1']) {
    const document = copy(match.exportCheckpoint());
    const renamed = renamePendingTicket(document, ticket.id, id);
    assert.equal(validMizukiRecruitTicket(renamed, { catalog: match.fullCatalog }), true, 'only ownership/format is invalid: ' + id);
    const recovered = fixture(t, 'BATTLE_SHOP', { start: false });
    assert.equal(recovered.restoreCheckpoint(document), false, id + ' cannot masquerade as seat zero');
  }
});

for (const legacy of [false, true]) {
  test((legacy ? 'legacy' : 'current') + ' commission joint voucher actually awards, restores, recruits and completes once', t => {
    // Seed 725 naturally contains the native two-profession reward in its
    // first rare-commission category. Do not replace canonical reward arrays.
    const match = fixture(t, 'MISSION', { seed: 725, enter: false });
    const missionNode = match.privateView('p0').mizuki.route.find(value => value.graphType === 'MISSION');
    assert.ok(missionNode);
    const mission = acceptMizukiRouteMission(match.routeMissions, { taskId: 'rogue_2_task_012',
      nodeId: missionNode.id, memberIds: ['p0'], seed: match.seed });
    assert.ok(mission); assert.equal(mission.status, 'active');
    match._withParty(match.expedition.partyFor('p0'), () => match._routeMissionProgress({ diceUsed: 1, diceRoll: 6 }));
    assert.equal(mission.status, 'complete');
    command(match, { t: 'g.mizuki.missionClaim', missionId: mission.id });
    assert.equal(match.privateView('p0').mizuki.phase, PHASE.EVENT);
    const reward = match.privateView('p0').mizuki.event.choices.find(value => value.id === 'choice_ro2_taskreward2_2');
    assert.ok(reward?.available);
    command(match, { t: 'g.mizuki.event', choiceId: reward.id });
    assert.equal(mission.status, 'claimed');
    assert.equal(match.privateView('p0').mizuki.phase, PHASE.RECRUIT);
    const player = match.players.get('p0'), ticket = player.tickets.find(value => value.id === player.recruit.activeTicketId);
    assert.ok(ticket); assert.equal(ticket.preferredProfessions.length, 2);
    const document = copy(match.exportCheckpoint());
    let ticketId = ticket.id;
    if (legacy) {
      const seq = /^mz(\d+)p/.exec(ticket.id)?.[1]; assert.ok(seq);
      ticketId = 'mzmission:' + seq + ':0'; renamePendingTicket(document, ticket.id, ticketId);
    }
    const restored = recoverDocument(t, match, 'MISSION', document), recovered = restored.players.get('p0');
    const choice = restored.privateView('p0').mizuki.recruit.choices.find(value => value.available);
    assert.ok(choice); assert.ok(choice.offerId.includes(ticketId));
    const count = recovered.roster.length, hope = recovered.hope;
    command(restored, { t: 'g.mizuki.recruit', offerId: choice.offerId });
    assert.equal(recovered.roster.length, count + 1); assert.equal(recovered.hope, hope - choice.hopeCost);
    assert.equal(recovered.tickets.find(value => value.id === ticketId).status, 'used');
    assert.equal(restored.privateView('p0').mizuki.phase, PHASE.ROUTE);
    const after = copy(recovered.roster), afterHope = recovered.hope;
    assert.notEqual(restored.handle('p0', { t: 'g.mizuki.missionClaim', missionId: mission.id }).ok, true);
    assert.deepEqual(recovered.roster, after); assert.equal(recovered.hope, afterHope);
  });
}
