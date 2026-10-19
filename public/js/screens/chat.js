import { t as trA } from '../../../shared/i18n.js';
import { useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Overlay, Icon, CloseButton, isTopOverlay } from '../ui/components.js';
import { usePresence } from '../ui/transitions.js';
import { toast, toastError } from '../ui/toasts.js';
import { net } from '../net.js';
import { joinRoom } from '../servers.js';
import { visibleViewport } from '../ui/device.js';
import { store, useStore, selectRoute } from '../store.js';

const MAX_MESSAGES = 50;
const MAX_TEXT = 200;

function messageTime(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function ChatPanel({ roomCode = null, online, me, channel = 'lobby' }) {
  const chat = useStore((s) => channel === 'match' ? s.matchChat : s.chat);
  const room = useStore((s) => s.room);
  const route = useStore(selectRoute);
  const inLobby = route === 'lobby';
  const phase = useStore((s) => channel === 'match' ? s.match.public?.phase : null);
  const items = Array.isArray(chat?.items) ? chat.items.slice(-MAX_MESSAGES) : [];
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null);
  const [unread, setUnread] = useState(0);
  const [newBelow, setNewBelow] = useState(0);
  const [panelMounted, leaving] = usePresence(open, 160);
  // Keep the expanded dock until its exit finishes; collapsing it first moves the still-visible panel.
  const expanded = panelMounted;
  const [bounds, setBounds] = useState(null);
  const chatRef = useRef(null);
  useLayoutEffect(() => {
    const selector = channel === 'match' ? '.gm__corner, .gm__chat-slot, .gtop' : roomCode ? '.room-fill, .room-bar, .room-screen .topbar, .ally-guide' : '.lobby-screen .topbar, .ally-guide';
    const update = () => {
      const v = visibleViewport();
      const css = getComputedStyle(document.documentElement);
      const inset = (side) => parseFloat(css.getPropertyValue(`--sa-${side}`)) || 0;
      const cornerNode = channel === 'match' ? document.querySelector('.gm__corner') : null;
      const slotNode = cornerNode?.querySelector('.gm__chat-slot');
      const launcher = chatRef.current?.querySelector('.sp-chat__toggle');
      // Reserve the unscaled size: the toolbar and floating launcher share the same mobile scale.
      // Keep that reservation while the panel opens and finishes its exit animation.
      if (slotNode && !expanded && launcher?.offsetWidth && launcher?.offsetHeight) {
        for (const [name, value] of [['width', launcher.offsetWidth], ['height', launcher.offsetHeight]]) {
          const size = `${value}px`;
          if (cornerNode.style.getPropertyValue(`--sp-chat-launcher-${name}`) !== size) {
            cornerNode.style.setProperty(`--sp-chat-launcher-${name}`, size);
          }
        }
      }
      const slot = slotNode?.getBoundingClientRect();
      let top = v.top + inset('t') + 8;
      const raisedPublic = channel === 'lobby' && route !== 'title' && route !== 'game';
      let bottom = v.bottom - inset('b') - 8 - (raisedPublic ? 52 : 0);
      if (raisedPublic) {
        const chatBox = chatRef.current?.getBoundingClientRect();
        for (const guide of document.querySelectorAll('.ally-guide')) {
          const r = guide.getBoundingClientRect();
          if (r.width && r.height && (!chatBox || r.left < chatBox.right && r.right > chatBox.left)) bottom = Math.min(bottom, r.top - 8);
        }
      }
      for (const node of document.querySelectorAll(selector)) {
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (node.matches('.gm__corner')) {
          document.documentElement.style.setProperty('--sp-corner-width', `${Math.ceil(r.width)}px`);
        }
        if (node.matches('.gtop')) {
          const chat = chatRef.current?.getBoundingClientRect();
          for (const child of node.children) {
            const c = child.getBoundingClientRect();
            if (!chat || c.left < chat.right && c.right > chat.left) top = Math.max(top, c.bottom + 8);
          }
        } else if (node.matches('.topbar')) top = Math.max(top, r.bottom + 8);
        // The room footer reserves a left dock for the collapsed chat launcher.
        // Raising it above the footer instead covers the first player's identity.
        else if (!expanded && !(channel === 'match' || (channel === 'lobby' && roomCode && node.matches('.room-bar')))) bottom = Math.min(bottom, r.top - 8);
      }
      // Apply the extra clearance after measuring obstacles so every public screen moves up equally.
      if (raisedPublic) bottom -= 24;
      if (channel === 'lobby') bottom -= 30;
      const tight = bottom - top < 176;
      const toggle = expanded && (v.keyboard || tight || v.height <= 600) ? 0 : chatRef.current?.querySelector('.sp-chat__toggle')?.getBoundingClientRect().height || 44;
      const available = Math.max(0, bottom - top - toggle - (toggle ? 4 : 0));
      const launcherLeft = channel === 'match' && !expanded && slot?.width
        ? slot.left : null;
      const launcherBottom = channel === 'match' && !expanded && slot?.height
        ? Math.max(0, innerHeight - slot.bottom) : null;
      if (raisedPublic && !expanded) {
        const side = document.querySelector('.east-hub .hub-side');
        if (side) {
          const top = side.getBoundingClientRect().top;
          side.style.setProperty('--public-chat-side-height', `${Math.max(0, bottom - toggle - 8 - top)}px`);
        }
      }
      const next = { bottom: launcherBottom ?? Math.max(v.bottomGap + inset('b') + 8, innerHeight - bottom), left: launcherLeft,
        height: available, keyboard: v.keyboard, tight };
      setBounds((prev) => prev && prev.bottom === next.bottom && prev.left === next.left && prev.height === next.height && prev.keyboard === next.keyboard && prev.tight === next.tight ? prev : next);
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    document.querySelectorAll(selector).forEach((node) => observer?.observe(node));
    // 房间补齐区和对局工具栏会随状态挂载/折叠，不能只观察首次出现的节点。
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(() => {
      document.querySelectorAll(selector).forEach((node) => observer?.observe(node));
      update();
    }) : null;
    const screen = document.querySelector(channel === 'match' ? '.gm__hud' : roomCode ? '.room-screen' : '.lobby-screen');
    if (screen) mutations?.observe(channel === 'lobby' ? document.body : screen, { childList: true, subtree: true });
    const toggle = chatRef.current?.querySelector('.sp-chat__toggle');
    if (toggle) observer?.observe(toggle);
    window.addEventListener('resize', update);
    if (channel === 'lobby') document.addEventListener('animationend', update, true);
    globalThis.visualViewport?.addEventListener('resize', update);
    globalThis.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener('resize', update);
      if (channel === 'lobby') document.removeEventListener('animationend', update, true);
      globalThis.visualViewport?.removeEventListener('resize', update);
      globalThis.visualViewport?.removeEventListener('scroll', update);
    };
  }, [channel, roomCode, phase, expanded, route]);
  const busy = useRef(false);
  const list = useRef(null);
  const pinned = useRef(true);
  const previous = useRef(items.at(-1)?.id);
  const canInvite = channel === 'lobby' && !!roomCode && room?.mode !== 'solo' && !room?.inMatch;
  const canJoin = channel === 'lobby' && (inLobby || (!!room && !room.inMatch));
  const label = channel === 'match' ? trA("本局聊天") : trA("公共聊天");

  useLayoutEffect(() => {
    const last = items.at(-1)?.id;
    const added = last && last !== previous.current
      ? items.slice(Math.max(0, items.findIndex((item) => item.id === previous.current) + 1)).filter((item) => item.playerId !== me?.playerId).length : 0;
    if (open) setUnread(0);
    else if (last && last !== previous.current) {
      const index = items.findIndex((item) => item.id === previous.current);
      setUnread((n) => Math.min(99, n + items.slice(index + 1).filter((item) => item.playerId !== me?.playerId).length));
    }
    if (open && !pinned.current && added) setNewBelow((n) => Math.min(99, n + added));
    if (open && pinned.current) setNewBelow(0);
    previous.current = last;
    if (open && pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [open, chat?.items]);

  useLayoutEffect(() => {
    if (!open) return;
    const escape = (e) => {
      if (e.key !== 'Escape' || !isTopOverlay(chatRef.current)) return;
      e.preventDefault(); e.stopImmediatePropagation(); setOpen(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (event) => {
      const target = event.target;
      if (target instanceof Element && chatRef.current?.contains(target)) return;
      if (!isTopOverlay(chatRef.current)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open, channel]);

  const onScroll = () => {
    const node = list.current;
    if (node) {
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
      if (pinned.current) setNewBelow(0);
    }
  };
  const latest = () => {
    pinned.current = true; setNewBelow(0);
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const run = async (kind, request, after) => {
    if (busy.current) return;
    if (!online) { toast(trA("连接中断，请稍候重试"), 'warn'); return; }
    busy.current = true;
    setPending(kind);
    try { await request(); if (after) after(); } catch (err) { toastError(err); }
    finally { busy.current = false; setPending(null); }
  };
  const send = (event) => {
    event.preventDefault();
    const value = text.trim().slice(0, MAX_TEXT);
    if (!value) return;
    run('send', () => net.request('chat.send', { text: value, channel,
      ...(channel === 'match' ? { matchId: chat.matchId } : {}) }), () => { setText(''); latest(); });
  };
  const join = (target) => {
    if (!['lobby', 'room'].includes(selectRoute(store.get())) || store.get().room?.inMatch) {
      toast(trA("正在对局，无法切换同盟"), 'warn'); return;
    }
    run('join', () => joinRoom(target));
  };
  const keyboard = expanded && bounds?.keyboard;
  const style = bounds ? `${bounds.left == null ? '' : `left:${bounds.left}px;`}bottom:${bounds.bottom}px;--chat-available:${bounds.height}px;` : undefined;

  return html`<${Overlay} level="chat" active=${expanded}><aside ref=${chatRef} class=${`sp-chat${channel === 'match' ? ' sp-chat--match' : ''}${expanded ? ' is-expanded' : ''}${open ? ' is-open' : ''}${leaving ? ' is-leaving' : ''}${keyboard ? ' has-keyboard' : ''}${bounds?.tight && expanded ? ' is-tight' : ''}`} style=${style} aria-label=${label}>
    <button type="button" class="sp-chat__toggle" aria-label=${label} aria-expanded=${open} aria-controls="sp-chat-panel"
      onClick=${() => { pinned.current = true; setOpen(!open); }}><${Icon} name="users" class="sp-chat__compact-icon" /><span class="sp-chat__label">${label}</span>
      ${unread ? html`<span class="sp-chat__count" aria-label=${trA("{p0} 条未读", { "p0": (unread) })}>${unread}</span>` : null}<span class="sp-chat__state" aria-hidden="true">${open ? '−' : '+'}</span></button>
    ${panelMounted ? html`<div id="sp-chat-panel" class="sp-chat__panel" inert=${open ? undefined : ''} aria-hidden=${!open}>
      <div class="sp-chat__heading"><div class="sp-chat__channel"><small>${channel === 'match' ? 'SQUAD COMMS' : 'PUBLIC CHANNEL'}</small><strong>${label}</strong></div><span class=${`sp-chat__connection${online ? ' is-online' : ''}`} title=${online ? trA('已连接') : trA('连接中')}><i></i>${online ? trA('已连接') : trA('连接中')}</span>
        <${CloseButton} class="sp-chat__close" label=${trA("聊天")} onClose=${() => setOpen(false)} /></div>
      <div class="sp-chat__list" ref=${list} onScroll=${onScroll} role="log" aria-label=${trA("聊天消息")} aria-live="polite" aria-relevant="additions text">
        ${items.length ? items.map((item) => html`<article key=${item.id} class=${`sp-chat__message${item.playerId === me?.playerId ? ' is-mine' : ''}`}>
          <div class="sp-chat__meta"><span class="sp-chat__avatar" aria-hidden="true">${(item.name || trA('博士')).slice(0, 1)}</span><strong>${item.name || trA("博士")}${item.playerId === me?.playerId ? html`<small>${trA('我')}</small>` : null}</strong><time>${messageTime(item.at)}</time></div>
          ${item.kind === 'invite' ? html`<div class="sp-chat__invite"><${Icon} name="link" /><span><small>${trA("同盟邀请")}</small><b>${item.code}</b></span>
            <button type="button" disabled=${!online || !canJoin || pending !== null || !item.code || (item.code === room?.code && item.serverId === room?.serverId)}
              onClick=${() => join({ code: item.code, serverId: item.serverId })}>${trA("一键加入")}</button></div>` : html`<p class="sp-chat__text">${item.text || ''}</p>`}
        </article>`) : html`<p class="sp-chat__empty">${channel === 'match' ? trA("与本局队友交流战术。观众无法加入此频道。") : trA("暂无消息，向其他博士打个招呼吧。")}</p>`}
      </div>
      ${newBelow ? html`<button type="button" class="sp-chat__latest" onClick=${latest}>${trA('{p0} 条新消息', {p0: newBelow})}<${Icon} name="chevronRight" /></button>` : null}
      <form class="sp-chat__compose" onSubmit=${send}>
        <input type="text" value=${text} maxLength=${MAX_TEXT} placeholder=${trA("输入内容（最多 200 字）")} aria-label=${trA("聊天内容")}
          disabled=${!online || !!pending || (channel === 'match' && !chat.matchId)}
          onInput=${(event) => setText(event.currentTarget.value.slice(0, MAX_TEXT))}
          onKeyDown=${(event) => { if (event.key === 'Enter' && event.isComposing) event.preventDefault(); }} />
        <button type="submit" aria-label=${trA('发送消息')} disabled=${!online || !!pending || !text.trim()}><span>${pending === 'send' ? trA("发送中") : trA("发送")}</span><${Icon} name="chevrons" /></button>
      </form>
      ${canInvite ? html`<button type="button" class="sp-chat__share" disabled=${!online || !!pending}
        onClick=${() => run('invite', () => net.request('chat.invite', {}))}><${Icon} name="link" />${pending === 'invite' ? trA("发送中…") : trA("一键发送房间码")}<b>${roomCode}</b></button>` : null}
    </div>` : null}
  </aside><//>`;
}
