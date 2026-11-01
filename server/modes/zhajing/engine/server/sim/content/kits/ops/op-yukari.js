// server/sim/content/kits/ops/op-yukari.js — 岳羽由加莉 (char_4219_yukari, P3R 联动) 的炸惊 kit.
//
// 5★ 辅助 / 游击手 (SUPPORT/supportiveranger)，RANGED，rangeId 3-1（10 格），攻击间隔 2.1 s，费 16。
//   （子职业官方现名「游击手」；`data/chess.json` 里原为旧名「支援射手」，2026-10-17 一并更正。）
//
// 特性「可以使用触发型效果协助作战」: 本项目**没有**现成的触发型效果机制（全库搜 triggerEffect 为空），
//   所以 S2 自己实现：给友方挂一个"监听其 skillStart"的标记，友方开技能时为其加伤害 buff。
//
// 天赋 T0「治愈之风」: 技能结束后，治疗自身和攻击范围内最多 N 名干员相当于由加莉攻击力 X% 的生命值。
//   用 `skillEnd` 钩子实现（她自己的技能或友方的技能结束都会触发 —— 文案是"技能结束后"，
//   与由加莉自己在不在施法无关）。治疗目标 = 自己 + 攻击范围内最多 N-1 名友方（按灼烧程度优先）。
//
// S1「龙卷箭」: 立即发射三发箭矢（各 50% 攻击力法术伤害），随后追加一次 200% 攻击力的范围法术伤害
//   并**浮空**所有目标 1.5 秒。
//   时序取自骨架实测：char_4219_yukari.skel 的 hits.Skill_1 = [1.533, 1.833, 2.133, 3.367]
//   —— 前三个是那三发箭矢，最后一个是追加的范围伤害，与数据 bb 三项印证。
//   浮空 = `battle.applyStatus(target, 'levitate', …)`（引擎已有，见 op-aglna2.js glide）。
//
// S2「明镜止水」: 为范围内最多 3 名我方干员（优先选择结城理、术师干员）施加**触发型效果**：
//   干员施放技能后，自身在 15 秒内获得 10% 伤害提升。
//   实现：给选中的友方挂 `yukari:trigger` buff（带 source 标记），并监听 `skillStart` ——
//   当被标记的友方开技能时，为其加 `dmgDealtMul` 1.1 的限时 buff。

import { num, talentBb, statBuff } from '../shared/tier1.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';

const S1 = 'skchr_yukari_1';
const S2 = 'skchr_yukari_2';

/** S1 三发箭矢 + 追加范围伤害的落点（s）—— char_4219_yukari.skel 的 hits.Skill_1。 */
const ARROW_AT = Object.freeze([1.533, 1.833, 2.133]);
const BURST_AT = 3.367;
/** S1 追加伤害的范围半径（格）。 */
const BURST_RADIUS = 1.5;
/** 触发型效果的 buff key（挂在友方身上）。 */
const TRIGGER_KEY = 'yukari:trigger';
/** 触发后给友方的伤害提升 buff key。 */
const BOOST_KEY = 'yukari:boost';
/** 空档案：法术伤害打空中也有效。 */
const ANY = Object.freeze({ canHitFly: true });

const bbOf = (chess, id) => (chess?.skills ?? []).find((s) => s && s.skillId === id)?.bb ?? {};

