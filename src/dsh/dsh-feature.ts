import { Notice, requestUrl } from "obsidian";
import { t } from "../i18n";
import type MvAideIdePlugin from "../../main";
import { getVaultRoot } from "../selection";
import {
  injectDshPlugin,
  inspectDshInjection,
  type InjectResult,
} from "./dsh-inject";
import {
  classifyProbe,
  DshStartCancelledError,
  DshProcessManager,
  isDshStartCancelled,
  type DshWebProbe,
} from "./dsh-process";
import {
  combinedToolStatus,
  describeDshInstallFailure,
  inspectDshRuntime,
  inspectNodeRuntimes,
  installDshPackages,
  preferredNodeLocation,
  preferredToolLocation,
  selectedNodeStatus,
  toolIsInstalled,
  toolIsReady,
  UNKNOWN_DSH_ENVIRONMENT,
  type DshEnvironmentStatus,
  type DshInstallLayer,
  type DshNodeLocations,
  type DshPackageName,
  type DshRuntimeInspection,
} from "./dsh-environment";
import {
  DSH_NODE_RUNTIME_VERSION,
  installOrUpgradeNodeRuntime,
  isDshNodeRuntimeTarget,
} from "./dsh-node-runtime";
import {
  cleanupLegacyDshInstallArtifacts,
  cleanupStaleDshInstallWorkspaces,
  type DshCleanupFailure,
} from "./dsh-install-workspace";
import type { DshInstallTarget } from "./dsh-settings";
import {
  renderDshAgentEntry,
  renderDshSection,
  type Rerender,
} from "./dsh-settings-ui";
import {
  DSH_WEB_VIEW_TYPE,
  DshWebView,
  openDshWebviewInNewLeaf,
  stopOpenMvAgentViews,
} from "./dsh-webview";
import { isDshConnectedToBridge } from "./dsh-bridge-status";

const COMMAND_ID = "open-mv-agent-for-obsidian";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export type DshInstallTargetChooser = (
  layer: Exclude<DshInstallLayer, "plugin">,
) => Promise<DshInstallTarget | null>;

function environmentFrom(
  node: DshNodeLocations,
  runtime: DshRuntimeInspection,
  plugin: DshEnvironmentStatus["plugin"],
): DshEnvironmentStatus {
  return {
    node,
    dsh: runtime.dsh,
    pnpm: runtime.pnpm,
    plugin,
    checkedAt: Date.now(),
  };
}

function markInstallFailure(
  runtime: DshRuntimeInspection,
  target: "vault" | "global",
  packages: readonly DshPackageName[],
  detail: string,
): DshRuntimeInspection {
  const next = structuredClone(runtime);
  for (const name of packages) next[name][target] = { state: "error", detail };
  return next;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Probe through Obsidian's `requestUrl` (Electron's Node network stack):
 * immune to the CORS/mixed-content blocking that stops plain `fetch` from the
 * plugin runtime.
 */
async function probeDshWebViaRequestUrl(
  url: string,
  timeoutMs: number,
): Promise<DshWebProbe> {
  try {
    const response = await withTimeout(
      requestUrl({ url, method: "GET", throw: false }),
      timeoutMs,
    );
    const cls = classifyProbe(
      typeof response.text === "string" ? response.text : null,
    );
    return { reachable: cls !== "unreachable", isDsh: cls === "dsh" };
  } catch {
    return { reachable: false, isDsh: false };
  }
}

/**
 * Self-contained `mv-agent` (DSH-driven) feature, wired by `main.ts` only.
 * Owns the always-on Ctrl+P command, the managed `dsh web` child process,
 * one-click install, and the dual-face profile injection — none of which touch
 * existing core logic.
 */
export class DshFeature {
  private readonly processManager: DshProcessManager;
  private commandRegistered = false;
  private environment: DshEnvironmentStatus = structuredClone(UNKNOWN_DSH_ENVIRONMENT);
  private environmentBusy = false;
  private mvAgentOperationGeneration = 0;
  private dshBridgeConnected = false;
  private dshBridgeProbeBusy = false;
  private dshBridgeProbeGeneration = 0;
  /**
   * Collapsible-subsection open state inside the mv-agent settings section.
   * All subsections default collapsed (开发规范七); user toggles are kept
   * in-session only.
   */
  private readonly openSubsectionIds = new Set<string>();

