import test from 'node:test';
import assert from 'node:assert/strict';
import { createMizukiRecruitTicket, validMizukiRecruitTicket, mizukiInitialRecruitTicketSpecs,
  mizukiRecruitParameters, mizukiRecruitPreferredProfessions, openMizukiRecruitTicket,
  rollMizukiRecruitCandidates, mizukiRecruitOfferId, mizukiRecruitRefreshId,
  planMizukiRecruitment, refreshMizukiRecruitTicket } from '../server/modes/mizuki/Recruitment.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { createRng } from '../server/sim/rng.js';

const professions = ['PIONEER', 'WARRIOR', 'MEDIC', 'SNIPER'];
const operators = Array.from({ length: 6 }, (_, index) => index + 1).flatMap(rarity => professions.flatMap(profession =>
  ['a', 'b'].map(copy => ({ operatorId: `r${rarity}_${profession}_${copy}`, profession, rarity, tier: rarity,
    promotionChessId: `r${rarity}_${profession}_${copy}_up` }))));
const catalog = { operators, byId: new Map(operators.map(operator => [operator.operatorId, operator])) };
const gd = { poolCopies: () => 1 };
const context = (extra = {}) => ({ catalog, gd, rng: createRng(2718), roster: [], ...extra });
const make = (extra = {}) => createMizukiRecruitTicket({ id: 'preference-ticket', profession: 'PIONEER', ...extra });
const countsByRarity = ticket => Object.fromEntries(Array.from({ length: 6 }, (_, index) => index + 1)
  .map(rarity => [rarity, ticket.candidates.filter(id => catalog.byId.get(id).rarity === rarity).length]));

test('ordinary profession vouchers offer two distinct operators per star and allow nonmatching professions', () => {
  const opened = openMizukiRecruitTicket(make(), context({ rng: () => .999 }));
  assert.equal(opened.ok, true);
  assert.deepEqual(countsByRarity(opened.ticket), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2 });
  assert.equal(new Set(opened.ticket.candidates).size, 12);
  const nonmatching = opened.ticket.candidates.find(id => catalog.byId.get(id).profession !== 'PIONEER');
  assert.ok(nonmatching);
  assert.equal(planMizukiRecruitment({ ticket: opened.ticket, offerId: mizukiRecruitOfferId(opened.ticket, nonmatching), catalog }).ok, true);
  assert.equal(mizukiRecruitParameters().candidatesPerRarity, 2);
  assert.equal(mizukiRecruitParameters().professionWeightMultiplier, 2);
});

test('single and combined profession preferences increase draw frequency while every profession remains reachable', () => {
  // Stratified samples cover the random input domain deterministically, rather
  // than relying on a lucky random run or reimplementing the weighted sampler.
  const smallOperators = professions.map(profession => ({ operatorId: profession, profession, rarity: 6, tier: 6 }));
  const smallCatalog = { operators: smallOperators, byId: new Map(smallOperators.map(operator => [operator.operatorId, operator])) };
  const sample = ticket => {
    const counts = Object.fromEntries(professions.map(profession => [profession, 0]));
    for (let index = 0; index < 1200; index++) {
      const [first] = rollMizukiRecruitCandidates({ catalog: smallCatalog, gd, ticket, roster: [], rng: () => index / 1200 });
      counts[first]++;
    }
    return counts;
  };
  const unbiased = sample(make({ profession: 'ANY' }));
  const single = sample(make());
  const combinedTicket = make(); combinedTicket.preferredProfessions = ['PIONEER', 'MEDIC'];
  const combined = sample(combinedTicket);
  assert.ok(single.PIONEER > unbiased.PIONEER * 1.5);
  assert.ok(single.PIONEER / single.WARRIOR > 1.9 && single.PIONEER / single.WARRIOR < 2.1);
  for (const profession of ['PIONEER', 'MEDIC']) {
    assert.ok(combined[profession] / combined.WARRIOR > 1.9 && combined[profession] / combined.WARRIOR < 2.1);
  }
  assert.ok(Object.values(single).every(count => count > 0));
  assert.ok(Object.values(combined).every(count => count > 0));
  assert.deepEqual(mizukiRecruitPreferredProfessions(combinedTicket), ['PIONEER', 'MEDIC']);
});

