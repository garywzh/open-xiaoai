# Open-XiaoAI x OpenClaw

这个示例把 **Root 后的小爱音箱** 接到 **本地 OpenClaw Gateway**，做成一个面向家庭场景的语音助手桥接层。

它的定位不是“把音箱变成另一台电脑”，而是：

- 大部分自由问答、陪聊、简单知识问答，交给 OpenClaw 里的 `xiaoai` agent
- 家居控制、原生音乐生态、闹钟提醒等高确定性能力，优先保留给原生小爱
- 本地音频播放、打断、状态查询等能力，通过 OpenClaw 插件工具调用
- 当工具已经完成动作时，用 `NO_REPLY` 避免桥接再次重复播报

## 当前架构

当前推荐方案一共 4 层：

1. **音箱 Client（Rust）**
   - 负责连接音箱与桥接服务
   - 监听 ASR / 播放事件
   - 在设备侧尽早打断原生小爱的“抢话”回复
2. **桥接服务（本目录）**
   - 接收音箱事件
   - 做去重、路由、打断、媒体服务、调试 API
   - 把文本请求转给 OpenClaw
3. **OpenClaw `xiaoai` agent**
   - 通过 `AGENTS.md` / `SOUL.md` / `TOOLS.md` / `USER.md` 定义家庭语音助手行为
4. **OpenClaw 插件工具**
   - 由 `xiaoai-tools-plugin/` 提供可选工具
   - 例如 `xiaoai_interrupt`、`xiaoai_speak`、`xiaoai_device_info`

## 功能特点

- **默认接管自由问答**：更适合家庭问答、儿童场景、短对话
- **原生白名单保留**：家居控制、闹钟提醒、原生播放等可继续走原生小爱
- **设备侧抢话拦截**：Client 发现原生回复开始播报时，会本地尝试打断
- **插件工具调用**：`xiaoai` agent 可以主动打断、播报、播放本地音频、查设备信息
- **静默收尾**：工具完成动作后，返回 `NO_REPLY`，避免二次播报

## 隐私与仓库边界

这套示例故意把**个人数据留在仓库外**：

- `examples/openclaw/.env` 是本地文件，已被 `.gitignore` 忽略
- `~/.openclaw/openclaw.json` 是你自己的 OpenClaw 本机配置，不在仓库里
- `~/.openclaw/workspace-xiaoai/` 里的 Core Files 属于你的本地 agent 工作区，也不在仓库里

请不要把下面这些内容提交进仓库：

- 局域网 IP
- Gateway token / API key
- 音箱序列号
- 个人化 session user
- 你自己家庭成员的偏好、称呼、画像

## 前置条件

开始前需要满足：

- 音箱已刷机，并且能 SSH 登录
- 音箱已运行 `packages/client-rust` 客户端
- 本机已安装并运行 OpenClaw Gateway
- 你希望为家庭音箱单独使用一个 `xiaoai` agent

> [!IMPORTANT]
> 本示例依赖本地 OpenClaw，不是“填一个云端 API Key 就能跑”的最小配置。

## 第一步：准备 OpenClaw 的 `xiaoai` agent

建议为音箱单独创建一个 `xiaoai` agent，而不是复用你的 `main` agent。

最少需要：

- 一个独立的 `agentId`：`xiaoai`
- 一个独立工作区：例如 `~/.openclaw/workspace-xiaoai`
- 该工作区里的 Core Files：`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`

## 第二步：在 OpenClaw 里启用插件工具

本示例依赖 `examples/openclaw/xiaoai-tools-plugin/` 里的插件工具。

在你的 `~/.openclaw/openclaw.json` 中，至少要有类似配置：

```json
{
  "agents": {
    "list": [
      {
        "id": "xiaoai",
        "workspace": "/path/to/workspace-xiaoai",
        "tools": {
          "profile": "minimal",
          "alsoAllow": [
            "xiaoai_status",
            "xiaoai_interrupt",
            "xiaoai_pause",
            "xiaoai_resume",
            "xiaoai_speak",
            "xiaoai_play_url",
            "xiaoai_list_media",
            "xiaoai_resolve_media_url",
            "xiaoai_play_file",
            "xiaoai_ask_native",
            "xiaoai_device_info"
          ]
        }
      }
    ]
  },
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/examples/openclaw/xiaoai-tools-plugin"
      ]
    },
    "entries": {
      "xiaoai-tools": {
        "enabled": true,
        "config": {
          "bridgeBaseUrl": "http://127.0.0.1:4400",
          "timeoutMs": 10000
        }
      }
    }
  }
}
```

> [!IMPORTANT]
> 这里要用的是 `alsoAllow`，不是 `allow`。
>
> 对 OpenClaw 的可选插件工具来说：
>
> - `profile: "minimal"` 用来保留核心最小工具面
> - `alsoAllow` 用来**增量挂载插件工具**
>
> 如果你误用了 `allow`，很容易出现“插件明明加载了，但 agent 还是看不到工具”的情况。

配置后执行：

```bash
openclaw config validate --json
openclaw gateway restart
openclaw plugins list
```

## 第三步：配置桥接服务

复制示例环境文件：

```bash
cd examples/openclaw
cp .env.example .env
```

然后只修改你自己的本地值，例如：

- `OPENCLAW_BASE_URL`
- `OPENCLAW_TOKEN`
- `OPEN_XIAOAI_MEDIA_PUBLIC_ORIGIN`
- `OPEN_XIAOAI_ASSISTANT_KEYWORDS`

示例中的默认值已经尽量做成“通用家庭助手”风格：

