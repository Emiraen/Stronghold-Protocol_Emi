# 晴雨同汪永久解锁

名片 ID 为 `special_good_boy`。`presentation.value.card`、`room.card.charId`、房间及榜单的 `card` 仍然使用该字符串。

客户端读取 `rank.me` 摘要顶层 `unlockedNameCards`，通过 `shared/nameCards.js` 的 `canUseSpecialNameCard(summary)` 判断是否可选。未解锁返回空数组，解锁后返回 `["special_good_boy"]`；客户端不再根据当前段位放行。

永久权限按 aid 写入排位档案：

```json
{
  "aid": "既有账户的 aid",
  "unlockedNameCards": ["special_good_boy"],
  "nameCardGrantMigrations": ["good-boy-legacy-v1:weijing"]
}
```

普通达段解锁的 `nameCardGrantMigrations` 为空。补发迁移 ID 只用于防止更名后旧名字再次被补发，不随公开 `rank.me` 返回。

初始补发在主服应用新游戏代码后自动执行，调用链为 `startServer()` → `profiles.ready()` → `authority.migrateNameCards()` → `ProfileReplication.transact('rank.nameCards', ...)` → 排位档案原子保存与现有 rank 字段复制。无额外网络接口、无独立凭据读取脚本，也不要求手工修改档案。

首批范围仅为运行迁移时当前真实赋能玩家，以及指定账户名 `味精`、`迷路`、`Emiraen`。当前赋能仍要求积分门槛和全服前 50，沿用现有并列名次规则。不会扫描历史成绩推断其他玩家曾达到赋能。

指定三人的解析优先使用主服账户索引；尚未注册的旧档案仅在名字对应唯一 aid 时采用。迁移记录和永久权限存入该 aid，之后改名、掉段或切换名片都不会丢失。找不到唯一账户时不会猜测，启动日志列出未解决名字；附服旧写入租约尚未交接时，相关 aid 和已观察到的达段事实会写入主服复制状态的 `pendingNameCardUnlocks`。复制交换归还所有权后，只对这份待发小队列自动重试；重启后也保留待发事实，不要求玩家再次达到赋能。

`authority.migrateNameCards()` 可由现有进程内维护代码再次调用，返回 `{ granted, unresolvedNames, deferredAids }`。它是幂等维护入口，未暴露为浏览器消息或 RPC；重启后的正常 `profiles.ready()` 同样会重试尚未完成的补发。已经完成的三人补发按迁移记录跳过，不会把其旧名授予另一个新 aid。

正式应用新代码后，结算前后达到赋能的玩家自动获得永久权限。每次排位结算事务后还会检查当前赋能名单，为因他人掉分而进入前 50 的玩家补写永久权限，均走已有复制事务。登录、权威读取和名片保存前也会确认尚未落标的当前赋能权限。

只更新资源文件、nginx 或 Win7 资源增量包不会执行这些游戏档案迁移。需要主服游戏进程实际应用本次代码，附服也更新相应代码后，才能按新规则选择与复制权限。本次开发没有执行部署、重启或线上补发。
