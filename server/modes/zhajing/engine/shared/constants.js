// Shared enums & constants (server + browser). Pure ESM, no Node APIs.

import { N_ } from './i18n.js';

export const PROTOCOL_VERSION = 1;
/** Release version shown to players (title screen, server banner, /healthz). Kept equal to package.json "version"
 * (test/version.test.js); PROTOCOL_VERSION above is the separate wire-format number. */
// ★ 2026-10-18（owner：1服单核跑满 → 玩家反馈卡）：模拟步频，服务端与客户端**必须同一值**。
//   30 → 20 让每场对局的服务端 CPU 降约 1/3；对外广播本来就是 10Hz（DELAYS.PUBLIC_THROTTLE），
//   所以画面刷新率不变，只是每帧之间的插值步数少一步。
export const SIM_HZ = 15;   // ★ 2026-10-18 晚：20 → 15（服务端 CPU 再降约 25%）；对外帧率仍是 20Hz，插值不露馅
export const TICK = 1 / SIM_HZ;

export const APP_VERSION = '0.3.1-mod.4';
/** A development build (the public `dev` branch): the title screen, the boot banner and the README say so, and
 * tools/package.mjs refuses to build a release zip from it without --allow-dev. */
export const DEV_BUILD = /-dev$/.test(APP_VERSION);

export const MAX_SEATS = 100;
/**
 * 创建同盟时可选的**真人席位上限**（用户 2026-10-13：创建同盟旁的三档开关 4 / 8 / 40）。
 * 40 是默认档：公共房间实际能坐满、也还看得清（快照是 O(N²) 扇出，见 server/lobby.js 的说明）；
 * 100 仍然是创建者输入解锁码之后的上限（`room.unlock`），不在这个开关里。
 * 服务端用同一份列表做白名单（shared/protocol.js `room.create.cap`），前端三档直接读它。
 */
export const ROOM_HUMAN_CAPS = Object.freeze([4, 8, 40]);
/** 默认的真人席位上限（= 创建时不选 cap 时的值，也是 ROOM_HUMAN_CAPS 的最后一档）。 */
export const HUMAN_CAP = 40;
/**
 * Spectator seats of a co-op room (community report #26, owner's decision 2026-10-04) — a remake feature: the official
 * room has 1–4 players and no spectator seat (there only eliminated players and 联防 bystanders watch, research 09 §3.1).
 * A spectator never counts as a player, may not act, and watches like an eliminated player (server/lobby.js spectate,
 * server/match/match/watch.js addSpectator).
 */
export const MAX_SPECTATORS = 2;
export const ROOM_CODE_LEN = 4;
export const NAME_MAX_LEN = 12;

/**
 * 服务器承载保护 — the number of humans seated across the WHOLE server at which the server counts as busy.
 * Reaching it (i.e. `Lobby.seatedHumans() >= BOT_FILL_MAX_HUMANS`, 30) does NOT forbid AI teammates: it switches
 * a room from the quiet rule (AI may take every free bot seat, including the AI-only seats above `humanCap` —
 * the 100-seat path) to the busy rule (`BOT_FILL_MAX_BOTS` AI per room). A room the host 解锁了 (`room.unlock`)
 * skips both rules: that is the operator's own decision.
 */
export const BOT_FILL_MAX_HUMANS = 30;

/**
 * 服务器承载保护 — how many AI teammates ONE room may hold while the server is busy (see `BOT_FILL_MAX_HUMANS`)
 * and the room is not unlocked. Every filled seat costs server CPU (the per-round simulation and the snapshot
 * fan-out), so the busy case is capped rather than refused: a room may still fill up to this many AI, and only a
 * further `room.addBot` is refused (ERR.ROOM_BOT_LIMIT). Counted per room over the seats that are `isBot`
 * (`Room.botCount`) — a human seat under AI 托管 is a human seat and never counts.
 */
export const BOT_FILL_MAX_BOTS = 10;

/**
 * ★ 2026-10-18 深夜（owner）：单房 AI 上限不再写死 10，而是**等于客户端可承载的上限**。
 *   单人房：房主浏览器最多代跑 CLIENT_BOTS_SOLO_MAX 个 → 房间最多这么多 AI；
 *   多真人房：每个真人最多代跑 CLIENT_BOTS_PER_PERSON 个 → 房间上限 = 真人数 × 这个数。
 *   好处：房间里出现的每一个 AI 都有人（客户端）真正在算，服务端不再替它们打架。
 *   lobby.js（房间能不能加 AI）和 match/clientCombat.js（真去派给谁算）读同一组常量。
 */
export const CLIENT_BOTS_SOLO_MAX = 12;

/**
 * ★ 2026-10-19（owner：「把机器人的限制搞到每房四个吧，有点没招了」）：
 * 每个房间最多 4 个 AI —— 不管房间里几个真人、也不管客户端能代跑多少。
 * 这是**兜底式的硬上限**：机器人再多，服务端/客户端的边界都可控。
 * 客户端代跑名额（单人 12 / 每人 3）仍然存在，但房间根本放不了那么多 AI。
 */
export const BOT_ROOM_CAP = 4;
export const CLIENT_BOTS_PER_PERSON = 3;

