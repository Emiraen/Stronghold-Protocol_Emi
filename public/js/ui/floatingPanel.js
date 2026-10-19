import { useEffect, useLayoutEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Overlay, isTopOverlay } from './components.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
let clickGuard = null;
function consumeDismissClick(target) {
  if (clickGuard) return;
  const stop = event => {
    if (event.target === target || target.contains?.(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
    window.removeEventListener('click', stop, true); clearTimeout(timer); clickGuard = null;
  };
  const timer = setTimeout(() => { window.removeEventListener('click', stop, true); clickGuard = null; }, 700);
  clickGuard = stop; window.addEventListener('click', stop, true);
}
const validRect = (r) => r && [r.left, r.right, r.top, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top;

/** Fit a secondary panel into free viewport space, keeping the selected sprite visible. */
export function floatingPanelPlacement({ viewport: v, width, height, anchor = null, side = 'left', placement = 'side', gap = 10 }) {
  const W = v.right - v.left, H = v.bottom - v.top;
  const w = Math.min(width, W), h = Math.min(height, H);
  const base = { left: side === 'right' ? v.right - w : v.left, top: v.top + Math.min(72, H * .13), width: w, height: Math.min(h, H - Math.min(72, H * .13)), side };
  if (!validRect(anchor)) {
    if (placement === 'center') return { left: v.left + (W - w) / 2, top: v.top + Math.min(64, H * .1), width: w, height: Math.min(h, H - Math.min(64, H * .1)), side: 'center' };
    return base;
  }
  const a = { left: clamp(anchor.left - gap, v.left, v.right), right: clamp(anchor.right + gap, v.left, v.right), top: clamp(anchor.top - gap, v.top, v.bottom), bottom: clamp(anchor.bottom + gap, v.top, v.bottom) };
  const spaces = {
    left: { left: v.left, top: v.top, width: a.left - v.left, height: H },
    right: { left: a.right, top: v.top, width: v.right - a.right, height: H },
    above: { left: v.left, top: v.top, width: W, height: a.top - v.top },
    below: { left: v.left, top: a.bottom, width: W, height: v.bottom - a.bottom },
  };
  const order = [side === 'right' ? 'right' : 'left', side === 'right' ? 'left' : 'right', 'above', 'below'];
  const chosen = order.find(k => spaces[k].width >= w && spaces[k].height >= Math.min(h, 260))
    || order.reduce((best, k) => {
      const score = (r) => Math.min(w, r.width) * Math.min(h, r.height) * (r.width >= Math.min(w, 210) && r.height >= Math.min(h, 150) ? 1 : .1);
      return score(spaces[k]) > score(spaces[best]) ? k : best;
    }, order[0]);
  const space = spaces[chosen];
  const outW = Math.min(w, Math.max(1, space.width)), outH = Math.min(h, Math.max(1, space.height));
  return {
    left: chosen === 'left' ? space.left + space.width - outW : chosen === 'right' ? space.left : clamp((anchor.left + anchor.right - outW) / 2, space.left, space.left + space.width - outW),
    top: chosen === 'above' ? space.top + space.height - outH : chosen === 'below' ? space.top : clamp((anchor.top + anchor.bottom - outH) / 2, space.top, space.top + space.height - outH),
    width: outW, height: outH, side: chosen,
  };
}

function FloatingFrame({ as: Tag = 'aside', children, class: cls = '', onClose, anchor = null, side = 'left', placement = 'side', family = 'match-detail', ignore = '', width = 440, ...rest }) {
  const ref = useRef(null), current = useRef(null), measureRef = useRef(null);
  current.current = { onClose, anchor, side, placement, family, ignore, width };
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    let frame = 0, lastTime = 0, lastKey = '';
    const viewport = window.visualViewport;
    const measure = () => {
      const p = current.current;
      const root = getComputedStyle(document.documentElement);
      const safe = key => Math.max(0, parseFloat(root.getPropertyValue(key)) || 0);
      const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
      const v = { left: x + Math.max(8, safe('--sa-l')), top: y + Math.max(8, safe('--sa-t')), right: x + (viewport?.width || innerWidth) - Math.max(8, safe('--sa-r')), bottom: y + (viewport?.height || innerHeight) - Math.max(8, safe('--sa-b')) };
      let a = null;
      try { a = typeof p.anchor === 'function' ? p.anchor() : p.anchor?.getBoundingClientRect ? p.anchor.getBoundingClientRect() : p.anchor; } catch { /* Fall back to the side dock. */ }
      const desiredWidth = Math.min(p.width, v.right - v.left);
      const desiredHeight = Math.min(760, v.bottom - v.top);
      const pos = floatingPanelPlacement({ viewport: v, width: desiredWidth, height: desiredHeight, anchor: a, side: p.side, placement: p.placement });
      const key = `${pos.left.toFixed(1)},${pos.top.toFixed(1)},${pos.width.toFixed(1)},${pos.height.toFixed(1)},${pos.side}`;
      if (lastKey === key) return;
      lastKey = key;
      Object.assign(panel.style, { left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px`, maxHeight: `${pos.height}px`, height: `${pos.height}px` });
      panel.dataset.floatSide = pos.side;
      panel.dataset.anchorAvoided = validRect(a) ? 'true' : 'false';
    };
    measureRef.current = measure;
    measure();
    const tick = (now) => { if (now - lastTime > 66) { lastTime = now; if (current.current.anchor) measure(); } frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    window.addEventListener('resize', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', measure); viewport?.removeEventListener('resize', measure); viewport?.removeEventListener('scroll', measure); measureRef.current = null; };
  }, []);
  useLayoutEffect(() => { measureRef.current?.(); });
  useEffect(() => {
    const panel = ref.current;
    const closeOutside = e => {
      const target = e.target;
      if (!(target instanceof Element) || !panel || panel.contains(target)) return;
      const p = current.current;
      if (target.closest('.modal, .guide, .lo, .choice-info, .sp-overlay-layer--modal')) return;
      if (p.ignore && target.closest(p.ignore)) return;
      const sibling = target.closest('[data-floating-family]');
      if (sibling?.dataset.floatingFamily === p.family) return;
      p.onClose?.();
      // A click to dismiss a card must not also buy, sell or ready behind it. The board remains directly selectable.
      if (!target.closest('.gm__field, .uframe, .uframe__close, .effects__hit, .bslot, .bstrip__more, .dbond, [data-testid=check-player], .gm__metrics')) { e.preventDefault(); e.stopPropagation(); consumeDismissClick(target); }
    };
    const closeKey = e => { if (e.key === 'Escape' && isTopOverlay(panel)) { e.preventDefault(); e.stopImmediatePropagation(); current.current.onClose?.(); } };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('keydown', closeKey, true);
    return () => { window.removeEventListener('pointerdown', closeOutside, true); window.removeEventListener('keydown', closeKey, true); };
  }, []);
  return html`<${Tag} ...${rest} ref=${ref} class=${`${cls} east-floating-panel`} data-floating-family=${family}>${children}<//>`;
}

/** Body portal keeps secondary menus above the complete battlefield HUD. */
export function FloatingPanel(props) {
  return html`<${Overlay} level="game-panel"><${FloatingFrame} ...${props} /><//>`;
}
