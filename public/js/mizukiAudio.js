// Private original-client BGM overlay. Shared audio code and manifests stay intact.
import { audio as sharedAudio } from './audio.js';
import { useEffect, useLayoutEffect, useRef } from '../vendor/hooks.module.js';
import { sha256Hex } from '../../shared/sha256.js';
import { store } from './store.js';
import { createMizukiSfxController } from './mizukiSfx.js';
import { cachedFetch, resourceCache } from './resourceCache.js';

const ROOT = '/assets/mizuki/native-audio/';
const MANIFEST = ROOT + 'manifest.json';
const SHA = /^[0-9a-f]{64}$/i;
const BATTLE_PHASES = new Set(['PREP', 'COMBAT']);
const OPENING_PHASES = new Set(['MIZUKI_SQUAD', 'MIZUKI_STRATEGY', 'MIZUKI_INITIAL_SUPPLY', 'MIZUKI_RECRUIT_GROUP']);
let modeController = null;
const privatePath = value => typeof value === 'string' && value.startsWith(ROOT)
  && !value.includes('..') && !/[?#\\]/.test(value);

export async function mizukiAudioDigest(bytes, { subtle = globalThis.crypto?.subtle } = {}) {
  if (subtle) return subtle.digest('SHA-256', bytes);
  // Plain HTTP LAN hosts do not expose SubtleCrypto. Reuse the project's exact SHA implementation.
  const hex = sha256Hex(new Uint8Array(bytes));
  return Uint8Array.from(hex.match(/../g), value => parseInt(value, 16)).buffer;
}

export function mizukiAudioStageId(field) {
  return field?.stage?.id || field?.meta?.stageId || null;
}

export function validateMizukiAudioManifest(value) {
  if (!value?.stages || !value?.tracks) throw new Error('Original Mizuki audio manifest is incomplete');
  const tracks = new Map();
  for (const record of Object.values(value.tracks)) {
    if (!privatePath(record?.path) || !SHA.test(record.sha256)
      || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || tracks.has(record.path)) {
      throw new Error('Invalid original Mizuki audio record');
    }
    tracks.set(record.path, record);
  }
  for (const [id, stage] of Object.entries(value.stages)) {
    if (!id || typeof stage?.bgmEvent !== 'string' || !stage.bgmEvent
      || !tracks.has(stage.loop) || stage.intro != null && !tracks.has(stage.intro)) {
      throw new Error('Unresolved original Mizuki BGM: ' + id);
    }
  }
  for (const [id, entry] of Object.entries(value.defaults || {})) {
    if (!entry?.bgmEvent || !tracks.has(entry.loop) || entry.intro != null && !tracks.has(entry.intro)) {
      throw new Error('Unresolved original Mizuki default BGM: ' + id);
    }
  }
  return { manifest: value, tracks };
}

/** A mounted battle owns the overlay; disposal restores the exact previous functions. */
export function createMizukiAudioController({ audio = sharedAudio, fetchFn = cachedFetch, cache = resourceCache,
  digest = mizukiAudioDigest,
  onError = error => console.warn('[mizuki-audio]', error.message) } = {}) {
  const originalManifest = audio.getManifest, originalPlay = audio.playBgm, originalBuffer = audio._buffer, originalStart = audio._startBgm;
  let active = true, manifest = null, records = new Map(), pending = null;
  let stageId = null, phase = null, modePhase = null, desired = null, lastError = null, requestedKey = audio.lastBgmKey;
  const buffers = new Map(), verified = new Set(), warned = new Set(), bankGains = new Map();
  function applyBankVolume(current) {
    if (!active || !desired || !current || current.loopUrl !== desired.track.loop || !audio.ctx) return;
    const volume = Number.isFinite(desired.entry.volume) && desired.entry.volume >= 0 ? desired.entry.volume : 1;
    let node = bankGains.get(current);
    if (!node && volume !== 1) {
      node = audio.ctx.createGain();
      current.gain.disconnect(); current.gain.connect(node); node.connect(audio.bgmGain);
      bankGains.set(current, node);
    }
    if (node) node.gain.setValueAtTime(volume, audio.ctx.currentTime);
    // Let the original manager finish its outgoing crossfade before releasing the bank gain.
    for (const [owner, gain] of bankGains) if (owner !== current) {
      bankGains.delete(owner);
      setTimeout(() => { try { gain.disconnect(); } catch { /* already released */ } }, 1200);
    }
  }
  async function overlayStart(key, track, token) {
    await originalStart.call(audio, key, track, token);
    if (active && token === audio.bgmToken && key === desired?.key) applyBankVolume(audio.bgm);
  }
  function report(error) {
    lastError = String(error?.message || error);
    if (!warned.has(lastError)) { warned.add(lastError); onError(error instanceof Error ? error : new Error(lastError)); }
  }
  function overlayManifest() {
    const base = originalManifest.call(audio);
    if (!active || !desired) return base;
    return { ...base, audio: { ...base?.audio, bgm: { ...base?.audio?.bgm, [desired.key]: desired.track } } };
  }
  function overlayPlay(key) {
    if (!active) return originalPlay.call(audio, key);
    if (!String(key || '').startsWith('mizuki:')) requestedKey = key;
    // A missing mapping stays silent instead of substituting another mode's battle music.
    const selected = modePhase || BATTLE_PHASES.has(phase) && stageId ? desired?.key || null : key;
    return originalPlay.call(audio, selected);
  }
  function overlayBuffer(url) {
    if (!active || typeof url !== 'string' || !url.startsWith(ROOT)) return originalBuffer.call(audio, url);
    if (buffers.has(url)) return buffers.get(url);
    const record = records.get(url);
    if (!record || !audio.ctx) { report(new Error('Unlisted or locked original Mizuki audio: ' + url)); return Promise.resolve(null); }
    const request = (async () => {
      try {
        const response = await fetchFn(url);
        if (!response.ok) throw new Error('Original Mizuki audio HTTP ' + response.status + ': ' + url);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== record.bytes) throw new Error('Original Mizuki audio byte length mismatch: ' + url);
        const hash = [...new Uint8Array(await digest(bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
        if (hash !== record.sha256.toLowerCase()) throw new Error('Original Mizuki audio SHA-256 mismatch: ' + url);
        if (!active) return null;
        const decoded = await new Promise((resolve, reject) => {
          const result = audio.ctx.decodeAudioData(bytes, resolve, reject);
          if (result?.then) result.then(resolve, reject);
        });
        if (!decoded) throw new Error('Original Mizuki audio decode failed: ' + url);
        verified.add(url);
        lastError = null;
        return decoded;
      } catch (error) { report(error); buffers.delete(url); return null; }
    })();
    buffers.set(url, request);
    return request;
  }
  audio.getManifest = overlayManifest;
  audio.playBgm = overlayPlay;
  audio._buffer = overlayBuffer;
  audio._startBgm = overlayStart;

  function sync() {
    if (!active) return;
    desired = null;
    if (BATTLE_PHASES.has(phase) && stageId && manifest) {
      const entry = manifest.stages[stageId];
      if (!entry) report(new Error('No original Mizuki BGM mapping for stage: ' + stageId));
      else desired = { key: 'mizuki:' + entry.bgmEvent, track: { intro: entry.intro || null, loop: entry.loop }, entry };
    } else if (modePhase && manifest) {
      const name = OPENING_PHASES.has(modePhase) ? 'background' : 'route';
      const entry = manifest.defaults?.[name];
      if (!entry) report(new Error('No original Mizuki default BGM mapping: ' + name));
      else desired = { key: 'mizuki:' + entry.bgmEvent, track: { intro: entry.intro || null, loop: entry.loop }, entry };
    }
    overlayPlay(requestedKey);
    applyBankVolume(audio.bgm);
  }
  let cacheRevision = -1;
  const offResources = cache.subscribe(state => {
    if (!active || state.cacheRevision === cacheRevision) return;
    cacheRevision = state.cacheRevision;
    if (!desired || !audio.ctx || audio.bgm?.loopUrl === desired.track.loop || !cache.isCached(desired.track.loop)) return;
    // A mode entered before its optional music finished caching must not stay silent.
    overlayPlay(requestedKey);
  });
  return {
    async load() {
      if (!active || manifest) return manifest;
      if (!pending) pending = (async () => {
        try {
          const response = await fetchFn(MANIFEST);
          if (!response.ok) throw new Error('Original Mizuki BGM manifest HTTP ' + response.status);
          const checked = validateMizukiAudioManifest(await response.json());
          if (!active) return null;
          manifest = checked.manifest; records = checked.tracks; lastError = null; sync();
          return manifest;
        } catch (error) { report(error); pending = null; return null; }
      })();
      return pending;
    },
    setStage(id, nextPhase = 'COMBAT') {
      if (!active || stageId === id && phase === nextPhase) return;
      stageId = typeof id === 'string' && id ? id : null; phase = nextPhase; lastError = null; sync();
    },
    setMode(nextPhase) {
      if (!active || modePhase === nextPhase) return;
      modePhase = nextPhase || null; lastError = null; sync();
    },
    snapshot() {
      return { active, stageId, phase, modePhase, bgmEvent: desired?.entry.bgmEvent || null, bank: desired?.entry.bank || null,
        loop: desired?.track.loop || null, intro: desired?.track.intro || null, volume: desired?.entry.volume ?? 1,
        waitingUnlock: !!desired && !audio.ctx, playing: !!desired && audio.bgm?.loopUrl === desired.track.loop,
        verified: [...verified], error: lastError, manifestLoaded: !!manifest };
    },
    dispose() {
      if (!active) return;
      active = false; desired = null;
      offResources();
      if (audio.getManifest === overlayManifest) audio.getManifest = originalManifest;
      if (audio._buffer === overlayBuffer) audio._buffer = originalBuffer;
      if (audio.playBgm === overlayPlay) audio.playBgm = originalPlay;
      if (audio._startBgm === overlayStart) audio._startBgm = originalStart;
      buffers.clear(); records.clear();
      // Invalidates in-flight decodes through the original BGM token and resumes the current route.
      originalPlay.call(audio, requestedKey);
      for (const gain of bankGains.values()) setTimeout(() => { try { gain.disconnect(); } catch { /* already released */ } }, 1200);
      bankGains.clear();
    },
  };
}

/** Own original music for the entire mode, including selection, nodes and rewards. */
export function useMizukiModeAudio() {
  useLayoutEffect(() => {
    const sounds = createMizukiSfxController();
    const current = createMizukiAudioController();
    const previous = globalThis.__SP_MIZUKI_AUDIO__;
    const previousSounds = globalThis.__SP_MIZUKI_SFX__;
    modeController = current;
    globalThis.__SP_MIZUKI_AUDIO__ = current;
    globalThis.__SP_MIZUKI_SFX__ = sounds;
    const sync = state => current.setMode(state.match?.private?.mizuki?.phase
      || state.match?.public?.mizuki?.phase || state.match?.public?.phase);
    sync(store.get());
    const off = store.subscribe(sync);
    void sounds.load();
    void current.load();
    return () => {
      off();
      if (modeController === current) modeController = null;
      current.dispose();
      sounds.dispose();
      if (globalThis.__SP_MIZUKI_AUDIO__ === current) globalThis.__SP_MIZUKI_AUDIO__ = previous || null;
      if (globalThis.__SP_MIZUKI_SFX__ === sounds) globalThis.__SP_MIZUKI_SFX__ = previousSounds || null;
    };
  }, []);
}

/** Uses the viewed field, including a teammate's field while waiting at a rendezvous. */
export function useMizukiBattleAudio(field, phase) {
  const controller = useRef(null);
  const stageId = mizukiAudioStageId(field);
  useEffect(() => {
    const inherited = modeController;
    const current = inherited || createMizukiAudioController();
    controller.current = current;
    const previous = globalThis.__SP_MIZUKI_AUDIO__;
    globalThis.__SP_MIZUKI_AUDIO__ = current;
    current.load();
    return () => {
      if (inherited) current.setStage(null, null);
      else current.dispose();
      if (controller.current === current) controller.current = null;
      if (!inherited && globalThis.__SP_MIZUKI_AUDIO__ === current) globalThis.__SP_MIZUKI_AUDIO__ = previous || null;
    };
  }, []);
  useEffect(() => { controller.current?.setStage(stageId, phase); }, [stageId, phase]);
}
