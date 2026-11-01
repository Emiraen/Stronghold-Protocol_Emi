// Mode-local serializable recruitment transactions. Match owns hope, roster and
// socket authorization. Automatic redraws never emit a manual refresh effect.
import { MIZUKI_RECRUIT_RULES as RULES, MIZUKI_PROFESSIONS } from './catalog.js';
import { DEFAULTS } from '../../match/gamedata.js';
import { preserveMizukiEquipment } from './RosterProgression.js';

const MAX = 9999, MAX_REQUESTS = 4096, CANDIDATE_VERSION = 3;
const integer = (value, min = 0, max = MAX) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const copy = value => structuredClone(value);
const fail = (error, detail) => ({ ok:false, error, detail });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const rosterUnit = (roster, operatorId) => (roster || []).find(unit => unit.operatorId === operatorId);
const operatorOf = (catalog, operatorId) => catalog?.byId?.get(operatorId)
  || catalog?.operators?.find(operator => operator.operatorId === operatorId);
const advanced = ticket => ticket.kind === 'advanced';
export const mizukiRecruitIsFree = ticket => ticket?.kind === 'sixstar_free';
const fullSelection = ticket => !ticket.randomCandidateCount && advanced(ticket);
const rarityOf = operator => Number(operator?.rarity ?? operator?.tier);
const copiesOf = unit => integer(unit?.recruitCopies, 1, RULES.ordinaryCopiesForPromotion) ? unit.recruitCopies : 1;

/** Legacy ordinary vouchers stored their profession preference as a hard filter. */
export function mizukiRecruitPreferredProfessions(ticket) {
  if (!ticket || advanced(ticket) || ticket.promotionOnly) return [];
  return [...new Set([...(ticket.preferredProfessions ?? ticket.allowedProfessions ?? []), ticket.profession])]
    .filter(profession => profession !== 'ANY' && Object.hasOwn(MIZUKI_PROFESSIONS, profession));
}

export function mizukiRecruitParameters() {
  return { candidateCount: RULES.candidatesPerRarity * 6, candidatesPerRarity: RULES.candidatesPerRarity,
    sixStarCandidateCount: RULES.candidatesPerRarity,
    professionWeightMultiplier:RULES.professionWeightMultiplier,
    recruitsPerTicket:RULES.recruitsPerTicket, freeRefreshesPerTicket:RULES.freeRefreshesPerTicket };
}

const STARTING_PROFESSIONS = Object.freeze({
  recruit_group_1: ['PIONEER', 'SNIPER', 'SPECIAL'],
  recruit_group_2: ['TANK', 'CASTER', 'SNIPER'],
  recruit_group_3: ['WARRIOR', 'SUPPORT', 'MEDIC'],
});

/** The user's variant replaces only one random starting voucher with a free six-star voucher. */
export function mizukiInitialRecruitTicketSpecs(groupId, rng) {
  if (STARTING_PROFESSIONS[groupId]) return STARTING_PROFESSIONS[groupId].map(profession => ({ profession, kind:'normal' }));
  if (groupId !== 'recruit_group_random' || typeof rng !== 'function') throw TypeError('Invalid starting recruitment group');
  const sample = () => {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw TypeError('Invalid recruitment RNG');
    return value;
  };
  const professions = Object.keys(MIZUKI_PROFESSIONS).filter(value => value !== 'ANY');
  const freeIndex = Math.floor(sample() * RULES.startingRecruitCount);
  return Array.from({length:RULES.startingRecruitCount}, (_, index) => ({
    profession:professions[Math.floor(sample() * professions.length)], kind:index === freeIndex ? 'sixstar_free' : 'normal',
  }));
}

export function createMizukiRecruitTicket({ id:ticketId, profession, name, iconId = null, kind = 'normal', advanced:direct } = {}) {
  if (!id(ticketId) || !Object.hasOwn(MIZUKI_PROFESSIONS, profession)
    || !['normal','advanced','sixstar_free'].includes(kind) || (direct !== undefined && typeof direct !== 'boolean')) throw TypeError('Invalid Mizuki recruitment ticket');
  const ticketKind = direct === undefined ? kind : direct ? 'advanced' : 'normal';
  return { schemaVersion:1, candidateVersion:CANDIDATE_VERSION, id:ticketId, profession, name:name || MIZUKI_PROFESSIONS[profession], iconId,
    kind:ticketKind, freeRecruit:ticketKind === 'sixstar_free',
    preferredProfessions:ticketKind === 'advanced' || profession === 'ANY' ? [] : [profession],
    count:RULES.recruitsPerTicket, status:'available', freeRefreshes:RULES.freeRefreshesPerTicket,
    freeRefreshesGranted:0, refreshCount:0, revision:0, lastManualRefreshRevision:0,
    metaRefreshRevision:0, candidates:[], recruited:[], requestIds:[] };
}

