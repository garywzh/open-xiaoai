import type { OpenClawBridgeConfig } from "./openclaw/types.js";

const kDefaultAssistantKeywords = ["请", "问问小爱", "小爱帮忙"];
const kDefaultHomeKeywords = [
  "打开",
  "关闭",
  "调到",
  "设置",
  "回充",
  "扫地",
  "空调",
  "灯",
  "窗帘",
  "电视",
  "加湿器",
  "风扇",
  "插座",
  "净化器",
  "米家",
];
const kDefaultHomePatterns = [
  "^(打开|关闭|开启|启动).*(灯|空调|窗帘|电视|风扇|插座|净化器|加湿器|扫地机器人)$",
  "^(把)?(.+)?(调到|设置成).+$",
  "^(让|叫).*(回充|回去充电)$",
];
const kDefaultMediaKeywords = ["播放", "来一首", "来点", "听", "放一段", "暂停", "继续播放", "下一首", "上一首", "音量", "闹钟", "提醒"];
const kDefaultMediaPatterns = [
  "^(播放|来一首|来点|听).+",
  "^播放\s+https?://.+\\.(mp3|wav|m4a|aac|flac)(\\?.*)?$",
];

export const kOpenXiaoAIConfig: OpenClawBridgeConfig = {
  server: {
    port: envNumber("OPEN_XIAOAI_SERVER_PORT", 4399),
    debugPort: envNumber("OPEN_XIAOAI_DEBUG_PORT", 4400),
  },
  media: {
    host: envString("OPEN_XIAOAI_MEDIA_HOST", "0.0.0.0"),
    port: envNumber("OPEN_XIAOAI_MEDIA_PORT", 4401),
    rootDir: envString("OPEN_XIAOAI_MEDIA_ROOT", "./media"),
    publicOrigin: envOptionalString("OPEN_XIAOAI_MEDIA_PUBLIC_ORIGIN"),
  },
  openclaw: {
    baseURL: envString("OPENCLAW_BASE_URL", "http://127.0.0.1:18789"),
    endpoint: envString("OPENCLAW_ENDPOINT", "/v1/chat/completions"),
    token: envOptionalString("OPENCLAW_TOKEN"),
    model: envString("OPENCLAW_MODEL", "openclaw"),
    agentId: envString("OPENCLAW_AGENT_ID", "xiaoai"),
    sessionUser: envString("OPENCLAW_SESSION_USER", "xiaoai-bridge-family"),
    sessionKey: envOptionalString("OPENCLAW_SESSION_KEY"),
    timeoutMs: envNumber("OPENCLAW_TIMEOUT_MS", 30_000),
    temperature: envNumber("OPENCLAW_TEMPERATURE", 0.3),
    historyMaxLength: envNumber("OPENCLAW_HISTORY_MAX_LENGTH", 0),
    systemPrompt: [
      "你是家里小爱音箱里的本地家庭语音助手桥接会话。",
      "你的最终文本会被桥接直接播报，请默认用简短、自然、适合口语的中文回答。",
      "你可以直接回答，也可以调用真实可用的工具来控制音箱、本地媒体或委托原生小爱。",
      "如果某个工具已经完成了用户可感知的动作，而且不需要你再补充播报，请只回复 NO_REPLY。",
      "除非用户明确要求，否则不要输出 JSON、代码块、工具名或内部说明。",
    ].join("\n"),
    extraHeaders: {},
  },
  router: {
    dedupeWindowMs: envNumber("OPEN_XIAOAI_DEDUPE_WINDOW_MS", 3_000),
    assistantKeywords: envList("OPEN_XIAOAI_ASSISTANT_KEYWORDS", kDefaultAssistantKeywords),
    homeKeywords: envList("OPEN_XIAOAI_HOME_KEYWORDS", kDefaultHomeKeywords),
    homePatterns: envList("OPEN_XIAOAI_HOME_PATTERNS", kDefaultHomePatterns, ";"),
    mediaKeywords: envList("OPEN_XIAOAI_MEDIA_KEYWORDS", kDefaultMediaKeywords),
    mediaPatterns: envList("OPEN_XIAOAI_MEDIA_PATTERNS", kDefaultMediaPatterns, ";"),
  },
  speaker: {
    ttsBlocking: envBoolean("OPEN_XIAOAI_TTS_BLOCKING", false),
    defaultPlayTimeout: envNumber("OPEN_XIAOAI_DEFAULT_PLAY_TIMEOUT", 10 * 60 * 1000),
    abortXiaoAIOnOpenClaw: envBoolean("OPEN_XIAOAI_ABORT_XIAOAI", true),
    abortRecoveryMs: envNumber("OPEN_XIAOAI_ABORT_RECOVERY_MS", 2_000),
  },
};

function envString(name: string, defaultValue: string) {
  const value = process.env[name]?.trim();
  return value || defaultValue;
}

function envOptionalString(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function envNumber(name: string, defaultValue: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

function envBoolean(name: string, defaultValue: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envList(name: string, defaultValue: string[], separator = ",") {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  return raw
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

