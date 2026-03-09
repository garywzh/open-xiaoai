const PLUGIN_ID = "xiaoai-tools";
const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:4400";
const DEFAULT_LIBRARY_BASE_URL = "http://127.0.0.1:4402";
const DEFAULT_TIMEOUT_MS = 10000;

function normalizeConfig(pluginConfig: Record<string, unknown> | undefined) {
  const legacyBridgeBaseUrl =
    typeof pluginConfig?.bridgeBaseUrl === "string" && pluginConfig.bridgeBaseUrl.trim()
      ? pluginConfig.bridgeBaseUrl.trim().replace(/\/$/, "")
      : undefined;
  const gatewayBaseUrl =
    typeof pluginConfig?.gatewayBaseUrl === "string" && pluginConfig.gatewayBaseUrl.trim()
      ? pluginConfig.gatewayBaseUrl.trim().replace(/\/$/, "")
      : legacyBridgeBaseUrl ?? DEFAULT_GATEWAY_BASE_URL;
  const libraryBaseUrl =
    typeof pluginConfig?.libraryBaseUrl === "string" && pluginConfig.libraryBaseUrl.trim()
      ? pluginConfig.libraryBaseUrl.trim().replace(/\/$/, "")
      : legacyBridgeBaseUrl ?? DEFAULT_LIBRARY_BASE_URL;

  const timeoutMsRaw = Number(pluginConfig?.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 1000
    ? timeoutMsRaw
    : DEFAULT_TIMEOUT_MS;

  const enabled = pluginConfig?.enabled !== false;

  return {
    enabled,
    gatewayBaseUrl,
    libraryBaseUrl,
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

function asOptionalStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
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
  baseUrl: string,
  timeoutMs: number,
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  const json = raw.trim() ? JSON.parse(raw) : {};

  if (!response.ok) {
    const error = new Error(
      typeof json?.error === "string"
        ? json.error
        : `HTTP ${response.status}`,
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
    name: "xiaoai_media_status",
    description: "Get local XiaoAI media library status, including index and downloader settings.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config.libraryBaseUrl, config.timeoutMs, "/api/library/status");
        return okResult({ tool: "xiaoai_media_status", ...data });
      } catch (error) {
        return errorResult("xiaoai_media_status", error);
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_media_list",
    description: "List indexed XiaoAI media library items, optionally filtered by a search query.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const query = asTrimmedString(rawParams?.query);
      const limit = asOptionalNumber(rawParams?.limit) ?? 50;
      try {
        const params = new URLSearchParams();
        if (query) {
          params.set("query", query);
        }
        params.set("limit", String(limit));
        const data = await requestJson(
          config.libraryBaseUrl,
          config.timeoutMs,
          `/api/library/items?${params.toString()}`,
        );
        return okResult({ tool: "xiaoai_media_list", query: query || undefined, ...data });
      } catch (error) {
        return errorResult("xiaoai_media_list", error, { query: query || undefined });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_media_match",
    description: "Match a user request against the local XiaoAI media library before downloading anything.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const query = asTrimmedString(rawParams?.query);
      const limit = asOptionalNumber(rawParams?.limit) ?? 5;
      if (!query) {
        return errorResult("xiaoai_media_match", new Error("query is required"));
      }
      try {
        const data = await requestJson(config.libraryBaseUrl, config.timeoutMs, "/api/library/match", {
          method: "POST",
          body: JSON.stringify({ query, limit }),
        });
        return okResult({ tool: "xiaoai_media_match", query, ...data });
      } catch (error) {
        return errorResult("xiaoai_media_match", error, { query });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_media_ensure",
    description: "Ensure a requested track exists in the local XiaoAI media library; return a cached file or download one from a source URL.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        sourceUrl: { type: "string", minLength: 1 },
        title: { type: "string" },
        artist: { type: "string" },
        aliases: {
          type: "array",
          items: { type: "string", minLength: 1 },
          maxItems: 12,
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: unknown, rawParams: Record<string, unknown>) {
      const query = asTrimmedString(rawParams?.query);
      const sourceUrl = asTrimmedString(rawParams?.sourceUrl);
      const title = asTrimmedString(rawParams?.title);
      const artist = asTrimmedString(rawParams?.artist);
      const aliases = asOptionalStringArray(rawParams?.aliases);
      if (!query) {
        return errorResult("xiaoai_media_ensure", new Error("query is required"));
      }
      try {
        const data = await requestJson(config.libraryBaseUrl, config.timeoutMs, "/api/library/ensure", {
          method: "POST",
          body: JSON.stringify({
            query,
            sourceUrl: sourceUrl || undefined,
            title: title || undefined,
            artist: artist || undefined,
            aliases,
          }),
        });
        return okResult({
          tool: "xiaoai_media_ensure",
          query,
          sourceUrl: sourceUrl || undefined,
          title: title || undefined,
          artist: artist || undefined,
          aliases,
          ...data,
        });
      } catch (error) {
        return errorResult("xiaoai_media_ensure", error, {
          query,
          sourceUrl: sourceUrl || undefined,
          title: title || undefined,
          artist: artist || undefined,
          aliases,
        });
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_media_rescan",
    description: "Rescan the local media asset root and refresh the media library index.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config.libraryBaseUrl, config.timeoutMs, "/api/library/rescan", {
          method: "POST",
          body: "{}",
        });
        return okResult({ tool: "xiaoai_media_rescan", ...data });
      } catch (error) {
        return errorResult("xiaoai_media_rescan", error);
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_status",
    description: "Get the current local XiaoAI gateway status, including speaker playback state.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const data = await requestJson(config.gatewayBaseUrl, config.timeoutMs, "/api/status");
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
        const data = await requestJson(
          config.gatewayBaseUrl,
          config.timeoutMs,
          "/api/interrupt",
          { method: "POST", body: "{}" },
        );
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
        const data = await requestJson(
          config.gatewayBaseUrl,
          config.timeoutMs,
          "/api/pause",
          { method: "POST", body: "{}" },
        );
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
        const data = await requestJson(
          config.gatewayBaseUrl,
          config.timeoutMs,
          "/api/resume",
          { method: "POST", body: "{}" },
        );
        return okResult({ tool: "xiaoai_resume", ...data });
      } catch (error) {
        return errorResult("xiaoai_resume", error);
      }
    },
  });

  registerOptionalTool(api, {
    name: "xiaoai_speak",
    description: "Speak a short text through the local XiaoAI gateway TTS.",
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
        const data = await requestJson(config.gatewayBaseUrl, config.timeoutMs, "/api/speak", {
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
    description: "Play a remote audio URL through the local XiaoAI gateway.",
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
        const data = await requestJson(config.gatewayBaseUrl, config.timeoutMs, "/api/play", {
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
        const data = await requestJson(config.gatewayBaseUrl, config.timeoutMs, "/api/ask-xiaoai", {
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
        const data = await requestJson(config.gatewayBaseUrl, config.timeoutMs, "/api/device");
        return okResult({ tool: "xiaoai_device_info", ...data });
      } catch (error) {
        return errorResult("xiaoai_device_info", error);
      }
    },
  });

  api.logger?.info?.(`${PLUGIN_ID}: registered optional XiaoAI gateway tools`);
}
