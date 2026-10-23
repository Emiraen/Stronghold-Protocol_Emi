import { t as trA } from '../../../shared/i18n.js';
// Room screen (同盟等待室): 4 seat cards (avatar frame, name, ready state, AI badge, host crown),
// host controls (difficulty picker, add/remove AI in co-op, start), invite code with copy code /
// copy link, ready toggle and leave.
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, ENTERTAINMENT_CAPACITIES, ENTERTAINMENT_DEFAULT_SEATS, CYCLOPS_CAPACITIES, CYCLOPS_DEFAULT_SEATS, ENDLESS_VARIANT } from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyTag, DifficultyIcon, Tooltip, confirmDialog, doctorNo,
  Spinner, Overlay,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { LoadoutButton } from './loadout.js';
import { openStats } from './stats.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch } from '../store.js';
import { difficultyInfo, RankBadge, ProtoCard, useHallKeyboard } from './lobby.js';
import { ChatPanel } from './chat.js';
import { data, useData } from '../data.js';
import { CardPicker, cardOperators, seatAvatar, seatPortrait, useSpecialNameCardCache, isSpecialCardPortrait } from '../ui/seatArt.js';
import { skinsStore, setPlayerCard } from '../ui/skins.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { usePresence, useRise, afterLeave } from '../ui/transitions.js';
import { SettingsModal } from '../ui/settings.js';
import { GIcon } from '../ui/gameComponents.js';
import { isRankedMatch } from '../../../shared/ranks.js';
import { installedCount } from '../content.js';
import { PluginTag } from '../ui/pluginTag.js';
import { UiPluginHost } from '../ui/pluginSlots.js';
import { rankPyramidMiniView } from '../ui/rankPyramid.js';
import { RankPyramidGraphic } from '../ui/rankPyramidGraphic.js';

const isEntertainmentRoom = (room) => room?.variant === 'entertainment_multi' || room?.variant === 'entertainment_cyclops' || room?.variant === ENDLESS_VARIANT;

/**
 * Seats padded to the room's capacity (co-op 4, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
export function normalizeSeats(room) {
  const cap = room?.mode === 'solo' ? 1 : room?.variant === 'entertainment_cyclops'
    ? (CYCLOPS_CAPACITIES.includes(room.capacity) ? room.capacity : CYCLOPS_DEFAULT_SEATS)
    : room?.variant === 'entertainment_multi' || room?.variant === ENDLESS_VARIANT
      ? (ENTERTAINMENT_CAPACITIES.includes(room.capacity) ? room.capacity : ENTERTAINMENT_DEFAULT_SEATS) : MAX_SEATS;
  const src = Array.isArray(room?.seats) ? room.seats : [];
  const out = [];
  for (let i = 0; i < cap; i++) {
    const s = src[i];
    out.push(s && typeof s === 'object' ? { ...s, seat: Number.isInteger(s.seat) ? s.seat : i } : null);
  }
  return out;
}

/**
 * Derived room facts for the local player.
 * @param {any} room
 * @param {any} myId
 */
export function roomFacts(room, myId) {
  const seats = normalizeSeats(room);
  const occupied = seats.filter(Boolean);
  const humans = occupied.filter((s) => !s.isBot);
  const mine = occupied.find((s) => s.playerId === myId) || null;
  const isHost = room?.hostId != null && room.hostId === myId;
  const others = humans.filter((s) => s.playerId !== myId);
  // The host never readies: starting the match is the host's ready (server rule), so the count
  // treats the host as ready — "已就绪 0/1" next to "准许进入模拟" would contradict itself.
  const isReady = (s) => !!s.ready || s.playerId === room?.hostId;
  const readyHumans = humans.filter(isReady).length;
  const othersReady = others.every((s) => s.ready && s.connected !== false);
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady,
    emptySeats: seats.filter((s) => !s).length,
    canStart: isHost && othersReady && !!mine,
    othersReady,
  };
}