- 默认 agent：`xiaoai`
- 默认 session user：`xiaoai-bridge-family`
- 默认桥接历史：`0`（更推荐直接复用 OpenClaw 侧会话上下文）

关于 `OPEN_XIAOAI_ASSISTANT_KEYWORDS`：

- **现在的推荐主流程已经不依赖这组前缀来触发桥接**
- 日常真实语音链路里，是否由桥接接管，主要取决于 **设备侧原生白名单** 与 **Client 的抢话拦截逻辑**
- 这个变量现在更适合当作 **兼容选项 / 调试选项**：
  - 你手动调用 `/api/debug/text` 时
  - 你想保留“显式唤起本地助手”的口头前缀时
  - 你需要把前缀从文本里剥掉，再交给 OpenClaw 时

如果你完全不想用这类前缀，也没问题；当前推荐方式就是直接说正常话，让白名单和桥接逻辑决定谁接管。

## 第四步：启动桥接服务

```bash
cd examples/openclaw
pnpm install
pnpm build
pnpm start
```

其中：

- `pnpm build` 会编译本示例依赖的 Rust 模块
- `pnpm start` 会启动：
  - 音箱桥接服务（默认 `4399`）
  - 调试 API（默认 `4400`）
  - 局域网媒体服务（默认 `4401`）

启动成功后，你应该能看到类似日志：

- `Debug API 已启动`
- `Media API 已启动`
- `已连接: <speaker-ip>:<port>`

## 第五步：可选配置原生白名单

Client 端支持“原生白名单”机制。

白名单命中的内容，默认继续交给原生小爱；未命中的自由问答，则更倾向交给桥接 + OpenClaw。

你可以在音箱上创建：

```bash
cat > /data/open-xiaoai/native_whitelist.txt <<'EOF2'
灯
空调
窗帘
电视
米家
播放
暂停
继续播放
闹钟
提醒
EOF2
```

也可以通过环境变量传入：

```bash
export OPEN_XIAOAI_NATIVE_WHITELIST='灯,空调,窗帘,播放,暂停,提醒'
```

默认白名单已经覆盖常见的：

- 家居控制
- 原生播放控制
- 闹钟提醒类请求

## 调试 API

桥接服务默认提供本机调试接口：

- `GET /healthz`
- `GET /api/status`
- `GET /api/device`
- `POST /api/interrupt`
- `POST /api/pause`
- `POST /api/resume`
- `POST /api/speak`
- `POST /api/play`
- `POST /api/ask-xiaoai`
- `POST /api/debug/text`
- `GET /api/media/list`
- `GET /api/media/url?file=...`

### 常用调试命令

```bash
curl http://127.0.0.1:4400/healthz

curl http://127.0.0.1:4400/api/status

curl http://127.0.0.1:4400/api/device

curl http://127.0.0.1:4400/api/media/list

curl -X POST http://127.0.0.1:4400/api/debug/text \
  -H 'Content-Type: application/json' \
  -d '{"text":"请先调用 xiaoai_device_info，然后告诉我设备型号和序列号。","execute":false}'
```

说明：

- `execute=false`：只跑路由和 OpenClaw 调用，不真正让音箱执行动作
- `execute=true`：真实执行播报、播放、委托原生小爱等动作

## 当前工具面

本示例的插件工具包括：

- `xiaoai_status`
- `xiaoai_interrupt`
- `xiaoai_pause`
- `xiaoai_resume`
- `xiaoai_speak`
- `xiaoai_play_url`
- `xiaoai_list_media`
- `xiaoai_resolve_media_url`
- `xiaoai_play_file`
- `xiaoai_ask_native`
- `xiaoai_device_info`

## 行为约定：`NO_REPLY`

当工具已经完成了用户可感知的动作，例如：

- 已经打断
- 已经开始播放
- 已经直接播报
- 已经委托原生小爱去执行并自行回复

`xiaoai` agent 应该返回：

```text
NO_REPLY
```

这样桥接层就不会再额外补一段重复播报。

## 故障排查

### 1. 插件已加载，但 agent 看不到工具

先检查：

- `openclaw plugins list`
- `openclaw agent --agent xiaoai --message '请先调用 xiaoai_device_info' --json`

如果运行报告里 `tools.entries` 只有 `session_status`，大概率是你把：

- `alsoAllow`

写成了：

- `allow`

### 2. 原生小爱还是抢话

优先检查：

- 音箱上 `client` 是否为最新版本
- `/data/open-xiaoai/native_whitelist.txt` 是否过宽
- 桥接日志里是否出现 `prepare_bridge_done`
- Client 日志里是否出现 `native_reply_detected` / `local_interrupt_done`

### 3. 已经调用工具，但桥接还重复播报

先看桥接调试输出：

- 是否最终归一化成 `action: "no_reply"`
- `xiaoai` agent 最后是否真的返回 `NO_REPLY`

### 4. 语音回复明显偏慢

当前总耗时通常分为：

- 音箱 ASR 到桥接收到最终文本
- 桥接发给 OpenClaw 的模型耗时
- 工具执行耗时
- 音箱播报启动耗时

建议先分别看：

- `examples/openclaw` 桥接日志
- `openclaw agent --json` 的 `durationMs`
- 音箱侧 client 日志

## 仓库内与仓库外的文件

**仓库内：**

- `examples/openclaw/`
- `examples/openclaw/xiaoai-tools-plugin/`

**仓库外：**

- `~/.openclaw/openclaw.json`
- `~/.openclaw/workspace-xiaoai/`
- `examples/openclaw/.env`
- `/data/open-xiaoai/native_whitelist.txt`

推荐把所有“个人化配置”都留在这些仓库外的位置。
