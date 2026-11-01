// Full project roster. Extra identities alias canonical DIY / stand-in definitions;
// no combat stats, skills, summons, covenants or garrisons are invented here.
import { readFileSync } from 'node:fs';
import { toDataSource, DataSource, normalizeToken } from '../../sim/simdata.js';
import { diyRecord, diyPool, lockedSelection } from '../../../shared/diy.js';
import { standInRecord, composeUnitRecord } from '../../../shared/standIn.js';
import { composeTalents } from '../../../shared/loadoutRecord.js';
import { mizukiUnlockedSkills, mizukiSkillUnlocked } from './SkillUnlock.js';
const OFFICIAL = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const OFFICIAL_UNITS = JSON.parse(readFileSync(new URL('../../../data/mizuki/operators.json', import.meta.url), 'utf8'));

const INITIAL = OFFICIAL.rawTopic.init.find((entry) => entry.modeId === 'NORMAL' && entry.modeGrade === 0);

export const MIZUKI_RECRUIT_RULES = Object.freeze({
  startingHope: INITIAL.initialPopulation, startingGold: INITIAL.initialGold,
  startingRecruitCount: 3, squadCapacity: INITIAL.initialSquadCapacity,
  recruitsPerTicket: 1, freeRefreshesPerTicket: 3, ordinaryCopiesForPromotion: 3,
  professionWeightMultiplier: 2, candidatesPerRarity: 2,
  candidateCountSource: 'User-requested variant: two candidates per available star rating; advanced vouchers offer the entire recruitable roster.',
  multiplayerRecruitSource: 'User-requested Mizuki variant: one recruit and three free manual refreshes per ticket; three ordinary copies promote; random start includes one free six-star voucher.',
  professionWeightSource: 'User-requested profession preference; matching voucher professions use the existing 2x project copy weight, and other professions remain eligible.',
  initialSource: 'data/mizuki/rogue2.json:rawTopic.init[NORMAL,0]',
  hopeCostSource: 'PRTS《集成战略》主题调整：水月原版4/5/6星招募2/3/6；用户指定本模式四星基础招募价改为1希望，五星与六星仍为3/6。',
  hopeCostSourceUrl: 'https://prts.wiki/w/集成战略#主题调整',
  hopeByRarity: Object.freeze({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 3, 6: 6 }),
  upgradeHopeByRarity: Object.freeze({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 2, 6: 3 }),
});
export const MIZUKI_PROFESSIONS = Object.freeze({
  ANY: '高级干员调度券', PIONEER: '先锋招募券', WARRIOR: '近卫招募券', TANK: '重装招募券',
  SNIPER: '狙击招募券', CASTER: '术师招募券', MEDIC: '医疗招募券', SUPPORT: '辅助招募券', SPECIAL: '特种招募券',
});
export const recruitHopeCost = (rarity) => MIZUKI_RECRUIT_RULES.hopeByRarity[rarity] ?? null;
const cache = new WeakMap();
const freezeList = (values) => Object.freeze([...(values || [])]);

function remapDefinition(def, id, raw) {
  return def ? Object.freeze({ ...def, id, baseId: id, raw: Object.freeze({ ...raw, chessId: id, baseId: id, goldenId: null,
    upgradeChessId: null, isGolden: false }) }) : null;
}

function information(id, def, source, canonicalChessId) {
  const raw = def.raw;
  return Object.freeze({ operatorId: id, chessId: id, canonicalChessId, source, charId: raw.charId || def.charId,
    name: raw.name || def.name, rarity: raw.rarity, hopeCost: recruitHopeCost(raw.rarity), tier: raw.tier, formStatus: raw.status || null,
    profession: raw.profession, position: raw.position, cost: raw.stats?.cost ?? def.stats.cost,
    avatar: raw.assets?.avatar || raw.charId, bonds: freezeList(raw.bonds), garrisonIds: freezeList(raw.garrisonIds),
    skillIndex: raw.skill?.index ?? def.loadout?.skillIndex ?? 0, moduleId: raw.module?.id || 'none',
    skills: Object.freeze(mizukiUnlockedSkills(raw).map((skill) => Object.freeze({
      index: skill.index ?? 0, skillId: skill.skillId, name: skill.name, description: skill.desc || '',
      skillType: skill.skillType, spCost: skill.spCost, duration: skill.duration, iconId: skill.iconId,
      unlockCond: skill.unlockCond || null,
    }))),
  });
}