export function validMizukiRecruitTicket(ticket, { catalog } = {}) {
  const limit = ticket?.recruitLimit ?? RULES.recruitsPerTicket;
  const bonus = ticket?.bonusRecruits ?? 0;
  const special = ticket?.specialPool;
  if (!plain(ticket) || ticket.schemaVersion !== 1 || !id(ticket.id)
    || !integer(limit, 1, RULES.recruitsPerTicket)
    || !integer(bonus, 0, MAX)
    || special !== undefined && (!plain(special) || !integer(special.revision, 1, ticket.lastManualRefreshRevision)
      || !integer(special.size, 1, 1024) || ticket.status !== 'available'
      || ticket.count !== ticket.candidates?.length || ticket.count > special.size)
    || ticket.randomFreeIndex !== undefined && ticket.randomFreeIndex !== null
      && !integer(ticket.randomFreeIndex, 0, (ticket.candidates?.length || 0) - 1)
    || ticket.sourceItemId !== undefined && !id(ticket.sourceItemId)
    || ticket.promotionOnly !== undefined && typeof ticket.promotionOnly !== 'boolean'
    || ticket.freeHope !== undefined && typeof ticket.freeHope !== 'boolean'
    || ticket.directPromotion !== undefined && typeof ticket.directPromotion !== 'boolean'
    || ticket.randomCandidateCount !== undefined && !integer(ticket.randomCandidateCount, 1, RULES.candidatesPerRarity * 6)
    || ticket.extraEliteNum !== undefined && !integer(ticket.extraEliteNum, 0, 12)
    || ticket.extraFreeRarities !== undefined && (!Array.isArray(ticket.extraFreeRarities)
      || ticket.extraFreeRarities.some(value => !integer(value, 1, 6)))
    || ticket.freeCandidateIds !== undefined && (!Array.isArray(ticket.freeCandidateIds)
      || ticket.freeCandidateIds.some(value => !ticket.candidates?.includes(value)))
    || ticket.allowedProfessions !== undefined && (!Array.isArray(ticket.allowedProfessions)
      || ticket.allowedProfessions.some(value => !Object.hasOwn(MIZUKI_PROFESSIONS, value)))
    || ticket.preferredProfessions !== undefined && (!Array.isArray(ticket.preferredProfessions)
      || ticket.preferredProfessions.some(value => value === 'ANY' || !Object.hasOwn(MIZUKI_PROFESSIONS, value)))
    || ticket.allowedRarities !== undefined && (!Array.isArray(ticket.allowedRarities)
      || ticket.allowedRarities.some(value => !integer(value, 1, 6)))
    || ticket.candidateVersion !== undefined && !integer(ticket.candidateVersion, 1, CANDIDATE_VERSION)
    || !Object.hasOwn(MIZUKI_PROFESSIONS, ticket.profession) || !['normal','advanced','sixstar_free'].includes(ticket.kind)
    || ticket.freeRecruit !== undefined && ticket.freeRecruit !== mizukiRecruitIsFree(ticket)
    || typeof ticket.name !== 'string' || ticket.name.length > 512
    || !(ticket.iconId === null || id(ticket.iconId)) || !['available','used','skipped'].includes(ticket.status)
    || !integer(ticket.count,0,special ? 1024 : RULES.recruitsPerTicket) || !integer(ticket.freeRefreshes)
    || !integer(ticket.freeRefreshesGranted) || !integer(ticket.refreshCount)
    || !integer(ticket.revision,0,1000000) || !integer(ticket.lastManualRefreshRevision,0,ticket.revision)
    || !integer(ticket.metaRefreshRevision,0,ticket.lastManualRefreshRevision)
    || !Array.isArray(ticket.candidates) || ticket.candidates.length > (fullSelection(ticket) ? 1024 : mizukiRecruitIsFree(ticket) ? RULES.candidatesPerRarity : RULES.candidatesPerRarity * 6)
    || ticket.candidates.some(value => !id(value) || catalog && !operatorOf(catalog,value))
    || mizukiRecruitIsFree(ticket) && catalog && ticket.candidates.some(value => rarityOf(operatorOf(catalog,value)) !== 6)
    || !Array.isArray(ticket.recruited) || ticket.recruited.length > MAX || bonus > ticket.recruited.length
    || ticket.recruited.some(value => !id(value) || catalog && !operatorOf(catalog,value))
    || !Array.isArray(ticket.requestIds) || ticket.requestIds.length > MAX_REQUESTS
    || ticket.requestIds.some(value => !id(value)) || new Set(ticket.requestIds).size !== ticket.requestIds.length
    || ticket.freeRefreshes !== RULES.freeRefreshesPerTicket + ticket.freeRefreshesGranted - ticket.refreshCount) return false;
  if (ticket.status === 'available' ? ticket.count < 1 || (special ? limit !== ticket.recruited.length - bonus + 1 : ticket.count !== limit-ticket.recruited.length+bonus)
    : ticket.count !== 0 || ticket.candidates.length !== 0) return false;
  if (ticket.status === 'used' && ticket.recruited.length - bonus !== limit) return false;
  if (ticket.status === 'skipped' && ticket.recruited.length - bonus >= limit) return false;
  if (ticket.revision === 0 && (ticket.candidates.length || ticket.refreshCount || ticket.recruited.length || ticket.status !== 'available')) return false;
  if (!!ticket.lastManualRefreshRevision !== !!ticket.refreshCount) return false;
  if (ticket.revision !== (ticket.revision ? 1 : 0)+ticket.refreshCount+ticket.recruited.length+(ticket.status==='skipped'?1:0)) return false;
  return ticket.operatorId === undefined || ticket.operatorId === ticket.recruited.at(-1);
}

