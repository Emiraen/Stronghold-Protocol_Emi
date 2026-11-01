# 水月原生敌人：狂暴投掷手与枯朽吞噬者

核对日期：2026-10-27。实现仅在水月模块注册，不修改其他模式的共享敌人 KITS。

## 本地原始证据

只读客户端 AB 目录：C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows。

| 原件 | SHA-256 |
| --- | --- |
| battle/enm_pfb_4.ab | 6e1720e486a5ecec5e57d890516224a41d1905e0ce7304da4023a86be34358b9 |
| battle/enm_pfb_11.ab | 8594247266f4629a729069e0ed23f20e1e3f536f1834f27b8599d96d93e0e8f7 |
| config/buff_template_holder.ab | 7b564314564333731209f1c522e9d332dfe1016619f5f8e0400e92964765afb5 |
| battle/prefabs/[uc]projectiles.ab | 05e079b93078b328e48a0b5512db9e8561f020bd3433da28beb180e22c31924a |
| enemy_1063_rageth.skel | 5f12459d6492fcbb210dcc043e6b4ad0d623494cb62ed25d224f1c67644bcf1d |
| enemy_1063_rageth_2.skel | c79dbc7e4537e3bb80f6623eb646c97d6404910b18701bee151651280bf8446c |
| enemy_1271_nhkodo.skel | 6009564e14a88cf3344081c3957dd823b4b7eb16e3a2351be567438587d22791 |

骨骼用项目 tools/assets/skel.mjs / 原生 Spine 3.8 解析器读取，不按名称猜伤害帧。
缓存：survival-evidence.json、survival-animation.json、nhkodo-prefab-compact.txt、
nhkodo-trigger-disassembly.txt、nhkodo-card-disassembly.txt、nhkodo-respawn-disassembly.txt、
nhkodo-card-update-disassembly.txt、nhkodo-timer-disassembly.txt / nhkodo-timer-update-disassembly.txt，
均位于 .cache/mizuki-native-rules。

## 狂暴宿主投掷手 / 掷骨手

原件：enm_pfb_4，enemy_1063_rageth / enemy_1063_rageth_2。

- CircleRange 半径 2，extendable=0、scaleble=0。数据库 rangeRadius=2.6 不参与该固定碰撞范围。
- 两个骨骼 Attack 时长 2.5 秒，OnAttack=1.467 秒。服务端使用原始元数据，并遵循现有引擎在 BAT 小于动画长度时的缩放。
- 物理弹道 projectile_rageth：speed=18、lifeTime=10、maxHitNum=1、stopAfterMaxHit=1。
- useCachedAtkOnly=0，命中读取当前攻击力；stopWhenSourceInvalid=0，弹体不随投掷手死亡取消。
- 原生特效 rageth_attack_01_trail / rageth_attack_01_hit，不创建替代图形。
- rager_periodic_damage_nomodi 使用 periodic_damage_without_modify：间隔 1 秒、第一次等待 1 秒，不因沉默/眩晕/冻结暂停。
- NoSourceDamage(PURE, damageWithoutModify=true, ignoreForSp=true, attackType=BUFF)。实现调用现有最终伤害原语 applyHpLoss，保留无来源 damaged/fatal/kill 与 noSp；不带 hpLoss 流失标签，不走普通 periodicDamage 的倍率和护盾链。
- 数据库 level 0 为普通每秒 250、精英每秒 350。实现读取实际关卡 blackboard，不硬编码，也不混淆其他变体。

## 萨卡兹枯朽吞噬者

原件：enm_pfb_11，enemy_1271_nhkodo。

### 普攻与吞噬是两个能力

两形态 Mode._attack 虽为 null，但 Mode._combat 分别实际指向 MeleeAttack 的 Attack_A2 / Attack_B，
不能误读为没有普通攻击。二者时长均 1.5 秒，OnAttack=0.833 秒，物理、atkScale=1。
独立 EnemySkill Devour 指向第三个 MeleeAttack：Attack_A 时长 1.833 秒，OnAttack=0.833 秒、atkScale=0。

选择链为 RangedSelectorTrigger → AdvancedSelectorWithValidatorFilter → CircleRange(0.7)，
并非自行编写“被阻挡即无条件吞噬”。HATRED_DES=4；我方地面单位、最多一个、ignoreTargetFree=1。
professionMask=767 排除 TRAP，FilterTagTargetValidator 排除 DEVOUR_IMMU。
实现复用项目干员碰撞半径与仇恨排序，忽略隐匿/无法选择，对选中的同一次部署在原始伤害帧执行。
技能中敌人停留、不能普攻；失衡/硬控或目标离场会中断，尚未成功吞噬可重试。

