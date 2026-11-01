import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { validMizukiRecruitTicket } from '../server/modes/mizuki/Recruitment.js';
import { createMizukiRecruitTicket } from '../server/modes/mizuki/Recruitment.js';

const data = getData({ log: { warn() {}, error() {}, info() {} } });
function fixture(t, count = 1) {
  const scheduler = new VirtualScheduler();
  const options = { data, scheduler, roomCode: 'MZKI', seed: 123,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat })),
    send() {}, broadcast() {}, onEnd() {} };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return match;
}
const recruitView = (match, playerId = 'p0') => match.privateView(playerId).mizuki.recruit;
function beginRecruit(match) {
  match.start();
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' }).ok, true);
  for (const [index, player] of match.order.entries()) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId }).ok, true);
  assert.equal(match.phase, PHASE.INITIAL_SUPPLY);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' }).ok, true);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' }).ok, true);
  assert.equal(match.phase, PHASE.RECRUIT);
}
function finishRecruit(match) {
  for (let guard = 0; guard < 30; guard++) {
    let pending = 0;
    for (const player of match.order.filter((value) => value.connected && !value.left)) {
      const view = recruitView(match, player.playerId);
      if (!view?.ticket) continue;
      pending++;
      assert.equal(match.handle(player.playerId, { t: 'g.mizuki.recruit', offerId: view.skipToken }).ok, true);
    }
    if (!pending) return;
  }
  assert.fail('Recruitment did not finish');
}
// Import a deterministic graph before exploration starts. These schema-only
// nodes carry real stages; this fixture makes no claim about official topology.
function beginRoute(match) {
  const dungeon = { zones: [{ id: 'zone_1', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
    { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
  ] }] };
  match.start();
  assert.deepEqual(match.handle(match.hostId, { t: 'g.mizuki.importDungeon', dungeon, sourceLabel: 'schema fixture' }), { ok: true });
  beginRecruit(match); finishRecruit(match); assert.equal(match.phase, PHASE.ROUTE);
}
function battleReward(match, playerId = 'p0') {
  const party = match.expedition.partyFor(playerId);
  match._withParty(party, () => { match.currentNode = { ...match.route.find((node) => node.type === 'combat') }; match._enterReward(); match._commit(); });
}
function selectRewards(match, playerId = 'p0') {
  const selected = [];
  for (let guard = 0; guard < 32; guard++) {
    const view = match.privateView(playerId).mizuki;
    if (view.phase !== PHASE.REWARD || view.ready) return selected;
    const reward = view.rewards.find(value => !value.selected
      && !view.rewards.some(choice => choice.group === value.group && choice.selected)
      && (value.type !== 'collectible' || !match.collectibles.includes(value.itemId)));
    assert.ok(reward, 'every outstanding reward group has an available choice');
    assert.equal(match.handle(playerId, { t: 'g.mizuki.reward', rewardId: reward.id }).ok, true);
    selected.push(reward);
  }
  assert.fail('reward groups did not finish');
}
function operatorChoice(match, player, operator) {
  match._refreshRecruit(player);
  const ticket = match._activeTicket(player);
  if (!ticket.candidates.includes(operator.operatorId)) {
    const index = ticket.candidates.findIndex(id => match.fullCatalog.byId.get(id).rarity === operator.rarity);
    assert.notEqual(index, -1, 'fixture retains the full two-per-rarity candidate page');
    ticket.candidates[index] = operator.operatorId;
  }
  return recruitView(match, player.playerId).choices.find(choice => choice.operatorId === operator.operatorId);
}

test('team resources remain public while each member retains personal health hope gold and tickets', (t) => {
  const match = fixture(t, 2); match.start();
  assert.equal(match.dice, 5);
  match.collectibles.push('rogue_2_band_1');
  const view = match.publicView().mizuki;
  assert.deepEqual(view.collectibles, ['rogue_2_band_1']);
  assert.deepEqual(view.resourceOwnership, { dice: 'team', light: 'team', collectibles: 'team',
    life: 'player', maxLife: 'player', shield: 'player', hope: 'player', gold: 'player', tickets: 'player' });
  match.players.get('p0').hope++;
  assert.equal(match.privateView('p0').mizuki.hope, 7);
  assert.equal(match.privateView('p1').mizuki.hope, 6);
  assert.equal(match.publicView().players[0].gold, undefined);
});

