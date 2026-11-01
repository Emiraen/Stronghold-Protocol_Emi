// shared/zhajingBase.js — 炸惊模拟的「基础数值膨胀」折算成干员白值 (config.modes[*].allyScale).
//
// 口径 (0.3.x 改): allyScale 过去是战场上的最终乘区 —— sim 把它挂在 unit.scaleMul 上 (units.js 的 Πmul, 乘在
// 盟约 / 惊变 / 道具的百分比加成之后)。现在它折进干员自己的白值:
//
//     白值 = 原白值 × { atk, def, hp }        (只动 atk / def / maxHp)
//
// 于是百分比加成从这个新白值起算, 而且干员调配 (炸惊页签) 的「局内数值」、局内详情卡和真正的战斗读的是同一份
// 数字 —— 屏幕上写的就是打出来的。战斗侧由 server/sim/battle/players.js 落到 unit.base 上; 客户端由
// ui/gameLogic/loadout.js 的 chessLoadout(opts.allyScale) 落到展示用的 record.stats 上。
//
// 只在炸惊里生效: 模式配置里只有 mode_single_zhajing / mode_multi_zhajing 带 allyScale, 客户端也只在
// 自己的炸惊页签 (ui/loadoutSync.js MODE_ZJ) 与 difficulty === 'ZHAJING' 的房间里把它传下去。

/** 兜底值 (data/config.json 的炸惊模式现在就是这一组; 配置缺失时用它)。 */
export const ZHAJING_ALLY_SCALE = Object.freeze({ atk: 2.5, def: 3, hp: 3 });

/**
 * 归一化 allyScale: 只认 ≥0 的有限数, 缺省按 1 算; 三项都是 1 (或没有) → null = 不膨胀。
 * @param {any} scale `{ atk?, def?, hp? }`
 * @returns {{ atk: number, def: number, hp: number } | null}
 */
export function allyScaleOf(scale) {
  if (!scale || typeof scale !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 1);
  const out = { atk: n(scale.atk), def: n(scale.def), hp: n(scale.hp) };
  return out.atk === 1 && out.def === 1 && out.hp === 1 ? null : out;
}

/** 炸惊模式配置里的 allyScale (单/多人同一组); 配置里没有就退回 ZHAJING_ALLY_SCALE。 */
export function allyScaleFromConfig(cfg) {
  const modes = cfg && typeof cfg === 'object' ? cfg.modes : null;
  const rec = modes && (modes.mode_single_zhajing || modes.mode_multi_zhajing);
  return allyScaleOf(rec && rec.allyScale ? rec.allyScale : ZHAJING_ALLY_SCALE);
}

/**
 * 白值膨胀后的 stats: atk / def / maxHp 各乘一档, 其它字段原样返回 (没有倍率时原对象原样返回)。
 * @param {any} stats @param {any} scale
 */
export function zhajingBaseStats(stats, scale) {
  const s = allyScaleOf(scale);
  if (!s || !stats || typeof stats !== 'object') return stats;
  const out = { ...stats };
  if (typeof out.atk === 'number') out.atk *= s.atk;
  if (typeof out.def === 'number') out.def *= s.def;
  if (typeof out.maxHp === 'number') out.maxHp *= s.hp;
  return out;
}

/** 这个 difficulty / modeId 是不是炸惊 (`ZHAJING` / `mode_single_zhajing` …)。 */
export const isZhajing = (v) => /zhajing/i.test(String(v ?? ''));
