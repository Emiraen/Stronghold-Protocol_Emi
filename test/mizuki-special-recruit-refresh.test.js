import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { mizukiCommanderNextExp } from '../server/modes/mizuki/Difficulty.js';
import { createMizukiRecruitTicket, openMizukiRecruitTicket, refreshMizukiRecruitTicket,
  mizukiRecruitRefreshId, mizukiRecruitOfferId, planMizukiRecruitment,
  consumeMizukiRecruitTicket, validMizukiRecruitTicket, enableMizukiSpecialRecruitPool } from '../server/modes/mizuki/Recruitment.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const copy = value => JSON.parse(JSON.stringify(value));
const ops = ['a', 'b', 'c'].map(operatorId => ({ operatorId, profession: 'MEDIC', rarity: 6, tier: 6, promotionChessId: operatorId + '_p', bonds: [] }));
const catalog = { operators: ops, byId: new Map(ops.map(operator => [operator.operatorId, operator])) };
const ctx = rng => ({ catalog, roster: [], rng });
const ticket = (kind = 'advanced') => createMizukiRecruitTicket({ id: 'quarter-free', profession: 'ANY', kind });
function fixture(t, bandId = 'band_pepe') {
  const scheduler = new VirtualScheduler();
  const options = { data: DATA, scheduler, seed: 123, roomCode: 'SPECIAL',
    seats: [{ playerId: 'p0', seat: 0, connected: true }], send() {}, broadcast() {}, onEnd() {} };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); });
  const command = message => { const result = match.handle('p0', message); assert.deepEqual(result, { ok: true }); return result; };
  match.start();
  command({ t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  command({ t: 'g.mizuki.strategy', bandId });
  command({ t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  command({ t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  const player = match.players.get('p0'); player.hope = 200; player.hopeCapacity = 200;
  return { match, player, command, options };
}
const view = match => match.privateView('p0').mizuki.recruit;
const refresh = (match, command) => command({ t: 'g.mizuki.recruit', offerId: view(match).refreshToken });
const pick = (command, offer) => command({ t: 'g.mizuki.recruit', offerId: offer.offerId });

test('each generated offer pool draws the exact 25% boundary once and persists one free slot', () => {
  for (const [chance, expected] of [[0, 1], [.249999, 1], [.25, 0], [.999999, 0]]) {
    let calls = 0;
    const opened = openMizukiRecruitTicket(ticket(), ctx(() => { calls++; return calls === 1 ? chance : .99; })).ticket;
    assert.equal(calls, expected ? 2 : 1, 'advanced full pool consumes RNG only for its one chance and chosen slot');
    const free = opened.candidates.map((operatorId, index) => planMizukiRecruitment({ ticket: opened, catalog, offerId: mizukiRecruitOfferId(opened, operatorId, index) }).freeRecruit);
    assert.equal(free.filter(Boolean).length, expected);
    const before = copy(opened);
    assert.deepEqual(openMizukiRecruitTicket(copy(opened), ctx(() => { throw Error('view rerolled'); })).ticket, before);
    let rerolls = 0;
    const next = refreshMizukiRecruitTicket(opened, { ...ctx(() => { rerolls++; return .25; }), token: mizukiRecruitRefreshId(opened) });
    assert.equal(next.ok, true); assert.equal(rerolls, 1); assert.equal(next.ticket.randomFreeIndex, null);
    assert.equal(validMizukiRecruitTicket(copy(next.ticket), { catalog }), true);
  }
  let freePools=0;
  for(let n=0;n<100;n++){let calls=0;const opened=openMizukiRecruitTicket(ticket(),ctx(()=>++calls===1?n/100:.5)).ticket;if(opened.randomFreeIndex!==null)freePools++;}
  assert.equal(freePools,25,'exactly 25 of 100 equally spaced chance values succeed');
});

test('duplicated special offers have exactly one random free slot, retained and removed by slot', () => {
  let draws = 0;
  let current = openMizukiRecruitTicket(ticket(), ctx(() => ++draws === 1 ? .2 : .5)).ticket;
  current = refreshMizukiRecruitTicket(current, { ...ctx(() => .2), token: mizukiRecruitRefreshId(current) }).ticket;
  current.metaRefreshRevision = current.revision; current.candidates = ['a', 'a', 'b']; current.randomFreeIndex = 1;
  assert.equal(enableMizukiSpecialRecruitPool(current), true);
  const plans = current.candidates.map((operatorId, index) => planMizukiRecruitment({ ticket: current, catalog, offerId: mizukiRecruitOfferId(current, operatorId, index) }));
  assert.deepEqual(plans.map(plan => plan.freeRecruit), [false, true, false]);
  const old = current.candidates.map((id, index) => mizukiRecruitOfferId(current, id, index));
  let result = consumeMizukiRecruitTicket(current, { ...ctx(() => { throw Error('purchase rerolled'); }), offerId: old[0] });
  assert.equal(result.ok, true); current = result.ticket;
  assert.deepEqual(current.candidates, ['a', 'b']); assert.equal(current.randomFreeIndex, 0);
  assert.equal(consumeMizukiRecruitTicket(current, { ...ctx(() => .5), offerId: old[1] }).ok, false, 'revision rejects earlier slot token');
  result = consumeMizukiRecruitTicket(current, { ...ctx(() => { throw Error('purchase rerolled'); }), offerId: mizukiRecruitOfferId(current, 'a', 0) });
  assert.equal(result.ok, true); current = result.ticket; assert.equal(current.randomFreeIndex, null);
  assert.deepEqual(current.candidates, ['b']); assert.equal(current.count, 1);
  assert.equal(validMizukiRecruitTicket(copy(current), { catalog }), true);
  result = consumeMizukiRecruitTicket(current, { ...ctx(() => { throw Error('purchase rerolled'); }), offerId: mizukiRecruitOfferId(current, 'b', 0) });
  assert.equal(result.ticket.status, 'used'); assert.equal(result.ticket.specialPool, undefined);
  assert.equal(validMizukiRecruitTicket(result.ticket, { catalog }), true);
});

test('Pepe waits for explicit refresh then permits consecutive priced recruits from the same stable pool', t => {
  const { match, player, command, options } = fixture(t);
  const before = copy(view(match).ticket);
  match._gainCommandExperience(mizukiCommanderNextExp(1));
  assert.equal(player.metaCounters['band:pepe:special'], 1);
  match._refreshRecruit(player); match.publicView(); match.exportCheckpoint(); view(match);
  assert.deepEqual(view(match).ticket, before, 'opening, level up, view and serialization leave the pool and allowance alone');
  refresh(match, command);
  let current = view(match); assert(current.ticket.specialPool);
  assert.equal(player.metaCounters['band:pepe:special'], 0);
  assert.equal(current.ticket.count, current.choices.length);
  const originalPool = [...current.ticket.candidates], first = current.choices.find(offer => offer.hopeCost > 0); assert(first);
  let hope = player.hope; pick(command, first); assert.equal(player.hope, hope - first.hopeCost);
  current = view(match); assert.equal(current.ticket.id, before.id); assert.equal(current.ticket.count, originalPool.length - 1);
  const expected = [...originalPool]; expected.splice(originalPool.indexOf(first.operatorId), 1);
  assert.deepEqual(current.ticket.candidates, expected);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: first.offerId }).error, 'BAD_TARGET');
  const second = current.choices.find(offer => offer.available && offer.hopeCost > 0); assert(second);
  hope = player.hope; pick(command, second); assert.equal(player.hope, hope - second.hopeCost);
  assert.equal(view(match).ticket.count, originalPool.length - 2);
  const checkpoint = copy(match.exportCheckpoint());
  const restoredScheduler = new VirtualScheduler();
  const restored = new MizukiMatch({ ...options, scheduler: restoredScheduler });
  t.after(() => { restored.dispose(); restoredScheduler.dispose(); });
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  assert.deepEqual(view(restored).ticket, view(match).ticket);
  const blocked = view(match).choices.find(offer => offer.hopeCost > 0);
  player.hope = 0; const unchanged = copy(view(match).ticket);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: blocked.offerId }).error, 'NO_FUNDS');
  assert.deepEqual(view(match).ticket, unchanged, 'failed cost validation neither consumes nor rerolls');
  player.hope=200;const oldSeq=player.uidSeq;player.uidSeq=9999;
  const rosterBefore=copy(player.roster),poolBefore=copy(view(match).ticket),hopeBefore=player.hope;
  assert.equal(match.handle('p0',{t:'g.mizuki.recruit',offerId:view(match).choices.find(offer=>!offer.owned&&offer.available).offerId}).error,'BAD_TARGET');
  assert.deepEqual(player.roster,rosterBefore);assert.deepEqual(view(match).ticket,poolBefore);assert.equal(player.hope,hopeBefore);player.uidSeq=oldSeq;
  player.hope = 200; refresh(match, command);
  assert.equal(view(match).ticket.specialPool, undefined); assert.equal(view(match).ticket.count, 1);
  pick(command, view(match).choices.find(offer => offer.available));
  assert.notEqual(view(match).ticket.id, before.id, 'ordinary next pool consumes only one recruit');
});

