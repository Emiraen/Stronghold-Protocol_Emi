# 水月原关卡机制补全记录

基于原客户端关卡、敌人数据库、预制体与动作模板取证；只有真实行为测试通过才登记支持。

## 当前核验（2026-10-27）

- officialMizukiStageOptions() 实查 **97 / 97** 可创建。ro2_ev_1真相与ro2_ev_2狂信如火已接入水月私有敌人模块；该范围是战斗记录支持，不等于完整官方探索生成、事件交易或奖励池还原。
- 原事件/旧Boss/铳兵专项 **24 / 24** 通过；加关卡、波次、武器站专项共 **41 / 41** 通过。最后两关的真相 **13 / 13**、狂信如火 **9 / 9** 通过；相关 ESLint 零错误。
- 97关×3seeds共291次生产自动战斗波次冒烟0issue：.cache/mizuki-native-rules/stage-runtime-verification.json。允许空编队漏怪，不作为玩家通关或数值平衡的证据。
- 15个本轮补全关卡逐一以原关卡源创建并运行到自然结束或300s；真实敌人波次与武器站已生成，所有实例 errorCount=0。300s未结束的原长波次并不提前强制胜利。
- 原关卡60个文件 SHA256 保持不变；只在水月私有模块注册行为，不写共享 KITS / BOSS_KITS。

## 本轮已补机制

- 真相：骑士最高攻击者减攻及原重生阶段；平民按中立路线逃生、禁止友伤和阻挡，死亡扣目标生命且不可联防；官员优先攻击平民并执行真实弹道。原行为审查见truth-production-audit.json。
- 狂信如火：两型狂信徒、术师与火球的原蓄力/命中时点、双模式召火、路线/衰减、碰撞爆炸与灼伤；审查见fire-implementation-status.json。
- 深度认知普通/紧急：原 trap_001_crate 卡与 trap_068_badbox#2 漂流箱依赖，不跳过预置或随机替代分支。
- 竭泽而渔、图穷匕见：原商人全场随机二目标12s不死攻速/攻击增益与睡眠分支；冲浪教练未阻挡物法减伤；救生员半血定时物理闪避。
- 荒地群猎：原60s初始无敌、物理普攻跟踪箭、技能3倍法术箭，Spine事件1.333s发射、speed10/life5，已发射弹不因源死亡消失。
- 鸭本运作：原MELEE根部署掩码和50s唤醒，休眠本身不生成无敌。
- 险路勿近：保留原文件复制遗留但无原触发者的 frosts 分支，不凭空摆冰晶或主动召唤。
- 吹笛人的号召普通/紧急：原5s定时施法、3s前置+Skill_End事件0.6s后发四向弹；speed9/life60、每弹只碰首目标，蓄力可被原控制打断；原RO2图无束流设施。
- 永恒安息/永恒愤怒：原3/1发弹药，双倍物理跟踪弹、空弹转剑；35s空弹检查，换弹每2s回1发；换弹被控制中断按剩弹转枪/剑且仅自身10s眩晕。
- 寒灾之咒：原80s初始无敌，法术普攻寒冷5s，12s冰环对冻结目标倍率按原乘法合并；6.6s重生、二阶段HP×1.5/ATK×1.9/无敌30s；冻结离场只使本次再部署×2；75s原 frosts 四phase按 **1、3、2、4** 顺序一次激活一phase。
- 命运的宠儿：本原场景只有三个 trap_027_stone，无束流/留声机；醉汉普通攻击另附40%ATK法术且不额外回SP，琴手/吟唱者原弹道；原连接选择器无合法设施时不自造连锁/充能目标。
- 铳与秩序普通/紧急：突击手优先真实武器站、命中额外1000法术；阵地破坏者2发炮、原speed4/life10与 **3×3方形** 溅射、命中站另附3000法术、空弹回近战；真实站每2s+1回同一弹药SP。神父10发，每次落弹按原攻击局部BB默认扣1，永久叠DEF-300；Passive.sp=2属于无匹配 vgctrl 的控制器选择器，不误当攻击扣弹2。紧急“与我无关”按原严格30%失血阈值触发、单次跳阈值只施法一次，0.2s后生成永久半径1.5火区，无来源真实100/秒、不回SP，忽略迷彩而不忽略隐匿；源死亡火区保留。

