# 水月原武器站适配证据

日期：2026-10-27。仅适用于水月专属模块，不修改共享战斗或其他模式。

## 原数据与机制

只读来源为本机明日方舟客户端的 trap_057_wpnsts 预设、sktok_wpnsts_1 / sktok_wpnsts_2、wpnsts_change_side 模板及 GameAssembly.dll。原始组件摘要存于 .cache/mizuki-native-rules/stage-prefabs.json 和 facility-template-actions.json，运行数据在 data/mizuki/facilities.json。

- skill 1 初始我方、skill 2 初始敌方。25000 HP，75 HP/s 自回复。
- 原 x-1 同阵营范围，每个目标进入范围后独立计时，每 2 秒恢复 1 SP。离开移除该目标计时。原职业 mask 639 仅过滤 Character，不能错误排除敌人。
- 致命事件 ON_BEFORE_TRY_SET_HP_ZERO 立即对旧阵营的范围单位造成 1000 法术伤害和 5 秒眩晕，再切换阵营；20 秒重生结束后满血、切换对应模式，可反复夺取。
- 原重生异常 mask 0x28 为 BLOCK_FREE + INVINCIBLE。原 target-free 属性又从 INVINCIBLE 派生，因此水月实例在窗口中同时不可选中。
- 原免环境伤害只匹配 IS_ENVIRONMENT_DAMAGE 标记；不能按弩炮、火山、祭坛、地形的名称免伤。
- 敌人的 SP 必须经过真实能力接口 mem.mizukiGainSp(amount, { reason: 'wpnsts', source })；未实现的敌人能力不能改成降低攻击冷却。

## 原特效生命周期修正

trap_latelan_char_01 / trap_latelan_enemy_01 **不是有限爆炸特效**。两项原根类为 MapEffect，三个 ParticleSystem 均 looping，原 Animator 包含循环 idle 和 start 曲线且无结束事件。

两模式各自的 passive buff wpnsts_t_blast 将该键作为 overrideEffectKey。客户端 Entity::AddBuffEffect（0x1806f4ea0，0x1806f4f72 读取 buff.effectKey，0x1806f52e7 创建）持有它；Entity::RemoveBuffEffect（0x180701880）在引用计数归零后于 0x1807019c1 调用 Effect::FinishMe。故它随模式 Buff 附加和移除而开始、停止。

MapEffect::_delayToFinish 在 get_delayToRecycle（0x181165f60）被返回，是 FinishMe 后回收延迟，不是自动寿命。Effect::DoPlay（0x18113c430）没有自动结束计时，MapEffect 也未覆写 DoPlay。不得从 2 秒动画长度、粒子 duration 或 20 秒重生窗口推导爆炸 TTL。

实现因此同时持有当前模式的 _01_start（能力效果）和 _01（Buff 范围效果）。原 RebornTalent 会移除未保留 Buff、detach 旧能力，所以夺取时两项均停止；重生结束后附加新模式两项。没有追加自创爆炸，也不会遗留无限一次性 MapEffect。

重生的 charging 原粒子循环，attack 原粒子单次；它们均由 RebornState 持有并在原 20 秒 OnExit 明确 FinishMe。原 attack 的 8 秒粒子总时长不能当作技能窗口。effect 回调第 4 参数为 { loop: true / false }，调用者应保留显式 false。

关键反汇编缓存：wpnsts-entity-buff-effect.txt、wpnsts-map-effect-lifetime.txt、wpnsts-effect-core-lifetime.txt、wpnsts-buff-set-effect.txt、wpnsts-effect-key-hook.txt。CreateEffect 空键读取黑板字符串 effect；它不能被错误解释为任意有限爆炸。

## 验证与局限

专项命令：node --test test/mizuki-weapon-station.test.js。覆盖初始双模式可选性、常驻范围 FX 生命周期、目标独立恢复 SP、离开重置、敌方真实 SP hook、两次夺取、重生窗口、原伤害和异常免疫。ESLint 检查同模块和测试。

唯一使用此设施的 ro2_n_4_8 仍含 enemy_1216_cansld 与 enemy_1284_sgprst 等尚未适配的原弹药 / SP 能力。设施可用不代表整关完整可玩，不能据此跳过关卡依赖门控。浏览器对原 Unity Shader 和 Animator 的兼容属于独立验收项；资源导出不等于完整视觉还原。

月度任务和月度奖励不属于本次接入范围。原局内奖励保持原任务边界，不由本模块改写。
