import { Menu, Modal, Notice, PluginSettingTab, Setting, setIcon, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type MvSenceAiIdePlugin from "../main";
import * as child_process from "child_process";
import {
  DEFAULT_SETTINGS,
  DEFAULT_INLINE_SYSTEM_PROMPT_BODY,
  DEFAULT_INLINE_NO_COMPLETION_PROMPT,
  DEFAULT_INLINE_REJECT_PROMPT,
} from "./constants";
import {
  eventToCodeMirrorKey,
  formatInlineHotkeyLabel,
} from "./inline-completion/inline-hotkey-format";
import type {
  LlmModelEntry,
  LlmPromptTemplate,
  LlmProviderConfig,
  LlmProviderType,
  LlmThinkingMode,
  InlineCompletionKeymap,
  SourceAssistProfile,
  SourceHighlightCustomTheme,
  TerminalThemePalette,
  TerminalThemePreset,
  ToolToggles,
} from "./types";
import {
  createSourceAssistProfile,
  normalizeSourceAssistExtension,
} from "./source-assist/source-assist-settings";
import { externalFileAllowedExtensions } from "./external-file-opener";
import { getDefaultSourceAssistSnippetVariables } from "./source-assist/default-snippet-variables";
import { createSourceAssistSnippetsEditor } from "./source-assist/snippets-editor";
import { parseSnippets } from "./vendor/latex-suite/src/snippets/parse";
import {
  importSourceHighlightTheme,
  removeSourceHighlightThemeReferences,
  type SourceHighlightImportFormat,
  sourceHighlightProfileThemeOptions,
} from "./source-assist/highlight-themes";
import {
  createTerminalCustomTheme,
  isSafeTerminalColor,
  normalizeTerminalPalette,
  normalizeTerminalThemeSettings,
  TERMINAL_DARK_PALETTE,
  TERMINAL_LIGHT_PALETTE,
  TERMINAL_THEME_CUSTOM,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_FIELD_LABELS,
  TERMINAL_THEME_LIGHT,
  TERMINAL_THEME_OBSIDIAN,
  TERMINAL_THEME_PALETTE_KEYS,
  type TerminalThemePaletteKey,
} from "./terminal/terminal-themes";

type MainSettingsSectionId =
  | "ide"
  | "llm"
  | "inline-completion"
  | "terminal"
  | "source-assist"
  | "external-file-opener";

const SOURCE_LABELS = {
  manual: "手动覆盖",
  "vault-local": "当前仓库 .claude/settings.local.json",
  "vault-project": "当前仓库 .claude/settings.json",
  user: "用户 ~/.claude/settings.json",
  environment: "Obsidian 进程环境变量",
  none: "未找到",
} as const;

class SourceAssistExtensionModal extends Modal {
  private inputEl!: HTMLInputElement;

  constructor(
    app: App,
    private readonly onSubmit: (extension: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "添加新源码类型" });
    contentEl.createEl("p", {
      text: "只输入文件后缀，不需要点号。例如 tex、bib、m。",
      cls: "setting-item-description",
    });
    this.inputEl = contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: "tex" },
    });
    this.inputEl.addClass("mv-senceai-source-assist-extension-input");
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });
    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    const submitButton = buttonRow.createEl("button", { text: "添加" });
    submitButton.addClass("mod-cta");
    submitButton.addEventListener("click", () => this.submit());
    const cancelButton = buttonRow.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
    this.inputEl.focus();
  }

  private submit(): void {
    const extension = normalizeSourceAssistExtension(this.inputEl.value);
    if (!extension) {
      new Notice("请输入合法后缀：只能包含字母、数字、+、_、-，且不能以点开头。");
      return;
    }
    this.onSubmit(extension);
    this.close();
  }
}

class SourceHighlightThemeImportModal extends Modal {
  private fileEl!: HTMLInputElement;
  private nameEl!: HTMLInputElement;
  private format: SourceHighlightImportFormat = "auto";

  constructor(
    app: App,
    private readonly onImport: (theme: SourceHighlightCustomTheme, warnings: string[]) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "载入自定义代码高亮主题" });
    contentEl.createEl("p", {
      text: "支持 Prism CSS、highlight.js CSS、VS Code/Shiki/TextMate JSON 和 mv-SenceAI JSON。非 Prism 格式会转换为近似效果，不能完全还原原主题。",
      cls: "setting-item-description",
    });

    const fileSetting = new Setting(contentEl)
      .setName("主题文件")
      .setDesc("选择本地已下载的 .css 或 .json 主题文件。插件只保存解析后的颜色数据。")
      .setClass("mv-senceai-theme-file-setting");
    this.fileEl = fileSetting.controlEl.createEl("input", {
      type: "file",
      attr: { accept: ".css,.json" },
    });

    new Setting(contentEl)
      .setName("主题名称（可选）")
      .addText((text) => {
        this.nameEl = text.inputEl;
        text.setPlaceholder("留空则使用文件名或主题内置名称");
      });

    new Setting(contentEl)
      .setName("主题格式")
      .setDesc("自动检测失败时可手动指定格式。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "自动检测")
          .addOption("prism-css", "Prism CSS")
          .addOption("highlight-js-css", "highlight.js CSS")
          .addOption("textmate-json", "VS Code / Shiki / TextMate JSON")
          .addOption("mv-senceai-json", "mv-SenceAI JSON")
          .setValue(this.format)
          .onChange((value) => {
            this.format = value as SourceHighlightImportFormat;
          }),
      );

    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    const importButton = buttonRow.createEl("button", { text: "载入" });
    importButton.addClass("mod-cta");
    importButton.addEventListener("click", () => {
      void this.submit();
    });
    const cancelButton = buttonRow.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
  }

  private async submit(): Promise<void> {
    const file = this.fileEl.files?.[0];
    if (!file) {
      new Notice("请选择一个主题文件。");
      return;
    }
    try {
      const content = await file.text();
      const result = importSourceHighlightTheme(content, {
        fileName: file.name,
        format: this.format,
        nameOverride: this.nameEl.value,
      });
      await this.onImport(result.theme, result.warnings);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`主题载入失败：${message}`);
      console.warn("[mv-senceai-ide] Failed to import source highlight theme.", error);
    }
  }
}

export interface MarkdownExtensionRegistry {
  getTypeByExtension?: (extension: string) => string | undefined;
  isExtensionRegistered?: (extension: string) => boolean;
  registerExtensions?: (extensions: string[], viewType: string) => void;
  unregisterExtensions?: (extensions: string[]) => void;
}

export interface CustomMarkdownExtensionRegistryState {
  active: string[];
  owned: string[];
}

export function normalizeCustomMarkdownExtensions(raw: string): string[] {
  const seen = new Set<string>();
  const extensions: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const extension = part.trim().replace(/^\.+/, "").toLowerCase();
    if (
      !extension ||
      extension === "md" ||
      seen.has(extension) ||
      !/^[a-z0-9][a-z0-9+_-]*$/.test(extension)
    ) {
      continue;
    }
    seen.add(extension);
    extensions.push(extension);
  }
  return extensions;
}

export interface CustomMarkdownFileCommandDefinition {
  extension: string;
  id: string;
  name: string;
}

export function customMarkdownFileCommandId(extension: string): string {
  const encoded = Array.from(extension, (char) =>
    char.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
  return `new-custom-markdown-${encoded}`;
}

export function customMarkdownFileCommandDefinitions(
  extensions: Iterable<string>,
): CustomMarkdownFileCommandDefinition[] {
  return Array.from(extensions, (extension) => ({
    extension,
    id: customMarkdownFileCommandId(extension),
    name: `新建 .${extension} 文件`,
  }));
}

export function availableCustomMarkdownFilePath(
  folderPath: string,
  extension: string,
  exists: (path: string) => boolean,
): string {
  const prefix =
    !folderPath || folderPath === "/"
      ? ""
      : `${folderPath.replace(/\/+$/, "")}/`;
  for (let index = 0; index < 10_000; index += 1) {
    const basename = index === 0 ? "Untitled" : `Untitled ${index}`;
    const filePath = `${prefix}${basename}.${extension}`;
    if (!exists(filePath)) return filePath;
  }
  throw new Error(`Unable to find an available .${extension} file path.`);
}

export type PrismTokenContent =
  | string
  | PrismTokenLike
  | Array<string | PrismTokenLike>;

export interface PrismTokenLike {
  type: string;
  content: PrismTokenContent;
  alias?: string | string[];
}

export interface PrismLike {
  languages?: Record<string, unknown>;
  tokenize?: (
    source: string,
    grammar: unknown,
  ) => Array<string | PrismTokenLike>;
}

export interface CustomMarkdownHighlightRange {
  from: number;
  to: number;
  classes: string;
}

const CUSTOM_MARKDOWN_PRISM_LANGUAGE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  csx: "csharp",
  f: "fortran",
  f03: "fortran",
  f08: "fortran",
  f90: "fortran",
  f95: "fortran",
  "for": "fortran",
  fs: "fsharp",
  fsproj: "fsharp",
  fsx: "fsharp",
  htm: "html",
  jl: "julia",
  jsonc: "json",
  m: "matlab",
  mjs: "javascript",
  ml: "ocaml",
  mli: "ocaml",
  pl: "perl",
  pm: "perl",
  ps1: "powershell",
  wls: "wolfram",
};

export function resolveCustomMarkdownPrismLanguage(
  rawExtension: string | null | undefined,
  prism: PrismLike | null | undefined,
): string | null {
  const extension = rawExtension?.trim().replace(/^\.+/, "").toLowerCase();
  if (!extension) return null;
  if (prism?.languages?.[extension]) return extension;

  const aliasedLanguage = CUSTOM_MARKDOWN_PRISM_LANGUAGE_ALIASES[extension];
  return aliasedLanguage && prism?.languages?.[aliasedLanguage]
    ? aliasedLanguage
    : null;
}

export function customMarkdownHighlightLanguage(
  registeredExtensions: Iterable<string>,
  rawExtension: string | null | undefined,
  prism: PrismLike | null | undefined,
): string | null {
  const extension = rawExtension?.trim().replace(/^\.+/, "").toLowerCase();
  if (!extension || !new Set(registeredExtensions).has(extension)) {
    return null;
  }
  return resolveCustomMarkdownPrismLanguage(extension, prism);
}

export function prismTokensToHighlightRanges(
  tokens: Array<string | PrismTokenLike>,
): CustomMarkdownHighlightRange[] {
  const ranges: CustomMarkdownHighlightRange[] = [];
  let position = 0;

  for (const token of tokens) {
    position = appendPrismTokenRanges(token, position, ranges);
  }

  return ranges;
}

export function customMarkdownHighlightRangesForSource(
  prism: PrismLike | null | undefined,
  registeredExtensions: Iterable<string>,
  rawExtension: string | null | undefined,
  source: string,
  warn: (message: string, error?: unknown) => void = console.warn,
): CustomMarkdownHighlightRange[] {
  const language = customMarkdownHighlightLanguage(
    registeredExtensions,
    rawExtension,
    prism,
  );
  const grammar = language ? prism?.languages?.[language] : null;
  if (!language || !grammar || typeof prism?.tokenize !== "function") {
    return [];
  }

  try {
    return prismTokensToHighlightRanges(prism.tokenize(source, grammar));
  } catch (error) {
    warn(`Failed to highlight custom Markdown extension ".${language}".`, error);
    return [];
  }
}

