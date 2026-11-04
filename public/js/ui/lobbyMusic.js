import { html, Button } from './components.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { store, selectRoute } from '../store.js';
import { audio, bgmKeyFor } from '../audio.js';
import { getLocalMedia, putLocalMedia, deleteLocalMedia, probeLocalMedia } from './localMedia.js';
import { MUSIC_PLAYLISTS, loadMusicPlaylist, loadMusicTrack } from '../musicSources.js';
import { LobbyMusicPanel } from './lobbyMusicPanel.js';
import { chooseMusicTrack, normalizeMusicSettings } from './lobbyMusicQueue.js';
import { t } from '../../../shared/i18n.js';

export const MAX_MUSIC_BYTES = 20 * 1024 * 1024;
const SETTINGS_KEY = 'sp-lobby-music-v2';
const listeners = new Set();
let settings, settingsExisted = false;
try { const saved = localStorage.getItem(SETTINGS_KEY); settingsExisted = !!saved; settings = normalizeMusicSettings(JSON.parse(saved)); }
catch { settings = normalizeMusicSettings(); }
let playlists = MUSIC_PLAYLISTS.map(playlist => ({ ...playlist, tracks: [] }));
let record = null, objectUrl = null, player = null, source = null, gain = null;
let installed = false, busy = false, revision = 0, videoAudible = false;
let status = '默认大厅音乐', fadeTimer = null, fadeTarget = 0, playingRequest = null;
let catalogLoading = false, catalogError = '', catalogRequest = null, loadingTrackId = null;
let foreground = null, next = null, nextController = null, advancing = false;

const currentKey = () => { const state = store.get(); return bgmKeyFor(selectRoute(state), state.match?.public); };
const inMusicArea = () => selectRoute(store.get()) !== 'title' && currentKey() === 'lobby';
const customSelected = () => !!record?.enabled && !record.paused && inMusicArea();
const videoSelected = () => videoAudible && selectRoute(store.get()) === 'lobby';
const notify = () => listeners.forEach(listener => listener(music.snapshot()));
const aborted = error => error?.name === 'AbortError';
const sameTrack = (a, b) => !!a && !!b && a.id === b.id && a.playlistId === b.playlistId;
const shuffleActive = () => settings.mode === 'shuffle' && settings.shuffleIds.length > 0;
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); settingsExisted = true; } catch { /* Playback works without storage. */ } }

function fade(on, immediate = false) {
  const target = on ? 1 : 0;
  if (fadeTarget === target && !immediate) return;
  fadeTarget = target; clearTimeout(fadeTimer);
  if (gain && audio.ctx) {
    const value = gain.gain, now = audio.ctx.currentTime;
    if (value.cancelAndHoldAtTime) value.cancelAndHoldAtTime(now);
    else { value.cancelScheduledValues(now); value.setValueAtTime(value.value, now); }
    if (immediate) value.setValueAtTime(target, now);
    else value.linearRampToValueAtTime(target, now + .7);
  }
  if (!on) {
    if (immediate || !gain) player?.pause();
    else fadeTimer = setTimeout(() => { if (!fadeTarget) { player?.pause(); notify(); } }, 750);
  }
}

function clearNext() { nextController?.abort(); nextController = null; next = null; }

function replace(value) {
  clearTimeout(fadeTimer); fade(false, true); playingRequest = null;
  if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  record = value; objectUrl = value?.blob ? URL.createObjectURL(value.blob) : null;
  if (player) { player.loop = !shuffleActive(); if (objectUrl) player.src = objectUrl; }
}

function refresh() { audio.playBgm(currentKey()); notify(); }

function prefetchNext() {
  if (!shuffleActive() || !record?.track || record.paused || next) return;
  const track = chooseMusicTrack(playlists, settings.shuffleIds, record.track);
  if (!track) return;
  const controller = new AbortController(); nextController = controller;
  const pending = { track, blob: null, promise: null }; next = pending;
  pending.promise = loadMusicTrack(track, { signal: controller.signal }).then(blob => {
    pending.blob = blob; return blob;
  }).catch(error => {
    if (next === pending && !aborted(error)) { status = '下一首预载失败，当前歌曲继续播放'; notify(); }
    return null;
  });
  notify();
}

