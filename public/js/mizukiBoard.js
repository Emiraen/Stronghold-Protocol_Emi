import { createMizukiFxFetch } from './mizukiFx.js';
import { cachedFetch } from './resourceCache.js';

/** Mode-private IO for the native Stronghold board; shared preload lists stay unchanged. */
export async function prepareMizukiBoardAssets(base, manifest, { fetchFn = cachedFetch } = {}) {
  if (!manifest?.groups?.['map/autochess']?.TX_autochessi_D) return { assets: base, destroy() {} };
  const request = createMizukiFxFetch(manifest, { fetchFn });
  const metadata = new Map();
  let destroyed = false;
  try {
    // loadBoardPack already requests its metadata in parallel. Retain only
    // requested responses, using the ordinary required-resource cache for IO.
    const scoped = Object.create(base);
    scoped.local = () => Promise.resolve(manifest);
    Object.defineProperty(scoped, 'localManifest', { value: manifest });
    scoped.localUrl = (group, name) => {
      const path = manifest.groups[group]?.[name]?.path;
      return path || base.localUrl?.(group, name) || null;
    };
    scoped.fetchBoardData = (url, options) => {
      if (destroyed) return Promise.reject(new Error('Original board assets released'));
      const key = String(url);
      if (!metadata.has(key)) {
        const pending = request(url, options).then(response => {
          if (!response.ok) throw new Error('Original board metadata unavailable: ' + url);
          return response;
        }).catch(error => { metadata.delete(key); throw error; });
        metadata.set(key, pending);
      }
      return metadata.get(key).then(response => response.clone());
    };
    scoped.image = (url, options = {}) => {
      if (destroyed) return Promise.resolve(null);
      return base.image(url, options);
    };
    return { assets: scoped, destroy() { destroyed = true; metadata.clear(); } };
  } catch (error) { metadata.clear(); throw error; }
}
