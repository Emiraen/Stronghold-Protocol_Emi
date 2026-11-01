import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = 'C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows';
const PREFIX = '/assets/mizuki/native-audio/';
const json = path => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const manifest = json('public/assets/mizuki/native-audio/manifest.json');
const levelIndex = json('data/mizuki/levels/index.json');
const audioDataBytes = readFileSync(resolve(ROOT, '.cache/mizuki-native-audio/audio_data.json'));
const audioData = JSON.parse(audioDataBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = url => {
  assert.ok(url.startsWith(PREFIX), url);
  assert.ok(!url.includes('..'), url);
  return readFileSync(resolve(ROOT, 'public', url.slice(1)));
};
const verify = record => {
  const data = bytes(record.path);
  assert.equal(data.length, record.bytes, record.path);
  assert.equal(hash(data), record.sha256, record.path);
  return data;
};

function waveFormat(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let format, dataBytes;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const kind = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= buffer.length);
    if (kind === 'fmt ') format = {
      codec: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10),
      sampleRate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22),
      blockAlign: buffer.readUInt16LE(offset + 20),
    };
    if (kind === 'data') dataBytes = size;
    offset += 8 + size + (size % 2);
  }
  assert.ok(format && dataBytes > 0);
  return { ...format, frames: dataBytes / format.blockAlign };
}

test('every original level and all 97 aliases resolve their own exact original BGM bank', () => {
  assert.equal(Object.keys(manifest.levels).length, 60);
  assert.equal(Object.keys(manifest.stages).length, 97);
  assert.equal(Object.keys(manifest.events).length, 7);
  for (const [stageId, alias] of Object.entries(levelIndex.stagesById)) {
    const stage = manifest.stages[stageId];
    const level = json('data/mizuki/levels/' + alias.file);
    assert.equal(stage.levelId, alias.levelId, stageId);
    assert.equal(stage.bgmEvent, level.bgmEvent, stageId);
    const source = audioData.bgmBanks.find(bank => bank.name === 'battle.ON_GAME_READY.' + level.bgmEvent);
    assert.ok(source, stageId);
    assert.equal(stage.bank, source.name);
    assert.deepEqual(stage.evidence.bankEvidence.record, source);
    assert.equal(manifest.tracks[stage.loop].asset, source.loop);
    assert.equal(stage.intro ? manifest.tracks[stage.intro].asset : null, source.intro);
    assert.equal(stage.volume, source.volume);
    assert.equal(stage.crossfade, source.crossfade);
    assert.equal(stage.evidence.sha256, alias.sha256);
  }
  assert.equal(manifest.events.rl2shopbattle.intro, null);
  assert.match(manifest.tracks[manifest.events.rogueboss.loop].asset, /act12d6d0\/m_bat_rglk0boss_loop$/);
});

test('all 20 tracks retain original rate/channels/bit depth as full PCM without lossy re-encoding', () => {
  assert.equal(Object.keys(manifest.tracks).length, 20);
  for (const [url, track] of Object.entries(manifest.tracks)) {
    assert.equal(track.path, url);
    const format = waveFormat(verify(track));
    const original = JSON.parse(bytes(track.typeTree.path));
    assert.equal(format.codec, 1, basename(url));
    assert.equal(format.sampleRate, original.m_Frequency);
    assert.equal(format.channels, original.m_Channels);
    assert.equal(format.bits, original.m_BitsPerSample);
    assert.equal(format.sampleRate, track.sampleRate);
    assert.equal(format.channels, track.channels);
    assert.equal(format.bits, track.bitsPerSample);
    assert.equal(format.frames, track.frames);
    assert.ok(Math.abs(format.frames / format.sampleRate - original.m_Length) <= 0.002);
    assert.equal(verify(track.original).subarray(0, 4).toString('ascii'), 'FSB5');
    assert.ok(verify(track.rawObject).length > 0);
  }
});

test('every exported playable/source file and all fourteen installed source bundles have recorded SHA256 and bytes', () => {
  assert.equal(Object.keys(manifest.groups.audio).length, 81);
  for (const record of Object.values(manifest.groups.audio)) verify(record);
  assert.equal(Object.keys(manifest.bundlesSha256).length, 14);
  for (const [bundle, sha256] of Object.entries(manifest.bundlesSha256)) {
    assert.equal(hash(readFileSync(resolve(CLIENT, bundle))), sha256, bundle);
  }
  for (const track of Object.values(manifest.tracks)) {
    assert.equal(track.sourceBundleSha256, manifest.bundlesSha256[track.sourceBundle]);
    assert.equal(track.container.replace(/^dyn\//, '').replace(/\.[^.]+$/, '').toLowerCase(), track.asset.toLowerCase());
  }
});

test('original bank table evidence is traceable and no universal-theme substitution is present', () => {
  const evidence = json('public/assets/mizuki/native-audio/source/bank-evidence.json');
  assert.equal(hash(audioDataBytes), manifest.audioDataSource.sha256);
  assert.equal(audioDataBytes.length, manifest.audioDataSource.bytes);
  assert.deepEqual(evidence.source, manifest.audioDataSource);
  const banks = { ...manifest.events, ...manifest.systemEvents };
  assert.deepEqual(Object.keys(evidence.banks).sort(), Object.keys(banks).sort());
  for (const [event, item] of Object.entries(evidence.banks)) {
    const index = Number(item.jsonPointer.split('/').at(-1));
    assert.deepEqual(item.record, audioData.bgmBanks[index]);
    assert.deepEqual(banks[event].evidence, item);
  }
  assert.deepEqual(manifest.missing, []);
  assert.deepEqual(manifest.warnings, []);
});

test('selection and route defaults use the original Mizuki system banks and retain all seven system variants', () => {
  assert.deepEqual(Object.keys(manifest.defaults).sort(), ['background', 'route']);
  assert.deepEqual(Object.keys(manifest.systemEvents).sort(), [
    'BACKGROUND', 'DEEPMAPHIGH', 'DEEPMAPLOW', 'MAPHIGH', 'MAPLOW', 'VARIATIONHIGH', 'VARIATIONLOW',
  ]);
  assert.deepEqual(manifest.defaults.background, manifest.systemEvents.BACKGROUND);
  assert.deepEqual(manifest.defaults.route, manifest.systemEvents.MAPHIGH);
  assert.equal(manifest.defaults.background.bank, 'sys.ON_ROGUELIKE_BACKGROUND.rogue_2');
  assert.equal(manifest.defaults.route.bank, 'sys.ON_ROGUELIKE_MAPHIGH.rogue_2');
  assert.match(manifest.tracks[manifest.defaults.background.loop].asset, /rogue_2\/m_sys_rglk2DLC_loop$/);
  assert.match(manifest.tracks[manifest.defaults.route.loop].asset, /rogue_2\/m_sys_rglk2theme1_loop$/);
  for (const [name, bank] of Object.entries(manifest.systemEvents)) {
    const source = audioData.bgmBanks.find(entry => entry.name === bank.bank);
    assert.ok(source, name);
    assert.equal(bank.bgmEvent, source.name, name);
    assert.equal(manifest.tracks[bank.loop].asset, source.loop, name);
    assert.equal(bank.intro ? manifest.tracks[bank.intro].asset : null, source.intro, name);
    assert.equal(bank.volume, source.volume, name);
    assert.equal(bank.crossfade, source.crossfade, name);
    assert.deepEqual(bank.evidence.record, source, name);
  }
});
