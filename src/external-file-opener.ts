import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TFile, type App, type WorkspaceLeaf } from "obsidian";
import {
  normalizeSourceAssistExtension,
} from "./source-assist/source-assist-settings";
import {
  createVerifiedFileSymlink,
  verifyFileSymlink,
  type FileSymlinkFailure,
} from "./file-symlink-service";
import {
  describeFileSymlinkFailure,
  isManagedCopyEligibleSymlinkFailure,
} from "./external-file-symlink-preflight";
import {
  activateManagedCopyAfterSymlinkFailure,
  isManagedCopyOwnedByScope,
  resolveManagedCopyScope,
  resumeManagedCopyFallbackAsync,
  watchManagedCopy,
  type ManagedCopyConflict,
  type ManagedCopyConflictChoice,
  type ManagedCopyConflictResolutionResult,
  type ManagedCopyScope,
  type ManagedCopySyncResult,
  type ManagedCopyWatchController,
} from "./managed-copy-fallback";
import {
  normalizeExternalFileMirrorFolder,
  normalizeExternalFileVaultPath,
  resolveExternalFileVaultPath,
} from "./external-file-mirror-path";
import { migrateManagedCopyToSymlink } from "./managed-copy-symlink-migration";
import type {
  BridgeSettings,
  ExternalFileMapping,
  ExternalFileOpenerExtensionMode,
} from "./types";

export interface ExternalFileOpenResult {
  success: boolean;
  externalPath: string;
  vaultPath: string | null;
  message?: string;
  symlinkFailure?: FileSymlinkFailure;
  managedCopyFallbackAvailable?: boolean;
}

export interface ManagedCopySymlinkRetrySummary {
  attempted: number;
  migrated: number;
  remaining: number;
  failures: string[];
  warnings: string[];
}

export type ManagedCopyRestorePriority = "idle" | "open-request";
export type ManagedCopyRestoreScheduler = (
  callback: () => void,
  priority?: ManagedCopyRestorePriority,
) => () => void;

export interface ManagedCopyRestoreTask {
  readonly completion: Promise<number>;
  readonly isCancelled: boolean;
  cancel(): void;
  /** Resolve true when this task restored the requested mapping. */
  prioritize(externalPath: string): Promise<boolean>;
}

class ExternalFileSymlinkFallbackRequiredError extends Error {
  constructor(readonly failure: FileSymlinkFailure) {
    super(
      `${describeFileSymlinkFailure(failure)} ` +
        "可重新检测符号链接，或明确选择受管临时副本后重试。",
    );
    this.name = "ExternalFileSymlinkFallbackRequiredError";
  }
}

interface ExternalFileOpenerOptions {
  app: App;
  getSettings: () => BridgeSettings;
  getVaultRoot: () => string;
  saveSettings: () => Promise<void>;
  focusObsidianApp?: () => Promise<void>;
  managedCopyFallbackEnabled?: () => boolean;
  getManagedCopyHostId?: () => string;
  onManagedCopyConflict?: (
    conflict: ManagedCopyConflict,
    resolve: (
      choice: ManagedCopyConflictChoice,
    ) => Promise<ManagedCopyConflictResolutionResult>,
  ) => void | Promise<void>;
  onManagedCopyError?: (error: unknown) => void;
  createFileSymlink?: typeof createVerifiedFileSymlink;
  verifyFileSymlink?: typeof verifyFileSymlink;
}

export function normalizeExternalFileMappingPathIdentity(
  externalPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return path.win32.normalize(externalPath).toLowerCase();
  }
  return path.normalize(externalPath);
}

function sameExternalFileMappingPath(left: string, right: string): boolean {
  return normalizeExternalFileMappingPathIdentity(left) ===
    normalizeExternalFileMappingPathIdentity(right);
}

export function managedCopyMappingStorageKey(
  scopeKey: string,
  externalPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathHash = crypto
    .createHash("sha256")
    .update(normalizeExternalFileMappingPathIdentity(externalPath, platform))
    .digest("hex");
  return `managed-copy:${scopeKey}:${pathHash}`;
}

function symlinkMappingStorageKey(
  externalPath: string,
  vaultPath: string,
): string {
  const identityHash = crypto
    .createHash("sha256")
    .update(normalizeExternalFileMappingPathIdentity(externalPath))
    .update("\0")
    .update(vaultPath)
    .digest("hex");
  return `symlink:${identityHash}`;
}

export function managedCopyHeartbeatInterval(storageKey: string): number {
  const offset = crypto
    .createHash("sha256")
    .update(storageKey)
    .digest()
    .readUInt16BE(0) % 5_001;
  return 30_000 + offset;
}

// Separate hash domain so the polling fallback does not align with heartbeats.
export function managedCopyPollInterval(storageKey: string): number {
  const offset = crypto
    .createHash("sha256")
    .update("poll\0")
    .update(storageKey)
    .digest()
    .readUInt16BE(0) % 1_001;
  return 2_000 + offset;
}

export const MARKDOWN_EXTERNAL_EXTENSIONS = ["md", "markdown"] as const;
const execFile = promisify(childProcess.execFile);

export function normalizeExternalFileOpenerExtensionMode(
  value: unknown,
): ExternalFileOpenerExtensionMode {
  return value === "markdown-and-source-assist"
    ? "markdown-and-source-assist"
    : "markdown-only";
}