export function syncCustomMarkdownExtensionRegistry(
  registry: MarkdownExtensionRegistry | null | undefined,
  currentOwnedExtensions: Iterable<string>,
  requestedRaw: string,
  warn: (message: string, error?: unknown) => void = console.warn,
): CustomMarkdownExtensionRegistryState {
  const requested = normalizeCustomMarkdownExtensions(requestedRaw);
  const active = new Set<string>();
  const owned = new Set(currentOwnedExtensions);

  if (!registry?.registerExtensions || !registry.unregisterExtensions) {
    if (requested.length > 0) {
      warn("Obsidian viewRegistry does not expose extension registration APIs.");
    }
    return { active: [], owned: Array.from(owned) };
  }

  const requestedSet = new Set(requested);
  const toRemove = Array.from(owned).filter((extension) => !requestedSet.has(extension));
  if (toRemove.length > 0) {
    try {
      registry.unregisterExtensions(toRemove);
      for (const extension of toRemove) owned.delete(extension);
    } catch (error) {
      warn("Failed to unregister custom Markdown extensions.", error);
    }
  }

  for (const extension of requested) {
    const existingType = registry.getTypeByExtension?.(extension);
    if (existingType === "markdown") {
      active.add(extension);
      continue;
    }

    if (existingType && existingType !== "markdown") {
      warn(
        `Extension ".${extension}" is registered for view "${existingType}"; re-registering it as Markdown.`,
      );
      try {
        registry.unregisterExtensions([extension]);
        owned.delete(extension);
      } catch (error) {
        warn(`Failed to unregister existing ".${extension}" view registration.`, error);
        continue;
      }
    } else if (registry.isExtensionRegistered?.(extension)) {
      warn(
        `Extension ".${extension}" is registered without a view type; re-registering it as Markdown.`,
      );
      try {
        registry.unregisterExtensions([extension]);
        owned.delete(extension);
      } catch (error) {
        warn(`Failed to unregister existing ".${extension}" extension registration.`, error);
        continue;
      }
    }

    try {
      registry.registerExtensions([extension], "markdown");
      owned.add(extension);
      if (registry.getTypeByExtension?.(extension) === "markdown" || !registry.getTypeByExtension) {
        active.add(extension);
      } else {
        warn(`Extension ".${extension}" did not resolve to Markdown after registration.`);
      }
    } catch (error) {
      warn(`Failed to register ".${extension}" as a Markdown extension.`, error);
    }
  }

  return { active: Array.from(active), owned: Array.from(owned) };
}

function appendPrismTokenRanges(
  token: string | PrismTokenLike,
  position: number,
  ranges: CustomMarkdownHighlightRange[],
): number {
  if (typeof token === "string") return position + token.length;

  const from = position;
  const to = from + prismTokenContentLength(token.content);
  const classes = prismTokenClasses(token);
  if (from < to && classes) {
    ranges.push({ from, to, classes });
  }
  appendPrismContentRanges(token.content, from, ranges);
  return to;
}

function appendPrismContentRanges(
  content: PrismTokenContent,
  position: number,
  ranges: CustomMarkdownHighlightRange[],
): number {
  if (typeof content === "string") return position + content.length;
  if (!Array.isArray(content)) {
    return appendPrismTokenRanges(content, position, ranges);
  }

  let nextPosition = position;
  for (const child of content) {
    nextPosition = appendPrismTokenRanges(child, nextPosition, ranges);
  }
  return nextPosition;
}

function prismTokenContentLength(content: PrismTokenContent): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, child) => sum + prismTokenContentLength(child), 0);
  }
  return prismTokenContentLength(content.content);
}

function prismTokenClasses(token: PrismTokenLike): string {
  const classParts = ["mv-senceai-source-token", "token", token.type];
  if (typeof token.alias === "string") {
    classParts.push(token.alias);
  } else if (Array.isArray(token.alias)) {
    classParts.push(...token.alias);
  }
  return classParts
    .flatMap((part) => part.split(/\s+/))
    .filter((part) => /^[a-zA-Z0-9_-]+$/.test(part))
    .join(" ");
}

function addHeading(containerEl: HTMLElement, text: string): void {
  new Setting(containerEl).setName(text).setHeading();
}

function createCollapsibleSettingsSection(
  containerEl: HTMLElement,
  id: MainSettingsSectionId,
  title: string,
  open: boolean,
  onToggle: (id: MainSettingsSectionId, open: boolean) => void,
): HTMLElement {
  const details = containerEl.createEl("details", {
    cls: "mv-senceai-settings-section",
  });
  details.dataset.sectionId = id;
  details.open = open;
  details.addEventListener("toggle", () => onToggle(id, details.open));
  details.createEl("summary", {
    text: title,
    cls: "mv-senceai-settings-section-summary setting-item-name",
  });
  return details.createDiv({ cls: "mv-senceai-settings-section-body" });
}

export class MvSenceAiIdeSettingTab extends PluginSettingTab {
  private readonly openSettingsSections = new Set<MainSettingsSectionId>();
  private readonly openSourceAssistProfileIds = new Set<string>();
  private readonly sourceAssistSnippetEditors: EditorView[] = [];
  private forceOpenSection: MainSettingsSectionId | null = null;
  private forceOpenSourceAssistProfileId: string | null = null;

  constructor(app: App, private readonly plugin: MvSenceAiIdePlugin) {
    super(app, plugin);
  }

  display(): void {
    const rootEl = this.containerEl;
    const previousScrollTop = this.captureSettingsUiState(rootEl);
    this.destroySourceAssistSnippetEditors();
    rootEl.empty();
    addHeading(rootEl, this.plugin.manifest.name || "mv-SenceAI");

    const ideEl = this.createSettingsSection(rootEl, "ide", "IDE桥接");
    const llmEl = this.createSettingsSection(rootEl, "llm", "划词助手");
    const inlineCompletionEl = this.createSettingsSection(
      rootEl,
      "inline-completion",
      "行内补全",
    );
    const terminalEl = this.createSettingsSection(rootEl, "terminal", "终端");
    const sourceAssistEl = this.createSettingsSection(
      rootEl,
      "source-assist",
      "源码编写辅助",
    );
    const externalFileOpenerEl = this.createSettingsSection(
      rootEl,
      "external-file-opener",
      "默认文件打开器",
    );
    let containerEl = ideEl;

    const claudeSetting = new Setting(containerEl)
      .setName("启用 Claude Code IDE 功能")
      .setDesc("默认开启。关闭后不写 Claude IDE lock、不注册 Claude MCP、不接管 Claude 设置。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ideIntegrations.claudeCode)
          .onChange(async (value) => {
            this.plugin.settings.ideIntegrations.claudeCode = value;
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("ide");
          }),
      );

    const claudeStatusEl = claudeSetting.settingEl.createEl("span", {
      cls: "mv-senceai-status-indicator",
    });
    if (!this.plugin.settings.ideIntegrations.claudeCode) {
      claudeStatusEl.setText("状态：已禁用");
      claudeStatusEl.addClass("mv-senceai-status-muted");
    } else if (this.plugin.claudeIdeError) {
      claudeStatusEl.setText(`● 启动失败: ${this.plugin.claudeIdeError}`);
      claudeStatusEl.addClass("mv-senceai-status-error");
    } else {
      claudeStatusEl.setText("● 运行中");
      claudeStatusEl.addClass("mv-senceai-status-success");
    }

    const codexSetting = new Setting(containerEl)
      .setName("启用 Codex IDE 功能")
      .setDesc("默认关闭。开启后支持 Codex CLI /ide，并把本插件 MCP 工具写入 Codex 配置。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ideIntegrations.codex)
          .onChange(async (value) => {
            this.plugin.settings.ideIntegrations.codex = value;
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("ide");
          }),
      );

    const codexStatusEl = codexSetting.settingEl.createEl("span", {
      cls: "mv-senceai-status-indicator",
    });
    if (!this.plugin.settings.ideIntegrations.codex) {
      codexStatusEl.setText("状态：已禁用");
      codexStatusEl.addClass("mv-senceai-status-muted");
    } else if (this.plugin.codexIdeError) {
      codexStatusEl.setText(`● 启动失败: ${this.plugin.codexIdeError}`);
      codexStatusEl.addClass("mv-senceai-status-error");
    } else {
      codexStatusEl.setText("● 运行中");
      codexStatusEl.addClass("mv-senceai-status-success");
    }

    addHeading(containerEl, "功能与工具");

    addHeading(containerEl, "被动");

    addHeading(containerEl, "状态感知");
    new Setting(containerEl)
      .setName("支持所有活动页面")
      .setDesc(
        "默认关闭。开启后追踪任意 Obsidian 标签，并通过 Claude 会话 PID 和终端标题标记精确忽略该会话自己的终端；改变后请重新启动 Claude Code。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.activityTracking.supportAllActivePages)
          .onChange(async (value) => {
            this.plugin.settings.activityTracking.supportAllActivePages = value;
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("ide");
          }),
      );

    const pageTypes: Array<{
      key: "trackMarkdown" | "trackPdf" | "trackWebview";
      name: string;
      description: string;
    }> = [
      {
        key: "trackMarkdown",
        name: "追踪 Markdown 页面",
        description: "追踪当前 Markdown 文件、光标和选区。",
      },
      {
        key: "trackPdf",
        name: "追踪 PDF 页面",
        description: "追踪当前 PDF 文件、页码和文本选区。",
      },
      {
        key: "trackWebview",
        name: "追踪 Web Viewer 页面",
        description: "追踪 Obsidian 内置浏览器的标题、URL 和文本选区。",
      },
    ];
    for (const pageType of pageTypes) {
      new Setting(containerEl)
        .setName(pageType.name)
        .setDesc(
          this.plugin.settings.activityTracking.supportAllActivePages
            ? "“支持所有活动页面”已开启，此选项不再单独生效。"
            : pageType.description,
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.activityTracking[pageType.key])
            .setDisabled(
              this.plugin.settings.activityTracking.supportAllActivePages,
            )
            .onChange(async (value) => {
              this.plugin.settings.activityTracking[pageType.key] = value;
              await this.plugin.saveAndApplySettings();
            }),
        );
    }

    containerEl = sourceAssistEl;
    this.renderSourceAssistSettings(containerEl);

    containerEl = externalFileOpenerEl;
    this.renderExternalFileOpenerSettings(containerEl);

    containerEl = ideEl;
    addHeading(containerEl, "视觉辅助");
    new Setting(containerEl)
      .setName("切换标签时保留选区高亮")
      .setDesc(
        "默认开启。切换到终端等特殊标签后仍显示 Markdown、PDF 和网页中最后一次划词；回到原页面空点或重新划词时继续遵循 Obsidian 原有行为。此功能不影响发送给 Claude 的选区。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.preserveSelectionHighlights)
          .onChange(async (value) => {
            await this.plugin.setSelectionHighlightsEnabled(value);
          }),
      );

