// Keep original URLs for Spine relative paths and PIXI caches; redirect only IO.
import { cachedFetch, acquireResourceUrl } from './resourceCache.js';

const installed = new WeakSet();
export function installResourcePixi(PIXI) {
  if (!PIXI || installed.has(PIXI)) return PIXI;
  const adapter = PIXI.settings?.ADAPTER;
  if (!adapter || typeof adapter.fetch !== 'function') throw new Error('PIXI adapter fetch unavailable');
  adapter.fetch = cachedFetch;
  // The worker path owns its native fetch and cannot see the page's IndexedDB adapter.
  // Keep PIXI's normal parser, ImageBitmap creation and unload/PromiseCache lifecycle intact.
  const parser = PIXI.Assets?.loader?.parsers?.find?.((item) => item.name === 'loadTextures');
  if (!parser?.config) throw new Error('PIXI texture parser unavailable');
  parser.config.preferWorkers = false;
  const originalLoad = parser.load;
  parser.load = async function (url, asset, loader) {
    if (globalThis.createImageBitmap && this.config.preferCreateImageBitmap) {
      return originalLoad.call(this, url, asset, loader);
    }
    // Older browsers use Image instead of ADAPTER.fetch; resolve its src explicitly.
    const source = await acquireResourceUrl(url);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`image failed: ${url}`));
        img.src = source.url;
      });
      const options = { ...asset.data };
      options.resolution ??= PIXI.utils.getResolutionOfUrl(url);
      const base = new PIXI.BaseTexture(image, options);
      base.resource.src = url;
      base.resource.internal = true;
      const texture = new PIXI.Texture(base);
      const forget = () => {
        delete loader.promiseCache[url];
        if (PIXI.Assets.cache.has(url)) PIXI.Assets.cache.remove(url);
      };
      base.once('destroyed', () => { if (url in loader.promiseCache) forget(); });
      texture.once('destroyed', () => { if (!base.destroyed) forget(); });
      return texture;
    } finally { source.release(); }
  };
  installed.add(PIXI);
  return PIXI;
}