export default {
  char_4219_yukari: (bb, chess) => {
    const t0 = talentBb(chess, 0);
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2);
    const grid = chess?.rangeGrid ?? [];
    const keysOf = (unit) => absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);

    return {
      skills: {
        [S1]: {
          kind: 'instant',
          onStart({ battle, unit }) {
            const keys = keysOf(unit);
            const cands = battle.enemiesInKeys(keys, unit, ANY);
            if (!cands.length) return;
            sortEnemyTargets(battle, unit, cands, null);
            const target = cands[0];
            const atk = unit.s.atk;
            const multi = num(b1.multi_atk_scale, 0.5);
            const final = num(b1.final_atk_scale, 2.0);
            const lev = num(b1.levitate, 1.5);
            // 三发箭矢
            for (const at of ARROW_AT) {
              battle.after(at, () => {
                if (!unit.alive || !unit.deployed) return;
                const e = target && target.alive ? target : null;
                if (!e) return;
                battle.fx('slash', { x: e.x, y: e.y, id: unit.id, n: 1, skill: 'yukari:arrow' });
                battle.dealDamage(unit, e, {
                  amount: atk * multi, type: 'arts', isSkill: true, canDodge: false,
                  tags: ['skill', 'arrow'],
                });
              }, { owner: unit });
            }
            // 追加：范围法术伤害 + 浮空所有目标
            battle.after(BURST_AT, () => {
              if (!unit.alive || !unit.deployed) return;
              const e = target && target.alive ? target : null;
              const cx = e ? e.x : unit.x, cy = e ? e.y : unit.y;
              const victims = e ? [e, ...battle.foesInRadius(cx, cy, BURST_RADIUS).filter((x) => x !== e)] : [];
              const list = victims.filter((v) => v && v.alive);
              if (!list.length) return;
              battle.fx('blink', { x: cx, y: cy, id: unit.id, skill: 'yukari:burst' });
              for (const v of list) {
                battle.dealDamage(unit, v, {
                  amount: atk * final, type: 'arts', isSkill: true, canDodge: false,
                  isSplash: v !== e, tags: ['skill', 'burst'],
                });
                // 浮空（引擎已有：op-aglna2.js 的 glide 用同一手法）
                if (v.alive && lev > 0) battle.applyStatus(v, 'levitate', { duration: lev, source: unit });
              }
            }, { owner: unit });
          },
        },

        [S2]: {
          kind: 'instant',
          onStart({ battle, unit }) {
            const maxTarget = Math.max(1, Math.floor(num(b2.max_target, 3)));
            const dur = num(b2.duration, 15);
            const up = num(b2.damage_up, 0.1);
            if (!(up > 0)) return;
            // 「优先选择结城理、术师干员」：先挑结城理，再挑术师，最后补其他
            const cands = battle.alliesInRadius(unit.x, unit.y, 99)
              .filter((a) => a && a.alive && a.deployed && a.kind === 'op');
            const pri = (a) => {
              const cid = String(a.def?.charId ?? '');
              if (cid === 'char_4217_makoto') return 0;                 // 结城理
              if (a.def?.profession === 'CASTER') return 1;              // 术师干员
              return 2;
            };
            cands.sort((a, b) => pri(a) - pri(b) || a.id - b.id);
            const picked = cands.slice(0, maxTarget);
            for (const a of picked) {
              battle.addBuff(a, {
                key: TRIGGER_KEY, persist: true, allowDead: true,
                data: { source: unit.id, dur, up },
                tags: ['talent', 'trigger'],
              });
              battle.fx('buff', { x: a.x, y: a.y, id: a.id, skill: 'yukari:mirror' });
            }
          },
        },
      },

      talents: [{
        install(battle, unit) {
          const maxTarget = Math.max(1, Math.floor(num(t0.max_target, 3)));
          const healScale = num(t0.heal_scale, 1);

          // 天赋「治愈之风」：技能结束后治疗自身 + 范围内最多 N 名干员
          // ★ 2026-10-17（三人代码体检）：**必须判断是不是由加莉自己的技能结束了**。
          //   `skillEnd` 是**全局**事件（载荷含 `unit`），`{ owner: unit }` 只是注册标记、不过滤来源
          //   —— 与结城理 kit 里那个 `death` 监听是同一类错误（那边 `if (ctx.unit !== unit) return;`）。
          //   实测（修复前）：让**结城理**开技，`skillEnd` 全是 unit=2（非由加莉），却仍治疗了 4 次；
          //   描述的口径是「**技能结束后**，治疗自身和攻击范围内最多3名干员」——指她自己的技能。
          battle.on('skillEnd', (ctx) => {
            if (ctx?.unit !== unit) return;
            if (!unit.alive || !unit.deployed) return;
            const amount = unit.s.atk * healScale;
            if (!(amount > 0)) return;
            const list = [unit, ...battle.alliesInRadius(unit.x, unit.y, 99).filter((a) => a !== unit)];
            // 优先治疗受伤最重的
            list.sort((a, b) => (a.hpRatio ?? 1) - (b.hpRatio ?? 1));
            for (const a of list.slice(0, maxTarget)) {
              if (a && a.alive && a.deployed) battle.heal(unit, a, amount, { source: unit });
            }
          }, { owner: unit });

          // 触发型效果：被标记的友方开技能 → 获得限时伤害提升
          battle.on('skillStart', (ctx) => {
            const a = ctx && ctx.unit;
            if (!a || !a.alive || a === unit) return;
            const mark = a.findBuff ? a.findBuff(TRIGGER_KEY) : null;
            if (!mark) return;
            const d = mark.data || {};
            const dur = num(d.dur, 15), up = num(d.up, 0.1);
            if (!(up > 0)) return;
            // ★ 2026-10-17（用户：「仅法术伤害 +15%」）：「术法充盈」只加法术伤害。
            //   原来是 `dmgDealtMul: 1 + up`（**全部**伤害），与「术法」二字的字面不符。
            //   改用 `artsDealtMul` —— damage.js:272 的乘区链 `dmgDealtMul × (phys|arts)DealtMul`，
            //   其中 `artsDealtMul` **只**在 `type === 'arts'` 时参与，物理/真实伤害不受影响。
            battle.addBuff(a, {
              key: BOOST_KEY, duration: dur, mods: { artsDealtMul: 1 + up },
              tags: ['talent', 'trigger'],
            });
            battle.fx('buff', { x: a.x, y: a.y, id: a.id, skill: 'yukari:trigger' });
          }, { owner: unit });
        },
      }],

      install(battle, unit) {
        void statBuff;
      },
    };
  },
};