test('Duyaoye and Orchid activate multiple purchases only on manual candidate refreshes', t => {
  for(const band of ['band_duyaoy','band_orchid']){
    const {match,command}=fixture(t,band);const before=copy(view(match).ticket);
    match._refreshRecruit(match.players.get('p0'));assert.deepEqual(view(match).ticket,before);assert.equal(before.specialPool,undefined);
    refresh(match,command);assert(view(match).ticket.specialPool);
    const id=view(match).ticket.id,size=view(match).choices.length;
    pick(command,view(match).choices.find(offer=>offer.available));
    assert.equal(view(match).ticket.id,id);assert.equal(view(match).choices.length,size-1);
    pick(command,view(match).choices.find(offer=>offer.available));
    assert.equal(view(match).ticket.id,id);assert.equal(view(match).choices.length,size-2);
  }
});

test('actual handler retains the one random free offer across paid purchases and checkpoint restore', t => {
  const {match,player,command,options}=fixture(t);
  const originalContext=match._recruitContext.bind(match);
  match._recruitContext=(player,ticket)=>{let calls=0;return {...originalContext(player,ticket),rng:()=>++calls===1?.1:.99};};
  const added=match._newTicket(player,9,{profession:'ANY',kind:'advanced'});
  player.recruit.ticketIds.push(added.id);player.recruit.activeTicketId=added.id;match._refreshRecruit(player);
  assert(view(match).ticket.randomFreeIndex!=null);assert.equal(view(match).choices[view(match).ticket.randomFreeIndex].hopeCost,0);
  match._gainCommandExperience(mizukiCommanderNextExp(1));refresh(match,command);
  const initial=view(match),freeIndex=initial.ticket.randomFreeIndex,freeOperator=initial.ticket.candidates[freeIndex];
  assert(initial.ticket.specialPool);assert.equal(initial.choices[freeIndex].hopeCost,0);
  const paid=initial.choices.find((offer,index)=>index!==freeIndex&&offer.available&&offer.hopeCost>0);assert(paid);
  let hope=player.hope;pick(command,paid);assert.equal(player.hope,hope-paid.hopeCost);
  const current=view(match);assert.equal(current.ticket.candidates[current.ticket.randomFreeIndex],freeOperator);
  const restoredScheduler=new VirtualScheduler(),restored=new MizukiMatch({...options,scheduler:restoredScheduler});
  t.after(()=>{restored.dispose();restoredScheduler.dispose();});
  assert.equal(restored.restoreCheckpoint(copy(match.exportCheckpoint())),true);
  assert.deepEqual(view(restored).ticket,current.ticket);
  const restoredFree=view(restored).choices[view(restored).ticket.randomFreeIndex];assert.equal(restoredFree.hopeCost,0);
  const restoredPlayer=restored.players.get('p0');hope=restoredPlayer.hope;
  assert.deepEqual(restored.handle('p0',{t:'g.mizuki.recruit',offerId:restoredFree.offerId}),{ok:true});
  assert.equal(restoredPlayer.hope,hope);assert.equal(view(restored).ticket.randomFreeIndex,null);
  assert.equal(view(restored).choices.length,current.choices.length-1);
});

