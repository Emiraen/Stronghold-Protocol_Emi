// server/sim/bondtiming.js — 盟约对**持续时间**的修正（战斗内、只读）。
//
// 目前只有一条：S.E.E.S 盟约
//   「<每叠加200层>【S.E.E.S】成员持续类技能的持续时间-1s（最多减到1s）」
// 它同时作用于两类计时（两者不是一个东西，各自独立结算）：
//   · duration 类技能 —— `SkillRuntime.activate` 里的 `timeLeft`（server/sim/skills.js）
//   · <替身>/傀儡态 —— `professions.js` 的 `enter()`：`DOLL_SWITCH + dollDuration`
// 放在这个独立小模块里，是为了让 skills.js 与 professions.js 共用同一份判定，且不产生循环依赖。
//
// 判定口径（与 op-makoto 的「带了就算」一致）：
//   · 只对【S.E.E.S】成员：棋子自带 `seesShip`，或戴着「“S.E.E.S”袖章」；
//   · 层数取该玩家**当前**的 S.E.E.S 层数（战斗中会涨），每满 200 层减 1 秒。

/** 每多少层减 1 秒。 */
export const SEES_DUR_STEP = 200;

/**
 * 该单位因 S.E.E.S 层数应缩短的秒数（0 = 不减）。
 * @param {any} battle
 * @param {any} u
 * @returns {number} 整数秒
 */
export function seesDurationCut(battle, u) {
  if (!u || u.kind !== 'op') return 0;
  const defBonds = Array.isArray(u.def?.bonds) ? u.def.bonds
    : (Array.isArray(u.def?.raw?.bonds) ? u.def.raw.bonds : null);
  const member = !!(defBonds && defBonds.includes('seesShip'))
    || (Array.isArray(u.items) && u.items.some((it) => String(it).startsWith('chess_item_sees_armband')));
  if (!member) return 0;
  const ps = battle && typeof battle.getPlayer === 'function' ? battle.getPlayer(u.ownerId) : null;
  const layers = Math.max(0, Number(ps && ps.bonds && ps.bonds.seesShip && ps.bonds.seesShip.layers) || 0);
  return Math.floor(layers / SEES_DUR_STEP);
}
