import { t as trA } from '../../../shared/i18n.js';
// 皮肤目录取自来源版本；选择与语音设置以 canonical aid 的服务器档案为准。
import { createStore, loadPref, savePref } from '../store.js';
import { resourceCache } from '../resourceCache.js';
import { data } from '../data.js';
import { isSkinCached } from '../assets.js';
import { skinSummonUrls } from '../tokenSkins.js';
import { audio } from '../audio.js';
import { defaultPresentation, isPresentation, checkPresentation, skinKeyForRecord } from '../../../shared/protocol.js';
import { toast } from './toasts.js';
import { isSpecialNameCard } from '../../../shared/nameCards.js';

export const PORTRAITS_PREF = 'skinPortraits';
const CARD_PREF = 'room.card';
const APPEARANCE_OWNER_PREF = 'appearance.profileId';
const completePresentation = (value) => ({ ...value, portraits: value.portraits || {}, card: value.card || '' });
export function cleanSkinsMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw).slice(0, 512)) {
    if (/^[A-Za-z0-9_.:-]+$/.test(id) && typeof value === 'string' && value.length <= 100 && value) out[id] = value;
  }
  return out;
}
export const skinsStore = createStore({ entries: {}, portraits: {}, card: '', installing: null, installingProgress: null, voice: defaultPresentation().voice,
  profileId: null, profileReady: false, identityEpoch: 0, sync: 'loading', locked: false });
export function skinFor(recordOrId) {
  const key = typeof recordOrId === 'string' ? recordOrId : skinKeyForRecord(recordOrId);
  return key ? skinsStore.get().entries[key] || null : null;
}
export function setSkins(entries) {
  if (!skinsStore.get().profileReady) return false;
  skinsStore.set({ entries: { ...entries } });
  return true;
}
export function setSkin(id, skin) {
  if (!skinsStore.get().profileReady) return false;
  const portraits = { ...skinsStore.get().portraits, [id]: skin };
  savePref(PORTRAITS_PREF, portraits);
  // Applying a model also applies its illustration; a later art-only selection can override it.
  skinsStore.set({ entries: { ...skinsStore.get().entries, [id]: skin }, portraits });
  return true;
}
export function setPortraits(entries) {
  if (!skinsStore.get().profileReady) return false;
  const portraits = cleanSkinsMap(entries);
  savePref(PORTRAITS_PREF, portraits);
  skinsStore.set({ portraits });
  return true;
}
export function setPlayerCard(card, choice) {
  if (!skinsStore.get().profileReady || (card !== '' && !isSpecialNameCard(card) && !/^char_[A-Za-z0-9_]+$/.test(card))) return false;
  if (isSpecialNameCard(card)) { skinsStore.set({ card }); return true; }
  if (card && choice !== undefined) {
    const art = data.get('assets')?.chars?.[card];
    if (!art || (choice !== 'original' && choice !== 'e2' && !art.skins?.[choice]?.portrait)) return false;
    const record = data.list('chess').find(c => c.charId === card && !c.isGolden && !c.isDiy);
    const key = record ? skinKeyForRecord(record) : `char:${card}`;
    const portraits = { ...skinsStore.get().portraits, [key]: choice };
    savePref(PORTRAITS_PREF, portraits);
    skinsStore.set({ card, portraits });
    return true;
  }
  skinsStore.set({ card });
  return true;
}
export function setPortrait(id, skin) {
  if (skin && skin !== 'e2' && skin !== 'original') return setSkin(id, skin);
  setPortraits({ ...skinsStore.get().portraits, [id]: skin || 'original' });
}
export const clearPortrait = id => setPortrait(id, 'original');
export function portraitFor(recordOrId) {
  const id = typeof recordOrId === 'string' ? recordOrId : skinKeyForRecord(recordOrId);
  if (!id) return null;
  const s = skinsStore.get();
  const ownArt = s.portraits[id];
  // A profile update from another device must not leave an old skin illustration behind.
  return ownArt || s.entries[id] || null;
}
export function syncDiySkins(oldPicks, newPicks) {
  const entries = { ...skinsStore.get().entries }, portraits = { ...skinsStore.get().portraits };
  let changed = false;
  for (const id of new Set([...Object.keys(oldPicks || {}), ...Object.keys(newPicks || {})])) {
    if ((oldPicks?.[id]?.charId || null) === (newPicks?.[id]?.charId || null)) continue;
    if (entries[id] || portraits[id]) { delete entries[id]; delete portraits[id]; changed = true; }
  }
  if (changed) { setSkins(entries); setPortraits(portraits); }
}
export function clearSkin(id) {
  if (!skinsStore.get().profileReady) return false;
  const next = { ...skinsStore.get().entries }; delete next[id];
  const portraits = { ...skinsStore.get().portraits }; delete portraits[id];
  savePref(PORTRAITS_PREF, portraits);
  skinsStore.set({ entries: next, portraits });
  return true;
}
export function setVoice(patch) {
  if (!skinsStore.get().profileReady) return false;
  skinsStore.set({ voice: { ...skinsStore.get().voice, ...patch } }); return true;
}
export function availableSkins(charId) {
  return (data.get('skins')?.chars?.[charId] || []).map(s => ({ ...s, installed: isInstalled(charId, s.id), downloadable: !!data.get('assets')?.chars?.[charId]?.skins?.[s.id] }));
}
export const isInstalled = (charId, skinId) => isSkinCached(data.get('assets')?.chars?.[charId]?.skins?.[skinId])
  && skinSummonUrls(skinId).every(url => resourceCache.isCached(url));