/** Invite link for a room code (current page URL with ?room=CODE). */
export function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy text to the clipboard (async API with a textarea fallback for insecure contexts).
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // 16 px: iOS zooms into smaller focused fields; `readonly` keeps the keyboard away
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.select();
    // iOS Safari ignores select() on a textarea: an explicit range is what it copies (LAN play over http has no
    // navigator.clipboard, so this path is the one iPhones / iPads take)
    try { ta.setSelectionRange(0, ta.value.length); } catch { /* ignore */ }
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function RoomProtocol({ room, variant, onClose, onPick, busy, leaving = false }) {
  const [pick, setPick] = useState(room.difficulty);
  const endless = room.variant === ENDLESS_VARIANT;
  const ref = useRef(null);
  useHallKeyboard(ref, onClose);
  return html`<${Overlay} level="hall"><div ref=${ref} tabindex="-1" class=${`rs-proto${leaving ? ' is-leaving' : ''}`}  style=${`--d-color:${DIFFICULTY_COLORS[pick]}`} role="dialog" aria-modal="true" aria-label=${trA('选择模拟协议')}
      onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="rs-proto__scene" aria-hidden="true"><${ProtocolScene} key=${pick} difficulty=${pick} /></div>
    <section class="rs-proto__side">
      <h2 class="rs-proto__title">${trA('选择模拟协议')}</h2>
      ${endless ? html`<div class="proto-list rs-proto__list" aria-label="无尽模式规则"><article class="pcard is-on pcard--endless"><span class="pcard__head"><${Icon} name="hourglass" class="pcard__glyph" /><span class="pcard__name">${trA('无尽模式')}</span></span><span class="pcard__desc">${trA('固定标准起始规则，击败最终首领后持续推进')}</span><span class="pcard__effects"><span>${trA('每五回合迎来新的首领')}</span><span>${trA('敌方强度持续提升，无数值上限')}</span></span><span class="pcard__meta"><span class="num">ENDLESS</span><span><b class="num">∞</b> ${trA('回合')}</span></span></article></div>` : html`<div class="proto-list rs-proto__list" role="radiogroup" aria-label=${trA('模拟难度')}>
        ${DIFFICULTIES.map((d) => html`<${ProtoCard} key=${d} roomMode=${room.mode} difficulty=${d} selected=${pick === d} onSelect=${setPick}
          cyclops=${room.variant === 'entertainment_cyclops'} />`)}
      </div>`}
      <button type="button" class="proto-start rs-proto__ok" disabled=${!!busy} onClick=${() => (endless || pick === room.difficulty ? onClose() : onPick(pick))}>
        <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
        <span class="proto-start__label">${busy === 'diff' ? html`<${Spinner} size="sm" />` : null}${trA('确认')}</span>
        <span class="proto-start__deco" aria-hidden="true"></span>
      </button>
    </section>
  </div><//>`;
}


function RankPyramidBadge({ view }) {
  return html`<div class="rseat__pyramid"><${RankPyramidGraphic} view=${view} mini=${true} /></div>`;
}

