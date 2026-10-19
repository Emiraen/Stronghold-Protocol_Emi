# 插件开发指南（当前版本）

本文面向本仓库当前插件系统。插件清单使用 `manifest: 2`，插件 API 当前值为 `2`，兼容范围由 `shared/constants.js` 的 `PLUGIN_API.min/current` 决定。创建插件时，`app` 必须覆盖服务器实际报告的应用版本；现有模板使用 `>=0.3.0 <0.4.0`。

规范和实现入口：

- [PLUGIN-API.md](PLUGIN-API.md)：冻结字段、权限、记录和消息表。
- [plugins/_template](../plugins/_template)：cosmetic、content、ui 模板。
- `shared/plugins/manifest.js`：类别、字段、权限和文件边界。
- `shared/plugins/ui.js`：UI 插件的 `postMessage` API 和限制。
- `shared/plugins/sdk.js`：脚本插件的 `sp:sdk@1`。

## 1. 选择插件类别

| 类别 | 用途 | 默认范围 | 是否改变对局 |
| --- | --- | --- | --- |
| `cosmetic` | 头像、立绘、Spine、音频、主题、公告 | `room`、`personal` | 不能 |
| `content` | 数据记录、干员、敌人、关卡、模式、DSL、offers | `room` | 可以影响组合内容 |
| `ui` | 沙箱界面组件、统计面板、房间/结算扩展 | `personal` | 不能发送对局指令 |
| `script` | 服务端模拟器或元数据扩展 | `room` | 可以，需服主开启并固定 |
| `trusted` | 受信任的页面或服务端代码 | `server`、`room` | 可以，实验性且需授权 |
| `lang` | UI 或游戏文本语言包 | `personal` | 不能 |

新插件优先选择 `cosmetic`、`content` 或 `ui`。`script`、`trusted` 属于受限代码插件，公网服务器默认不接受；`ui` 始终只读。

## 2. 目录和最小清单

目录名必须匹配 `^[a-z0-9][a-z0-9-]{1,31}$`：

~~~text
plugins/my-weather/
  plugin.json
  README.md
  media/
  data/
~~~

最小清单：

~~~json
{
  "manifest": 2,
  "name": { "zh": "天气主题", "en": "Weather theme" },
  "description": { "zh": "改变大厅视觉", "en": "A lobby visual theme" },
  "version": "0.1.0",
  "app": ">=0.3.0 <0.4.0",
  "api": 1,
  "class": "cosmetic",
  "scope": ["room", "personal"],
  "authors": ["作者名"],
  "license": "CC0-1.0",
  "permissions": ["assets.override"]
}
~~~

常用字段：`requires` 必需依赖，`optional` 可选依赖，`conflicts` 互斥插件，`loadAfter/loadBefore` 加载顺序，`priority` 排序，`settings` 设置，`permissions` 权限，`entry` 入口，`slots` UI 位置。`settings` 最多 32 项，只允许 boolean、integer、number、enum，不允许自由文本。

路径必须是插件目录内的相对路径，不能包含 `..`、隐藏段或绝对路径。未知字段只会产生警告；结构、路径、权限或哈希错误会拒绝插件。

## 3. 权限

| 权限 | 用途 |
| --- | --- |
| `assets.override` / `assets.add` | 覆盖或新增资源 |
| `theme` | 写入允许的主题变量 |
| `data.patch` / `data.add` | 修改或新增数据 |
| `dsl` | 使用受限 DSL |
| `offers` | 声明交互窗口 |
| `ui.frame` | 挂载沙箱 UI |
| `sim.code` / `meta.code` / `mode.code` | 脚本扩展 |
| `trusted.page` / `trusted.server` | 受信任页面或服务端入口 |

权限必须符合类别，且只声明实际使用的能力。脚本权限只有在服主开启脚本模式、插件被允许并固定后才生效。

## 4. 外观插件

资源写在 `assets` 中。可以使用插件自己的文件，也可以用 `ref` 引用安装中已有资源：

~~~json
{
  "class": "cosmetic",
  "permissions": ["assets.override"],
  "assets": {
    "chars": {
      "char_102_texas": {
        "avatar": "media/avatar.png",
        "portrait": { "ref": "char_112_siege" },
        "spine": { "front": {
          "skel": "spine/front.skel",
          "atlas": "spine/front.atlas",
          "textures": ["spine/front.png"]
        }}
      }
    },
    "audio": { "voice": { "char_102_texas": { "select": "audio/select.ogg" } } }
  }
}
~~~

不要复制官方游戏文件；原创文件放在插件目录，官方文件用 `ref`。Spine 的动画、事件和 bounds 由 `plugin.lock.json` 记录，不要手写。外观插件只改变显示和声音，不改变模拟器数值、技能或胜负。同一资源被多个插件修改时，组合顺序决定最终值并产生覆盖警告。`theme` 只能使用 `shared/plugins/theme.js` 的 allowlist，`notices` 不进入对局内容身份。

## 5. 内容插件

内容插件可以声明 `data`、`operators`、`enemies`、`modes`、`stages`、`dsl`、`offers` 和 `i18n` 文件：

~~~json
{
  "manifest": 2,
  "name": { "zh": "新敌人包", "en": "Enemy pack" },
  "version": "0.1.0",
  "app": ">=0.3.0 <0.4.0",
  "api": 1,
  "class": "content",
  "scope": ["room"],
  "permissions": ["data.add"],
  "enemies": ["data/enemies.json"],
  "i18n": { "zh": "data/i18n/zh.json" }
}
~~~

