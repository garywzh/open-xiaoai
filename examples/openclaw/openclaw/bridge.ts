import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RustServer } from "./open-xiaoai.js";
import { OpenClawClient } from "./openclaw-client.js";
import {
  createMediaReadStream,
  ensureMediaFileReadable,
  getContentType,
  listMediaFiles,
  resolveMediaBaseURL,
  resolveMediaFileURL,
  resolveMediaRoot,
} from "./media.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { BridgeRouter } from "./router.js";
import type {
  BridgeAction,
  BridgeMessage,
  DebugRunResult,
  OpenClawBridgeConfig,
} from "./types.js";

type XiaoAIEvent = {
  event?: string;
  data?: unknown;
};

type RecognizeLine = {
  header?: {
    namespace?: string;
    name?: string;
  };
  payload?: {
    is_final?: boolean;
    results?: Array<{
      text?: string;
    }>;
  };
};

export class OpenClawBridge {
  private readonly client: OpenClawClient;
  private readonly router: BridgeRouter;
  private readonly history: BridgeMessage[] = [];
  private readonly seenTexts = new Map<string, number>();

  constructor(private readonly config: OpenClawBridgeConfig) {
    this.client = new OpenClawClient(config.openclaw);
    this.router = new BridgeRouter(config.router);
  }

  async start() {
    process.env.OPEN_XIAOAI_SERVER_ADDR = `0.0.0.0:${this.config.server.port}`;

    (global as typeof globalThis & { RUST_CALLBACKS: Record<string, unknown> }).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onInputData,
    };

