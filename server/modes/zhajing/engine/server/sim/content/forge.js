// server/sim/content/forge.js — 炸惊模拟「锻造器」的战斗侧（用户 2026-10-14「接效果」）。
//
// 做两件事：
//   ① **基础暴击 5%**（炸惊专属，用户 2026-10-14「暴击率初始给5%」）——给该场所有干员挂一个
//      `critRate: 0.05` 的常驻 buff。非炸惊不挂，所以详情卡上那两行（第 9 / 第 10 位）也不出现。
//   ② **每名玩家的锻造加成** —— 数值来自 PlayerBattleInput.forge（match/player/round.js 用
//      shared/forgeData.js 的 forgeBattleMods 从 ps.forge.forged 折算）：{ atk, def, hp, crit, vamp, range, block, sp }。
//
// 九个选项的落点：
//   · atk→atkFlat · def→defFlat · hp→hpFlat · range→rangeExtend · block→blockCnt · sp→spCostFlat（负数）
//   · crit→critRate（比例）· vamp→lifesteal（比例）  ← 这两个键是给「锻造器」新加进 buffs.js ADD_KEYS 的
//   · 资金 在 match 侧立即到账（不在这里）
//
// 暴击 / 吸血的效果由**战斗级钩子**实现，读的是单位**实时的** `s.critRate` / `s.lifesteal`：
//   · 暴击 = 双倍伤害（`hit` 钩子里 dmg.mul *= 2，和「骑士竞技」同一处、同一手法）
//   · 吸血 = 造成伤害时按比例回自己的血（`damaged` 钩子里 battle.heal，和「嗜血 / 吸血习性」同一手法）
// 因为读实时属性，基础 5% 和锻造的加成自然叠在一起（ADD_KEYS 是求和）。
//
// 挂 buff 用 passiveBuff（persist + refresh:'replace'，幂等），所以 deploy / battleStart 重复调用安全。
// 注册在 content/index.js 的 DOMAIN_NAMES（'forge'），随 installContent 的 'full' 模式运行。

import { num, passiveBuff } from './support/index.js';
import { forgeModsEmpty } from '../../../shared/forgeData.js';

/** 这一玩家的锻造面板加成（同一玩家所有干员共用）。 */
const STATS_KEY = 'forge:stats';
/** `u.mem` 里的幂等标记：spCostMul 只乘一次（deploy 会重复触发）。 */
const SPMUL_KEY = 'forge:spMul';
/** 炸惊的基础暴击（所有干员都有）。 */
const BASE_CRIT_KEY = 'forge:baseCrit';
/** 暴击倍率（引擎原本没有暴击机制，这里按双倍实现）。 */
const CRIT_MUL = 2;
/** 炸惊的基础暴击率（用户 2026-10-14：「暴击率初始给5%」）。 */
export const BASE_CRIT = 0.05;

