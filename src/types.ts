import type { ManagedCopyState } from "./managed-copy-fallback";
import type { LintSettings } from "./lint/lint-types";
import type { RegexReplaceSettings } from "./regex-replace/regex-replace-types";
import type { MvRunSettings } from "./terminal/mv-run-types";
import type { VimSettings } from "./vim/settings";
import type { DshSettings } from "./dsh/dsh-settings";

export type UpstreamMode = "native" | "compatibility";

export interface ToolToggles {
  getLatestSelection: boolean;
  getOpenEditors: boolean;
  openFile: boolean;
  readCurrentWebPage: boolean;
  getDiagnostics: boolean;
  getTerminalOutput: boolean;
  searchVaultSymbols: boolean;
  getBacklinks: boolean;
  getOutgoingLinks: boolean;
  searchTags: boolean;
  listNotesByTag: boolean;
}

export interface ActivityTrackingSettings {
  supportAllActivePages: boolean;
  trackMarkdown: boolean;
  trackPdf: boolean;
  trackWebview: boolean;
  /** 被动推送 lint 错误计数（只推错误不推警告；仅在该类型 lint 跑过时产生）。 */
  pushLintErrors: boolean;
  /** selection_changed 快照附 heading 面包屑（仅 md/tex）。 */
  includeHeadingBreadcrumb: boolean;
}

export interface ToolContextLimits {
  /** Null means return the complete content without plugin-side truncation. */
  readCurrentWebPage: number | null;
}

export interface IdeIntegrationSettings {
  /** Claude Code IDE bridge. Fresh installs keep the original behavior enabled. */
  claudeCode: boolean;
  /** Codex CLI /ide context provider and managed MCP config. Fresh installs default off. */
  codex: boolean;
}

/** Independent authorization for the opt-in universal IDE MCP endpoint. */
export interface UniversalMcpSettings {
  enabled: boolean;
  authToken: string | null;
}

export type LlmProviderType = "openai" | "anthropic";

/** How a model wants "thinking" params applied (gated by the template toggle). */
export type LlmThinkingMode = "default" | "on" | "off" | "custom";

/** A model entry within a provider (the `name` is the value sent to the API). */
export interface LlmModelEntry {
  /** Stable id for cross-references from templates. */
  id: string;
  /** Display name AND actual model string sent to the API, e.g. "GLM-5.1". */
  name: string;
}

/** A connectable API provider with its own credentials and model list. */
export interface LlmProviderConfig {
  id: string;
  /** User-visible name, e.g. "白山". */
  name: string;
  type: LlmProviderType;
  baseUrl: string;
  apiKey: string;
  models: LlmModelEntry[];
  /**
   * When true, route requests through Obsidian's requestUrl (Node network
   * stack) to bypass CORS / Origin rejections. Streaming degrades to one-shot.
   */
  useProxy: boolean;
}

export interface LlmPromptTemplate {
  id: string;
  label: string;
  prompt: string;
  /** When false, the template is hidden from menus/commands/hotkeys. */
  enabled: boolean;
  /** Points at LlmProviderConfig.id, or null when unselected. */
  providerId: string | null;
  /** Points at LlmModelEntry.id within the chosen provider, or null. */
  modelId: string | null;
  /** Thinking mode applied per-template. "default" sends nothing (safe). */
  thinkingMode: LlmThinkingMode;
  /** Raw JSON merged into the body when thinkingMode === "custom". */
  thinkingCustom?: string;
}

/**
 * Persisted geometry of the LLM result popover (viewport-relative pixels).
 * Null until the user first drags/resizes the window.
 */
export interface LlmWindowGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LlmFeatureSettings {
  enabled: boolean;
  providers: LlmProviderConfig[];
  templates: LlmPromptTemplate[];
  /**
   * When true, inject a custom right-click menu into webviewer pages (suppressing
   * the page's native context menu). When false, webviewer relies on hotkeys.
   */
  webContextMenu: boolean;
  /** Last known viewport-relative position/size of the popover, or null. */
  windowGeometry: LlmWindowGeometry | null;
  /**
   * Id of an enabled template to auto-trigger on text selection when the
   * session-level ribbon toggle is active. Null = auto-trigger disabled
   * (and the ribbon button is hidden).
   */
  autoTriggerTemplateId: string | null;
}

/**
 * CodeMirror keymap binding strings for inline completion. Each value uses
 * CodeMirror's normalized key format (e.g. "Tab", "Escape", "Cmd-Shift-Enter",
 * "Mod-]"). An empty string means the binding is not registered.
 */
export interface InlineCompletionKeymap {
  /** Accept the current ghost-text completion. Default "Tab". */
  accept: string;
  /**
   * Reject the completion and ask the model for a different one. Empty string
   * = no binding (reject then behaves like a no-op; use cancel instead).
   */
  reject: string;
  /** Dismiss the current ghost-text completion without re-querying. Default "Escape". */
  cancel: string;
  /** Request a completion manually. Empty string = no manual request binding. */
  request: string;
}

