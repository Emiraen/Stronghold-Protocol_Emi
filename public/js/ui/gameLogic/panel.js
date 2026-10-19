// 从 A 原正文按职责拆分；保持原有行为。
import { isObj } from './shared.js';

export function panelSide(uf, slots) {
  if (!isObj(uf) || !isObj(slots)) return 'left';
  const hit = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  if (!hit(uf, slots.left)) return 'left';
  return hit(uf, slots.right) ? 'left' : 'right';
}

export function panelSlots(vp, rem, { shopOpen = false } = {}) {
  const W = Number(vp?.width) || 1920;
  const H = Number(vp?.height) || 1080;
  const X = Number.isFinite(vp?.left) ? vp.left : 0;
  const Y = Number.isFinite(vp?.top) ? vp.top : 0;
  const R = rem > 0 ? rem : 100;
  const top = R * 2.1;
  const leftH = Math.min(R * 8.4, H - top - R * 1.02);
  const rightBottom = H - R * (shopOpen ? PANEL_RIGHT_BOTTOM_SHOP : PANEL_RIGHT_BOTTOM);
  return {
    left: { left: X + R * 2.3, right: X + R * (2.3 + 4.9), top: Y + top, bottom: Y + top + leftH },
    right: { left: X + W - R * (PANEL_RIGHT_GAP + 4.9), right: X + W - R * PANEL_RIGHT_GAP, top: Y + top, bottom: Y + Math.max(top + R, rightBottom) },
  };
}

export const PANEL_RIGHT_GAP = 0.9;

export const PANEL_RIGHT_BOTTOM = 1.02;

export const PANEL_RIGHT_BOTTOM_SHOP = 3.78;

export const BPOP = Object.freeze({ width: 5.4, top: 2.1, bottomGap: 0.3, left: 2.3, beside: 7.32, besideR: 5.92, right: 0.9 });

export function bondPopupPlace(uf, vp, rem, card = null) {
  const W = Number(vp?.width) || 1920;
  const H = Number(vp?.height) || 1080;
  const X = Number.isFinite(vp?.left) ? vp.left : 0;
  const Y = Number.isFinite(vp?.top) ? vp.top : 0;
  const R = rem > 0 ? rem : 100;
  const top = Y + R * BPOP.top;
  const bottom = Y + Math.max(R * BPOP.top + R, H - R * BPOP.bottomGap);
  const rectOf = (p) => {
    const left = X + (p === 'left' ? R * BPOP.left : p === 'beside' ? R * BPOP.beside
      : p === 'besideR' ? W - R * (BPOP.besideR + BPOP.width) : W - R * (BPOP.right + BPOP.width));
    return { left, right: left + R * BPOP.width, top, bottom };
  };
  // last resort: over the card it was opened from (closing the popup shows the card again)
  const order = card === 'left' ? ['beside', 'right', 'left'] : card === 'right' ? ['besideR', 'left', 'right'] : ['left', 'right'];
  if (!isObj(uf)) return order[0];
  const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  return order.find((p) => !hit(uf, rectOf(p))) || order[0];
}
