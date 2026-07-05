export const DIFF_VIEW_TYPE = "mv-senceai-ide-diff";
export const TERMINAL_VIEW_TYPE = "mv-terminal-view";
export const PLUGIN_ID = "mv-senceai-ide";
export const IDE_NAME = "Obsidian";
export const SERVER_HOST = "127.0.0.1";
export const PORT_BASE = 47000;
export const PORT_SPAN = 1500;
export const MCP_SERVER_NAME = "mv-senceai-ide";
export const TERMINAL_MARKER_PREFIX = "mv-senceai-ide:";
export const MANAGED_HOOK_MARKER = "mv-senceai-ide-terminal-marker-v1";
export const WINDOWS_MCP_REGISTRATION_VERSION = 1;

/**
 * Main body of the default inline-completion system prompt (role + rules 1-3).
 */
export const DEFAULT_INLINE_SYSTEM_PROMPT_BODY =
  "# 你是一个 Obsidian 行内补全助手。" +
  "用户输入的是 Markdown 源文本片段，包括普通文字、md 公式、代码块、表格、链接和标点都必须视为纯文本上下文。" +
  "光标位置由专门标记指出。你的补全要满足下列要求\n" +
  "1. 只输出应该插入到光标处的补全文本本身\n" +
  "2. 注意md的行内公式格式和latex一样，但是行间公式必须用双$包围，比如\n" +
  "$$\n这是一个行间公式\n$$\n" +
  "3. 不要重复上下文，不要输出你的思考过程，不要解释，不要添加代码块围栏";

/**
 * No-completion sentinel instruction (rule 4).
 * The sentinel `<MV_SENCEAI_NO_COMPLETION>` must be preserved so the protocol
 * layer can detect "no completion" responses.
 */
export const DEFAULT_INLINE_NO_COMPLETION_PROMPT =
  "# 强调：如果上下文已经完整、继续续写会编造或你没有高置信补全，" +
  "请只输出 <MV_SENCEAI_NO_COMPLETION>";

/**
 * User message sent after rejecting an inline-completion candidate.
 * `{rejected}` is replaced with the exact rejected ghost text.
 */
export const DEFAULT_INLINE_REJECT_PROMPT =
  "上一条 assistant 消息是用户刚刚拒绝的行内补全候选，不是 Markdown 正文，也不是需要继续续写的前缀。\n" +
  "请基于原始 Markdown 光标上下文，生成一个插入到同一光标位置的替代补全，只输出新补全文本本身。\n" +
  "不要续写、复用、扩展或轻微改写被拒绝候选；如果没有明显更好的替代，请只输出 <MV_SENCEAI_NO_COMPLETION>。\n" +
  "被拒绝候选如下，仅用于避开：\n<rejected_completion>\n{rejected}\n</rejected_completion>";

/**
 * Full default system prompt (body + no-completion), concatenated.
 */
export const DEFAULT_INLINE_SYSTEM_PROMPT =
  DEFAULT_INLINE_SYSTEM_PROMPT_BODY + "\n" + DEFAULT_INLINE_NO_COMPLETION_PROMPT;

export const DEFAULT_SETTINGS = {
  upstreamMode: "native" as const,
  upstreamBaseUrl: "",
  autoManageClaudeSettings: true,
  previousLocalBaseUrl: null,
  managedLocalBaseUrl: null,
  activityTracking: {
    supportAllActivePages: false,
    trackMarkdown: true,
    trackPdf: true,
    trackWebview: true,
  },
  preserveSelectionHighlights: true,
  toolToggles: {
    getLatestSelection: true,
    getOpenEditors: true,
    openFile: true,
    readCurrentWebPage: false,
  },
  toolContextLimits: {
    readCurrentWebPage: null,
  },
  ideIntegrations: {
    claudeCode: true,
    codex: false,
  },
  llm: {
    enabled: false,
    providers: [
      {
        id: "openai-default",
        name: "OpenAI",
        type: "openai" as const,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        models: [{ id: "gpt-4o-mini", name: "gpt-4o-mini" }],
        useProxy: false,
      },
    ],
    templates: [
      {
        id: "translate",
        label: "翻译成中文",
        prompt: "请把以下内容翻译成中文，只输出译文：\n\n{selection}",
        enabled: true,
        providerId: null,
        modelId: null,
        thinkingMode: "default" as const,
      },
      {
        id: "summarize",
        label: "总结",
        prompt: "请用简洁的中文总结以下内容要点：\n\n{selection}",
        enabled: true,
        providerId: null,
        modelId: null,
        thinkingMode: "default" as const,
      },
      {
        id: "polish",
        label: "润色",
        prompt:
          "请润色以下文字，保持原意，输出更流畅自然的表达，只输出结果：\n\n{selection}",
        enabled: true,
        providerId: null,
        modelId: null,
        thinkingMode: "default" as const,
      },
    ],
    webContextMenu: false,
    windowGeometry: null,
    autoTriggerTemplateId: null,
  },
  inlineCompletion: {
    enabled: false,
    armed: false,
    providerId: null,
    modelId: null,
    thinkingMode: "default" as const,
    keymap: {
      accept: "Tab",
      reject: "",
      cancel: "Escape",
      request: "",
    },
    // Conservative defaults (per product decision): fewer tokens, fewer surprises.
    debounceMs: 700,
    contextBeforeChars: 2000,
    contextAfterChars: 2000,
    maxChars: 200,
    maxLines: 3,
    systemPromptBody: DEFAULT_INLINE_SYSTEM_PROMPT_BODY,
    noCompletionPrompt: DEFAULT_INLINE_NO_COMPLETION_PROMPT,
    rejectPrompt: DEFAULT_INLINE_REJECT_PROMPT,
  },
  sourceAssist: {
    enabled: true,
    snippetsEnabled: true,
    suppressSnippetTriggerOnIME: true,
    removeSnippetWhitespace: true,
    mathPreviewEnabled: true,
    mathPreviewPositionIsAbove: true,
    mathPreviewCursor: "▶",
    mathPreviewBracketHighlighting: false,
    wordDelimiters: "., +-\\n\t:;!?\\/{}[]()=~$'\"|`<>*^%#@&",
    snippetDebug: "off" as const,
    snippetRecursion: 0,
    profiles: [
      {
        id: "source-assist-md",
        extension: "md",
        enabled: true,
        snippets: "export default []",
        snippetsTrigger: "Tab",
        snippetNextTabstopTrigger: "Tab",
        snippetPreviousTabstopTrigger: "Shift-Tab",
        texEnhancedRenderEnabled: false,
      },
    ],
  },
  mcpEnabled: true,
  mcpAuthToken: "",
  claudeExecutable: "",
  codexExecutable: "codex",
  registeredMcpUrl: null,
  windowsMcpRegistrationVersion: 0,
  terminalMacShellPath: "",
  terminalMacShellArgs: "",
  terminalWinShellPath: "",
  terminalWinShellArgs: "",
  terminalPythonPath: "",
  terminalFontFamily: "",
  terminalFontSize: "",
  terminalOpenPosition: "right",
};
