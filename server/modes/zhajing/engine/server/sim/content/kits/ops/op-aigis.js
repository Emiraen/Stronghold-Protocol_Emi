// server/sim/content/kits/ops/op-aigis.js — 埃癸斯 (char_4218_aigis, P3R 联动) 的炸惊 kit.
//
// 5★ 狙击 / 裂空炮手 (SNIPER/skybreaker)，RANGED，rangeId 3-6（9 格），攻击间隔 2.1 s，费 22。
//   （子职业官方现名「裂空炮手」；`data/chess.json` 里原为旧名「对空狙击」，2026-10-17 一并更正。）
//
// 特性「部署后起飞，起飞后只攻击空中敌人；技能开启时降落且攻击造成群体物理伤害」:
//   · 起飞 = `liftoff` + `blockFly` 两个 flag（ba.liftoff「不阻挡地面敌人且不会被地面敌人攻击，可以阻挡飞行敌人」）。
//     引擎已完整实现（buffs.js:37 把 liftoff 列为 ally 的 flag；damage.js liftoffEvades 做对地规避；
//     blocking.js:79 起飞单位只阻挡飞行敌人）。同一手法见 chess_char_2_13-tippi.js 与 op-aglna2.js。
//   · 「只攻击空中敌人」= trait 的 `canAttack`（ai.js:92 的闸门）。引擎只有 groundOnly（只打地面），
//     没有反向开关，所以这里自己写：起飞且范围内没有空中敌人时收起攻击。
//   · 「技能开启时降落」= 技能 onStart 撤掉 liftoff；「攻击造成群体物理伤害」= 技能带 splash（见下）。
//
// 天赋 T1「反暗影特殊压制兵装」：造成的物理伤害 +%、受到的物理伤害 -%。
//   前者 = trait 的 dmgMul，后者 = 常驻 buff 的 physTakenMul。
//
// S1 启动狂宴模式 (20 s)：攻击力+atk、防御力+def，**随机**攻击范围内的目标（引擎没有 random 索敌，
//   用 `targeting.random` 交给通用索敌处理），技能结束后自身晕眩 stun 秒。
//   （数值全部从 `b1.bb` / `b2.bb` 读，缺数据时的兜底值 = `_a` 的实值：
//     S1 = atk 0.7 / def 0.3 / stun 10；S2 = atk_scale 1.0 / kick_atk_scale 2.1。
//     `_b` 分别是 S1 1.0 / 0.5、S2 1.3 / 2.7。旧注释写的 "+40% / +20%"、"70% / 150%" 是早期抄录，已更正。）
// S2 全弹发射：锁定范围内一个目标发射 times 枚导弹（每枚 atk_scale × 攻击力物理），之后**自身飞踢向目标**，
//   对目标及周围敌人造成 kick_atk_scale × 攻击力物理。
//   （`_a` = 1.0 / 2.1，`_b` = 1.3 / 2.7；旧注释的 "70% / 150%" 同样是早期抄录，已更正。）
//   · 6 枚导弹的时序取自骨架实测：char_4218_aigis.skel 的 hits.Skill_2_Begin = [0.667, 0.8, 0.933,
//     1.067, 1.2, 1.333] —— 恰好 6 次 OnAttack，与数据 bb.times = 6 印证。
//   · 自身位移用 `battle.moveRedeploy`（op-aglna2.js 的 moveTo 同一手法），视觉用 fx('blink')。

import { num, talentBb, traitBb, statBuff } from '../shared/tier1.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';

const S1 = 'skchr_aigis_1';
const S2 = 'skchr_aigis_2';

/** 起飞 (ba.liftoff)：对地规避 + 只阻挡飞行敌人。 */
const LIFTOFF = Object.freeze({ liftoff: true, blockFly: true });
/** 起飞态的 buff key。 */
const AIR_KEY = 'aigis:air';
/** 覆盖远距离空中单位的索敌档案（「只攻击空中敌人」用）。 */
const AIR = Object.freeze({ canHitFly: true });
/** S2 的 6 枚导弹落点（s，从技能开始算）—— char_4218_aigis.skel 的 hits.Skill_2_Begin。 */
const MISSILE_AT = Object.freeze([0.667, 0.8, 0.933, 1.067, 1.2, 1.333]);

const bbOf = (chess, id) => (chess?.skills ?? []).find((s) => s && s.skillId === id)?.bb ?? {};

