import { t as trA, N_ } from '../../../shared/i18n.js';
// Lobby screen: pick 独立模拟 / 同盟模拟 and a difficulty (标准/险境/绝境/终极), create a room,
// or join one with a 同盟密钥 (recent codes remembered). Shows connection status + ping.
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, PHASE_NAMES, ROOM_CODE_LEN, MAX_SEATS, ENTERTAINMENT_DEFAULT_SEATS, ENTERTAINMENT_CAPACITIES, CYCLOPS_DEFAULT_SEATS, CYCLOPS_CAPACITIES, ENDLESS_VARIANT, modeIdFor } from '../../../shared/constants.js';
import { isRankedMatch, rankIconUrl, rankBoundaries, rankOf } from '../../../shared/ranks.js';
import { html, Button, Icon, MicroLabel, Panel, TextField, PingPill, AvatarFrame, Tooltip, Spinner, DifficultyIcon, doctorNo, Modal, Overlay, isTopOverlay } from '../ui/components.js';
import { toast, toastError, describeError } from '../ui/toasts.js';
import { GuideButton, openGuide } from '../ui/guide.js';
import { SettingsModal } from '../ui/settings.js';
import { GIcon } from '../ui/gameComponents.js';
import { LoadoutButton } from './loadout.js';
import { openStats } from './stats.js';
import { net, identity } from '../net.js';
import { serversState, joinRoom, watchMatch } from '../servers.js';
import { store, useStore, shallowEqual, loadPref, savePref, loadRankedPref } from '../store.js';
import { data, getConfig, getMode, getStage, useData } from '../data.js';
import { Emblem } from './title.js';
import { FullscreenButton } from '../ui/device.js';
import { useHubBackdrop, HubBackdrop, HubRadar, BackdropSettings, BackdropGlyph, backdropTheme } from '../ui/hubBackdrop.js';
import { LobbyMusicButton } from '../ui/lobbyMusic.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { RadarScene, CreateArt, JoinArt } from '../ui/matchFlow.js';
import { useLeave } from '../ui/transitions.js';
import { ResultView } from './result.js';
import { ChatPanel } from './chat.js';
import { RecruitmentPreview, RecruitmentHall, recruitmentKey, recruitmentTarget } from '../ui/recruitment.js';
import { CardPicker, cardOperators, seatAvatar } from '../ui/seatArt.js';
import { skinsStore, setPlayerCard } from '../ui/skins.js';

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: '时长较短的模拟训练', effects: ['可以快速完成作战', '常规奖励'] },
    NORMAL: { code: 'AC-2', desc: '敌方攻击强度较高的模拟训练', effects: ['可使用盟约数增加', '大幅增加奖励'] },
    HARD: { code: 'AC-3', desc: '敌方攻击强度极高的模拟训练', effects: ['作战环境困难', '出现更加危险的敌人'] },
    ABYSS: { code: 'AC-4', desc: '敌方攻击强度到达极限的模拟训练', effects: ['作战环境无比困难', '出现极度危险的敌人'] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: '敌方攻击强度较低的模拟训练', effects: ['作战环境较为温和', '常规奖励'] },
    NORMAL: { code: 'AC-2', desc: '敌方攻击强度较高的模拟训练', effects: ['可使用盟约数增加', '大幅增加奖励'] },
    HARD: { code: 'AC-3', desc: '敌方攻击强度极高的模拟训练', effects: ['作战环境困难', '出现更加危险的敌人'] },
    ABYSS: { code: 'AC-4', desc: '敌方攻击强度到达极限的模拟训练', effects: ['作战环境无比困难', '出现极度危险的敌人'] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) return rec.name.split(/\s+/)[0];
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? trA("战场#{no}", { "no": (String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0')) }) : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? trA("战场固定为 {name}", { "name": (name) }) : trA("战场固定"); }
    return ids.length > 1 ? trA("战场随机（共{n}张）", { "n": (ids.length) }) : '';
  }
  return Number.isInteger(stages) && stages > 1 ? trA("战场随机（共{n}张）", { "n": (stages) }) : '';
}

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty) {
  const fallback = MODE_TEXT[roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•\s]+/, '')).filter(Boolean)
    : fallback.effects;
  const rounds = Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : fallback.desc,
    effects,
    rounds,
    hidden: difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) {
    try {
      const invite = new URL(s, globalThis.location?.href);
      if (!['http:', 'https:'].includes(invite.protocol) || invite.username || invite.password) return '';
    } catch { return ''; }
    s = m[1];
  }
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

const RECENT_ROOMS_PREF = `recentRooms.${encodeURIComponent(globalThis.location?.origin || 'local')}`;

/** 最近房间仅属于当前 origin；旧单服列表在当前 origin 迁移一次。 */
export function recentRooms() {
  let list = loadPref(RECENT_ROOMS_PREF, null);
  if (list === null) {
    list = loadPref('recentRooms', []);
    savePref(RECENT_ROOMS_PREF, list);
    savePref('recentRooms', []);
  }
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code) {
  if (!CODE_RE.test(code)) return;
  savePref(RECENT_ROOMS_PREF, [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4));
}

const FALLBACK_TIPS = [
  N_("联合模拟在选择策略时可以进行一次跳过"),
  N_("调度中心即使冻结，依然可以主动刷新"),
  N_("两件同名装备可以合成一件更强力的装备"),
  N_("只有达成完美作战的队友可以进行联防"),
];
const TIP_ROTATE_MS = 5000; // matchingTipRotateInterval

/** Rotating tactical tips (config.json `tips`, weighted list of { tip, weight }). */
function TipsPanel() {
  const cfg = getConfig();
  const tips = Array.isArray(cfg?.tips)
    ? cfg.tips.map((t) => (typeof t === 'string' ? t : t?.tip)).filter((t) => typeof t === 'string' && t)
    : FALLBACK_TIPS;
  const list = tips.length ? tips : FALLBACK_TIPS;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * list.length));
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => i + 1), TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, []);
  const i = ((idx % list.length) + list.length) % list.length;
  return html`<div class="tips brackets">
    <div class="tips__head">
      <${Icon} name="info" />
      <span>${trA("作战提示")}</span>
      <${MicroLabel}>TACTICAL TIPS<//>
      <span class="tips__idx num">${String(i + 1).padStart(2, '0')}<span class="t-dim">/${String(list.length).padStart(2, '0')}</span></span>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i - 1 + list.length)} aria-label=${trA("上一条")}><${Icon} name="chevronLeft" /></button>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i + 1)} aria-label=${trA("下一条")}><${Icon} name="chevronRight" /></button>
    </div>
    <p key=${i} class="tips__text">${trA(list[i])}</p>
  </div>`;
}

/** 排位段位徽章（大厅/结算用）：图标 + 段位名。
 *  label 由服务端拼好（含小段小分；未定级为「未定级 (x/y)」；神话以上尾部带「#N」全服排名）。 */
export function RankBadge({ rank, size = 'md' }) {
  const r = rank && typeof rank === 'object' ? rank : null;
  const label = r?.rank?.label || r?.label || trA("未定级");
  const icon = r?.rank?.icon || r?.icon || 'unranked';
  return html`<span class="rank-badge rank-badge--${size}">
    <img class="rank-badge__icon" src=${rankIconUrl(icon)} alt=${label} loading="lazy" />
    <span class="rank-badge__text">
      <b class="rank-badge__label">${label}</b>
    </span>
  </span>`;
}

