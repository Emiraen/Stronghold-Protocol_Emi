#!/usr/bin/env node
// Offline, reproducible IS3 training forms. Uses the project's existing official unit builder.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getData } from '../server/data.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { createOfficialUnitBuilders } from '../server/plugins/officialUnitBuilder.js';
import { FULL_RANK } from '../shared/potential.js';
import { mizukiSkillUnlocked } from '../server/modes/mizuki/SkillUnlock.js';

const root = process.cwd();
const warnings = new Set();
const builder = createOfficialUnitBuilders((warning) => warnings.add(warning));
const tables = {}; const sources = {};
for (const [key, name] of Object.entries({ charTable: 'character_table', skillTable: 'skill_table', rangeTable: 'range_table' })) {
  const file = path.join(root, '.cache/gamedata/excel', name + '.json');
  const bytes = fs.readFileSync(file);
  tables[key] = JSON.parse(bytes);
  sources[name] = { sha256: createHash('sha256').update(bytes).digest('hex'),
    url: 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/' + name + '.json' };
}
const ctx = { ac: {}, research: {}, uniequip: {}, battleEquip: {}, ...tables, potRank: FULL_RANK };
const data = getData({ log: { warn() {}, error() {}, info() {} } });
const catalogue = createMizukiCatalog(data);
const units = {}; const tokens = {}; const errors = [];
const charIds = [...new Set(catalogue.operators.map((operator) => operator.charId))].sort();
const formOf = (charId, promotion) => {
  const char = tables.charTable[charId];
  const requestedPhase = promotion ? 2 : 1;
  const phase = Math.min(requestedPhase, char.phases.length - 1);
  if (promotion && phase < 2) return null;
  const level = char.phases[phase].maxLevel;
  const status = { phase, level, skillLevel: phase === 2 ? 10 : 7, equipLevel: 0 };
  const form = builder.buildUnitForm(ctx, charId, status);
  // The shared builder may list a chess's locked default skill for the old
  // mode. RO2 must retain and enforce the character's official phase/level.
  form.skills = form.skills.map((skill) => ({ ...skill,
    unlockCond: structuredClone(char.skills?.[skill.index]?.unlockCond || null) }))
    .filter((skill) => mizukiSkillUnlocked(skill, status));
  return form;
};
for (const charId of charIds) {
  try {
    if (!tables.charTable[charId]) throw new Error('official character missing');
    units[charId] = { ...builder.buildUnitHead(ctx, charId),
      forms: { base: formOf(charId, 0), upgraded: formOf(charId, 1) } };
  } catch (error) { errors.push({ charId, message: error.message }); }
}
for (const [charId, unit] of Object.entries(units)) for (const [formId, form] of Object.entries(unit.forms)) {
  if (!form) continue;
  const ownerKey = charId + '@' + formId;
  const tokenIds = new Set(form.tokens || []);
  for (const tokenId of tokenIds) {
    const char = tables.charTable[tokenId];
    if (!char) continue;
    const phase = Math.min(form.status.phase, char.phases.length - 1);
    const status = { phase, level: Math.min(form.status.level, char.phases[phase].maxLevel),
      skillLevel: form.status.skillLevel, equipLevel: 0 };
    const tokenForm = builder.buildUnitForm(ctx, tokenId, status);
    const native = catalogue.source.rawToken(tokenId);
    // These are additive token-owned hidden talents, not owner talents or module overrides.
    // The shared auto-mode data and tokenStat reader remain untouched.
    const hiddenTalentCapacityBonus = { deployLimit: 0, deckStack: 0 };
    for (const talent of tokenForm.talents || []) if (talent.hidden) {
      for (const [key, stat] of [['max_deploy_count', 'deployLimit'], ['max_deck_stack_cnt', 'deckStack']]) {
        if (Number.isFinite(talent.bb?.[key])) hiddenTalentCapacityBonus[stat] += talent.bb[key];
      }
    }
    const stats = { ...tokenForm.stats };
    for (const [stat, bonus] of Object.entries(hiddenTalentCapacityBonus)) stats[stat] = (stats[stat] || 0) + bonus;
    const variant = { phase, level: status.level, stats, hiddenTalentCapacityBonus, immunities: tokenForm.immunities,
      rangeGrid: tokenForm.rangeGrid, trait: tokenForm.trait, talents: tokenForm.talents,
      dmgType: tokenForm.dmgType, attackKind: tokenForm.attackKind, projectile: tokenForm.projectile,
      canHitFly: tokenForm.canHitFly, bySkill: {} };
    // Keep the established token classification (healing drones, ALL-position tokens) while replacing training stats.
    if (native) for (const key of ['dmgType', 'attackKind', 'projectile', 'canHitFly']) if (native[key] != null) variant[key] = native[key];
    const ownerSkills = form.skills.length ? form.skills : [{ index: 0 }];
    for (const skill of ownerSkills) {
      const tokenSkill = tokenForm.skills.find((value) => value.index === skill.index) || tokenForm.skills[0] || null;
      const talent = form.talents.find((value) => value.tokenKey === tokenId);
      const fromSkill = skill.overrideTokenKey === tokenId;
      const sourcesForSkill = [talent ? 'talent' : null, fromSkill ? 'skill' : null,
        form.displayTokens.includes(tokenId) ? 'display' : null].filter(Boolean);
      const count = typeof talent?.bb?.cnt === 'number' ? talent.bb.cnt : fromSkill && typeof skill.bb?.cnt === 'number' ? skill.bb.cnt : null;
      variant.bySkill[skill.index] = { skill: tokenSkill, sources: sourcesForSkill, count };
    }
    Object.assign(variant, variant.bySkill[ownerSkills[0].index]);
    if (!tokens[tokenId]) tokens[tokenId] = { ...(native || {}), tokenId, kind: 'summon', name: char.name,
      profession: char.profession, subProfessionId: char.subProfessionId, position: char.position,
      placeable: native?.placeable !== false, variants: {}, assets: { avatar: tokenId, spine: tokenId } };
    tokens[tokenId].variants[ownerKey] = variant;
  }
}
const output = { schema: 1, source: { tables: sources, builder: 'server/plugins/officialUnitBuilder.js',
  training: '每个干员首招精一封顶；无精一的低星使用实际最高阶段。进阶精二封顶，技能7+专3。无模组；满潜沿项目默认。',
  recruitment: 'data/mizuki/rogue2.json:detailConst.charUpgradeTable',
  skillAvailability: 'character_table.skills[].unlockCond，按当前官方训练阶段与等级过滤；运行时与选项共用条件。',
  tokenForms: '召唤物阶段/等级按召唤者与token官方上限取较小值，技能槽跟随召唤者。',
  hiddenTokenCapacity: '召唤物自身隐藏天赋max_deploy_count/max_deck_stack_cnt，分别加到基础deployLimit/deckStack；无模组，不改共享数据。' },
  report: { entries: catalogue.operators.length, characters: charIds.length, generated: Object.keys(units).length,
    tokens: Object.keys(tokens).length, errors, warningCount: warnings.size }, units, tokens };
if (errors.length) throw new Error(JSON.stringify(errors));
fs.mkdirSync(path.join(root, 'data/mizuki'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/mizuki/operators.json'), JSON.stringify(output) + '\n');
console.log(JSON.stringify(output.report));
