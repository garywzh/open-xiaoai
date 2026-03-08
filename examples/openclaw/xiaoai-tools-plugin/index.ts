const PLUGIN_ID = "xiaoai-tools";
const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:4400";
const DEFAULT_TIMEOUT_MS = 10000;

function normalizeConfig(pluginConfig: Record<string, unknown> | undefined) {
  const bridgeBaseUrl =
    typeof pluginConfig?.bridgeBaseUrl === "string" && pluginConfig.bridgeBaseUrl.trim()
      ? pluginConfig.bridgeBaseUrl.trim().replace(/\/$/, "")
      : DEFAULT_BRIDGE_BASE_URL;

  const timeoutMsRaw = Number(pluginConfig?.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 1000
    ? timeoutMsRaw
    : DEFAULT_TIMEOUT_MS;

  const enabled = pluginConfig?.enabled !== false;

  return {
    enabled,
    bridgeBaseUrl,
    timeoutMs,
  };
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function okResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, ...payload }, null, 2),
      },
    ],
  };
}

function errorResult(tool: string, error: unknown, extra?: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            tool,
            error: message,
            ...extra,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function requestJson(
  config: ReturnType<typeof normalizeConfig>,
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(`${config.bridgeBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const raw = await response.text();
  const json = raw.trim() ? JSON.parse(raw) : {};

  if (!response.ok) {
    const error = new Error(
      typeof json?.error === "string"
        ? json.error
        : `Bridge HTTP ${response.status}`,
    ) as Error & { status?: number; payload?: unknown };
    error.status = response.status;
    error.payload = json;
    throw error;
  }

  return json as Record<string, unknown>;
}

function registerOptionalTool(
  api: { registerTool: (tool: Record<string, unknown>, options?: { optional?: boolean }) => void; logger?: { info?: (message: string) => void } },
  tool: Record<string, unknown>,
) {
  api.registerTool(tool, { optional: true });
}

export default function register(api: {
  pluginConfig?: Record<string, unknown>;
  registerTool: (tool: Record<string, unknown>, options?: { optional?: boolean }) => void;
  logger?: { info?: (message: string) => void };
}) {
  const config = normalizeConfig(api.pluginConfig);
  if (!config.enabled) {
    api.logger?.info?.(`${PLUGIN_ID}: disabled by config, skipping registration`);
    return;
  }

  registerOptionalTool(api, {
    name: "xiaoai_status",
    description: "Get the current local XiaoAI bridge status, including speaker playback state.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config, "/api/status");
        return okResult({ tool: "xiaoai_status", ...data });
      } catch (error) {
        return errorResult("xiaoai_status", error);
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_interrupt",
    description: "Interrupt the current XiaoAI reply or media playback immediately.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config, "/api/interrupt", { method: "POST", body: "{}" });
        return okResult({ tool: "xiaoai_interrupt", ...data });
      } catch (error) {
        return errorResult("xiaoai_interrupt", error);
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_pause",
    description: "Pause the current local media playback.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config, "/api/pause", { method: "POST", body: "{}" });
        return okResult({ tool: "xiaoai_pause", ...data });
      } catch (error) {
        return errorResult("xiaoai_pause", error);
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_resume",
    description: "Resume paused local media playback.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config, "/api/resume", { method: "POST", body: "{}" });
        return okResult({ tool: "xiaoai_resume", ...data });
      } catch (error) {
        return errorResult("xiaoai_resume", error);
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_speak",
    description: "Speak a short text through the local XiaoAI bridge TTS.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1 },
      },
      required: ["text"],
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const text = asTrimmedString(rawParams?.text);
      if (!text) {
        return errorResult("xiaoai_speak", new Error("text is required"));
      }
      try {
        const data = await requestJson(config, "/api/speak", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        return okResult({ tool: "xiaoai_speak", text, ...data });
      } catch (error) {
        return errorResult("xiaoai_speak", error, { text });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_play_url",
    description: "Play a remote audio URL through the local XiaoAI bridge.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", minLength: 1 },
      },
      required: ["url"],
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const url = asTrimmedString(rawParams?.url);
      if (!url) {
        return errorResult("xiaoai_play_url", new Error("url is required"));
      }
      try {
        const data = await requestJson(config, "/api/play", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        return okResult({ tool: "xiaoai_play_url", url, ...data });
      } catch (error) {
        return errorResult("xiaoai_play_url", error, { url });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_list_media",
    description: "List local media files that the XiaoAI bridge can play.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const pattern = asTrimmedString(rawParams?.pattern).toLowerCase();
      const limit = asOptionalNumber(rawParams?.limit) ?? 50;
      try {
        const data = await requestJson(config, "/api/media/list");
        const rawFiles = Array.isArray(data.files) ? data.files : [];
        const files = rawFiles
          .filter((entry) => typeof entry === "string")
          .filter((entry) => !pattern || entry.toLowerCase().includes(pattern))
          .slice(0, limit);
        return okResult({
          tool: "xiaoai_list_media",
          pattern: pattern || undefined,
          total: rawFiles.length,
          returned: files.length,
          files,
        });
      } catch (error) {
        return errorResult("xiaoai_list_media", error, { pattern: pattern || undefined });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_resolve_media_url",
    description: "Resolve a local bridge media file to its playable URL.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file: { type: "string", minLength: 1 },
      },
      required: ["file"],
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const file = asTrimmedString(rawParams?.file);
      if (!file) {
        return errorResult("xiaoai_resolve_media_url", new Error("file is required"));
      }
      try {
        const data = await requestJson(config, `/api/media/url?file=${encodeURIComponent(file)}`);
        return okResult({ tool: "xiaoai_resolve_media_url", ...data });
      } catch (error) {
        return errorResult("xiaoai_resolve_media_url", error, { file });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_play_file",
    description: "Play a local bridge media file by name.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file: { type: "string", minLength: 1 },
      },
      required: ["file"],
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const file = asTrimmedString(rawParams?.file);
      if (!file) {
        return errorResult("xiaoai_play_file", new Error("file is required"));
      }
      try {
        const resolved = await requestJson(config, `/api/media/url?file=${encodeURIComponent(file)}`);
        const url = asTrimmedString(resolved.url);
        if (!url) {
          throw new Error("bridge did not return a playable url");
        }
        const played = await requestJson(config, "/api/play", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        return okResult({
          tool: "xiaoai_play_file",
          file: asTrimmedString(resolved.file) || file,
          url,
          ...played,
        });
      } catch (error) {
        return errorResult("xiaoai_play_file", error, { file });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_ask_native",
    description: "Delegate a clear device-control or native XiaoAI command to the original system assistant.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1 },
        silent: { type: "boolean" },
      },
      required: ["text"],
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const text = asTrimmedString(rawParams?.text);
      const silent = asOptionalBoolean(rawParams?.silent);
      if (!text) {
        return errorResult("xiaoai_ask_native", new Error("text is required"));
      }
      try {
        const data = await requestJson(config, "/api/ask-xiaoai", {
          method: "POST",
          body: JSON.stringify({ text, silent }),
        });
        return okResult({ tool: "xiaoai_ask_native", text, silent, ...data });
      } catch (error) {
        return errorResult("xiaoai_ask_native", error, { text, silent });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_device_info",
    description: "Get local XiaoAI device model and serial number information.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config, "/api/device");
        return okResult({ tool: "xiaoai_device_info", ...data });
      } catch (error) {
        return errorResult("xiaoai_device_info", error);
      }
    },
  });

  api.logger?.info?.(`${PLUGIN_ID}: registered optional XiaoAI bridge tools`);
}
