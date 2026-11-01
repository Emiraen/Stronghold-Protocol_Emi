# 水月原排异接入（2026-10-27）

实现：server/modes/mizuki/NativeMutations.js。只在水月战场安装，不修改共享 Battle、技能、盟约或其他模式。

## 原始证据

- data/mizuki/rogue2.json / rawTopic.charBuffData：19项完整 ID、说明、真实 ability/shared-data key 与 blackboard。1–4 基础，5–8 强化，9–12 第三期感染基础，13–18 六种两两组合，19 进化。
- 同文件 modules.sanCheck.sanRanges 与 modules.dice：灯火100、50–99、1–49、0分四档，六/八/十二面骰子、结果区间、是否能重掷。骰子结果 MutationResult 在原生元数据中有一个 id 与 chars 列表，故一次双目标检定使用同一反应 ID。
- 原客户端 config/buff_template_holder.ab：选择性解包43项相关模板到 .cache/mizuki-native-rules/mutation-template-actions.json，不扫描图形资源。
- 原 bleed checker 使用0.03秒检查生命不足后创建1秒周期伤害；满血时删除派生伤害 buff。真实 NoSourceDamage 为 PURE、ignoreForSp、isUndeadable=true。实现为每秒150/300无来源真实伤害，正常伤害流水线含护盾/减伤，最后保持至少1生命。
- 原冻结模板排除 MOVE_LIKE_RESPAWN_SELF；普通/组合15秒，强化30秒，保留抵抗及免疫。强化冻结期间攻击/防御+200%。
- 原 auto trigger 仅检验 MANUAL 技能并调用 TriggerSkill/checkBeforeTrigger，不要求技能策略的敌人目标。
- 属性反应使用 FINAL_SCALER，基础/组合0.5，强化0.25；费用及再部署时间也缩放。强化其他原值为生命越低最高+120%攻击、未开技能时每秒+5%攻击/-2攻速最多60层（技能结束重置）、初始技力+80。

## 接口与持久化

卡片字段 mutationId 存原 charBuffData ID，可随 roster 存档并传入下一战 Combat.players[].units[]。安装器由输入身份 playerId+uid 对齐，不让召唤物无条件继承。

getMizukiMutation(unit) 读取原ID；setMizukiMutationSuppressed(unit,on) 临时禁止其效果但保留原ID；controller.setMutation(unit,id,{temporary:true}) 用于本场同化且不改输入卡片。进化、宿主同化距离和人数由 NativeInfection.js 管理。

createMizukiSanCheck 生成待决结果，不立刻改干员；rerollMizukiSanCheck 消耗一枚库存骰子并生成替代待决结果；commitMizukiSanCheck 才原子写入持久反应。state.checkedZones/checks 防止同层重复与恢复后再次触发。严格校验原点数、原结果、原难度反应池、目标数及玩家+UID身份。

本模块从调用方接收真实灯火值与区域标识，不自行发明每节点灯火消耗或根据UI推测生命损失系数。原 battleLoadingTips 已确认非完美作战以及战后目标生命不足上限一半会下降灯火，但本次客户端表未提供确切下降量。N2第三层遭诅古物原 difficultyUpgradeRelicGroups 为空，不能直接将全部诅咒藏品（含剧情品）作为它的随机池。

月度任务和月度奖励不接入。
