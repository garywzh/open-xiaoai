# Open-XiaoAI x OpenClaw

让小爱音箱通过局域网桥接到本地部署的 OpenClaw，同时保留原生小爱在语音识别、文字转语音和米家控制上的优势。

## 目标

本示例的目标分为三部分：

1. 用户对小爱音箱说话后，可以把文本消息交给 OpenClaw 对话。
2. OpenClaw 可以让小爱音箱播放指定的 MP3 / 音频链接。
3. OpenClaw 或桥接服务可以继续控制米家设备。

## 配置方式

当前支持两种方式：

1. 直接修改 `config.ts`
2. 使用环境变量覆盖默认值

推荐做法：

- 复制 `examples/openclaw/.env.example` 为你自己的本地环境文件
- 启动脚本会自动按顺序加载 `.env`、`.env.local`
- 如果你已经在 Shell 里导出了同名环境变量，Shell 值优先，不会被本地文件覆盖

常用变量：

- `OPENCLAW_BASE_URL`
- `OPENCLAW_TOKEN`
- `OPENCLAW_AGENT_ID`
- `OPEN_XIAOAI_MEDIA_PUBLIC_ORIGIN`
- `OPEN_XIAOAI_ASSISTANT_KEYWORDS`
- `OPEN_XIAOAI_HOME_PATTERNS`

## 选型结论

本目录采用 **MiGPT 风格桥接方案**，而不是“小智风格音频全接管方案”。

原因：

- 小爱原生 ASR 已经能稳定得到识别文本，`Open-XiaoAI` 也已经能把它转成事件上报。
- 小爱原生 TTS 和米家指令链路已经可用，复用它们的改造成本最低。
- OpenClaw 当前最适合扮演“对话大脑 + 工具编排器”，不必在第一阶段同时承担 STT/TTS。
- OpenClaw Gateway 默认提供本地控制面接口，HTTP Chat Completions 端点也可启用，适合作为桥接目标。

## 整体架构

```text
用户
  ↓ 语音
小爱音箱
  ↓
Open-XiaoAI Rust Client（音箱侧）
  ⇅ WebSocket :4399
Open-XiaoAI Bridge Server（本目录实现）
  ├─ 路由文本到 OpenClaw Gateway
  ├─ 调小爱播放文本 / URL / 音频流
  └─ 调原生小爱执行米家命令
  ↓
OpenClaw Gateway（局域网 / 本机）
  ├─ 对话
  ├─ Skills
  └─ 后续可接 Home Assistant
```

## 为什么不直接做“小智模式”

如果直接把小爱音箱当成“远程麦克风 + 扬声器”，虽然也能接 OpenClaw，但第一阶段就要同时解决：

- 实时 STT
- 实时 TTS
- 打断 / 半双工控制
- 米家控制回退

这会把项目复杂度一下子拉高。当前更稳妥的做法是：

- **输入** 继续使用小爱原生识别结果
- **输出** 优先使用小爱原生 TTS / 音频播放
- **家居控制** 优先继续走小爱原生链路
- **OpenClaw** 专注于大模型对话和工具编排

## 第一阶段的工作边界

第一阶段只做“文本桥接 + 播放控制 + 米家回退”，不做：

- 自建 STT 服务
- 自建 TTS 服务
- 全双工打断语音链路
- OpenClaw Node / 设备节点协议接入

## 方案拆分

### A. 音箱侧

直接复用 `packages/client-rust`：

- 监听小爱原生识别日志并上报 `instruction` 事件
- 监听播放状态并上报 `playing` 事件
- 提供 `run_shell`、`start_play`、`stop_play`、`start_recording`、`stop_recording` RPC

本目录不改动音箱侧 Rust Client，只在服务端消费这些能力。

### B. 桥接服务

本目录新增一个 Node.js 服务，功能上参考 `examples/migpt`，但把 MiGPT 替换为 OpenClaw。

桥接服务职责：

1. 接收来自音箱的原生识别文本。
2. 执行路由策略：
   - 家居命令 → 交回原生小爱执行。
   - 一般问答 → 发送给 OpenClaw。
   - 媒体播放命令 → 让音箱播放指定 URL。
3. 把 OpenClaw 返回的文本或结构化结果映射为小爱动作。

### C. OpenClaw 侧

OpenClaw 第一阶段不直接连小爱音箱，而是通过桥接服务协作。

推荐使用两种方式之一：

1. **HTTP Chat Completions**
   - 优点：接入最简单。
   - 适合第一阶段直接把文本消息送入 OpenClaw。
2. **Skills 调桥接 API**
   - 适合让 OpenClaw 主动执行“播 MP3”“交回小爱控制米家”等动作。

## 推荐目录结构

本目录建议做成和 `examples/migpt` 类似的双层结构：

```text
examples/openclaw/
├─ README.md
├─ PLAN.md
├─ package.json
├─ tsconfig.json
├─ Cargo.toml
├─ config.ts
├─ src/
│  ├─ lib.rs
│  ├─ node.rs
│  ├─ runtime.rs
│  └─ server.rs
└─ openclaw/
   ├─ index.ts
   ├─ bridge.ts
   ├─ openclaw-client.ts
   ├─ router.ts
   ├─ speaker.ts
   └─ types.ts
```

