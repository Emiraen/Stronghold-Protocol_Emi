import { html, Button, Modal } from './components.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { store, selectRoute } from '../store.js';
import { audio, bgmKeyFor } from '../audio.js';
import { getLocalMedia, putLocalMedia, deleteLocalMedia, probeLocalMedia } from './localMedia.js';
import { t } from '../../../shared/i18n.js';

export const MAX_MUSIC_BYTES = 20 * 1024 * 1024;
const listeners = new Set();
let record = null, objectUrl = null, player = null, source = null, gain = null;
let installed = false, busy = false, revision = 0, videoAudible = false;
let status = '默认大厅音乐', fadeTimer = null, fadeTarget = 0, playingRequest = null;

const currentKey = () => {
  const state = store.get();
  return bgmKeyFor(selectRoute(state), state.match?.public);
};
const inMusicArea = () => selectRoute(store.get()) !== 'title' && currentKey() === 'lobby';
const customSelected = () => !!record?.enabled && !record.paused && inMusicArea();
const videoSelected = () => videoAudible && selectRoute(store.get()) === 'lobby';
const notify = () => listeners.forEach(listener => listener(music.snapshot()));

function fade(on, immediate = false) {
  const target = on ? 1 : 0;
  if (fadeTarget === target && !immediate) return;
  fadeTarget = target;
  clearTimeout(fadeTimer);
  if (gain && audio.ctx) {
    const now = audio.ctx.currentTime;
    const value = gain.gain;
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

function replace(next) {
  clearTimeout(fadeTimer);
  fade(false, true);
  playingRequest = null;
  if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  record = next;
  objectUrl = next?.blob ? URL.createObjectURL(next.blob) : null;
  if (player && objectUrl) player.src = objectUrl;
}

function syncPlayer() {
  if (!player) return;
  const wanted = customSelected() && !videoSelected() && !document.hidden;
  if (!wanted) { fade(false, document.hidden || videoSelected() || !record || !!record.paused); return; }
  if (!audio.ctx || !audio.bgmGain) return;
  try {
    if (!source) {
      source = audio.ctx.createMediaElementSource(player);
      gain = audio.ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain); gain.connect(audio.bgmGain);
    }
    fade(true);
    if (!player.paused || playingRequest) return;
    const currentRecord = record;
    const request = player.play();
    playingRequest = request;
    request.then(() => {
      if (currentRecord !== record) return;
      if (!customSelected() || videoSelected() || document.hidden) { syncPlayer(); return; }
      status = t('正在播放 · 单曲循环'); notify();
    }, () => {
      if (currentRecord !== record || !customSelected()) return;
      status = t('点击“播放”开始音乐'); notify();
    }).finally(() => { if (playingRequest === request) playingRequest = null; });
  } catch {
    if (record) record.enabled = false;
    status = t('音乐播放失败，已恢复默认音乐');
    refresh();
  }
}

function refresh() {
  audio.playBgm(currentKey());
  notify();
}

function install() {
  if (installed) return;
  installed = true;
  player = new Audio(); player.loop = true; player.preload = 'none';
  player.addEventListener('pause', notify);
  player.onerror = () => {
    if (record) record.enabled = false;
    status = t('音乐播放失败，已恢复默认音乐'); refresh();
  };

  // East's audio engine stays intact. The adapter only substitutes its lobby track;
  // custom audio still passes through East's BGM volume and master mute channels.
  const playEastBgm = audio.playBgm.bind(audio);
  let overridden = false;
  audio.playBgm = key => {
    const override = key === 'lobby' && (customSelected() || videoSelected());
    // Also invalidate a default track still decoding when the user imports local music.
    if (override && !overridden) ++audio.bgmToken;
    overridden = override;
    playEastBgm(override ? null : key);
    syncPlayer();
  };
  store.subscribe((state, previous) => {
    if (selectRoute(state) !== selectRoute(previous)
        || bgmKeyFor(selectRoute(state), state.match?.public) !== bgmKeyFor(selectRoute(previous), previous.match?.public)) refresh();
  });
  document.addEventListener('visibilitychange', syncPlayer);
  window.addEventListener('sp:lobby-video-audio', event => {
    videoAudible = !!event.detail?.active; refresh();
  });
  const gesture = () => {
    if (!customSelected()) return;
    audio._unlock(); refresh();
  };
  for (const name of ['pointerdown', 'keydown', 'touchend', 'click']) {
    window.addEventListener(name, gesture, { passive: true });
  }
  const initialRevision = revision;
  getLocalMedia('lobbyMusic').then(value => {
    if (initialRevision !== revision || !(value?.blob instanceof Blob) || !value.blob.size || value.blob.size > MAX_MUSIC_BYTES) return;
    replace({ ...value, enabled: value.enabled !== false, paused: value.paused === true });
    status = record.paused ? t('已暂停 · 使用默认音乐') : t('点击“播放”开始音乐');
    refresh();
  }).catch(() => { status = t('本地音乐存储暂不可用'); notify(); });
}

async function validate(file) {
  if (!file?.size) throw new Error(t('请选择有效的音频文件'));
  if (file.size > MAX_MUSIC_BYTES) throw new Error(t('音乐不能超过 20MB，请选择较小的文件'));
  if (!/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name || '')
      || (file.type && !file.type.startsWith('audio/') && file.type !== 'video/webm' && file.type !== 'application/ogg')) {
    throw new Error(t('请选择 MP3、M4A、OGG、WAV 等音频文件'));
  }
  await probeLocalMedia(file, 'audio');
}

