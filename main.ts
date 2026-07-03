import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Notice,
  Plugin,
  type WorkspaceLeaf,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { isSelectedPageType } from "./src/activity-tracking";
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
  WINDOWS_MCP_REGISTRATION_VERSION,
} from "./src/constants";
import {
  latestSelectionForContext,
  rememberLatestSelection,
} from "./src/context-cache";
import { ObsidianDiffView } from "./src/diff-view";
import {
  cleanStaleObsidianLocks,
  removeLockFile,
  writeLockFile,
} from "./src/lock-file";
import { migrateLlm } from "./src/llm-migrate";
import { migrateInlineCompletion } from "./src/inline-completion/inline-completion-migrate";
import {
  atMentionedParams,
  currentSelection,
  getVaultRoot,
  selectionChangedParams,
} from "./src/selection";
import { MvSenceAiIdeSettingTab } from "./src/settings-tab";
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
import {
  activeWorkspaceLeaf,
  currentWorkspaceContext,
  getOpenWorkspaceTabs,
} from "./src/workspace-context";
import { SelectionHighlightController } from "./src/selection-highlights";
import { TerminalSessionTracker } from "./src/terminal-session-tracker";
import { LlmFeature } from "./src/llm-feature";
import { InlineCompletionFeature } from "./src/inline-completion/inline-completion-feature";
import {
  CodexIdeProvider,
  type CodexIdeContextSnapshot,
} from "./src/codex-ide-provider";
import {
  ensureCodexMcpRegistration,
  removeCodexMcpRegistration,
  ensureCodexShellAlias,
  removeCodexShellAlias,
} from "./src/codex-mcp-registration";
import { syncAgentRulesInWorkspace } from "./src/agent-rules-manager";
import type {
  BridgeClientContext,
  BridgeSettings,
  JsonRpcRequest,
  JsonRpcResponse,
  ResolvedUpstream,
  SelectionState,
} from "./src/types";

