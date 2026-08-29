import { t } from "../../i18n";

/**
 * DSH plugin auto-updater — a self-contained module that runs AFTER the
 * startup dependency check (`reconcileIdeIntegration`) and refreshes the
 * injected mv-AIDE plugins when their version differs from this build.
 *
 * Design contract:
 * - Zero intrusion: it consumes the injection status already cached by the
 *   startup check and never reruns detection unless an update is actually
 *   required. It is wired by `main.ts` through the DshFeature entry point
 *   `runPluginAutoUpdateAfterReconcile()`; existing reconcile / manual
 *   injection paths are untouched.
 * - Higher-version injections are NEVER downgraded (also enforced inside
 *   `ide/injection.ts`).
 * - Every failure is contained: a bad update shows a notice and logs, but
 *   never breaks the startup chain, the IDE bridge, or the reconcile state.
 *
 * The module itself imports neither obsidian nor DshFeature; capabilities
 * arrive through `DshPluginAutoUpdateDeps`, so the whole orchestration is
 * unit-testable without mocks of either.
 */

export interface DshPluginFullStatusLike {
  state: string;
  relation?: string;
}

export interface DshPluginAutoUpdateResult {
  ok: boolean;
  changed?: boolean;
  message: string;
}

export interface DshPluginAutoUpdateDeps {
  /** Persisted master switch (`settings.dsh.autoUpdatePlugins`). */
  isAutoUpdateEnabled(): boolean;
  /** Persisted restart opt-in (`settings.dsh.autoRestartAfterPluginUpdate`). */
  isAutoRestartEnabled(): boolean;
  /** The aggregate injected-plugin status cached by the startup check. */
  fullStatus(): DshPluginFullStatusLike | null;
  /**
   * Run the explicit full three-plugin injection (equivalent to the manual
   * 「更新/升级/修复」 button). Implementations must NOT restart mv-agent;
   * the updater decides about restarts itself.
   */
  runFullInjection(): Promise<DshPluginAutoUpdateResult>;
  /**
   * Restart the already running DSH backend so it loads the new bundle.
   * Returns true when a running instance was found and restarted. Must never
   * open a new mv-agent view.
   */
  restartRunningMvAgent(): Promise<boolean>;
  /** Surface a user-facing notice. */
  notify(message: string): void;
}

/**
 * Whether one aggregate injection status qualifies for an automatic update:
 * version drift (outdated / unknown / same-version content conflict) or an
 * incomplete injection the manual button would label 「修复」. `newer` and
 * `partial`+`newer` are higher-version protections and never auto-update;
 * `missing`, `ready`, `blocked` and `error` remain the responsibility of the
 * reconcile / manual flows.
 */
export function shouldAutoUpdateInjection(status: DshPluginFullStatusLike): boolean {
  switch (status.state) {
    case "outdated":
    case "unknown":
    case "conflict":
      return true;
    case "partial":
      return status.relation !== "newer";
    default:
      return false;
  }
}

export class DshPluginAutoUpdater {
  constructor(private readonly deps: DshPluginAutoUpdateDeps) {}

  /**
   * Entry point called once per Obsidian launch, after the startup
   * dependency check settled. Returns immediately when the feature is off,
   * no status is cached, or the injection does not qualify — the hot path
   * performs no IO at all.
   */
  async runAfterStartupReconcile(): Promise<void> {
    if (!this.deps.isAutoUpdateEnabled()) return;
    const status = this.deps.fullStatus();
    if (!status || !shouldAutoUpdateInjection(status)) return;

    let result: DshPluginAutoUpdateResult;
    try {
      result = await this.deps.runFullInjection();
    } catch (error) {
      this.contain(t("注入插件自动更新失败：{message}", { message: describeError(error) }));
      return;
    }
    if (!result.ok) {
      this.contain(t("注入插件自动更新失败：{message}", { message: result.message }));
      return;
    }
    if (result.changed !== true) return;

    if (!this.deps.isAutoRestartEnabled()) {
      this.deps.notify(t("注入插件已自动更新到当前 mv-AIDE 版本；重启 mv-agent 后生效。"));
      return;
    }
    let restarted = false;
    try {
      restarted = await this.deps.restartRunningMvAgent();
    } catch (error) {
      console.error("[mv-aide] DSH plugin auto-update restart failed", error);
      restarted = false;
    }
    this.deps.notify(
      restarted
        ? t("注入插件已自动更新，正在运行的 mv-agent 已重启以加载新版本。")
        : t("注入插件已自动更新；未发现正在运行的 mv-agent，新版本将在下次打开时生效。"),
    );
  }

  private contain(message: string): void {
    console.error("[mv-aide] DSH plugin auto-update failed:", message);
    this.deps.notify(message);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
