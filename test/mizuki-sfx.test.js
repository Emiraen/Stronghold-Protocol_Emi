import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMizukiSfxController, mergeMizukiSfx, validateMizukiSfxManifest } from '../public/js/mizukiSfx.js';
import { createMizukiAudioController } from '../public/js/mizukiAudio.js';
import { createMizukiBattleSfx } from '../public/js/mizukiBattleSfx.js';

const sound = '/assets/mizuki/native-sfx/fixture.wav';
const previousSound = '/assets/audio/sfx/previous.wav';
const music = '/assets/mizuki/native-audio/fixture.wav';
const bytes = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]);
const hash = createHash('sha256').update(bytes).digest('hex');
const record = path => ({ path, bytes: bytes.byteLength, sha256: hash });
const sfxManifest = () => ({ schema: 1, files: { [sound]: record(sound) }, audio: { sfx: {
  ui: { confirm: sound }, battle: { leak: sound }, units: { char_fixture: { attack: sound,
    skills: { 2: sound }, attacks: { 2: sound }, hits: { 2: sound },
    mix: { hit: { vol: 0.4 } }, attackMix: { 2: { vol: 0.6 } }, hitMix: { 2: { vol: 0.7 } } } },
} } });
const bgmManifest = { tracks: { [music]: record(music) }, stages: {
  fixture_stage: { bgmEvent: 'fixture', bank: 'battle.fixture', intro: null, loop: music },
} };
const baseManifest = () => ({ audio: { bgm: { lobby: { loop: '/shared/lobby.wav' } }, sfx: {
  ui: { click: previousSound }, battle: { deploy: previousSound }, units: { char_fixture: {
    born: previousSound, skills: { 0: previousSound }, attacks: { 0: previousSound }, hits: { 0: previousSound },
    mix: { attack: { vol: 0.8 } }, attackMix: { 0: { vol: 0.2 } }, hitMix: { 0: { vol: 0.3 } },
  } },
} } });

function fixture() {
  const base = baseManifest(), requested = [], errors = [];
  const audio = {
    ctx: { decodeAudioData(buffer, done) { done({ decoded: true, bytes: buffer.byteLength }); } },
    lastBgmKey: 'lobby', bgm: null, units: [],
    getManifest() { return base; },
    _buffer(url) { requested.push(url); return Promise.resolve({ shared: true, url }); },
    playBgm(key) { this.lastBgmKey = key; },
    async _startBgm() {},
    setFieldUnits(units) { this.units = units; },
    handleBattleEvents() {},
  };
  const originals = { manifest: audio.getManifest, buffer: audio._buffer, play: audio.playBgm, start: audio._startBgm };
  const fetchFn = async url => {
    if (url === '/assets/mizuki/native-sfx/manifest.json') return { ok: true, json: async () => sfxManifest() };
    if (url === '/assets/mizuki/native-audio/manifest.json') return { ok: true, json: async () => bgmManifest };
    if (url === music) return { ok: true, arrayBuffer: async () => bytes.slice().buffer };
    throw new Error('Unexpected fixture URL: ' + url);
  };
  return { audio, base, requested, errors, originals, fetchFn, onError: error => errors.push(error.message) };
}

test('Mizuki SFX merges different skill indices and mix tables while leaving both source manifests intact', () => {
  const base = baseManifest(), addition = sfxManifest();
  const saved = [JSON.stringify(base), JSON.stringify(addition)];
  const merged = mergeMizukiSfx(base, validateMizukiSfxManifest(addition));
  const unit = merged.audio.sfx.units.char_fixture;
  assert.deepEqual(unit.skills, { 0: previousSound, 2: sound });
  assert.deepEqual(unit.attacks, { 0: previousSound, 2: sound });
  assert.deepEqual(unit.hits, { 0: previousSound, 2: sound });
  assert.deepEqual(unit.mix, { attack: { vol: 0.8 }, hit: { vol: 0.4 } });
  assert.deepEqual(unit.attackMix, { 0: { vol: 0.2 }, 2: { vol: 0.6 } });
  assert.deepEqual(unit.hitMix, { 0: { vol: 0.3 }, 2: { vol: 0.7 } });
  assert.equal(unit.born, previousSound);
  assert.deepEqual(merged.audio.sfx.ui, { click: previousSound, confirm: sound });
  assert.deepEqual(merged.audio.sfx.battle, { deploy: previousSound, leak: sound });
  assert.deepEqual([JSON.stringify(base), JSON.stringify(addition)], saved);
});