## 原取证入口

- .cache/mizuki-native-rules/station-missing-enemy-prefabs.json：逐敌人预制体、模式、选择器、技能组件与Collider2D。
- station-projectiles.json、station-extra-projectiles.json：跟踪、方形溅射、永久火区与原FX名。
- station-boss-actions.json、station-template-actions.json、station-gun-actions.json：动作模板事件和黑板路由。
- station-hp-trigger.txt、station-modify-sp.txt、station-gun-range.txt：原客户端IL2CPP具体方法反汇编。
- 不改资源总manifest；FX由统一导出流程收录，特别保留原拼写 endmy_sgwlf_skill_start/range/buff。

## 开始补全时的17关阻塞快照

- ro2_n_4_8 铳与秩序：enemy_behavior:enemy_1284_sgprst、enemy_behavior:enemy_1215_ptrarc、enemy_behavior:enemy_1216_cansld
- ro2_n_5_4 吹笛人的号召：enemy_behavior:enemy_1243_ltswar、enemy_behavior:enemy_1243_ltswar_2
- ro2_n_6_2 深度认知：facility_card:trap_001_crate、branch_trigger:trap_068_badbox#2
- ro2_b_1 永恒安息：enemy_behavior:enemy_2026_syudg
- ro2_b_1_b 永恒愤怒：enemy_behavior:enemy_2027_syudg2
- ro2_b_5 “命运的宠儿”：enemy_behavior:enemy_1242_ltsmag_2、enemy_behavior:enemy_1238_ltmob_2、enemy_behavior:enemy_1088_ltsmer_2
- ro2_b_8 荒地群猎：enemy_behavior:enemy_2006_flsnip
- ro2_b_9 寒灾之咒：enemy_behavior:enemy_2007_flwitch、branch_trigger:frosts
- ro2_b_10 险路勿近：branch_trigger:frosts
- ro2_t_5 鸭本运作：enemy_behavior:enemy_1181_napkgt_2
- ro2_ev_1 真相：enemy_behavior:enemy_1104_lfkght_2、enemy_behavior:enemy_3001_upeopl、enemy_behavior:enemy_1107_uoffcr_2
- ro2_ev_2 狂信如火：enemy_behavior:enemy_1184_cadkgt_2、enemy_behavior:enemy_1184_cadkgt、enemy_behavior:enemy_1176_dusocr、enemy_behavior:enemy_1177_dufrbl
- ro2_ev_4 竭泽而渔：enemy_behavior:enemy_2036_syshop、enemy_behavior:enemy_1259_durwar、enemy_behavior:enemy_1259_durwar_2、enemy_behavior:enemy_1262_durplc
- ro2_ev_5 图穷匕见：enemy_behavior:enemy_2036_syshop
- ro2_e_4_8 铳与秩序：enemy_behavior:enemy_1285_sgwlf、enemy_behavior:enemy_1284_sgprst、enemy_behavior:enemy_1215_ptrarc、enemy_behavior:enemy_1216_cansld
- ro2_e_5_4 吹笛人的号召：enemy_behavior:enemy_1243_ltswar、enemy_behavior:enemy_1243_ltswar_2
- ro2_e_6_2 深度认知：facility_card:trap_001_crate、branch_trigger:trap_068_badbox#2

## 分组实施

1. 关卡设施和条件分支：深度认知路障卡及漂流箱引用；寒灾冰晶原触发。
2. 普通敌人：生命阈值闪避、未阻挡减伤、休眠视野、元素/投射物和弹药。
3. 特殊敌人与Boss：原技能、阶段、召唤和友方平民，不以普通攻击替代。

本记录的阻塞清单为开始补全时的快照，实际支持状态以 officialMizukiStageOptions 和专项测试为准。