  constructor(private readonly plugin: MvAideIdePlugin) {
    this.processManager = new DshProcessManager(
      () => getVaultRoot(this.plugin.app),
      () => this.plugin.settings.dsh.port,
      probeDshWebViaRequestUrl,
      async () => {
        const vaultRoot = getVaultRoot(this.plugin.app);
        const nodes = await inspectNodeRuntimes(vaultRoot);
        const node = selectedNodeStatus(nodes);
        if (node.state !== "ready") {
          throw new Error(node.detail || t("未检测到兼容的 Node.js。"));
        }
        const runtime = await inspectDshRuntime(vaultRoot, nodes);
        if (!runtime.command) throw new Error(t("DSH 尚未安装，请先点击“安装”。"));
        return runtime.command;
      },
    );
    // The palette command is always available, independent of the enable
    // toggle (the toggle only controls the IDE bridge / lock file).
    this.registerCommand();
    // The custom mv-agent view (bare webview + status bar). registerView is
    // auto-disposed with the plugin, so no manual cleanup is needed.
    this.plugin.registerView(
      DSH_WEB_VIEW_TYPE,
      (leaf) => new DshWebView(leaf, this.plugin),
    );
  }

  /** Whether the mv-AIDE IDE bridge must run for this feature (lock file + tools). */
  requiresBridge(): boolean {
    return this.plugin.settings.dsh.enabled;
  }

  private registerCommand(): void {
    if (this.commandRegistered) return;
    this.plugin.addCommand({
      id: COMMAND_ID,
      name: t("打开 mv-agent"),
      callback: () => void this.openDshWithNotice(),
    });
    this.plugin.addCommand({
      id: "close-mv-agent",
      name: t("停止 mv-agent"),
      callback: () => void this.stopMvAgentWithNotice(),
    });
    this.plugin.addCommand({
      id: "restart-mv-agent",
      name: t("重启 mv-agent"),
      callback: () => void this.restartDshWithNotice(),
    });
    this.commandRegistered = true;
  }

  /** Re-register the commands so a language switch refreshes their names. */
  refreshCommand(): void {
    if (this.commandRegistered) {
      this.plugin.removeCommand(COMMAND_ID);
      this.plugin.removeCommand("close-mv-agent");
      this.plugin.removeCommand("restart-mv-agent");
    }
    this.commandRegistered = false;
    this.registerCommand();
  }

  dispose(): void {
    this.mvAgentOperationGeneration += 1;
    this.dshBridgeProbeGeneration += 1;
    this.dshBridgeConnected = false;
    if (this.commandRegistered) {
      this.plugin.removeCommand(COMMAND_ID);
      this.plugin.removeCommand("close-mv-agent");
      this.plugin.removeCommand("restart-mv-agent");
      this.commandRegistered = false;
    }
    this.processManager.dispose();
  }

  environmentStatus(): DshEnvironmentStatus {
    return this.environment;
  }

  isEnvironmentBusy(): boolean {
    return this.environmentBusy;
  }

  private async updatePersistedInjectionState(ready: boolean): Promise<void> {
    if (this.plugin.settings.dsh.injected === ready) return;
    this.plugin.settings.dsh.injected = ready;
    await this.plugin.saveData(this.plugin.settings);
  }

  private async cleanupInstallArtifactsStrict(vaultRoot: string): Promise<void> {
    const [legacy, stale] = await Promise.all([
      cleanupLegacyDshInstallArtifacts(vaultRoot),
      cleanupStaleDshInstallWorkspaces(),
    ]);
    const failures: DshCleanupFailure[] = [...legacy.failures, ...stale.failures];
    if (failures.length === 0) return;
    throw new Error(t("DSH 安装临时文件清理失败：{detail}", {
      detail: failures.map((failure) => `${failure.path}: ${failure.error}`).join("; "),
    }));
  }

  /** Post-layout migration for cache directories left by older releases. */
  async cleanupInstallArtifactsBestEffort(): Promise<void> {
    if (this.environmentBusy) return;
    const vaultRoot = getVaultRoot(this.plugin.app);
    try {
      await this.cleanupInstallArtifactsStrict(vaultRoot);
    } catch (error) {
      console.warn("[mv-aide] DSH installer cleanup failed", error);
    }
  }

