import { t as trA } from '../../../shared/i18n.js';
// Player settings (BGM/SFX/voice volume, mute, damage numbers, render quality, the shortcut keys): a tiny observable
// store persisted in localStorage (`sp.pref.settings`), applied to the audio manager on every change, plus
// the settings modal — which also holds the language switch (ui/lang.js; kept apart in `sp.pref.lang`; under it a note
// while the current language's pack is a machine translation, `_meta.machineTranslated`) and the 快捷键
// section that rebinds the in-match shortcuts (the key map: ui/gameLogic/shortcuts.js; the community request
// 「快捷键可不可以自己设置」, the owner's decision of 2026-10-07).

import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon, MicroLabel } from './components.js';
import { createStore, useStore, loadPref, savePref, store } from '../store.js';
import { sanitizeSettings, HOTKEY_ACTIONS, DEFAULT_HOTKEYS, hotkeyLabel, rebindHotkey, isDefaultHotkeys, captureHotkey } from './gameLogic.js';
import { audio } from '../audio.js';
import { openGuide } from './guide.js';
import { openResourcePreload } from './resourcePreload.js';
import { detectFeatures } from './device.js';
import { skinsStore, setVoice } from './skins.js';
import { LangToggle, machineTranslationNote } from './lang.js';
import { t, tc, N_ } from '../../../shared/i18n.js';
import { errorCount, currentBattle, diagnosticsText } from '../diag.js';
import { copyText, copyQQGroup } from './clipboard.js';
import { TEXT_SIZES } from './gameLogic/settings.js';
import { FRAME_RATES } from '../frameRate.js';
import { ScreenFitSection } from './screenFit.js';
import { PwaInstallButton } from './pwaInstall.js';
import { AnnouncementButton } from './announcement.js';
import { catalog, loadCatalog, cosmeticPlugins, installedCount, personal, personalSet, pluginName, setPersonalPlugin } from '../content.js';
import { setUiPlugin, uiPluginEntries, uiPlugins } from './uiPlugins.js';
import { UI_LIMITS } from '../../../shared/plugins/ui.js';
import { toast, describeError } from './toasts.js';
import { pluginMicro } from './pluginTag.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Settings store: { bgm, sfx, voice, muted, damageNumbers, quality, keys }. */
export const settingsStore = createStore(sanitizeSettings(loadPref('settings', null)));

export function applyTextSize(value) {
  globalThis.document?.documentElement?.setAttribute('data-text', TEXT_SIZES.includes(value) ? value : 'sm');
}
applyTextSize(settingsStore.get().textSize);

settingsStore.subscribe((s) => {
  savePref('settings', sanitizeSettings(s));
  audio.setVolumes(s);
  applyTextSize(s.textSize);
});
audio.setVolumes(settingsStore.get());

/** @param {Partial<ReturnType<typeof sanitizeSettings>>} patch */
export function updateSettings(patch) {
  settingsStore.set(sanitizeSettings({ ...settingsStore.get(), ...patch }));
}

/** Preact hook: current settings. */
export const useSettings = () => useStore((s) => s, Object.is, settingsStore);

/**
 * The label of the key a rebindable shortcut has right now ('R', 'Space' …) — the HUD's key hints (shop bar, ready /
 * pause, underframe). Read at render: the game screen re-renders when the settings dialog closes.
 * @param {'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready'} action
 */
export const hotkeyLabelOf = (action) => hotkeyLabel(settingsStore.get().keys?.[action]);

function Slider({ label, micro, value, onInput, icon }) {
  const pct = Math.round(value * 100);
  return html`<label class="set-row">
    <span class="set-row__label"><${Icon} name=${icon} />${label}<${MicroLabel}>${micro}<//></span>
    <input class="set-range" type="range" min="0" max="100" step="5" value=${pct} style=${`--pct:${pct}%`}
      onInput=${(e) => onInput(Number(e.currentTarget.value) / 100)} />
    <span class="set-row__val num">${pct}</span>
  </label>`;
}