const actionToken = (ticket, action) => 'mz:' + action + ':' + ticket.id + ':' + ticket.revision;
export const mizukiRecruitOfferId = (ticket, operatorId, index = ticket?.candidates?.indexOf(operatorId) ?? -1) =>
  actionToken(ticket,'pick') + ':' + operatorId + ':' + index;
export const mizukiRecruitRefreshId = ticket => actionToken(ticket,'refresh');
export const mizukiRecruitSkipId = ticket => actionToken(ticket,'skip');

function guard(ticket, { catalog, requestId } = {}) {
  if (!validMizukiRecruitTicket(ticket,{catalog}) || ticket.status !== 'available') return fail('BAD_TARGET','招募券已失效。');
  if (requestId !== undefined && (!id(requestId) || ticket.requestIds.includes(requestId))) return fail('BAD_TARGET','该操作已处理或编号无效。');
  if (ticket.requestIds.length >= MAX_REQUESTS) return fail('BAD_TARGET','招募操作记录已满。');
  return null;
}

function remember(ticket, requestId) { if (requestId !== undefined) ticket.requestIds.push(requestId); }

function eligibleRecruitOperators(catalog, roster) {
  return catalog.operators.filter(operator => {
    const matches = (roster || []).filter(unit => unit.operatorId === operator.operatorId);
    return !matches.length || !matches.some(unit => unit.promotion) && !!operator.promotionChessId;
  });
}

function ticketOperators(catalog, roster, ticket) {
  return eligibleRecruitOperators(catalog, roster).filter(operator => {
    if (ticket?.promotionOnly && !rosterUnit(roster, operator.operatorId)) return false;
    // Promotion supplies retain their original target restriction. Recruitment
    // vouchers use this legacy list only as a weight preference, including saves.
    if (ticket?.promotionOnly && ticket.allowedProfessions?.length && !ticket.allowedProfessions.includes(operator.profession)) return false;
    return !ticket?.allowedRarities?.length || ticket.allowedRarities.includes(rarityOf(operator));
  });
}