test('ordinary ticket pages retain two choices per available rarity and three free refreshes with stale action rejection', (t) => {
  const match = fixture(t); beginRecruit(match);
  const player = match.players.get('p0');
  const initial = recruitView(match);
  assert.equal(initial.ticket.count, 1);
  const availableRarities = [...new Set(match.fullCatalog.operators.map(operator => operator.rarity))];
  for (const rarity of availableRarities) assert.equal(initial.choices.filter(choice => choice.rarity === rarity).length,
    Math.min(2, match.fullCatalog.operators.filter(operator => operator.rarity === rarity).length));
  assert.equal(initial.choices.length, 6);
  assert.equal(initial.freeRefreshes, 3);
  const oldToken = initial.refreshToken, gold = player.gold, hope = player.hope;
  for (let i = 0; i < 3; i++) assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: recruitView(match).refreshToken }).ok, true);
  assert.equal(player.recruitRefreshes, 3);
  assert.equal(recruitView(match).freeRefreshes, 0);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: oldToken }).error, 'BAD_TARGET');
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: recruitView(match).refreshToken }).error, 'NO_FUNDS');
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: null }).error, 'BAD_TARGET');
  assert.equal(player.gold, gold); assert.equal(player.hope, hope);
  assert.ok(player.tickets.every((ticket) => validMizukiRecruitTicket(ticket, { catalog: match.fullCatalog })));
});

test('third ordinary copy promotes one owned unit and retains UID and equipment', (t) => {
  const match = fixture(t); beginRecruit(match);
  const player = match.players.get('p0'); player.hope = 999;
  const operator = match.fullCatalog.operators.find((value) => value.promotionChessId);
  let originalUid;
  const equipmentId = Object.keys(match.ds.raw.items).find((id) => match.gd.item(id));
  for (let count = 1; count <= 3; count++) {
    const choice = operatorChoice(match, player, operator);
    assert.equal(choice.action, count === 1 ? 'recruit' : count === 2 ? 'copy' : 'promote');
    assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: choice.offerId }).ok, true);
    const unit = player.roster[0];
    if (count === 1) { originalUid = unit.uid; unit.items = [{ kind: 'item', id: equipmentId, uid: 900001 }]; }
    assert.equal(player.roster.length, count === 2 ? 2 : 1); assert.equal(unit.uid, originalUid);
    assert.equal(unit.recruitCopies, count === 3 ? 3 : 1); assert.equal(unit.promotion, count === 3 ? 1 : 0);
    if (count === 2) {
      assert.notEqual(player.roster[1].uid, originalUid);
      assert.equal(player.roster[1].recruitCopies, 1);
    }
    assert.equal(unit.items[0].uid, 900001);
  }
  assert.equal(player.gainedChess, 2);
  assert.ok(player.tickets.slice(0, 3).every((ticket) => ticket.status === 'used' && ticket.recruited.length === 1));
});

test('battle offers two personal profession tickets, keeps one selection, and grants hope through commander level-up', (t) => {
  const match = fixture(t, 2); beginRoute(match);
  const counts = match.order.map((player) => player.tickets.length);
  const hopes = match.order.map((player) => player.hope);
  battleReward(match);
  assert.equal(match.phase, PHASE.REWARD);
  assert.deepEqual(match.commander, { level: 2, exp: 0, totalExp: 10 });
  const hopesAfterBattle = match.order.map((player) => player.hope);
  assert.deepEqual(hopesAfterBattle, hopes.map(hope => hope + 4));
  for (const [index, player] of match.order.entries()) {
    assert.equal(player.tickets.length, counts[index] + 2);
    const offeredTickets = player.rewards.filter(reward => reward.type === 'recruitTicket');
    assert.equal(offeredTickets.length, 2);
    assert.equal(new Set(offeredTickets.map(reward => reward.profession)).size, 2);
    const selected = selectRewards(match, player.playerId).filter(reward => reward.type === 'recruitTicket');
    assert.equal(selected.length, 1);
  }
  assert.equal(match.phase, PHASE.RECRUIT); assert.equal(match.continuation, 'battle');
  for (const [index, player] of match.order.entries()) {
    assert.equal(player.tickets.length, counts[index] + 2);
    assert.equal(player.tickets.slice(counts[index]).filter(ticket => ticket.status === 'available').length, 1);
    assert.equal(player.tickets.slice(counts[index]).filter(ticket => ticket.status === 'skipped').length, 1);
    assert.equal(player.recruit.ticketIds.length, 1);
  }
  finishRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE); assert.equal(match.completedNodes, 1);
  assert.deepEqual(match.order.map((player) => player.hope), hopesAfterBattle,
    'finishing a node must not fabricate an additional hope reward');
  assert.ok(match.order.every((player) => player.recruitRefreshes === 0));
});

test('offline tickets are skipped when online decisions finish and an all-offline group pauses', (t) => {
  const match = fixture(t, 2); beginRecruit(match);
  match.onDisconnect('p1'); finishRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE);
  assert.ok(match.players.get('p1').tickets.every((ticket) => ticket.status === 'skipped'));
  battleReward(match);
  match.onDisconnect('p0');
  assert.equal(match.phase, PHASE.REWARD);
  match._advanceOnlineActors(); assert.equal(match.phase, PHASE.REWARD);
  match.onReconnect('p0');
  selectRewards(match);
  finishRecruit(match); assert.equal(match.completedNodes, 1);
});

