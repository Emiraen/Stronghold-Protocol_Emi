// shared/banPick.js — 卡池预选 (自选要 ban 的盟约) and the 「特别关心 ❤」 mark. Pure ESM shared by the server
// (validation + the per-player ban computation) and the client (the 干员调配 picker).
//
// WHY IT IS PER PLAYER. The 100-seat variant gives every player a pool of its own (server/match/player/rules.js:
// INDEPENDENT POOL — the full original copy count of every non-banned base chess, so 100 seats never compete over the
// 3-8 copies the shared pool carries). Bans decide that pool's id set, so a per-player ban list is exactly the
// resolution the variant already implies: each player's shop is drawn from its own list.
//
// MODEL
//   * A pick list is kept PER DIFFICULTY (`byDifficulty`), because the ban quota depends on the difficulty and the
//     player picks before a room exists. Only the difficulty the match actually runs with is used.
//   * Per difficulty: `bonds` = the 盟约 the player wants OFF; `favorites` = the 大盟约 marked 「特别关心 ❤」;
//     `fill` = pad the remaining quota with a random draw (default true). `bonds` may name at most the quota's
//     `core` + `addon` entries; a favourited 盟约 may never be in `bonds` (that is the whole point of the mark).
//   * At match start the ban set is: the player's own picks, then — while `fill` is on and the quota is not full — a
//     uniform random draw from the mode-active bonds the player did not pick and does not favourite. The mode's own
//     `inactiveBondIds` stay off whatever the player does (they are not a ban, they are not in the mode).
//   * A favourited 盟约 is NEVER banned, not by the player's own list and not by a random fill. Its 金 colour is a UI
//     matter; the engine only honours the exemption.
//   * A visible chess is banned iff EVERY one of its bonds is in (the ban set ∪ mode.inactiveBondIds) — the same rule
//     server/match/pool.js drawDisabledBonds uses, so the two never disagree.

// Kept free of imports on purpose: shared/protocol.js imports THIS module to validate `room.loadout.bans`, so an
// import back would be a cycle. `isBondId` mirrors protocol.js `isId`.
const isBondId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_\-.:]+$/.test(v);

/** The difficulties a pick list exists for (shared/constants.js DIFFICULTIES; no TRAINING — that mode is not open). */
// ★ 2026-10-15（用户）：「在炸惊模拟加入 ban 位」—— 大小盟约各 2 个。
//   炸惊本来就有一套「剔除盟约」的机制（mode.inactiveBondIds = 孤独/投资，常驻关闭），
//   而且 drawDisabledBonds 的判定 `bonds.every(b => off.has(b))`、banPicker 的难度标签、
//   protocol 的校验、loadoutSync 的档位判定，全都遍历这张表 —— 所以只要把 ZHAJING 加进来，
//   配额再在 data/config.json 的 bans 里给一份，整条链路就通了。
//   （ZHAJING 已在 shared/constants.js 的 DIFFICULTIES 里，中文名也早有：炸惊模拟（BETAv0.799325）。）
export const BANPICK_DIFFICULTIES = Object.freeze(['FUNNY', 'NORMAL', 'HARD', 'ABYSS', 'ZHAJING']);

/**
 * ★ 2026-10-23（owner）：这三个是「非核心 + weight 0」的小盟约（不参与随机抽取），
 *   但玩家仍然可以主动 ban 掉它们（用来把对应干员从自己的池子里移除）：
 *   企鹅物流 / 岁 / 医师。
 */
export const BANNABLE_ZERO_WEIGHT = Object.freeze(new Set(['penguinShip', 'suiShip', 'physicianShip']));

/** How many 盟约 of each kind may be picked off, per difficulty (data/config.json `bans`). */
export const BAN_QUOTA_FALLBACK = Object.freeze({
  FUNNY: Object.freeze({ core: 0, addon: 1 }),
  NORMAL: Object.freeze({ core: 3, addon: 4 }),
  HARD: Object.freeze({ core: 3, addon: 4 }),
  ABYSS: Object.freeze({ core: 3, addon: 4 }),
  // ★ 2026-10-15：和 data/config.json `bans.ZHAJING` 一致（大小盟约各 2 个）。
  //   正常情况走 config，这里是「config 缺了 / 单机工具没带」时的兜底。
  ZHAJING: Object.freeze({ core: 2, addon: 2 }),
});

/** The quota of a difficulty out of `config.bans` (falling back to the built-in table). */
export function banQuota(config, difficulty) {
  const b = config && typeof config === 'object' ? config.bans : null;
  const q = b && typeof b === 'object' ? b[difficulty] : null;
  if (q && Number.isInteger(q.core) && Number.isInteger(q.addon)) return { core: q.core, addon: q.addon };
  return BAN_QUOTA_FALLBACK[difficulty] || Object.freeze({ core: 0, addon: 0 });
}