function drawWeighted(operators, count, {gd, ticket, rng}) {
  const preferredProfessions = new Set(mizukiRecruitPreferredProfessions(ticket));
  const entries = operators.map(operator => {
    const key = operator.canonicalChessId || operator.operatorId;
    const configured = gd?.poolCopies ? gd.poolCopies(key) : DEFAULTS.poolCopies[operator.tier] || 10;
    if (!Number.isFinite(configured) || configured < 0) throw TypeError('Invalid project recruitment weight');
    // Zero copies exclude a slot from the old shop pool, not from Mizuki's full roster.
    const base = configured || DEFAULTS.poolCopies[operator.tier] || 10;
    return [operator.operatorId,base * (preferredProfessions.has(operator.profession) ? RULES.professionWeightMultiplier : 1)];
  }).filter(([,weight]) => weight > 0);
  const out = [];
  while (entries.length && out.length < count) {
    const total = entries.reduce((sum,[,weight]) => sum+weight,0), sample = rng();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1 || !Number.isFinite(total)) throw TypeError('Invalid recruitment RNG');
    let remain = sample*total, selected = entries.length-1;
    for (let i=0;i<entries.length;i++) if ((remain -= entries[i][1]) < 0) { selected=i;break; }
    out.push(entries.splice(selected,1)[0][0]);
  }
  return out;
}

/** One weighted operator for original meta callbacks; independent from the voucher's page shape. */
export function rollMizukiRecruitOperator({catalog, gd, rng, roster = [], profession = 'ANY'} = {}) {
  if (typeof rng !== 'function' || !Array.isArray(catalog?.operators)) throw TypeError('Invalid Mizuki recruitment draw');
  return drawWeighted(eligibleRecruitOperators(catalog, roster), 1, {gd, ticket:{profession}, rng})[0] || null;
}

/** Ordinary pages contain two distinct candidates per available star rating. */
export function rollMizukiRecruitCandidates({ catalog, gd, ticket, rng, roster = [] } = {}) {
  if (!validMizukiRecruitTicket(ticket,{catalog}) || typeof rng !== 'function' || !Array.isArray(catalog?.operators)) throw TypeError('Invalid Mizuki recruitment draw');
  const eligible = ticketOperators(catalog, roster, ticket);
  if (fullSelection(ticket)) return eligible.slice().sort((a,b) => rarityOf(a)-rarityOf(b) || a.operatorId.localeCompare(b.operatorId)).map(operator => operator.operatorId);
  if (ticket.randomCandidateCount) return drawWeighted(eligible, ticket.randomCandidateCount, { gd, ticket, rng });
  const rarities = mizukiRecruitIsFree(ticket) ? [6] : [1,2,3,4,5,6];
  return rarities.flatMap(rarity => drawWeighted(eligible.filter(operator => rarityOf(operator) === rarity), RULES.candidatesPerRarity, {gd,ticket,rng}));
}

function redraw(ticket, context) {
  const next = copy(ticket);
  next.revision++;
  next.preferredProfessions = mizukiRecruitPreferredProfessions(next);
  next.candidates = next.status === 'available' ? rollMizukiRecruitCandidates({...context,ticket:next}) : [];
  assignFreeCandidates(next, context);
  next.candidateVersion = CANDIDATE_VERSION;
  return next;
}

function assignFreeCandidates(ticket, { catalog, rng, roster = [] }) {
  ticket.freeCandidateIds = [];
  ticket.randomFreeIndex = null;
  if (ticket.status !== 'available') return;
  const choose = values => values.length ? values[Math.floor(rng() * values.length)] : null;
  for (const rarity of ticket.extraFreeRarities || []) {
    const candidate = choose(ticket.candidates.filter(value => rarityOf(operatorOf(catalog, value)) === rarity));
    if (candidate && !ticket.freeCandidateIds.includes(candidate)) ticket.freeCandidateIds.push(candidate);
  }
  for (let index = 0; index < (ticket.extraEliteNum || 0); index++) {
    const candidate = choose(ticket.candidates.filter(value => rarityOf(operatorOf(catalog, value)) >= 5 && !ticket.freeCandidateIds.includes(value)));
    if (candidate) ticket.freeCandidateIds.push(candidate);
  }
  // Store the slot, rather than the operator id: copied slots are separate offers.
  // A page is generated once; views and purchases never draw this chance again.
  const chance = rng();
  if (!Number.isFinite(chance) || chance < 0 || chance >= 1) throw TypeError('Invalid recruitment RNG');
  if (chance < .25 && ticket.candidates.length) {
    const sample = rng();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw TypeError('Invalid recruitment RNG');
    const paid = ticket.candidates.map((id,index) => {
      const operator=operatorOf(catalog,id);
      const price=advanced(ticket)&&rosterUnit(roster,id) ? operator?.upgradeHopeCost??RULES.upgradeHopeByRarity[rarityOf(operator)]
        : operator?.hopeCost??RULES.hopeByRarity[rarityOf(operator)];
      return !mizukiRecruitIsFree(ticket)&&!ticket.freeHope&&!ticket.freeCandidateIds.includes(id)&&price>0 ? index : -1;
    }).filter(index=>index>=0);
    const slots=paid.length?paid:ticket.candidates.map((_,index)=>index);
    ticket.randomFreeIndex = slots[Math.floor(sample * slots.length)];
  }
}

