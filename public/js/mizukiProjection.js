import { GEO } from '../../shared/constants.js';
import { presetCamera } from './render/projection.js';
import { MIZUKI_GEO } from './mizukiPrep.js';

// The native map puts the bench at row 0; ordinary Stronghold puts it at row 7.
// Translate the shared shop-collapsed camera with that coordinate change only.
export function mizukiPresetCamera(kind, viewport, options) {
  // Native RO2 bosses have one source map, not Stronghold's two-sided boss board.
  // Its short row bounds otherwise match the shared official-boss heuristic.
  if (kind === 'boss' || kind === 'hidden') {
    return presetCamera(kind, viewport, { ...options, fit: true, half: false, config: null });
  }
  if (kind !== 'prep') return presetCamera(kind, viewport, options);
  const camera = presetCamera('prep', viewport, { ...options, rect: null, config: null, shop: false });
  camera.ty += MIZUKI_GEO.HAND_ROW - GEO.HAND_ROW;
  return camera.update();
}
