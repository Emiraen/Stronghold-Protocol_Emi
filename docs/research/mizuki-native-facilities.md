# 水月原客户端设施模型

仅新增水月私有资源 public/assets/mizuki/native-facilities，不修改其他模式的共享地图、装置或画面。

## 净鳞之源的真实来源

trap_038_dsbell 的 MapDependentTrap 原生根 prefab 位于 pkgrps/btl_pfb_tokens_0.ab。它没有模型，按 _defaultSkin 和 _skins 动态加载皮肤：

- 默认 skin_dsbell_default。
- CAVE / WATER_CAVE 指向 skin_dsbell_caven，适用于使用该主题的原关卡。
- 两个动态皮肤真实容器均在 battle/prefabs/skins/trap.ab 的 dyn/battle/prefabs/skins/trap/<skin>.prefab。

它们是原 MeshRenderer 模型，不是 Spine，也不是箱子。共同使用原网格 S_zhong（1433 顶点），洞穴版材质 MT_zhong_caven、贴图 TX_zhong_caven；默认版为 MT_zhong 与 TX_zhong。材质 shader 为 Unlit/Texture，opaque、zWrite=true、cull=Back。原 Mesh 子节点旋转 [-0.5,-0.5,0.5,0.5]、缩放 [0.01,0.01,0.01] 已保留；不能再猜一个替代模型比例或覆盖旋转。

原皮肤 Animator 的 m_Controller 为 null，MeshAnimator._animations 为空。因此本体没有可导出的 Animator clip，不应添加自创摆动或呼吸动画。它的真实状态特效 trap_038_dsbell_buff_01..04 已在水月原 FX 索引 /assets/mizuki/fx/index.json；应按服务端状态继续播放这些效果。

来源 SHA256：

- battle/prefabs/skins/trap.ab: 6c9e211481bd4448cb91604de8bc1fe47cc5d64dc2cdb3814173aaa80a18c5cd
- pkgrps/btl_pfb_tokens_0.ab: 3aa8959610c992071e002c5d71d26e2928856edd62b0fd2de814e4795c12c17e

## 渲染入口

主 manifest 为 /assets/mizuki/native-facilities/manifest.json；FX descriptor 格式入口在 /assets/mizuki/native-facilities/fx/manifest.json、index.json、textures.json。

以 facilities[id].themeSkins[原场景主题] || facilities[id].defaultSkin 得到皮肤名，再读取 facilities[id].skins[皮肤名].path。对净鳞之源，洞穴模型文件为 /assets/mizuki/native-facilities/fx/prefabs/skin_dsbell_caven.json。

保留 descriptor 原节点层级、局部位姿、网格、材质与动画引用；将整体根节点挂载到装置真实格心。不得将 service-side obstacleKind='crate' 解释为所有设施都应显示木箱；障碍语义与原生图形类型是不同数据。

## 其他原生设施

共导出 14 设施根、40 prefab（含已配置动态皮肤）、55 原 mesh、31 原 texture，另有 4 个原生 Spine 模型及其 64 个可播放/来源文件。crate、stone、frosts、farm、ballis、wpnsts 等都保留客户端的默认/主题皮肤表。每个导出文件记录 bytes 和 SHA256，19 个实际加载源 bundle 也记录 SHA256；导出 missing/warnings 均为空。

四个设施 trap_024_npcsld、trap_065_normbox、trap_066_rarebox、trap_068_badbox 原 prefab 明确使用 Spine.Unity.SkeletonAnimation / SingleSpineAnimator，静态 prefab 的 MeshFilter 由骨骼运行时填充，不能把空 MeshFilter 当作缺资源后放置木箱。其 meshAvailable=false，但这四项已经沿原 SkeletonAnimation.skeletonDataAsset 引用实际导出，不再是待补资源。

骨骼入口为主 manifest 的 spines[设施 ID]，facilities[设施 ID].spineKey 指向该条目，graphicPolicy='original-spine'、spineAvailable=true。skel、atlas、textures、pma 和 files 字段供既有水月 Spine 加载器读取；全部位于私有前缀 /assets/mizuki/native-facilities/spines/<设施 ID>/，没有写入共享 library 或 assets.json。

原引用实际容器是 pkgrps/btl_pfb_tokens_0.ab 内 dyn/battle/prefabs/[uc]tokens/<设施 ID>.prefab。四个 SkeletonDataAsset pathId 依次为 5831193156163640919、6687687626814964146、2898786817965304849、7921269057825472878。每个模型同时保留原 SkeletonDataAsset/AtlasAsset、未规范化图集文本及相关 serialized 对象；atlas 只补原纹理尺寸和 PMA 声明，骨骼字节保持原样，PNG 按原材质 MainTex/AlphaTex 合成。

四个 SkeletonAnimation 的原 _animationName 均为 Default，loop=false、timeScale=1；这些原设置与 initialFlipX/initialFlipY 已记入清单。不能根据静态网格为空或文件名来推测动画，也不能给净鳞之源这类无原 clip 的 MeshRenderer 模型附加自创动作。

trap_061_creep 使用原 EmptyAnimator，没有模型，本体应通过原地形/特效呈现，不能补造木箱。本次导出保留原行为数据，不伪称已实现所有 Unity shader 或行为脚本。

## 重现与验证

在项目目录使用稳定的 UnityPy Python 环境运行 tools/export-mizuki-native-facilities.py。它使用完整 client-cab-map.json 解析跨包 PPtr，再调用项目已有 FX Exporter；无需也不会修改客户端。

test/mizuki-native-facilities.test.js 校验真实皮肤选择、源哈希、原本体网格/位姿、材质贴图、无控制器动画的证据、其他设施的原渲染类型，以及所有导出资源的文件大小和 SHA256；本次为 5/5 通过。

tools/verify-mizuki-resources.py 进一步检查四个 Spine 的精确设施绑定、12 个直接加载文件、全部原对象文件，以及内部 FX manifest 中的 192 条完整资源和 31 条 half 贴图记录。2026-10-27 的完整报告 .cache/mizuki-preview/resource-verification-20261027.json 包含本次四个 Spine，未把单一模型的锚点检查当作全包验收。