export function createMizukiCatalog(data = {}) {
  if (data && typeof data === 'object' && cache.has(data)) return cache.get(data);
  const base = toDataSource(data);
  const raw = typeof data.getChess === 'function' ? data.raw : data;
  const chess = base.raw?.chess || {};
  const backups = base.rawBackups?.();
  const concrete = Object.values(chess).filter((record) => !record.isGolden && !record.isDiy && record.charId);
  const aliases = new Map();
  const operators = []; const unsupported = []; const emptySlots = [];
  const rawAliases = {};
  for (const record of Object.values(chess)) if (!record.isGolden && record.isDiy) emptySlots.push(record.chessId);
  for (const record of concrete) {
    const def = base.getChess(record.chessId);
    if (!def || recruitHopeCost(record.rarity) === null) { unsupported.push(record.chessId); continue; }
    operators.push(information(record.chessId, def, 'chess', record.chessId));
  }
  const concreteChars = new Set(concrete.map((record) => record.charId));
  const legalDiy = new Set([...diyPool(5, { data: base }), ...diyPool(6, { data: base })]);
  for (const [charId, unit] of Object.entries(backups?.units || {})) {
    if (concreteChars.has(charId)) continue;
    const id = `mizuki_${charId}`;
    let entry; let record; let def;
    if (legalDiy.has(charId)) {
      const slotId = Object.keys(backups.diy.slots).find((slot) => diyPool(backups.diy.slots[slot].tier, { data: base }).includes(charId));
      const tier = backups.diy.slots[slotId]?.tier;
      const locked = lockedSelection(base, tier, charId);
      const form = Object.values(unit.forms || {}).find((value) => value.skills?.length);
      const pick = locked ? { charId, ...locked } : { charId, skillIndex: form?.skills?.[0]?.index ?? 0, uniEquipId: null };
      record = slotId ? diyRecord(slotId, pick, { data: base }) : null;
      def = record ? base.getDiy(slotId, pick) : null;
      entry = def ? { source: 'diy', canonicalChessId: slotId, pick, locked: !!locked, defaultDef: def, defaultRaw: record } : null;
    } else {
      const shell = concrete.find((value) => value.backup?.charId === charId && value.chessType === 'NORMAL');
      record = shell ? standInRecord(shell, backups) : null;
      def = shell ? base.getStandIn(shell.chessId) : null;
      entry = def && record ? { source: 'standin', canonicalChessId: shell.chessId, defaultDef: def, defaultRaw: record } : null;
    }
    if (!entry || !def || !record || recruitHopeCost(record.rarity) === null) { unsupported.push(charId); continue; }
    aliases.set(id, entry); rawAliases[id] = { ...record, chessId: id, baseId: id, goldenId: null, upgradeChessId: null, isGolden: false };
    operators.push(information(id, remapDefinition(def, id, record), entry.source, entry.canonicalChessId));
  }

  const promotions = new Map();
  for (let index = 0; index < operators.length; index++) {
    const operator = operators[index];
    const entry = aliases.get(operator.operatorId);
    const nativeId = entry?.canonicalChessId || operator.canonicalChessId;
    const promotedNativeId = base.rawChess(nativeId)?.goldenId;
    let promotedDef = null; let promotedId = promotedNativeId;
    if (promotedNativeId && entry?.source === 'diy') {
      promotedDef = base.getDiy(promotedNativeId, entry.pick);
      promotedId = `${operator.operatorId}_promoted`;
    } else if (promotedNativeId && entry?.source === 'standin') {
      promotedDef = base.getStandIn(promotedNativeId);
      promotedId = `${operator.operatorId}_promoted`;
    } else if (promotedNativeId) promotedDef = base.getChess(promotedNativeId);
    if (promotedDef && entry) {
      aliases.set(promotedId, { ...entry, canonicalChessId: promotedNativeId, defaultDef: promotedDef, defaultRaw: promotedDef.raw });
      rawAliases[promotedId] = { ...promotedDef.raw, chessId: promotedId, baseId: promotedId, goldenId: null, upgradeChessId: null, isGolden: false };
    }
    if (promotedDef) promotions.set(operator.operatorId, { chessId: promotedId, canonicalChessId: promotedNativeId, status: promotedDef.raw.status });
    operators[index] = Object.freeze({ ...operator, promotionChessId: promotedDef ? promotedId : null,
      promotionFormStatus: promotedDef?.raw.status || null,
      upgradeHopeCost: MIZUKI_RECRUIT_RULES.upgradeHopeByRarity[operator.rarity] ?? null });
  }
  const source = Object.create(base);
  // Combat covenant helpers need the full generated maps as well as sim maps.
  source.raw = { ...raw, ...base.raw, chess: { ...chess, ...rawAliases } };
  source.rawChess = (id) => rawAliases[id] || base.rawChess(id);
  source.getChess = (id, loadout = null) => {
    const entry = aliases.get(id);
    if (!entry) return base.getChess(id, loadout);
    if (entry.source === 'standin') return remapDefinition(entry.defaultDef, id, entry.defaultRaw);
    const pick = entry.locked ? entry.pick : { ...entry.pick,
      skillIndex: Number.isInteger(loadout?.skillIndex) ? loadout.skillIndex : entry.pick.skillIndex,
      uniEquipId: typeof loadout?.moduleId === 'string' && loadout.moduleId !== 'none' ? loadout.moduleId : entry.pick.uniEquipId };
    const def = base.getDiy(entry.canonicalChessId, pick, loadout?.potential) || entry.defaultDef;
    return remapDefinition(def, id, def.raw);
  };
  source.getToken = (id, ownerId = null, ownerLoadout = null) => {
    const entry = aliases.get(ownerId);
    if (!entry) return base.getToken(id, ownerId, ownerLoadout);
    if (entry.source === 'standin') return base.getToken(id, entry.canonicalChessId, { ...ownerLoadout, standIn: true });
    const def = source.getChess(ownerId, ownerLoadout);
    return base.getDiyToken(id, entry.canonicalChessId, def.loadout?.diy || entry.pick, def.loadout?.potential);
  };
  const details = {};
  const formedChess = {}; const tokenOwnerById = new Map(); const moduleTokenOwnerById = new Map();
  const officialTokens = structuredClone(OFFICIAL_UNITS.tokens);
  for (let index = 0; index < operators.length; index++) {
    const operator = operators[index];
    const officialUnit = OFFICIAL_UNITS.units[operator.charId];
    if (!officialUnit?.forms?.base) throw new TypeError('Official Mizuki base form missing: ' + operator.charId);
    for (const [formKey, promotion] of [['base', 0], ['upgraded', 1]]) {
      const officialForm = officialUnit.forms[formKey];
      if (!officialForm) continue;
      const form = { ...officialForm, skills: mizukiUnlockedSkills(officialForm) };
      const existingPromotion = promotions.get(operator.operatorId);
      const id = promotion ? existingPromotion?.chessId || operator.operatorId + '_promoted' : operator.operatorId;
      const nativeDef = source.getChess(promotion && existingPromotion ? existingPromotion.chessId : operator.operatorId);
      // Modules are a run-local choice. Keep the RO2 training stats and skills,
      // and borrow only this character's real module records at their existing
      // project module level; E1 never receives an E2 module.
      const modules = promotion && nativeDef.charId === operator.charId ? nativeDef.raw.modules || [] : [];
      if (modules.length) moduleTokenOwnerById.set(id, { key: nativeDef.tokenOwner || nativeDef.id,
        defaultModule: nativeDef.raw.module?.id || 'none' });
      const equipLevel = modules.length ? Math.max(...modules.map((module) => module.level || 0)) : 0;
      const moduleForm = modules.length ? { ...form, modules } : form;
      const moduleNames = Object.fromEntries(modules.map((module) => [module.uniEquipId,
        { name: module.name, typeName: module.typeName }]));
      const identity = { ...nativeDef.raw, chessId: id, baseId: operator.operatorId,
        isGolden: !!promotion, goldenId: null, upgradeChessId: null, status: { ...form.status, equipLevel } };
      const wantedSkill = nativeDef.raw.skill?.index ?? operator.skillIndex;
      const skillIndex = form.skills.some((skill) => skill.index === wantedSkill) ? wantedSkill : form.skills.at(-1)?.index ?? 0;
      const record = composeUnitRecord(identity, { ...officialUnit, moduleNames }, moduleForm,
        { skillIndex, moduleId: null, bonds: operator.bonds });
      if (!record?.stats) throw new TypeError('Cannot compose official Mizuki form: ' + id);
      if (nativeDef.diyFor || operator.source === 'diy') record.diyFor = nativeDef.diyFor || operator.canonicalChessId;
      if (nativeDef.standInFor) record.standInFor = nativeDef.standInFor;
      formedChess[id] = record;
      // Sidebar data for the client: the whole official skill list with each skill's unlock state, trait, range and stats.
      details[id] = {
        appellation: officialUnit.appellation || nativeDef.raw.appellation || '',
        subProfessionId: officialUnit.subProfessionId || nativeDef.raw.subProfessionId || null,
        subProfessionName: officialUnit.subProfessionName || nativeDef.raw.subProfessionName || '',
        subProfIcon: nativeDef.raw.assets?.subProfIcon || officialUnit.assets?.subProfIcon || null,
        status: structuredClone(officialForm.status || null), stats: structuredClone(officialForm.stats || null),
        trait: officialForm.trait?.desc || officialForm.trait?.descRaw ? { desc: officialForm.trait.desc || '', descRaw: officialForm.trait.descRaw || '' }
          : nativeDef.raw.trait ? { desc: nativeDef.raw.trait.desc || '', descRaw: nativeDef.raw.trait.descRaw || '' } : null,
        rangeGrid: structuredClone(officialForm.rangeGrid || nativeDef.raw.rangeGrid || null),
        skills: (officialForm.skills || []).map((skill, order) => ({ index: skill.index ?? order, skillId: skill.skillId, iconId: skill.iconId,
          name: skill.name || '', description: skill.desc || '', descRaw: skill.descRaw || '', skillType: skill.skillType, spType: skill.spType,
          spCost: skill.spCost, initSp: skill.initSp, duration: skill.duration, level: skill.level,
          unlockCond: skill.unlockCond || null, locked: !mizukiSkillUnlocked(skill, officialForm.status) })),
      };
      const ownerKey = operator.charId + '@' + formKey;
      tokenOwnerById.set(id, ownerKey);
      for (const tokenId of form.tokens || []) {
        const token = officialTokens[tokenId];
        if (token?.variants?.[ownerKey]) token.variants[id] = token.variants[ownerKey];
      }
      if (promotion) promotions.set(operator.operatorId, { chessId: id,
        canonicalChessId: existingPromotion?.canonicalChessId || operator.canonicalChessId, status: form.status });
    }
    // The base form lists the skills its promotion adds as locked, so the sidebar shows them instead of dropping them.
    const upgradedId = promotions.get(operator.operatorId)?.chessId;
    if (details[operator.operatorId] && upgradedId && details[upgradedId]) {
      const status = details[operator.operatorId].status;
      details[operator.operatorId].skills = details[upgradedId].skills.map((skill) => ({ ...skill,
        locked: !mizukiSkillUnlocked({ unlockCond: skill.unlockCond }, status) }));
    }
    if (!officialUnit.forms.upgraded) promotions.delete(operator.operatorId);
  }
  const formedSource = new DataSource({ ...source.raw, chess: formedChess,
    tokens: { ...(source.raw.tokens || {}), ...officialTokens } }, source);
  const officialSource = Object.create(source);
  officialSource.raw = { ...source.raw, ...formedSource.raw, chess: { ...source.raw.chess, ...formedChess } };
  officialSource.rawChess = (id) => formedChess[id] || source.rawChess(id);
  officialSource.rawToken = (id) => officialTokens[id] || source.rawToken(id);
  officialSource.getChess = (id, loadout = null) => {
    if (!formedChess[id]) return source.getChess(id, loadout);
    const def = formedSource.getChess(id, loadout);
    return Object.freeze({ ...def, tokenOwner: tokenOwnerById.get(id) });
  };
  officialSource.getToken = (id, ownerId = null, ownerLoadout = null) => {
    const record = officialTokens[id];
    const ownerKey = tokenOwnerById.get(ownerId) || ownerId;
    const variant = record?.variants?.[ownerKey];
    if (!variant) return source.getToken(id, ownerId, ownerLoadout);
    const skillIndex = ownerLoadout?.skillIndex ?? formedChess[ownerId]?.skill?.index ?? 0;
    const selected = variant.bySkill?.[skillIndex];
    let resolved = selected ? { ...variant, ...selected } : variant;
    const moduleId = ownerLoadout?.moduleId;
    const nativeOwner = moduleTokenOwnerById.get(ownerId);
    const nativeVariant = nativeOwner && source.rawToken(id)?.variants?.[nativeOwner.key];
    // Chess-token baselines already include the default module, whereas backup
    // token baselines contain no module. Compare both shapes to an unequipped
    // baseline before transferring their delta onto the official trained body.
    const native = nativeVariant?.byModule?.none ? { ...nativeVariant, ...nativeVariant.byModule.none } : nativeVariant;
    const selectedModule = nativeVariant?.byModule?.[moduleId];
    const module = selectedModule ? { ...nativeVariant, ...selectedModule }
      : moduleId === nativeOwner?.defaultModule && moduleId !== 'none' ? nativeVariant : null;
    if (module && formedChess[ownerId]?.modules?.some((entry) => entry.uniEquipId === moduleId)) {
      // A native token variant is trained at the old slot's level. Transfer
      // only its module delta onto the official RO2 token, never its old body.
      resolved = { ...resolved };
      if (module.stats) resolved.stats = Object.fromEntries(Object.entries(resolved.stats).map(([key, value]) => [key,
        value + (typeof module.stats[key] === 'number' && typeof native.stats?.[key] === 'number'
          ? module.stats[key] - native.stats[key] : 0)]));
      if (module.talents) {
        const changes = module.talents.filter((talent) => JSON.stringify(talent)
          !== JSON.stringify(native.talents?.find((baseTalent) => baseTalent.index === talent.index)))
          .map((talent) => ({ ...talent, talentIndex: talent.index }));
        if (changes.length) resolved.talents = composeTalents(resolved.talents, changes);
      }
      for (const key of ['trait', 'immunities', 'rangeGrid', 'skill', 'count', 'sources']) {
        if (Object.hasOwn(module, key) && JSON.stringify(module[key]) !== JSON.stringify(native[key])) resolved[key] = structuredClone(module[key]);
      }
    }
    const selectedRecord = resolved === variant ? record : { ...record, variants: {
      ...record.variants, [ownerKey]: resolved, [ownerId]: resolved } };
    return Object.freeze(normalizeToken(id, selectedRecord, ownerKey, resolved));
  };
  for (let index = 0; index < operators.length; index++) {
    const operator = operators[index]; const promotion = promotions.get(operator.operatorId);
    operators[index] = Object.freeze({ ...information(operator.operatorId, officialSource.getChess(operator.operatorId), operator.source, operator.canonicalChessId),
      promotionChessId: promotion?.chessId || null, promotionFormStatus: promotion?.status || null,
      upgradeHopeCost: MIZUKI_RECRUIT_RULES.upgradeHopeByRarity[operator.rarity] ?? null });
  }
  const byId = new Map(operators.map((operator) => [operator.operatorId, operator]));
  const report = Object.freeze({ entries: operators.length, characters: new Set(operators.map((operator) => operator.charId)).size,
    normal: operators.filter((operator) => operator.source === 'chess').length,
    extraDiy: operators.filter((operator) => operator.source === 'diy').length,
    extraStandin: operators.filter((operator) => operator.source === 'standin').length,
    excludedGolden: Object.values(chess).filter((record) => record.isGolden).length,
    emptySlots: freezeList(emptySlots), unsupported: freezeList(unsupported),
    professions: Object.fromEntries(Object.keys(MIZUKI_PROFESSIONS).filter((id) => id !== 'ANY')
      .map((profession) => [profession, operators.filter((operator) => operator.profession === profession).length])),
  });
  const result = { operators: Object.freeze(operators), byId, promotions, details, source: officialSource, report,
    trainingSource: OFFICIAL_UNITS.source, trainingReport: OFFICIAL_UNITS.report };
  if (data && typeof data === 'object') cache.set(data, result);
  return result;
}
