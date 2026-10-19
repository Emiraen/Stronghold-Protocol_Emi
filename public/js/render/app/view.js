// 从 A 原正文按职责拆分；保持原有行为。
import { normRect } from '../projection.js';
import { AREAS, areaFor } from '../board3d/layout.js';

export const VIEW_KINDS = new Set(['prep', 'normal', 'unite', 'boss', 'bossPrep', 'pen']);

export function viewKind(kind, opts) {
  let k = kind === 'hidden' ? 'boss' : kind;
  if (!VIEW_KINDS.has(k)) k = 'normal';
  if (k === 'prep' && opts && opts.rect && normRect(opts.rect).r1 <= 6) k = 'bossPrep';
  return k;
}

export const AREA_NO_PEN = Object.freeze({
  normal: Object.freeze(AREAS.normal.filter((a) => a.r1 <= 13)),
  unite: Object.freeze(AREAS.unite.filter((a) => a.r1 <= 13)),
});

export function boardArea(vk) {
  if (vk === 'pen') return AREAS.normal;
  if (vk === 'prep' || vk === 'normal') return AREA_NO_PEN.normal.length ? AREA_NO_PEN.normal : AREAS.normal;
  if (vk === 'unite') return AREA_NO_PEN.unite.length ? AREA_NO_PEN.unite : AREAS.unite;
  return areaFor(vk);
}

export function bandFor(kind) {
  if (kind === 'boss' || kind === 'hidden' || kind === 'bossPrep') return [0, 13];
  return kind === 'pen' ? [6, 18] : [6, 13];
}

export function fieldRows(kind) {
  return kind === 'boss' || kind === 'hidden' || kind === 'bossPrep' ? [0, 6] : kind === 'pen' ? [6, 18] : [6, 13];
}

export const penShown = (vk, prevVk = null) => vk === 'pen' || prevVk === 'pen';

export const leaderShown = (vk, prevVk = null) => vk === 'bossPrep' || prevVk === 'bossPrep';

export function boardPreference(opt) {
  let q = null;
  try { q = new URLSearchParams(globalThis.location?.search || '').get('board'); } catch { /* no location */ }
  const v = q || opt;
  return v === '2d' || v === '3d' ? v : 'auto';
}

export function switchableBox({ board, pixi }) {
  let inner = null, owner;
  const drop = () => { try { inner?.destroy(); } catch { /* ignore */ } inner = null; owner = undefined; };
  return {
    get mesh() { return inner ? inner.mesh || null : null; },
    get inner() { return inner; },
    update(cam, b) {
      const scene = board() || null;
      if (!inner || owner !== scene || inner.destroyed) {
        drop();
        inner = scene ? scene.createDevice() : pixi();
        owner = scene;
      }
      inner?.update(cam, b);
    },
    destroy: drop,
  };
}
