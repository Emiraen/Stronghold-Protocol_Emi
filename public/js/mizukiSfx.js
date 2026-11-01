import { audio as sharedAudio } from './audio.js';
import { mizukiBattleSfxScope } from './mizukiBattleSfx.js';

const MANIFEST = '/assets/mizuki/native-sfx/manifest.json';
const soundPath = path => typeof path === 'string' && /^\/assets\/(?:audio\/sfx\/|mizuki\/native-sfx\/)/.test(path)
  && !path.includes('..') && !/[?#\\]/.test(path);
const tables = ['skills', 'attacks', 'hits', 'mix', 'attackMix', 'hitMix'];

export function validateMizukiSfxManifest(value) {
  if (value?.schema !== 1 || !value.audio?.sfx?.units || !value.files) throw Error('水月原版音效清单不完整');
  for (const [url, record] of Object.entries(value.files)) {
    if (!soundPath(url) || record.path !== url || !/^[0-9a-f]{64}$/i.test(record.sha256)
      || !Number.isSafeInteger(record.bytes) || record.bytes <= 0) throw Error('水月音效资源条目无效：' + url);
  }
  const paths = object => {
    if (typeof object === 'string') {
      if (!soundPath(object) || !value.files[object]) throw Error('水月音效未登记：' + object);
    } else if (object && typeof object === 'object') Object.values(object).forEach(paths);
  };
  paths(value.audio.sfx);
  return value;
}

export function mergeMizukiSfx(base, addition) {
  const previous = base?.audio?.sfx || {}, next = addition.audio.sfx;
  const units = { ...previous.units };
  for (const [id, record] of Object.entries(next.units || {})) {
    units[id] = { ...units[id], ...record };
    for (const table of tables) if (previous.units?.[id]?.[table] || record[table]) {
      units[id][table] = { ...previous.units?.[id]?.[table], ...record[table] };
    }
  }
  return { ...base, audio: { ...base?.audio, sfx: { ...previous, ...next,
    ui: { ...previous.ui, ...next.ui }, battle: { ...previous.battle, ...next.battle }, units } } };
}

// Add the complete mode roster while retaining the existing mixer, volume and
// event playback. Disposal restores the exact manager functions for other modes.
export function createMizukiSfxController({ audio = sharedAudio, fetchFn = globalThis.fetch,
  onError = error => console.warn('[mizuki-sfx]', error.message) } = {}) {
  const originalManifest = audio.getManifest, originalBuffer = audio._buffer;
  let active = true, manifest = null, pending = null, error = null;
  let cachedBase, cachedManifest, cachedView;
  function overlayManifest() {
    const base = originalManifest.call(audio);
    if (!active || !manifest) return base;
    if (cachedBase !== base || cachedManifest !== manifest) {
      cachedBase = base; cachedManifest = manifest; cachedView = mergeMizukiSfx(base, manifest);
    }
    return cachedView;
  }
  function overlayBuffer(url) {
    const job = originalBuffer.call(audio, url);
    if (!active || !soundPath(url)) return job;
    const scope = mizukiBattleSfxScope(audio);
    // Decode/cache may finish after another field or after the result dialog.
    // Keep the shared cache, but drop that obsolete playback request.
    return Promise.resolve(job).then(buffer => active && (!scope || mizukiBattleSfxScope(audio) === scope) ? buffer : null);
  }
  audio.getManifest = overlayManifest;
  audio._buffer = overlayBuffer;
  return {
    async load() {
      if (!active || manifest) return manifest;
      if (!pending) pending = (async () => {
        try {
          const response = await fetchFn(MANIFEST);
          if (!response.ok) throw Error('水月原版音效清单 HTTP ' + response.status);
          const checked = validateMizukiSfxManifest(await response.json());
          if (!active) return null;
          manifest = checked; error = null; return manifest;
        } catch (failure) {
          error = String(failure?.message || failure); pending = null; onError(failure); return null;
        }
      })();
      return pending;
    },
    snapshot() { return { active, loaded: !!manifest, files: Object.keys(manifest?.files || {}).length,
      units: Object.keys(manifest?.audio?.sfx?.units || {}).length, error }; },
    dispose() {
      if (!active) return;
      active = false;
      if (audio.getManifest === overlayManifest) audio.getManifest = originalManifest;
      if (audio._buffer === overlayBuffer) audio._buffer = originalBuffer;
      manifest = null; cachedView = null;
    },
  };
}
