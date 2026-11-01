// shared/avatars.js — 头像系统的共享部分（服务端校验 + 浏览器解析，同一份代码）。
//
// 线上只传一个**不透明 id**，绝不传 URL（避免任意图片地址注入）：
//   player:avatar_def_01               官方个人头像（本机国服客户端提取，tools/local-extract/extract.py）
//   char:char_003_kalts                干员头像
//   e2:char_003_kalts                  干员精英二头像
//   skin:char_003_kalts@sale#14        皮肤头像
//   band:band_amiya                    策略分队图标（每个分队都可选）
// 客户端用 data/avatars.json（_garrison-list/gen-avatars.mjs 生成）把 id 解析成图片地址；
// 解析不到就回落到首字母 / 机器人图标（ui/components.js AvatarFrame、ui/gameComponents.js PlayerAvatar）。
//
// AVATAR_MAX_LEN 之外没有别的限制：id 的形状由正则守住，未知 id 只会画不出图，不会出事。

/** id 的 kind 列表（顺序 = 选择器里的页签顺序）。 */
export const AVATAR_KINDS = Object.freeze(['char', 'e2', 'skin', 'band', 'player']);

/** `kind:key` 里的 key：干员/分队 id、皮肤 key（char_x@sale#14）、个人头像 key（avatar_def_01）。 */
export const AVATAR_MAX_LEN = 64;

const ID_RE = /^(char|e2|skin|band|player):[A-Za-z0-9_@#.\-]{1,64}$/;

/**
 * Whether `v` may travel as a player's avatar id (null/'' = 不设头像, allowed).
 * @param {any} v
 * @returns {boolean}
 */
export function isAvatarId(v) {
  return typeof v === 'string' && v.length <= AVATAR_MAX_LEN + 8 && ID_RE.test(v);
}

/**
 * Split an avatar id into `{ kind, key }` (null when malformed).
 * @param {any} id
 * @returns {{ kind: string, key: string }|null}
 */
export function avatarParts(id) {
  if (!isAvatarId(id)) return null;
  const i = id.indexOf(':');
  return { kind: id.slice(0, i), key: id.slice(i + 1) };
}

/**
 * 把 id 解析成图片地址（客户端侧）。`cat` = data/avatars.json。
 * @param {any} cat the avatar catalogue
 * @param {any} id avatar id sent by the server / stored in localStorage
 * @returns {string|null}
 */
/**
 * 兼容旧 id 方案（用户 2026-10-13）：早期生成器用 `#` 分隔皮肤名，现在的目录用 `@`
 * （localStorage 里是 `skin:char_222_bpipe#race#1`，目录里是 `skin:char_222_bpipe@race#1`）。
 * 老玩家的存档还带着旧形式，这里规范化成目录里真实存在的 id；找不到就原样返回。
 * @param {any} cat data/avatars.json
 * @param {any} id
 * @returns {string}
 */
export function canonicalAvatarId(cat, id) {
  if (!isAvatarId(id)) return id;
  const map = cat && typeof cat === 'object' ? cat.src : null;
  if (!map || typeof map !== 'object') return id;
  if (map[id]) return id;
  if (id.includes('#') && !id.includes('@')) {
    const alt = id.replace('#', '@');
    if (map[alt]) return alt;
  }
  return id;
}
export function avatarSrc(cat, id) {
  if (!isAvatarId(id) || !cat || typeof cat !== 'object') return null;
  const map = cat.src;
  if (!map || typeof map !== 'object') return null;
  const url = map[canonicalAvatarId(cat, id)];
  return typeof url === 'string' && url ? url : null;
}

/**
 * 选择器列表可以用**半身像**当缩略图的地址（用户 2026-10-13 试过一版）。
 *
 * 官方「头像」素材（180×180）本身是紧裁的胸像（头发贴顶被切）；同一批干员另有「半身像」
 * （assets/char/portrait/*.png，180×360，char/e2 全齐，只有 2 张皮肤缺），头是完整的。
 * **当前没在用**：用户最终要求「跟左下角预览一致」，列表图统一走 avatarSrc（官方头像图标，
 * 方形素材放方形格子 = 完整不裁切）。想换回半身像时：把 avatarPicker.js 里 Cell 的 `thumb`
 * 传成这个函数的结果，CSS 里把 object-position 改成 center top 就行。
 * @param {any} cat data/avatars.json
 * @param {any} id
 * @returns {string|null}
 */
export function avatarThumbSrc(cat, id) {
  const icon = avatarSrc(cat, id);
  const p = avatarParts(canonicalAvatarId(cat, id));
  if (!icon || !p) return icon;
  if (p.kind === 'char') return `/assets/char/portrait/${p.key}_1.png`;
  if (p.kind === 'e2') return `/assets/char/portrait/${p.key}_2.png`;
  if (p.kind === 'skin') return icon.replace('/skin_avatar/', '/skin_portrait/');
  return icon;   // band / player：本来就是方形图标，没有半身像
}

/**
 * 一个 id 的显示名（选择器/提示用）；不在目录里时退回 id 本身。
 * @param {any} cat
 * @param {any} id
 * @returns {string}
 */
export function avatarName(cat, id) {
  if (!isAvatarId(id) || !cat || !Array.isArray(cat.items)) return '';
  const hit = cat.items.find((x) => x && x.id === canonicalAvatarId(cat, id));
  return hit ? hit.name || id : '';
}

/**
 * 动态头像的 spine 信息（`data/avatars.json` 的 `dyn` 表，用户 2026-10-13）。
 *
 * 只有真·spine 骨架才登记（目前 6 个 `player:avatar_dyn_0X`）；另外 3 个动态头像是 GIF，
 * `<img>` 自己就会动，不需要登记。返回 `{ skel }`（图集按 pixi-spine 约定同名同目录），
 * 没有则返回 null —— 调用方 `ui/dynAvatar.js` 见到 null 就只画静态图。
 * @param {any} cat data/avatars.json
 * @param {any} id
 * @returns {{ skel: string }|null}
 */
export function avatarDyn(cat, id) {
  if (!isAvatarId(id) || !cat || typeof cat !== 'object') return null;
  const map = cat.dyn;
  if (!map || typeof map !== 'object') return null;
  const hit = map[canonicalAvatarId(cat, id)];
  return hit && typeof hit === 'object' && typeof hit.skel === 'string' && hit.skel ? hit : null;
}

/** 页签顺序（选择器）：组 key → 目录里的 group 值。 */
export const AVATAR_TABS = Object.freeze(['char', 'e2', 'skin', 'band', 'player']);