export const loadSkinData = () => Promise.all([data.load('skins'), data.load('assets')]);

export async function requestSkinInstall(_net, skinId) {
  if (skinsStore.get().installing) return { ok: false };
  const chars = data.get('assets')?.chars || {};
  const char = Object.values(chars).find(value => value?.skins?.[skinId]);
  const skin = char?.skins?.[skinId];
  if (!skin) throw new Error('当前资源包未包含此皮肤');
  const urls = [...skinSummonUrls(skinId)];
  const walk = value => {
    if (typeof value === 'string') urls.push(value);
    else if (value && typeof value === 'object') for (const nested of Object.values(value)) walk(nested);
  };
  walk(skin);
  skinsStore.set({ installing: skinId, installingProgress: { skinId, phase: 'download', done: 0, total: urls.filter(url => resourceCache.isManaged(url)).length } });
  const off = resourceCache.subscribe(() => {
    const managed = urls.filter(url => resourceCache.isManaged(url));
    skinsStore.set({ installingProgress: { skinId, phase: 'download', done: managed.filter(url => resourceCache.isCached(url)).length, total: managed.length } });
  });
  try {
    const ok = await resourceCache.download('optional', { urls });
    if (!ok || !isSkinCached(skin) || !skinSummonUrls(skinId).every(url => resourceCache.isCached(url))) throw new Error('皮肤资源尚未完整下载，可在资源管理中继续');
    return { ok: true };
  } finally { off(); skinsStore.set({ installing: null, installingProgress: null }); }
}