function Toggle({ label, micro, value, onChange }) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <button type="button" class=${`set-toggle${value ? ' is-on' : ''}`} role="switch" aria-checked=${value ? 'true' : 'false'}
      onClick=${() => onChange(!value)}><i></i><span>${value ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>
  </div>`;
}

const QUALITY = [['high', N_('高')], ['medium', N_('中')], ['low', N_('低')]];
/** The rebindable shortcuts' names (msgids), by action. */
const HOTKEY_NAMES = { refresh: N_('刷新商店'), freeze: N_('冻结 / 解冻商店'), levelUp: N_('升级调度中心'), retreat: N_('撤退选中干员'),
  sell: N_('出售选中干员'), ready: N_('准备就绪 / 暂停（独立模拟）') };

/**
 * 快捷键: each shortcut with its key. Click its key (or Enter / Space on it) and press the new one: Esc cancels (the
 * dialog stays open), Tab leaves, a key held with Ctrl / Alt / ⌘ or one the interface keeps is refused, a key another
 * shortcut has is swapped — the line under the list says what happened; 恢复默认 restores the keys of 0.1.4. Esc
 * (cancel / close) is fixed. On a touch-only device the section says the keys need a keyboard and folds the list (an
 * attached keyboard still uses it).
 * @param {{ keys: Record<string, string>, touchUi: boolean }} props
 */
function HotkeySection({ keys, touchUi }) {
  const [waiting, setWaiting] = useState(null); // the action waiting for its new key
  const [note, setNote] = useState(null);       // { text, warn }: the result line
  // a layout effect: the key listener is on as soon as the key shows that it waits (an Esc right after the click must
  // end the wait, never reach the dialog's own Esc)
  useLayoutEffect(() => {
    if (!waiting) return undefined;
    const name = t(HOTKEY_NAMES[waiting]);
    const onKey = (e) => {
      const r = captureHotkey(e);
      if (r.kind === 'leave') { setWaiting(null); return; } // Tab: the focus moves on
      // ahead of the dialog's own Esc (it stays open), a focused button's Enter / Space and every other key handler
      e.preventDefault();
      e.stopImmediatePropagation();
      if (r.kind === 'ignore') return;
      const cur = settingsStore.get().keys;
      if (r.kind === 'cancel') {
        setWaiting(null);
        setNote({ text: t('已取消，「{action}」仍是 {key}', { action: name, key: hotkeyLabel(cur[waiting]) }) });
        return;
      }
      if (r.kind === 'refuse') {
        setNote({ warn: true, text: r.reason === 'modifier' ? t('快捷键只能是单个按键，不能搭配 Ctrl、Alt 或 ⌘')
          : t('{key} 不能设为快捷键：Esc、Tab、Enter、方向键和功能键留给界面使用', { key: r.name }) });
        return;
      }
      const res = rebindHotkey(cur, waiting, r.code);
      updateSettings({ keys: res.keys });
      setWaiting(null);
      const key = hotkeyLabel(r.code);
      setNote({ text: res.swapped
        ? t('「{action}」已改为 {key}；「{other}」原来用 {key}，已换成 {old}', { action: name, key, other: t(HOTKEY_NAMES[res.swapped]), old: hotkeyLabel(res.keys[res.swapped]) })
        : t('「{action}」已改为 {key}', { action: name, key }) });
    };
    // a press anywhere but the waiting key ends the wait (another key starts its own)
    const onDown = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.set-key.is-waiting')) setWaiting(null); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [waiting]);

  const status = note ? note.text : waiting ? t('请按下「{action}」的新按键（Esc 取消）', { action: t(HOTKEY_NAMES[waiting]) }) : '';
  const list = html`<ul class="set-keys__list">
    ${HOTKEY_ACTIONS.map((a) => {
      const on = waiting === a;
      const label = hotkeyLabel(keys?.[a]);
      return html`<li key=${a} class="set-keys__row">
        <span class="set-keys__name">${t(HOTKEY_NAMES[a])}</span>
        <button type="button" class=${cx('set-key', on && 'is-waiting')} data-action=${a} aria-pressed=${on ? 'true' : 'false'}
          aria-label=${t('更改「{action}」的快捷键（当前：{key}）', { action: t(HOTKEY_NAMES[a]), key: label })}
          onClick=${() => { setNote(null); setWaiting((w) => (w === a ? null : a)); }}>
          ${on ? html`<span class="set-key__wait">${t('按下新按键…')}</span>` : html`<kbd>${label}</kbd>`}
        </button>
      </li>`;
    })}
    <li class="set-keys__row is-fixed">
      <span class="set-keys__name">${t('取消 / 关闭')}</span>
      <span class="set-key is-fixed"><kbd>Esc</kbd><small>${t('不可更改')}</small></span>
    </li>
  </ul>
  <p class=${cx('set-keys__note', note?.warn && 'is-warn')} role="status" aria-live="polite">${status}</p>`;
  return html`<section class="set-keys" aria-labelledby="set-keys-title">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-keys-title">${t('快捷键')}<${MicroLabel}>HOTKEYS<//></span>
      <${Button} variant="ghost" size="sm" icon="refresh" class="set-keys__reset" disabled=${isDefaultHotkeys(keys)}
        onClick=${() => { setWaiting(null); updateSettings({ keys: DEFAULT_HOTKEYS }); setNote({ text: t('已恢复默认快捷键') }); }}>${t('恢复默认')}<//>
    </div>
    ${touchUi ? html`<p class="set-hint">${t('快捷键需要实体键盘；触屏设备连接键盘后可用')}</p>
      <details class="set-keys__more"><summary>${t('查看 / 更改快捷键')}</summary>${list}</details>` : list}
  </section>`;
}

/** Where a report goes: this project's issue tracker (shown as text the player can select; a link may open nothing). */
export const ISSUES_URL = 'https://github.com/Emiraen/Stronghold-Protocol_Emi/issues';

/**
 * 问题反馈: copy the diagnostics of this page (diag.js) for a GitHub issue — the errors recorded since the page opened,
 * this browser and device, where the player is, and, switched on by default while a battle is on screen, that battle's
 * spec (the dev tools replay it). Player names, the room code and the token are replaced; nothing is uploaded. Laid out
 * like 快捷键 above it (a head with its button, a hint, the result line); the battle switch is the settings' Toggle, and
 * when the clipboard refuses (some in-app browsers), the report is shown selected in a box styled like 干员调配's 导出.
 */
/** The result line of 复制诊断信息, by outcome (msgids: translated when shown, so a language switch reaches it). */
const DIAG_NOTES = { copied: N_('已复制诊断信息，可以粘贴到 GitHub issue 中'), refused: N_('无法写入剪贴板，请手动复制下面的内容') };

function DiagSection() {
  const [attach, setAttach] = useState(true);
  const [note, setNote] = useState(null);       // 'copied' | 'refused' | null: the result line
  const [manual, setManual] = useState(null);   // the report, when the clipboard refused it
  const boxRef = useRef(null);
  // the box opens selected for a manual copy, scrolled to its first line (select() leaves it at the end)
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (manual && el) { el.focus(); el.select(); el.scrollTop = 0; }
  }, [manual]);
  const n = errorCount();
  const battle = currentBattle();
  const copy = async () => {
    const text = diagnosticsText({ state: store.get(), settings: settingsStore.get(), attachBattle: attach && !!battle });
    const ok = await copyText(text);
    setManual(ok ? null : text);
    setNote(ok ? 'copied' : 'refused');
  };
  return html`<section class="set-diag" aria-labelledby="set-diag-title">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-diag-title">${t('问题反馈')}<${MicroLabel}>DIAGNOSTICS<//></span>
      <${Button} variant="ghost" size="sm" icon="copy" class="set-diag__copy" data-testid="diag-copy" onClick=${copy}>${t('复制诊断信息')}<//>
    </div>
    <p class="set-hint">${t('遇到问题时，复制诊断信息并粘贴到 GitHub issue 中，开发者就能看到出错时的情况。诊断信息只在本机生成，不会自动上传；玩家名和房间号会被替换。')}</p>
    <div class="set-diag__meta">
      <span class="set-diag__stat">${t('已记录的错误')}<b class=${cx('set-diag__count num', n > 0 && 'is-warn')} data-testid="diag-count">${n}</b></span>
      <span class="set-diag__url">${ISSUES_URL.replace(/^https:\/\//, '')}</span>
    </div>
    ${battle ? html`<${Toggle} label=${t('附上本场战斗')} micro="BATTLE DATA" value=${attach} onChange=${setAttach} />
      <p class="set-hint set-diag__battle-hint">${t('开发者可以用附上的战斗数据重现这场战斗。')}</p>` : null}
    ${note ? html`<p class=${cx('set-keys__note', note === 'refused' && 'is-warn')} role="status" aria-live="polite">${t(DIAG_NOTES[note])}</p>` : null}
    ${manual ? html`<textarea ref=${boxRef} class="set-diag__text" data-testid="diag-text" spellcheck=${false} readOnly
      aria-label=${t('诊断信息')} value=${manual}></textarea>` : null}
  </section>`;
}

/**
 * 外观插件 (see the header): the server's cosmetic plugins of scope `personal`, each with its switch; nothing when there
 * is none. The catalogue is fetched again when the section opens (a plugin dropped in meanwhile shows) — on a server that
 * has plugins only (content.js installedCount: a server without any is never asked for it).
 */
function CosmeticSection() {
  const cat = useStore((s) => s, Object.is, catalog);
  const ids = useStore((s) => s.ids, Object.is, personal);
  const installed = useStore(installedCount);
  useEffect(() => { if (installed) loadCatalog({ force: true }); }, [installed]);
  const list = installed ? cosmeticPlugins(cat.plugins, 'personal') : [];
  if (!list.length) return null;
  const set = personalSet(ids, list.filter((p) => typeof p.vs === 'string'));
  const applied = new Set(set.order);
  const auto = new Set(set.auto);
  const flip = (id, on) => { const r = setPersonalPlugin(id, on); if ('error' in r) toast(describeError(r.error), 'warn'); };
  return html`<section class="set-plugins" aria-labelledby="set-plugins-title" data-testid="personal-plugins">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-plugins-title">${t('外观插件')}<${MicroLabel}>COSMETIC PLUGINS<//></span>
    </div>
    <p class="set-hint">${t('只改变你自己看到的画面和声音，不影响其他博士，也不影响战斗；插件为非官方制作。')}</p>
    ${list.map((p) => {
      // on: applied (chosen, or 「自动」: another one needs it) — or chosen but left out now (a conflict): switch it off
      const skipped = set.skipped.includes(p.id);
      const on = applied.has(p.id) || skipped;
      const isAuto = auto.has(p.id);
      return html`<div key=${p.id} class="set-row" data-plugin=${p.id}>
        <span class="set-row__label">${pluginName(p)}${isAuto ? html` <span class="plugrow__badge">${t('自动')}</span>` : null}<${MicroLabel}>${pluginMicro(p)}<//>
          ${skipped ? html`<span class="set-hint is-warn">${t('与其他已开启的插件冲突或缺少所需插件，没有生效')}</span>` : null}</span>
        <button type="button" class=${`set-toggle${on ? ' is-on' : ''}`} role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${pluginName(p)}
          disabled=${isAuto && !ids.includes(p.id)} onClick=${() => flip(p.id, !on)}><i></i><span>${on ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>
      </div>`;
    })}
  </section>`;
}

/**
 * 界面插件 (DESIGN §32.8): each loaded ui plugin of scope `personal`, switched on in this browser only
 * (`sp.pref.ui-plugins`). It cannot play the match and it does not change what anyone else sees.
 */
function UiPluginSection() {
  const cat = useStore((s) => s, Object.is, catalog);
  const ids = useStore((s) => s.ids, Object.is, uiPlugins);
  const installed = useStore(installedCount);
  useEffect(() => { if (installed) loadCatalog({ force: true }); }, [installed]);
  const list = installed ? uiPluginEntries(cat.plugins) : [];
  if (!installed || (cat.status !== 'ready' && !list.length && !ids.length)) return null;
  if (!list.length && !ids.length) return null;
  const onIds = new Set(ids);
  const flip = (id, on) => {
    const r = setUiPlugin(id, on);
    if (!r.error) return;
    toast(r.error === 'PLUGIN_LIMIT' ? t('最多同时开启 {n} 个界面插件', { n: UI_LIMITS.maxPlugins }) : describeError(r.error), 'warn');
  };
  return html`<section class="set-plugins" aria-labelledby="set-ui-plugins-title" data-testid="ui-plugins">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-ui-plugins-title">${t('界面插件')}<${MicroLabel}>UI PLUGINS<//></span>
    </div>
    <p class="set-hint">${t('只改变这个浏览器里的界面，不能替你操作对局，也不影响其他博士；插件为非官方制作。')}</p>
    ${!list.length ? html`<p class="set-hint">${t('本服务器没有可开启的界面插件')}</p>` : list.map((p) => {
      const on = onIds.has(p.id);
      return html`<div key=${p.id} class="set-row" data-plugin=${p.id}>
        <span class="set-row__label">${pluginName(p)}<${MicroLabel}>${pluginMicro(p)}<//></span>
        <button type="button" class=${`set-toggle${on ? ' is-on' : ''}`} role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${pluginName(p)}
          onClick=${() => flip(p.id, !on)}><i></i><span>${on ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>
      </div>`;
    })}
  </section>`;
}

/**
 * Settings modal.
 * @param {{ open: boolean, onClose: Function }} props
 */
export function SettingsModal({ open, onClose }) {
  const s = useSettings();
  const presentation = useStore((v) => v, Object.is, skinsStore);
  const voice = presentation.voice;
  const [tested, setTested] = useState(false);
  const [touchUi] = useState(() => detectFeatures().coarse && !detectFeatures().fine);
  const mtNote = machineTranslationNote(); // a pack marked as machine translation says so under the switch
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('设置')} micro="SETTINGS" width="7.4rem" class="settings-modal east-settings" utility=${true}
    actions=${html`<${Button} variant="secondary" icon="shield" class="set-resource-preload" onClick=${() => { onClose(); openResourcePreload(); }}>${t('资源预载')}<//>
      <${Button} variant="secondary" size="sm" icon="copy" class="set-qq-group" title="QQ群：964356269" onClick=${copyQQGroup}>${t('加群')}<//>
      <${AnnouncementButton} />
      <${PwaInstallButton} />
      <${Button} variant="secondary" icon="book" class="set-guide" onClick=${() => openGuide(0)}>${t('玩法说明')}<//>
      <${Button} variant="primary" icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">${t('语言')}<${MicroLabel}>LANGUAGE<//></span>
        <${LangToggle} class="set-lang" />
      </div>
      ${mtNote ? html`<p class="set-hint set-lang-note" data-testid="lang-mt-note">${mtNote}</p>` : null}
      <${Slider} label=${t('背景音乐')} micro="BGM" icon="play" value=${s.bgm} onInput=${(v) => updateSettings({ bgm: v })} />
      <${Slider} label=${t('音效')} micro="SFX" icon="signal" value=${s.sfx}
        onInput=${(v) => { updateSettings({ sfx: v }); if (!tested) { setTested(true); setTimeout(() => setTested(false), 400); audio.sfx('click'); } }} />
      <fieldset disabled=${!presentation.profileReady} style="border:0;margin:0;padding:0;min-width:0">
        <${Toggle} label=${trA("干员语音")} micro="VOICE" value=${voice.enabled} onChange=${(enabled) => setVoice({ enabled })} />
        <${Slider} label=${trA("语音音量")} micro="VOICE VOLUME" icon="play" value=${voice.volume} onInput=${(volume) => setVoice({ volume })} />
        <div class="set-row"><span class="set-row__label">${trA("语音语言")}<${MicroLabel}>VOICE LANGUAGE<//></span>
          <div class="set-seg" role="radiogroup" aria-label=${trA("语音语言")}>
            ${[['jp', trA("日语")], ['cn', trA("中文")], ['en', '英语'], ['kr', '韩语']].map(([lang, label]) => html`<button key=${lang} type="button" role="radio"
              aria-checked=${String(voice.lang === lang)} class=${voice.lang === lang ? 'is-on' : ''} onClick=${() => setVoice({ lang })}>${label}</button>`)}
          </div>
        </div>
        <p class="set-hint">${!presentation.profileReady ? trA("等待服务器档案") : presentation.sync === 'error' ? trA("保存失败，已恢复服务器配置") : presentation.sync === 'synced' ? trA("语音设置已同步服务器档案") : trA("正在保存语音设置…")}</p>
      </fieldset>
      <${Toggle} label=${t('静音')} micro="MUTE" value=${s.muted} onChange=${(v) => updateSettings({ muted: v })} />
      <${Toggle} label=${t('显示伤害数字')} micro="DAMAGE NUMBERS" value=${s.damageNumbers} onChange=${(v) => updateSettings({ damageNumbers: v })} />
      <${Toggle} label=${t('官方伤害数字')} micro="OFFICIAL NUMBERS" value=${s.officialDamageNumbers} onChange=${(v) => updateSettings({ officialDamageNumbers: v })} />
      <${Toggle} label="优先本土配音" micro="NATIVE VOICE" value=${s.voiceNative} onChange=${v => updateSettings({ voiceNative: v })} />
      <${Toggle} label="秘术师能量" micro="STORED ENERGY" value=${s.energyCount} onChange=${v => updateSettings({ energyCount: v })} />
      <${ScreenFitSection} />
      <${Toggle} label=${t('弹药数量')} micro="AMMO COUNT" value=${s.ammoCount} onChange=${(v) => updateSettings({ ammoCount: v })} />
      <div class="set-row">
        <span class="set-row__label">官方特效<${MicroLabel}>BATTLE EFFECTS<//></span>
        <div class="set-seg" role="radiogroup" aria-label="官方特效">
          ${[['auto', '自动'], ['off', '关闭'], ['lite', '精简'], ['full', '完整']].map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${String(s.officialFx === id)} class=${s.officialFx === id ? 'is-on' : ''} onClick=${() => updateSettings({ officialFx: id })}>${label}</button>`)}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">${t('文字大小')}<${MicroLabel}>TEXT SIZE<//></span>
        <div class="set-seg" role="radiogroup" aria-label=${t('文字大小')}>
          ${TEXT_SIZES.map((id, index) => html`<button key=${id} type="button" role="radio" aria-checked=${String(s.textSize === id)} class=${s.textSize === id ? 'is-on' : ''} onClick=${() => updateSettings({ textSize: id })}>${t(['标准', '中', '大', '特大'][index])}</button>`)}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">${t('帧率上限')}<${MicroLabel}>FRAME RATE<//></span>
        <div class="set-seg" role="radiogroup" aria-label=${t('帧率上限')}>
          ${FRAME_RATES.map((limit) => html`<button key=${limit} type="button" role="radio" aria-checked=${String(s.fpsLimit === limit)} class=${s.fpsLimit === limit ? 'is-on' : ''} onClick=${() => updateSettings({ fpsLimit: limit })}>${limit ? `${limit} FPS` : t('不限')}</button>`)}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">${t('画面质量')}<${MicroLabel}>QUALITY<//></span>
        <div class="set-seg" role="radiogroup">
          ${QUALITY.map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${s.quality === id ? 'true' : 'false'}
            class=${s.quality === id ? 'is-on' : ''} onClick=${() => updateSettings({ quality: id })}>${t(label)}</button>`)}
        </div>
      </div>
      <${HotkeySection} keys=${s.keys} touchUi=${touchUi} />
      ${open ? html`<${CosmeticSection} /><${UiPluginSection} />` : null}
      ${open ? html`<${DiagSection} />` : null}
      <p class="set-hint">${touchUi ? t('触屏操作：点击单位选中（撤退 / 出售）· 长按单位或卡牌查看详情 · 拖动部署后滑动选择朝向') : t('右键查看详情')}</p>
    </div>
  <//>`;
}
