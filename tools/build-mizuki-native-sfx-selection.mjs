#!/usr/bin/env node
// Build mode-local sound roles and the complete set of their original banks.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetToPath, indexAudio, pickUnitSfx, UI_SFX, BATTLE_SFX, resolveSpec } from './assets/audio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK = path.join(ROOT, '.cache/mizuki-native-sfx');
const read = relative => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
const sourcePath = '.cache/mizuki-native-audio/audio_data.json';
const rawBytes = readFileSync(path.join(ROOT, sourcePath));
const raw = JSON.parse(rawBytes);
const indexed = indexAudio(raw);
const base = read('data/assets.json').audio.sfx;
const operators = read('data/mizuki/operators.json');
const runtime = read('data/mizuki/runtime-ui.json');
const enemies = read('data/mizuki/enemy-database.json');
const native = read('public/assets/local/fx/index.json');
const containers = read('.cache/mizuki-native-sfx/client-sfx-containers.json');
const chars = new Set(Object.keys(operators.units));
const tokens = new Set([...Object.keys(operators.tokens), ...Object.keys(runtime.tokens)]);
const enemyIds = new Set(Object.keys(enemies.enemies));
const unitIds = [...new Set([...chars, ...tokens, ...enemyIds])].sort();
const defs = new Map(raw.soundFXBanks.map((bank, index) => [bank.name, { index, bank }]));
const banks = {}, resources = {}, roles = {}, evidence = {}, absent = [];
const skillIds = new Set();
const canonical = p => '/assets/audio/sfx/' + p;

function resource(p, asset = 'Audio/Sound_Beta_2/' + p.replace(/\.mp3$/, '')) {
  const key = asset.replaceAll('\\', '/').toLowerCase();
  if (!resources[key]) {
    const url = canonical(p);
    const installed = existsSync(path.join(ROOT, 'public', decodeURIComponent(url)));
    resources[key] = { asset, canonicalPath: p, canonicalUrl: url, installed,
      nativeContainer: containers.assets[key] || null,
      url: installed ? url : '/assets/mizuki/native-sfx/tracks/' + p.replace(/\.mp3$/, '.wav') };
  }
  return resources[key].url;
}

function requestedBank(name) {
  if (banks[name]) return indexed.bank(name);
  let resolved = name;
  const chain = [], seen = new Set();
  while (!defs.get(resolved)?.bank?.sounds?.some(sound => sound.asset)) {
    if (seen.has(resolved) || typeof raw.bankAlias?.[resolved] !== 'string') return [];
    seen.add(resolved); chain.push({ from: resolved, to: raw.bankAlias[resolved] });
    resolved = raw.bankAlias[resolved];
  }
  const { bank, index } = defs.get(resolved);
  banks[name] = { resolvedName: resolved, jsonPointer: '/soundFXBanks/' + index, aliases: chain,
    sounds: bank.sounds.map(sound => {
      const asset = typeof sound.asset === 'string' ? sound.asset : '';
      const p = assetToPath(asset);
      return { ...sound, ...(p ? { canonicalPath: p, url: resource(p, asset) } : {}) };
    }) };
  return indexed.bank(name);
}

function unitBank(id, key) {
  const [event, ...rest] = key.split('.');
  return requestedBank(['battle', event, id, ...rest].join('.'));
}
function first(paths) { return paths?.length ? resource(paths[0]) : null; }
function mix(paths) { return indexed.mixOf(paths); }
function setRole(unit, role, paths, trace, onlyMissing = true) {
  if (!paths?.length || onlyMissing && unit[role]) return;
  unit[role] = first(paths);
  const m = mix(paths);
  if (m) (unit.mix ||= {})[role] = m;
  trace[role] = paths.map(p => canonical(p));
}