function historyDate(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? trA("时间未知") : d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** This view owns its subscriptions: returning to the lobby or changing identity discards pending pushes. */
export function HistoryScreen({ playerId, name, onBack }) {
  const [items, setItems] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const selected = useRef(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const offList = net.on('history.list', (msg) => {
      if (!active || selected.current || msg.viewerId !== playerId) return;
      const list = Array.isArray(msg.items) ? msg.items : [];
      // viewerId is the current authenticated session; item.playerId belongs to a past match.
      // Re-login creates a new playerId, but the same aid is still entitled to these records.
      setItems(list.slice(0, 10));
      setError('');
    });
    const offDetail = net.on('history.detail', (msg) => {
      if (!active || msg.viewerId !== playerId || msg.matchId !== selected.current?.matchId || msg.playerId !== selected.current?.playerId || !msg.result) return;
      setDetail(msg);
      setLoading(false);
      setError('');
    });
    net.request('history.list', {}).catch((err) => {
      if (active && !selected.current) { setError(err.message); setItems([]); }
    });
    return () => { active = false; offList(); offDetail(); };
  }, [playerId, name, refresh]);

  const open = (item) => {
    if (loading) return;
    const selection = { matchId: item.matchId, playerId: item.playerId };
    selected.current = selection;
    setLoading(true);
    setError('');
    net.request('history.detail', selection).catch((err) => {
      if (selected.current === selection) { setLoading(false); setError(err.message); }
    });
  };
  const backToList = () => { selected.current = null; setDetail(null); setLoading(false); setError(''); };

  return html`<div class="screen history-screen">
    <header class="topbar">
      <div class="topbar__left"><${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${onBack}>${trA("返回大厅")}<//></div>
      <div class="topbar__center"><${MicroLabel} tone="mint">MATCH HISTORY<//><h1 class="topbar__title">${trA("对局记录")}</h1></div>
      <div class="topbar__right"><span class="history-screen__owner">${name || trA("博士")} ${trA("· 公共同名档案 · 最近 10 条")}</span>
        <${Button} variant="ghost" size="sm" disabled=${loading} onClick=${() => { selected.current = null; setItems(null); setError(''); setRefresh((n) => n + 1); }}>${trA("刷新记录")}<//>
      </div>
    </header>
    <main class="history-screen__body screen__scroll">
      <div class="section-label"><span class="section-label__idx num">01</span>${trA("模拟档案")}<${MicroLabel}>NORMAL & RANKED<//></div>
      ${error ? html`<p class="history-screen__error" role="alert">${error}</p>` : null}
      ${items === null ? html`<p class="history-screen__empty">${trA("正在读取对局记录…")}</p>`
        : items.length === 0 ? html`<p class="history-screen__empty">${trA("暂无已完成的对局")}</p>`
          : html`<div class="history-screen__list">${items.map((item) => html`<button type="button" key=${`${item.matchId}:${item.playerId}`}
            class="history-entry" disabled=${loading} onClick=${() => open(item)}>
            <span class="history-entry__result ${item.victory ? 'is-win' : 'is-lose'}">${item.victory ? trA("模拟完成") : trA("模拟失败")}</span>
            <span class="history-entry__info"><b>${item.variant === ENDLESS_VARIANT ? '娱乐 · 无尽模式' : item.variant === 'entertainment_multi' ? '娱乐 · 多人同盟' : item.ranked ? trA("排位赛") : trA("普通模拟")} · ${trA(DIFFICULTY_NAMES[item.difficulty] || item.difficulty || trA("未知难度"))}</b>
              <small>${(/^(mode_)?single/.test(item.modeId || '')) ? trA("独立模拟") : (/^(mode_)?multi/.test(item.modeId || '')) ? trA("同盟模拟") : trA("模拟")} ${trA("· 通过")} ${item.roundsPassed ?? 0} ${trA("回合")}${item.rank?.tierAfter ? ` · ${item.rank.tierAfter}` : ''}</small></span>
            <time class="history-entry__time num">${historyDate(item.at)}</time>
            <${Icon} name="chevronRight" />
          </button>`)}</div>`}
      ${loading ? html`<p class="history-screen__empty">${trA("正在读取对局详情…")}</p>` : null}
    </main>
    ${detail ? html`<${Modal} open=${true} title=${trA("历史对局详情")} class="social-modal" width="min(1600px, 96vw)" onClose=${backToList}>
      <${ResultView} result=${detail.result} myId=${detail.playerId} onBack=${backToList} backLabel="返回对局记录" /><//>` : null}
  </div>`;
}

function SpectatorHall({ online, onBack }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [watchError, setWatchError] = useState('');
  const [unavailable, setUnavailable] = useState([]);
  const inFlight = useRef(false);
  const regionName = (id) => serversState.get().directory?.servers.find((entry) => entry.id === id)?.name || (id === 'main' ? '华东' : id === 'secondary' ? '华南' : '未知服务器');
  useEffect(() => {
    let active = true;
    let pending = false;
    if (!online) { setItems([]); setUnavailable([]); setError(''); }
    const refresh = async () => {
      if (!online || pending) return;
      pending = true;
      try {
        const msg = await net.request('spectator.list', {});
        if (active) { setItems(msg.items || []); setUnavailable(msg.unavailable || []); setError(''); }
      } catch (err) {
        if (active) { setItems([]); setUnavailable([]); setError(trA("暂时无法刷新，连接恢复后会自动重试")); }
      }
      finally { pending = false; }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [online]);
  const watch = async (item) => {
    if (inFlight.current || !online) return;
    inFlight.current = true;
    setBusy(item.matchId);
    setWatchError('');
    try { await watchMatch(item); }
    catch (err) { setWatchError(describeError(err)); toastError(err); }
    finally { inFlight.current = false; setBusy(null); }
  };
  return html`<div class="screen spectator-hall">
    <header class="spectator-hall__header"><button type="button" onClick=${onBack}>${trA("返回大厅")}</button>
      <h1>${trA("观战大厅")}</h1><span>${trA("仅观看 · 不参与操作或结算")}</span></header>
    ${online && watchError ? html`<p role="alert">${watchError}</p>` : null}
    <div class="spectator-hall__list screen__scroll" aria-live="polite">
      ${!online || error ? html`<p>${error || trA("连接中断，请稍候…")}</p>` : null}
      ${online && unavailable.length ? html`<p role="status">${unavailable.map(regionName).join(' / ')}观战列表暂不可用，其余服务器仍可观战。</p>` : null}
      ${online && !error && items.length ? items.map((item) => html`<article class="spectator-hall__card" key=${item.matchId}>
        <h2>${regionName(item.serverId)} · ${item.variant === ENDLESS_VARIANT ? '娱乐 · 无尽模式' : item.variant === 'entertainment_multi' ? '娱乐 · 多人同盟' : item.mode === 'solo' ? trA("独立模拟") : trA("同盟模拟")} · ${item.code}</h2>
        <p>${trA(DIFFICULTY_NAMES[item.difficulty] || item.difficulty)} · ${item.ranked ? trA("排位") : trA("普通")} ${trA("· 第")} ${item.round || 0} ${trA("回合 ·")} ${trA(PHASE_NAMES[item.phase] || item.phase)} · ${item.spectators} ${trA("人观战")}</p>
        <div class="spectator-hall__players">${item.players.map((p) => html`<span key=${p.playerId}>${p.name}${p.isBot ? '（AI）' : ''} · ${p.alive ? `${p.lp} LP` : trA("已淘汰")}</span>`)}</div>
        <button type="button" disabled=${!online || !!busy} onClick=${() => watch(item)}>${busy === item.matchId ? trA("进入中…") : trA("进入观战")}</button>
      </article>`) : html`<p class="spectator-hall__empty">${trA("暂无进行中的对局，每 5 秒自动刷新。")}</p>`}
    </div>
  </div>`;
}

const RANK_BOUNDARIES = rankBoundaries();

function RankHelp({ open, onClose }) {
  return html`<${Modal} open=${open} onClose=${onClose} title=${trA("段位积分边界")} micro="RANK POINTS" class="rank-help" overlayClass="rank-help-overlay"
    actions=${html`<${Button} variant="primary" onClick=${onClose}>${trA("关闭")}<//>`}>
    <p>${trA("当前段位以结算结果为准。")}</p>
    <table class="rank-help__table"><thead><tr><th>${trA("段位")}</th><th>${trA("总积分范围")}</th></tr></thead>
      <tbody>${RANK_BOUNDARIES.map((r) => html`<tr key=${r.icon}><td>${r.label}</td><td class="num">${r.to == null ? `≥ ${r.from}` : `${r.from}–${r.to}`}</td></tr>`)}</tbody>
    </table>
  <//>`;
}