说明：

- `src/*.rs`：复用 `examples/migpt` 的 Rust + Neon 模式，负责和音箱客户端通信。
- `openclaw/openclaw-client.ts`：负责请求 OpenClaw Gateway。
- `openclaw/router.ts`：负责“问答 / 播放 / 米家”路由决策。
- `openclaw/speaker.ts`：封装小爱音箱的播放、唤醒、回退命令。
- `openclaw/bridge.ts`：把事件、OpenClaw 回复、小爱动作串起来。

## 路由策略

### 1. 默认策略

- 识别到明显家居命令：
  - 例如“打开客厅灯”“关闭空调”“扫地机器人回充”
  - 直接调用 `ask_xiaoai(text)`
- 识别到媒体播放命令：
  - 例如“播放某个播客”“播放某个 MP3 链接”
  - 交给 OpenClaw 产出 URL 或结构化动作，再调用桥接播放
- 其他一般问答：
  - 交给 OpenClaw
  - 再让小爱用原生 TTS 播报文本回复

当前实现为了避免和原生小爱双重响应，默认只有命中 `assistantKeywords` 前缀的语句才进入桥接逻辑，比如：

- `问问龙虾 今天上海天气怎么样`
- `召唤龙虾 打开客厅灯`

未命中前缀时，桥接服务会忽略这句识别文本，让原生小爱继续处理。

### 2. 后续增强

- 把路由从“关键词”升级为“意图分类”。
- 引入白名单：只允许某些用户 / 唤醒词访问 OpenClaw。
- 对家居命令增加二次确认策略。

目前已经支持：

- 关键词匹配：`homeKeywords`、`mediaKeywords`
- 正则匹配：`homePatterns`、`mediaPatterns`

其中正则配置适合处理更稳定的家居命令模板。

## OpenClaw 接入方式

### 方式一：先用 Chat Completions（推荐）

直接由桥接服务调用 OpenClaw Gateway 的 OpenAI 兼容端点：

- `POST /v1/chat/completions`
- 默认和 Gateway 共用端口
- 需要显式启用
- 使用 Gateway Bearer Token 鉴权

这条路径最适合 MVP，因为：

- 不需要先写 OpenClaw 插件
- 不需要先做 Gateway WebSocket 协议客户端
- 易于调试和录制请求日志

当前实现按 OpenClaw 官方 OpenAI 兼容 HTTP 接口发送：

- `POST /v1/chat/completions`
- `Authorization: Bearer <token>`
- `x-openclaw-agent-id: <agentId>`
- `model: "openclaw"`
- `user: <sessionUser>` 用于复用会话

### 方式二：后续增加 Skills

为 OpenClaw 增加一个 `xiaoai_bridge` Skill，职责是：

- 调本机桥接 API 播放音频
- 调本机桥接 API 把文本交回原生小爱执行
- 查询当前音箱状态

这适合第二阶段做“OpenClaw 主动调用音箱动作”的能力。

## 本地 API 设计

桥接服务内部建议抽象出以下动作接口：

- `speak(text)`
  - 用小爱原生 TTS 播报文本
- `playUrl(url)`
  - 让音箱播放音频链接
- `askXiaoAI(text)`
  - 把命令交回原生小爱执行
- `abortXiaoAI()`
  - 打断小爱当前回复

如果后续要给 OpenClaw Skill 调用，可再对外暴露 HTTP：

- `POST /api/speak`
- `POST /api/play`
- `POST /api/ask-xiaoai`
- `POST /api/debug/text`
- `GET /api/status`

当前代码中，这些调试接口默认监听在 `127.0.0.1:${config.server.debugPort}`，便于本机联调。

另外，桥接程序还会启动一个局域网媒体服务：

- `http://<你的局域网IP>:4401/media/<文件路径>`
- 默认从 `examples/openclaw/media` 目录读取音频文件
- 适合让 OpenClaw 返回 `play_file` 动作，而不是手写完整 URL

### 调试示例

```bash
curl http://127.0.0.1:4400/healthz

curl http://127.0.0.1:4400/api/media/list

curl "http://127.0.0.1:4400/api/media/url?file=test.mp3"

curl -X POST http://127.0.0.1:4400/api/debug/text \
  -H 'Content-Type: application/json' \
  -d '{"text":"问问龙虾 今天上海天气怎么样","execute":false}'
```

说明：

- `execute=false` 只做路由和 OpenClaw 调用，不真正让音箱执行动作。
- `execute=true` 会真正触发播报 / 播放 / 回退给原生小爱。

### 路由规则调试建议

在调家居规则时，建议先用：

```bash
curl -X POST http://127.0.0.1:4400/api/debug/text \
  -H 'Content-Type: application/json' \
  -d '{"text":"召唤龙虾 打开客厅灯","execute":false}'
```

先看返回里的：

- `routedAs`
- `normalizedText`
- `action`

确认命中的是 `home_control` 或 `openclaw`，再把 `execute` 改成 `true`。

### `play_file` 动作

