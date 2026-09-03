import { Notice, requestUrl } from "obsidian";
import { t } from "../../i18n";
import { prependExecutableDirectory, resolveUserCommandEnvironment } from "../../process-environment";
import { runProcess } from "../../process-runner";
import { findSystemExecutable } from "../../universal-mcp-stdio-command";
import type MvAideIdePlugin from "../../../main";
import { getVaultRoot } from "../../selection";
import {
  ensureDshAgentInjection,
  ensureDshFullInjection,
  injectionStateIsUsable,
  inspectDshInjection,
  type InjectResult,
} from "./ide/injection";
import {
  createRequestUrlDshProbe,
  DshStartCancelledError,
  DshProcessManager,
  isDshStartCancelled,
  normalizeDshWebUrl,
  sameDshWebUrl,
  type DshWebProbe,
} from "./runtime/process";
import {
  combinedToolStatus,
  describeDshInstallFailure,
  inspectDshRuntime,
  inspectNodeRuntimes,
  installDshPackages,
  preferredNodeLocation,
  preferredRepairTarget,
  preferredToolLocation,
  selectedNodeStatus,
  toolIsReady,
  UNKNOWN_DSH_ENVIRONMENT,
  type DshEnvironmentStatus,
  type DshEnvironmentUpdates,
  type DshInstallLayer,
  type DshNodeLocations,
  type DshPackageInstallSpec,
  type DshPackageName,
  type DshRuntimeInspection,
  type RuntimeUpdateStatus,
} from "./runtime/environment";
import { installOrUpgradeNodeRuntime } from "./runtime/node-runtime";
import {
  normalizeRuntimeVersion,
  resolveDshTargetVersion,
  resolveNodeTargetVersion,
  resolvePnpmTargetVersion,
  runtimeUpdateRelation,
} from "./runtime/package-update";
import {
  cleanupLegacyDshInstallArtifacts,
  cleanupStaleDshInstallWorkspaces,
  type DshCleanupFailure,
} from "./runtime/install-workspace";
import type { DshInstallTarget } from "./settings";
import { DshPluginAutoUpdater } from "./plugin-auto-updater";
import {
  renderDshAgentEntry,
  renderDshSection,
  type Rerender,
} from "./ui/settings-ui";
import {
  DSH_WEB_VIEW_TYPE,
  DshWebView,
  openDshWebviewInNewLeaf,
  stopOpenMvAgentViews,
} from "./runtime/webview";
import { isDshConnectedToBridge } from "./ide/bridge-status";
import {
  inspectDshSourceUpdate,
  rebuildOrUpgradeDshSource,
} from "./runtime/source-runtime";
import { effectiveDshHomeDirectory } from "./paths";

const COMMAND_ID = "open-mv-agent-for-obsidian";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export type DshIdePluginRuntimeState =
  | { state: "disabled" }
  | { state: "checking" }
  | { state: "blocked"; detail: string }
  | { state: "injecting" }
  | { state: "ready" }
  | { state: "error"; detail: string };

export interface DshIdeReconcileResult extends ActionResult {
  changed: boolean;
}

export type DshInstallTargetChooser = (
  layer: Exclude<DshInstallLayer, "plugin">,
) => Promise<DshInstallTarget | null>;

function environmentFrom(
  node: DshNodeLocations,
  runtime: DshRuntimeInspection,
  plugins: DshEnvironmentStatus["plugins"],
  updates: DshEnvironmentUpdates = UNKNOWN_DSH_ENVIRONMENT.updates,
): DshEnvironmentStatus {
  return {
    node,
    dsh: runtime.dsh,
    pnpm: runtime.pnpm,
    plugins,
    updates: structuredClone(updates),
    checkedAt: Date.now(),
  };
}

