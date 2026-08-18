import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  editorInfoField,
  FuzzySuggestModal,
  Keymap,
  loadPrism,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  TFolder,
  type App,
  type PaneType,
  type WorkspaceLeaf,
} from "obsidian";
import { breadcrumbAtLine } from "./src/heading-breadcrumb";
import { StateEffect, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { isSelectedPageType } from "./src/activity-tracking";
import { detectSystemNodeCommand } from "./src/universal-mcp-stdio-command";
import {
  UniversalMcpServer,
  type UniversalMcpRuntimeDescriptor,
} from "./src/universal-mcp";
import stdioLauncherSource from "inline:dist/universal-mcp-stdio.cjs";
import { BridgeServer } from "./src/bridge-server";
import {
  applyManagedTerminalHooks,
  restoreManagedTerminalHooks,
} from "./src/claude-hooks";
import {
  applyManagedBaseUrl,
  localClaudeSettingsPath,
  restoreManagedBaseUrl,
} from "./src/claude-settings";
import {
  DEFAULT_SETTINGS,
  DIFF_VIEW_TYPE,
  TERMINAL_VIEW_TYPE,
  UNIVERSAL_MCP_PORT_BASE,
  UNIVERSAL_MCP_PORT_SPAN,
  WINDOWS_MCP_REGISTRATION_VERSION,
} from "./src/constants";
import {
  latestSelectionForContext,
  rememberLatestSelection,
} from "./src/context-cache";
import { ObsidianDiffView } from "./src/diff-view";
import { setLanguage, t, type Language } from "./src/i18n";
import { TerminalView } from "./src/terminal/terminal-view";
import { normalizeTerminalThemeSettings } from "./src/terminal/terminal-themes";
import {
  cleanStaleObsidianLocks,
  claudeCompatibilityLockDirectory,
  discoveryLockDirectory,
  removeLockFile,
  writeLockFile,
} from "./src/lock-file";
import { migrateLlm } from "./src/llm-migrate";
import { migrateInlineCompletion } from "./src/inline-completion/inline-completion-migrate";
import { LintFeature } from "./src/lint/lint-feature";
import { normalizeLintSettings } from "./src/lint/lint-types";
import { normalizeRegexReplaceSettings } from "./src/regex-replace/regex-replace-types";
import { RegexReplaceFeature } from "./src/regex-replace/regex-replace-feature";
import { BrowserHistoryButtonFeature } from "./src/browser-history-button";
import { BrowserDownloadsButtonFeature } from "./src/browser-downloads-button";
import { FileExplorerPathBarFeature } from "./src/file-explorer-path-bar";
import { LocalWebPreviewFeature } from "./src/local-web-preview";
import { DshFeature } from "./src/dsh/dsh-feature";
import { normalizeDshSettings } from "./src/dsh/dsh-settings";
import {
  FALLBACK_OPENABLE_EXTENSIONS,
  extensionOfFileName,
} from "./src/file-explorer-path-bar";
import { parseTexSections } from "./src/source-assist/tex-outline";
import { normalizeMvRunSettings } from "./src/terminal/mv-run-types";
import { TerminalRegistry } from "./src/terminal-control/terminal-registry";
import { DshTerminalRpc } from "./src/terminal-control/dsh-terminal-rpc";
import { runFileBottomCommandWithTerminalRegistry } from "./src/terminal-control/mv-run-command";
import {
  normalizeTerminalOpenMode,
  normalizeTerminalOpenPosition,
  resolveTerminalLeaf,
} from "./src/terminal-control/terminal-layout";
import {
  applyObsidianStatusBarVisibility as applyNativeStatusBarVisibility,
  clearObsidianStatusBarVisibility,
} from "./src/obsidian-status-bar-visibility";
import {
  anyVimSourceEnabled,
  normalizeVimSettings,
} from "./src/vim/settings";
import type {
  VimFeatureHandle,
  VimFeatureHost,
  VimFeatureStatus,
} from "./src/vim-host/public";
import { SourceAssistFeature } from "./src/source-assist/source-assist-feature";
import { TexOutlineFeature } from "./src/source-assist/tex-outline-feature";
import {
  CUSTOM_MARKDOWN_PLAIN_VISUALS_CLASS,
  customMarkdownPlainVisualsEnabled,
  normalizeSourceAssistSettings,
  sourceAssistMarkdownExtensions,
} from "./src/source-assist/source-assist-settings";
import { sourceHighlightThemeStyleAttribute } from "./src/source-assist/highlight-themes";
import {
  atMentionedParams,
  currentSelection,
  getVaultRoot,
  selectionChangedParams,
} from "./src/selection";
import {
  availableCustomMarkdownFilePath,
  customMarkdownFileCommandDefinitions,
  customMarkdownHighlightRangesForSource,
  MvAideIdeSettingTab,
  syncCustomMarkdownExtensionRegistry,
  type MarkdownExtensionRegistry,
  type PrismLike,
} from "./src/settings-tab";
import {
  ToolRegistry,
} from "./src/tool-registry";
import {
  IDE_TOOL_DEFINITIONS,
  isMcpToolEnabled,
  mcpToolDefinitions,
} from "./src/tool-definitions";
import {
  ensureMcpRegistration,
  removeMcpRegistration,
} from "./src/mcp-registration";
import {
  migrateManualUpstream,
  resolveAnthropicBaseUrl,
} from "./src/upstream-resolver";
import {
  schedulePostLayoutStartup,
  type PostLayoutStartupHandle,
} from "./src/post-layout-startup";
import { stablePortSeed } from "./src/path-utils";
import { FileTypeIconView } from "./src/file-type-icon-view";
import {
  createStartupPerformanceRecorder,
  type StartupPerformanceSnapshot,
} from "./src/startup-performance";
import {
  applyBottomTerminalSplitRatio,
  activeWorkspaceLeaf,
  currentWorkspaceContext,
  getOpenWorkspaceTabs,
} from "./src/workspace-context";
import {
  installWebSelectionReporterScript,
  parseWebSelectionMessage,
} from "./src/web-selection-reporter";
import { SelectionHighlightController } from "./src/selection-highlights";
import { TerminalSessionTracker } from "./src/terminal-session-tracker";
import { LlmFeature } from "./src/llm-feature";
import { InlineCompletionFeature } from "./src/inline-completion/inline-completion-feature";
import {
  ExternalFileOpenerFeature,
  externalFileAllowedExtensions,
  isExternalFileExtensionAllowed,
  normalizeExternalFileDisabledExtensions,
  normalizeExternalFileOpenerExtensionMode,
  type ExternalFileOpenResult,
  type ExternalFileStorageMigrationSummary,
  type ManagedCopyRestoreTask,
  type ManagedCopySymlinkRetrySummary,
} from "./src/external-file-opener";
import {
  openExternalFileWithFallbackConsent as runExternalFileFallbackConsent,
} from "./src/external-file-fallback-orchestrator";
import {
  requestExternalFileSymlinkFallbackDecision,
  type ExternalFileSymlinkFallbackDecision,
} from "./src/external-file-symlink-fallback-modal";
import {
  ExternalFileOpenerSystem,
  readExternalFileOpenerOwner,
  sameVaultRoot,
  type DefaultOpenerOperationResult,
  type DefaultOpenerStatus,
  type ExternalFileOpenerOwnerConfirmation,
} from "./src/external-file-opener-system";
import { readOrCreateExternalFileHostId } from "./src/external-file-host-identity";
import { normalizeExternalFileMirrorFolder } from "./src/external-file-mirror-path";
import {
  EXTERNAL_FILE_MIRROR_FOLDER,
  VIM_VAULT_CONFIG_PATH,
} from "./src/vault-storage-paths";
import {
  openFileWithDefaultApp,
  type DefaultFileOpenResult,
} from "./src/reveal-in-folder";
import type {
  ManagedCopyConflict,
  ManagedCopyConflictChoice,
  ManagedCopyConflictResolutionResult,
} from "./src/managed-copy-fallback";
import {
  CodexIdeProvider,
  codexIdeSocketPathForRuntime,
  type CodexIdeContextSnapshot,
} from "./src/codex-ide-provider";
import {
  ensureCodexMcpRegistration,
  removeCodexMcpRegistration,
  ensureCodexShellAlias,
  removeCodexShellAlias,
} from "./src/codex-mcp-registration";
import type {
  BridgeClientContext,
  BridgeSettings,
  JsonRpcRequest,
  JsonRpcResponse,
  ResolvedUpstream,
  SelectionState,
} from "./src/types";

type NewLeafSpecifier = PaneType | boolean;
type UniversalMcpServerInstance = InstanceType<typeof UniversalMcpServer>;

interface UniversalMcpIdleHandle {
  kind: "idle" | "timeout";
  id: number;
}

interface BundledModuleEvaluationTiming {
  startedAt: number;
  endedAt?: number;
}

interface NativeOpenDialog {
  showOpenDialog(options: {
    properties?: string[];
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

const refreshCustomMarkdownHighlightEffect = StateEffect.define<void>();

class CustomMarkdownExtensionModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly extensions: string[],
    private readonly onChooseExtension: (extension: string) => void,
  ) {
    super(app);
    this.setPlaceholder(t("选择要新建的文件后缀"));
    this.emptyStateText = t("没有可用的自定义 Markdown 后缀");
    this.setInstructions([
      { command: "↵", purpose: t("新建对应后缀文件") },
      { command: "esc", purpose: t("取消") },
    ]);
  }

  getItems(): string[] {
    return this.extensions;
  }

  getItemText(extension: string): string {
    return `.${extension}`;
  }

  onChooseItem(extension: string, _evt: MouseEvent | KeyboardEvent): void {
    this.onChooseExtension(extension);
  }
}

class ExternalFilePathModal extends Modal {
  private pathValue = "";

  constructor(
    app: App,
    private readonly allowedExtensions: string[],
    private readonly onSubmitPath: (filePath: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("通过路径打开电脑上的文件") });
    contentEl.createEl("p", {
      text: t("支持后缀：{extensions}", {
        extensions: this.allowedExtensions.map((ext) => `.${ext}`).join("、"),
      }),
      cls: "setting-item-description",
    });
    const setting = new Setting(contentEl)
      .setName(t("文件路径"))
      .addText((text) => {
        text
          .setPlaceholder("/absolute/path/file.md")
          .setValue(this.pathValue)
          .onChange((value) => {
            this.pathValue = value;
          });
      });
    const input = setting.controlEl.querySelector("input");
    input?.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t("打开")).setCta().onClick(() => this.submit()),
      )
      .addButton((button) =>
        button.setButtonText(t("取消")).onClick(() => this.close()),
      );
    input?.focus();
  }

  private submit(): void {
    const value = this.pathValue.trim();
    if (!value) {
      new Notice(t("请输入外部文件绝对路径。"));
      return;
    }
    this.onSubmitPath(value);
    this.close();
  }
}

class ManagedCopyConflictModal extends Modal {
  private choiceMade = false;

