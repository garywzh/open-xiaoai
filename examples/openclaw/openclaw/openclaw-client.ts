import type {
  BridgeAction,
  BridgeMessage,
  OpenAIChatCompletionResponse,
  OpenClawBridgeConfig,
} from "./types.js";

export class OpenClawClient {
  constructor(private readonly config: OpenClawBridgeConfig["openclaw"]) {}

  async chat(messages: BridgeMessage[]): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.extraHeaders ?? {}),
    };

    if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }

    if (this.config.agentId) {
      headers["x-openclaw-agent-id"] = this.config.agentId;
    }

    if (this.config.sessionKey) {
      headers["x-openclaw-session-key"] = this.config.sessionKey;
    }

    const response = await fetch(`${this.config.baseURL}${this.config.endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature ?? 0.3,
        user: this.config.sessionUser,
        messages,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenClaw HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenAIChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenClaw 响应为空");
    }

    if (typeof content === "string") {
      return content.trim();
    }

    const text = content
      .map((part) => part.text?.trim())
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("OpenClaw 返回了空内容片段");
    }

    return text;
  }

  normalizeAction(reply: string): BridgeAction {
    const raw = unwrapJsonCodeFence(reply);
    if (isNoReplyToken(raw)) {
      return { action: "no_reply" };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<BridgeAction>;
      if (parsed.action === "no_reply") {
        return { action: "no_reply" };
      }
      if (parsed.action === "play_url" && typeof parsed.url === "string") {
        return { action: "play_url", url: parsed.url };
      }
      if (parsed.action === "ask_xiaoai" && typeof parsed.text === "string") {
        return { action: "ask_xiaoai", text: parsed.text };
      }
      if (parsed.action === "reply_text" && typeof parsed.text === "string") {
        return { action: "reply_text", text: parsed.text };
      }
      if (parsed.action === "play_file" && typeof parsed.file === "string") {
        return { action: "play_file", file: parsed.file };
      }
    } catch {
      return { action: "reply_text", text: reply };
    }

    return { action: "reply_text", text: reply };
  }
}

function isNoReplyToken(text: string) {
  const normalized = text.trim();
  return /^(?:\[\[\s*NO_REPLY\s*\]\]|NO_REPLY)$/i.test(normalized)
    || normalized === "No response from OpenClaw."
    || normalized === "No reply from agent.";
}

function unwrapJsonCodeFence(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}
