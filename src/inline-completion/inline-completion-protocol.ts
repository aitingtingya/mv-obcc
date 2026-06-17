import type { InlineCompletionSettings } from "../types";

export const NO_COMPLETION_SENTINEL = "<MV_SENCEAI_NO_COMPLETION>";

export function truncateInlineCompletion(
  text: string,
  cfg: Pick<InlineCompletionSettings, "maxChars" | "maxLines">,
): string {
  let result = text;
  if (cfg.maxLines > 0) {
    const lines = result.split("\n");
    if (lines.length > cfg.maxLines) {
      result = lines.slice(0, cfg.maxLines).join("\n");
    }
  }
  if (cfg.maxChars > 0 && result.length > cfg.maxChars) {
    result = result.slice(0, cfg.maxChars);
  }
  return result;
}

export function isNoCompletionResponse(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || trimmed.startsWith(NO_COMPLETION_SENTINEL);
}

export function shouldHoldCompletionStream(text: string): boolean {
  const pending = text.trimStart();
  if (!pending) return true;
  return (
    NO_COMPLETION_SENTINEL.startsWith(pending) ||
    pending.startsWith(NO_COMPLETION_SENTINEL)
  );
}

export function displayableCompletionStreamText(
  text: string,
  cfg: Pick<InlineCompletionSettings, "maxChars" | "maxLines">,
): string | null {
  if (shouldHoldCompletionStream(text)) return null;
  const truncated = truncateInlineCompletion(text, cfg);
  return truncated ? truncated : null;
}

export function finalCompletionText(
  text: string,
  cfg: Pick<InlineCompletionSettings, "maxChars" | "maxLines">,
): string | null {
  if (isNoCompletionResponse(text)) return null;
  const truncated = truncateInlineCompletion(text, cfg);
  return truncated ? truncated : null;
}
