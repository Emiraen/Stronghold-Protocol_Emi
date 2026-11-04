import { html, Button, Icon, Modal } from './components.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { searchMusicTracks } from './musicSearch.js';
import { loadMusicCover, musicCoverCacheKey } from '../musicSources.js';
import { t } from '../../../shared/i18n.js';

const PAGE_SIZE = 60;
const PLAYLISTS = [
  { id: 'ost', title: '明日方舟原声带' },
  { id: 'personal', title: 'The music so good even a devil may cry' },
];
const sizeLabel = bytes => bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '';
const durationLabel = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—:—';
  const whole = Math.floor(seconds), minutes = Math.floor(whole / 60), rest = String(whole % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

function AlbumArtwork({ track, enabled, playing }) {
  const [image, setImage] = useState(null);
  const active = useRef(null);
  const key = track?.coverResource ? musicCoverCacheKey(track) : null;
  useEffect(() => {
    if (!enabled || !key) return undefined;
    const controller = new AbortController();
    let url;
    void loadMusicCover(track, { signal: controller.signal }).then(blob => {
      if (controller.signal.aborted || !blob) return;
      url = URL.createObjectURL(blob);
      const next = { key, url }; active.current = next; setImage(next);
    }).catch(() => { /* Missing art keeps a stable, compact placeholder. */ });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      if (active.current?.url === url) active.current = null;
    };
  }, [enabled, key]);
  const url = enabled && image === active.current && image?.key === key ? image.url : null;
  return html`<div class="music-library__artwork" title=${track?.album || undefined}>
    ${url ? html`<img src=${url} alt=${t('专辑封面')} width="64" height="64" decoding="async"
      onError=${() => setImage(null)} />` : html`<${Icon} name=${playing ? 'signal' : 'play'} />`}
  </div>`;
}

