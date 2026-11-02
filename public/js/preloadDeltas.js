import { V79_DELTAS } from './v79Resources.js';
import { NAMEPLATE_DELTA } from './nameplateResources.js';
import { CHAT_STICKER_DELTA } from './chatStickerResources.js';
import { EMOTE_ANIMATION_DELTA } from './emoteAnimationResources.js';
// Additive catalogue for the published UI sounds. Base pack offsets stay unchanged.
export const PRELOAD_DELTA = Object.freeze({"name":"resource-ui-click-20261101.sprpack","bytes":36528,"sha1":"bc517e719d7a92ec2f59ec99cd7bcad6eb8fc62c","sha256":"3f3654a8c8478e52dc0a0e17d3f59d35686c67da82f54d07c8018ed92608081f","discover":true,"parentFileId":"6ae6d3288f6fa618090a4240894426ce6532858d","resources":[{"url":"/media/sfx/general/g_ui/g_ui_btn_n","version":"678045395f1834a74511edda72e87d6fc169f4d50e4582d9f056314900f846c6","bytes":4432,"type":"audio/mpeg","offset":828},{"url":"/media/sfx/general/g_ui/g_ui_back","version":"714feac64c5cdc80756312e685846fd350ebc6d4f144c1c0e38e01d97dd88d2a","bytes":15299,"type":"audio/mpeg","offset":5260},{"url":"/media/sfx/general/g_ui/g_ui_confirm","version":"9ff914e8d906e218f0cd67312ecac88e004366580f56d9a1f068e1b63c3aff80","bytes":11955,"type":"audio/mpeg","offset":20559},{"url":"/media/sfx/general/g_ui/g_ui_tickup","version":"dabef84a32d2a67c4be3856bccb38bb924b1d0ccf1a81834f33a0b8fa87485e1","bytes":4014,"type":"audio/mpeg","offset":32514}]});
export const PRELOAD_DELTAS = Object.freeze([PRELOAD_DELTA, NAMEPLATE_DELTA, ...V79_DELTAS, CHAT_STICKER_DELTA, EMOTE_ANIMATION_DELTA]);
const packsByUrl = new Map(PRELOAD_DELTAS.flatMap(pack => pack.resources.map(row => [row.url, pack])));
const rowsByUrl = new Map(PRELOAD_DELTAS.flatMap(pack => pack.resources.map(row => [row.url, row])));
export function preloadDeltaPack(item) {
  const value = typeof item === 'string' ? item : item?.url;
  if (!value) return null;
  try {
    const path = new URL(value, 'http://localhost').pathname.replace(/^\/assets\/audio\/(.*)\.mp3$/, '/media/$1');
    return packsByUrl.get(path) || null;
  } catch { return null; }
}
export function preloadDelta(item) {
  const value = typeof item === 'string' ? item : item?.url;
  if (!value) return null;
  try {
    const path = new URL(value, 'http://localhost').pathname.replace(/^\/assets\/audio\/(.*)\.mp3$/, '/media/$1');
    return rowsByUrl.get(path) || null;
  } catch { return null; }
}
export function withPreloadDeltas(data) {
  if (data?.schema !== 1 || !Array.isArray(data.groups?.required) || !Array.isArray(data.groups?.voice) ||
      (data.groups.optional !== undefined && !Array.isArray(data.groups.optional))) return data;
  const groups = { ...data.groups };
  for (const group of ['required', 'optional', 'voice']) {
    if (groups[group]) groups[group] = groups[group].filter(row => !preloadDelta(row));
  }
  for (const pack of PRELOAD_DELTAS) {
    const group = pack.group || 'required';
    groups[group] = [...(groups[group] || []), ...pack.resources.map(({ offset, ...row }) => ({ ...row }))];
  }
  return { ...data, groups };
}
