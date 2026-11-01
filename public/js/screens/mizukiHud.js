// Mizuki native-style stage: fixed 1920x1080 canvas scaled to the viewport,
// plus the top bar and bottom bar shared by every exploration screen.
// Art comes from public/assets/mizuki/native-ui-hud (exported from the unpacked client).
import { h, Modal, Button } from '../ui/components.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { quitMatch } from '../ui/matchChrome.js';
import { openGuide } from '../ui/guide.js';

const e = (type, props, ...children) => h(type, props, ...children.flat(3));
const cx = (...parts) => parts.filter(Boolean).join(' ');
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const shown = value => Number.isFinite(Number(value)) && value !== null ? String(value) : '--';

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;
export const hudUrl = name => '/assets/mizuki/native-ui-hud/' + name + '.png';
export const hudBg = name => ({ backgroundImage: 'url(' + hudUrl(name) + ')' });

export function MizukiStage({ children, class: cls = '', scheme = 'dark', label = '水月与深蓝之树' }) {
  const viewport = useRef(null);
  const [scale, setScale] = useState(() => Math.min((globalThis.innerWidth || STAGE_WIDTH) / STAGE_WIDTH, (globalThis.innerHeight || STAGE_HEIGHT) / STAGE_HEIGHT));
  useEffect(() => {
    const el = viewport.current;
    if (!el) return undefined;
    const fit = () => {
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) setScale(Math.min(box.width / STAGE_WIDTH, box.height / STAGE_HEIGHT));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return undefined;
    const SCROLLERS = '.mzr-grid,.mzs-scroll,.mzv-map,.mzv-collectibles-strip';
    const wheel = event => {
      const box = event.target.closest?.(SCROLLERS);
      if (!box) return;
      if (box.matches('.mzv-map') && box.scrollHeight > box.clientHeight && !event.shiftKey
        && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
        box.scrollTop += event.deltaY; event.preventDefault(); return;
      }
      if (box.scrollWidth <= box.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      box.scrollLeft += delta; event.preventDefault();
    };
    let drag = null;
    const move = event => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = drag.vertical ? event.clientY - drag.y : 0;
      if (!drag.moved && Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      drag.moved = true;
      drag.box.scrollLeft = drag.left - dx / drag.scale;
      if (drag.vertical) drag.box.scrollTop = drag.top - dy / drag.scale;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (drag?.moved) { const stop = ev => { ev.stopPropagation(); ev.preventDefault(); }; window.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => window.removeEventListener('click', stop, true), 0); }
      drag = null;
    };
    const down = event => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      const box = event.target.closest?.(SCROLLERS);
      if (!box) return;
      const vertical = box.matches('.mzv-map') && box.scrollHeight > box.clientHeight;
      if (box.scrollWidth <= box.clientWidth && !vertical) return;
      drag = { box, x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop, vertical,
        moved: false, scale: box.getBoundingClientRect().width / box.offsetWidth || 1 };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerdown', down);
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('pointerdown', down); up(); };
  }, []);
  return e('main', { class: cx('screen mzh-screen', 'mzh-screen--' + scheme, cls), ref: viewport, 'aria-label': label },
    e('div', { class: 'mzh-stage', style: { '--mzh-stage-scale': scale, transform: 'translate(-50%,-50%) scale(' + scale + ')' } }, children,
      e('span', { class: 'mzh-chat-slot', 'data-mz-chat-slot': true, 'aria-hidden': true })));
}

function ExitButton({ onExit, class: cls = '' }) {
  const [open, setOpen] = useState(false);
  return e('span', {},
    e('button', { type: 'button', class: cx('mzh-exit', cls), 'aria-label': '离开本次探索', 'data-mz-exit': true, onClick: () => setOpen(true) }),
    e(Modal, { open, onClose: () => setOpen(false), title: '离开本次探索',
      actions: [e(Button, { variant: 'secondary', onClick: () => setOpen(false) }, '继续探索'), e(Button, { variant: 'danger', onClick: onExit || quitMatch }, '退出探索')] },
      e('p', {}, '退出将结束你本次探索的参与。')));
}

function Resource({ kind, icon, children }) {
  return e('div', { class: cx('mzh-res', 'mzh-res--' + kind) }, e('span', { class: 'mzh-res__icon', style: hudBg(icon) }), e('span', { class: 'mzh-res__value' }, children));
}

/**
 * Top bar. `steps` > 0 draws the three-node progress line below the title.
 * Light screens (grey recruit/formation pages) only show the exit button and the hope bar.
 */
