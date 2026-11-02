import { h } from '../../vendor/preact.module.js';
import { useEffect, useLayoutEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon } from './components.js';
import { useStore } from '../store.js';
import { acquireResourceUrl, resourceCache } from '../resourceCache.js';
import { NAMEPLATES, nameplateFor, nameplateUrls } from '../../../shared/nameplates.js';
import { skinsStore, setNameplate } from './skins.js';
import { t } from '../../../shared/i18n.js';

// This accessor deliberately never uses availableBlob: optional art must not download on render.
export function cachedNameplateSource(id, variant = 'long') {
  const row = nameplateFor(id);
  if (!row) return null;
  const url = row[variant] || row.long || row.short;
  return url && resourceCache.isCached(url) ? url : null;
}

export function useNameplateUrl(id, variant = 'long') {
  const [revision, refresh] = useState(0);
  const [loaded, setLoaded] = useState(null);
  const src = cachedNameplateSource(id, variant);
  useLayoutEffect(() => {
    let previous = cachedNameplateSource(id, variant);
    return resourceCache.subscribe(() => {
      const next = cachedNameplateSource(id, variant);
      if (next !== previous) { previous = next; refresh(n => n + 1); }
    });
  }, [id, variant]);
  useLayoutEffect(() => {
    let cancelled = false, resource, image;
    if (!src) { setLoaded(null); return undefined; }
    acquireResourceUrl(src, { cachedOnly: true }).then(handle => {
      if (cancelled) { handle.release(); return; }
      resource = handle;
      image = new Image();
      image.onload = () => { if (!cancelled) setLoaded({ src, url: handle.url }); };
      image.onerror = () => { if (!cancelled) setLoaded(null); };
      image.src = handle.url;
    }).catch(() => { if (!cancelled) setLoaded(null); });
    return () => {
      cancelled = true;
      if (image) image.onload = image.onerror = null;
      resource?.release();
    };
  }, [src, revision]);
  return loaded?.src === src ? loaded.url : undefined;
}

/** The wrapper keeps the original DOM layout and default class when optional art is absent. */
export function Nameplate({ as = 'div', nameplate = '', variant = 'long', hideUncached = false, class: cls = '', children, ...props }) {
  const native = nameplateFor(nameplate)?.game === 'arknights';
  const url = useNameplateUrl(nameplate, native ? 'long' : variant);
  if (hideUncached && !url) return null;
  return h(as, { ...props, class: `${cls}${url ? ' has-nc' : ''}` },
    url ? native ? html`<span class="nc-layer nc-layer--native" aria-hidden="true"><svg class="nc-native-art" viewBox=${variant === 'short' ? '20 1 530 134' : '20 1 960 134'} preserveAspectRatio="xMaxYMid slice"><image href=${url} x="0" y="0" width="1000" height="172" /></svg></span>` : html`<span class="nc-layer" aria-hidden="true" style=${{ '--nc': `url("${url}")` }}></span>` : null,
    children);
}

const PAGE_SIZE = 18;
function TemplateTile({ row, selected, onSelect, disabled }) {
  const cached = cachedNameplateSource(row?.id);
  return html`<button type="button" class=${`nameplate-option${selected ? ' is-selected' : ''}`} aria-pressed=${selected}
      onClick=${onSelect} disabled=${disabled} data-nameplate=${row?.id || ''} title=${row?.name || t('默认样式')}>
    <${Nameplate} class="nameplate-option__art" nameplate=${row?.id}>
      ${selected ? html`<span class="nameplate-option__check"><${Icon} name="check" /></span>` : null}
      ${!row ? html`<span class="nameplate-option__default">STRONGHOLD PROTOCOL</span>` : null}
    <//>
    <span class="nameplate-option__label"><b>${row?.name || t('默认样式')}</b>${row && !cached ? html`<small>${t('未预载')}</small>` : null}</span>
  </button>`;
}

