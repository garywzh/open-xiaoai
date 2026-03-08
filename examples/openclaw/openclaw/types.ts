export interface OpenClawBridgeConfig {
  server: {
    port: number;
    debugPort: number;
  };
  media: {
    host: string;
    port: number;
    rootDir: string;
    publicOrigin?: string;
  };
  openclaw: {
    baseURL: string;
    endpoint: string;
    token?: string;
    model: string;
    agentId?: string;
    sessionUser?: string;
    sessionKey?: string;
    timeoutMs: number;
    temperature?: number;
    historyMaxLength: number;
    systemPrompt?: string;
    extraHeaders?: Record<string, string>;
  };
  router: {
    dedupeWindowMs: number;
    assistantKeywords: string[];
    homeKeywords: string[];
    homePatterns: string[];
    mediaKeywords: string[];
    mediaPatterns: string[];
  };
  speaker: {
    ttsBlocking: boolean;
    defaultPlayTimeout: number;
    abortXiaoAIOnOpenClaw: boolean;
    abortRecoveryMs: number;
  };
}

export interface BridgeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type BridgeAction =
  | {
      action: "reply_text";
      text: string;
    }
  | {
      action: "play_file";
      file: string;
    }
  | {
      action: "play_url";
      url: string;
    }
  | {
      action: "ask_xiaoai";
      text: string;
    }
  | {
      action: "no_reply";
    };

export interface RouteDecision {
  type: "ignore" | "home_control" | "play_url_direct" | "openclaw";
  text: string;
  url?: string;
}

export interface DebugRunResult {
  input: string;
  routedAs: RouteDecision["type"];
  normalizedText: string;
  reply?: string;
  action?: BridgeAction;
  executed: boolean;
}

export interface OpenAIMessageContentPart {
  type?: string;
  text?: string;
}

export interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | OpenAIMessageContentPart[] | null;
    };
  }>;
}
