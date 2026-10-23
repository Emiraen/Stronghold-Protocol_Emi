import { t as trA } from '../../../shared/i18n.js';
// Title screen: remembered account name, password login, registration and legacy password reset.
// Only a successful authenticated welcome enters the game. Reconnects use the tab's auth ticket.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, APP_VERSION, EMI_BUILD } from '../../../shared/constants.js';
import { html, Modal, Button, Icon, MicroLabel, TextField, PingPill } from '../ui/components.js';
import { GuideButton } from '../ui/guide.js';
import { SettingsModal } from '../ui/settings.js';
import { openStats } from './stats.js';
import { toast } from '../ui/toasts.js';
import { net, identity, NetError } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, detectFeatures } from '../ui/device.js';
import { resourceCache } from '../resourceCache.js';
import { PwaInstallButton } from '../ui/pwaInstall.js';
import { AnnouncementButton } from '../ui/announcement.js';
import { GIcon } from '../ui/gameComponents.js';
import { openResourcePreload } from '../ui/resourcePreload.js';
import { useResourceUrl } from '../ui/cachedImage.js';

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_LEN UTF-16 code units — the
 * protocol's `hello.name` limit — without splitting a surrogate pair.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN);
    // Don't leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;

/**
 * Authenticate before entering the game shell (title → lobby).
 * @param {string} rawName
 * @returns {Promise<boolean>} 昵称无效或资源清单、本地存储尚未就绪时返回 false
 */
export async function enterSession(rawName, auth = null, resume = null, rememberPassword = false) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  if (!await resourceCache.ensureSessionReady()) {
    // A form may resume its pending submission after the resource dialog is closed.
    openResourcePreload(resume || (() => identity.getAuth(name) ? enterSession(name).catch(() => false) : false));
    return false;
  }
  if (serversState.get().switching) return false;
  if (!auth && !identity.getAuth(name)) throw new NetError('AUTH_REQUIRED', '请输入账户密码');
  if (net.name && net.name !== name) net.closeForServerSwitch();
  identity.saveName(name);
  if (!net.url || net.status === 'closed') {
    if (!await prepareServerConnection()) return false;
  }
  try {
    await net.login(name, auth);
    if (auth && typeof auth.password === 'string') {
      if (rememberPassword) identity.saveRememberedLogin(name, auth.action === 'reset' ? auth.newPassword : auth.password);
      else identity.clearRememberedLogin();
    }
  }
  finally {
    if (auth) for (const key of ['password', 'newPassword', 'confirmPassword']) delete auth[key];
  }
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  return true;
}

// data/assets.json `ui` keys are 'group/key' (docs/ASSETS.md).
const BACKDROP_KEYS = ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02'];
const RIDGE_KEYS = ['titleRidges', 'entry/bg_mountains_tiled'];

/**
 * Find a UI image URL in data/assets.json (tolerant of a few plausible shapes).
 * @param {any} assets
 * @param {string[]} names
 * @returns {string|null}
 */