  async checkEnvironment(): Promise<ActionResult> {
    if (this.environmentBusy) {
      return { ok: false, message: "DSH 环境操作正在进行，请等待完成。" };
    }
    this.environmentBusy = true;
    try {
      const vaultRoot = getVaultRoot(this.plugin.app);
      await this.cleanupInstallArtifactsStrict(vaultRoot);
      const nodes = await inspectNodeRuntimes(vaultRoot);
      const node = selectedNodeStatus(nodes);
      const runtime = await inspectDshRuntime(vaultRoot, nodes);
      let plugin: DshEnvironmentStatus["plugin"];
      if (!toolIsReady(runtime.dsh) || !toolIsReady(runtime.pnpm)) {
        plugin = { state: "blocked", detail: t("等待 DSH 与 pnpm。") };
      } else {
        const injection = await inspectDshInjection(vaultRoot);
        plugin = { state: injection.state, detail: injection.detail };
      }
      this.environment = environmentFrom(nodes, runtime, plugin);
      await this.updatePersistedInjectionState(plugin.state === "ready");
      const ok = node.state === "ready"
        && toolIsReady(runtime.dsh)
        && toolIsReady(runtime.pnpm);
      return {
        ok,
        message: ok
          ? t("检测完成：Node.js、DSH 与 pnpm 均可用。")
          : node.state !== "ready"
            ? node.detail || t("未检测到 Node.js。")
            : !toolIsReady(runtime.dsh)
              ? combinedToolStatus(runtime.dsh).detail || t("未检测到 DSH。")
              : combinedToolStatus(runtime.pnpm).detail || t("未检测到 pnpm。"),
      };
    } finally {
      this.environmentBusy = false;
    }
  }

  private async inspectActualEnvironment(vaultRoot: string): Promise<{
    nodes: DshNodeLocations;
    runtime: DshRuntimeInspection;
  }> {
    const nodes = await inspectNodeRuntimes(vaultRoot);
    const runtime = await inspectDshRuntime(vaultRoot, nodes);
    const injection = toolIsReady(runtime.dsh) && toolIsReady(runtime.pnpm)
      ? await inspectDshInjection(vaultRoot)
      : { state: "blocked" as const, detail: t("等待 DSH 与 pnpm。") };
    this.environment = environmentFrom(nodes, runtime, injection);
    await this.updatePersistedInjectionState(injection.state === "ready");
    return { nodes, runtime };
  }

  private async ensureNodeForTarget(
    vaultRoot: string,
    target: DshInstallTarget,
    requireTargetVersion = false,
  ): Promise<DshNodeLocations> {
    let nodes = await inspectNodeRuntimes(vaultRoot);
    const status = nodes[target];
    if (
      status.state === "ready"
      && status.executable
      && status.npmExecutable
      && (!requireTargetVersion || isDshNodeRuntimeTarget(status.version))
    ) return nodes;
    const installed = await installOrUpgradeNodeRuntime(
      vaultRoot,
      target,
      status.installed ? status.origin ?? "unknown" : null,
    );
    if (installed.code !== 0) {
      throw new Error(installed.stderr || installed.stdout || t("Node.js 安装或升级失败。"));
    }
    nodes = await inspectNodeRuntimes(vaultRoot);
    const verified = nodes[target];
    if (verified.state !== "ready") {
      throw new Error(verified.detail || t("Node.js 安装后校验失败。"));
    }
    if (requireTargetVersion && !isDshNodeRuntimeTarget(verified.version)) {
      throw new Error(t("Node.js 升级后仍是 {version}，未达到目标版本 {target}。", {
        version: verified.version ?? t("未知版本"),
        target: DSH_NODE_RUNTIME_VERSION,
      }));
    }
    await this.inspectActualEnvironment(vaultRoot);
    return nodes;
  }