test('Mizuki SFX accepts registered private/shared sound paths and rejects unregistered or invalid entries', () => {
  const shared = sfxManifest();
  shared.files[previousSound] = record(previousSound);
  shared.audio.sfx.units.char_fixture.born = previousSound;
  assert.equal(validateMizukiSfxManifest(shared), shared);
  const absent = sfxManifest(); absent.audio.sfx.units.char_fixture.skills[1] = '/assets/mizuki/native-sfx/missing.wav';
  assert.throws(() => validateMizukiSfxManifest(absent), /未登记/);
  const relative = sfxManifest(); relative.audio.sfx.units.char_fixture.attack = 'unregistered.wav';
  assert.throws(() => validateMizukiSfxManifest(relative), /未登记/);
  const external = sfxManifest(); external.audio.sfx.units.char_fixture.attack = 'https://example.invalid/sound.wav';
  assert.throws(() => validateMizukiSfxManifest(external), /未登记/);
  const outside = sfxManifest(); outside.files['/assets/mizuki/native-sfx/../outside.wav'] = record('/assets/mizuki/native-sfx/../outside.wav');
  assert.throws(() => validateMizukiSfxManifest(outside), /条目无效/);
  const query = sfxManifest(); query.files[sound + '?x=1'] = record(sound + '?x=1');
  assert.throws(() => validateMizukiSfxManifest(query), /条目无效/);
  const corrupt = sfxManifest(); corrupt.files[sound].sha256 = 'not-a-sha';
  assert.throws(() => validateMizukiSfxManifest(corrupt), /条目无效/);
});

for (const order of ['sfx-first', 'bgm-first']) test('Mizuki BGM/SFX overlays coexist and restore exact functions in ' + order + ' nesting', async () => {
  const f = fixture(), saved = JSON.stringify(f.base), controllers = [];
  const create = name => name === 'sfx'
    ? createMizukiSfxController(f)
    : createMizukiAudioController({ ...f, digest: async buffer => createHash('sha256').update(new Uint8Array(buffer)).digest() });
  try {
    const firstName = order === 'sfx-first' ? 'sfx' : 'bgm';
    const first = create(firstName); controllers.push(first); await first.load();
    const middle = { manifest: f.audio.getManifest, buffer: f.audio._buffer, play: f.audio.playBgm, start: f.audio._startBgm };
    const second = create(firstName === 'sfx' ? 'bgm' : 'sfx'); controllers.push(second); await second.load();
    const bgm = firstName === 'bgm' ? first : second;
    bgm.setStage('fixture_stage', 'COMBAT');
    const merged = f.audio.getManifest();
    assert.equal(merged.audio.bgm['mizuki:fixture'].loop, music);
    assert.equal(merged.audio.bgm.lobby.loop, '/shared/lobby.wav');
    assert.deepEqual(merged.audio.sfx.units.char_fixture.skills, { 0: previousSound, 2: sound });
    assert.deepEqual(await f.audio._buffer(sound), { shared: true, url: sound });
    assert.deepEqual(await f.audio._buffer(music), { decoded: true, bytes: bytes.byteLength });
    assert.equal(JSON.stringify(f.base), saved);
    assert.deepEqual(f.errors, []);
    second.dispose(); controllers.pop();
    assert.strictEqual(f.audio.getManifest, middle.manifest);
    assert.strictEqual(f.audio._buffer, middle.buffer);
    assert.strictEqual(f.audio.playBgm, middle.play);
    assert.strictEqual(f.audio._startBgm, middle.start);
    first.dispose(); controllers.pop();
    assert.strictEqual(f.audio.getManifest, f.originals.manifest);
    assert.strictEqual(f.audio._buffer, f.originals.buffer);
    assert.strictEqual(f.audio.playBgm, f.originals.play);
    assert.strictEqual(f.audio._startBgm, f.originals.start);
  } finally { for (const controller of controllers.reverse()) controller.dispose(); }
});

test('Mizuki drops delayed SFX from an old battle or terminal view while retaining current/prep UI playback', async () => {
  const f = fixture(), resolvers = [];
  f.audio._buffer = () => new Promise(resolve => resolvers.push(resolve));
  const controller = createMizukiSfxController(f), battle = createMizukiBattleSfx(f.audio);
  const field = id => ({ fieldId: id, battleId: 'battle-' + id, meta: { units: [] }, units: [] });
  const decoded = { decoded: true };
  try {
    await controller.load();
    const ui = f.audio._buffer(sound); resolvers.shift()(decoded);
    assert.equal(await ui, decoded, 'preparation UI SFX have no combat scope to invalidate');
    battle.setField(field('a'));
    const old = f.audio._buffer(sound);
    battle.setField(field('b')); resolvers.shift()(decoded);
    assert.equal(await old, null);
    const current = f.audio._buffer(sound); resolvers.shift()(decoded);
    assert.equal(await current, decoded);
    const ending = f.audio._buffer(sound);
    battle.setField(field('b'), { phase: 'COMBAT', finishing: true }); resolvers.shift()(decoded);
    assert.equal(await ending, null);
    const disposed = f.audio._buffer(sound);
    controller.dispose(); resolvers.shift()(decoded);
    assert.equal(await disposed, null);
  } finally { battle.dispose(); controller.dispose(); }
});