export default class MvSenceAiIdePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  port = 0;
  mcpStatus = "尚未检查";
  codexMcpStatus = "Codex MCP 未启用";
  claudeIdeError: string | null = null;
  codexIdeError: string | null = null;
  private server: BridgeServer | null = null;
  private bridgeAuthToken: string | null = null;
  private bridgeHasClaudeLock = false;
  private readonly latestSelections = new Map<string, SelectionState>();
  private latestWebLeaf: WorkspaceLeaf | null = null;
  private readonly lastContexts = new Map<string, SelectionState>();
  private readonly previousBroadcasts = new Map<string, string>();
  private broadcastTimer: number | null = null;
  private broadcastGeneration = 0;
  private toolRegistry: ToolRegistry | null = null;
  private terminalTracker: TerminalSessionTracker | null = null;
  private selectionHighlighter: SelectionHighlightController | null = null;
  private llmFeature: LlmFeature | null = null;
  private inlineCompletion: InlineCompletionFeature | null = null;
  private codexIdeProvider: CodexIdeProvider | null = null;
  private mcpRegistrationTimer: number | null = null;
  private mcpRegistrationInFlight: Promise<void> | null = null;
  private codexMcpRegistrationTimer: number | null = null;
  private codexMcpRegistrationInFlight: Promise<void> | null = null;
  private postLayoutStartup: PostLayoutStartupHandle | null = null;
  private unloaded = false;

  async onload(): Promise<void> {
    this.unloaded = false;
    const rawLoaded = (await this.loadData()) as
      | (Partial<BridgeSettings> & { codex?: unknown })
      | null;
    const { codex: _legacyCodex, ...loaded } = rawLoaded ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
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
        ...DEFAULT_SETTINGS.ideIntegrations,
        ...(loaded.ideIntegrations ?? {}),
      },
      llm: migrateLlm(loaded.llm),
      inlineCompletion: migrateInlineCompletion(loaded.inlineCompletion),
    };
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
    this.addSettingTab(new MvSenceAiIdeSettingTab(this.app, this));
    this.terminalTracker = new TerminalSessionTracker(this.app);
    this.selectionHighlighter = new SelectionHighlightController(
      this.app,
      this.settings.preserveSelectionHighlights,
    );
    this.inlineCompletion = new InlineCompletionFeature(this);
    this.toolRegistry = new ToolRegistry(
      this.app,
      (context) => this.latestSelectionFor(context),
      () => this.latestWebLeaf,
      () => this.settings.toolContextLimits.readCurrentWebPage,
    );

    const socketPath = path.join(
      this.codexRuntimeDir(),
      "codex-ipc",
      `ipc-${typeof process.getuid === "function" ? process.getuid() : 0}.sock`,
    );

    this.codexIdeProvider = new CodexIdeProvider({
      getSnapshot: () => this.codexIdeContextSnapshot(),
      socketPath,
      onLog: (message) => console.error("[mv-senceai-ide]", message),
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.terminalTracker?.scan();
        this.selectionHighlighter?.sync(true);
        this.scheduleBroadcast();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.terminalTracker?.scan();
        this.selectionHighlighter?.sync();
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
        if (
          this.settings.activityTracking.supportAllActivePages ||
          this.app.workspace.activeLeaf?.view.getViewType() === "webviewer"
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
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) this.scheduleBroadcast();
      }),
    );
    this.addCommand({
      id: "send-selection-to-claude-code",
      name: "Send current selection to Claude Code",
      editorCallback: () => {
        const state = currentSelection(this.app);
        if (state) {
          this.server?.broadcast({
            jsonrpc: "2.0",
            method: "at_mentioned",
            params: atMentionedParams(state),
          });
        }
      },
    });

    this.llmFeature = new LlmFeature(this);
    this.llmFeature.registerCommands();
    this.llmFeature.registerMenus();

    await this.syncLocalServices(false, false);
    this.schedulePostLayoutStartup();
    this.terminalTracker.scan();
    this.selectionHighlighter.sync(true);
    this.scheduleBroadcast();
  }

  onunload(): void {
    if (this.broadcastTimer !== null) {
      activeWindow.clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.unloaded = true;
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
    void removeCodexShellAlias();
    void this.finishUnload();
  }

  async saveAndApplySettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.syncLocalServices(true, false);
    await this.syncCodexIdeProvider();
    this.scheduleCodexMcpRegistrationIfReady();
    void this.syncAgentRulesBestEffort();
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
    try {
      await this.codexIdeProvider?.stop();
      await this.restoreClaudeSettings();
      await this.closeDiffs();
      await this.stopBridge();
    } catch (error) {
      console.error("[mv-senceai-ide] unload cleanup failed", error);
    }
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
    this.mcpStatus = result.ok ? result.message : `清理失败：${result.message}`;
    if (result.ok) this.settings.registeredMcpUrl = null;
    await this.saveData(this.settings);
  }

  private shouldRunLocalServer(): boolean {
    return (
      this.settings.ideIntegrations.claudeCode ||
      (this.settings.ideIntegrations.codex && this.settings.mcpEnabled)
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
        console.error("[mv-senceai-ide] Claude IDE bridge start failed", error);
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
          ? "Codex MCP 等待启动后初始化"
          : "Codex MCP 未启用";
    }
  }

  private async syncClaudeIntegration(notify = false): Promise<void> {
    if (!this.settings.ideIntegrations.claudeCode || !this.server || !this.port) {
      this.clearScheduledMcpRegistration();
      if (this.bridgeHasClaudeLock && this.port) removeLockFile(this.port);
      this.bridgeHasClaudeLock = false;
      if (!this.settings.ideIntegrations.claudeCode) {
        this.mcpStatus = "Claude Code IDE 已关闭";
        await this.restoreClaudeSettings();
      }
      return;
    }

    cleanStaleObsidianLocks();
    if (!this.bridgeHasClaudeLock) {
      writeLockFile(
        this.port,
        getVaultRoot(this.app),
        this.bridgeAuthToken ?? randomUUID(),
      );
      this.bridgeHasClaudeLock = true;
    }
    await this.applyClaudeSettingsBestEffort(notify);
    if (!this.unloaded) await this.saveData(this.settings);
    this.scheduleMcpRegistration();
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
      onMessage: (request, context) =>
        this.handleRequest(request, "ide", context),
      onMcpMessage: (request, context) =>
        this.handleRequest(request, "mcp", context),
      onClientContextChanged: () => {
        this.terminalTracker?.scan();
        this.scheduleBroadcast();
      },
      onLog: (message) => console.error("[mv-senceai-ide]", message),
    });
    this.port = await this.server.start();
    console.log(`[mv-senceai-ide] listening on 127.0.0.1:${this.port}`);
  }

  private async stopBridge(): Promise<void> {
    const port = this.port;
    this.port = 0;
    this.bridgeAuthToken = null;
    await this.server?.stop();
    this.server = null;
    if (port && this.bridgeHasClaudeLock) removeLockFile(port);
    this.bridgeHasClaudeLock = false;
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
      console.warn("[mv-senceai-ide] Claude settings sync failed", error);
      if (notify) {
        new Notice("Claude 设置同步失败，但插件已继续运行。详情见控制台。");
      }
    }
  }

  private async handleRequest(
    request: JsonRpcRequest,
    channel: "ide" | "mcp",
    context?: BridgeClientContext,
  ): Promise<JsonRpcResponse | null> {
    const id = request.id ?? null;
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
              name: channel === "mcp" ? "mv-senceai-ide-tools" : "mv-senceai-ide",
              version: this.manifest.version,
            },
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
      void this.broadcastSelection();
    }, 100);
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
      this.mcpStatus = "MCP 已连接";
      return;
    }

    this.mcpStatus = this.settings.mcpEnabled
      ? "MCP 后台检查中"
      : "MCP 已关闭";
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
      console.warn("[mv-senceai-ide] MCP registration failed", error);
      this.mcpStatus = `注册失败：${
        error instanceof Error ? error.message : String(error)
      }`;
      if (!this.unloaded) await this.saveData(this.settings);
    }
  }

  private scheduleCodexMcpRegistration(): void {
    this.clearScheduledCodexMcpRegistration();
    this.codexMcpStatus =
      this.settings.ideIntegrations.codex && this.settings.mcpEnabled
        ? "Codex MCP 后台检查中"
        : "Codex MCP 未启用";
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
        ? "Codex MCP 未启用"
        : `Codex MCP 清理失败：${result.message}`;
      return;
    }

    const url = this.currentMcpUrl();
    if (!url) {
      this.codexMcpStatus = "Codex MCP 等待本地服务";
      return;
    }

    const result = await ensureCodexMcpRegistration(
      url,
      this.settings.mcpAuthToken,
    );
    this.codexMcpStatus = result.ok
      ? result.message
      : `Codex MCP 配置失败：${result.message}`;
  }

  private currentMcpUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}/mcp` : null;
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
        console.error("[mv-senceai-ide] post-layout startup failed", error);
      },
    });
  }

  private async runPostLayoutStartup(): Promise<void> {
    if (this.unloaded) return;
    this.cleanupCodexRuntimeCacheBestEffort();
    await this.syncCodexIdeProvider();
    if (this.unloaded) return;
    this.scheduleCodexMcpRegistrationIfReady();
    await this.syncAgentRulesBestEffort();
  }

  private scheduleCodexMcpRegistrationIfReady(): void {
    if (this.settings.ideIntegrations.codex && this.codexIdeError) {
      this.codexMcpStatus = "Codex MCP 等待启动后初始化";
      return;
    }
    this.scheduleCodexMcpRegistration();
  }

  private async syncAgentRulesBestEffort(): Promise<void> {
    try {
      await syncAgentRulesInWorkspace(
        getVaultRoot(this.app),
        this.settings.ideIntegrations.syncClaudeRules,
        this.settings.ideIntegrations.syncCodexRules,
      );
    } catch (error) {
      console.warn("[mv-senceai-ide] agent rules sync failed", error);
    }
  }

  private cleanupCodexRuntimeCacheBestEffort(): void {
    try {
      fs.rmSync(path.join(this.codexRuntimeDir(), "node-compile-cache"), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      console.warn("[mv-senceai-ide] Codex runtime cache cleanup failed", error);
    }
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
      await ensureCodexShellAlias(
        this.codexRuntimeDir(),
        this.settings.codexExecutable || "codex",
      );
    } catch (error) {
      this.codexIdeError = error instanceof Error ? error.message : String(error);
      console.error("[mv-senceai-ide] Codex IDE provider failed", error);
      await removeCodexShellAlias();
    }
  }

  private async broadcastSelection(): Promise<void> {
    const generation = ++this.broadcastGeneration;
    const leaf = activeWorkspaceLeaf(this.app);
    const activeState =
      (await currentWorkspaceContext(this.app, leaf)) ??
      currentSelection(this.app);
    if (generation !== this.broadcastGeneration) return;
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

  private async codexIdeContextSnapshot(): Promise<CodexIdeContextSnapshot> {
    const leaf = activeWorkspaceLeaf(this.app);
    const activeState =
      (await currentWorkspaceContext(this.app, leaf)) ??
      currentSelection(this.app);
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
      this.mcpStatus = "Claude Code IDE 已关闭";
      return;
    }
    if (!this.port) return;
    if (!this.settings.mcpEnabled) {
      if (force || this.settings.registeredMcpUrl) {
        await this.cleanMcpRegistration();
      } else {
        this.mcpStatus = "已关闭";
      }
      return;
    }
    const url = this.currentMcpUrl();
    if (!url) return;
    if (!force && this.settings.registeredMcpUrl === url) {
      this.mcpStatus = "MCP 已连接";
      return;
    }
    const result = await ensureMcpRegistration(
      this.settings.claudeExecutable,
      url,
      this.settings.mcpAuthToken,
      getVaultRoot(this.app),
    );
    this.mcpStatus = result.ok ? result.message : `注册失败：${result.message}`;
    if (result.ok) {
      this.settings.registeredMcpUrl = url;
      if (!this.settings.claudeExecutable && result.executable) {
        this.settings.claudeExecutable = result.executable;
      }
    }
  }
}