export function RankLeaderboard({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError('');
    try {
      const reply = await net.request('rank.list', {});
      if (mounted.current) setItems(reply.items || []);
    } catch (err) {
      if (mounted.current) setError(err?.message || trA("排行榜加载失败，请重试"));
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => { refresh(); return () => { mounted.current = false; }; }, []);
  const m = data.get('assets');
  const cardList = useMemo(() => cardOperators(data.list('chess'), data.get('backups')), [data.get('chess'), data.get('backups')]);
  const byChar = useMemo(() => new Map(cardList.map((c) => [c.charId, c])), [cardList]);
  return html`<${HallFrame} title=${trA("全服排名")} en="GLOBAL RANKING" onBack=${onClose} class="east-rank-leaderboard">
    <main class="rank-leaderboard-screen">
      <header class="rank-leaderboard-screen__head"><div><${MicroLabel} tone="mint">MYTHIC LADDER<//><p>${trA("神话及以上玩家的全服排位。排名按积分及最近活跃时间确定。下拉列表可查看更多名次。")}</p></div>
        <${Button} size="sm" variant="secondary" loading=${loading} disabled=${loading} onClick=${refresh}>${trA("刷新")}<//></header>
      ${loading ? html`<div class="rank-leaderboard-screen__state" role="status"><${Spinner} size="sm" label=${trA("正在加载排行榜")} /></div>`
        : error ? html`<p class="rank-leaderboard-screen__state" role="alert">${error}</p>`
        : !items.length ? html`<p class="rank-leaderboard-screen__state" role="status">${trA("暂无神话及以上玩家")}</p>`
        : html`<div class="rank-leaderboard-screen__table-wrap"><div class="rank-leaderboard-screen__row rank-leaderboard-screen__row--head"><span>${trA("排名")}</span><span>${trA("头像")}</span><span>${trA("昵称")}</span><span>${trA("段位")}</span><span>${trA("分数")}</span><span>${trA("胜场")}</span></div>
          ${items.map((item, idx) => { const seat = { playerId: item.position || idx + 1, card: item.card, cardSkin: item.cardSkin || 'original' };
            const avatar = seatAvatar(seat, { pool: cardList, byChar, m, myId: null, myCard: null });
            const fallbackAvatar = item.cardSkin && item.cardSkin !== 'original'
              ? seatAvatar({ ...seat, cardSkin: 'original' }, { pool: cardList, byChar, m, myId: null, myCard: null }) : null;
            return html`<div key=${item.position || idx} class=${`rank-leaderboard-screen__row rank-leaderboard-screen__row--r${Math.min(item.position || idx + 1, 3)}`}>
              <span class="rank-leaderboard-screen__rank num">${item.position}</span><span class="rank-leaderboard-screen__avatar"><${AvatarFrame} size="sm" name=${item.name || trA('博士')} src=${avatar} fallbackSrc=${fallbackAvatar} fallbackIcon="user" seat=${idx} /></span>
              <span class="rank-leaderboard-screen__name">${item.name || trA('博士')}</span><span class="rank-leaderboard-screen__tier"><img src=${rankIconUrl(item.rank.icon)} alt=${item.rank.label} /><b>${item.rank.label}</b></span>
              <span class="rank-leaderboard-screen__points num">${item.points}</span><span class="rank-leaderboard-screen__wins num">${item.wins || 0}</span>
            </div>`; })}</div>`}
    </main>
  <//>`;
}

function SweepGlyph() {
  return html`<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 2.5 27.7 9.2v13.6L16 29.5 4.3 22.8V9.2z" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M9 9l12.5 12.5M23 9 10.5 21.5" stroke="currentColor" stroke-width="2.2" />
    <path d="M19.2 23.8l4.6-4.6M8.2 19.2l4.6 4.6M21.6 21.6l2.2 2.2M10.4 21.6l-2.2 2.2" stroke="currentColor" stroke-width="1.8" />
  </svg>`;
}

/** S.W.E.E.P.报告: opens the report (screens/sweep.js — 盟约报告 / 策略报告 / 敌方资料). */
function SweepPlate({ onClick }) {
  return html`<button type="button" class="hub-plate hub-plate--sweep" onClick=${onClick} title=${trA('S.W.E.E.P.报告：盟约、策略与敌方资料')}>
    <span class="hub-plate__glyph"><${SweepGlyph} /></span>
    <span class="hub-plate__label">S.W.E.E.P.${trA('报告')}</span>
    <span class="hub-plate__tag">REPORT</span>
  </button>`;
}

/** Share an in-flight import; each mounted viewer can cancel its own callbacks. */
export function createSweepLoader(load = () => import('./sweep.js')) {
  let pending;
  return (onLoad, onError) => {
    let active = true;
    if (!pending) {
      pending = Promise.resolve().then(load).catch(error => {
        pending = undefined;
        throw error;
      });
    }
    pending.then(module => { if (active) onLoad(module); }, error => { if (active) onError(error); });
    return () => { active = false; };
  };
}

const requestSweep = createSweepLoader();

function SweepLoading({ error, onRetry, onClose }) {
  const ref = useRef(null);
  useHallKeyboard(ref, onClose);
  useEffect(() => {
    document.body.classList.add('sw-open');
    return () => document.body.classList.remove('sw-open');
  }, []);
  return html`<${Overlay}><div class="sw" ref=${ref} tabindex="-1" aria-label=${trA('S.W.E.E.P.报告')}>
    <div class="sw__bg" aria-hidden="true"><i class="sw__mist"></i><i class="sw__lines"></i></div>
    <header class="sw-top"><div class="sw-top__left">
      <button type="button" class="sw-back" onClick=${onClose} aria-label=${trA('返回')} title=${trA('返回 (Esc)')}>
        <${Icon} name="chevronLeft" /><span class="sw-back__mark">S.W.E.E.P.</span>
      </button>
    </div></header>
    <main class="sw-body"><div class="sw-right"><div class="sw-loading" role=${error ? 'alert' : 'status'}>
      ${error ? html`<p>${trA('报告加载失败，请重试。')}</p><${Button} onClick=${onRetry}>${trA('重试')}<//>`
        : html`<${Spinner} /> ${trA('正在读取报告…')}`}
    </div></div></main>
  </div><//>`;
}

