# 水月原界面动效：来源与接入边界

日期：2026-10-27。仅水月模块使用，不更改其他模式的资源清单、缓存或渲染器。

## 可复现原资源

- `tools/export-mizuki-ui-motion.py` 从已有客户端原始解包树保存 56 AnimationClip、76 Animation、6 Animator、4 AnimatorController，以及 9 个原界面预设的层级绑定。64 位对象 ID 使用字符串；无穷斜率保留 step 语义，未自写关键帧或时长。
- `tools/export-mizuki-ui-fx.py` 直接读取本机客户端两个原 UI 包，导出 34 个根、191 ParticleSystem、65 纹理、13 网格。
- `tools/audit-mizuki-ui-fx.py` 独立按原 GameObject/Transform 父链审计：rogue_2 包 84/84，common roguelike 包 107/107，未覆盖粒子为 0。这仅指这两个包，不代表游戏全部资源。
- 最初仅扫描 effect 文件夹漏掉了骰子、路线节点、普通奖励等 5 个内嵌粒子根；已经补齐。普通局内奖励仍在范围内；不接入月度任务或月度奖励。
- `tools/export-mizuki-node-types.py` 直接解析客户端 IL2CPP 元数据压缩常量，输出原 `Torappu.RoguelikeEventType` 的符号、数值、原编码和源 SHA-256，避免按字段顺序猜枚举。

输出：`public/assets/mizuki/native-ui-motion/`。manifest 保存每个原动画的 raw 副本与原/portable SHA，nodeViewData 保存原粒子类型映射和颜色，effectBindings 保存原组件字段、完整界面层级与目标预设。

## 路线粒子不能用空占位代替

`dungeon_node/panel_widgets/panel_particle` 原占位 PS 没有发射模块，renderer 默认关闭。客户端 `RoguelikeDungeonNodeView::RenderParticles`（0x181f9ed20）调用 `RoguelikeNodeViewData::GetParticlePrefab`（0x181f8ddc0），按节点类型实例化并缓存真正的 nodeeffect。`anim_selectable_node` 0.2 秒的 `AnimationEventOnPlayParticle` 针对这个运行时实例。不能强开占位或凭空补 emission。原调用链记录在 `.cache/mizuki-native-rules/ui-route-particles.txt`。

`ui_rogue_shuiyue_01` 原挂载是 `topic_entry/anim_effect/effect_back`；`button_01` 是首页新游戏/继续按钮。二者不能因名字相近就当作策略或路线背景。`_02` 未找到足够的直接挂载证据时保持未绑定。

## 原连接线参数的真实含义

原 `Torappu/UI/Roguelike/Connector` Shader 位于 rogue_2 包，原对象 pathID `-7130826079755031734`。对其压缩程序解包并调用系统 D3DDisassemble，得到 6 个原程序的指令，记录在 `.cache/mizuki-native-rules/ui-connector-shader-disasm.txt`；原网格代码见 `ui-connector-mesh.txt`。

`RoguelikeConnector::OnPopulateMesh`（0x181fb5410）计算 `xMin + width * _clipRatio`，转为 Canvas 局部坐标后写入 UV1.x；UV1.y 为 `_useClipColor`，TANGENT 为 `_clipColor`。顶点程序在 useClipColor>=1 时选替代颜色；像素程序按 `localX >= threshold` 选择正常色，否则替代色，再乘原纹理，alpha clip 变体阈值为 0.001。

因此 anim_connector 的 -1→0→1 是颜色分界移动，不能当成普通 0→1 长度裁切或缩放连接线。

## 验收限制

导出原曲线、PS、网格和材质不等于浏览器自动复现所有 Unity Shader/Animator 行为。必须分别验证实际 draw、活粒子、真实事件链、单次/循环和卸载。wrapMode=0 不推断成循环。战斗单次 FX 不进重连持续效果快照；持续 FX 按原 Buff/状态的开始和结束维护。