export function externalFileAllowedExtensions(
  settings: Pick<BridgeSettings, "externalFileOpener" | "sourceAssist">,
): string[] {
  const extensions = new Set<string>(MARKDOWN_EXTERNAL_EXTENSIONS);
  if (settings.externalFileOpener.extensionMode === "markdown-and-source-assist") {
    for (const profile of settings.sourceAssist.profiles) {
      if (!profile.enabled) continue;
      const extension = normalizeSourceAssistExtension(profile.extension);
      if (extension && extension !== "md" && extension !== "markdown") {
        extensions.add(extension);
      }
    }
  }
  return Array.from(extensions);
}

export function normalizeExternalFileExtension(filePath: string): string {
  return path
    .extname(filePath.replace(/\\/g, "/"))
    .replace(/^\./, "")
    .toLowerCase();
}

export function isExternalFileExtensionAllowed(
  settings: Pick<BridgeSettings, "externalFileOpener" | "sourceAssist">,
  filePath: string,
): boolean {
  const extension = normalizeExternalFileExtension(filePath);
  return extension !== "" && externalFileAllowedExtensions(settings).includes(extension);
}

export function isAbsoluteExternalPath(filePath: string): boolean {
  return (
    path.isAbsolute(filePath) ||
    /^[a-zA-Z]:[\\/]/.test(filePath) ||
    /^\\\\[^\\]+\\[^\\]+/.test(filePath)
  );
}

export function normalizeExternalFilePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error("外部文件路径为空。");
  const resolved = trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed;
  if (!isAbsoluteExternalPath(resolved)) {
    throw new Error("外部文件路径必须是绝对路径。");
  }
  return process.platform === "win32"
    ? path.win32.normalize(resolved)
    : path.normalize(resolved);
}