现在除了 `play_url`，还支持：

```json
{
  "action": "play_file",
  "file": "music/demo.mp3"
}
```

桥接服务会自动把它转换成局域网可访问的音频 URL。

### 调试脚本

```bash
pnpm media:url -- --list
pnpm media:url -- music/demo.mp3
pnpm smoke
pnpm smoke -- --live
```

这个脚本会输出：

- 媒体根目录
- 检测到的局域网 IP
- 最终可给音箱访问的音频 URL

其中：

- `pnpm smoke` 会做纯本地检查：路由规则、媒体 URL、OpenClaw 动作解析
- `pnpm smoke -- --live` 会额外访问本机调试接口，检查 `http://127.0.0.1:4400`

## OpenClaw Skill 草案

根据 OpenClaw 官方技能文档，技能目录通常放在工作区的 `skills/` 下，并以 `SKILL.md` 作为入口。

本示例已在这里准备了一个可直接改造的草案：

- `examples/openclaw/skills/xiaoai-bridge/SKILL.md`
- `examples/openclaw/skills/xiaoai-bridge/invoke.mjs`

用途：

- 让 OpenClaw 主动查询桥接状态
- 让 OpenClaw 主动调用小爱播报文本
- 让 OpenClaw 主动让小爱播放 URL 音频
- 让 OpenClaw 把米家命令回退给原生小爱

如果你的 OpenClaw 工作区不在本目录，可把 `xiaoai-bridge` 整个文件夹复制到你的 OpenClaw 工作区 `skills/` 目录中。

技能默认访问：

- `http://127.0.0.1:4400`

也可以通过下面这个环境变量覆盖：

- `OPEN_XIAOAI_BRIDGE_BASE_URL`

示例：

```bash
node examples/openclaw/skills/xiaoai-bridge/invoke.mjs status
node examples/openclaw/skills/xiaoai-bridge/invoke.mjs debug-text "问问龙虾 今天上海天气怎么样"
node examples/openclaw/skills/xiaoai-bridge/invoke.mjs speak "我已经连上桥接服务。"
node examples/openclaw/skills/xiaoai-bridge/invoke.mjs ask-xiaoai "打开客厅灯"
```

## 建议的回复协议

为了让 OpenClaw 更容易和桥接服务协作，建议第一阶段先约定一个很小的结构化回复协议：

```json
{
  "action": "reply_text",
  "text": "你好，我在。"
}
```

后续扩展：

```json
{
  "action": "play_url",
  "url": "http://192.168.1.10:8080/audio/demo.mp3"
}
```

```json
{
  "action": "ask_xiaoai",
  "text": "打开客厅灯"
}
```

MVP 阶段可先允许非结构化文本，默认按 `reply_text` 处理。

## 分阶段计划

### 阶段 1：MVP 文本桥接

交付目标：

- 小爱说一句话，桥接服务能拿到文本。
- 桥接服务能把文本发给 OpenClaw。
- OpenClaw 的文本回复能通过小爱 TTS 说出来。

### 阶段 2：播放 URL / MP3

交付目标：

- OpenClaw 能触发“播放某个 URL”。
- 小爱能播放局域网可访问的 MP3。

### 阶段 3：米家回退

交付目标：

- 家居命令被桥接服务识别后，直接交回小爱执行。
- 典型米家命令不经过 OpenClaw 也能稳定执行。

### 阶段 4：OpenClaw Skill 化

交付目标：

- OpenClaw 能通过 Skill 主动让小爱播放、朗读或执行原生命令。

### 阶段 5：可选接入 Home Assistant

交付目标：

- 对于小爱不擅长的设备或复杂自动化，由 OpenClaw 转接到 Home Assistant。

## 风险与规避

### 1. 识别文本重复上报

需要在桥接层按 `dialog_id + text + 时间窗口` 做去重。

### 2. 小爱与 OpenClaw 双重回复

默认要对识别文本做路由，不要让同一句既被 OpenClaw 回复、又被原生小爱继续完整处理。

### 3. 音频 URL 可达性

MP3 需要让音箱能直接访问：

- 局域网 HTTP 服务
- NAS 静态文件服务
- Nginx / Caddy 临时目录

不要传本机绝对路径给音箱。

### 4. OpenClaw 权限过大

桥接服务只应连接内网 / 本机的 Gateway，并使用私有 Token；不要把 Gateway 或桥接 API 直接暴露到公网。

## 开发顺序建议

1. 先复制并改造 `examples/migpt` 的骨架。
2. 先接通 OpenClaw Chat Completions。
3. 再做播放 URL。
4. 再做家居命令回退。
5. 最后再做 OpenClaw Skill。

## 参考资料

- OpenClaw Gateway 网络模型：<https://docs.openclaw.ai/gateway/network-model>
- OpenClaw Gateway 架构：<https://docs.openclaw.ai/concepts/architecture>
- OpenClaw OpenAI Chat Completions：<https://docs.openclaw.ai/gateway/openai-http-api>
- OpenClaw Skills：<https://docs.openclaw.ai/skills>
- OpenClaw Creating Skills：<https://docs.openclaw.ai/tools/creating-skills>

