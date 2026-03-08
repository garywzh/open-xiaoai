import type { BridgeAction, OpenClawBridgeConfig, RouteDecision } from "./types.js";

export class BridgeRouter {
  private readonly homePatterns: RegExp[];

  constructor(private readonly config: OpenClawBridgeConfig["router"]) {
    this.homePatterns = compilePatterns(config.homePatterns);
  }

  decide(text: string): RouteDecision {
    const normalizedText = text.trim();
    if (!normalizedText) {
      return {
        type: "ignore",
        text: normalizedText,
      };
    }

    const effectiveText = this.normalizeBridgeText(normalizedText).trim();
    if (!effectiveText) {
      return {
        type: "ignore",
        text: normalizedText,
      };
    }

    if (this.matchesHomeRule(effectiveText)) {
      return {
        type: "home_control",
        text: effectiveText,
      };
    }

    return {
      type: "openclaw",
      text: effectiveText,
    };
  }

  shouldDedupe(previousAt: number | undefined) {
    if (!previousAt) {
      return false;
    }
    return Date.now() - previousAt < this.config.dedupeWindowMs;
  }

  normalizeFallbackAction(text: string): BridgeAction {
    return {
      action: "reply_text",
      text,
    };
  }

  private includesAny(text: string, keywords: string[]) {
    return keywords.some((keyword) => text.includes(keyword));
  }

  private matchesPattern(text: string, patterns: RegExp[]) {
    return patterns.some((pattern) => pattern.test(text));
  }

  private matchesHomeRule(text: string) {
    return this.matchesPattern(text, this.homePatterns) || this.includesAny(text, this.config.homeKeywords);
  }

  private normalizeBridgeText(text: string) {
    for (const keyword of this.config.assistantKeywords) {
      if (text === keyword) {
        return "";
      }

      if (text.startsWith(keyword)) {
        return text.slice(keyword.length).trimStart();
      }
    }

    return text;
  }
}

function compilePatterns(patterns: string[]) {
  return patterns
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .flatMap((pattern) => {
      try {
        return [new RegExp(pattern, "i")];
      } catch {
        return [];
      }
    });
}