test('v4 checkpoints retain ticket pages counters shared collectibles and reject tampering', (t) => {
  const match = fixture(t); beginRecruit(match);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: recruitView(match).refreshToken }).ok, true);
  match.collectibles.push('rogue_2_band_1');
  const doc = match.exportCheckpoint();
  assert.equal(doc.mizuki.recruitmentVersion, 4);
  const restored = fixture(t);
  assert.equal(restored.restoreCheckpoint(doc), true);
  assert.deepEqual(recruitView(restored), recruitView(match));
  assert.equal(restored.players.get('p0').recruitRefreshes, 1);
  assert.deepEqual(restored.collectibles, match.collectibles);
  for (const mutate of [
    (value) => { value.mizuki.recruitmentVersion = 3; },
    (value) => { value.players[0].tickets[0].count = 4; },
    (value) => { value.players[0].tickets[0].freeRefreshes++; },
    (value) => { value.players[0].recruitRefreshes = -1; },
    (value) => { value.mizuki.collectibles = ['made-up']; },
    (value) => { value.mizuki.continuation = 'battle'; },
  ]) {
    const invalid = structuredClone(doc); mutate(invalid);
    assert.equal(fixture(t).restoreCheckpoint(invalid), false);
  }
});

test('battle reward and battle recruitment checkpoints restore without issuing another ticket', (t) => {
  const match = fixture(t); beginRoute(match); battleReward(match);
  const rewardDoc = match.exportCheckpoint();
  const rewardRestored = fixture(t); assert.equal(rewardRestored.restoreCheckpoint(rewardDoc), true);
  selectRewards(rewardRestored);
  const ticketCount = rewardRestored.players.get('p0').tickets.length;
  const recruitDoc = rewardRestored.exportCheckpoint();
  const recruitRestored = fixture(t); assert.equal(recruitRestored.restoreCheckpoint(recruitDoc), true);
  assert.equal(recruitRestored.players.get('p0').tickets.length, ticketCount);
  finishRecruit(recruitRestored); assert.equal(recruitRestored.completedNodes, 1);
  assert.equal(recruitRestored.players.get('p0').tickets.length, ticketCount);
});

test('ANY remains ordinary and explicit advanced tickets retain copies on promotion', (t) => {
  const match = fixture(t); beginRecruit(match);
  const player = match.players.get('p0'); player.hope = 999;
  const operator = match.fullCatalog.operators.find((value) => value.promotionChessId);
  assert.equal(match._addOperator(player, operator.operatorId, { recruitCopies: 1 }), true);
  const uid = player.roster[0].uid;
  const ordinary = createMizukiRecruitTicket({ id: player.tickets[0].id, profession: 'ANY' });
  player.tickets[0] = ordinary; player.recruit.activeTicketId = ordinary.id;
  const ordinaryChoice = operatorChoice(match, player, operator);
  assert.equal(ordinaryChoice.action, 'copy');
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: ordinaryChoice.offerId }).ok, true);
  assert.equal(player.roster.length, 2);
  assert.equal(player.roster[0].promotion, 0); assert.equal(player.roster[0].recruitCopies, 1);
  const secondUid = player.roster[1].uid;
  assert.notEqual(secondUid, uid); assert.equal(player.roster[1].recruitCopies, 1);
  const ticket = createMizukiRecruitTicket({ id: player.tickets[1].id, profession: 'ANY', kind: 'advanced' });
  player.tickets[1] = ticket; player.recruit.activeTicketId = ticket.id;
  const choice = operatorChoice(match, player, operator); assert.equal(choice.action, 'upgrade');
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: choice.offerId }).ok, true);
  assert.equal(player.roster.length, 2); assert.equal(player.roster[0].uid, uid);
  assert.equal(player.roster[0].promotion, 1); assert.equal(player.roster[0].recruitCopies, 1);
  assert.equal(player.roster[1].uid, secondUid); assert.equal(player.roster[1].promotion, 0);
  const doc = match.exportCheckpoint(); assert.equal(fixture(t).restoreCheckpoint(doc), true);
  const bad = structuredClone(doc); bad.players[0].roster[0].recruitCopies = 4;
  assert.equal(fixture(t).restoreCheckpoint(bad), false);
});

