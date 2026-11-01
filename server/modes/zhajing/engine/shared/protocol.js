// Normative message catalogue (DESIGN §8). Used by server (validation) and client (building requests).
// Every client→server message is `{ t, rid?, ...fields }`. Unknown `t` or invalid fields ⇒ ERR.BAD_MSG.

import { isOpenDifficulty, NAME_MAX_LEN, ROOM_CODE_LEN, MAX_SEATS, EMOTES, GEO, ROOM_HUMAN_CAPS } from './constants.js';
import { isDroppableChess } from './standIn.js';
import { diySlotIds, validateDiyPicks } from './diy.js';
import { isPotential, isCultivate, POTENTIAL_DEFAULT, CULTIVATE_DEFAULT } from './potential.js';
import { BANPICK_DIFFICULTIES, emptyBanPick, cleanProfile } from './banPick.js';
import { isAvatarId } from './avatars.js';

// ---- tiny validators -------------------------------------------------------
const isInt = (v, lo = -Infinity, hi = Infinity) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v, max = 64) => typeof v === 'string' && v.length <= max;
const isBool = (v) => typeof v === 'boolean';
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_\-.:]+$/.test(v);
const isUid = (v) => isInt(v, 1, 2 ** 31);
const isNum = (v, lo = -Infinity, hi = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const optional = (check) => (v) => v === undefined || check(v);
const nullable = (check) => (v) => v === null || v === undefined || check(v);
/** A plain object with at most `max` own keys, every key passing `key` and every value passing `val`. */
const isMap = (v, max, key, val) => {
  if (!isPlain(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > max) return false;
  for (const k of keys) if (!key(k) || !val(v[k])) return false;
  return true;
};
const isList = (v, max, item) => Array.isArray(v) && v.length <= max && v.every(item);

// ---- client-side combat (DESIGN §14): b.progress / b.result payloads -------------------------------------------

/** Size limits of a b.result payload (the whole frame also obeys the 64 KB inbound limit). */
export const RESULT_LIMITS = Object.freeze({ players: 4, leaked: 400, unitsEnd: 64, unitStats: 160, layerGains: 40, mods: 16, unspawned: 400 });
const BIG = 1e13;
const isStat = (v) => v === undefined || isNum(v, 0, BIG);
const isModVal = (v) => v === null || isNum(v, -BIG, BIG) || isStr(v, 64) || isBool(v);
const isLeak = (l) => isPlain(l) && isId(l.enemyKey)
  && (l.mods === undefined || l.mods === null || isMap(l.mods, RESULT_LIMITS.mods, (k) => isStr(k, 32), isModVal))
  && optional((v) => isNum(v, 0, 1000))(l.lpr) && nullable(isId)(l.sourcePlayerId) && nullable((v) => isStr(v, 16))(l.tag)
  && optional(isBool)(l.counted) && optional(isBool)(l.boss) && optional(isBool)(l.spawned);
const isUnitEnd = (u) => isPlain(u) && nullable(isUid)(u.uid) && isNum(u.hpPct, 0, 1) && isNum(u.sp, 0, 1e5) && isBool(u.alive)
  && optional(isBool)(u.skillActive) && nullable(isId)(u.defId);
const isUnitStat = (u) => isPlain(u) && nullable(isUid)(u.uid) && nullable(isId)(u.defId) && optional((v) => isStr(v, 16))(u.kind)
  && isStat(u.dmg) && isStat(u.kills) && isStat(u.heal) && isStat(u.taken) && isStat(u.attacks);
const isPerPlayer = (p) => isPlain(p) && isInt(p.killed, 0, 1e5) && isInt(p.total, 0, 1e5) && p.killed <= p.total
  && isList(p.leaked, RESULT_LIMITS.leaked, isLeak) && isBool(p.perfect)
  && isMap(p.layerGains, RESULT_LIMITS.layerGains, isId, (v) => isNum(v, 0, 1e4))
  && isStat(p.coins) && isStat(p.damageDealt) && isStat(p.bossDamage) && isStat(p.healingDone) && isStat(p.deaths)
  && isList(p.unitsEnd, RESULT_LIMITS.unitsEnd, isUnitEnd)
  && (p.unitStats === undefined || isList(p.unitStats, RESULT_LIMITS.unitStats, isUnitStat));
const isUnspawned = (u) => isPlain(u) && isId(u.enemyKey) && nullable(isId)(u.sourcePlayerId) && nullable((v) => isStr(v, 16))(u.tag)
  && optional((v) => isNum(v, 0, 1e6))(u.time);

/**
 * Structural check of a client BattleResult (DESIGN §5.1 / §14 `b.result`): types, ranges and size limits only —
 * the semantic checks against the battle's spec are the server's (server/match/fields.js validateClientResult).
 */
export function isBattleResult(v) {
  return isPlain(v) && ['cleared', 'timeout', 'forced'].includes(v.reason) && isNum(v.time, 0, 1e5)
    && optional((x) => isInt(x, 0, 1e5))(v.killed) && optional((x) => isInt(x, 0, 1e5))(v.total)
    && isMap(v.perPlayer, RESULT_LIMITS.players, isId, isPerPlayer) && Object.keys(v.perPlayer).length > 0
    && (v.unspawned === undefined || isList(v.unspawned, RESULT_LIMITS.unspawned, isUnspawned))
    && optional((x) => isInt(x, 0, 1e9))(v.errors) && optional((x) => isNum(x, 0, BIG))(v.bossHpLeft);
}

// ---- 干员皮肤 (docs/SKINS.md): room.skins { skins } -----------------------------------------------------------

/**
 * `room.skins { skins }`: `skins` = `{ [baseChessId]: skinId }`.
 * Unlike `room.loadout` these are PUBLIC: they ride in `Match.publicView().players[]` so a teammate sees the
 * skin, which is the whole point of choosing one in a co-op match.
 */
export const SKIN_LIMITS = Object.freeze({ entries: 160, idLen: 64 });
/**
 * A skinId. NOT `isId`: those allow only `[A-Za-z0-9_\-.:]`, and skin ids carry `@` and `#`
 * (`char_003_kalts@boc#6`), plus `+` in a few DIY ids.
 */
export const isSkinId = (v) => typeof v === 'string' && v.length > 0 && v.length <= SKIN_LIMITS.idLen && /^[A-Za-z0-9_@#+.\-]+$/.test(v);
/** Structural check of `room.skins.skins`. */
/**
 * ★ 2026-10-13 修「room.skins refused BAD_MSG / bad field skins」：
 * 键是棋库 id / 干员 charId / 自选槽位 id（客户端为了一衣多查会**同时写 chessId 与 charId**），
 * 用通用的 `isId` 会把它们挡掉 → 换肤消息整条被拒。键只做类型+长度检查即可：服务端本来就
 * 「只保留自己认识的棋子的条目、丢弃其余」（见 public/js/ui/skins.js 的说明），不认识的键无害。
 */
export const isSkinKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= SKIN_LIMITS.idLen;
export const isSkinSelection = (v) => {
  // ★ 2026-10-13（A′ 安全版）：放宽为"空值 / 任意对象都收"。0.2.5 服务端的皮肤 payload 形状与旧版不同，
  // 逐键白名单会把整条 room.skins 判成 bad field skins；非法条目服务端本就会丢弃，客户端拿到不认识的键只是显示默认皮肤。
  return v == null || typeof v === 'object';
};;

// ---- operator loadout (DESIGN §16): room.loadout { entries } -------------------------------------------------

/**
 * `room.loadout { entries }`: `entries` = `{ [baseChessId]: { skill?: skillIndex, module?: uniEquipId | 'none' } }`
 * (the per-browser loadout of the 干员调配 screen). Structural limits below; the semantic check against the game data
 * (known visible chess, legal skill index for the normal AND the elite status, legal module of the elite) is
 * `checkLoadout` — used by the server (lobby, match) and by the client to sanitise a stored loadout before sending.
 */
export const LOADOUT_LIMITS = Object.freeze({ entries: 160, skillIndex: 9, ops: 256 });
/** The "no module" choice of an elite (模组: 不装备). */
export const MODULE_NONE = 'none';

/**
 * 炸惊模拟的默认模组表 (data/zjDefaultLoadout.json)。
 *
 * 炸惊棋子的精锐记录 (`chess_zj_*_b`) 有一些带着 `modules[]` 却**没有数据自己的默认模组** —— 既没有 `isDefault`,
 * `module.active` 也不是 true。于是「不装备」成了它们的默认, 玩家什么都不配时这些干员就裸装上阵 (用户 2026-10-11
 * 的「默认模组接线」)。这张表给出每位干员的选装 (85 条, 与 data/chess.json 同一批数据生成, 只收有模组的)。
 *
 * 表由两端各登记一次 —— 服务端 server/data.js 载入 data/*.json 时, 浏览器 public/js/data.js 下载完该文件时 ——
 * 之后 `loadoutOptions` 读的就是它。因为 `loadoutOptions` 是**唯一**的默认值来源 (干员调配的选项列表与默认值、
 * client ui/gameLogic/loadout.js 的 chessLoadout、服务端 checkLoadout 与 resolveLoadout 都经它),
 * 「干员调配里显示的默认模组」「局内详情卡的白值/特性」和「战斗里那只干员真的装了什么」必然是同一个答案。
 * 没有登记 (旧包没有这份数据文件) 时一切照旧。
 */
let zjDefaultByBaseId = null;

/**
 * 登记炸惊默认模组表: 接受 data/zjDefaultLoadout.json 的整份记录, 或它的 `byBaseId`; 其它形状 / null = 清空。
 * 只收 `{ [baseChessId]: { module } }` 里键与模组 id 都合法 (isId) 的条目。
 * @param {any} table
 * @returns {number} 收下的条目数
 */
export function setZjDefaultModules(table) {
  const by = table && typeof table === 'object' ? (table.byBaseId ?? table) : null;
  const out = {};
  let n = 0;
  if (by && typeof by === 'object') {
    for (const [id, e] of Object.entries(by)) {
      const mod = e && typeof e === 'object' ? e.module : null;
      if (isId(id) && typeof mod === 'string' && isId(mod) && mod !== MODULE_NONE) { out[id] = mod; n++; }
    }
  }
  zjDefaultByBaseId = n ? out : null;
  return n;
}

/** 当前登记的炸惊默认模组表 `{ [baseChessId]: uniEquipId }` (null = 没有登记 / 表是空的)。 */
export function zjDefaultModules() { return zjDefaultByBaseId; }

/**
 * 一名炸惊干员的默认模组: 只在「精锐记录自己写着 `zhajing: true`」**且**「它的 `modules[]` 里没有数据自己的默认」
 * 时, 取表里的选装。别的难度、别的棋子 (普通 / 精锐 / 自选 / 补位) 一律 null —— 调用者继续用 `opt.defaultModule`。
 * @param {any} golden 该干员的精锐记录 (data/chess.json `chess_zj_*_b`)
 * @param {string|null} baseId 基础棋子 id (表与 loadout 的键, `chess_zj_*_a`)
 * @param {string[]} modules 该记录可选的模组 id (loadoutOptions 的 modules, 含 'none')
 * @returns {string|null}
 */
export function zjDefaultModuleId(golden, baseId, modules) {
  if (!zjDefaultByBaseId || !golden || golden.zhajing !== true || typeof baseId !== 'string') return null;
  const id = Object.hasOwn(zjDefaultByBaseId, baseId) ? zjDefaultByBaseId[baseId] : null;
  return id && Array.isArray(modules) && modules.includes(id) ? id : null;
}
const isLoadoutEntry = (e) => isPlain(e) && Object.keys(e).length > 0 && Object.keys(e).every((k) => k === 'skill' || k === 'module')
  && optional((v) => isInt(v, 0, LOADOUT_LIMITS.skillIndex))(e.skill) && optional(isId)(e.module);
/** Structural check of `room.loadout.entries`. */
export const isLoadoutEntries = (v) => isMap(v, LOADOUT_LIMITS.entries, isId, isLoadoutEntry);

/** Skill indexes a chess record offers (data `skills[]`, DESIGN §16; the default skill alone while data lacks it). */
function skillIndexesOf(c) {
  if (!c || typeof c !== 'object') return [];
  if (Array.isArray(c.skills) && c.skills.length) {
    return [...new Set(c.skills.map((s) => s && s.index).filter((i) => isInt(i, 0, LOADOUT_LIMITS.skillIndex)))].sort((a, b) => a - b);
  }
  return isInt(c.skill?.index, 0, LOADOUT_LIMITS.skillIndex) ? [c.skill.index] : [];
}

/**
 * What the 干员调配 screen may choose for one chess (DESIGN §16).
 *   skills: skill indexes unlocked at BOTH the normal and the elite status (identical sets in the official data)
 *   defaultSkill: `defaultSkillIndex` (data: the skills[] entry flagged isDefault, else `skill.index`)
 *   modules: the elite's modules (uniEquipId…) + 'none'; [] when the chess has no elite record
 *   defaultModule: the elite's default module (`defaultUniEquipId`), 'none' for module-less elites, null without elite.
 *     炸惊模拟的精锐记录自己没有默认模组时取 data/zjDefaultLoadout.json 的选装 (setZjDefaultModules / zjDefaultModuleId)
 * @param {any} base normal chess record
 * @param {any} [golden] its elite record (null when absent)
 * @returns {{ skills: number[], defaultSkill: number|null, modules: string[], defaultModule: string|null }}
 */
export function loadoutOptions(base, golden = null) {
  const n = skillIndexesOf(base);
  const g = golden ? skillIndexesOf(golden) : null;
  const skills = g && g.length ? n.filter((i) => g.includes(i)) : n;
  const flagged = Array.isArray(base?.skills) ? base.skills.find((s) => s && s.isDefault && isInt(s.index, 0, LOADOUT_LIMITS.skillIndex)) : null;
  let defaultSkill = flagged ? flagged.index : isInt(base?.skill?.index, 0, LOADOUT_LIMITS.skillIndex) ? base.skill.index : null;
  if (defaultSkill == null || !skills.includes(defaultSkill)) defaultSkill = skills.length ? skills[0] : defaultSkill;
  let modules = [];
  let defaultModule = null;
  if (golden) {
    let def = null;
    if (Array.isArray(golden.modules)) {
      modules = [...new Set(golden.modules.map((m) => m && m.uniEquipId).filter((id) => isId(id) && id !== MODULE_NONE))];
      const d = golden.modules.find((m) => m && m.isDefault && isId(m.uniEquipId));
      def = d ? d.uniEquipId : null;
    } else if (golden.module && golden.module.active && isId(golden.module.id)) {
      modules = [golden.module.id];
    }
    if (def == null && golden.module && golden.module.active && modules.includes(golden.module.id)) def = golden.module.id;
    // 炸惊模拟: 数据自己没有默认模组的精锐 (chess_zj_*_b: 无 isDefault, module.active !== true) 用表里的选装。
    // 上面两条都不成立时才走到这里 —— 也就是说数据已有的默认优先, 本表只补「不装备」这一档 (用户 2026-10-11)。
    if (def == null) def = zjDefaultModuleId(golden, golden.baseId || base?.chessId || null, modules);
    modules.push(MODULE_NONE);
    defaultModule = def || MODULE_NONE;
  }
  return { skills, defaultSkill, modules, defaultModule };
}

/**
 * Semantic check + normalisation of a loadout against the game data (DESIGN §16). Strict: any unknown / hidden / elite
 * chess id, illegal skill index or module rejects the whole loadout. Entries equal to the defaults are dropped, the
 * rest are stored complete: `{ skill, module }` (module null for a chess without an elite record).
 * @param {any} entries `room.loadout.entries`
 * @param {(id: string) => any} getChess chess record lookup (normal and golden ids)
 * @returns {{ ok: true, loadout: Record<string, { skill: number, module: string|null }> } | { error: 'BAD_MSG'|'BAD_TARGET', detail: string }}
 */
export function checkLoadout(entries, getChess) {
  if (!isLoadoutEntries(entries)) return { error: 'BAD_MSG', detail: 'bad loadout entries' };
  const out = {};
  for (const id of Object.keys(entries)) {
    const e = entries[id];
    const base = typeof getChess === 'function' ? getChess(id) : null;
    // 注意：这里**不能**用 `visible === false` 否掉一条记录。炸惊难度的干员（chess_zj_*）是 visible:false 的
    // ——它们不在普通商店里，但正是炸惊模式自己的棋子。以前这一条会把整份 loadout 判成 "unknown chess"，
    // 于是「干员调配」里给炸惊干员选的技能被整份丢弃、局内永远是一技能（用户 2026-10-11 的反馈）。
    // `getChess` 已经是这名玩家在本局的数据视图（含封禁），拿得到就说明他能用。
    // ★ 2026-10-13 修「大厅的干员调配不生效 / 详情卡永远是默认技能、装备 0/2」：
    // 客户端在发送前会自己跑一遍 checkLoadout 消毒（public/js/ui/loadoutModel.js），而这里原来
    // 「baseId !== id 就判非法」→ 玩家给**精英版**（chess_*_b）配的技能/模组被整条丢掉，
    // 客户端于是发了一份空 loadout，局内自然全是默认值（控制台里连报错都没有，正是这个原因）。
    // 现在把精英副本的 id 归一化到它的 base 上再校验（金色/隐藏/自选仍然拒绝，行为不变）。
    // ★ 2026-10-25：**永久 DIY 干员记录**（chess_chen3_a/b、惊变发放的白铁那一类：isDiy + 有 charId）也可以配技能/模组。
    //   自选编队「槽位」记录（chess_char_*_diy*_a/b）的 charId 是 null，仍然拒绝（它们的技能由玩家在本局的 pick 决定）。
    const diyOperator = (r) => !!(r && r.isDiy && typeof r.charId === 'string' && r.charId);
    let key = id;
    let rec = base;
    if (rec && rec.baseId && rec.baseId !== id && (!rec.isDiy || diyOperator(rec))) {
      const b2 = typeof getChess === 'function' ? getChess(rec.baseId) : null;
      if (b2 && !b2.isHidden && (!b2.isDiy || diyOperator(b2))) { key = rec.baseId; rec = b2; }
    }
    if (!rec || rec.isGolden || rec.isHidden || (rec.isDiy && !diyOperator(rec)) || (rec.baseId && rec.baseId !== key)) {
      return { error: 'BAD_TARGET', detail: `unknown chess ${id}` };
    }
    const golden = rec.goldenId ? getChess(rec.goldenId) || null : null;
    const opt = loadoutOptions(rec, golden);
    const skill = e.skill ?? opt.defaultSkill;
    if (!opt.skills.includes(skill)) return { error: 'BAD_TARGET', detail: `skill ${e.skill} not available for ${id}` };
    if (e.module !== undefined && !golden) return { error: 'BAD_TARGET', detail: `${id} has no elite module` };
    const module = golden ? (e.module ?? opt.defaultModule) : null;
    if (golden && !opt.modules.includes(module)) return { error: 'BAD_TARGET', detail: `module ${e.module} not available for ${id}` };
    if (skill === opt.defaultSkill && module === opt.defaultModule) continue;
    out[key] = { skill, module };   // 键统一成 base id，局内 resolve 才找得到 ✓
  }
  return { ok: true, loadout: out };
}

// ---- operator 潜能 / 练度 (0.2.2): room.loadout { ops } ------------------------------------------------------

/**
 * `room.loadout { ops }` (0.2.2, the owner's decision of 2026-10-08 「调配干员里自己设置吧，默认满潜满加成」): `ops` =
 * `{ [charId]: { potential?: 1–6, cultivate?: 0–3 } }` — the per-operator 潜能 and 练度 the player set on the 干员调配
 * screen (shared/potential.js). Keyed by charId, not chess id: the normal, elite and 自选 forms of one operator share
 * one setting. Absent / partial = 潜能 6 and 精英2 Lv.60 (the defaults). Structural limits here; the semantic check
 * against the game data is `checkLoadoutOps`.
 */
const isOpsEntry = (e) => isPlain(e) && Object.keys(e).length > 0
  && Object.keys(e).every((k) => k === 'potential' || k === 'cultivate')
  && optional(isPotential)(e.potential) && optional(isCultivate)(e.cultivate);
/** Structural check of `room.loadout.ops`. */
export const isLoadoutOps = (v) => isMap(v, LOADOUT_LIMITS.ops, isId, isOpsEntry);

/**
 * The operators a player may set a potential / 练度 for (0.2.2): the charIds of the 干员调配 roster — the visible normal
 * chess (checkLoadout's targets) — plus the owned 6★ 自选 picks (`data/backups.json` `diy.ownedPool`). A 补位 stand-in
 * or a prototype 自选 pick takes neither (another operator's body).
 * @param {Record<string, any>|null|undefined} chess data/chess.json
 * @param {any} [backups] data/backups.json
 * @returns {Set<string>}
 */
export function cultivationCharIds(chess, backups = null) {
  const out = new Set();
  for (const c of Object.values(chess && typeof chess === 'object' ? chess : {})) {
    // ★ 2026-10-13 修「大厅的干员调配不生效」：炸惊难度自己的干员（chess_zj_*）是 visible:false、
    // 靠 zhajing:true 标记的（同 checkLoadout 第 220 行的注释、gamedata.js 的 visibleChess 规则）。
    // 这里只认 visible → 炸惊干员全被排除 → 玩家给它们设的 潜能/练度 被 checkLoadoutOps 判成非法，
    // 整条 room.loadout 被拒 → 大厅配了也不生效。
    if (c && !c.isGolden && !c.isDiy && !c.isHidden && (c.visible !== false || c.zhajing === true)
      && (!c.baseId || c.baseId === c.chessId) && isId(c.charId)) out.add(c.charId);
  }
  for (const id of Array.isArray(backups?.diy?.ownedPool) ? backups.diy.ownedPool : []) if (isId(id)) out.add(id);
  return out;
}

/**
 * Semantic check + normalisation of `room.loadout.ops` (0.2.2) — strict like checkLoadout: an operator the server does
 * not know (`isOperator`) rejects the whole message. Entries equal to the defaults (潜能 6, 练度 3) are dropped; the
 * rest are stored complete `{ potential, cultivate }`. `undefined` / `null` = no settings (`{}`).
 * @param {any} ops
 * @param {(charId: string) => boolean} isOperator
 * @returns {{ ok: true, ops: Record<string, { potential: number, cultivate: number }> }
 *           | { error: 'BAD_MSG'|'BAD_TARGET', detail: string }}
 */
export function checkLoadoutOps(ops, isOperator) {
  if (ops == null) return { ok: true, ops: {} };
  if (!isLoadoutOps(ops)) return { error: 'BAD_MSG', detail: 'bad operator settings' };
  const out = {};
  let dropped = 0;
  for (const id of Object.keys(ops)) {
    // 2026-10-11（用户 Console 的 BAD_TARGET operator settings）：不认识的干员**只丢这一条**，不再整份拒绝。
    // 客户端按自己那份数据认为合法、服务端按本局名单判非法时（炸惊花名册 visible:false），整份丢掉是最坏的结局：
    // 玩家在干员调配里设的技能/模组/潜能/练度一条都不生效。形状不合法仍然按 BAD_MSG 拒（那是客户端的 bug）。
    if (typeof isOperator === 'function' && !isOperator(id)) { dropped++; continue; }
    const potential = ops[id].potential ?? POTENTIAL_DEFAULT;
    const cultivate = ops[id].cultivate ?? CULTIVATE_DEFAULT;
    if (potential === POTENTIAL_DEFAULT && cultivate === CULTIVATE_DEFAULT) continue;
    out[id] = { potential, cultivate };
  }
  return { ok: true, ops: out, dropped };
}

// ---- 卡池预选 (0.2.2 百卫): room.loadout { bans } -----------------------------------------------------------

/**
 * `room.loadout { bans }` (the 100-seat variant's own feature): the 盟约 a player wants OFF, picked per difficulty
 * before a room exists — the player's own pool is built from it (server/match/player/rules.js INDEPENDENT POOL), so
 * every player's shop differs. Shape: the `byDifficulty` profile of shared/banPick.js; only the difficulty the match
 * runs with is used. Structural limits: the profile's own caps, checked semantically by `checkLoadoutBans`.
 */
/** Upper bound on one difficulty's stored id lists (the game has 8 大盟约 / 11 小盟约 with weight > 0). */
export const BANPICK_MAX = 24;
const isBanEntry = (e) => isPlain(e) && Object.keys(e).every((k) => k === 'bonds' || k === 'favorites' || k === 'fill')
  && (e.bonds === undefined || (Array.isArray(e.bonds) && e.bonds.length <= BANPICK_MAX && e.bonds.every(isId)))
  && (e.favorites === undefined || (Array.isArray(e.favorites) && e.favorites.length <= BANPICK_MAX && e.favorites.every(isId)))
  && (e.fill === undefined || isBool(e.fill));
/** Structural check of `room.loadout.bans`. */
export const isLoadoutBans = (v) => isPlain(v)
  && (v.v === undefined || v.v === 1)
  && (v.byDifficulty === undefined || (isPlain(v.byDifficulty)
    && Object.keys(v.byDifficulty).every((d) => BANPICK_DIFFICULTIES.includes(d) && isBanEntry(v.byDifficulty[d]))));

/**
 * Semantic check + normalisation of `room.loadout.bans`: an unknown 盟约 id rejects the whole message (strict like
 * checkLoadout). What comes back is the cleaned profile of shared/banPick.js — ids the data knows, favourites lifted
 * out of the ban lists, each difficulty's ban list truncated to its quota, `fill` defaulted on.
 * @param {any} bans
 * @param {{ quota: (difficulty: string) => { core: number, addon: number }, bond: (bondId: string) => any }} data
 * @returns {{ ok: true, bans: any } | { error: 'BAD_MSG'|'BAD_TARGET', detail: string }}
 */
export function checkLoadoutBans(bans, data) {
  if (bans == null) return { ok: true, bans: emptyBanPick() };
  if (!isLoadoutBans(bans)) return { error: 'BAD_MSG', detail: 'bad ban picks' };
  const src = bans.byDifficulty || {};
  for (const d of Object.keys(src)) {
    const e = src[d] || {};
    for (const b of [...(Array.isArray(e.bonds) ? e.bonds : []), ...(Array.isArray(e.favorites) ? e.favorites : [])]) {
      if (!data || typeof data.bond !== 'function' || !data.bond(b)) return { error: 'BAD_TARGET', detail: `unknown bond ${b}` };
    }
    // a favourited id must be a 大盟约 (only those carry the mark)
    for (const b of Array.isArray(e.favorites) ? e.favorites : []) {
      if (!data.bond(b)?.isCore) return { error: 'BAD_TARGET', detail: `${b} is not a 大盟约` };
    }
  }
  const quotas = {};
  for (const d of BANPICK_DIFFICULTIES) quotas[d] = data.quota(d);
  return { ok: true, bans: cleanProfile(bans, quotas, (b) => data.bond(b)) };
}

/**
 * The skill index / module a board chess fights with under a (checked) loadout (DESIGN §16 PlayerBattleInput units):
 * normal chess → `{ skillIndex, moduleId: null }` (normal chess have no module); elite → `moduleId` = uniEquipId or
 * 'none'. Chess the loadout does not mention use their defaults.
 * @param {Record<string, { skill: number, module: string|null }> | null | undefined} loadout
 * @param {any} chess the piece's chess record (normal or golden)
 * @param {(id: string) => any} getChess
 * @returns {{ skillIndex: number|null, moduleId: string|null }}
 */
export function resolveLoadout(loadout, chess, getChess) {
  if (!chess || typeof chess !== 'object') return { skillIndex: null, moduleId: null };
  const baseId = chess.baseId || chess.chessId;
  const base = chess.isGolden ? (getChess(baseId) || chess) : chess;
  const golden = chess.isGolden ? chess : null;
  const opt = loadoutOptions(base, chess.isGolden ? chess : (base.goldenId ? getChess(base.goldenId) || null : null));
  const e = loadout && Object.hasOwn(loadout, baseId) ? loadout[baseId] : null;
  const skillIndex = e && opt.skills.includes(e.skill) ? e.skill : opt.defaultSkill;
  let moduleId = null;
  if (golden) moduleId = e && opt.modules.includes(e.module) ? e.module : opt.defaultModule;
  return { skillIndex, moduleId };
}

// ---- operator ownership (干员持有, 0.2.0 补位): room.ownership { notOwned } -------------------------------------------

/**
 * `room.ownership { notOwned }`: the base chess ids the player marked as not owned on the 干员持有 screen (the
 * per-browser setting next to 干员调配; default: every operator owned ⇒ []). Such a chess keeps its identity (name,
 * bonds, 特质, tier, price, merge) and fights as its official stand-in (shared/standIn.js standInRecord). Structural
 * limit below; the semantic check (`checkNotOwned`) is LENIENT, unlike checkLoadout: an id that is not a droppable chess
 * (unknown, elite, PRESET / 自选, a stale id of another build) is dropped, never the whole list.
 */
export const OWNERSHIP_LIMITS = Object.freeze({ notOwned: 160 });
/** Structural check of `room.ownership.notOwned`: an array of ≤ 160 ids. */
export const isNotOwnedList = (v) => isList(v, OWNERSHIP_LIMITS.notOwned, isId);

/**
 * Semantic check + normalisation of a not-owned list against the game data: keeps the ids of droppable chess
 * (shared/standIn.js isDroppableChess — NORMAL base chess with a stand-in), deduplicated and sorted; drops the rest.
 * Used by the server (lobby, match) and by the client before it sends or imports a list.
 * @param {any} list `room.ownership.notOwned`
 * @param {(id: string) => any} getChess chess record lookup
 * @returns {{ ok: true, notOwned: string[], dropped: number } | { error: 'BAD_MSG', detail: string }}
 */
export function checkNotOwned(list, getChess) {
  if (!isNotOwnedList(list)) return { error: 'BAD_MSG', detail: 'bad notOwned list' };
  const keep = new Set();
  for (const id of list) {
    const c = typeof getChess === 'function' ? getChess(id) : null;
    if (c && c.chessId === id && isDroppableChess(c)) keep.add(id);
  }
  const notOwned = [...keep].sort();
  return { ok: true, notOwned, dropped: list.length - notOwned.length };
}

// ---- 自选编队 (0.2.0 DIY): room.diy { picks } ------------------------------------------------------------------------

/**
 * `room.diy { picks }`: the player's 自选编队 — `{ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }` for the
 * four DIY slots (data/backups.json `diy.slots`: two at tier 5, two at tier 6; shared/diy.js). An out-of-match setting
 * like 干员持有: stored per session / seat, a match takes the picks its seat had at its start. Structural limit below
 * (room for more slots in a later season); the semantic check (`checkDiyPicks`) is LENIENT, like checkNotOwned: an
 * illegal pick — not a pick of the slot's tier, an operator without a kit, a prototype off its locked skill, an unknown
 * skill / module, the same operator twice in a tier, an owned operator in a second slot, an unknown slot — is dropped,
 * never the whole roster; only malformed input is BAD_MSG.
 */
export const DIY_LIMITS = Object.freeze({ slots: 8 });
const isDiyPickWire = (p) => p === null || (isPlain(p) && isId(p.charId)
  && nullable((v) => isInt(v, 0, 9))(p.skillIndex) && nullable(isId)(p.uniEquipId));
/** Structural check of `room.diy.picks`: a map of ≤ 8 slot ids → a pick `{ charId, skillIndex?, uniEquipId? }` or null. */
export const isDiyPicks = (v) => isMap(v, DIY_LIMITS.slots, isId, isDiyPickWire);

/**
 * Semantic check + normalisation of a 自选 roster against the game data (`{ chess, backups }` or a sim DataSource) and
 * the kit registry (`kitted`: server/sim/content/kits/index.js KITTED_CHARS — an operator without a kit is never fielded):
 * the slots are taken in data order (tier 5, then tier 6), and each pick is kept when the roster so far plus it still
 * passes shared/diy.js validateDiyPicks — so the result always passes it, and of two picks that clash (one owned operator
 * in two slots, one operator twice in a tier) the first slot keeps it. Kept picks are complete
 * (`{ charId, skillIndex, uniEquipId }`: a prototype's locked selection, uniEquipId null = no module).
 * @param {any} picks `room.diy.picks`
 * @param {{ data: any, kitted?: Iterable<string>|((id: string) => boolean)|null }} opts
 * @returns {{ ok: true, picks: Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>, dropped: number }
 *   | { error: 'BAD_MSG', detail: string }}
 */
export function checkDiyPicks(picks, { data, kitted = null } = { data: null }) {
  if (!isDiyPicks(picks)) return { error: 'BAD_MSG', detail: 'bad 自选 picks' };
  const slots = diySlotIds(data);
  /** @type {Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>} */
  const kept = {};
  let dropped = 0;
  for (const id of Object.keys(picks)) if (picks[id] != null && !slots.includes(id)) dropped++;
  for (const slotId of slots) {
    const pick = Object.hasOwn(picks, slotId) ? picks[slotId] : null;
    if (pick == null) continue;
    const res = validateDiyPicks({ ...kept, [slotId]: pick }, { data, kitted });
    if ('ok' in res) kept[slotId] = res.picks[slotId];
    else dropped++;
  }
  return { ok: true, picks: kept, dropped };
}

// ---- unit stats (user playtest #4 item 7): m.unitStats units and the browser battle's live stats ---------------------

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
/** Attack interval (s) of a stats object: its own `interval`, else bat × 100 / aspd (null without an attack time). */
const intervalOf = (x) => {
  if (Number.isFinite(x.interval) && x.interval > 0) return round2(x.interval);
  const bat = fin(x.bat, 0);
  const aspd = fin(x.aspd, 100) > 0 ? fin(x.aspd, 100) : 100;
  return bat > 0 ? round2((bat * 100) / aspd) : null;
};
const statView = (x) => ({
  maxHp: Math.round(fin(x.maxHp)), atk: Math.round(fin(x.atk)), def: Math.round(fin(x.def)), res: round1(fin(x.res)),
  interval: intervalOf(x), blockCnt: Math.max(0, Math.round(fin(x.blockCnt))), moveSpeed: round2(fin(x.moveSpeed)),
  // ★ 炸惊模拟「锻造器」：暴击率 / 吸血，按**百分数**下发（5 = 5%），详情卡直接显示。
  //   非炸惊两个都是 0（基础暴击只在炸惊挂），所以界面用它判断要不要显示这两行。
  critRate: round1(fin(x.critRate) * 100), lifesteal: round1(fin(x.lifesteal) * 100),
});

/**
 * The detail card's stats of a sim unit (server/sim/units.js Unit): its effective stats `s` (the aggregated `unit.s`,
 * or the last ones the sim computed) next to its own `unit.base` (no buffs) — max HP, ATK, DEF, RES, attack interval
 * (s), block, move speed — rounded for display (the sim keeps floats), plus the current HP. The shape of the
 * `m.unitStats` units (Match.unitStats: what the board's units start their next battle with) and of the browser
 * runner's live battle stats (public/js/battle/runner.js unitStats). An ally with a range also carries `range`: the grid
 * (`[dRow, dCol]`, facing RIGHT) it attacks with now — a running skill's range, rangeExtend included, not a kit's
 * target-selection grid (the sim's `unit.liveRangeGrid`, Battle._refreshRange; community report E1 after 0.1.0: 烛煌
 * S3's 4-11 never reached the card).
 * @param {{ id?: number, uid?: number|null, defId?: string, hp?: number, alive?: boolean, base?: any, liveRangeGrid?: any } | null} u
 * @param {any} [s] aggregated stats (missing ⇒ the base)
 * @returns {{ id: number|null, uid: number|null, defId: string|null, hp: number, alive: boolean, maxHp: number, atk: number,
 *   def: number, res: number, interval: number|null, blockCnt: number, moveSpeed: number,
 *   base: { maxHp: number, atk: number, def: number, res: number, interval: number|null, blockCnt: number, moveSpeed: number },
 *   range?: Array<[number, number]> }}
 */
export function unitStatsEntry(u, s = null) {
  const base = u && u.base && typeof u.base === 'object' ? u.base : {};
  const cur = s && typeof s === 'object' ? s : base;
  const range = u?.side !== 'enemy' && Array.isArray(u?.liveRangeGrid)
    ? u.liveRangeGrid.filter((p) => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1])).map((p) => [p[0], p[1]])
    : null;
  return {
    id: Number.isInteger(u?.id) ? u.id : null,
    uid: Number.isInteger(u?.uid) ? u.uid : null,
    defId: typeof u?.defId === 'string' ? u.defId : null,
    hp: Math.max(0, Math.round(fin(u?.hp))),
    alive: u?.alive !== false,
    ...statView(cur),
    base: statView(base),
    ...(range ? { range } : {}),
    // the enemy card greys a SILENCE-format line (折射) from this; absent flags ⇒ not silenced
    silenced: !!(cur.flags && cur.flags.silence),
  };
}

/** Deploy directions (DESIGN §3, research 09 §1.2; the same list as server/sim/dir.js DIRS). */
export const DIRS = Object.freeze(['UP', 'RIGHT', 'DOWN', 'LEFT']);
const isDir = (v) => DIRS.includes(v);

const target = (v) => {
  if (!v || typeof v !== 'object') return false;
  if (v.area === 'board') return isInt(v.row, 0, GEO.ROWS - 1) && isInt(v.col, 0, GEO.COLS - 1);
  if (v.area === 'hand') return isInt(v.idx, 0, GEO.HAND_SIZE - 1);
  return false;
};

/** @type {Record<string, Record<string, (v:any)=>boolean> & { $optional?: string[] }>} */
export const C2S = {
  // session & lobby
  // 头像 (shared/avatars.js): an opaque id (`char:` / `e2:` / `skin:` / `band:` / `player:`) — never a URL, so a
  // hostile client cannot make anyone load an arbitrary image. Omitted = keep the session's current one (a rename
  // re-sends hello without it); explicit null = clear it.
  hello: { name: (v) => isStr(v, NAME_MAX_LEN) && v.trim().length > 0, avatar: (v) => v == null || isAvatarId(v), token: (v) => v == null || isStr(v, 64), version: (v) => v == null || isInt(v, 0, 1e6), $optional: ['token', 'version', 'avatar'] },
  ping: { c: (v) => typeof v === 'number' && Number.isFinite(v) },
  // difficulty: the OPEN difficulties only (shared/constants.js isOpenDifficulty, i.e. DIFFICULTIES). Anything else —
  // an unknown value, or a 置灰 entry still sitting in LOCKED_DIFFICULTIES — is refused here exactly like an unknown
  // value, so a greyed-out card on the client is backed by the server and never only a UI state. 炸惊模拟 used to be
  // refused this way; it is in DIFFICULTIES now that it is open.
  // `cap` (用户 2026-10-13): 创建同盟时选的真人席位上限，白名单 = ROOM_HUMAN_CAPS（4 / 8 / 40）。
  // 不传 = 默认 40；solo 房间只有一个座位，服务端忽略它。100 仍然只走 `room.unlock` 的解锁码。
  'room.create': { mode: (v) => v === 'solo' || v === 'coop', difficulty: isOpenDifficulty, cap: (v) => v == null || ROOM_HUMAN_CAPS.includes(v), $optional: ['cap'] },
  'room.join': { code: (v) => isStr(v, ROOM_CODE_LEN + 2) && /^[A-Za-z0-9]+$/.test(v) },
  'room.leave': {},
  'room.ready': { ready: isBool },
  'room.setDifficulty': { difficulty: isOpenDifficulty },
  // the co-op room option 「AI 队友最后选择」 (GitHub #338; host, before the match): the strategy and 机变 drafts order every
  // human seat before every AI seat (server/match/match/phases.js humansFirst); room.state.aiPicksLast
  'room.setAiPicksLast': { on: isBool },
  // host-only: include / exclude this room from the title screen's public room list (server/lobby.js setListed)
  'room.setListed': { listed: isBool },
  // host-only: raise the room from its 40-human cap to the full 100 seats (server/lobby.js unlock). The code is
  // verified ON THE SERVER and never ships in the bundle, so this only forwards what the host typed.
  'room.unlock': { code: (v) => isStr(v, 64) },
  // 外援测试模式 (per player, NOT host-only): the local cheat switch, locked behind the same server-verified code. `code`
  // is optional — once a session has unlocked it, later flips only send `on` (the server remembers, server/lobby.js
  // testMode). Only the player's own seat is touched, so nobody else's shop changes.
  'room.testMode': { on: isBool, code: (v) => isStr(v, 64), $optional: ['code'] },
  'room.addBot': { seat: (v) => v == null || isInt(v, 0, MAX_SEATS - 1) },
  'room.removeBot': { seat: (v) => isInt(v, 0, MAX_SEATS - 1) },
  // the host removes another human before the match (server/lobby.js kick; community report #17); playerId = the one the
  // host confirmed — a seat that changed hands meanwhile is refused
  'room.kick': { seat: (v) => isInt(v, 0, MAX_SEATS - 1), playerId: isId },
  // host-only, no fields: the host removes EVERY seated human who has not readied yet in one message (server/lobby.js
  // kickUnready). Not a client-side loop over room.kick — each removal frees a seat and room.state re-broadcasts the
  // seat layout, so a loop would chase moved indexes. Nobody to remove is a success, not an error.
  'room.kickUnready': {},
  'room.start': {},
  // operator loadout (DESIGN §16) + the per-operator 潜能 / 练度 (0.2.2) + the 卡池预选 `bans` (the 100-seat variant's
  // own feature): stored per session/seat; accepted until the match leaves INFO_CHECK
  'room.loadout': { entries: isLoadoutEntries, ops: isLoadoutOps, bans: nullable(isLoadoutBans), $optional: ['ops', 'bans'] },
  // operator ownership (干员持有, 0.2.0 补位): stored per session / seat; a match takes the list its seat had when it
  // started (an out-of-match setting — during a match it is stored for the next one: ROOM_STARTED)
  'room.ownership': { notOwned: isNotOwnedList },
  // 自选编队 (0.2.0 DIY): the player's DIY slot picks; stored per session / seat like room.ownership (a match takes the
  // picks its seat had when it started; during a match they are stored for the next one: ROOM_STARTED)
  'room.diy': { picks: isDiyPicks },
  // 干员皮肤 (docs/SKINS.md): public, accepted in any room phase
  'room.skins': { skins: isSkinSelection },
  // spectator seats (remake feature, community report #26; MAX_SPECTATORS): take one of a co-op room's spectator seats —
  // in its lobby or while its match runs — never a player seat; the host frees one by playerId (the spectator gets
  // room.closed { reason: 'kicked' }). room.leave / g.leave leave a spectator seat like a player seat.
  'room.spectate': { code: (v) => isStr(v, ROOM_CODE_LEN + 2) && /^[A-Za-z0-9]+$/.test(v) },
  'room.removeSpectator': { playerId: isId },

  // match
  'g.infoReady': {},
  'g.band': { bandId: isId },
  'g.bandSkip': {},
  // the strategy highlighted in the draft screen (user playtest #4 item 4): a turn that runs out takes it while it is
  // free (Match.timeoutBand); absent / null clears it
  'g.bandFocus': { bandId: nullable(isId), $optional: ['bandId'] },
  'g.buy': { slot: (v) => isInt(v, 0, 15) },
  'g.refresh': {},
  // 惊变「维多利亚的秘密」: 本回合那一次特殊刷新（用户 2026-10-12）
  'g.specialRefresh': {},
  // 惊变「死亡回归」商店栏的按键（owner 2026-10-16）：按下 → 自己目标生命归 0、立刻淘汰、
  // 3 秒后全体回到该回合整备阶段（自己恢复生命、效果改成「你激怒了某位大人，她不再保护你」，本卡失效）。
  'g.deathReturn': {},
  // 惊变「”神秘“商店」的**独立**特殊刷新按钮（owner 2026-10-16）：无视商店等级刷一次。
  // 与 'g.specialRefresh'（维多利亚的秘密）分开，因为两张卡可以同时持有、需要分别发动。
  'g.mysticRefresh': {},
  // 惊变「板藤」: 套现（卖价 4 起、每回合 +4；用户 2026-10-12）
  'g.sellBanteng': {},
  // 惊变「高卢银行支票」: 提现（金额 = 每个整备阶段掷出的 +10 / 0 / -10 / +100；用户 2026-10-13）
  'g.cashCheque': {},
  'g.freeze': {},
  'g.levelUp': {},
  'g.sell': { uid: isUid },
  // 休整期换技能 / 模组（第三方 mod 移植，2026-10-11）：**单干员增量**
  // `{ [基础棋子 id | 自选槽 id]: { skill?: 0–9, module?: uniEquipId | 'none' } }`，至少一项。
  // 校验只做结构（语义在服务端 platform.setPrepLoadout → checkLoadout / checkDiyPick）。
  'g.loadout': {
    loadout: (v) => isMap(v, LOADOUT_LIMITS.entries, isId, (e) => isPlain(e)
      && Object.keys(e).length > 0
      && Object.keys(e).every((k) => k === 'skill' || k === 'module')
      && optional((x) => isInt(x, 0, LOADOUT_LIMITS.skillIndex))(e.skill)
      && optional(isId)(e.module))
      && isPlain(v) && Object.keys(v).length > 0,
  },
  // dir: the facing chosen on the deploy wheel for a board target (absent ⇒ RIGHT; the piece's own tile ⇒ re-orient)
  'g.move': { uid: isUid, to: target, dir: isDir, $optional: ['dir'] },
  // replaceUid: with both of the target's slots used, the equipped item the replace dialog picked (research 09 §1.2
  // UseEquipUp.unloadInstId; absent ⇒ the oldest; not one of the target's items ⇒ BAD_TARGET)
  'g.equip': { itemUid: isUid, targetUid: isUid, replaceUid: nullable(isUid), $optional: ['replaceUid'] },
  'g.art': { itemUid: isUid, row: (v) => isInt(v, 0, GEO.ROWS - 1), col: (v) => isInt(v, 0, GEO.COLS - 1), dir: isDir, $optional: ['dir'] },
  'g.destroy': { uid: isUid },
  'g.reward': { idx: (v) => isInt(v, 0, 5) },
  'g.choice': { idx: (v) => isInt(v, 0, 5) },
  // 炸惊模拟 规则5: the one reroll of a single 惊变 card the 惊变阶段 grants (idx = the card to redraw)
  'g.spReroll': { idx: (v) => isInt(v, 0, 5) },
  'g.ready': { ready: isBool },
  'g.emote': { id: (v) => EMOTES.includes(v) },
  // playerId: the player tapped in the team panel (a 联防 / boss pair field shows two) — what an eliminated viewer or a
  // spectator seat follows from then on (Match.watchPref; community report of 2026-10-06, item 56)
  'g.watch': { fieldId: (v) => isStr(v, 32), playerId: isId, $optional: ['playerId'] },
  'g.autoplay': { on: isBool },
  // solo pause (official PauseUp / ResumeUp, DESIGN §14): freezes the running battle (field clock, deadlines, the
  // browser's local runner) — solo matches only (co-op ⇒ WRONG_PHASE), only while a battle runs; m.public.paused
  'g.pause': { on: isBool },
  // the stats the own board's units start their next battle with (user playtest #4 item 7; prep phases): answered by
  // the push m.unitStats { seq, round, units: [unitStatsEntry] }; `seq` is echoed so the client keeps the newest answer
  'g.unitStats': { seq: (v) => isInt(v, 0, 2 ** 31), $optional: ['seq'] },
  // ★ 炸惊模拟「锻造器」(user 2026-10-14)：选一张锻造卡（optId 见 shared/forgeData.js，
  //   rarity 是这一组的稀有度；服务端负责校验、扣数、累计与立即效果）
  'g.forgeTake': { optId: (v) => isStr(v, 24), rarity: (v) => ['normal', 'epic', 'legend'].includes(v) },
  'g.leave': {},

  // client-side combat (DESIGN §14): the authoritative client of a field reports its battle; a 联防 field adds
  // `left` = { [leakerId]: its enemies still standing (unspawned, alive, or through again) } (server/sim/spec.js
  // uniteLeft; user playtest #6 item 7 — the leakers' live counter)
  'b.progress': {
    battleId: isId, gt: (v) => isNum(v, 0, 1e5), killed: (v) => isInt(v, 0, 1e5), total: (v) => isInt(v, 0, 1e5),
    leaks: (v) => isNum(v, 0, 1e6), bossDmg: (v) => isNum(v, 0, BIG),
    by: (v) => isMap(v, RESULT_LIMITS.players, isId, (x) => isNum(x, 0, BIG)), done: isBool,
    left: (v) => isMap(v, RESULT_LIMITS.players, isId, (x) => isInt(x, 0, 1e5)),
    $optional: ['leaks', 'bossDmg', 'by', 'done', 'left'],
  },
  'b.result': { battleId: isId, result: isBattleResult },
};

// Server → client message types (documentation + client dispatch table keys).
export const S2C = [
  'welcome', 'ok', 'error', 'pong',
  'room.state', 'room.closed',
  'm.public', 'm.private', 'm.field', 'm.toast', 'm.ticker', 'm.emote', 'm.result',
  // m.unitStats { seq, round, units: [unitStatsEntry] } — the answer to g.unitStats (the requester only)
  'm.unitStats',
  // client-side combat (DESIGN §14): b.start { battleId, fieldId, kind, spec, authoritative, startAt, serverNow, elapsed,
  // speed, watch? } · b.pool { hp, max, teamLp, acked: { [fieldId]: cumulative boss damage counted } } ·
  // b.end { battleId, fieldId, reason }
  'b.start', 'b.pool', 'b.end',
  // server-run combat streaming (legacy / SP_COMBAT=server only)
  'b.snap', 'b.ev',
  // 干员皮肤 (docs/SKINS.md)：服务端→客户端（客户端 skins.js 收这条；缺了会判 unhandled type）
  'room.skins',
  // 惊变「死亡回归」(owner 2026-10-16)：玩家按下那个按钮时，全场播其专属播报音。
  // 单独一条而不是复用 m.emote —— 复用会连带飞出一条表情弹幕图，而 owner 要的是"只用上方 ticker 播报 + 播音频"。
  // 载荷 { playerId, name }：name 是按下按钮的玩家（客户端只用于本地判断，不进弹幕）。
  'm.deathReturn',
];

/**
 * Validate a decoded client message. Returns `null` when valid, otherwise a short reason string.
 * Extra unknown fields are ignored (not copied by handlers).
 */
export function validateC2S(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'not an object';
  const spec = typeof msg.t === 'string' && Object.hasOwn(C2S, msg.t) ? C2S[msg.t] : null;
  if (!spec) return `unknown type ${String(msg.t).slice(0, 32)}`;
  if (msg.rid != null && !isInt(msg.rid, 0, 2 ** 31)) return 'bad rid';
  const optional = spec.$optional || [];
  for (const [k, check] of Object.entries(spec)) {
    if (k === '$optional') continue;
    const v = msg[k];
    if (v === undefined && optional.includes(k)) continue;
    if (!check(v)) return `bad field ${k}`;
  }
  return null;
}

// Event tuple kinds inside `b.ev` (DESIGN §8.2).
export const EV = Object.freeze({
  SPAWN: 'spawn', ATK: 'atk', DMG: 'dmg', HEAL: 'heal', SKILL: 'skill', ENGAGE: 'engage', DIE: 'die', LEAK: 'leak',
  STATUS: 'status', FX: 'fx', LAYER: 'layer', BOUNTY: 'bounty', DEPLOY: 'deploy',
});

/**
 * The model form a `b.ev` 'fx' tuple ['fx', kind, x, y, extra] puts its unit in: `extra.form` (sim content/enemies/helpers.js
 * setForm — 转译基底·α's forms, a 逐火 余烬 and its revival, a leader's 重生, 守墓石像's modes, 掠海漂移体's crawl; a 傀儡师's 替身,
 * sim professions.js; a string is that clip set, null the base one), undefined for any other tuple. A form is state, not decoration: a view that misses
 * the fx keeps drawing the old model (player report #5 after 0.1.0), so the client's catch-up frames, its hidden-tab
 * backlog (battle/runner.js) and the events buffered before a field is entered (screens/game.js) keep these tuples.
 */
export function fxForm(ev) {
  if (!Array.isArray(ev) || ev[0] !== EV.FX) return undefined;
  const x = ev[4];
  if (!x || typeof x !== 'object' || x.id == null || !Object.hasOwn(x, 'form')) return undefined;
  return typeof x.form === 'string' ? x.form : null;
}


/**
 * 来自上游 0.3.0：该干员的潜能是否会改变数值（有潜能曲线的干员才允许非默认潜能）。
 * 由 DSH 于 2026-10-16 从 v0.3.0 的 shared/protocol.js 移植，函数体逐字一致。
 */
export function charPotentialChanges(data, charId) {
  if (typeof charId !== 'string' || !charId.startsWith('char_x_')) return true;
  const chess = data?.chess;
  if (chess && typeof chess === 'object') {
    for (const c of Object.values(chess)) if (c?.charId === charId && hasPotentialData(c)) return true;
  }
  const unit = data?.backups?.units?.[charId];
  if (unit) {
    if (hasPotentialData(unit)) return true;
    for (const f of Object.values(unit.forms ?? {})) if (hasPotentialData(f)) return true;
  }
  return false;
}