/**
 * Independent inline-completion (ghost text) feature settings. Lives as a peer
 * of `llm` under `BridgeSettings`; providers are shared (referenced by id) but
 * the feature is otherwise self-contained.
 */
export interface InlineCompletionSettings {
  /** Master switch. When off the ribbon button is hidden and nothing fires. */
  enabled: boolean;
  /** Session toggle exposed as a ribbon button; persisted so users keep intent across reloads. */
  armed: boolean;
  /** Provider id from the shared `llm.providers` list, or null when unselected. */
  providerId: string | null;
  /** Model id within the chosen provider, or null when unselected. */
  modelId: string | null;
  /** Thinking mode applied to inline completion requests. "default" sends nothing. */
  thinkingMode: LlmThinkingMode;
  /** Raw JSON merged into the request body when thinkingMode === "custom". */
  thinkingCustom?: string;
  keymap: InlineCompletionKeymap;
  /** Idle delay after the last keystroke before requesting a completion. */
  debounceMs: number;
  /** Number of characters before the cursor sent as context. */
  contextBeforeChars: number;
  /** Number of characters after the cursor sent as context. */
  contextAfterChars: number;
  /** Legacy single context limit kept only for migrating older persisted data. */
  contextChars?: number;
  /** Hard cap on completion length (characters). */
  maxChars: number;
  /** Hard cap on completion length (lines). */
  maxLines: number;
  /** Main body of the system prompt (role + rules). Falls back to default when empty. */
  systemPromptBody: string;
  /** No-completion sentinel instruction. Falls back to default when empty. */
  noCompletionPrompt: string;
  /** User message template for reject-and-regenerate. Falls back to default when empty. */
  rejectPrompt: string;
}

export interface SourceAssistProfile {
  id: string;
  /** File extension without the leading dot, for example "md" or "tex". */
  extension: string;
  /** Enables the Latex Suite snippets/tabstop/preview runtime for this profile. */
  latexSuiteEnabled: boolean;
  /** "follow-global" or a built-in/custom source highlight theme id. */
  highlightThemeId: string;
  snippets: string;
  snippetsTrigger: string;
  snippetNextTabstopTrigger: string;
  snippetPreviousTabstopTrigger: string;
  /** Enables the plugin's custom TeX Live Preview extension for .tex files only. */
  texEnhancedRenderEnabled: boolean;
  /** Shows \section-level headings in the core Outline and enables editor folding for .tex files. */
  texOutlineEnabled: boolean;
  /**
   * Custom math formats for the TeX enhanced renderer: an array of
   * `{ 开头, 结尾, 设置 }` entries where 设置 is "n" (inline), "j"
   * (display), "nl"/"jl" (environments). Accepts strict JSON or
   * latex-suite style (bare keys, trailing commas, legacy
   * `export default` prefix); parsed via `JSON.parse` after normalization.
   */
  texMathFormats: string;
}

export type SourceHighlightThemeFormat =
  | "mv-aide-json"
  | "prism-css"
  | "highlight-js-css"
  | "textmate-json";

export type SourceHighlightPaletteKey =
  | "comment"
  | "keyword"
  | "string"
  | "number"
  | "function"
  | "property"
  | "operator"
  | "punctuation";

export interface SourceHighlightTokenStyle {
  color?: string;
  fontStyle?: "normal" | "italic";
  fontWeight?: "normal" | "bold";
  textDecoration?: "none" | "underline";
}

export type SourceHighlightPalette = Partial<
  Record<SourceHighlightPaletteKey, SourceHighlightTokenStyle>
>;

export interface SourceHighlightCustomTheme {
  id: string;
  name: string;
  format: SourceHighlightThemeFormat;
  importedAt: number;
  palette: SourceHighlightPalette;
}

export interface SourceAssistSettings {
  enabled: boolean;
  snippetsEnabled: boolean;
  suppressSnippetTriggerOnIME: boolean;
  removeSnippetWhitespace: boolean;
  mathPreviewEnabled: boolean;
  mathPreviewPositionIsAbove: boolean;
  mathPreviewCursor: string;
  mathPreviewBracketHighlighting: boolean;
  wordDelimiters: string;
  snippetDebug: "off" | "info" | "verbose";
  snippetRecursion: number;
  highlightThemeId: string;
  customHighlightThemes: SourceHighlightCustomTheme[];
  profiles: SourceAssistProfile[];
}

export type ExternalFileOpenerExtensionMode =
  | "markdown-only"
  | "markdown-and-source-assist";

export interface ExternalFileMapping {
  externalPath: string;
  vaultPath: string;
  createdAt: number;
  extension: string;
  /** Missing on legacy mappings, which are always interpreted as symlinks. */
  strategy?: "symlink" | "managed-copy";
  /** Present only for a device-owned managed-copy fallback mapping. */
  managedCopy?: ManagedCopyState;
}