function syncPlayer() {
  if (!player) return;
  if (!customSelected() || videoSelected() || document.hidden) {
    fade(false, document.hidden || videoSelected() || !record || !!record.paused); return;
  }
  if (!audio.ctx || !audio.bgmGain) return;
  try {
    if (!source) {
      source = audio.ctx.createMediaElementSource(player); gain = audio.ctx.createGain(); gain.gain.value = 0;
      source.connect(gain); gain.connect(audio.bgmGain);
    }
    fade(true);
    if (advancing && player.ended) return;
    if (!player.paused || playingRequest) return;
    const playingRecord = record, request = player.play(); playingRequest = request;
    request.then(() => {
      if (playingRecord !== record) return;
      if (!customSelected() || videoSelected() || document.hidden) { syncPlayer(); return; }
      status = shuffleActive() ? '正在播放 · 随机播放' : '正在播放 · 单曲循环';
      prefetchNext(); notify();
    }, () => {
      if (playingRecord === record && customSelected()) { status = '点击“播放”开始音乐'; notify(); }
    }).finally(() => { if (playingRequest === request) playingRequest = null; });
  } catch {
    if (record) record.enabled = false;
    status = '音乐播放失败，已恢复默认音乐'; refresh();
  }
}

async function refreshCatalog() {
  if (catalogRequest) return catalogRequest;
  catalogLoading = true; catalogError = ''; notify();
  catalogRequest = (async () => {
    const results = await Promise.allSettled(MUSIC_PLAYLISTS.map(playlist => loadMusicPlaylist(playlist.id)));
    playlists = [...playlists];
    const failures = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        const playlist = result.value;
        playlists[index] = { ...MUSIC_PLAYLISTS[index], ...playlist,
          tracks: playlist.tracks.map(track => ({ ...track, playlistId: playlist.id, playlistTitle: playlist.title })) };
      } else failures.push(MUSIC_PLAYLISTS[index].title + '：' + (result.reason?.message || '歌单获取失败'));
    }
    catalogError = failures.join('；');
    return playlists;
  })().finally(() => { catalogLoading = false; catalogRequest = null; notify(); });
  return catalogRequest;
}

async function startTrack(track, token, prepared = null) {
  foreground?.abort(); const controller = new AbortController(); foreground = controller;
  busy = true; loadingTrackId = track.id; status = '正在预载 · ' + track.title; notify();
  try {
    const blob = prepared || await loadMusicTrack(track, { signal: controller.signal, onProgress: (done, total) => {
      if (token !== revision) return;
      status = '正在预载 · ' + track.title + (total ? ` · ${Math.floor(done / total * 100)}%` : ''); notify();
    } });
    if (token !== revision) return false;
    replace({ blob, name: track.title, track, enabled: true, paused: settings.paused });
    settings.selected = { id: track.id, playlistId: track.playlistId }; saveSettings();
    status = settings.paused ? '已暂停 · 使用默认音乐' : '已预载 · ' + track.title;
    refresh(); prefetchNext(); return true;
  } catch (error) {
    if (token !== revision || aborted(error)) return false;
    status = error.message || '音乐预载失败，请重试'; notify(); throw error;
  } finally {
    if (foreground === controller) { foreground = null; busy = false; loadingTrackId = null; notify(); }
  }
}

async function advanceShuffle() {
  if (!shuffleActive() || record?.paused || advancing) return;
  advancing = true;
  const token = ++revision, pending = next;
  const track = pending?.track || chooseMusicTrack(playlists, settings.shuffleIds, record?.track);
  if (!track) { advancing = false; status = '所选歌单暂无可播放音乐'; notify(); return; }
  try {
    status = '正在准备下一首'; notify();
    const blob = pending?.blob || (pending ? await pending.promise : null);
    if (token !== revision) return;
    clearNext(); await startTrack(track, token, blob);
  } catch (error) {
    if (token !== revision || aborted(error)) return;
    if (record) { record.paused = true; settings.paused = true; saveSettings(); }
    refresh();
  } finally { advancing = false; }
}

