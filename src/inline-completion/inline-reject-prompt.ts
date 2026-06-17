import { DEFAULT_INLINE_REJECT_PROMPT } from "../constants";

const REJECTED_PLACEHOLDER = "{rejected}";

export function buildRejectUserMessage(
  template: string | undefined,
  rejectedText: string,
): string {
  const source = template?.trim() ? template : DEFAULT_INLINE_REJECT_PROMPT;
  return source.replaceAll(REJECTED_PLACEHOLDER, () => rejectedText);
}
