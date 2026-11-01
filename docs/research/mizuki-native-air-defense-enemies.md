# 水月原生空援防御者与传奇战争幽灵

核对日期：2026-10-27。只在水月独立模块注册，不修改共享 KITS 或其他模式。

## 原件与证据

- 客户端 battle/enm_pfb_7.ab SHA-256：16ea38879f63ab77eca4533a0fc4699e75eeee743402aa00d9957339e586b201。
- config/buff_template_holder.ab SHA-256：7b564314564333731209f1c522e9d332dfe1016619f5f8e0400e92964765afb5。
- 本地缓存 airdef-prefabs.json、airdef-drone-prefab.json、airdef-actions.json、airdef-trigger-disassembly.txt。
- 普攻 Spine：mershd_2 Attack 时长 1、OnAttack=.467；merlgd_2 时长 1.933、OnAttack=.8。
- mershd_2 Skill 动画时长 1，但原能力 timeMode=LOAD_FROM_BLACKBOARD、duration=2，不把它误作 1 秒施法。

## 战术防御者组长

HalfHPCallDef 的 hp_ratio=.5，原模板 FilterByTargetHpRatio 为严格 LT。
事件 7 与周期事件 2 均检查；周期 .1 秒，失衡或 STUNNED 时不触发。
TriggerEnemySkill 会打断当前普攻并清理麻痹，随后移除触发 buff；技能 maxTriggerTime=1。
AirSupportDef 两秒期间停留，受控中断仍消耗这一次呼叫。

SummonEnemyToTileAbility 的 sourceSelector 为全图 trap_airsup_base 第一项，onlySelectMe=1，
在施法开始缓存源与自身格子，结束成功时从该源召 enemy_1146_defspd_2。
无机库就无无人机，不选择虚构入口；起终点共享独立 x/y ±.2 偏移，终点 WAIT=9999。
召唤物 unharmful=1，不计主波次数，但已召无人机不随呼叫者死亡消失。

## 铁砧 B 型

原 defspd 的 AirSupportReachExitChecker 抵达容差 .05，抵达后切模式。
未抵达不提供光环，也不攻击；SelfDestruction 从出生计时 40 秒，清 log_killed 后无来源自毁。
原 CircleRange 固定 2.5、不可缩放与扩展，目标碰撞参与范围选择；selfOption=EXCLUDE。
DefAndHpRecoveryUp 使用实际 blackboard DEF+300、HP_RECOVERY_PER_SEC+250。
原 buffKey 最大一层，多个铁砧不叠加；目标离开、源离场、沉默均清理对应光环。

## 传奇战争幽灵

这不是普通近战兵，也不直接套用两秒空援弩手技能。

- 普攻 active buff enemy_merlgd_atkspd 在首次攻击开始检查 merlgd_first_attack，
  TriggerAbility 触发独立 common AirSupportAtk 后移除首攻标记。
- AirSupportAtk 的 waitForAttackEvent=1，SPECIFIED duration=0，无 Skill 动画。
  在首次抬手缓存源机库/目标格子；原 OnAttack 事件时召高级攻击无人机。
  即使锁定目标已离场，缓存的目标格子不改；没有原机库时也不在伤害帧重选新机库。
- 半血事件只调用独立 AirSupportDef common ability：无等待事件、SPECIFIED duration=0，
  立即召防御无人机，无额外停步、无两秒技能。两个呼叫各一次、互相独立。
- merlgd_airsup_ready 的原效果维持到两个呼叫完成；各呼叫显示一秒原信号效果。
- GlobalAura 只筛 airsup_drone 标记，
  原 MOVE_SPEED RATIO_ADD=2，故移速乘 3；同 buffKey 不叠加，呼叫者离场立即撤销。

TriggerAbility.Execute 0x1810cfd30 在 0x1810cffcb–0x1810cffdb 调用 CastToTarget。
EasyToStartAbility.OnWaitForPreDelay 原协程 0x180eb62e1 判定 waitForAttackEvent，
真分支 0x180eb636d/0x180eb6386 等待事件 0x13，不额外加 preDelay。
SummonEnemyToTileAbility.OnCastStart=0x180e9c610 缓存源与目标，OnCastEnd=0x180e9c3c0，
仅成功结束分支 0x180e9c561–0x180e9c580 执行召唤。

## 集成与验证

native-air-defense-enemies.js 导出 MIZUKI_AIR_DEFENSE_KITS（三个原始 ID）及
snapshotNativeAirDefenseEffects。original-stages 的原依赖图应加载
mershd_2→defspd_2、merlgd_2→atkspd_2+defspd_2。

专项测试覆盖严格半血、两秒时点、控制延后与中断消耗、真实 AI 首攻时点、缓存失效目标/机库、
抵达开光环、固定碰撞范围、每秒恢复、同层不叠加、沉默/离场清理、40 秒燃料与无源不造机库。
当前 8 项通过、ESLint 0；这不等同于全部水月关卡或整局多人回归完成。
