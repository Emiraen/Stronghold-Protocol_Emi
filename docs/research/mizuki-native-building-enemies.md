# 水月原末路狂徒机制

核对日期：2026-10-27。仅安装于水月 official enemy registry。未修改共享 AI、targeting、Battle 或其他模式。

## 原始证据

- 本机官方客户端只读源：`C:/Program Files/Hypergryph Launcher/games/Arknights Game`。
- `.cache/mizuki-native-rules/prefabs-more-ordinary.json` 中 `enemy_1059_buster_2` 保留源 bundle、组件 pathId 和原字段。
- 原 Attack CircleCollider2D 半径 `2.0999999046325684`，CircleRange `_extendable=0` / `_scaleble=0`。DB range 1.3 不覆盖此固定预设。
- 原 Spine `Attack` 长 2.7 秒，`OnAttack` 位于 1.433 秒，缓存 `buster-attack-animation.json`。
- `EasyToStartAbility.<OnWaitForPreDelay>d__16.MoveNext` (`0x180eb6230`) 在 `0x180eb62e1` 检查 waitForAttackEvent。true 只等待事件 `0x13`；false 才进入 preDelay 时钟。因此 prefab preDelay=1.1339999437 不与 OnAttack 1.433 叠加。缓存 `buster-easy-wait-coroutine.txt`。
- 原 Trigger 是 `SecondaryFilterAdvancedSelector`：targetSide=2、targetMotion=3（地面及飞行）、targetCategory=DEFAULT(1)、HATRED_DES、SPECIFIED_FILTER_TAG=building、sortByTauntAtLast=true、maxNum=1。
- `SecondaryFilterAdvancedSelector.OnPostFilter` (`0x1809c2510`) 先仇恨排序，再交换 building 到前段，然后在 `0x1809c2909–0x1809c291c` 对完整候选列表重新按嘲讽排序，最后裁 maxTargetNum。其 lambda `b__15_0` (`0x1809971c0`) 仅比较双方 tauntLevel 并取降序，不检查 building。因此高嘲讽非建筑可以越过 building。证据缓存 `survival-1059-postfilter.txt`、`survival-1059-taunt-comparator.txt`。
- `CombatWrapper.GetTarget` (`0x180a2f670`) 返回 Enemy.blocker；StartCombat 把 blocker 传入 `_DoCast`，再传 Ability.CastToTarget。AbilityStandard.UpdateTargets 的 alwaysIncludeTarget 会在选择器结束后替换 max1 的尾项，因此被阻挡时实际阻挡者覆盖范围内其他建筑。缓存 `survival-1059-combat-wrapper.txt`。
- 原 talent `buster_t_1` / `filtertag_enhance` 在 ON_CALCULATE_DAMAGE 检查目标 building 标签并执行 AtkScaleUp；黑板 `atkup.atk_scale=1.8`。倍率作用于 DEF 之前的攻击值，且原天赋可沉默。
- 原攻击为物理、无弹道，FX `demonk_attack_01_start` / `demonk_attack_01_hit`。

## 实现

`native-building-enemies.js` 独立管理本敌人的攻击起手与命中，借用共享的真实攻击冷却、attackWindup、attackStand、伤害管线与攻击事件。Category DEFAULT 的原农场设施可以被本选择器命中；不把其他 device 一概视为 building，不改自动模式的设备可选性。建筑标签来自原设施预设。

被控制、恐惧、缴械、浮空、失衡、离场时中断起手；锁定部署序列防止命中同卡的新一次部署；目标离开原范围后仍结算已锁定的攻击。正常发射/命中经过 beforeAttack、attack、enemyAttackStart 与麻痹处理。只有原天赋的倍率受到沉默影响，普攻和建筑优先选择不被沉默关闭。

`test/mizuki-native-building-enemies.test.js` 9/9 通过：正式 registry 安装、固定原范围、1.433 攻击时点不叠加 preDelay、普通类别筛选、阻挡优先、高嘲讽覆盖建筑分组、1.8 倍在 DEF 前应用、沉默区别、各类异常控制中断、部署序列锁、锁定后离开范围仍命中、原麻痹中断，以及真实 30Hz 行走/冷却共存。

本文件只说明该敌人机制；不表示未实现的 Boss/设施或全部 97 个关卡均已完成。