function install() {
  if (installed) return;
  installed = true; player = new Audio(); player.loop = true; player.preload = 'none';
  player.addEventListener('pause', notify);
  player.addEventListener('ended', () => { void advanceShuffle(); });
  player.onerror = () => {
    clearNext();
    if (record) record.enabled = false;
    status = '浏览器无法播放这首音乐，请选择其他歌曲'; refresh();
  };
  const playEastBgm = audio.playBgm.bind(audio); let overridden = false;
  audio.playBgm = key => {
    const override = key === 'lobby' && (customSelected() || videoSelected());
    if (override && !overridden) ++audio.bgmToken;
    overridden = override; playEastBgm(override ? null : key); syncPlayer();
  };
  store.subscribe((state, previous) => {
    if (selectRoute(state) !== selectRoute(previous)
      || bgmKeyFor(selectRoute(state), state.match?.public) !== bgmKeyFor(selectRoute(previous), previous.match?.public)) refresh();
  });
  document.addEventListener('visibilitychange', syncPlayer);
  window.addEventListener('sp:lobby-video-audio', event => { videoAudible = !!event.detail?.active; refresh(); });
  const gesture = () => { if (customSelected()) { audio._unlock(); refresh(); } };
  for (const name of ['pointerdown', 'keydown', 'touchend', 'click']) window.addEventListener(name, gesture, { passive: true });
  const initialRevision = revision;
  void (async () => {
    if (settings.mode === 'manual' || settings.mode === 'shuffle') {
      await refreshCatalog();
      if (initialRevision !== revision) return;
      const track = settings.mode === 'shuffle' ? chooseMusicTrack(playlists, settings.shuffleIds)
        : playlists.flatMap(playlist => playlist.tracks).find(track => sameTrack(track, settings.selected));
      if (track) await startTrack(track, initialRevision);
      else { status = catalogError || '已保存的歌曲暂不可用，请选择音乐'; notify(); }
      return;
    }
    const value = await getLocalMedia('lobbyMusic');
    if (initialRevision !== revision || settings.mode === 'default' && settingsExisted) return;
    if (!(value?.blob instanceof Blob) || !value.blob.size || value.blob.size > MAX_MUSIC_BYTES) return;
    settings.mode = 'local'; settings.paused = value.paused === true; saveSettings();
    replace({ ...value, enabled: value.enabled !== false, paused: settings.paused });
    status = record.paused ? '已暂停 · 使用默认音乐' : '点击“播放”开始音乐'; refresh();
  })().catch(error => { if (initialRevision === revision) { status = error.message || '本地音乐存储暂不可用'; notify(); } });
}

