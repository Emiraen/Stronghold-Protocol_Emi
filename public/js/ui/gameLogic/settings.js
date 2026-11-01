// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';
import { normalizeFrameRate } from '../../frameRate.js';
import { sanitizeVoiceOverrides } from '../../voicePrefs.js';
import { DEFAULT_CAMERA_SETTINGS, sanitizeCameraSettings } from '../../render/cameraSettings.js';

export const TEXT_SIZES = Object.freeze(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']);
export const TEXT_SIZE_LABELS = Object.freeze({ xxs: '极小', xs: '小', sm: '标准', md: '中', lg: '大', xl: '特大' });


// ---- settings ------------------------------------------------------------------------------------------------------

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, muted: false, damageNumbers: true, officialDamageNumbers: false, ammoCount: false, energyCount: false, voiceNative: false, officialFx: 'auto', quality: 'high', fpsLimit: 0, textSize: 'sm', danmakuTextSize: 'sm', voiceOverrides: Object.freeze({}), keys: DEFAULT_HOTKEYS, ...DEFAULT_CAMERA_SETTINGS });
const QUALITIES = ['high', 'medium', 'low'];

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, muted: boolean, damageNumbers: boolean, quality: 'high'|'medium'|'low',
 *   keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    ...sanitizeCameraSettings(r),
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : DEFAULT_SETTINGS.officialDamageNumbers,
    energyCount: typeof r.energyCount === 'boolean' ? r.energyCount : DEFAULT_SETTINGS.energyCount,
    voiceNative: r.voiceNative === true,
    ammoCount: typeof r.ammoCount === 'boolean' ? r.ammoCount : DEFAULT_SETTINGS.ammoCount,
    officialFx: ['auto', 'off', 'lite', 'full'].includes(r.officialFx) ? r.officialFx : DEFAULT_SETTINGS.officialFx,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    fpsLimit: normalizeFrameRate(r.fpsLimit),
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    danmakuTextSize: TEXT_SIZES.includes(r.danmakuTextSize) ? r.danmakuTextSize : DEFAULT_SETTINGS.danmakuTextSize,
    voiceOverrides: sanitizeVoiceOverrides(r.voiceOverrides),
    keys: sanitizeHotkeys(r.keys),
  };
}
