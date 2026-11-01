import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { createMizukiRecruitTicket, validMizukiRecruitTicket } from '../server/modes/mizuki/Recruitment.js';
import { validMizukiPrep } from '../server/modes/mizuki/Prep.js';
import { mizukiRunLoadoutOptions } from '../server/modes/mizuki/RunLoadout.js';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const copy = value => structuredClone(value);

function fixture(t, { start = true } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ roomCode: 'DUPR', hostId: 'p0', seed: 9201, matchId: 'mizuki-duplicate-recruit-test',
    seats: [{ playerId: 'p0', seat: 0, connected: true, left: false }], data: DATA, scheduler,
    log: { info() {}, warn() {}, error() {} }, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  if (start) beginRecruit(match);
  return match;
}

function command(match, playerId, message) {
  const result = match.handle(playerId, message);
  assert.equal(result.ok, true, JSON.stringify({ message, result }));
  return result;
}

function beginRecruit(match) {
  match.start();
  assert.equal(match.phase, PHASE.SQUAD);
  command(match, 'p0', { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  assert.equal(match.phase, PHASE.STRATEGY);
  command(match, 'p0', { t: 'g.mizuki.strategy', bandId: match.strategyOptions[0].bandId });
  assert.equal(match.phase, PHASE.INITIAL_SUPPLY);
  command(match, 'p0', { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  assert.equal(match.phase, PHASE.RECRUIT_GROUP);
  command(match, 'p0', { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  assert.equal(match.phase, PHASE.RECRUIT);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.RECRUIT);
}

function fourStarWithLoadout(match) {
  const operator = match.fullCatalog.operators.find(value => value.rarity === 4 && value.promotionChessId
    && mizukiRunLoadoutOptions(match.ds, { chessId: value.operatorId, skillIndex: value.skillIndex, moduleId: 'none' }).skills.length > 1);
  assert.ok(operator, 'the official roster exposes a four-star with multiple run skills');
  return operator;
}

function operatorAtRarity(match, rarity, excluded = new Set()) {
  const operator = match.fullCatalog.operators.find(value => value.rarity === rarity && value.promotionChessId
    && !excluded.has(value.operatorId));
  assert.ok(operator, `the official roster exposes an eligible ${rarity}-star`);
  return operator;
}

function ticketFor(match, operator, id, kind = 'normal') {
  const player = match.players.get('p0');
  const ticket = createMizukiRecruitTicket({ id, profession: 'ANY', kind });
  ticket.randomCandidateCount = 1;
  ticket.revision = 1;
  ticket.candidates = [operator.operatorId];
  ticket.candidateVersion = 3;
  assert.equal(validMizukiRecruitTicket(ticket, { catalog: match.fullCatalog }), true);
  return ticket;
}

function installTickets(match, tickets) {
  const player = match.players.get('p0');
  player.tickets = tickets;
  player.recruit.ticketIds = tickets.map(ticket => ticket.id);
  player.recruit.activeTicketId = tickets[0]?.id || null;
  player.recruit.ticketId = player.recruit.activeTicketId;
  player.recruit.selectedTicketId = player.recruit.activeTicketId;
  player.ready = false;
}

function choice(match, operatorId) {
  return match.privateView('p0').mizuki.recruit.choices.find(value => value.operatorId === operatorId);
}

function restoreFixture(t, doc) {
  const match = fixture(t, { start: false });
  assert.equal(match.restoreCheckpoint(copy(doc)), true);
  return match;
}

test('actual recruitment creates a second UID, then merges the third into the equipped and loaded first copy', t => {
  const match = fixture(t), player = match.players.get('p0'), operator = fourStarWithLoadout(match);
  const ids = ['dup-p0t-1', 'dup-p0t-2', 'dup-p0t-3'];
  installTickets(match, ids.map(id => ticketFor(match, operator, id)));

  const firstChoice = choice(match, operator.operatorId);
  assert.equal(firstChoice.action, 'recruit');
  assert.equal(firstChoice.hopeCost, 1);
  command(match, 'p0', { t: 'g.mizuki.recruit', offerId: firstChoice.offerId });
  const first = player.roster[0], firstUid = first.uid;
  assert.equal(player.roster.length, 1);

  const firstSkills = match.privateView('p0').mizuki.roster[0].loadout.skills;
  const alternate = firstSkills.find(skill => skill.index !== first.skillIndex);
  assert.ok(alternate);
  command(match, 'p0', { t: 'g.mizuki.loadout', uid: firstUid, skillIndex: alternate.index, moduleId: 'none' });
  const firstLoadout = copy(player.roster[0].runLoadout);
  const firstItemId = Object.keys(match.ds.raw.items).find(id => match.gd.item(id));
  assert.ok(firstItemId);
  const firstItem = { uid: 900001, id: firstItemId, kind: 'item', meta: { owner: 'first' } };
  player.roster[0].items = [firstItem];

  const secondChoice = choice(match, operator.operatorId);
  assert.equal(secondChoice.action, 'copy');
  command(match, 'p0', { t: 'g.mizuki.recruit', offerId: secondChoice.offerId });
  assert.equal(player.roster.length, 2);
  const second = player.roster.find(unit => unit.uid !== firstUid);
  assert.ok(second);
  assert.notEqual(second.uid, firstUid);
  assert.equal(second.recruitCopies, 1);
  assert.equal(first.recruitCopies, 1);
  assert.equal(player.gainedChess, 2);

  const secondSkills = match.privateView('p0').mizuki.roster.find(unit => unit.uid === second.uid).loadout.skills;
  const secondSkill = secondSkills.find(skill => skill.index !== second.skillIndex) || secondSkills[0];
  assert.ok(secondSkill);
  command(match, 'p0', { t: 'g.mizuki.loadout', uid: second.uid, skillIndex: secondSkill.index, moduleId: 'none' });
  const loadedSecond = player.roster.find(unit => unit.uid === second.uid);
  loadedSecond.items = [{ uid: 900002, id: firstItemId, kind: 'item', meta: { owner: 'second' } }];
  const secondItem = copy(loadedSecond.items[0]);
  player.lineup = [firstUid, second.uid];
  player.prep = { hand: [firstUid, ...Array(9).fill(null)], temp: [1000001, ...Array(4).fill(null)],
    board: [{ uid: second.uid, row: 8, col: 8, dir: 'RIGHT' }],
    tokens: [{ uid: 1000001, kind: 'token', id: 'fixture-token', ownerUid: second.uid, count: 1, items: [] }], tokenSeq: 1 };
  assert.equal(validMizukiPrep(player.prep, player), true);

  const beforeHope = player.hope, thirdChoice = choice(match, operator.operatorId);
  assert.equal(thirdChoice.action, 'promote');
  const beforeTicket = copy(match._activeTicket(player));
  player.equipmentInventory = Array.from({ length: 4096 }, (_, index) => ({ uid: 910000 + index, id: firstItemId, kind: 'item', meta: {} }));
  const failed = match.handle('p0', { t: 'g.mizuki.recruit', offerId: thirdChoice.offerId });
  assert.equal(failed.error, 'BAD_TARGET');
  assert.equal(player.hope, beforeHope);
  assert.deepEqual(match._activeTicket(player), beforeTicket);
  assert.equal(player.roster.length, 2);
  assert.equal(player.roster.find(unit => unit.uid === second.uid).items[0].uid, secondItem.uid);
  assert.equal(validMizukiPrep(player.prep, player), true);

  player.equipmentInventory = [];
  const retry = choice(match, operator.operatorId);
  assert.equal(retry.action, 'promote');
  command(match, 'p0', { t: 'g.mizuki.recruit', offerId: retry.offerId });
  assert.equal(player.roster.length, 1);
  const promoted = player.roster[0];
  assert.equal(promoted.uid, firstUid);
  assert.equal(promoted.chessId, operator.promotionChessId);
  assert.equal(promoted.promotion, 1);
  assert.equal(promoted.recruitCopies, 3);
  assert.deepEqual(promoted.items, [firstItem]);
  assert.deepEqual(promoted.runLoadout, firstLoadout);
  assert.deepEqual(player.equipmentInventory, [secondItem]);
  assert.deepEqual(player.lineup, [firstUid]);
  assert.ok(!player.lineup.includes(second.uid));
  assert.ok(player.prep.hand.every(uid => uid === null || uid === firstUid));
  assert.ok(player.prep.temp.every(uid => uid === null));
  assert.deepEqual(player.prep.board, []);
  assert.deepEqual(player.prep.tokens, []);
  assert.equal(validMizukiPrep(player.prep, player), true);
  assert.equal(player.gainedChess, 2);
});

test('new and legacy duplicate checkpoints round-trip without duplicating units, loadout or equipment', t => {
  const source = fixture(t), player = source.players.get('p0'), operator = fourStarWithLoadout(source);
  const first = source._grantMetaChess(player, operator.operatorId);
  const second = source._grantMetaChess(player, operator.operatorId);
  assert.ok(first && second);
  assert.notEqual(first.uid, second.uid);
  assert.equal(player.roster.length, 2);
  const itemId = Object.keys(source.ds.raw.items).find(id => source.gd.item(id));
  player.roster[0].items = [{ uid: 900101, id: itemId, kind: 'item', meta: { instance: 'one' } }];
  player.roster[1].items = [{ uid: 900102, id: itemId, kind: 'item', meta: { instance: 'two' } }];
  const currentRecords = player.roster.map(unit => ({ uid: unit.uid, operatorId: unit.operatorId,
    recruitCopies: unit.recruitCopies, promotion: unit.promotion, items: copy(unit.items), runLoadout: copy(unit.runLoadout || null) }));

  const currentDoc = copy(source.exportCheckpoint());
  const restoredCurrent = restoreFixture(t, currentDoc);
  assert.deepEqual(restoredCurrent.players.get('p0').roster.map(unit => ({ uid: unit.uid, operatorId: unit.operatorId,
    recruitCopies: unit.recruitCopies, promotion: unit.promotion, items: unit.items, runLoadout: unit.runLoadout || null })), currentRecords);
  const twice = restoreFixture(t, restoredCurrent.exportCheckpoint());
  assert.equal(twice.players.get('p0').roster.length, 2);
  assert.deepEqual(twice.players.get('p0').roster.map(unit => unit.uid), currentRecords.map(unit => unit.uid));

  const legacy = copy(currentDoc), legacyPlayer = legacy.players[0], survivor = legacyPlayer.roster[0];
  legacyPlayer.roster = [{ ...survivor, recruitCopies: 2 }];
  legacyPlayer.lineup = [survivor.uid];
  // An aggregated legacy copy had no second UID in its preparation slots.
  legacyPlayer.prep.hand = legacyPlayer.prep.hand.map(uid => uid === survivor.uid ? uid : null);
  legacyPlayer.prep.temp = legacyPlayer.prep.temp.map(uid => uid === survivor.uid ? uid : null);
  legacyPlayer.prep.board = legacyPlayer.prep.board.filter(piece => piece.uid === survivor.uid);
  legacyPlayer.prep.tokens = [];
  legacyPlayer.uidSeq = survivor.uid % 10000;
  legacyPlayer.gainedChess = 1;
  const restoredLegacy = restoreFixture(t, legacy), legacyOwner = restoredLegacy.players.get('p0');
  assert.equal(legacyOwner.roster.length, 2);
  const materialized = legacyOwner.roster.find(unit => unit.uid !== survivor.uid);
  assert.ok(materialized);
  assert.equal(materialized.recruitCopies, 1);
  assert.equal(materialized.promotion, 0);
  assert.deepEqual(materialized.items, []);
  assert.deepEqual(legacyOwner.roster.find(unit => unit.uid === survivor.uid).items, survivor.items);
  assert.equal(legacyOwner.uidSeq, legacyPlayer.uidSeq + 1);
  assert.deepEqual(legacyOwner.lineup, [survivor.uid, materialized.uid]);
  assert.equal(legacyOwner.gainedChess, 1);

  const restoredLegacyTwice = restoreFixture(t, restoredLegacy.exportCheckpoint());
  const finalPlayer = restoredLegacyTwice.players.get('p0');
  assert.equal(finalPlayer.roster.length, 2);
  assert.deepEqual(finalPlayer.roster.map(unit => unit.uid), legacyOwner.roster.map(unit => unit.uid));
  assert.deepEqual(finalPlayer.roster.map(unit => unit.items), legacyOwner.roster.map(unit => unit.items));
  assert.equal(finalPlayer.gainedChess, 1);
});

test('_grantMetaChess returns the new second-copy entity UID', t => {
  const match = fixture(t), player = match.players.get('p0'), operator = fourStarWithLoadout(match);
  const first = match._grantMetaChess(player, operator.operatorId);
  const second = match._grantMetaChess(player, operator.operatorId);
  assert.ok(first && second);
  assert.equal(player.roster.length, 2);
  assert.equal(player.roster.find(unit => unit.uid === first.uid).operatorId, operator.operatorId);
  assert.equal(player.roster.find(unit => unit.uid === second.uid).operatorId, operator.operatorId);
  assert.notEqual(second.uid, first.uid);
  assert.equal(player.roster.find(unit => unit.uid === second.uid).recruitCopies, 1);
});

test('four-star recruitment costs and charges one hope, failed offers retain ticket, five/six-star and free costs stay intact', t => {
  const match = fixture(t), player = match.players.get('p0');
  const used = new Set();
  const four = operatorAtRarity(match, 4, used); used.add(four.operatorId);
  const five = operatorAtRarity(match, 5, used); used.add(five.operatorId);
  const six = operatorAtRarity(match, 6, used); used.add(six.operatorId);
  const freeSix = operatorAtRarity(match, 6, used);
  const tickets = [
    ticketFor(match, four, 'cost-p0t-four'), ticketFor(match, five, 'cost-p0t-five'),
    ticketFor(match, six, 'cost-p0t-six'), ticketFor(match, freeSix, 'cost-p0t-free', 'sixstar_free'),
  ];
  installTickets(match, tickets);
  const initialHope = 20;

  player.hope = 0;
  const fourChoice = choice(match, four.operatorId);
  assert.equal(fourChoice.hopeCost, 1);
  assert.equal(fourChoice.available, false);
  const fourBefore = copy(match._activeTicket(player));
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: fourChoice.offerId }).error, 'NO_FUNDS');
  assert.equal(player.hope, 0);
  assert.deepEqual(match._activeTicket(player), fourBefore);
  assert.equal(player.roster.length, 0);

  player.hope = initialHope;
  assert.equal(choice(match, four.operatorId).hopeCost, 1);
  const beforeFour = player.hope;
  command(match, 'p0', { t: 'g.mizuki.recruit', offerId: choice(match, four.operatorId).offerId });
  assert.equal(player.hope, beforeFour - 1);

  assert.equal(choice(match, five.operatorId).hopeCost, 3);
  const beforeFive = player.hope;
  command(match, 'p0', { t: 'g.mizuki.recruit', offerId: choice(match, five.operatorId).offerId });
  assert.equal(player.hope, beforeFive - 3);

  assert.equal(choice(match, six.operatorId).hopeCost, 6);
  const beforeSix = player.hope;
  command(match, 'p0', { t: 'g.mizuki.recruit', offerId: choice(match, six.operatorId).offerId });
  assert.equal(player.hope, beforeSix - 6);

  player.hope = 0;
  const freeChoice = choice(match, freeSix.operatorId);
  assert.equal(freeChoice.hopeCost, 0);
  assert.equal(freeChoice.available, true);
  command(match, 'p0', { t: 'g.mizuki.recruit', offerId: freeChoice.offerId });
  assert.equal(player.hope, 0);
  assert.equal(player.roster.find(unit => unit.operatorId === freeSix.operatorId).promotion, 0);
});
