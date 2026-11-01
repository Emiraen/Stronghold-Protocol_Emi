# 水月肉鸽模式前端样式文件清单

更新时间：2026-10-28

工程根目录：

```text
D:\Stronghold-Protocol_Emi-master.backup-before-unity-20261026-093704\.unity-migration\original-before-unity-20261026
```

本清单覆盖水月模式专属样式，以及当前作战界面实际复用的卫戍协议共享样式。表中路径均相对于工程根目录；文件链接可从本文直接打开。

## 1. 模式专属样式

| 文件 | 用途 | 加载方式 |
| --- | --- | --- |
| [public/css/mizuki.css](../public/css/mizuki.css) | 水月页面框架、资源栏、分队、盟约策略、招募、路线节点及连线、事件、编队名片、技能与模组、装备和结算 | `public/js/screens/mizuki.js` 挂载时动态加载，卸载时移除 |

### mizuki.css 内部分区

以下行号对应本清单生成时的源码，后续修改可能使行号移动。

| 起始行 | 内容 | 主要选择器 |
| --- | --- | --- |
| 1 | 模式基础布局、资源栏、页面组件与响应式样式 | `.mz-screen`、`.mz-header`、`.mz-resources` |
| 24 | 水月作战界面的模式局部覆盖 | `.gm--mizuki-native`、`.mz-native-actions` |
| 30 | 路线地图、节点、连线及状态 | `.mz-native-map`、`.mz-map-node`、`.mz-native-connector__base`、`.mz-native-connector__fill` |
| 34 | 官方分队、策略和初始招募界面 | `.mz-native-selection`、`.mz-init-card` |
| 38 | 拓扑导入、历史档案等样式及探索布局覆盖；部分规则已无当前渲染入口 | `.mz-dungeon-import`、`.mz-stage-archive`、`.mz-exploration` |
| 49 | 编队名片、立绘、星级、精英图标、技能、模组、装备及移动端布局 | `.mz-native-roster-modal`、`.mz-native-roster-card`、`.mz-native-loadout-option`、`.mz-native-gear-slot` |
| 153 | 节点官方图标、名称条及最终样式覆盖 | `.mz-map-node__icon`、`.mz-map-node__tag`、`.mz-map-node__type-name` |

## 2. 实际复用的共享样式

以下文件通过 `public/index.html` 全局加载。它们同时服务其他模式；水月局部调整应优先使用 `mizuki.css` 中的模式限定选择器。

| 文件 | 水月模式中的用途 | 代表性选择器或依赖 |
| --- | --- | --- |
| [public/css/screens/game.css](../public/css/screens/game.css) | 作战框架、战场容器、顶部状态栏、队友栏、战斗 HUD、盟约条与设置 | `.gm`、`.gm__field`、`.gtop`、`.team`、`.chud`、`.bstrip` |
| [public/css/screens/game-panels.css](../public/css/screens/game-panels.css) | 干员详情、盟约详情、头像缩略图、部署朝向轮 | `.dpanel`、`.bpop`、`.uthumb`、`.fwheel` |
| [public/css/east-match-legacy.css](../public/css/east-match-legacy.css) | 对局按钮、聊天和弹窗的样式覆盖 | `NativeMizukiBattle` 主动启用 `body.east-match-legacy` |
| [public/css/east-floating-panels.css](../public/css/east-floating-panels.css) | 干员与盟约浮动详情面板的层级、滚动 | `.east-floating-panel`、`.dpanel__scroll`、`.bpop__scroll` |
| [public/css/east-battle.css](../public/css/east-battle.css) | 多人队友列表与玩家身份的局部布局 | `.gm .team.team--multi`、`.team__identity`；不代表其中商店规则也被水月使用 |
| [public/css/east-match-mobile-fixes.css](../public/css/east-match-mobile-fixes.css) | 移动作战布局、盟约栏滚动、触控范围和角落按钮布局 | `.gm__bonds .bstrip`、`.sp-coarse .gm`、`.gm .gm__corner` |
| [public/css/devices.css](../public/css/devices.css) | 横竖屏、安全区、触屏和 HUD 设备适配 | `.gm__hud`、`.gm__field canvas`、`.sp-coarse` |
| [public/css/utility-mobile.css](../public/css/utility-mobile.css) | 设置和通用工具弹窗的移动端适配 | `.settings-modal .set-row`、`.modal--utility` |
| [public/css/east-enhancements.css](../public/css/east-enhancements.css) | 打开作战设置时使用的设置弹窗样式 | `.east-settings`；实际 `SettingsModal` 带有此类 |
| [public/css/screens/chat.css](../public/css/screens/chat.css) | 对局聊天面板；有聊天频道且允许聊天时使用 | `.sp-chat--match` |
| [public/css/components.css](../public/css/components.css) | 通用按钮、弹窗、标签、盟约圆标和提示 | `.btn`、`.bond`、`.modal`、`.sp-overlay-layer` |
| [public/css/east-ui-polish.css](../public/css/east-ui-polish.css) | 通用按钮和弹层层级补充；部分样式受后加载文件覆盖 | `.sp-overlay-layer--game-panel`、`.sp-overlay-layer--modal` |
| [public/css/theme.css](../public/css/theme.css) | 全局颜色、字体尺寸、基础变量和页面基础样式 | 页面及共享组件的 CSS 变量 |
| [public/fonts/fonts.css](../public/fonts/fonts.css) | 本地字体定义 | 本地字体的 `@font-face` |