export default {
  char_4218_aigis: (bb, chess) => {
    const t0 = talentBb(chess, 0);
    const tb = traitBb(chess);
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2);
    const dmgScale = num(t0.damage_scale, 1);
    const dmgResist = num(t0.damage_resistance, 0);
    const missileTimes = Math.max(1, Math.floor(num(b2.times, MISSILE_AT.length)));
    // 特性「起飞后只攻击空中敌人」：**必须由 kit.trait 提供** ——
    // players.js:247 `u.profile = resolveProfile(u.def, u.kit.trait || null)`，而 resolveProfile 末尾
    // （professions.js:699）`if (kitTrait) Object.assign(p, kitTrait)` 把整个 kit.trait 合并进 profile；
    // ai.js:92 读的正是 `prof.canAttack`。所以：
    //   · 不能写在 install() 里改 unit.trait（那时 profile 早已建好，且 unit.trait 是职业运行时状态）
    //   · 必须是**纯函数** —— profile 在单位创建时建一次，之后不再重建（`b`/`u` 是运行时参数）
    const rGrid = chess?.rangeGrid ?? [];
    const airGate = (b, u) => {
      if (!u.mem.aigisAir) return true;      // 已降落：照常攻击
      const keys = absoluteRangeKeys(rGrid, u.tileR, u.tileC, u.dir, 0);
      return b.enemiesInKeys(keys, u, AIR).some((e) => e.isFlying);
    };

    return {
      // 天赋：造成的物理伤害 +%；特性：起飞后只打空中（见上）
      trait: {
        ...(dmgScale !== 1 ? { dmgMul: (b, u, t) => (t && t.side === 'enemy' ? dmgScale : 1) } : {}),
        canAttack: airGate,
      },

      skills: {
        [S1]: {
          kind: 'duration',
          duration: num(b1.duration, 20),
          // ★ 2026-10-17（用户：「但是没有空中敌人他也不会主动开技能啊」）：**触发规则必须是 SEARCH**。
          //   默认的 `DEFAULT` 是"**即将攻击时**才开技"（skills.js `onAboutToAttack`），而特性让起飞态
          //   只打空中 ⇒ 没有空中敌人时她永远不攻击 ⇒ 永远不满足触发 ⇒ 永远不降落 ⇒ 死锁。
          //   实测（修复前）：只有地面敌人时 30 秒 0 次开技、0 次命中；地面+空中同时存在时**同样是 0 次**
          //   （因为她的攻击循环在"无可打目标"时不产生 onAboutToAttack）。
          //   `SEARCH`（skills.js:24 的注释）正是为这种"不会攻击但仍要开技"设计的：
          //   「an enemy inside the INITIAL range, checked every tick **without waiting for an attack**」，
          //   判定用 `u.baseRangeKeys`（她自己的攻击范围）+ `u.profile`（所以空中地面都算）。
          trigger: { rule: 'SEARCH' },
          mods: { atkPct: num(b1.atk, 0), defPct: num(b1.def, 0) },
          // 「随机攻击范围内的目标」：引擎没有 random 优先级，用 targeting.random 交给通用索敌
          targeting: { random: true },
          onStart({ battle, unit }) {
            land(battle, unit);                      // 「技能开启时降落」
            unit.mem.aigisAir = false;
          },
          onEnd({ battle, unit }) {
            // 「技能结束后自身晕眩 10 秒」
            const stun = num(b1.stun, 0);
            if (stun > 0) battle.applyStatus(unit, 'stun', { duration: stun, source: unit, force: true });
            takeOff(battle, unit);                   // 落地之后重新起飞（特性是"部署后起飞"的常驻态）
            unit.mem.aigisAir = true;
          },
        },

        [S2]: {
          kind: 'instant',
          // 同 S1：SEARCH（不等攻击）——否则没有空中敌人时这个技能永远不会开
          trigger: { rule: 'SEARCH' },
          onStart({ battle, unit }) {
            land(battle, unit);
            unit.mem.aigisAir = false;
            // ★ 2026-10-17 加固：**任何提前返回都必须重新起飞**。
            //   原来 `if (!cands.length) return;` 直接返回，把她永久留在地面（`onEnd` 只在 S1 上有，
            //   这一条没有兜底）；飞踢那条路也依赖 `target.alive`，目标中途死了同样会漏掉起飞。
            //   现在整段包在 try/finally 里，"落地 → 打 → 起飞"无论走哪条分支都成立。
            try {
              const keys = absoluteRangeKeys(chess.rangeGrid ?? [], unit.tileR, unit.tileC, unit.dir, 0);
              const cands = battle.enemiesInKeys(keys, unit, AIR);
              if (!cands.length) return;             // 范围内没有目标：不发射也不飞（finally 会让她起飞）
              sortEnemyTargets(battle, unit, cands, null);
              const target = cands[0];
              const atk = unit.s.atk;
              const atkScale = num(b2.atk_scale, 0.7);
              const kickScale = num(b2.kick_atk_scale, 1.5);
              // 6 枚导弹（时序 = 骨架 hits.Skill_2_Begin）
              for (let i = 0; i < missileTimes; i++) {
                const at = MISSILE_AT[Math.min(i, MISSILE_AT.length - 1)];
                battle.after(at, () => {
                  if (!unit.alive || !unit.deployed) return;
                  const e = target && target.alive ? target : null;
                  if (!e) return;
                  battle.dealDamage(unit, e, {
                    amount: atk * atkScale, type: 'phys', isSkill: true, canDodge: false,
                    tags: ['skill', 'missile'],
                  });
                }, { owner: unit });
              }
              // 飞踢：**她自己不移动** —— 官方 ability 里 `Kick` 是
              //   { class: 'RangedAttack', animKey: 'Skill_2_Loop', projectileKey: 'projectile_chr_aigis_s2_kick',
              //     mount: 'MUZZLE', attackType: 1, damageType: 1 }
              // 即"从枪口打出的一发踢击抛射物"；同组的 `TakeOff` 是 `EmptyAnimatedAbility`（`animKey: 'Skill_2_End'`，
              // 纯动画，无位移）。原来的实现用 `battle.moveRedeploy` 把她搬到目标旁 —— 那是引擎的 **【移动】**：
              // `deploySeq +1` / `deployedAt = time` / 广播 `deploy` 事件（tiles.js:45），
              // 于是玩家看到"飞踢之后人直接部署过去了"（部署动画 + 她自己的 deploy 钩子又触发一次起飞）。
              // 现在改成：特效打**目标**身上，溅射范围以**目标**为中心。
              const kickAt = MISSILE_AT[Math.min(missileTimes, MISSILE_AT.length - 1)] + 0.3;
              battle.after(kickAt, () => {
                if (!unit.alive || !unit.deployed) return;
                const e = target && target.alive ? target : null;
                if (!e) return;
                // 踢击抛射物命中目标的瞬间（视觉），位置在目标身上，不是她身上
                battle.fx('blink', { x: e.x, y: e.y, id: unit.id, target: e.id });
                // 对目标及目标周围的敌人（范围以**目标**为中心）
                const around = [e, ...battle.foesInRadius(e.x, e.y, 1.5).filter((x) => x !== e)];
                for (const v of around) {
                  if (!v || !v.alive) continue;
                  battle.dealDamage(unit, v, {
                    amount: unit.s.atk * kickScale, type: 'phys', isSkill: true, canDodge: false,
                    isSplash: v !== e, tags: ['skill', 'kick'],
                  });
                }
              }, { owner: unit });
            } finally {
              // 踢完（或空放）回到起飞态 —— 特性「部署后起飞」是常驻态，S2 只是临时降落
              takeOff(battle, unit);
              unit.mem.aigisAir = true;
            }
          },
        },
      },

      talents: [{
        install(battle, unit) {
          // 天赋「受到的物理伤害 -%」
          if (dmgResist > 0) statBuff(battle, unit, 'talent:aigis:resist', { physTakenMul: 1 - dmgResist });
          // 特性「部署后起飞」：每次部署都进入起飞态
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit) return;
            takeOff(battle, unit);
            unit.mem.aigisAir = true;
          }, { owner: unit });
        },
      }],

      install(battle, unit) {
        // 「起飞后只攻击空中敌人」的闸门由上面的 kit.trait.canAttack 提供（见那里的注释）——
        // 这里不要再改 unit.trait：profile 在单位创建时就由 kit.trait 建好了，晚改无效。
        void unit;
      },
    };
  },
};

/** 起飞：放走已阻挡的地面敌人 + 挂 liftoff flag + 视觉。 */
function takeOff(battle, unit) {
  battle.releaseBlocked(unit);
  battle.addBuff(unit, { key: AIR_KEY, flags: { ...LIFTOFF }, persist: true, allowDead: true });
  battle.fx('takeoff', { x: unit.x, y: unit.y, id: unit.id });
}

/** 降落：撤掉 liftoff flag。 */
function land(battle, unit) {
  battle.removeBuff(unit, AIR_KEY);
  battle.fx('land', { x: unit.x, y: unit.y, id: unit.id });
}
