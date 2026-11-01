# 资源解包与整理工具说明

整理日期：2026-10-26。项目：`D:\Stronghold-Protocol_Emi-master`。

本文整理当前项目已有的资源工具，重点是明日方舟客户端解包，以及后续 Unity 复现能复用的产物。命令根据现有源码整理；本次没有执行解包、下载、安装依赖、打包或全库测试，也没有修改服务器。

## 1. 先选哪个工具

| 目标 | 入口 | 说明 |
|---|---|---|
| 从本地明日方舟客户端提取资源 | `tools/local-extract/extract.py` | 主要入口；按已配置任务提取，不是全客户端通用导出器 |
| 查看本地解包任务清单 | `extract.py --print-jobs` | 打印 JSON；不解包，不需要 UnityPy |
| 补充缺失的历史赛季场景包 | `tools/local-extract/fetch_scenes.py` | 读取官方历史更新清单并下载对应包；有联网和 MD5 行为 |
| 下载、整理现有网页客户端的素材 | `tools/fetch-assets.mjs` | 从配置的社区资源源获取素材，处理 Spine、字体和资源清单；不是本地客户端解包 |
| 准备网页渲染依赖 | `tools/vendor.mjs` | 整理 Preact、Pixi、Spine、Three 等网页库；不是游戏素材工具 |
| 打包当前网页项目或资源包 | `tools/package.mjs` | 现有发行打包流程；不是 Unity 工程导出器 |
| 查看项目资源包索引 | `tools/packs.mjs list --json` | 读取项目包注册信息；不是官方客户端资源目录扫描器 |

完整路径均以本项目根目录为基准。主入口：[extract.py](D:/Stronghold-Protocol_Emi-master/tools/local-extract/extract.py)。

## 2. 本地解包覆盖范围

现有入口使用 UnityPy 读取 AssetBundle，并通过 `aklz4.py` 处理已适配的 LZ4AK 压缩。它按任务表和 ID 列表工作，覆盖范围不是“客户端所有对象”。

| 资源 | 当前实现 | 主要输出 |
|---|---|---|
| 卫戍协议 UI、表情、帮助页、弹道图片 | 提取配置资源包中的 Sprite / Texture2D | PNG，部分生成 WebP |
| 棋盘、地形、场景装饰 | 提取贴图、材质参数、配置的网格及摆放信息 | PNG / WebP、OBJ、JSON |
| 特定敌人的战斗模型 | 按 `ENEMY_SPINES` 列表提取；不是所有敌人 | `.skel`、`.atlas`、图集 PNG |
| 特定召唤物战斗模型 | 按 `TOKEN_SPINES` 列表提取；不是所有召唤物 | `.skel`、`.atlas`、图集 PNG |
| 插件引用的官方干员美术 | 根据当前安装的插件引用发现干员，提取头像、立绘、默认正背面模型 | PNG、Spine 文件及清单映射 |
| 已配置的官方战场场景 | 读取本地或额外提供的历史场景包及依赖 | `scene.json`、`scene.bin`、光照和场景贴图 |
| 当前模式单位引用的战斗特效 | 必须显式指定 `--only fx`；默认只取样例集合 | 特效描述 JSON、WebP、网格 JSON |

敌人、召唤物、场景范围以任务表为准。插件美术不等于全部干员皮肤导出；普通解包也不等于导出全部音乐、语音和字体。

## 3. 环境准备

Node.js 版本要求以当前项目 `package.json` 为准：`>=22`。Python 依赖见 [requirements.txt](D:/Stronghold-Protocol_Emi-master/tools/local-extract/requirements.txt)：`UnityPy>=1.25`、`lz4>=4`、`Pillow>=10`。插件引用发现和部分 Spine 元数据处理还会调用 Node.js。

PowerShell 示例：

```powershell
$Root = 'D:\Stronghold-Protocol_Emi-master'
Set-Location -LiteralPath $Root

# 已有可用解包环境时直接复用，无须重复安装。
python -m venv "$Root\.venv-extract"
$Py = "$Root\.venv-extract\Scripts\python.exe"
& $Py -m pip install -r "$Root\tools\local-extract\requirements.txt"
```

