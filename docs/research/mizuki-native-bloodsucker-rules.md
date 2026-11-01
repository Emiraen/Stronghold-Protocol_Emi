# 水月原血裔与补给车机制

核对日期：2026-10-27。仅由水月 `official-enemies.js` 安装；未修改共享敌人库、战斗模拟器或其他模式。月度任务与月度奖励不属于接入范围，普通局内奖励不受此约束影响。

## 原始证据

- 本机只读官方客户端：`C:/Program Files/Hypergryph Launcher/games/Arknights Game`。
- `data/mizuki/enemy-database.json` 保留原敌人等级、属性与黑板。
- `.cache/mizuki-native-rules/prefabs-more-ordinary.json`：原 dzoms、dzomg、dpvt、dsuply 预设的行为组件与选择器。来源 bundle 及对象 pathId 在缓存中。
- `.cache/mizuki-native-rules/bloodsucker-actions.json`：原 `config/buff_template_holder.ab` SHA-256 `7b564314564333731209f1c522e9d332dfe1016619f5f8e0400e92964765afb5`，对象 pathId `6070581171229484677`。
- `BlockedToggleChecker::_UpdateEnemyBlockeeBuffs`（`0x180edabe0`）调用 `Enemy.get_blocker`，向当前阻挡者添加控制 Buff，并在阻挡者改变时移除旧控制 Buff。反汇编保存在 `bloodsucker-blocker-disassembly.txt`。
- `Buff.Event` 原枚举序号 3 为 `ON_OWNER_KILLED`。派生节点明确用 `FilterDeathReason(FALLDOWN)` 接 `IfNot`。
- `.cache/mizuki-native-rules/dsuply-projectile.json`：原 `battle/prefabs/[uc]projectiles.ab` 中 `projectile_enemy_dsuply`。
- `public/assets/mizuki/library/spines/enemy_1224_dsuply_2/enemy_1224_dsuply_2.skel` SHA-256 `0bf094fd6f3d7dfef032e863d465c86c7e02417091315630a1768b2bb0f54066`；`tools/assets/skel.mjs` 读取 Attack 长 1.2 秒、OnAttack 0.433 秒，结果在 `dsuply-attack-animation.json`。
- `ApplyElementDamage::CreateElementDamageModifier`（`0x180fee4e0`）读取源实体攻击力并调用原 `BattleFormula.CalculateElementDamage`；缓存 `dsuply-element-modifier.txt`、`dsuply-element-disassembly.txt`。

## 已接入

1. `enemy_1220_dzoms`、`enemy_1221_dzomg` 原 `damage_resistance` 只作用于物理与法术。黑板 0.9 表示减免 90%，作为防御/法抗结算后的伤害乘区处理，真实伤害不减。该能力不可沉默。原出生等待为 1 秒，无凭空添加的无敌。
2. 这两类血裔持有原 `enemy_bloodsucker_mark`。每名正在被阻挡的血裔使其阻挡者阻挡数加 1，原有效叠加上限 6。仅给这些敌人实例设置 `blockedBy` 访问器，原 `_unblock`、`releaseBlocked`、死亡、撤退、转移及容量释放即时清理；不改共享方法。
3. `enemy_1222_dpvt` 真正被击杀后，以原黑板 `deathrattle.enemy_key=enemy_1220_dzoms`、`delay=1` 派生 1 名敌人。使用真实剩余路线、原独立 ±0.1 轴偏移、原可达性检验和波次等待。沉默不禁用；漏怪、撤退、过期与坠落不派生。
4. `enemy_1224_dsuply_2` 原全场光环只选择带血裔标记的同阵营目标，攻击力每个来源加 10%，最多 5 层，源沉默或离场移除。原 `ON_CALCULATE_DAMAGE` 附加 DARK（项目原生名称 `apoptosis`，凋亡）损伤，比例为源当前攻击力的 10% × 有效层数。
5. 补给车攻击范围取原固定 CircleRange 半径 2：原 `_extendable=0`、`_scaleble=0`，DB 的 1.6 不会覆盖这个预设范围。原物理追踪弹道速度 10、寿命 5 秒；发射后源死亡不使其消失。攻击动画在当前敌人实例中克隆，保持原 1.2/0.433 节奏。
6. 原 FX 以客户端键发送：两种血裔出生、补给车常驻/发射/飞行/命中。`officialEnemyEffects` 保存当前有效常驻效果，用于重连。前端导出、shader 与动态验收有独立完成条件；服务器发出原键不等于粒子已完整渲染。

## 验证与边界

`test/mizuki-native-enemies.test.js` 本轮 51/51 通过；覆盖物法/真实伤差异、沉默、出生时点、7 个血裔上限与即时释放、派生波次 hold、全场五层光环、非标记排除、源沉默/死亡/漏怪清理、真实速度与寿命、源死亡后弹道仍命中、观察者原范围 FX 重连快照。对应模式文件与测试 ESLint 通过。

这些机制仍不表示 97 个关卡档案全部可玩。原末路狂徒 `enemy_1059_buster_2` 已另行通过 `native-building-enemies.js` 专属接入，原建筑优先、高台攻击、最终嘲讽排序与建筑伤害倍率的证据见 `mizuki-native-building-enemies.md`。原关卡包含其他未接入机制时仍必须继续拒绝启动。
