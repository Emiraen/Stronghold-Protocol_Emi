// server/sim/detmath.js — 「与浏览器引擎无关的数学」模块（上游 0.2.2，PR #373）的兼容实现。
//
// 上游为什么要它：Chrome / Firefox / Safari / Node 的 Math.sin / cos / atan2 / hypot / pow 允许有
// 1 ULP 级别的差异，而客户端的预测模拟必须和服务器逐位对上，所以上游用 fdlibm 自己实现了 sin / cos /
// atan2，并自己实现 hypot 与整数次幂（CHANGELOG 0.2.2：「模拟里禁止再用会因引擎而异的 Math 函数」）。
//
// 本服的情况：模拟**只在服务器（Node）上跑**，不存在跨引擎比对，因此这里不做 fdlibm 移植，只提供
// kit 真正用到的 hypot / powi，并且保证与 Node 的 Math.hypot / Math.pow **逐位一致** —— 也就是说，
// 引入本模块不会改变任何一场战斗的结果（行为与升级前完全相同）。比对见 _upstream/detmath-test.mjs。
//
// 若将来要把上游其它文件（ai.js / displacement.js / bosses.js / archetypes.js / items/battle.js）也切到
// detmath，再把 fdlibm 的 sin / cos / atan2 补进来；那才是真正的跨引擎一致化，与本次的范围补丁无关。

/**
 * `Math.hypot` 的逐位等价实现（V8 的算法：先取绝对值最大者，再按 max 归一化后求和开方）。
 * 与 `Math.hypot` 一样接受任意个参数。
 * @param {...number} xs
 * @returns {number}
 */
export function hypot(...xs) {
  let max = 0;
  for (const x of xs) {
    const a = Math.abs(x);
    if (a > max) max = a;
    if (a === Infinity) return Infinity;   // 有 ±Infinity ⇒ Infinity（NaN 之外）
  }
  if (max === 0) return 0;
  let sum = 0;
  for (const x of xs) {
    if (Number.isNaN(x)) return NaN;
    const t = x / max;
    sum += t * t;
  }
  return max * Math.sqrt(sum);
}

/**
 * 整数次幂。上游用二进制快速幂自己实现，但它在 `0.1 ** 7` 这类非 2 的幂底数上与 `Math.pow` 差 1 ULP
 * （实测 16/250291 例）。本模块的目标是**不改变任何一场战斗的结果**，所以这里直接转发 `Math.pow`。
 * 本次改动没有任何地方用到 `powi`（只有 `hypot` 被 op-kalts2 用到），保留它只是为了 API 兼容。
 * @param {number} base @param {number} exp
 * @returns {number}
 */
export function powi(base, exp) {
  return Math.pow(base, exp);
}

// 上游 detmath 还导出 sin / cos / atan2（fdlibm）。本服没有跨引擎需求，直接转发给 Math，保证可用。
export const sin = Math.sin;
export const cos = Math.cos;
export const atan2 = Math.atan2;
