import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Fragment, Modal, Button, Icon, ProgressBar, MicroLabel, confirmDialog } from './components.js';
import { resourceCache } from '../resourceCache.js';
import { useStore, loadPref, savePref } from '../store.js';
import { copyQQGroup } from './clipboard.js';
import { skinsStore } from './skins.js';
import { t } from '../../../shared/i18n.js';

let menu = { open: false, resume: null };
const listeners = new Set();
const publish = () => { for (const fn of listeners) fn({ ...menu }); };
export function openResourcePreload(resume = null) {
  menu = { open: true, resume: resume || menu.resume }; publish(); void resourceCache.ensureReady();
}
function close() { menu = { open: false, resume: null }; publish(); }
const size = n => `${((n || 0) / 1024 / 1024).toFixed(1)} MiB`;

function ResourceGroup({ group, state, checking, options }) {
  const required = group === 'required', voice = group === 'voice';
  const done = state.total > 0 && state.done === state.total;
  const percent = state.bytes ? Math.min(100, state.downloadedBytes / state.bytes * 100) : 0;
  return html`<section class=${`resource-preload__group resource-tier resource-preload__group--${group}`}>
    <header class="resource-tier__head"><div><h3><${Icon} name=${required ? 'shield' : voice ? 'mic' : 'image'} />${t(required ? '画面与必要资源' : voice ? '干员语音' : '个性化资源')}</h3>
      <${MicroLabel}>${required ? 'ESSENTIAL ASSETS' : voice ? 'OPERATOR VOICES' : 'PERSONALIZATION'}<//></div><span class="resource-tier__badge">${t('主动预载')}</span></header>
    <p>${t(required ? '低清原皮立绘、默认模型、原棋盘支持资源、表情、玩法说明与音效。点击下方按钮后从 Win7 预载；未预载时仅按需获取当前画面使用的必要资源。' : voice ? '语音保存在本机，选择下方语言后下载。已有语音会保留，缺少时可以继续补齐。' : '皮肤与精英二立绘、官方地图场景、官方战斗特效、额外皮肤模型、模组图标与背景音乐。仅点击预载后从 Win7 下载；未预载的皮肤立绘使用原皮，地图使用原棋盘，特效使用原演算效果。')}</p>
    <div class="resource-tier__summary"><b>${t(checking ? '正在检查' : done ? '已缓存完整' : state.running ? state.paused ? '正在暂停…' : '正在下载…' : state.paused ? '已暂停' : state.done ? '等待继续' : '尚未下载')}</b><span class="num">${percent.toFixed(1)}%</span></div>
    <${ProgressBar} value=${state.downloadedBytes} max=${state.bytes || 1} tone=${required ? 'mint' : 'amber'} />
    <div class="resource-preload__count"><span>${state.done} / ${state.total} ${t('项')}</span><span>${size(state.downloadedBytes)} / ${size(state.bytes)}</span></div>
    <div class="resource-tier__actions">${state.running
      ? html`<${Button} variant="secondary" size="sm" icon="pause" disabled=${state.paused} onClick=${() => resourceCache.pause(group)}>${t(state.paused ? '正在暂停' : '暂停下载')}<//>`
      : html`<${Button} variant=${required ? 'primary' : 'secondary'} size="sm" icon=${done ? 'check' : 'download'} disabled=${checking || done || !state.total} onClick=${() => resourceCache.download(group, options)}>${t(done ? '下载完成' : state.error ? '重试下载' : state.done ? '继续下载' : '下载资源')}<//>`}</div>
    ${state.error ? html`<p class="resource-preload__error" role="alert">${state.error}</p>` : null}
  </section>`;
}

export function ResourcePreloadHost() {
  const entered = useStore(s => s.session.entered);
  const voice = useStore(s => s.voice, Object.is, skinsStore);
  const [view, setView] = useState(() => ({ ...menu }));
  const [state, setState] = useState(() => resourceCache.getState());
  const [continuing, setContinuing] = useState(false);
  const [voiceLang, setVoiceLang] = useState(() => loadPref('resourceVoiceLang', voice.lang || 'cn'));
  const [allVoices, setAllVoices] = useState(() => loadPref('resourceAllVoices', false) === true);
  const [storage, setStorage] = useState(null);
  const [note, setNote] = useState('');
  const fileInput = useRef(null);
  const downloading = state.required.running || state.optional.running || state.voice.running;
  const packBusy = !!state.pack.running || !!state.clearing;
  const packDisabled = state.checking || packBusy || downloading;
  const voiceOptions = allVoices ? {} : { voiceLang };
  const voiceState = resourceCache.selectionState('voice', voiceOptions);
  useLayoutEffect(() => {
    listeners.add(setView); const off = resourceCache.subscribe(setState);
    setView({ ...menu }); setState(resourceCache.getState());
    return () => { listeners.delete(setView); off(); };
  }, []);
  useEffect(() => {
    let active = true;
    if (view.open) globalThis.navigator?.storage?.estimate?.().then(v => { if (active) setStorage(v); }).catch(() => {});
    return () => { active = false; };
  }, [view.open, downloading, state.clearing]);
  const exportResources = async () => {
    const blob = await resourceCache.exportPack(); if (!blob) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'Stronghold-resources.sprpack'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const importResources = async event => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (file) await resourceCache.importPack(file);
  };
  const clearOptional = async () => {
    if (!await confirmDialog({ title: t('清理个性化资源'), text: t('清理本机缓存的皮肤与精英二立绘、官方地图、官方特效、音乐和语音。设置、档案与对局记录会保留；未预载的立绘、地图和特效使用原有表现。') })) return;
    const result = await resourceCache.clearOptional();
    setNote(result?.busy ? t('资源正在使用中，请等待当前处理完成后重试') : result?.error || t('已清理个性化资源与语音缓存'));
  };
  const proceed = async () => {
    setContinuing(true);
    try { if (!await resourceCache.ensureSessionReady()) return; const resume = menu.resume; close(); if (resume) await resume(); }
    finally { setContinuing(false); }
  };
  return html`<${Fragment}>
    ${!entered ? html`<div class="resource-preload__entries"><${Button} class="resource-preload__qq-entry" size="sm" icon="copy" title="QQ群：964356269" onClick=${copyQQGroup}>${t('加群')}<//><${Button} class="resource-preload__entry" size="sm" icon="shield" onClick=${() => openResourcePreload()}>${t('资源预载')}<//></div>` : null}
    ${entered && state.missing && !view.open ? html`<${Button} class="resource-preload__entry resource-preload__missing" size="sm" icon="shield" onClick=${() => openResourcePreload()}>${t('本地资源缺失 · 点击补齐')}<//>` : null}
    <${Modal} open=${view.open} class="resource-preload resource-modal" width="min(11rem, 94vw)" micro="RESOURCE MANAGER" title=${t('预载资源管理')} utility=${true} onClose=${close}
      actions=${html`${downloading ? html`<${Button} variant="secondary" icon="pause" onClick=${() => resourceCache.pause()}>${t('暂停全部')}<//>` : null}${view.resume ? html`<${Button} variant="primary" iconRight="chevrons" loading=${continuing} disabled=${continuing} onClick=${proceed}>${t('进入游戏')}<//>` : null}<${Button} variant="secondary" onClick=${close}>${t('关闭')}<//>`}>
      <div class="resource-manager">
        <p class="resource-manager__intro">${t('各类资源均需手动开始预载，从 Win7 下载并保存在此浏览器。关闭面板后已开始的下载会继续；暂停后可以从已完成的位置继续。')}</p>
        ${state.missing ? html`<p class="resource-preload__error" role="alert">${state.missing}</p>` : null}
        <div class="resource-preload__columns resource-manager__tiers"><${ResourceGroup} group="required" state=${state.required} checking=${state.checking || packBusy} /><${ResourceGroup} group="optional" state=${state.optional} checking=${state.checking || packBusy} /></div>
        <section class="resource-manager__voice"><div class="resource-manager__voice-head"><h3>${t('预载语音语言')}</h3><div class="resource-voice-tabs" role="group" aria-label=${t('预载语音语言')}>
          ${['cn', 'jp'].map(lang => html`<button type="button" aria-pressed=${voiceLang === lang} disabled=${state.voice.running || packBusy} onClick=${() => { setVoiceLang(lang); savePref('resourceVoiceLang', lang); }}>${lang === 'cn' ? t('中文') : '日本語'}</button>`)}
        </div></div><label class="resource-choice"><input type="checkbox" checked=${allVoices} disabled=${state.voice.running || packBusy} onChange=${e => { setAllVoices(e.currentTarget.checked); savePref('resourceAllVoices', e.currentTarget.checked); }} />${t('同时预载全部语音语言')}</label></section>
        <${ResourceGroup} group="voice" state=${voiceState} options=${voiceOptions} checking=${state.checking || packBusy} />
        <section class="resource-archive resource-preload__pack"><div class="resource-archive__toolbar"><h3>${t('资源包备份')}</h3><div class="res-actions">
          <${Button} variant="secondary" size="sm" disabled=${packDisabled} loading=${state.pack.running === 'import'} onClick=${() => fileInput.current?.click()}>${t('导入资源包')}<//>
          <${Button} variant="secondary" size="sm" disabled=${packDisabled || !(state.required.done + state.optional.done + state.voice.done)} loading=${state.pack.running === 'export'} onClick=${exportResources}>${t('导出资源包')}<//>
          <input ref=${fileInput} type="file" accept=".sprpack,application/octet-stream" hidden=${true} onChange=${importResources} />
        </div></div><p class="resource-preload__note">${t('导出完整缓存的资源以便备份或转移；导入时会校验内容并保留已有缓存。')}</p>
        ${state.pack.running ? html`<p role="status">${t(state.pack.running === 'import' ? '正在导入并校验资源' : '正在校验并导出资源')}… ${state.pack.done} / ${state.pack.total}</p>` : null}
        ${state.pack.note ? html`<p role="status">${state.pack.note}</p>` : null}${state.pack.error ? html`<p class="resource-preload__error" role="alert">${state.pack.error}</p>` : null}</section>
        <section class="resource-storage"><h3>${t('本机存储')}</h3><p>${storage ? t('已使用 {used} / 可用额度 {quota}', { used: size(storage.usage), quota: size(storage.quota) }) : t('资源缓存于当前浏览器')}</p>
          <p class="resource-preload__note">${t(state.storageProtection === 'persisted' ? '已启用持久存储保护。' : '可以导出资源包备份；清除网站数据或更换网址会失去本机缓存。')}</p>
          <${Button} variant="secondary" size="sm" disabled=${packDisabled} onClick=${clearOptional}>${t(state.clearing ? '正在清理' : '清理个性化资源')}<//>
          ${note ? html`<p role="status">${note}</p>` : null}
        </section>
        ${state.error ? html`<p class="resource-preload__error" role="alert">${state.error}</p>` : null}
      </div>
    <//>
  <//>`;
}
