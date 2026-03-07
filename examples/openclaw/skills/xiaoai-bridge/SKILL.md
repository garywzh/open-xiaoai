---
name: xiaoai_bridge
description: Call a local Open-XiaoAI bridge so OpenClaw can speak through XiaoAI, play audio, inspect bridge status, or hand a command back to native XiaoAI.
metadata: {"openclaw":{"emoji":"🔊","requires":{"bins":["node"]}}}
---

# XiaoAI Bridge

Use this skill when the user wants to operate the local XiaoAI bridge exposed by `examples/openclaw`.

This skill talks to the bridge debug HTTP API, which normally listens on `http://127.0.0.1:4400`.

## Before You Act

1. Prefer `status` first if the user asks whether the bridge is online.
2. Use `debug-text` for dry-run validation when the user is testing routing.
3. Use `speak` for short spoken replies.
4. Use `play` only with a XiaoAI-reachable URL.
5. Use `ask-xiaoai` for Mi Home / native XiaoAI commands such as turning on lights.

## Commands

Run the helper with Node:

```bash
node {baseDir}/invoke.mjs status
node {baseDir}/invoke.mjs debug-text "问问爪爪 今天上海天气怎么样"
node {baseDir}/invoke.mjs speak "我已经连上局域网桥接服务。"
node {baseDir}/invoke.mjs play "http://192.168.1.8:4401/media/music/demo.mp3"
node {baseDir}/invoke.mjs ask-xiaoai "打开客厅灯"
```

## Parameters

- Set `OPEN_XIAOAI_BRIDGE_BASE_URL` to override the default debug API base URL.
- The default is `http://127.0.0.1:4400`.

## Expected Endpoints

- `GET /api/status`
- `POST /api/debug/text`
- `POST /api/speak`
- `POST /api/play`
- `POST /api/ask-xiaoai`

## Safety

- Do not send repeated `speak` requests for the same answer.
- Do not call `play` with a local filesystem path; use an HTTP URL.
- If the bridge API is offline, report the failure clearly and stop.
