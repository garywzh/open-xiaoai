export interface XiaoAIMediaAssetConfig {
  host: string;
  port: number;
  rootDir: string;
  publicOrigin?: string;
}

export interface XiaoAIMediaLibraryConfig {
  apiHost: string;
  apiPort: number;
  indexFile: string;
  downloadSubdir: string;
  proxy?: string;
  cookiesPath?: string;
  ytDlpBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
}

export interface OpenClawAgentConfig {
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
}

export interface GatewayRouterConfig {
  dedupeWindowMs: number;
  assistantKeywords: string[];
  homeKeywords: string[];
  homePatterns: string[];
}

export interface XiaoAISpeakerControlConfig {
  ttsBlocking: boolean;
  defaultPlayTimeout: number;
  abortXiaoAIOnOpenClaw: boolean;
  abortRecoveryMs: number;
}

export interface XiaoAIGatewayConfig {
  server: {
    port: number;
    debugPort: number;
  };
  media: XiaoAIMediaAssetConfig;
  openclaw: OpenClawAgentConfig;
  router: GatewayRouterConfig;
  speaker: XiaoAISpeakerControlConfig;
}

export interface XiaoAIMediaLibraryServiceConfig {
  media: XiaoAIMediaAssetConfig;
  library: XiaoAIMediaLibraryConfig;
}

export interface OpenClawRuntimeConfig {
  gateway: XiaoAIGatewayConfig;
  mediaLibraryService: XiaoAIMediaLibraryServiceConfig;
}

export interface GatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type GatewayAction =
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

export type BridgeMessage = GatewayMessage;
export type BridgeAction = GatewayAction;
export type OpenClawBridgeConfig = XiaoAIGatewayConfig & {
  library: XiaoAIMediaLibraryConfig;
};

export interface RouteDecision {
  type: "ignore" | "home_control" | "openclaw";
  text: string;
}

export interface DebugRunResult {
  input: string;
  routedAs: RouteDecision["type"];
  normalizedText: string;
  reply?: string;
  action?: GatewayAction;
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