/**
 * 服务器承载保护（2026-10-15 用户：把「服务器总 AI 数」设为 100）——
 * **全服所有房间加起来**同时能坐多少个 AI 队友。与上面两个常量不同，这一条**一直生效**：
 * 不看在线真人多少、也不看房间有没有解锁 —— 它就是这台机器的容量上限。
 *
 * 为什么要有它：`BOT_FILL_MAX_BOTS`（每房 10）只在全服真人 ≥ 30 时才管，而且房主解锁就跳过；
 * 30 人以下时一个房间本来就能一路加到 MAX_SEATS（100）。也就是说在"安静 + 已解锁"的组合下，
 * 单房间可以吃掉整台机器的席位。这一条补上那个缺口：无论什么条件，全服 AI 总数到顶就拒绝。
 *
 * 计数用现成的 `Lobby.stats().bots`（server/lobby.js），它已经遍历所有房间数出这个数，
 * 本来是给 /healthz 显示用的。判定放在 `Lobby.addBot` 里，早于每房那一层的判断。
 */
export const MAX_SERVER_BOTS = 100;

/**
 * The difficulties a room may actually be created with — the OPEN ones. This is the whole whitelist: the lobby's
 * default, its random fallbacks, the in-room picker and the server's own validation (shared/protocol.js
 * `room.create` / `room.setDifficulty`) all key off this list, so nothing that is not in it can ever start a match.
 *
 * 炸惊模拟 (ZHAJING) is the fifth and newest: config.json modes `mode_single_zhajing` / `mode_multi_zhajing`
 * (独创数值与全新卫戍特质, its own 14-round schedule), icon `modeIcon/mode_zhajing_icon`.
 */
export const DIFFICULTIES = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS', 'ZHAJING'];
/**
 * Difficulties that are LISTED in the lobby's 模拟难度 list but not open yet (置灰 + 备注, the entry shows its
 * data/config.json mode record like any other, it just cannot be selected or started). Kept OUT of DIFFICULTIES on
 * purpose: that one list is what every "可随机 / 可默认" path and the server's validation read, so a locked
 * difficulty is refused by the same check that refuses an unknown value — no second code path to keep in sync.
 *
 * EMPTY since 炸惊模拟 opened (it used to be `['ZHAJING']`): the machinery stays for the next difficulty that needs a
 * 置灰 entry, and `DIFFICULTY_LIST` keeps working unchanged because it is a spread of both lists.
 */
export const LOCKED_DIFFICULTIES = [];
/** What the lobby renders, in order: the open difficulties, then the locked ones (greyed out). */
export const DIFFICULTY_LIST = [...DIFFICULTIES, ...LOCKED_DIFFICULTIES];
/** Whether a difficulty may be picked / started. The server validates with this too (never trust the client). */
export const isOpenDifficulty = (d) => DIFFICULTIES.includes(d);

export const DIFFICULTY_NAMES = {
  FUNNY: N_('标准模拟'), NORMAL: N_('险境模拟'), HARD: N_('绝境模拟'), ABYSS: N_('终极模拟'),
  ZHAJING: N_('炸惊模拟（BETAv0.799325）'),   // open: 独创数值与全新卫戍特质
};
export const DIFFICULTY_COLORS = {
  FUNNY: '#f6a329', NORMAL: '#e85a1a', HARD: '#e73118', ABYSS: '#ff0024',
  ZHAJING: '#17d9a0',        // from the icon (emote autochess_battle_scared, mid tone #17af82 brightened)
};

// modeId in data/config.json = `mode_${type}_${difficulty.toLowerCase()}` with type single|multi
export const modeIdFor = (roomMode, difficulty) =>
  `mode_${roomMode === 'solo' ? 'single' : 'multi'}_${difficulty.toLowerCase()}`;

export const PHASE = Object.freeze({
  LOBBY: 'LOBBY',
  INFO_CHECK: 'INFO_CHECK',
  BAND_DRAFT: 'BAND_DRAFT',
  BATTLE_CHECK: 'BATTLE_CHECK',
  ROUND_START: 'ROUND_START',
  // 炸惊模拟 规则14: the 敌方惊变 reveal — ONE card drawn automatically before round 1, shown to the whole room
  // (flickerMs of rolling, then resultMs of the zoomed result) before the round's own flow continues
  ENEMY_JIBIAN: 'ENEMY_JIBIAN',
  // ★ 2026-10-24（owner）：隐秘核心战前的「隐秘惊变」揭示阶段（保底一张隐秘稀有度卡）
  HIDDEN_JIBIAN: 'HIDDEN_JIBIAN',
  SP_DRAFT: 'SP_DRAFT',
  PREP: 'PREP',
  COMBAT: 'COMBAT',
  UNITE: 'UNITE',
  SETTLE: 'SETTLE',
  FINAL_ASSAULT: 'FINAL_ASSAULT',
  HIDDEN_CORE: 'HIDDEN_CORE',
  RESULT: 'RESULT',
});

export const PHASE_NAMES = {
  LOBBY: N_('等待中'), INFO_CHECK: N_('确认本局信息'), BAND_DRAFT: N_('选择策略'), BATTLE_CHECK: N_('协议启动'),
  ROUND_START: N_('回合开始'), ENEMY_JIBIAN: N_('敌方惊变'), HIDDEN_JIBIAN: N_('隐秘惊变'), SP_DRAFT: N_('机变阶段'), PREP: N_('休整期'), COMBAT: N_('作战中'), UNITE: N_('联防阶段'),
  SETTLE: N_('结算'), FINAL_ASSAULT: N_('最终攻势'), HIDDEN_CORE: N_('隐秘核心'), RESULT: N_('模拟结束'),
};

