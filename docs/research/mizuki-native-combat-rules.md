# 水月手动作战：原生费用与部署占位

核对日期：2026-10-27。运行时数据：`data/mizuki/native-combat-rules.json`。
适配器：`server/modes/mizuki/NativeCombatRules.js`、`Combat.js`。

## 原始来源

只读核对本机官方客户端 `C:/Program Files/Hypergryph Launcher/games/Arknights Game`：

- `GameAssembly.dll` SHA-256：`5d0ffcb8be5d385e069442f0b3e8ad674cbb707cf796f692657a25e876f181ec`。
- `Arknights_Data/il2cpp_data/Metadata/global-metadata.dat` SHA-256：`5992e2be0e4280dccf2547065100de573ed48c8761f557b761d62695db82f80c`。
- `Arknights_Data/StreamingAssets/AB/Windows/charpack/char_*.ab` 中干员 prefab 的原始字段。
- `pkgrps/btl_pfb_tokens_*.ab` 中召唤物 prefab 的原始字段。
- `config/buff_template_holder.ab` SHA-256：`7b564314564333731209f1c522e9d332dfe1016619f5f8e0400e92964765afb5`，对象 pathId `6070581171229484677`。

完整 213 个 bundle 哈希及各实体 pathId 保存在 JSON。缓存脚本与有限取证输出在 `.cache/mizuki-native-rules/`；不修改官方客户端。

## 已核实并接入的规则

1. 干员费用以真实 kit 处理后的基础费用计算：首次 1 倍、第二次向下取整的 1.5 倍、第三次及以后 2 倍。原常量 `CHARACTER_RESPAWN_COST_MULTIPLIER=0.5`、`CHARACTER_RESPAWN_COST_MAX_MULTIPLIER=2`；`Deck.Card.get_rawCost` 位于 `0x1806a9860`。召唤物不增加重部署倍率。
2. 只在玩家成功手动部署后累计次数；费用在原 deploy/天赋钩子之前支付，失败回滚。技能位移、复活不计为额外付费部署；不改写 `unit.base.cost`，砾等原 kit 的减费只计算一次。
3. 主动撤退返费为 `min(floor(currentCost * recoverRatio), ceil(rawCost * maxRatio))`。原 `Character.Withdraw` 位于 `0x1809f2ce0`，普通 prefab 比例为 0.5、原费上限比例为 1；冲锋手 prefab 比例为 1，商人 prefab 比例为 0。战败或死亡不走主动撤退退款。
4. `Token.get_allowWithdrawGainCost` 位于 `0x180a591e0`，默认直接返回 false；召唤物不能仅因继承 prefab 的 0.5 比例而获得干员退款。
5. 原 CHG-X、EXE-X 模板 `bpipe_e_trait[gaincost]`、`wildmn_e_trait[gaincost]`、`grani_e_trait[gaincost]`、`sddrag_e_trait[gaincost]`、`vigna_e_trait[gaincost]`、`phatom_e_trait`、`gravel_e_trait`、`waaifu_e_trait` 的 `SetWithdrawCostRecoverRatio` 都设置 `_dontLimitMaxWithdrawCost=true`。选择这些模组的 `withdraw_cost_recover_ratio` 黑板后，上限放宽至本次部署使用费用。节点 Execute 位于 `0x1810e5b20`。
6. 部署占位读取原 prefab `_occupiedRemainingCharacterCnt`。Mon3tr、幻影虚影、麦哲伦无人机、令的召唤物等占 1；医疗探机、流形、战术家援军、海嗣等为 0。模组的 `dont_occupy_deploy_cnt` 仍可覆盖为 0。
7. 高级弦惊不是简单的一个布尔占位：`ling_soul3_evolution[self]` 与 `[another]` 都执行 `TransferRemainingCharacterCntVolume`，将被吸收者体积加到幸存者，并清零被吸收者。Execute 位于 `0x180fe6970`；体积 setter 位于 `0x1809fcc30`。水月读取原 kit 现有 `mem.lingAdvanced` 标记，将在场高级弦惊计为 2，占位不会因融合凭空少一个；撤退或死亡释放 2，下次部署回到基础形态 1。

## 手动召唤卡组适配

水月为召唤师按原同时部署容量创建多个手动实体，使用原 kit 的 `summonDeck.held`、`maxDeployed`、`deckReadyAt`，避免继承旧自动模式的开场免费放置策略。独立召唤容量按体积计数，高级弦惊计 2；技能生成库存的召唤物使用原 `summonStock`。不修改共享召唤师 kit。

## 快照字段

- 作战：`deployLimit`、`deploySlotsUsed`。
- roster：`deploySlots`、`paidCost`、`nextCost`、`retreatRefund`。
- `roster.cost`：在场时为本次实付；未部署时为下次真实费用。
- 召唤卡组：`summonHeld`、`summonCap`、`summonDeployLimit`、`disabledReason`。
- `SUMMON_LIMIT` 表示所属干员的召唤物同时部署容量已满；`NO_SUMMON_STOCK` 表示原库存不足。

## 覆盖与隔离

JSON 覆盖 209 个干员和当前 catalog 全部 57 种 token。当前本地官方客户端没有 `char_4231_clemnt` prefab；该额外干员使用普通干员默认 1 占位、0.5 返费，不能声称它已经逐项原文件核实。

原生规则仅由水月 `ManualBattle` / `MizukiCombat` 导入。共享 `Battle`、召唤师 kit 和原盟约规则未改。共享 `server/sim/content/garrisons/battle.js` 的原有函数正文与备份一致，只额外导出水月需要的 helper；换行也按备份保留 LF。

定向回归位于 `test/mizuki-native-combat-rules.test.js`，覆盖重复费用、失败和死亡、各分支返费、Mon3tr、零占位医疗探机、真实令 S3 双向融合及召唤卡组容量。此报告只证明上述费用、返费、占位和适配规则，不代表已完整复刻官方全部战斗引擎。
