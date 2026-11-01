import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_SFX, BATTLE_SFX } from '../tools/assets/audio.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');
const json = relative => JSON.parse(readFileSync(resolve(ROOT, relative), 'utf8'));
const manifest = json('public/assets/mizuki/native-sfx/manifest.json');
const selection = json('.cache/mizuki-native-sfx/selection.json');
const audioDataBytes = readFileSync(resolve(ROOT, manifest.source.audioData));
const audioData = JSON.parse(audioDataBytes);
const operators = json('data/mizuki/operators.json');
const runtime = json('data/mizuki/runtime-ui.json');
const enemies = json('data/mizuki/enemy-database.json');
const native = json('public/assets/local/fx/index.json');
const sourceBanks = new Map(audioData.soundFXBanks.map(bank => [bank.name, bank]));
const sourceNames = new Set([...sourceBanks.keys(), ...Object.keys(audioData.bankAlias || {})]);
const chars = new Set(Object.keys(operators.units));
const tokens = new Set([...Object.keys(operators.tokens), ...Object.keys(runtime.tokens)]);
const enemyIds = new Set(Object.keys(enemies.enemies));
const unitIds = new Set([...chars, ...tokens, ...enemyIds]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assetKey = asset => asset.replaceAll('\\', '/').toLowerCase();
const sorted = values => [...values].sort();

function localBytes(url) {
  assert.match(url, /^\/assets\/(?:audio\/sfx\/|mizuki\/native-sfx\/)/, url);
  assert.ok(!/[?#\\]/.test(url), 'URL must encode filename fragments: ' + url);
  const decoded = decodeURIComponent(url);
  assert.ok(!decoded.includes('\\') && !decoded.split('/').includes('..'), url);
  const file = resolve(PUBLIC, '.' + decoded);
  assert.ok(file.startsWith(PUBLIC + sep), url);
  return readFileSync(file);
}

function verify(record) {
  assert.equal(typeof record.path, 'string');
  assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0, record.path);
  assert.match(record.sha256, /^[a-f0-9]{64}$/, record.path);
  const bytes = localBytes(record.path);
  assert.equal(bytes.length, record.bytes, record.path);
  assert.equal(hash(bytes), record.sha256, record.path);
  return bytes;
}

function assetPaths(value, result = new Set()) {
  if (typeof value === 'string' && value.startsWith('/assets/')) result.add(value);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) assetPaths(child, result);
  return result;
}

function resolveBank(name) {
  const seen = new Set();
  while (name && !seen.has(name)) {
    seen.add(name);
    const bank = sourceBanks.get(name);
    if (bank?.sounds?.some(sound => sound.asset)) return bank;
    name = audioData.bankAlias?.[name];
  }
  return null;
}

const unitBankNames = new Map();
for (const name of sourceNames) {
  const parts = name.split('.');
  if (parts[0] !== 'battle' || !/^(?:char|enemy|token|trap)_/.test(parts[2] || '')) continue;
  // An existing empty unit bank is not indexed as an alias by the source table loader.
  if (sourceBanks.has(name) && !sourceBanks.get(name).sounds?.some(sound => sound.asset)) continue;
  if (!resolveBank(name)) continue;
  if (!unitBankNames.has(parts[2])) unitBankNames.set(parts[2], []);
  unitBankNames.get(parts[2]).push(name);
}

function requireBank(name) {
  const source = resolveBank(name);
  if (!source) return null;
  assert.ok(selection.banks[name], 'selection omitted original bank: ' + name);
  assert.ok(manifest.banks[name], 'production omitted original bank: ' + name);
  assert.equal(manifest.banks[name].resolvedName, source.name, name);
  return manifest.banks[name];
}

function skillsFor(id) {
  const skills = new Map();
  const forms = Object.values(operators.units[id]?.forms || {});
  const chess = Object.values(runtime.chess).filter(unit => unit.charId === id);
  for (const unit of [...forms, ...chess]) for (const skill of unit.skills || []) {
    if (skill.skillId) skills.set(skill.index ?? 0, skill);
  }
  const tokenSkill = runtime.tokens[id]?.skill || operators.tokens[id]?.skill;
  if (tokenSkill?.skillId) skills.set(tokenSkill.index ?? 0, tokenSkill);
  return skills;
}

function allSourceSkills(id) {
  const skills = new Set();
  const entries = [...Object.values(operators.units[id]?.forms || {}), ...Object.values(runtime.chess).filter(unit => unit.charId === id)];
  for (const entry of entries) for (const skill of entry.skills || []) if (skill.skillId) skills.add(skill.skillId);
  for (const token of [runtime.tokens[id], operators.tokens[id]]) if (token?.skill?.skillId) skills.add(token.skill.skillId);
  return skills;
}

function waveFormat(bytes, label) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', label);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', label);
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, label);
  let format, dataBytes;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= bytes.length, label);
    if (kind === 'fmt ') {
      assert.ok(size >= 16, label);
      format = {
        codec: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12), byteRate: bytes.readUInt32LE(offset + 16),
        blockAlign: bytes.readUInt16LE(offset + 20), bits: bytes.readUInt16LE(offset + 22),
      };
    }
    if (kind === 'data') dataBytes = size;
    offset += 8 + size + size % 2;
  }
  assert.ok(format && dataBytes > 0, label);
  assert.equal(format.codec, 1, label);
  assert.ok(format.channels > 0 && format.sampleRate > 0 && format.bits > 0, label);
  assert.equal(format.blockAlign, format.channels * format.bits / 8, label);
  assert.equal(format.byteRate, format.sampleRate * format.blockAlign, label);
  assert.equal(dataBytes % format.blockAlign, 0, label);
  return { ...format, frames: dataBytes / format.blockAlign };
}