function SeatCard({ seat, index, room, facts, myId, busy, matching, onAddBot, onRemoveBot, onKick, onCancelReady, portraits, onPickCard, onInvite, pyramid }) {
  const [bad, setBad] = useState(null);
  const flash = useRise(!!seat && (seat.ready || seat.isBot || seat.playerId === room.hostId));
  if (!seat) {
    return html`<article class="rseat rseat--empty" style=${`--i:${index}`}>
      <span class="rseat__clip" aria-hidden="true"></span>
      <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
      <div class="rseat__art">
        <button type="button" class="rseat__invite" onClick=${onInvite}><span class="rseat__plus" aria-hidden="true"></span><b>${trA("邀请")}</b><small>${trA("复制同盟密钥以邀请队友")}</small></button>
        <span class="rseat__noinfo" aria-hidden="true">NOINFO</span>
      </div>
      ${room.mode !== 'solo' && facts.isHost ? html`<button type="button" class="rseat__botadd" disabled=${matching || !!busy} onClick=${onAddBot}>
        ${busy === 'add' ? html`<${Spinner} size="sm" />` : html`<${Icon} name="robot" />`}${trA("添加 AI 队友")}</button>` : null}
      <div class="rseat__plate rseat__plate--empty" aria-hidden="true"></div>
    </article>`;
  }
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  const ready = !offline && (seat.isBot || facts.isReady(seat));
  const src = seat.isBot ? null : seatPortrait(seat, portraits);
  const avatarSrc = seat.isBot ? null : seatAvatar(seat, portraits);
  const canPick = isMe && !seat.isBot; 
  return html`<article class=${`rseat${ready ? ' is-ready' : ''}${flash ? ' is-flash' : ''}${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${seat.isBot ? ' is-bot' : ''}${offline ? ' is-offline' : ''}`} style=${`--i:${index}`}>
    <span class="rseat__clip" aria-hidden="true"></span>
    <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
    <div class=${`rseat__art${canPick ? ' is-pickable' : ''}${isSpecialCardPortrait(src) ? ' rseat__art--special' : ''}`}>
      ${src && src !== bad ? html`<img src=${src} alt="" draggable=${false} loading="lazy" onError=${() => setBad(src)} />` : html`<span class="rseat__glyph">${seat.isBot ? html`<${Icon} name="robot" />` : [...(seat.name || '?')][0]}</span>`}
      ${pyramid ? html`<${RankPyramidBadge} view=${pyramid} />` : null}
      ${canPick ? html`<button type="button" class="rseat__pick" onClick=${onPickCard} aria-label=${trA('更换名片干员')}><${Icon} name="edit" /><span>${trA('更换立绘')}</span></button>` : null}
      ${isHostSeat ? html`<span class="rseat__host">${trA("创建者")}</span>` : null}
      ${offline ? html`<span class="rseat__lost"><${Icon} name="wifiOff" />${trA("连接中断")}</span>` : null}
      <span class="rseat__state"><span class="rseat__box">${ready ? html`<${Icon} name="check" />` : null}</span>
        ${offline ? trA("连接中断") : isHostSeat && !seat.ready ? trA("待命中") : ready ? trA("已就绪") : trA("准备中")}</span>
    </div>
    ${seat.isBot && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${!!busy} onClick=${() => onRemoveBot(index)} title=${trA("移除该 AI 队友")} aria-label=${trA("移除 AI 队友")}><${Icon} name="robot" /><${Icon} name="close" /></button>` : null}
    ${!seat.isBot && !isMe && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${!!busy || matching || !!room.matchCandidate} onClick=${() => onKick(index, seat.name, seat.playerId)} title=${trA("移出该博士")} aria-label=${trA("移出该博士")}><${Icon} name="user" /><${Icon} name="close" /></button>` : null}
    <div class="rseat__plate">
      ${isMe ? html`<span class="rseat__me" title=${trA("你")}><${Icon} name="user" /></span>` : null}
      <${AvatarFrame} size="sm" src=${avatarSrc} fallbackIcon="user" name=${seat.name} seat=${index} bot=${seat.isBot} self=${isMe} />
      <span class="rseat__who"><b class="rseat__name">${seat.name || trA("博士")}</b></span>
      <small class="rseat__doc">${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}</small>
    </div>
    ${!isEntertainmentRoom(room) && room.ranked === true ? html`<div class="rseat__rank">${seat.isBot ? html`<span>${trA("人机 · 不参与排位")}</span>` : html`<${RankBadge} rank=${seat.rank} size="sm" />`}</div>` : null}
    ${isEntertainmentRoom(room) && !seat.isBot && !isMe && facts.isHost && seat.ready ? html`<button type="button" class="rseat__cancel" disabled=${!!busy} onClick=${() => onCancelReady(index, seat.playerId)}>取消准备</button>` : null}
  </article>`;
}

function InviteBox({ code }) {
  const copy = async (what) => {
    const ok = await copyText(what === 'code' ? code : inviteLink(code));
    if (ok) toast(what === 'code' ? trA("已复制同盟密钥 {code}", { "code": (code) }) : trA("已复制邀请链接"), 'success');
    else toast(trA("复制失败，请手动复制"), 'warn');
  };
  return html`<div class="rs-key">
    <span class="rs-key__k">${trA("同盟密钥")}</span>
    <b class="rs-key__code num selectable" aria-label=${trA("同盟密钥 {code}", { code })}>${code}</b>
    <button type="button" class="rs-key__copy" onClick=${() => copy('code')}>${trA("复制")}</button>
    <button type="button" class="rs-key__link" onClick=${() => copy('link')} title=${trA("复制邀请链接")} aria-label=${trA("复制邀请链接")}><${Icon} name="link" /></button>
  </div>`;
}

function DifficultyPicker({ room, isHost, busy, onPick }) {
  if (!isHost) {
    return html`<div class="dpick dpick--ro">
      <${DifficultyTag} difficulty=${room.difficulty} size="lg" code=${difficultyInfo(room.mode, room.difficulty).code} />
      <span class="t-dim">${trA("由创建者选择")}</span>
    </div>`;
  }
  // All difficulties remain available; eligibility is re-evaluated for each match.
  return html`<div class="dpick" role="radiogroup" aria-label=${trA("模拟难度")}>
    ${DIFFICULTIES.map((d) => html`<button key=${d} type="button" role="radio" aria-checked=${room.difficulty === d ? 'true' : 'false'}
        class=${`dpick__opt${room.difficulty === d ? ' is-active' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[d]}`}
        disabled=${!!busy} title=${d === 'FUNNY' ? trA("标准模拟不计排位分、不计定级") : ''}
        onClick=${() => room.difficulty !== d && onPick(d)}>
      <${DifficultyIcon} difficulty=${d} />${trA(DIFFICULTY_NAMES[d].replace('模拟', ''))}
    </button>`)}
  </div>`;
}

/** Room screen component. */
export function RoomScreen() {
  useSpecialNameCardCache();
  useStore((s) => s.entries, Object.is, skinsStore);
  useStore((s) => s.portraits, Object.is, skinsStore);
  const room = useStore((s) => s.room);
  const installedPlugins = useStore(installedCount);
  const me = useStore((s) => s.me, shallowEqual);
  const rank = useStore((s) => s.rank, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const [busy, setBusy] = useState(null);
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [optsOpen, setOptsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [since] = useState(() => Date.now());
  const [clockTick, tick] = useState(0);
  const myCard = useStore((s) => s.card, Object.is, skinsStore);
  const protocol = usePresence(protocolOpen);
  useEffect(() => { const id = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(id); }, []);
  useData('chess', 'assets', 'backups');
  const m = data.get('assets');
  const cardList = useMemo(() => cardOperators(data.list('chess'), data.get('backups')), [data.get('chess'), data.get('backups')]);
  const portraits = useMemo(() => ({ pool: cardList, byChar: new Map(cardList.map(c => [c.charId, c])), m, myId: me.playerId, myCard }), [cardList, m, me.playerId, myCard]);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);

  if (!room) return null;
  const online = conn.status === 'online';
  const coop = room.mode !== 'solo';
  const cyclops = room.variant === 'entertainment_cyclops';
  const endless = room.variant === ENDLESS_VARIANT;
  const entertainment = isEntertainmentRoom(room);
  const capacities = cyclops ? CYCLOPS_CAPACITIES : ENTERTAINMENT_CAPACITIES;
  const ranked = !entertainment && isRankedMatch(room.ranked, room.difficulty);
  const facts = roomFacts(room, me.playerId);
  const showPyramids = ranked && !room.inMatch;
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);
  const matching = !!room.matchFill?.searching;

  const run = async (kind, fn) => {
    if (inFlight.current || !alive.current) return false;
    if (!online) { toast(trA("连接中断，请稍候重试"), 'warn'); return false; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); return true; } catch (err) { toastError(err); return false; } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const toggleReady = () => run('ready', () => net.request('room.ready', { ready: !myReady }));
  const start = () => run('start', () => net.request('room.start', {}));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat) => run(`rm${seat}`, () => net.request('room.removeBot', { seat }));
  const kick = async (seat, name, playerId) => {
    const ok = await confirmDialog({ title: '移出博士', text: `确定将 ${name || '该博士'} 移出同盟吗？`, okText: '移出', danger: true });
    if (ok) run(`kick${seat}`, () => net.request('room.kick', { seat, playerId }));
  };
  const setDifficulty = (difficulty) => run('diff', () => net.request('room.setDifficulty', { difficulty }));
  const leave = async () => {
    if (inFlight.current) return;
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ title: '离开同盟', text: '你是同盟的创建者，离开后创建者身份将移交或同盟解散。确定离开吗？', okText: '离开', danger: true });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy('leave');
    try {
      try { await net.request('room.leave', {}); }
      catch (err) { if (err?.code !== 'NOT_IN_ROOM') throw err; }
      store.set({ room: null, spectator: null, match: emptyMatch(), matchChat: { matchId: null, items: [] }, ticker: [], emotes: [] });
    } catch (err) {
      toastError(err);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const pickCard = (charId, choice) => {
    if (!online || inFlight.current || !setPlayerCard(charId, choice)) return;
    setPicking(false);
  };
  const invite = async () => { if (await copyText(room.code)) toast(trA('已复制同盟密钥 {code}', { code: room.code }), 'success'); else toast(trA('复制失败，请手动复制'), 'warn'); };
  const elapsed = Math.floor((Date.now() - since) / 1000);
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const statusLine = !online
    ? html`<span class="t-orange"><${Icon} name="wifiOff" />${trA("连接中断，正在重连…")}</span>`
    : !coop
      ? html`<span class="t-mint">${trA("*模拟协议已就绪，准许进入模拟")}</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">${trA("*同盟人数达标，准许进入模拟")}</span>`
        : html`<span class="t-lo">${trA("等待所有博士准备就绪")}</span>`
      : myReady
        ? html`<span class="t-mint">${trA("已就绪 · 等待创建者开始模拟")}</span>`
        : html`<span class="t-lo">${trA("准备就绪后，创建者即可开始模拟")}</span>`;

  return html`<div class=${`screen room-screen east-room rs${coop ? '' : ' rs--solo'}${entertainment ? ' room-screen--multi rs--big' : ''}${cyclops ? ' room-screen--cyclops' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[room.difficulty]};--n:${facts.seats.length}`}>
    ${endless ? null : html`<${UiPluginHost} />`}
    <div class="rs__bg" aria-hidden="true"></div>
    <header class="topbar rs-top">
      <div class="rs-top__left">
        <${Tooltip} text=${trA("离开同盟")} placement="bottom">
          <button type="button" class="rs-exit" disabled=${busy === 'leave'} onClick=${leave} aria-label=${trA("离开同盟")}><${Icon} name="exit" /></button>
        <//>
        <div class="rs-clock">
          <b>${endless ? '娱乐 · 无尽模式' : cyclops ? '舟铲铲之战' : entertainment ? '娱乐 · 多人同盟' : coop ? trA("同盟模拟") : trA("独立模拟")}</b>
          <span>${trA("等待时间")} <b class="num">${clock}</b> · <${PingPill} ms=${conn.ping} online=${online} /></span>
        </div>
        <div class="rs-tools">
          <${Button} variant="secondary" size="sm" square=${true} icon="chart" onClick=${openStats} title=${trA('统计数据')} aria-label=${trA('统计数据')} />
          <${Button} class="settings-btn" variant="secondary" size="sm" square=${true} onClick=${() => setSettingsOpen(true)} title=${trA('设置')} aria-label=${trA('设置')}><${GIcon} name="gear" class="btn__icon" /><//>
          <${GuideButton} class="room-guide" variant="secondary" square=${true} />
        </div>
      </div>
      <div class="rs-top__right">
        ${!endless && ((!entertainment && room.ranked !== true) || installedPlugins > 0 || room.content?.plugins?.length) ? html`<${PluginTag} room=${room} myId=${me.playerId} />` : null}
        <span class="room-ranked-chip" title=${ranked ? trA("排位赛：结算计入段位分") : trA("不影响段位分、定级进度和隐藏分")}><${Icon} name="shield" />${ranked ? trA("排位赛") : trA("不计排位分")}</span>

        ${coop ? html`<${InviteBox} code=${room.code} />` : html`<div class="rs-key rs-key--solo"><${MicroLabel}>SINGLE OPERATOR<//><span>${trA("仅限 1 名博士")}</span></div>`}
      </div>
    </header>

    <${ChatPanel} roomCode=${room.code} online=${online} me=${me} />
    ${entertainment ? html`<section class="entertainment-options" aria-label=${cyclops ? '舟铲铲之战房间设置' : endless ? '无尽模式房间设置' : '多人房间设置'}>
      <label>房间容量 <select aria-label="调整房间容量" value=${room.capacity} disabled=${!facts.isHost || !!busy || !online}
        onChange=${(e) => run('capacity', () => net.request('room.setCapacity', { capacity: Number(e.currentTarget.value) }))}>
        ${capacities.map((n) => html`<option key=${n} value=${n}>${n} 人</option>`)}
      </select></label>
      <span>已入座 ${facts.occupied.length}/${facts.seats.length} · 仅房号邀请 / 手动 AI · 不计排位</span>
    </section>` : null}
    <main class="rs-seats">
      ${facts.seats.map((s, i) => html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
        myId=${me.playerId} busy=${busy} matching=${matching} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick}
        pyramid=${showPyramids && s && !s.isBot ? rankPyramidMiniView(s.rankPyramid ?? (s.playerId === me.playerId ? rank?.rankPyramid : null)) : null}
        portraits=${portraits} onPickCard=${() => setPicking(true)} onInvite=${invite}
        onCancelReady=${(seat, playerId) => run('cancelReady', () => net.request('room.cancelReady', { seat, playerId }))} />`)}
      ${coop ? null : html`<aside class="solo-brief rs-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        <h2>${trA(DIFFICULTY_NAMES[room.difficulty] || '')}<span class="num t-dim"> ${info.code}</span></h2>
        <p>${info.desc}</p>
        <ul>
          ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
          <li>${trA("共")} <b class="num">${info.rounds}</b> ${trA("回合")}${info.hidden ? trA("，满足条件时进入隐秘核心") : ''}</li>
          <li>${trA("独立模拟中休整期与机变阶段不限时")}</li>
        </ul>
      </aside>`}
    </main>

    <footer class="room-bar rs-foot">
      <div class="rs-foot__left"><${LoadoutButton} from="room" size="lg" class="rs-loadout" /></div>
      <div class="rs-foot__center">
        <p class="rs-hint">${coop ? html`<span class="rs-ready num" title=${trA("已就绪")}>${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}<b>${facts.readyHumans}</b>/${facts.humans.length}</span>` : null}${statusLine}</p>
        <div class="rs-pill">
          <span class="rs-pill__mode">${cyclops ? '舟铲铲之战' : entertainment ? '娱乐模式' : ranked ? trA("排位赛") : trA("模拟协议")}</span>
          <i class="rs-pill__sep"></i>
          ${endless ? html`<span class="rs-pill__diff" title="固定标准起始规则"><${Icon} name="hourglass" />${trA('无尽模式')}</span>` : html`<button type="button" class="rs-pill__diff" disabled=${!facts.isHost || !!busy} onClick=${() => setProtocolOpen(true)} title=${facts.isHost ? trA("模拟难度") : trA("由创建者选择")}>
            <${DifficultyIcon} difficulty=${room.difficulty} />${trA(DIFFICULTY_NAMES[room.difficulty])}<${Icon} name="chevrons" />
          </button>`}
          <i class="rs-pill__sep"></i><button type="button" class="rs-pill__gear" aria-label=${trA('同盟设置')} onClick=${() => setOptsOpen(!optsOpen)}><${GIcon} name="gear" /></button>
        </div>
        ${optsOpen ? html`<div class="rs-opts" role="dialog" aria-label=${trA('同盟设置')}><h4>${trA('同盟设置')}<button class="rs-opts__close" type="button" aria-label=${trA('关闭')} onClick=${() => setOptsOpen(false)}><${Icon} name="close" /></button></h4>
          <label class="rs-opt"><span>${trA('AI 队友最后选择')}<small>${trA('策略与机变阶段先由真人选择')}</small></span><input type="checkbox" checked=${!!room.aiPicksLast} disabled=${!facts.isHost || !coop || !!busy} onChange=${(e) => run('aiLast', () => net.request('room.setAiPicksLast', { on: e.currentTarget.checked }))} /></label>
          ${entertainment ? html`<label class="rs-opt"><span>${trA('人数上限')}</span><select aria-label=${trA('设置房间容量')} value=${room.capacity} disabled=${!facts.isHost || !!busy} onChange=${e => run('capacity', () => net.request('room.setCapacity', { capacity: Number(e.currentTarget.value) }))}>${capacities.map(n => html`<option key=${n} value=${n}>${n}</option>`)}</select></label>` : null}
        </div>` : null}
      </div>
      <div class="rs-foot__right">
        ${facts.isHost
          ? html`<button type="button" class="proto-start rs-go" disabled=${!facts.canStart || !online || matching || !!busy} onClick=${start} title=${facts.canStart ? undefined : trA("仍有博士未准备就绪")}>
              <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
              <span class="proto-start__label">${busy === 'start' ? html`<${Spinner} size="sm" />` : null}${trA("开始模拟")}</span><span class="proto-start__deco" aria-hidden="true"></span>
            </button>`
          : html`<button type="button" class=${`proto-start rs-go${myReady ? ' is-ready' : ''}`} disabled=${!online || !facts.mine || !!room.matchCandidate || !!busy} onClick=${toggleReady}>
              <span class="rs-go__box" aria-hidden="true">${myReady ? html`<${Icon} name="check" />` : null}</span>
              <span class="proto-start__label">${busy === 'ready' ? html`<${Spinner} size="sm" />` : null}${myReady ? trA("已就绪") : trA("准备就绪")}</span><span class="proto-start__deco" aria-hidden="true"></span>
            </button>`}
      </div>
    </footer>
    ${protocol[0] ? html`<${RoomProtocol} room=${room} onClose=${() => setProtocolOpen(false)} busy=${busy} leaving=${protocol[1]} onPick=${async d => { if (await setDifficulty(d)) setProtocolOpen(false); }} />` : null}
    ${picking ? html`<${CardPicker} current=${myCard} list=${cardList} m=${m} online=${online}
      loading=${!m || !data.get('chess') || !data.get('backups')} onPick=${pickCard} onClose=${() => setPicking(false)} />` : null}
    <${SettingsModal} open=${settingsOpen} onClose=${() => setSettingsOpen(false)} />
  </div>`;
}
