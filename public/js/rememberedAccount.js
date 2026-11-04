// A small appearance snapshot for the explicitly remembered account. Credentials stay in identity.
import { identity, net } from './net.js';
import { data } from './data.js';
import { skinsStore } from './ui/skins.js';
import { cardOperators, seatAvatar } from './ui/seatArt.js';

const PROFILE_KEY = 'sp.remembered.account.profile';
const accountName = (value) => String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ');
const imageUrl = (value) => typeof value === 'string' && value.length <= 1024
  && /^(?:\/(?!\/)|https?:\/\/)/.test(value) ? value : null;

export function loadRememberedProfile(name) {
  try {
    const profile = JSON.parse(globalThis.localStorage?.getItem(PROFILE_KEY) || 'null');
    if (!profile || profile.name !== accountName(name)) return null;
    return { name: profile.name, avatar: imageUrl(profile.avatar), fallbackAvatar: imageUrl(profile.fallbackAvatar) };
  } catch { return null; }
}

export function clearRememberedProfile() {
  try { globalThis.localStorage?.removeItem(PROFILE_KEY); } catch { /* storage unavailable */ }
}

/** Uses authenticated profile pushes and existing loaded metadata; no requests or polling. */
export function rememberCurrentProfile() {
  const saved = identity.loadRememberedLogin();
  const name = accountName(net.serverName || net.name);
  const profile = skinsStore.get();
  if (!saved || accountName(saved.name) !== name || net.status !== 'online'
      || !identity.getAuth(name) || !profile.profileReady || !net.playerId) return;
  const pool = cardOperators(data.list('chess'), data.get('backups'));
  const portraits = { pool, byChar: new Map(pool.map(item => [item.charId, item])), m: data.get('assets'), myId: null, myCard: null };
  const cardSkin = profile.portraits[`char:${profile.card}`] || profile.entries[`char:${profile.card}`] || 'original';
  const seat = { playerId: net.playerId, card: profile.card, cardSkin };
  const avatar = imageUrl(seatAvatar(seat, portraits));
  const fallbackAvatar = imageUrl(seatAvatar({ ...seat, cardSkin: 'original' }, portraits));
  // Metadata may arrive after presentation.state. Keep an existing face until it does.
  const previous = loadRememberedProfile(name);
  if (!avatar && previous?.avatar) return;
  const value = JSON.stringify({ name, avatar, fallbackAvatar });
  try {
    if (globalThis.localStorage?.getItem(PROFILE_KEY) !== value) globalThis.localStorage?.setItem(PROFILE_KEY, value);
  } catch { /* storage unavailable */ }
}

let installed = false;
export function installRememberedProfile() {
  if (installed) return;
  installed = true;
  skinsStore.subscribe((next, previous) => {
    if (next.profileReady && (next.profileReady !== previous.profileReady || next.profileId !== previous.profileId
        || next.card !== previous.card || next.portraits !== previous.portraits || next.entries !== previous.entries)) rememberCurrentProfile();
  });
  data.subscribe((key) => {
    if (['assets', 'chess', 'backups'].includes(key)) rememberCurrentProfile();
  });
}