  private async ensureAnyNode(
    vaultRoot: string,
    preferredTarget: DshInstallTarget | null,
    chooseTarget: DshInstallTargetChooser,
  ): Promise<DshNodeLocations> {
    let nodes = await inspectNodeRuntimes(vaultRoot);
    const selected = selectedNodeStatus(nodes);
    if (selected.state === "ready" && selected.executable && selected.npmExecutable) return nodes;
    const existing = preferredNodeLocation(nodes);
    const target = existing ?? preferredTarget ?? await chooseTarget("node");
    if (!target) throw new Error(t("已取消 Node.js 安装。"));
    nodes = await this.ensureNodeForTarget(vaultRoot, target);
    return nodes;
  }

  private async ensurePackage(
    vaultRoot: string,
    name: DshPackageName,
    requestedTarget: DshInstallTarget | null,
    chooseTarget: DshInstallTargetChooser,
    force: boolean,
  ): Promise<void> {
    let { nodes, runtime } = await this.inspectActualEnvironment(vaultRoot);
    const locations = runtime[name];
    if (!force && toolIsReady(locations)) return;
    const existingTarget = preferredToolLocation(locations);
    const target = existingTarget ?? requestedTarget ?? await chooseTarget(name);
    if (!target) throw new Error(t("已取消{layer}安装。", { layer: name === "dsh" ? "DSH" : "pnpm" }));

    if (target === "global") {
      nodes = await this.ensureNodeForTarget(vaultRoot, "global");
    } else {
      nodes = await this.ensureAnyNode(vaultRoot, "vault", chooseTarget);
    }
    const node = target === "global" ? nodes.global : selectedNodeStatus(nodes);
    const installed = await installDshPackages(vaultRoot, target, node, [name]);
    if (installed.code !== 0) {
      const detail = describeDshInstallFailure(target, installed);
      runtime = markInstallFailure(runtime, target, [name], detail);
      this.environment = environmentFrom(
        nodes,
        runtime,
        { state: "blocked", detail: t("等待 DSH 与 pnpm。") },
      );
      throw new Error(t("{layer} 安装或升级失败：{detail}", {
        layer: name === "dsh" ? "DSH" : "pnpm",
        detail,
      }));
    }
    const inspected = await this.inspectActualEnvironment(vaultRoot);
    if (inspected.runtime[name][target].state !== "ready") {
      throw new Error(t("{layer} 安装后校验失败。", { layer: name === "dsh" ? "DSH" : "pnpm" }));
    }
  }

  async ensureLayer(
    layer: DshInstallLayer,
    requestedTarget: DshInstallTarget | null,
    chooseTarget: DshInstallTargetChooser,
  ): Promise<ActionResult> {
    if (this.environmentBusy) {
      return { ok: false, message: "DSH 环境操作正在进行，请等待完成。" };
    }
    this.environmentBusy = true;
    try {
      const vaultRoot = getVaultRoot(this.plugin.app);
      await this.cleanupInstallArtifactsStrict(vaultRoot);
      if (layer === "node") {
        const initial = await inspectNodeRuntimes(vaultRoot);
        const existing = preferredNodeLocation(initial);
        const target = existing ?? requestedTarget ?? await chooseTarget("node");
        if (!target) return { ok: false, message: t("已取消 Node.js 安装。") };
        await this.ensureNodeForTarget(vaultRoot, target, true);
        return { ok: true, message: t("Node.js 已在原位置安装或升级并通过校验。") };
      }

      if (layer === "dsh") {
        await this.ensurePackage(vaultRoot, "dsh", requestedTarget, chooseTarget, true);
        return { ok: true, message: t("DSH 已安装或升级并通过校验。") };
      }

      if (layer === "pnpm") {
        await this.ensurePackage(vaultRoot, "pnpm", requestedTarget, chooseTarget, true);
        return { ok: true, message: t("pnpm 已安装或升级并通过校验。") };
      }

      await this.ensureAnyNode(vaultRoot, null, chooseTarget);
      await this.ensurePackage(vaultRoot, "dsh", null, chooseTarget, false);
      await this.ensurePackage(vaultRoot, "pnpm", null, chooseTarget, false);
      const { nodes, runtime } = await this.inspectActualEnvironment(vaultRoot);
      if (!runtime.command) throw new Error(t("DSH 命令解析失败。"));
      let result = await injectDshPlugin(vaultRoot, runtime.command);
      const actual = await inspectDshInjection(vaultRoot);
      this.environment = environmentFrom(
        nodes,
        runtime,
        { state: actual.state, detail: actual.detail },
      );
      await this.updatePersistedInjectionState(result.ok && actual.state === "ready");
      if (result.ok) {
        const connectedUrls = this.collectActiveDshUrls();
        const hadRunningDsh = connectedUrls.length > 0 || this.processManager.currentUrl() !== null;
        if (hadRunningDsh) {
          const restartedUrl = await this.processManager.restartForObsidian(connectedUrls);
          this.navigateOpenViewsTo(restartedUrl);
          result = {
            ...result,
            message: `${result.message}\n已重启运行中的 DSH，以加载 mv-agent 浏览器端模块。`,
          };
        }
      }
      return result;
    } catch (error) {
      const vaultRoot = getVaultRoot(this.plugin.app);
      await this.inspectActualEnvironment(vaultRoot).catch(() => undefined);
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.environmentBusy = false;
    }
  }