function LazySweepReport({ onClose }) {
  const [module, setModule] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => requestSweep(setModule, setError), [attempt]);
  return module ? html`<${module.SweepReport} onClose=${onClose} />`
    : html`<${SweepLoading} error=${error} onClose=${onClose}
        onRetry=${() => { setError(null); setAttempt(value => value + 1); }} />`;
}

function JoinLine({ text }) {
  return html`<div class="tr-join" role="status"><span class="tr-join__mark" aria-hidden="true"></span>${text}<span class="tr-join__dots" aria-hidden="true"></span></div>`;
}

function AllianceSelect({ onClose, code, onCode, codeOk, recent, online, maint, busy, onCreate, onJoin, onSpectate, difficulty }) {
  const [leaving, leave] = useLeave(onClose);
  const ref = useRef(null);
  useHallKeyboard(ref, leave);
  useEffect(() => {
    document.body.classList.add('hub-dialog-open');
    return () => document.body.classList.remove('hub-dialog-open');
  }, []);
  const joining = busy === 'create' ? trA('正在建立同盟') : busy === 'join' ? trA('正在加入同盟') : busy === 'spectate' ? trA('正在进入观战') : null;
  return html`<div ref=${ref} tabindex="-1" class=${`proto ally${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label=${trA('选择同盟方式')}>
    <div class="proto__bg ally__bg" aria-hidden="true"></div>
    <header class="proto-top">
      <button type="button" class="proto-back" onClick=${leave} title=${trA('返回大厅 (Esc)')} aria-label=${trA('返回大厅')}>
        <${Icon} name="chevronLeft" /><span class="proto-back__home"><${Icon} name="rook" /></span>
      </button>
      <div class="proto-title"><h2>${trA('选择同盟方式')}</h2><span class="proto-title__mode ally__mode">${trA('同盟模拟')}<i>ALLIANCE SIMULATION</i></span></div>
    </header>
    <div class="proto-body ally-body">
      <section class="ally-stage"><${RadarScene} />
        <button type="button" class="ally-guide" onClick=${() => openGuide(0)}><span class="ally-guide__icon"><${Icon} name="book" /></span>${trA('入门协议')}</button>
      </section>
      <section class="ally-side">
        <button type="button" class="ally-card ally-card--create" disabled=${!online || maint?.active || busy === 'create'} onClick=${onCreate}>
          <span class="ally-card__art"><${CreateArt} /></span>
          <span class="ally-card__bar"><span class="ally-card__icon"><${Icon} name="plus" /></span>${maint?.active ? trA('维护中 · 暂停开局') : trA('创建同盟')}
            ${busy === 'create' ? html`<${Spinner} size="sm" />` : html`<small>${trA('难度：{name}（可在同盟内更改）', { name: trA(DIFFICULTY_NAMES[difficulty]) })}</small>`}</span>
        </button>
        <div class="ally-card ally-card--join">
          <span class="ally-card__art"><${JoinArt} /></span>
          <label class="ally-key"><${Icon} name="search" />
            <input type="text" value=${code} placeholder=${trA('输入同盟密钥')} maxlength="64" autocomplete="off" spellcheck="false"
              onInput=${(e) => onCode(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.isComposing) onJoin(); }} />
            ${html`<button type="button" class="ally-key__spec" disabled=${!online || busy === 'spectate'} onClick=${onSpectate}
              title=${trA('打开观战大厅')}><${Icon} name="eye" />${trA('观战大厅')}</button>`}
          </label>
          ${recent.length ? html`<span class="ally-recent">${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${trA('填入密钥（不会直接加入）')} onClick=${() => onCode(c)}>${c}</button>`)}</span>` : null}
          <button type="button" class="ally-card__bar ally-card__bar--join" disabled=${!codeOk || !online || busy === 'join'} onClick=${() => onJoin()}>
            <span class="ally-card__icon"><${Icon} name="users" /></span>${trA('加入同盟')}${busy === 'join' ? html`<${Spinner} size="sm" />` : null}
          </button>
        </div>
      </section>
    </div>
    ${joining ? html`<${JoinLine} text=${joining} />` : null}
  </div>`;
}



/** Icons drawn on the same 24px grid as the imported UI. */
function EastGlyph({ name }) {
  const paths = {
    entertainment: 'M5 4h14l3 5v11H2V9zm1.2 2L4 9.7V18h16V9.7L17.8 6zM7 10h2v2h2v2H9v2H7v-2H5v-2h2zm9 1h2v2h-2zm-3 3h2v2h-2z',
    cyclops: 'M12 2 3 7v10l9 5 9-5V7zm0 2.3L19 8v8l-7 3.7L5 16V8zm0 3C8 7.3 6 12 6 12s2 4.7 6 4.7 6-4.7 6-4.7-2-4.7-6-4.7zm0 2.5a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z',
    chart: 'M3 3h2v16h16v2H3zm5 9h3v5H8zm5-4h3v9h-3zm5-4h3v13h-3z',
  };
  return paths[name] ? html`<svg class="icon" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path d=${paths[name]} fill-rule="evenodd" /></svg>` : html`<${Icon} name=${name} />`;
}

function HubTile({ icon, label, en, onClick, children, disabled = false, class: cls = '' }) {
  return html`<button type="button" class=${`hub-tile ${cls}`} onClick=${onClick} disabled=${disabled}>
    <span class="hub-tile__icon"><${EastGlyph} name=${icon} /></span>
    <span class="hub-tile__text"><span class="hub-tile__label">${label}</span><span class="hub-tile__en">${en}</span></span>${children}
  </button>`;
}

function HubEntry({ name, en, icon, tone = 'mint', onClick }) {
  return html`<div class="hub-entry-wrap"><span class="hub-entry__group"><${EastGlyph} name=${icon} />${name}</span>
    <button type="button" class=${`hub-entry hub-entry--${tone}`} onClick=${onClick}>
      <span class="hub-entry__icon"><${EastGlyph} name=${icon} /></span><span class="hub-entry__en">${en}</span>
      <span class="hub-entry__name">${name}</span><span class="hub-entry__corner" aria-hidden="true"></span>
    </button></div>`;
}

