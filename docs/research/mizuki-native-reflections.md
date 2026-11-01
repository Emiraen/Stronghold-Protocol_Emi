# 水月原场景反射与主光

2026-10-27。从已安装客户端的 60 对原 scene／lightingdata bundle 增量提取到独立 public/assets/mizuki/native-reflections。tools/export-mizuki-native-reflections.py 只读取 native-maps 的场景来源清单，不写地图目录，也不重写此前保留的 74,164 个原始地图对象。

## 完整原资源

manifest.complete=true，覆盖 60 场景和 97 stage alias；60 个原 RenderSettings 默认反射，加 59 个原 ReflectionProbe，共 119 个 Cubemap。level_rogue2_b-8 原场景没有 ReflectionProbe，使用它自己的 RenderSettings 默认反射，没有补造 Probe 或强度。

本机这 119 个原 Cubemap 均为 DXT5 RGBM、128×128、六个面、八级 mip，m_MipsStripped=0。128 是原资产的尺寸，不是浏览器降采样。每个完整编码 payload 为 131,232 bytes，保留面序 +X、-X、+Y、-Y、+Z、-Z 及面内全部 mip 链；总计 5,712 个 face/mip 单元，未只取 mip 0。

每个 cubemaps[key] 保留原 CAB、pathId、bundle SHA256、完整 payload、原 serialized object、原 typetree 以及无损 RGBA PNG 图集。图集 mip 行的 y 为此前各 mip 边长之和；面 f 在当前 mip 的 x=f×mipSize，保持原上传顺序、flip=false。完整 payload 和原 RGBA 图集可供以后直接使用原压缩纹理或重新核对解码，不以浏览器派生图替代原件。

消费环境 PNG 沿用既有 scenes.env_atlas 的 gamma RGBM5 约定，并补充 Windows DXT5 的精确 16-byte block 长度；没有修改共享 tools/local-extract/scenes.py。PNG 为无损保存，包含全部 mip，不生成会污染图集格边的有损 WebP。每个原场景默认反射与每个原 Probe 的强度分别生成对应 env atlas，不能将一个默认强度套到全部场景。

## 精确引用与场景入口

主清单 /assets/mizuki/native-reflections/manifest.json 提供 scenes、stages、cubemaps、atlases、sourceObjects 与源 bundle 哈希。groups 的 scene/data 和 scene/env 可供水月现有 exact fetch 验证；其余 group 覆盖完整 payload、原对象和元数据。共 1,312 个已登记文件，120 个本机源 bundle，missing/warnings 为空。

每个 scene 文件包含：

- reflections.probes：全部原 Probe tree、原 PPtr 字段和 owner、实际解析的 Cubemap identity、原 intensity、importance、blendDistance、boxProjection、box 与完整局部／世界 Transform。
- reflections.default：RenderSettings.m_DefaultReflectionMode 实际选定的 m_GeneratedSkyboxReflection 或 m_CustomReflection，以及原 m_ReflectionIntensity。
- renderSettings：原树、m_Sun 指针和原 serialized 对象；没有用预设 Sun 代替原证据。
- images.env：当前棋盘 Anchor 对应的环境 PNG；env 提供 size、mips、range、source、probeId、atlasKey、cubemapKey 与 intensityAlreadyApplied。
- coordinateBasis：原 Tiles 与 Anchor 的完整 Transform、worldMatrix 和原始对象 identity，供场景坐标变换使用。

便捷 env 的选择点是原 Anchor：只选启用、层级活动、原 box 包含 Anchor 的 Probe，再按 importance 和 box 体积排序；无可选 Probe 时读取原默认反射。全部原 Probe 和默认反射始终保留。单个 env 的便捷入口不等于已经实现 Unity 的逐 renderer 边缘混合，外围物体的 Probe 选择仍应由渲染接入按需要处理。

env PNG 已将原 intensity 写入 RGBM5/range 编码，intensityAlreadyApplied=true；着色器恢复 range 后不能再乘一遍 intensity。原 Cubemap 面轴仍为 Unity world 轴，不能直接把新 board 轴当作原面轴；可使用 coordinateBasis.tiles.worldMatrix 恢复采样方向。

## 主光坐标

60 个场景均只有一个启用且层级活动的原 Directional Light。若 RenderSettings.m_Sun 有指针则以原指针选取；为空时只有这唯一原方向光可选，无需猜默认方向或光强。

light.color、light.intensity 原样来自 m_Color 与 m_Intensity，原树和 Transform 同时保留。light.dir 先取原 Light +Z 的反方向作为向光世界向量，再经 inverse(Tiles.worldMatrix) 转到 Tiles 局部，最后按前端棋盘约定变换为 board=[Tiles.x, -Tiles.y, -Tiles.z] 并归一化。没有把 Unity world 向量直接当作棋盘方向。directionalLights 保留所有原方向光记录与选择证据。

## 验收

.cache/mizuki-preview/graphics-resource-verification-20261027.json 为 graphics-incremental，六个 section 全部通过，0 error、无 deferred：4,849 个独立文件、5,687 次 SHA256 预期、5,360 次 bytes 预期、1,127 个严格 JSON。

其中 native-reflections 全量检查全部 119 个 payload／原对象／元数据／无损 RGBA 图集、119 个消费图集、60 个 scene，以及每个原 PPtr、原强度、5,712 个完整 face/mip 单元、59 个 Probe 和唯一默认反射场景。主光方向以 Tiles→world 的正向变换独立反查原世界向量，颜色和强度与原树逐项一致。

同次增量验收还覆盖地图新增的 204 张原尺寸 PNG 与全部像素指纹、122 张 lightmap/shadowmask 的原 PPtr identity、82 份其他 Texture2D 原身份、红蓝门全部 1,465 个原对象与 280 个放置，以及 41 个共享文件隔离。原地图 74,164 个对象明确 rawObjectsRehashed=0；此前 77k 全量通过报告仍保留，不把增量验收写成重新全扫原对象。
