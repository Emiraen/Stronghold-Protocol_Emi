# 水月原版逐关 BGM

2026-10-27 导出。范围仅为水月私有 public/assets/mizuki/native-audio；没有修改共享 audio.js、assets.json 或其他模式的音乐。主入口为 /assets/mizuki/native-audio/manifest.json。

## 选择证据

97 个 stageId 通过 data/mizuki/levels/index.json 的 stagesById[stageId].levelId 指向 60 个原关卡。每关读取自己的原 level JSON 顶层 bgmEvent，再查原 audio_data.json 的 bgmBanks 中 battle.ON_GAME_READY.<bgmEvent>；如遇 bankAlias 则保留完整别名链。intro 与 loop 使用该原记录明确指定的资源，而不是根据曲名猜测或为全部关卡套同一首主题曲。

原关卡 JSON 的 SHA256/bytes、/bgmEvent 字段位置及精确 bank 记录均保存在 manifest.levels、manifest.stages 的 evidence 中。原表 JSON pointer 与所选原记录同时保存在 source/bank-evidence.json。全部 60 个原关卡未发现额外 bgm/music 切换字段，因此没有人为补造 Boss 阶段换曲。

原音频表来自与原关卡导入相同的 ArknightsGameData 原始数据镜像：

https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/audio_data.json

本次表原件缓存为 .cache/mizuki-native-audio/audio_data.json，8,205,156 bytes，SHA256 a61c10d77e52560dc564771e8b700b959b47dc8a0844970668e8dea5055c4e53。manifest.audioDataSource 明确记录这是原始数据镜像；未宣称该表 revision 与已安装客户端的 build 完全相同。音频媒体本体均从本机已安装客户端原 AB 提取，每条都验证了 bank asset 对应的精确原 AudioClip container。

## 七个事件

下表计数按 60 个 canonical level，97 个 stage alias 均继承各自 canonical level 的记录。

| bgmEvent | 原资源目录／曲目 stem | 原关卡数 | intro | loop | 原 bank 音量 |
| --- | --- | ---: | --- | --- | ---: |
| rl2normal1 | rogue_2/m_bat_rglk2normal1 | 30 | 有 | 有 | 1.0 |
| rl2normal2 | rogue_2/m_bat_rglk2normal2 | 21 | 有 | 有 | 1.0 |
| rogueboss | act12d6d0/m_bat_rglk0boss | 3 | 有 | 有 | 0.9 |
| rl2boss1 | rogue_2/m_bat_rglk2boss1 | 2 | 有 | 有 | 1.0 |
| rl2boss2 | rogue_2/m_bat_rglk2boss2 | 1 | 有 | 有 | 1.0 |
| rl2boss3 | rogue_2/m_bat_rglk2boss3 | 1 | 有 | 有 | 1.0 |
| rl2shopbattle | rogue_2/m_sys_rglk2shop | 2 | 无 | 有 | 1.0 |

六组 intro/loop 加一段商店战斗 loop，共 13 条可播放音轨。rogueboss 的来源确实是 act12d6d0 的原曲，不能因水月主题目录不同而替换。七个原 bank 的 crossfade=1、delay=0，fadeStyleId=null；这些字段原样保存在各 stage/event 记录中。rogueboss 的 0.9 是原 bank 增益，应与用户自己的音乐音量设置共同生效。

## 音频质量与文件

所有可播放 WAV 均为原采样率 44,100 Hz、双声道、16bit PCM。使用既有本地解包环境的原生 fmod_toolkit，直接从本机 AudioClip 所引用的 FSB 资源解码，没有 MP3 重编码、降采样、改单声道或改变位深。

每条 tracks[URL] 包含 path、SHA256、bytes、sampleRate、channels、bitsPerSample、frames、duration、codec，以及原 AudioClip 的 compressionFormat、container、CAB、pathId、源 bundle SHA256。原 FSB、原 serialized AudioClip 和原 typetree 同时保留；循环依据是音频表明确的 loop 字段，原编码资源可继续用于核对，而不是凭音频时长推测循环段。

交付共 7 个源 bundle、13 条 WAV、53 个可播放/来源文件，183,177,334 bytes。原 installed client build 由 manifest.client 实际记录。全部导出文件与源包均有 SHA256，missing/warnings 为空。

## 接入接口

manifest.stages[stageId] 提供 levelId、bgmEvent、bank、intro（URL 或 null）、loop（URL）、volume、crossfade、delay 和 evidence。manifest.tracks 直接按 URL 索引，避免从文件名重建资源。只需按当前正在观战的水月战场 stageId 选择对应记录，再交给既有音乐通道处理用户音量、静音、解锁和页面可见性。

浏览器实际播放路由由水月专用 controller 与生产 AudioManager 验证；本资源文档不把独立解码验收描述为整局音乐播放已经验收。

## 重现与验收

导出工具为 tools/export-mizuki-native-audio.py，需要 UnityPy、aklz4、fmod_toolkit。当前可用环境为原解包目录 .cache/is3-extract-venv/Scripts/python.exe；工具会复用目标项目稳定环境的 AK 压缩支持，并只向水月私有目录写资源。

test/mizuki-native-audio.test.js 本次 4/4 通过，逐项覆盖全部 97 stage 映射、13 条 WAV 格式、53 个文件的 SHA256/bytes、7 个本机源包，以及音频表完整来源证据；ESLint 0。

tools/verify-mizuki-resources.py 已纳入音频，--only-audio 可增量检查而不重扫此前完整通过的 74,164 个地图原始对象。本次 .cache/mizuki-preview/audio-resource-verification-20261027.json 为 passed：122 个独立文件、174 次 SHA 预期、167 次 bytes 预期、77 个严格 JSON，错误为 0。报告 auditScope='audio-only'，不会伪称本次再次全扫地图。

另以全新独立 headless Chrome 155.0.8059.85、独立临时本地 HTTP 测试页逐条 fetch → WebAudio.decodeAudioData，13/13 音轨全部通过。使用原采样率的 OfflineAudioContext，解码后的采样率、声道、精确帧数和时长全部与清单一致，时长差均为 0，页面错误为 0。报告为 .cache/mizuki-preview/audio-browser-verification-20261027.json；没有连接或复用前端代理的浏览器会话，也没有操作用户 GUI。
