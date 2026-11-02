import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { EmoteArt } from './emotes.js';
import { useResourceUrl } from './cachedImage.js';
import { openResourcePreload } from './resourcePreload.js';
import { resourceCache } from '../resourceCache.js';
import { CHAT_STICKERS, IN_MATCH_STICKER_GROUPS, getChatSticker } from '../../../shared/chatStickers.js';
import { t } from '../../../shared/i18n.js';

let pickerSequence = 0;

/** GIFs remain browser images, including when their source is a cached Blob URL. */
export function StickerArt({ id, class: cls = '', missingAction = true, ...props }) {
  const sticker = getChatSticker(id);
  const source = sticker && !sticker.builtin ? sticker.src : null;
  const [cacheState, setCacheState] = useState(() => ({ source, cached: !!source && resourceCache.isCached(source) }));
  useEffect(() => {
    const update = () => setCacheState(previous => {
      const cached = !!source && resourceCache.isCached(source);
      return previous.source === source && previous.cached === cached ? previous : { source, cached };
    });
    update();
    return resourceCache.subscribe(update);
  }, [source]);
  const cached = cacheState.source === source ? cacheState.cached : !!source && resourceCache.isCached(source);
  const url = useResourceUrl(cached ? source : null);
  if (!sticker) return null;
  if (sticker.builtin) return html`<span class=${`eart ${cls}`} role="img" aria-label=${sticker.label} ...${props}><${EmoteArt} id=${sticker.id} /></span>`;
  if (!cached && missingAction) return html`<span class=${`sp-chat__sticker-missing ${cls}`} ...${props}><span>${t('预载后可查看表情')}</span><button type="button" class="sp-chat__sticker-missing-action" onClick=${event => { event.stopPropagation(); openResourcePreload(); }}>${t('资源预载')}</button></span>`;
  if (!url) return html`<span class=${`eart sp-chat__sticker-unavailable ${cls}`} role="img" aria-label=${`${sticker.label} · ${t('需预载个性化资源')}`} ...${props}>${cached ? t('载入中') : t('需预载')}</span>`;
  return html`<img class=${`eart ${cls}`} src=${url} alt=${sticker.label} draggable=${false} decoding="async" ...${props} />`;
}

export function StickerPicker({ onSend, disabled = false, inMatch = false }) {
  const [open, setOpen] = useState(false);
  const [, refresh] = useState(0);
  const root = useRef(null), trigger = useRef(null), panel = useRef(null);
  const id = useRef(null);
  if (!id.current) id.current = `sp-sticker-picker-${++pickerSequence}`;
  useEffect(() => {
    const signature = () => CHAT_STICKERS.filter(sticker => !sticker.builtin && sticker.src && resourceCache.isCached(sticker.src)).map(sticker => sticker.id).join('|');
    let previous = signature();
    return resourceCache.subscribe(() => {
      const next = signature();
      if (next !== previous) { previous = next; refresh(value => value + 1); }
    });
  }, []);
  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); close(true);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const send = sticker => {
    if (disabled || !sticker.builtin && sticker.src && !resourceCache.isCached(sticker.src)) return;
    onSend(sticker.id);
    close(true);
  };
  const personal = CHAT_STICKERS.filter(sticker => !sticker.builtin);
  const groups = inMatch ? IN_MATCH_STICKER_GROUPS.map(group => ({ ...group, label: t(group.label) }))
    : [{ id: 'all', label: t('选择表情'), stickers: [...CHAT_STICKERS.filter(sticker => sticker.builtin), ...personal] }];
  return html`<span class="sp-sticker-picker" ref=${root}>
    <button ref=${trigger} type="button" class="sp-chat__sticker-toggle" disabled=${disabled}
      aria-label=${t('发送表情')} aria-haspopup="dialog" aria-expanded=${open} aria-controls=${id.current}
      title=${t('发送表情')} onClick=${() => setOpen(value => !value)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M7.5 14.5c1.3 3 7.7 3 9 0M8 9h.1M16 9h.1" stroke-linecap="round" /></svg>
    </button>
    ${open ? html`<span ref=${panel} id=${id.current} class="sp-chat__stickers" role="dialog" aria-label=${t('选择表情')}>
      <span class="sp-chat__sticker-head"><b>${t('选择表情')}</b><button type="button" aria-label=${t('关闭表情选择')} onClick=${() => close(true)}>×</button></span>
      <span class="sp-chat__sticker-scroll">
        ${groups.map(group => html`<section key=${group.id} class=${`sp-chat__sticker-group${inMatch ? '' : ' sp-chat__sticker-group--merged'}`} aria-label=${group.label}>
          ${inMatch ? html`<h4>${group.label}</h4>` : null}<span class="sp-chat__sticker-grid">${group.stickers.map(sticker => {
            const locked = !sticker.builtin && !!sticker.src && !resourceCache.isCached(sticker.src);
            return html`<button key=${sticker.id} class="sp-chat__sticker-choice" type="button" aria-label=${sticker.label}
              title=${`${sticker.label}${locked ? ` · ${t('需预载个性化资源')}` : ''}`} disabled=${disabled || locked} onClick=${() => send(sticker)}><${StickerArt} id=${sticker.id} missingAction=${false} /></button>`;
          })}</span>
        </section>`)}
      </span>
      <span class="sp-chat__sticker-note">${t('个性化表情预载后可用于聊天与局内交流。')}<button type="button" class="sp-chat__sticker-preload" onClick=${() => { close(); openResourcePreload(); }}>${t('预载资源')}</button></span>
    </span>` : null}
  </span>`;
}
