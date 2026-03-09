import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { RustServer } from "./open-xiaoai.js";
import { OpenClawClient } from "./openclaw-client.js";
import { readJsonBody, writeJson } from "./http.js";
import { resolveMediaBaseURL, resolveMediaFileURL } from "./media.js";
import { GatewayRouter } from "./router.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import type {
  DebugRunResult,
  GatewayAction,
  GatewayMessage,
  XiaoAIGatewayConfig,
} from "./types.js";

type XiaoAIEvent = {
  event?: string;
  data?: unknown;
};

type RecognizeLine = {
  header?: {
    dialog_id?: string;
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

type RecognizedCommand = {
  dialogId?: string;
  text: string;
};

type TraceContext = {
  id: string;
  dialogId?: string;
  input: string;
  startedAt: number;
};

export class XiaoAIGateway {
  private readonly client: OpenClawClient;
  private readonly router: GatewayRouter;
  private readonly history: GatewayMessage[] = [];
  private readonly seenCommands = new Map<string, number>();
  private traceSeq = 0;

  constructor(private readonly config: XiaoAIGatewayConfig) {
    this.client = new OpenClawClient(config.openclaw);
    this.router = new GatewayRouter(config.router);
  }

  async start() {
    process.env.OPEN_XIAOAI_SERVER_ADDR = `0.0.0.0:${this.config.server.port}`;

    (global as typeof globalThis & { RUST_CALLBACKS: Record<string, unknown> }).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onInputData,
    };

    await this.startDebugServer();
    console.log("✅ XiaoAI gateway 已启动...");
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

      const recognized = extractRecognizedText(lineText);
      if (!recognized) {
        return;
      }

      await this.handleRecognizedText(recognized);
    }
  };

  private async handleRecognizedText(recognized: RecognizedCommand) {
    const { dialogId, text } = recognized;
    const trace = this.createTrace(text, dialogId);
    this.logTrace(trace, "received_final_asr");

    const dedupeKey = dialogId?.trim() || text;
    const previousAt = this.seenCommands.get(dedupeKey);
    if (this.router.shouldDedupe(previousAt)) {
      this.logTrace(trace, `deduped_skip key=${dedupeKey}`);
      return;
    }
    this.seenCommands.set(dedupeKey, Date.now());

    console.log(`🔥 收到指令: ${text}`);
    await this.runText(text, { trace });
  }

  async runText(text: string, options?: { execute?: boolean; trace?: TraceContext }): Promise<DebugRunResult> {
    const execute = options?.execute ?? true;
    const trace = options?.trace ?? this.createTrace(text);
    const decision = this.router.decide(text);
    this.logTrace(trace, `route type=${decision.type}`);

    if (execute) {
      const stageStartedAt = Date.now();
      await this.syncDialogMode(trace, decision.type, decision.text);
      this.logTrace(trace, `sync_dialog_mode_done cost=${Date.now() - stageStartedAt}ms`);
    }

    if (decision.type === "ignore") {
      this.logTrace(trace, "ignore");
      return {
        input: text,
        routedAs: decision.type,
        normalizedText: decision.text,
        executed: false,
      };
    }

    if (execute) {
      const stageStartedAt = Date.now();
      await this.prepareGatewayCommand(decision.type);
      this.logTrace(trace, `prepare_gateway_done cost=${Date.now() - stageStartedAt}ms`);
    }

    if (decision.type === "home_control") {
      if (execute) {
        const stageStartedAt = Date.now();
        await OpenXiaoAISpeaker.askXiaoAI(decision.text, { silent: true });
        this.logTrace(trace, `ask_xiaoai_done cost=${Date.now() - stageStartedAt}ms`);
      }
      this.logTrace(trace, "done");
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

    const messages = this.buildMessages(decision.text);
    this.logTrace(trace, `openclaw_request_start messages=${messages.length}`);
    const llmStartedAt = Date.now();
    const reply = await this.client.chat(messages);
    this.logTrace(trace, `openclaw_reply_done cost=${Date.now() - llmStartedAt}ms chars=${reply.length}`);
    const action = this.client.normalizeAction(reply);
    this.logTrace(trace, `normalized_action type=${action.action}`);

    if (execute) {
      const stageStartedAt = Date.now();
      await this.executeAction(action, decision.text);
      this.logTrace(trace, `execute_action_done cost=${Date.now() - stageStartedAt}ms`);
    }

    this.logTrace(trace, "done");
    return {
      input: text,
      routedAs: decision.type,
      normalizedText: decision.text,
      reply,
      action,
      executed: execute,
    };
  }

  private createTrace(text: string, dialogId?: string): TraceContext {
    this.traceSeq += 1;
    return {
      id: `${this.traceSeq}`,
      dialogId,
      input: text,
      startedAt: Date.now(),
    };
  }

  private logTrace(trace: TraceContext, stage: string) {
    const elapsed = Date.now() - trace.startedAt;
    const dialog = trace.dialogId ? ` dialog=${trace.dialogId}` : "";
    console.log(`⏱️ [gateway#${trace.id}] +${elapsed}ms ${stage}${dialog} text=${trace.input}`);
  }

  private async syncDialogMode(trace: TraceContext, routeType: DebugRunResult["routedAs"], text: string) {
    const dialogId = trace.dialogId?.trim();
    if (!dialogId) {
      return;
    }

    const allowNative = routeType === "home_control" || routeType === "ignore";
    const ok = await RustServer.set_dialog_mode(dialogId, allowNative, text);
    if (!ok) {
      console.warn(`⚠️ 同步对话模式失败 dialog=${dialogId} allowNative=${allowNative}`);
    }
  }

  private async interruptCurrentAudio() {
    const paused = await OpenXiaoAISpeaker.setPlaying(false);
    const stopped = await OpenXiaoAISpeaker.wakeUp(false);

    if (paused || stopped) {
      if (paused && stopped) {
        console.log("⚡️ 已暂停本地播放并软打断小爱");
        return {
          ok: true,
          method: "pause+soft",
        };
      }

      if (paused) {
        console.log("⚡️ 已暂停当前本地播放");
        return {
          ok: true,
          method: "pause",
        };
      }

      console.log("⚡️ 软打断小爱成功");
      return {
        ok: true,
        method: "soft",
      };
    }

    console.log("⚠️ 软打断失败，回退重启 mico_aivs_lab");
    const restarted = await OpenXiaoAISpeaker.abortXiaoAI();
    if (restarted && this.config.speaker.abortRecoveryMs > 0) {
      await sleep(this.config.speaker.abortRecoveryMs);
    }

    return {
      ok: restarted,
      method: "restart",
    };
  }

  private async prepareGatewayCommand(routeType: "home_control" | "openclaw") {
    if (!this.config.speaker.abortXiaoAIOnOpenClaw) {
      return;
    }

    if (routeType === "home_control") {
      return;
    }

    await this.interruptCurrentAudio();
  }

  private buildMessages(text: string): GatewayMessage[] {
    const messages: GatewayMessage[] = [];

    if (this.config.openclaw.systemPrompt) {
      messages.push({
        role: "system",
        content: this.config.openclaw.systemPrompt,
      });
    }

    if (this.config.openclaw.historyMaxLength > 0) {
      const history = this.history.slice(-this.config.openclaw.historyMaxLength);
      messages.push(...history);
    }

    messages.push({
      role: "user",
      content: text,
    });
    return messages;
  }

  private async executeAction(action: GatewayAction, userText: string) {
    if (action.action === "no_reply") {
      this.pushHistory(userText, "NO_REPLY");
      return;
    }

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
        console.log(`✅ Gateway API 已启动: http://127.0.0.1:${this.config.server.debugPort}`);
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
      const speakerStatus = await OpenXiaoAISpeaker.getPlaying(true);
      const micStatus = await OpenXiaoAISpeaker.getMic();
      const device = await OpenXiaoAISpeaker.getDevice();
      writeJson(response, 200, {
        ok: true,
        speakerStatus,
        micStatus,
        device,
        agentId: this.config.openclaw.agentId ?? "main",
        sessionUser: this.config.openclaw.sessionUser,
        historyLength: this.history.length,
        dedupeCacheSize: this.seenCommands.size,
        mediaAssetBaseURL: resolveMediaBaseURL(this.config.media),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/device") {
      const device = await OpenXiaoAISpeaker.getDevice();
      writeJson(response, 200, {
        ok: true,
        ...device,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interrupt") {
      const result = await this.interruptCurrentAudio();
      const speakerStatus = await OpenXiaoAISpeaker.getPlaying(true);
      writeJson(response, 200, {
        ...result,
        speakerStatus,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pause") {
      const ok = await OpenXiaoAISpeaker.setPlaying(false);
      const speakerStatus = await OpenXiaoAISpeaker.getPlaying(true);
      writeJson(response, 200, {
        ok,
        speakerStatus,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/resume") {
      const ok = await OpenXiaoAISpeaker.setPlaying(true);
      const speakerStatus = await OpenXiaoAISpeaker.getPlaying(true);
      writeJson(response, 200, {
        ok,
        speakerStatus,
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
      const ok = await OpenXiaoAISpeaker.play({ text: body.text });
      const speakerStatus = await OpenXiaoAISpeaker.getPlaying(true);
      writeJson(response, 200, {
        ok,
        text: body.text,
        speakerStatus,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/play") {
      const body = await readJsonBody<{ url?: string }>(request);
      if (!body.url?.trim()) {
        writeJson(response, 400, { error: "url is required" });
        return;
      }
      const ok = await OpenXiaoAISpeaker.play({ url: body.url });
      const speakerStatus = await OpenXiaoAISpeaker.getPlaying(true);
      writeJson(response, 200, {
        ok,
        url: body.url,
        speakerStatus,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ask-xiaoai") {
      const body = await readJsonBody<{ text?: string; silent?: boolean }>(request);
      if (!body.text?.trim()) {
        writeJson(response, 400, { error: "text is required" });
        return;
      }
      const silent = body.silent ?? false;
      const ok = await OpenXiaoAISpeaker.askXiaoAI(body.text, { silent });
      writeJson(response, 200, {
        ok,
        text: body.text,
        silent,
      });
      return;
    }

    writeJson(response, 404, { error: "not found" });
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractInstructionLine(data: unknown) {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const maybeLine = (data as { NewLine?: unknown }).NewLine;
  return typeof maybeLine === "string" ? maybeLine : undefined;
}

function extractRecognizedText(lineText: string): RecognizedCommand | undefined {
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
  if (!text) {
    return undefined;
  }

  return {
    dialogId: line.header?.dialog_id,
    text,
  };
}
