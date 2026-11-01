# 水月 N0–N18 原客户端证据核对（2026-10-27）

本报告只记录本地原客户端导出数据及原生元数据已能证明的内容，不把文字描述等同于完整执行公式。生产实现与完成度由模式集成报告另行说明。

## 已验证的数据

来源：data/mizuki/rogue2.json 的 rawTopic.difficulties，筛选 modeDifficulty=NORMAL、grade=0…18。

| 等级 | 本级新增规则（原文数据） |
| --- | --- |
| N0 | 深入海洋将面临更严峻的考验 |
| N1 | 受到的元素损伤提高15% |
| N2 | 第三层初始随机获得1个遭诅古物 |
| N3 | 所有敌人法术抗性+10 |
| N4 | 招募3星及以上干员时希望消耗+1 |
| N5 | 所有领袖单位攻击力和防御力额外+15% |
| N6 | 初始灯火-15 |
| N7 | 所有敌人的移动速度+15% |
| N8 | 受到的元素损伤提高15% |
| N9 | 所有敌人的攻击速度+15 |
| N10 | 初始灯火-15 |
| N11 | 所有精英和领袖单位生命值+20% |
| N12 | 所有敌人法术抗性+10 |
| N13 | 受到的元素损伤提高15% |
| N14 | 可同时部署人数-1 |
| N15 | 所有精英和领袖单位攻击力、防御力和生命值额外+20% |
| N16 | 获得收藏品【养育者基因种】 |
| N17 | 组合排异反应将取代基础排异反应 |
| N18 | 所有精英和领袖单位登场后20秒内受到物理和法术伤害-50%，攻击力+30% |

addDesc 明确写出：N1…N15 每进入新的区域，所有敌人攻击力和生命值额外 +N%；N16 为攻击力/生命值 +20%/+20%；N17 为 +20%/+25%；N18 为 +20%/+30%。这些数字与作用对象可由数据直接确认。

rawTopic.init 中 NORMAL 0、1、16、17、18 的起始基础数值一致：生命4、希望6、源石锭6、编队容量6、护盾0、生命上限4、钥匙0；不能依靠这些 init 行解释高难变化。

## N16、N17 的实际系统入口

rawTopic.items.rogue_2_relic_fight_159（养育者基因种）的 usage 确认：排异反应干员同化周围2名正常干员后临时进化；排异反应无效，获得35%庇护，攻击无视目标35%法术抗性和防御力。对应 rawTopic.relics 条目仅有 immediate_reward/rogue_2_shield、count=0，不能把这个占位 buff 当成完整实现。

原生元数据 .cache/mizuki-native-rules/metadata-index.json 定位到 Torappu.Battle.Rogue2InfectionManager，存在 _DoActiveInfection、_TryInfectCharacterOnTile、_Infect、_Ascend、_OnOriginallyInfectedCharacterBorn、_OnOriginallyAscendedCharacterBorn 等方法，并有感染人数、感染/进化 buff、投射物、原始与当前感染/进化干员 UID 字段。这证明客户端具有独立感染/同化/进化管理器；本次未反汇编验证各方法执行次序与触发距离。

rawTopic.charBuffData 含基础、强化与组合排异数据及真实 ability key。例如造血障碍使用 rogue_2_bleed[hp_not_full]、damage=150；专注失调使用 AutoSkillTrigger；神经退行使用 rogue_2_frozen[limited][once]、freeze=15；血肉畸变使用 char_attribute_final_scaler（生命/防御/攻击/费用/再部署时间均为0.5）。原生 Torappu.Battle.Roguelike.Internal.DMutationEffectBuff 具有 DoPreProcess 入口。

## 未验证，禁止据此宣称完整还原

- “每进入新的区域”尚未验证是按区域索引线性加成还是逐区域复利，亦未验证首区域是否计一次；文字描述不足以选定公式。
- N1/N8/N13 的元素损伤 +15% 尚未验证相加还是相乘；N5/N15、N11/N15 同类属性叠加层级及取整时机也未核实。
- N18 的20秒、物法减伤50%、攻击+30%来自官方描述；本次未定位实际 modifier/ability blackboard、计时起点、召唤物继承和重生时是否重置。
- 已定位 RoguelikeBattleManager 的 attributeAdditons、attributeMultipliers、attributeFinalScalers、_ApplyFinalAttributes、PreprocessEnemy，以及 EAttributeMul、EAttributeAdd、GBuffWithLayer 等原生入口；尚无反汇编证据足以闭合上述公式。
- N16 同化/进化和 N17 排异系统必须实际接入战斗生命周期、能力和持久状态才能算完成；仅展示 N0–N18 选择项、藏品图标或说明，不等于这两套系统已还原。

月度任务及月度奖励按本项目要求不接入；原数据中 doMonthTask 字段不构成本项目启用依据。