test('accepted recall at an existing route boundary rejoins immediately without requiring an extra node', (t) => {
  const match = fixture(t, 4); beginRoute(match);
  const branchNode = match.route[1].id;
  for (const playerId of ['p1', 'p2']) {
    const requested = match.handle(playerId, { t: 'g.mizuki.splitRequest', nodeId: branchNode });
    assert.equal(requested.ok, true);
    assert.equal(match.handle('p0', { t: 'g.mizuki.splitDecide', requestId: requested.request.id, approve: true }).ok, true);
  }
  const leader = match.expedition.partyFor('p0'), branch = match.expedition.partyFor('p1');
  assert.notEqual(leader.id, branch.id); assert.deepEqual(branch.memberIds, ['p1', 'p2']);
  const proposed = match.handle('p0', { t: 'g.mizuki.recallPropose', targetIds: ['p1'] });
  assert.equal(proposed.ok, true);
  const requestId = proposed.request.id;
  const hopes = match.order.map(player => player.hope);
  assert.equal(match.handle('p1', { t: 'g.mizuki.recallRespond', requestId, accept: true }).ok, true);
  assert.equal(match.handle('p1', { t: 'g.mizuki.recallVote', requestId, agree: true }).ok, true);
  assert.equal(match.handle('p2', { t: 'g.mizuki.recallVote', requestId, agree: true }).ok, true);
  assert.equal(match.expedition.recalls[0].status, 'completed');
  assert.equal(match.expedition.partyFor('p1').id, leader.id);
  assert.deepEqual(match.expedition.partyFor('p0').memberIds, ['p0', 'p1', 'p3']);
  assert.deepEqual(match.expedition.partyFor('p2').memberIds, ['p2']);
  assert.equal(match.expedition.parties.size, 2);
  assert.equal(match.players.get('p1').fieldId, 'n:p1');
  assert.equal(match.players.get('p1').ready, false);
  assert.equal(match.partyStates.get(leader.id).completedNodes, 0);
  assert.equal(match.partyStates.get(branch.id).completedNodes, 0);
  assert.deepEqual(match.order.map(player => player.hope), hopes);
  const doc = match.exportCheckpoint();
  const restored = fixture(t, 4); assert.equal(restored.restoreCheckpoint(doc), true);
  const restoredLeader = restored.expedition.partyFor('p0');
  assert.equal(restored.expedition.partyFor('p1').id, restoredLeader.id);
  assert.equal(restored.expedition.recalls[0].status, 'completed');
  assert.equal(restored.players.get('p1').fieldId, 'n:p1');
  assert.equal(restored.players.get('p1').ready, false);
  assert.equal(restored.expedition.partyFor('p2').id, branch.id);
  assert.deepEqual(restored.order.map(player => player.hope), hopes);
  assert.equal(restored.handle('p1', { t: 'g.mizuki.recallRespond', requestId, accept: true }).ok, true);
  assert.equal(restored.expedition.parties.size, 2, 'repeated consent cannot duplicate membership changes');
  assert.equal(fixture(t, 4).restoreCheckpoint(restored.exportCheckpoint()), true);
});

test('real Lappland refresh trait uses manual recruit count and ignores automatic redraws', (t) => {
  const match = fixture(t); beginRecruit(match);
  const player = match.players.get('p0'); player.hope = 999;
  const lappland = match.fullCatalog.byId.get('chess_char_2_16_a');
  assert.ok(lappland);
  assert.equal(match._addOperator(player, lappland.operatorId), true);
  const others = match.fullCatalog.operators.filter((operator) => operator.operatorId !== lappland.operatorId && operator.bonds.includes('siracusaShip'));
  for (const operator of others.slice(0, 3)) assert.equal(match._addOperator(player, operator.operatorId), true);
  player.prep.board = player.roster.filter((unit) => unit.operatorId !== lappland.operatorId)
    .map((unit, col) => ({ uid: unit.uid, row: 0, col, dir: 'RIGHT' }));
  assert.equal(match._prepBonds(player).siracusaShip.active, true);
  const before = player.layers.siracusaShip || 0;
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: recruitView(match).refreshToken }).ok, true);
  assert.equal(player.layers.siracusaShip, before + 4);
  assert.equal(player.recruitRefreshes, 1);
  const offer = recruitView(match).choices.find((choice) => choice.available && !choice.owned);
  assert.ok(offer);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: offer.offerId }).ok, true);
  assert.equal(player.layers.siracusaShip, before + 4); assert.equal(player.recruitRefreshes, 1);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: recruitView(match).refreshToken }).ok, true);
  assert.equal(player.layers.siracusaShip, before + 4); assert.equal(player.recruitRefreshes, 2);
  assert.deepEqual(player.metaMessages.filter((message) => /UNSUPPORTED/.test(message)), []);
  const restored = fixture(t); assert.equal(restored.restoreCheckpoint(match.exportCheckpoint()), true);
  assert.equal(restored.players.get('p0').layers.siracusaShip, before + 4);
});
