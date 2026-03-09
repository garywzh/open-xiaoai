# Open-XiaoAI x OpenClaw 开发计划

## 里程碑

### M1：桥接骨架

- [ ] 复制 `examples/migpt` 的 Rust + Neon 服务端骨架到本目录
- [ ] 将 MiGPT 依赖替换为 OpenClaw 客户端封装
- [ ] 增加本目录独立的 `package.json` / `Cargo.toml` / `tsconfig.json`

验收标准：

- `pnpm dev` 能启动服务端并监听 `0.0.0.0:4399`
- 小爱音箱能连接到本服务端

### M2：文本桥接 MVP

- [x] 监听 `instruction` 事件并提取最终识别文本
- [x] 调用 OpenClaw Chat Completions HTTP 端点
- [x] 用小爱原生 TTS 播放文本回复
- [x] 增加本地调试入口 `/api/debug/text`

验收标准：

- 对小爱说“今天天气怎么样”
- OpenClaw 返回文本后，小爱播报结果

### M3：播放音频能力

- [x] 增加 `playUrl()` 封装
- [x] 支持把 OpenClaw 返回的 `play_url` / `play_file` 动作映射成音箱播放
- [x] 提供局域网音频 URL 调试脚本 / 文档

验收标准：

- OpenClaw 返回一个局域网 MP3 URL
- 小爱能开始播放该音频

### M4：米家控制回退

- [x] 增加家居命令路由器
- [x] 对典型控制短语调用 `askXiaoAI()`
- [x] 增加可配置规则（关键词 + 正则）

验收标准：

- “打开客厅灯”不走 OpenClaw 对话文本播报
- 命令会回退给小爱原生执行

### M5：OpenClaw Skill 集成

- [ ] 设计 `xiaoai_bridge` Skill
- [ ] Skill 通过本机 API 调用桥接服务动作
- [ ] 验证 OpenClaw 主动触发播报 / 播放 / 家居回退

验收标准：

- 在 OpenClaw 对话中可主动调用 Skill 让小爱播放指定音频

### M6：媒体库服务 + OpenClaw Plugin

- [ ] 将媒体能力从 gateway 中拆出为独立 media-library-service
- [ ] 将下载链路统一落到媒体资产目录，并由媒体服务对外提供可播放 URL
- [ ] 为 OpenClaw 插件增加媒体库工具（match / ensure / list）
- [ ] 验证 agent 能先查缓存，再下载，再调用 gateway 播放 URL

验收标准：

- 对 agent 说“播放许嵩的素颜”时，能先查本地媒体库
- 未命中时可在拿到外部来源后下载为 MP3 并写入媒体库
- 下载完成后返回的媒体 URL 能直接交给 gateway 播放

### M7：Home Assistant（可选）

- [ ] 评估 OpenClaw 对接 HA 的方式
- [ ] 对复杂自动化场景优先走 HA，而不是原生小爱

验收标准：

- 至少一个复杂自动化场景可经 OpenClaw → HA 执行成功

## 当前推荐实现顺序

1. `M1`
2. `M2`
3. `M4`
4. `M3`
5. `M5`
6. `M6`
7. `M7`

说明：

- `M4` 提前于 `M3`，因为“保住米家控制”比“播 MP3”更关键。
- `M5` 放后面，是因为 Skill 更适合在桥接服务 API 稳定后接入。
- `M6` 单独抽出，是因为媒体资源管理和设备控制应该解耦。

## 初版配置项建议

建议后续新增 `config.ts`，包含：

- `server.port`
- `openclaw.baseURL`
- `openclaw.token`
- `openclaw.agentId`
- `router.homeKeywords`
- `router.mediaKeywords`
- `speaker.ttsBlocking`
- `speaker.defaultPlayTimeout`

## 初版测试清单

- [ ] 音箱连接成功
- [ ] 能收到最终识别文本
- [ ] OpenClaw HTTP 调用成功
- [ ] 文本能通过小爱播报
- [ ] 家居命令可回退
- [ ] 音频 URL 可播放
- [ ] 断线后可重连
- [ ] 同一句识别结果不会重复执行
