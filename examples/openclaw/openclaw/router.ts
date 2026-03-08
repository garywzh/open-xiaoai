import type { BridgeAction, OpenClawBridgeConfig, RouteDecision } from "./types.js";

const AUDIO_URL_PATTERN = /(https?:\/\/\S+\.(?:mp3|wav|m4a|aac|flac))(?:\?\S*)?/i;

export class BridgeRouter {
  private readonly homePatterns: RegExp[];
  private readonly mediaPatterns: RegExp[];

  constructor(private readonly config: OpenClawBridgeConfig["router"]) {
    this.homePatterns = compilePatterns(config.homePatterns);
    this.mediaPatterns = compilePatterns(config.mediaPatterns);
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

    const matchedAudioUrl = effectiveText.match(AUDIO_URL_PATTERN)?.[1];

    if (matchedAudioUrl && this.matchesMediaRule(effectiveText)) {
      return {
        type: "play_url_direct",
        text: effectiveText,
        url: matchedAudioUrl,
      };
    }

    if (this.matchesNativeWhitelistRule(effectiveText)) {
      return {
        type: "ignore",
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

  private matchesMediaRule(text: string) {
    return this.matchesPattern(text, this.mediaPatterns) || this.includesAny(text, this.config.mediaKeywords);
  }

  private matchesNativeWhitelistRule(text: string) {
    return this.matchesHomeRule(text) || this.matchesMediaRule(text);
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
