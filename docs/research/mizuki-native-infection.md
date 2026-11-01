# N16 同化进化（2026-10-27）

实现：server/modes/mizuki/NativeInfection.js；参数：data/mizuki/native-infection.json。仅水月模式安装，不修改共享 Battle、干员技能或其他模式。

## 本地官方源

- 原客户端 battle/prefabs/[uc]envsystems.ab，env_027_rogue2enroll3 / Rogue2InfectionManager。SerializedFile CAB-63d3144cebdd9c7c80a7d0b4f965ca02，PathID 5896648793732786632，原对象 SHA256 03882efd25cabcf63f4eb19479a7381762aea45c84a192da822158afdab8ded0。原 tree/raw 保留在 .cache/mizuki-native-rules/infection-config/。
- 原 GameAssembly.dll 对应类只读反汇编：.cache/mizuki-native-rules/infection-manager-disassembly.txt。原脚本 tools/inspect-mizuki-native-methods.py 可按精确类名复核。
- 原动作树：.cache/mizuki-native-rules/mutation-template-actions.json，rogue_2_enroll_3_ascension[core] 创建 damage_resistance[inf] 和 DEF_PENETRATE / MAGIC_RESIST_PENETRATE 加算属性。
- 原 rogue2 数据：rawTopic.items.rogue_2_relic_fight_159 的 usage 明确同化2名、35%庇护、35%双穿透；rawTopic.charBuffData.rogue_2_mutation_19 为进化。relics 同 ID 的 immediate_reward/shield0 只是占位，不能当效果实现。

## 与原管理器一致的状态机

- 开战登记原 char_shared_data 排异干员；本场第一个原排异的黑板作为全场感染模板（_RegisterOriginalCharBuff / _GenerateInfectionBuffData）。N17组合排异保持全部分量。
- 排异宿主部署时按原八格顺序 (1,-1)、(1,0)、(1,1)、(0,-1)、(0,1)、(-1,-1)、(-1,0)、(-1,1) 查找正常干员。仅成功感染计数；两次成功后立即进化，不再传播。
- 正常干员部署时收集1.5格内仍有额度的全部原宿主：正常干员仅感染一次，每个在范围内的原宿主都减一次额度。被感染的正常干员没有宿主传播能力。召唤物、敌人不参与。
- 原宿主剩余额度、感染和进化在本场死亡/再部署后保留；临时同化不写回编队持久排异字段。安全存档回滚战前准备阶段，下一战重新建立本场状态。
- 进化立即暂停排异全部效果（含冻结、流血、属性、费用/再部署缩放和强制自动技能），获得35%物理/法术庇护、35%防御/法抗穿透。复用卫戍 holdProtect 的同名最高值规则，不额外降低真实/元素伤害。
- 双人同图可以跨队友感染；以实际单位身份登记，个人 UID 重号、编队和盟约状态不合并。

## 验证

node --test test/mizuki-infection.test.js：9/9通过，真实 Battle 实例覆盖 N15隔离/原藏品启用、原八格顺序、同次感染为多个宿主计数、N17冻结属性组合、实际伤害/穿透与庇护不叠加、死亡再部署、双人同场及个人持久输入隔离；另测PILL随机一名/BIGPILL全员永久进化、无目标不扣，以及N0永久进化仍生效。

原projectile来自battle/prefabs/[uc]projectiles.ab的SimpleProjectile：mainEffect=rogue_2_infect_trail，命中rogue_2_infect_hit，速度5、寿命10。证据infection-projectile.json，工具export-mizuki-infection-projectile.py。真实FX资源已导出，不把projectile注册名误当particle prefab。进化环绕在快照中保留，重连不丢。

实际Match道具库存、NO_TARGET/战中拒绝、持久化和原UI按钮亦有集成与浏览器测试。N16战后原随机掉率未取得，尚未擅自生成奖励。
