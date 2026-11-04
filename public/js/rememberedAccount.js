// A small appearance snapshot for the explicitly remembered account. Credentials stay in identity.
import { identity, net } from './net.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { data } from './data.js';
import { skinsStore } from './ui/skins.js';
import { cardOperators, seatAvatar, SPECIAL_CARD_ART } from './ui/seatArt.js';
import { acquireResourceUrl, resourceCache } from './resourceCache.js';

const PROFILE_KEY = 'sp.remembered.account.profile';
const accountName = (value) => String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ');
const imageUrl = (value) => typeof value === 'string' && value.length <= 1024
  && /^(?:\/(?!\/)|https?:\/\/)/.test(value) ? value : null;
const thumbnailUrl = (value) => typeof value === 'string' && value.length <= 48 * 1024
  && /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
const listeners = new Set();
const previews = new Map();
const notify = () => { for (const listener of listeners) listener(); };

function saveProfile(profile) {
  try {
    const value = JSON.stringify(profile);
    if (globalThis.localStorage?.getItem(PROFILE_KEY) === value) return;
    globalThis.localStorage?.setItem(PROFILE_KEY, value);
    notify();
  } catch { /* storage unavailable */ }
}

export function loadRememberedProfile(name) {
  try {
    const profile = JSON.parse(globalThis.localStorage?.getItem(PROFILE_KEY) || 'null');
    if (!profile || profile.name !== accountName(name)) return null;
    const avatar = imageUrl(profile.avatar), fallbackAvatar = imageUrl(profile.fallbackAvatar);
    return { name: profile.name, avatar, fallbackAvatar,
      thumbnail: profile.thumbnailSource === avatar ? thumbnailUrl(profile.thumbnail) : null };
  } catch { return null; }
}

export function clearRememberedProfile() {
  try { globalThis.localStorage?.removeItem(PROFILE_KEY); } catch { /* storage unavailable */ }
  notify();
}

/** A same-tab write or another tab's storage event updates an already mounted title. */
export function useRememberedProfile(name) {
  const [profile, setProfile] = useState(() => loadRememberedProfile(name));
  useEffect(() => {
    const refresh = () => setProfile(loadRememberedProfile(name));
    const storage = event => { if (event.key === PROFILE_KEY || event.key === null) refresh(); };
    listeners.add(refresh);
    globalThis.addEventListener?.('storage', storage);
    refresh();
    return () => {
      listeners.delete(refresh);
      globalThis.removeEventListener?.('storage', storage);
    };
  }, [name]);
  return profile?.name === accountName(name) ? profile : null;
}

function makeThumbnail(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 96;
        const context = canvas.getContext('2d');
        const edge = Math.min(image.naturalWidth, image.naturalHeight);
        if (!context || !edge) throw new Error('Avatar image is unavailable');
        context.drawImage(image, (image.naturalWidth - edge) / 2, (image.naturalHeight - edge) / 2,
          edge, edge, 0, 0, 96, 96);
        resolve(thumbnailUrl(canvas.toDataURL('image/webp', 0.85)));
      } catch (error) { reject(error); }
    };
    image.onerror = reject;
    image.src = url;
  });
}

/** Reuse downloaded art; the title's tiny inline preview never waits on the resource catalogue. */
export function warmRememberedProfile(name) {
  const profile = loadRememberedProfile(name);
  if (!profile?.avatar || profile.thumbnail || typeof Image === 'undefined') return Promise.resolve();
  const key = profile.name + '\n' + profile.avatar;
  if (previews.has(key)) return previews.get(key);
  const job = (async () => {
    let resource;
    try {
      // These small card avatars already ship as ordinary client images.
      resource = SPECIAL_CARD_ART.some(card => card.avatar === profile.avatar)
        ? { url: profile.avatar, release() {} }
        : await acquireResourceUrl(profile.avatar, { cachedOnly: true });
      const thumbnail = await makeThumbnail(resource.url);
      const current = loadRememberedProfile(name);
      const remembered = identity.loadRememberedLogin();
      if (!thumbnail || remembered?.name !== profile.name || current?.avatar !== profile.avatar) return;
      saveProfile({ ...current, thumbnail, thumbnailSource: profile.avatar });
    } catch { /* A local miss keeps the existing avatar URL; later cache completion retries it. */ }
    finally { resource?.release(); }
  })().finally(() => previews.delete(key));
  previews.set(key, job);
  return job;
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
  saveProfile({ name, avatar, fallbackAvatar,
    ...(previous?.avatar === avatar && previous.thumbnail
      ? { thumbnail: previous.thumbnail, thumbnailSource: avatar } : {}) });
  void warmRememberedProfile(name);
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
  let revision = -1;
  resourceCache.subscribe(() => {
    const next = resourceCache.getState().cacheRevision;
    if (next === revision) return;
    revision = next;
    const name = identity.loadRememberedLogin()?.name;
    if (name) void warmRememberedProfile(name);
  });
}
