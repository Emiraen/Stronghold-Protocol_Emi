// Field view loader: mounts the Pixi render engine (public/js/render/app.js → createFieldView, DESIGN §9)
// into a host element, falling back to the DOM view (fallbackField.js) when the engine is missing, times
// out or throws. Every call into the view goes through a guard so a render bug can never crash the HUD.
// The shared asset store gets the game data's copy of the asset manifest (`seedAssets`, public issue #8 item 5), and the
// prep cameras the HUD bands they keep clear (`hudBands`; the folded shop's band: public issue #5).
//
// `?render=fallback` (or globalThis.__SP_RENDER__ = 'fallback') skips the engine (dev / mock harness);
// `?render=engine` never falls back silently (errors are logged and the fallback still mounts).

// relative, like every other client module (the import map only resolves to this same URL; no bare specifier here)
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { createFallbackView } from './fallbackField.js';
import { data } from '../data.js';
import { audio } from '../audio.js';
import { settingsStore } from './settings.js';

const LOAD_TIMEOUT_MS = 12000;
const METHODS = ['setStage', 'setCamera', 'setPrep', 'enterBattle', 'pushSnapshot', 'pushEvents', 'highlightTiles', 'on', 'resize', 'destroy'];
// direction-step hooks (ui/facingWheel.js): optional — the wheel falls back to the engine's dev hooks when absent;
// setPen (enemy preview pen list), prepField ({ kind, side, mirror } of the Final Assault prep), stripesUnder (the view
// stripes range previews under the units itself) — render/app.js; the DOM fallback lacks them (→ null)
const OPTIONAL = ['pieceScreenRect', 'setSettings', 'off', 'tileScreen', 'holdPiece', 'setPieceDir', 'setPen', 'prepField', 'stripesUnder', 'replayDeploys'];

/**
 * Camera padding (px) that keeps the field clear of the DOM HUD (top bar + bond strip, team panel, shop bar /
 * combat switcher, effects column). Sizes follow the rem scale of css/theme.css.
 * The Final Assault prep ('bossPrep') has the prep HUD (shop bar below) on the boss field: prep padding; the enemy pen
 * ('pen') is viewed with the shop collapsed.
 * @param {string} kind 'prep'|'bossPrep'|'pen'|'normal'|'unite'|'boss'|'hidden'
 * @param {{ width: number, height: number }} size
 */
export function hudPadding(kind, size) {
  let rem = 100;
  try { rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100; } catch { /* ignore */ }
  const h = size?.height || 1080;
  const clampH = (v) => Math.min(v, h * 0.4);
  if (kind === 'prep' || kind === 'bossPrep') return { top: clampH(rem * 1.95), bottom: clampH(rem * 3.2), left: rem * 2.25, right: rem * 0.9 };
  if (kind === 'boss' || kind === 'hidden' || kind === 'unite') return { top: clampH(rem * 1.9), bottom: clampH(rem * 0.95), left: rem * 2.1, right: rem * 0.95 };
  return { top: clampH(rem * 1.95), bottom: clampH(rem * 1.0), left: rem * 2.25, right: rem * 1.05 };
}

/**
 * HUD geometry (rem) the prep cameras keep clear (they mirror the CSS; test/ui/playtest5-ui.test.js checks the rules):
 * the bond strip's bottom edge (css/screens/game.css .gm__bonds top 1.36rem + a .bslot: disc .52rem + name ≈
 * 2.15rem measured) and the shop bar's top edge above the viewport's bottom (css/screens/game-shop.css .shopbar
 * bottom .2rem + .shopbar__row padding .1rem ×2 + card height 2.24rem, plus its 2 px + 1 px borders). The shop bar
 * sits on the viewport's bottom edge even on a notched phone (css/devices.css, DESIGN §18.1).
 * The folded shop (public issue #5): the tab's top edge (.shopbar-tab bottom .2rem + padding .08rem ×2 + its .44rem
 * button, plus its 2 px + 1 px borders; it sits inside the HUD layer, above the bottom safe-area inset) and the corner
 * buttons' top edge (css/screens/game.css .gm__corner bottom .24rem + a .56rem row — the fallback when the corner
 * cannot be measured: on phones its buttons grow to 34 px and below 768 CSS px of width they wrap into two rows,
 * css/devices.css).
 */