/** An empty profile (every difficulty at "pick nothing, fill the rest randomly"). */
export function emptyBanPick() {
  const byDifficulty = {};
  for (const d of BANPICK_DIFFICULTIES) byDifficulty[d] = { bonds: [], favorites: [], fill: true };
  return { v: 1, byDifficulty };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const uniq = (a) => [...new Set(a)];

/**
 * One difficulty's entry, cleaned: unknown ids dropped, duplicates removed, `bonds` ∩ `favorites` emptied (a
 * favourited 盟约 is never banned), and `bonds` truncated to the quota. `favorites` holds AT MOST ONE id — the mark is
 * a single 「特别关心」, not a list — and the quota only constrains what may be banned, never the mark.
 * @param {any} entry @param {{ core: number, addon: number }} quota
 * @param {(bondId: string) => { isCore?: boolean } | null} bondOf
 */
export function cleanEntry(entry, quota, bondOf) {
  const e = isObj(entry) ? entry : {};
  // at most one favourite, and only a 大盟约 may carry it
  const favAll = uniq((Array.isArray(e.favorites) ? e.favorites : []).filter((b) => isBondId(b) && bondOf(b)?.isCore));
  const fav = favAll.slice(0, 1);
  const favSet = new Set(fav);
  let core = 0;
  let addon = 0;
  const bonds = [];
  for (const b of Array.isArray(e.bonds) ? e.bonds : []) {
    if (!isBondId(b) || favSet.has(b)) continue;         // a favourited 盟约 is never in the ban list
    const rec = bondOf(b);
    // ★ 2026-10-18：核心盟约不看 weight —— S.E.E.S 是 weight 0 的核心盟约，必须能出现在卡池预选里。
    //   非核心的 weight-0 盟约（inert，卡池预选里灰显）默认不可 ban；
    //   ★ 2026-10-23（owner）：企鹅物流 / 岁 / 医师 这三个虽不参与随机抽取，也开放成可 ban。
    if (!rec || (!(Number(rec.weight) > 0) && !rec.isCore && !BANNABLE_ZERO_WEIGHT.has(b))) continue;
    if (rec.isCore) { if (core >= quota.core) continue; core++; }
    else { if (addon >= quota.addon) continue; addon++; }
    if (!bonds.includes(b)) bonds.push(b);
  }
  // `fill` is kept for older stored profiles; the random fill itself is never optional
  return { bonds: bonds.sort(), favorites: fav, fill: true };
}

/**
 * A whole profile, cleaned for the given data. A stored profile from an older build (or a tampered message) always
 * comes back usable. `difficulty`/`quota` are the ones the caller has at hand (the match's); every other difficulty is
 * cleaned with the built-in table, and a caller with the full config (the lobby) passes it through `banQuota`.
 * @param {any} raw
 * @param {Record<string, { core: number, addon: number }>} quotas keyed by difficulty
 * @param {(bondId: string) => { isCore?: boolean } | null} bondOf
 */
export function cleanProfile(raw, quotas, bondOf) {
  const src = isObj(raw) && isObj(raw.byDifficulty) ? raw.byDifficulty : {};
  const byDifficulty = {};
  for (const d of BANPICK_DIFFICULTIES) {
    const q = (quotas && quotas[d]) || BAN_QUOTA_FALLBACK[d] || { core: 0, addon: 0 };
    byDifficulty[d] = cleanEntry(src[d], q, bondOf);
  }
  return { v: 1, byDifficulty };
}

/** Toggle one 盟约 in a difficulty's ban list (returns a NEW entry). */
export function toggleBan(entry, bondId, quota, bondOf) {
  const e = cleanEntry(entry, quota, bondOf);
  const has = e.bonds.includes(bondId);
  const rec = bondOf(bondId);
  // ★ 2026-10-23：核心盟约不看 weight —— S.E.E.S 的 weight 是 0，但它在大盟约里应当可以 ban
  //   （列表 banPickerBonds 就是这么列的，cleanEntry 也已经是这个口径；只有这里漏了）。
  if (!rec || (!(Number(rec.weight) > 0) && !rec.isCore && !BANNABLE_ZERO_WEIGHT.has(bondId))) return e;
  if (has) return cleanEntry({ ...e, bonds: e.bonds.filter((b) => b !== bondId) }, quota, bondOf);
  // adding: refuse when the kind's quota is already used up (the UI greys the rest out, this is the guard)
  const used = e.bonds.filter((b) => !!bondOf(b)?.isCore === !!rec.isCore).length;
  const cap = rec.isCore ? quota.core : quota.addon;
  if (used >= cap) return e;
  return cleanEntry({ ...e, bonds: [...e.bonds, bondId], favorites: e.favorites.filter((f) => f !== bondId) }, quota, bondOf);
}

/**
 * Toggle `bondId` as 「特别关心 ❤」 (returns a NEW entry). At most ONE 大盟约 carries the mark per difficulty: marking
 * a new one replaces the previous — the mark means "this is the 盟约 I am building around", not a list. Marking also
 * lifts the 盟约 out of the ban list, so a favourite can never be banned.
 */
export function toggleFavorite(entry, bondId, quota, bondOf) {
  const e = cleanEntry(entry, quota, bondOf);
  const rec = bondOf(bondId);
  if (!rec || !rec.isCore) return e; // only 大盟约 carry the mark
  const fav = e.favorites.includes(bondId) ? [] : [bondId]; // at most one
  return cleanEntry({ ...e, favorites: fav, bonds: e.bonds.filter((b) => b !== bondId) }, quota, bondOf);
}

/** The single 「特别关心 ❤」 of an entry, or null. */
export function favoriteOf(entry) {
  return Array.isArray(entry?.favorites) && entry.favorites.length ? entry.favorites[0] : null;
}

/** Set the 「剩余槽位随机补」 switch. Kept for callers of older builds — the fill is MANDATORY, so it only clears it. */
export function setFill(entry, on, quota, bondOf) {
  void on;
  return cleanEntry(entry, quota, bondOf);
}

/** How many of each kind a difficulty's entry still has left, and whether it is at the defaults. */
export function banPickStats(entry, quota, bondOf) {
  const e = cleanEntry(entry, quota, bondOf);
  let core = 0;
  for (const b of e.bonds) if (bondOf(b)?.isCore) core++;
  return {
    core, addon: e.bonds.length - core,
    coreLeft: Math.max(0, quota.core - core),
    addonLeft: Math.max(0, quota.addon - (e.bonds.length - core)),
    favorites: e.favorites.length,
    fill: true, // the random fill is never optional
    changed: e.bonds.length > 0 || e.favorites.length > 0,
  };
}

/** Uniform sample of `n` items without replacement (Fisher–Yates over a copy; `rng` = a `() => [0,1)` function). */
function sample(arr, n, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, Math.min(n, a.length)));
}