export function MizukiTopBar({ life, maxLife, commander = {}, title, steps = 0, step = 0, hope, capacity, gold, keys, onExit, info = false }) {
  const level = num(commander.level, 1), exp = num(commander.exp), next = num(commander.nextLevelExp, 10);
  const fill = Math.min(1, Math.max(0, num(hope) / Math.max(1, num(capacity, 1))));
  const stepX = index => 108 + index * 114;
  return e('header', { class: 'mzh-top' },
    e(ExitButton, { onExit }),
    info ? e('span', { class: 'mzh-info', style: hudBg('cmn1-img_btn_info'), 'aria-hidden': true }) : null,
    e('div', { class: 'mzh-life', style: hudBg('cmn1-hp_bar') },
      e('span', { class: 'mzh-life__label' }, '目标生命值'),
      e('span', { class: 'mzh-life__value', 'data-mz-life': true }, e('b', {}, shown(life)), e('i', {}, '/' + shown(maxLife)))),
    e('div', { class: 'mzh-command', style: hudBg('cmn1-exp_back') },
      e('span', { class: 'mzh-command__label' }, '指挥等级'),
      e('span', { class: 'mzh-command__value' }, e('b', {}, exp), '/' + next),
      e('span', { class: 'mzh-command__chevron', 'aria-hidden': true })),
    e('div', { class: 'mzh-level', 'aria-label': '指挥等级 ' + level }, e('small', {}, 'LV'), e('b', {}, level)),
    title ? e('div', { class: 'mzh-title' }, e('h1', {}, title)) : null,
    steps > 0 ? e('div', { class: 'mzh-steps', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': steps, 'aria-valuenow': step + 1 },
      e('i', { class: 'mzh-steps__fill', style: { width: stepX(Math.min(step, steps - 1)) + 'px' } }),
      Array.from({ length: steps }, (_, index) => e('i', { key: index, class: cx('mzh-steps__node', index <= step && 'is-done'), style: { left: stepX(index) + 'px' } }))) : null,
    e('div', { class: 'mzh-resources' },
      e('div', { class: 'mzh-res mzh-res--hope', 'data-mz-hope': true },
        e('span', { class: 'mzh-res__icon', style: hudBg('cmn1-hope_icon') }),
        e('span', { class: 'mzh-res__bar' }, e('i', { style: { width: fill * 100 + '%' } })),
        e('span', { class: 'mzh-res__pair' }, e('b', {}, shown(hope)), e('b', { class: 'is-cap' }, shown(capacity)))),
      e(Resource, { kind: 'gold', icon: 'topic-rogue_2_gold' }, shown(gold)),
      e(Resource, { kind: 'key', icon: 'topic-rogue_2_key' }, shown(keys))));
}

/** Bottom bar: help diamond, dice counter, collectibles, operator count and a free slot for page actions. */
export function MizukiBottomBar({ dice, showDice = true, collectibles, showCollectibles = false, onCollectibles, operators, showOperators = false, operatorsSide = 'right', onOperators, children, right }) {
  return e('footer', { class: 'mzh-bottom' },
    showDice ? e('button', { type: 'button', class: 'mzh-diamond', 'aria-label': '探索说明', style: hudBg('topic-rogue_2_grow_icon_exp'), onClick: () => openGuide(0) }) : null,
    showDice ? e('div', { class: 'mzh-dice', 'data-mz-dice': true }, e('small', {}, 'REMAIN'), e('span', { class: 'mzh-dice__icon', style: hudBg('cmn2-icon_relic') }), e('b', {}, shown(dice)), e('span', {}, '掷骰次数')) : null,
    showCollectibles ? e('div', { class: 'mzh-collect', 'data-mz-collectibles': true,
      ...(onCollectibles ? { role: 'button', tabIndex: 0, 'aria-label': '查看全队收藏品', 'aria-haspopup': 'dialog',
        onClick: onCollectibles, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCollectibles(); } } } : {}) },
      e('span', { class: 'mzh-collect__icon', style: hudBg('cmn2-icon_relic') }), e('b', {}, shown(collectibles)), e('span', {}, '收藏品')) : null,
    children,
    showOperators ? e('button', { type: 'button', class: cx('mzh-operators', 'mzh-operators--' + operatorsSide), 'data-mz-operators': true, onClick: onOperators },
      e('span', { class: 'mzh-operators__label' }, e('i', { style: hudBg('topic-member') }), e('span', {}, '干员')), e('b', {}, shown(operators))) : null,
    right);
}

/** Blue confirm button used by the selection pages (matches the official 确认招募 control). */
export function MizukiConfirm({ children, disabled, onClick, kind }) {
  return e('button', { type: 'button', class: 'mzh-confirm', disabled, onClick, 'data-mz-confirm': kind },
    e('span', { class: 'mzh-confirm__check', 'aria-hidden': true }), e('span', {}, children));
}
