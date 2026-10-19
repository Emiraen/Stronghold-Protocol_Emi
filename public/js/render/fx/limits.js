// 从 A 原正文按职责拆分；保持原有行为。
import { setSimProjectileSpeeds } from './speeds.js';

if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') {
  import('/sim/constants.js').then((m) => { if (m?.PROJECTILE_SPEEDS) setSimProjectileSpeeds(m.PROJECTILE_SPEEDS, m.BOOMERANG_RETURN_SPEED); }, () => {});
}

export const MAX_PARTICLES = { high: 1400, medium: 800, low: 360 };

export const SKILL_GOLD = 0xffd45a;

export const NO_OPTS = Object.freeze({});

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const easeOut = (t) => 1 - (1 - t) * (1 - t);