export function findUiAsset(assets, names) {
  if (!assets || typeof assets !== 'object') return null;
  const asUrl = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url || v.path || v.src || null;
    return null;
  };
  const ui = assets.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    for (const n of names) {
      const u = asUrl(ui[n]);
      if (u) return u;
    }
  }
  const lists = [Array.isArray(ui) ? ui : null, Array.isArray(assets.files) ? assets.files : null].filter(Boolean);
  for (const list of lists) {
    for (const n of names) {
      const hit = list.map(asUrl).find((u) => typeof u === 'string' && u.includes('/ui/') && u.toLowerCase().split('/').pop().startsWith(n.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

// Dot-matrix watchtower emblem (13×14 bitmap; dots grow toward the base for depth).
const EMBLEM = [
  'XXX..XXX..XXX',
  'XXX..XXX..XXX',
  'XXXXXXXXXXXXX',
  '.XXXXXXXXXXX.',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXX.XXXX..',
  '..XXXX.XXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX',
  'XXXXXXXXXXXXX',
];

export function Emblem() {
  const dots = useMemo(() => {
    const out = [];
    EMBLEM.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== 'X') return;
        const rad = 0.2 + (r / (EMBLEM.length - 1)) * 0.2;
        const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
        out.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent, d: (r * 13 + c) % 7 });
      });
    });
    return out;
  }, []);
  return html`<div class="emblem" aria-hidden="true">
    <span class="emblem__bracket emblem__bracket--l"></span>
    <svg class="emblem__svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map((d, i) => html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : `d${d.d}`} />`)}
    </svg>
    <span class="emblem__bracket emblem__bracket--r"></span>
  </div>`;
}

function Ridges() {
  return html`<svg class="title-bg__ridges" viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#16231f" /><stop offset="1" stop-color="#0a0e0d" />
      </linearGradient>
      <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0f1714" /><stop offset=".6" stop-color="#080b0a" />
      </linearGradient>
      <linearGradient id="ridge-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17f9b7" stop-opacity="0" />
        <stop offset=".3" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset=".7" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset="1" stop-color="#17f9b7" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="ridge ridge--far" fill="url(#ridge-far)" stroke="url(#ridge-edge)"
      d="M0 420V250l120-40 90 30 90-70 60 20 80-70 80 55 80-25 90 70 90-20 80 50 100-15 90 25 90-55 90-55 70-55 70 45 80-20 90 65 80-20 100 55 100-20 100 40v180z" />
    <path class="ridge ridge--near" fill="url(#ridge-near)" stroke="url(#ridge-edge)"
      d="M0 420V322l160-32 100 20 120-50 90 40 130-20 120 50 140-30 140 35 120-35 140 20 140-50 120 30 120-20 120 40 160-20v147z" />
  </svg>`;
}

const STATUS_TEXT = {
  idle: '准备连接', connecting: '正在连接服务器', connected: '已连接服务器', handshaking: '正在验证身份',
  online: '已连接服务器', reconnecting: '连接中断，正在重连', closed: '连接已关闭',
};

/** Title screen component. */
import { LangToggle } from '../ui/lang.js';
import { serversState, loadServers, switchServer, prepareServerConnection, retryServerConnection } from '../servers.js';

const LOAD_LABELS = { idle: '空闲', normal: '一般', busy: '繁忙', unknown: '状态未知' };
function ServerPicker({ name, disabled = false }) {
  const state = useStore((s) => s, undefined, serversState);
  const conn = useStore((s) => s.connection, shallowEqual);
  const connecting = conn.status === 'connecting' || conn.status === 'handshaking';
  const [retryReady, setRetryReady] = useState(false);
  useEffect(() => {
    setRetryReady(false);
    if (!connecting) return;
    const timer = setTimeout(() => setRetryReady(true), 1000);
    return () => clearTimeout(timer);
  }, [connecting]);
  const refresh = () => {
    // 手机原生选择面板打开时不更新 option 文案，避免列表刷新打断选择。
    if (!document.hidden && document.activeElement?.dataset.testid !== 'server-select') void loadServers();
  };
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);
  const retry = async () => {
    try { await retryServerConnection(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const choose = async (event) => {
    const id = event.currentTarget.value;
    try { await switchServer(id, { name: sanitizeName(name) }); }
    catch (err) { toast(err.message, 'error'); }
  };
  return html`<div class="title-server">
    <select aria-label="选择服务器" data-testid="server-select" value=${state.directory?.current || ''}
      disabled=${disabled || !state.directory || state.switching} onChange=${choose}>
      ${state.directory ? state.directory.servers.map((entry) => html`<option key=${entry.id} value=${entry.id}>${entry.name} · ${LOAD_LABELS[entry.load]}</option>`)
        : html`<option value="">${state.loading ? '正在加载服务器…' : '服务器暂不可用'}</option>`}
    </select>
    ${state.error || (connecting && retryReady) || ['reconnecting', 'closed'].includes(conn.status) ? html`<button type="button" class="title-server__retry" disabled=${disabled || state.loading || state.switching} onClick=${retry}>重试连接</button>` : null}
    ${state.error ? html`<span role="alert" class="title-server__error">${state.error}</span>` : null}
  </div>`;
}

const DEFAULT_PASSWORD = '1234567';
const PASSWORD_MAX_LEN = 128;
const passwordError = (value) => value.length < 6 || value.length > PASSWORD_MAX_LEN ? '密码长度须为 6–128 个字符' : '';

function AccountModal({ mode, initialName, oldPassword, rememberPassword, onClose }) {
  const reset = mode === 'reset';
  const [name, setName] = useState(initialName || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  const close = () => {
    if (submitting.current) return;
    setPassword(''); setConfirmPassword('');
    onClose();
  };
  const submit = async (event) => {
    event?.preventDefault();
    if (submitting.current) return;
    const account = sanitizeName(name);
    let problem = !account ? '请输入账户名称' : passwordError(password);
    if (!problem && reset && password === DEFAULT_PASSWORD) problem = '新密码不能与默认密码相同';
    if (!problem && reset && password !== confirmPassword) problem = '两次输入的密码不一致';
    if (problem) { setError(problem); return; }
    submitting.current = true;
    setBusy(true); setError('');
    try {
      const auth = reset
        ? { action: 'reset', password: oldPassword, newPassword: password, confirmPassword }
        : { action: 'register', password };
      if (await enterSession(account, auth, () => submit(), rememberPassword)) {
        setPassword(''); setConfirmPassword(''); onClose();
      }
    } catch (err) {
      setError(err.code === 'AUTH_NAME_TAKEN' ? '名称已被占用' : err.message || '操作失败，请重试');
    } finally {
      submitting.current = false; setBusy(false);
    }
  };
  return html`<${Modal} open=${true} onClose=${close} closeDisabled=${busy} closeOnBackdrop=${!busy}
    title=${reset ? '设置新密码' : '注册账户'} micro=${reset ? 'PASSWORD RESET' : 'NEW ACCOUNT'}
    class="title-auth-modal" width="min(520px, 94vw)">
    <form class="title-auth-form" onSubmit=${submit}>
      ${reset ? html`<p class="title-auth-note">首次登录需要修改默认密码，完成后将自动登录。</p>` : null}
      <${TextField} label="账户名称" micro="CALLSIGN" name="username" autocomplete="username" value=${name}
        maxLength=${NAME_MAX_LEN} icon="user" disabled=${reset || busy} autoFocus=${!reset && !touchUi}
        onInput=${(value) => { setName(value); setError(''); }} />
      <${TextField} label=${reset ? '新密码' : '密码'} micro="PASSWORD" name="new-password" type="password"
        autocomplete="new-password" value=${password} maxLength=${PASSWORD_MAX_LEN} icon="key"
        hint="6–128 个字符" disabled=${busy} autoFocus=${reset && !touchUi}
        onInput=${(value) => { setPassword(value); setError(''); }} />
      ${reset ? html`<${TextField} label="确认新密码" micro="CONFIRM PASSWORD" name="confirm-password" type="password"
        autocomplete="new-password" value=${confirmPassword} maxLength=${PASSWORD_MAX_LEN} icon="key" disabled=${busy}
        onInput=${(value) => { setConfirmPassword(value); setError(''); }} />` : null}
      ${error ? html`<p class="title-auth-error" role="alert">${error}</p>` : null}
      <div class="title-auth-actions">
        <${Button} variant="secondary" disabled=${busy} onClick=${close}>取消<//>
        <${Button} variant="primary" type="submit" loading=${busy}>${reset ? '确认并登录' : '注册并登录'}<//>
      </div>
    </form>
  <//>`;
}