  constructor(
    app: App,
    private readonly conflict: ManagedCopyConflict,
    private readonly resolveConflict: (
      choice: ManagedCopyConflictChoice,
    ) => Promise<ManagedCopyConflictResolutionResult>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("外部文件出现双边修改") });
    contentEl.createEl("p", {
      text: t("外部原文件和 Obsidian 中的受管临时副本都已修改。为防止覆盖，本插件已暂停自动同步，请选择保留哪一侧。"),
      cls: "setting-item-description",
    });
    contentEl.createEl("p", {
      text: t("外部文件：{path}", { path: this.conflict.state.externalPath }),
      cls: "setting-item-description",
    });
    contentEl.createEl("p", {
      text: t("Vault 副本：{path}", { path: this.conflict.state.vaultPath }),
      cls: "setting-item-description",
    });
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("保留外部文件"))
          .setCta()
          .onClick(() => void this.choose("external")),
      )
      .addButton((button) =>
        button
          .setButtonText(t("保留 Obsidian 副本"))
          .onClick(() => void this.choose("copy")),
      )
      .addButton((button) =>
        button
          .setButtonText(t("稍后处理"))
          .onClick(() => void this.choose("later")),
      );
  }

  onClose(): void {
    if (!this.choiceMade) void this.resolveConflict("later");
  }

  private async choose(choice: ManagedCopyConflictChoice): Promise<void> {
    if (this.choiceMade) return;
    this.choiceMade = true;
    this.close();
    try {
      const result = await this.resolveConflict(choice);
      if (result.status === "resolved-external") {
        new Notice(t("已保留外部文件，并更新 Obsidian 受管副本。"));
      } else if (result.status === "resolved-copy") {
        new Notice(t("已保留 Obsidian 副本，并安全写回外部文件。"));
      } else if (result.status === "stale") {
        new Notice(t("选择期间文件再次变化；本次未覆盖任何一侧，请重新处理。"), 8000);
      }
    } catch (error) {
      new Notice(
        t("受管副本冲突处理失败：{message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }
}

function customMarkdownHighlightRefreshRequested(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) =>
    transaction.effects.some((effect) =>
      effect.is(refreshCustomMarkdownHighlightEffect),
    ),
  );
}

export default class MvAideIdePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  port = 0;
  mcpStatus = t("尚未检查");
  codexMcpStatus = t("Codex MCP 未启用");
  universalMcpStatus = t("mv-AIDE 协议未启用");
  defaultFileOpenerStatus = t("尚未检查");
  claudeIdeError: string | null = null;
  codexIdeError: string | null = null;
  private server: BridgeServer | null = null;
  private bridgeAuthToken: string | null = null;
  private bridgeHasDiscoveryLock = false;
  private bridgeHasClaudeMirror = false;
  private readonly latestSelections = new Map<string, SelectionState>();
  private latestWebLeaf: WorkspaceLeaf | null = null;
  /** 每个 webviewer 叶子的页内推送缓存：{text 选区文本, url 导航中目标 URL}。 */
  private readonly webSelectionPush = new WeakMap<
    WorkspaceLeaf,
    { text: string | null; url: string | null }
  >();
  /** webview 元素 → 所属叶子（事件回调反查）。 */
  private readonly webElementLeaf = new Map<HTMLElement, WorkspaceLeaf>();
  /** webview 元素 → 已挂接的选区通道监听器（onunload 逐一移除）。 */
  private readonly webSelectionListeners = new Map<
    HTMLElement,
    Array<{ type: string; listener: EventListener }>
  >();
  /** 已挂接推送监听/脚本注入的 webview 元素（幂等去重）。 */
  private readonly reportedWebElements = new WeakSet<HTMLElement>();
  private readonly lastContexts = new Map<string, SelectionState>();
  private readonly previousBroadcasts = new Map<string, string>();
  private broadcastTimer: number | null = null;
  private broadcastGeneration = 0;
  /** 广播串行化：进行中标记与待重跑标记（见 runBroadcast）。 */
  private broadcastInFlight = false;
  private broadcastQueued = false;
  private toolRegistry: ToolRegistry | null = null;
  private terminalTracker: TerminalSessionTracker | null = null;
  terminalRegistry: TerminalRegistry | null = null;
  private dshTerminalRpc: DshTerminalRpc | null = null;
  private selectionHighlighter: SelectionHighlightController | null = null;
  private llmFeature: LlmFeature | null = null;
  private inlineCompletion: InlineCompletionFeature | null = null;
  private sourceAssist: SourceAssistFeature | null = null;
  private vimFeature: VimFeatureHandle | null = null;
  private lintFeature: LintFeature | null = null;
  private lintPushSignature: string | null = null;
  private regexReplace: RegexReplaceFeature | null = null;
  private texOutline: TexOutlineFeature | null = null;
  private browserHistoryButton: BrowserHistoryButtonFeature | null = null;
  private browserDownloadsButton: BrowserDownloadsButtonFeature | null = null;
  private fileExplorerPathBar: FileExplorerPathBarFeature | null = null;
  private localWebPreview: LocalWebPreviewFeature | null = null;
  private externalFileOpener: ExternalFileOpenerFeature | null = null;
  dshFeature: DshFeature | null = null;
  private readonly externalFileOpenerSystem = new ExternalFileOpenerSystem();
  private externalFileFallbackDecision:
    Promise<ExternalFileSymlinkFallbackDecision> | null = null;
  private codexIdeProvider: CodexIdeProvider | null = null;
  private mcpRegistrationTimer: number | null = null;
  private mcpRegistrationInFlight: Promise<void> | null = null;
  private codexMcpRegistrationTimer: number | null = null;
  private codexMcpRegistrationInFlight: Promise<void> | null = null;
  private postLayoutStartup: PostLayoutStartupHandle | null = null;
  private fileTypeIconView: FileTypeIconView | null = null;
  private universalMcpServer: UniversalMcpServerInstance | null = null;
  private universalMcpDescriptor: UniversalMcpRuntimeDescriptor | null = null;
  private universalMcpIdleHandle: UniversalMcpIdleHandle | null = null;
  private universalMcpLayoutReady = false;
  private universalMcpStartGeneration = 0;
  private universalMcpStartInFlight: Promise<void> | null = null;
  private universalMcpStopInFlight: Promise<void> | null = null;
  private universalSelectionSignature: string | null = null;
  private universalEditorsSignature: string | null = null;
  private universalLatestMention: unknown = null;
  private readonly startupPerformance = createStartupPerformanceRecorder();
  private startupModuleTimingRecorded = false;
  private measuredManagedCopyRestoreTask: ManagedCopyRestoreTask | null = null;
  private registeredCustomMarkdownExtensions = new Set<string>();
  private ownedCustomMarkdownExtensions = new Set<string>();
  private readonly registeredCustomMarkdownCommandIds = new Set<string>();
  private readonly registeredStaticCommandIds = new Set<string>();
  private terminalRibbonIcon: HTMLElement | null = null;
  private customMarkdownRibbonIcon: HTMLElement | null = null;
  private customMarkdownPrism: PrismLike | null = null;
  private customMarkdownPrismLoadStarted = false;
  private readonly customMarkdownHighlightEditorViews = new Set<EditorView>();
  private unloaded = false;

  async onload(): Promise<void> {
    this.recordBundledModuleEvaluation();
    const endOnloadTiming = this.startupPerformance.begin("plugin.onload");
    try {
    this.unloaded = false;
    const rawLoaded = (await this.loadData()) as
      | (Partial<BridgeSettings> & { codex?: unknown })
      | null;
    const { codex: _legacyCodex, ...loaded } = rawLoaded ?? {};
    const terminalOpenPosition = normalizeTerminalOpenPosition(
      loaded.terminalOpenPosition ?? DEFAULT_SETTINGS.terminalOpenPosition,
    );
    const terminalOpenMode = normalizeTerminalOpenMode(
      loaded.terminalOpenMode ?? DEFAULT_SETTINGS.terminalOpenMode,
    );
    this.settings = normalizeTerminalThemeSettings({
      ...DEFAULT_SETTINGS,
      ...loaded,
      terminalOpenPosition,
      terminalOpenMode,
      // 旧版曾用该字段启用 UA/WebAuthn 登录补丁。该方案会制造矛盾的
      // 浏览器指纹，现仅保留数据结构兼容；无论旧 data.json 为何值，
      // 当前运行时都必须保持原生 Web Viewer 身份。
      webviewStripElectronUa: false,
      hideObsidianStatusBar: loaded.hideObsidianStatusBar === true,
      activityTracking: {
        ...DEFAULT_SETTINGS.activityTracking,
        ...(loaded.activityTracking ?? {}),
      },
      toolToggles: {
        ...DEFAULT_SETTINGS.toolToggles,
        ...(loaded.toolToggles ?? {}),
      },
      toolContextLimits: {
        ...DEFAULT_SETTINGS.toolContextLimits,
        ...(loaded.toolContextLimits ?? {}),
      },
      ideIntegrations: {
        claudeCode:
          loaded.ideIntegrations?.claudeCode ??
          DEFAULT_SETTINGS.ideIntegrations.claudeCode,
        codex:
          loaded.ideIntegrations?.codex ??
          DEFAULT_SETTINGS.ideIntegrations.codex,
      },
      universalMcp: {
        ...DEFAULT_SETTINGS.universalMcp,
        ...(loaded.universalMcp ?? {}),
      },
      llm: migrateLlm(loaded.llm),
      inlineCompletion: migrateInlineCompletion(loaded.inlineCompletion),
      sourceAssist: normalizeSourceAssistSettings(loaded.sourceAssist),
      vim: normalizeVimSettings(loaded.vim),
      sourceLint: normalizeLintSettings(loaded.sourceLint),
      regexReplace: normalizeRegexReplaceSettings(loaded.regexReplace),
      mvRun: normalizeMvRunSettings(loaded.mvRun),
      externalFileOpener: {
        ...DEFAULT_SETTINGS.externalFileOpener,
        ...(loaded.externalFileOpener ?? {}),
        mirrorFolder: (() => {
          try {
            return normalizeExternalFileMirrorFolder(
              loaded.externalFileOpener?.mirrorFolder ??
                DEFAULT_SETTINGS.externalFileOpener.mirrorFolder,
            );
          } catch {
            return DEFAULT_SETTINGS.externalFileOpener.mirrorFolder;
          }
        })(),
        extensionMode: normalizeExternalFileOpenerExtensionMode(
          loaded.externalFileOpener?.extensionMode,
        ),
        disabledExtensions: normalizeExternalFileDisabledExtensions(
          loaded.externalFileOpener?.disabledExtensions,
        ),
        mappings: {
          ...(loaded.externalFileOpener?.mappings ?? {}),
        },
      },
      dsh: normalizeDshSettings(loaded.dsh),
    });
    setLanguage(this.settings.language ?? "zh");
    this.universalMcpStatus = this.settings.universalMcp.enabled
      ? t("等待 Obsidian 启动完成")
      : t("mv-AIDE 协议未启用");
    if (!this.settings.externalFileOpener.openerToken) {
      this.settings.externalFileOpener.openerToken = randomUUID();
    }
    if (
      process.platform === "win32" &&
      this.settings.windowsMcpRegistrationVersion !==
        WINDOWS_MCP_REGISTRATION_VERSION
    ) {
      this.settings.mcpAuthToken = randomUUID();
      this.settings.registeredMcpUrl = null;
      this.settings.windowsMcpRegistrationVersion =
        WINDOWS_MCP_REGISTRATION_VERSION;
    } else if (!this.settings.mcpAuthToken) {
      this.settings.mcpAuthToken = randomUUID();
    }
    this.settings = migrateManualUpstream(getVaultRoot(this.app), this.settings);
    this.registerView(DIFF_VIEW_TYPE, (leaf) => new ObsidianDiffView(leaf));
    this.registerView(TERMINAL_VIEW_TYPE, (leaf) => new TerminalView(leaf, this));
    this.register(() => this.unregisterCustomMarkdownExtensions());
    this.terminalRegistry = new TerminalRegistry(
      this.app,
      () => this.createTerminalView(),
    );
    this.dshTerminalRpc = new DshTerminalRpc(this.terminalRegistry);
    this.applyObsidianStatusBarVisibility();
    this.syncCustomMarkdownExtensions();
    this.addSettingTab(new MvAideIdeSettingTab(this.app, this));
    this.terminalTracker = new TerminalSessionTracker(this.app);
    this.selectionHighlighter = new SelectionHighlightController(
      this.app,
      this.settings.preserveSelectionHighlights,
    );
    this.inlineCompletion = new InlineCompletionFeature(this);
    this.sourceAssist = new SourceAssistFeature(this);
    this.externalFileOpener = new ExternalFileOpenerFeature({
      app: this.app,
      getSettings: () => this.settings,
      getVaultRoot: () => getVaultRoot(this.app),
      saveSettings: () => this.saveData(this.settings),
      managedCopyFallbackEnabled: () =>
        this.externalFileOpenerSystem.managedCopyFallbackEnabled(
          getVaultRoot(this.app),
        ),
      getManagedCopyHostId: () => readOrCreateExternalFileHostId(
        getVaultRoot(this.app),
        path.join(os.homedir(), ".mv-aide", "external-file-host-id"),
      ),
      moveVaultDirectory: async (previousVaultPath, targetVaultPath) => {
        await this.moveVaultDirectory(previousVaultPath, targetVaultPath);
      },
      onManagedCopyConflict: (conflict, resolve) => {
        new ManagedCopyConflictModal(this.app, conflict, resolve).open();
      },
      onManagedCopyError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          "[mv-aide] Managed-copy synchronization failed.",
          error,
        );
        new Notice(
          t("受管临时副本同步失败：{message}", { message }),
          8000,
        );
      },
    });
    this.toolRegistry = new ToolRegistry(
      this.app,
      (context) => this.latestSelectionFor(context),
      () => this.latestWebLeaf,
      () => this.settings.toolContextLimits.readCurrentWebPage,
      () => this.lintFeature?.diagnosticsSnapshot() ?? [],
      () => this.settings.dsh.reviewOutsideVault,
    );

    this.codexIdeProvider = new CodexIdeProvider({
      getSnapshot: () => this.codexIdeContextSnapshot(),
      socketPath: codexIdeSocketPathForRuntime(this.codexRuntimeDir()),
      onLog: (message) => console.error("[mv-aide]", message),
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.terminalTracker?.scan();
        this.terminalRegistry?.refresh();
        this.terminalRegistry?.markActiveLeaf(leaf);
        this.fileTypeIconView?.refreshTabIcons();
        this.selectionHighlighter?.sync(true);
        this.trackWebSelectionReporters();
        this.scheduleBroadcast();
        // Returning to a terminal tab must hand keyboard focus back to
        // xterm's textarea; otherwise the terminal looks dead until clicked.
        this.app.workspace.getActiveViewOfType(TerminalView)?.focusTerminal();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.terminalTracker?.scan();
        this.terminalRegistry?.refresh();
        this.fileTypeIconView?.refreshTabIcons();
        this.selectionHighlighter?.sync();
        this.trackWebSelectionReporters();
        this.scheduleBroadcast();
      }),
    );
    this.registerDomEvent(
      this.app.workspace.containerEl.ownerDocument,
      "selectionchange",
      () => this.scheduleBroadcast(),
    );
    this.registerDomEvent(activeWindow, "focus", () => {
      this.previousBroadcasts.clear();
      this.terminalTracker?.scan();
      this.scheduleBroadcast();
    });
    this.registerInterval(
      activeWindow.setInterval(() => {
        this.terminalTracker?.scan();
        this.selectionHighlighter?.sync();
        this.llmFeature?.tick();
        this.inlineCompletion?.tick();
        const leaf = activeWorkspaceLeaf(this.app);
        this.trackWebSelectionReporters();
        if (
          this.settings.activityTracking.supportAllActivePages ||
          leaf?.view.getViewType() === "webviewer"
        ) {
          this.scheduleBroadcast();
        }
      }, 500),
    );
    this.registerEditorExtension(
      this.selectionHighlighter.markdownExtension(),
    );
    this.registerEditorExtension(
      this.inlineCompletion.markdownExtension(),
    );
    await this.sourceAssist.load();
    this.registerEditorExtension(this.sourceAssist.extensions);
    await this.syncVimFeatureFromSettings();
    this.lintFeature = new LintFeature(this);
    this.registerEditorExtension(this.lintFeature.extensions);
    this.lintFeature.registerCommand();
    this.lintFeature.registerHooks();
    this.register(() => this.lintFeature?.dispose());
    this.regexReplace = new RegexReplaceFeature(this);
    this.registerEditorExtension(this.regexReplace.extensions);
    this.regexReplace.registerCommands();
    this.browserHistoryButton = new BrowserHistoryButtonFeature(this);
    this.browserHistoryButton.register();
    this.browserHistoryButton.setEnabled(this.settings.browserHistoryButton);
    this.browserDownloadsButton = new BrowserDownloadsButtonFeature(this);
    this.browserDownloadsButton.register();
    this.browserDownloadsButton.setEnabled(this.settings.browserDownloadsButton);
    this.fileExplorerPathBar = new FileExplorerPathBarFeature(this);
    this.fileExplorerPathBar.register();
    this.fileExplorerPathBar.setEnabled(this.settings.fileExplorerPathBar);
    this.dshFeature = new DshFeature(this);
    this.texOutline = new TexOutlineFeature(this.app, () =>
      this.texOutlineFeatureEnabled(),
    );
    this.register(() => this.texOutline?.dispose());
    this.registerEditorExtension(this.texOutline.editorExtension());
    this.texOutline.activate();
    this.registerEditorExtension(this.customMarkdownPlainVisualsExtension());
    this.registerEditorExtension(this.customMarkdownHighlightThemeExtension());
    this.registerEditorExtension(this.customMarkdownHighlightExtension());
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) this.scheduleBroadcast();
      }),
    );
    void this.loadCustomMarkdownPrism();
    this.registerStaticCommands();

    this.terminalRibbonIcon = this.addRibbonIcon(
      "terminal",
      t("打开系统终端"),
      () => {
        this.activateTerminalView();
      },
    );

    this.customMarkdownRibbonIcon = this.addRibbonIcon(
      "file-plus",
      t("新建非 MD 源码文件"),
      (evt) => {
        this.activateCustomMarkdownFileCreation(Keymap.isModEvent(evt));
      },
    );

    this.llmFeature = new LlmFeature(this);
    this.llmFeature.registerCommands();
    this.llmFeature.registerMenus();

    this.fileTypeIconView = new FileTypeIconView({
      app: this.app,
      getSupportedExtensions: () => this.externalFileAllowedExtensions(),
      isEnabled: () =>
        this.settings.externalFileOpener.enabled &&
        this.settings.externalFileOpener.fileTypeIcons !== false,
    });
    this.fileTypeIconView.start();
    this.app.workspace.onLayoutReady(() => this.fileTypeIconView?.refresh());

    this.schedulePostLayoutStartup();
    this.terminalTracker.scan();
    this.terminalRegistry?.refresh();
    this.terminalRegistry?.markActiveLeaf(activeWorkspaceLeaf(this.app));
    this.selectionHighlighter.sync(true);
    this.scheduleBroadcast();
    } finally {
      endOnloadTiming();
    }
  }

  onunload(): void {
    if (this.broadcastTimer !== null) {
      activeWindow.clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    clearObsidianStatusBarVisibility(document);
    this.dshTerminalRpc?.dispose();
    this.dshTerminalRpc = null;
    this.terminalRegistry?.dispose();
    this.terminalRegistry = null;
    this.unloaded = true;
    this.cancelUniversalMcpIdleStart();
    this.postLayoutStartup?.cancel();
    this.postLayoutStartup = null;
    this.clearScheduledMcpRegistration();
    this.clearScheduledCodexMcpRegistration();
    this.selectionHighlighter?.destroy();
    this.selectionHighlighter = null;
    this.llmFeature?.dispose();
    this.llmFeature = null;
    this.inlineCompletion?.dispose();
    this.inlineCompletion = null;
    this.vimFeature?.disable();
    this.vimFeature = null;
    this.externalFileOpener?.dispose();
    this.externalFileOpener = null;
    this.fileTypeIconView?.dispose();
    this.fileTypeIconView = null;
    this.localWebPreview?.dispose();
    this.localWebPreview = null;
    this.dshFeature?.dispose();
    this.dshFeature = null;
    this.removeWebSelectionReporters();
    this.customMarkdownHighlightEditorViews.clear();

    const leaves = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof TerminalView) {
        try {
          (view as any).stopShell();
        } catch (_) {}
      }
    }

    void removeCodexShellAlias();
    void this.finishUnload();
  }

  private async openTerminalView(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const { leaf, createdBottomSplit } = resolveTerminalLeaf(workspace, {
      position: this.settings.terminalOpenPosition,
      mode: this.settings.terminalOpenMode,
    });
    if (!leaf) return null;

    await leaf.setViewState({
      type: TERMINAL_VIEW_TYPE,
      active: true,
    });
    await workspace.revealLeaf(leaf);
    if (createdBottomSplit) applyBottomTerminalSplitRatio(leaf, workspace);
    setTimeout(() => {
      if (leaf.view instanceof TerminalView) {
        leaf.view.focusTerminal();
      }
    }, 100);
    return leaf;
  }

  async activateTerminalView(): Promise<WorkspaceLeaf | null> {
    return this.openTerminalView();
  }

  /** Create a brand-new integrated terminal without changing the existing open command. */
  async createTerminalView(): Promise<WorkspaceLeaf | null> {
    return this.openTerminalView();
  }

  applyObsidianStatusBarVisibility(): void {
    applyNativeStatusBarVisibility(document, this.settings.hideObsidianStatusBar);
  }

  refreshTerminalThemes(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof TerminalView) {
        view.refreshTheme();
      }
    }
  }

  async saveAndApplySettings(): Promise<void> {
    await this.saveData(this.settings);
    this.fileTypeIconView?.syncFromSettings();
    this.syncCustomMarkdownExtensions();
    await this.sourceAssist?.settingsChanged();
    await this.syncLocalServices(true, false);
    await this.syncCodexIdeProvider();
    await this.applyUniversalMcpSetting();
    this.scheduleCodexMcpRegistrationIfReady();
    // Push the mv-agent settings to connected dsh plugins live (they read
    // them on initialize as well; this covers mid-session toggles).
    this.server?.broadcast({
      jsonrpc: "2.0",
      method: "mv_aide_settings_changed",
      params: {
        reviewOutsideVault: this.settings.dsh.reviewOutsideVault,
        passiveDelivery: this.settings.dsh.passiveDelivery,
        terminalAwarenessEnhanced: this.settings.dsh.terminalAwarenessEnhanced,
        pushLocation: this.settings.dsh.pushLocation,
        pushSelection: this.settings.dsh.pushSelection,
        outsideToolPolicy: this.settings.dsh.outsideToolPolicy,
      },
    });
  }

  async saveSourceAssistSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.syncCustomMarkdownExtensions();
    await this.sourceAssist?.settingsChanged();
    await this.texOutline?.settingsChanged();
    await this.syncVimFeatureFromSettings();
  }

  vimGlobalConfigPath(): string {
    return path.join(
      getVaultRoot(this.app),
      ...VIM_VAULT_CONFIG_PATH.split("/"),
    );
  }

  vimLegacyConfigSources(): VimFeatureHost["legacyVimrcSources"] {
    return [
      {
        filePath: path.join(os.homedir(), ".mv-aide", "vim", ".vimrc"),
        removeAfterMigration: true,
      },
      {
        filePath: path.join(
          getVaultRoot(this.app),
          this.app.vault.configDir,
          "plugins",
          this.manifest.id,
          ".vimrc",
        ),
        removeAfterMigration: false,
      },
    ];
  }

  vimStatus(): VimFeatureStatus {
    return this.vimFeature?.status() ?? {
      state: "disabled",
      message: this.vimSourceExtensionsEnabled()
        ? t("Vim 尚未完成加载。")
        : t("Vim 已关闭；未注册任何编辑器处理器。"),
      editorCount: 0,
      loadedFiles: [],
    };
  }

  async saveVimSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.syncVimFeatureFromSettings();
  }

  async reloadVimConfiguration(): Promise<void> {
    if (!this.vimSourceExtensionsEnabled()) return;
    const feature = await this.ensureVimFeature();
    await feature.reload();
  }

  async ensureVimConfigFile(): Promise<void> {
    if (!this.vimSourceExtensionsEnabled()) return;
    const feature = await this.ensureVimFeature();
    await feature.ensureVimrcFile();
  }

  async openVimConfigFile(): Promise<void> {
    if (!this.vimSourceExtensionsEnabled()) return;
    const feature = await this.ensureVimFeature();
    await feature.openVimrcFile();
  }

  async hasLegacyVimConfigFile(): Promise<boolean> {
    if (!this.vimSourceExtensionsEnabled()) return false;
    const feature = await this.ensureVimFeature();
    return feature.hasLegacyVimrcFile();
  }

  async migrateLegacyVimConfigFile(): Promise<boolean> {
    if (!this.vimSourceExtensionsEnabled()) return false;
    const feature = await this.ensureVimFeature();
    return feature.migrateLegacyVimrcFile();
  }

  private async syncVimFeatureFromSettings(): Promise<void> {
    if (!this.vimSourceExtensionsEnabled()) {
      this.vimFeature?.disable();
      return;
    }
    const conflict = this.detectVimConflict();
    if (conflict) {
      for (const source of Object.values(this.settings.vim.sources)) {
        source.enabled = false;
      }
      await this.saveData(this.settings);
      new Notice(conflict, 8000);
      return;
    }
    const feature = await this.ensureVimFeature();
    await feature.settingsChanged();
  }

  private vimSourceExtensionsEnabled(): boolean {
    return anyVimSourceEnabled(
      this.settings.vim,
      this.settings.sourceAssist.profiles.map((profile) => profile.extension),
    );
  }

  private async ensureVimFeature(): Promise<VimFeatureHandle> {
    if (this.vimFeature) return this.vimFeature;
    const { createVimFeature } = await import("./src/vim-host/feature");
    const host: VimFeatureHost = {
      app: this.app,
      pluginId: this.manifest.id,
      globalVimrcPath: this.vimGlobalConfigPath(),
      legacyVimrcSources: this.vimLegacyConfigSources(),
      vaultRoot: getVaultRoot(this.app),
      getSettings: () => this.settings.vim,
      sourceExtensions: () =>
        this.settings.sourceAssist.profiles.map((profile) => profile.extension),
      latexSuiteRuntimeEnabled: (extension) => {
        if (!this.settings.sourceAssist.enabled) return false;
        return this.settings.sourceAssist.profiles.some(
          (profile) =>
            profile.extension === extension && profile.latexSuiteEnabled,
        );
      },
      shouldYieldKey: (view, event) =>
        this.inlineCompletion?.shouldHandleKeyBeforeVim(view, event) ?? false,
      onEnterVisual: (view) => this.inlineCompletion?.dismissForVimVisual(view),
      createStatusBarItem: () => this.addStatusBarItem(),
      registerEditorExtension: (extension) =>
        this.registerEditorExtension(extension),
      refreshEditorExtensions: () => this.app.workspace.updateOptions(),
      notify: (message, timeout) => new Notice(message, timeout),
    };
    this.vimFeature = createVimFeature(host);
    return this.vimFeature;
  }

  private detectVimConflict(): string | null {
    const vimEnabled = Reflect.get(this.app, "isVimEnabled");
    if (
      typeof vimEnabled === "function" &&
      Reflect.apply(vimEnabled, this.app, []) === true
    ) {
      return t("无法启用 mv-AIDE Vim：请先在 Obsidian「编辑器」设置中关闭内置 Vim 键位。插件不会自动修改该设置。");
    }
    const pluginManager = Reflect.get(this.app, "plugins") as
      | { enabledPlugins?: Set<string> }
      | undefined;
    const conflicts = ["vim-motions", "obsidian-vimrc-support"].filter((id) =>
      pluginManager?.enabledPlugins?.has(id),
    );
    if (conflicts.length > 0) {
      return t("无法启用 mv-AIDE Vim：请先关闭冲突插件 {plugins}。插件不会自动关闭其它插件。", {
        plugins: conflicts.join(", "),
      });
    }
    return null;
  }

  private logicalVimSelection(view: MarkdownView) {
    const cm = (view.editor as unknown as { cm?: unknown }).cm;
    return cm instanceof EditorView
      ? this.vimFeature?.effectiveSelection(cm) ?? null
      : null;
  }

  currentSelectionState(): SelectionState | null {
    return currentSelection(this.app, (view) => this.logicalVimSelection(view));
  }

  currentWorkspaceContextState(
    leaf?: WorkspaceLeaf | null,
  ): Promise<SelectionState | null> {
    const push = leaf ? this.webSelectionPush.get(leaf) : undefined;
    return currentWorkspaceContext(
      this.app,
      leaf,
      (view) => this.logicalVimSelection(view),
      push && typeof push.text === "string" ? push.text : null,
      push && typeof push.url === "string" ? push.url : null,
    );
  }

  /**
   * 给所有 webviewer 叶子（含后台标签）挂接页内选区推送通道
   * （console-message），幂等。页面加载/导航期间 executeJavaScript 不可用，
   * 页内 selectionchange 的打点仍能即时推回；导航中的目标 URL 在
   * did-start-navigation 时就缓存，切换标签瞬间即可显示新页面地址。
   */
  private trackWebSelectionReporters(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType() !== "webviewer") return;
      const view = leaf.view as {
        webview?: (HTMLElement & {
          executeJavaScript?: (code: string) => Promise<unknown>;
        }) | null;
      };
      const webview = view.webview;
      if (!webview) return;
      if (this.reportedWebElements.has(webview)) return;
      this.reportedWebElements.add(webview);
      this.webElementLeaf.set(webview, leaf);

      const inject = (): void => {
        try {
          void webview
            .executeJavaScript?.(installWebSelectionReporterScript())
            .catch(() => {
              /* navigation in progress — dom-ready will re-inject */
            });
        } catch {
          /* navigation in progress — dom-ready will re-inject */
        }
      };

      const onConsoleMessage = ((event: Event) => {
        const message = (event as { message?: unknown }).message;
        if (typeof message !== "string") return;
        const text = parseWebSelectionMessage(message);
        if (text === null) return;
        const target = this.webElementLeaf.get(webview);
        if (!target) return;
        const current = this.webSelectionPush.get(target) ?? {
          text: null,
          url: null,
        };
        this.webSelectionPush.set(target, { ...current, text });
        if (activeWorkspaceLeaf(this.app) === target) this.scheduleBroadcast();
      }) as EventListener;
      const onDomReady = (): void => {
        const target = this.webElementLeaf.get(webview);
        if (target) {
          // 新文档就绪：view.url 已可用，导航 URL 缓存清掉；选区文本恢复
          // 为"未推送"，由注入脚本的首报与轮询兜底共同提供。
          this.webSelectionPush.set(target, { text: null, url: null });
        }
        inject();
      };
      const onNavigationStart = ((event: Event) => {
        const ev = event as { isMainFrame?: unknown; url?: unknown };
        if (ev.isMainFrame !== true) return;
        const target = this.webElementLeaf.get(webview);
        if (!target) return;
        const url = typeof ev.url === "string" ? ev.url : null;
        // 导航期间旧文档的选区不能算数：text 置 ""，避免读到旧页选区。
        this.webSelectionPush.set(target, { text: "", url });
        if (activeWorkspaceLeaf(this.app) === target) this.scheduleBroadcast();
      }) as EventListener;

      webview.addEventListener("console-message", onConsoleMessage);
      webview.addEventListener("dom-ready", onDomReady);
      webview.addEventListener("did-start-navigation", onNavigationStart);
      this.webSelectionListeners.set(webview, [
        { type: "console-message", listener: onConsoleMessage },
        { type: "dom-ready", listener: onDomReady },
        { type: "did-start-navigation", listener: onNavigationStart },
      ]);
      inject();
    });
  }

  /** 插件卸载时移除所有已挂接的 webview 选区通道监听器。 */
  private removeWebSelectionReporters(): void {
    for (const [webview, handlers] of this.webSelectionListeners) {
      for (const { type, listener } of handlers) {
        webview.removeEventListener(type, listener);
      }
    }
    this.webSelectionListeners.clear();
    this.webElementLeaf.clear();
  }

  private texOutlineFeatureEnabled(): boolean {
    const settings = this.settings.sourceAssist;
    // profile 级开关在 0.9.6 更名：enabled → latexSuiteEnabled（Code Suite
    // 总开关），与 sourceAssistTexEnhancedRenderEnabled 的门控口径一致。
    return (
      settings.enabled &&
      settings.profiles.some(
        (profile) =>
          profile.extension === "tex" &&
          profile.latexSuiteEnabled &&
          profile.texOutlineEnabled,
      )
    );
  }

  private registerStaticCommands(): void {
    for (const id of this.registeredStaticCommandIds) {
      this.removeCommand(id);
    }
    this.registeredStaticCommandIds.clear();

    this.addCommand({
      id: "send-selection-to-claude-code",
      name: t("发送当前选中内容到 Claude Code"),
      editorCallback: () => {
        const state = this.currentSelectionState();
        if (state) {
          const mention = atMentionedParams(state);
          this.universalLatestMention = mention;
          this.server?.broadcast({
            jsonrpc: "2.0",
            method: "at_mentioned",
            params: mention,
          });
          this.universalMcpServer?.publishBridgeEvent("at_mentioned", mention);
        }
      },
    });
    this.registeredStaticCommandIds.add("send-selection-to-claude-code");

    this.addCommand({
      id: "open-system-terminal",
      name: t("打开系统终端"),
      callback: () => this.activateTerminalView(),
    });
    this.registeredStaticCommandIds.add("open-system-terminal");

    this.addCommand({
      id: "run-file-bottom-command",
      name: t("运行 mv-run 指令"),
      editorCallback: (_editor, view) => {
        const registry = this.terminalRegistry;
        if (!registry) return;
        void runFileBottomCommandWithTerminalRegistry(
          this,
          registry,
          view instanceof MarkdownView ? view : undefined,
        );
      },
    });
    this.registeredStaticCommandIds.add("run-file-bottom-command");

    this.addCommand({
      id: "new-custom-markdown-file",
      name: t("新建非 MD 源码文件"),
      callback: () => this.activateCustomMarkdownFileCreation(false),
    });
    this.registeredStaticCommandIds.add("new-custom-markdown-file");

    this.addCommand({
      id: "open-external-file",
      name: t("打开电脑上的文件"),
      callback: () => void this.openExternalFileViaDialog(),
    });
    this.registeredStaticCommandIds.add("open-external-file");

    this.addCommand({
      id: "open-external-file-by-path",
      name: t("通过路径打开电脑上的文件"),
      callback: () => this.openExternalFileByPath(),
    });
    this.registeredStaticCommandIds.add("open-external-file-by-path");

    this.addCommand({
      id: "prune-external-file-links",
      name: t("清理外部文件链接"),
      callback: () => void this.pruneExternalFileLinks(),
    });
    this.registeredStaticCommandIds.add("prune-external-file-links");
  }

  /**
   * Switch the plugin UI language. Only invoked when the user toggles the
   * language in settings; re-registers commands and refreshes ribbon / view
   * titles so the new language applies immediately.
   */
  async applyLanguage(lang: Language): Promise<void> {
    if (this.settings.language === lang) {
      await this.saveData(this.settings);
      return;
    }
    this.settings.language = lang;
    setLanguage(lang);
    await this.saveData(this.settings);
    this.refreshAllCommands();
    this.refreshRibbonIcons();
    this.llmFeature?.refreshRibbon();
    this.inlineCompletion?.refreshRibbon();
    this.refreshViewTitles();
    this.refreshStatusTexts();
  }

  private refreshAllCommands(): void {
    this.registerStaticCommands();
    for (const id of Array.from(this.registeredCustomMarkdownCommandIds)) {
      this.removeCommand(id);
    }
    this.registeredCustomMarkdownCommandIds.clear();
    this.syncCustomMarkdownFileCommands();
    this.llmFeature?.registerCommands();
    this.lintFeature?.registerCommand();
    this.regexReplace?.registerCommands();
    this.dshFeature?.refreshCommand();
  }

  private refreshRibbonIcons(): void {
    const apply = (el: HTMLElement | null, title: string): void => {
      if (!el) return;
      el.setAttribute("aria-label", title);
      el.setAttribute("data-tooltip", title);
      el.setAttribute("title", title);
    };
    apply(this.terminalRibbonIcon, t("打开系统终端"));
    apply(this.customMarkdownRibbonIcon, t("新建非 MD 源码文件"));
  }

  private refreshViewTitles(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
      (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE)) {
      (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
      if (leaf.view instanceof ObsidianDiffView) leaf.view.refreshI18n();
    }
  }

  private refreshStatusTexts(): void {
    if (this.settings.ideIntegrations.claudeCode) {
      this.scheduleMcpRegistration();
    } else {
      this.mcpStatus = t("Claude Code IDE 已关闭");
    }
    this.scheduleCodexMcpRegistrationIfReady();
    this.scheduleUniversalMcpStart();
    void this.checkDefaultFileOpener().catch(() => undefined);
  }

  private customMarkdownExtensionRegistry(): MarkdownExtensionRegistry | null {
    return (this.app as unknown as { viewRegistry?: MarkdownExtensionRegistry }).viewRegistry ?? null;
  }

  private syncCustomMarkdownExtensions(): void {
    const state = syncCustomMarkdownExtensionRegistry(
      this.customMarkdownExtensionRegistry(),
      this.ownedCustomMarkdownExtensions,
      sourceAssistMarkdownExtensions(this.settings.sourceAssist).join(","),
      (message, error) => {
        console.warn(`[mv-aide] ${message}`, error ?? "");
      },
    );
    this.registeredCustomMarkdownExtensions = new Set(state.active);
    this.ownedCustomMarkdownExtensions = new Set(state.owned);
    this.syncCustomMarkdownFileCommands();
    this.refreshCustomMarkdownHighlights();
  }

  private syncCustomMarkdownFileCommands(): void {
    const definitions = customMarkdownFileCommandDefinitions(
      this.registeredCustomMarkdownExtensions,
    );
    const nextCommandIds = new Set(definitions.map((definition) => definition.id));

    for (const id of Array.from(this.registeredCustomMarkdownCommandIds)) {
      if (!nextCommandIds.has(id)) {
        this.removeCommand(id);
        this.registeredCustomMarkdownCommandIds.delete(id);
      }
    }

    for (const definition of definitions) {
      if (this.registeredCustomMarkdownCommandIds.has(definition.id)) continue;

      this.addCommand({
        id: definition.id,
        name: definition.name,
        callback: () => this.createCustomMarkdownFile(definition.extension, false),
      });
      this.registeredCustomMarkdownCommandIds.add(definition.id);
    }
  }

  private customMarkdownCreationExtensions(): string[] {
    return Array.from(this.registeredCustomMarkdownExtensions);
  }

  private activateCustomMarkdownFileCreation(
    newLeaf: NewLeafSpecifier = false,
  ): void {
    const extensions = this.customMarkdownCreationExtensions();
    if (extensions.length === 0) {
      new Notice(t("请先在“源码编写辅助”中添加源码类型。"));
      return;
    }

    if (extensions.length === 1) {
      void this.createCustomMarkdownFile(extensions[0]!, newLeaf);
      return;
    }

    new CustomMarkdownExtensionModal(this.app, extensions, (extension) => {
      void this.createCustomMarkdownFile(extension, newLeaf);
    }).open();
  }

  private async createCustomMarkdownFile(
    extension: string,
    newLeaf: NewLeafSpecifier = false,
  ): Promise<void> {
    try {
      const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
      const parent = this.app.fileManager.getNewFileParent(
        sourcePath,
        `Untitled.${extension}`,
      );
      const filePath = this.availableCustomMarkdownFilePath(parent, extension);
      const file = await this.app.vault.create(filePath, "");
      await this.app.workspace.getLeaf(newLeaf).openFile(file, {
        active: true,
        state: { mode: "source" },
        eState: { rename: "all" },
      });
    } catch (error) {
      console.error(
        "[mv-aide] Failed to create custom Markdown file",
        error,
      );
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("创建 .{extension} 文件失败：{message}", { extension, message }));
    }
  }

  private externalFileAllowedExtensions(): string[] {
    return externalFileAllowedExtensions(this.settings);
  }

  private async openExternalFileViaDialog(): Promise<void> {
    const dialog = this.nativeOpenDialog();
    if (!dialog) {
      new Notice(t("当前 Obsidian 环境无法打开系统文件选择器，请改用路径打开。"));
      this.openExternalFileByPath();
      return;
    }
    const extensions = this.externalFileAllowedExtensions();
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "AIDE supported files", extensions },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    await this.openExternalFile(result.filePaths[0]!);
  }

  private openExternalFileByPath(): void {
    new ExternalFilePathModal(
      this.app,
      this.externalFileAllowedExtensions(),
      (filePath) => {
        void this.openExternalFile(filePath);
      },
    ).open();
  }

  private async openExternalFile(
    filePath: string,
    makeFrontmost = true,
  ): Promise<void> {
    const result = await this.openExternalFileWithConsent(filePath, makeFrontmost);
    if (!result.success) {
      new Notice(
        t("打开外部文件失败：{message}", {
          message: result.message ?? t("未知错误"),
        }),
        8000,
      );
    }
  }

  private async openExternalFileWithConsent(
    filePath: string,
    makeFrontmost: boolean,
  ): Promise<ExternalFileOpenResult> {
    const opener = this.externalFileOpener;
    if (!opener) {
      return {
        success: false,
        externalPath: filePath,
        vaultPath: null,
        message: t("外部文件打开器尚未初始化。"),
      };
    }
    return await runExternalFileFallbackConsent({
      open: () => opener.openExternalFile(filePath, { makeFrontmost }),
      requestDecision: (failure, message) =>
        this.requestExternalFileFallbackDecision(failure, message),
      authorizeManagedCopy: (failure) =>
        this.externalFileOpenerSystem.authorizeManagedCopyFallbackAfterFailure(
          getVaultRoot(this.app),
          failure,
        ),
      ...(process.platform === "win32"
        ? { repairWindowsSymlinkSupport: () => this.repairWindowsDeveloperMode() }
        : {}),
    });
  }

  private async requestExternalFileFallbackDecision(
    failure: NonNullable<ExternalFileOpenResult["symlinkFailure"]>,
    message: string,
  ): Promise<ExternalFileSymlinkFallbackDecision> {
    if (this.externalFileFallbackDecision) {
      return await this.externalFileFallbackDecision;
    }
    const pending = requestExternalFileSymlinkFallbackDecision({
      app: this.app,
      failure,
      message,
      platform: process.platform,
      openDeveloperSettings: process.platform === "win32"
        ? () => this.openWindowsDeveloperSettings()
        : undefined,
    });
    this.externalFileFallbackDecision = pending;
    try {
      return await pending;
    } finally {
      if (this.externalFileFallbackDecision === pending) {
        this.externalFileFallbackDecision = null;
      }
    }
  }

  private async pruneExternalFileLinks(): Promise<void> {
    const removed = await this.externalFileOpener?.pruneBrokenMappings();
    new Notice(
      removed && removed > 0
        ? t("已清理 {count} 个失效外部文件链接。", { count: removed })
        : t("没有需要清理的外部文件链接。"),
    );
  }

  private nativeOpenDialog(): NativeOpenDialog | null {
    try {
      const requireFn = (window as unknown as {
        require?: (moduleName: string) => unknown;
      }).require;
      const electron = requireFn?.("electron") as
        | {
            remote?: { dialog?: NativeOpenDialog };
            dialog?: NativeOpenDialog;
          }
        | undefined;
      return electron?.remote?.dialog ?? electron?.dialog ?? null;
    } catch {
      return null;
    }
  }

  private availableCustomMarkdownFilePath(
    parent: TFolder,
    extension: string,
  ): string {
    return availableCustomMarkdownFilePath(parent.path, extension, (filePath) =>
      this.app.vault.getAbstractFileByPath(filePath) !== null,
    );
  }

  private unregisterCustomMarkdownExtensions(): void {
    for (const id of Array.from(this.registeredCustomMarkdownCommandIds)) {
      this.removeCommand(id);
      this.registeredCustomMarkdownCommandIds.delete(id);
    }

    const extensions = Array.from(this.ownedCustomMarkdownExtensions);
    if (extensions.length === 0) {
      this.registeredCustomMarkdownExtensions.clear();
      this.refreshCustomMarkdownHighlights();
      return;
    }

    try {
      this.customMarkdownExtensionRegistry()?.unregisterExtensions?.(extensions);
    } catch (error) {
      console.warn("[mv-aide] Failed to unregister custom Markdown extensions.", error);
    } finally {
      this.registeredCustomMarkdownExtensions.clear();
      this.ownedCustomMarkdownExtensions.clear();
      this.refreshCustomMarkdownHighlights();
    }
  }

  private customMarkdownHighlightExtension() {
    const plugin = this;
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(private readonly view: EditorView) {
          plugin.customMarkdownHighlightEditorViews.add(view);
          this.decorations = plugin.customMarkdownHighlightDecorations(view);
        }

        update(update: ViewUpdate): void {
          const shouldRefresh =
            update.docChanged ||
            plugin.customMarkdownEditorExtension(update.startState) !==
              plugin.customMarkdownEditorExtension(update.state) ||
            customMarkdownHighlightRefreshRequested(update);
          if (shouldRefresh) {
            this.decorations = plugin.customMarkdownHighlightDecorations(
              update.view,
            );
          }
        }

        destroy(): void {
          plugin.customMarkdownHighlightEditorViews.delete(this.view);
        }
      },
      {
        decorations: (pluginValue) => pluginValue.decorations,
      },
    );
  }

  private customMarkdownPlainVisualsExtension() {
    return EditorView.editorAttributes.of((view) => {
      const extension = this.customMarkdownEditorExtension(view.state);
      return customMarkdownPlainVisualsEnabled(
        this.registeredCustomMarkdownExtensions,
        extension,
      )
        ? { class: CUSTOM_MARKDOWN_PLAIN_VISUALS_CLASS }
        : null;
    });
  }

  private customMarkdownHighlightThemeExtension() {
    return EditorView.editorAttributes.of((view) => {
      const extension = this.customMarkdownEditorExtension(view.state);
      const style = sourceHighlightThemeStyleAttribute(
        this.settings.sourceAssist,
        this.registeredCustomMarkdownExtensions,
        extension,
      );
      if (!style && !this.registeredCustomMarkdownExtensions.has(extension)) {
        return null;
      }
      return {
        class: "mv-aide-source-highlight-themed",
        ...(style ? { style } : {}),
      };
    });
  }

  private customMarkdownHighlightDecorations(view: EditorView): DecorationSet {
    const ranges = customMarkdownHighlightRangesForSource(
      this.customMarkdownPrism,
      this.registeredCustomMarkdownExtensions,
      this.customMarkdownEditorExtension(view.state),
      view.state.doc.toString(),
      (message, error) => {
        console.warn(`[mv-aide] ${message}`, error ?? "");
      },
    );
    if (ranges.length === 0) return Decoration.none;

    const docLength = view.state.doc.length;
    const decorations = ranges
      .filter((range) => range.from < range.to && range.to <= docLength)
      .map((range) =>
        Decoration.mark({ class: range.classes }).range(range.from, range.to),
      );
    return decorations.length > 0
      ? Decoration.set(decorations, true)
      : Decoration.none;
  }

  private customMarkdownEditorExtension(state: EditorState): string {
    return (
      state
        .field(editorInfoField, false)
        ?.file?.extension?.toLowerCase() ?? ""
    );
  }

  private async loadCustomMarkdownPrism(): Promise<void> {
    if (this.customMarkdownPrismLoadStarted) return;
    this.customMarkdownPrismLoadStarted = true;

    try {
      this.customMarkdownPrism = (await loadPrism()) as PrismLike;
      this.refreshCustomMarkdownHighlights();
    } catch (error) {
      console.warn("[mv-aide] Failed to load Prism.", error);
    }
  }

  private refreshCustomMarkdownHighlights(): void {
    for (const view of Array.from(this.customMarkdownHighlightEditorViews)) {
      try {
        view.dispatch({
          effects: refreshCustomMarkdownHighlightEffect.of(undefined),
        });
      } catch (error) {
        console.warn(
          "[mv-aide] Failed to refresh custom Markdown highlighting.",
          error,
        );
      }
    }
  }

  refreshLlmFeature(): void {
    this.llmFeature?.settingsChanged();
  }

  refreshInlineCompletion(): void {
    this.inlineCompletion?.settingsChanged();
  }

  async setSelectionHighlightsEnabled(enabled: boolean): Promise<void> {
    this.settings.preserveSelectionHighlights = enabled;
    this.selectionHighlighter?.setEnabled(enabled);
    await this.saveData(this.settings);
  }

  async setBrowserHistoryButtonEnabled(enabled: boolean): Promise<void> {
    this.settings.browserHistoryButton = enabled;
    this.browserHistoryButton?.setEnabled(enabled);
    await this.saveData(this.settings);
  }

  async setBrowserDownloadsButtonEnabled(enabled: boolean): Promise<void> {
    this.settings.browserDownloadsButton = enabled;
    this.browserDownloadsButton?.setEnabled(enabled);
    await this.saveData(this.settings);
  }

  async setFileExplorerPathBarEnabled(enabled: boolean): Promise<void> {
    this.settings.fileExplorerPathBar = enabled;
    this.fileExplorerPathBar?.setEnabled(enabled);
    await this.saveData(this.settings);
  }

  async setBrowserLocalFilePreviewEnabled(enabled: boolean): Promise<void> {
    this.settings.browserLocalFilePreview = enabled;
    if (enabled && !this.localWebPreview) {
      this.localWebPreview = new LocalWebPreviewFeature(this);
    }
    await this.localWebPreview?.setEnabled(enabled);
    if (!enabled) this.localWebPreview = null;
    await this.saveData(this.settings);
  }

  /** 路径栏与下载弹窗共享的「全量显示」开关状态（会话级，不持久化）。 */
  private externalListingShowAll = false;

  getExternalListingShowAllFiles(): boolean {
    return this.externalListingShowAll;
  }

  setExternalListingShowAllFiles(value: boolean): void {
    this.externalListingShowAll = value;
  }

  /** 文件名是否可被 Obsidian 打开：优先查 viewRegistry，回落内置清单。 */
  canOpenWithObsidian(fileName: string): boolean {
    const extension = extensionOfFileName(fileName);
    if (!extension) return false;
    const registry = (
      this.app as unknown as {
        viewRegistry?: { getTypeByExtension?: (extension: string) => unknown };
      }
    ).viewRegistry;
    if (typeof registry?.getTypeByExtension === "function") {
      return Boolean(registry.getTypeByExtension(extension));
    }
    return FALLBACK_OPENABLE_EXTENSIONS.has(extension);
  }

  /**
   * 下载/浏览弹窗点击文件：注入打开器已启用、Obsidian 有可注册视图且后缀在
   * 注入打开器允许清单内时，用注入打开机制在当前 vault 直接打开（不经系统
   * wrapper 的仓库选择，本仓库不一定是默认打开仓库）；否则回退系统默认应用。
   * 不在此处弹 Notice：失败信息由调用方（弹窗行打开路径）统一展示。
   */
  async openExternalListingFile(
    absolutePath: string,
  ): Promise<DefaultFileOpenResult> {
    if (
      this.settings.externalFileOpener.enabled &&
      this.canOpenWithObsidian(path.basename(absolutePath)) &&
      isExternalFileExtensionAllowed(this.settings, absolutePath)
    ) {
      const result = await this.openExternalFileWithConsent(absolutePath, true);
      return { ok: result.success, error: result.message };
    }
    return await openFileWithDefaultApp(absolutePath);
  }

  async restartBridge(): Promise<void> {
    await this.stopBridge();
    await this.syncLocalServices(true);
    this.previousBroadcasts.clear();
    this.scheduleBroadcast();
  }

  async restoreClaudeSettings(): Promise<void> {
    const filePath = localClaudeSettingsPath(getVaultRoot(this.app));
    this.settings = restoreManagedBaseUrl(filePath, this.settings);
    restoreManagedTerminalHooks(filePath);
    await this.saveData(this.settings);
  }

  private async finishUnload(): Promise<void> {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["Universal MCP", () => this.stopUniversalMcp()],
      ["Codex IDE provider", async () => this.codexIdeProvider?.stop()],
      ["Claude settings", () => this.restoreClaudeSettings()],
      ["diff views", () => this.closeDiffs()],
      ["bridge", () => this.stopBridge()],
    ];
    await Promise.allSettled(
      cleanupSteps.map(async ([label, cleanup]) => {
        try {
          await cleanup();
        } catch (error) {
          console.error(`[mv-aide] ${label} unload cleanup failed`, error);
        }
      }),
    );
  }

  resolvedUpstream(): ResolvedUpstream {
    return resolveAnthropicBaseUrl(getVaultRoot(this.app), this.settings);
  }

  async retryMcpRegistration(): Promise<void> {
    this.clearScheduledMcpRegistration();
    await this.runMcpRegistration(true);
  }

  async cleanMcpRegistration(): Promise<void> {
    const result = await removeMcpRegistration(
      this.settings.claudeExecutable,
      getVaultRoot(this.app),
    );
    this.mcpStatus = result.ok
      ? result.message
      : t("清理失败：{message}", { message: result.message });
    if (result.ok) this.settings.registeredMcpUrl = null;
    await this.saveData(this.settings);
  }

  async checkDefaultFileOpener(): Promise<DefaultOpenerStatus> {
    const status = await this.externalFileOpenerSystem.check(
      getVaultRoot(this.app),
      this.externalFileAllowedExtensions(),
    );
    this.defaultFileOpenerStatus = status.message;
    return status;
  }

  async installDefaultFileOpener(
    options: { allowManagedCopyFallback?: boolean } = {},
  ): Promise<DefaultOpenerOperationResult> {
    const vaultRoot = getVaultRoot(this.app);
    const existing = readExternalFileOpenerOwner();
    if (existing) {
      const status = await this.checkDefaultFileOpener();
      const result: DefaultOpenerOperationResult = {
        ok: false,
        status,
        message: `${status.message} ${t("如需更换 owner，请先清理默认打开方式。")}`,
        failureKind: "existing-owner",
      };
      this.defaultFileOpenerStatus = result.message;
      new Notice(result.message, 8000);
      return result;
    }

    const wasEnabled = this.settings.externalFileOpener.enabled;
    if (!this.settings.externalFileOpener.enabled) {
      this.settings.externalFileOpener.enabled = true;
      await this.saveAndApplySettings();
    }
    const result = await this.externalFileOpenerSystem.install({
      vaultRoot,
      vaultName: this.vaultName(),
      mirrorFolder: this.settings.externalFileOpener.mirrorFolder,
      extensionMode: this.settings.externalFileOpener.extensionMode,
      extensions: this.externalFileAllowedExtensions(),
      allowManagedCopyFallback: options.allowManagedCopyFallback,
    });
    if (!result.ok && !wasEnabled) {
      this.settings.externalFileOpener.enabled = false;
      await this.saveAndApplySettings();
    }
    this.defaultFileOpenerStatus = result.message;
    if (result.ok) {
      this.syncExternalFileOpenerRuntime();
    }
    new Notice(result.message, result.ok ? 4000 : 8000);
    return result;
  }

  async cleanupDefaultFileOpener(
    confirmedOwner?: ExternalFileOpenerOwnerConfirmation,
  ): Promise<DefaultOpenerOperationResult> {
    const result = await this.externalFileOpenerSystem.cleanup(
      getVaultRoot(this.app),
      { confirmedOwner },
    );
    this.syncExternalFileOpenerRuntime();
    this.defaultFileOpenerStatus = result.message;
    new Notice(result.message, result.ok ? 5000 : 8000);
    return result;
  }

  async retryManagedCopiesAsSymlinks(): Promise<ManagedCopySymlinkRetrySummary> {
    const summary = await this.externalFileOpener?.retryManagedCopiesAsSymlinks() ?? {
      attempted: 0,
      migrated: 0,
      remaining: 0,
      failures: [],
      warnings: [],
    };
    if (summary.attempted === 0) {
      new Notice(t("当前没有本机受管临时副本需要迁移。"), 4000);
    } else if (summary.remaining === 0) {
      new Notice(
        t("已将 {count} 个受管临时副本安全迁移为真实符号链接。", {
          count: summary.migrated,
        }),
        5000,
      );
    } else {
      new Notice(
        t("已迁移 {migrated} 个；仍保留 {remaining} 个受管副本。 未迁移项不会丢失内容，详情见控制台。", {
          migrated: summary.migrated,
          remaining: summary.remaining,
        }),
        8000,
      );
      for (const failure of summary.failures) {
        console.warn(`[mv-aide] Managed-copy migration skipped: ${failure}`);
      }
    }
    for (const warning of summary.warnings) {
      console.warn(`[mv-aide] Managed-copy migration warning: ${warning}`);
    }
    return summary;
  }

  externalFileStorageNeedsMigration(): boolean {
    return this.settings.externalFileOpener.mirrorFolder !==
      EXTERNAL_FILE_MIRROR_FOLDER;
  }

  async migrateExternalFileStorage(): Promise<ExternalFileStorageMigrationSummary> {
    if (!this.externalFileOpener) {
      throw new Error(t("外部文件打开器尚未完成加载。"));
    }
    const summary = await this.externalFileOpener.migrateStorageFolder(
      EXTERNAL_FILE_MIRROR_FOLDER,
    );
    this.syncExternalFileOpenerRuntime();
    return summary;
  }

  private async moveVaultDirectory(
    previousVaultPath: string,
    targetVaultPath: string,
  ): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(previousVaultPath);
    if (!(source instanceof TFolder)) {
      throw new Error(t("旧外部文件目录未被 Obsidian 识别为文件夹。"));
    }
    const targetParent = path.posix.dirname(targetVaultPath);
    let current = "";
    for (const segment of targetParent.split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) {
        throw new Error(t("外部文件目标父路径已被普通文件占用。"));
      }
      await this.app.vault.createFolder(current);
    }
    await this.app.fileManager.renameFile(source, targetVaultPath);
  }

  async repairWindowsDeveloperMode(): Promise<boolean> {
    const result = await this.externalFileOpenerSystem.repairWindowsDeveloperMode();
    const messages = {
      repaired: t("已通过管理员权限启用并验证 Windows 开发者模式。"),
      "already-enabled": t("Windows 开发者模式已经生效，将重新检测符号链接。"),
      "blocked-by-policy": t("组织策略明确禁用了开发者模式，插件不会覆盖该策略。"),
      cancelled: t("已取消管理员修复。"),
    };
    const message = messages[result.status as keyof typeof messages] ?? result.message;
    new Notice(message, result.ok ? 5000 : 8000);
    return result.ok;
  }

  async openWindowsDeveloperSettings(): Promise<void> {
    try {
      await this.externalFileOpenerSystem.openWindowsDeveloperSettings();
      new Notice(t("已打开 Windows 开发者设置。开启开发者模式后回到此处重新检测。"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("无法打开 Windows 开发者设置：{message}", { message }), 8000);
    }
  }

  async openWindowsDefaultAppsSettings(): Promise<void> {
    try {
      await this.externalFileOpenerSystem.openWindowsDefaultAppsSettings();
      new Notice(t("已打开 Windows 默认应用设置，请为已注册后缀选择 MV AIDE File Opener。"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("无法打开 Windows 默认应用设置：{message}", { message }), 8000);
    }
  }

  async openWindowsGenericDefaultAppsSettings(): Promise<void> {
    try {
      await this.externalFileOpenerSystem.openWindowsGenericDefaultAppsSettings();
      new Notice(t("已打开 Windows 默认应用设置；如需更换已清理的默认项，请在系统界面选择其它应用。"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("无法打开 Windows 默认应用设置：{message}", { message }), 8000);
    }
  }

  private syncExternalFileOpenerRuntime(): void {
    const vaultRoot = getVaultRoot(this.app);
    if (!this.settings.externalFileOpener.enabled || !this.port) {
      this.externalFileOpener?.stopManagedCopyRuntime();
      this.externalFileOpenerSystem.removeRuntime(vaultRoot);
      return;
    }
    const owner = readExternalFileOpenerOwner();
    if (!owner || !sameVaultRoot(owner.vaultRoot, vaultRoot)) {
      this.externalFileOpener?.stopManagedCopyRuntime();
      this.externalFileOpenerSystem.removeRuntime(vaultRoot);
      return;
    }
    // Publish the opener runtime first. Managed-copy recovery is intentionally
    // a later, cancellable idle task so it cannot hold up external requests.
    this.startupPerformance.measureSync("external-opener.runtime-publish", () => {
      this.externalFileOpenerSystem.writeRuntime({
        vaultRoot,
        vaultName: this.vaultName(),
        port: this.port,
        token: this.settings.externalFileOpener.openerToken,
      });
    });
    const restoreTask = this.externalFileOpener?.scheduleManagedCopyWatcherRestore();
    if (restoreTask && restoreTask !== this.measuredManagedCopyRestoreTask) {
      this.measuredManagedCopyRestoreTask = restoreTask;
      const endRestoreTiming = this.startupPerformance.begin("managed-copy.restore");
      void restoreTask.completion.then(
        () => {
          endRestoreTiming();
          if (this.measuredManagedCopyRestoreTask === restoreTask) {
            this.measuredManagedCopyRestoreTask = null;
          }
        },
        (error) => {
          endRestoreTiming();
          if (this.measuredManagedCopyRestoreTask === restoreTask) {
            this.measuredManagedCopyRestoreTask = null;
          }
          console.warn(
            "[mv-aide] Failed to restore managed-copy watchers.",
            error,
          );
        },
      );
    }
  }

  private vaultName(): string {
    const vault = this.app.vault as unknown as { getName?: () => string };
    return vault.getName?.() || path.basename(getVaultRoot(this.app));
  }

  private shouldRunLocalServer(): boolean {
    return (
      this.settings.externalFileOpener.enabled ||
      this.settings.ideIntegrations.claudeCode ||
      (this.settings.ideIntegrations.codex && this.settings.mcpEnabled) ||
      this.dshFeature?.requiresBridge() === true
    );
  }

  private async syncLocalServices(
    notifyClaude = false,
    scheduleCodexMcp = true,
  ): Promise<void> {
    this.claudeIdeError = null;
    if (this.shouldRunLocalServer() && !this.server) {
      try {
        await this.startBridge();
      } catch (error) {
        this.claudeIdeError = error instanceof Error ? error.message : String(error);
        console.error("[mv-aide] Claude IDE bridge start failed", error);
      }
    } else if (!this.shouldRunLocalServer() && this.server) {
      await this.stopBridge();
    }

    await this.syncClaudeIntegration(notifyClaude);
    if (scheduleCodexMcp) {
      this.scheduleCodexMcpRegistration();
    } else {
      this.codexMcpStatus =
        this.settings.ideIntegrations.codex && this.settings.mcpEnabled
          ? t("Codex MCP 等待启动后初始化")
          : t("Codex MCP 未启用");
    }
    this.syncExternalFileOpenerRuntime();
  }

  private async syncClaudeIntegration(notify = false): Promise<void> {
    const bridgeRequested =
      this.settings.ideIntegrations.claudeCode ||
      this.dshFeature?.requiresBridge() === true;
    if (!bridgeRequested || !this.server || !this.port) {
      this.clearScheduledMcpRegistration();
      if (this.bridgeHasDiscoveryLock && this.port) {
        removeLockFile(this.port, discoveryLockDirectory());
      }
      if (this.bridgeHasClaudeMirror && this.port) {
        removeLockFile(this.port, claudeCompatibilityLockDirectory());
      }
      this.bridgeHasDiscoveryLock = false;
      this.bridgeHasClaudeMirror = false;
      if (!this.settings.ideIntegrations.claudeCode) {
        this.mcpStatus = t("Claude Code IDE 已关闭");
        await this.restoreClaudeSettings();
      }
      return;
    }

    const vaultRoot = getVaultRoot(this.app);
    const authToken = this.bridgeAuthToken ?? randomUUID();
    this.bridgeAuthToken = authToken;
    cleanStaleObsidianLocks(discoveryLockDirectory());
    cleanStaleObsidianLocks(claudeCompatibilityLockDirectory());
    if (!this.bridgeHasDiscoveryLock) {
      writeLockFile(this.port, vaultRoot, authToken, discoveryLockDirectory());
      this.bridgeHasDiscoveryLock = true;
    }
    if (this.settings.ideIntegrations.claudeCode && !this.bridgeHasClaudeMirror) {
      writeLockFile(this.port, vaultRoot, authToken, claudeCompatibilityLockDirectory());
      this.bridgeHasClaudeMirror = true;
    } else if (!this.settings.ideIntegrations.claudeCode && this.bridgeHasClaudeMirror) {
      removeLockFile(this.port, claudeCompatibilityLockDirectory());
      this.bridgeHasClaudeMirror = false;
    }
    if (this.settings.ideIntegrations.claudeCode) {
      await this.applyClaudeSettingsBestEffort(notify);
      if (!this.unloaded) await this.saveData(this.settings);
      this.scheduleMcpRegistration();
    }
  }

  private async startBridge(): Promise<void> {
    const vaultRoot = getVaultRoot(this.app);
    const authToken = randomUUID();
    this.bridgeAuthToken = authToken;
    this.server = new BridgeServer({
      authToken,
      mcpAuthToken: this.settings.mcpAuthToken,
      vaultRoot,
      settings: () => this.settings,
      upstreamBaseUrl: () => this.resolvedUpstream().url,
      externalFileOpenerToken: () =>
        this.settings.externalFileOpener.openerToken,
      onExternalFileOpen: async (request) => {
        const result = await this.openExternalFileWithConsent(
          request.path,
          request.makeFrontmost,
        );
        if (!result.success) {
          new Notice(
            t("打开外部文件失败：{message}", {
              message: result.message ?? t("未知错误"),
            }),
            8000,
          );
        }
        return result;
      },
      onMessage: (request, context) =>
        this.handleRequest(request, "ide", context),
      onMcpMessage: (request, context) =>
        this.handleRequest(request, "mcp", context),
      onClientContextChanged: () => {
        this.terminalTracker?.scan();
        this.scheduleBroadcast();
      },
      onLog: (message) => console.error("[mv-aide]", message),
    });
    this.port = await this.server.start();
    console.log(`[mv-aide] listening on 127.0.0.1:${this.port}`);
  }

  private async stopBridge(): Promise<void> {
    const port = this.port;
    this.externalFileOpenerSystem.removeRuntime(getVaultRoot(this.app));
    this.port = 0;
    this.bridgeAuthToken = null;
    await this.server?.stop();
    this.server = null;
    if (port && this.bridgeHasDiscoveryLock) removeLockFile(port, discoveryLockDirectory());
    if (port && this.bridgeHasClaudeMirror) removeLockFile(port, claudeCompatibilityLockDirectory());
    this.bridgeHasDiscoveryLock = false;
    this.bridgeHasClaudeMirror = false;
  }

  private async applyClaudeSettings(): Promise<void> {
    const filePath = localClaudeSettingsPath(getVaultRoot(this.app));
    if (this.settings.activityTracking.supportAllActivePages) {
      applyManagedTerminalHooks(filePath);
    } else {
      restoreManagedTerminalHooks(filePath);
    }
    if (
      this.settings.upstreamMode === "compatibility" &&
      this.settings.autoManageClaudeSettings &&
      this.resolvedUpstream().url &&
      this.port
    ) {
      this.settings = applyManagedBaseUrl(
        filePath,
        `http://127.0.0.1:${this.port}`,
        this.settings,
      );
    } else {
      this.settings = restoreManagedBaseUrl(filePath, this.settings);
    }
  }

  private async applyClaudeSettingsBestEffort(notify = false): Promise<void> {
    try {
      await this.applyClaudeSettings();
    } catch (error) {
      console.warn("[mv-aide] Claude settings sync failed", error);
      if (notify) {
        new Notice(t("Claude 设置同步失败，但插件已继续运行。详情见控制台。"));
      }
    }
  }

  private async handleRequest(
    request: JsonRpcRequest,
    channel: "ide" | "mcp",
    context?: BridgeClientContext,
  ): Promise<JsonRpcResponse | null> {
    const id = request.id ?? null;
    if (channel === "ide") {
      this.dshTerminalRpc?.observeInitialize(request, context);
      const terminalResponse = await this.dshTerminalRpc?.handle(request, context);
      if (terminalResponse) return terminalResponse;
    }

    switch (request.method) {
      case "initialize":
        if (context) this.previousBroadcasts.delete(context.clientId);
        this.scheduleBroadcast();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              (request.params?.protocolVersion as string | undefined) ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: {
              name: channel === "mcp" ? "mv-aide-tools" : "mv-aide",
              version: this.manifest.version,
            },
            reviewOutsideVault: this.settings.dsh.reviewOutsideVault,
            passiveDelivery: this.settings.dsh.passiveDelivery,
            terminalAwarenessEnhanced: this.settings.dsh.terminalAwarenessEnhanced,
            pushLocation: this.settings.dsh.pushLocation,
            pushSelection: this.settings.dsh.pushSelection,
            outsideToolPolicy: this.settings.dsh.outsideToolPolicy,
          },
        };
      case "tools/list":
        if (context) this.previousBroadcasts.delete(context.clientId);
        this.scheduleBroadcast();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools:
              channel === "mcp"
                ? mcpToolDefinitions(this.settings)
                : IDE_TOOL_DEFINITIONS,
          },
        };
      case "tools/call": {
        const name = String(request.params?.name ?? "");
        if (channel === "mcp" && !isMcpToolEnabled(name, this.settings)) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool disabled or not found: ${name}` },
          };
        }
        const args =
          request.params?.arguments &&
          typeof request.params.arguments === "object" &&
          !Array.isArray(request.params.arguments)
            ? (request.params.arguments as Record<string, unknown>)
            : {};
        const toolResult = await this.toolRegistry?.call(name, args, context);
        return toolResult
          ? { jsonrpc: "2.0", id, result: toolResult }
          : {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Tool not found: ${name}` },
            };
      }
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        };
    }
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer !== null) activeWindow.clearTimeout(this.broadcastTimer);
    this.broadcastTimer = activeWindow.setTimeout(() => {
      this.broadcastTimer = null;
      this.runBroadcast();
    }, 100);
  }

  /**
   * 串行执行广播：同一时刻最多一个广播在飞。若广播进行中又有新请求，
   * 只置"待重跑"标记，本次完成后再补跑一次。
   *
   * 若不串行：加载期间每次广播都要 await executeJavaScript（≤1.2s），而
   * 500ms interval 不断使 generation 递增，防旧写守卫会让每一轮广播都在
   * 落库前被顶掉——加载期间没有任何更新能写进去（表现为状态栏一直停在
   * 旧页面，直到加载完成 executeJavaScript 变快才首次落库）。
   */
  private runBroadcast(): void {
    if (this.broadcastInFlight) {
      this.broadcastQueued = true;
      return;
    }
    this.broadcastInFlight = true;
    void this.broadcastSelection()
      .catch((error) => {
        console.warn("[mv-aide] Context refresh failed", error);
      })
      .finally(() => {
        this.broadcastInFlight = false;
        if (!this.unloaded) this.publishUniversalContextChanges();
        if (this.broadcastQueued) {
          this.broadcastQueued = false;
          this.runBroadcast();
        }
      });
  }

  private clearScheduledMcpRegistration(): void {
    if (this.mcpRegistrationTimer === null) return;
    activeWindow.clearTimeout(this.mcpRegistrationTimer);
    this.mcpRegistrationTimer = null;
  }

  private clearScheduledCodexMcpRegistration(): void {
    if (this.codexMcpRegistrationTimer === null) return;
    activeWindow.clearTimeout(this.codexMcpRegistrationTimer);
    this.codexMcpRegistrationTimer = null;
  }

  private scheduleMcpRegistration(force = false): void {
    this.clearScheduledMcpRegistration();
    if (!this.port) return;

    const url = this.currentMcpUrl();
    if (
      !force &&
      this.settings.mcpEnabled &&
      this.settings.registeredMcpUrl === url
    ) {
      this.mcpStatus = t("MCP 已连接");
      return;
    }

    this.mcpStatus = this.settings.mcpEnabled
      ? t("MCP 后台检查中")
      : t("MCP 已关闭");
    this.mcpRegistrationTimer = activeWindow.setTimeout(() => {
      this.mcpRegistrationTimer = null;
      void this.runMcpRegistration(force);
    }, 0);
  }

  private async runMcpRegistration(force = false): Promise<void> {
    if (this.mcpRegistrationInFlight) {
      if (!force) {
        await this.mcpRegistrationInFlight;
        return;
      }
      await this.mcpRegistrationInFlight;
    }

    const task = this.performMcpRegistration(force);
    this.mcpRegistrationInFlight = task;
    try {
      await task;
    } finally {
      if (this.mcpRegistrationInFlight === task) {
        this.mcpRegistrationInFlight = null;
      }
    }
  }

  private async performMcpRegistration(force: boolean): Promise<void> {
    try {
      await this.syncMcpRegistration(force);
      if (!this.unloaded) await this.saveData(this.settings);
    } catch (error) {
      console.warn("[mv-aide] MCP registration failed", error);
      this.mcpStatus = t("注册失败：{message}", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!this.unloaded) await this.saveData(this.settings);
    }
  }

  private scheduleCodexMcpRegistration(): void {
    this.clearScheduledCodexMcpRegistration();
    this.codexMcpStatus =
      this.settings.ideIntegrations.codex && this.settings.mcpEnabled
        ? t("Codex MCP 后台检查中")
        : t("Codex MCP 未启用");
    this.codexMcpRegistrationTimer = activeWindow.setTimeout(() => {
      this.codexMcpRegistrationTimer = null;
      void this.runCodexMcpRegistration();
    }, 0);
  }

  private async runCodexMcpRegistration(): Promise<void> {
    if (this.codexMcpRegistrationInFlight) {
      await this.codexMcpRegistrationInFlight;
      return;
    }

    const task = this.syncCodexMcpRegistration();
    this.codexMcpRegistrationInFlight = task;
    try {
      await task;
    } finally {
      if (this.codexMcpRegistrationInFlight === task) {
        this.codexMcpRegistrationInFlight = null;
      }
    }
  }

  private async syncCodexMcpRegistration(): Promise<void> {
    if (!this.settings.ideIntegrations.codex || !this.settings.mcpEnabled) {
      const result = await removeCodexMcpRegistration();
      this.codexMcpStatus = result.ok
        ? t("Codex MCP 未启用")
        : t("Codex MCP 清理失败：{message}", { message: result.message });
      return;
    }

    const url = this.currentMcpUrl();
    if (!url) {
      this.codexMcpStatus = t("Codex MCP 等待本地服务");
      return;
    }

    const result = await ensureCodexMcpRegistration(
      url,
      this.settings.mcpAuthToken,
    );
    this.codexMcpStatus = result.ok
      ? result.message
      : t("Codex MCP 配置失败：{message}", { message: result.message });
  }

  private currentMcpUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  getUniversalMcpHttpConfig(): string | null {
    const descriptor = this.universalMcpDescriptor;
    if (!descriptor) return null;
    return JSON.stringify(
      {
        type: "streamable-http",
        url: descriptor.httpUrl,
        headers: {
          Authorization: `Bearer ${descriptor.auth.token}`,
        },
      },
      null,
      2,
    );
  }

  hasUniversalMcpRuntime(): boolean {
    return this.universalMcpDescriptor !== null;
  }

  async getUniversalMcpStdioConfig(): Promise<string | null> {
    if (!this.universalMcpDescriptor) return null;
    const launcherPath = await this.ensureUniversalMcpStdioLauncher();
    const nodeCommand = this.resolveUniversalMcpNodeCommand();
    const config: Record<string, unknown> = {
      type: "stdio",
      command: nodeCommand ?? process.execPath,
      args: [
        launcherPath,
        "--runtime",
        this.universalMcpRuntimeDescriptorPath(),
      ],
    };
    if (!nodeCommand) {
      config.env = { ELECTRON_RUN_AS_NODE: "1" };
    }
    return JSON.stringify(config, null, 2);
  }

  private universalMcpNodeCommand: string | null | undefined;

  private resolveUniversalMcpNodeCommand(): string | null {
    if (this.universalMcpNodeCommand === undefined) {
      this.universalMcpNodeCommand = detectSystemNodeCommand();
    }
    return this.universalMcpNodeCommand;
  }

  async rotateUniversalMcpToken(): Promise<void> {
    this.settings.universalMcp.authToken = randomUUID();
    await this.saveData(this.settings);
    await this.stopUniversalMcp();
    this.scheduleUniversalMcpStart();
  }

  private universalMcpRuntimeDescriptorPath(): string {
    // 运行时生成物不得写入插件安装目录（官方行为检查会将"写自身插件
    // 目录"判为自更新，且插件更新/同步会覆盖该目录），放系统临时目录。
    return path.join(
      os.tmpdir(),
      `mv-aide-universal-mcp-${stablePortSeed(getVaultRoot(this.app))}`,
      "runtime.json",
    );
  }

  private universalMcpStdioLauncherPath(): string {
    return path.join(
      path.dirname(this.universalMcpRuntimeDescriptorPath()),
      "stdio-launcher.cjs",
    );
  }

  /**
   * 发布只随包 3 个标准文件（main.js/manifest.json/styles.css），stdio 启动
   * 器以文本内嵌在 main.js 中，首次使用时物化到系统临时目录（规范三：不
   * 得写入插件安装目录）。内容一致则直接复用。
   */
  private async ensureUniversalMcpStdioLauncher(): Promise<string> {
    const launcherPath = this.universalMcpStdioLauncherPath();
    try {
      const existing = await fs.promises.readFile(launcherPath, "utf8");
      if (existing === stdioLauncherSource) return launcherPath;
    } catch {
      // 不存在或不可读则重写。
    }
    await fs.promises.mkdir(path.dirname(launcherPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${launcherPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, stdioLauncherSource, { mode: 0o755 });
    await fs.promises.rename(temporary, launcherPath);
    return launcherPath;
  }

  private async applyUniversalMcpSetting(): Promise<void> {
    if (!this.settings.universalMcp.enabled) {
      await this.stopUniversalMcp();
      return;
    }
    this.scheduleUniversalMcpStart();
  }

  private scheduleUniversalMcpStart(): void {
    this.cancelUniversalMcpIdleStart();
    if (!this.settings.universalMcp.enabled) {
      this.universalMcpStatus = t("mv-AIDE 协议未启用");
      return;
    }
    if (!this.universalMcpLayoutReady) {
      this.universalMcpStatus = t("等待 Obsidian 启动完成");
      return;
    }
    if (this.universalMcpServer?.isRunning) {
      this.universalMcpStatus = t("运行中：{url}", {
        url: this.universalMcpDescriptor?.httpUrl ?? t("本机"),
      });
      return;
    }

    const generation = ++this.universalMcpStartGeneration;
    this.universalMcpStatus = t("等待 Obsidian 空闲后启动");
    const run = () => {
      this.universalMcpIdleHandle = null;
      if (
        this.unloaded ||
        generation !== this.universalMcpStartGeneration ||
        !this.settings.universalMcp.enabled
      ) {
        return;
      }
      const inFlight = this.startUniversalMcp(generation);
      this.universalMcpStartInFlight = inFlight;
      void inFlight.finally(() => {
        if (this.universalMcpStartInFlight === inFlight) {
          this.universalMcpStartInFlight = null;
        }
      });
    };
    const idleWindow = activeWindow as typeof activeWindow & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      this.universalMcpIdleHandle = {
        kind: "idle",
        id: idleWindow.requestIdleCallback(run, { timeout: 2000 }),
      };
    } else {
      this.universalMcpIdleHandle = {
        kind: "timeout",
        id: activeWindow.setTimeout(run, 50),
      };
    }
  }

  private cancelUniversalMcpIdleStart(): void {
    const pending = this.universalMcpIdleHandle;
    this.universalMcpIdleHandle = null;
    this.universalMcpStartGeneration += 1;
    if (!pending) return;
    if (pending.kind === "idle") {
      const idleWindow = activeWindow as typeof activeWindow & {
        cancelIdleCallback?: (id: number) => void;
      };
      idleWindow.cancelIdleCallback?.(pending.id);
    } else {
      activeWindow.clearTimeout(pending.id);
    }
  }

  private async startUniversalMcp(generation: number): Promise<void> {
    try {
      if (!this.settings.universalMcp.authToken) {
        this.settings.universalMcp.authToken = randomUUID();
        await this.saveData(this.settings);
      }
      if (
        this.unloaded ||
        generation !== this.universalMcpStartGeneration ||
        !this.settings.universalMcp.enabled
      ) {
        return;
      }

      this.universalMcpStatus = t("正在启动 mv-AIDE 协议服务");
      await this.ensureUniversalMcpStdioLauncher();
      const vaultRoot = getVaultRoot(this.app);
      const preferredOffset = stablePortSeed(vaultRoot) % UNIVERSAL_MCP_PORT_SPAN;
      let lastPortError: unknown = null;

      for (let offset = 0; offset < UNIVERSAL_MCP_PORT_SPAN; offset += 1) {
        const port =
          UNIVERSAL_MCP_PORT_BASE +
          ((preferredOffset + offset) % UNIVERSAL_MCP_PORT_SPAN);
        const candidate = new UniversalMcpServer({
          authToken: this.settings.universalMcp.authToken,
          runtimeDescriptorPath: this.universalMcpRuntimeDescriptorPath(),
          port,
          serverName: "mv-aide-universal",
          serverVersion: this.manifest.version,
          capabilities: {
            getContextSnapshot: () => this.codexIdeContextSnapshot(),
            listIdeTools: () => IDE_TOOL_DEFINITIONS,
            callIdeTool: async (name, args, context) => {
              const definition = IDE_TOOL_DEFINITIONS.find(
                (tool) => tool.name === name,
              );
              if (!definition) {
                return {
                  content: [{ type: "text", text: `Tool not found: ${name}` }],
                  isError: true,
                };
              }
              const result = await this.toolRegistry?.call(name, args, {
                clientId: context.clientId,
                channel: "mcp",
              });
              return (
                result ?? {
                  content: [{ type: "text", text: `Tool not found: ${name}` }],
                  isError: true,
                }
              );
            },
          },
          onLog: (message) => console.log(`[mv-aide] ${message}`),
        });
        try {
          const descriptor = await this.startupPerformance.measure(
            "universal-mcp.runtime-publish",
            () => candidate.start(),
          );
          if (
            this.unloaded ||
            generation !== this.universalMcpStartGeneration ||
            !this.settings.universalMcp.enabled
          ) {
            await candidate.stop();
            return;
          }
          this.universalMcpServer = candidate;
          this.universalMcpDescriptor = descriptor;
          this.universalSelectionSignature = null;
          this.universalEditorsSignature = null;
          this.publishUniversalContextChanges();
          if (this.universalLatestMention !== null) {
            candidate.publishBridgeEvent(
              "at_mentioned",
              this.universalLatestMention,
            );
          }
          this.universalMcpStatus = t("运行中：{url}", { url: descriptor.httpUrl });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
          lastPortError = error;
        }
      }
      throw lastPortError ?? new Error(t("没有可用的本机 mv-AIDE 协议端口。"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.universalMcpStatus = t("启动失败：{message}", { message });
      console.error("[mv-aide] Universal MCP start failed", error);
    }
  }

  private async stopUniversalMcp(): Promise<void> {
    this.cancelUniversalMcpIdleStart();
    if (this.universalMcpStopInFlight) {
      await this.universalMcpStopInFlight;
      return;
    }
    const stop = async () => {
      const starting = this.universalMcpStartInFlight;
      if (starting) await starting.catch(() => undefined);
      const server = this.universalMcpServer;
      this.universalMcpServer = null;
      this.universalMcpDescriptor = null;
      this.universalSelectionSignature = null;
      this.universalEditorsSignature = null;
      if (server) await server.stop();
      this.universalMcpStatus = this.settings.universalMcp.enabled
        ? t("等待 Obsidian 空闲后启动")
        : t("mv-AIDE 协议未启用");
    };
    const inFlight = stop();
    this.universalMcpStopInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.universalMcpStopInFlight === inFlight) {
        this.universalMcpStopInFlight = null;
      }
    }
  }

  private publishUniversalContextChanges(): void {
    const server = this.universalMcpServer;
    if (!server?.isRunning) return;
    const current = this.lastContexts.get("global") ?? null;
    const selection = current ? selectionChangedParams(current) : null;
    const selectionSignature = JSON.stringify(selection);
    if (selectionSignature !== this.universalSelectionSignature) {
      this.universalSelectionSignature = selectionSignature;
      server.publishBridgeEvent("selection_changed", selection);
    }

    const openEditors = getOpenWorkspaceTabs(this.app).tabs;
    const editorsSignature = JSON.stringify(openEditors);
    if (editorsSignature !== this.universalEditorsSignature) {
      this.universalEditorsSignature = editorsSignature;
      server.publishBridgeEvent("workspace_changed", openEditors);
    }
  }

  /** LintFeature 每次跑完/清除诊断后回调：按规则做错误计数的被动推送。 */
  handleLintDiagnosticsChanged(_filePath: string): void {
    // 被动推送只传错误、不传警告；只有 lint 实际跑过（或清除）才会走到这里，
    // 未开启 lint 的类型天然不推。细节由 AI 用 getDiagnostics 工具主动拉。
    if (!this.settings.activityTracking.pushLintErrors) return;
    const server = this.universalMcpServer;
    if (!server?.isRunning) return;
    const summary = this.lintDiagnosticsSummary();
    const signature = JSON.stringify(summary);
    if (signature === this.lintPushSignature) return;
    this.lintPushSignature = signature;
    server.publishBridgeEvent("diagnostics_changed", summary);
  }

  private lintDiagnosticsSummary(): Array<{
    filePath: string;
    errorCount: number;
    updatedAt: number;
  }> {
    return (this.lintFeature?.diagnosticsSnapshot() ?? [])
      .map((entry) => ({
        filePath: entry.filePath,
        errorCount: entry.diagnostics.filter((d) => d.severity === "error")
          .length,
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  /** 给 markdown 快照（md/tex）附 heading 面包屑；其它类型不加字段。 */
  private async attachHeadingBreadcrumb(
    state: SelectionState | null,
  ): Promise<void> {
    if (!state) return;
    if (state.resourceType !== "markdown") {
      delete state.headingBreadcrumb;
      return;
    }
    if (!this.settings.activityTracking.includeHeadingBreadcrumb) {
      delete state.headingBreadcrumb;
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(state.relativePath);
    if (!(file instanceof TFile)) return;
    const extension = file.extension.toLowerCase();
    let breadcrumb: string | null = null;
    if (extension === "md") {
      const headings =
        this.app.metadataCache.getFileCache(file)?.headings ?? [];
      breadcrumb = breadcrumbAtLine(
        headings.map((h) => ({
          heading: h.heading,
          level: h.level,
          line: h.position.start.line,
        })),
        state.cursor.line,
      );
    } else if (extension === "tex") {
      const content = await this.app.vault.cachedRead(file);
      breadcrumb = breadcrumbAtLine(
        parseTexSections(content).map((s) => ({
          heading: s.heading,
          level: s.latexLevel,
          line: s.line,
        })),
        state.cursor.line,
      );
    }
    if (breadcrumb) state.headingBreadcrumb = breadcrumb;
    else delete state.headingBreadcrumb;
  }

  private codexRuntimeDir(): string {
    return path.join(
      getVaultRoot(this.app),
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
      "tmp",
    );
  }

  private schedulePostLayoutStartup(): void {
    this.postLayoutStartup?.cancel();
    this.postLayoutStartup = schedulePostLayoutStartup({
      onLayoutReady: (callback) => this.app.workspace.onLayoutReady(callback),
      setTimeout: (callback, delayMs) => activeWindow.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => activeWindow.clearTimeout(timerId),
      delayMs: 2000,
      isUnloaded: () => this.unloaded,
      run: () => this.runPostLayoutStartup(),
      onError: (error) => {
        console.error("[mv-aide] post-layout startup failed", error);
      },
    });
  }

  private async runPostLayoutStartup(): Promise<void> {
    if (this.unloaded) return;
    const endPostLayoutTiming = this.startupPerformance.begin("post-layout.total");
    try {
      this.universalMcpLayoutReady = true;
      this.startupPerformance.measureSync("post-layout.codex-cache-cleanup", () => {
        this.cleanupCodexRuntimeCacheBestEffort();
      });
      await this.startupPerformance.measure("post-layout.dsh-install-cleanup", () =>
        this.dshFeature?.cleanupInstallArtifactsBestEffort() ?? Promise.resolve(),
      );
      await this.startupPerformance.measure("post-layout.codex-provider", () =>
        this.syncCodexIdeProvider(),
      );
      if (this.unloaded) return;
      await this.startupPerformance.measure("post-layout.local-web-preview", () =>
        this.startLocalWebPreviewIfEnabled(),
      );
      if (this.unloaded) return;
      await this.startupPerformance.measure("post-layout.local-services", () =>
        this.syncLocalServices(false, false),
      );
      if (this.unloaded) return;
      this.startWindowsFileOpenerMigration();
      this.scheduleCodexMcpRegistrationIfReady();
      this.scheduleUniversalMcpStart();
    } finally {
      endPostLayoutTiming();
      const metrics = this.startupPerformance.snapshot().aggregates.map((entry) => ({
        name: entry.name,
        count: entry.count,
        totalMs: Number(entry.totalMs.toFixed(1)),
        maxMs: Number(entry.maxMs.toFixed(1)),
      }));
      console.debug("[mv-aide] startup performance", metrics);
    }
  }

  private async startLocalWebPreviewIfEnabled(): Promise<void> {
    if (this.unloaded || !this.settings.browserLocalFilePreview) return;
    if (!this.localWebPreview) {
      this.localWebPreview = new LocalWebPreviewFeature(this);
    }
    await this.localWebPreview.setEnabled(true);
  }

  getStartupPerformanceSnapshot(): StartupPerformanceSnapshot {
    return this.startupPerformance.snapshot();
  }

  private recordBundledModuleEvaluation(): void {
    if (this.startupModuleTimingRecorded) return;
    this.startupModuleTimingRecorded = true;
    const sharedGlobal = globalThis as typeof globalThis & {
      __mvAideModuleEvaluationTiming?: BundledModuleEvaluationTiming;
    };
    const timing = sharedGlobal.__mvAideModuleEvaluationTiming;
    delete sharedGlobal.__mvAideModuleEvaluationTiming;
    if (
      !timing ||
      !Number.isFinite(timing.startedAt) ||
      !Number.isFinite(timing.endedAt) ||
      (timing.endedAt as number) < timing.startedAt
    ) {
      return;
    }
    this.startupPerformance.recordSpan(
      "module.evaluate",
      timing.startedAt,
      timing.endedAt as number,
    );
  }

  private startWindowsFileOpenerMigration(): void {
    if (process.platform !== "win32" ||
        !this.settings.externalFileOpener.enabled) {
      return;
    }
    void this.externalFileOpenerSystem.migrateWindowsFileOpener(
      getVaultRoot(this.app),
      this.externalFileAllowedExtensions(),
    ).then((migration) => {
      if (this.unloaded) return;
      if (migration.migrated || migration.error) {
        this.defaultFileOpenerStatus = migration.error
          ? `${migration.message} ${migration.error}`
          : migration.message;
      }
      if (migration.error) {
        console.warn("[mv-aide] Windows file opener migration failed", migration.error);
        new Notice(this.defaultFileOpenerStatus, 8000);
      }
    }).catch((error) => {
      if (this.unloaded) return;
      const message = error instanceof Error ? error.message : String(error);
      this.defaultFileOpenerStatus = t("Windows 打开器自动迁移失败：{message}", { message });
      console.warn("[mv-aide] Windows file opener migration failed", error);
      new Notice(this.defaultFileOpenerStatus, 8000);
    });
  }

  private scheduleCodexMcpRegistrationIfReady(): void {
    if (this.settings.ideIntegrations.codex && this.codexIdeError) {
      this.codexMcpStatus = t("Codex MCP 等待启动后初始化");
      return;
    }
    this.scheduleCodexMcpRegistration();
  }

  private cleanupCodexRuntimeCacheBestEffort(): void {
    void fs.promises
      .rm(path.join(this.codexRuntimeDir(), "node-compile-cache"), {
        recursive: true,
        force: true,
      })
      .catch((error) => {
        console.warn("[mv-aide] Codex runtime cache cleanup failed", error);
      });
  }

  private async syncCodexIdeProvider(): Promise<void> {
    if (!this.codexIdeProvider) return;
    this.codexIdeError = null;
    if (!this.settings.ideIntegrations.codex) {
      await this.codexIdeProvider.stop();
      await removeCodexShellAlias();
      return;
    }
    try {
      await this.codexIdeProvider.start();
      if (process.platform !== "win32") {
        await ensureCodexShellAlias(
          this.codexRuntimeDir(),
          this.settings.codexExecutable || "codex",
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      this.codexIdeError =
        process.platform === "win32" && code === "EADDRINUSE"
          ? t("Codex IDE 通道已被其它 IDE 或仓库占用。")
          : error instanceof Error
            ? error.message
            : String(error);
      console.error("[mv-aide] Codex IDE provider failed", error);
      await removeCodexShellAlias();
    }
  }

  private async broadcastSelection(): Promise<void> {
    const generation = ++this.broadcastGeneration;
    const leaf = activeWorkspaceLeaf(this.app);
    const activeState =
      (await this.currentWorkspaceContextState(leaf)) ??
      this.currentSelectionState();
    if (generation !== this.broadcastGeneration) return;
    if (activeState) await this.attachHeadingBreadcrumb(activeState);
    this.terminalTracker?.scan();
    if (
      leaf?.view.getViewType() === "webviewer" &&
      activeState?.resourceType === "web"
    ) {
      this.latestWebLeaf = leaf;
    }

    const clients = this.server?.ideClients() ?? [];
    if (clients.length === 0) {
      const state = this.resolveTrackedState(undefined, leaf, activeState);
      if (state) this.rememberState("global", state);
      return;
    }

    for (const client of clients) {
      const state = this.resolveTrackedState(client, leaf, activeState);
      if (!state) continue;
      this.rememberState(this.contextKey(client), state);
      this.sendSelection(client, state);
    }
  }

  private sendSelection(
    client: BridgeClientContext,
    state: SelectionState,
  ): void {
    const signature = JSON.stringify({
      filePath: state.filePath,
      title: state.title,
      viewType: state.viewType,
      url: state.url,
      page: state.page,
      cursor: state.cursor,
      selection: state.selection,
      headingBreadcrumb: state.headingBreadcrumb,
    });
    if (signature === this.previousBroadcasts.get(client.clientId)) return;
    this.previousBroadcasts.set(client.clientId, signature);
    this.server?.sendToClient(client.clientId, {
      jsonrpc: "2.0",
      method: "selection_changed",
      params: selectionChangedParams(state),
    });
  }

  private contextKey(context?: BridgeClientContext): string {
    return context?.sessionId ?? context?.clientId ?? "global";
  }

  private rememberState(key: string, state: SelectionState): void {
    this.lastContexts.set(key, state);
    this.lastContexts.set("global", state);
    rememberLatestSelection(this.latestSelections, key, state);
  }

  private fallbackContext(context?: BridgeClientContext): SelectionState | null {
    const key = this.contextKey(context);
    return (
      this.lastContexts.get(key) ??
      (context ? null : this.lastContexts.get("global") ?? null)
    );
  }

  private latestSelectionFor(context?: BridgeClientContext): SelectionState | null {
    return latestSelectionForContext(this.latestSelections, context);
  }

  /** 当前已连接的 IDE 桥接客户端数（dsh / Claude Code 等），供 mv-agent 状态栏使用。 */
  ideBridgeClientCount(): number {
    return this.server?.ideClients().length ?? 0;
  }

  /** 全局最新选区快照（含空选区；无任何追踪时返回 null），供 mv-agent 状态栏使用。 */
  latestSelectionSnapshot(): SelectionState | null {
    return this.latestSelectionFor();
  }

  private async codexIdeContextSnapshot(): Promise<CodexIdeContextSnapshot> {
    const leaf = activeWorkspaceLeaf(this.app);
    const activeState =
      (await this.currentWorkspaceContextState(leaf)) ??
      this.currentSelectionState();
    if (activeState) await this.attachHeadingBreadcrumb(activeState);
    const current = this.resolveTrackedState(undefined, leaf, activeState);
    if (current) this.rememberState("global", current);
    return {
      vaultRoot: getVaultRoot(this.app),
      current,
      openEditors: getOpenWorkspaceTabs(this.app).tabs,
    };
  }

  private resolveTrackedState(
    context: BridgeClientContext | undefined,
    leaf: WorkspaceLeaf | null,
    activeState: SelectionState | null,
  ): SelectionState | null {
    const tracking = this.settings.activityTracking;
    if (!tracking.supportAllActivePages) {
      return activeState && isSelectedPageType(activeState, tracking)
        ? activeState
        : this.fallbackContext(context);
    }

    if (this.terminalTracker?.isTerminalLeaf(leaf)) {
      const ownLeaf = this.terminalTracker.leafForSession(context?.sessionId);
      if (!ownLeaf || ownLeaf === leaf) return this.fallbackContext(context);
    }
    return activeState ?? this.fallbackContext(context);
  }

  private async closeDiffs(): Promise<void> {
    await this.toolRegistry?.call("closeAllDiffTabs", {});
    this.app.workspace.detachLeavesOfType(DIFF_VIEW_TYPE);
  }

  private async syncMcpRegistration(force = false): Promise<void> {
    if (!this.settings.ideIntegrations.claudeCode) {
      this.mcpStatus = t("Claude Code IDE 已关闭");
      return;
    }
    if (!this.port) return;
    if (!this.settings.mcpEnabled) {
      if (force || this.settings.registeredMcpUrl) {
        await this.cleanMcpRegistration();
      } else {
        this.mcpStatus = t("已关闭");
      }
      return;
    }
    const url = this.currentMcpUrl();
    if (!url) return;
    if (!force && this.settings.registeredMcpUrl === url) {
      this.mcpStatus = t("MCP 已连接");
      return;
    }
    const result = await ensureMcpRegistration(
      this.settings.claudeExecutable,
      url,
      this.settings.mcpAuthToken,
      getVaultRoot(this.app),
    );
    this.mcpStatus = result.ok
      ? result.message
      : t("注册失败：{message}", { message: result.message });
    if (result.ok) {
      this.settings.registeredMcpUrl = url;
      if (!this.settings.claudeExecutable && result.executable) {
        this.settings.claudeExecutable = result.executable;
      }
    }
  }
}