function normalizeVaultPath(vaultPath: string): string {
  return vaultPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function safeBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.split("/").filter(Boolean).pop() || "external.md";
  return name.replace(/[<>:"|?*\x00-\x1F]/g, "_");
}

export function externalFileMirrorPath(
  mirrorFolder: string,
  externalPath: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(externalPath)
    .digest("hex")
    .slice(0, 16);
  const normalizedFolder = normalizeExternalFileMirrorFolder(mirrorFolder);
  return normalizeExternalFileVaultPath(
    `${normalizedFolder}/${hash}/${safeBasename(externalPath)}`,
  );
}

function containedRelativePath(
  rootPath: string,
  candidatePath: string,
  pathApi: typeof path.win32,
): string | null {
  const relative = pathApi.relative(pathApi.resolve(rootPath), pathApi.resolve(candidatePath));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

export function windowsVaultRelativeFilePath(
  vaultRoot: string,
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32") return null;
  const lexicalRelative = containedRelativePath(vaultRoot, filePath, path.win32);
  if (!lexicalRelative) return null;
  try {
    const realVaultRoot = fs.realpathSync.native(vaultRoot);
    const realFilePath = fs.realpathSync.native(filePath);
    if (!containedRelativePath(realVaultRoot, realFilePath, path.win32)) return null;
  } catch {
    return null;
  }
  return normalizeVaultPath(lexicalRelative);
}

interface ElectronWindowLike {
  focus?: () => void;
  show?: () => void;
  restore?: () => void;
  isMinimized?: () => boolean;
}

interface ElectronLike {
  remote?: {
    app?: { focus?: (options?: { steal?: boolean }) => void };
    getCurrentWindow?: () => ElectronWindowLike;
  };
}

function rendererWindow(): (Window & { require?: (moduleName: string) => unknown }) | null {
  const globals = globalThis as unknown as {
    activeWindow?: Window & { require?: (moduleName: string) => unknown };
    window?: Window & { require?: (moduleName: string) => unknown };
  };
  return globals.activeWindow ?? globals.window ?? null;
}

function focusElectronWindow(): boolean {
  let focused = false;
  try {
    const electron = rendererWindow()?.require?.("electron") as ElectronLike | undefined;
    const currentWindow = electron?.remote?.getCurrentWindow?.();
    if (currentWindow?.isMinimized?.()) {
      currentWindow.restore?.();
      focused = true;
    }
    currentWindow?.show?.();
    currentWindow?.focus?.();
    if (currentWindow?.show || currentWindow?.focus) focused = true;
    electron?.remote?.app?.focus?.({ steal: true });
    if (electron?.remote?.app?.focus) focused = true;
  } catch {
    // Electron focus is best effort; platform fallback may still work.
  }

  try {
    rendererWindow()?.focus?.();
    focused = true;
  } catch {
    // Browser window focus is also best effort.
  }
  return focused;
}

export async function focusObsidianApp(): Promise<void> {
  let focused = focusElectronWindow();
  if (process.platform === "darwin") {
    try {
      await execFile("/usr/bin/open", ["-b", "md.obsidian"]);
      focused = true;
    } catch {
      try {
        await execFile("/usr/bin/open", ["-a", "Obsidian"]);
        focused = true;
      } catch (error) {
        if (!focused) throw error;
      }
    }
  }
  if (!focused) {
    throw new Error("No available Obsidian focus mechanism.");
  }
}


interface ManagedCopyRestoreWorkItem {
  storageKey: string;
  mapping: ExternalFileMapping;
  identity: string;
}

function defaultManagedCopyRestoreScheduler(
  callback: () => void,
  priority: ManagedCopyRestorePriority = "idle",
): () => void {
  if (priority === "idle") {
    const idleHost = globalThis as typeof globalThis & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleHost.requestIdleCallback) {
      const handle = idleHost.requestIdleCallback(callback, { timeout: 500 });
      return () => idleHost.cancelIdleCallback?.(handle);
    }
  }
  const handle = setTimeout(callback, priority === "open-request" ? 0 : 16);
  return () => clearTimeout(handle);
}

class ManagedCopyRestoreTaskImpl implements ManagedCopyRestoreTask {
  readonly completion: Promise<number>;
  private readonly queued: ManagedCopyRestoreWorkItem[];
  private readonly waiters = new Map<
    string,
    {
      promise: Promise<boolean>;
      resolve: (restored: boolean) => void;
    }
  >();
  private resolveCompletion!: (count: number) => void;
  private scheduledCancel: (() => void) | null = null;
  private runningItem: ManagedCopyRestoreWorkItem | null = null;
  private cancelled = false;
  private finishing = false;
  private nextPriority: ManagedCopyRestorePriority = "idle";

  constructor(
    candidates: ManagedCopyRestoreWorkItem[],
    private readonly scheduler: (
      callback: () => void,
      priority?: ManagedCopyRestorePriority,
    ) => () => void,
    private readonly processItem: (
      item: ManagedCopyRestoreWorkItem,
    ) => Promise<boolean>,
    private readonly finish: (completed: boolean) => Promise<number>,
  ) {
    this.queued = [...candidates];
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
    for (const candidate of candidates) {
      let resolve!: (restored: boolean) => void;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      this.waiters.set(candidate.identity, { promise, resolve });
    }
    this.scheduleNext("idle");
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    if (this.cancelled || this.finishing) return;
    this.cancelled = true;
    this.scheduledCancel?.();
    this.scheduledCancel = null;
    for (const item of this.queued.splice(0)) {
      this.resolveWaiter(item.identity, false);
    }
    if (!this.runningItem) void this.complete(false);
  }

  async prioritize(externalPath: string): Promise<boolean> {
    if (this.cancelled || this.finishing) return false;
    const identity = normalizeExternalFileMappingPathIdentity(externalPath);
    const waiter = this.waiters.get(identity);
    if (!waiter) return false;
    const index = this.queued.findIndex((item) => item.identity === identity);
    if (index > 0) {
      const [candidate] = this.queued.splice(index, 1);
      if (candidate) this.queued.unshift(candidate);
    }
    if (index >= 0) {
      if (this.runningItem) this.nextPriority = "open-request";
      else {
        this.scheduledCancel?.();
        this.scheduledCancel = null;
        this.scheduleNext("open-request");
      }
    }
    return waiter.promise;
  }

  private scheduleNext(priority: ManagedCopyRestorePriority): void {
    if (this.cancelled || this.finishing || this.scheduledCancel) return;
    if (this.queued.length === 0) {
      void this.complete(true);
      return;
    }
    this.scheduledCancel = this.scheduler(() => {
      this.scheduledCancel = null;
      void this.runOne();
    }, priority);
  }

  private async runOne(): Promise<void> {
    if (this.cancelled || this.finishing || this.runningItem) return;
    const item = this.queued.shift();
    if (!item) {
      await this.complete(true);
      return;
    }
    this.runningItem = item;
    let restored = false;
    try {
      restored = await this.processItem(item);
    } catch {
      restored = false;
    } finally {
      this.resolveWaiter(item.identity, restored);
      this.runningItem = null;
    }
    if (this.cancelled) {
      await this.complete(false);
    } else {
      const priority = this.nextPriority;
      this.nextPriority = "idle";
      this.scheduleNext(priority);
    }
  }

  private resolveWaiter(identity: string, restored: boolean): void {
    const waiter = this.waiters.get(identity);
    if (!waiter) return;
    this.waiters.delete(identity);
    waiter.resolve(restored);
  }

  private async complete(completed: boolean): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    let count = 0;
    try {
      count = await this.finish(completed);
    } catch {
      // Completion is deliberately non-rejecting; item errors were isolated.
    }
    this.resolveCompletion(count);
  }
}
export class ExternalFileOpenerFeature {
  private readonly managedCopyWatchers = new Map<
    string,
    ManagedCopyWatchController
  >();

  private managedCopyRestoreTask: ManagedCopyRestoreTaskImpl | null = null;
  private disposed = false;
  private layoutReadyPromise: Promise<void> | null = null;
  private layoutReadyTimer: number | null = null;

  constructor(private readonly options: ExternalFileOpenerOptions) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.layoutReadyTimer !== null) {
      activeWindow.clearTimeout(this.layoutReadyTimer);
      this.layoutReadyTimer = null;
    }
    this.stopManagedCopyRuntime();
  }

  /** Stop restartable runtime work without permanently disposing the feature. */
  stopManagedCopyRuntime(): void {
    this.managedCopyRestoreTask?.cancel();
    for (const watcher of this.managedCopyWatchers.values()) watcher.dispose();
    this.managedCopyWatchers.clear();
  }

  allowedExtensions(): string[] {
    return externalFileAllowedExtensions(this.options.getSettings());
  }

  async openExternalFile(
    rawExternalPath: string,
    options: { makeFrontmost?: boolean } = {},
  ): Promise<ExternalFileOpenResult> {
    let externalPath = "";
    try {
      const settings = this.options.getSettings();
      if (!settings.externalFileOpener.enabled) {
        throw new Error("默认文件打开器已关闭。");
      }

      // 冷启动时协议调用可能先于布局恢复到达；等布局就绪后再查找已打开
      // 标签，否则恢复中的 deferred 标签尚未挂上 view.file，会被误判为
      // 未打开而重复新开标签。
      await this.waitForLayoutReady();

      externalPath = normalizeExternalFilePath(rawExternalPath);
      if (!isExternalFileExtensionAllowed(settings, externalPath)) {
        throw new Error(
          `不支持该后缀：.${normalizeExternalFileExtension(externalPath) || "unknown"}`,
        );
      }

      const stat = fs.statSync(externalPath);
      if (!stat.isFile()) throw new Error("只能打开文件，不能打开文件夹。");

      const directVaultPath = windowsVaultRelativeFilePath(
        this.options.getVaultRoot(),
        externalPath,
      );
      const vaultPath = directVaultPath ??
        (await this.linkExternalFile(externalPath)).vaultPath;
      if (!directVaultPath) await this.options.saveSettings();

      const file = await this.waitForIndexedFile(vaultPath);
      if (!file) {
        throw new Error(
          directVaultPath
            ? `Obsidian 尚未索引仓库内文件：${vaultPath}`
            : `Obsidian 尚未索引镜像文件：${vaultPath}`,
        );
      }

      const makeFrontmost = options.makeFrontmost !== false;
      // 已打开则聚焦已有标签，避免同一文件出现重复标签。
      const existingLeaf = this.findOpenFileLeaf(file);
      if (existingLeaf) {
        if (makeFrontmost) {
          this.options.app.workspace.setActiveLeaf(existingLeaf, {
            focus: true,
          });
          await this.revealLeaf(existingLeaf);
          await this.focusObsidianAppBestEffort();
        }
        return {
          success: true,
          externalPath,
          vaultPath,
        };
      }
      // 默认打开器一律新开标签，严禁覆盖用户当前正在查看的标签页。
      const leaf = this.options.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: makeFrontmost });
      if (makeFrontmost) {
        await this.revealLeaf(leaf);
        await this.focusObsidianAppBestEffort();
      }
      return {
        success: true,
        externalPath,
        vaultPath,
      };
    } catch (error) {
      const fallbackRequired =
        error instanceof ExternalFileSymlinkFallbackRequiredError;
      return {
        success: false,
        externalPath: externalPath || rawExternalPath,
        vaultPath: null,
        message: error instanceof Error ? error.message : String(error),
        symlinkFailure: fallbackRequired ? error.failure : undefined,
        managedCopyFallbackAvailable: fallbackRequired || undefined,
      };
    }
  }

  private async focusObsidianAppBestEffort(): Promise<void> {
    try {
      await (this.options.focusObsidianApp ?? focusObsidianApp)();
    } catch (error) {
      console.warn("[mv-aide] Failed to focus Obsidian.", error);
    }
  }

  /**
   * Schedule persisted watcher restoration after the runtime descriptor has
   * been published. Only one task may run; each idle slice restores at most
   * one mapping and open requests can promote their mapping to the front.
   */
  scheduleManagedCopyWatcherRestore(
    scheduler: ManagedCopyRestoreScheduler = defaultManagedCopyRestoreScheduler,
  ): ManagedCopyRestoreTask {
    const running = this.managedCopyRestoreTask;
    if (running && !running.isCancelled) return running;

    const preparation = this.prepareManagedCopyWatcherRestore();
    const activeStorageKeys = new Set<string>();
    let saveRequired = preparation.stateChanged;
    let task!: ManagedCopyRestoreTaskImpl;
    task = new ManagedCopyRestoreTaskImpl(
      preparation.candidates,
      scheduler,
      async ({ storageKey, mapping }) => {
        if (this.disposed || !preparation.scope || !mapping.managedCopy) {
          return false;
        }
        const current = this.options.getSettings().externalFileOpener
          .mappings[storageKey];
        if (current !== mapping) return false;
        const runningWatcher = this.managedCopyWatchers.get(storageKey);
        if (this.managedCopyWatcherMatches(runningWatcher, mapping)) {
          activeStorageKeys.add(storageKey);
          return false;
        }
        try {
          const resumed = await resumeManagedCopyFallbackAsync({
            scope: preparation.scope,
            externalPath: mapping.externalPath,
            vaultPath: mapping.vaultPath,
            existing: mapping.managedCopy,
          });
          if (this.disposed || task.isCancelled) return false;
          const latest = this.options.getSettings().externalFileOpener
            .mappings[storageKey];
          if (latest !== mapping || !latest.managedCopy) return false;
          if (resumed.state !== mapping.managedCopy) saveRequired = true;
          mapping.managedCopy = resumed.state;
          this.startManagedCopyWatcher(
            storageKey,
            mapping,
            preparation.scope,
            resumed.synchronization,
          );
          activeStorageKeys.add(storageKey);
          if (saveRequired) {
            await this.saveManagedCopyRestoreState();
            saveRequired = false;
          }
          return true;
        } catch (error) {
          this.reportManagedCopyError(error);
          return false;
        }
      },
      async (completed) => {
        if (saveRequired) {
          await this.saveManagedCopyRestoreState();
          saveRequired = false;
        }
        if (completed && !this.disposed) {
          this.reconcileManagedCopyWatchersAfterRestore(
            preparation.snapshotMappings,
            activeStorageKeys,
          );
        }
        return activeStorageKeys.size;
      },
    );
    this.managedCopyRestoreTask = task;
    void task.completion.finally(() => {
      if (this.managedCopyRestoreTask === task) {
        this.managedCopyRestoreTask = null;
      }
    });
    return task;
  }

  /** Compatibility API; now yields through the idle restoration task. */
  async restoreManagedCopyWatchers(): Promise<number> {
    return this.scheduleManagedCopyWatcherRestore().completion;
  }

  private prepareManagedCopyWatcherRestore(): {
    scope: ManagedCopyScope | null;
    candidates: ManagedCopyRestoreWorkItem[];
    snapshotMappings: Map<string, ExternalFileMapping>;
    stateChanged: boolean;
  } {
    const settings = this.options.getSettings().externalFileOpener;
    const persistedCandidates: Array<[string, ExternalFileMapping]> = [];
    const snapshotMappings = new Map<string, ExternalFileMapping>();
    for (const [storageKey, mapping] of Object.entries(settings.mappings)) {
      if (
        mapping &&
        typeof mapping === "object" &&
        mapping.strategy === "managed-copy" &&
        mapping.managedCopy
      ) {
        persistedCandidates.push([storageKey, mapping]);
        snapshotMappings.set(storageKey, mapping);
      }
    }
    if (persistedCandidates.length === 0) {
      return {
        scope: null,
        candidates: [],
        snapshotMappings,
        stateChanged: false,
      };
    }

    let scope: ManagedCopyScope;
    try {
      scope = this.managedCopyScope();
    } catch (error) {
      this.reportManagedCopyError(error);
      return {
        scope: null,
        candidates: [],
        snapshotMappings,
        stateChanged: false,
      };
    }
    let stateChanged = false;
    const ownedCandidates = persistedCandidates.filter(([, mapping]) =>
      mapping.managedCopy && isManagedCopyOwnedByScope(mapping.managedCopy, scope));
    const localCandidates: Array<[string, ExternalFileMapping]> = [];
    for (const [storageKey, mapping] of ownedCandidates) {
      if (
        typeof mapping.externalPath !== "string" ||
        !mapping.externalPath.trim() ||
        typeof mapping.vaultPath !== "string" ||
        !mapping.vaultPath.trim()
      ) {
        this.reportManagedCopyError(new Error(
          `本机受管临时副本映射 ${storageKey} 的路径字段无效，已跳过恢复。`,
        ));
        continue;
      }
      const expectedKey = managedCopyMappingStorageKey(
        scope.scopeKey,
        mapping.externalPath,
      );
      if (storageKey === expectedKey) {
        localCandidates.push([storageKey, mapping]);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(settings.mappings, expectedKey)) {
        this.reportManagedCopyError(new Error(
          `无法迁移旧版受管临时副本映射 ${storageKey}：本机隔离键已被占用。已保留原状态且未自动恢复。`,
        ));
        continue;
      }
      settings.mappings[expectedKey] = mapping;
      delete settings.mappings[storageKey];
      this.managedCopyWatchers.get(storageKey)?.dispose();
      this.managedCopyWatchers.delete(storageKey);
      snapshotMappings.set(expectedKey, mapping);
      localCandidates.push([expectedKey, mapping]);
      stateChanged = true;
    }

    const identityCounts = new Map<string, number>();
    for (const [, mapping] of localCandidates) {
      const identity = normalizeExternalFileMappingPathIdentity(
        mapping.externalPath,
      );
      identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
    }
    const reportedDuplicateIdentities = new Set<string>();
    const candidates: ManagedCopyRestoreWorkItem[] = [];
    for (const [storageKey, mapping] of localCandidates) {
      const identity = normalizeExternalFileMappingPathIdentity(
        mapping.externalPath,
      );
      if ((identityCounts.get(identity) ?? 0) > 1) {
        if (!reportedDuplicateIdentities.has(identity)) {
          reportedDuplicateIdentities.add(identity);
          this.reportManagedCopyError(new Error(
            `发现多个本机受管临时副本映射：${mapping.externalPath}。已拒绝自动恢复，未覆盖任何状态。`,
          ));
        }
        continue;
      }
      candidates.push({ storageKey, mapping, identity });
    }
    return { scope, candidates, snapshotMappings, stateChanged };
  }

  private async saveManagedCopyRestoreState(): Promise<void> {
    try {
      await this.options.saveSettings();
    } catch (error) {
      this.reportManagedCopyError(error);
    }
  }

  private reconcileManagedCopyWatchersAfterRestore(
    snapshotMappings: Map<string, ExternalFileMapping>,
    activeStorageKeys: Set<string>,
  ): void {
    const mappings = this.options.getSettings().externalFileOpener.mappings;
    for (const [storageKey, watcher] of this.managedCopyWatchers) {
      const current = mappings[storageKey];
      const snapshot = snapshotMappings.get(storageKey);
      const snapshotWasNotRestored = snapshot === current &&
        !activeStorageKeys.has(storageKey);
      if (
        snapshotWasNotRestored ||
        current?.strategy !== "managed-copy" ||
        !this.managedCopyWatcherMatches(watcher, current)
      ) {
        watcher.dispose();
        this.managedCopyWatchers.delete(storageKey);
      }
    }
  }

  async pruneBrokenMappings(): Promise<number> {
    const settings = this.options.getSettings().externalFileOpener;
    let removed = 0;
    for (const [storageKey, mapping] of Object.entries(settings.mappings)) {
      const strategy = mapping.strategy ?? "symlink";
      if (strategy === "managed-copy") continue;
      if (
        !fs.existsSync(mapping.externalPath) ||
        !this.isSymlinkValid(mapping.vaultPath, mapping.externalPath)
      ) {
        this.managedCopyWatchers.get(storageKey)?.dispose();
        this.managedCopyWatchers.delete(storageKey);
        this.removeMirrorSymlink(mapping.vaultPath);
        delete settings.mappings[storageKey];
        removed++;
      }
    }
    if (removed > 0) await this.options.saveSettings();
    return removed;
  }

  async retryManagedCopiesAsSymlinks(): Promise<ManagedCopySymlinkRetrySummary> {
    const mappings = this.options.getSettings().externalFileOpener.mappings;
    const managedEntries = Object.entries(mappings).filter(
      ([, mapping]) => mapping.strategy === "managed-copy" && mapping.managedCopy,
    );
    const summary: ManagedCopySymlinkRetrySummary = {
      attempted: 0,
      migrated: 0,
      remaining: 0,
      failures: [],
      warnings: [],
    };
    if (managedEntries.length === 0) return summary;

    const scope = this.managedCopyScope();
    const localEntries = managedEntries.filter(([, mapping]) =>
      mapping.managedCopy && isManagedCopyOwnedByScope(mapping.managedCopy, scope));
    summary.remaining = localEntries.length;
    if (localEntries.length === 0) return summary;
    const createFileSymlink = this.options.createFileSymlink ??
      createVerifiedFileSymlink;
    for (const [storageKey, mapping] of localEntries) {
      if (!mapping.managedCopy) continue;
      summary.attempted++;
      const runningWatcher = this.managedCopyWatchers.get(storageKey);
      if (runningWatcher && !runningWatcher.isDisposed) {
        await runningWatcher.flush();
        mapping.managedCopy = runningWatcher.currentState;
      }
      runningWatcher?.dispose();
      this.managedCopyWatchers.delete(storageKey);

      try {
        const migration = await migrateManagedCopyToSymlink({
          state: mapping.managedCopy,
          scope,
          createFileSymlink,
        });
        if (migration.status === "migrated") {
          mapping.strategy = "symlink";
          delete mapping.managedCopy;
          summary.migrated++;
          summary.remaining--;
          if (migration.warning) summary.warnings.push(migration.warning);
          continue;
        }

        mapping.managedCopy = migration.state;
        const reason = migration.status === "symlink-failed"
          ? describeFileSymlinkFailure(migration.failure)
          : migration.reason;
        summary.failures.push(`${mapping.externalPath}：${reason}`);
        this.startManagedCopyWatcher(storageKey, mapping, scope);
      } catch (error) {
        summary.failures.push(
          `${mapping.externalPath}：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        try {
          this.startManagedCopyWatcher(storageKey, mapping, scope);
        } catch (watchError) {
          this.reportManagedCopyError(watchError);
        }
      }
    }
    await this.options.saveSettings();
    return summary;
  }

  private async linkExternalFile(externalPath: string): Promise<ExternalFileMapping> {
    const settings = this.options.getSettings().externalFileOpener;
    const entries = this.mappingEntriesForExternalPath(externalPath);
    for (const [, mapping] of entries) {
      if (
        mapping.strategy !== "managed-copy" &&
        this.isSymlinkValid(mapping.vaultPath, externalPath)
      ) {
        return mapping;
      }
    }
    const managedEntries = entries.filter(
      ([, mapping]) => mapping.strategy === "managed-copy" && mapping.managedCopy,
    );
    let scope: ManagedCopyScope | null = null;
    if (managedEntries.length > 0) {
      scope = this.managedCopyScope();
      const localEntries = managedEntries.filter(([, mapping]) =>
        mapping.managedCopy && isManagedCopyOwnedByScope(mapping.managedCopy, scope!));
      if (localEntries.length > 1) {
        throw new Error(
          `发现多个本机受管临时副本映射：${externalPath}。已拒绝自动选择，未覆盖任何状态。`,
        );
      }
      if (localEntries.length === 1) {
        const [storageKey, mapping] = localEntries[0]!;
        await this.reuseManagedCopyMapping(storageKey, mapping, scope);
        return mapping;
      }
    }

    for (const [storageKey, mapping] of entries) {
      if (mapping.strategy === "managed-copy") continue;
      this.removeMirrorSymlink(mapping.vaultPath);
      this.managedCopyWatchers.get(storageKey)?.dispose();
      this.managedCopyWatchers.delete(storageKey);
      delete settings.mappings[storageKey];
    }

    const extension = normalizeExternalFileExtension(externalPath);
    const preferred = externalFileMirrorPath(settings.mirrorFolder, externalPath);
    const vaultPath = this.availableMirrorPath(preferred, externalPath);
    const absolute = resolveExternalFileVaultPath(
      this.options.getVaultRoot(),
      vaultPath,
      { createParent: true },
    ).absolutePath;
    const createFileSymlink = this.options.createFileSymlink ?? createVerifiedFileSymlink;
    const symlink = await createFileSymlink({
      targetPath: externalPath,
      linkPath: absolute,
    });

    if (symlink.ok) {
      const mapping: ExternalFileMapping = {
        externalPath,
        vaultPath,
        createdAt: Date.now(),
        extension,
        strategy: "symlink",
      };
      const storageKey = this.availableStorageKey(externalPath, mapping);
      settings.mappings[storageKey] = mapping;
      return mapping;
    }

    if (!isManagedCopyEligibleSymlinkFailure(symlink)) {
      throw new Error(describeFileSymlinkFailure(symlink));
    }
    if (this.options.managedCopyFallbackEnabled?.() !== true) {
      throw new ExternalFileSymlinkFallbackRequiredError(symlink);
    }

    scope ??= this.managedCopyScope();
    const activation = activateManagedCopyAfterSymlinkFailure({
      symlinkFailure: {
        operation: "symlink",
        outcome: "failed",
        reason: symlink.message,
        code: symlink.win32Error ?? symlink.errorCode,
      },
      scope,
      externalPath,
      vaultPath,
    });
    const mapping: ExternalFileMapping = {
      externalPath,
      vaultPath,
      createdAt: Date.now(),
      extension,
      strategy: "managed-copy",
      managedCopy: activation.state,
    };
    const storageKey = managedCopyMappingStorageKey(scope.scopeKey, externalPath);
    if (Object.prototype.hasOwnProperty.call(settings.mappings, storageKey)) {
      throw new Error("本机受管临时副本的持久化键已被占用，未覆盖现有映射。");
    }
    settings.mappings[storageKey] = mapping;
    this.startManagedCopyWatcher(storageKey, mapping, scope);
    return mapping;
  }

  private managedCopyScope(): ManagedCopyScope {
    const hostId = this.options.getManagedCopyHostId?.().trim();
    if (!hostId) throw new Error("无法读取本机受管临时副本标识。");
    return resolveManagedCopyScope({
      hostId,
      vaultRoot: this.options.getVaultRoot(),
    });
  }

  private async reuseManagedCopyMapping(
    storageKey: string,
    mapping: ExternalFileMapping,
    scope: ManagedCopyScope,
  ): Promise<void> {
    if (!mapping.managedCopy) {
      throw new Error("本机受管临时副本映射缺少同步状态。");
    }
    const restoredDuringStartup = await (
      this.managedCopyRestoreTask?.prioritize(mapping.externalPath) ?? false
    );
    const runningWatcher = this.managedCopyWatchers.get(storageKey);
    if (this.managedCopyWatcherMatches(runningWatcher, mapping)) {
      if (!restoredDuringStartup) await runningWatcher!.flush();
      mapping.managedCopy = runningWatcher!.currentState;
      return;
    }
    if (runningWatcher) {
      runningWatcher.dispose();
      this.managedCopyWatchers.delete(storageKey);
    }
    const activation = await resumeManagedCopyFallbackAsync({
      scope,
      externalPath: mapping.externalPath,
      vaultPath: mapping.vaultPath,
      existing: mapping.managedCopy,
    });
    mapping.managedCopy = activation.state;
    this.startManagedCopyWatcher(
      storageKey,
      mapping,
      scope,
      activation.synchronization,
    );
  }

  private startManagedCopyWatcher(
    storageKey: string,
    mapping: ExternalFileMapping,
    scope: ManagedCopyScope,
    initialSynchronization?: ManagedCopySyncResult,
  ): void {
    if (!mapping.managedCopy) return;
    const existingWatcher = this.managedCopyWatchers.get(storageKey);
    if (this.managedCopyWatcherMatches(existingWatcher, mapping)) return;
    existingWatcher?.dispose();
    const watcher = watchManagedCopy({
      state: mapping.managedCopy,
      scope,
      synchronizeImmediately: !initialSynchronization,
      initialSynchronization,
      heartbeatIntervalMs: managedCopyHeartbeatInterval(storageKey),
      pollIntervalMs: managedCopyPollInterval(storageKey),
      onStateChange: async (nextState) => {
        const current = this.options.getSettings().externalFileOpener.mappings[storageKey];
        if (
          current?.strategy !== "managed-copy" ||
          current.vaultPath !== mapping.vaultPath ||
          !sameExternalFileMappingPath(current.externalPath, mapping.externalPath) ||
          !current.managedCopy ||
          !isManagedCopyOwnedByScope(current.managedCopy, scope)
        ) {
          return;
        }
        current.managedCopy = nextState;
        await this.options.saveSettings();
      },
      onConflict: async (conflict, resolve) => {
        if (this.options.onManagedCopyConflict) {
          await this.options.onManagedCopyConflict(conflict, resolve);
        } else {
          await resolve("later");
        }
      },
      onError: (error) => this.reportManagedCopyError(error),
    });
    this.managedCopyWatchers.set(storageKey, watcher);
  }

  private managedCopyWatcherMatches(
    watcher: ManagedCopyWatchController | undefined,
    mapping: ExternalFileMapping,
  ): boolean {
    if (!watcher || watcher.isDisposed || !mapping.managedCopy) return false;
    const current = watcher.currentState;
    return (
      sameExternalFileMappingPath(current.externalPath, mapping.externalPath) &&
      current.vaultPath === mapping.vaultPath &&
      current.scope.scopeKey === mapping.managedCopy.scope.scopeKey
    );
  }

  private mappingEntriesForExternalPath(
    externalPath: string,
  ): Array<[string, ExternalFileMapping]> {
    const matches: Array<[string, ExternalFileMapping]> = [];
    for (const [storageKey, mapping] of Object.entries(
      this.options.getSettings().externalFileOpener.mappings,
    )) {
      if (
        !mapping ||
        typeof mapping !== "object" ||
        typeof mapping.externalPath !== "string"
      ) continue;
      if (sameExternalFileMappingPath(mapping.externalPath, externalPath)) {
        matches.push([storageKey, mapping]);
      }
    }
    return matches;
  }

  private availableStorageKey(
    preferredKey: string,
    mapping: ExternalFileMapping,
  ): string {
    const mappings = this.options.getSettings().externalFileOpener.mappings;
    if (!Object.prototype.hasOwnProperty.call(mappings, preferredKey)) {
      return preferredKey;
    }
    const stableKey = symlinkMappingStorageKey(
      mapping.externalPath,
      mapping.vaultPath,
    );
    if (!Object.prototype.hasOwnProperty.call(mappings, stableKey)) {
      return stableKey;
    }
    for (let index = 1; index < 100; index++) {
      const candidate = `${stableKey}:${index}`;
      if (!Object.prototype.hasOwnProperty.call(mappings, candidate)) {
        return candidate;
      }
    }
    throw new Error("无法为外部文件分配持久化映射键。");
  }

  private disposeManagedCopyWatchersExcept(storageKeys: Set<string>): void {
    for (const [storageKey, watcher] of this.managedCopyWatchers) {
      if (storageKeys.has(storageKey)) continue;
      watcher.dispose();
      this.managedCopyWatchers.delete(storageKey);
    }
  }

  private reportManagedCopyError(error: unknown): void {
    try {
      if (this.options.onManagedCopyError) {
        this.options.onManagedCopyError(error);
        return;
      }
      console.warn(
        "[mv-aide] Managed-copy synchronization failed.",
        error,
      );
    } catch {
      // Error reporting must not destabilize watcher restoration.
    }
  }

  private availableMirrorPath(preferred: string, externalPath: string): string {
    const vaultRoot = this.options.getVaultRoot();
    const parsed = path.posix.parse(preferred);
    for (let index = 0; index < 100; index++) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = normalizeExternalFileVaultPath(
        path.posix.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`),
      );
      const absolute = resolveExternalFileVaultPath(
        vaultRoot,
        candidate,
        { createParent: true },
      ).absolutePath;
      try {
        if (
          fs.lstatSync(absolute).isSymbolicLink() &&
          this.isSymlinkValid(candidate, externalPath)
        ) return candidate;
      } catch {
        return candidate;
      }
    }
    throw new Error("无法为外部文件分配镜像路径。");
  }


  private removeMirrorSymlink(vaultPath: string): void {
    try {
      const absolute = resolveExternalFileVaultPath(
        this.options.getVaultRoot(),
        vaultPath,
      ).absolutePath;
      if (fs.lstatSync(absolute).isSymbolicLink()) fs.unlinkSync(absolute);
    } catch {
      // Already gone, invalid legacy path, or outside the canonical vault.
    }
  }

  private isSymlinkValid(vaultPath: string, externalPath: string): boolean {
    try {
      const absolute = resolveExternalFileVaultPath(
        this.options.getVaultRoot(),
        vaultPath,
      ).absolutePath;
      const verify = this.options.verifyFileSymlink ?? verifyFileSymlink;
      return verify({ targetPath: externalPath, linkPath: absolute }).ok;
    } catch {
      return false;
    }
  }

  private async waitForIndexedFile(vaultPath: string): Promise<TFile | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const file = this.options.app.vault.getAbstractFileByPath(vaultPath);
      if (file instanceof TFile) return file;
      await new Promise((resolve) => activeWindow.setTimeout(resolve, 250));
    }
    return null;
  }

  private waitForLayoutReady(): Promise<void> {
    if (!this.layoutReadyPromise) {
      const workspace = this.options.app.workspace;
      this.layoutReadyPromise = Promise.race([
        new Promise<void>((resolve) => {
          workspace.onLayoutReady(resolve);
        }),
        // 兜底：布局事件异常缺失时不至于永远挂住打开请求。
        new Promise<void>((resolve) => {
          this.layoutReadyTimer = activeWindow.setTimeout(resolve, 15000);
        }),
      ]);
    }
    return this.layoutReadyPromise;
  }

  private findOpenFileLeaf(file: TFile): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.options.app.workspace.iterateRootLeaves((leaf) => {
      if (found) return;
      const viewFile = (leaf.view as unknown as { file?: { path?: string } | null })
        ?.file;
      if (viewFile?.path === file.path) {
        found = leaf;
        return;
      }
      // 冷启动恢复的后台标签是 deferred view：view.file 为 null，但
      // 序列化的视图状态里已经记录了目标文件路径。
      const stateFile = (
        leaf.getViewState?.() as { state?: { file?: string } } | undefined
      )?.state?.file;
      if (stateFile === file.path) found = leaf;
    });
    return found;
  }

  private async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const workspace = this.options.app.workspace as unknown as {
      revealLeaf?: (target: WorkspaceLeaf) => Promise<void>;
    };
    await workspace.revealLeaf?.(leaf);
  }
}