test('random free slot prioritizes paid four, five and six star recruits and actual handler charges zero',t=>{
  for(const rarity of [4,5,6]){
    const {match,player,command}=fixture(t);const target=match.fullCatalog.operators.find(operator=>operator.rarity===rarity&&operator.hopeCost>0);assert(target);
    const raw=match._newTicket(player,20+rarity,{profession:'ANY',kind:'advanced'});
    player.recruit.ticketIds.push(raw.id);player.recruit.activeTicketId=raw.id;
    const sorted=match.fullCatalog.operators.slice().sort((a,b)=>a.rarity-b.rarity||a.operatorId.localeCompare(b.operatorId));
    const paid=sorted.filter(operator=>operator.hopeCost>0),position=paid.findIndex(operator=>operator.operatorId===target.operatorId);
    let calls=0;match._recruitContext=(player,ticket)=>({catalog:match.fullCatalog,gd:match.gd,roster:player.roster,rng:()=>++calls===1?.1:(position+.1)/paid.length});
    match._refreshRecruit(player);const offer=view(match).choices.find(offer=>offer.operatorId===target.operatorId);
    assert.equal(view(match).ticket.candidates[view(match).ticket.randomFreeIndex],target.operatorId);assert.equal(offer.hopeCost,0);
    const hope=player.hope;pick(command,offer);assert.equal(player.hope,hope);assert(player.roster.some(unit=>unit.operatorId===target.operatorId));
  }
});

test('manual special pages preserve free six-star and advanced voucher restrictions and skip clears them', t => {
  for (const kind of ['sixstar_free', 'advanced']) {
    const { match, player, command } = fixture(t);
    const added = match._newTicket(player, 8, { profession: 'ANY', kind });
    player.recruit.ticketIds.push(added.id); player.recruit.activeTicketId = added.id; match._refreshRecruit(player);
    if (kind === 'advanced') assert.equal(view(match).choices.length, match.fullCatalog.operators.length);
    match._gainCommandExperience(mizukiCommanderNextExp(1));
    refresh(match, command); assert(view(match).ticket.specialPool);
    if (kind === 'sixstar_free') {
      assert(view(match).choices.every(offer => offer.rarity === 6 && offer.hopeCost === 0));
      const hope = player.hope; pick(command, view(match).choices[0]); assert.equal(player.hope, hope);
      assert(view(match).choices.every(offer => offer.rarity === 6 && offer.hopeCost === 0));
    }
    const id = added.id; command({ t: 'g.mizuki.recruit', offerId: view(match).skipToken });
    const skipped = player.tickets.find(ticket => ticket.id === id);
    assert.equal(skipped.status, 'skipped'); assert.equal(skipped.specialPool, undefined); assert.equal(skipped.randomFreeIndex, null);
    assert.equal(validMizukiRecruitTicket(skipped, { catalog: match.fullCatalog }), true);
  }
});