export interface ExternalFileOpenerSettings {
  enabled: boolean;
  extensionMode: ExternalFileOpenerExtensionMode;
  /**
   * 在 extensionMode 决定的基础集合上按后缀单独关闭（小写、不带点）。
   * 缺省 [] 表示不过滤；设置页「支持的后缀范围」折叠区逐后缀维护。
   */
  disabledExtensions: string[];
  mirrorFolder: string;
  mappings: Record<string, ExternalFileMapping>;
  openerToken: string;
  fileTypeIcons: boolean;
}

export type TerminalThemeMode = "obsidian" | "light" | "dark" | "custom";

export interface TerminalThemePalette {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalThemePreset {
  id: string;
  name: string;
  createdAt: number;
  palette: TerminalThemePalette;
}

export interface BridgeSettings {
  upstreamMode: UpstreamMode;
  /** Optional manual override. Empty means resolve from Claude settings. */
  upstreamBaseUrl: string;
  autoManageClaudeSettings: boolean;
  previousLocalBaseUrl: string | null;
  managedLocalBaseUrl: string | null;
  activityTracking: ActivityTrackingSettings;
  preserveSelectionHighlights: boolean;
  /** 文件系统与浏览器：内置浏览器视图工具栏「浏览历史」按钮。 */
  browserHistoryButton: boolean;
  /** 文件系统与浏览器：内置浏览器视图工具栏「下载」按钮。 */
  browserDownloadsButton: boolean;
  /** 文件系统与浏览器：文件资源管理器顶部路径栏增强。 */
  fileExplorerPathBar: boolean;
  /** 文件系统与浏览器：本地文件预览（内置浏览器打开 file:// / 本机绝对路径 / HTML 右键菜单）。 */
  browserLocalFilePreview: boolean;
  /** @deprecated 旧版 UA 补丁设置；保留读取兼容，不再产生运行时行为。 */
  webviewStripElectronUa: boolean;
  toolToggles: ToolToggles;
  toolContextLimits: ToolContextLimits;
  ideIntegrations: IdeIntegrationSettings;
  universalMcp: UniversalMcpSettings;
  llm: LlmFeatureSettings;
  inlineCompletion: InlineCompletionSettings;
  sourceAssist: SourceAssistSettings;
  vim: VimSettings;
  sourceLint: LintSettings;
  regexReplace: RegexReplaceSettings;
  mvRun: MvRunSettings;
  externalFileOpener: ExternalFileOpenerSettings;
  dsh: DshSettings;
  mcpEnabled: boolean;
  mcpAuthToken: string;
  claudeExecutable: string;
  codexExecutable: string;
  registeredMcpUrl: string | null;
  windowsMcpRegistrationVersion: number;
  terminalMacShellPath: string;
  terminalMacShellArgs: string;
  terminalWinShellPath: string;
  terminalWinShellArgs: string;
  terminalPythonPath: string;
  terminalFontFamily: string;
  terminalFontSize: string;
  terminalKeyPassthrough: boolean;
  terminalOpenPosition: string;
  terminalThemeMode: TerminalThemeMode;
  terminalCustomThemeId: string;
  terminalCustomThemes: TerminalThemePreset[];
  language: "zh" | "en";
}

export interface BridgeClientContext {
  clientId: string;
  channel: "ide" | "mcp";
  processId?: number;
  sessionId?: string;
}

export interface EditorPoint {
  line: number;
  character: number;
}

export interface EditorSelection {
  start: EditorPoint;
  end: EditorPoint;
  isEmpty: boolean;
  text: string;
}

export interface SelectionState {
  filePath: string;
  relativePath: string;
  title?: string;
  viewType?: string;
  resourceType?: "markdown" | "web" | "pdf" | "file" | "view";
  url?: string;
  page?: number;
  /** 光标所在 heading 链（仅 md/tex，如 "第 3 章 > 3.2 路径积分"）。 */
  headingBreadcrumb?: string;
  cursor: EditorPoint;
  selection: EditorSelection;
}

export interface OpenEditorTab {
  uri: string;
  isActive: boolean;
  label: string;
  viewType: string;
  resourceType: "markdown" | "web" | "pdf" | "file" | "view";
  languageId?: string;
  filePath?: string;
  relativePath?: string;
  url?: string;
}

export interface ResolvedUpstream {
  url: string;
  source:
    | "manual"
    | "vault-local"
    | "vault-project"
    | "user"
    | "environment"
    | "none";
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface DiffPayload {
  sessionId: string;
  oldFilePath: string;
  newFilePath: string;
  oldContents: string;
  newContents: string;
  tabName: string;
  onResolve: (decision: "accept" | "reject", contents: string) => Promise<void>;
  validateOriginal: () => Promise<boolean>;
}