function verifyMp3(bytes, label) {
  let start = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    assert.ok(bytes.length > 10, label);
    assert.ok(bytes[3] >= 2 && bytes[3] <= 4, label);
    assert.ok([...bytes.subarray(6, 10)].every(value => value < 128), label);
    start = 10 + bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9];
    if (bytes[3] === 4 && bytes[5] & 0x10) start += 10;
  }
  const frameLength = offset => {
    if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return 0;
    const version = (bytes[offset + 1] >> 3) & 3, layer = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = bytes[offset + 2] >> 4, rateIndex = (bytes[offset + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0;
    const rates = [44100, 48000, 32000];
    const mpeg1 = { 3: [32,64,96,128,160,192,224,256,288,320,352,384,416,448], 2: [32,48,56,64,80,96,112,128,160,192,224,256,320,384], 1: [32,40,48,56,64,80,96,112,128,160,192,224,256,320] };
    const lower = layer === 3 ? [32,48,56,64,80,96,112,128,144,160,176,192,224,256] : [8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const bitrate = (version === 3 ? mpeg1[layer] : lower)[bitrateIndex - 1] * 1000;
    const rate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const padding = (bytes[offset + 2] >> 1) & 1;
    const size = layer === 3 ? (Math.floor(12 * bitrate / rate) + padding) * 4
      : Math.floor((layer === 1 && version !== 3 ? 72 : 144) * bitrate / rate) + padding;
    return offset + size <= bytes.length ? size : 0;
  };
  let frame = -1;
  for (let offset = start; offset + 4 < Math.min(bytes.length, start + 16384); offset++) {
    const size = frameLength(offset);
    const next = offset + size;
    if (size && (frameLength(next) || next === bytes.length || bytes.length - next === 128 && bytes.toString('ascii', next, next + 3) === 'TAG')) {
      frame = offset;
      break;
    }
  }
  assert.ok(frame >= 0, 'MP3 must contain complete consecutive MPEG audio frames: ' + label);
}

test('Mizuki SFX production references and selection resources are all registered with no missing assets', () => {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.format, 'mizuki-native-sfx');
  assert.deepEqual(manifest.missing, []);
  assert.deepEqual(manifest.coverage.missing, []);
  assert.deepEqual(manifest.coverage.missingFilesInNativeClient, []);
  assert.equal(audioDataBytes.length, manifest.source.bytes);
  assert.equal(hash(audioDataBytes), manifest.source.sha256);
  assert.equal(selection.source.sha256, manifest.source.sha256);
  const references = assetPaths(manifest.audio.sfx);
  assert.ok(references.size > 0);
  for (const url of references) {
    assert.ok(manifest.files[url], 'unregistered playback reference: ' + url);
    assert.equal(manifest.files[url].path, url);
  }
  assert.deepEqual(sorted(Object.keys(manifest.assets)), sorted(Object.keys(selection.resources)));
  for (const [key, resource] of Object.entries(selection.resources)) {
    const asset = manifest.assets[key];
    assert.equal(assetKey(resource.asset), key);
    assert.equal(asset.asset, resource.asset, key);
    assert.equal(asset.canonicalPath, resource.canonicalPath, key);
    assert.ok(manifest.files[asset.path], 'selected resource is absent: ' + key);
  }
  assert.equal(manifest.coverage.selectedResources, Object.keys(selection.resources).length);
  assert.equal(manifest.coverage.playableResources, Object.keys(manifest.assets).length);
  assert.equal(manifest.coverage.indexedFiles, Object.keys(manifest.files).length);
});

test('Mizuki SFX selection covers the full current operator, token, enemy and skill scope', () => {
  const skills = new Set([...unitIds].flatMap(id => [...allSourceSkills(id)]));
  const scope = {
    operators: chars.size, tokens: tokens.size, enemies: enemyIds.size,
    uniqueUnits: unitIds.size, uniqueSkills: skills.size,
  };
  assert.deepEqual(selection.report.scope, scope);
  assert.deepEqual(manifest.coverage.scope, scope);
  assert.deepEqual(sorted(Object.keys(selection.unitEvidence)), sorted(unitIds));
  assert.deepEqual(manifest.unitEvidence, selection.unitEvidence);
  const mapped = Object.keys(manifest.audio.sfx.units);
  const absent = manifest.coverage.noExplicitUnitBank;
  assert.deepEqual(sorted([...mapped, ...absent]), sorted(unitIds));
  assert.equal(manifest.coverage.mappedUnits, mapped.length);
  const bankNamesFor = id => unitBankNames.get(id) || [];
  for (const id of unitIds) {
    let bankId = id;
    if (!bankNamesFor(bankId).length && native.units[id]?.aliasOf) bankId = native.units[id].aliasOf;
    if (!bankNamesFor(bankId).length && /^enemy_.+_\d+$/.test(id)) {
      const family = id.replace(/_\d+$/, '');
      if (bankNamesFor(family).length) bankId = family;
    }
    assert.equal(manifest.unitEvidence[id].bankId, bankId, id);
    for (const name of bankNamesFor(bankId)) requireBank(name);
    const sourceUnit = native.units[id] || native.units[bankId];
    const defaultMode = sourceUnit?.modes?.find(mode => mode.name === 'Default') || sourceUnit?.modes?.[0];
    const projectiles = new Set(sourceUnit?.projectiles || []);
    if (chars.has(id)) projectiles.add('projectile_chr_' + id.replace(/^char_\d+_/, ''));
    const defaultProjectile = defaultMode?.attack?.projectileKey || defaultMode?.combat?.projectileKey;
    if (defaultProjectile) projectiles.add(defaultProjectile);
    for (const key of projectiles) for (const event of ['BORN', 'HIT', 'DESTROY']) requireBank(`battle.ON_PROJECTILE_${event}.${key}`);
    for (const skillId of allSourceSkills(id)) for (const event of ['START', 'FINISH', 'SPECIAL_POINT']) requireBank(`battle.ON_SKILL_${event}.${skillId}`);
    for (const [index, skill] of skillsFor(id)) {
      for (const event of ['START', 'FINISH', 'SPECIAL_POINT']) requireBank(`battle.ON_SKILL_${event}.${skill.skillId}`);
      const start = resolveBank('battle.ON_SKILL_START.' + skill.skillId);
      if (start) {
        const first = start.sounds.find(sound => sound.asset);
        assert.equal(manifest.audio.sfx.units[id]?.skills?.[index], manifest.assets[assetKey(first.asset)].path, id + ':' + index);
      }
      const sourceSkill = sourceUnit?.skills?.[skill.skillId];
      const mode = Number.isInteger(sourceSkill?.mode) ? sourceUnit?.modes?.[sourceSkill.mode] : null;
      const skillProjectiles = new Set(sourceSkill?.projectiles || []);
      const projectile = mode?.attack?.projectileKey || mode?.combat?.projectileKey;
      for (const key of skillProjectiles) for (const event of ['BORN', 'HIT']) requireBank(`battle.ON_PROJECTILE_${event}.${key}`);
      for (const role of ['attacks', 'hits']) {
        const evidence = manifest.unitEvidence[id][role]?.[index];
        if (evidence) {
          assert.equal(evidence.skillId, skill.skillId, id + ':' + role + ':' + index);
          assert.equal(evidence.nativeMode, sourceSkill?.mode, id + ':' + role + ':' + index);
          assert.equal(evidence.projectile, projectile || null, id + ':' + role + ':' + index);
        }
      }
    }
  }
});

test('every selected original bank retains its exact sounds, silence weights, volume and aliases', () => {
  assert.deepEqual(sorted(Object.keys(manifest.banks)), sorted(Object.keys(selection.banks)));
  assert.equal(manifest.coverage.selectedBanks, Object.keys(manifest.banks).length);
  for (const [name, bank] of Object.entries(manifest.banks)) {
    assert.match(bank.jsonPointer, /^\/soundFXBanks\/\d+$/, name);
    const source = audioData.soundFXBanks[Number(bank.jsonPointer.split('/').at(-1))];
    assert.ok(source, name);
    assert.equal(source.name, bank.resolvedName, name);
    let current = name;
    for (const alias of bank.aliases) {
      assert.equal(alias.from, current, name);
      assert.equal(audioData.bankAlias[alias.from], alias.to, name);
      current = alias.to;
    }
    assert.equal(current, source.name, name);
    assert.equal(bank.sounds.length, source.sounds.length, name);
    for (let index = 0; index < source.sounds.length; index++) {
      const { canonicalPath, url, ...sound } = bank.sounds[index];
      assert.deepEqual(sound, source.sounds[index], name + ':' + index);
      if (!sound.asset) {
        assert.equal(url, undefined, name);
        continue;
      }
      const resource = manifest.assets[assetKey(sound.asset)];
      assert.ok(resource, name + ':' + sound.asset);
      assert.equal(canonicalPath, resource.canonicalPath, name);
      assert.equal(url, resource.path, name);
      assert.ok(manifest.files[url], name + ':' + url);
    }
  }
});

test('all playable roguelike UI banks and the shared UI/battle specifications are available', () => {
  for (const name of sourceNames) if (/^ui\.ON_ROGUELIKE/.test(name)) {
    const bank = requireBank(name);
    if (bank) assert.equal(manifest.audio.sfx.ui['mizuki:' + name], bank.sounds.find(sound => sound.asset).url, name);
  }
  for (const specs of [UI_SFX, BATTLE_SFX]) for (const spec of Object.values(specs)) {
    if (spec.bank) requireBank(spec.bank);
  }
});

test('every runtime SFX file matches real nonempty audio bytes and its recorded SHA256', () => {
  assert.ok(Object.keys(manifest.files).length > 0);
  for (const [url, record] of Object.entries(manifest.files)) {
    assert.equal(record.path, url);
    assert.ok(!/\/(?:raw|original|source)\//.test(url), 'source evidence is not a runtime asset: ' + url);
    const bytes = verify(record);
    if (record.type === 'audio/wav') {
      const format = waveFormat(bytes, url);
      assert.equal(format.sampleRate, record.sampleRate, url);
      assert.equal(format.channels, record.channels, url);
      assert.equal(format.bits, record.bitsPerSample, url);
      assert.equal(format.frames, record.frames, url);
      assert.equal(format.frames / format.sampleRate, record.duration, url);
    } else {
      assert.equal(record.type, 'audio/mpeg', url);
      verifyMp3(bytes, url);
    }
  }
});

test('native decoded clips retain hashed FSB source evidence outside the runtime inventory', () => {
  const nativeRecords = Object.values(manifest.files).filter(record => record.kind === 'PCM_WAV');
  assert.equal(manifest.coverage.nativeDecodedClips, nativeRecords.length);
  for (const record of nativeRecords) {
    assert.ok(record.original.path.startsWith('/assets/mizuki/native-sfx/raw/'), record.path);
    assert.equal(manifest.files[record.original.path], undefined, record.path);
    assert.equal(verify(record.original).toString('ascii', 0, 4), 'FSB5', record.path);
    assert.match(record.source.sha256, /^[a-f0-9]{64}$/, record.path);
    assert.equal(record.source.container.replace(/^dyn\//, '').replace(/\.[^.]+$/, '').toLowerCase(), assetKey(record.asset), record.path);
  }
});
