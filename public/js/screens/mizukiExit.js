import { h, Fragment } from '../ui/components.js';
import { useEffect } from '../../vendor/hooks.module.js';
import { createStore, useStore } from '../store.js';
import { ExitModal, AwayOverlay, awayStore } from '../ui/matchChrome.js';

const exitStore = createStore({ open: false });
export const requestMizukiExit = () => exitStore.set({ open: true });

// Keep Mizuki on the same exit and away controls as a normal Stronghold match.
export function MizukiExitModal({ open, onClose, solo, onAway }) {
  const singleSeat = useStore(s => (s.match.public?.players?.length || s.room?.players?.length || 1) === 1);
  return h(ExitModal, { open, onClose, solo: solo ?? singleSeat, onAway });
}

export function MizukiAwayOverlay() {
  const away = useStore(s => s.away, Object.is, awayStore);
  const visible = useStore(s => {
    const pub = s.match.public;
    const player = pub?.players?.find(p => p.playerId === s.me.playerId);
    const active = !!pub && !!s.room?.inMatch && !s.spectator && !s.match.result
      && pub.phase !== 'RESULT' && player && player.alive !== false && !player.left;
    return active && (away || player.autoplay === true);
  });
  return visible ? h(AwayOverlay) : null;
}

export function MizukiExitControls() {
  const open = useStore(s => s.open, Object.is, exitStore);
  useEffect(() => () => exitStore.set({ open: false }), []);
  return h(Fragment, {}, h(MizukiExitModal, { open, onClose: () => exitStore.set({ open: false }) }), h(MizukiAwayOverlay));
}