export const HUD_REM = Object.freeze({
  bondStripBottom: 2.16, shopBarTop: 2.64, shopBarBorderPx: 3, shopTabTop: 0.8, shopTabBorderPx: 3, cornerTop: 0.8,
});

/**
 * CSS px of HUD along the top edge (top bar + bond strip) and the bottom edge of the viewport during prep — the own
 * board ('prep') or the Final Assault half ('bossPrep'); mobile landscape combat also returns a fitted HUD frame. The prep camera keeps the bench /
 * temp rows and the field's back row clear of them (render/projection.js clearHud; user playtest #5 item 9: the rem
 * floor of 40 px makes the HUD relatively taller on phones in landscape and the shop bar covered the bench).
 * The bottom band is the shop bar's — also for an eliminated player's own board (no shop bar: the band only costs size
 * there, while a camera following the bar's presence would have to re-frame whenever it appears, e.g. when the private
 * state arrives after the prep camera was set) — unless `opts.shop === false`: the player folded the shop (收起) and the
 * own prep board moved to the official shop-collapsed camera (public issue #5: the board did not grow; screens/game.js
 * asks for it only while a folded bar is shown). Its band is the higher of the folded tab (bottom right) and the corner
 * buttons' hit areas (交流 / ⚙ / 📖 / ⛶, bottom left, measured by `cornerBand`: on a narrow phone two rows of 34 px buttons
 * with 44 px touch areas) — under the official collapsed camera the bench's left pads reach under the corner, and with
 * the tab alone it would cover bench pad 0 at the user's 756×366 Android and the near edge of pads 0–2 at 844×390; both
 * are 1-D bands like the bar's, so every bench pad stays fully pressable. Scouting a
 * teammate's board uses the 'normal' camera: no band. An armed shop card (two-tap buy, css/screens/game-shop.css
 * .scard.is-armed) rises 4 px above the bar's top on a phone and covers the bench pads' near corners by ≈ 3 px while it
 * stays armed — less than under the unchanged official camera at 1920×1080 (13 px above the bar, ≈ 11 px over the pads).
 * @param {string} kind
 * @param {{ width: number, height: number }} size
 * @param {{ shop?: boolean }} [opts] `shop: false` = the folded shop's band
 * @returns {{ top: number, bottom: number, fit?: boolean, left?: number, right?: number }|null}
 */
