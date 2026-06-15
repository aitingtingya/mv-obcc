type ContentBlock = Record<string, unknown>;

function asBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

export function moveMessageSystemBlocks<T>(input: T): T {
  if (!input || typeof input !== "object") return input;

  const body = structuredClone(input) as Record<string, unknown>;
  if (!Array.isArray(body.messages)) return input;

  const output: Array<Record<string, unknown>> = [];
  let lastUser: { message: Record<string, unknown>; blocks: ContentBlock[] } | null = null;
  let pending: ContentBlock[] = [];

  for (const raw of body.messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const message = { ...(raw as Record<string, unknown>) };
    if (message.role === "system") {
      const blocks = asBlocks(message.content);
      if (lastUser) {
        lastUser.blocks.push(...blocks);
      } else {
        pending.push(...blocks);
      }
      continue;
    }

    if (message.role === "user") {
      const blocks = [...pending, ...asBlocks(message.content)];
      pending = [];
      message.content = blocks;
      lastUser = { message, blocks };
      output.push(message);
    } else {
      output.push(message);
      lastUser = null;
    }
  }

  if (pending.length > 0) {
    body.system = [...asBlocks(body.system), ...pending];
  }

  body.messages = output;
  return body as T;
}