/** The existing lobby music button owns opening and catalog loading. */
export function LobbyMusicPanel({ open, onClose, state = {}, actions = {} }) {
  const [query, setQuery] = useState(''), [active, setActive] = useState('ost');
  const [page, setPage] = useState(0), [error, setError] = useState('');
  const input = useRef(null), list = useRef(null);
  const playlists = PLAYLISTS.map(playlist => ({ ...playlist,
    ...(state.playlists || []).find(value => value.id === playlist.id) }));
  const results = useMemo(() => searchMusicTracks(state.playlists || [], query), [state.playlists, query]);
  const searching = !!query.trim();
  const tracks = searching ? results : results.filter(track => track.playlistId === active);
  const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const visible = tracks.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); }, [query, active]);
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [currentPage, query, active]);
  useEffect(() => { if (open) setError(''); }, [open]);
  const action = async callback => {
    setError('');
    try { await callback?.(); } catch (failure) { setError(failure?.message || t('操作失败')); }
  };
  const currentLabel = state.mode === 'shuffle' ? t('随机播放') : state.mode === 'manual' || state.mode === 'local' ? t('单曲循环') : t('默认音乐');
  return html`<${Modal} class="lobby-music-panel lobby-music-panel--library" open=${open} title=${t('大厅音乐')} micro="LOBBY MUSIC"
    width="min(680px, calc(100vw - 24px))" onClose=${onClose}
    actions=${html`<${Button} variant="secondary" onClick=${onClose}>${t('关闭')}<//>`}>
    <div class="music-library">
      <section class="music-library__now" aria-label=${t('当前音乐')}>
        <${AlbumArtwork} track=${state.currentTrack} enabled=${open} playing=${state.playing} />
        <div class="music-library__now-text"><span class="music-library__eyebrow">${currentLabel}</span>
          <strong>${state.name || t('默认大厅音乐')}</strong>
          ${state.name && (state.currentArtist || Number.isFinite(state.currentDuration))
            ? html`<small>${[state.currentArtist, Number.isFinite(state.currentDuration) ? durationLabel(state.currentDuration) : ''].filter(Boolean).join(' · ')}</small>` : null}
          <small role="status" aria-live="polite">${state.status || ''}</small>
          ${state.nextTitle && state.mode === 'shuffle' ? html`<small class="music-library__next">${t('下一首')} · ${state.nextTitle}</small>` : null}
        </div>
        <${Button} variant="secondary" size="sm" icon=${state.playing ? 'pause' : 'play'} disabled=${!state.name || state.busy}
          onClick=${() => action(actions.toggle)}>${state.playing ? t('暂停') : t('播放')}<//>
      </section>
      <div class="music-library__search">
        <${Icon} name="search" />
        <input type="search" value=${query} aria-label=${t('搜索两个歌单的音乐')} placeholder=${t('搜索音乐 · 同时搜索两个歌单')}
          autoCapitalize="none" autoComplete="off" spellcheck=${false} enterKeyHint="search"
          onInput=${event => setQuery(event.currentTarget.value)} />
        ${query ? html`<button type="button" class="music-library__clear" aria-label=${t('清空搜索')} onClick=${() => setQuery('')}><${Icon} name="x" /></button>` : null}
      </div>
      <div class="music-library__playlists" aria-label=${t('歌单与随机播放')}>
        ${playlists.map(playlist => html`<div key=${playlist.id} class=${`music-playlist ${active === playlist.id && !searching ? 'is-active' : ''}`}>
          <button type="button" class="music-playlist__open" aria-pressed=${active === playlist.id && !searching}
            onClick=${() => { setActive(playlist.id); setQuery(''); }}>
            <strong>${playlist.title}</strong><small>${playlist.tracks ? `${playlist.tracks.length} ${t('首')}` : t('等待读取歌单')}</small>
          </button>
          <label class="music-playlist__shuffle"><input type="checkbox" checked=${(state.shuffleIds || []).includes(playlist.id)}
            onClick=${event => {
              // Commit before the window audio-unlock click can redraw this controlled input.
              const checked = event.currentTarget.checked;
              action(() => actions.setShuffle?.(playlist.id, checked));
            }} />
            <span>${t('随机播放')}</span></label>
        </div>`)}
      </div>
      <p class="music-library__hint">${searching ? (state.shuffleIds || []).length
        ? t('搜索结果按匹配程度排序。点歌后继续随机播放。') : t('搜索结果按匹配程度排序。点击歌曲后持续单曲循环。')
        : state.mode === 'shuffle' ? t('从勾选的歌单随机播放；点歌切换当前歌曲，播完后继续随机。播放时提前下载下一首。')
          : t('勾选歌单可随机播放；未勾选时，主动点歌后持续单曲循环。')}</p>
      ${state.catalogLoading ? html`<div class="music-library__notice" role="status">${t('正在从资源服读取歌单…')}</div>` : null}
      ${state.catalogError ? html`<div class="music-library__notice music-library__notice--error" role="alert"><span>${state.catalogError}</span>
        <${Button} size="sm" disabled=${state.catalogLoading} onClick=${() => action(actions.refreshCatalog)}>${t('重新读取')}<//></div>` : null}
      <div class="music-library__list-head"><span>${searching ? t('搜索结果') : playlists.find(playlist => playlist.id === active)?.title}</span>
        <small>${tracks.length} ${t('首')}</small></div>
      <div ref=${list} class="music-library__list" aria-label=${t('歌曲列表')} aria-busy=${!!state.catalogLoading}>
        ${visible.map(track => {
          const loading = state.loadingTrackId === track.id;
          const current = state.currentTrackId === track.id && (!state.currentPlaylistId || state.currentPlaylistId === track.playlistId);
          return html`<button key=${track.playlistId + ':' + track.id} type="button" class=${`music-track ${current ? 'is-current' : ''}`}
            disabled=${state.busy || loading} aria-label=${`${loading ? t('正在预载') : t('播放')} ${track.title}`}
            aria-current=${current ? 'true' : undefined} onClick=${() => action(() => actions.playTrack?.(track))}>
            <span class="music-track__play" aria-hidden="true"><${Icon} name=${loading ? 'download' : current && state.playing ? 'signal' : 'play'} /></span>
            <span class="music-track__text"><strong>${track.title}</strong>
              <small>${[track.playlistId !== 'ost' ? track.artist || t('演唱者未标注') : '', searching ? track.playlistTitle : '', loading ? t('正在预载…') : ''].filter(Boolean).join(' · ')}</small></span>
            <span class="music-track__details"><span class="music-track__duration" aria-label=${t('时长') + ' ' + durationLabel(track.duration)}>${durationLabel(track.duration)}</span>
              <small class="music-track__size">${sizeLabel(track.bytes)}</small></span>
          </button>`;
        })}
        ${!visible.length && !state.catalogLoading ? html`<p class="music-library__empty">${searching ? t('没有找到匹配的音乐，试试歌曲名或歌手名。') : t('资源服歌单暂不可用。')}
          ${!searching && !state.catalogError ? html`<${Button} size="sm" onClick=${() => action(actions.refreshCatalog)}>${t('读取歌单')}<//>` : null}</p>` : null}
      </div>
      ${totalPages > 1 ? html`<nav class="music-library__pages" aria-label=${t('歌曲分页')}>
        <${Button} size="sm" icon="chevronLeft" disabled=${currentPage === 0} onClick=${() => setPage(currentPage - 1)}>${t('上一页')}<//>
        <span>${currentPage + 1} / ${totalPages}</span>
        <${Button} size="sm" iconRight="chevronRight" disabled=${currentPage + 1 === totalPages} onClick=${() => setPage(currentPage + 1)}>${t('下一页')}<//>
      </nav>` : null}
      <div class="music-library__footer">
        <input ref=${input} type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav,.aac,.flac,.webm" hidden onChange=${event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) action(() => actions.upload?.(file));
        }} />
        <div class="music-library__local-actions"><${Button} size="sm" disabled=${state.busy} onClick=${() => input.current?.click()}>${t('导入本地音乐')}<//>
          <${Button} size="sm" variant="ghost" disabled=${state.busy} onClick=${() => action(actions.reset)}>${t('恢复默认')}<//></div>
        <small>${t('本地导入每首最大 20MB。播放偏好仅保存在本设备；音量沿用游戏设置。')}</small>
      </div>
      ${error ? html`<p class="local-music__error" role="alert">${error}</p>` : null}
    </div>
  <//>`;
}