### 卡牌与形态动作链

enemy_nhkodo_t[devour_holder] 的 ON_BUFF_START：

1. CreateBuffUseTargetAsSource：吞噬者携带独立无限 enemy_nhkodo_t_devour，来源为被吞目标。
2. 为被吞目标生成 HOLD_BY_BUFF 卡牌 buff，继承 respawn_disabled=1。
3. CreateDeckBuff 只标记该 card UID，cardEffectType=DEVOURED。
4. 记录 card_uid，然后 InstantKill(killSource=true, skipReborn=false)，不是虚构的高伤害攻击。
5. switch_mode_no_restore 切到 mode 1，该形态不再带 Devour。

无限 devour buff 的 ON_BUFF_FINISH 同时 FinishCardBuff、按 card UID 清理 nhkodo_deck。
本地实现以 operator.mem.mizukiDevouredBy=enemy.id 持有卡牌状态，由水月手动部署入口拒绝部署。
吞噬者真实死亡、进入目标点或其他离场均清理同一状态；不在原地复活干员。

### 归还时不附加普通再部署冷却

此处使用 respawn_disabled，而不是 respawn_timer_stopped。
Card._UpdateCardBuff 0x1806a71a0 将其写入 m_respawnDisabled（0x1b9）；
Card.OnTick 0x1806a3e80 在该值有效时调用 PeriodicTimer.MarkInvalid（0x1806a4141–0x1806a4150）。
MarkInvalid 0x181f04ae0 用 -1 同时写入 period 与 remaining（0x181f04b1c–0x181f04b2a）。
取消卡牌 buff 后下一次 timer Update 将负剩余值归零并返回 ready；Card.OnTick 随后切回状态 1。
故实现锁定期间 respawnAt=-1，持有者离场时设为当前战斗时间，不凭空增加 70 秒冷却。

S1 enemy_nhkodo_buff 为 DEF ADDITION、MOVE_SPEED RATIO_ADD：
读取 Stronger.def=700、Stronger.move_speed=-0.3，防御加 700、移速乘 0.7，保留普通物理攻击。
原始动画替换为 Idle_B / Move_B / Die_B，普通攻击 Attack_B；对外 form 名为 devoured。

吞噬特效 enemy_nhkodo_attack_01_start 的 oneshot=0，从 ON_CAST_START 持续至 ON_CAST_END。
模块提供 snapshotNativeSurvivalEffects 恢复持续特效；S1 原特效为
enemy_nhkodo_attack_02_start / enemy_nhkodo_attack_02_hit。
前者由真实普通攻击抬手触发（AI 更新后的 swing 跃迁），后者只在 0.833 秒伤害帧触发，
同一抬手不会因后续内容 tick 重复发出 start。

## 集成接口

server/modes/mizuki/native-survival-enemies.js 导出：

- MIZUKI_SURVIVAL_KITS：三个原始敌人 ID 的 mode-local kit。
- isNativeDevoured(unit)：是否被吞噬并锁牌。
- snapshotNativeSurvivalEffects(battle)：当前活跃的吞噬 cast loop。

水月注册表合并 map，并替换旧 rageth_2 → rager 共享 alias，避免叠加两次自伤。
ManualBattle.redeploy、Combat._deploy 与手牌 snapshot 使用 isNativeDevoured，错误码 DEVOUR_LOCKED。
手牌声明 deployable=false、disabledReason=DEVOUR_LOCKED、devouredBy，不改其他模式。
前端 form=devoured 映射 B 动画，默认 attack 为 Attack_A2，Devour slot 为 Attack_A。

## 验证

test/mizuki-native-survival-enemies.test.js 独立加载原始数据，覆盖：

- 自伤首次等待 1 秒、控制中继续、250/350 分族、无来源/noSp/无倍率/不吃护盾。
- 固定半径、原始动画元数据、速度 18 与 10 秒弹道、动态攻击力、源死亡后命中。
- 吞噬 0.833 秒伤害帧、忽略 targetFree、一次吞噬、700 防御与 -30% 移速。
- 死亡/漏怪/其他离场归还、不原地复活、硬控中断重试、免疫标签、部署序号变化防误吞。
- S1 真实 AI 抬手与伤害帧的 start/hit 分离、连续 tick 不重复 start、下一次抬手重新触发。

本文件不宣称适配水月全部关卡，也不把本子任务测试替代整局四人联机回归。