// Board geometry on the 19x21 stage grid (row 0 = bottom). See DESIGN §3.
export const GEO = Object.freeze({
  ROWS: 19, COLS: 21,
  FIELD: { r0: 9, r1: 12, c0: 2, c1: 10 },        // own deployable board region
  NORMAL_RECT: { r0: 9, r1: 12, c0: 0, c1: 10 },  // simulation rect for a normal battle
  UNITE_RECT: { r0: 9, r1: 12, c0: 0, c1: 20 },
  BOSS_RECT: { r0: 0, r1: 5, c0: 0, c1: 20 },
  // 待部署区：**炸惊模式翻倍成两排 20 格，其余难度保持一排 10 格**（用户 2026-10-11）。
  // HAND_SIZE 是协议层的**上限**（客户端可送 0..19），实际格数由 benchSizeOf(modeId) 决定：
  // 模式自己的 config benchSize 优先（炸惊 = 20），否则 BENCH.base（10）。落座规则见 handTileOf。
  HAND_ROW: 7, HAND_SIZE: 20, HAND_PER_ROW: 10, HAND_ROWS: 2,
  // 临时整备区（竖排：同一列、自上而下 N 格）—— 用户 2026-10-13：改 TEMP_COL / TEMP_R0 / TEMP_SIZE 即可整体挪动
  // 临时整备区（4+2 两段竖排，用户 2026-10-13 定稿）：段A 竖 TEMP_SIZE 格，段B 在其右侧一列、下移 TEMP_R0B-TEMP_R0
  TEMP_ROW: 8, TEMP_C0: 4, TEMP_SIZE_NORMAL: 5,   // 普通模式：原样（行 8、列 4–8，5 格；在可放区之外 ✓）
  TEMP_COL: 0, TEMP_R0: 9, TEMP_SIZE: 4,
  TEMP_COL2: 1, TEMP_R0B: 11, TEMP_SIZE2: 2,   // 炸惊：竖排 4+2

  TEMP_ROW: 8, TEMP_C0: 4,
           // temp slot idx 0..4 = cols 4..8           // temp slot idx 0..4 = cols 4..8
  PARTNER_COL_OFFSET: 8,
});


/** 待部署区的两种规格：普通一排 10 格；炸惊两排 20 格（每排 10）。 */
export const BENCH = Object.freeze({ base: 10, per: 10, rows: 2, zhajing: 20 });

/**
 * 某个模式（或直接给格数）的待部署区格数。
 * @param {string|number|null} modeOrSize 模式 id（含 zhajing 即 20）或直接的格数
 * @returns {number}
 */
export function benchSizeOf(modeOrSize = null) {
  if (typeof modeOrSize === 'number' && Number.isFinite(modeOrSize) && modeOrSize > 0) return Math.trunc(modeOrSize);
  return /zhajing/i.test(String(modeOrSize || '')) ? BENCH.zhajing : BENCH.base;
}

/** 格数 → 该排几行（10 → 1 行；20 → 2 行）。 */
export const benchRowsOf = (modeOrSize = null) => Math.max(1, Math.ceil(benchSizeOf(modeOrSize) / BENCH.per));

/**
 * 待部署区槽位 idx → 棋盘格子。普通模式：一排（HAND_ROW 的第 idx 列）；
 * 炸惊：前 10 个在上排 HAND_ROW，其余在下排 HAND_ROW-1（离战场更远那一排）。
 * 客户端绘制/拖动与服务端视角（match/views.js）共用这一条规则。
 * @param {number} idx @param {string|number|null} [modeOrSize] 模式 id 或格数（缺省 = 普通 10 格）
 * @returns {{ row: number, col: number }}
 */
/**
 * 临时整备区槽位 idx → 棋盘格子（**竖排**：同一列，自上而下）。
 * 2026-10-13 起临时区是【蓝门左侧一竖列】：改 TEMP_COL / TEMP_R0 / TEMP_SIZE 就能整体挪。
 * @param {number} idx @returns {{ row: number, col: number }}
 */
export function tempTileOf(idx, modeOrSize = null) {
  const i = Math.max(0, Math.trunc(Number(idx) || 0));
  if (benchSizeOf(modeOrSize) <= BENCH.base) return { row: GEO.TEMP_ROW, col: GEO.TEMP_C0 + i };
  if (i < GEO.TEMP_SIZE) return { row: GEO.TEMP_R0 + i, col: GEO.TEMP_COL };
  return { row: GEO.TEMP_R0B + (i - GEO.TEMP_SIZE), col: GEO.TEMP_COL2 };
}

/** 棋盘格子 → 临时整备区槽位 idx（不在临时区则 null）。 */
export function tempIndexOf(row, col, modeOrSize = null) {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (benchSizeOf(modeOrSize) <= BENCH.base) {
    const i = col - GEO.TEMP_C0;
    return row === GEO.TEMP_ROW && i >= 0 && i < GEO.TEMP_SIZE_NORMAL ? i : null;
  }
  if (col === GEO.TEMP_COL) {
    const i = row - GEO.TEMP_R0;
    return i >= 0 && i < GEO.TEMP_SIZE ? i : null;
  }
  if (col === GEO.TEMP_COL2) {
    const i = row - GEO.TEMP_R0B;
    return i >= 0 && i < GEO.TEMP_SIZE2 ? GEO.TEMP_SIZE + i : null;
  }
  return null;
}

