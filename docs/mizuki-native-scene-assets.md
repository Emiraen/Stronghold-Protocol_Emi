# 水月模式原场景资源

所有路径、字段和数量仅针对水月模式，不修改其他模式的共享资源导出器。原客户端位于本机 Hypergryph Launcher 安装目录，提取过程中不改客户端文件。

## 重建顺序

在项目根目录执行：

```powershell
python tools/export-mizuki-map-scenes.py
python tools/augment-mizuki-map-lighting.py
python tools/export-mizuki-map-fullres.py
node tools/build-mizuki-map-themes.mjs
python tools/export-mizuki-gates.py
node --test test/mizuki-native-lighting.test.js test/mizuki-map-themes.test.js test/mizuki-native-gates.test.js
```

如果只补元数据，无需重新执行第一步，避免重写 74,164 条已保存的原始 serialized records。第一步会重建 scene/root 描述，所以重建后必须继续运行增补步骤，最后刷新 themes 中的 scene/root SHA。工具通过 UnityPy 支持的 Pillow 路径解码图像，规避本机可选 NumPy 的导入崩溃。

## 地图与光照

`public/assets/mizuki/native-maps/manifest.json` 覆盖 97 个 stageId 和 60 个独立原场景：

- 每个 scene root 的节点拥有 `sourceGameObjectPathId`、`sourceSerializedFile`、`sourceTransformPathId` 和未经简化的 `nativeTransform`。原始 PathID 在 JSON 中以字符串保真保存；调用 UnityPy 的整数索引时转回整数。
- 各 renderer 拥有 `sourceRendererPathId`、原始记录证据 `source` 与完整的 `native` typetree。`native.m_StaticBatchInfo`、`m_StaticBatchRoot`、`m_LightmapIndex`、`m_LightmapTilingOffset` 保留原值。不能在每个静态合批节点重复绘制整张 Combined Mesh。
- 每个 scene 的 `lightmaps` 数组按原 `LightmapSettings.m_Lightmaps` 排序，包含 `textureKey`、`directionalTextureKey`、`shadowMaskKey`。`native` 保留原 PPtr，`textures` 提供精确解析到的 serialized file、PathID、原始 raw SHA、纹理格式/色彩空间以及 PNG 和压缩 mip payload 的路径与 SHA。
- `groups['scene/texture-fullres']` 按原 textureKey 提供全部 204 张原尺寸无损 PNG；其中 122 张属于 lightmap/shadowmask，82 张为其他材质或组件纹理。PNG 从原始客户端解码，不从 WebP、half 或截图放大。`groups['scene/texture-payloads']` 保留各纹理原压缩数据及原 mip 链。
- `texture-sources.json` 保存 Material、MonoBehaviour、LightmapSettings 的原 PPtr 与 textureKey 对应证据；`scene/texture-sources` 保留额外材质纹理的原 Texture2D serialized record。

高质量渲染应优先使用 `scene/texture-fullres`，并使用原 UV1、lightmap ST 与静态合批 submesh 范围。保留完整数据和无损贴图不表示浏览器已经实现原 Unity Shader 的全部效果。

## 原红蓝门

`public/assets/mizuki/native-gates` 由原 `battle/prefabs/effects/tile.ab` 导出：

- 原 `tile_start`、`tile_end`、`tile_flystart`、`tile_end_special` prefab，含粒子、原 mesh、材质和 clip。
- 6 张原尺寸 PNG 位于 `fx/tex/fullres`，通过 manifest 的 `groups['fx/tex-fullres']` 或 texture metadata 的 `fullresFile` 读取；同时保留原压缩 mip payload。
- `placements.json` 直接来自原 scene 的 `Torappu.Battle.Tile._effect`，不是从敌人出生路线推测。实际 280 处引用包括 183 个 `tile_start`、87 个 `tile_end`、10 个 `tile_flystart`。
- 原场景坐标 `(sceneRow, sceneCol)` 到关卡数组的转换是 `gridRow = rows - 1 - sceneRow`，`gridCol = sceneCol`。280 处均与原关卡 tileKey 核验一致。
- `Tile.Start` 调用 `GenerateTileEffect`；该方法先检查 `get_isHidden`，并在传入的 Tile 世界位置调用 `CreateEffect`。普通 `DefaultGameMode.HookTileEffect` 原样返回 key。不要依照怪物当前是否出怪启停门。
- 普通红蓝门的 `ParticleEffect._rotateType = 0`（原 NONE）、`_spawnLocation = 0`、`_useBodyRotation = 0`、`_isLoop = 1`、`_maxLifetime = -1`，不按路线转向。原 UVAnimation 是 2 秒循环，Meshes 有原 FxDelay 0.4 秒。`tile_flystart` 是独立 mesh 动画，约 0.966667 秒循环，不能因没有粒子或 particle stats.looping=false 而移除。
- `CreateEffect` 运行时指定位置覆盖 prefab 作者根位置，因此蓝门作者的 `[-1.293, 0, 0]` 不应额外加到门位；仅实例内清零根位置，保留子层级原变换和根旋转。

反汇编证据：`.cache/mizuki-native-rules/gate-disassembly.txt`、`gate-hooks-disassembly.txt`、`gate-location-disassembly.txt`。主题与 DSbell 皮肤映射的原字段证据位于 `themes.json`。