新增记录必须使用插件命名空间，不能覆盖官方或其他插件 ID。服务器会重新检查引用、记录类型、数值范围和官方上限；组合失败时整组内容不会进入房间。当前稳定规则开关为 `shopBias`、`prepLoadout`、`morphPairing`、`unequip`。实际启用的规则进入内容身份 `cs`，房间玩家必须加载同一组合。

## 6. UI 插件

清单示例：

~~~json
{
  "manifest": 2,
  "name": { "zh": "伤害统计", "en": "Damage tally" },
  "version": "0.1.0",
  "app": ">=0.3.0 <0.4.0",
  "api": 1,
  "class": "ui",
  "scope": ["personal"],
  "permissions": ["ui.frame"],
  "entry": { "client": "ui/index.html" },
  "slots": ["hud.right"]
}
~~~

可申请的 slot：`hud.right`、`result.tab`、`stats.tab`、`room.panel`。

~~~js
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.v !== 1) return;
  if (msg.t === 'welcome') parent.postMessage({ v: 1, t: 'ready' }, '*');
  if (msg.t === 'battle' && Array.isArray(msg.events)) updatePanel(msg.events);
});
parent.postMessage({ v: 1, t: 'ready' }, '*');
parent.postMessage({ v: 1, t: 'slot', slot: 'hud.right' }, '*');
parent.postMessage({ v: 1, t: 'resize', height: 72 }, '*');
~~~

插件消息：`ready`、`slot`、`resize`、`storage`、`notice`、`stats`。主机消息：`welcome`、`state`、`battle`、`stats`、`storage`、`limit`、`slot`、`rejected`、`result`、`net`。

限制：单条消息 8 KiB；每秒 20 条、突发 40 条；战斗推送每秒 4 次、每批 40 个事件；快照 48 KiB；iframe 高度 48–480 px；每插件最多 32 个键、总存储 32 KiB、单值 4 KiB。UI 插件不能发送 `hello`、`ping`、`room.*`、`g.*`、`b.*` 等对局意图，不能访问游戏 origin、Cookie、IndexedDB 或网络接口。快照和事件可能被裁剪，插件必须容忍缺字段、断帧和重复初始化。

## 7. 脚本插件和 SDK

脚本入口示例：

~~~json
{
  "class": "script",
  "permissions": ["sim.code", "meta.code"],
  "entry": { "sim": "src/sim.js", "meta": "src/meta.js" }
}
~~~

代码通过 `sp:sdk@1` 获取冻结 API：

~~~js
import { createSDK } from 'sp:sdk@1';

export default function setup(plugin, context) {
  const sp = createSDK(plugin, { settings: context.settings, log: context.log });
  sp.kits.register('my-kit', (definition) => ({
    install(battle, unit) {
      sp.kit.statBuff(battle, unit, 'my-buff', { atk: 10 });
    }
  }));
}
~~~

当前 SDK 成员：`constants`、`content.register`、`dir`、`enemies.register`、`kit`、`kits.register`、`log`、`math`、`meta.register`、`settings`、`targeting`。脚本环境没有 DOM、网络、文件系统、随机数、时钟或隐式全局状态。记录是冻结副本；不要修改回调参数或跨回合保存引擎对象。`log` 每次 setup 最多 20 行并会截断。权限缺失会抛出 `PLUGIN_PERMISSION_MISSING`。

## 8. 打包、检查和测试

~~~powershell
Copy-Item -Recurse plugins/_template/cosmetic plugins/my-theme
# 编辑 plugin.json 和资源
node tools/plugin.mjs check plugins/my-theme --strict
node tools/plugin.mjs pack plugins/my-theme
~~~

常用命令：

~~~powershell
node tools/plugin.mjs list
node tools/plugin.mjs check plugins/my-theme --strict --json
node tools/plugin.mjs pack plugins/my-theme --zip --out dist
node tools/plugin.mjs test my-theme
node tools/plugin.mjs errors --markdown
node tools/plugin.mjs surface --write
~~~

`pack` 会检查清单和文件、计算 SHA-256、记录 Spine 元数据并写入 `plugin.lock.json`。锁文件过期时重新执行 `pack`。发布前至少运行：

~~~powershell
node tools/plugin.mjs check plugins/my-theme --strict
npm run check:imports
npm run lint
npm test
~~~

## 9. 安装和部署

本地安装：

~~~powershell
node tools/plugin.mjs install .\dist\my-theme.zip
~~~

远程安装必须使用 HTTPS 并校验 SHA-256：

~~~powershell
node tools/plugin.mjs install https://example.invalid/my-theme.zip --sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
~~~

服务器会扫描插件目录并生成索引。缺插件、版本不符、依赖冲突、权限不匹配或锁文件哈希不一致时，房间拒绝该组合。公网服务器默认不允许 `trusted` 和受信任脚本；代码插件必须由服主开启、固定并在隔离服务器先验证。

## 10. 排错原则

- 先运行 `check --strict --json`，根据 `path`、`need`、`detail` 修复问题。
- “已安装但房间不可用”依次检查应用版本、API、依赖、冲突、scope、权限、锁文件、内容身份和玩家是否加载完成。
- UI 插件只依赖允许的 `welcome/state/battle/result/net` 字段，永远不要假设字段存在。
- 外观资源按需加载，避免首屏预载大文件；音频和图片尽量压缩。
- 内容插件失败时让服务器拒绝整组组合，不要在运行时偷偷修改官方数据。

若本文与 [PLUGIN-API.md](PLUGIN-API.md)、验证器输出或 `shared/plugins/*` 实现不一致，以验证器和代码中的闭合集合为准。
