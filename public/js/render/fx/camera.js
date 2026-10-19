// 从 A 原正文按职责拆分；保持原有行为。


export const SHOT_HEIGHT = Object.freeze({ launch: 0.45, aim: 0.5 });

export function bodyZ(cam, v, frac) {
  const z0 = (v.z || 0) + (v.hover || 0);
  const h = (v._headTiles || 1.2) * frac;
  if (!cam || typeof cam.liftFor !== 'function') return z0 + h;
  const dz = cam.liftFor(v.x, v.y, z0, h * cam.scaleAt(v.x, v.y, z0));
  return Number.isFinite(dz) ? z0 + dz : z0 + h;
}

export const feetZ = (v) => (v.z || 0) + (v.hover || 0) + 0.2;

export const camKey = (c) => (c ? c.tx + c.ty * 1e3 + c.tz * 1e6 + c.tilt * 7.13 + c.dist * 1e4 + c.scale * 3.7e-2 + c.cx * 1.1e-5 + c.cy * 1.3e-8 : 0);