test('opening an old profession-filtered page migrates it once without spending a refresh or changing its revision', () => {
  const ticket = make();
  delete ticket.preferredProfessions;
  ticket.candidateVersion = 2; ticket.revision = 1; ticket.allowedProfessions = ['PIONEER'];
  ticket.candidates = operators.filter(operator => operator.profession === 'PIONEER').map(operator => operator.operatorId);
  ticket.sourceItemId = 'rogue_2_recruit_ticket_pioneer';
  const original = structuredClone(ticket), token = mizukiRecruitRefreshId(ticket);
  assert.equal(validMizukiRecruitTicket(ticket, { catalog }), true);
  const result = openMizukiRecruitTicket(ticket, context({ rng: () => .999 }));
  assert.equal(result.ok, true); assert.equal(result.effects.candidateMigration, true);
  assert.equal(result.effects.manualRefresh, false);
  assert.equal(result.ticket.candidateVersion, 3);
  assert.equal(result.ticket.revision, original.revision);
  assert.equal(result.ticket.freeRefreshes, 3); assert.equal(result.ticket.refreshCount, 0); assert.equal(result.ticket.count, 1);
  assert.equal(mizukiRecruitRefreshId(result.ticket), token);
  assert.deepEqual(result.ticket.preferredProfessions, ['PIONEER']);
  assert.ok(result.ticket.candidates.some(id => catalog.byId.get(id).profession !== 'PIONEER'));
  assert.deepEqual(ticket, original, 'reading an old save does not mutate its serialized source');
  const readAgain = openMizukiRecruitTicket(result.ticket, context({ rng: () => assert.fail('a current page must not redraw on view reads') }));
  assert.deepEqual(readAgain.ticket, result.ticket);
  const older = structuredClone(original); older.candidateVersion = 1;
  assert.equal(openMizukiRecruitTicket(older, context()).ticket.candidateVersion, 3);
});

test('advanced vouchers expose the whole recruitable roster even with legacy profession restrictions', () => {
  const ticket = make({ kind: 'advanced' }); ticket.allowedProfessions = ['PIONEER'];
  const opened = openMizukiRecruitTicket(ticket, context());
  assert.equal(opened.ok, true);
  assert.deepEqual(new Set(opened.ticket.candidates), new Set(operators.map(operator => operator.operatorId)));
  assert.deepEqual(opened.ticket.preferredProfessions, []);
  const nonmatching = operators.find(operator => operator.profession === 'MEDIC');
  assert.equal(planMizukiRecruitment({ ticket: opened.ticket, offerId: mizukiRecruitOfferId(opened.ticket, nonmatching.operatorId), catalog }).ok, true);
});

test('random starting recruitment preserves exactly one free two-candidate six-star voucher and three refreshes', () => {
  const specs = mizukiInitialRecruitTicketSpecs('recruit_group_random', createRng(42));
  assert.equal(specs.length, 3); assert.equal(specs.filter(spec => spec.kind === 'sixstar_free').length, 1);
  let result = openMizukiRecruitTicket(make(specs.find(spec => spec.kind === 'sixstar_free')), context());
  for (let refresh = 0; refresh <= 3; refresh++) {
    assert.equal(result.ok, true);
    const ticket = result.ticket;
    assert.equal(ticket.candidates.length, 2);
    assert.equal(new Set(ticket.candidates).size, 2);
    assert.ok(ticket.candidates.every(id => catalog.byId.get(id).rarity === 6));
    assert.equal(ticket.freeRefreshes, 3 - refresh); assert.equal(ticket.count, 1);
    for (const id of ticket.candidates) assert.equal(planMizukiRecruitment({ ticket, offerId: mizukiRecruitOfferId(ticket, id), catalog }).freeRecruit, true);
    result = refreshMizukiRecruitTicket(ticket, context({ token: mizukiRecruitRefreshId(ticket), requestId: 'free-six-' + refresh }));
  }
  assert.equal(result.ok, false); assert.equal(result.error, 'NO_FUNDS');
});

test('official single, double and quadruple vouchers preserve their profession types and only full-roster vouchers offer full selection', () => {
  // Exercise the actual item-grant path without starting a match or simulation.
  const match = { offerSeq: 0 }, player = { seat: 0, tickets: [] };
  const grant = id => {
    const [ticketId] = MizukiMatch.prototype._grantRouteItem.call(match, player, id);
    return player.tickets.find(ticket => ticket.id === ticketId);
  };
  const single = grant('rogue_2_recruit_ticket_pioneer');
  assert.equal(single.kind, 'normal'); assert.equal(single.profession, 'PIONEER');
  assert.deepEqual(single.preferredProfessions, ['PIONEER']); assert.equal(single.allowedProfessions, undefined);
  const double = grant('rogue_2_recruit_ticket_double_1');
  assert.equal(double.kind, 'normal'); assert.deepEqual(double.preferredProfessions, ['WARRIOR', 'PIONEER']);
  const quad = grant('rogue_2_recruit_ticket_quad_melee');
  assert.equal(quad.kind, 'normal'); assert.deepEqual(quad.preferredProfessions, ['WARRIOR', 'TANK', 'SPECIAL', 'PIONEER']);
  const advanced = grant('rogue_2_recruit_ticket_all');
  assert.equal(advanced.kind, 'advanced'); assert.equal(advanced.profession, 'ANY'); assert.deepEqual(advanced.preferredProfessions, []);
  const promotion = grant('rogue_2_upgrade_ticket_pioneer');
  assert.equal(promotion.promotionOnly, true); assert.deepEqual(promotion.allowedProfessions, ['PIONEER']);
  assert.ok(player.tickets.every(ticket => validMizukiRecruitTicket(ticket)));
});
