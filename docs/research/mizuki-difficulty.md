# 水月 NORMAL N0–N18 原规则接入取证

仅作用于 server/modes/mizuki；没有修改通用 Battle、其他模式或共享干员定义。

## 原始记录与来源

- data/mizuki/rogue2.json 中 rawTopic.difficulties 的 NORMAL 0–18 共十九条提供难度名称、说明、分数系数和告警等级。
- 同表 rawTopic.init 提供所有 NORMAL 初始资源；十九档目前均为生命/最大生命4、希望6、源石锭6、编队容量6、护盾/钥匙0。
- rawTopic.charBuffData 是排异原 ID、黑板、名称及说明；squadBuffData 是启示数据。
- 本地已安装客户端 GameAssembly.dll 的 RoguelikeBattleManager、EAttributeMul 和 BasicRelic 实现由 tools/inspect-mizuki-difficulty-native.py 只读反汇编。
- PRTS“水月与深蓝之树”正文用于交叉核对服务器打包后区域增幅、难度累计、初始投掷次数以及灯火结算，URL：https://prts.wiki/w/水月与深蓝之树 。页面摘要由主代理保存，不将网页叙述冒充客户端黑板。

## 属性预处理与累计

_ClearAttributeCache 将 additions / multipliers / finalScalers 初始化为 0 / 0 / 1；_ApplyFinalAttributes 依次应用加算、百分比缓存和最终乘算，再按属性原范围裁剪。

EAttributeMul::DoPreProcess 调用 BasicRelic::ApplyMultipliersToAttribute，后者将单个黑板值按层数加入百分比缓存。这证明了单个预处理记录的缓存代数，不等于服务器将多档难度规则直接相加。

PRTS 已核对的累计规则：区域增长从第一普通区域开始，每个新普通区域再次乘算；同类深入难度增幅也按规定分别乘算。故 N13 元素损伤为 1.15³，N15 精英/领袖生命额外为 1.2²，领袖攻防额外为 1.15×1.2。各档区域增长率替换前一档的区域增长率，不将 N1…N18 的区域百分比全部累加。

Difficulty.js 在 fresh enemy.base 上进行原预处理，敌人 def、原生泄漏重放记录和全局数据均保持原值；联防重放再次创建新 unit 后处理一次，不会把已处理的数值再乘一次。

N18 动作图来自 config/buff_template_holder.ab；只有精英和领袖生效，攻击是普通 MULTIPLIER 属性修正，伤害类型筛选为物理和法术。duration20、攻击+30%、减伤50%由原 difficulties 描述提供。原 [g]rogue_2_enroll_3_difficulty_18 prefab 黑板为空，其自身 lifeTime=0/lifeTimeType=1 不是最终20秒参数来源。实现不把此空黑板写成“已读出20/.3/.5”。真伤和元素HP伤害不受此减伤影响。

## 层间与资源

原 PlayerRoguelikeV2Zone 含 id/nodes/variation/zoneType；PlayerRoguelikeZoneType 只有 NORMAL 与 SP。isHiddenZone 只是展示属性，portalZones 也不能替代额外区域判据；不同结局第六层仍应按普通第六层处理。

非完美通关的灯火-5与战后生命低于上限一半的灯火-5为两个独立条件。前者读取原敌人泄漏计数，即使共享生命盾吸收损失或联防清除幸存敌人，本次原战斗仍非完美。

共享初始投掷次数集中为 MIZUKI_INITIAL_DICE：原始1，用户要求额外+4，总5；此前未实现占位0不能当作官方基准。投票是联机同步决策层：全体在线成员选择接受/重投，平票优先领队；重投成功只扣一次共享骰子，接受后才写入排异。

## N2 普通诅咒池边界

当前客户端 difficultyUpgradeRelicGroups 为空，缺少服务器实际随机权重。实现使用原 items 元数据筛选 type=RELIC、subType=CURSE、rarity=RARE、canSacrifice=true、无解锁限定，得到普通诅咒 curse_1…curse_6，排除剧情限定 curse_7…curse_10。该筛选是从原物品分类作出的边界推导，不声称空服务器表中存在显式的六项列表或已验证其权重。

所有六项实际效果均读取原 relics 黑板：部署技力-15、敌生命倍率1.25、获得时随机排异、以后进入新层随机排异、战后灯火-2和-3。第三普通区域进入仅发放一次，进区效果在新获得该诅咒之前结算，存档保存发放结果及已进入区域。

## 回归

test/mizuki-difficulty.test.js 覆盖十九档初始值、区域复利、真实 Battle 敌人属性/原定义不变、N18计时、难度权限与锁定、层间投票和重投防重放、排异存档、第三层诅咒不重复、两项灯火条件，以及原crate卡的PREP部署、原5DP、共享库存、重建和checkpoint。

深度认知的 crate 使用原 tokenCards 数量10、费用5、生命100、阻挡3；仅在本模式卫戍备战界面放置。放置记录与本队准备状态保存；重建新 Battle 时从原初始DP及卡库回放一次。
