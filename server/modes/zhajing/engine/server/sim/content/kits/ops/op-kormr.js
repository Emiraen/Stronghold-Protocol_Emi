// server/sim/content/kits/ops/op-kormr.js — 虎狼丸 (char_4220_kormr, P3R 联动) 的炸惊 kit.
//
// 1★ 近卫·剑豪 (WARRIOR/sword)，**无技能** (character_table.skills = [])，只有天赋「黑色猎犬」。
//
// 特性「普通攻击连续造成两次伤害，且不受部署数量限制，但再部署时间极长」:
//   · 普攻两次 = `sword` 职业默认 (professions.js `sword: P({ hits: 2 })`)，本 kit 不重复声明。
//     与骨架互证: char_4220_kormr.skel 的 hits.Attack = [0.467, 0.667] — 正好 2 次 OnAttack。
//   · 再部署时间极长 = 数据里的 respawnTime 200（chess 记录已带）。
//   · ★「不受部署数量限制」**已实现**（2026-10-17，用户要求做成卫戍特质）：
//     数据 `data/garrisons.json` 的 `garrison_zj_60_2_c`（`bb.no_deploy_slot: 1`，
//     文案「<战斗中>部署后不占用可部署位置」），挂在 `chess_zj_60_2_a/_b` 的 `garrisonIds` 上；
//     引擎侧由 `server/match/player/placement.js` 的 `noDeploySlot()` 在 BOARD_FULL 判定处放行。
//     这条**不在本 kit 里**（它属于比赛层的部署位规则，不是战斗内的 kit 逻辑）。
//
// 天赋「黑色猎犬·I…VI」(data/chess.json talents[0]，随潜能):
//   部署后对周围一定范围内**最近的 1 名**敌人发动**总计 6 次无视闪避**的斩击，
//   每次斩击造成相当于攻击力 {atk_scale} 的**法术**伤害，
//   最后一次斩击改为造成攻击力 {final_atk_scale} 的法术伤害并使目标**恐惧 {fear} 秒**。
//
//   范围 rangeId = `x-1`（与 陈/艾丽妮 的 S3 同一形状，项目里已有现成常量 X_1）。
//   时序来自骨架实测 —— char_4220_kormr.skel 的 hits.Skill_Loop = [0, 0.3, 0.6, 0.9, 1.2, 1.7]：
//   恰好 6 次 OnAttack，最后一次间隔 0.5 s（收招）。所以第 i 次斩击在 SKILL_SLASH_AT[i] 秒落下。
//   天赋黑板的 times = 6 与之印证。
//
// 「无视闪避」= 显式 `canDodge: false`（damage.js:82 的默认是 `type === 'phys' || 'arts'` → true）。
// 「恐惧」= battle.applyStatus(target, 'fear', …) —— 引擎已有完整实现 (sim/fear.js, buffs.js:87)。
//
// 一个细节：斩击**逐个**打，每次都重新取"范围内最近的敌人"（首个目标死了/走了就换下一个），
// 这与 陈 S3 `slashTarget()` 的既有手法一致；但虎狼丸是"最近的 1 名"，所以每击都重新排序取第 1 个。

import { num, talentBb, statBuff } from '../shared/tier1.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';

/** 天赋第 0 项的 rangeId `x-1`（陈/艾丽妮/陈3 三处 kit 已用同一常量，此处照抄）。 */
const X_1 = Object.freeze([[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2],
  [-1, -1], [-1, 0], [-1, 1], [-2, 0]]);
/** 6 次斩击的落下时刻（s，从部署算起）—— char_4220_kormr.skel 的 hits.Skill_Loop。 */
const SLASH_AT = Object.freeze([0, 0.3, 0.6, 0.9, 1.2, 1.7]);
/** 天赋黑板的 times 缺失时的兜底次数。 */
const SLASH_TIMES = SLASH_AT.length;
/** 斩击的视觉（客户端 fx kind；陈 S3 用的同一个）。 */
const SLASH_FX = 'slash';

/** 天赋范围在当前朝向上的绝对格 key（技能范围不吃攻击距离延伸，extend 0）。 */
const keysOf = (unit, grid) => absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);

export default {
  char_4220_kormr: (bb, chess) => {
    const t0 = talentBb(chess, 0);
    const times = Math.max(1, Math.floor(num(t0.times, SLASH_TIMES)));
    const atkScale = num(t0.atk_scale, 1);
    const finalScale = num(t0.final_atk_scale, atkScale);
    const fear = num(t0.fear, 0);
    // 天赋的 rangeGrid（chess 记录若带就用，否则 x-1）
    const grid = chess?.talents?.[0]?.rangeGrid ?? X_1;

    return {
      talents: [{
        install(battle, unit) {
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit) return;
            const seq = unit.deploySeq;
            // ★ 幂等护栏：`deploySeq` 是"一次部署"的身份标识（units.js:84「also the identity of one
            //   deployment」；tokens.js / ai.js 都用同一手法）。没有它时同一 seq 的 deploy 事件被发两次
            //   就会把 6 次斩击打成 12 次 —— 实测（test harness 构造时也发一次 deploy，玩家再部署一次）
            //   会出现 11 条斩击伤害、恐惧也施加两遍。有了它，再部署时 seq 变化自然重新触发。
            if (unit.mem.kormrTalentSeq === seq) return;
            unit.mem.kormrTalentSeq = seq;
            const here = () => unit.alive && unit.deployed && unit.deploySeq === seq;

            /**
             * 范围内**最近的 1 名**敌人（每击重新取；blocked-first 由 sortEnemyTargets 的既有规则处理）。
             * profile 用单位自己的（`unit.profile`）—— canHitFly / groundOnly 由干员数据决定，
             * 和通用 kit 里 `enemiesInGrid` 的既有做法一致（`{ canHitFly, groundOnly }` 取自同一处）。
             */
            const nearest = () => {
              const list = battle.enemiesInKeys(keysOf(unit, grid), unit, unit.profile);
              if (!list.length) return null;
              sortEnemyTargets(battle, unit, list, 'nearest');
              return list[0];
            };

            for (let i = 0; i < times; i++) {
              const last = i === times - 1;
              battle.after(SLASH_AT[Math.min(i, SLASH_AT.length - 1)], () => {
                if (!here()) return;
                const e = nearest();
                if (!e) return;                       // 范围内没有敌人：这一击落空（其余照常，与"总计 6 次"的字面一致）
                battle.fx(SLASH_FX, { x: e.x, y: e.y, id: unit.id, n: i, target: e.id, skill: 'kormr:blackdog' });
                battle.dealDamage(unit, e, {
                  amount: unit.s.atk * (last ? finalScale : atkScale),
                  type: 'arts',                      // 天赋写明「法术伤害」
                  isSkill: true,
                  canDodge: false,                   // 「无视闪避」
                  tags: ['skill', 'talent', 'slash'],
                });
                if (last && e.alive && fear > 0) {
                  battle.applyStatus(e, 'fear', { duration: fear, source: unit });
                }
              }, { owner: unit });
            }
          }, { owner: unit });
        },
      }],
      // 特性里"无视闪避"只属于天赋，普攻照常可被闪避，所以 install 里不改 trait。
      install(battle, unit) {
        // 目前没有常驻属性天赋/模组；留空占位，方便以后加模组。
        void statBuff;
      },
    };
  },
};