function candidatePageMatches(ticket, {catalog, roster = []}) {
  if (ticket.candidateVersion !== CANDIDATE_VERSION) return false;
  const eligible = ticketOperators(catalog, roster, ticket);
  const candidateIds = new Set(ticket.candidates);
  if (candidateIds.size !== ticket.candidates.length
    || ticket.candidates.some(value => !eligible.some(operator => operator.operatorId === value))) return false;
  if (fullSelection(ticket)) return candidateIds.size === eligible.length;
  if (ticket.randomCandidateCount) return ticket.candidates.length === Math.min(ticket.randomCandidateCount, eligible.length);
  const rarities = mizukiRecruitIsFree(ticket) ? [6] : [1,2,3,4,5,6];
  return ticket.candidates.every(value => rarities.includes(rarityOf(operatorOf(catalog,value))))
    && rarities.every(rarity => ticket.candidates.filter(value => rarityOf(operatorOf(catalog,value)) === rarity).length
      === Math.min(RULES.candidatesPerRarity, eligible.filter(operator => rarityOf(operator) === rarity).length));
}

/** Opening also upgrades legacy/empty pages once, without consuming a refresh or recruit. */
export function openMizukiRecruitTicket(ticket, context = {}) {
  const error = guard(ticket,context); if (error) return error;
  if (!ticket.revision) return {ok:true,ticket:redraw(ticket,context),effects:{manualRefresh:false}};
  if (ticket.specialPool) return {ok:true,ticket:copy(ticket),effects:{manualRefresh:false}};
  if (ticket.lastManualRefreshRevision === ticket.revision && ticket.metaRefreshRevision === ticket.revision) {
    return {ok:true,ticket:copy(ticket),effects:{manualRefresh:false}};
  }
  if (candidatePageMatches(ticket,context) && (!ticket.extraFreeRarities?.length && !ticket.extraEliteNum || ticket.freeCandidateIds !== undefined)) return {ok:true,ticket:copy(ticket),effects:{manualRefresh:false}};
  const next = copy(ticket);
  next.preferredProfessions = mizukiRecruitPreferredProfessions(next);
  next.candidates = rollMizukiRecruitCandidates({...context,ticket:next});
  assignFreeCandidates(next, context);
  next.candidateVersion = CANDIDATE_VERSION;
  return {ok:true,ticket:next,effects:{manualRefresh:false,candidateMigration:true}};
}

/** Keep ordinary copies as real pieces until the third copy completes a merge. */
export function planMizukiOperatorGain({ operatorId, catalog, roster = [], upgrade = false, directPromotion = false } = {}) {
  const operator = operatorOf(catalog, operatorId);
  if (!operator) return fail('BAD_TARGET','干员数据无法载入。');
  const matches = roster.filter(unit => unit.operatorId === operatorId);
  const owned = matches[0];
  if (matches.some(unit => unit.promotion) || owned && !operator.promotionChessId) return fail('ALREADY','此干员已进阶或没有进阶形态。');
  const count = matches.reduce((sum, unit) => sum + copiesOf(unit), 0) + 1;
  if (count > RULES.ordinaryCopiesForPromotion) return fail('BAD_TARGET','干员招募份数无效。');
  const merge = !!owned && !upgrade && count === RULES.ordinaryCopiesForPromotion;
  const previous = owned && (upgrade || merge) ? owned : null;
  return { ok:true, operator, operatorId, owned:previous, hasOwned:!!owned, existingUid:previous?.uid ?? null,
    action:!owned ? 'recruit' : upgrade ? 'upgrade' : merge ? 'promote' : 'copy',
    promotion:operator.promotionChessId && (directPromotion || upgrade && owned || merge) ? 1 : 0,
    recruitCopies:merge ? RULES.ordinaryCopiesForPromotion : previous ? copiesOf(previous) : 1,
    consumedUids:merge ? matches.slice(1).map(unit => unit.uid) : [], upgradeCost:!!owned && upgrade };
}

