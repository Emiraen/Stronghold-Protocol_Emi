// The same communication state and compact-landscape geometry used by MatchScreen.
import { useEffect, useRef } from '../../vendor/hooks.module.js';
import { useTicker } from './components.js';
import { activeBubbles, battleEmotes, battleChatDanmaku } from './gameLogic/watch.js';
import { useStore } from '../store.js';
import { audio } from '../audio.js';

export function useMatchCommunication(pub, myId, config) {
  const emotes = useStore(s => s.emotes);
  const chat = useStore(s => s.matchChat);
  const now = Date.now();
  const bubbles = activeBubbles(emotes, now, (config?.timers?.chatBubble ?? 3) * 1000);
  const danmaku = [...battleEmotes(emotes, pub, myId, now), ...battleChatDanmaku(chat?.items, pub, myId, now)]
    .sort((a, b) => a.seq - b.seq);
  useTicker(bubbles.size || danmaku.length ? 250 : 0);
  const last = useRef(emotes.length ? emotes[emotes.length - 1].seq : 0);
  useEffect(() => {
    const event = emotes[emotes.length - 1];
    if (event && event.seq > last.current) {
      last.current = event.seq;
      if (event.playerId !== myId) audio.sfx('emote', { volume: 0.6 });
    }
  }, [emotes]);
  return { bubbles, danmaku };
}

export function useMatchHudLayout(hudRef, variant) {
  useEffect(() => {
    const hud = hudRef.current;
    if (!hud) return undefined;
    const measure = () => {
      const { width, height } = hud.getBoundingClientRect();
      if (!matchMedia('(pointer: coarse) and (max-height: 600px) and (orientation: landscape)').matches) {
        hud.parentElement.style.removeProperty('--battle-ui-unit');
        hud.parentElement.style.removeProperty('--battle-top');
        return;
      }
      const controlScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-scale')) || 1;
      const unit = Math.sqrt(Math.max(1, width * height) / (844 * 390)) * controlScale;
      hud.parentElement.style.setProperty('--battle-ui-unit', `${unit}px`);
      hud.parentElement.style.setProperty('--battle-top', `${84 * unit}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(hud); window.addEventListener('resize', measure); measure();
    return () => {
      observer.disconnect(); window.removeEventListener('resize', measure);
      hud.parentElement.style.removeProperty('--battle-ui-unit'); hud.parentElement.style.removeProperty('--battle-top');
    };
  }, [hudRef]);
  useEffect(() => {
    const hud = hudRef.current, team = hud?.querySelector('.team');
    const row = team?.querySelector('.team__row'), bonds = hud?.querySelector('.gm__bonds');
    if (!team || !row || !bonds) return undefined;
    const place = () => {
      if (!matchMedia('(pointer: coarse) and (max-height: 600px) and (orientation: landscape)').matches) {
        team.style.removeProperty('--team-top'); return;
      }
      const tr = team.getBoundingClientRect(), rr = row.getBoundingClientRect();
      const hr = hud.getBoundingClientRect(), br = bonds.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 40;
      const bubbleHeight = Math.max(.97 * rem, 48.5);
      const top = br.bottom + 4 + bubbleHeight * 46 / 97 - rr.height / 2 - (rr.top - tr.top) - hr.top;
      team.style.setProperty('--team-top', `${Math.max(0, top)}px`);
    };
    const observer = new ResizeObserver(place);
    for (const el of [hud, team, row, bonds]) observer.observe(el);
    place();
    return () => { observer.disconnect(); team.style.removeProperty('--team-top'); };
  }, [hudRef, variant]);
}