export function NameplatePicker({ onClose, name, rank }) {
  const presentation = useStore(s => s, Object.is, skinsStore);
  const [selected, select] = useState(presentation.nameplate || '');
  const [game, setGame] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const preview = useNameplateUrl(selected);
  const [cacheRevision, refresh] = useState(0);
  useEffect(() => {
    const status = () => nameplateUrls(selected).map(url => resourceCache.isCached(url)).join();
    let previous = status();
    return resourceCache.subscribe(() => {
      const next = status();
      if (previous !== next) { previous = next; refresh(n => n + 1); }
    });
  }, [selected]);
  useEffect(() => {
    if (!saving) return;
    if (presentation.sync === 'error') { setSaving(false); setError(t('保存失败')); }
    else if (presentation.profileReady && presentation.sync === 'synced' && presentation.nameplate === selected) onClose();
  }, [saving, presentation.sync, presentation.profileReady, presentation.nameplate, selected]);
  // Reset unsaved choices on account changes; never submit the previous account's draft.
  useEffect(() => { select(skinsStore.get().nameplate || ''); setSaving(false); setError(''); }, [presentation.identityEpoch]);
  const filtered = NAMEPLATES.filter(row => (game === 'all' || row.game === game)
    && (!query.trim() || `${row.name} ${row.theme}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const cached = selected && nameplateUrls(selected).every(url => resourceCache.isCached(url));
  void cacheRevision;
  const install = async () => {
    setDownloading(true); setError('');
    try {
      if (!await resourceCache.ensureManifestReady()) throw new Error(t('资源清单加载失败'));
      const urls = nameplateUrls(selected);
      if (!await resourceCache.download('optional', { urls }) || !urls.every(url => resourceCache.isCached(url))) {
        throw new Error(t('模板未完整预载，请在资源管理中继续'));
      }
    } catch (e) { setError(e.message || t('预载失败')); }
    finally { setDownloading(false); }
  };
  return html`<${Modal} open=${true} title=${t('名牌选择')} micro="NAMEPLATE" class="nameplate-picker" utility=${true} width="min(900px, 96vw)" onClose=${onClose}
      actions=${html`<span class="nameplate-picker__status" role="status">${error || (saving ? t('保存中…') : '')}</span>
        ${selected && !cached ? html`<${Button} variant="secondary" size="sm" disabled=${downloading || saving} onClick=${install}>${downloading ? t('预载中…') : t('预载所选')}<//>` : null}
        <${Button} variant="primary" size="sm" disabled=${!presentation.profileReady || saving} onClick=${() => {
          setError(''); if (setNameplate(selected)) setSaving(true);
        }}>${t('应用')}<//>`}>
    <${Nameplate} class="nameplate-preview" nameplate=${selected}>
      <b>${name || t('博士')}</b><span>${rank || t('卫戍模拟档案')}</span>
      ${selected && !preview ? html`<small>${t('未预载')}</small>` : null}
    <//>
    <div class="nameplate-picker__filters">
      <div class="nameplate-picker__tabs" role="group" aria-label=${t('模板来源')}>
        ${[['all', t('全部')], ['arknights', t('明日方舟')], ['valorant', t('无畏契约')]].map(([id, label]) => html`<button type="button" disabled=${saving} aria-pressed=${id === game} class=${id === game ? 'is-selected' : ''} onClick=${() => { setGame(id); setPage(0); }}>${label}</button>`)}
      </div>
      <input type="search" disabled=${saving} value=${query} aria-label=${t('搜索模板')} placeholder=${t('搜索模板')} onInput=${e => { setQuery(e.currentTarget.value); setPage(0); }} />
    </div>
    <div class="nameplate-picker__grid" aria-label=${t('名牌模板')}>
      <${TemplateTile} selected=${selected === ''} disabled=${saving || downloading} onSelect=${() => select('')} />
      ${filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row => html`<${TemplateTile} key=${row.id} row=${row} selected=${selected === row.id} disabled=${saving || downloading} onSelect=${() => select(row.id)} />`)}
    </div>
    <nav class="nameplate-picker__pages" aria-label=${t('模板分页')}>
      <${Button} variant="ghost" size="sm" disabled=${currentPage === 0} onClick=${() => setPage(currentPage - 1)}>${t('上一页')}<//>
      <span>${currentPage + 1} / ${pages}</span>
      <${Button} variant="ghost" size="sm" disabled=${currentPage + 1 >= pages} onClick=${() => setPage(currentPage + 1)}>${t('下一页')}<//>
    </nav>
  <//>`;
}
