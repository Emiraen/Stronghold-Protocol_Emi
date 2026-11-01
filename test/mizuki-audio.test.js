import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AudioManager, resolveBgm } from '../public/js/audio.js';
import { createMizukiAudioController, mizukiAudioStageId, mizukiAudioDigest, validateMizukiAudioManifest } from '../public/js/mizukiAudio.js';

const ROOT = '/assets/mizuki/native-audio/';
const bytes = new Uint8Array([82, 73, 70, 70, 3, 2, 1, 0]);
const sha = createHash('sha256').update(bytes).digest('hex');
const record = name => ({ path: ROOT + name + '.wav', bytes: bytes.byteLength, sha256: sha });
const tracks = ['intro', 'loop', 'boss'].map(record);
const defaults = ['selection', 'route'].map(record);
const manifest = { tracks: Object.fromEntries([...tracks, ...defaults].map(v => [v.path, v])), stages: {
  ro2_n_1_1: { bgmEvent: 'normal', bank: 'battle.ON_GAME_READY.normal', intro: tracks[0].path, loop: tracks[1].path },
  ro2_n_1_2: { bgmEvent: 'normal', bank: 'battle.ON_GAME_READY.normal', intro: tracks[0].path, loop: tracks[1].path },
  ro2_b_1: { bgmEvent: 'boss', bank: 'battle.ON_GAME_READY.boss', intro: null, loop: tracks[2].path, volume: 0.9 },
}, defaults: {
  background: { bgmEvent: 'sys.ON_ROGUELIKE_BACKGROUND.rogue_2', bank: 'sys.ON_ROGUELIKE_BACKGROUND.rogue_2', intro: null, loop: defaults[0].path },
  route: { bgmEvent: 'sys.ON_ROGUELIKE_MAPHIGH.rogue_2', bank: 'sys.ON_ROGUELIKE_MAPHIGH.rogue_2', intro: null, loop: defaults[1].path },
} };
const flush = () => new Promise(resolve => setImmediate(resolve));
async function decoded(f) {
  const selected = f.controller.snapshot();
  await Promise.all([selected.intro, selected.loop].filter(Boolean).map(url => f.audio._buffer(url)));
  await flush();
}

