export const INLINE_CURSOR_MARKER = "<|mv-senceai-cursor|>";

export interface InlineCursorContext {
  before: string;
  after: string;
}

export function buildInlineCursorContext(
  doc: string,
  cursor: number,
  beforeChars: number,
  afterChars = beforeChars,
): InlineCursorContext {
  const head = Math.max(0, Math.min(cursor, doc.length));
  const beforeLimit = Math.max(0, Math.floor(beforeChars));
  const afterLimit = Math.max(0, Math.floor(afterChars));
  const beforeFrom = Math.max(0, head - beforeLimit);
  const afterTo = Math.min(doc.length, head + afterLimit);
  return {
    before: doc.slice(beforeFrom, head),
    after: doc.slice(head, afterTo),
  };
}

export function buildInlineCompletionUserMessage(
  context: InlineCursorContext,
): string {
  return (
    "下面是 Markdown 源文本片段。光标位置用 " +
    INLINE_CURSOR_MARKER +
    " 标记。\n" +
    "请只输出应该插入到光标处的补全文本，不要重复已有上下文，不要解释。\n\n" +
    "```markdown\n" +
    context.before +
    INLINE_CURSOR_MARKER +
    context.after +
    "\n```"
  );
}