安装依赖需要网络。上面的命令是使用说明，本次整理没有执行。

`--game` 应指向 **AssetBundle 根目录**，不是启动器 EXE，也不是 APK / ZIP 文件。Windows 常见目录形态：

```text
C:\Program Files\Hypergryph Launcher\games\Arknights\Arknights_Data\StreamingAssets\AB\Windows
```

该路径只是源码支持的候选之一，不代表已经确认你的客户端安装在此处。非默认位置应显式传入 `--game`。

## 4. 推荐：先导出到独立目录

避免首次提取就覆盖现有资源和清单。以下命令延续上一节的 `$Root`、`$Py`：

```powershell
$Game = 'C:\Program Files\Hypergryph Launcher\games\Arknights\Arknights_Data\StreamingAssets\AB\Windows'
$Stage = "$Root\.tmp-resource-export\20261026"
$Out = "$Stage\assets"
$Manifest = "$Stage\local-assets.json"

# 换成已确认存在的客户端目录，再运行提取。
# 独立目录应是新目录；不要指向现有客户端资源目录。
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

# 只查看配置任务；不解包，不生成资源。
& $Py "$Root\tools\local-extract\extract.py" --print-jobs
```

### 4.1 按类别提取

```powershell
# 战斗表情
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only emoticon

# 配置列表内的敌人、召唤物模型；--only 可重复。
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only spine/enemy --only spine/token

# 当前安装插件引用的官方干员头像、立绘和默认 Spine
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only plugin-art --plugin-root $Root

# 配置表内的官方场景
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only scene
```

其他 `--only` 值应从 `--print-jobs` 输出的 `sub` 字段选择，不要把任意资源名当作任务名。

### 4.2 战斗特效

```powershell
# 样例集合；默认 --fx-set 就是 sample。
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only fx --fx-set sample --fx-jobs 2

# 当前模式单位引用的特效；不是客户端全部特效。
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only fx --fx-set used --fx-jobs 2

# 指定特效键；名称来自现有任务或特效引用。
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only fx --fx-keys common_hit_01,buff_stun --fx-jobs 2
```

`--fx-jobs 2` 只限制提取进程数，不限制总资源量或哈希次数。特效导出内部有 SHA-1，用于资源去重 / 标识；需要继续遵守“仅少量哈希”的限制，不能把 `used` 默认当作小任务。

### 4.3 普通任务与 WebP 转换

```powershell
# 普通任务集合：未显式开启 fx，也未开启插件美术。
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest

# 普通任务集合，同时包含当前插件引用的官方干员美术。
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --plugin-art --plugin-root $Root

# 已有指定 PNG 的 WebP 转换；需要 Pillow，不需要游戏客户端。
& $Py "$Root\tools\local-extract\extract.py" --out $Out --manifest $Manifest --webp
```

注意：`--webp` 只处理工具配置的棋盘贴图和帮助页，不是递归转换全部 PNG。

## 5. 参数与写入边界

| 参数 | 实际作用 |
|---|---|
| `--game <目录>` | 指定客户端 AB 根目录；省略时只搜索源码中的候选位置 |
| `--out <目录>` | 指定输出文件根目录；默认是项目的 `public/assets/local` |
| `--manifest <文件>` | 指定普通本地资源清单；默认是项目的 `data/local-assets.json` |
| `--only <前缀>` | 按已配置输出类别筛选任务，可重复；不是任意 AB 文件过滤器 |
| `--plugin-root <目录>` | 提供插件引用发现所需的项目安装目录 |
| `--plugin-art` | 普通任务运行时额外开启插件引用的官方干员美术 |
| `--scenes <目录>` | 提供额外场景 AB 根目录，可重复；目录应保留包内相对路径 |
| `--fx-set sample/used` | 选择特效样例或当前模式引用集合，配合 `--only fx` |
| `--fx-keys <键列表>` | 逗号分隔的特效键，配合 `--only fx` |
| `--fx-jobs <数量>` | 特效并行进程数，默认由实现选择、最高默认使用 8 个 |
| `--print-jobs` | 打印配置任务后退出 |
| `--webp` | 转换已提取的指定 PNG 后退出 |

