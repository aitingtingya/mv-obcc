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
import { parseTexMathFormats } from "./source-assist/tex-math";
import {
  MARKDOWN_EXTERNAL_EXTENSIONS,
  externalFileAllowedExtensions,
  externalFileExtensionUniverse,
} from "./external-file-opener";
import { t } from "./i18n";
import { renderLintSetting } from "./lint/lint-settings-ui";
import { renderMvRunSetting } from "./terminal/mv-run-settings-ui";
import { renderRegexScopeSetting } from "./regex-replace/regex-replace-settings-ui";
import { EXTERNAL_FILE_MIRROR_FOLDER } from "./vault-storage-paths";
import type {
  DefaultOpenerOperationResult,
  ExternalFileOpenerOwner,
} from "./external-file-opener-system";
import { getDefaultSourceAssistSnippetVariables } from "./source-assist/default-snippet-variables";
import { createSourceAssistSnippetsEditor } from "./source-assist/snippets-editor";
import {
  browserLoginRuntimeStatus,
  openObsidianDownloadPage,
  WINDOWS_LOGIN_BASELINE,
} from "./webview-ua-compat";
import { parseSnippets } from "./vendor/latex-suite/src/snippets/parse";
import { vimSourceSettings } from "./vim/settings";
import { VIM_CURSOR_COLOR_THEMES } from "./vim/cursor-color";
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
  | "vim"
  | "external-file-opener"
  | "filesystem-browser";

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
    contentEl.createEl("h3", { text: t("添加新源码类型") });
    contentEl.createEl("p", {
      text: t("只输入文件后缀，不需要点号。例如 tex、bib、m。"),
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
    const submitButton = buttonRow.createEl("button", { text: t("添加") });
    submitButton.addClass("mod-cta");
    submitButton.addEventListener("click", () => this.submit());
    const cancelButton = buttonRow.createEl("button", { text: t("取消") });
    cancelButton.addEventListener("click", () => this.close());
    this.inputEl.focus();
  }

  private submit(): void {
    const extension = normalizeSourceAssistExtension(this.inputEl.value);
    if (!extension) {
      new Notice(t("请输入合法后缀：只能包含字母、数字、+、_、-，且不能以点开头。"));
      return;
    }
    this.onSubmit(extension);
    this.close();
  }
}

class SymlinkFallbackModal extends Modal {
  private statusEl!: HTMLElement;
  private readonly returnFocusEl: HTMLElement | null;

  constructor(
    app: App,
    private message: string,
    private readonly platform: NodeJS.Platform,
    private readonly fallbackAvailable: boolean,
    private readonly openDeveloperSettings: (() => Promise<void>) | null,
    private readonly repairAndRetry: (
      () => Promise<DefaultOpenerOperationResult>
    ) | null,
    private readonly retryInjection: () => Promise<DefaultOpenerOperationResult>,
    private readonly continueWithFallback: () => Promise<DefaultOpenerOperationResult>,
  ) {
    super(app);
    const activeElement = this.modalEl.ownerDocument.activeElement;
    this.returnFocusEl = activeElement
      && activeElement !== this.modalEl.ownerDocument.body
      && typeof (activeElement as HTMLElement).focus === "function"
      ? activeElement as HTMLElement
      : null;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.classList.add("mv-senceai-symlink-modal");
    this.modalEl.setAttribute("aria-busy", "false");
    contentEl.empty();
    contentEl.createEl("h3", {
      text: this.platform === "win32"
        ? t("Windows 符号链接修复")
        : t("符号链接不可用"),
    });
    contentEl.createEl("p", {
      text: t("插件始终优先创建并验证真实符号链接。只有该尝试明确失败后，才允许启用独立的受管临时副本；选择后，日常文件打开与同步保持静默。"),
      cls: "setting-item-description",
    });
    this.statusEl = contentEl.createEl("p", {
      text: this.message,
      cls: "setting-item-description",
    });
    this.statusEl.addClass("mv-senceai-status-error");
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.setAttribute("aria-atomic", "true");

    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    if (this.repairAndRetry) {
      const repairButton = buttonRow.createEl("button", {
        text: t("管理员修复并重试"),
      });
      repairButton.addClass("mod-cta");
      repairButton.addEventListener("click", () => {
        void this.run(repairButton, this.repairAndRetry!);
      });
    }
    if (this.openDeveloperSettings) {
      const settingsButton = buttonRow.createEl("button", {
        text: t("打开开发者设置"),
      });
      settingsButton.addEventListener("click", () => {
        settingsButton.disabled = true;
        this.modalEl.setAttribute("aria-busy", "true");
        void this.openDeveloperSettings!().finally(() => {
          settingsButton.disabled = false;
          this.modalEl.setAttribute("aria-busy", "false");
          if (settingsButton.isConnected) {
            settingsButton.focus({ preventScroll: true });
          }
        });
      });
    }
    const retryButton = buttonRow.createEl("button", { text: t("重新检测") });
    retryButton.addEventListener("click", () => {
      void this.run(retryButton, this.retryInjection);
    });
    if (this.fallbackAvailable) {
      const fallbackButton = buttonRow.createEl("button", {
        text: t("使用受管临时副本并继续"),
      });
      fallbackButton.addEventListener("click", () => {
        void this.run(fallbackButton, this.continueWithFallback);
      });
    }
    const cancelButton = buttonRow.createEl("button", { text: t("取消") });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    const returnFocusEl = this.returnFocusEl;
    queueMicrotask(() => {
      if (returnFocusEl?.isConnected) {
        returnFocusEl.focus({ preventScroll: true });
      }
    });
  }

  private async run(
    button: HTMLButtonElement,
    operation: () => Promise<DefaultOpenerOperationResult>,
  ): Promise<void> {
    button.disabled = true;
    this.modalEl.setAttribute("aria-busy", "true");
    try {
      const result = await operation();
      this.message = result.message;
      this.statusEl.setText(result.message);
      if (result.ok) this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.message = message;
      this.statusEl.setText(message);
    } finally {
      button.disabled = false;
      this.modalEl.setAttribute("aria-busy", "false");
      if (button.isConnected) {
        button.focus({ preventScroll: true });
      }
    }
  }
}

class WindowsDefaultAppConfirmationModal extends Modal {
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private status: DefaultOpenerOperationResult["status"],
    private readonly openDefaultAppsSettings: () => Promise<void>,
    private readonly recheck: () => Promise<DefaultOpenerOperationResult["status"]>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("Windows 默认应用确认") });
    contentEl.createEl("p", {
      text: t("MV AIDE File Opener 已注册为候选应用。Windows 要求您在系统界面中确认每个文件后缀的默认打开方式。"),
      cls: "setting-item-description",
    });
    this.statusEl = contentEl.createEl("p", {
      text: this.status.message,
      cls: "setting-item-description",
    });

    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    const settingsButton = buttonRow.createEl("button", {
      text: t("打开默认应用设置"),
    });
    settingsButton.addClass("mod-cta");
    settingsButton.addEventListener("click", () => {
      void this.openDefaultAppsSettings();
    });
    const retryButton = buttonRow.createEl("button", { text: t("重新检查") });
    retryButton.addEventListener("click", () => {
      void this.retry(retryButton);
    });
    const cancelButton = buttonRow.createEl("button", { text: t("稍后") });
    cancelButton.addEventListener("click", () => this.close());
  }

  private async retry(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      this.status = await this.recheck();
      this.statusEl.setText(this.status.message);
      if (this.status.kind !== "not-default") this.close();
    } finally {
      button.disabled = false;
    }
  }
}

class WindowsOtherVaultCleanupModal extends Modal {
  constructor(
    app: App,
    private readonly owner: ExternalFileOpenerOwner,
    private readonly confirmCleanup: () => Promise<DefaultOpenerOperationResult | null>,
    private readonly onResult: (result: DefaultOpenerOperationResult) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("确认清理其它仓库的默认打开器") });
    contentEl.createEl("p", {
      text: t("当前 Windows 默认打开器 owner 属于其它仓库。只有确认 owner 在等待期间没有变化后，插件才会执行精确清理。"),
      cls: "setting-item-description",
    });
    contentEl.createEl("p", {
      text: t("仓库：{path}", { path: this.owner.vaultRoot }),
      cls: "setting-item-description",
    });
    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    const confirmButton = buttonRow.createEl("button", { text: t("确认清理") });
    confirmButton.addClass("mod-warning");
    confirmButton.addEventListener("click", () => {
      void this.confirm(confirmButton);
    });
    const cancelButton = buttonRow.createEl("button", { text: t("取消") });
    cancelButton.addEventListener("click", () => this.close());
  }

  private async confirm(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const result = await this.confirmCleanup();
      if (!result) return;
      this.close();
      this.onResult(result);
    } finally {
      button.disabled = false;
    }
  }
}

class WindowsCleanupCompleteModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly openDefaultAppsSettings: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("Windows 默认打开器已清理") });
    contentEl.createEl("p", {
      text: this.message,
      cls: "setting-item-description",
    });
    contentEl.createEl("p", {
      text: t("Windows 受保护的默认应用选择不会被插件修改。如需为这些后缀改选其它应用，可以打开系统默认应用设置。"),
      cls: "setting-item-description",
    });
    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    const settingsButton = buttonRow.createEl("button", {
      text: t("打开默认应用设置"),
    });
    settingsButton.addClass("mod-cta");
    settingsButton.addEventListener("click", () => {
      void this.openDefaultAppsSettings();
      this.close();
    });
    const closeButton = buttonRow.createEl("button", { text: t("稍后") });
    closeButton.addEventListener("click", () => this.close());
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
    contentEl.createEl("h3", { text: t("载入自定义代码高亮主题") });
    contentEl.createEl("p", {
      text: t("支持 Prism CSS、highlight.js CSS、VS Code/Shiki/TextMate JSON 和 mv-AIDE JSON。非 Prism 格式会转换为近似效果，不能完全还原原主题。"),
      cls: "setting-item-description",
    });

    const fileSetting = new Setting(contentEl)
      .setName(t("主题文件"))
      .setDesc(t("选择本地已下载的 .css 或 .json 主题文件。插件只保存解析后的颜色数据。"))
      .setClass("mv-senceai-theme-file-setting");
    this.fileEl = fileSetting.controlEl.createEl("input", {
      type: "file",
      attr: { accept: ".css,.json" },
    });

    new Setting(contentEl)
      .setName(t("主题名称（可选）"))
      .addText((text) => {
        this.nameEl = text.inputEl;
        text.setPlaceholder(t("留空则使用文件名或主题内置名称"));
      });

    new Setting(contentEl)
      .setName(t("主题格式"))
      .setDesc(t("自动检测失败时可手动指定格式。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", t("自动检测"))
          .addOption("prism-css", "Prism CSS")
          .addOption("highlight-js-css", "highlight.js CSS")
          .addOption("textmate-json", "VS Code / Shiki / TextMate JSON")
          .addOption("mv-senceai-json", "mv-AIDE JSON")
          .setValue(this.format)
          .onChange((value) => {
            this.format = value as SourceHighlightImportFormat;
          }),
      );

    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    const importButton = buttonRow.createEl("button", { text: t("载入") });
    importButton.addClass("mod-cta");
    importButton.addEventListener("click", () => {
      void this.submit();
    });
    const cancelButton = buttonRow.createEl("button", { text: t("取消") });
    cancelButton.addEventListener("click", () => this.close());
  }

  private async submit(): Promise<void> {
    const file = this.fileEl.files?.[0];
    if (!file) {
      new Notice(t("请选择一个主题文件。"));
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
      new Notice(t("主题载入失败：{message}", { message }));
      console.warn("[mv-aide] Failed to import source highlight theme.", error);
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
    name: t("新建 .{ext} 文件", { ext: extension }),
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
  private readonly openIdeSubsectionIds = new Set<string>();
  private readonly openSourceAssistProfileIds = new Set<string>();
  private readonly openVimSourceProfileExtensions = new Set<string>();
  private readonly sourceAssistSnippetEditors: EditorView[] = [];
  private forceOpenSection: MainSettingsSectionId | null = null;
  private forceOpenSourceAssistProfileId: string | null = null;
  private defaultOpenerOperationPending = false;

  constructor(app: App, private readonly plugin: MvSenceAiIdePlugin) {
    super(app, plugin);
  }

  display(): void {
    const rootEl = this.containerEl;
    const previousScrollTop = this.captureSettingsUiState(rootEl);
    this.destroySourceAssistSnippetEditors();
    rootEl.empty();
    addHeading(rootEl, this.plugin.manifest.name || "mv-AIDE");

    new Setting(rootEl)
      .setName(t("界面语言"))
      .setDesc(t("切换插件界面显示语言，立即生效。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh", t("中文"))
          .addOption("en", "English")
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            await this.plugin.applyLanguage(value as "zh" | "en");
            this.rerenderSettings();
          }),
      );

    const ideEl = this.createSettingsSection(rootEl, "ide", t("IDE桥接"));
    const llmEl = this.createSettingsSection(rootEl, "llm", t("划词助手"));
    const inlineCompletionEl = this.createSettingsSection(
      rootEl,
      "inline-completion",
      t("行内补全"),
    );
    const terminalEl = this.createSettingsSection(rootEl, "terminal", t("终端"));
    const sourceAssistEl = this.createSettingsSection(
      rootEl,
      "source-assist",
      t("源码编写辅助"),
    );
    const vimEl = this.createSettingsSection(rootEl, "vim", t("Vim 增强"));
    const externalFileOpenerEl = this.createSettingsSection(
      rootEl,
      "external-file-opener",
      t("默认文件打开器"),
    );
    const filesystemBrowserEl = this.createSettingsSection(
      rootEl,
      "filesystem-browser",
      t("文件系统与浏览器"),
    );
    let containerEl = ideEl;

    const universalMcpEl = this.createIdeSubsection(
      containerEl,
      "universal-mcp",
      t("暴露 mv-AIDE 协议"),
    );
    this.renderIdeUniversalMcpSettings(universalMcpEl);

    const agentsEl = this.createIdeSubsection(
      containerEl,
      "agents",
      t("已适配 agent"),
    );
    this.renderIdeUpstreamSettings(agentsEl);
    this.renderIdeClaudeSettings(agentsEl);
    this.renderIdeCodexSettings(agentsEl);

    const passiveEl = this.createIdeSubsection(
      containerEl,
      "passive",
      t("被动工具"),
    );
    this.renderIdeVisualAssistSettings(passiveEl);
    this.renderIdeActivityTrackingSettings(passiveEl);
    this.renderIdeDiffSettings(passiveEl);
    this.renderIdeMaintenanceSettings(passiveEl);

    const activeEl = this.createIdeSubsection(
      containerEl,
      "active",
      t("主动工具"),
    );
    this.renderIdeMcpToolSettings(activeEl);

    containerEl = sourceAssistEl;
    this.renderSourceAssistSettings(containerEl);

    containerEl = vimEl;
    this.renderVimSettings(containerEl);

    containerEl = externalFileOpenerEl;
    this.renderExternalFileOpenerSettings(containerEl);

    containerEl = filesystemBrowserEl;
    this.renderFilesystemBrowserSettings(containerEl);

    containerEl = llmEl;
    containerEl.createEl("div", {
      text: t("🤖 API 提供商（划词助手与行内补全共用）"),
      cls: "mv-senceai-section-title setting-item-name",
    });
    addHeading(containerEl, t("API 提供商"));
    {
      const tip = containerEl.createEl("p", {
        text: t("API Base URL 和模型必填；API Key 仅对需要鉴权的服务必填，本地无鉴权服务可留空。"),
      });
      tip.addClass("mv-senceai-llm-hint");
    }
    this.renderProviders(containerEl);

    containerEl = inlineCompletionEl;
    containerEl.createEl("div", {
      text: t("⌨️ 行内补全（Markdown 续写）"),
      cls: "mv-senceai-section-title setting-item-name",
    });
    this.renderInlineCompletion(containerEl);

    containerEl = llmEl;
    containerEl.createEl("div", {
      text: t("✍️ 划词助手（选词调用 LLM）"),
      cls: "mv-senceai-section-title setting-item-name",
    });
    addHeading(containerEl, t("总开关"));

    new Setting(containerEl)
      .setName(t("启用"))
      .setDesc(
        t("完全独立于 IDE 桥接。开启后，在 Markdown / PDF / Web Viewer 中划词，右键或快捷键即可用预设提示词调用 LLM。"),
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
        text: t("提示：PDF 视图的右键被 Obsidian / pdf++ 占用，无法注入 LLM 菜单，请用快捷键触发（在「快捷键设置」里给「LLM：xxx」命令绑键）。网页视图（Web Viewer）里，Obsidian 的快捷键因焦点隔离无法直接生效，插件会自动把你已绑定的「LLM：xxx」快捷键同步注入网页，所以网页里用同一个快捷键即可。"),
      });
      tip.addClass("mv-senceai-llm-hint");
    }

    if (this.plugin.settings.llm.enabled) {
      new Setting(containerEl)
        .setName(t("网页视图注入右键菜单（实验性）"))
        .setDesc(
          t("因网页视图跨域隔离，Obsidian 读不到网页内的选区。开启后会向网页注入脚本，在网页内显示我们的右键菜单（会屏蔽网页原生右键，部分站点可能失效）。关闭时网页视图改用快捷键调用。"),
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.llm.webContextMenu)
            .onChange(async (value) => {
              this.plugin.settings.llm.webContextMenu = value;
              await this.plugin.saveData(this.plugin.settings);
              new Notice(
                value
                  ? t("已开启网页右键菜单，将在网页内注入。")
                  : t("已关闭，网页视图请用快捷键调用。"),
                4000,
              );
            }),
        );

      // ---- 悬浮窗行为 + 划词自动触发 ----
      addHeading(containerEl, t("悬浮窗与自动触发"));

      // 自动触发模板：下拉列出所有「已启用」的模板 + 一个「（关闭）」选项。
      // 仅当存在至少一个已启用模板时才显示，否则给一条提示。
      const enabledTemplates = this.plugin.settings.llm.templates.filter(
        (t) => t.enabled,
      );
      if (enabledTemplates.length === 0) {
        new Setting(containerEl)
          .setName(t("划词自动触发模板"))
          .setDesc(t("当前没有已启用的模板，无法设置自动触发。请先在下方启用至少一个模板。"));
      } else {
        new Setting(containerEl)
          .setName(t("划词自动触发模板"))
          .setDesc(
            t("选择一个模板后，左侧功能区会出现「划词自动触发」按钮（点亮后才生效，每次启动默认关闭）。点亮后划词会自动用所选模板调用助手；所选模板若被关闭或删除，按钮会自动消失。"),
          )
          .addDropdown((dropdown) => {
            dropdown.addOption("", t("（关闭）"));
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
      addHeading(containerEl, t("提示词模板"));
      const hint = containerEl.createEl("div", {
        text: t("提示词中可用 {selection} 占位符表示划词内容；不含占位符时，划词会自动追加到末尾。每个模板可单独开关，并选择用哪个提供商的哪个模型。"),
      });
      hint.addClass("mv-senceai-llm-hint");
      this.renderTemplates(containerEl);

      new Setting(containerEl).addButton((btn) =>
        btn
          .setButtonText(t("新增提示词模板"))
          .setCta()
          .onClick(async () => {
            const next: LlmPromptTemplate = {
              id: `tpl-${Date.now()}`,
              label: t("新模板"),
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
      text: t("💻 终端设置"),
      cls: "mv-senceai-section-title setting-item-name",
    });

    addHeading(containerEl, t("打开与主题"));

    new Setting(containerEl)
      .setName(t("终端打开位置"))
      .setDesc(t("选择新终端视图默认打开的面板区域。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("tab", t("中间主栏 (Middle Main Split / Tabs)"))
          .addOption("left", t("左侧边栏 (Left Sidebar)"))
          .addOption("right", t("右侧边栏 (Right Sidebar)"))
          .addOption("bottom", t("底部拆分栏 (Bottom Split Pane)"))
          .setValue(this.plugin.settings.terminalOpenPosition || "right")
          .onChange(async (value) => {
            this.plugin.settings.terminalOpenPosition = value as any;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    this.renderTerminalThemeSettings(containerEl);

    addHeading(containerEl, t("Shell 配置"));

    new Setting(containerEl)
      .setName(t("macOS/Linux Shell 路径"))
      .setDesc(t("自定义 macOS/Linux 系统下的终端 Shell。留空则默认为 $SHELL 或 /bin/zsh。"))
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
      .setName(t("macOS/Linux Shell 参数"))
      .setDesc(t("启动 macOS/Linux Shell 时的命令行参数（以空格分隔）。默认为 -l。"))
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
      .setName(t("Windows Shell 路径"))
      .setDesc(t("自定义 Windows 系统下的终端 Shell。留空则默认为 cmd.exe。"))
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
      .setName(t("Windows Shell 参数"))
      .setDesc(t("启动 Windows Shell 时的命令行参数（以空格分隔）。留空则不传参数。"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.terminalWinShellArgs)
          .onChange(async (value) => {
            this.plugin.settings.terminalWinShellArgs = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    addHeading(containerEl, t("字体与字号"));

    new Setting(containerEl)
      .setName(t("自定义终端字体 (Font Family)"))
      .setDesc(t("填写您在终端中使用的等宽字体（例如 'MesloLGS NF' 或 'Fira Code' 等 Nerd Font），以完美展示各类图标。留空默认使用 Menlo, Monaco, monospace。"))
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
      .setName(t("终端字号 (Font Size)"))
      .setDesc(t("设置终端内字体大小。留空则默认为 13px。"))
      .addText((text) =>
        text
          .setPlaceholder("13")
          .setValue(this.plugin.settings.terminalFontSize || "")
          .onChange(async (value) => {
            this.plugin.settings.terminalFontSize = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName(t("终端按键直通 (Key passthrough)"))
      .setDesc(t("终端聚焦时，将 Ctrl/Alt/F 键/方向键组合等按键直接发送给终端程序（与系统终端行为一致），不再触发 Obsidian 快捷键。关闭则恢复 Obsidian 快捷键优先。"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.terminalKeyPassthrough !== false)
          .onChange(async (value) => {
            this.plugin.settings.terminalKeyPassthrough = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    addHeading(containerEl, t("Python 与依赖"));

    new Setting(containerEl)
      .setName(t("Python 可执行文件路径"))
      .setDesc(t("用于运行 PTY 封装脚本的 Python 3 路径。留空则在系统 PATH 中自动寻找。"))
      .addText((text) =>
        text
          .setPlaceholder(t("python3 或 py"))
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

    // pywinpty 仅 Windows 需要，非 Windows 不渲染该区块
    if (process.platform === "win32")
      new Setting(containerEl)
      .setName(t("Windows 依赖管理 (pywinpty)"))
      .setDesc(t("Windows 用户运行终端必须安装 winpty 依赖。点击右侧按钮进行检测或一键更新。"))
      .addButton((button) =>
        button
          .setButtonText(t("检测依赖"))
          .onClick(async () => {
            new Notice(t("正在检测 Windows 依赖 (winpty)..."));
            const pythonCmd = getPythonCmd();
            child_process.execFile(pythonCmd, ["-c", "import winpty"], { windowsHide: true }, (error) => {
              if (error) {
                new Notice(t("❌ Windows 依赖检测失败：未检测到 winpty 库，请点击右侧按钮安装。"));
              } else {
                new Notice(t("✅ Windows 依赖检测成功：已检测到 winpty 库，终端可以正常运行。"));
              }
            });
          })
      )
      .addButton((button) =>
        button
          .setButtonText(t("更新依赖"))
          .onClick(async () => {
            new Notice(t("正在后台更新 Windows 依赖 (pywinpty)..."));
            const pythonCmd = getPythonCmd();
            const installArgs = ["-m", "pip", "install", "-U", "pywinpty"];
            const installCmd = [pythonCmd, ...installArgs].join(" ");
            new Notice(t("运行命令: {cmd}", { cmd: installCmd }));
            child_process.execFile(pythonCmd, installArgs, { windowsHide: true }, (error) => {
              if (error) {
                new Notice(t("❌ Windows 依赖更新失败:\n{message}", { message: error.message }));
                console.error(error);
              } else {
                new Notice(t("✅ Windows 依赖 (pywinpty) 更新成功！"));
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

  private createIdeSubsection(
    containerEl: HTMLElement,
    id: string,
    title: string,
  ): HTMLElement {
    const details = containerEl.createEl("details", {
      cls: "mv-senceai-ide-subsection",
    });
    details.dataset.subsectionId = id;
    details.open = this.openIdeSubsectionIds.has(id);
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openIdeSubsectionIds.add(id);
      } else {
        this.openIdeSubsectionIds.delete(id);
      }
    });
    details.createEl("summary", {
      text: title,
      cls: "mv-senceai-settings-section-summary setting-item-name",
    });
    return details.createDiv({ cls: "mv-senceai-settings-section-body" });
  }

  private renderIdeUniversalMcpSettings(containerEl: HTMLElement): void {
    const universalSetting = new Setting(containerEl)
      .setName(t("暴露 mv-AIDE 协议"))
      .setDesc(
        t("默认关闭。开启后通过标准 MCP 协议完整暴露 IDE 桥接能力：全部 8 个 IDE 工具（含 openDiff 人工审核）与状态感知资源（工作区上下文、打开的标签、最新选区、@ 提及），用户可以自行接入其它 agent。仅本机 127.0.0.1 提供 Streamable HTTP 与 stdio 接入，在 Obsidian 启动完成后的空闲阶段加载；不影响 Claude Code、Codex 与 MCP 工具开关。"),
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.universalMcp.enabled)
          .onChange(async (value) => {
            this.plugin.settings.universalMcp.enabled = value;
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("ide");
          }),
      );
    universalSetting.settingEl.addClass("mv-senceai-universal-mcp-setting");

    const universalStatus = new Setting(containerEl)
      .setName(t("mv-AIDE 协议状态"))
      .setDesc(this.plugin.universalMcpStatus);
    universalStatus.settingEl.addClass("mv-senceai-universal-mcp-setting");
    universalStatus.descEl.setAttribute("aria-live", "polite");

    if (this.plugin.settings.universalMcp.enabled) {
      const protocolSetting = new Setting(containerEl)
        .setName(t("通用 MCP 协议版本"))
        .setDesc(t("2026-07-28、2025-11-25、2025-03-26（由客户端协商）"));
      protocolSetting.settingEl.addClass("mv-senceai-universal-mcp-setting");

      const copyConfig = async (
        config: string | null,
        label: string,
      ): Promise<void> => {
        if (!config) {
          new Notice(t("mv-AIDE 协议尚未就绪，请在 Obsidian 启动完成后刷新状态。"));
          return;
        }
        try {
          await navigator.clipboard.writeText(config);
          new Notice(t("{label}已复制", { label }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(t("复制失败：{message}", { message }), 8000);
        }
      };

      const connectionSetting = new Setting(containerEl)
        .setName(t("通用 Agent 连接配置"))
        .setDesc(
          t("HTTP 和 stdio 使用同一套标准能力。stdio 只连接已经运行的 Obsidian，不会自行启动 Obsidian。"),
        )
        .addButton((button) => {
          const config = this.plugin.getUniversalMcpHttpConfig();
          button
            .setButtonText(t("复制 HTTP 配置"))
            .setDisabled(!config)
            .onClick(() => copyConfig(config, t("HTTP 配置")));
        })
        .addButton((button) => {
          // 禁用判断只查运行时是否就绪；配置在用户点击时才生成，
          // 避免设置页渲染时同步探测系统 Node（spawnSync）卡住主线程。
          button
            .setButtonText(t("复制 stdio 配置"))
            .setDisabled(!this.plugin.hasUniversalMcpRuntime())
            .onClick(async () =>
              copyConfig(await this.plugin.getUniversalMcpStdioConfig(), t("stdio 配置")),
            );
        })
        .addButton((button) =>
          button.setButtonText(t("刷新状态")).onClick(() => {
            this.rerenderSettings("ide");
          }),
        )
        .addButton((button) =>
          button.setButtonText(t("轮换令牌")).onClick(async () => {
            await this.plugin.rotateUniversalMcpToken();
            new Notice(t("mv-AIDE 协议令牌已轮换，请更新所有客户端配置。"));
            this.rerenderSettings("ide");
          }),
        );
      connectionSetting.settingEl.addClass("mv-senceai-universal-mcp-setting");
    }
  }

  private renderIdeUpstreamSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("上游兼容"));
    new Setting(containerEl)
      .setName(t("上游模式"))
      .setDesc(
        t("原生模式不改请求；兼容模式会把 IDE system 上下文移动到对应 user 消息中，不会复制两份。"),
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("native", t("原生"))
          .addOption("compatibility", t("兼容"))
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
        .setName(t("Anthropic 上游地址（可选）"))
        .setDesc(
          t("留空时自动读取 Claude 配置。只有需要覆盖自动结果时才填写。"),
        )
        .addText((text) =>
          text
            .setPlaceholder(t("留空以自动读取"))
            .setValue(this.plugin.settings.upstreamBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.upstreamBaseUrl = value.trim();
              await this.plugin.saveAndApplySettings();
            }),
        );

      new Setting(containerEl)
        .setName(t("当前识别的上游"))
        .setDesc(t("来源：{source}", { source: t(SOURCE_LABELS[resolved.source]) }))
        .addText((text) =>
          text.setValue(resolved.url || t("未找到 ANTHROPIC_BASE_URL")).setDisabled(true),
        );

      new Setting(containerEl)
        .setName(t("自动管理当前仓库的 Claude 设置"))
        .setDesc(
          t("仅把当前仓库的 ANTHROPIC_BASE_URL 指向本地兼容端点；关闭时恢复插件接管前的值。"),
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
  }

  private renderIdeClaudeSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("Claude Code"));
    const claudeSetting = new Setting(containerEl)
      .setName(t("启用 Claude Code IDE 功能"))
      .setDesc(t("默认开启。关闭后不写 Claude IDE lock、不注册 Claude MCP、不接管 Claude 设置。"))
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
      claudeStatusEl.setText(t("状态：已禁用"));
      claudeStatusEl.addClass("mv-senceai-status-muted");
    } else if (this.plugin.claudeIdeError) {
      claudeStatusEl.setText(t("● 启动失败: {error}", { error: this.plugin.claudeIdeError }));
      claudeStatusEl.addClass("mv-senceai-status-error");
    } else {
      claudeStatusEl.setText(t("● 运行中"));
      claudeStatusEl.addClass("mv-senceai-status-success");
    }

    new Setting(containerEl)
      .setName(t("Claude 可执行文件"))
      .setDesc(t("通常自动检测。Windows 或自定义安装位置可在此填写完整路径。"))
      .addText((text) =>
        text
          .setPlaceholder(t("自动检测"))
          .setValue(this.plugin.settings.claudeExecutable)
          .onChange(async (value) => {
            this.plugin.settings.claudeExecutable = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          }),
      );
  }

  private renderIdeCodexSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("Codex"));
    const codexSetting = new Setting(containerEl)
      .setName(t("启用 Codex IDE 功能"))
      .setDesc(t("默认关闭。开启后支持 Codex CLI /ide，并把本插件 MCP 工具写入 Codex 配置。"))
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
      codexStatusEl.setText(t("状态：已禁用"));
      codexStatusEl.addClass("mv-senceai-status-muted");
    } else if (this.plugin.codexIdeError) {
      codexStatusEl.setText(t("● 启动失败: {error}", { error: this.plugin.codexIdeError }));
      codexStatusEl.addClass("mv-senceai-status-error");
    } else {
      codexStatusEl.setText(t("● 运行中"));
      codexStatusEl.addClass("mv-senceai-status-success");
    }

    new Setting(containerEl)
      .setName(t("Codex 可执行文件"))
      .setDesc(t("通常自动检测为 codex。自定义安装位置可在此填写完整路径。"))
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

  private renderIdeVisualAssistSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("视觉辅助"));
    new Setting(containerEl)
      .setName(t("切换标签时保留选区高亮"))
      .setDesc(
        t("默认开启。切换到终端等特殊标签后仍显示 Markdown、PDF 和网页中最后一次划词；回到原页面空点或重新划词时继续遵循 Obsidian 原有行为。此功能不影响发送给 Claude 的选区。"),
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.preserveSelectionHighlights)
          .onChange(async (value) => {
            await this.plugin.setSelectionHighlightsEnabled(value);
          }),
      );

    addHeading(containerEl, t("内置浏览器"));
    const runtime = browserLoginRuntimeStatus(process.platform, {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    });
    const electronVersion = runtime.electronVersion ?? t("未知");
    const chromiumVersion = runtime.chromiumVersion ?? t("未知");
    let runtimeDescription: string;
    if (runtime.state === "supported") {
      runtimeDescription = t(
        "当前 Electron {electron} / Chromium {chromium} 已达到登录验收基线。插件保持原生 Windows Chromium 身份，不再伪装 Safari 或修改 WebAuthn。",
        { electron: electronVersion, chromium: chromiumVersion },
      );
    } else if (runtime.state === "outdated") {
      runtimeDescription = t(
        "当前 Electron {electron} / Chromium {chromium} 低于登录验收基线 Electron {electronBaseline} / Chromium {chromiumBaseline}。Obsidian 核心自动更新不会升级浏览器内核，请覆盖安装最新版 installer；无需卸载。插件不会用 UA 伪装绕过此限制。",
        {
          electron: electronVersion,
          chromium: chromiumVersion,
          electronBaseline: String(WINDOWS_LOGIN_BASELINE.electronMajor),
          chromiumBaseline: String(WINDOWS_LOGIN_BASELINE.chromiumMajor),
        },
      );
    } else if (runtime.state === "unknown") {
      runtimeDescription = t(
        "无法读取当前 Electron/Chromium 版本。插件不会修改浏览器 UA、WebAuthn、Cookie 或网络请求；建议覆盖安装最新版 Obsidian installer 后重试登录。",
      );
    } else {
      runtimeDescription = t(
        "插件保持 Obsidian 内置浏览器的原生平台身份，不修改 UA、WebAuthn、Cookie 或网络请求。",
      );
    }
    const runtimeSetting = new Setting(containerEl)
      .setName(t("内置浏览器登录环境"))
      .setDesc(runtimeDescription);
    if (runtime.state === "outdated" || runtime.state === "unknown") {
      runtimeSetting.addButton((button) =>
        button
          .setButtonText(t("下载最新版 Obsidian"))
          .setCta()
          .onClick(async () => {
            try {
              await openObsidianDownloadPage();
            } catch (error) {
              new Notice(
                t("无法打开 Obsidian 下载页：{message}", {
                  message: error instanceof Error ? error.message : String(error),
                }),
                8000,
              );
            }
          }),
      );
    }
  }

  private renderIdeActivityTrackingSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("状态感知"));
    new Setting(containerEl)
      .setName(t("支持所有活动页面"))
      .setDesc(
        t("默认关闭。开启后追踪任意 Obsidian 标签，并通过 Claude 会话 PID 和终端标题标记精确忽略该会话自己的终端；改变后请重新启动 Claude Code。"),
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

    new Setting(containerEl)
      .setName(t("推送 lint 错误计数"))
      .setDesc(
        t("lint 诊断更新时向 MCP 客户端推送各文件错误计数；只推错误，不推警告。"),
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.activityTracking.pushLintErrors)
          .onChange(async (value) => {
            this.plugin.settings.activityTracking.pushLintErrors = value;
            await this.plugin.saveAndApplySettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("快照附 heading 面包屑"))
      .setDesc(
        t("在选区快照中附带光标所在 heading 层级路径；仅对 Markdown 和 LaTeX 文件生效。"),
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.activityTracking.includeHeadingBreadcrumb)
          .onChange(async (value) => {
            this.plugin.settings.activityTracking.includeHeadingBreadcrumb = value;
            await this.plugin.saveAndApplySettings();
          }),
      );

    const pageTypes: Array<{
      key: "trackMarkdown" | "trackPdf" | "trackWebview";
      name: string;
      description: string;
    }> = [
      {
        key: "trackMarkdown",
        name: t("追踪 Markdown 页面"),
        description: t("追踪当前 Markdown 文件、光标和选区。"),
      },
      {
        key: "trackPdf",
        name: t("追踪 PDF 页面"),
        description: t("追踪当前 PDF 文件、页码和文本选区。"),
      },
      {
        key: "trackWebview",
        name: t("追踪 Web Viewer 页面"),
        description: t("追踪 Obsidian 内置浏览器的标题、URL 和文本选区。"),
      },
    ];
    for (const pageType of pageTypes) {
      new Setting(containerEl)
        .setName(pageType.name)
        .setDesc(
          this.plugin.settings.activityTracking.supportAllActivePages
            ? t("“支持所有活动页面”已开启，此选项不再单独生效。")
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
  }

  private renderIdeDiffSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("diff"));
    new Setting(containerEl)
      .setName(t("Diff 审核行为"))
      .setDesc(
        t("完全跟随 Claude Code 权限模式：默认权限会显示审核；acceptEdits 会直接接受编辑，插件不会额外弹窗。"),
      );
  }

  private renderIdeMaintenanceSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("维护"));
    new Setting(containerEl)
      .setName(t("重启桥接"))
      .setDesc(t("重建本地服务和 Claude Code IDE lock 文件。"))
      .addButton((button) =>
        button.setButtonText(t("重启")).onClick(async () => {
          await this.plugin.restartBridge();
          new Notice(t("mv-AIDE 桥接已重启。"));
          this.rerenderSettings("ide");
        }),
      );

    new Setting(containerEl)
      .setName(t("恢复插件管理的 Claude 设置"))
      .setDesc(t("只恢复本插件替换过的 ANTHROPIC_BASE_URL，不改其他配置。"))
      .addButton((button) =>
        button.setButtonText(t("恢复")).onClick(async () => {
          await this.plugin.restoreClaudeSettings();
          new Notice(t("已恢复 mv-AIDE 管理的 Claude 设置。"));
          this.rerenderSettings("ide");
        }),
      );
  }

  private renderIdeMcpToolSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(t("启用 MCP 主动工具"))
      .setDesc(
        t("主动工具通过标准 MCP 提供给 Claude Code 和 Codex CLI。改变后请重启对应客户端或重新执行 /mcp。"),
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
          name: t("获取最近标签与选区"),
          description: t("焦点离开 Obsidian 后仍可读取最近一次状态。"),
        },
        {
          key: "getOpenEditors",
          name: t("获取全部打开标签"),
          description: t("包括 Markdown、PDF、图片、网页、终端和其他插件页面。"),
        },
        {
          key: "openFile",
          name: t("在 Obsidian 中打开文件"),
          description: t("允许 Claude 主动定位仓库内文件和文本范围。"),
        },
        {
          key: "readCurrentWebPage",
          name: t("读取最近网页为 Markdown"),
          description:
            t("把最近浏览且仍打开的 Web Viewer 页面转换为 Markdown，不刷新或跳转页面。用于让 Claude 查看网页全貌，而不是只读取选区。"),
        },
        {
          key: "getDiagnostics",
          name: t("获取 lint 诊断"),
          description: t("按严重级别（错误/警告/全部）和文件路径过滤读取 lint 诊断。"),
        },
        {
          key: "getTerminalOutput",
          name: t("读取终端输出"),
          description: t("读取插件集成终端标签的末尾输出行，可按标签名过滤。"),
        },
        {
          key: "searchVaultSymbols",
          name: t("搜索库内符号"),
          description: t("按子串搜索全库 Markdown heading 等符号。"),
        },
        {
          key: "getBacklinks",
          name: t("获取反向链接"),
          description: t("列出链接到指定文件的库内文件。"),
        },
        {
          key: "getOutgoingLinks",
          name: t("获取出链"),
          description: t("列出指定文件链接出去的库内文件。"),
        },
        {
          key: "searchTags",
          name: t("搜索标签"),
          description: t("按子串搜索库内使用中的标签（返回 #tag）。"),
        },
        {
          key: "listNotesByTag",
          name: t("按标签列笔记"),
          description: t("列出携带指定标签的库内文件。"),
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
            .setName(t("网页工具最大返回字符数"))
            .setDesc(
              t("留空或填写 0 表示不限，插件会忠实返回当前已加载页面的完整可见内容；填写正整数时才截断。"),
            )
            .addText((text) => {
              text.inputEl.type = "number";
              text.inputEl.min = "0";
              text.inputEl.step = "1";
              text
                .setPlaceholder(t("不限"))
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
        .setName(t("MCP 注册状态"))
        .setDesc(this.plugin.mcpStatus)
        .addButton((button) =>
          button.setButtonText(t("重新注册")).onClick(async () => {
            await this.plugin.retryMcpRegistration();
            new Notice(this.plugin.mcpStatus);
            this.rerenderSettings("ide");
          }),
        )
        .addButton((button) =>
          button.setButtonText(t("清理注册")).onClick(async () => {
            await this.plugin.cleanMcpRegistration();
            new Notice(this.plugin.mcpStatus);
            this.rerenderSettings("ide");
          }),
        );
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
      .setName(t("终端主题"))
      .setDesc(t("控制本插件内置终端的 xterm 配色。浅色/深色使用固定高对比色板；自定义主题可复制后自行调整。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption(TERMINAL_THEME_OBSIDIAN, t("跟随 Obsidian"))
          .addOption(TERMINAL_THEME_LIGHT, t("浅色"))
          .addOption(TERMINAL_THEME_DARK, t("深色"))
          .addOption(TERMINAL_THEME_CUSTOM, t("自定义"))
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
                  t("自定义深色终端"),
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
        .setName(t("当前自定义主题"))
        .setDesc(t("选择要应用到已打开和新建终端的自定义主题。"))
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
      text: t("自定义终端主题"),
      cls: "mv-senceai-source-profile-summary setting-item-name",
    });
    details.createEl("p", {
      text: t("自定义主题只保存结构化颜色数据，不执行 CSS/JS。浅色和深色内置主题不可直接修改，可复制后调整。"),
      cls: "setting-item-description",
    });

    new Setting(details)
      .setName(t("创建自定义主题"))
      .setDesc(t("从内置浅色或深色色板复制一份，然后在下方编辑。"))
      .addButton((button) =>
        button
          .setButtonText(t("复制浅色"))
          .onClick(async () => {
            await this.addTerminalCustomTheme(TERMINAL_LIGHT_PALETTE, t("自定义浅色终端"));
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("复制深色"))
          .onClick(async () => {
            await this.addTerminalCustomTheme(TERMINAL_DARK_PALETTE, t("自定义深色终端"));
          }),
      );

    if (settings.terminalCustomThemes.length === 0) {
      details.createEl("p", {
        text: t("尚未创建自定义终端主题。"),
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
      .setName(t("主题名称"))
      .addText((text) =>
        text
          .setValue(theme.name)
          .onChange(async (value) => {
            theme.name = value.trim().slice(0, 80) || t("自定义终端主题");
            titleEl.setText(theme.name);
            await this.saveTerminalThemeSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("设为当前"))
          .onClick(async () => {
            this.plugin.settings.terminalThemeMode = TERMINAL_THEME_CUSTOM;
            this.plugin.settings.terminalCustomThemeId = theme.id;
            await this.saveTerminalThemeSettings(true);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("删除"))
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
      .setName(t("恢复默认配色"))
      .setDesc(t("会覆盖该自定义主题当前的所有颜色。"))
      .addButton((button) =>
        button
          .setButtonText(t("套用浅色默认"))
          .onClick(async () => {
            theme.palette = normalizeTerminalPalette(TERMINAL_LIGHT_PALETTE);
            await this.saveTerminalThemeSettings(true);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("套用深色默认"))
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
      .setName(t(TERMINAL_THEME_FIELD_LABELS[key]))
      .setDesc(t("支持 #rgb/#rrggbb/#rrggbbaa、rgb()/rgba()、hsl()/hsla()。"));
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
            statusEl.setText(t("颜色格式无效，未保存。"));
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

  private openWindowsDefaultAppConfirmation(
    status: DefaultOpenerOperationResult["status"],
  ): void {
    new WindowsDefaultAppConfirmationModal(
      this.app,
      status,
      () => this.plugin.openWindowsDefaultAppsSettings(),
      async () => {
        const checked = await this.plugin.checkDefaultFileOpener();
        this.rerenderSettings("external-file-opener");
        return checked;
      },
    ).open();
  }

  private async runDefaultOpenerOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T | null> {
    if (this.defaultOpenerOperationPending) return null;
    this.defaultOpenerOperationPending = true;
    this.rerenderSettings("external-file-opener");
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("默认打开器操作失败：{message}", { message }), 8000);
      return null;
    } finally {
      this.defaultOpenerOperationPending = false;
      this.rerenderSettings("external-file-opener");
    }
  }

  private handleWindowsCleanupResult(
    result: DefaultOpenerOperationResult,
  ): void {
    const owner = result.status.owner;
    if (
      result.failureKind === "other-vault-confirmation-required" &&
      owner
    ) {
      new WindowsOtherVaultCleanupModal(
        this.app,
        owner,
        () => this.runDefaultOpenerOperation(() =>
          this.plugin.cleanupDefaultFileOpener({
            marker: owner.marker,
            vaultRoot: owner.vaultRoot,
            installedAt: owner.installedAt,
          })),
        (confirmedResult) => this.handleWindowsCleanupResult(confirmedResult),
      ).open();
      return;
    }
    if (result.ok && result.offerWindowsDefaultAppsSettings) {
      new WindowsCleanupCompleteModal(
        this.app,
        result.message,
        () => this.plugin.openWindowsGenericDefaultAppsSettings(),
      ).open();
    }
  }

  private renderFilesystemBrowserSettings(containerEl: HTMLElement): void {
    addHeading(containerEl, t("内置浏览器"));

    new Setting(containerEl)
      .setName(t("浏览历史"))
      .setDesc(t("在内置浏览器视图工具栏显示「浏览历史」按钮。"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.browserHistoryButton)
          .onChange(async (value) => {
            await this.plugin.setBrowserHistoryButtonEnabled(value);
          }),
      );

    new Setting(containerEl)
      .setName(t("下载"))
      .setDesc(t("在内置浏览器视图工具栏显示「下载」按钮。"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.browserDownloadsButton)
          .onChange(async (value) => {
            await this.plugin.setBrowserDownloadsButtonEnabled(value);
          }),
      );

    addHeading(containerEl, t("文件资源管理器"));

    new Setting(containerEl)
      .setName(t("目录浏览按钮"))
      .setDesc(
        t(
          "在文件列表工具行显示文件夹按钮，点击后在弹窗中浏览电脑上的任意目录（可编辑路径、快捷位置、全量显示切换）。",
        ),
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.fileExplorerPathBar)
          .onChange(async (value) => {
            await this.plugin.setFileExplorerPathBarEnabled(value);
          }),
      );
  }

  private renderExternalFileOpenerSettings(containerEl: HTMLElement): void {
    const settings = this.plugin.settings.externalFileOpener;
    const supportedExtensions = externalFileAllowedExtensions(this.plugin.settings)
      .map((extension) => `.${extension}`)
      .join("、");

    new Setting(containerEl)
      .setName(t("启用默认文件打开器"))
      .setDesc(
        t("开启后，本插件会启动本地服务，供系统默认打开器 wrapper 打开电脑上的外部文件。"),
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.enabled).onChange(async (value) => {
          settings.enabled = value;
          await this.plugin.saveAndApplySettings();
          this.rerenderSettings("external-file-opener");
        }),
      );

    new Setting(containerEl)
      .setName(t("Obsidian 内显示文件类型图标"))
      .setDesc(t("在标签页按后缀显示文件格式徽标（如 MD、PY、TEX），便于一眼区分文件格式。"))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.fileTypeIcons !== false)
          .setDisabled(!settings.enabled)
          .onChange(async (value) => {
            settings.fileTypeIcons = value;
            await this.plugin.saveAndApplySettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("系统默认打开方式"))
      .setDesc(this.plugin.defaultFileOpenerStatus)
      .addButton((button) =>
        button
          .setButtonText(t("检查"))
          .setDisabled(this.defaultOpenerOperationPending)
          .onClick(async () => {
            const status = await this.runDefaultOpenerOperation(
              () => this.plugin.checkDefaultFileOpener(),
            );
            if (!status) return;
            new Notice(status.message, status.checkFailed ? 8000 : 5000);
            if (status.requiresWindowsConfirmation) {
              this.openWindowsDefaultAppConfirmation(status);
            }
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("一键注入"))
          .setCta()
          .setDisabled(!settings.enabled || this.defaultOpenerOperationPending)
          .onClick(async () => {
            const result = await this.runDefaultOpenerOperation(
              () => this.plugin.installDefaultFileOpener(),
            );
            if (!result) return;
            if (
              result.failureKind === "symlink-permission" ||
              result.failureKind === "symlink-unsupported"
            ) {
              const retryInjection = async (
                allowManagedCopyFallback = false,
              ): Promise<DefaultOpenerOperationResult> => {
                const retry = await this.plugin.installDefaultFileOpener({
                  allowManagedCopyFallback,
                });
                this.rerenderSettings("external-file-opener");
                if (retry.status.requiresWindowsConfirmation) {
                  window.setTimeout(
                    () => this.openWindowsDefaultAppConfirmation(retry.status),
                    0,
                  );
                }
                return retry;
              };
              new SymlinkFallbackModal(
                this.app,
                result.message,
                process.platform,
                result.managedCopyFallbackAvailable === true,
                process.platform === "win32"
                  ? () => this.plugin.openWindowsDeveloperSettings()
                  : null,
                process.platform === "win32"
                  ? async () => {
                      await this.plugin.repairWindowsDeveloperMode();
                      return await retryInjection(false);
                    }
                  : null,
                () => retryInjection(false),
                () => retryInjection(true),
              ).open();
            } else if (result.status.requiresWindowsConfirmation) {
              this.openWindowsDefaultAppConfirmation(result.status);
            }
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("清理"))
          .setDisabled(this.defaultOpenerOperationPending)
          .onClick(async () => {
            const result = await this.runDefaultOpenerOperation(
              () => this.plugin.cleanupDefaultFileOpener(),
            );
            if (result) this.handleWindowsCleanupResult(result);
          }),
      );

    const mirrorSetting = new Setting(containerEl)
      .setName(t("镜像目录"))
      .setDesc(
        t("Vim 配置和外部文件目录统一保存在当前 vault 的 mv-aide 目录；始终优先使用真实 symlink。"),
      )
      .addText((text) =>
        text
          .setValue(settings.mirrorFolder)
          .setPlaceholder(EXTERNAL_FILE_MIRROR_FOLDER)
          .setDisabled(true),
      )
      .addButton((button) =>
        button
          .setButtonText(t("迁移到仓库目录"))
          .setDisabled(!this.plugin.externalFileStorageNeedsMigration())
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const summary = await this.plugin.migrateExternalFileStorage();
              new Notice(
                t("外部文件目录已迁移，共更新 {count} 个映射。", {
                  count: summary.migratedMappings,
                }),
                5000,
              );
              this.rerenderSettings("external-file-opener");
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : String(error),
                8000,
              );
              button.setDisabled(false);
            }
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("重试并迁移符号链接"))
          .setTooltip(t("仅手动触发：先同步本机受管副本，再把安全收敛的副本迁移回真实符号链接"))
          .setDisabled(!settings.enabled)
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.retryManagedCopiesAsSymlinks();
            } finally {
              button.setDisabled(!settings.enabled);
            }
          }),
      );
    mirrorSetting.settingEl.addClass("mv-senceai-external-mirror-setting");

    // 「支持的后缀范围」折叠区：逐后缀开关，固定在默认文件打开器最下面。
    const builtinExtensions = MARKDOWN_EXTERNAL_EXTENSIONS as readonly string[];
    const extensionUniverse = externalFileExtensionUniverse(this.plugin.settings);
    const sourceAssistExtensions = extensionUniverse.filter(
      (extension) => !builtinExtensions.includes(extension),
    );
    const disabledExtensions = new Set(settings.disabledExtensions);
    const extensionsEl = this.createIdeSubsection(
      containerEl,
      "external-file-opener-extensions",
      t("支持的后缀范围"),
    );
    extensionsEl.createEl("p", {
      cls: "setting-item-description",
      text:
        t("当前支持：{extensions}", { extensions: supportedExtensions }) +
        " " +
        t("分别设置每个后缀是否由默认打开器处理。"),
    });
    for (const extension of extensionUniverse) {
      const isBuiltin = builtinExtensions.includes(extension);
      const extensionEnabled = isBuiltin
        ? !disabledExtensions.has(extension)
        : settings.extensionMode === "markdown-and-source-assist" &&
          !disabledExtensions.has(extension);
      new Setting(extensionsEl).setName(`.${extension}`).addToggle((toggle) =>
        toggle
          .setValue(extensionEnabled)
          .setDisabled(!settings.enabled)
          .onChange(async (value) => {
            const nextDisabled = new Set(settings.disabledExtensions);
            if (value) {
              nextDisabled.delete(extension);
              if (!isBuiltin && settings.extensionMode === "markdown-only") {
                // 模式只决定基础集合：开任意扩展后缀时切入扩展模式，
                // 其余扩展后缀保持单独关闭（等价旧的「仅内置后缀」语义）。
                settings.extensionMode = "markdown-and-source-assist";
                for (const other of sourceAssistExtensions) {
                  if (other !== extension) nextDisabled.add(other);
                }
              }
            } else {
              nextDisabled.add(extension);
            }
            settings.disabledExtensions = Array.from(nextDisabled);
            await this.plugin.saveAndApplySettings();
            this.rerenderSettings("external-file-opener");
          }),
      );
    }
  }

  private renderSourceAssistSettings(containerEl: HTMLElement): void {
    const settings = this.plugin.settings.sourceAssist;

    new Setting(containerEl)
      .setName(t("启用源码编写辅助"))
      .setDesc(t("开启后启用按后缀隔离的 Code Suite。"))
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
        .setButtonText(t("添加新源码类型"))
        .setCta()
        .onClick(() => {
          new SourceAssistExtensionModal(this.app, async (extension) => {
            if (this.plugin.settings.sourceAssist.profiles.some((p) => p.extension === extension)) {
              new Notice(t(".{extension} 已存在。", { extension }));
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

  private renderVimSettings(containerEl: HTMLElement): void {
    const settings = this.plugin.settings.vim;
    const status = this.plugin.vimStatus();

    new Setting(containerEl)
      .setName(t("Vim 运行状态"))
      .setDesc(
        `${status.message}${
          status.loadedFiles.length > 0
            ? ` ${t("已加载配置：{files}", { files: status.loadedFiles.join(", ") })}`
            : ""
        }`,
      );

    new Setting(containerEl)
      .setName(t("模式状态显示"))
      .setDesc(t("在 Obsidian 状态栏中使用文字或单一色块表示当前 Vim 模式；两种方式不会同时显示。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("text", t("文字"))
          .addOption("color", t("颜色"))
          .setValue(settings.statusDisplay)
          .onChange(async (value) => {
            settings.statusDisplay = value === "color" ? "color" : "text";
            await this.plugin.saveVimSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("光标颜色"))
      .setDesc(t("非插入模式块光标的配色：内置主题或自定义 RGB 三原色；默认跟随文本色。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("default", t("默认（跟随文本色）"));
        for (const theme of VIM_CURSOR_COLOR_THEMES) {
          dropdown.addOption(theme.id, t(theme.label));
        }
        dropdown
          .addOption("custom", t("自定义 RGB"))
          .setValue(settings.cursorColorTheme)
          .onChange(async (value) => {
            settings.cursorColorTheme = value;
            await this.plugin.saveVimSettings();
            this.rerenderSettings("vim");
          });
      });

    if (settings.cursorColorTheme === "custom") {
      const rgbSetting = new Setting(containerEl)
        .setName(t("自定义三原色"))
        .setDesc(t("R / G / B 三通道各取 0–255 的整数，改动即时生效。"));
      for (const channel of ["r", "g", "b"] as const) {
        rgbSetting.addText((text) =>
          text
            .setPlaceholder(channel.toUpperCase())
            .setValue(String(settings.cursorColorCustom[channel]))
            .onChange(async (value) => {
              const parsed = Math.round(Number(value));
              if (!Number.isFinite(parsed)) return;
              settings.cursorColorCustom[channel] = Math.min(
                255,
                Math.max(0, parsed),
              );
              await this.plugin.saveVimSettings();
            }),
        );
      }
    }

    const vimrcSetting = new Setting(containerEl)
      .setName(t("全局 .vimrc"))
      .setDesc(this.plugin.vimGlobalConfigPath())
      .addButton((button) =>
        button
          .setButtonText(t("创建"))
          .setDisabled(status.state !== "enabled")
          .onClick(async () => {
            try {
              await this.plugin.ensureVimConfigFile();
              new Notice(t("全局 .vimrc 已就绪。"), 3000);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error), 6000);
            }
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("打开"))
          .setDisabled(status.state !== "enabled")
          .onClick(async () => {
            try {
              await this.plugin.openVimConfigFile();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error), 6000);
            }
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("重新加载"))
          .setDisabled(status.state !== "enabled")
          .onClick(async () => {
            await this.plugin.reloadVimConfiguration();
            this.rerenderSettings("vim");
          }),
      )
      .addButton((button) => {
        button
          .setButtonText(t("迁移旧配置"))
          .setDisabled(true)
          .onClick(async () => {
            try {
              const migrated = await this.plugin.migrateLegacyVimConfigFile();
              new Notice(
                migrated
                  ? t("旧 .vimrc 已迁移。")
                  : t("没有可迁移的旧 .vimrc。"),
                3000,
              );
              this.rerenderSettings("vim");
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error), 6000);
            }
          });
        if (status.state === "enabled") {
          void this.plugin.hasLegacyVimConfigFile().then((available) => {
            button.setDisabled(!available);
          });
        }
      },
      );
    vimrcSetting.settingEl.addClass("mv-aide-vimrc-setting");

    new Setting(containerEl)
      .setName(t("允许 Vim 执行外部命令"))
      .setDesc(t("允许 :! 和 autocmd 间接调用系统命令。默认关闭；只应对自己维护的 vimrc 开启。"))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.allowExternalCommands)
          .onChange(async (value) => {
            settings.allowExternalCommands = value;
            await this.plugin.saveVimSettings();
          }),
      );

    new Setting(containerEl).setName(t("按后缀配置"))
      .setDesc(t("虚拟 vimrc 在全局 .vimrc 之后执行；只删除完全相同的重复指令，其余指令按顺序生效。"))
      .setHeading();

    for (const profile of this.plugin.settings.sourceAssist.profiles) {
      const source = vimSourceSettings(settings, profile.extension);
      const details = containerEl.createEl("details", {
        cls: "mv-senceai-source-assist-profile mv-aide-vim-source-profile",
      });
      details.open = this.openVimSourceProfileExtensions.has(profile.extension);
      details.addEventListener("toggle", () => {
        if (details.open) {
          this.openVimSourceProfileExtensions.add(profile.extension);
        } else {
          this.openVimSourceProfileExtensions.delete(profile.extension);
        }
      });
      details.createEl("summary", {
        cls: "mv-senceai-source-assist-profile-summary setting-item-name",
        text: profile.extension === "md"
          ? t("Markdown (.md)")
          : t("源码类型 .{ext}", { ext: profile.extension }),
      });
      const body = details.createDiv({ cls: "mv-senceai-source-assist-profile-body" });
      new Setting(body)
        .setName(t("该源码使用 Vim"))
        .setDesc(t("只在这个后缀的编辑器中加载 Vim；所有后缀都关闭时，Vim 模块不会加载或注册任何运行资源。"))
        .addToggle((toggle) =>
          toggle
            .setValue(source.enabled)
            .onChange(async (value) => {
              settings.sources[profile.extension] = {
                ...vimSourceSettings(settings, profile.extension),
                enabled: value,
              };
              this.openVimSourceProfileExtensions.add(profile.extension);
              await this.plugin.saveVimSettings();
              this.rerenderSettings("vim");
            }),
        );
      new Setting(body)
        .setName(t("与 Code Suite 共存时允许 Insert 映射"))
        .setDesc(
          profile.latexSuiteEnabled
            ? t("开启后，Code Suite 未消费的 Insert 输入才继续交给 imap/abbrev；关闭可避免替换规则冲突。")
            : t("该后缀的 Code Suite 已关闭，Insert 映射会自动生效，无需额外授权。"),
        )
        .addToggle((toggle) =>
          toggle
            .setValue(source.allowInsertMappingsWithLatexSuite)
            .setDisabled(!source.enabled || !profile.latexSuiteEnabled)
            .onChange(async (value) => {
              settings.sources[profile.extension] = {
                ...source,
                allowInsertMappingsWithLatexSuite: value,
              };
              await this.plugin.saveVimSettings();
            }),
        );

      const virtualSetting = new Setting(body)
        .setName(t("虚拟 vimrc"))
        .setDesc(t("只对该后缀生效，在全局 .vimrc 之后执行。"));
      virtualSetting.settingEl.addClass("mv-aide-vimrc-virtual-setting");
      virtualSetting.controlEl.empty();
      const textarea = virtualSetting.settingEl.createEl("textarea", {
        cls: "mv-aide-vimrc-textarea",
        attr: {
          rows: "8",
          spellcheck: "false",
          placeholder: '" Example: nnoremap H ^',
        },
      });
      textarea.value = source.virtualVimrc;
      textarea.addEventListener("change", async () => {
        settings.sources[profile.extension] = {
          ...vimSourceSettings(settings, profile.extension),
          virtualVimrc: textarea.value,
        };
        await this.plugin.saveVimSettings();
      });
    }
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
    const title =
      profile.extension === "md"
        ? t("Markdown (.md)")
        : t("源码类型 .{ext}", { ext: profile.extension });
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
          ? t("固定 profile：用于普通 Markdown 文件。")
          : t("该后缀会自动注册为 Markdown view，并出现在新建非 MD 源码文件命令中。若该后缀已由其它插件处理，本插件会尝试改注册为 Markdown view，可能影响其它插件的打开方式。"),
    });

    if (profile.extension !== "md") {
      const deleteButton = summary.createEl("button", {
        cls: "clickable-icon mv-senceai-source-assist-profile-delete",
        attr: {
          "aria-label": t("删除该源码类型并取消本插件对该后缀的识别"),
          type: "button",
        },
      });
      setIcon(deleteButton, "trash");
      deleteButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.plugin.settings.sourceAssist.profiles.splice(idx, 1);
        this.openSourceAssistProfileIds.delete(profile.id);
        this.openVimSourceProfileExtensions.delete(profile.extension);
        await this.plugin.saveSourceAssistSettings();
        this.rerenderSettings("source-assist");
      });
    }

    const wrap = details.createDiv({ cls: "mv-senceai-source-assist-profile-body" });

    if (profile.extension !== "md") {
      this.renderSourceAssistProfileHighlightThemeSetting(wrap, profile, idx);
    }

    if (profile.extension === "tex") {
      new Setting(wrap)
        .setName(t("在核心大纲中显示章节"))
        .setDesc(
          t("将 \\section、\\subsection 等章节命令显示为 Obsidian 核心大纲中的标题层级，允许在编辑器中按章节折叠，并按标题层级渲染章节标题（光标不在该行时隐藏命令外壳、按层级区分字号）。需要核心“大纲”插件开启，行为与 Markdown 标题一致。"),
        )
        .addToggle((toggle) =>
          toggle
            .setValue(profile.texOutlineEnabled)
            .onChange(async (value) => {
              const target = this.plugin.settings.sourceAssist.profiles[idx];
              if (!target) return;
              target.texOutlineEnabled = value;
              await this.plugin.saveSourceAssistSettings();
            }),
        );
    }

    new Setting(wrap).setName(t("Lint 诊断")).setHeading();
    renderLintSetting(wrap, this.plugin, profile.extension);
    new Setting(wrap).setName(t("mv-run 指令")).setHeading();
    renderMvRunSetting(wrap, this.plugin, profile.extension);
    new Setting(wrap).setName(t("正则替换")).setHeading();
    renderRegexScopeSetting(wrap, this.plugin, profile.extension);

    new Setting(wrap).setName(t("Code Suite")).setHeading();
    this.renderSourceAssistProfileLatexSuiteSetting(wrap, profile, idx);

    if (profile.extension === "tex") {
      new Setting(wrap)
        .setName(t("打开 TeX 增强渲染"))
        .setDesc(
          t("实验功能：使用本插件自定义 Live Preview 扩展渲染 \\(...\\)、\\[...\\] 和常见数学环境，可能影响光标移动、折叠行为或其它编辑器插件兼容性。该功能要求本 profile 的 Code Suite 开关处于开启状态，否则不会加载。关闭后 .tex 仍作为 Markdown view 打开，Code Suite 仍可用。"),
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
      this.renderTexMathCustomFormatsSetting(wrap, profile, idx);
    }

    this.renderSourceAssistSnippetsEditor(wrap, profile, idx);
    this.renderSourceAssistHotkeyIntro(wrap);

    this.renderSourceAssistHotkeySetting(
      wrap,
      profile,
      idx,
      "snippetsTrigger",
      t("手动触发按键"),
      t("用于触发非 automatic 代码展开；Code Suite 默认使用 Tab。"),
    );
    this.renderSourceAssistHotkeySetting(
      wrap,
      profile,
      idx,
      "snippetNextTabstopTrigger",
      t("下一 tabstop"),
      t("snippet 展开后跳到下一个 $1/$2/$0 等占位点。"),
    );
    this.renderSourceAssistHotkeySetting(
      wrap,
      profile,
      idx,
      "snippetPreviousTabstopTrigger",
      t("上一 tabstop"),
      t("snippet 展开后跳回上一个占位点。"),
    );
  }

  private renderSourceAssistProfileLatexSuiteSetting(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
  ): void {
    const name =
      profile.extension === "md"
        ? t("启用 Markdown 的 Code Suite")
        : t("启用该后缀的 Code Suite");
    const desc =
      profile.extension === "md"
        ? t("关闭后只停用 Markdown profile 的 Code Suite 代码展开、tabstop 和相关预览。")
        : t("关闭后只停用该 profile 的 Code Suite 代码展开、tabstop 和相关预览；不取消后缀注册、不移除新建命令、不影响源码高亮或 Markdown 视觉屏蔽。");
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle
          .setValue(profile.latexSuiteEnabled)
          .onChange(async (value) => {
            const target = this.plugin.settings.sourceAssist.profiles[idx];
            if (!target) return;
            target.latexSuiteEnabled = value;
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
      .setName(t("源码高亮主题"))
      .setDesc(t("只影响该后缀文件的源码 token 配色，不影响 Code Suite 代码展开、Markdown view 注册或 TeX 增强渲染。"))
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
    addHeading(containerEl, t("自定义代码高亮主题"));
    new Setting(containerEl)
      .setName(t("载入自定义代码高亮主题"))
      .setDesc(
        t("从本地 .css/.json 文件导入，保存为插件自己的主题数据；非 Prism 主题会转换为近似效果，不能完全还原。"),
      )
      .addButton((button) =>
        button
          .setButtonText(t("选择主题文件"))
          .setCta()
          .onClick(() => {
            new SourceHighlightThemeImportModal(this.app, async (theme) => {
              this.plugin.settings.sourceAssist.customHighlightThemes.push(theme);
              await this.plugin.saveSourceAssistSettings();
              new Notice(t("已载入主题：{name}", { name: theme.name }));
              // 转换警告即设置页 desc 已常驻说明的"近似转换"提示，不再打 console。
              this.rerenderSettings("source-assist");
            }).open();
          }),
      );

    const themes = this.plugin.settings.sourceAssist.customHighlightThemes;
    if (themes.length === 0) {
      containerEl.createDiv({
        cls: "setting-item-description mv-senceai-source-highlight-empty",
        text: t("暂无自定义主题。内置主题可直接在上方源码类型中选择。"),
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: "mv-senceai-source-highlight-theme-list" });
    for (const theme of themes) {
      new Setting(listEl)
        .setName(theme.name)
        .setDesc(t("格式：{format}；已保存为解析后的 token palette。", { format: theme.format }))
        .addButton((button) =>
          button
            .setButtonText(t("删除"))
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
      text: t("按键说明：手动触发按键用于触发非 automatic 代码展开；下一/上一 tabstop 用于在 $1/$2/$0 等占位点之间跳转。"),
    });
  }

  private renderSourceAssistSnippetsEditor(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
  ): void {
    const setting = new Setting(containerEl)
      .setDesc(
        t("填写格式与 Code Suite 的代码展开规则一致；可以直接粘贴兼容的规则数组。行首 // 会按 JS 注释处理。"),
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

  private renderTexMathCustomFormatsSetting(
    containerEl: HTMLElement,
    profile: SourceAssistProfile,
    idx: number,
  ): void {
    const setting = new Setting(containerEl)
      .setName(t("自定义数学环境（行内 / 行间）"))
      .setDesc(
        t("格式与代码展开面板一致，每项为 { 开头, 结尾, 设置 }；设置填 n=行内、j=行间、nl=行内环境、jl=行间环境。"),
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
      initialValue: profile.texMathFormats,
      validate: async (value) => {
        parseTexMathFormats(value);
      },
      onValidChange: async (value) => {
        const target = this.plugin.settings.sourceAssist.profiles[idx];
        if (!target || target.texMathFormats === value) return;
        target.texMathFormats = value;
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
      dropdown.addOption("__custom__", t("手动录入"));
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
      button.setButtonText(t("录制")).onClick(() => {
        cleanupRecording?.();
        valueEl.addClass("is-recording");
        valueEl.setText(t("请按下快捷键..."));
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

    addHeading(containerEl, t("总开关"));
    new Setting(containerEl)
      .setName(t("启用行内补全"))
      .setDesc(
        t("开启后左侧功能区会出现「行内补全」按钮；按钮点亮时自动补全，未点亮时只响应手动请求按键。"),
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

    addHeading(containerEl, t("模型与上下文"));
    new Setting(containerEl)
      .setName(t("补全模型"))
      .setDesc(t("选择行内补全使用的提供商和模型；这里复用上方 API 提供商配置。"))
      .addDropdown((dropdown) => {
        dropdown.addOption("", t("（未选择提供商）"));
        for (const provider of this.plugin.settings.llm.providers) {
          dropdown.addOption(provider.id, provider.name || t("（未命名提供商）"));
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
          dropdown.addOption("", t("（先选择提供商）"));
          dropdown.setDisabled(true);
        } else if (provider.models.length === 0) {
          dropdown.addOption("", t("（该提供商暂无模型）"));
          dropdown.setDisabled(true);
        } else {
          dropdown.addOption("", t("（未选择模型）"));
          for (const model of provider.models) {
            dropdown.addOption(model.id, model.name || t("（未命名模型）"));
          }
          dropdown.setValue(cfg.modelId ?? "");
          dropdown.onChange(async (value) => {
            cfg.modelId = value || null;
            await this.saveInlineCompletionSettings();
          });
        }
      });

    new Setting(containerEl)
      .setName(t("思考"))
      .setDesc(
        t("决定是否在行内补全请求中携带思考参数。默认 = 不发送任何思考参数；自定义 = 你填的 JSON。"),
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("default", t("默认"))
          .addOption("on", t("开"))
          .addOption("off", t("关"))
          .addOption("custom", t("自定义"))
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
          .setPlaceholder(t('自定义 JSON，如 {"thinking":{"type":"enabled"}}'))
          .setValue(cfg.thinkingCustom ?? "")
          .onChange(async (value) => {
            cfg.thinkingCustom = value;
            await this.saveInlineCompletionSettings();
          });
      });

    // ---- 补全提示词 ----
    addHeading(containerEl, t("补全提示词"));

    new Setting(containerEl)
      .setName(t("补全提示词主体"))
      .setDesc(t("发送给模型的系统消息主体部分（角色描述 + 补全规则）。留空或清空则使用内置默认值。"))
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder(t("（使用默认提示词主体）"))
          .setValue(cfg.systemPromptBody)
          .onChange(async (value) => {
            cfg.systemPromptBody = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText(t("恢复默认")).onClick(async () => {
          cfg.systemPromptBody = DEFAULT_INLINE_SYSTEM_PROMPT_BODY;
          await this.saveInlineCompletionSettings();
          this.rerenderSettings("inline-completion");
        }),
      );

    {
      const sentinelMatch = DEFAULT_INLINE_NO_COMPLETION_PROMPT.match(/<[^>]+NO_COMPLETION>/);
      const sentinelToken = sentinelMatch ? sentinelMatch[0] : "<MV_SENCEAI_NO_COMPLETION>";
      const hintEl = containerEl.createEl("div", {
        text: t(
          "下方「{token}」是无需补全时的返回标记。如果修改或删除该标记，模型将无法正确抑制无效补全。",
          { token: sentinelToken },
        ),
      });
      hintEl.addClass("mv-senceai-llm-hint");
    }

    new Setting(containerEl)
      .setName(t("无需补全指令"))
      .setDesc(t("控制模型在无需补全时返回的 sentinel 标记指令。修改时请特别注意。"))
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder(t("（使用默认无需补全指令）"))
          .setValue(cfg.noCompletionPrompt)
          .onChange(async (value) => {
            const defaultSentinel =
              DEFAULT_INLINE_NO_COMPLETION_PROMPT.match(/<[^>]+NO_COMPLETION>/)?.[0] ?? "";
            const userHasSentinel = defaultSentinel && value.includes(defaultSentinel);
            if (value.trim() && defaultSentinel && !userHasSentinel) {
              new Notice(
                t("⚠️ 无需补全标记已变更，如果模型不返回该标记，可能导致无法正确抑制无效补全。"),
                6000,
              );
            }
            cfg.noCompletionPrompt = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText(t("恢复默认")).onClick(async () => {
          cfg.noCompletionPrompt = DEFAULT_INLINE_NO_COMPLETION_PROMPT;
          await this.saveInlineCompletionSettings();
          this.rerenderSettings("inline-completion");
        }),
      );

    new Setting(containerEl)
      .setName(t("拒绝后重生成指令"))
      .setDesc(
        t("按拒绝键后发送给模型的用户消息。支持 {rejected} 占位符代表被拒绝的补全文本；留空则使用内置默认值。"),
      )
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder(t("（使用默认拒绝后重生成指令）"))
          .setValue(cfg.rejectPrompt)
          .onChange(async (value) => {
            cfg.rejectPrompt = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText(t("恢复默认")).onClick(async () => {
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
      t("光标前上下文长度"),
      t("发送给模型的光标前最多多少个 Markdown 源文本字符。留空则使用默认值。"),
    );
    renderContextLimit(
      "contextAfterChars",
      t("光标后上下文长度"),
      t("发送给模型的光标后最多多少个 Markdown 源文本字符。留空则使用默认值。"),
    );

    new Setting(containerEl)
      .setName(t("触发延迟"))
      .setDesc(t("停止输入后等待多少毫秒再请求补全。留空则使用默认值。"))
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
      .setName(t("最大补全字符数"))
      .setDesc(t("限制 ghost text 的最大字符数。留空则使用默认值。"))
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
      .setName(t("最大补全行数"))
      .setDesc(t("限制 ghost text 的最大行数。留空则使用默认值。"))
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

    addHeading(containerEl, t("快捷键"));
    this.renderInlineHotkeyRecorder(
      containerEl,
      "accept",
      t("接受按键"),
      t("插入当前 ghost text。点击录制后按下想绑定的快捷键。"),
      DEFAULT_SETTINGS.inlineCompletion.keymap.accept,
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "reject",
      t("拒绝按键"),
      t("可清空不绑定。绑定后会把被拒绝的补全发回模型并请求另一版。"),
      "",
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "cancel",
      t("取消按键"),
      t("只清空当前 ghost text，不请求模型。点击录制后按下想绑定的快捷键。"),
      DEFAULT_SETTINGS.inlineCompletion.keymap.cancel,
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "request",
      t("手动请求按键"),
      t("左侧按钮未点亮时也可用它请求一次补全。可清空不绑定。"),
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
      button.setButtonText(t("录制")).onClick(() => {
        cleanupRecording?.();
        valueEl.addClass("is-recording");
        valueEl.setText(t("请按下快捷键..."));
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
        button.setButtonText(t("恢复默认")).onClick(() => {
          void save(fallback);
        }),
      );
    } else {
      setting.addButton((button) =>
        button.setButtonText(t("清空")).onClick(() => {
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
        .setButtonText(t("新增提供商"))
        .onClick(async () => {
          const next: LlmProviderConfig = {
            id: `provider-${Date.now()}`,
            name: t("新提供商"),
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
      attr: { placeholder: t("提供商名称（如：白山）"), value: provider.name },
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
        text: opt === "anthropic" ? "Anthropic" : t("OpenAI 兼容"),
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
        .setTooltip(t("删除该提供商"))
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
          ? t("如 https://api.anthropic.com，插件自动追加 /v1/messages。")
          : t("如 https://api.openai.com/v1，插件自动追加 /chat/completions。"),
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
      .setDesc(t("明文保存在插件 data.json。本地无鉴权服务（如 Ollama）可留空。"))
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
      .setName(t("绕过 CORS(代理模式)"))
      .setDesc(
        t("默认关闭(流式逐字输出)。开启后改用 Obsidian 内部网络通道,可绕过部分端点对 app:// Origin 的 CORS 拒绝(表现为『Failed to fetch』),但会失去流式、改为一次性返回。iphy 等报 CORS 错的端点请开启。"),
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
      text: t("模型"),
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
          placeholder: t("模型名（如 GLM-5.1，即发往 API 的值）"),
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

      const delBtn = row.createEl("button", { text: t("删除"), cls: "mv-senceai-llm-model-del" });
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
      text: t("+ 添加模型"),
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
      attr: { placeholder: t("菜单显示名（如：翻译）"), value: tpl.label },
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
    promptArea.setAttr("placeholder", t("提示词，可用 {selection} 占位符"));
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
      modelBtn.textContent = mdl && p
        ? t("模型：{pname} / {mname}", { pname: p.name, mname: mdl.name })
        : t("选择模型");
    };
    refreshModelLabel();
    modelBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle(t("（清除选择）")).onClick(async () => {
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
            item.setTitle(`  ${m.name || t("（未命名模型）")}`).onClick(async () => {
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
      text: t("思考"),
      cls: "mv-senceai-llm-tpl-thinking-label",
    });
    void thinkingLabel;
    const thinkingSelect = thinkingRow.createEl("select");
    for (const opt of [
      { value: "default", text: t("默认") },
      { value: "on", text: t("开") },
      { value: "off", text: t("关") },
      { value: "custom", text: t("自定义") },
    ]) {
      const o = thinkingSelect.createEl("option", { value: opt.value, text: opt.text });
      if ((tpl.thinkingMode ?? "default") === opt.value) o.selected = true;
    }
    const customBox = thinkingRow.createEl("input", { type: "text" });
    customBox.addClass("mv-senceai-llm-tpl-thinking-custom");
    customBox.placeholder = t('自定义 JSON，如 {"thinking":{"type":"enabled"}}');
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
      text: t(
        "💡 思考下拉决定是否在请求中携带思考参数：开 = {\"thinking\":{\"type\":\"enabled\"}}、关 = {\"thinking\":{\"type\":\"disabled\"}}、自定义 = 你填的 JSON。默认 = 不发送任何思考参数（安全）。是否被模型实际采纳取决于模型与端点，不支持的模型可能报错或忽略。",
      ),
      cls: "mv-senceai-llm-tpl-hint-thinking",
    });
    void thinkingHint;

    const enableRow = setting.controlEl.createDiv({
      cls: "mv-senceai-llm-tpl-enable-row",
    });
    const enableToggle = enableRow.createEl("input", { type: "checkbox" });
    enableToggle.checked = tpl.enabled;
    enableToggle.id = `mv-senceai-llm-tpl-enabled-${idx}`;
    const enableLabel = enableRow.createEl("label", { text: t("启用") });
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
        target.enabled
          ? t("已启用：{label}", { label: target.label })
          : t("已关闭：{label}", { label: target.label }),
        3000,
      );
    });

    setting.addExtraButton((btn) =>
      btn
        .setIcon("trash")
        .setTooltip(t("删除该模板"))
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