export function handTileOf(idx, modeOrSize = null) {
  const i = Math.max(0, Math.trunc(Number(idx) || 0));
  const rows = benchRowsOf(modeOrSize);
  const per = BENCH.per;
  return { row: GEO.HAND_ROW + Math.min(rows - 1, Math.floor(i / per)), col: i % per };
}

export function handIndexOf(row, col, modeOrSize = null) {
  const per = BENCH.per;
  if (!Number.isInteger(row) || !Number.isInteger(col) || col < 0 || col >= per) return null;
  const rows = benchRowsOf(modeOrSize);
  const down = row - GEO.HAND_ROW;
  if (down < 0 || down >= rows) return null;
  const idx = down * per + col;
  return idx < benchSizeOf(modeOrSize) ? idx : null;
}

export const AREA = Object.freeze({ BOARD: 'board', HAND: 'hand', TEMP: 'temp', OUTSIDE: 'outside' });

export const PIECE_KIND = Object.freeze({ CHESS: 'chess', ITEM: 'item', TOKEN: 'token' });

/**
 * Whether the placed piece of a skill's summon (赫默's 医疗探机, 巫恋's 诅咒娃娃) also deploys once, for free, at the
 * battle start. true = the PRTS reading (卫戍协议/帮助 §作战阶段: "所有手动部署的召唤物，无视所属干员的持有状态…作战开始时
 * 立即部署一次", example 赫默's drone), settled by the user on 2026-10-01 after playtest #6 (DESIGN §20); false = the
 * playtest #4 reading ("是赫默开技能释放一次，不是开局直接就部署了"): it takes its tile only when the owner's skill gives one.
 * Either way the piece re-appears on its tile each time the owner's skill gives one.
 * One switch for everything that depends on it: the sim (server/sim/content/tokens.js dockSkillSummons) and the summon
 * card's hint (public/js/ui/detailPanel.js summonDeployHint). docs/PLAYING.md §4 and docs/SIM.md (token pieces) state
 * the rule in prose — test/ui/playtest6_summons.test.js fails until they match the value.
 */
export const SKILL_SUMMON_START_DEPLOY = true;

/**
 * Official per-bond layer cap (docs/research/11-limits-official.md §1): the client's
 * `Torappu.Battle.AutoChessBattleConst.MAX_GARRISON_STACK = 999`, and its bond counter (`AddBondCount`) stores
 * `min(L + n, 999)` — each bond stops at 999 on its own; the community reports bonds sitting at 999 while fed (巴哈姆特
 * 12534 "每把都能999层", 12316 "999謝"; research 02 §layers). The only implementation of the cap (DESIGN §20.12). Every
 * writer of a bond's layers goes through `layerGainRoom`: the prep-side gains (server/match/player/economy.js addLayers —
 * 特质, items, bands, 机变 cards, bonds), the settle of the in-battle gains (server/match/match/settle.js) and the live in-battle
 * copy (server/sim/battle/economy.js addLayers, as the client's AddBondCount) — and the dev tools' direct writes (tools/matchrun.mjs
 * --layers, tools/balance.mjs applyBoard); a gain at the cap adds 0 (no onLayers, no 'layer'
 * event), and the client-result check (server/match/fields.js) bounds a reported gain by the room left. Milestones paid
 * per N layers (远见, 奇迹, 维多利亚 …) stop with the count. 0 / Infinity = no cap. 炸惊模拟 规则1 raises the cap to
 * 9999 for its own modes (config.modes[*].bondLayerCap → GameData.bondLayerCap), which every caller passes to
 * `layerGainRoom`; this constant stays the official 999 for every other mode.
 */
export const BOND_LAYER_CAP = 999;

/**
 * The layers a gain of `n` actually adds to a bond holding `before` under `cap` (default BOND_LAYER_CAP): min(n, cap −
 * before), never negative (a count already at or over the cap gains 0 and is never lowered); 0 for a non-positive /
 * non-finite `n` except +Infinity (= "the room left"). 炸惊模拟 规则1 raises the cap to 9999 for its modes
 * (GameData.bondLayerCap), so every writer passes its own cap in; the default keeps the official 999 everywhere else.
 */
export function layerGainRoom(before, n, cap = BOND_LAYER_CAP) {
  if (!(n > 0)) return 0;
  // ★ null / undefined = 「这个模式没配」⇒ 官方 999（用户 2026-10-13：有人反馈**普通模式没有 999 上限了**）。
  //   GameData.bondLayerCap 对普通模式返回 null，而 `null > 0` 是 false —— 旧写法把它归进"无上限"那一档，
  //   于是整备期/结算期的加层可以越过 999 一直涨（战斗内那条路有 `typeof … === 'number'` 保护，所以只漏了一部分）。
  //   只有**显式** 0 / Infinity 才是无上限（见上面文档）。
  const c = cap == null ? BOND_LAYER_CAP : (cap > 0 ? cap : Infinity);
  const b = Number.isFinite(before) && before > 0 ? before : 0;
  return Math.max(0, Math.min(n, c - b));
}