提取读取客户端资源，但会写入 `--out` 和清单。重复提取可能覆盖同名产物；没有通用的“永不覆盖”开关。带 `--only` 时保留其他类别，普通运行的清单合并规则不同，不能把普通运行当作无条件增量安装。

**独立目录只隔离物理文件，不自动改成 Unity 路径。**导出的资源引用仍可能保留 `/assets/local/...` 这类网页虚拟路径，需要后续映射。`--manifest` 的父目录应先创建；特效清单会以 `local-fx.json` 为名写在它旁边。

## 6. 历史场景补齐工具

入口：[fetch_scenes.py](D:/Stronghold-Protocol_Emi-master/tools/local-extract/fetch_scenes.py)。当前源码默认历史版本为 `26-04-13-12-31-42_e9b560`，默认平台 `Android`，默认输出至项目 `.cache/official-scenes/<版本>`。这是脚本配置，不是“最新客户端版本”，也未在本次确认远端仍可下载。

```powershell
# 只读取远端更新清单、列出目标包；不会下载场景包。仍然需要联网。
& $Py "$Root\tools\local-extract\fetch_scenes.py" --list

# 下载指定历史版本的场景与依赖；会执行 MD5。
$SceneRoot = "$Stage\scene-bundles"
& $Py "$Root\tools\local-extract\fetch_scenes.py" --version 26-04-13-12-31-42_e9b560 --platform Android --out $SceneRoot --with-deps

# 从额外场景目录导出；现有 extract.py 仍要求 --game 目录存在。
& $Py "$Root\tools\local-extract\extract.py" --game $Game --out $Out --manifest $Manifest --only scene --scenes $SceneRoot
```

此工具当前请求的是源码配置的**官方资源 CDN**，不是此前网页预载使用的 CDN；没有直连备选参数，也没有 `--no-hash` 参数。受限时不要未经确认直接执行下载；本文没有更改它的地址或校验逻辑。

## 7. 辅助模块：由主入口调用

这些文件不是独立的“全资源导出命令”：

| 模块 | 职责 |
|---|---|
| `tools/local-extract/aklz4.py` | 向 UnityPy 注册已适配的 LZ4AK 解压逻辑 |
| `tools/local-extract/scenes.py` | 场景任务表、几何、贴图、光照和材质参数导出 |
| `tools/local-extract/fx.py` | 特效依赖、粒子和动画描述、贴图、网格及索引导出 |
| `tools/local-extract/operators.py` | 发现插件引用的官方干员，提取图片和默认战斗模型 |
| `tools/local-extract/plugin-art.mjs` | 仓库自有桥接：插件美术引用发现 / Spine 元数据；不执行插件脚本 |
| `tools/local-extract/plugin-fx.mjs` | 仓库自有桥接：读取插件特效引用 |
| `tools/assets/skel.mjs`、`anim-roles.mjs` | 骨骼元数据解析，以及 idle / attack / skill 等动画角色映射 |
| `tools/assets/atlas.mjs`、`spine.mjs` | 图集与模型整理、本地模型元数据处理 |
| `tools/assets/plan.mjs`、`sources.mjs`、`downloader.mjs` | 网页素材任务计划、来源与下载 |
| `tools/assets/manifest.mjs` | 网页资源清单、内容标识与条目整理 |

## 8. 网页资源整理与打包

以下工具服务当前网页版本。仅为使用参考，本次未运行。

