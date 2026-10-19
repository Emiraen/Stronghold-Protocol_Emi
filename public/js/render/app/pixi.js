// 从 A 原正文按职责拆分；保持原有行为。


import { installResourcePixi } from '../../resourcePixi.js';
import { installPixiNoEval } from './pixiNoEval.js';

export const VENDOR = { pixi: '/vendor/pixi.min.js', spine: '/vendor/pixi-spine.js' };

export let pixiPromise = null;

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export function ensurePixi() {
  if (globalThis.PIXI && globalThis.PIXI.spine) {
    // CSP deliberately omits unsafe-eval. Pixi's stock ShaderSystem otherwise throws during
    // Application construction before the board can even probe WebGL, which was misreported
    // to players as a 3D/WebGL capability failure.
    installPixiNoEval(globalThis.PIXI);
    return Promise.resolve(installResourcePixi(globalThis.PIXI));
  }
  if (!pixiPromise) {
    pixiPromise = (async () => {
      if (!globalThis.PIXI) await loadScript(VENDOR.pixi);
      if (!globalThis.PIXI?.spine) await loadScript(VENDOR.spine);
      if (!globalThis.PIXI || !globalThis.PIXI.spine) throw new Error('PIXI / pixi-spine unavailable');
      // Install the CSP-safe shader uniform synchronizer before any PIXI.Application is created.
      installPixiNoEval(globalThis.PIXI);
      return installResourcePixi(globalThis.PIXI);
    })();
    pixiPromise.catch(() => { pixiPromise = null; });
  }
  return pixiPromise;
}

/** Pixi 7 retains extension objects across loss, but WebGL disables the extensions. */
export function restorePixiExtensions(renderer) {
  const canvas = renderer.view;
  const restore = () => renderer.context.getExtensions();
  // Run before Pixi's bubble listener rebuilds GPU resources using extension enums.
  canvas.addEventListener('webglcontextrestored', restore, true);
  return () => canvas.removeEventListener('webglcontextrestored', restore, true);
}