export const music = {
  snapshot: () => ({
    name: record?.name || '', size: record?.blob?.size || 0,
    enabled: !!record?.enabled, paused: !!record?.paused,
    playing: !!player && !player.paused && customSelected() && !videoSelected(), status: t(status), busy,
  }),
  async upload(file) {
    if (busy) return;
    install(); ++revision; busy = true; notify();
    try {
      await validate(file);
      const next = { blob: file, name: file.name.slice(0, 180), enabled: true, paused: false };
      await putLocalMedia('lobbyMusic', next);
      replace(next); status = t('已保存音乐'); audio._unlock(); refresh();
    } catch (error) { status = error.message || t('音乐导入失败'); throw error; }
    finally { busy = false; notify(); }
  },
  async toggle() {
    if (!record || busy) return;
    ++revision; busy = true; notify();
    try {
      const next = { ...record, enabled: true, paused: !!record.enabled && !player.paused };
      await putLocalMedia('lobbyMusic', next);
      record = next;
      status = next.paused ? t('已暂停 · 使用默认音乐') : t('点击“播放”开始音乐');
      audio._unlock(); refresh();
    } finally { busy = false; notify(); }
  },
  async reset() {
    if (busy) return;
    ++revision; busy = true; notify();
    try {
      await deleteLocalMedia('lobbyMusic');
      replace(null); status = t('默认大厅音乐'); refresh();
    } finally { busy = false; notify(); }
  },
};

export function LobbyMusicButton() {
  const [open, setOpen] = useState(false), [state, setState] = useState(music.snapshot), [error, setError] = useState('');
  const input = useRef(null);
  useEffect(() => {
    install(); const listener = value => setState(value);
    listeners.add(listener); listener(music.snapshot());
    return () => listeners.delete(listener);
  }, []);
  const action = async callback => {
    setError('');
    try { await callback(); } catch (failure) { setError(failure.message || t('操作失败')); }
  };
  return html`
    <${Button} variant="secondary" size="sm" square=${true} class="hub-music-btn" title=${t('大厅音乐')} aria-label=${t('大厅音乐')} onClick=${() => setOpen(true)}>
      <svg class="btn__icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M9 3v12.2a4 4 0 1 0 2 3.5V7.1l8-2v8.1a4 4 0 1 0 2 3.5V0z" /></svg>
    <//>
    <${Modal} class="lobby-music-panel" open=${open} title=${t('大厅音乐')} micro="LOBBY MUSIC" width="min(460px, calc(100vw - 32px))" onClose=${() => setOpen(false)} actions=${html`<${Button} variant="secondary" onClick=${() => setOpen(false)}>${t('关闭')}<//>`}>
      <div class="local-music">
        <p class="local-music__note">${t('导入喜欢的大厅音乐，每首最大 20MB。仅保存在当前浏览器；房间、战前信息和选人时继续播放，进入战场后淡出并切换游戏音乐。')}</p>
        <div class="local-music__track"><strong>${state.name || t('默认大厅音乐')}</strong>
          <small role="status">${state.status}${state.size ? ` · ${(state.size / 1024 / 1024).toFixed(1)} MB` : ''}</small></div>
        <input ref=${input} type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav,.aac,.flac,.webm" hidden onChange=${event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) action(() => music.upload(file));
        }} />
        <div class="local-music__actions">
          <${Button} disabled=${state.busy} onClick=${() => input.current?.click()}>${state.busy ? t('正在导入…') : t('导入音乐')}<//>
          <${Button} disabled=${!state.name || state.busy} onClick=${() => action(() => music.toggle())}>${state.playing ? t('暂停') : t('播放')}<//>
          <${Button} disabled=${!state.name || state.busy} variant="secondary" onClick=${() => action(() => music.reset())}>${t('恢复默认')}<//>
        </div>
        <small class="local-music__note">${t('音量和静音沿用游戏设置。刷新后保留；恢复默认会删除本地音乐，清理浏览器数据也会移除媒体资源。')}</small>
        ${error ? html`<p role="alert" class="local-music__error">${error}</p>` : null}
      </div>
    <//>`;
}