  async injectDshPlugin(): Promise<InjectResult> {
    return this.ensureLayer("plugin", null, async () => null);
  }

  async openDshForObsidian(): Promise<void> {
    const generation = ++this.mvAgentOperationGeneration;
    await this.openDshForOperation(generation);
  }

  private async openDshForOperation(generation: number): Promise<void> {
    const connectedUrls = this.collectActiveDshUrls();
    const url = await this.processManager.ensureStartedForOpen(connectedUrls);
    if (generation !== this.mvAgentOperationGeneration) return;
    const leaf = await openDshWebviewInNewLeaf(
      this.plugin.app.workspace,
      this.plugin.settings.dsh.autoOpenRegion,
      url,
    );
    if (generation !== this.mvAgentOperationGeneration) leaf.detach();
  }

  /** dsh 实例实际运行的端口（未运行返回 null），供状态栏展示。 */
  currentDshPort(): number | null {
    return this.processManager.currentPort();
  }

  /** dsh 实例当前 URL（未运行返回 null），供状态栏展示。 */
  currentDshUrl(): string | null {
    return this.processManager.currentUrl();
  }

  /** Cached truth for the status dot; refreshed asynchronously by the view. */
  isDshBridgeConnected(): boolean {
    return this.dshBridgeConnected;
  }

  /**
   * Refresh the status dot from OS process/TCP facts only. This deliberately
   * does not inspect IDE Bridge clients or change the bridge protocol.
   */
  async refreshDshBridgeConnection(): Promise<boolean> {
    const bridgePort = Number((this.plugin as unknown as { port?: number }).port ?? 0);
    const dshPort = this.processManager.currentPort();
    const dshUrl = this.processManager.currentUrl();
    if (!bridgePort || !dshPort || !dshUrl) {
      this.dshBridgeProbeGeneration += 1;
      this.dshBridgeConnected = false;
      return false;
    }
    if (this.dshBridgeProbeBusy) return this.dshBridgeConnected;

    const generation = ++this.dshBridgeProbeGeneration;
    this.dshBridgeProbeBusy = true;
    try {
      const connected = await isDshConnectedToBridge(
        { dshPort, bridgePort, dshUrl },
        { probe: probeDshWebViaRequestUrl },
      );
      if (generation === this.dshBridgeProbeGeneration) {
        this.dshBridgeConnected = connected;
      }
      return this.dshBridgeConnected;
    } catch {
      if (generation === this.dshBridgeProbeGeneration) {
        this.dshBridgeConnected = false;
      }
      return false;
    } finally {
      this.dshBridgeProbeBusy = false;
    }
  }

  /** Confirm that one exact URL serves DSH and synchronize shared state. */
  async confirmDshViewUrl(url: string): Promise<string | null> {
    return this.processManager.confirmDshUrl(url);
  }

  /**
   * 解析 mv-agent 视图应显示的 URL：优先在电脑上找已打开的 dsh 实例
   * （配置端口 + 候选端口探测），找不到则启动一个。
   */
  async resolveDshViewUrl(): Promise<string> {
    const generation = this.mvAgentOperationGeneration;
    const found = await this.processManager.findDshUrl();
    if (generation !== this.mvAgentOperationGeneration) {
      throw new DshStartCancelledError();
    }
    if (found) return found;
    const url = await this.processManager.ensureStarted();
    if (generation !== this.mvAgentOperationGeneration) {
      throw new DshStartCancelledError();
    }
    return url;
  }