function modeSounds(unitBanks, mode, role) {
  if (!Number.isInteger(mode) || mode < 1 || !unitBanks) return null;
  const suffix = new RegExp('\\.(?:[^.]*attack[^.]*|[^.]*combat[^.]*)\\.' + mode + '(?:\\.|$)', 'i');
  const keys = [...unitBanks.keys()].filter(key => suffix.test(key));
  const ordered = keys.sort((a, b) => (a.startsWith('ON_ABILITY_START') ? -1 : 0) - (b.startsWith('ON_ABILITY_START') ? -1 : 0));
  for (const key of ordered) {
    const paths = unitBanks.get(key);
    const filtered = paths.filter(p => role === 'hit' ? /\/(?:p_imp|e_imp)\//.test(p) || key.startsWith('ON_ABILITY_HIT')
      : !/\/(?:p_imp|e_imp)\//.test(p) && !key.startsWith('ON_ABILITY_HIT'));
    if (filtered.length) return filtered;
  }
  return null;
}

function allSkills(id) {
  const found = new Map();
  for (const form of Object.values(operators.units[id]?.forms || {})) for (const skill of form.skills || []) {
    if (skill.skillId) found.set(skill.index, skill);
  }
  for (const unit of Object.values(runtime.chess)) if (unit.charId === id) for (const skill of unit.skills || []) {
    if (skill.skillId) found.set(skill.index, skill);
  }
  const tokenSkill = runtime.tokens[id]?.skill || operators.tokens[id]?.skill;
  if (tokenSkill?.skillId) found.set(tokenSkill.index ?? 0, tokenSkill);
  return [...found.values()].sort((a, b) => a.index - b.index);
}

for (const id of unitIds) {
  let bankId = id;
  let unitBanks = indexed.unitBanks.get(id);
  if (!unitBanks?.size && native.units[id]?.aliasOf) {
    bankId = native.units[id].aliasOf;
    unitBanks = indexed.unitBanks.get(bankId);
  }
  if (!unitBanks?.size && /^enemy_.+_\d+$/.test(id)) {
    const family = id.replace(/_\d+$/, '');
    if (indexed.unitBanks.has(family)) { bankId = family; unitBanks = indexed.unitBanks.get(family); }
  }
  for (const key of unitBanks?.keys() || []) unitBank(bankId, key);
  const sourceUnit = native.units[id] || native.units[bankId];
  const projectiles = new Set(sourceUnit?.projectiles || []);
  const defaultMode = sourceUnit?.modes?.find(mode => mode.name === 'Default') || sourceUnit?.modes?.[0];
  const defaultProjectile = defaultMode?.attack?.projectileKey || defaultMode?.combat?.projectileKey;
  const short = id.replace(/^char_\d+_/, '');
  if (chars.has(id)) projectiles.add('projectile_chr_' + short);
  if (defaultProjectile) projectiles.add(defaultProjectile);
  for (const projectile of projectiles) for (const event of ['BORN', 'HIT', 'DESTROY']) requestedBank(`battle.ON_PROJECTILE_${event}.${projectile}`);
  const projectilePaths = event => {
    for (const key of [defaultProjectile, chars.has(id) ? 'projectile_chr_' + short : null].filter(Boolean)) {
      const result = requestedBank(`battle.ON_PROJECTILE_${event}.${key}`);
      if (result.length) return result;
    }
    return [];
  };
  const picked = pickUnitSfx(unitBanks, { operator: chars.has(id), projectile: { born: projectilePaths('BORN'), hit: projectilePaths('HIT') } });
  const unit = structuredClone(base.units[id] || {});
  const trace = { bankId, source: 'audio_data bank names; native skill mode indices and projectile keys' };
  for (const role of ['attack', 'hit', 'born', 'die']) setRole(unit, role, picked[role], trace);
  for (const skill of allSkills(id)) {
    skillIds.add(skill.skillId);
    const index = String(skill.index ?? 0);
    const start = requestedBank('battle.ON_SKILL_START.' + skill.skillId);
    requestedBank('battle.ON_SKILL_FINISH.' + skill.skillId);
    requestedBank('battle.ON_SKILL_SPECIAL_POINT.' + skill.skillId);
    if (start.length) { (unit.skills ||= {})[index] = first(start); (trace.skills ||= {})[index] = skill.skillId; }
    const sourceSkill = sourceUnit?.skills?.[skill.skillId];
    const nativeMode = sourceSkill?.mode;
    const mode = Number.isInteger(nativeMode) ? sourceUnit?.modes?.[nativeMode] : null;
    const projectile = mode?.attack?.projectileKey || mode?.combat?.projectileKey;
    for (const key of sourceSkill?.projectiles || []) for (const event of ['BORN', 'HIT']) requestedBank(`battle.ON_PROJECTILE_${event}.${key}`);
    for (const [role, table, event] of [['attack', 'attacks', 'BORN'], ['hit', 'hits', 'HIT']]) {
      let paths = modeSounds(unitBanks, nativeMode, role);
      if (!paths?.length && projectile) paths = requestedBank(`battle.ON_PROJECTILE_${event}.${projectile}`);
      if (paths?.length && !unit[table]?.[index]) {
        (unit[table] ||= {})[index] = first(paths);
        (trace[table] ||= {})[index] = { skillId: skill.skillId, nativeMode, projectile: projectile || null };
        const m = mix(paths);
        if (m) (unit[role === 'attack' ? 'attackMix' : 'hitMix'] ||= {})[index] = m;
      }
    }
  }
  if (!unit.skill && unit.skills) unit.skill = unit.skills[Object.keys(unit.skills)[0]];
  if (Object.keys(unit).length) roles[id] = unit;
  else absent.push(id);
  evidence[id] = trace;
}

const ui = structuredClone(base.ui), battle = structuredClone(base.battle);
for (const [name, spec] of Object.entries(UI_SFX)) {
  if (spec.bank) requestedBank(spec.bank);
  const p = resolveSpec(spec, indexed.bank); if (!ui[name] && p.length) ui[name] = first(p);
}
for (const [name, spec] of Object.entries(BATTLE_SFX)) {
  if (spec.bank) requestedBank(spec.bank);
  const p = resolveSpec(spec, indexed.bank); if (!battle[name] && p.length) battle[name] = first(p);
}
for (const name of [...defs.keys(), ...Object.keys(raw.bankAlias || {})]) if (/^ui\.ON_ROGUELIKE/.test(name)) {
  const paths = requestedBank(name);
  if (paths.length) ui['mizuki:' + name] = first(paths);
}

function registerExisting(value) {
  if (typeof value === 'string' && value.startsWith('/assets/audio/sfx/')) resource(value.slice('/assets/audio/sfx/'.length));
  else if (value && typeof value === 'object') for (const child of Object.values(value)) registerExisting(child);
}
registerExisting({ ui, battle, units: roles });
const entries = Object.values(resources);
const report = { scope: { operators: chars.size, tokens: tokens.size, enemies: enemyIds.size,
    uniqueUnits: unitIds.length, uniqueSkills: skillIds.size }, selectedBanks: Object.keys(banks).length,
  selectedResources: entries.length, reusedInstalled: entries.filter(entry => entry.installed).length,
  missingFiles: entries.filter(entry => !entry.installed).length,
  missingFilesInNativeClient: entries.filter(entry => !entry.installed && !entry.nativeContainer).map(entry => entry.asset),
  unmappedBefore: { operators: [...chars].filter(id => !base.units[id]).length,
    tokens: [...tokens].filter(id => !base.units[id]).length, enemies: [...enemyIds].filter(id => !base.units[id]).length },
  mappedUnits: Object.keys(roles).length, noExplicitUnitBank: absent,
  roleCounts: Object.fromEntries(['attack', 'hit', 'born', 'die', 'skills', 'attacks', 'hits'].map(role => [role,
    Object.values(roles).filter(unit => unit[role] && (typeof unit[role] !== 'object' || Object.keys(unit[role]).length)).length])) };
const output = { schema: 1, source: { audioData: sourcePath, sha256: createHash('sha256').update(rawBytes).digest('hex'),
    bytes: rawBytes.length, nativeSkillModes: '/assets/local/fx/index.json', nativeClient: containers.client },
  audio: { sfx: { ui, battle, units: roles } }, banks, resources, unitEvidence: evidence, report };
mkdirSync(TASK, { recursive: true });
writeFileSync(path.join(TASK, 'selection.json'), JSON.stringify(output));
writeFileSync(path.join(TASK, 'selection-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