export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  const switching = useStore((s) => s.switching, undefined, serversState);
  const rememberedLogin = useMemo(() => identity.loadRememberedLogin(), []);
  const [name, setName] = useState(() => rememberedLogin?.name || store.get().me.name || identity.loadName() || '');
  const [password, setPassword] = useState(() => rememberedLogin?.password || '');
  const [rememberPassword, setRememberPassword] = useState(() => !!rememberedLogin);
  const [authError, setAuthError] = useState('');
  const [authModal, setAuthModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const assetsSettled = useData('assets');
  const assets = data.get('assets');
  const backdrop = findUiAsset(assets, BACKDROP_KEYS);
  const ridges = findUiAsset(assets, RIDGE_KEYS);
  const ridgesUrl = useResourceUrl(ridges);
  // Track load/fail per URL (not as booleans reset in effects: an image can load before an effect runs).
  const [bgLoadedUrl, setBgLoadedUrl] = useState(null);
  const [ridgesLoadedUrl, setRidgesLoadedUrl] = useState(null);
  const [ridgesFailedUrl, setRidgesFailedUrl] = useState(null);
  const bgLoaded = !!backdrop && bgLoadedUrl === backdrop;
  const ridgesLoaded = !!ridges && ridgesLoadedUrl === ridges;
  const ridgesFailed = !!ridges && ridgesFailedUrl === ridges;
  // CSS ridgelines only when there is no ridge art (avoids a swap flash when the art arrives).
  const cssRidges = assetsSettled && (!ridges || ridgesFailed);

  const valid = isValidName(name);
  const authenticating = busy || conn.status === 'handshaking';
  useEffect(() => {
    if (conn.lastError && conn.lastError.code !== 'AUTH_RESET_REQUIRED') setAuthError(conn.lastError.text);
  }, [conn.lastError?.code, conn.lastError?.text]);
  const start = async (event) => {
    event?.preventDefault();
    if (submitting.current || authenticating || switching || authModal) return;
    if (!valid) { setAuthError('请输入账户名称'); return; }
    if (!password) { setAuthError('请输入密码'); return; }
    submitting.current = true;
    setBusy(true); setAuthError('');
    try {
      if (await enterSession(name, { action: 'login', password }, () => start(), rememberPassword)) setPassword('');
    } catch (err) {
      if (err.code === 'AUTH_RESET_REQUIRED') {
        setAuthModal({ mode: 'reset', initialName: sanitizeName(name), oldPassword: password });
        setPassword(''); setAuthError('');
      } else setAuthError(err.message || '登录失败，请重试');
    } finally {
      submitting.current = false; setBusy(false);
    }
  };

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  return html`<div class="screen title-screen">
    <div class=${`title-bg${bgLoaded ? ' has-art' : ''}${ridgesLoaded ? ' has-ridges' : ''}`} aria-hidden="true">
      ${backdrop ? html`<img class="title-bg__art" src=${backdrop} alt="" draggable=${false}
        onLoad=${() => setBgLoadedUrl(backdrop)} />` : null}
      <div class="title-bg__glow"></div>
      <div class="title-bg__radar"><div class="title-bg__sweep"></div></div>
      <div class="title-bg__target"></div>
      ${cssRidges ? html`<${Ridges} />` : null}
      ${ridges && !ridgesFailed ? html`<div class="title-bg__ridge-art" style=${ridgesUrl ? `background-image:url("${ridgesUrl}")` : undefined}>
        <img src=${ridges} alt="" hidden onLoad=${() => setRidgesLoadedUrl(ridges)} onError=${() => setRidgesFailedUrl(ridges)} />
      </div>` : null}
      <div class="title-bg__haze"></div>
      <span class="cross" style="left:7%;top:22%"></span>
      <span class="cross" style="left:93%;top:30%"></span>
      <span class="cross" style="left:14%;top:70%"></span>
      <span class="cross" style="left:88%;top:62%"></span>
      <span class="cross" style="left:60%;top:12%"></span>
    </div>

    <div class="title-corner title-corner--tl">
      <span class="title-corner__mark"></span>
      <div><${MicroLabel} tone="mint">RHODES ISLAND // SIMULATION SERVICE<//><br /><${MicroLabel}>TACTICAL CO-OP NODE · 02<//></div>
    </div>
    <div class="title-corner title-corner--tr">
      <div>
        <div class="title-corner__tools">
          <${Button} variant="ghost" size="sm" icon="book" class="stats-entry title-stats" data-testid="stats-entry-title"
            onClick=${openStats} title=${trA('本机统计 / 记录')}>${trA('本机统计')}<//>
          <${LangToggle} class="title-lang" />
          <${PwaInstallButton} class="title-install" />
        </div>
        <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
      </div>
    </div>

    <main class="title-main">
      <${Emblem} />
      <div class="title-en">
        <span class="title-en__a">STRONGHOLD PROTOCOL</span>
        <span class="title-en__b">ALLIANCE</span>
      </div>
      <h1 class="title-cn">${trA("卫戍协议")}<span class="title-cn__colon">：</span><em>${trA("盟约")}</em></h1>
      <p class="title-tag">${trA("调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。")}</p>

      <form class="title-login" onSubmit=${start}>
        ${pendingJoin ? html`<div class="title-invite">
          <${Icon} name="key" />
          <span>${trA("收到同盟邀请")}</span><b class="num">${pendingJoin.code || pendingJoin}</b><span class="t-lo">· 登录后将自动加入</span>
        </div>` : null}
        <${TextField} label=${trA("博士代号")} micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
          name="username" autocomplete="username" disabled=${authenticating || switching}
          placeholder=${trA('输入你的代号（最多 {NAME_MAX_LEN} 字）', { NAME_MAX_LEN })} autoFocus=${!touchUi}
          onInput=${(value) => { setName(value); setAuthError(''); }} />
        <${TextField} label="账户密码" micro="PASSWORD" size="lg" icon="key" value=${password} type="password"
          name="password" autocomplete="current-password" maxLength=${PASSWORD_MAX_LEN} disabled=${authenticating || switching}
          placeholder="输入账户密码" hint="已有账户首次登录使用默认密码 1234567"
          onInput=${(value) => { setPassword(value); setAuthError(''); }} />
        <label class="title-remember">
          <input type="checkbox" name="remember-password" checked=${rememberPassword} disabled=${authenticating || switching}
            onChange=${(event) => {
              const checked = event.currentTarget.checked;
              setRememberPassword(checked);
              if (!checked) identity.clearRememberedLogin();
            }} />
          <span>记住密码</span>
        </label>
        ${authError ? html`<p class="title-auth-error" role="alert">${authError}</p>` : null}
        <div class="title-login__submit">
          <${Button} variant="primary" size="xl" block=${true} type="submit" iconRight="chevrons"
            loading=${authenticating} disabled=${!valid || !password || switching}>${trA("开始游戏")}<//>
          <${Button} variant="secondary" size="lg" disabled=${authenticating || switching}
            onClick=${() => { setPassword(''); setAuthError(''); setAuthModal({ mode: 'register', initialName: name }); }}>注册<//>
        </div>
        <${ServerPicker} name=${name} disabled=${authenticating} />
        <div class="title-meta">
          <div class="title-conn">
            <span class=${`status-dot ${dotClass}`}></span>
            <span>${trA(STATUS_TEXT[conn.status] || conn.status)}</span>
            ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
          </div>
          <div class="title-tools">
            <${GuideButton} class="title-guide" />
            <button type="button" class="title-settings fsbtn tapx" aria-label=${trA("设置")} title=${trA("设置")} onClick=${() => setSettingsOpen(true)}><${GIcon} name="gear" /></button>
            <${FullscreenButton} class="title-fs" />
          </div>
        </div>
      </form>
      <div class="title-actions">
        <${AnnouncementButton} class="title-notice" variant="ghost" testId="notice-entry-title" />
        <${Button} variant="ghost" size="sm" icon="info" onClick=${() => setAboutOpen(true)}>${trA("关于")}<//>
      </div>
    </main>

    ${authModal ? html`<${AccountModal} ...${authModal} rememberPassword=${rememberPassword} onClose=${() => setAuthModal(null)} />` : null}
    <${Modal} open=${aboutOpen} onClose=${() => setAboutOpen(false)} title=${trA('关于本项目')} micro="STRONGHOLD PROTOCOL · EAST" class="about-panel" width="min(800px, 94vw)">
      <p class="about-intro">${trA('卫戍协议：盟约')} · East</p><p>${trA('East 联机与排位功能，整合新版功能及 PR 643 界面。')}</p>
      <dl class="about-links"><div><dt>${trA('项目仓库')}</dt><dd><a href="https://github.com/sganggs/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">Stronghold-Protocol</a></dd></div><div><dt>${trA('本地资源')}</dt><dd>${trA('音乐、壁纸和下载资源保存在当前设备，可在资源管理中查看。')}</dd></div></dl>
      <section class="about-section"><h3>${trA('项目与素材')}</h3><p>${trA('非官方同人作品。游戏素材版权归上海鹰角网络 / Yostar 及相关权利人所有。项目代码与第三方组件遵循其原有许可证。')}</p></section>
    <//>
    ${settingsOpen ? html`<${SettingsModal} open=${true} onClose=${() => setSettingsOpen(false)} />` : null}
    <footer class="title-foot"><div class="title-foot__actions"></div>
      <span>${trA("非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有")}</span>
      <div class="title-foot-meta">
        <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
        <${MicroLabel}>${EMI_BUILD}<//>
      </div>
      <a class="title-icp" href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer">粤ICP备2026158344号</a>
    </footer>
  </div>`;
}