/**
 * 一个**模式**的盟约层数上限，给客户端显示用（服务端走 GameData.bondLayerCap + layerGainRoom）。
 * 与 layerGainRoom 同口径：模式自己配了正数就用它（炸惊 9999）；没配（undefined / null）= 官方 999；
 * 显式 0 = 无上限（Infinity）。
 * @param {{ bondLayerCap?: number }|null|undefined} mode config.modes[*] 记录
 * @returns {number}
 */
export function bondLayerCapOf(mode) {
  const v = mode && mode.bondLayerCap;
  if (v == null) return BOND_LAYER_CAP > 0 ? BOND_LAYER_CAP : Infinity;
  return v > 0 ? v : Infinity;
}

/**
 * Official boss-hit limit "限伤" (docs/research/11-limits-official.md §2): `AutoChessBattleConst.MAX_BATTLE_DAMAGE =
 * 300000`. In a boss battle outside training — our battle kinds 'boss' (Final Assault) and 'hidden' (Hidden Core) — a
 * single hit on a leader (`AutoChessBattleUtil.IsBossEnemy`: an enemyId of activity_table autoChessData.bossInfoDict
 * = data/bosses.json `enemyKey`; in the sim the tag-'boss' units: those leaders and their mirrored copies, never parts,
 * escorts or drones) whose `ceil(final damage)` ≥ this is CANCELLED: 0 damage, nothing credited to the shared pool
 * (`AutoChessStepModeManager._OnBossEnemyTakeDamage` → `modifier.Cancel()`). It is not a clamp: a hit of 299999 lands.
 * Checked in server/sim/damage.js (dealDamage after DEF / RES and every multiplier, before shields; Battle.loseHp — not
 * the 胄 drone link's pool share, `noHitLimit`, DESIGN §25.13.4). Minions, normal rounds and 联防 are unaffected.
 * 0 / Infinity = off.
 */
// 100-SEAT VARIANT (docs/FINDINGS-100.md): 限伤 is OFF — the owner's decision. The flat 300000 is a per-hit safety
// valve calibrated for a 4-seat pool; against the 100-seat pool it is negligible anyway (0.08 % vs 2.1 %), so it no
// longer does its job while still cancelling legitimate big hits. `leaderHitCancelled` short-circuits on
// `!(BOSS_HIT_LIMIT > 0)`, so Infinity disables it without touching that code.
export const BOSS_HIT_LIMIT = Infinity;

// Snapshot unit flag bits (DESIGN §8.2)
export const UF = Object.freeze({
  BLOCKED: 1, STUNNED: 2, FROZEN: 4, STEALTH: 8, SKILL: 16, SHIELD: 32, INVULN: 64, COLD: 128, SLEEP: 256, FLYING: 512,
});

export const ANIM = Object.freeze({ IDLE: 0, MOVE: 1, ATTACK: 2, SKILL: 3, DIE: 4, STUN: 5, DEPLOY: 6 });

export const ERR = Object.freeze({
  BAD_MSG: 'BAD_MSG',             // malformed / unknown message
  RATE: 'RATE',                   // rate limited
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_STARTED: 'ROOM_STARTED',
  NOT_HOST: 'NOT_HOST',
  NOT_READY: 'NOT_READY',
  WRONG_PHASE: 'WRONG_PHASE',
  NO_FUNDS: 'NO_FUNDS',
  HAND_FULL: 'HAND_FULL',
  BOARD_FULL: 'BOARD_FULL',
  BAD_TILE: 'BAD_TILE',
  BAD_TARGET: 'BAD_TARGET',
  SOLD_OUT: 'SOLD_OUT',
  MAX_LEVEL: 'MAX_LEVEL',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ALREADY: 'ALREADY',
  TEMP_NOT_EMPTY: 'TEMP_NOT_EMPTY',
  ELIMINATED: 'ELIMINATED',
  SPECTATOR: 'SPECTATOR',         // a spectator seat only watches (MAX_SPECTATORS)
  // 服务器承载保护: this room already holds BOT_FILL_MAX_BOTS AI teammates while the server is busy. Its own code
  // (rather than the generic ROOM_FULL) so the player is told the real reason; the ERR_TEXT below states the cap.
  ROOM_BOT_LIMIT: 'ROOM_BOT_LIMIT',
  // 服务器承载保护: 全服 AI 总数已达 MAX_SERVER_BOTS（不论繁忙与否、不论是否解锁）。
  SERVER_BOT_LIMIT: 'SERVER_BOT_LIMIT',
  INTERNAL: 'INTERNAL',
});