export function installSkinsSync({ net, target = skinsStore, timers = globalThis, notify = (text) => toast(text, 'warn') } = {}) {
  let timer = null, generation = 0, seq = 0, serial = 0, dirty = false, applying = false, disposed = false;
  let accepted = completePresentation(defaultPresentation()), sending = false;
  const replace = (patch) => { applying = true; try { target.set(patch); } finally { applying = false; } };
  const cancel = () => { timers.clearTimeout(timer); timer = null; };
  const schedule = (ms = 500) => {
    cancel(); if (disposed || !dirty || !target.get().profileReady) return;
    target.set({ sync: 'pending' }); timer = timers.setTimeout(() => { timer = null; void flush(); }, ms);
  };
  const reset = () => {
    cancel(); generation++; seq++; sending = dirty = false; accepted = completePresentation(defaultPresentation());
    replace({ entries: {}, portraits: {}, card: '', voice: accepted.voice, profileId: null, profileReady: false,
      identityEpoch: target.get().identityEpoch + 1, sync: 'loading', locked: false });
  };
  async function flush() {
    if (disposed || sending || !dirty || !target.get().profileReady || net.status !== 'online') return;
    const state = target.get(), g = generation, editId = ++seq, before = serial;
    const value = { skins: state.entries, voice: state.voice, portraits: state.portraits, card: state.card };
    dirty = false; sending = true; target.set({ sync: 'sending' });
    try {
      await net.request('profile.presentation', { v: 1, profileId: state.profileId, editId, value });
      if (disposed || g !== generation) return;
      if (before === serial) accepted = structuredClone(value);
      if (!dirty) target.set({ sync: 'synced' });
    } catch (e) {
      if (disposed || g !== generation) return;
      if (['OFFLINE', 'TIMEOUT', 'RATE'].includes(e?.code)) {
        if (before === serial) { dirty = true; schedule(1500); }
      } else {
        cancel(); dirty = false;
        replace({ entries: accepted.skins, portraits: accepted.portraits, card: accepted.card, voice: accepted.voice, sync: 'error' });
        notify(trA("外观与语音保存失败，已恢复服务器配置"));
      }
    } finally {
      if (g === generation) { sending = false; if (dirty && timer == null) schedule(); }
    }
  }
  const offWelcome = net.on('welcome', reset);
  const offStatus = net.on('status', (s) => { if (s?.status !== 'online') reset(); });
  const offState = net.on('presentation.state', (msg) => {
    if (disposed || net.status !== 'online' || msg?.v !== 1 || !/^[0-9a-f]{32}$/.test(msg.profileId) || !isPresentation(msg.value)) return;
    const s = target.get(); if (s.profileId && s.profileId !== msg.profileId) return;
    serial++; accepted = completePresentation(structuredClone(msg.value));
    const own = msg.editorId === net.playerId;
    const keepEdit = own && s.profileReady && (dirty || msg.editId < seq);
    if (!keepEdit) { cancel(); dirty = false; }
    const legacyOwner = loadPref(APPEARANCE_OWNER_PREF, null);
    const canMigrate = !keepEdit && (legacyOwner === null || legacyOwner === msg.profileId)
      && (msg.value.card === undefined || msg.value.portraits === undefined);
    const legacy = canMigrate ? { card: loadPref(CARD_PREF, ''), portraits: cleanSkinsMap(loadPref(PORTRAITS_PREF, {})) } : null;
    // Claim legacy choices before loading metadata; an account switch must not adopt them again.
    if (canMigrate) savePref(APPEARANCE_OWNER_PREF, msg.profileId);
    replace({ profileId: msg.profileId, profileReady: true, locked: !!msg.locked,
      ...(!keepEdit ? { entries: accepted.skins, portraits: accepted.portraits, card: accepted.card, voice: accepted.voice, sync: 'synced' } : {}) });
    if (canMigrate) {
      const g = generation, version = serial;
      // Adopt an old device's choices only into its first matching profile, never over cloud fields.
      void Promise.all(['chess', 'assets', 'backups'].map((key) => data.load(key))).then(() => {
        if (disposed || g !== generation || version !== serial || dirty || target.get().profileId !== msg.profileId) return;
        const valid = (patch) => !checkPresentation({ ...defaultPresentation(), ...patch },
          (id) => data.lookup('chess', id), data.get('assets'), data.get('backups')?.units).error;
        const patch = {};
        if (msg.value.card === undefined) patch.card = valid({ card: legacy.card }) ? legacy.card : '';
        if (msg.value.portraits === undefined) patch.portraits = Object.fromEntries(Object.entries(legacy.portraits)
          .slice(0, 256).filter(([id, art]) => valid({ portraits: { [id]: art } })));
        target.set(patch);
      }).catch(() => {});
    } else if (!keepEdit && msg.value.card !== undefined && msg.value.portraits !== undefined) {
      savePref(APPEARANCE_OWNER_PREF, msg.profileId);
      savePref(CARD_PREF, accepted.card);
      savePref(PORTRAITS_PREF, accepted.portraits);
    }
  });
  const offStore = target.subscribe((s, p) => {
    if (!applying && s.profileReady && (s.entries !== p.entries || s.voice !== p.voice || s.portraits !== p.portraits || s.card !== p.card)) { dirty = true; schedule(); }
  });
  return { flush, dispose() { disposed = true; generation++; cancel(); offWelcome?.(); offStatus?.(); offState?.(); offStore?.(); } };
}

skinsStore.subscribe((s) => audio.setVoiceSettings({ ...s.voice, enabled: s.profileReady && s.voice.enabled }));
audio.setVoiceSettings({ ...skinsStore.get().voice, enabled: false });
