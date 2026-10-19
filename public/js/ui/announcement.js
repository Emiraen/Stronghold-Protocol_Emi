import { useEffect } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { t } from '../../../shared/i18n.js';

const HIDDEN_DAY_PREF = 'announcementHiddenDay';
function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function loadHiddenDay() {
  const value = loadPref(HIDDEN_DAY_PREF, '');
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}
const notices = createStore({ open: false, notice: null, dismissed: Number(loadPref('announcementDismissed', 0)) || 0, day: localDay(), hiddenDay: loadHiddenDay() });
function hideAnnouncementToday(hidden) {
  const day = localDay(), hiddenDay = hidden ? day : '';
  savePref(HIDDEN_DAY_PREF, hiddenDay);
  notices.set({ day, hiddenDay });
}
function AnnouncementTodayToggle({ checked }) {
  return html`<label class="announcement-today"><input type="checkbox" checked=${checked} onChange=${e => hideAnnouncementToday(e.currentTarget.checked)} /><span>${t('今日不再弹出')}</span></label>`;
}
export function acceptAnnouncement(value) {
  if (!value || typeof value.title !== 'string' || typeof value.content !== 'string' || !Number.isSafeInteger(value.updatedAt)) return;
  const old = notices.get().notice;
  if (old && value.updatedAt < old.updatedAt) return;
  if (old && value.updatedAt === old.updatedAt && value.title === old.title && value.content === old.content) return;
  notices.set({ notice: { title: value.title, content: value.content, updatedAt: value.updatedAt } });
}
function dismissAnnouncement() {
  const notice = notices.get().notice;
  if (!notice) return;
  savePref('announcementDismissed', notice.updatedAt);
  notices.set({ dismissed: notice.updatedAt });
}
export function openAnnouncement() {
  dismissAnnouncement();
  notices.set({ open: true });
}
export function AnnouncementButton({ class: cls = '', square = false, variant = 'secondary', testId = null }) {
  const s = useStore(v => v, Object.is, notices);
  const unread = !!(s.notice?.title || s.notice?.content) && s.dismissed !== s.notice.updatedAt;
  return html`<${Button} class=${`${cls}${unread ? ' is-unread' : ''}`} size="sm" variant=${variant} square=${square} icon="info" title=${t('服务器公告')}
    data-testid=${testId} aria-label=${t('服务器公告')} onClick=${openAnnouncement}>${square ? null : t('公告')}<//>`;
}
export function AnnouncementBanner() {
  const s = useStore(v => v, Object.is, notices);
  useEffect(() => {
    let stopped = false, busy = false, controller;
    const check = async () => {
      const day = localDay();
      if (notices.get().day !== day) notices.set({ day });
      if (stopped || busy || globalThis.document?.hidden) return;
      busy = true; controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 5000);
      try {
        const response = await fetch('/announcement.json', { cache: 'no-cache', signal: controller.signal });
        if (response.ok) { const value = await response.json(); if (!stopped) acceptAnnouncement(value); }
      } catch { /* A notice request never interrupts the game. */ }
      finally { busy = false; clearTimeout(timer); }
    };
    const syncHiddenDay = event => {
      if (event.key === `sp.pref.${HIDDEN_DAY_PREF}` || event.key === null) notices.set({ day: localDay(), hiddenDay: loadHiddenDay() });
    };
    const interval = setInterval(check, 30000);
    globalThis.document?.addEventListener('visibilitychange', check);
    globalThis.addEventListener('focus', check);
    globalThis.addEventListener('storage', syncHiddenDay);
    void check();
    return () => {
      stopped = true; controller?.abort(); clearInterval(interval);
      globalThis.document?.removeEventListener('visibilitychange', check);
      globalThis.removeEventListener('focus', check);
      globalThis.removeEventListener('storage', syncHiddenDay);
    };
  }, []);
  const active = !!(s.notice?.title || s.notice?.content);
  const hiddenToday = s.hiddenDay === s.day;
  return html`
    ${active && !hiddenToday && s.dismissed !== s.notice.updatedAt ? html`<aside class="east-announcement" role="status" aria-label=${t('服务器公告')}>
      <button type="button" class="east-announcement__content" onClick=${openAnnouncement}><b>${s.notice.title}</b><span>${s.notice.content}</span></button>
      <${AnnouncementTodayToggle} checked=${hiddenToday} />
      <${Button} variant="ghost" size="sm" square=${true} icon="close" title=${t('关闭公告')} aria-label=${t('关闭公告')} onClick=${dismissAnnouncement} />
    </aside>` : null}
    <${Modal} open=${s.open} onClose=${() => notices.set({ open: false })} title=${s.notice?.title || t('服务器公告')} micro="ANNOUNCEMENT" width="7.2rem" class="announcement-detail" utility=${true}>
      <p class="announcement-detail__text">${active ? s.notice.content : t('当前暂无公告')}</p>
      <${AnnouncementTodayToggle} checked=${hiddenToday} />
    <//>`;
}