export const ERR_TEXT = {
  BAD_MSG: N_('无效的请求'), RATE: N_('操作过于频繁'), NOT_IN_ROOM: N_('你不在房间中'), ROOM_NOT_FOUND: N_('未找到该同盟密钥对应的房间'),
  ROOM_FULL: N_('房间已满'), ROOM_STARTED: N_('模拟已开始'), NOT_HOST: N_('只有房主可以操作'), NOT_READY: N_('仍有玩家未就绪'),
  WRONG_PHASE: N_('当前阶段无法进行该操作'), NO_FUNDS: N_('资金不足'), HAND_FULL: N_('整备区已满'), BOARD_FULL: N_('已达到部署上限'),
  BAD_TILE: N_('无法部署在该位置'), BAD_TARGET: N_('无效的目标'), SOLD_OUT: N_('已售出'), MAX_LEVEL: N_('调度中心已达最高等级'),
  NOT_YOUR_TURN: N_('尚未轮到你'), ALREADY: N_('已完成该操作'), TEMP_NOT_EMPTY: N_('临时整备区不为空'), ELIMINATED: N_('你已被淘汰'),
  SPECTATOR: N_('观战中无法进行该操作'), INTERNAL: N_('服务器内部错误'),
  // 服务器承载保护: the busy-server AI cap is reached in this room (BOT_FILL_MAX_BOTS). Its own line, not part of the
  // ROOM_FULL sentence above, because 房间已满 would hide the reason; the "10" mirrors BOT_FILL_MAX_BOTS.
  ROOM_BOT_LIMIT: N_('服务器繁忙，本房间的 AI 队友已达上限（10 个）'),
  SERVER_BOT_LIMIT: N_('全服 AI 队友总数已达上限（100 个），请稍后再试或减少 AI'),
};

