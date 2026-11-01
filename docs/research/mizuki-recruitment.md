# 水月模式招募事务与原盟约刷新接入

更新：2026-10-27。范围仅限水月模式；共享商店、原效果定义和其他玩法未修改。

## 已确认的变体规则

- 每张招募券可招募三次，另有三次免费主动刷新。
- 每次选人成功后自动更换候选页。自动换页不扣主动刷新次数，也不触发刷新盟约或刷新特质。
- 职业券保留职业偏好，但候选来自完整干员池，不按职业排除其他干员。
- 普通同名招募累计份数：首次为一份、第二次为两份、第三次原位精英化。原 UID 与完整装备实例保留，不额外赠送干员。
- 高级权限与职业范围分开保存。kind=advanced 或创建时 advanced=true 才能对已有普通干员一次进阶；ANY 职业的普通券不自动获得进阶权限。
- 高级券、进阶节点和进阶道具可共用一次进阶 plan。直接进阶保留原累计份数。
- 希望价格仍由 Match 按已有分队折扣规则计算。普通重复招募使用招募价；高级直接进阶使用进阶价。
- 用户指定四星基础招募价为 1 希望；一至三星仍为 0、五星为 3、六星为 6。进阶价格保持四星 1、五星 2、六星 3；免费招募、难度与藏品等已有费用规则继续在基础价上计算。

## 未指定参数与项目依据

每页候选数使用 GameData.shopSlots(GameData.maxShopLevel).chess，当前值为五。水月没有商店升级限制，因此完整干员池按项目最高调度等级的候选格数展示。没有新增另一套候选数量表。

抽选基础权重使用 GameData.poolCopies(operator.canonicalChessId)。项目既有各阶份数为 12、14、18、16、8、5，并继续使用其逐干员覆盖和联机倍率。本模式的展示不占用或耗尽其他模式的共享库存。

用户未指定职业权重倍率，当前采用二倍作为可调整默认值，保存在 MIZUKI_RECRUIT_RULES.professionWeightMultiplier。公式为基础权重乘以同职业二倍，其他职业一倍；ANY 不额外加权。此倍率和五格展示属于项目适配参数，不宣称是官方原肉鸽的随机抽选规则。

每一页初次抽取按权重不放回，减少同页重复干员。原策略明确要求复制候选时，原 handler 仍可生成重复候选格。

## Recruitment.js 接口

| 接口 | 职责 |
| --- | --- |
| createMizukiRecruitTicket | 创建可直接序列化的三招募、三刷新券 |
| mizukiRecruitParameters | 返回项目候选格数及本模式参数 |
| openMizukiRecruitTicket | 仅首次打开时抽取候选；重复读视图不重抽 |
| rollMizukiRecruitCandidates | 完整池、职业偏好、既有份数加权抽选 |
| mizukiRecruitOfferId | 包含券 ID、候选代次和干员 ID 的选人 token |
| mizukiRecruitRefreshId / mizukiRecruitSkipId | 包含券 ID 和候选代次的主动刷新、放弃 token |
| planMizukiRecruitment | 只读返回 recruit、copy、promote 或 upgrade 计划 |
| applyMizukiRecruitProgress | 应用份数与进阶，同时保留原 UID、完整装备实例 |
| planMizukiDirectPromotion | 高级招募、进阶节点与道具的一次进阶计划 |
| consumeMizukiRecruitTicket | 成功选人后扣一次招募并自动换页，返回新券 |
| refreshMizukiRecruitTicket | 通过当前 token 后扣一次主动刷新并返回新券 |
| skipMizukiRecruitTicket | 通过当前 token 后放弃本券所有剩余招募 |
| grantMizukiRecruitRefreshes | 原盟约或特质授予有限额外免费刷新 |
| validMizukiRecruitTicket / validMizukiRecruitProgress | 存档恢复时严格校验券与干员累计份数 |

除了原效果授予免费次数的 grant 函数外，招募券事务不修改传入券，返回 { ok, ticket, effects }。Match 持有授权、希望扣除、阵容创建和最终提交职责。应先验证当前 token 和 plan，再构建阵容替换；将新阵容传入 consume，使自动新页能排除已进阶干员。

干员记录新增 recruitCopies。普通 promotion=0 只接受一或二份，promotion=1 接受一至三份（保留高级券直接进阶前的份数）。Match 仍校验 chessId、技能与官方形态对应关系。

## 招募券保存与防重放

招募券 schemaVersion=1，保存 count、status、freeRefreshes、freeRefreshesGranted、refreshCount、revision、candidates、recruited、requestIds、lastManualRefreshRevision、metaRefreshRevision。

- 当前 token 必须同时匹配券和 revision。旧候选、旧刷新和旧放弃 token 无法作用于新页或下一张券。
- requestId 如提供，必须未处理过；保存后仍拒绝重用。
- revision 与打开次数、主动刷新次数、已招募次数、放弃状态严格相符。
- 免费次数恒等于三加原效果奖励次数减主动刷新次数。
- 使用完和放弃的券必须 count=0 且没有候选。
- 不接收 null 作为跨券放弃命令；应发送后端返回的 skipOfferId。

## RecruitmentMeta.js 原效果接口

dispatchMizukiRecruitRefresh 接收已成功提交的新券、effects、player、catalog、gd、contextFactory 和可选 callbacks。只有 effects.manualRefresh=true，且该代次确由主动刷新产生时才执行；先记录 metaRefreshRevision，防止回调重入或保存恢复后重复触发。

Match 在调用前增加自己的 player.recruitRefreshes，提供给原 ctx.roundStats().refreshes；本 helper 不重复增加。contextFactory(source) 可直接复用 Match._metaContext(player, source)。

执行顺序为原 registry 的 global、band、bond、garrison、装备。原 handler 保持不变，候选页提供 shopSlots、setShopSlot、rollChess，免费奖励提供有限额 grantFreeRefresh，每个拥有的干员提供逐回合逐份特质计数。handler 执行前固定干员快照，因此刷新效果刚获得的新干员不会补计当前这次刷新。进阶后的棋子 ID 变化使其特质计数与原形态分开。

dispatchMizukiRecruitPromotion 只派发原 onMerge handler；不存在额外原商店三合一赠人调用。Match 若接原策略的显式 grantChess 等效果，可通过 callbacks 提供自己的安全招募/物品入口。

实际 handler 回归包含拉普兰德刷新加层、奇迹授予下一次免费刷新，以及梓兰复制候选中最高阶干员。没有重写这些盟约、特质或策略数值。

## 验证

test/mizuki-recruitment.test.js 覆盖十九项：完整池偏好、三招募三刷新、自动换页与手动事件隔离、三份原位精英化、装备实例保留、高级权限分离、存档篡改、旧 token、requestId 重放、刷新效果恰好执行一次、原特质/盟约/策略 handler，以及不赠送额外精英化奖励。

2026-10-27：十九项通过，专项 ESLint 零错误、零警告。与 Match、协议、召回和前端的整体回归由集成人员运行。