/**
 * The 盟约 set one player disables this match: its own picks, then a random fill of the remaining quota. The fill is
 * MANDATORY (there is no switch) and never touches a favourited 盟约 nor the mode's own inactive list.
 * @param {{ entry: any, quota: { core: number, addon: number }, bondIds: string[], bondOf: Function, modeInactive: Set<string>, rng: Function }} o
 * @returns {string[]} the disabled 盟约 ids, sorted
 */
export function drawPlayerBans({ entry, quota, bondIds, bondOf, modeInactive, rng }) {
  const e = cleanEntry(entry, quota, bondOf);
  const favSet = new Set(e.favorites);
  const picked = new Set(e.bonds);
  // the pool the random fill may draw from: mode-active, bannable, not already picked, never a favourite
  const eligible = bondIds.filter((b) => {
    const rec = bondOf(b);
    return rec && Number(rec.weight) > 0 && !modeInactive.has(b) && !picked.has(b) && !favSet.has(b);
  });
  const out = new Set(e.bonds);
  // the fill is MANDATORY: whatever the player did not pick is drawn at random (a favourite is never drawn)
  const coreLeft = Math.max(0, quota.core - e.bonds.filter((b) => bondOf(b)?.isCore).length);
  const addonLeft = Math.max(0, quota.addon - e.bonds.filter((b) => !bondOf(b)?.isCore).length);
  const core = eligible.filter((b) => bondOf(b)?.isCore);
  const addon = eligible.filter((b) => !bondOf(b)?.isCore);
  for (const b of sample(core, coreLeft, rng)) out.add(b);
  for (const b of sample(addon, addonLeft, rng)) out.add(b);
  return [...out].sort();
}

/**
 * The visible chess a player's own pool leaves out: every chess whose bonds are all in (the player's disabled set ∪
 * the mode's inactive list). Same rule as server/match/pool.js drawDisabledBonds, applied to ONE player's set.
 * @param {{ visibleChess: Iterable<string>, chess: (id: string) => any, disabled: Iterable<string>, modeInactive: Set<string> }} o
 * @returns {string[]}
 */
export function bannedChessFor({ visibleChess, chess, disabled, modeInactive }) {
  const off = new Set([...disabled, ...modeInactive]);
  const out = [];
  for (const id of visibleChess) {
    const c = chess(id);
    const bonds = c && Array.isArray(c.bonds) ? c.bonds : [];
    if (bonds.length > 0 && bonds.every((b) => off.has(b))) out.push(id);
  }
  return out;
}