// ---- Emotes (交流, research 09 §4) -----------------------------------------------------------------------------
// The 36 official in-match emotes: display_meta_table emoticonData, scene AUTOCHESS_BATTLE, 6 themes × 6, one wheel
// page per theme in activity_table autoChessData.enabledEmoticonThemeIdList order, emotes by sortId. `g.emote { id }`
// / `m.emote { playerId, id }` carry the official emoji id. Generated reference: data/emotes.json
// (tools/build-emotes.mjs); test/ui/emotes.test.js keeps this table identical to it.
// Official emotes have no text (desc is null): `label` is ours and only ever an aria-label, never displayed.
// Art: extracted from a local client (tools/local-extract) to /assets/local/emoticon/<dir>/<picId>.png and listed in
// data/local-assets.json group `emoticon/<dir>`; also downloaded from the public mirror by tools/fetch-assets.mjs
// (tools/assets/plan.mjs UI_EXTRAS → data/assets.json ui['emoticon/<dir>/<picId>'], GitHub issue #42). The UI takes the
// local picture first, then the mirror copy, and shows a neutral glyph when neither is there. The picId is not
// derived from the id (autochess_battle_fooldoctor_03…06 → pic_fooldoctor_04/05/06/08_battle).
const emo = (id, sortId, picId, label) => Object.freeze({ id, sortId, picId, label });
export const EMOTE_THEMES = Object.freeze([
  { themeId: 'emoticon_autochess_basic', dir: 'basic', sortId: 100000, isBasic: true, name: N_('表情套组：卫戍协议'), emotes: [
    emo('autochess_battle_happy', 1001, 'pic_happy_battle', N_('开心')),
    emo('autochess_battle_scared', 1002, 'pic_scared_battle', N_('害怕')),
    emo('autochess_battle_sorry', 1003, 'pic_sorry_battle', N_('对不起')),
    emo('autochess_battle_thanks', 1004, 'pic_thanks_battle', N_('谢谢')),
    emo('autochess_battle_thinking', 1005, 'pic_thinking_battle', N_('思考')),
    emo('autochess_battle_nice_cooperate', 1006, 'pic_cooperate_battle', N_('合作愉快')),
  ] },
  { themeId: 'emoticon_originium_slug', dir: 'slug', sortId: 1001, isBasic: false, name: N_('表情套组：虫动'), emotes: [
    emo('slug_autochess_battle_nice_work', 2001, 'pic_nice_work_battle', N_('合作愉快！')),
    emo('slug_autochess_battle_thanks', 2002, 'pic_thanks_battle', N_('谢谢！')),
    emo('slug_autochess_battle_sorry', 2003, 'pic_sorry_battle', N_('对不起！')),
    emo('slug_autochess_battle_bye', 2004, 'pic_bye_battle', N_('再见！')),
    emo('slug_autochess_battle_distrust', 2005, 'pic_distrust_battle', '？？？'),
    emo('slug_autochess_battle_very_soon', 2006, 'pic_very_soon_battle', N_('很快就好！')),
  ] },
  { themeId: 'emoticon_autochess_basic_2', dir: 'basic_2', sortId: 100001, isBasic: true, name: N_('表情套组：卫戍协议'), emotes: [
    emo('autochess_battle_noproblem', 1007, 'pic_noproblem_battle', N_('没问题！')),
    emo('autochess_battle_respect', 1008, 'pic_respect_battle', N_('敬礼！')),
    emo('autochess_battle_call', 1009, 'pic_call_battle', N_('欢呼！')),
    emo('autochess_battle_playingcool', 1010, 'pic_playingcool_battle', N_('酷！')),
    emo('autochess_battle_sad', 1011, 'pic_sad_battle', N_('伤心')),
    emo('autochess_battle_dying', 1012, 'pic_dying_battle', N_('快死了')),
  ] },
  { themeId: 'emoticon_foolsday_doctor', dir: 'fooldoctor', sortId: 1002, isBasic: false, name: N_('表情套组：博士士'), emotes: [
    emo('autochess_battle_fooldoctor_01', 1020, 'pic_fooldoctor_01_battle', N_('博士士 1')),
    emo('autochess_battle_fooldoctor_02', 1021, 'pic_fooldoctor_02_battle', N_('博士士 2')),
    emo('autochess_battle_fooldoctor_03', 1022, 'pic_fooldoctor_04_battle', N_('博士士 3')),
    emo('autochess_battle_fooldoctor_04', 1023, 'pic_fooldoctor_05_battle', N_('博士士 4')),
    emo('autochess_battle_fooldoctor_05', 1024, 'pic_fooldoctor_06_battle', N_('博士士 5')),
    emo('autochess_battle_fooldoctor_06', 1025, 'pic_fooldoctor_08_battle', N_('博士士 6')),
  ] },
  { themeId: 'emoticon_foolsday_amiya', dir: 'foolamiya', sortId: 1003, isBasic: false, name: N_('表情套组：米米子'), emotes: [
    emo('autochess_battle_foolamiya_01', 1040, 'pic_foolamiya_01_battle', N_('米米子 1')),
    emo('autochess_battle_foolamiya_02', 1041, 'pic_foolamiya_02_battle', N_('米米子 2')),
    emo('autochess_battle_foolamiya_03', 1042, 'pic_foolamiya_03_battle', N_('米米子 3')),
    emo('autochess_battle_foolamiya_04', 1043, 'pic_foolamiya_04_battle', N_('米米子 4')),
    emo('autochess_battle_foolamiya_05', 1044, 'pic_foolamiya_05_battle', N_('米米子 5')),
    emo('autochess_battle_foolamiya_06', 1045, 'pic_foolamiya_06_battle', N_('米米子 6')),
  ] },
  { themeId: 'emoticon_foolsday_wisdel', dir: 'foolwisdel', sortId: 1004, isBasic: false, name: N_('表情套组：维维美'), emotes: [
    emo('autochess_battle_foolwisdel_01', 1060, 'pic_foolwisdel_01_battle', N_('维维美 1')),
    emo('autochess_battle_foolwisdel_02', 1061, 'pic_foolwisdel_02_battle', N_('维维美 2')),
    emo('autochess_battle_foolwisdel_03', 1062, 'pic_foolwisdel_03_battle', N_('维维美 3')),
    emo('autochess_battle_foolwisdel_04', 1063, 'pic_foolwisdel_04_battle', N_('维维美 4')),
    emo('autochess_battle_foolwisdel_05', 1064, 'pic_foolwisdel_05_battle', N_('维维美 5')),
    emo('autochess_battle_foolwisdel_06', 1065, 'pic_foolwisdel_06_battle', N_('维维美 6')),
  ] },
  // 用户 2026-10-11：自建「司凤」表情页（两张图 + 各自的音效，见 EMOTE_SOUND）。不在官方表里，
  // 所以 data/emotes.json 也同步加了同一组（test/ui/emotes.test.js 会比对两边一致）。
  { themeId: 'emoticon_sifeng', dir: 'sifeng', sortId: 900, isBasic: false, name: N_('表情套组：司凤'), emotes: [
    emo('sifeng_win', 901, 'pic_win', N_('会赢的')),
    emo('sifeng_ice', 902, 'pic_ice', N_('冰冰冰')),
    emo('sifeng_ksk', 903, 'pic_ksk', N_('kskblzdjd')),
    emo('sifeng_nopang', 904, 'pic_nopang', N_('没胖')),
    emo('sifeng_amiya', 905, 'pic_amiya', N_('只有两岁')),
    emo('sifeng_naiwa', 906, 'pic_naiwa', N_('奶蛙')),
    // 用户 2026-10-12：但丁（DMC「CUB」梗图）+ 它自己的音效，见 EMOTE_SOUND
    emo('sifeng_dante', 907, 'pic_dante', N_('但丁真是')),
    // 用户 2026-10-13：又加两张（图 pic_lesgo / pic_baoli，音效见 EMOTE_SOUND）
    emo('sifeng_lesgo', 908, 'pic_lesgo', N_('来次够')),
    emo('sifeng_baoli', 909, 'pic_baoli', N_('暴力')),
    // 用户 2026-10-14：又加两张（图 pic_tan / pic_qieqiang，音效见 EMOTE_SOUND）。
    // ★ 注意：这里的 EMOTE_THEMES 才是客户端真正用的目录，data/emotes.json 只是同步副本
    //   （test/ui/emotes.test.js 会比对两边一致）—— 加表情【两边都要改】。
    emo('sifeng_tan', 910, 'pic_tan', N_('叹')),
    // 用户 2026-10-15：又加两张（GIF，由 10月15日(1).mp4 / 10月15日.mp4 转出，音效取自原音轨）。
    emo('sifeng_naochi', 911, 'pic_naochi', N_('闹吃')),
    emo('sifeng_guzhenxing', 912, 'pic_guzhenxing', N_('古振兴')),
    // 用户 2026-10-15：「把31切枪和闹吃换个位置」⇒ 闹吃 提到第 2 页，31切枪 排到最后。
    emo('sifeng_qieqiang', 913, 'pic_qieqiang', N_('31切枪')),
    // 用户 2026-10-19：「意气风发」（图 + 专属音效）
    emo('sifeng_yiqifengfa', 914, 'pic_yiqifengfa', N_('意气风发')),
  ] },
].map((t) => Object.freeze({ ...t, emotes: Object.freeze(t.emotes) })));
/** Every emote with its theme: `{ id, sortId, picId, label, themeId, dir }`, in wheel order. */
export const EMOTE_CATALOG = Object.freeze(EMOTE_THEMES.flatMap((t) => t.emotes.map((e) => Object.freeze({ ...e, themeId: t.themeId, dir: t.dir }))));
/** The 36 official emote ids (protocol whitelist: `EMOTES.includes(id)`). */
export const EMOTES = Object.freeze(EMOTE_CATALOG.map((e) => e.id));

