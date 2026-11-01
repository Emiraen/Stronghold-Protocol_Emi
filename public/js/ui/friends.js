import { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, AvatarFrame, Spinner, Overlay, Modal, isTopOverlay } from './components.js';
import { toast, toastError } from './toasts.js';
import { data, useData } from '../data.js';
import { cardOperators, seatAvatar } from './seatArt.js';
import { useStore, store, selectRoute, emptyMatch } from '../store.js';
import { friendsStore, friendAction, unreadFriendMessages } from '../friends.js';
import { joinRoom, watchMatch } from '../servers.js';
import { net } from '../net.js';
import { rankIconUrl, normalizeRankLabel } from '../../../shared/ranks.js';
import { friendPresenceText } from '../../../shared/friends.js';
import { FRIEND_MESSAGE_MAX_LENGTH } from '../../../shared/friendMessages.js';
import { localFriendMessages, onFriendMessageCache } from '../friendMessageCache.js';

const TABS = [['list', '好友列表', 'users'], ['add', '添加好友', 'user'], ['requests', '好友申请', 'user'], ['recommend', '推荐好友', 'refresh']];
const useFriends = selector => useStore(selector, Object.is, friendsStore);

export function FriendRequestDot() {
  const count = useFriends(s => s.requests.length);
  return count ? html`<span class="friends-dot" role="status" aria-label=${`${count}条新好友申请`}></span>` : null;
}

export function FriendActivityDot() {
  const count = useFriends(s => s.requests.length + unreadFriendMessages(s));
  return count ? html`<span class="friends-dot" role="status" aria-label="新的好友申请或私信"></span>` : null;
}

export function FriendMessageDot({ targetId }) {
  const count = useFriends(s => unreadFriendMessages(s, targetId));
  return count ? html`<span class="friends-dot friends-dot--message" role="status" aria-label=${`${count}条未读私信`}></span>` : null;
}