export const music = {
  snapshot: () => ({ name: record?.name || '', size: record?.blob?.size || 0, enabled: !!record?.enabled,
    paused: !!record?.paused, playing: !!player && !player.paused && customSelected() && !videoSelected(),
    status: t(status), busy, mode: settings.mode, shuffleIds: [...settings.shuffleIds], playlists,
    catalogLoading, catalogError, loadingTrackId, currentTrackId: record?.track?.id || null,
    currentPlaylistId: record?.track?.playlistId || null, nextTitle: next?.track.title || '',
    currentArtist: record?.track?.playlistId !== 'ost' ? record?.track?.artist || '' : '', currentDuration: record?.track?.duration ?? null }),
  async refreshCatalog() { install(); return refreshCatalog(); },
  async playTrack(track) {
    install(); audio._unlock(); const token = ++revision; advancing = false; clearNext();
    settings.mode = settings.shuffleIds.length ? 'shuffle' : 'manual'; settings.paused = false; saveSettings();
    if (player) player.loop = !shuffleActive();
    return startTrack(track, token);
  },
  async setShuffle(id, checked) {
    if (!MUSIC_PLAYLISTS.some(playlist => playlist.id === id)) return;
    install(); audio._unlock(); const token = ++revision;
    foreground?.abort(); foreground = null; busy = false; loadingTrackId = null; advancing = false; clearNext();
    settings.shuffleIds = checked ? [...new Set([...settings.shuffleIds, id])] : settings.shuffleIds.filter(value => value !== id);
    settings.mode = settings.shuffleIds.length ? 'shuffle' : record ? record.track ? 'manual' : 'local' : 'default';
    settings.paused = false; saveSettings();
    if (player) player.loop = !settings.shuffleIds.length;
    status = settings.shuffleIds.length ? '正在准备随机播放' : record ? '正在播放 · 单曲循环' : '默认大厅音乐';
    notify();
    if (!settings.shuffleIds.length) {
      if (player) player.loop = true;
      if (record) record.paused = false;
      status = record ? '正在播放 · 单曲循环' : '默认大厅音乐'; refresh(); return;
    }
    if (!playlists.some(playlist => settings.shuffleIds.includes(playlist.id) && playlist.tracks.length)) await refreshCatalog();
    if (token !== revision) return;
    const track = chooseMusicTrack(playlists, settings.shuffleIds, record?.track);
    if (!track) { status = catalogError || '所选歌单暂无可播放音乐'; notify(); return; }
    return startTrack(track, token);
  },
  async upload(file) {
    install(); audio._unlock(); const token = ++revision; foreground?.abort(); advancing = false; clearNext(); busy = true; notify();
    try {
      if (!file?.size) throw new Error(t('请选择有效的音频文件'));
      if (file.size > MAX_MUSIC_BYTES) throw new Error(t('音乐不能超过 20MB，请选择较小的文件'));
      if (!/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name || '')
        || file.type && !file.type.startsWith('audio/') && !['video/webm', 'application/ogg'].includes(file.type))
        throw new Error(t('请选择 MP3、M4A、OGG、WAV 等音频文件'));
      await probeLocalMedia(file, 'audio');
      if (token !== revision) return;
      const value = { blob: file, name: file.name.slice(0, 180), enabled: true, paused: false };
      await putLocalMedia('lobbyMusic', value);
      if (token !== revision) return;
      settings.mode = 'local'; settings.paused = false; saveSettings(); replace(value); status = '已保存音乐'; refresh();
    } catch (error) { if (token === revision) { status = error.message || '音乐导入失败'; notify(); } throw error; }
    finally { if (token === revision) { busy = false; notify(); } }
  },
  async toggle() {
    install(); audio._unlock();
    if (!record) {
      if (settings.mode === 'shuffle') { const id = settings.shuffleIds[0]; if (id) return music.setShuffle(id, true); }
      return;
    }
    record.enabled = true; record.paused = !record.paused && !player.paused;
    settings.paused = record.paused; saveSettings();
    if (settings.mode === 'local') await putLocalMedia('lobbyMusic', record);
    status = record.paused ? '已暂停 · 使用默认音乐' : '点击“播放”开始音乐';
    if (!record.paused && player.ended && shuffleActive()) { void advanceShuffle(); return; }
    refresh(); if (!record.paused) prefetchNext();
  },
  async reset() {
    install(); ++revision; foreground?.abort(); foreground = null; advancing = false; clearNext(); busy = false; loadingTrackId = null;
    settings = normalizeMusicSettings(); saveSettings(); replace(null); status = '默认大厅音乐'; refresh();
    await deleteLocalMedia('lobbyMusic');
  },
};

export function LobbyMusicButton() {
  const [open, setOpen] = useState(false), [state, setState] = useState(music.snapshot);
  useEffect(() => {
    install(); const listener = value => setState(value); listeners.add(listener); listener(music.snapshot());
    return () => listeners.delete(listener);
  }, []);
  return html`
    <${Button} variant="secondary" size="sm" square=${true} class="hub-music-btn" title=${t('大厅音乐')} aria-label=${t('大厅音乐')}
      onClick=${() => { setOpen(true); void music.refreshCatalog(); }}>
      <svg class="btn__icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M9 3v12.2a4 4 0 1 0 2 3.5V7.1l8-2v8.1a4 4 0 1 0 2 3.5V0z" /></svg>
    <//>
    <${LobbyMusicPanel} open=${open} onClose=${() => setOpen(false)} state=${state} actions=${music} />`;
}