export function install(battle) {
  if (!battle) return;
  // battle.zj 只在 modeId 含 `zhajing` 时非 null（Battle 构造里 zjViewFor）—— 用它判定炸惊
  const zj = !!battle.zj;

  // ── ① 基础暴击 5% —— 已折进白值（battle/players.js `_createAllyFromInput`），这里不再挂 buff。
  //      钩子照样按 u.s.critRate 算，所以白值 + 任何 buff 都吃得进去。

  // ── ② 每名玩家的锻造加成（只处理范围 / 技力这两项） ──────────────────────────
  let any = zj;
  for (const p of (battle.players || [])) {
    // ★ 输入在 `p.input`（server/sim/battle/players.js:41 `input: p`）—— `bonds` 被抄到了顶层，
    //   `forge` 没有；只读 `p.forge` 会恒为 undefined，于是整段被 forgeModsEmpty 跳过、一点属性都不加
    //   （用户 2026-10-14：「干员放下去没看到数值增加」）。两个位置都认，以后谁搬都不怕。
    const fm = p && (p.forge || (p.input && p.input.forge));
    if (!fm || forgeModsEmpty(fm)) continue;
    any = true;
    const pid = p.playerId;
    const isMine = (u) => !!u && u.kind === 'op' && u.ownerId === pid;
    // ★ 2026-10-14 改口径：atk / def / hp / block / crit / vamp 六项已经【折进干员白值】
    //   （server/sim/battle/players.js 直接改 `unit.base`，和 allyScale 同一手法），这里**不再重复挂 buff**。
    //   只有白值里没有对应项的两个还留在这儿：攻击距离（rangeExtend）和技力需求。
    const mods = {};
    if (fm.range) mods.rangeExtend = Math.max(0, Math.round(num(fm.range, 0)));
    if (!Object.keys(mods).length && !fm.spMul) continue;
    // ★ 2026-10-16「技力需求 -10%」改为**倍率**（owner 方案 A）：
    //   原来把 -10 当 `spCostFlat` 减掉，而 skills.js 是 `floor(baseSpCost * mul + spCostFlat)`
    //   —— 绝对减法。spCost ≤ 10 的干员会被减成 0，于是 spMax=0 ⇒ 客户端技力条消失
    //   （units.js 的 showSp 要求 spMax > 0），且引擎按"免费技能"把 charges 拉满 ⇒ 开不出技能。
    //   现在走 `skill.spCostMul`，和盟友特质 sp_ratio 同一条通道（bonds/addon/battle.js 的 suntSpCost）。
    //   `u.mem` 做幂等护栏：deploy 会重复触发（`applyAll()` 在 install 时也跑一遍），
    //   而 u.mem 是**每个单位构造时建一次、不随 redeploy 清空**的（units.js:90），所以倍率只会乘一次。
    //   赋值 spCostMul 的 setter 自己会 `_normalize()`，把 sp/charges 的不变量重新理顺（技能可能已经攒了一半技力）。
    const spMul = num(fm.spMul, 1);
    const applyOne = (u) => {
      if (!isMine(u)) return;
      const sk = u && u.skill;
      if (sk && !sk.noSkill && spMul !== 1 && !u.mem[SPMUL_KEY]) {
        u.mem[SPMUL_KEY] = true;
        sk.spCostMul = sk.spCostMul * spMul;
      }
      if (Object.keys(mods).length) passiveBuff(battle, u, STATS_KEY, mods);
    };
    const applyAll = () => { for (const u of battle.allies()) applyOne(u); };
    applyAll();
    battle.on('deploy', (ctx) => applyOne(ctx && ctx.unit));
    battle.on('battleStart', () => applyAll());
  }

  // ── ③ 战斗级钩子（读实时属性，所以基础 5% 与锻造加成一起算） ─────────────────
  if (!any) return;

  battle.on('hit', (ctx) => {
    const dmg = ctx && ctx.dmg;
    const s = ctx && (ctx.credit ?? ctx.source);
    const t = ctx && ctx.target;
    if (!dmg || !s || !t || s.side !== 'ally' || t.side !== 'enemy') return;
    const c = num(s.s && s.s.critRate, 0);
    if (c > 0 && battle.rng() < Math.min(1, c)) {
      dmg.mul *= CRIT_MUL;
      // ★ 打标记：damage.js 会把它写进 dmg 事件的第 5 位（客户端据此换红金数字 + 粒子 + 音效）
      dmg.crit = true;
    }
  });

  battle.on('damaged', (ctx) => {
    const s = ctx && ctx.source;
    const t = ctx && ctx.target;
    if (!s || !t || s.side !== 'ally' || t.side !== 'enemy') return;
    if (!(ctx.amount > 0) || !s.alive) return;
    const v = num(s.s && s.s.lifesteal, 0);
    if (v > 0) battle.heal(s, s, ctx.amount * Math.min(1, v), { self: true });
  });
}