function fixture({ unlocked = true, fetchFn, cache } = {}) {
  const sources = [], gains = [], requests = [], errors = [];
  class Param {
    constructor() { this.value = 1; }
    setValueAtTime(v) { this.value = v; }
    linearRampToValueAtTime(v) { this.value = v; }
    setTargetAtTime(v) { this.value = v; }
    cancelScheduledValues() {}
  }
  class Node { connect(target) { this.target = target; } disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); gains.push(this); } }
  class Source extends Node { constructor() { super(); sources.push(this); } start(at) { this.started = at; } stop(at) { this.stopped = at; } }
  class Context {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createGain() { return new Gain(); }
    createBufferSource() { return new Source(); }
    createBuffer() { return { getChannelData: () => new Float32Array(1) }; }
    decodeAudioData(ab, ok) { ok({ duration: 7.5, bytes: ab.byteLength }); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  const base = { audio: { bgm: { lobby: { loop: '/shared/lobby' }, prep: { loop: '/shared/prep' }, combat: { loop: '/shared/combat' } }, sfx: { marker: true } } };
  const audio = new AudioManager({ getManifest: () => base, win: { AudioContext: Context, document: {}, removeEventListener() {} } });
  // This is the pre-existing shared cache boundary; private files must bypass it with verified bytes.
  audio._buffer = async url => ({ duration: 2, shared: url });
  if (unlocked) audio._unlock();
  const originals = { manifest: audio.getManifest, play: audio.playBgm, buffer: audio._buffer };
  const controller = createMizukiAudioController({ audio, cache, onError: error => errors.push(error.message),
    fetchFn: async url => { requests.push(url); return fetchFn ? fetchFn(url) : url.endsWith('manifest.json')
      ? { ok: true, json: async () => manifest } : { ok: true, arrayBuffer: async () => bytes.slice().buffer }; } });
  return { audio, base, originals, controller, requests, sources, gains, errors };
}

test('original music selection uses the viewed field stage and rejects unresolved paths', () => {
  assert.equal(mizukiAudioStageId({ stage: { id: 'ro2_b_1' }, meta: { stageId: 'wrong' } }), 'ro2_b_1');
  assert.equal(mizukiAudioStageId({ meta: { stageId: 'ro2_n_1_1' } }), 'ro2_n_1_1');
  assert.equal(mizukiAudioStageId(null), null);
  assert.equal(validateMizukiAudioManifest(manifest).tracks.size, 5);
  assert.throws(() => validateMizukiAudioManifest({ tracks: {}, stages: manifest.stages }), /Unresolved/);
  const bad = structuredClone(manifest); bad.tracks[tracks[0].path].path = ROOT + '../outside.wav';
  assert.throws(() => validateMizukiAudioManifest(bad), /Invalid/);
  const missingDefault = structuredClone(manifest); missingDefault.defaults.route.loop = ROOT + 'absent.wav';
  assert.throws(() => validateMizukiAudioManifest(missingDefault), /Unresolved original Mizuki default BGM/);
});

test('optional Mizuki music resumes after caching, shares pending playback and unsubscribes on exit', async () => {
  let listener, available = false, unsubscribed = false;
  const cache = { isCached: () => available, subscribe(fn) { listener = fn; return () => { unsubscribed = true; }; } };
  const f = fixture({ cache, fetchFn: async url => {
    if (url.endsWith('manifest.json')) return { ok: true, json: async () => manifest };
    if (!available) throw Object.assign(new Error('optional music not cached'), { name: 'ResourceUnavailableError' });
    return { ok: true, arrayBuffer: async () => bytes.slice().buffer };
  } });
  try {
    f.controller.setMode('MIZUKI_ROUTE'); await f.controller.load(); await decoded(f);
    assert.equal(f.audio.bgm, null);
    available = true;
    listener({ cacheRevision: 1 }); listener({ cacheRevision: 2 }); listener({ cacheRevision: 2 });
    await decoded(f);
    assert.equal(f.audio.bgm.loopUrl, defaults[1].path);
    assert.equal(f.controller.snapshot().error, null);
    const started = f.sources.length;
    listener({ cacheRevision: 3 }); await flush();
    assert.equal(f.sources.length, started, 'unrelated downloads do not restart the playing loop');
    f.controller.dispose();
    assert.equal(unsubscribed, true);
    listener({ cacheRevision: 4 }); await flush();
    assert.equal(f.controller.snapshot().active, false);
  } finally { f.controller.dispose(); }
});

test('Mizuki selection and route defaults retain music ownership over ordinary route requests', async () => {
  const f = fixture(), { audio, controller } = f;
  try {
    controller.setMode('MIZUKI_SQUAD'); await controller.load(); await decoded(f);
    assert.equal(audio.bgm.loopUrl, defaults[0].path);
    assert.equal(controller.snapshot().bank, 'sys.ON_ROGUELIKE_BACKGROUND.rogue_2');
    const started = f.sources.length;
    for (const phase of ['MIZUKI_STRATEGY', 'MIZUKI_INITIAL_SUPPLY', 'MIZUKI_RECRUIT_GROUP']) {
      controller.setMode(phase); audio.playBgm('prep'); await flush();
      assert.equal(audio.bgm.loopUrl, defaults[0].path);
    }
    assert.equal(f.sources.length, started, 'opening selections share the same continuous original loop');
    controller.setMode('MIZUKI_ROUTE'); await decoded(f);
    assert.equal(audio.bgm.loopUrl, defaults[1].path);
    const routeStarted = f.sources.length;
    for (const phase of ['MIZUKI_EVENT', 'MIZUKI_RECRUIT', 'MIZUKI_SHOP', 'MIZUKI_REWARD']) {
      controller.setMode(phase); audio.playBgm('lobby'); await flush();
      assert.equal(audio.bgm.loopUrl, defaults[1].path);
    }
    assert.equal(f.sources.length, routeStarted, 'node interactions keep the route loop playing');
    assert.deepEqual(f.errors, []);
  } finally { controller.dispose(); }
  await flush();
  assert.equal(audio.bgm.loopUrl, '/shared/lobby', 'leaving Mizuki resumes the latest ordinary route request');
});

test('viewed stage BGM overrides mode defaults until the battle view releases its stage', async () => {
  const f = fixture(), { audio, controller } = f;
  try {
    controller.setMode('MIZUKI_ROUTE'); await controller.load(); await decoded(f);
    controller.setStage('ro2_b_1', 'COMBAT'); await decoded(f);
    assert.equal(audio.bgm.loopUrl, tracks[2].path);
    controller.setMode('MIZUKI_REWARD'); audio.playBgm('prep'); await flush();
    assert.equal(audio.bgm.loopUrl, tracks[2].path, 'the retained final battle frame keeps its original stage music');
    controller.setStage(null, null); await decoded(f);
    assert.equal(audio.bgm.loopUrl, defaults[1].path);
    assert.equal(controller.snapshot().modePhase, 'MIZUKI_REWARD');
    assert.equal(controller.snapshot().stageId, null);
  } finally { controller.dispose(); }
  await flush();
  assert.equal(audio.bgm.loopUrl, '/shared/prep');
});

test('normal and boss tracks use the original BGM channel without shared manifest changes', async () => {
  const f = fixture(), { audio, controller } = f;
  const gain = audio.bgmGain, base = JSON.stringify(f.base);
  try {
    controller.setStage('ro2_n_1_1', 'PREP'); await controller.load(); await decoded(f);
    assert.equal(audio.bgm.loopUrl, tracks[1].path);
    assert.equal(audio.bgm.nodes.length, 2, 'official intro then loop');
    assert.strictEqual(audio.bgm.gain.target, gain);
    assert.strictEqual(audio.getManifest().audio.sfx, f.base.audio.sfx);
    const started = f.sources.length;
    controller.setStage('ro2_n_1_2', 'COMBAT'); audio.playBgm('combat'); await flush();
    assert.equal(f.sources.length, started, 'same original loop continues across stage and phase sync');
    controller.setStage('ro2_b_1', 'COMBAT'); await decoded(f);
    assert.equal(audio.bgm.loopUrl, tracks[2].path);
    assert.equal(audio.bgm.nodes.length, 1, 'no invented intro for a bank without one');
    assert.equal(audio.bgm.gain.target.gain.value, 0.9, 'original bank volume is independent of the user volume');
    assert.strictEqual(audio.bgm.gain.target.target, gain);
    assert.equal(controller.snapshot().playing, true);
    assert.deepEqual(controller.snapshot().verified.sort(), tracks.map(v => v.path).sort());
    assert.equal(JSON.stringify(f.base), base);
    assert.deepEqual(f.errors, []);
  } finally { controller.dispose(); }
  assert.strictEqual(audio.getManifest, f.originals.manifest);
  assert.strictEqual(audio._buffer, f.originals.buffer);
  assert.strictEqual(audio.playBgm, f.originals.play);
});

test('gesture unlock starts the requested original track and returns to the latest route on disposal', async () => {
  const f = fixture({ unlocked: false }), { audio, controller } = f;
  try {
    audio.playBgm('combat'); controller.setStage('ro2_n_1_1'); await controller.load();
    assert.equal(controller.snapshot().waitingUnlock, true);
    audio._unlock(); await decoded(f);
    assert.equal(audio.bgm.loopUrl, tracks[1].path);
    audio.playBgm('lobby');
  } finally { controller.dispose(); }
  await flush();
  assert.equal(audio.lastBgmKey, 'lobby');
  assert.equal(audio.bgm.loopUrl, '/shared/lobby');
  assert.equal(resolveBgm(audio.getManifest(), 'mizuki:normal'), null);
});

test('original volume, mute and visibility controls remain on the shared Web Audio graph', async () => {
  const f = fixture(), { audio, controller } = f;
  try {
    controller.setStage('ro2_n_1_1'); await controller.load(); await decoded(f);
    audio.setVolumes({ bgm: 0.25, sfx: 0.4, muted: false });
    assert.equal(audio.bgmGain.gain.value, 0.25 ** 2 * 0.55);
    audio.setVolumes({ muted: true }); assert.equal(audio.master.gain.value, 0);
    audio.setVolumes({ muted: false }); assert.equal(audio.master.gain.value, 1);
    audio.win.document.hidden = true; audio._onVis(); await flush();
    assert.equal(audio.ctx.state, 'suspended');
    audio.win.document.hidden = false; audio._onVis(); await flush();
    assert.equal(audio.ctx.state, 'running');
    assert.equal(controller.snapshot().playing, true);
  } finally { controller.dispose(); }
});

test('original audio integrity remains checked on an HTTP LAN without SubtleCrypto', async () => {
  assert.equal(Buffer.from(await mizukiAudioDigest(bytes.buffer, { subtle: null })).toString('hex'), sha);
});

test('corrupt audio is rejected before decoding and never substituted by another mode track', async () => {
  const f = fixture({ fetchFn: async url => url.endsWith('manifest.json') ? { ok: true, json: async () => manifest }
    : { ok: true, arrayBuffer: async () => new Uint8Array(bytes.length).buffer } });
  try {
    f.controller.setStage('ro2_b_1'); await f.controller.load(); await decoded(f);
    assert.equal(f.audio.bgm, null);
    assert.match(f.controller.snapshot().error, /SHA-256 mismatch/);
    assert.equal(f.controller.snapshot().verified.length, 0);
    assert.ok(!f.requests.some(url => url.startsWith('/shared/')));
  } finally { f.controller.dispose(); }
});

test('missing stage mappings are visible and late manifest loads cannot resurrect a disposed view', async () => {
  const f = fixture();
  try {
    f.controller.setStage('unknown'); await f.controller.load();
    assert.match(f.controller.snapshot().error, /No original Mizuki BGM mapping/);
    assert.equal(f.audio.bgm, null);
  } finally { f.controller.dispose(); }
  let finish;
  const late = fixture({ fetchFn: () => new Promise(resolve => { finish = resolve; }) });
  late.controller.setStage('ro2_b_1'); const loading = late.controller.load();
  late.controller.dispose(); finish({ ok: true, json: async () => manifest }); await loading;
  assert.equal(late.controller.snapshot().active, false);
  assert.strictEqual(late.audio.getManifest, late.originals.manifest);
  assert.equal(late.controller.snapshot().manifestLoaded, false);
});