export function hudBands(kind, size, opts) {
  if (kind !== 'prep' && kind !== 'bossPrep') {
    // 战斗画面也按手机的实际控件边界铺开；桌面维持官方构图。
    try {
      const h = size?.height || 1080;
      if (!(size?.width > h && h <= 600 && document.documentElement.classList?.contains('sp-coarse'))
        || !['normal', 'unite', 'boss', 'hidden'].includes(kind)) return null;
      const width = size.width;
      const bounds = selector => Array.from(document.querySelectorAll(selector)).map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
      const gm = document.querySelector('.gm') || document.documentElement;
      const hud = document.querySelector('.gm__hud')?.getBoundingClientRect();
      const cssTop = parseFloat(getComputedStyle(gm).getPropertyValue('--battle-top')) || 84;
      const left = Math.max(0, ...bounds('.team, .gm__corner, .sp-chat--match .sp-chat__toggle').map(r => r.right)) + 4;
      const right = Math.max(8, ...bounds('.gm__effects').map(r => width - r.left + 4));
      const bottom = Math.max(8, ...bounds('.chud__bottom, .gm__watching').map(r => h - r.top + 2));
      return { fit: true, left, right, top: Math.min(h * .4, Math.max(0, hud?.top || 0) + cssTop), bottom };
    } catch { return null; }
  }
  const folded = !!opts && opts.shop === false;
  const h = size?.height || 1080;
  let rem = 100;
  let safeTop = 0;
  let safeBottom = 0;
  let corner = 0;
  let mobileTop = null;
  try {
    rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100;
    // the HUD layer starts below the top safe-area inset and ends above the bottom one (css/devices.css .gm__hud)
    const hud = document.querySelector('.gm__hud')?.getBoundingClientRect();
    safeTop = Math.max(0, hud?.top || 0);
    if (folded) {
      if (hud && hud.bottom > 0) safeBottom = Math.max(0, h - hud.bottom);
      corner = cornerBand(h);
    }
  } catch { /* ignore */ }
  let bottom = folded
    ? Math.max(safeBottom + rem * HUD_REM.shopTabTop + HUD_REM.shopTabBorderPx, corner || safeBottom + rem * HUD_REM.cornerTop)
    : rem * HUD_REM.shopBarTop + HUD_REM.shopBarBorderPx;
  bottom = Math.min(h * 0.4, bottom);
  // Emi40：沿用上游 clearHud 平移/缩放，预留实际购买栏及触控工具高度，而非固定 rem 卡片高度。
  // 横屏触控的 padding、40px 按钮和安全区都会改变它的上边界；保留空隙让 armed 卡片也不压备战格。
  let phoneFrame = null;
  try {
    const phone = size?.width > h && h <= 600 && document.documentElement.classList?.contains('sp-coarse');
    if (phone) {
      const cssTop = parseFloat(getComputedStyle(document.querySelector('.gm') || document.documentElement).getPropertyValue('--battle-top'));
      if (Number.isFinite(cssTop) && cssTop > 0) mobileTop = safeTop + cssTop;
    }
    // 手机按控件实际尺寸贴合，保留细小触控间隙。
    const gap = phone ? 2 : 8;
    let measuredBottom = 0;
    const selectors = folded ? '.shopbar-tab' : '.shopbar__row, .shopbar__tools';
    for (const el of document.querySelectorAll(selectors)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) measuredBottom = Math.max(measuredBottom, h - r.top + gap);
    }
    bottom = phone && measuredBottom > 0 ? measuredBottom : Math.max(bottom, measuredBottom);
    const cornerRect = document.querySelector('.gm__corner')?.getBoundingClientRect();
    const chatToggle = document.querySelector('.sp-chat--match .sp-chat__toggle')?.getBoundingClientRect();
    if (phone) {
      // 左侧工具、聊天与棋盘横向分区，不能把它们的顶部当作整屏底部禁区。
      // 工具换行越多，旧算法越会把棋盘压小并推向上方。商店仍按实际顶部避让。
      phoneFrame = {
        fit: true,
        left: Math.max(document.querySelector('.team')?.getBoundingClientRect().right || rem * 2.25, cornerRect?.right || 0, chatToggle?.right || 0) + 4,
        right: Math.max(8, (size.width - (document.querySelector('.gm__effects')?.getBoundingClientRect().left || size.width - rem * 0.9)) + 4),
      };
      if (folded && measuredBottom > 0) bottom = measuredBottom;
    } else {
      bottom = Math.max(bottom, cornerBand(h));
      if (chatToggle?.width > 0 && chatToggle.height > 0) bottom = Math.max(bottom, h - chatToggle.top + gap);
    }
  } catch { /* 无 DOM 时沿用上游尺寸 */ }
  const pager = document.querySelector('.gm.has-inventory-pager .gm__inventory-pages')?.getBoundingClientRect();
  if (pager?.width > 0 && pager.height > 0) { const touchFit = !!phoneFrame;
    const clearance = Math.max(0, (size?.width || globalThis.innerWidth || 1920) - pager.left + 8);
    phoneFrame = { ...phoneFrame, fit: true, left: Math.max(phoneFrame?.left || rem * 2.25, rem * 2.25), right: Math.max(phoneFrame?.right || 0, clearance) };
    if (touchFit) bottom = Math.max(bottom, h - pager.top + 2);
  }
  return {
    top: Math.min(h * 0.4, mobileTop ?? safeTop + rem * HUD_REM.bondStripBottom),
    bottom,
    ...phoneFrame,
  };
}