export function FriendMessageDialog({ player, onClose }) {
  const self = useFriends(s => s.selfId);
  const cacheError = useFriends(s => s.cacheError || '');
  const latest = useFriends(s => (s.threads || []).find(thread => thread.targetId === player.id)?.lastSeq || 0);
  const online = useStore(s => s.connection.status === 'online');
  const [items, setItems] = useState([]), [text, setText] = useState(''), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [sending, setSending] = useState(false), [older, setOlder] = useState(false);
  const scroll = useRef(null), currentItems = useRef([]), atBottom = useRef(true), read = useRef(0), pending = useRef(null), active = useRef(true);
  const olderBusy = useRef(false), sendBusy = useRef(false);
  useEffect(() => () => { active.current = false; }, []);
  const merge = incoming => {
    const bySeq = new Map(currentItems.current.map(item => [item.seq, item]));
    for (const item of incoming) bySeq.set(item.seq, item);
    const rows = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    currentItems.current = rows; setItems(rows);
  };
  const markRead = async () => {
    const last = currentItems.current.at(-1)?.seq || 0;
    if (!active.current || !online || document.visibilityState === 'hidden' || !atBottom.current || last <= read.current) return;
    const before = read.current; read.current = last;
    try { await friendAction('message.read', { targetId: player.id, throughSeq: last }); await friendAction('list'); }
    catch { if (read.current === last) read.current = before; }
  };
  useEffect(() => {
    let alive = true;
    const load = () => localFriendMessages(self, player.id).then(result => {
      if (!alive) return; merge(result.items); if (result.hasOlder) setOlder(true);
      requestAnimationFrame(() => { if (alive && atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
    }).catch(() => { if (alive) setError('无法读取本机私信记录'); });
    void load();
    const off = onFriendMessageCache((account, target) => { if (account === self && target === player.id) void load(); });
    return () => { alive = false; off(); };
  }, [self, player.id]);
  useEffect(() => {
    let alive = true;
    if (!online) { setLoading(false); return; }
    friendAction('message.list', { targetId: player.id }).then(result => {
      if (!alive) return;
      const initial = !currentItems.current.length;
      merge(result.items); if (initial) setOlder(result.hasOlder);
      setError('');
      requestAnimationFrame(() => { if (!alive) return; if (atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; void markRead(); });
    }, err => { if (alive) setError(err.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [player.id, latest, online]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState !== 'hidden') void markRead(); };
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [online]);
  const loadOlder = async () => {
    if (olderBusy.current || !currentItems.current.length) return;
    olderBusy.current = true; setLoading(true);
    const height = scroll.current?.scrollHeight || 0, top = scroll.current?.scrollTop || 0;
    try {
      const beforeSeq = currentItems.current[0].seq;
      if (online) await friendAction('message.list', { targetId: player.id, beforeSeq });
      const result = await localFriendMessages(self, player.id, beforeSeq);
      if (!active.current) return;
      atBottom.current = false; merge(result.items); setOlder(result.hasOlder);
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = top + scroll.current.scrollHeight - height; });
    } catch (err) { if (active.current) setError(err.message); }
    finally { olderBusy.current = false; if (active.current) setLoading(false); }
  };
  const send = async event => {
    event.preventDefault();
    const value = text.trim(); if (!value || sendBusy.current || !online) return;
    sendBusy.current = true; setSending(true); setError('');
    if (!pending.current || pending.current.text !== value) pending.current = { text: value, clientId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') };
    try {
      const result = await friendAction('message.send', { targetId: player.id, ...pending.current });
      pending.current = null;
      if (!active.current) return;
      atBottom.current = true; merge([result.message]); setText('');
      await friendAction('list');
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; void markRead(); });
    } catch (err) { if (active.current) setError(err.message); }
    finally { sendBusy.current = false; if (active.current) setSending(false); }
  };
  return html`<${Modal} open=${true} title=${`与 ${player.name} 私信`} onClose=${onClose} width="min(660px, 94vw)">
    <div class="friend-chat" data-chat-target=${player.id}>
      <div class="friend-chat__messages" ref=${scroll} role="log" aria-label="私信记录" aria-live="polite" onScroll=${() => {
        const el = scroll.current; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 36; if (atBottom.current) void markRead();
      }}>
        ${older ? html`<button type="button" class="friend-chat__older" disabled=${loading} onClick=${loadOlder}>更早消息</button>` : null}
        ${loading && !items.length ? html`<${Spinner} size="sm" label="加载私信" />` : !items.length ? html`<p class="friends-empty">暂无私信</p>` : null}
        ${items.map(item => html`<article key=${item.seq} class=${`friend-chat__message${item.from === self ? ' is-mine' : ''}`} data-message-seq=${item.seq}>
          <small>${item.from === self ? '我' : player.name} · ${new Date(item.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small><p>${item.text}</p></article>`)}
      </div>
      ${error || cacheError ? html`<p class="friends-error" role="alert">${error || cacheError}</p>` : null}
      <form class="friend-chat__compose" onSubmit=${send}>
        <textarea aria-label="私信内容" rows="2" maxlength=${FRIEND_MESSAGE_MAX_LENGTH} value=${text} disabled=${sending}
          onInput=${event => setText(event.currentTarget.value)}></textarea>
        <${Button} type="submit" disabled=${!online || sending || !text.trim()} loading=${sending}>发送<//>
      </form>
    </div>
  <//>`;
}

function useDialogKeyboard(ref, onClose) {
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = ref.current;
    element?.focus();
    const key = event => {
      if (!element || !isTopOverlay(element)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); }
      if (event.key !== 'Tab') return;
      const focusable = [...element.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter(el => el.getClientRects().length);
      if (!focusable.length) { event.preventDefault(); return element.focus(); }
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
}

function FriendSurface({ onClose, compact, anchor, children, title = '好友列表' }) {
  return html`<${Overlay} level=${compact ? 'controls' : 'hall'}><${FriendSurfaceBody} onClose=${onClose} compact=${compact} anchor=${anchor} title=${title}>${children}<//><//>`;
}
function FriendSurfaceBody({ onClose, compact, anchor, children, title }) {
  const ref = useRef(null);
  useDialogKeyboard(ref, onClose);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  const width = Math.min(viewport.width <= 950 ? 300 : 320, viewport.width - 20);
  const style = compact ? { width: `${width}px`, left: `${Math.max(10, Math.min(anchor?.left || 10, viewport.width - width - 10))}px`,
    top: `${Math.min(anchor?.bottom + 8 || 60, Math.max(10, viewport.height - 280))}px`,
    maxHeight: `${Math.max(220, viewport.height - Math.min(anchor?.bottom + 8 || 60, Math.max(10, viewport.height - 280)) - 10)}px` } : undefined;
  return html`<div class=${compact ? 'friends-menu-backdrop' : 'friends-hall-backdrop'} onClick=${onClose}>
    <section ref=${ref} tabindex="-1" class=${`friends-surface ${compact ? 'friends-menu' : 'friends-hall proto east-hall'}`} style=${style}
      role="dialog" aria-modal="true" aria-label=${title} onClick=${event => event.stopPropagation()}>
      <header class="friends-head"><button type="button" class="friends-back" onClick=${onClose} aria-label=${compact ? '关闭好友列表' : '返回大厅'}><${Icon} name=${compact ? 'close' : 'chevronLeft'} /></button>
        <div><h2>${title}</h2><small>FRIENDS</small></div></header>${children}
    </section></div>`;
}

function usePortraits() {
  useData('chess', 'assets', 'backups');
  const chess = data.get('chess'), backups = data.get('backups'), m = data.get('assets');
  return useMemo(() => { const pool = cardOperators(data.list('chess'), backups); return { pool, byChar: new Map(pool.map(c => [c.charId, c])), m }; }, [chess, backups, m]);
}

export function FriendCard({ player, onOpen, children }) {
  const portraits = usePortraits();
  const avatar = seatAvatar({ playerId: player.id, card: player.card, cardSkin: player.cardSkin || 'original' }, portraits);
  const fallback = player.cardSkin ? seatAvatar({ playerId: player.id, card: player.card, cardSkin: 'original' }, portraits) : null;
  const online = !!player.presence && player.presence.state !== 'offline';
  return html`<article class="friends-card" data-friend-id=${player.id}>
    <button class="friends-card__identity" type="button" onClick=${() => onOpen(player.id)} aria-label=${`查看${player.name}的排位信息`}>
      <${AvatarFrame} size="sm" name=${player.name} src=${avatar} fallbackSrc=${fallback} fallbackIcon="user" />
      <span class="friends-card__info"><b class="friends-card__name">${player.name}</b>
        <span class="friends-card__rank"><img src=${rankIconUrl(player.rank?.rank?.icon || 'unranked')} alt="" /><span>${normalizeRankLabel(player.rank?.rank?.label) || '未定级'}</span></span>
        <span class=${`friends-card__presence${online ? ' is-online' : ''}`}><i></i>${player.presence?.state === 'playing' ? '正在游戏中 · ' : ''}${friendPresenceText(player.presence)}</span>
      </span></button>
    ${children ? html`<div class="friends-card__actions">${children}</div>` : null}
  </article>`;
}

function useFriendActions() {
  const [busy, setBusy] = useState(''), active = useRef(true), pending = useRef(false);
  useEffect(() => () => { active.current = false; }, []);
  const run = async (action, fields, message) => {
    if (pending.current) return null;
    pending.current = true; setBusy(`${action}:${fields?.targetId || ''}`);
    try {
      const result = await friendAction(action, fields);
      await friendAction('list').catch(() => {}); // The committed action is still successful; push sync will retry the display.
      if (message) toast(message, 'success');
      return result;
    } catch (error) { toastError(error); return null; }
    finally { pending.current = false; if (active.current) setBusy(''); }
  };
  return [busy, run];
}

export function FriendsHall({ onClose, compact = false, anchor, initialTab = 'list' }) {
  const state = useFriends(s => s);
  const online = useStore(s => s.connection.status === 'online');
  const room = useStore(s => s.room);
  const [tab, setTab] = useState(initialTab), [query, setQuery] = useState(''), [items, setItems] = useState([]);
  const [searching, setSearching] = useState(false), [error, setError] = useState(''), [target, setTarget] = useState(null);
  const [chat, setChat] = useState(null);
  useEffect(() => { setChat(null); }, [state.selfId]);
  const [busy, run] = useFriendActions();
  const searchGeneration = useRef(0), mounted = useRef(true);
  useEffect(() => {
    friendAction('list').catch(err => { if (mounted.current) setError(err.message); });
    return () => { mounted.current = false; searchGeneration.current++; };
  }, []);
  const search = async (action = 'search') => {
    const generation = ++searchGeneration.current;
    setSearching(true); setError('');
    try { const result = await friendAction(action, action === 'search' ? { query: query.trim() } : {});
      if (mounted.current && searchGeneration.current === generation) setItems(result.items || []);
    } catch (err) { if (mounted.current && searchGeneration.current === generation) { setItems([]); setError(err.message); } }
    finally { if (mounted.current && searchGeneration.current === generation) setSearching(false); }
  };
  useEffect(() => {
    searchGeneration.current++; setItems([]); setError(''); setSearching(false);
    if (tab === 'recommend') void search('recommend');
  }, [tab]);
  const request = player => run('request', { targetId: player.id }, '好友申请已发送');
  const addButton = player => {
    const added = state.friends.some(friend => friend.id === player.id), sent = state.outgoing.includes(player.id);
    return html`<${Button} size="sm" disabled=${!online || !!busy || added || sent} onClick=${() => request(player)}>${added ? '已是好友' : sent ? '已申请' : '添加好友'}<//>`;
  };
  const inviting = compact && room && !room.inMatch && room.mode === 'coop' && room.seats?.some(seat => !seat);
  const visible = tab === 'list' ? state.friends : tab === 'requests' ? state.requests.map(row => row.player) : items;
  const tabs = compact ? [TABS[2], TABS[0]] : TABS;
  const watch = async player => {
    try {
      if (selectRoute(store.get()) === 'game') throw new Error('请先结束当前对局或观战');
      if (store.get().room) {
        await net.request('room.leave', {});
        store.set({ room: null, match: emptyMatch() });
      }
      if (await watchMatch(player.presence.watch)) onClose();
    } catch (err) { toastError(err); }
  };
  return html`${!target ? html`<${FriendSurface} compact=${compact} anchor=${anchor} onClose=${onClose} title=${compact ? tab === 'requests' ? '好友申请' : '好友列表' : '好友列表'}>
    <div class="friends-layout"><nav class="friends-tabs" aria-label="好友功能">${tabs.map(([key, title, icon]) => html`<button type="button" key=${key} class=${tab === key ? 'is-active' : ''} aria-current=${tab === key ? 'page' : undefined} onClick=${() => setTab(key)}><${Icon} name=${icon} /><span>${title}</span>${key === 'requests' ? html`<${FriendRequestDot} />` : key === 'list' && state.threads?.some(thread => thread.unread) ? html`<span class="friends-dot" aria-label="未读私信"></span>` : null}</button>`)}</nav>
      <main class="friends-main">
        <header class="friends-main__head"><h3>${TABS.find(item => item[0] === tab)?.[1]}</h3>
          ${tab === 'list' ? html`<span class="num">${state.friends.length}</span>` : null}
          <${Button} size="sm" variant="ghost" icon="refresh" disabled=${!online || searching || !!busy} onClick=${() => tab === 'recommend' ? search('recommend') : tab === 'add' ? search() : friendAction('list').catch(toastError)}>刷新<//></header>
        ${tab === 'add' ? html`<form class="friends-search" onSubmit=${event => { event.preventDefault(); if (query.trim()) search(); }}><label for="friends-search-name">玩家姓名</label><div><input id="friends-search-name" type="search" value=${query} maxlength="64" placeholder="搜索玩家姓名" onInput=${event => setQuery(event.currentTarget.value)} /><${Button} type="submit" disabled=${!online || searching || !query.trim()} loading=${searching}>搜索<//></div></form>` : null}
        ${error || state.error ? html`<p class="friends-error" role="alert">${error || state.error}</p>` : null}
        <div class="friends-list" aria-live="polite">${searching || !state.loaded && !error ? html`<div class="friends-empty"><${Spinner} size="sm" label="正在加载好友" /></div>`
          : !visible.length ? html`<p class="friends-empty">${tab === 'list' ? '暂无好友' : tab === 'requests' ? '暂无好友申请' : tab === 'recommend' ? '暂无可推荐的在线玩家' : query.trim() ? '未找到对应玩家' : '输入玩家姓名搜索'}</p>`
            : visible.map(player => html`<${FriendCard} key=${player.id} player=${player} onOpen=${setTarget}>
              ${tab === 'requests' ? html`<${Button} size="sm" disabled=${!online || !!busy} onClick=${() => run('accept', { targetId: player.id }, '已添加好友')}>接受<//><${Button} size="sm" variant="secondary" disabled=${!online || !!busy} onClick=${() => run('reject', { targetId: player.id })}>忽略<//>`
                : tab === 'add' || tab === 'recommend' ? addButton(player)
                  : html`<${Button} size="sm" variant="secondary" class="friend-message-button" data-message-target=${player.id} onClick=${() => setChat(player)}>私信<${FriendMessageDot} targetId=${player.id} /><//>${player.presence?.watch ? html`<${Button} size="sm" variant="secondary" icon="eye" disabled=${!online || !!busy} onClick=${() => watch(player)}>观战<//>` : null}
                    ${compact ? html`<${Button} size="sm" disabled=${!online || !!busy || !inviting || player.presence?.state === 'offline'} onClick=${() => run('invite', { targetId: player.id }, player.presence?.state === 'playing' ? '预约已发送' : '邀请已发送')}>${player.presence?.state === 'playing' ? '预约好友' : '邀请好友'}<//>` : html`<${Button} size="sm" variant="danger" disabled=${!online || !!busy} onClick=${() => run('remove', { targetId: player.id }, '已删除好友')}>删除好友<//>`}`}
            <//>`)}</div>
      </main></div>
  <//>` : html`<${FriendProfile} key=${target} targetId=${target} onClose=${() => setTarget(null)} />`}
    ${chat ? html`<${FriendMessageDialog} key=${state.selfId + ':' + chat.id} player=${chat} onClose=${() => setChat(null)} />` : null}`;
}

export function FriendProfile({ targetId, onClose }) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [rankUI, setRankUI] = useState(null);
  const [leaderboard, setLeaderboard] = useState(false), [help, setHelp] = useState(false);
  const online = useStore(s => s.connection.status === 'online');
  useEffect(() => {
    let active = true;
    Promise.all([friendAction('profile', { targetId }), import('../screens/lobby.js')]).then(([profile, components]) => {
      if (active) { setValue(profile); setRankUI(components); }
    }, err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [targetId]);
  if (!value || !rankUI) return html`<${Modal} open=${true} title="玩家排位信息" onClose=${onClose}>${error ? html`<p role="alert">${error}</p>` : html`<${Spinner} label="正在读取排位档案" />`}<//>`;
  if (leaderboard) return html`<${rankUI.RankLeaderboard} targetId=${targetId} targetName=${value.player.name} onClose=${() => setLeaderboard(false)} />`;
  return html`<${rankUI.RankHall} rank=${value.player.rank} me=${{ playerId: targetId, name: value.player.name }} online=${online}
    targetId=${targetId} historyItems=${value.items || []} onBack=${onClose} onLeaderboard=${() => setLeaderboard(true)} onHelp=${() => setHelp(true)} />
    <${rankUI.RankHelp} open=${help} onClose=${() => setHelp(false)} />`;
}

export function RoomFriendsButton({ forceOpen = 0 }) {
  const [open, setOpen] = useState(false), [anchor, setAnchor] = useState(null);
  const ref = useRef(null);
  const toggle = value => { setAnchor(ref.current?.getBoundingClientRect()); setOpen(value); };
  useEffect(() => { if (forceOpen) toggle(true); }, [forceOpen]);
  return html`<button ref=${ref} type="button" class="btn btn--secondary btn--sm btn--square friends-room-button" aria-label="好友列表" title="好友列表" aria-expanded=${open} onClick=${() => toggle(!open)}><${Icon} name="users" /><${FriendActivityDot} /></button>
    ${open ? html`<${FriendsHall} compact=${true} anchor=${anchor} onClose=${() => setOpen(false)} />` : null}`;
}

export function RoomPlayerMenu({ player, anchor, onClose }) {
  const friends = useFriends(s => s.friends), outgoing = useFriends(s => s.outgoing);
  const [target, setTarget] = useState(false), [busy, run] = useFriendActions();
  const added = friends.some(friend => friend.id === player.profileId), sent = outgoing.includes(player.profileId);
  if (target) return html`<${FriendProfile} targetId=${player.profileId} onClose=${onClose} />`;
  return html`<${FriendSurface} compact=${true} anchor=${anchor} title=${player.name} onClose=${onClose}>
    <div class="friends-player-actions"><${Button} disabled=${!!busy || added || sent || !player.profileId} onClick=${async () => { if (await run('request', { targetId: player.profileId }, '好友申请已发送')) onClose(); }}>${added ? '已是好友' : sent ? '已申请' : '添加好友'}<//>
      <${Button} variant="secondary" disabled=${!player.profileId} onClick=${() => setTarget(true)}>查看玩家战绩<//></div>
  <//>`;
}

/** Mounted above route screens so invitations also arrive during games and survive room changes. */
export function FriendInvitationHost() {
  const invitations = useFriends(s => s.invitations), online = useStore(s => s.connection.status === 'online');
  const [now, setNow] = useState(Date.now()), [mute, setMute] = useState(false), [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState([]);
  const invite = invitations.find(row => row.status !== 'reserved' && row.expiresAt > now && !hidden.includes(`${row.id}:${row.status}`));
  useEffect(() => {
    if (!invitations.length) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [invitations]);
  useEffect(() => { setMute(false); }, [invite?.id]);
  const respond = async accept => {
    if (!invite || busy) return;
    setBusy(true);
    try {
      const result = await friendAction('respond', { inviteId: invite.id, accept, mute });
      if (result.join) {
        if (selectRoute(store.get()) === 'game') { toast('请先结束当前对局或观战，再加入好友房间', 'warn'); return; }
        if (!await joinRoom(result.join)) return;
      }
      if (result.reserved) toast('已预约好友，离开当前对局后将提示加入', 'success');
      setHidden(ids => [...ids.slice(-99), `${invite.id}:${invite.status}`]);
      await friendAction('list');
    } catch (err) { toastError(err); }
    finally { setBusy(false); }
  };
  return html`<${Modal} open=${!!invite && online} title=${invite?.kind === 'reservation' && invite?.status !== 'ready' ? '好友预约' : '好友邀请'} micro="FRIEND INVITATION" onClose=${() => respond(false)} closeDisabled=${busy}
    actions=${html`<${Button} variant="secondary" disabled=${busy} onClick=${() => respond(false)}>忽略<//><${Button} disabled=${busy} loading=${busy} onClick=${() => respond(true)}>确定<//>`}>
    <p class="friends-invite-text">${`好友${invite?.from?.name || ''}邀请您加入${invite?.modeName || ''}模式房间`}</p>
    <label class="friends-mute"><input type="checkbox" checked=${mute} disabled=${busy} onChange=${event => setMute(event.currentTarget.checked)} /><span>忽略所有该玩家邀请</span></label>
  <//>`;
}