function StampRing() {
  return html`<svg class="pcard__ring" viewBox="0 0 120 100" aria-hidden="true"><path pathLength="1" d="M18 62C6 34 34 8 70 10c34 2 48 30 38 54-10 24-46 32-72 22C20 80 10 66 16 50" /><path pathLength="1" d="M30 20c22-14 62-12 78 10 12 18 4 44-16 54" /></svg>`;
}

export function ProtoCard({ roomMode, difficulty, selected, onSelect, cyclops }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`pcard${selected ? ' is-on' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`}
    onClick=${() => onSelect(difficulty)} aria-pressed=${selected}>
    <span class="pcard__glow" aria-hidden="true"></span><span class="pcard__head"><${DifficultyIcon} difficulty=${difficulty} class="pcard__glyph" /><span class="pcard__name">${trA(DIFFICULTY_NAMES[difficulty])}</span></span>
    <span class="pcard__desc">${info.desc}</span><span class="pcard__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}</span>
    <span class="pcard__meta"><span class="num">${info.code}</span><span><b class="num">${cyclops ? 21 : info.rounds}</b> ${trA('回合')}${!cyclops && info.hidden ? trA(' + 隐秘核心') : ''}</span>${info.stageNote ? html`<span>${info.stageNote}</span>` : null}</span>
    <span class="pcard__stamp" aria-hidden="true"><${StampRing} /><span class="pcard__tick"><${Icon} name="check" /></span><span class="pcard__ok">${trA('已选定')}</span></span>
  </button>`;
}

/** Keyboard and focus stay in the topmost full-screen hall, including portalled room dialogs. */
export function useHallKeyboard(ref, onClose) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const box = ref.current;
    if (!box) return undefined;
    const available = () => [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex], summary')]
      .filter(el => el.tabIndex >= 0 && !el.disabled && !el.closest('[inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const focusFirst = () => (available()[0] || box).focus();
    if (isTopOverlay(box)) box.focus();
    const key = e => {
      if (!isTopOverlay(box) || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current?.(); }
      else if (e.key === 'Tab') {
        const items = available(), first = items[0] || box, last = items.at(-1) || box;
        if (!items.includes(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
          e.preventDefault(); (e.shiftKey ? last : first).focus();
        }
      }
    };
    const focus = e => { if (isTopOverlay(box) && !box.contains(e.target)) focusFirst(); };
    window.addEventListener('keydown', key);
    window.addEventListener('focusin', focus);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('focusin', focus);
      if (previous?.isConnected) previous.focus?.();
    };
  }, []);
}

/** A second-level hall uses East's overlay host and keeps its dialogs above it. */
function HallFrame({ title, en, onBack, children, class: cls = '', difficulty = 'NORMAL', modeName = 'EAST' }) {
  const [leaving, leave] = useLeave(onBack);
  const ref = useRef(null);
  useHallKeyboard(ref, leave);
  return html`<${Overlay} level="hall"><div ref=${ref} tabindex="-1" class=${`proto east-hall ${cls}${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label=${title}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`}>
    <div class="proto__bg" aria-hidden="true"></div><header class="proto-top">
      <button type="button" class="proto-back" onClick=${leave} aria-label=${trA('返回大厅')}><${Icon} name="chevronLeft" /><span class="proto-back__home"><${Icon} name="rook" /></span></button>
      <div class="proto-title"><h2>${title}</h2><span class="proto-title__mode">${modeName}<i>${en}</i></span></div>
    </header>${children}
  </div><//>`;
}

function EntertainmentHall({ onBack, onPick }) {
  const modes = [
    { id: 'entertainment_multi', name: '多人模式', en: 'MULTIPLAYER ALLIANCE', icon: 'users', no: '01', desc: '组建至多 20 人的同盟，分组卡池与轮选，多轮联防。', tags: ['1–20 名博士', '房号邀请 / 手动 AI', '不计排位'] },
    { id: 'entertainment_cyclops', name: '舟铲铲之战', en: 'CYCLOPS TACTICS', icon: 'cyclops', no: '02', desc: '21 回合 · 全干员池 · 装备奖励 · 独眼巨人的馈赠。', tags: ['1–8 名博士', '每 4 人共享卡池', '存款利息 / 经验升级'] },
    { id: ENDLESS_VARIANT, name: '无尽模式', en: 'ENDLESS PROTOCOL', icon: 'hourglass', no: '03', desc: '击败原版最终首领后继续推进，每五回合迎来新的首领，敌方强度持续增长。', tags: ['4–20 名博士', '回合与强度无上限', '不计排位'] },
  ];
  return html`<${HallFrame} title=${trA('娱乐模式大厅')} en="ENTERTAINMENT" onBack=${onBack} class="east-entertainment">
    <div class="east-entertainment__intro"><${MicroLabel} tone="mint">SPECIAL SIMULATION PROTOCOLS<//><p>${trA('选择玩法，邀请同伴开始模拟。娱乐对局不计入排位。')}</p></div>
    <main class="east-entertainment__cards">${modes.map((m) => html`<button type="button" key=${m.id} class="east-mode" onClick=${() => onPick(m.id)}>
      <span class="east-mode__no num">${m.no}</span><span class="east-mode__art"><${EastGlyph} name=${m.icon} /></span>
      <span class="east-mode__en">${m.en}</span><h3>${trA(m.name)}</h3><p>${trA(m.desc)}</p>
      <span class="east-mode__tags">${m.tags.map((tag) => html`<span key=${tag}>${trA(tag)}</span>`)}</span>
      <span class="east-mode__enter">${trA('选择模拟协议')}<${Icon} name="chevrons" /></span>
    </button>`)}</main>
  <//>`;
}

/** Use the actual settlement total, including placement, protection and awarded bonuses. */
export function rankHistoryDelta(rank) {
  if (!rank || typeof rank !== 'object') return null;
  if (Number.isFinite(rank.totalDelta)) return rank.totalDelta;
  if (Number.isFinite(rank.before) && Number.isFinite(rank.after)) return rank.after - rank.before;
  if (Number.isFinite(rank.delta)) return rank.delta + (Number.isFinite(rank.bonus) ? rank.bonus : 0);
  return null;
}