/**
 * CSS px from the viewport's bottom edge (`h` high) up to the top of the corner buttons' hit areas (交流 / ⚙ / 📖 / ⛶,
 * .gm__corner), 0 when they are not on the page. On a touch screen every one of them takes taps from an invisible area
 * of at least --tap-min (44 px) centred on it (css/devices.css touch targets), 5 px above a 34 px phone button — a bench
 * pad edge there is not pressable.
 * @param {number} h
 */
function cornerBand(h) {
  const btns = document.querySelectorAll('.gm__corner .gm__gear, .gm__corner .ewheel__btn, .gm__corner .gm__chat-slot');
  if (!btns || !btns.length) return 0;
  const root = document.documentElement;
  const tap = root?.classList?.contains('sp-coarse') ? parseFloat(getComputedStyle(root).getPropertyValue('--tap-min')) || 0 : 0;
  let top = Infinity;
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    if (r && r.height > 0) top = Math.min(top, r.top + r.height / 2 - Math.max(r.height, tap) / 2);
  }
  return top < Infinity ? Math.max(0, h - top) : 0;
}

function renderPref() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('render');
    if (q === 'fallback' || q === 'engine') return q;
  } catch { /* ignore */ }
  return globalThis.__SP_RENDER__ === 'fallback' ? 'fallback' : 'auto';
}

function abortError(signal) {
  return signal?.reason ?? new DOMException('战场初始化已取消', 'AbortError');
}

function checkActive(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function withTimeout(p, ms, what, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (done, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(reject, new Error(`${what} timed out`)), ms);
    // 取消后仍接住共享加载的迟到拒绝。
    Promise.resolve(p).then((value) => finish(resolve, value), (err) => finish(reject, err));
    if (signal?.aborted) onAbort();
  });
}

/**
 * Wrap a view so no method can throw into the UI (each failing method is logged once).
 * @param {any} view
 * @param {'engine'|'fallback'} kind
 */
export function guardView(view, kind) {
  const warned = new Set();
  const safe = { kind, raw: view };
  for (const name of [...METHODS, ...OPTIONAL]) {
    safe[name] = (...args) => {
      const fn = view && view[name];
      if (typeof fn !== 'function') return name === 'on' ? () => {} : null;
      try {
        const out = fn.apply(view, args);
        if (out && typeof out.then === 'function') out.catch((err) => { if (!warned.has(name)) { warned.add(name); console.warn(`[field] ${name} failed`, err); } });
        if (name === 'on') return typeof out === 'function' ? out : () => { try { view.off?.(args[0], args[1]); } catch { /* ignore */ } };
        return out;
      } catch (err) {
        if (!warned.has(name)) { warned.add(name); console.warn(`[field] ${kind} view ${name} failed`, err); }
        return name === 'on' ? () => {} : null;
      }
    };
  }
  return safe;
}

/**
 * Hand the game data's copies of /data/assets.json and /data/local-assets.json (data.js 'assets' / 'local': the match
 * screen waits for them, gameComponents GAME_FILES) to the asset store, now or when they land: it then never downloads
 * the manifest a second time — after a page reload (a phone browser discarding a background tab, Chrome's Memory Saver)
 * that second download was the one createFieldView waited ≤ 4 s for, and a slow or failed one left every operator the
 * image-less placeholder (public issue #8 item 5). Without a copy the store fetches and retries by itself.
 * @param {{ seed?: (m: any) => boolean, seedLocal?: (m: any) => boolean }} store public/js/assets.js store
 */
export function seedAssets(store) {
  if (!store) return;
  const give = (name, fn) => {
    if (typeof fn !== 'function') return;
    const now = data.getRaw(name);
    if (now) { fn(now); return; }
    // still loading (or failed): adopt it if it lands; a later success of the store's own fetch makes this a no-op
    Promise.resolve(data.load(name)).then((m) => { if (m) fn(m); }, () => {});
  };
  give('assets', store.seed?.bind(store));
  give('local', store.seedLocal?.bind(store));
}