/** Expand an old aggregated second copy without duplicating its equipment or hooks. */
export function materializeMizukiRecruitCopies(player, capacity) {
  const next = copy(player);
  for (const unit of [...next.roster]) if (!unit.promotion && copiesOf(unit) > 1) {
    const count = copiesOf(unit);
    if (next.roster.length + count - 1 > 1024 || next.uidSeq + count - 1 > 9999) throw TypeError('Mizuki duplicate recovery exceeds roster capacity');
    unit.recruitCopies = 1;
    for (let index = 1; index < count; index++) {
      const duplicate = { ...copy(unit), uid:(next.seat + 1) * 10000 + ++next.uidSeq, items:[] };
      next.roster.push(duplicate);
      if (next.lineup.includes(unit.uid) && next.lineup.length < capacity) next.lineup.push(duplicate.uid);
    }
  }
  return next;
}

export function planMizukiRecruitment({ ticket, offerId, catalog, roster = [] } = {}) {
  const error = guard(ticket,{catalog}); if (error) return error;
  const selectedIndex = ticket.candidates.findIndex((value,index) => mizukiRecruitOfferId(ticket,value,index) === offerId);
  const operatorId = selectedIndex < 0 ? null : ticket.candidates[selectedIndex];
  const operator = operatorOf(catalog,operatorId);
  if (!operator) return fail('BAD_TARGET','招募选项已失效。');
  if (!ticketOperators(catalog, roster, ticket).some(value => value.operatorId === operatorId)) return fail('BAD_TARGET','干员不符合此券的招募条件。');
  const plan = planMizukiOperatorGain({ operatorId, catalog, roster, upgrade:advanced(ticket), directPromotion:ticket.directPromotion });
  if (!plan.ok) return plan;
  return { ...plan, freeRecruit:mizukiRecruitIsFree(ticket) || ticket.freeHope === true
      || ticket.randomFreeIndex === selectedIndex || (ticket.freeCandidateIds || []).includes(operatorId) };
}

/** Promotion retains its survivor's UID and equipment; a second copy gets a new UID. */
export function applyMizukiRecruitProgress(previous, next, plan) {
  if (!plan?.ok || next?.operatorId !== plan.operatorId || !integer(plan.recruitCopies,1,RULES.ordinaryCopiesForPromotion)
    || !integer(plan.promotion,0,1) || !!previous !== !!plan.owned
    || previous && (previous.uid !== plan.existingUid || previous.operatorId !== plan.operatorId)) throw TypeError('Invalid Mizuki recruitment progression');
  return { ...preserveMizukiEquipment(previous,next),promotion:plan.promotion,recruitCopies:plan.recruitCopies };
}

export function validMizukiRecruitProgress(unit, { catalog } = {}) {
  return !!(plain(unit) && id(unit.operatorId) && (!catalog || operatorOf(catalog,unit.operatorId))
    && integer(unit.promotion,0,1) && integer(unit.recruitCopies,1,RULES.ordinaryCopiesForPromotion)
    && (unit.promotion || unit.recruitCopies < RULES.ordinaryCopiesForPromotion));
}

/** Advanced recruitment, progression nodes and progression items share this one-step plan. */
export function planMizukiDirectPromotion({ catalog, unit } = {}) {
  const operator = operatorOf(catalog,unit?.operatorId);
  if (!operator || unit.promotion || !operator.promotionChessId) return fail('ALREADY','此干员已进阶或没有进阶形态。');
  return {ok:true,operator,owned:unit,operatorId:operator.operatorId,existingUid:unit.uid,
    action:'upgrade',promotion:1,recruitCopies:copiesOf(unit),upgradeCost:true};
}