    addHeading(containerEl, "主动：MCP 工具");
    new Setting(containerEl)
      .setName("启用 MCP 主动工具")
      .setDesc(
        "主动工具通过标准 MCP 提供给 Claude Code 和 Codex CLI。改变后请重启对应客户端或重新执行 /mcp。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpEnabled)
          .onChange(async (value) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("ide");
          }),
      );

    if (this.plugin.settings.mcpEnabled) {
      const tools: Array<{
        key: keyof ToolToggles;
        name: string;
        description: string;
      }> = [
        {
          key: "getLatestSelection",
          name: "获取最近标签与选区",
          description: "焦点离开 Obsidian 后仍可读取最近一次状态。",
        },
        {
          key: "getOpenEditors",
          name: "获取全部打开标签",
          description: "包括 Markdown、PDF、图片、网页、终端和其他插件页面。",
        },
        {
          key: "openFile",
          name: "在 Obsidian 中打开文件",
          description: "允许 Claude 主动定位仓库内文件和文本范围。",
        },
        {
          key: "readCurrentWebPage",
          name: "读取最近网页为 Markdown",
          description:
            "把最近浏览且仍打开的 Web Viewer 页面转换为 Markdown，不刷新或跳转页面。用于让 Claude 查看网页全貌，而不是只读取选区。",
        },
      ];
      for (const tool of tools) {
        new Setting(containerEl)
          .setName(tool.name)
          .setDesc(tool.description)
          .addToggle((toggle) =>
            toggle
              .setValue(this.plugin.settings.toolToggles[tool.key])
              .onChange(async (value) => {
                this.plugin.settings.toolToggles[tool.key] = value;
                await this.plugin.saveAndApplySettings();
              }),
          );
        if (tool.key === "readCurrentWebPage") {
          new Setting(containerEl)
            .setName("网页工具最大返回字符数")
            .setDesc(
              "留空或填写 0 表示不限，插件会忠实返回当前已加载页面的完整可见内容；填写正整数时才截断。",
            )
            .addText((text) => {
              text.inputEl.type = "number";
              text.inputEl.min = "0";
              text.inputEl.step = "1";
              text
                .setPlaceholder("不限")
                .setValue(
                  this.plugin.settings.toolContextLimits.readCurrentWebPage?.toString() ??
                    "",
                )
                .onChange(async (value) => {
                  const trimmed = value.trim();
                  if (!trimmed) {
                    this.plugin.settings.toolContextLimits.readCurrentWebPage =
                      null;
                  } else {
                    const parsed = Number(trimmed);
                    if (!Number.isFinite(parsed) || parsed < 0) return;
                    this.plugin.settings.toolContextLimits.readCurrentWebPage =
                      parsed === 0 ? null : Math.floor(parsed);
                  }
                  await this.plugin.saveData(this.plugin.settings);
                });
            });
        }
      }

      new Setting(containerEl)
        .setName("MCP 注册状态")
        .setDesc(this.plugin.mcpStatus)
        .addButton((button) =>
          button.setButtonText("重新注册").onClick(async () => {
            await this.plugin.retryMcpRegistration();
            new Notice(this.plugin.mcpStatus);
            this.rerenderSettings("ide");
          }),
        )
        .addButton((button) =>
          button.setButtonText("清理注册").onClick(async () => {
            await this.plugin.cleanMcpRegistration();
            new Notice(this.plugin.mcpStatus);
            this.rerenderSettings("ide");
          }),
        );

      new Setting(containerEl)
        .setName("Claude 可执行文件")
        .setDesc("通常自动检测。Windows 或自定义安装位置可在此填写完整路径。")
        .addText((text) =>
          text
            .setPlaceholder("自动检测")
            .setValue(this.plugin.settings.claudeExecutable)
            .onChange(async (value) => {
              this.plugin.settings.claudeExecutable = value.trim();
              await this.plugin.saveData(this.plugin.settings);
            }),
        );

      new Setting(containerEl)
        .setName("Codex 可执行文件")
        .setDesc("通常自动检测为 codex。自定义安装位置可在此填写完整路径。")
        .addText((text) =>
          text
            .setPlaceholder("codex")
            .setValue(this.plugin.settings.codexExecutable)
            .onChange(async (value) => {
              this.plugin.settings.codexExecutable = value.trim();
              await this.plugin.saveData(this.plugin.settings);
            }),
        );
    }

    addHeading(containerEl, "上游兼容");
    new Setting(containerEl)
      .setName("上游模式")
      .setDesc(
        "原生模式不改请求；兼容模式会把 IDE system 上下文移动到对应 user 消息中，不会复制两份。",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("native", "原生")
          .addOption("compatibility", "兼容")
          .setValue(this.plugin.settings.upstreamMode)
          .onChange(async (value) => {
            this.plugin.settings.upstreamMode =
              value === "compatibility" ? "compatibility" : "native";
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("ide");
          }),
      );

    if (this.plugin.settings.upstreamMode === "compatibility") {
      const resolved = this.plugin.resolvedUpstream();
      new Setting(containerEl)
        .setName("Anthropic 上游地址（可选）")
        .setDesc(
          "留空时自动读取 Claude 配置。只有需要覆盖自动结果时才填写。",
        )
        .addText((text) =>
          text
            .setPlaceholder("留空以自动读取")
            .setValue(this.plugin.settings.upstreamBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.upstreamBaseUrl = value.trim();
              await this.plugin.saveAndApplySettings();
            }),
        );

      new Setting(containerEl)
        .setName("当前识别的上游")
        .setDesc(`来源：${SOURCE_LABELS[resolved.source]}`)
        .addText((text) =>
          text.setValue(resolved.url || "未找到 ANTHROPIC_BASE_URL").setDisabled(true),
        );

      new Setting(containerEl)
        .setName("自动管理当前仓库的 Claude 设置")
        .setDesc(
          "仅把当前仓库的 ANTHROPIC_BASE_URL 指向本地兼容端点；关闭时恢复插件接管前的值。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.autoManageClaudeSettings)
            .onChange(async (value) => {
              this.plugin.settings.autoManageClaudeSettings = value;
              await this.plugin.saveAndApplySettings();
              this.rerenderSettings("ide");
            }),
        );
    }

    addHeading(containerEl, "Diff 与维护");
    new Setting(containerEl)
      .setName("Diff 审核行为")
      .setDesc(
        "完全跟随 Claude Code 权限模式：默认权限会显示审核；acceptEdits 会直接接受编辑，插件不会额外弹窗。",
      );

    new Setting(containerEl)
      .setName("重启桥接")
      .setDesc("重建本地服务和 Claude Code IDE lock 文件。")
      .addButton((button) =>
        button.setButtonText("重启").onClick(async () => {
          await this.plugin.restartBridge();
          new Notice("mv-SenceAI 桥接已重启。");
          this.rerenderSettings("ide");
        }),
      );

    new Setting(containerEl)
      .setName("恢复插件管理的 Claude 设置")
      .setDesc("只恢复本插件替换过的 ANTHROPIC_BASE_URL，不改其他配置。")
      .addButton((button) =>
        button.setButtonText("恢复").onClick(async () => {
          await this.plugin.restoreClaudeSettings();
          new Notice("已恢复 mv-SenceAI 管理的 Claude 设置。");
          this.rerenderSettings("ide");
        }),
      );



    containerEl = llmEl;
    containerEl.createEl("div", {
      text: "🤖 API 提供商（划词助手与行内补全共用）",
      cls: "mv-senceai-section-title setting-item-name",
    });
    addHeading(containerEl, "API 提供商");
    {
      const tip = containerEl.createEl("p", {
        text: "API Base URL 和模型必填；API Key 仅对需要鉴权的服务必填，本地无鉴权服务可留空。",
      });
      tip.addClass("mv-senceai-llm-hint");
    }
    this.renderProviders(containerEl);

    containerEl = inlineCompletionEl;
    containerEl.createEl("div", {
      text: "⌨️ 行内补全（Markdown 续写）",
      cls: "mv-senceai-section-title setting-item-name",
    });
    this.renderInlineCompletion(containerEl);

    containerEl = llmEl;
    containerEl.createEl("div", {
      text: "✍️ 划词助手（选词调用 LLM）",
      cls: "mv-senceai-section-title setting-item-name",
    });
    addHeading(containerEl, "总开关");

    new Setting(containerEl)
      .setName("启用")
      .setDesc(
        "完全独立于 IDE 桥接。开启后，在 Markdown / PDF / Web Viewer 中划词，右键或快捷键即可用预设提示词调用 LLM。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.llm.enabled)
          .onChange(async (value) => {
            this.plugin.settings.llm.enabled = value;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.refreshLlmFeature();
            this.rerenderSettings("llm");
          }),
      );

    {
      const tip = containerEl.createEl("p", {
        text: "提示：PDF 视图的右键被 Obsidian / pdf++ 占用，无法注入 LLM 菜单，请用快捷键触发（在「快捷键设置」里给「LLM：xxx」命令绑键）。网页视图（Web Viewer）里，Obsidian 的快捷键因焦点隔离无法直接生效，插件会自动把你已绑定的「LLM：xxx」快捷键同步注入网页，所以网页里用同一个快捷键即可。",
      });
      tip.addClass("mv-senceai-llm-hint");
    }

    if (this.plugin.settings.llm.enabled) {
      new Setting(containerEl)
        .setName("网页视图注入右键菜单（实验性）")
        .setDesc(
          "因网页视图跨域隔离，Obsidian 读不到网页内的选区。开启后会向网页注入脚本，在网页内显示我们的右键菜单（会屏蔽网页原生右键，部分站点可能失效）。关闭时网页视图改用快捷键调用。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.llm.webContextMenu)
            .onChange(async (value) => {
              this.plugin.settings.llm.webContextMenu = value;
              await this.plugin.saveData(this.plugin.settings);
              new Notice(
                value
                  ? "已开启网页右键菜单，将在网页内注入。"
                  : "已关闭，网页视图请用快捷键调用。",
                4000,
              );
            }),
        );

      // ---- 悬浮窗行为 + 划词自动触发 ----
      addHeading(containerEl, "悬浮窗与自动触发");

      // 自动触发模板：下拉列出所有「已启用」的模板 + 一个「（关闭）」选项。
      // 仅当存在至少一个已启用模板时才显示，否则给一条提示。
      const enabledTemplates = this.plugin.settings.llm.templates.filter(
        (t) => t.enabled,
      );
      if (enabledTemplates.length === 0) {
        new Setting(containerEl)
          .setName("划词自动触发模板")
          .setDesc("当前没有已启用的模板，无法设置自动触发。请先在下方启用至少一个模板。");
      } else {
        new Setting(containerEl)
          .setName("划词自动触发模板")
          .setDesc(
            "选择一个模板后，左侧功能区会出现「划词自动触发」按钮（点亮后才生效，每次启动默认关闭）。点亮后划词会自动用所选模板调用助手；所选模板若被关闭或删除，按钮会自动消失。",
          )
          .addDropdown((dropdown) => {
            dropdown.addOption("", "（关闭）");
            for (const tpl of enabledTemplates) {
              dropdown.addOption(tpl.id, tpl.label);
            }
            dropdown.setValue(
              this.plugin.settings.llm.autoTriggerTemplateId ?? "",
            );
            dropdown.onChange(async (value) => {
              this.plugin.settings.llm.autoTriggerTemplateId = value || null;
              await this.plugin.saveData(this.plugin.settings);
              this.plugin.refreshLlmFeature();
            });
          });
      }

      // ---- 提示词模板 ----
      addHeading(containerEl, "提示词模板");
      const hint = containerEl.createEl("div", {
        text: "提示词中可用 {selection} 占位符表示划词内容；不含占位符时，划词会自动追加到末尾。每个模板可单独开关，并选择用哪个提供商的哪个模型。",
      });
      hint.addClass("mv-senceai-llm-hint");
      this.renderTemplates(containerEl);

      new Setting(containerEl).addButton((btn) =>
        btn
          .setButtonText("新增提示词模板")
          .setCta()
          .onClick(async () => {
            const next: LlmPromptTemplate = {
              id: `tpl-${Date.now()}`,
              label: "新模板",
              prompt: "{selection}",
              enabled: true,
              providerId: null,
              modelId: null,
              thinkingMode: "default",
            };
            this.plugin.settings.llm.templates.push(next);
            await this.plugin.saveData(this.plugin.settings);
            this.rerenderSettings("llm");
          }),
      );
    }

    // ---- 💻 终端设置 ----
    containerEl = terminalEl;
    containerEl.createEl("div", {
      text: "💻 终端设置",
      cls: "mv-senceai-section-title setting-item-name",
    });

    addHeading(containerEl, "打开与主题");

    new Setting(containerEl)
      .setName("终端打开位置")
      .setDesc("选择新终端视图默认打开的面板区域。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("tab", "中间主栏 (Middle Main Split / Tabs)")
          .addOption("left", "左侧边栏 (Left Sidebar)")
          .addOption("right", "右侧边栏 (Right Sidebar)")
          .addOption("bottom", "底部拆分栏 (Bottom Split Pane)")
          .setValue(this.plugin.settings.terminalOpenPosition || "right")
          .onChange(async (value) => {
            this.plugin.settings.terminalOpenPosition = value as any;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    this.renderTerminalThemeSettings(containerEl);

    addHeading(containerEl, "Shell 配置");

    new Setting(containerEl)
      .setName("macOS/Linux Shell 路径")
      .setDesc("自定义 macOS/Linux 系统下的终端 Shell。留空则默认为 $SHELL 或 /bin/zsh。")
      .addText((text) =>
        text
          .setPlaceholder("/bin/zsh")
          .setValue(this.plugin.settings.terminalMacShellPath)
          .onChange(async (value) => {
            this.plugin.settings.terminalMacShellPath = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("macOS/Linux Shell 参数")
      .setDesc("启动 macOS/Linux Shell 时的命令行参数（以空格分隔）。默认为 -l。")
      .addText((text) =>
        text
          .setPlaceholder("-l")
          .setValue(this.plugin.settings.terminalMacShellArgs)
          .onChange(async (value) => {
            this.plugin.settings.terminalMacShellArgs = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Windows Shell 路径")
      .setDesc("自定义 Windows 系统下的终端 Shell。留空则默认为 cmd.exe。")
      .addText((text) =>
        text
          .setPlaceholder("powershell.exe")
          .setValue(this.plugin.settings.terminalWinShellPath)
          .onChange(async (value) => {
            this.plugin.settings.terminalWinShellPath = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Windows Shell 参数")
      .setDesc("启动 Windows Shell 时的命令行参数（以空格分隔）。留空则不传参数。")
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.terminalWinShellArgs)
          .onChange(async (value) => {
            this.plugin.settings.terminalWinShellArgs = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    addHeading(containerEl, "字体与字号");

    new Setting(containerEl)
      .setName("自定义终端字体 (Font Family)")
      .setDesc("填写您在终端中使用的等宽字体（例如 'MesloLGS NF' 或 'Fira Code' 等 Nerd Font），以完美展示各类图标。留空默认使用 Menlo, Monaco, monospace。")
      .addText((text) =>
        text
          .setPlaceholder("Menlo, Monaco, monospace")
          .setValue(this.plugin.settings.terminalFontFamily || "")
          .onChange(async (value) => {
            this.plugin.settings.terminalFontFamily = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("终端字号 (Font Size)")
      .setDesc("设置终端内字体大小。留空则默认为 13px。")
      .addText((text) =>
        text
          .setPlaceholder("13")
          .setValue(this.plugin.settings.terminalFontSize || "")
          .onChange(async (value) => {
            this.plugin.settings.terminalFontSize = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    addHeading(containerEl, "Python 与依赖");

    new Setting(containerEl)
      .setName("Python 可执行文件路径")
      .setDesc("用于运行 PTY 封装脚本的 Python 3 路径。留空则在系统 PATH 中自动寻找。")
      .addText((text) =>
        text
          .setPlaceholder("python3 或 py")
          .setValue(this.plugin.settings.terminalPythonPath)
          .onChange(async (value) => {
            this.plugin.settings.terminalPythonPath = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    const getPythonCmd = () => {
      const isWindows = process.platform === "win32";
      const settings = this.plugin.settings;
      let pythonCmd = settings.terminalPythonPath || (isWindows ? "py" : "python3");
      if (isWindows && !settings.terminalPythonPath) {
        try {
          child_process.execSync("py --version", { stdio: "ignore", timeout: 1000 });
          pythonCmd = "py";
        } catch (e) {
          try {
            const whereOutput = child_process.execSync("where.exe python", { encoding: "utf8", timeout: 1000 });
            const pythonPaths = whereOutput.split(/\r?\n/).map(p => p.trim()).filter(p => p && !p.includes("WindowsApps"));
            const executable = pythonPaths.find((p) => !/\.(bat|cmd)$/i.test(p));
            pythonCmd = executable || pythonPaths[0] || "python";
          } catch (e2) {
            pythonCmd = "python";
          }
        }
      }
      return pythonCmd;
    };

    new Setting(containerEl)
      .setName("Windows 依赖管理 (pywinpty)")
      .setDesc("Windows 用户运行终端必须安装 winpty 依赖。点击右侧按钮进行检测或一键更新。")
      .addButton((button) =>
        button
          .setButtonText("检测依赖")
          .onClick(async () => {
            new Notice("正在检测 Windows 依赖 (winpty)...");
            const pythonCmd = getPythonCmd();
            child_process.execFile(pythonCmd, ["-c", "import winpty"], { windowsHide: true }, (error) => {
              if (error) {
                new Notice("❌ Windows 依赖检测失败：未检测到 winpty 库，请点击右侧按钮安装。");
              } else {
                new Notice("✅ Windows 依赖检测成功：已检测到 winpty 库，终端可以正常运行。");
              }
            });
          })
      )
      .addButton((button) =>
        button
          .setButtonText("更新依赖")
          .onClick(async () => {
            new Notice("正在后台更新 Windows 依赖 (pywinpty)...");
            const pythonCmd = getPythonCmd();
            const installArgs = ["-m", "pip", "install", "-U", "pywinpty"];
            const installCmd = [pythonCmd, ...installArgs].join(" ");
            new Notice(`运行命令: ${installCmd}`);
            child_process.execFile(pythonCmd, installArgs, { windowsHide: true }, (error) => {
              if (error) {
                new Notice(`❌ Windows 依赖更新失败:\n${error.message}`);
                console.error(error);
              } else {
                new Notice("✅ Windows 依赖 (pywinpty) 更新成功！");
              }
            });
          })
      );
    this.restoreSettingsScrollTop(rootEl, previousScrollTop);
    this.forceOpenSection = null;
  }

  hide(): void {
    this.destroySourceAssistSnippetEditors();
  }

  private rerenderSettings(openSection?: MainSettingsSectionId): void {
    if (openSection) {
      this.openSettingsSections.add(openSection);
      this.forceOpenSection = openSection;
    }
    this.display();
  }

  private destroySourceAssistSnippetEditors(): void {
    for (const editor of this.sourceAssistSnippetEditors) {
      editor.destroy();
    }
    this.sourceAssistSnippetEditors.length = 0;
  }

  private captureSettingsUiState(containerEl: HTMLElement): number {
    for (const details of Array.from(
      containerEl.querySelectorAll<HTMLDetailsElement>(
        "details.mv-senceai-settings-section[data-section-id]",
      ),
    )) {
      const id = details.dataset.sectionId as MainSettingsSectionId | undefined;
      if (!id) continue;
      if (details.open) {
        this.openSettingsSections.add(id);
      } else {
        this.openSettingsSections.delete(id);
      }
    }
    return this.settingsScrollEl(containerEl).scrollTop;
  }

  private restoreSettingsScrollTop(containerEl: HTMLElement, scrollTop: number): void {
    const scrollEl = this.settingsScrollEl(containerEl);
    activeWindow.requestAnimationFrame(() => {
      scrollEl.scrollTop = scrollTop;
    });
  }

  private settingsScrollEl(containerEl: HTMLElement): HTMLElement {
    return (
      containerEl.closest<HTMLElement>(".vertical-tab-content")
      ?? containerEl.closest<HTMLElement>(".modal-content")
      ?? containerEl.parentElement
      ?? containerEl
    );
  }

  private createSettingsSection(
    containerEl: HTMLElement,
    id: MainSettingsSectionId,
    title: string,
  ): HTMLElement {
    return createCollapsibleSettingsSection(
      containerEl,
      id,
      title,
      this.sectionShouldOpen(id),
      (nextId, open) => this.setSectionOpen(nextId, open),
    );
  }

  private sectionShouldOpen(id: MainSettingsSectionId): boolean {
    return this.forceOpenSection === id || this.openSettingsSections.has(id);
  }

  private setSectionOpen(id: MainSettingsSectionId, open: boolean): void {
    if (open) {
      this.openSettingsSections.add(id);
    } else {
      this.openSettingsSections.delete(id);
    }
  }

  private async saveTerminalThemeSettings(rerender = false): Promise<void> {
    this.plugin.settings = normalizeTerminalThemeSettings(this.plugin.settings);
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.refreshTerminalThemes();
    if (rerender) {
      this.rerenderSettings("terminal");
    }
  }

  private renderTerminalThemeSettings(containerEl: HTMLElement): void {
    this.plugin.settings = normalizeTerminalThemeSettings(this.plugin.settings);
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName("终端主题")
      .setDesc("控制本插件内置终端的 xterm 配色。浅色/深色使用固定高对比色板；自定义主题可复制后自行调整。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption(TERMINAL_THEME_OBSIDIAN, "跟随 Obsidian")
          .addOption(TERMINAL_THEME_LIGHT, "浅色")
          .addOption(TERMINAL_THEME_DARK, "深色")
          .addOption(TERMINAL_THEME_CUSTOM, "自定义")
          .setValue(settings.terminalThemeMode)
          .onChange(async (value) => {
            settings.terminalThemeMode = value as typeof settings.terminalThemeMode;
            if (settings.terminalThemeMode === TERMINAL_THEME_CUSTOM) {
              const firstCustomTheme = settings.terminalCustomThemes[0];
              if (firstCustomTheme) {
                settings.terminalCustomThemeId = firstCustomTheme.id;
              } else {
                const theme = createTerminalCustomTheme(
                  TERMINAL_DARK_PALETTE,
                  "自定义深色终端",
                );
                settings.terminalCustomThemes.push(theme);
                settings.terminalCustomThemeId = theme.id;
              }
            }
            await this.saveTerminalThemeSettings(true);
          }),
      );

    if (settings.terminalThemeMode === TERMINAL_THEME_CUSTOM) {
      new Setting(containerEl)
        .setName("当前自定义主题")
        .setDesc("选择要应用到已打开和新建终端的自定义主题。")
        .addDropdown((dropdown) => {
          for (const theme of settings.terminalCustomThemes) {
            dropdown.addOption(theme.id, theme.name);
          }
          dropdown
            .setValue(settings.terminalCustomThemeId)
            .onChange(async (value) => {
              settings.terminalCustomThemeId = value;
              await this.saveTerminalThemeSettings();
            });
        });
    }

    this.renderTerminalCustomThemeManager(containerEl);
  }

  private renderTerminalCustomThemeManager(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const details = containerEl.createEl("details", {
      cls: "mv-senceai-terminal-theme-manager",
    });
    details.createEl("summary", {
      text: "自定义终端主题",
      cls: "mv-senceai-source-profile-summary setting-item-name",
    });
    details.createEl("p", {
      text: "自定义主题只保存结构化颜色数据，不执行 CSS/JS。浅色和深色内置主题不可直接修改，可复制后调整。",
      cls: "setting-item-description",
    });

    new Setting(details)
      .setName("创建自定义主题")
      .setDesc("从内置浅色或深色色板复制一份，然后在下方编辑。")
      .addButton((button) =>
        button
          .setButtonText("复制浅色")
          .onClick(async () => {
            await this.addTerminalCustomTheme(TERMINAL_LIGHT_PALETTE, "自定义浅色终端");
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("复制深色")
          .onClick(async () => {
            await this.addTerminalCustomTheme(TERMINAL_DARK_PALETTE, "自定义深色终端");
          }),
      );

    if (settings.terminalCustomThemes.length === 0) {
      details.createEl("p", {
        text: "尚未创建自定义终端主题。",
        cls: "setting-item-description",
      });
      return;
    }

    for (const theme of settings.terminalCustomThemes) {
      this.renderTerminalCustomThemeEditor(details, theme);
    }
  }

  private async addTerminalCustomTheme(
    palette: TerminalThemePalette,
    name: string,
  ): Promise<void> {
    const theme = createTerminalCustomTheme(palette, name);
    this.plugin.settings.terminalCustomThemes.push(theme);
    this.plugin.settings.terminalThemeMode = TERMINAL_THEME_CUSTOM;
    this.plugin.settings.terminalCustomThemeId = theme.id;
    await this.saveTerminalThemeSettings(true);
  }

  private renderTerminalCustomThemeEditor(
    containerEl: HTMLElement,
    theme: TerminalThemePreset,
  ): void {
    const details = containerEl.createEl("details", {
      cls: "mv-senceai-terminal-theme-card",
    });
    const summary = details.createEl("summary", {
      cls: "mv-senceai-source-profile-summary setting-item-name",
    });
    const titleEl = summary.createSpan({ text: theme.name });

    new Setting(details)
      .setName("主题名称")
      .addText((text) =>
        text
          .setValue(theme.name)
          .onChange(async (value) => {
            theme.name = value.trim().slice(0, 80) || "自定义终端主题";
            titleEl.setText(theme.name);
            await this.saveTerminalThemeSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("设为当前")
          .onClick(async () => {
            this.plugin.settings.terminalThemeMode = TERMINAL_THEME_CUSTOM;
            this.plugin.settings.terminalCustomThemeId = theme.id;
            await this.saveTerminalThemeSettings(true);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("删除")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.terminalCustomThemes =
              this.plugin.settings.terminalCustomThemes.filter((item) => item.id !== theme.id);
            if (this.plugin.settings.terminalCustomThemeId === theme.id) {
              this.plugin.settings.terminalCustomThemeId = "";
              this.plugin.settings.terminalThemeMode = TERMINAL_THEME_OBSIDIAN;
            }
            await this.saveTerminalThemeSettings(true);
          }),
      );

    new Setting(details)
      .setName("恢复默认配色")
      .setDesc("会覆盖该自定义主题当前的所有颜色。")
      .addButton((button) =>
        button
          .setButtonText("套用浅色默认")
          .onClick(async () => {
            theme.palette = normalizeTerminalPalette(TERMINAL_LIGHT_PALETTE);
            await this.saveTerminalThemeSettings(true);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("套用深色默认")
          .onClick(async () => {
            theme.palette = normalizeTerminalPalette(TERMINAL_DARK_PALETTE);
            await this.saveTerminalThemeSettings(true);
          }),
      );

    for (const key of TERMINAL_THEME_PALETTE_KEYS) {
      this.renderTerminalColorSetting(details, theme, key);
    }
  }

  private renderTerminalColorSetting(
    containerEl: HTMLElement,
    theme: TerminalThemePreset,
    key: TerminalThemePaletteKey,
  ): void {
    const setting = new Setting(containerEl)
      .setName(TERMINAL_THEME_FIELD_LABELS[key])
      .setDesc("支持 #rgb/#rrggbb/#rrggbbaa、rgb()/rgba()、hsl()/hsla()。");
    const statusEl = setting.descEl.createDiv({
      cls: "mv-senceai-terminal-color-status",
    });
    setting.addText((text) =>
      text
        .setPlaceholder(TERMINAL_DARK_PALETTE[key])
        .setValue(theme.palette[key])
        .onChange(async (value) => {
          const next = value.trim();
          if (!isSafeTerminalColor(next)) {
            statusEl.setText("颜色格式无效，未保存。");
            statusEl.addClass("mv-senceai-status-error");
            return;
          }
          statusEl.setText("");
          statusEl.removeClass("mv-senceai-status-error");
          theme.palette[key] = next;
          await this.saveTerminalThemeSettings();
        }),
    );
  }

  private renderExternalFileOpenerSettings(containerEl: HTMLElement): void {
    const settings = this.plugin.settings.externalFileOpener;
    const supportedExtensions = externalFileAllowedExtensions(this.plugin.settings)
      .map((extension) => `.${extension}`)
      .join("、");

    new Setting(containerEl)
      .setName("启用默认文件打开器")
      .setDesc(
        "开启后，本插件会启动本地服务，供系统默认打开器 wrapper 打开电脑上的外部文件。",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.enabled).onChange(async (value) => {
          settings.enabled = value;
          await this.plugin.saveAndApplySettings();
          this.rerenderSettings("external-file-opener");
        }),
      );

    new Setting(containerEl)
      .setName("支持的后缀范围")
      .setDesc(`当前支持：${supportedExtensions}`)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("markdown-only", "仅支持 md")
          .addOption("markdown-and-source-assist", "支持扩展后缀名")
          .setValue(settings.extensionMode)
          .setDisabled(!settings.enabled)
          .onChange(async (value) => {
            settings.extensionMode =
              value === "markdown-and-source-assist"
                ? "markdown-and-source-assist"
                : "markdown-only";
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("external-file-opener");
          }),
      );

    new Setting(containerEl)
      .setName("系统默认打开方式")
      .setDesc(this.plugin.defaultFileOpenerStatus)
      .addButton((button) =>
        button.setButtonText("检查").onClick(() => {
          const status = this.plugin.checkDefaultFileOpener();
          new Notice(status.message);
          this.rerenderSettings("external-file-opener");
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("一键注入")
          .setCta()
          .setDisabled(!settings.enabled)
          .onClick(async () => {
            await this.plugin.installDefaultFileOpener();
            this.rerenderSettings("external-file-opener");
          }),
      )
      .addButton((button) =>
        button.setButtonText("清理").onClick(async () => {
          await this.plugin.cleanupDefaultFileOpener();
          this.rerenderSettings("external-file-opener");
        }),
      );

    new Setting(containerEl)
      .setName("镜像目录")
      .setDesc("外部文件会以 symlink 形式映射到此 vault 内目录。")
      .addText((text) =>
        text
          .setValue(settings.mirrorFolder)
          .setPlaceholder("senceai-external-files/mirror")
          .setDisabled(!settings.enabled)
          .onChange(async (value) => {
            settings.mirrorFolder =
              value.trim().replace(/^\/+/, "") ||
              DEFAULT_SETTINGS.externalFileOpener.mirrorFolder;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );
  }

  private renderSourceAssistSettings(containerEl: HTMLElement): void {
    const settings = this.plugin.settings.sourceAssist;

    new Setting(containerEl)
      .setName("启用源码编写辅助")
      .setDesc("开启后启用按后缀隔离的 Latex Suite 风格 snippets。")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.enabled)
          .onChange(async (value) => {
            settings.enabled = value;
            await this.plugin.saveSourceAssistSettings();
          }),
      );

    for (let i = 0; i < settings.profiles.length; i += 1) {
      const profile = settings.profiles[i];
      if (!profile) continue;
      this.renderSourceAssistProfile(containerEl, profile, i);
    }

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("添加新源码类型")
        .setCta()
        .onClick(() => {
          new SourceAssistExtensionModal(this.app, async (extension) => {
            if (this.plugin.settings.sourceAssist.profiles.some((p) => p.extension === extension)) {
              new Notice(`.${extension} 已存在。`);
              return;
            }
            const profile = createSourceAssistProfile(extension);
            this.plugin.settings.sourceAssist.profiles.push(profile);
            this.forceOpenSourceAssistProfileId = profile.id;
            await this.plugin.saveSourceAssistSettings();
            this.rerenderSettings("source-assist");
          }).open();
        }),
    );

    this.renderSourceHighlightImportSettings(containerEl);
  }

  private renderSourceAssistProfile(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
  ): void {
    const details = containerEl.createEl("details", {
      cls: "mv-senceai-source-assist-profile",
    });
    const shouldForceOpen = this.forceOpenSourceAssistProfileId === profile.id;
    details.open = shouldForceOpen || this.openSourceAssistProfileIds.has(profile.id);
    if (shouldForceOpen) {
      this.openSourceAssistProfileIds.add(profile.id);
      this.forceOpenSourceAssistProfileId = null;
    }
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openSourceAssistProfileIds.add(profile.id);
      } else {
        this.openSourceAssistProfileIds.delete(profile.id);
      }
    });
    const title = profile.extension === "md" ? "Markdown (.md)" : `源码类型 .${profile.extension}`;
    const summary = details.createEl("summary", {
      cls: "mv-senceai-source-assist-profile-summary",
    });
    const summaryText = summary.createDiv({
      cls: "mv-senceai-source-assist-profile-summary-text",
    });
    summaryText.createDiv({
      cls: "setting-item-name",
      text: title,
    });
    summaryText.createDiv({
      cls: "setting-item-description",
      text:
        profile.extension === "md"
          ? "固定 profile：用于普通 Markdown 文件。"
          : "该后缀会自动注册为 Markdown view，并出现在新建非 MD 源码文件命令中。若该后缀已由其它插件处理，本插件会尝试改注册为 Markdown view，可能影响其它插件的打开方式。",
    });

    if (profile.extension !== "md") {
      const deleteButton = summary.createEl("button", {
        cls: "clickable-icon mv-senceai-source-assist-profile-delete",
        attr: {
          "aria-label": "删除该源码类型并取消本插件对该后缀的识别",
          type: "button",
        },
      });
      setIcon(deleteButton, "trash");
      deleteButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.plugin.settings.sourceAssist.profiles.splice(idx, 1);
        this.openSourceAssistProfileIds.delete(profile.id);
        await this.plugin.saveSourceAssistSettings();
        this.rerenderSettings("source-assist");
      });
    }

    const wrap = details.createDiv({ cls: "mv-senceai-source-assist-profile-body" });

    this.renderSourceAssistProfileEnabledSetting(wrap, profile, idx);

    if (profile.extension !== "md") {
      this.renderSourceAssistProfileHighlightThemeSetting(wrap, profile, idx);
    }

    if (profile.extension === "tex") {
      new Setting(wrap)
        .setName("打开 TeX 增强渲染")
        .setDesc(
          "实验功能：使用本插件自定义 Live Preview 扩展渲染 \\(...\\)、\\[...\\] 和常见数学环境，可能影响光标移动、折叠行为或其它编辑器插件兼容性。该功能要求本 profile 的 snippets 替换开关处于开启状态，否则不会加载。关闭后 .tex 仍作为 Markdown view 打开，snippets 仍可用。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(profile.texEnhancedRenderEnabled)
            .onChange(async (value) => {
              const target = this.plugin.settings.sourceAssist.profiles[idx];
              if (!target) return;
              target.texEnhancedRenderEnabled = value;
              await this.plugin.saveSourceAssistSettings();
            }),
        );
    }

    this.renderSourceAssistSnippetsEditor(wrap, profile, idx);
    this.renderSourceAssistHotkeyIntro(wrap);

    this.renderSourceAssistHotkeySetting(
      wrap,
      profile,
      idx,
      "snippetsTrigger",
      "手动触发按键",
      "用于触发非 automatic snippets；默认与 Latex Suite 一样是 Tab。",
    );
    this.renderSourceAssistHotkeySetting(
      wrap,
      profile,
      idx,
      "snippetNextTabstopTrigger",
      "下一 tabstop",
      "snippet 展开后跳到下一个 $1/$2/$0 等占位点。",
    );
    this.renderSourceAssistHotkeySetting(
      wrap,
      profile,
      idx,
      "snippetPreviousTabstopTrigger",
      "上一 tabstop",
      "snippet 展开后跳回上一个占位点。",
    );
  }

  private renderSourceAssistProfileEnabledSetting(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
  ): void {
    const name =
      profile.extension === "md"
        ? "启用 Markdown snippets 替换"
        : "启用该后缀的 snippets 替换";
    const desc =
      profile.extension === "md"
        ? "关闭后只停用 Markdown profile 的 Latex Suite snippets、tabstop 和相关预览 runtime。"
        : "关闭后只停用该 profile 的 Latex Suite snippets、tabstop 和相关预览 runtime；不取消后缀注册、不移除新建命令、不影响源码高亮或 Markdown 视觉屏蔽。";
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle
          .setValue(profile.enabled)
          .onChange(async (value) => {
            const target = this.plugin.settings.sourceAssist.profiles[idx];
            if (!target) return;
            target.enabled = value;
            await this.plugin.saveSourceAssistSettings();
          }),
	      );
  }

  private renderSourceAssistProfileHighlightThemeSetting(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
  ): void {
    new Setting(containerEl)
      .setName("源码高亮主题")
      .setDesc("只影响该后缀文件的源码 token 配色，不影响 snippets 替换、Markdown view 注册或 TeX 增强渲染。")
      .addDropdown((dropdown) => {
        for (const option of sourceHighlightProfileThemeOptions(
          this.plugin.settings.sourceAssist.customHighlightThemes,
        )) {
          dropdown.addOption(option.id, option.name);
        }
        dropdown
          .setValue(profile.highlightThemeId)
          .onChange(async (value) => {
            const target = this.plugin.settings.sourceAssist.profiles[idx];
            if (!target) return;
            target.highlightThemeId = value;
            await this.plugin.saveSourceAssistSettings();
          });
      });
  }

  private renderSourceHighlightImportSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, "自定义代码高亮主题");
    new Setting(containerEl)
      .setName("载入自定义代码高亮主题")
      .setDesc(
        "从本地 .css/.json 文件导入，保存为插件自己的主题数据；非 Prism 主题会转换为近似效果，不能完全还原。",
      )
      .addButton((button) =>
        button
          .setButtonText("选择主题文件")
          .setCta()
          .onClick(() => {
            new SourceHighlightThemeImportModal(this.app, async (theme, warnings) => {
              this.plugin.settings.sourceAssist.customHighlightThemes.push(theme);
              await this.plugin.saveSourceAssistSettings();
              new Notice(`已载入主题：${theme.name}`);
              for (const warning of warnings) console.info(`[mv-senceai-ide] ${warning}`);
              this.rerenderSettings("source-assist");
            }).open();
          }),
      );

    const themes = this.plugin.settings.sourceAssist.customHighlightThemes;
    if (themes.length === 0) {
      containerEl.createDiv({
        cls: "setting-item-description mv-senceai-source-highlight-empty",
        text: "暂无自定义主题。内置主题可直接在上方源码类型中选择。",
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: "mv-senceai-source-highlight-theme-list" });
    for (const theme of themes) {
      new Setting(listEl)
        .setName(theme.name)
        .setDesc(`格式：${theme.format}；已保存为解析后的 token palette。`)
        .addButton((button) =>
          button
            .setButtonText("删除")
            .setWarning()
            .onClick(async () => {
              removeSourceHighlightThemeReferences(
                this.plugin.settings.sourceAssist,
                theme.id,
              );
              await this.plugin.saveSourceAssistSettings();
              this.rerenderSettings("source-assist");
            }),
        );
    }
  }

  private renderSourceAssistHotkeyIntro(containerEl: HTMLElement): void {
    containerEl.createDiv({
      cls: "setting-item-description mv-senceai-source-assist-hotkey-intro",
      text: "按键说明：手动触发按键用于触发非 automatic snippets；下一/上一 tabstop 用于在 $1/$2/$0 等占位点之间跳转。",
    });
  }

  private renderSourceAssistSnippetsEditor(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
  ): void {
    const setting = new Setting(containerEl)
      .setName("Snippets")
      .setDesc(
        "填写格式与 Latex Suite 的 snippets 设置一致；可以直接粘贴原 snippets 数组。行首 // 会按 JS 注释处理。",
      )
      .setClass("mv-senceai-source-assist-snippets-setting");
    setting.controlEl.empty();

    const editorWrap = setting.settingEl.createDiv({
      cls: "mv-senceai-snippets-editor-wrapper",
    });
    const footer = setting.settingEl.createDiv({
      cls: "mv-senceai-snippets-footer",
    });
    const view = createSourceAssistSnippetsEditor({
      containerEl: editorWrap,
      footerEl: footer,
      initialValue: profile.snippets,
      validate: async (value) => {
        const snippetVariables = await getDefaultSourceAssistSnippetVariables();
        await parseSnippets(
          value,
          snippetVariables,
        );
      },
      onValidChange: async (value) => {
        const target = this.plugin.settings.sourceAssist.profiles[idx];
        if (!target || target.snippets === value) return;
        target.snippets = value;
        await this.plugin.saveSourceAssistSettings();
      },
    });
    this.sourceAssistSnippetEditors.push(view);
  }

  private renderSourceAssistHotkeySetting(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
    key: "snippetsTrigger" | "snippetNextTabstopTrigger" | "snippetPreviousTabstopTrigger",
    name: string,
    description: string,
  ): void {
    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .setClass("mv-senceai-inline-hotkey-setting");
    const valueEl = setting.controlEl.createEl("span", {
      cls: "mv-senceai-inline-hotkey-value",
      text: formatInlineHotkeyLabel(profile[key]),
    });
    const input = setting.controlEl.createEl("input", {
      type: "text",
      attr: { value: profile[key], placeholder: "Tab" },
    });
    input.addClass("mv-senceai-source-assist-hotkey-input");

    const save = async (value: string) => {
      const target = this.plugin.settings.sourceAssist.profiles[idx];
      if (!target) return;
      target[key] = value.trim();
      input.value = target[key];
      valueEl.setText(formatInlineHotkeyLabel(target[key]));
      await this.plugin.saveSourceAssistSettings();
    };

    input.addEventListener("change", () => {
      void save(input.value);
    });

    setting.addDropdown((dropdown) => {
      for (const value of ["Tab", "Shift-Tab", "Enter", "Mod-Enter", "Mod-Space"]) {
        dropdown.addOption(value, value);
      }
      dropdown.addOption("__custom__", "手动录入");
      dropdown.setValue(["Tab", "Shift-Tab", "Enter", "Mod-Enter", "Mod-Space"].includes(profile[key]) ? profile[key] : "__custom__");
      dropdown.onChange((value) => {
        if (value === "__custom__") {
          input.focus();
          return;
        }
        void save(value);
      });
    });

    let cleanupRecording: (() => void) | null = null;
    const stopRecording = () => {
      cleanupRecording?.();
      cleanupRecording = null;
      valueEl.removeClass("is-recording");
      valueEl.setText(formatInlineHotkeyLabel(profile[key]));
    };

    setting.addButton((button) =>
      button.setButtonText("录制").onClick(() => {
        cleanupRecording?.();
        valueEl.addClass("is-recording");
        valueEl.setText("请按下快捷键...");
        let timeoutId: number | null = null;
        const onKeyDown = (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const next = eventToCodeMirrorKey(
            event,
            activeWindow.navigator.platform.toLowerCase().includes("mac"),
          );
          if (!next) return;
          void save(next).then(stopRecording);
        };
        cleanupRecording = () => {
          activeWindow.removeEventListener("keydown", onKeyDown, true);
          if (timeoutId !== null) {
            activeWindow.clearTimeout(timeoutId);
            timeoutId = null;
          }
        };
        activeWindow.addEventListener("keydown", onKeyDown, true);
        timeoutId = activeWindow.setTimeout(() => {
          stopRecording();
        }, 10_000);
      }),
    );
  }

  // ---- 行内补全：独立模块设置 ----

  private async saveInlineCompletionSettings(): Promise<void> {
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.refreshInlineCompletion();
  }

  private renderInlineCompletion(containerEl: HTMLElement): void {
    const cfg = this.plugin.settings.inlineCompletion;

    addHeading(containerEl, "总开关");
    new Setting(containerEl)
      .setName("启用行内补全")
      .setDesc(
        "开启后左侧功能区会出现「行内补全」按钮；按钮点亮时自动补全，未点亮时只响应手动请求按键。",
      )
      .addToggle((toggle) =>
        toggle.setValue(cfg.enabled).onChange(async (value) => {
          cfg.enabled = value;
          if (!value) {
            cfg.armed = false;
          }
          await this.saveInlineCompletionSettings();
          this.rerenderSettings("inline-completion");
        }),
      );

    addHeading(containerEl, "模型与上下文");
    new Setting(containerEl)
      .setName("补全模型")
      .setDesc("选择行内补全使用的提供商和模型；这里复用上方 API 提供商配置。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "（未选择提供商）");
        for (const provider of this.plugin.settings.llm.providers) {
          dropdown.addOption(provider.id, provider.name || "（未命名提供商）");
        }
        dropdown.setValue(cfg.providerId ?? "");
        dropdown.onChange(async (value) => {
          cfg.providerId = value || null;
          const provider = this.plugin.settings.llm.providers.find(
            (p) => p.id === cfg.providerId,
          );
          if (!provider?.models.some((m) => m.id === cfg.modelId)) {
            cfg.modelId = null;
          }
          await this.saveInlineCompletionSettings();
          this.rerenderSettings("inline-completion");
        });
      })
      .addDropdown((dropdown) => {
        const provider = this.plugin.settings.llm.providers.find(
          (p) => p.id === cfg.providerId,
        );
        if (!provider) {
          dropdown.addOption("", "（先选择提供商）");
          dropdown.setDisabled(true);
        } else if (provider.models.length === 0) {
          dropdown.addOption("", "（该提供商暂无模型）");
          dropdown.setDisabled(true);
        } else {
          dropdown.addOption("", "（未选择模型）");
          for (const model of provider.models) {
            dropdown.addOption(model.id, model.name || "（未命名模型）");
          }
          dropdown.setValue(cfg.modelId ?? "");
          dropdown.onChange(async (value) => {
            cfg.modelId = value || null;
            await this.saveInlineCompletionSettings();
          });
        }
      });

    new Setting(containerEl)
      .setName("思考")
      .setDesc(
        "决定是否在行内补全请求中携带思考参数。默认 = 不发送任何思考参数；自定义 = 你填的 JSON。",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("default", "默认")
          .addOption("on", "开")
          .addOption("off", "关")
          .addOption("custom", "自定义")
          .setValue(cfg.thinkingMode ?? "default")
          .onChange(async (value) => {
            cfg.thinkingMode = value as LlmThinkingMode;
            await this.saveInlineCompletionSettings();
            this.rerenderSettings("inline-completion");
          });
      })
      .addText((text) => {
        const isCustom = (cfg.thinkingMode ?? "default") === "custom";
        text.inputEl.toggleClass("mv-senceai-is-hidden", !isCustom);
        text
          .setPlaceholder('自定义 JSON，如 {"thinking":{"type":"enabled"}}')
          .setValue(cfg.thinkingCustom ?? "")
          .onChange(async (value) => {
            cfg.thinkingCustom = value;
            await this.saveInlineCompletionSettings();
          });
      });

    // ---- 补全提示词 ----
    addHeading(containerEl, "补全提示词");

    new Setting(containerEl)
      .setName("补全提示词主体")
      .setDesc("发送给模型的系统消息主体部分（角色描述 + 补全规则）。留空或清空则使用内置默认值。")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder("（使用默认提示词主体）")
          .setValue(cfg.systemPromptBody)
          .onChange(async (value) => {
            cfg.systemPromptBody = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText("恢复默认").onClick(async () => {
          cfg.systemPromptBody = DEFAULT_INLINE_SYSTEM_PROMPT_BODY;
          await this.saveInlineCompletionSettings();
          this.rerenderSettings("inline-completion");
        }),
      );

    {
      const sentinelMatch = DEFAULT_INLINE_NO_COMPLETION_PROMPT.match(/<[^>]+NO_COMPLETION>/);
      const sentinelToken = sentinelMatch ? sentinelMatch[0] : "<MV_SENCEAI_NO_COMPLETION>";
      const hintEl = containerEl.createEl("div", {
        text:
          `下方「${sentinelToken}」是无需补全时的返回标记。` +
          `如果修改或删除该标记，模型将无法正确抑制无效补全。`,
      });
      hintEl.addClass("mv-senceai-llm-hint");
    }

    new Setting(containerEl)
      .setName("无需补全指令")
      .setDesc("控制模型在无需补全时返回的 sentinel 标记指令。修改时请特别注意。")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder("（使用默认无需补全指令）")
          .setValue(cfg.noCompletionPrompt)
          .onChange(async (value) => {
            const defaultSentinel =
              DEFAULT_INLINE_NO_COMPLETION_PROMPT.match(/<[^>]+NO_COMPLETION>/)?.[0] ?? "";
            const userHasSentinel = defaultSentinel && value.includes(defaultSentinel);
            if (value.trim() && defaultSentinel && !userHasSentinel) {
              new Notice(
                "⚠️ 无需补全标记已变更，如果模型不返回该标记，可能导致无法正确抑制无效补全。",
                6000,
              );
            }
            cfg.noCompletionPrompt = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText("恢复默认").onClick(async () => {
          cfg.noCompletionPrompt = DEFAULT_INLINE_NO_COMPLETION_PROMPT;
          await this.saveInlineCompletionSettings();
          this.rerenderSettings("inline-completion");
        }),
      );

    new Setting(containerEl)
      .setName("拒绝后重生成指令")
      .setDesc(
        "按拒绝键后发送给模型的用户消息。支持 {rejected} 占位符代表被拒绝的补全文本；留空则使用内置默认值。",
      )
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder("（使用默认拒绝后重生成指令）")
          .setValue(cfg.rejectPrompt)
          .onChange(async (value) => {
            cfg.rejectPrompt = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText("恢复默认").onClick(async () => {
          cfg.rejectPrompt = DEFAULT_INLINE_REJECT_PROMPT;
          await this.saveInlineCompletionSettings();
          this.rerenderSettings("inline-completion");
        }),
      );

    const renderContextLimit = (
      key: "contextBeforeChars" | "contextAfterChars",
      name: string,
      desc: string,
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "100";
          text.inputEl.step = "100";
          text
            .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion[key]))
            .setValue(String(cfg[key]))
            .onChange(async (value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                cfg[key] = DEFAULT_SETTINGS.inlineCompletion[key];
              } else {
                const parsed = Number(trimmed);
                if (!Number.isFinite(parsed) || parsed < 100) return;
                cfg[key] = Math.floor(parsed);
              }
              await this.saveInlineCompletionSettings();
            });
        });
    };

    renderContextLimit(
      "contextBeforeChars",
      "光标前上下文长度",
      "发送给模型的光标前最多多少个 Markdown 源文本字符。留空则使用默认值。",
    );
    renderContextLimit(
      "contextAfterChars",
      "光标后上下文长度",
      "发送给模型的光标后最多多少个 Markdown 源文本字符。留空则使用默认值。",
    );

    new Setting(containerEl)
      .setName("触发延迟")
      .setDesc("停止输入后等待多少毫秒再请求补全。留空则使用默认值。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "50";
        text.inputEl.step = "50";
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion.debounceMs))
          .setValue(String(cfg.debounceMs))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              cfg.debounceMs = DEFAULT_SETTINGS.inlineCompletion.debounceMs;
            } else {
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed < 50) return;
              cfg.debounceMs = Math.floor(parsed);
            }
            await this.saveInlineCompletionSettings();
          });
      });

    new Setting(containerEl)
      .setName("最大补全字符数")
      .setDesc("限制 ghost text 的最大字符数。留空则使用默认值。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "10";
        text.inputEl.step = "10";
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion.maxChars))
          .setValue(String(cfg.maxChars))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              cfg.maxChars = DEFAULT_SETTINGS.inlineCompletion.maxChars;
            } else {
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed < 10) return;
              cfg.maxChars = Math.floor(parsed);
            }
            await this.saveInlineCompletionSettings();
          });
      });

    new Setting(containerEl)
      .setName("最大补全行数")
      .setDesc("限制 ghost text 的最大行数。留空则使用默认值。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion.maxLines))
          .setValue(String(cfg.maxLines))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              cfg.maxLines = DEFAULT_SETTINGS.inlineCompletion.maxLines;
            } else {
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed < 1) return;
              cfg.maxLines = Math.floor(parsed);
            }
            await this.saveInlineCompletionSettings();
          });
      });

    addHeading(containerEl, "快捷键");
    this.renderInlineHotkeyRecorder(
      containerEl,
      "accept",
      "接受按键",
      "插入当前 ghost text。点击录制后按下想绑定的快捷键。",
      DEFAULT_SETTINGS.inlineCompletion.keymap.accept,
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "reject",
      "拒绝按键",
      "可清空不绑定。绑定后会把被拒绝的补全发回模型并请求另一版。",
      "",
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "cancel",
      "取消按键",
      "只清空当前 ghost text，不请求模型。点击录制后按下想绑定的快捷键。",
      DEFAULT_SETTINGS.inlineCompletion.keymap.cancel,
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "request",
      "手动请求按键",
      "左侧按钮未点亮时也可用它请求一次补全。可清空不绑定。",
      "",
    );
  }

  private renderInlineHotkeyRecorder(
    containerEl: HTMLElement,
    key: keyof InlineCompletionKeymap,
    name: string,
    description: string,
    fallback: string,
  ): void {
    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .setClass("mv-senceai-inline-hotkey-setting");
    const valueEl = setting.controlEl.createEl("span", {
      cls: "mv-senceai-inline-hotkey-value",
      text: formatInlineHotkeyLabel(
        this.plugin.settings.inlineCompletion.keymap[key],
      ),
    });

    let cleanupRecording: (() => void) | null = null;
    const stopRecording = () => {
      cleanupRecording?.();
      cleanupRecording = null;
      valueEl.removeClass("is-recording");
      valueEl.setText(
        formatInlineHotkeyLabel(
          this.plugin.settings.inlineCompletion.keymap[key],
        ),
      );
    };
    const save = async (value: string) => {
      this.plugin.settings.inlineCompletion.keymap[key] = value;
      await this.saveInlineCompletionSettings();
      stopRecording();
    };

    setting.addButton((button) =>
      button.setButtonText("录制").onClick(() => {
        cleanupRecording?.();
        valueEl.addClass("is-recording");
        valueEl.setText("请按下快捷键...");
        let timeoutId: number | null = null;
        const onKeyDown = (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const next = eventToCodeMirrorKey(
            event,
            activeWindow.navigator.platform.toLowerCase().includes("mac"),
          );
          if (!next) return;
          void save(next);
        };
        cleanupRecording = () => {
          activeWindow.removeEventListener("keydown", onKeyDown, true);
          if (timeoutId !== null) {
            activeWindow.clearTimeout(timeoutId);
            timeoutId = null;
          }
        };
        activeWindow.addEventListener("keydown", onKeyDown, true);
        timeoutId = activeWindow.setTimeout(() => {
          stopRecording();
        }, 10_000);
      }),
    );

    if (fallback) {
      setting.addButton((button) =>
        button.setButtonText("恢复默认").onClick(() => {
          void save(fallback);
        }),
      );
    } else {
      setting.addButton((button) =>
        button.setButtonText("清空").onClick(() => {
          void save("");
        }),
      );
    }
  }

  // ---- 划词助手：API 提供商编辑 ----

  private renderProviders(containerEl: HTMLElement): void {
    const providers = this.plugin.settings.llm.providers;
    for (let i = 0; i < providers.length; i += 1) {
      const idx = i;
      const provider = providers[idx];
      if (!provider) continue;
      this.renderProvider(containerEl, idx, provider);
    }

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("新增提供商")
        .onClick(async () => {
          const next: LlmProviderConfig = {
            id: `provider-${Date.now()}`,
            name: "新提供商",
            type: "openai",
            baseUrl: "",
            apiKey: "",
            models: [],
            useProxy: false,
          };
          this.plugin.settings.llm.providers.push(next);
          await this.plugin.saveData(this.plugin.settings);
          this.rerenderSettings("llm");
        }),
    );
  }

  private renderProvider(
    containerEl: HTMLElement,
    idx: number,
    provider: LlmProviderConfig,
  ): void {
    const wrap = containerEl.createDiv({ cls: "mv-senceai-llm-provider" });
    const header = new Setting(wrap)
      .setClass("mv-senceai-llm-provider-header")
      .setHeading();

    // Provider name + type + delete, all in the header's control area.
    header.controlEl.empty();
    header.controlEl.addClass("mv-senceai-llm-provider-head");

    const nameInput = header.controlEl.createEl("input", {
      type: "text",
      attr: { placeholder: "提供商名称（如：白山）", value: provider.name },
    });
    nameInput.addClass("mv-senceai-llm-provider-name");
    nameInput.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.providers[idx];
      if (!target) return;
      target.name = nameInput.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    const typeSelect = header.controlEl.createEl("select");
    for (const opt of ["openai", "anthropic"] as LlmProviderType[]) {
      const o = typeSelect.createEl("option", {
        value: opt,
        text: opt === "anthropic" ? "Anthropic" : "OpenAI 兼容",
      });
      if (provider.type === opt) o.selected = true;
    }
    typeSelect.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.providers[idx];
      if (!target) return;
      target.type = typeSelect.value as LlmProviderType;
      await this.plugin.saveData(this.plugin.settings);
    });

    header.addExtraButton((btn) =>
      btn
        .setIcon("trash")
        .setTooltip("删除该提供商")
        .onClick(async () => {
          // Clear templates that referenced this provider.
          for (const t of this.plugin.settings.llm.templates) {
            if (t.providerId === provider.id) {
              t.providerId = null;
              t.modelId = null;
            }
          }
          if (this.plugin.settings.inlineCompletion.providerId === provider.id) {
            this.plugin.settings.inlineCompletion.providerId = null;
            this.plugin.settings.inlineCompletion.modelId = null;
          }
          this.plugin.settings.llm.providers.splice(idx, 1);
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.refreshInlineCompletion();
          this.rerenderSettings("llm");
        }),
    );

    new Setting(wrap)
      .setName("API Base URL")
      .setDesc(
        provider.type === "anthropic"
          ? "如 https://api.anthropic.com，插件自动追加 /v1/messages。"
          : "如 https://api.openai.com/v1，插件自动追加 /chat/completions。",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://...")
          .setValue(provider.baseUrl)
          .onChange(async (value) => {
            const target = this.plugin.settings.llm.providers[idx];
            if (!target) return;
            target.baseUrl = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(wrap)
      .setName("API Key")
      .setDesc("明文保存在插件 data.json。本地无鉴权服务（如 Ollama）可留空。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(provider.apiKey)
          .onChange(async (value) => {
            const target = this.plugin.settings.llm.providers[idx];
            if (!target) return;
            target.apiKey = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(wrap)
      .setName("绕过 CORS(代理模式)")
      .setDesc(
        "默认关闭(流式逐字输出)。开启后改用 Obsidian 内部网络通道,可绕过部分端点对 app:// Origin 的 CORS 拒绝(表现为『Failed to fetch』),但会失去流式、改为一次性返回。iphy 等报 CORS 错的端点请开启。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(provider.useProxy)
          .onChange(async (value) => {
            const target = this.plugin.settings.llm.providers[idx];
            if (!target) return;
            target.useProxy = value;
            await this.plugin.saveData(this.plugin.settings);
            this.rerenderSettings("llm");
          }),
      );

    // Models list.
    const modelsHeading = wrap.createEl("div", {
      text: "模型",
      cls: "mv-senceai-llm-models-label",
    });
    const modelsList = wrap.createDiv({ cls: "mv-senceai-llm-models" });
    const models = provider.models;
    for (let m = 0; m < models.length; m += 1) {
      const midx = m;
      const model = models[midx];
      if (!model) continue;
      const row = modelsList.createDiv({ cls: "mv-senceai-llm-model-row" });
      const input = row.createEl("input", {
        type: "text",
        attr: {
          placeholder: "模型名（如 GLM-5.1，即发往 API 的值）",
          value: model.name,
        },
      });
      input.addClass("mv-senceai-llm-model-name");
      input.addEventListener("change", async () => {
        const p = this.plugin.settings.llm.providers[idx];
        const target = p?.models[midx];
        if (!target) return;
        target.name = input.value;
        await this.plugin.saveData(this.plugin.settings);
      });

      const delBtn = row.createEl("button", { text: "删除", cls: "mv-senceai-llm-model-del" });
      delBtn.addEventListener("click", async () => {
        const p = this.plugin.settings.llm.providers[idx];
        if (!p) return;
        const removed = p.models[midx];
        p.models.splice(midx, 1);
        // Clear templates pointing at the removed model.
        if (removed) {
          for (const t of this.plugin.settings.llm.templates) {
            if (t.providerId === provider.id && t.modelId === removed.id) {
              t.modelId = null;
            }
          }
          if (
            this.plugin.settings.inlineCompletion.providerId === provider.id &&
            this.plugin.settings.inlineCompletion.modelId === removed.id
          ) {
            this.plugin.settings.inlineCompletion.modelId = null;
          }
        }
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.refreshInlineCompletion();
        this.rerenderSettings("llm");
      });
    }
    void modelsHeading; // label rendered above
    const addModelBtn = modelsList.createEl("button", {
      text: "+ 添加模型",
      cls: "mv-senceai-llm-model-add",
    });
    addModelBtn.addEventListener("click", async () => {
      const p = this.plugin.settings.llm.providers[idx];
      if (!p) return;
      const entry: LlmModelEntry = {
        id: `model-${Date.now()}`,
        name: "",
      };
      p.models.push(entry);
      await this.plugin.saveData(this.plugin.settings);
      this.rerenderSettings("llm");
    });
  }

  // ---- 划词助手：提示词模板编辑 ----

  private renderTemplates(containerEl: HTMLElement): void {
    const templates = this.plugin.settings.llm.templates;
    for (let i = 0; i < templates.length; i += 1) {
      const idx = i;
      const tpl = templates[idx];
      if (!tpl) continue;
      this.renderTemplate(containerEl, idx, tpl);
    }
  }

  private renderTemplate(
    containerEl: HTMLElement,
    idx: number,
    tpl: LlmPromptTemplate,
  ): void {
    const setting = new Setting(containerEl).setClass("mv-senceai-llm-tpl");
    setting.infoEl.empty();
    setting.infoEl.addClass("mv-senceai-llm-tpl-info");
    setting.controlEl.empty();
    setting.controlEl.addClass("mv-senceai-llm-tpl-control");

    const labelInput = setting.infoEl.createEl("input", {
      type: "text",
      attr: { placeholder: "菜单显示名（如：翻译）", value: tpl.label },
    });
    labelInput.addClass("mv-senceai-llm-tpl-label");
    labelInput.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.label = labelInput.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    const promptArea = setting.infoEl.createEl("textarea");
    promptArea.setAttr("rows", "3");
    promptArea.setAttr("placeholder", "提示词，可用 {selection} 占位符");
    promptArea.value = tpl.prompt;
    promptArea.addClass("mv-senceai-llm-tpl-prompt");
    promptArea.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.prompt = promptArea.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    // Model selection button + current selection summary, plus enable toggle.
    const modelBtn = setting.controlEl.createEl("button", {
      cls: "mv-senceai-llm-tpl-model",
    });
    const refreshModelLabel = () => {
      const p = this.plugin.settings.llm.providers.find((x) => x.id === tpl.providerId);
      const mdl = p?.models.find((x) => x.id === tpl.modelId);
      modelBtn.textContent = mdl && p ? `模型：${p.name} / ${mdl.name}` : "选择模型";
    };
    refreshModelLabel();
    modelBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("（清除选择）").onClick(async () => {
          const target = this.plugin.settings.llm.templates[idx];
          if (!target) return;
          target.providerId = null;
          target.modelId = null;
          await this.plugin.saveData(this.plugin.settings);
          tpl.providerId = null;
          tpl.modelId = null;
          refreshModelLabel();
        }),
      );
      for (const p of this.plugin.settings.llm.providers) {
        if (p.models.length === 0) continue;
        menu.addItem((item) =>
          item.setTitle(`${p.name} ▸`).setDisabled(true),
        );
        for (const m of p.models) {
          menu.addItem((item) =>
            item.setTitle(`  ${m.name || "（未命名模型）"}`).onClick(async () => {
              const target = this.plugin.settings.llm.templates[idx];
              if (!target) return;
              target.providerId = p.id;
              target.modelId = m.id;
              await this.plugin.saveData(this.plugin.settings);
              tpl.providerId = p.id;
              tpl.modelId = m.id;
              refreshModelLabel();
            }),
          );
        }
      }
      menu.showAtMouseEvent(evt as MouseEvent);
    });

    // 思考下拉（默认/开/关/自定义），紧跟「选择模型」之后。选「自定义」展开 JSON 框。
    const thinkingRow = setting.controlEl.createDiv({
      cls: "mv-senceai-llm-tpl-thinking-row",
    });
    const thinkingLabel = thinkingRow.createEl("span", {
      text: "思考",
      cls: "mv-senceai-llm-tpl-thinking-label",
    });
    void thinkingLabel;
    const thinkingSelect = thinkingRow.createEl("select");
    for (const opt of [
      { value: "default", text: "默认" },
      { value: "on", text: "开" },
      { value: "off", text: "关" },
      { value: "custom", text: "自定义" },
    ]) {
      const o = thinkingSelect.createEl("option", { value: opt.value, text: opt.text });
      if ((tpl.thinkingMode ?? "default") === opt.value) o.selected = true;
    }
    const customBox = thinkingRow.createEl("input", { type: "text" });
    customBox.addClass("mv-senceai-llm-tpl-thinking-custom");
    customBox.placeholder = '自定义 JSON，如 {"thinking":{"type":"enabled"}}';
    customBox.value = tpl.thinkingCustom ?? "";
    const refreshCustomVisibility = () => {
      customBox.style.display = thinkingSelect.value === "custom" ? "" : "none";
    };
    refreshCustomVisibility();
    thinkingSelect.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.thinkingMode = thinkingSelect.value as LlmThinkingMode;
      await this.plugin.saveData(this.plugin.settings);
      refreshCustomVisibility();
    });
    customBox.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.thinkingCustom = customBox.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    // 到位的小字提示（固定通用）。
    const thinkingHint = setting.infoEl.createEl("div", {
      text:
        "💡 思考下拉决定是否在请求中携带思考参数：" +
        "开 = {\"thinking\":{\"type\":\"enabled\"}}、关 = {\"thinking\":{\"type\":\"disabled\"}}、" +
        "自定义 = 你填的 JSON。默认 = 不发送任何思考参数（安全）。" +
        "是否被模型实际采纳取决于模型与端点，不支持的模型可能报错或忽略。",
      cls: "mv-senceai-llm-tpl-hint-thinking",
    });
    void thinkingHint;

    const enableRow = setting.controlEl.createDiv({
      cls: "mv-senceai-llm-tpl-enable-row",
    });
    const enableToggle = enableRow.createEl("input", { type: "checkbox" });
    enableToggle.checked = tpl.enabled;
    enableToggle.id = `mv-senceai-llm-tpl-enabled-${idx}`;
    const enableLabel = enableRow.createEl("label", { text: "启用" });
    enableLabel.setAttribute("for", enableToggle.id);
    enableToggle.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.enabled = enableToggle.checked;
      if (
        !target.enabled &&
        this.plugin.settings.llm.autoTriggerTemplateId === target.id
      ) {
        this.plugin.settings.llm.autoTriggerTemplateId = null;
      }
      await this.plugin.saveData(this.plugin.settings);
      this.plugin.refreshLlmFeature();
      new Notice(
        target.enabled ? `已启用：${target.label}` : `已关闭：${target.label}`,
        3000,
      );
    });

    setting.addExtraButton((btn) =>
      btn
        .setIcon("trash")
        .setTooltip("删除该模板")
        .onClick(async () => {
          const [removed] = this.plugin.settings.llm.templates.splice(idx, 1);
          if (
            removed &&
            this.plugin.settings.llm.autoTriggerTemplateId === removed.id
          ) {
            this.plugin.settings.llm.autoTriggerTemplateId = null;
          }
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.refreshLlmFeature();
          this.rerenderSettings("llm");
        }),
    );
  }
}