function RankHistory({ playerId, name, online }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState('');
  const selected = useRef(null);
  useEffect(() => {
    let active = true;
    selected.current = null;
    setItems(null); setDetail(null); setLoading(''); setError('');
    if (!online || !playerId) { setItems([]); return () => { active = false; }; }
    const off = net.on('history.list', msg => {
      if (!active || msg.viewerId !== playerId) return;
      setItems((Array.isArray(msg.items) ? msg.items : []).filter(item => item.ranked).slice(0, 10));
      setError('');
    });
    const offDetail = net.on('history.detail', msg => {
      if (!active || msg.viewerId !== playerId || msg.matchId !== selected.current?.matchId || msg.playerId !== selected.current?.playerId || !msg.result) return;
      setDetail(msg); setLoading('');
    });
    net.request('history.list', {}).catch(err => { if (active) { setItems([]); setError(describeError(err)); } });
    return () => { active = false; selected.current = null; off(); offDetail(); };
  }, [playerId, name, online, refresh]);
  const open = item => {
    if (loading) return;
    const selection = { matchId: item.matchId, playerId: item.playerId };
    selected.current = selection; setLoading(item.matchId); setError('');
    net.request('history.detail', selection).catch(err => {
      if (selected.current === selection) { setLoading(''); setError(describeError(err)); }
    });
  };
  const closeDetail = () => { selected.current = null; setDetail(null); setLoading(''); };
  return html`<section class="rank-history" aria-label=${trA('账号排位对局记录')}>
    <header class="rank-history__head"><div><${MicroLabel} tone="mint">ACCOUNT // RANKED HISTORY<//><h3>${trA('排位对局记录')}</h3></div>
      <${Button} variant="ghost" size="sm" icon="refresh" disabled=${!online || items === null || !!loading} onClick=${() => setRefresh(n => n + 1)}>${trA('刷新')}<//></header>
    <div class="rank-history__account"><${Icon} name="user" /><b>${name || trA('博士')}</b><span>${trA('最近已完成的排位模拟')}</span></div>
    ${error ? html`<p class="rank-history__error" role="alert">${error}</p>` : null}
    <div class="rank-history__list" aria-live="polite">
      ${items === null ? html`<div class="rank-history__empty"><${Spinner} size="sm" /><b>${trA('正在读取排位档案')}</b></div>`
        : !items.length ? html`<div class="rank-history__empty"><${EastGlyph} name="chart" /><b>${online ? trA('暂无排位记录') : trA('连接后查看排位记录')}</b><p>${trA('完成排位模拟后，在这里查看结算与积分变化。')}</p></div>`
          : items.map(item => {
            const delta = rankHistoryDelta(item.rank);
            const placement = item.rank?.kind === 'placement';
            const afterIcon = item.rank?.iconAfter || (Number.isFinite(item.rank?.after) && (!placement || item.rank.placementPlayed >= (item.rank.placementMatches || 3)) ? rankOf(item.rank.after).icon : 'unranked');
            return html`<button key=${`${item.matchId}:${item.playerId}`} type="button" class=${`rank-record${item.victory ? ' is-win' : ' is-lose'}`} disabled=${!!loading} onClick=${() => open(item)}>
              <span class="rank-record__result"><i></i>${item.victory ? trA('胜利') : trA('失利')}</span>
              <span class="rank-record__info"><b>${trA(DIFFICULTY_NAMES[item.difficulty] || item.difficulty || '未知难度')}<span>${item.mode === 'solo' || /^(mode_)?single/.test(item.modeId || '') ? trA('独立模拟') : trA('同盟模拟')}</span></b>
                <small>${historyDate(item.at)} · ${trA('通过')} ${item.roundsPassed ?? 0} ${trA('回合')}</small>
                ${item.rank ? html`<span class="rank-record__tier">${item.rank.tierAfter || ''}${placement ? ` · ${trA('定级')} ${item.rank.placementPlayed || 0}/${item.rank.placementMatches || 3}` : ''}</span>` : null}</span>
              <span class=${`rank-record__points${delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : ''}`}>
                <span class="rank-record__delta"><img class="rank-record__after-icon" src=${rankIconUrl(afterIcon)} alt=${item.rank?.tierAfter || trA('未定级')} title=${item.rank?.tierAfter || trA('未定级')} /><b class="num">${delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta}`}</b></span><small>${trA('排位分')}</small>
                ${Number.isFinite(item.rank?.before) && Number.isFinite(item.rank?.after) ? html`<em class="num">${item.rank.before} → ${item.rank.after}</em>` : null}</span>
              <span class="rank-record__go">${loading === item.matchId ? html`<${Spinner} size="sm" />` : html`<${Icon} name="chevronRight" />`}</span>
            </button>`;
          })}
    </div>
    <p class="rank-history__note"><${Icon} name="info" />${trA('显示服务器最近 10 条已完成对局中的排位记录，积分以该局最终结算为准。')}</p>
    ${detail ? html`<${Modal} open=${true} title=${trA('排位对局详情')} micro="RANKED MATCH REPORT" class="social-modal" width="min(1600px, 96vw)" onClose=${closeDetail}>
      <${ResultView} result=${detail.result} myId=${detail.playerId} onBack=${closeDetail} backLabel="返回排位记录" /><//>` : null}
  </section>`;
}

function RankHall({ rank, me, online, onBack, onStart, onLeaderboard, onHelp }) {
  return html`<${HallFrame} title=${trA('排位大厅')} en="RANKED PROTOCOL" onBack=${onBack} class="east-ranked">
    <main class="east-ranked__body"><section class="east-ranked__identity">
      <${MicroLabel} tone="mint">RANKED SIMULATION<//><${RankBadge} rank=${rank} /><h2>${trA('以同盟之名，攀登巅峰')}</h2>
      <p>${trA('险境、绝境、终极模拟计入排位。标准模拟不计排位分与定级。')}</p>
      <div class="east-ranked__tools"><${Button} icon="crown" disabled=${!online} onClick=${onLeaderboard}>${trA('全服排行榜')}<//><${Button} icon="info" onClick=${onHelp}>${trA('段位规则')}<//></div>
      <div class="east-ranked__start"><${Button} icon="user" disabled=${!online} onClick=${() => onStart('solo')}>${trA('创建独立排位')}<//><${Button} variant="secondary" icon="users" disabled=${!online} onClick=${() => onStart('coop')}>${trA('创建同盟排位')}<//></div>
    </section><${RankHistory} key=${me?.playerId || ''} playerId=${me?.playerId} name=${me?.name} online=${online} /></main>
  <//>`;
}