```powershell
# 查看网页素材获取计划，不执行实际素材下载。
node "$Root\tools\fetch-assets.mjs" --dry-run

# 联网获取并整理网页资源，会写资源、缓存和清单。
node "$Root\tools\fetch-assets.mjs" --concurrency=4

# 离线整理已有资源；不联网，但并非只读，会重建清单和后处理。
node "$Root\tools\fetch-assets.mjs" --offline

# 在明确需要更新本地敌人 Spine 元数据时使用，不是日常必跑。
node "$Root\tools\fetch-assets.mjs" --offline --local-spines

# 查看现有资源包注册信息
node "$Root\tools\packs.mjs" list --json
```

`--dry-run` 只表示不执行实际素材下载，不应当把整个脚本当作绝对只读或绝对不联网的工具。`--force` 会重下，`--prune` 会删除未引用的非本地资源，`--allow-shrink` 允许缩减清单；需要保留现有资源时不建议开启这些参数。离线模式也不等于不计算哈希。

`tools/vendor.mjs` 将网页依赖准备到 `public/vendor`；`tools/build-data.mjs` 生成游戏数据，不是资源解包步骤，单纯整理素材不必运行。

`tools/package.mjs` 支持完整发行、精简发行、更新与资源包模式（`--full`、`--lite`、`--update --from`、`--assets`），会执行既有打包检查；其 `--dry-run` 也会做检查，不适合作为本次少量检查要求下的默认步骤。`tools/package-art.mjs` 是其资源清单规划 / 导入辅助模块，不是单独的 CLI。以上均不能直接生成 Unity 工程或 Unity APK。

## 9. 产物与 Unity 复现的对应关系

| 产物 | 在 Unity 中的用途 / 限制 |
|---|---|
| PNG、音频等现有素材 | 可作为导入来源，仍需设置透明度、尺寸、压缩、采样等；本解包入口不保证全部类型覆盖 |
| `.skel` + `.atlas` + 图集页 | Spine 素材；运行库版本、图集路径、PMA 和混合方式需要适配；当前项目曾取样到 3.8.99，不代表所有模型同版 |
| OBJ + 材质 / 摆放 JSON | 网格和重建摆放的输入；不是完整可直接运行的 Prefab |
| `scene.json` + `scene.bin` + 光照贴图 | 本项目自定义网页场景格式，需要编写导入 / 转换逻辑；不是 Unity `.unity` 场景文件 |
| 特效描述 JSON + WebP + 网格 JSON | 用于重建粒子、动画和材质行为；不是已恢复的 Unity 特效工程 |
| 材质参数、Shader 名称和渲染状态 | 只是重建线索，不能据此认定完整 Shader 源码和脚本行为均已还原 |
| `data/assets.json`、`local-assets.json`、`local-fx.json` | 资源映射与覆盖范围依据；不是玩法实现，也不自动变成 Unity Addressables |

现有工具主要面向网页客户端做资源转换，其中包含坐标转换、透明通道合并、纹理转换等处理。Unity 复现应保留原 AB 副本和导出清单，区分原始数据与网页转换产物；不可将网页坐标再次当作 Unity 原坐标直接使用。

**边界：能提取现有客户端和补充包中、工具已覆盖的资源；不能据此保证所有资源齐全，也不能恢复完整官方工程。**自定义湮灭素材、mod 和现有游戏规则仍以本项目为来源，不会由官方解包自动补齐。

## 10. 本次范围与后续使用顺序

1. 先用 `--print-jobs` 确认当前工具覆盖的类别，再确认客户端 AB 根目录。
2. 只选需要的类别，输出到独立目录，保持原客户端与现有资源不变。
3. 缺历史场景时再考虑补包；涉及下载和较多哈希的任务单独决定。
4. Unity 迁移先处理一套棋盘、一个干员模型和一段特效，不默认启动全资源提取。
5. 需要接入现有网页资源时，另行制定备份与清单合并步骤；本说明不自动安装或部署任何产物。

本次只新增本文档；没有执行上述示例命令，没有额外哈希，没有启动测试，也没有接触游戏服务器进程。更详细的网页资源规范见 [ASSETS.md](D:/Stronghold-Protocol_Emi-master/docs/ASSETS.md)。