/** Commit a successful choice only after Match has validated and built the roster replacement. */
export function consumeMizukiRecruitTicket(ticket, context = {}) {
  const error = guard(ticket,context); if (error) return error;
  const selectedIndex = ticket.candidates.findIndex((value,index) => mizukiRecruitOfferId(ticket,value,index) === context.offerId);
  const operatorId = selectedIndex < 0 ? null : ticket.candidates[selectedIndex];
  if (selectedIndex < 0 || context.operatorId !== undefined && context.operatorId !== operatorId) return fail('BAD_TARGET','招募选项已失效。');
  const next = copy(ticket); next.count--;next.recruited.push(operatorId);next.operatorId=operatorId;
  if (ticket.specialPool) {
    next.candidates.splice(selectedIndex, 1);
    next.freeCandidateIds = (next.freeCandidateIds || []).filter(id => next.candidates.includes(id));
    next.randomFreeIndex = next.randomFreeIndex == null || next.randomFreeIndex === selectedIndex ? null
      : next.randomFreeIndex > selectedIndex ? next.randomFreeIndex - 1 : next.randomFreeIndex;
    if (next.count) next.bonusRecruits = (next.bonusRecruits || 0) + 1;
    else { next.status = 'used'; delete next.specialPool; }
    next.revision++; remember(next,context.requestId);
    return {ok:true,ticket:next,effects:{manualRefresh:false,automaticRedraw:false}};
  }
  if (!next.count) { next.status='used';next.candidates=[]; }
  remember(next,context.requestId);
  return { ok:true,ticket:redraw(next,context),effects:{manualRefresh:false,automaticRedraw:!!next.count} };
}

export function refreshMizukiRecruitTicket(ticket, context = {}) {
  const error = guard(ticket,context); if (error) return error;
  if(!ticket.revision)return fail('BAD_TARGET','招募券尚未打开。');
  if (context.token !== mizukiRecruitRefreshId(ticket) && !(context.token === undefined && context.expectedRevision === ticket.revision)) return fail('BAD_TARGET','刷新选项已失效。');
  if (ticket.freeRefreshes < 1) return fail('NO_FUNDS','本券免费刷新次数已用完。');
  const next=copy(ticket);
  if (next.specialPool) { next.count = (next.recruitLimit ?? RULES.recruitsPerTicket) - next.recruited.length + (next.bonusRecruits || 0); delete next.specialPool; }
  next.freeRefreshes--;next.refreshCount++;next.lastManualRefreshRevision=next.revision+1;remember(next,context.requestId);
  const drawn=redraw(next,context);drawn.lastManualRefreshRevision=drawn.revision;
  return { ok:true,ticket:drawn,effects:{manualRefresh:true,free:true,price:0} };
}

export function skipMizukiRecruitTicket(ticket, context = {}) {
  const error=guard(ticket,context);if(error)return error;
  if(!ticket.revision)return fail('BAD_TARGET','招募券尚未打开。');
  if(context.token !== mizukiRecruitSkipId(ticket))return fail('BAD_TARGET','放弃选项已失效。');
  const next=copy(ticket);next.count=0;next.status='skipped';next.candidates=[];next.freeCandidateIds=[];next.revision++;remember(next,context.requestId);
  next.randomFreeIndex=null;delete next.specialPool;
  return {ok:true,ticket:next,effects:{manualRefresh:false}};
}

/** A strategy-modified manual page sells each slot once, using this same voucher. */
export function enableMizukiSpecialRecruitPool(ticket) {
  if (!validMizukiRecruitTicket(ticket) || ticket.status !== 'available' || !ticket.candidates.length
    || ticket.lastManualRefreshRevision !== ticket.revision || ticket.metaRefreshRevision !== ticket.revision) return false;
  ticket.specialPool = {revision:ticket.revision,size:ticket.candidates.length};
  ticket.count = ticket.candidates.length;
  return true;
}

/** Original covenant/trait grants extend this ticket's finite refresh allowance. */
export function grantMizukiRecruitRefreshes(ticket, amount = 1) {
  if(!validMizukiRecruitTicket(ticket)||ticket.status!=='available'||!integer(amount))return 0;
  const add=Math.min(amount,MAX-ticket.freeRefreshes,MAX-ticket.freeRefreshesGranted);
  ticket.freeRefreshes+=add;ticket.freeRefreshesGranted+=add;
  return ticket.freeRefreshes;
}