/**
 * 表情面板一页放得下几张：面板是 3×2 格（`public/css/emotes.css` 的 `.ewheel__viewport` 高 1.78rem，
 * 正好两行 .85rem + 间距；`overflow:hidden`）。
 *
 * 官方每套正好 6 张，自建的「司凤」页会一直加（用户 2026-10-12 加第 7 张「但丁真是」）—— 原来的滚轮是
 * “一个主题 = 一页”，第 7 张会排到第三行、掉出视口**直接看不见**。所以在这里按 6 张切页：官方各套仍然
 * 恰好一页（外观、翻页手感都没变），超出的主题分成 (主题, 第几段)，多出来的那页由同一个滚轮翻过去。
 */
export const EMOTES_PER_PAGE = 6;
/** 滚轮真正翻的一页：`{ ...主题, emotes, part, parts }`；一套 ≤6 张时就是该主题本身（parts = 1）。 */
export const EMOTE_PAGES = Object.freeze(EMOTE_THEMES.flatMap((t) => {
  const parts = Math.max(1, Math.ceil(t.emotes.length / EMOTES_PER_PAGE));
  return Array.from({ length: parts }, (_, part) => Object.freeze({
    ...t,
    emotes: Object.freeze(t.emotes.slice(part * EMOTES_PER_PAGE, (part + 1) * EMOTES_PER_PAGE)),
    part,
    parts,
  }));
}));
/** 主题 id → 它在 EMOTE_PAGES 里的**第一页**下标（未知主题 = 0）。 */
export const emotePageOf = (themeId) => {
  const i = EMOTE_PAGES.findIndex((p) => p.themeId === themeId);
  return i < 0 ? 0 : i;
};

/**
 * 用户 2026-10-11：「司凤」表情页里带专属音效的表情 → 音效键。发送时**全场**都播（含发送者），
 * 设置 →「司凤表情音效」可以整体关掉。键名对应 `data/assets.json` 的 `audio.sfx.*`
 * （`sifengWin` = audio.sfx.emote.sifengWin；`jibianBing` = audio.sfx.battle.jibianBing，即「冰冰冰」）。
 */
export const EMOTE_SOUND = Object.freeze({
    sifeng_lesgo: 'sifengLesgo',
    sifeng_baoli: 'sifengBaoli',
  sifeng_win: 'sifengWin',
  sifeng_ice: 'jibianBing', sifeng_ksk: 'kskblzdjd', sifeng_nopang: 'meipang',
      sifeng_naiwa: 'sifengNaiwa',
  sifeng_amiya: 'sifengAmiya',
  sifeng_dante: 'sifengDante',
  sifeng_tan: 'sifengTan',   // ★ 2026-10-14 新表情「叹」
  sifeng_qieqiang: 'sifengQieqiang',   // ★ 2026-10-14 新表情「31切枪」
  // ★ 2026-10-15 新表情两张（音效直接取自原 mp4 的音轨）
  sifeng_guzhenxing: 'sifengGuzhenxing',
  sifeng_naochi: 'sifengNaochi',
  sifeng_yiqifengfa: 'sifengYiqifengfa',   // ★ 2026-10-19 新表情「意气风发」
});
const EMOTE_INDEX = new Map(EMOTE_CATALOG.map((e) => [e.id, e]));
/** Catalog record of an emote id, or null (safe for any input, including '__proto__'). */
export const emoteInfo = (id) => (typeof id === 'string' && EMOTE_INDEX.get(id)) || null;
// id-keyed maps without a prototype: a wire id like '__proto__' / 'toString' looks up undefined, never an Object method
const emoteMap = (pick) => Object.freeze(Object.assign(Object.create(null), Object.fromEntries(EMOTE_CATALOG.map((e) => [e.id, pick(e)]))));
/** Emote id → theme id. */
export const EMOTE_THEME = emoteMap((e) => e.themeId);
/** Emote id → our aria-label (never displayed). */
export const EMOTE_LABEL = emoteMap((e) => e.label);
/** data/local-assets.json group of an emote's art (`emoticon/<dir>`), or null. */
export const emoteArtGroup = (id) => { const e = emoteInfo(id); return e ? `emoticon/${e.dir}` : null; };
/** Canonical URL of an emote's extracted art (`/assets/local/emoticon/<dir>/<picId>.png`), or null for unknown ids. */
export const emoteArtPath = (id) => { const e = emoteInfo(id); return e ? `/assets/local/emoticon/${e.dir}/${e.picId}.png` : null; };
export const EMOTE_COOLDOWN_MS = 1000; // activity_table autoChessData.constData.chatCD (s)
export const EMOTE_BUBBLE_MS = 3000;   // constData.chatTime (s): how long a bubble stays up


/** 来自上游 0.3.0 的插件 API 版本表（DSH 2026-10-16 补）。 */
export const PLUGIN_API = Object.freeze({ current: 1, min: 1 });