  /** URLs of all currently open mv-agent views, active view first. */
  private collectActiveDshUrls(): string[] {
    const leaves = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    const sorted = [...leaves].sort((left, right) => {
      if (left === activeLeaf) return -1;
      if (right === activeLeaf) return 1;
      return 0;
    });
    const urls: string[] = [];
    for (const leaf of sorted) {
      const view = leaf.view as DshWebView | null;
      const url = view?.currentViewUrl?.();
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  /** Point every open mv-agent view at the same restarted endpoint. */
  private navigateOpenViewsTo(url: string): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
    for (const leaf of leaves) {
      try {
        (leaf.view as DshWebView | null)?.navigateTo?.(url);
      } catch {
        /* per-view containment */
      }
    }
  }

  /**
   * Reboot each currently open DSH iframe against its own endpoint after a host
   * plugin changed the browser client-module graph. DSH rc.7 client-hmr does
   * not dynamically materialize graph additions/removals, so a full document
   * boot is required for mv-agent enable/disable to converge on the browser.
   */
  reloadOpenViewsForPluginGraphChange(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
    for (const leaf of leaves) {
      try {
        const view = leaf.view as DshWebView | null;
        const url = view?.currentViewUrl?.();
        if (url) view?.navigateTo?.(url);
      } catch {
        /* per-view containment */
      }
    }
  }

  private async openDshWithNotice(): Promise<void> {
    const generation = ++this.mvAgentOperationGeneration;
    try {
      await this.openDshForOperation(generation);
      if (generation !== this.mvAgentOperationGeneration) return;
      new Notice(t("已打开 mv-agent。"), 8000);
    } catch (error) {
      if (
        generation !== this.mvAgentOperationGeneration ||
        isDshStartCancelled(error)
      ) {
        return;
      }
      new Notice(
        t("打开失败：{message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }

  private async stopMvAgentWithNotice(): Promise<void> {
    const generation = ++this.mvAgentOperationGeneration;
    try {
      const connectedUrls = this.collectActiveDshUrls();
      const summary = await this.processManager.stopAllTargetDshInstances(connectedUrls);
      if (generation !== this.mvAgentOperationGeneration) return;
      const stoppedViewCount = stopOpenMvAgentViews(this.plugin.app.workspace);
      const viewMessage = stoppedViewCount > 0
        ? t("已停止 {count} 个 mv-agent 界面。", { count: stoppedViewCount })
        : t("没有打开的 mv-agent 界面。");
      const backendMessage = summary.notRunning
        ? t("没有发现需要停止的 DSH 后台。")
        : t("已停止 {count} 个 DSH 后台。", { count: summary.stoppedPids.length });
      new Notice(`mv-agent：${viewMessage}\n${backendMessage}`, 8000);
    } catch (error) {
      if (generation !== this.mvAgentOperationGeneration) return;
      new Notice(
        t("停止失败：{message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }

  private async restartDshWithNotice(): Promise<void> {
    const generation = ++this.mvAgentOperationGeneration;
    try {
      const connectedUrls = this.collectActiveDshUrls();
      const url = await this.processManager.restartForObsidian(connectedUrls);
      if (generation !== this.mvAgentOperationGeneration) return;
      const currentLeaves = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
      if (currentLeaves.length > 0) {
        this.navigateOpenViewsTo(url);
      } else {
        const leaf = await openDshWebviewInNewLeaf(
          this.plugin.app.workspace,
          this.plugin.settings.dsh.autoOpenRegion,
          url,
        );
        if (generation !== this.mvAgentOperationGeneration) leaf.detach();
      }
      new Notice(t("mv-agent 已重启。"), 8000);
    } catch (error) {
      if (generation !== this.mvAgentOperationGeneration) return;
      new Notice(
        t("重启失败：{message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }

  renderAgentEntry(containerEl: HTMLElement, rerender: Rerender): void {
    renderDshAgentEntry(this.plugin, containerEl, rerender);
  }

  renderSection(containerEl: HTMLElement, rerender: Rerender): void {
    renderDshSection(this.plugin, containerEl, rerender, this.openSubsectionIds);
  }

  openSubsection(id: string): void {
    this.openSubsectionIds.add(id);
  }
}