function updateStatusFor(
  currentVersion: string | undefined,
  targetVersion: string,
): RuntimeUpdateStatus {
  if (!currentVersion) return { checked: true, targetVersion, updateAvailable: true, relation: "older" };
  try {
    const relation = runtimeUpdateRelation(currentVersion, targetVersion);
    return {
      checked: true,
      targetVersion,
      relation,
      updateAvailable: relation === "older",
    };
  } catch (error) {
    return {
      checked: true,
      targetVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function updateError(error: unknown): RuntimeUpdateStatus {
  return {
    checked: true,
    error: error instanceof Error ? error.message : String(error),
  };
}

function toolVersionAtPreferredLocation(
  runtime: DshRuntimeInspection,
  name: DshPackageName,
): { target: DshInstallTarget | "custom"; version?: string } | null {
  if (runtime[name].custom?.state === "ready") {
    return { target: "custom", version: runtime[name].custom.version };
  }
  const target = preferredToolLocation(runtime[name]);
  return target ? { target, version: runtime[name][target].version } : null;
}

function blockedPluginStatuses(detail: string): DshEnvironmentStatus["plugins"] {
  return {
    agent: { state: "blocked", detail },
    manager: { state: "blocked", detail },
    subworkspace: { state: "blocked", detail },
    full: { state: "blocked", detail },
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
const probeDshWebViaRequestUrl = createRequestUrlDshProbe(requestUrl);

/**
 * Self-contained `mv-agent` (DSH-driven) feature, wired by `main.ts` only.
 * Owns the always-on Ctrl+P command, the managed `dsh web` child process,
 * one-click install, and the dual-face profile injection — none of which touch
 * existing core logic.
 */
export class DshFeature {
  private readonly processManager: DshProcessManager;
  private readonly pluginAutoUpdater: DshPluginAutoUpdater;
  private commandRegistered = false;
  private environment: DshEnvironmentStatus = structuredClone(UNKNOWN_DSH_ENVIRONMENT);
  private environmentBusy = false;
  private runtimeSelectionRestartRequired = false;
  private idePluginRuntimeState: DshIdePluginRuntimeState = { state: "disabled" };
  private mvAgentOperationGeneration = 0;
  /**
   * Collapsible-subsection open state inside the mv-agent settings section.
   * All subsections default collapsed (开发规范七); user toggles are kept
   * in-session only.
   */
  private readonly openSubsectionIds = new Set<string>();

  private markRuntimeSelectionChanged(): void {
    if (
      this.processManager.currentUrl()
      || this.processManager.isRunning()
      || this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE).length > 0
    ) {
      this.runtimeSelectionRestartRequired = true;
    }
  }

  constructor(private readonly plugin: MvAideIdePlugin) {
    if (this.plugin.settings.dsh.enabled) {
      this.idePluginRuntimeState = { state: "checking" };
    }
    this.processManager = new DshProcessManager(
      () => getVaultRoot(this.plugin.app),
      () => this.plugin.settings.dsh.port,
      probeDshWebViaRequestUrl,
      async () => {
        const vaultRoot = getVaultRoot(this.plugin.app);
        const commandEnv = await resolveUserCommandEnvironment();
        const nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
        const node = selectedNodeStatus(nodes);
        if (node.state !== "ready") {
          throw new Error(node.detail || t("未检测到兼容的 Node.js。"));
        }
        const runtime = await inspectDshRuntime(vaultRoot, nodes, runProcess, commandEnv, {
          customDirectory: this.plugin.settings.dsh.customDirectory,
          homeDirectory: effectiveDshHomeDirectory(
            vaultRoot,
            this.plugin.settings.dsh.useVaultDshHome,
            commandEnv,
          ),
          requireRuntimeOwner: this.plugin.settings.dsh.useVaultDshHome,
          preferredPort: this.plugin.settings.dsh.port,
          sourceProbe: probeDshWebViaRequestUrl,
        });
        if (!runtime.command) {
          throw new Error(
            combinedToolStatus(runtime.dsh).detail || t("DSH 尚未安装，请先点击“安装”。"),
          );
        }
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
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => {
        this.syncOpenViewWindowContexts();
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-open", (_workspaceWindow, hostWindow) => {
        this.syncOpenViewWindowContexts();
        hostWindow.queueMicrotask(() => this.syncOpenViewWindowContexts());
      }),
    );
    // Modular auto-updater for the injected DSH plugins. It only consumes
    // the startup reconcile's cached status plus the two capability methods
    // below, so existing reconcile/manual flows stay byte-identical.
    this.pluginAutoUpdater = new DshPluginAutoUpdater({
      isAutoUpdateEnabled: () => this.plugin.settings.dsh.autoUpdatePlugins === true,
      isAutoRestartEnabled: () => this.plugin.settings.dsh.autoRestartAfterPluginUpdate === true,
      fullStatus: () => this.environment.plugins.full,
      runFullInjection: () => this.runFullInjectionForAutoUpdate(),
      restartRunningMvAgent: () => this.restartRunningMvAgentForAutoUpdate(),
      notify: (message) => new Notice(message, 8000),
    });
  }

  /** Whether the mv-AIDE IDE bridge must run for this feature (lock file + tools). */
  requiresBridge(): boolean {
    return this.plugin.settings.dsh.enabled && this.idePluginRuntimeState.state === "ready";
  }

  ideIntegrationState(): DshIdePluginRuntimeState {
    return this.idePluginRuntimeState;
  }

  private syncOpenViewWindowContexts(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
    for (const leaf of leaves) {
      try {
        (leaf.view as DshWebView | null)?.syncWindowContext?.();
      } catch {
        /* Per-view containment: one closing window must not block the rest. */
      }
    }
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

  private async annotateRunningBundleStatus(
    plugins: DshEnvironmentStatus["plugins"],
  ): Promise<DshEnvironmentStatus["plugins"]> {
    const next = structuredClone(plugins);
    let dshUrl = this.processManager.currentUrl();
    if (!dshUrl) dshUrl = await this.processManager.findDshUrl().catch(() => null);
    if (!dshUrl) return next;

    const describe = (value: unknown): { mvAideVersion: string | null; fingerprint: string | null } | null => {
      if (!value || typeof value !== "object") return null;
      const row = value as Record<string, unknown>;
      return {
        mvAideVersion: typeof row.mvAideVersion === "string" ? row.mvAideVersion : null,
        fingerprint: typeof row.fingerprint === "string" ? row.fingerprint : null,
      };
    };
    const fetchRuntime = async (pathname: string): Promise<Record<string, unknown>> => {
      try {
        const endpoint = new URL(pathname, dshUrl).toString();
        const response = await withTimeout(
          requestUrl({ url: endpoint, method: "GET", throw: false }),
          2_000,
        );
        return response.status === 200 && response.json && typeof response.json === "object"
          ? response.json as Record<string, unknown>
          : {};
      } catch {
        return {};
      }
    };
    const [mvRuntime, subworkspaceRuntime] = await Promise.all([
      fetchRuntime("/api/mv-agent/runtime"),
      fetchRuntime("/api/mv-dsh-subworkspace/runtime"),
    ]);
    // Accept the short-lived flat descriptor shape while every current bundle
    // publishes the stable { agent, manager } structure.
    const runtime = {
      agent: describe(mvRuntime.agent) ?? describe(mvRuntime),
      manager: describe(mvRuntime.manager),
      subworkspace: describe(subworkspaceRuntime.runtime),
    };
    for (const kind of ["agent", "manager", "subworkspace"] as const) {
      const disk = next[kind];
      const running = runtime[kind];
      if (disk.state === "missing") continue;
      if (!running) {
        if (disk.relation === "current") {
          disk.restartRequired = true;
          disk.detail = `${disk.detail ?? ""} 当前 DSH 未加载该磁盘 bundle；运行版本待重启。`.trim();
        }
        continue;
      }
      if (running.mvAideVersion) disk.runtimeVersion = running.mvAideVersion;
      const sameVersion = (running.mvAideVersion ?? null) === (disk.version ?? null);
      const sameFingerprint = (running.fingerprint ?? null) === (disk.fingerprint ?? null);
      disk.restartRequired = !(sameVersion && sameFingerprint);
      disk.detail = disk.restartRequired
        ? `${disk.detail ?? ""} 磁盘版本 ${disk.version ?? "未知"}，当前 DSH 已加载 ${running.mvAideVersion ?? "未知"}；运行版本待重启。`.trim()
        : `${disk.detail ?? ""} 当前 DSH 已加载同一 bundle。`.trim();
    }
    next.full.restartRequired = next.agent.restartRequired === true
      || next.manager.restartRequired === true
      || next.subworkspace.restartRequired === true;
    if (next.full.restartRequired) {
      next.full.detail = `${next.full.detail ?? ""} 磁盘包与当前 DSH 运行包不同，运行版本待重启。`.trim();
    }
    return next;
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
      const commandEnv = await resolveUserCommandEnvironment();
      const nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
      const node = selectedNodeStatus(nodes);
      const runtime = await inspectDshRuntime(vaultRoot, nodes, runProcess, commandEnv, {
        customDirectory: this.plugin.settings.dsh.customDirectory,
        homeDirectory: effectiveDshHomeDirectory(
          vaultRoot,
          this.plugin.settings.dsh.useVaultDshHome,
          commandEnv,
        ),
        requireRuntimeOwner: this.plugin.settings.dsh.useVaultDshHome,
        preferredPort: this.plugin.settings.dsh.port,
        sourceProbe: probeDshWebViaRequestUrl,
      });
      const plugins = !toolIsReady(runtime.dsh) || !toolIsReady(runtime.pnpm)
        ? blockedPluginStatuses(t("等待 DSH 与 pnpm。"))
        : await inspectDshInjection(vaultRoot, this.plugin.manifest.version, runtime.command ?? undefined);

      const npmExecutable = node.npmExecutable;
      const npmEnvironment = prependExecutableDirectory(commandEnv, node.executable);
      const npmMissing = (): Promise<string> => Promise.reject(new Error(t("未检测到可用于更新检查的 npm。")));
      const dshUpdate = runtime.sourceRuntime
        ? inspectDshSourceUpdate(runtime.sourceRuntime).then((source) => ({
            checked: true,
            targetVersion: source.targetVersion,
            updateAvailable: source.updateAvailable,
            relation: source.updateAvailable ? "older" as const : "current" as const,
          }))
        : npmExecutable
          ? resolveDshTargetVersion(npmExecutable, runProcess, npmEnvironment)
              .then((target) => updateStatusFor(toolVersionAtPreferredLocation(runtime, "dsh")?.version, target))
          : npmMissing().then((): RuntimeUpdateStatus => ({ checked: false }));
      const [nodeTarget, dshTarget, pnpmTarget] = await Promise.allSettled([
        resolveNodeTargetVersion(),
        dshUpdate,
        npmExecutable ? resolvePnpmTargetVersion(npmExecutable, runProcess, npmEnvironment) : npmMissing(),
      ]);
      const pnpmCurrent = toolVersionAtPreferredLocation(runtime, "pnpm")?.version;
      const updates: DshEnvironmentUpdates = {
        node: nodeTarget.status === "fulfilled"
          ? updateStatusFor(node.version, nodeTarget.value)
          : updateError(nodeTarget.reason),
        dsh: dshTarget.status === "fulfilled" ? dshTarget.value : updateError(dshTarget.reason),
        pnpm: pnpmTarget.status === "fulfilled"
          ? updateStatusFor(pnpmCurrent, pnpmTarget.value)
          : updateError(pnpmTarget.reason),
      };

      const pluginsWithRuntime = await this.annotateRunningBundleStatus(plugins);
      this.environment = environmentFrom(nodes, runtime, pluginsWithRuntime, updates);
      await this.updatePersistedInjectionState(injectionStateIsUsable(plugins.full));
      const ok = node.state === "ready"
        && toolIsReady(runtime.dsh)
        && toolIsReady(runtime.pnpm);
      const updateFailed = Object.values(updates).some((status) => Boolean(status.error));
      return {
        ok,
        message: ok
          ? updateFailed
            ? t("检测完成：运行环境可用，但部分最新版本检查失败。")
            : t("检测完成：Node.js、DSH 与 pnpm 均可用，并已检查最新版本。")
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
    commandEnv: NodeJS.ProcessEnv;
  }> {
    const commandEnv = await resolveUserCommandEnvironment();
    const nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
    const runtime = await inspectDshRuntime(vaultRoot, nodes, runProcess, commandEnv, {
      customDirectory: this.plugin.settings.dsh.customDirectory,
      homeDirectory: effectiveDshHomeDirectory(
        vaultRoot,
        this.plugin.settings.dsh.useVaultDshHome,
        commandEnv,
      ),
      requireRuntimeOwner: this.plugin.settings.dsh.useVaultDshHome,
      preferredPort: this.plugin.settings.dsh.port,
      sourceProbe: probeDshWebViaRequestUrl,
    });
    const plugins = toolIsReady(runtime.dsh) && toolIsReady(runtime.pnpm)
      ? await inspectDshInjection(vaultRoot, this.plugin.manifest.version, runtime.command ?? undefined)
      : blockedPluginStatuses(t("等待 DSH 与 pnpm。"));
    const pluginsWithRuntime = await this.annotateRunningBundleStatus(plugins);
    this.environment = environmentFrom(nodes, runtime, pluginsWithRuntime, this.environment.updates);
    await this.updatePersistedInjectionState(injectionStateIsUsable(plugins.full));
    return { nodes, runtime, commandEnv };
  }

  private async ensureNodeForTarget(
    vaultRoot: string,
    target: DshInstallTarget,
    targetVersion: string,
    force = false,
  ): Promise<DshNodeLocations> {
    let commandEnv = await resolveUserCommandEnvironment();
    let nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
    const status = nodes[target];
    if (
      !force
      && status.state === "ready"
      && status.executable
      && status.npmExecutable
    ) return nodes;
    const installed = await installOrUpgradeNodeRuntime(
      vaultRoot,
      target,
      targetVersion,
      status.installed ? status.origin ?? "unknown" : null,
      { environment: commandEnv },
    );
    if (installed.code !== 0) {
      throw new Error(installed.stderr || installed.stdout || t("Node.js 安装或升级失败。"));
    }
    commandEnv = await resolveUserCommandEnvironment();
    nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
    const verified = nodes[target];
    if (verified.state !== "ready") {
      throw new Error(verified.detail || t("Node.js 安装后校验失败。"));
    }
    if (
      !verified.version
      || normalizeRuntimeVersion(verified.version) !== normalizeRuntimeVersion(targetVersion)
    ) {
      throw new Error(t("Node.js 操作后版本校验失败：目标 {target}，实际 {actual}。", {
        target: targetVersion,
        actual: verified.version ?? t("未知版本"),
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
    const commandEnv = await resolveUserCommandEnvironment();
    let nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
    const selected = selectedNodeStatus(nodes);
    if (selected.state === "ready" && selected.executable && selected.npmExecutable) return nodes;
    const existing = preferredNodeLocation(nodes);
    const target = existing ?? preferredTarget ?? await chooseTarget("node");
    if (!target) throw new Error(t("已取消 Node.js 安装。"));
    const targetVersion = await resolveNodeTargetVersion();
    nodes = await this.ensureNodeForTarget(vaultRoot, target, targetVersion);
    return nodes;
  }

  private async resolvePackageTargetVersion(
    name: DshPackageName,
    node: ReturnType<typeof selectedNodeStatus>,
    commandEnv: NodeJS.ProcessEnv,
  ): Promise<string> {
    const npmExecutable = node.npmExecutable;
    if (!npmExecutable) throw new Error(t("未检测到可用于更新检查的 npm。"));
    const npmEnvironment = prependExecutableDirectory(commandEnv, node.executable);
    return name === "dsh"
      ? resolveDshTargetVersion(npmExecutable, runProcess, npmEnvironment)
      : resolvePnpmTargetVersion(npmExecutable, runProcess, npmEnvironment);
  }

  private async ensurePackage(
    vaultRoot: string,
    name: DshPackageName,
    requestedTarget: DshInstallTarget | null,
    chooseTarget: DshInstallTargetChooser,
    force: boolean,
  ): Promise<{
    action: "install" | "upgrade" | "reinstall";
    beforeVersion?: string;
    targetVersion: string;
    afterVersion: string;
  } | null> {
    let { nodes, runtime, commandEnv } = await this.inspectActualEnvironment(vaultRoot);
    const locations = runtime[name];
    if (!force && toolIsReady(locations)) return null;
    const existingTarget = preferredToolLocation(locations) ?? preferredRepairTarget(locations);
    const target = existingTarget ?? requestedTarget ?? await chooseTarget(name);
    if (!target) throw new Error(t("已取消{layer}安装。", { layer: name === "dsh" ? "DSH" : "pnpm" }));

    if (target === "global") {
      const globalNode = nodes.global;
      if (globalNode.state !== "ready" || !globalNode.npmExecutable) {
        const nodeTargetVersion = await resolveNodeTargetVersion();
        nodes = await this.ensureNodeForTarget(vaultRoot, "global", nodeTargetVersion);
      }
    } else {
      nodes = await this.ensureAnyNode(vaultRoot, "vault", chooseTarget);
    }
    commandEnv = await resolveUserCommandEnvironment();
    nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
    const node = target === "global" ? nodes.global : selectedNodeStatus(nodes);
    const channelTargetVersion = await this.resolvePackageTargetVersion(name, node, commandEnv);
    const beforeVersion = runtime[name][target].version;
    const relation = beforeVersion
      ? runtimeUpdateRelation(beforeVersion, channelTargetVersion)
      : "older";
    const targetVersion = relation === "newer" && beforeVersion
      ? beforeVersion
      : channelTargetVersion;
    const action = !beforeVersion
      ? "install" as const
      : relation === "older"
        ? "upgrade" as const
        : "reinstall" as const;
    const spec: DshPackageInstallSpec = { name, version: targetVersion };
    const lifecycle = process.platform === "win32" && name === "dsh"
      ? {
          beforeMutation: async (): Promise<void> => {
            const drained = await this.processManager.stopAllDshForWindowsPackageMutation();
            if (drained.remainingPids.length > 0) {
              throw new Error(t("仍有 DSH 进程无法停止；为避免安装目录被占用，本次操作未执行。PID：{pids}", {
                pids: drained.remainingPids.join(", "),
              }));
            }
          },
        }
      : undefined;
    const installed = await installDshPackages(
      vaultRoot,
      target,
      node,
      [spec],
      runProcess,
      commandEnv,
      lifecycle,
    );
    if (installed.code !== 0) {
      const detail = describeDshInstallFailure(target, installed);
      runtime = markInstallFailure(runtime, target, [name], detail);
      this.environment = environmentFrom(
        nodes,
        runtime,
        blockedPluginStatuses(t("等待 DSH 与 pnpm。")),
        this.environment.updates,
      );
      throw new Error(t("{layer} 安装或升级失败：{detail}", {
        layer: name === "dsh" ? "DSH" : "pnpm",
        detail,
      }));
    }
    const inspected = await this.inspectActualEnvironment(vaultRoot);
    const after = inspected.runtime[name][target];
    if (after.state !== "ready" || !after.version) {
      throw new Error(t("{layer} 安装后校验失败。", { layer: name === "dsh" ? "DSH" : "pnpm" }));
    }
    if (normalizeRuntimeVersion(after.version) !== normalizeRuntimeVersion(targetVersion)) {
      throw new Error(t("{layer} 操作后版本校验失败：目标 {target}，实际 {actual}。", {
        layer: name === "dsh" ? "DSH" : "pnpm",
        target: targetVersion,
        actual: after.version,
      }));
    }
    this.environment.updates[name] = updateStatusFor(after.version, channelTargetVersion);
    return { action, beforeVersion, targetVersion, afterVersion: after.version };
  }

  /**
   * Injection/update is allowed to restart mv-agent only when the user already
   * has an mv-agent view open. Reuse the existing restart command behavior;
   * never infer user intent from a cached/running DSH endpoint alone.
   */
  private async restartOpenMvAgentAfterInjection(): Promise<void> {
    const openViews = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
    if (openViews.length === 0) return;
    await this.restartDshWithNotice();
  }

  /**
   * Run the modular plugin auto-updater once the startup dependency check
   * (reconcileIdeIntegration) settled. Called from main.ts post-layout
   * startup. All failures are contained; this never affects the startup
   * chain or the IDE bridge.
   */
  async runPluginAutoUpdateAfterReconcile(): Promise<void> {
    if (!this.plugin.settings.dsh.enabled) return;
    if (this.idePluginRuntimeState.state !== "ready") return;
    try {
      await this.pluginAutoUpdater.runAfterStartupReconcile();
    } catch (error) {
      console.error("[mv-aide] DSH plugin auto-update failed", error);
    }
  }

  /**
   * Auto-updater capability: run the explicit full three-plugin injection
   * (same semantics as the manual 「更新/升级/修复」 button) WITHOUT any
   * restart — the updater decides about restarts itself. Only invoked when
   * the cached injection status already qualified, so `environmentBusy`
   * (a race with a manual environment action) degrades to a skipped run
   * rather than an injected mid-flight mutation.
   */
  private async runFullInjectionForAutoUpdate(): Promise<{
    ok: boolean;
    changed?: boolean;
    message: string;
  }> {
    if (this.environmentBusy) {
      return { ok: false, changed: false, message: t("DSH 环境操作正在进行，自动更新跳过本次执行。") };
    }
    this.environmentBusy = true;
    try {
      const vaultRoot = getVaultRoot(this.plugin.app);
      const detected = await this.inspectActualEnvironment(vaultRoot);
      if (!detected.runtime.command) {
        return {
          ok: false,
          changed: false,
          message: t("未解析到 DSH 命令，自动更新跳过本次执行。"),
        };
      }
      const result = await ensureDshFullInjection(
        vaultRoot,
        detected.runtime.command,
        this.plugin.manifest.version,
        { explicit: true },
      );
      if (result.ok && result.changed === true) {
        await this.refreshEnvironmentAfterAutoUpdate();
      }
      return result;
    } finally {
      this.environmentBusy = false;
    }
  }

  /**
   * After `ensureDshFullInjection` actually wrote new bundles to disk the
   * startup-reconcile snapshot in `this.environment` is stale (typically
   * still showing 「需要修复」). Re-run the standard environment inspection
   * once so the settings panel reflects the injected plugins as 「已就绪」
   * without waiting for a manual re-check. The refresh itself re-enters
   * `inspectActualEnvironment`, which re-computes `environmentFrom(...)`,
   * `annotateRunningBundleStatus(...)` and persists `settings.dsh.injected`;
   * any failure is contained to a console entry so the startup chain and the
   * updater's success notice stay unaffected.
   */
  private async refreshEnvironmentAfterAutoUpdate(): Promise<void> {
    try {
      const vaultRoot = getVaultRoot(this.plugin.app);
      await this.inspectActualEnvironment(vaultRoot);
    } catch (error) {
      console.error("[mv-aide] DSH plugin auto-update environment refresh failed", error);
    }
  }

  /**
   * Auto-updater capability: restart the DSH backend ONLY when one is
   * actually running (current or discoverable endpoint), so it loads the
   * freshly injected bundle. Unlike restartOpenMvAgentAfterInjection this is
   * gated on a running backend rather than an open view, but it never opens
   * a new mv-agent view — existing tabs are simply navigated back to their
   * endpoint. Returns true when a running instance was found and restarted.
   */
  private async restartRunningMvAgentForAutoUpdate(): Promise<boolean> {
    let dshUrl = this.processManager.currentUrl();
    if (!dshUrl) dshUrl = await this.processManager.findDshUrl().catch(() => null);
    if (!dshUrl) return false;
    const url = await this.processManager.restartForObsidian(this.collectActiveDshUrls());
    void this.navigateOpenViewsTo(url);
    return true;
  }

  async reconcileIdeIntegration(options: {
    restartRunningDsh?: boolean;
  } = {}): Promise<DshIdeReconcileResult> {
    if (!this.plugin.settings.dsh.enabled) {
      this.idePluginRuntimeState = { state: "disabled" };
      return { ok: true, changed: false, message: t("状态：已禁用") };
    }

    this.idePluginRuntimeState = { state: "checking" };
    const vaultRoot = getVaultRoot(this.plugin.app);
    try {
      const commandEnv = await resolveUserCommandEnvironment();
      const nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
      const runtime = await inspectDshRuntime(vaultRoot, nodes, runProcess, commandEnv, {
        customDirectory: this.plugin.settings.dsh.customDirectory,
        homeDirectory: effectiveDshHomeDirectory(
          vaultRoot,
          this.plugin.settings.dsh.useVaultDshHome,
          commandEnv,
        ),
        requireRuntimeOwner: this.plugin.settings.dsh.useVaultDshHome,
        preferredPort: this.plugin.settings.dsh.port,
        sourceProbe: probeDshWebViaRequestUrl,
      });
      const before = await inspectDshInjection(vaultRoot, this.plugin.manifest.version, runtime.command ?? undefined);
      const beforeWithRuntime = await this.annotateRunningBundleStatus(before);
      this.environment = environmentFrom(nodes, runtime, beforeWithRuntime, this.environment.updates);
      await this.updatePersistedInjectionState(injectionStateIsUsable(before.full));

      if (!runtime.command) {
        const detail = combinedToolStatus(runtime.dsh).detail
          || selectedNodeStatus(nodes).detail
          || t("DSH 尚未安装，请先点击“安装”。");
        this.idePluginRuntimeState = { state: "blocked", detail };
        return { ok: false, changed: false, message: detail };
      }

      if (!injectionStateIsUsable(before.agent)) {
        this.idePluginRuntimeState = { state: "injecting" };
      }
      const result = await ensureDshAgentInjection(
        vaultRoot,
        runtime.command,
        this.plugin.manifest.version,
        // Same-version content drift must be replaced unconditionally while
        // plugin auto-update is enabled; without authorization the shared
        // compatibility library refuses the overwrite and blocks the whole
        // reconcile + auto-update chain.
        { allowSameVersionOverwrite: this.plugin.settings.dsh.autoUpdatePlugins === true },
      );
      const after = await inspectDshInjection(vaultRoot, this.plugin.manifest.version, runtime.command);
      const afterWithRuntime = await this.annotateRunningBundleStatus(after);
      this.environment = environmentFrom(nodes, runtime, afterWithRuntime, this.environment.updates);
      await this.updatePersistedInjectionState(injectionStateIsUsable(after.full));

      if (!result.ok || !injectionStateIsUsable(after.agent)) {
        const detail = result.ok ? after.agent.detail : result.message;
        this.idePluginRuntimeState = { state: "error", detail };
        return { ok: false, changed: result.changed === true, message: detail };
      }

      if (options.restartRunningDsh) {
        await this.restartOpenMvAgentAfterInjection();
      }
      this.idePluginRuntimeState = { state: "ready" };
      return { ok: true, changed: result.changed === true, message: result.message };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.idePluginRuntimeState = { state: "error", detail };
      return { ok: false, changed: false, message: detail };
    }
  }

  async setIdeEnabled(enabled: boolean): Promise<void> {
    this.plugin.settings.dsh.enabled = enabled;
    await this.plugin.saveData(this.plugin.settings);
    if (enabled) {
      await this.reconcileIdeIntegration({ restartRunningDsh: true });
    } else {
      this.idePluginRuntimeState = { state: "disabled" };
    }
    await this.plugin.syncDshIdeServices();
  }

  async configureCustomDshDirectory(input: string): Promise<ActionResult> {
    if (this.environmentBusy) {
      return { ok: false, message: t("DSH 环境操作正在进行，请等待完成。") };
    }
    if (!input.trim()) return { ok: false, message: t("请填写 DSH 源码目录，或点击“清除”恢复自动检测。") };
    this.environmentBusy = true;
    try {
      const vaultRoot = getVaultRoot(this.plugin.app);
      const commandEnv = await resolveUserCommandEnvironment();
      const nodes = await inspectNodeRuntimes(vaultRoot, runProcess, commandEnv);
      const runtime = await inspectDshRuntime(vaultRoot, nodes, runProcess, commandEnv, {
        customDirectory: input,
        homeDirectory: effectiveDshHomeDirectory(
          vaultRoot,
          this.plugin.settings.dsh.useVaultDshHome,
          commandEnv,
        ),
        requireRuntimeOwner: this.plugin.settings.dsh.useVaultDshHome,
        preferredPort: this.plugin.settings.dsh.port,
        sourceProbe: probeDshWebViaRequestUrl,
      });
      if (!runtime.sourceRuntime || runtime.dsh.custom?.state !== "ready") {
        return {
          ok: false,
          message: runtime.dsh.custom?.detail || t("自定义 DSH 目录验证失败。"),
        };
      }
      if (!toolIsReady(runtime.pnpm)) {
        return {
          ok: false,
          message: combinedToolStatus(runtime.pnpm).detail || t("未检测到 pnpm。"),
        };
      }
      const command = runtime.sourceRuntime.command;
      const dump = await runProcess(
        command.executable,
        [...command.argsPrefix, "--profile", "web", "--dump-config"],
        { cwd: command.cwd, env: command.env, timeoutMs: 120_000 },
      );
      if (dump.code !== 0) {
        return { ok: false, message: dump.stderr || dump.stdout || t("DSH 实际配置校验失败。") };
      }
      this.plugin.settings.dsh.customDirectory = runtime.sourceRuntime.rootDirectory;
      await this.plugin.saveData(this.plugin.settings);
      this.markRuntimeSelectionChanged();
      this.environment.updates.dsh = { checked: false };
      await this.inspectActualEnvironment(vaultRoot);
      await this.reconcileEnabledIdeAfterEnvironmentChange(false);
      return {
        ok: true,
        message: t("已使用自定义 DSH 源码目录：{path}", {
          path: runtime.sourceRuntime.rootDirectory,
        }),
      };
    } finally {
      this.environmentBusy = false;
    }
  }

  async clearCustomDshDirectory(): Promise<ActionResult> {
    if (this.environmentBusy) {
      return { ok: false, message: t("DSH 环境操作正在进行，请等待完成。") };
    }
    this.environmentBusy = true;
    try {
      this.plugin.settings.dsh.customDirectory = "";
      await this.plugin.saveData(this.plugin.settings);
      this.markRuntimeSelectionChanged();
      this.environment.updates.dsh = { checked: false };
      const vaultRoot = getVaultRoot(this.plugin.app);
      await this.inspectActualEnvironment(vaultRoot);
      await this.reconcileEnabledIdeAfterEnvironmentChange(false);
      return { ok: true, message: t("已恢复自动检测 DSH。") };
    } finally {
      this.environmentBusy = false;
    }
  }

  async setUseVaultDshHome(enabled: boolean): Promise<void> {
    if (this.plugin.settings.dsh.useVaultDshHome === enabled) return;
    if (this.environmentBusy) {
      throw new Error(t("DSH 环境操作正在进行，请等待完成。"));
    }
    this.environmentBusy = true;
    try {
      const preserveFullInjection = this.plugin.settings.dsh.injected
        || injectionStateIsUsable(this.environment.plugins.full);
      this.plugin.settings.dsh.useVaultDshHome = enabled;
      await this.plugin.saveData(this.plugin.settings);
      this.markRuntimeSelectionChanged();
      const vaultRoot = getVaultRoot(this.plugin.app);
      const inspected = await this.inspectActualEnvironment(vaultRoot);
      if (preserveFullInjection && inspected.runtime.command) {
        const result = await ensureDshFullInjection(
          vaultRoot,
          inspected.runtime.command,
          this.plugin.manifest.version,
          { explicit: true },
        );
        if (!result.ok) throw new Error(result.message);
        await this.inspectActualEnvironment(vaultRoot);
      }
    } finally {
      this.environmentBusy = false;
    }
  }

  async setDshPort(port: number): Promise<void> {
    if (this.plugin.settings.dsh.port === port) return;
    this.plugin.settings.dsh.port = port;
    await this.plugin.saveData(this.plugin.settings);
    this.markRuntimeSelectionChanged();
  }

  runtimeSelectionNeedsRestart(): boolean {
    return this.runtimeSelectionRestartRequired;
  }

  private async reconcileEnabledIdeAfterEnvironmentChange(restartRunningDsh: boolean): Promise<void> {
    if (!this.plugin.settings.dsh.enabled) return;
    await this.reconcileIdeIntegration({ restartRunningDsh });
    await this.plugin.syncDshIdeServices();
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
        const channelTargetVersion = await resolveNodeTargetVersion();
        const beforeVersion = initial[target].version;
        const relation = beforeVersion
          ? runtimeUpdateRelation(beforeVersion, channelTargetVersion)
          : "older";
        const targetVersion = relation === "newer" && beforeVersion
          ? beforeVersion
          : channelTargetVersion;
        const action = !beforeVersion ? "install" : relation === "older" ? "upgrade" : "reinstall";
        const nodes = await this.ensureNodeForTarget(vaultRoot, target, targetVersion, true);
        const afterVersion = nodes[target].version ?? targetVersion;
        this.environment.updates.node = updateStatusFor(afterVersion, channelTargetVersion);
        await this.reconcileEnabledIdeAfterEnvironmentChange(true);
        return {
          ok: true,
          message: action === "upgrade"
            ? t("Node.js 已从 {from} 升级到 {to}。", { from: beforeVersion ?? t("未知版本"), to: afterVersion })
            : action === "reinstall"
              ? t("Node.js {version} 已重新安装并通过校验。", { version: afterVersion })
              : t("Node.js {version} 已安装并通过校验。", { version: afterVersion }),
        };
      }

      if (layer === "dsh") {
        const inspected = await this.inspectActualEnvironment(vaultRoot);
        if (inspected.runtime.runningUnmanagedDetail && !inspected.runtime.command) {
          throw new Error(inspected.runtime.runningUnmanagedDetail);
        }
        if (this.plugin.settings.dsh.customDirectory && !inspected.runtime.sourceRuntime) {
          throw new Error(
            inspected.runtime.dsh.custom?.detail || t("自定义 DSH 目录无效，请修正或清除后重试。"),
          );
        }
        if (inspected.runtime.sourceRuntime) {
          const source = inspected.runtime.sourceRuntime;
          const commandEnvironment = source.command.env ?? inspected.commandEnv;
          const pnpmExecutable = source.pnpmExecutable
            ?? findSystemExecutable("pnpm", process.platform, commandEnvironment);
          if (!pnpmExecutable) throw new Error(t("未检测到可用于 DSH 源码构建的 pnpm。"));
          const requestedUpgrade = this.environment.updates.dsh.updateAvailable === true;
          const sourceUpdate = requestedUpgrade
            ? await inspectDshSourceUpdate(source)
            : null;
          const rebuilt = await rebuildOrUpgradeDshSource(source, {
            upgrade: sourceUpdate?.updateAvailable === true,
            pnpmExecutable,
          });
          await this.inspectActualEnvironment(vaultRoot);
          this.environment.updates.dsh = {
            checked: true,
            targetVersion: rebuilt.version,
            relation: "current",
            updateAvailable: false,
          };
          await this.reconcileEnabledIdeAfterEnvironmentChange(true);
          return {
            ok: true,
            message: sourceUpdate?.updateAvailable
              ? t("DSH 源码版已从 {from} 升级并构建为 {to}。", {
                  from: source.version,
                  to: rebuilt.version,
                })
              : t("DSH 源码版 {version} 已重新安装依赖、构建并通过校验。", {
                  version: rebuilt.version,
                }),
          };
        }
        const operation = await this.ensurePackage(vaultRoot, "dsh", requestedTarget, chooseTarget, true);
        if (!operation) throw new Error(t("DSH 操作未执行。"));
        await this.reconcileEnabledIdeAfterEnvironmentChange(true);
        return {
          ok: true,
          message: operation.action === "upgrade"
            ? t("DSH 已从 {from} 升级到 {to}。", { from: operation.beforeVersion ?? t("未知版本"), to: operation.afterVersion })
            : operation.action === "reinstall"
              ? t("DSH {version} 已重新安装并通过校验。", { version: operation.afterVersion })
              : t("DSH {version} 已安装并通过校验。", { version: operation.afterVersion }),
        };
      }

      if (layer === "pnpm") {
        const operation = await this.ensurePackage(vaultRoot, "pnpm", requestedTarget, chooseTarget, true);
        if (!operation) throw new Error(t("pnpm 操作未执行。"));
        await this.reconcileEnabledIdeAfterEnvironmentChange(true);
        return {
          ok: true,
          message: operation.action === "upgrade"
            ? t("pnpm 已从 {from} 升级到 {to}。", { from: operation.beforeVersion ?? t("未知版本"), to: operation.afterVersion })
            : operation.action === "reinstall"
              ? t("pnpm {version} 已重新安装并通过校验。", { version: operation.afterVersion })
              : t("pnpm {version} 已安装并通过校验。", { version: operation.afterVersion }),
        };
      }

      await this.ensureAnyNode(vaultRoot, null, chooseTarget);
      const detected = await this.inspectActualEnvironment(vaultRoot);
      if (detected.runtime.runningUnmanagedDetail && !detected.runtime.command) {
        throw new Error(detected.runtime.runningUnmanagedDetail);
      }
      if (this.plugin.settings.dsh.customDirectory) {
        const configured = detected;
        if (!configured.runtime.sourceRuntime) {
          throw new Error(
            configured.runtime.dsh.custom?.detail || t("自定义 DSH 目录无效，请修正或清除后重试。"),
          );
        }
      }
      await this.ensurePackage(vaultRoot, "dsh", null, chooseTarget, false);
      await this.ensurePackage(vaultRoot, "pnpm", null, chooseTarget, false);
      const { nodes, runtime } = await this.inspectActualEnvironment(vaultRoot);
      if (!runtime.command) throw new Error(t("DSH 命令解析失败。"));
      const result = await ensureDshFullInjection(
        vaultRoot,
        runtime.command,
        this.plugin.manifest.version,
        { explicit: true },
      );
      const actual = await inspectDshInjection(vaultRoot, this.plugin.manifest.version, runtime.command);
      const actualWithRuntime = await this.annotateRunningBundleStatus(actual);
      this.environment = environmentFrom(nodes, runtime, actualWithRuntime, this.environment.updates);
      await this.updatePersistedInjectionState(result.ok && injectionStateIsUsable(actual.full));
      if (result.ok) await this.restartOpenMvAgentAfterInjection();
      await this.reconcileEnabledIdeAfterEnvironmentChange(false);
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
    let restartRequired = this.runtimeSelectionRestartRequired;
    if (this.plugin.settings.dsh.enabled) {
      const reconciled = await this.reconcileIdeIntegration({ restartRunningDsh: false });
      if (!reconciled.ok) throw new Error(reconciled.message);
      restartRequired = restartRequired
        || reconciled.changed === true
        || this.environment.plugins.full.restartRequired === true;
    }
    const url = restartRequired
      ? await this.processManager.restartForObsidian(connectedUrls)
      : await this.processManager.ensureStartedForOpen(connectedUrls);
    if (generation !== this.mvAgentOperationGeneration) return;
    if (restartRequired) {
      this.runtimeSelectionRestartRequired = false;
      await this.navigateOpenViewsTo(url);
    }
    const leaf = await openDshWebviewInNewLeaf(
      this.plugin.app.workspace,
      this.plugin.settings.dsh.autoOpenRegion,
      await this.frameUrlFor(url),
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

  /**
   * The URL an mv-agent iframe should load for a semantic endpoint URL: the
   * plugin-owned loopback proxy when that endpoint is auth-gated (Alpha),
   * otherwise the endpoint itself. Falls back to the given URL when the
   * endpoint is not the currently managed one.
   */
  async frameUrlFor(semanticUrl: string): Promise<string> {
    const normalized = normalizeDshWebUrl(semanticUrl);
    if (!normalized) return semanticUrl;
    const current = this.processManager.currentUrl();
    if (current && sameDshWebUrl(current, normalized)) {
      const webViewUrl = await this.processManager.webViewUrl();
      if (webViewUrl) return webViewUrl;
    }
    return normalized;
  }

  /**
   * Map a frame URL back to the semantic DSH endpoint URL (proxy-origin
   * frames resolve to the real fronted endpoint).
   */
  semanticUrlOf(frameUrl: string): string | null {
    return this.processManager.semanticUrlOf(frameUrl);
  }

  /**
   * The URL for 「浏览器打开」/「复制 DSH 地址」: the launch URL when token
   * authority is held (a top-level navigation lands the cookie normally),
   * else the identity URL.
   */
  externalDshUrl(): string | null {
    return this.processManager.externalLaunchUrl();
  }

  /**
   * Read one mv-agent view's real connection state from OS process/TCP facts.
   * The view URL is authoritative even before this Vault's private process
   * manager has adopted a shared DSH instance.
   */
  async isDshViewConnectedToBridge(dshUrl: string): Promise<boolean> {
    const bridgePort = Number((this.plugin as unknown as { port?: number }).port ?? 0);
    const normalized = normalizeDshWebUrl(dshUrl);
    if (!bridgePort || !normalized) return false;
    const dshPort = Number(new URL(normalized).port);
    if (!Number.isInteger(dshPort) || dshPort <= 0 || dshPort >= 65536) return false;
    try {
      return await isDshConnectedToBridge(
        { dshPort, bridgePort, dshUrl: normalized },
        { probe: probeDshWebViaRequestUrl },
      );
    } catch {
      return false;
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
  private async navigateOpenViewsTo(url: string): Promise<void> {
    const frameUrl = await this.frameUrlFor(url);
    const leaves = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
    for (const leaf of leaves) {
      try {
        void (leaf.view as DshWebView | null)?.navigateTo?.(frameUrl);
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
        if (url) void this.frameUrlFor(url).then((frameUrl) => {
          void view?.navigateTo?.(frameUrl);
        });
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
      this.runtimeSelectionRestartRequired = false;
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
      if (this.plugin.settings.dsh.enabled) {
        const reconciled = await this.reconcileIdeIntegration({ restartRunningDsh: false });
        if (!reconciled.ok) throw new Error(reconciled.message);
      }
      const connectedUrls = this.collectActiveDshUrls();
      const url = await this.processManager.restartForObsidian(connectedUrls);
      if (generation !== this.mvAgentOperationGeneration) return;
      this.runtimeSelectionRestartRequired = false;
      const currentLeaves = this.plugin.app.workspace.getLeavesOfType(DSH_WEB_VIEW_TYPE);
      if (currentLeaves.length > 0) {
        await this.navigateOpenViewsTo(url);
      } else {
        const leaf = await openDshWebviewInNewLeaf(
          this.plugin.app.workspace,
          this.plugin.settings.dsh.autoOpenRegion,
          await this.frameUrlFor(url),
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
