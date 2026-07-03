import { DEFAULT_SETTINGS } from "../constants";
import type {
  InlineCompletionKeymap,
  InlineCompletionSettings,
  LlmThinkingMode,
} from "../types";

/**
 * Coerce an arbitrary persisted `inlineCompletion` blob (possibly missing,
 * possibly partial — this feature ships after existing installs) into a
 * complete, valid settings object. Deep-merges over the bundled defaults so
 * unknown new fields never get lost and old users upgrade cleanly.
 */
export function migrateInlineCompletion(loaded: unknown): InlineCompletionSettings {
  const base = DEFAULT_SETTINGS.inlineCompletion;
  const src = (loaded ?? {}) as Partial<InlineCompletionSettings> & {
    keymap?: Partial<InlineCompletionKeymap>;
    contextBeforeChars?: unknown;
    contextAfterChars?: unknown;
    contextChars?: unknown;
    /** Legacy combined prompt from older versions. */
    systemPrompt?: unknown;
  };

  const enabled = typeof src.enabled === "boolean" ? src.enabled : base.enabled;
  const armed = typeof src.armed === "boolean" ? src.armed : base.armed;
  const providerId =
    typeof src.providerId === "string" && src.providerId ? src.providerId : base.providerId;
  const modelId =
    typeof src.modelId === "string" && src.modelId ? src.modelId : base.modelId;
  const thinkingMode: LlmThinkingMode =
    src.thinkingMode === "on" ||
    src.thinkingMode === "off" ||
    src.thinkingMode === "custom"
      ? src.thinkingMode
      : base.thinkingMode;
  const thinkingCustom =
    typeof src.thinkingCustom === "string" ? src.thinkingCustom : undefined;

  const km: Partial<InlineCompletionKeymap> = src.keymap ?? {};
  const keymap: InlineCompletionKeymap = {
    accept: typeof km.accept === "string" ? km.accept : base.keymap.accept,
    reject: typeof km.reject === "string" ? km.reject : base.keymap.reject,
    cancel: typeof km.cancel === "string" ? km.cancel : base.keymap.cancel,
    request: typeof km.request === "string" ? km.request : base.keymap.request,
  };

  const clamp = (value: unknown, fallback: number, min: number): number => {
    if (value === "" || value === null || value === undefined) return fallback;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.floor(n));
  };

  return {
    enabled,
    armed: enabled ? armed : false,
    providerId,
    modelId,
    thinkingMode,
    thinkingCustom,
    keymap,
    debounceMs: clamp(src.debounceMs, base.debounceMs, 50),
    contextBeforeChars: clamp(
      src.contextBeforeChars,
      clamp(src.contextChars, base.contextBeforeChars, 100),
      100,
    ),
    contextAfterChars: clamp(
      src.contextAfterChars,
      clamp(src.contextChars, base.contextAfterChars, 100),
      100,
    ),
    maxChars: clamp(src.maxChars, base.maxChars, 10),
    maxLines: clamp(src.maxLines, base.maxLines, 1),
    ...migrateSystemPromptFields(src, base),
    rejectPrompt:
      typeof src.rejectPrompt === "string" ? src.rejectPrompt : base.rejectPrompt,
  };
}

/**
 * Migrate the legacy combined `systemPrompt` into the new split fields.
 * - If the new fields already exist, use them directly.
 * - If only the legacy `systemPrompt` exists, split it by the sentinel line.
 * - Otherwise, fall back to defaults.
 */
function migrateSystemPromptFields(
  src: {
    systemPromptBody?: string;
    noCompletionPrompt?: string;
    systemPrompt?: unknown;
  },
  base: { systemPromptBody: string; noCompletionPrompt: string },
): { systemPromptBody: string; noCompletionPrompt: string } {
  // New fields take priority.
  const hasBody = typeof src.systemPromptBody === "string";
  const hasNoComp = typeof src.noCompletionPrompt === "string";
  if (hasBody && hasNoComp) {
    return {
      systemPromptBody: src.systemPromptBody as string,
      noCompletionPrompt: src.noCompletionPrompt as string,
    };
  }

  // Legacy combined prompt — split heuristically by the sentinel line.
  if (typeof src.systemPrompt === "string" && src.systemPrompt) {
    const legacy = src.systemPrompt as string;
    const sentinelPattern = /#\s*强调[：:][^\n]*<[^>]+NO_COMPLETION>[^\n]*/;
    const oldSentinelPattern = /如果上下文已经完整[^\n]*<[^>]+NO_COMPLETION>[^\n]*/;
    const match =
      legacy.match(sentinelPattern) ?? legacy.match(oldSentinelPattern);
    if (match && match.index !== undefined) {
      return {
        systemPromptBody: legacy.slice(0, match.index).trimEnd(),
        noCompletionPrompt: match[0],
      };
    }
    // No sentinel found — treat entire legacy prompt as body.
    return {
      systemPromptBody: legacy,
      noCompletionPrompt: base.noCompletionPrompt,
    };
  }

  // Nothing saved — use defaults.
  return {
    systemPromptBody: hasBody ? (src.systemPromptBody as string) : base.systemPromptBody,
    noCompletionPrompt: hasNoComp
      ? (src.noCompletionPrompt as string)
      : base.noCompletionPrompt,
  };
}