    await this.startMediaServer();
    await this.startDebugServer();
    console.log("✅ OpenClaw bridge 已启动...");
    await RustServer.start();
  }

  private onInputData = (_data: Uint8Array) => {
    return undefined;
  };

  private onEvent = async (eventJson: string) => {
    const event = JSON.parse(eventJson) as XiaoAIEvent;

    if (event.event === "playing") {
      OpenXiaoAISpeaker.status =
        event.data === "Playing"
          ? "playing"
          : event.data === "Paused"
            ? "paused"
            : "idle";
      return;
    }

    if (event.event === "kws") {
      console.log("🔥 唤醒词识别", event.data);
      return;
    }

    if (event.event === "instruction") {
      const lineText = extractInstructionLine(event.data);
      if (!lineText) {
        return;
      }

      const text = extractRecognizedText(lineText);
      if (!text) {
        return;
      }

      await this.handleRecognizedText(text);
    }
  };

  private async handleRecognizedText(text: string) {
    const previousAt = this.seenTexts.get(text);
    if (this.router.shouldDedupe(previousAt)) {
      return;
    }
    this.seenTexts.set(text, Date.now());

    console.log(`🔥 收到指令: ${text}`);

    await this.runText(text);
  }

  async runText(text: string, options?: { execute?: boolean }): Promise<DebugRunResult> {
    const execute = options?.execute ?? true;
    const decision = this.router.decide(text);

    if (decision.type === "ignore") {
      return {
        input: text,
        routedAs: decision.type,
        normalizedText: decision.text,
        executed: false,
      };
    }

    if (execute) {
      await this.prepareBridgeCommand(decision.type);
    }

    if (decision.type === "home_control") {
      if (execute) {
        await OpenXiaoAISpeaker.askXiaoAI(decision.text);
      }
      return {
        input: text,
        routedAs: decision.type,
        normalizedText: decision.text,
        action: {
          action: "ask_xiaoai",
          text: decision.text,
        },
        executed: execute,
      };
    }

    if (decision.type === "play_url_direct" && decision.url) {
      if (execute) {
        await OpenXiaoAISpeaker.play({ url: decision.url });
      }
      return {
        input: text,
        routedAs: decision.type,
        normalizedText: decision.text,
        action: {
          action: "play_url",
          url: decision.url,
        },
        executed: execute,
      };
    }

    const messages = this.buildMessages(decision.text);
    const reply = await this.client.chat(messages);
    const action = this.client.normalizeAction(reply);

    if (execute) {
      await this.executeAction(action, decision.text);
    }

    return {
      input: text,
      routedAs: decision.type,
      normalizedText: decision.text,
      reply,
      action,
      executed: execute,
    };
  }

  private async prepareBridgeCommand(routeType: "home_control" | "play_url_direct" | "openclaw") {
    if (!this.config.speaker.abortXiaoAIOnOpenClaw) {
      return;
    }

    if (routeType === "home_control") {
      return;
    }

    await OpenXiaoAISpeaker.abortXiaoAI();
    if (this.config.speaker.abortRecoveryMs > 0) {
      await sleep(this.config.speaker.abortRecoveryMs);
    }
  }

  private buildMessages(text: string): BridgeMessage[] {
    const messages: BridgeMessage[] = [];

    if (this.config.openclaw.systemPrompt) {
      messages.push({
        role: "system",
        content: this.config.openclaw.systemPrompt,
      });
    }

    const history = this.history.slice(-this.config.openclaw.historyMaxLength);
    messages.push(...history, {
      role: "user",
      content: text,
    });
    return messages;
  }

  private async executeAction(action: BridgeAction, userText: string) {
    if (action.action === "play_url") {
      await OpenXiaoAISpeaker.play({
        url: action.url,
        timeout: this.config.speaker.defaultPlayTimeout,
      });
      this.pushHistory(userText, `[play_url] ${action.url}`);
      return;
    }

    if (action.action === "play_file") {
      const url = resolveMediaFileURL(this.config.media, action.file);
      await OpenXiaoAISpeaker.play({
        url,
        timeout: this.config.speaker.defaultPlayTimeout,
      });
      this.pushHistory(userText, `[play_file] ${action.file}`);
      return;
    }

    if (action.action === "ask_xiaoai") {
      await OpenXiaoAISpeaker.askXiaoAI(action.text);
      this.pushHistory(userText, `[ask_xiaoai] ${action.text}`);
      return;
    }

    await OpenXiaoAISpeaker.play({
      text: action.text,
      blocking: this.config.speaker.ttsBlocking,
      timeout: this.config.speaker.defaultPlayTimeout,
    });
    this.pushHistory(userText, action.text);
  }

  private pushHistory(userText: string, assistantText: string) {
    this.history.push(
      {
        role: "user",
        content: userText,
      },
      {
        role: "assistant",
        content: assistantText,
      },
    );

    const maxLength = Math.max(this.config.openclaw.historyMaxLength, 0) * 2;
    if (this.history.length > maxLength) {
      this.history.splice(0, this.history.length - maxLength);
    }
  }

  private async startDebugServer() {
    await new Promise<void>((resolve, reject) => {
      const server = createServer(async (request, response) => {
        try {
          await this.handleDebugRequest(request, response);
        } catch (error) {
          writeJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.on("error", reject);
      server.listen(this.config.server.debugPort, "127.0.0.1", () => {
        console.log(`✅ Debug API 已启动: http://127.0.0.1:${this.config.server.debugPort}`);
        resolve();
      });
    });
  }

  private async startMediaServer() {
    const mediaRoot = resolveMediaRoot(this.config.media);
    const baseURL = resolveMediaBaseURL(this.config.media);

    await new Promise<void>((resolve, reject) => {
      const server = createServer(async (request, response) => {
        try {
          await this.handleMediaRequest(request, response);
        } catch (error) {
          writeJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.on("error", reject);
      server.listen(this.config.media.port, this.config.media.host, () => {
        console.log(`✅ Media API 已启动: ${baseURL}`);
        console.log(`📁 Media Root: ${mediaRoot}`);
        resolve();
      });
    });
  }

  private async handleDebugRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        gateway: this.config.openclaw.baseURL,
        agentId: this.config.openclaw.agentId ?? "main",
        serverPort: this.config.server.port,
        debugPort: this.config.server.debugPort,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      writeJson(response, 200, {
        ok: true,
        speakerStatus: OpenXiaoAISpeaker.status,
        historyLength: this.history.length,
        dedupeCacheSize: this.seenTexts.size,
        mediaBaseURL: resolveMediaBaseURL(this.config.media),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/media/list") {
      const files = await listMediaFiles(this.config.media);
      writeJson(response, 200, {
        ok: true,
        rootDir: resolveMediaRoot(this.config.media),
        files,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/media/url") {
      const file = url.searchParams.get("file")?.trim();
      if (!file) {
        writeJson(response, 400, { error: "file is required" });
        return;
      }
      const resolved = await ensureMediaFileReadable(this.config.media, file);
      writeJson(response, 200, {
        ok: true,
        file: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        url: resolveMediaFileURL(this.config.media, file),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/debug/text") {
      const body = await readJsonBody<{ text?: string; execute?: boolean }>(request);
      if (!body.text?.trim()) {
        writeJson(response, 400, { error: "text is required" });
        return;
      }
      const result = await this.runText(body.text, {
        execute: body.execute ?? false,
      });
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/speak") {
      const body = await readJsonBody<{ text?: string }>(request);
      if (!body.text?.trim()) {
        writeJson(response, 400, { error: "text is required" });
        return;
      }
      await OpenXiaoAISpeaker.play({ text: body.text });
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/play") {
      const body = await readJsonBody<{ url?: string }>(request);
      if (!body.url?.trim()) {
        writeJson(response, 400, { error: "url is required" });
        return;
      }
      await OpenXiaoAISpeaker.play({ url: body.url });
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ask-xiaoai") {
      const body = await readJsonBody<{ text?: string }>(request);
      if (!body.text?.trim()) {
        writeJson(response, 400, { error: "text is required" });
        return;
      }
      await OpenXiaoAISpeaker.askXiaoAI(body.text);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 404, { error: "not found" });
  }

  private async handleMediaRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        rootDir: resolveMediaRoot(this.config.media),
        baseURL: resolveMediaBaseURL(this.config.media),
      });
      return;
    }

    if (request.method !== "GET" || !url.pathname.startsWith("/media/")) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    const relativePath = decodeURIComponent(url.pathname.slice("/media/".length));
    const resolved = await ensureMediaFileReadable(this.config.media, relativePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", getContentType(resolved.absolutePath));
    response.setHeader("Cache-Control", "public, max-age=60");

    await new Promise<void>((resolve, reject) => {
      const stream = createMediaReadStream(resolved.absolutePath);
      stream.on("error", reject);
      response.on("close", resolve);
      stream.pipe(response);
    });
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function writeJson(response: ServerResponse, statusCode: number, data: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

function extractInstructionLine(data: unknown) {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const maybeLine = (data as { NewLine?: unknown }).NewLine;
  return typeof maybeLine === "string" ? maybeLine : undefined;
}

function extractRecognizedText(lineText: string) {
  let line: RecognizeLine;
  try {
    line = JSON.parse(lineText) as RecognizeLine;
  } catch {
    return undefined;
  }

  if (line.header?.namespace !== "SpeechRecognizer") {
    return undefined;
  }

  if (line.header?.name !== "RecognizeResult") {
    return undefined;
  }

  if (!line.payload?.is_final) {
    return undefined;
  }

  const text = line.payload.results?.[0]?.text?.trim();
  return text || undefined;
}