## 3. 样式与页面入口

这些是关联源码，不属于 CSS 文件。

| 文件 | 作用 |
| --- | --- |
| [public/index.html](../public/index.html) | 共享 CSS 的加载入口和加载顺序 |
| [public/js/screens/mizuki.js](../public/js/screens/mizuki.js) | 水月页面结构、内联样式和动态 CSS 变量；加载与卸载 `mizuki.css` |
| [public/js/screens/mizukiBattle.js](../public/js/screens/mizukiBattle.js) | 复用卫戍作战组件，挂载 `.gm--mizuki-native`，启用 `east-match-legacy` |
| [public/js/mizukiConnector.js](../public/js/mizukiConnector.js) | 路线连线的 SVG 几何、原始线宽和进度表现 |
| [public/js/mizukiUiMotion.js](../public/js/mizukiUiMotion.js) | 解包 UI 动画曲线的播放与内联属性更新 |
| [public/js/mizukiRouteFx.js](../public/js/mizukiRouteFx.js) | 路线节点官方粒子效果的衔接 |

## 4. 与样式关联的官方资源

以下资源目录由页面与渲染代码读取，不是 CSS 文件。

- `public/assets/mizuki/native-ui-route/`：节点官方图标、名称条、颜色及映射清单。
- `public/assets/mizuki/native-ui-motion/`：官方 UI 动画、节点 prefab、连线配置与效果数据。
- `public/assets/mizuki/library/manifest.json`：模式资源索引。
- `public/assets/mizuki/native-ui-layout.json`：官方 UI 布局与资源映射。
- `public/assets/mizuki/theme/`：模式背景资源。

## 5. 范围说明

- 当前共有 **1 个模式专属 CSS 文件、14 个实际复用的共享样式或字体文件**。
- 备战席、棋盘、棋子、红蓝门和地图主体通过 Canvas／渲染器绘制，没有独立的 `bench.css`；调整这些内容需要查看渲染代码及资源。
- `public/css/screens/game-shop.css` 虽然全局加载，但水月作战不挂载局内商店，不列为水月主要样式依赖。
- `public/css/east-mobile-game.css` 当前没有加载入口，不列为已生效依赖。
- 大厅、房间、排位、其他模式专属页面文件不因全局加载而自动归入本模式清单。
- Mock 顶部验收工具栏的内联样式位于 `.cache/mizuki-native-rules/mock-route-preview.mjs`，仅供预览，不属于正式游戏 UI。
