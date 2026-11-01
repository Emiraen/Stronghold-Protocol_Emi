# 水月持久干员与装备事务

本模块仅作用于水月模式。生产作战沿用卫戍自动作战；不修改其他模式的 PlayerState、sell、equip 或合成机制。

## 持久字段

- unit.items 保存完整装备实例对象，例如 {uid, id, kind:'item', meta:...}，不将背包中的装备降格为仅物品 ID。战斗输入需要物品 ID 时由输入适配器转换。
- player.equipmentInventory 保存未装备的实例；遣散后装备进入此区，不因手牌或临时区容量而销毁。
- player.rosterRequestIds 保存已经成功处理的可选操作编号。未成功的操作不消耗编号，恢复存档后重复编号仍被拒绝。
- 招募晋升必须调用 preserveMizukiEquipment(previous,next)，保留原 UID 和装备实例数据；从 lineup 移除干员不删除 roster，也不卸除其装备。

## 集成接口

1. Match 从已鉴权连接确定 player，不能接受客户端给出的任意 playerId。在命令分支先调用 canDismissMizukiOperator({phase,completedNodes})。允许路线、奖励、事件、商店、招募及 completedNodes > 0 的战后 PREP；禁止首战前 PREP、COMBAT、分队/策略选择和结束阶段。
2. 调用 dismissMizukiOperator(player,uid,{hopeRefund:1,phase,completedNodes,actorId,requestId})。actorId/phase 为可选的第二层防御；公共入口仍必须先鉴权、检查阶段。返回 {ok,error,detail,returnedItems,dismissedUid,hopeRefund}。
3. 成功后 Match 重建该场准备输入、刷新快照和 checkpoint。helper 原子更新 roster、lineup、equipmentInventory、hope、ready；存在 prep 时清除手牌、临时区、棋盘的干员 UID，并移除所属召唤物及其全部位置。失败时不修改这些字段。
4. 升级使用 preserveMizukiEquipment；新干员也可用 preserveMizukiEquipment(null,next) 初始化 items。它是纯函数，返回新对象，不修改参数。
5. mizukiEquipmentView(player) 返回 {equipped:[{uid,items}]}；私有快照显式传 {includeInventory:true} 以增加 inventory。视图均复制数据，不共享可变数组。

返还 1 希望是本项目已告知用户的默认值，不宣称为官方肉鸽遣散规则。允许调用方显式传入其他已批准数值。背包与操作记录各 4096 项是防止存档异常的安全上限，触及上限时整笔拒绝；不静默截断或销毁。希望沿用现有 checkpoint 的 0..9999 范围，超限同样拒绝。

## Checkpoint 校验

调用 validMizukiRosterProgression(player,{itemExists,seenItemUids,reservedUids})，并继续执行已有 validMizukiPrep 与 roster/lineup/希望校验。

- itemExists 可传 id => Boolean(gd.item(id))，或在需要限制可携带装备时检查 itemType==='EQUIP'。
- 先汇总所有玩家的干员、召唤物 UID 到 reservedUids；再以同一个 seenItemUids Set 依次验证玩家，可拒绝跨玩家装备重复拥有和装备/棋子 UID 冲突。
- 装备必须有正安全整数 UID、非空 ID 和可 JSON 保存的有限数值元数据。拒绝旧式纯字符串物品、重复 UID、错误种类、损坏数组和重复操作记录。
- 为兼容装备尚未接入的旧 checkpoint，缺少 items/equipmentInventory/rosterRequestIds 字段视为无装备/无记录；已存在的字段必须合法。若 checkpoint 版本要求完整字段，Match 可在恢复前迁移旧版本或直接拒绝旧版本。

证据参照：原项目 server/match/player/economy.js sell 先检查装备回收容量，再解除干员和所属召唤物，归还装备后结算收入。本水月 helper 复用“先校验、完整回收、不丢装备”的事务顺序，不调用原模式资金收入。

## 验证

独立测试 test/mizuki-roster-progression.test.js 覆盖晋升保留装备、移出编队、视图隔离、阶段门禁、遣散回收和召唤物清理、越权与重放、坏数据/满背包整笔回滚、跨玩家 UID 校验及 JSON 存档恢复。
