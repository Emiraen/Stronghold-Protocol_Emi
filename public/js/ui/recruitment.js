import { useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { getStage, useData } from '../data.js';
import { net } from '../net.js';
import { describeError } from './toasts.js';
import { serversState, roomServer } from '../servers.js';

export const recruitmentKey = room => `${room.serverId || roomServer(room.code) || 'unknown'}:${room.code}`;
export function recruitmentServerName(room) {
  const id = room.serverId || roomServer(room.code);
  return room.serverName || serversState.get().directory?.servers.find(entry => entry.id === id)?.name
    || ({ main: '华东', secondary: '华南' })[id] || '未知服务器';
}
export const recruitmentTarget = room => ({ code: room.code, serverId: room.serverId || roomServer(room.code) });

export function recruitmentMode(room) {
  if (room.variant === 'entertainment_endless') return '无尽';
  if (room.variant === 'entertainment_cyclops') return '铲铲';
  if (room.variant === 'entertainment_multi') return '多人';
  return room.ranked ? '排位' : '普通';
}
export const recruitmentName = room => room.name || `${room.hostName || '博士'}的同盟`;
export function recruitmentStage(room) {
  const stage = room.stage;
  if (!stage) return '关卡：开局抽取';
  const value = typeof stage === 'string' ? stage : stage.id || stage.stageId;
  const data = value && getStage(value);
  return `关卡：${data?.name || (typeof stage === 'object' && stage.name) || value || '开局抽取'}`;
}

export function RecruitmentPreview({ rooms = [], online, onOpen }) {
  const gesture = useRef({ x: 0, y: 0, moved: false });
  const down = e => { gesture.current = { x: e.clientX, y: e.clientY, moved: false }; };
  const move = e => { if (Math.hypot(e.clientX - gesture.current.x, e.clientY - gesture.current.y) > 6) gesture.current.moved = true; };
  const open = e => { if (e.detail === 0 || !gesture.current.moved) onOpen(); };
  return html`<button type="button" class="hub-recruitment" onPointerDown=${down} onPointerMove=${move} onClick=${open} aria-label="打开招募大厅，查看缺人同盟">
    <span class="hub-recruitment__heading"><span><${Icon} name="users" />缺人同盟</span><b>${rooms.length}</b><${Icon} name="chevronRight" /></span>
    <span class="hub-recruitment__list" aria-label="正在招募的同盟">
      ${online && rooms.length ? rooms.map(room => html`<span class="hub-recruitment__row" key=${recruitmentKey(room)}>
        <span class="hub-recruitment__name">${recruitmentName(room)}</span>
        <span class="hub-recruitment__facts"><span class="hub-recruitment__mode">${recruitmentMode(room)}</span><span>${recruitmentServerName(room)}</span><span>${DIFFICULTY_NAMES[room.difficulty] || room.difficulty}</span><b>缺 ${room.missing} 人</b></span>
        <span class="hub-recruitment__seatsline"><span class="hub-recruitment__seats" style=${`--recruit-capacity:${room.capacity}`} aria-label=${`${room.occupied}/${room.capacity} 席已入座`}>${Array.from({length:room.capacity},(_,i)=>html`<i class=${room.seats?.some(s=>s.seat===i)?'is-occupied':''} key=${i}></i>`)}</span><span class="hub-recruitment__join">加入 ›</span></span>
      </span>`) : html`<span class="hub-recruitment__empty">${online ? '暂无招募 · 点击进入大厅' : '连接后查看招募'}</span>`}
    </span>
    <span class="hub-recruitment__more">招募大厅<${Icon} name="chevronRight" /></span>
  </button>`;
}

export function RecruitmentHall({ rooms = [], online, busy, onJoin, onBack }) {
  useData('stages');
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const refresh = async () => {
    if (pending.current || !online) return;
    pending.current = true; setRefreshing(true); setError('');
    try { await net.request('recruitment.list', {}); }
    catch (err) { setError(describeError(err)); }
    finally { pending.current = false; setRefreshing(false); }
  };
  return html`<div class="screen spectator-hall recruitment-hall">
    <header class="spectator-hall__header recruitment-hall__header"><button type="button" onClick=${onBack}><${Icon} name="chevronLeft" />返回大厅</button>
      <div><h1>招募大厅</h1><p>已发送房间邀请的缺人同盟</p></div><button type="button" disabled=${!online || refreshing} onClick=${refresh}><${Icon} name="refresh" />${refreshing ? '刷新中…' : '刷新'}</button></header>
    ${error ? html`<p role="alert">${error}</p>` : null}
    <div class="spectator-hall__list recruitment-hall__list screen__scroll" aria-live="polite">
      ${!online ? html`<p class="recruitment-hall__empty">连接中断，恢复后自动更新。</p>` : !rooms.length ? html`<div class="recruitment-hall__empty"><${Icon} name="users" /><h2>暂无缺人同盟</h2><p>在房间聊天中发送房间码邀请后，同盟会出现在这里。<br />满员、开始游戏或房间解散后自动移除。</p></div>` : rooms.map(room => html`<article class="spectator-hall__card recruitment-card" key=${recruitmentKey(room)}>
        <div class="recruitment-card__head"><span class=${`recruitment-tag${room.ranked ? ' recruitment-tag--ranked' : ''}`}>${recruitmentMode(room)}</span><h2>${recruitmentName(room)}</h2><span class="recruitment-card__code">${room.code}</span></div>
        <div class="recruitment-card__facts"><span>${recruitmentServerName(room)}</span><span>${DIFFICULTY_NAMES[room.difficulty] || room.difficulty || '标准'}</span><span>${room.containerName ? `容器：${room.containerName}` : recruitmentStage(room)}</span><b>缺 ${room.missing} 人</b></div>
        <div class="recruitment-card__bottom"><div class="recruitment-seats" aria-label=${`已入座 ${room.occupied} 人，共 ${room.capacity} 席`}>
          ${Array.from({ length: room.capacity }, (_, i) => { const seat = room.seats?.find(s => s.seat === i); return html`<span class=${`recruitment-seat${seat ? ' is-occupied' : ''}`} title=${seat ? `${seat.name}${seat.isBot ? '（AI）' : ''}` : '空闲席位'} key=${i}><${Icon} name=${seat ? 'user' : 'plus'} /></span>`; })}
          <span class="recruitment-seats__count">${room.occupied}/${room.capacity}</span></div>
          <button type="button" class="recruitment-card__join" disabled=${!online || !!busy} onClick=${() => onJoin(room)}>${busy === `recruit:${recruitmentKey(room)}` ? '加入中…' : '加入同盟'}<${Icon} name="chevronRight" /></button></div>
      </article>`)}
    </div>
  </div>`;
}