/**
 * Create a field view in `host`: the render engine when available, else the DOM fallback.
 * @param {HTMLElement} host
 * @param {{ signal?: AbortSignal }} [options] 取消未完成的挂载，不创建 fallback。
 * @returns {Promise<ReturnType<typeof guardView>>}
 */
export async function mountFieldView(host, { signal } = {}) {
  checkActive(signal);
  const pref = renderPref();
  const opts = { data, assets: data.get('assets'), audio, settings: settingsStore.get(), padding: hudPadding, hud: hudBands };
  if (pref !== 'fallback') {
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let engineView = null;
    const dispose = (view) => { try { view?.destroy?.(); } catch { /* ignore */ } };
    try {
      checkActive(controller.signal);
      // the shared asset store (public/js/assets.js) keeps its Spine cache across remounts (next match, reconnect)
      const am = await withTimeout(import('../assets.js'), LOAD_TIMEOUT_MS, 'asset store import', controller.signal);
      checkActive(controller.signal);
      if (am?.assets && typeof am.assets.ready === 'function') {
        opts.assets = am.assets;
        seedAssets(am.assets);
      }
      const mod = await withTimeout(import('../render/app.js'), LOAD_TIMEOUT_MS, 'render engine import', controller.signal);
      checkActive(controller.signal);
      if (typeof mod?.createFieldView !== 'function') throw new Error('createFieldView missing');
      // 忽略取消的工厂迟到返回时，也只销毁本次创建的 view。
      const pending = Promise.resolve(mod.createFieldView(host, { ...opts, signal: controller.signal })).then((view) => {
        if (controller.signal.aborted) dispose(view); else engineView = view;
        return view;
      });
      const view = await withTimeout(pending, LOAD_TIMEOUT_MS, 'createFieldView', controller.signal);
      checkActive(controller.signal);
      const missing = METHODS.filter((k) => typeof view?.[k] !== 'function');
      if (missing.length) throw new Error(`view lacks ${missing.join(', ')}`);
      return guardView(view, 'engine');
    } catch (err) {
      controller.abort(err);
      dispose(engineView);
      checkActive(signal);
      if (err?.name === 'AbortError') throw err;
      console.warn('[field] render engine unavailable, using the simplified view:', err?.message || err);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  checkActive(signal);
  return guardView(createFallbackView(host, { ...opts, assets: data.get('assets') }), 'fallback');
}

/**
 * Preact hook: 挂载战场视图，临时降级后自动有限重试，也响应重新联网/回到前台；返回 { view, kind }。
 * @param {{ current: HTMLElement|null }} hostRef
 */
export function useFieldView(hostRef) {
  const [state, setState] = useState({ view: null, kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);
  const viewRef = useRef(null);
  useEffect(() => {
    let dead = false, retrying = false, retryTimer = 0;
    const host = hostRef.current;
    if (!host) return undefined;
    setState({ view: null, kind: 'loading' });
    const controller = new AbortController();
    mountFieldView(host, { signal: controller.signal }).then((view) => {
      if (dead) { view.destroy(); return; }
      viewRef.current = view;
      if (view.kind === 'engine') retries.current = 0;
      globalThis.__SP_VIEW__ = view; // dev / E2E introspection (view.raw.stats?.())
      setState({ view, kind: view.kind });
      // Slow vendor loads and a busy GPU can recover without a visibility/network event.
      if (view.kind === 'fallback' && renderPref() !== 'fallback' && retries.current < 2) {
        retryTimer = setTimeout(onRetry, retries.current ? 4000 : 1000);
      }
    }, (err) => { if (!dead && !controller.signal.aborted) console.error('[field] mount failed', err); });
    const unsub = settingsStore.subscribe((s) => viewRef.current?.setSettings?.(s));
    const onResize = () => {
      // A physical right-side viewport exclusion: the board cannot draw beneath the pager.
      const gm = host.closest('.gm');
      const pager = gm?.querySelector('.gm__inventory-pages')?.getBoundingClientRect();
      const frameRect = gm?.getBoundingClientRect();
      const clearance = pager?.width > 0 && frameRect ? Math.ceil(frameRect.right - pager.left + 8) : 0;
      const cssClearance = clearance + 'px';
      if (gm && gm.style.getPropertyValue('--inventory-side-clearance') !== cssClearance) gm.style.setProperty('--inventory-side-clearance', cssClearance);
      const hud = host?.parentElement?.querySelector('.gm__hud');
      const corner = hud?.querySelector('.gm__corner')?.getBoundingClientRect();
      const bounds = hud?.getBoundingClientRect();
      if (corner?.height > 0 && bounds?.height > 0) {
        const chat = document.querySelector('.sp-chat--match .sp-chat__toggle')?.getBoundingClientRect();
        const top = Math.min(corner.top, chat?.height > 0 ? chat.top : corner.top);
        const bottom = `${Math.ceil(bounds.bottom - top + 8)}px`;
        if (hud.style.getPropertyValue('--sp-team-bottom') !== bottom) hud.style.setProperty('--sp-team-bottom', bottom);
      }
      viewRef.current?.resize();
    };
    // 最多连续重试两次；旧视图由 effect cleanup 回收，不重启对局或下载素材。
    const onRetry = () => {
      if (dead || retrying || viewRef.current?.kind !== 'fallback' || renderPref() === 'fallback'
        || document.visibilityState !== 'visible' || retries.current >= 2) return;
      clearTimeout(retryTimer);
      retrying = true; retries.current++; setAttempt((n) => n + 1);
    };
    // 商店挂载、收展及触控尺寸改变后，重新读取实测 HUD；不改变聊天布局或监听聊天内容。
    let frame = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(onResize);
    };
    const hud = host?.parentElement?.querySelector('.gm__hud');
    // 商店入场 transform 不触发尺寸观察；动画结束后按最终位置重新避让。
    const onShopAnimationEnd = (e) => {
      if (e.animationName === 'shop-up' && e.target?.classList?.contains('shopbar')) scheduleFit();
    };
    hud?.addEventListener('animationend', onShopAnimationEnd);
    const geometryObserver = new ResizeObserver(scheduleFit);
    const observeHud = () => {
      geometryObserver.disconnect();
      if (hud) geometryObserver.observe(hud);
      if (host) geometryObserver.observe(host);
      for (const el of hud?.querySelectorAll('.shopbar, .shopbar__row, .shopbar__tools, .shopbar-tab, .shopbar__capacity, .gm__inventory-pages, .gm__corner') || []) geometryObserver.observe(el);
      const chatToggle = document.querySelector('.sp-chat--match .sp-chat__toggle');
      if (chatToggle) geometryObserver.observe(chatToggle);
      scheduleFit();
    };
    const hudObserver = new MutationObserver(observeHud);
    if (hud) hudObserver.observe(hud, { childList: true });
    observeHud();
    window.addEventListener('resize', scheduleFit);
    window.visualViewport?.addEventListener('resize', scheduleFit);
    window.visualViewport?.addEventListener('scroll', scheduleFit);
    window.addEventListener('online', onRetry);
    document.addEventListener('visibilitychange', onRetry);
    return () => {
      dead = true;
      controller.abort();
      clearTimeout(retryTimer);
      unsub();
      cancelAnimationFrame(frame);
      geometryObserver.disconnect();
      hudObserver.disconnect();
      hud?.removeEventListener('animationend', onShopAnimationEnd);
      window.removeEventListener('resize', scheduleFit);
      window.visualViewport?.removeEventListener('resize', scheduleFit);
      window.visualViewport?.removeEventListener('scroll', scheduleFit);
      window.removeEventListener('online', onRetry);
      document.removeEventListener('visibilitychange', onRetry);
      // the dev hook must not keep the destroyed view — and through its host the whole detached match screen — alive
      if (viewRef.current && globalThis.__SP_VIEW__ === viewRef.current) globalThis.__SP_VIEW__ = null;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [attempt]);
  return state;
}
