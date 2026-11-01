import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { mizukiCommanderNextExp } from '../server/modes/mizuki/Difficulty.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });

function matchFor(t, bandId = 'band_pepe') {
  const scheduler = new VirtualScheduler();
  const match = new MizukiMatch({ data: DATA, scheduler, seed: 123, roomCode: 'STRAT',
    seats: [{ playerId: 'p0', seat: 0 }], send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.start();
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' }), { ok: true });
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.strategy', bandId }), { ok: true });
  assert.equal(match.phase, PHASE.INITIAL_SUPPLY);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' }), { ok: true });
  assert.equal(match.phase, PHASE.RECRUIT_GROUP);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' }), { ok: true });
  assert.equal(match.phase, PHASE.RECRUIT);
  return match;
}

test('Pepe grants a paid-priority voucher refresh on every commander level and consumes it once', (t) => {
  const match = matchFor(t, 'band_pepe'), player = match.players.get('p0');
  match._gainCommandExperience(mizukiCommanderNextExp(1));
  assert.equal(match.commander.level, 2);
  assert.equal(player.metaCounters['band:pepe:special'], 1);
  match._gainCommandExperience(mizukiCommanderNextExp(2));
  assert.equal(match.commander.level, 3);
  assert.equal(player.metaCounters['band:pepe:special'], 2, 'level 3 also awards the refresh');
  assert.match(match.strategyOptions.find(option => option.bandId === 'band_pepe').description, /每提升1级/);

  const before = match.privateView('p0').mizuki.recruit.ticket.freeRefreshes;
  const refreshToken = match.privateView('p0').mizuki.recruit.refreshToken;
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruit', offerId: refreshToken }), { ok: true });
  const refreshed = match.privateView('p0').mizuki.recruit.ticket;
  assert.equal(refreshed.freeRefreshes, before - 1);
  assert.equal(player.metaCounters['band:pepe:special'], 1);
  assert.ok(refreshed.candidates.some(id => match.fullCatalog.byId.get(id).bonds.includes('sargonShip')));
});

test('Cathy receives her original equipment choice on each commander level', (t) => {
  const match = matchFor(t, 'band_cathy'), player = match.players.get('p0');
  const before = player.equipmentOffers.length;
  match._gainCommandExperience(mizukiCommanderNextExp(1));
  assert.equal(match.commander.level, 2);
  assert.equal(player.equipmentOffers.length, before + 1);
  assert.equal(player.equipmentOffers.at(-1).kind, 'item');
  assert.match(match.strategyOptions.find(option => option.bandId === 'band_cathy').description, /指挥等级每提升1级/);
});

test('Orchid keeps its copied highest-rarity recruit offer through page reconciliation', (t) => {
  const match = matchFor(t, 'band_orchid'), player = match.players.get('p0');
  player.hope = 100; player.hopeCapacity = 100;
  const before = match.privateView('p0').mizuki.recruit.choices;
  const highest = Math.max(...before.map(offer => offer.rarity));
  const refreshToken = match.privateView('p0').mizuki.recruit.refreshToken;
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruit', offerId: refreshToken }), { ok: true });

  const after = match.privateView('p0').mizuki.recruit.choices;
  assert.equal(after.length, before.length);
  const duplicates = [...new Set(after.map(offer => offer.operatorId))]
    .map(operatorId => after.filter(offer => offer.operatorId === operatorId)).find(group => group.length > 1);
  assert.ok(duplicates, 'the copied operator appears in a second recruit slot');
  assert.equal(duplicates.length, 2);
  assert.equal(duplicates[0].rarity, highest, 'the copied offer is from the highest available rarity');
  assert.notEqual(duplicates[0].offerId, duplicates[1].offerId, 'copied slots have independent action tokens');
  assert.equal(new Set(after.map(offer => offer.offerId)).size, after.length);

  const chosen = duplicates[1];
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruit', offerId: chosen.offerId }), { ok: true });
  assert.ok(player.roster.some(unit => unit.operatorId === chosen.operatorId), 'either copied slot recruits the displayed operator');
});

test('hope spending counts as three coins for Kirara and Paganini without changing ordinary coin conversion', (t) => {
  const kirara = matchFor(t, 'band_kirara'), kp = kirara.players.get('p0');
  kp.hope = 100; kp.hopeCapacity = 100; kp.equipmentBattlesCompleted = 6;
  const kiraraBefore = kp.gainedChess;
  assert.equal(kirara._spendHope(kp, 6), true);
  assert.equal(kp.gainedChess, kiraraBefore, '18 converted coins do not reach 20');
  assert.equal(kirara._spendHope(kp, 1), true);
  assert.equal(kp.gainedChess, kiraraBefore + 1, 'the next 3 converted coins cross 20');
  assert.match(kirara.strategyOptions.find(option => option.bandId === 'band_kirara').description, /1希望=3资金/);

  const paganini = matchFor(t, 'band_paganini'), pp = paganini.players.get('p0');
  pp.hope = 100; pp.hopeCapacity = 100; pp.equipmentBattlesCompleted = 6;
  const paganiniBefore = pp.gainedChess;
  assert.equal(paganini._spendHope(pp, 18), true);
  assert.equal(pp.gainedChess, paganiniBefore, '54 converted coins do not reach 55');
  assert.equal(paganini._spendHope(pp, 1), true);
  assert.equal(pp.gainedChess, paganiniBefore + 1, 'the next 3 converted coins cross 55');
  const elite = pp.roster.at(-1), operator = paganini.fullCatalog.byId.get(elite.operatorId);
  assert.ok(elite.promotion);
  assert.ok(operator.rarity >= 4 && operator.bonds.includes('lateranoShip'));
  assert.match(paganini.strategyOptions.find(option => option.bandId === 'band_paganini').description, /1希望=3资金/);

  assert.equal(kirara._spendHope(kp, 1), true);
  assert.equal(kp.hope, 92);
  assert.equal(kp.economicCoinTotal, 0, 'Hope spending is separate from regular earned-coin conversion');
  assert.equal(kp.economicCoinRemainder, 0);
});

test('Sciurus first Kjerag recruitment costs one hope and its normal price returns afterward', (t) => {
  const match = matchFor(t, 'band_sciurus'), player = match.players.get('p0');
  const ticket = match._newTicket(player, 4, { profession: 'ANY', kind: 'advanced' });
  player.recruit.ticketIds.push(ticket.id);
  player.recruit.activeTicketId = ticket.id;
  player.hope = 1; player.hopeCapacity = 1;
  match._refreshRecruit(player);
  const offer = match.privateView('p0').mizuki.recruit.choices.find(value => value.bonds.includes('kjeragShip'));
  assert.ok(offer, 'advanced recruitment page contains Kjerag operators');
  assert.equal(offer.hopeCost, 1);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruit', offerId: offer.offerId }), { ok: true });
  assert.equal(player.hope, 0);
  assert.equal(player.metaCounters['band:sciurus:r'], match.round);
  const nextKjerag = match.fullCatalog.operators.find(value => value.bonds.includes('kjeragShip')
    && !player.roster.some(unit => unit.operatorId === value.operatorId));
  assert.ok(nextKjerag);
  assert.equal(match._hopeCost(nextKjerag, false, player), nextKjerag.hopeCost);
  assert.match(match.strategyOptions.find(option => option.bandId === 'band_sciurus').description, /消耗1点希望/);
});