export function LobbyScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const switching = useStore((s) => s.switching, undefined, serversState);
  const rank = useStore((s) => s.rank, shallowEqual);
  const recruitment = useStore((s) => s.recruitment?.rooms || [], shallowEqual);
  useData('config', 'chess', 'assets', 'backups');
  useStore((s) => s.entries, Object.is, skinsStore);
  useStore((s) => s.portraits, Object.is, skinsStore);
  const cardList = useMemo(() => cardOperators(data.list('chess'), data.get('backups')), [data.get('chess'), data.get('backups')]);
  const myCard = useStore((s) => s.card, Object.is, skinsStore);
  const avatarSrc = seatAvatar({playerId:me.playerId,card:myCard}, {pool:cardList,byChar:new Map(cardList.map(c=>[c.charId,c])),m:data.get('assets'),myId:me.playerId,myCard});
  const bg = useHubBackdrop();
  const [hall, setHall] = useState(null);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [roomMode, setRoomMode] = useState(() => loadPref('lobby.mode', 'coop') === 'solo' ? 'solo' : 'coop');
  const [variant, setVariant] = useState(null);
  const [capacity, setCapacity] = useState(ENTERTAINMENT_DEFAULT_SEATS);
  const [cyclopsCapacity, setCyclopsCapacity] = useState(CYCLOPS_DEFAULT_SEATS);
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', 'NORMAL');
    return DIFFICULTIES.includes(d) ? d : 'NORMAL';
  });
  const [ranked, setRanked] = useState(() => loadRankedPref());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  const [recent] = useState(recentRooms);
  const [dialog, setDialog] = useState(null);
  const [rankHelpOpen, setRankHelpOpen] = useState(false);
  const alive = useRef(true), inFlight = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);
  const online = conn.status === 'online' && !switching;
  const entertainment = variant !== null;
  const cyclops = variant === 'entertainment_cyclops';
  const rankedEligible = !entertainment && isRankedMatch(ranked, difficulty);
  const codeOk = CODE_RE.test(normalizeCode(code));
  const pickDifficulty = (d) => { setDifficulty(d); savePref('lobby.difficulty', d); };
  const toggleRanked = () => { setRanked(!ranked); savePref('lobby.ranked', !ranked); };
  const openMode = (mode, rankedStart = false) => {
    setRoomMode(mode); setVariant(null); setHall('protocol'); savePref('lobby.mode', mode);
    if (rankedStart) { setRanked(true); savePref('lobby.ranked', true); if (difficulty === 'FUNNY') pickDifficulty('NORMAL'); }
  };
  const pickEntertainment = (id) => { setVariant(id); setRoomMode('coop'); if (id === ENDLESS_VARIANT) pickDifficulty('NORMAL'); setHall('protocol'); };
  const run = async (kind, fn) => {
    if (inFlight.current || serversState.get().switching) return;
    if (!online) { toast(trA('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true; setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); }
    finally { inFlight.current = false; if (alive.current) setBusy(null); }
  };
  const create = () => run('create', () => net.request('room.create', entertainment
    ? { mode: 'coop', variant, capacity: cyclops ? cyclopsCapacity : capacity, difficulty, ranked: false }
    : { mode: roomMode, difficulty, ranked }));
  const join = () => {
    if (!codeOk) { toast(trA('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    return run('join', () => joinRoom(code));
  };
  const backToTitle = () => { identity.setEntered(false); store.set((s) => ({ session: { ...s.session, entered: false } })); };
  const pickCard = (charId, choice) => {
    if (!online || !setPlayerCard(charId, choice)) return;
    setDialog(null);
  };
  const modeName = variant === ENDLESS_VARIANT ? '无尽模式' : cyclops ? '舟铲铲之战' : entertainment ? '多人模式' : roomMode === 'solo' ? '独立模拟' : '同盟模拟';
  const backFromProtocol = () => setHall(entertainment ? 'entertainment' : roomMode === 'coop' ? 'alliance' : null);

  return html`<div class="screen lobby-screen lobby-hub east-hub" data-hub-theme=${backdropTheme(bg)}>
    <${HubBackdrop} bg=${bg} /><header class="topbar hub-topbar">
      <div class="topbar__left"><${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${backToTitle} title=${trA('返回标题')}>${trA('返回')}<//><${PingPill} ms=${conn.ping} online=${online} />
        <span class="topbar__sep" aria-hidden="true"></span><div class="topbar__tools">
          <${Button} variant="secondary" size="sm" square=${true} onClick=${() => setDialog('settings')} title=${trA('设置')} aria-label=${trA('设置')}><${GIcon} name="gear" /><//>
          <${GuideButton} class="lobby-guide" variant="secondary" square=${true} />
          <${Button} variant="secondary" size="sm" square=${true} onClick=${() => setDialog('backdrop')} title=${trA('大厅背景')} aria-label=${trA('大厅背景')}><${BackdropGlyph} /><//>
          <${LobbyMusicButton} /><${FullscreenButton} class="btn btn--secondary btn--sm btn--square" />
        </div></div>
      <div class="topbar__right"><button type="button" class="me-chip me-chip--btn" onClick=${() => setDialog('card')} aria-label=${trA('名片编辑')} title=${trA('名片编辑')}><${AvatarFrame} size="sm" name=${me.name} src=${avatarSrc} fallbackIcon="user" seat=${0} self=${true} /><div class="me-chip__text"><span class="me-chip__name">${me.name || trA('博士')}</span><${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//></div></button></div>
    </header>
    <main class="hub-stage">
      <div class="hub-center"><div class="hub-center__mark"><${HubRadar} bg=${bg} /><${Emblem} /></div><div class="hub-center__en">STRONGHOLD PROTOCOL <b>ALLIANCE</b></div><h1 class="hub-center__title">${trA('卫戍协议：盟约')}</h1></div>
      <aside class="hub-side">
        <${HubTile} icon="crown" label=${trA('排位')} en="RANKED PROTOCOL" class="east-rank-tile" onClick=${() => setHall('ranked')}><${RankBadge} rank=${rank} size="sm" /><//>
        <${HubTile} icon="chart" label=${trA('统计数据')} en="STATISTICS" onClick=${openStats} />
        <${HubTile} icon="key" label=${trA('密钥加入')} en="JOIN WITH KEY" onClick=${() => setDialog('join')} />
        <${HubTile} icon="eye" label=${trA('观战大厅')} en="SPECTATOR HALL" onClick=${() => setDialog('spectator')} disabled=${!online} />
        <${HubTile} icon="book" label=${trA('对局记录')} en="MATCH HISTORY" onClick=${() => setDialog('history')} disabled=${!online || !me.playerId} />
        <${TipsPanel} />
      </aside>
      <aside class="hub-right"><div class="hub-right__plates">
        <${SweepPlate} onClick=${() => setSweepOpen(true)} />
        <${LoadoutButton} from="lobby" size="lg" class="hub-plate hub-plate--loadout" label=${trA('干员调配')} />
        <${RecruitmentPreview} rooms=${recruitment} online=${online} onOpen=${() => setDialog('recruitment')} />
      </div></aside>
      <section class="hub-entries" aria-label=${trA('模拟方式')}><div class="hub-entries__row">
        <${HubEntry} name=${trA('独立模拟')} en="SOLO" icon="user" onClick=${() => openMode('solo')} />
        <${HubEntry} name=${trA('同盟模拟')} en="ALLIANCE" icon="users" onClick=${() => setHall('alliance')} />
        <${HubEntry} name=${trA('娱乐模式')} en="ENTERTAINMENT" icon="entertainment" tone="bright" onClick=${() => setHall('entertainment')} />
      </div></section>
    </main>
    ${!hall && !dialog ? html`<${ChatPanel} online=${online} me=${me} />` : null}

    ${dialog === 'card' ? html`<${CardPicker} current=${myCard} list=${cardList} m=${data.get('assets')} online=${online}
      loading=${!data.get('assets') || !data.get('chess') || !data.get('backups')} onPick=${pickCard} onClose=${() => setDialog(null)} />` : null}
    ${sweepOpen ? html`<${LazySweepReport} onClose=${() => setSweepOpen(false)} />` : null}
    ${hall === 'alliance' ? html`<${Overlay} level="hall"><${AllianceSelect} onClose=${() => setHall(null)} code=${code} onCode=${(v) => setCode(normalizeCode(v))} codeOk=${codeOk} recent=${recent} online=${online} busy=${busy} difficulty=${difficulty} onCreate=${() => openMode('coop')} onJoin=${join} onSpectate=${() => setDialog('spectator')} /><//>` : null}
    ${hall === 'entertainment' ? html`<${EntertainmentHall} onBack=${() => setHall(null)} onPick=${pickEntertainment} />` : null}
    ${hall === 'ranked' ? html`<${RankHall} rank=${rank} me=${me} online=${online} onBack=${() => setHall(null)} onStart=${(m) => openMode(m, true)} onLeaderboard=${() => setHall('leaderboard')} onHelp=${() => setRankHelpOpen(true)} />` : null}
    ${hall === 'leaderboard' ? html`<${RankLeaderboard} onClose=${() => setHall('ranked')} />` : null}
    ${hall === 'protocol' ? html`<${HallFrame} title=${trA('选择模拟协议')} en=${entertainment ? 'ENTERTAINMENT' : roomMode === 'solo' ? 'SOLO SIMULATION' : 'ALLIANCE SIMULATION'} modeName=${trA(modeName)} difficulty=${difficulty} onBack=${backFromProtocol}>
      <div class="proto-body"><section class="proto-stage"><${ProtocolScene} key=${difficulty} difficulty=${difficulty} /><div class="proto-brief"><span class="proto-brief__code num">${variant === ENDLESS_VARIANT ? 'ENDLESS' : difficultyInfo(roomMode, difficulty).code}</span><b class="proto-brief__name">${trA(variant === ENDLESS_VARIANT ? '无尽模式' : DIFFICULTY_NAMES[difficulty])}</b><p>${variant === ENDLESS_VARIANT ? '标准起始规则 · 击败最终首领后持续推进 · 每五回合首领战 · 不计排位' : cyclops ? '21 回合 · 装备奖励 · R10 征召 · 经验升级' : entertainment ? '多人同盟 · 分组卡池与轮选 · 不计排位' : roomMode === 'solo' ? '独自调配阵容，以自己的节奏完成模拟。' : '邀请同伴或手动添加 AI，共同抵御敌潮。'}</p></div></section>
      <section class="proto-side">${variant === ENDLESS_VARIANT ? html`<div class="proto-list" aria-label="无尽模式规则"><article class="pcard is-on pcard--endless"><span class="pcard__glow" aria-hidden="true"></span><span class="pcard__head"><${Icon} name="hourglass" class="pcard__glyph" /><span class="pcard__name">${trA('无尽模式')}</span></span><span class="pcard__desc">${trA('击败原版最终首领后继续推进')}</span><span class="pcard__effects"><span>${trA('每五回合迎来新的首领')}</span><span>${trA('敌方强度持续提升，无数值上限')}</span></span><span class="pcard__meta"><span class="num">ENDLESS</span><span><b class="num">∞</b> ${trA('回合')}</span><span>${trA('固定标准起始规则')}</span></span><span class="pcard__stamp" aria-hidden="true"><${StampRing} /><span class="pcard__tick"><${Icon} name="check" /></span><span class="pcard__ok">${trA('已选定')}</span></span></article></div>` : html`<div class="proto-list" aria-label=${trA('模拟难度')}>${DIFFICULTIES.map((d) => html`<${ProtoCard} key=${d} roomMode=${roomMode} difficulty=${d} selected=${difficulty === d} onSelect=${pickDifficulty} cyclops=${cyclops} />`)}</div>`}
        <div class="proto-foot">
          ${entertainment ? html`<label class="east-capacity">${trA('房间人数')}<select aria-label=${cyclops ? '舟铲铲之战房间人数' : variant === ENDLESS_VARIANT ? '无尽模式房间人数' : '娱乐房间容量'} value=${cyclops ? cyclopsCapacity : capacity} onChange=${(e) => (cyclops ? setCyclopsCapacity : setCapacity)(Number(e.currentTarget.value))}>${(cyclops ? CYCLOPS_CAPACITIES : ENTERTAINMENT_CAPACITIES).map((n) => html`<option key=${n} value=${n}>${n} ${trA('人')}</option>`)}</select><span>${trA('娱乐模式 · 不计排位')}</span></label>` : html`<label class="east-ranked-toggle"><input type="checkbox" checked=${ranked} onChange=${toggleRanked} /><span>${trA('开启排位赛')}</span><small>${difficulty === 'FUNNY' ? trA('标准不计排位分 / 不计定级') : rankedEligible ? 'RANKED' : trA('普通模拟')}</small></label>`}
          <p class="proto-hint">${!online ? trA('正在连接服务器…') : entertainment ? trA('房间码邀请 / 手动添加 AI · 不参与自动匹配') : trA('创建后可通过聊天发送房间码，邀请同伴加入。')}</p>
          <button type="button" class="proto-start" disabled=${!online || !!busy} onClick=${create}><span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span><span class="proto-start__label">${busy === 'create' ? trA('创建中…') : variant === ENDLESS_VARIANT ? trA('创建无尽模式房间') : entertainment ? trA('创建娱乐同盟') : roomMode === 'solo' ? trA('开始独立模拟') : trA('创建同盟')}</span><span class="proto-start__deco" aria-hidden="true"></span></button>
        </div>
      </section></div>
    <//>` : null}
    <${SettingsModal} open=${dialog === 'settings'} onClose=${() => setDialog(null)} />
    <${Modal} open=${dialog === 'backdrop'} title=${trA('大厅背景')} micro="LOBBY BACKDROP" onClose=${() => setDialog(null)} class="east-backdrop-modal" width="min(700px, 94vw)"><${BackdropSettings} bg=${bg} /><//>
    <${Modal} open=${dialog === 'join'} title=${trA('密钥加入')} micro="JOIN WITH ALLIANCE KEY" onClose=${() => setDialog(null)} width="min(640px, 94vw)">
      <div class="join-row"><${TextField} size="code" icon="key" value=${code} placeholder=${trA('输入同盟密钥 / 粘贴邀请链接')} onInput=${setCode} onEnter=${join} /></div>
      <div class="join-foot">${recent.length ? recent.map((c) => html`<button key=${c} type="button" class="code-chip num" onClick=${() => setCode(c)}>${c}</button>`) : html`<span>${trA('向同伴索取同盟密钥，或粘贴完整邀请链接。')}</span>`}</div>
      <${Button} variant="amber" size="lg" block=${true} icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online} onClick=${join}>${trA('加入同盟')}<//>
    <//>
    ${dialog === 'history' ? html`<${Modal} open=${true} title=${trA('对局记录')} class="social-modal" width="min(1600px, 96vw)" onClose=${() => setDialog(null)}><${HistoryScreen} key=${`${me.playerId}:${me.name}`} playerId=${me.playerId} name=${me.name} onBack=${() => setDialog(null)} /><//>` : null}
    ${dialog === 'recruitment' ? html`<${Modal} open=${true} title="招募大厅" class="social-modal recruitment-modal" width="min(1200px, 96vw)" onClose=${() => setDialog(null)}><${RecruitmentHall} rooms=${recruitment} online=${online} busy=${busy} onBack=${() => setDialog(null)} onJoin=${(room) => run(`recruit:${recruitmentKey(room)}`, () => joinRoom(recruitmentTarget(room)))} /><//>` : null}
    ${dialog === 'spectator' ? html`<${Modal} open=${true} title=${trA('观战大厅')} class="social-modal" width="min(1200px, 96vw)" onClose=${() => setDialog(null)}><${SpectatorHall} online=${online} onBack=${() => setDialog(null)} /><//>` : null}
    <${RankHelp} open=${rankHelpOpen} onClose=${() => setRankHelpOpen(false)} />
  </div>`;
}
