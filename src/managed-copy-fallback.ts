import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureContainedVaultDirectory } from "./external-file-mirror-path";

/**
 * Explicit proof that the primary symlink strategy was attempted and failed.
 * The fallback creation entry point rejects every other shape at runtime too,
 * so JavaScript callers cannot accidentally make managed copies eagerly.
 */
export interface SymlinkFailureProof {
  operation: "symlink";
  outcome: "failed";
  reason: string;
  code?: string | number;
}

export interface ManagedCopyScopeInput {
  /** Stable, device-local identifier. It must not be synced between devices. */
  hostId: string;
  /** Absolute root of the vault that will contain the managed copy. */
  vaultRoot: string;
}

export interface ManagedCopyScope {
  hostId: string;
  /** Canonical filesystem path, used to prevent reuse in another vault. */
  vaultRoot: string;
  /** SHA-256 identity derived from hostId and the canonical vault root. */
  scopeKey: string;
}

export interface ManagedCopyState {
  version: 1;
  strategy: "managed-copy";
  scope: ManagedCopyScope;
  externalPath: string;
  /** POSIX-style path relative to the vault root. */
  vaultPath: string;
  /** Last content known to be identical on both sides. */
  baselineSha256: string;
  createdAt: number;
  synchronizedAt: number;
}

export type ManagedCopyFallbackErrorCode =
  | "symlink-failure-required"
  | "invalid-scope"
  | "invalid-external-path"
  | "invalid-vault-path"
  | "path-outside-vault"
  | "foreign-state"
  | "state-path-mismatch"
  | "target-occupied"
  | "unsafe-symbolic-link"
  | "not-a-file"
  | "invalid-conflict"
  | "controller-disposed"
  | "source-changed-during-copy";

export class ManagedCopyFallbackError extends Error {
  constructor(
    public readonly code: ManagedCopyFallbackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedCopyFallbackError";
  }
}

export type ManagedCopySyncStatus =
  | "unchanged"
  | "external-to-copy"
  | "copy-to-external"
  | "copy-recreated"
  | "converged"
  | "conflict"
  | "stale"
  | "external-missing"
  | "both-missing";

export interface ManagedCopySyncResult {
  status: ManagedCopySyncStatus;
  state: ManagedCopyState;
  externalSha256: string | null;
  copySha256: string | null;
}

export interface ManagedCopyConflict {
  status: "conflict";
  state: ManagedCopyState;
  externalSha256: string;
  copySha256: string;
}

export type ManagedCopyConflictChoice = "external" | "copy" | "later";

export interface ManagedCopyConflictResolutionResult {
  status: "resolved-external" | "resolved-copy" | "deferred" | "stale";
  state: ManagedCopyState;
  externalSha256: string | null;
  copySha256: string | null;
}

export type ManagedCopyActivationResult =
  | {
      status: "created";
      state: ManagedCopyState;
    }
  | {
      status: "reused";
      state: ManagedCopyState;
      synchronization: ManagedCopySyncResult;
    };

export interface ManagedCopyResumeResult {
  status: "resumed";
  state: ManagedCopyState;
  synchronization: ManagedCopySyncResult;
}

export interface ActivateManagedCopyAfterSymlinkFailureOptions {
  symlinkFailure: SymlinkFailureProof;
  scope: ManagedCopyScopeInput;
  externalPath: string;
  vaultPath: string;
  now?: () => number;
}

export interface ResumeManagedCopyFallbackOptions {
  scope: ManagedCopyScopeInput;
  externalPath: string;
  vaultPath: string;
  existing: ManagedCopyState;
  now?: () => number;
}

/** @deprecated Prefer the explicit activation or resume entry point. */
export type ActivateManagedCopyFallbackOptions =
  | (ActivateManagedCopyAfterSymlinkFailureOptions & { existing?: null })
  | (ResumeManagedCopyFallbackOptions & {
      /** Ignored for existing state; retained only for source compatibility. */
      symlinkFailure?: SymlinkFailureProof;
    });

export interface ManagedCopyDirectoryWatcher {
  close(): void;
  on?(
    event: "error",
    listener: (error: Error) => void,
  ): ManagedCopyDirectoryWatcher;
}

export type ManagedCopyWatchFactory = (
  directoryPath: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => ManagedCopyDirectoryWatcher;

export interface ManagedCopyWatchOptions {
  state: ManagedCopyState;
  scope: ManagedCopyScopeInput;
  debounceMs?: number;
  selfWriteSuppressionMs?: number;
  /** Checksum polling interval used only when native watching is unavailable. */
  pollIntervalMs?: number;
  /** Low-frequency checksum safety net while native directory watching is active. */
  heartbeatIntervalMs?: number;
  synchronizeImmediately?: boolean;
  /**
   * Hashes produced by a synchronization that completed immediately before
   * this watcher was constructed. Supplying them avoids reading both files a
   * second time merely to seed the checksum heartbeat.
   */
  initialSynchronization?: Pick<
    ManagedCopySyncResult,
    "externalSha256" | "copySha256"
  >;
  watchFactory?: ManagedCopyWatchFactory;
  now?: () => number;
  onStateChange?: (state: ManagedCopyState) => void | Promise<void>;
  onConflict?: (
    conflict: ManagedCopyConflict,
    resolve: (
      choice: ManagedCopyConflictChoice,
    ) => Promise<ManagedCopyConflictResolutionResult>,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

/** Limits controller-driven retries; the heartbeat remains the slow safety net. */
const MAX_IMMEDIATE_STALE_RETRIES = 3;

interface ResolvedManagedCopyPath {
  vaultPath: string;
  absolutePath: string;
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function normalizedScopePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedScopePath(left) === normalizedScopePath(right);
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertSymlinkFailure(proof: SymlinkFailureProof): void {
  if (
    !proof ||
    proof.operation !== "symlink" ||
    proof.outcome !== "failed" ||
    typeof proof.reason !== "string" ||
    proof.reason.trim() === ""
  ) {
    throw new ManagedCopyFallbackError(
      "symlink-failure-required",
      "只有在符号链接明确失败后才能创建受管临时副本。",
    );
  }
}

export function managedCopyScopeKey(hostId: string, vaultRoot: string): string {
  return crypto
    .createHash("sha256")
    .update(hostId)
    .update("\0")
    .update(normalizedScopePath(vaultRoot))
    .digest("hex");
}

export function resolveManagedCopyScope(
  input: ManagedCopyScopeInput,
): ManagedCopyScope {
  const hostId = input.hostId.trim();
  if (!hostId) {
    throw new ManagedCopyFallbackError(
      "invalid-scope",
      "受管临时副本需要非空的本机标识。",
    );
  }
  if (!path.isAbsolute(input.vaultRoot)) {
    throw new ManagedCopyFallbackError(
      "invalid-scope",
      "受管临时副本需要绝对 vault 路径。",
    );
  }

  let vaultRoot: string;
  try {
    const stat = fs.statSync(input.vaultRoot);
    if (!stat.isDirectory()) throw new Error("not a directory");
    vaultRoot = fs.realpathSync.native(input.vaultRoot);
  } catch {
    throw new ManagedCopyFallbackError(
      "invalid-scope",
      "受管临时副本的 vault 路径不存在或不是目录。",
    );
  }

  return {
    hostId,
    vaultRoot,
    scopeKey: managedCopyScopeKey(hostId, vaultRoot),
  };
}

export function isManagedCopyOwnedByScope(
  state: ManagedCopyState | null | undefined,
  scope: ManagedCopyScope,
): boolean {
  const runtimeState = state as Partial<ManagedCopyState> | null | undefined;
  const runtimeScope = runtimeState?.scope as Partial<ManagedCopyScope> | undefined;
  if (
    runtimeState?.version !== 1 ||
    runtimeState.strategy !== "managed-copy" ||
    !runtimeScope ||
    typeof runtimeScope.hostId !== "string" ||
    typeof runtimeScope.scopeKey !== "string" ||
    typeof runtimeScope.vaultRoot !== "string"
  ) {
    return false;
  }
  return (
    runtimeScope.hostId === scope.hostId &&
    runtimeScope.scopeKey === scope.scopeKey &&
    samePath(runtimeScope.vaultRoot, scope.vaultRoot)
  );
}

export function normalizeManagedCopyVaultPath(vaultPath: string): string {
  const replaced = vaultPath.trim().replace(/\\/g, "/");
  if (
    !replaced ||
    replaced.startsWith("/") ||
    /^[a-zA-Z]:\//.test(replaced) ||
    replaced.startsWith("//")
  ) {
    throw new ManagedCopyFallbackError(
      "invalid-vault-path",
      "受管临时副本路径必须是 vault 内的相对路径。",
    );
  }
  const normalized = path.posix.normalize(replaced);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new ManagedCopyFallbackError(
      "invalid-vault-path",
      "受管临时副本路径不能离开 vault。",
    );
  }
  return normalized;
}

function resolveManagedCopyPath(
  scope: ManagedCopyScope,
  vaultPath: string,
  createParent: boolean,
): ResolvedManagedCopyPath {
  const normalized = normalizeManagedCopyVaultPath(vaultPath);
  const absolutePath = path.join(scope.vaultRoot, ...normalized.split("/"));
  if (!isContainedPath(scope.vaultRoot, absolutePath)) {
    throw new ManagedCopyFallbackError(
      "path-outside-vault",
      "受管临时副本路径解析到了 vault 外部。",
    );
  }

  const parent = path.dirname(absolutePath);
  try {
    ensureContainedVaultDirectory(scope.vaultRoot, parent, createParent);
  } catch (error) {
    if (error instanceof ManagedCopyFallbackError) throw error;
    if (!createParent && isMissingError(error)) {
      return { vaultPath: normalized, absolutePath };
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw error;
    throw new ManagedCopyFallbackError(
      "path-outside-vault",
      error instanceof Error
        ? error.message
        : "受管临时副本的父目录无法安全创建。",
    );
  }
  return { vaultPath: normalized, absolutePath };
}

function assertRegularFileOrMissing(
  filePath: string,
  role: "external" | "copy",
): "file" | "missing" {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new ManagedCopyFallbackError(
        "unsafe-symbolic-link",
        `拒绝把${role === "external" ? "外部文件" : "临时副本"}符号链接当作受管副本写入。`,
      );
    }
    if (!stat.isFile()) {
      throw new ManagedCopyFallbackError(
        "not-a-file",
        `${role === "external" ? "外部路径" : "临时副本路径"}不是普通文件。`,
      );
    }
    return "file";
  } catch (error) {
    if (isMissingError(error)) return "missing";
    throw error;
  }
}

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Hash a file without monopolizing the renderer thread for the full read. */
export async function sha256FileAsync(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function temporarySiblingPath(destination: string, purpose: "new" | "backup"): string {
  const random = crypto.randomBytes(8).toString("hex");
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.mv-obcc-${purpose}-${process.pid}-${random}.tmp`,
  );
}

type ManagedCopyFileRole = "external" | "copy";

interface VerifiedCopyOptions {
  sourceRole: ManagedCopyFileRole;
  destinationRole: ManagedCopyFileRole;
  expectedSourceSha256: string;
  expectedDestinationSha256: string | null;
}

type VerifiedCopyResult =
  | { status: "copied"; sha256: string }
  | {
      status: "stale";
      sourceSha256: string | null;
      destinationSha256: string | null;
    };

function regularFileSha256OrNull(
  filePath: string,
  role: ManagedCopyFileRole,
): string | null {
  if (assertRegularFileOrMissing(filePath, role) === "missing") return null;
  try {
    return sha256File(filePath);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

async function assertRegularFileOrMissingAsync(
  filePath: string,
  role: ManagedCopyFileRole,
): Promise<"file" | "missing"> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new ManagedCopyFallbackError(
        "unsafe-symbolic-link",
        `拒绝把${role === "external" ? "外部文件" : "临时副本"}符号链接当作受管副本写入。`,
      );
    }
    if (!stat.isFile()) {
      throw new ManagedCopyFallbackError(
        "not-a-file",
        `${role === "external" ? "外部路径" : "临时副本路径"}不是普通文件。`,
      );
    }
    return "file";
  } catch (error) {
    if (isMissingError(error)) return "missing";
    throw error;
  }
}

async function regularFileSha256OrNullAsync(
  filePath: string,
  role: ManagedCopyFileRole,
): Promise<string | null> {
  if (await assertRegularFileOrMissingAsync(filePath, role) === "missing") {
    return null;
  }
  try {
    return await sha256FileAsync(filePath);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

/**
 * Publish a prepared sibling without replacing a path another process created.
 * A hard link gives us an atomic no-overwrite name claim; COPYFILE_EXCL is the
 * portable fallback for filesystems that do not support hard links.
 */
function publishWithoutOverwrite(
  preparedPath: string,
  destination: string,
): void {
  try {
    fs.linkSync(preparedPath, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    fs.copyFileSync(preparedPath, destination, fs.constants.COPYFILE_EXCL);
  }
  fs.unlinkSync(preparedPath);
}

function restoreBackupWithoutOverwrite(
  backupPath: string,
  destination: string,
): boolean {
  try {
    publishWithoutOverwrite(backupPath, destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy one regular file over another without following a destination link.
 * The source and destination hashes observed by the caller are checked again
 * immediately before the destination is claimed. A mismatch returns `stale`
 * and leaves both live paths untouched.
 */
function replaceWithVerifiedCopy(
  source: string,
  destination: string,
  options: VerifiedCopyOptions,
): VerifiedCopyResult {
  if (assertRegularFileOrMissing(source, options.sourceRole) !== "file") {
    throw new ManagedCopyFallbackError("not-a-file", "副本同步源文件不存在。");
  }
  const initialSourceSha256 = regularFileSha256OrNull(
    source,
    options.sourceRole,
  );
  const initialDestinationSha256 = regularFileSha256OrNull(
    destination,
    options.destinationRole,
  );
  if (
    initialSourceSha256 !== options.expectedSourceSha256 ||
    initialDestinationSha256 !== options.expectedDestinationSha256
  ) {
    return {
      status: "stale",
      sourceSha256: initialSourceSha256,
      destinationSha256: initialDestinationSha256,
    };
  }

  const temporaryPath = temporarySiblingPath(destination, "new");
  let backupPath: string | null = null;
  try {
    fs.copyFileSync(source, temporaryPath, fs.constants.COPYFILE_EXCL);
    const temporaryHash = sha256File(temporaryPath);
    const sourceSha256 = regularFileSha256OrNull(source, options.sourceRole);
    const destinationSha256 = regularFileSha256OrNull(
      destination,
      options.destinationRole,
    );
    if (
      temporaryHash !== options.expectedSourceSha256 ||
      sourceSha256 !== options.expectedSourceSha256 ||
      destinationSha256 !== options.expectedDestinationSha256
    ) {
      return { status: "stale", sourceSha256, destinationSha256 };
    }

    if (destinationSha256 !== null) {
      backupPath = temporarySiblingPath(destination, "backup");
      fs.renameSync(destination, backupPath);
      const claimedDestinationSha256 = regularFileSha256OrNull(
        backupPath,
        options.destinationRole,
      );
      if (claimedDestinationSha256 !== options.expectedDestinationSha256) {
        const restored = restoreBackupWithoutOverwrite(backupPath, destination);
        if (restored) backupPath = null;
        return {
          status: "stale",
          sourceSha256: regularFileSha256OrNull(source, options.sourceRole),
          destinationSha256: regularFileSha256OrNull(
            destination,
            options.destinationRole,
          ),
        };
      }
    }
    try {
      publishWithoutOverwrite(temporaryPath, destination);
    } catch (error) {
      if (backupPath) {
        const restored = restoreBackupWithoutOverwrite(backupPath, destination);
        if (restored) backupPath = null;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          status: "stale",
          sourceSha256: regularFileSha256OrNull(source, options.sourceRole),
          destinationSha256: regularFileSha256OrNull(
            destination,
            options.destinationRole,
          ),
        };
      }
      throw error;
    }
    if (backupPath) {
      fs.unlinkSync(backupPath);
      backupPath = null;
    }
    return { status: "copied", sha256: options.expectedSourceSha256 };
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file was either promoted or never created.
    }
    if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(destination)) {
      restoreBackupWithoutOverwrite(backupPath, destination);
    }
  }
}

async function publishWithoutOverwriteAsync(
  preparedPath: string,
  destination: string,
): Promise<void> {
  try {
    await fs.promises.link(preparedPath, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    await fs.promises.copyFile(
      preparedPath,
      destination,
      fs.constants.COPYFILE_EXCL,
    );
  }
  await fs.promises.unlink(preparedPath);
}

async function restoreBackupWithoutOverwriteAsync(
  backupPath: string,
  destination: string,
): Promise<boolean> {
  try {
    await publishWithoutOverwriteAsync(backupPath, destination);
    return true;
  } catch {
    return false;
  }
}

/** Async equivalent used only by startup restoration. */
async function replaceWithVerifiedCopyAsync(
  source: string,
  destination: string,
  options: VerifiedCopyOptions,
): Promise<VerifiedCopyResult> {
  if (await assertRegularFileOrMissingAsync(source, options.sourceRole) !== "file") {
    throw new ManagedCopyFallbackError("not-a-file", "副本同步源文件不存在。");
  }
  const [initialSourceSha256, initialDestinationSha256] = await Promise.all([
    regularFileSha256OrNullAsync(source, options.sourceRole),
    regularFileSha256OrNullAsync(destination, options.destinationRole),
  ]);
  if (
    initialSourceSha256 !== options.expectedSourceSha256 ||
    initialDestinationSha256 !== options.expectedDestinationSha256
  ) {
    return {
      status: "stale",
      sourceSha256: initialSourceSha256,
      destinationSha256: initialDestinationSha256,
    };
  }

  const temporaryPath = temporarySiblingPath(destination, "new");
  let backupPath: string | null = null;
  try {
    await fs.promises.copyFile(source, temporaryPath, fs.constants.COPYFILE_EXCL);
    const [temporaryHash, sourceSha256, destinationSha256] = await Promise.all([
      sha256FileAsync(temporaryPath),
      regularFileSha256OrNullAsync(source, options.sourceRole),
      regularFileSha256OrNullAsync(destination, options.destinationRole),
    ]);
    if (
      temporaryHash !== options.expectedSourceSha256 ||
      sourceSha256 !== options.expectedSourceSha256 ||
      destinationSha256 !== options.expectedDestinationSha256
    ) {
      return { status: "stale", sourceSha256, destinationSha256 };
    }

    if (destinationSha256 !== null) {
      backupPath = temporarySiblingPath(destination, "backup");
      await fs.promises.rename(destination, backupPath);
      const claimedDestinationSha256 = await regularFileSha256OrNullAsync(
        backupPath,
        options.destinationRole,
      );
      if (claimedDestinationSha256 !== options.expectedDestinationSha256) {
        const restored = await restoreBackupWithoutOverwriteAsync(
          backupPath,
          destination,
        );
        if (restored) backupPath = null;
        return {
          status: "stale",
          sourceSha256: await regularFileSha256OrNullAsync(
            source,
            options.sourceRole,
          ),
          destinationSha256: await regularFileSha256OrNullAsync(
            destination,
            options.destinationRole,
          ),
        };
      }
    }
    try {
      await publishWithoutOverwriteAsync(temporaryPath, destination);
    } catch (error) {
      if (backupPath) {
        const restored = await restoreBackupWithoutOverwriteAsync(
          backupPath,
          destination,
        );
        if (restored) backupPath = null;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          status: "stale",
          sourceSha256: await regularFileSha256OrNullAsync(
            source,
            options.sourceRole,
          ),
          destinationSha256: await regularFileSha256OrNullAsync(
            destination,
            options.destinationRole,
          ),
        };
      }
      throw error;
    }
    if (backupPath) {
      await fs.promises.unlink(backupPath);
      backupPath = null;
    }
    return { status: "copied", sha256: options.expectedSourceSha256 };
  } finally {
    try {
      await fs.promises.unlink(temporaryPath);
    } catch {
      // The temporary file was either promoted or never created.
    }
    if (backupPath) {
      try {
        await fs.promises.access(destination);
      } catch {
        await restoreBackupWithoutOverwriteAsync(backupPath, destination);
      }
    }
  }
}

function assertStatePaths(
  state: ManagedCopyState,
  externalPath: string,
  vaultPath: string,
): void {
  if (
    !samePath(state.externalPath, externalPath) ||
    state.vaultPath !== normalizeManagedCopyVaultPath(vaultPath)
  ) {
    throw new ManagedCopyFallbackError(
      "state-path-mismatch",
      "现有受管临时副本属于另一个文件映射。",
    );
  }
}

/**
 * First-time activation. This is the only entry point that consumes symlink
 * failure proof; resuming persisted state is intentionally a separate API.
 */
export function activateManagedCopyAfterSymlinkFailure(
  options: ActivateManagedCopyAfterSymlinkFailureOptions,
): Extract<ManagedCopyActivationResult, { status: "created" }> {
  assertSymlinkFailure(options.symlinkFailure);
  const scope = resolveManagedCopyScope(options.scope);
  if (!path.isAbsolute(options.externalPath)) {
    throw new ManagedCopyFallbackError(
      "invalid-external-path",
      "受管临时副本需要绝对外部文件路径。",
    );
  }
  const externalPath = path.resolve(options.externalPath);
  const destination = resolveManagedCopyPath(scope, options.vaultPath, true);

  if (assertRegularFileOrMissing(externalPath, "external") !== "file") {
    throw new ManagedCopyFallbackError("not-a-file", "外部文件不存在。 ");
  }
  if (assertRegularFileOrMissing(destination.absolutePath, "copy") !== "missing") {
    throw new ManagedCopyFallbackError(
      "target-occupied",
      "目标镜像路径已被现有文件占用，未覆盖该文件。",
    );
  }

  const expectedSourceSha256 = sha256File(externalPath);
  const copyResult = replaceWithVerifiedCopy(
    externalPath,
    destination.absolutePath,
    {
      sourceRole: "external",
      destinationRole: "copy",
      expectedSourceSha256,
      expectedDestinationSha256: null,
    },
  );
  if (copyResult.status === "stale") {
    throw new ManagedCopyFallbackError(
      "source-changed-during-copy",
      "创建临时副本时任一侧发生并发变化，未覆盖任何文件。",
    );
  }
  const baselineSha256 = copyResult.sha256;
  const now = (options.now ?? Date.now)();
  return {
    status: "created",
    state: {
      version: 1,
      strategy: "managed-copy",
      scope,
      externalPath,
      vaultPath: destination.vaultPath,
      baselineSha256,
      createdAt: now,
      synchronizedAt: now,
    },
  };
}

/** Resume an already-owned mapping without requiring or fabricating proof. */
export function resumeManagedCopyFallback(
  options: ResumeManagedCopyFallbackOptions,
): ManagedCopyResumeResult {
  const scope = resolveManagedCopyScope(options.scope);
  if (!path.isAbsolute(options.externalPath)) {
    throw new ManagedCopyFallbackError(
      "invalid-external-path",
      "受管临时副本需要绝对外部文件路径。",
    );
  }
  if (!isManagedCopyOwnedByScope(options.existing, scope)) {
    throw new ManagedCopyFallbackError(
      "foreign-state",
      "拒绝复用其他主机或其他 vault 创建的临时副本。",
    );
  }
  const externalPath = path.resolve(options.externalPath);
  const destination = resolveManagedCopyPath(scope, options.vaultPath, true);
  assertStatePaths(options.existing, externalPath, destination.vaultPath);
  const synchronization = synchronizeManagedCopy(options.existing, options.scope, {
    now: options.now,
  });
  return {
    status: "resumed",
    state: synchronization.state,
    synchronization,
  };
}

/** Resume an already-owned mapping using non-blocking startup I/O. */
export async function resumeManagedCopyFallbackAsync(
  options: ResumeManagedCopyFallbackOptions,
): Promise<ManagedCopyResumeResult> {
  const scope = resolveManagedCopyScope(options.scope);
  if (!path.isAbsolute(options.externalPath)) {
    throw new ManagedCopyFallbackError(
      "invalid-external-path",
      "受管临时副本需要绝对外部文件路径。",
    );
  }
  if (!isManagedCopyOwnedByScope(options.existing, scope)) {
    throw new ManagedCopyFallbackError(
      "foreign-state",
      "拒绝复用其他主机或其他 vault 创建的临时副本。",
    );
  }
  const externalPath = path.resolve(options.externalPath);
  const destination = resolveManagedCopyPath(scope, options.vaultPath, true);
  assertStatePaths(options.existing, externalPath, destination.vaultPath);
  const synchronization = await synchronizeManagedCopyAsync(
    options.existing,
    options.scope,
    { now: options.now },
  );
  return {
    status: "resumed",
    state: synchronization.state,
    synchronization,
  };
}

/**
 * Compatibility wrapper for existing callers. Persisted state is routed to
 * `resumeManagedCopyFallback` before proof validation, so resume never depends
 * on a synthetic symlink-failure reason.
 */
export function activateManagedCopyFallback(
  options: ActivateManagedCopyFallbackOptions,
): ManagedCopyActivationResult {
  if (options.existing) {
    const resumed = resumeManagedCopyFallback({
      scope: options.scope,
      externalPath: options.externalPath,
      vaultPath: options.vaultPath,
      existing: options.existing,
      now: options.now,
    });
    return { ...resumed, status: "reused" };
  }
  return activateManagedCopyAfterSymlinkFailure(options);
}

/**
 * Reuse an existing managed copy without retrying symlink creation. A
 * simultaneous edit is reported as a conflict and neither side is changed.
 */
export function synchronizeManagedCopy(
  state: ManagedCopyState,
  scopeInput: ManagedCopyScopeInput,
  options: { now?: () => number } = {},
): ManagedCopySyncResult {
  const scope = resolveManagedCopyScope(scopeInput);
  if (!isManagedCopyOwnedByScope(state, scope)) {
    throw new ManagedCopyFallbackError(
      "foreign-state",
      "拒绝同步其他主机或其他 vault 创建的临时副本。",
    );
  }
  const destination = resolveManagedCopyPath(scope, state.vaultPath, true);
  const externalState = assertRegularFileOrMissing(state.externalPath, "external");
  const copyState = assertRegularFileOrMissing(destination.absolutePath, "copy");

  if (externalState === "missing" && copyState === "missing") {
    return {
      status: "both-missing",
      state,
      externalSha256: null,
      copySha256: null,
    };
  }
  if (externalState === "missing") {
    return {
      status: "external-missing",
      state,
      externalSha256: null,
      copySha256: sha256File(destination.absolutePath),
    };
  }
  if (copyState === "missing") {
    const externalSha256 = sha256File(state.externalPath);
    const copyResult = replaceWithVerifiedCopy(
      state.externalPath,
      destination.absolutePath,
      {
        sourceRole: "external",
        destinationRole: "copy",
        expectedSourceSha256: externalSha256,
        expectedDestinationSha256: null,
      },
    );
    if (copyResult.status === "stale") {
      return {
        status: "stale",
        state,
        externalSha256: copyResult.sourceSha256,
        copySha256: copyResult.destinationSha256,
      };
    }
    const baselineSha256 = copyResult.sha256;
    const nextState = {
      ...state,
      baselineSha256,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "copy-recreated",
      state: nextState,
      externalSha256: baselineSha256,
      copySha256: baselineSha256,
    };
  }

  const externalSha256 = sha256File(state.externalPath);
  const copySha256 = sha256File(destination.absolutePath);
  const baseline = state.baselineSha256;
  if (externalSha256 === copySha256) {
    if (externalSha256 === baseline) {
      return {
        status: "unchanged",
        state,
        externalSha256,
        copySha256,
      };
    }
    const nextState = {
      ...state,
      baselineSha256: externalSha256,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "converged",
      state: nextState,
      externalSha256,
      copySha256,
    };
  }

  if (externalSha256 !== baseline && copySha256 === baseline) {
    const copyResult = replaceWithVerifiedCopy(
      state.externalPath,
      destination.absolutePath,
      {
        sourceRole: "external",
        destinationRole: "copy",
        expectedSourceSha256: externalSha256,
        expectedDestinationSha256: copySha256,
      },
    );
    if (copyResult.status === "stale") {
      return {
        status: "stale",
        state,
        externalSha256: copyResult.sourceSha256,
        copySha256: copyResult.destinationSha256,
      };
    }
    const synchronizedHash = copyResult.sha256;
    const nextState = {
      ...state,
      baselineSha256: synchronizedHash,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "external-to-copy",
      state: nextState,
      externalSha256: synchronizedHash,
      copySha256: synchronizedHash,
    };
  }
  if (externalSha256 === baseline && copySha256 !== baseline) {
    const copyResult = replaceWithVerifiedCopy(
      destination.absolutePath,
      state.externalPath,
      {
        sourceRole: "copy",
        destinationRole: "external",
        expectedSourceSha256: copySha256,
        expectedDestinationSha256: externalSha256,
      },
    );
    if (copyResult.status === "stale") {
      return {
        status: "stale",
        state,
        externalSha256: copyResult.destinationSha256,
        copySha256: copyResult.sourceSha256,
      };
    }
    const synchronizedHash = copyResult.sha256;
    const nextState = {
      ...state,
      baselineSha256: synchronizedHash,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "copy-to-external",
      state: nextState,
      externalSha256: synchronizedHash,
      copySha256: synchronizedHash,
    };
  }

  return {
    status: "conflict",
    state,
    externalSha256,
    copySha256,
  };
}

/**
 * Startup-safe synchronization. Hashing and copies use promise-based,
 * streaming I/O while preserving the same stale checks and atomic publication
 * rules as synchronizeManagedCopy.
 */
export async function synchronizeManagedCopyAsync(
  state: ManagedCopyState,
  scopeInput: ManagedCopyScopeInput,
  options: { now?: () => number } = {},
): Promise<ManagedCopySyncResult> {
  const scope = resolveManagedCopyScope(scopeInput);
  if (!isManagedCopyOwnedByScope(state, scope)) {
    throw new ManagedCopyFallbackError(
      "foreign-state",
      "拒绝同步其他主机或其他 vault 创建的临时副本。",
    );
  }
  const destination = resolveManagedCopyPath(scope, state.vaultPath, true);
  const [externalState, copyState] = await Promise.all([
    assertRegularFileOrMissingAsync(state.externalPath, "external"),
    assertRegularFileOrMissingAsync(destination.absolutePath, "copy"),
  ]);

  if (externalState === "missing" && copyState === "missing") {
    return {
      status: "both-missing",
      state,
      externalSha256: null,
      copySha256: null,
    };
  }
  if (externalState === "missing") {
    return {
      status: "external-missing",
      state,
      externalSha256: null,
      copySha256: await sha256FileAsync(destination.absolutePath),
    };
  }
  if (copyState === "missing") {
    const externalSha256 = await sha256FileAsync(state.externalPath);
    const copyResult = await replaceWithVerifiedCopyAsync(
      state.externalPath,
      destination.absolutePath,
      {
        sourceRole: "external",
        destinationRole: "copy",
        expectedSourceSha256: externalSha256,
        expectedDestinationSha256: null,
      },
    );
    if (copyResult.status === "stale") {
      return {
        status: "stale",
        state,
        externalSha256: copyResult.sourceSha256,
        copySha256: copyResult.destinationSha256,
      };
    }
    const baselineSha256 = copyResult.sha256;
    const nextState = {
      ...state,
      baselineSha256,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "copy-recreated",
      state: nextState,
      externalSha256: baselineSha256,
      copySha256: baselineSha256,
    };
  }

  const [externalSha256, copySha256] = await Promise.all([
    sha256FileAsync(state.externalPath),
    sha256FileAsync(destination.absolutePath),
  ]);
  const baseline = state.baselineSha256;
  if (externalSha256 === copySha256) {
    if (externalSha256 === baseline) {
      return {
        status: "unchanged",
        state,
        externalSha256,
        copySha256,
      };
    }
    const nextState = {
      ...state,
      baselineSha256: externalSha256,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "converged",
      state: nextState,
      externalSha256,
      copySha256,
    };
  }

  if (externalSha256 !== baseline && copySha256 === baseline) {
    const copyResult = await replaceWithVerifiedCopyAsync(
      state.externalPath,
      destination.absolutePath,
      {
        sourceRole: "external",
        destinationRole: "copy",
        expectedSourceSha256: externalSha256,
        expectedDestinationSha256: copySha256,
      },
    );
    if (copyResult.status === "stale") {
      return {
        status: "stale",
        state,
        externalSha256: copyResult.sourceSha256,
        copySha256: copyResult.destinationSha256,
      };
    }
    const synchronizedHash = copyResult.sha256;
    const nextState = {
      ...state,
      baselineSha256: synchronizedHash,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "external-to-copy",
      state: nextState,
      externalSha256: synchronizedHash,
      copySha256: synchronizedHash,
    };
  }
  if (externalSha256 === baseline && copySha256 !== baseline) {
    const copyResult = await replaceWithVerifiedCopyAsync(
      destination.absolutePath,
      state.externalPath,
      {
        sourceRole: "copy",
        destinationRole: "external",
        expectedSourceSha256: copySha256,
        expectedDestinationSha256: externalSha256,
      },
    );
    if (copyResult.status === "stale") {
      return {
        status: "stale",
        state,
        externalSha256: copyResult.destinationSha256,
        copySha256: copyResult.sourceSha256,
      };
    }
    const synchronizedHash = copyResult.sha256;
    const nextState = {
      ...state,
      baselineSha256: synchronizedHash,
      synchronizedAt: (options.now ?? Date.now)(),
    };
    return {
      status: "copy-to-external",
      state: nextState,
      externalSha256: synchronizedHash,
      copySha256: synchronizedHash,
    };
  }

  return {
    status: "conflict",
    state,
    externalSha256,
    copySha256,
  };
}

export function isManagedCopyConflict(
  result: ManagedCopySyncResult,
): result is ManagedCopyConflict {
  return (
    result.status === "conflict" &&
    typeof result.externalSha256 === "string" &&
    typeof result.copySha256 === "string"
  );
}

/**
 * Resolve a conflict against the exact hashes that were shown to the user.
 * If either side changed while the choice was pending, this returns `stale`
 * and performs no write. `later` is always non-mutating.
 */
export function resolveManagedCopyConflict(
  conflict: ManagedCopyConflict,
  scopeInput: ManagedCopyScopeInput,
  choice: ManagedCopyConflictChoice,
  options: { now?: () => number } = {},
): ManagedCopyConflictResolutionResult {
  if (
    conflict.status !== "conflict" ||
    !conflict.externalSha256 ||
    !conflict.copySha256
  ) {
    throw new ManagedCopyFallbackError(
      "invalid-conflict",
      "只能解析包含双边内容哈希的受管副本冲突。",
    );
  }
  if (choice !== "external" && choice !== "copy" && choice !== "later") {
    throw new ManagedCopyFallbackError(
      "invalid-conflict",
      "未知的受管副本冲突选择。",
    );
  }

  const state = conflict.state;
  const scope = resolveManagedCopyScope(scopeInput);
  if (!isManagedCopyOwnedByScope(state, scope)) {
    throw new ManagedCopyFallbackError(
      "foreign-state",
      "拒绝解析其他主机或其他 vault 的临时副本冲突。",
    );
  }
  const destination = resolveManagedCopyPath(scope, state.vaultPath, false);
  if (choice === "later") {
    return {
      status: "deferred",
      state,
      externalSha256: conflict.externalSha256,
      copySha256: conflict.copySha256,
    };
  }

  const externalState = assertRegularFileOrMissing(state.externalPath, "external");
  const copyState = assertRegularFileOrMissing(destination.absolutePath, "copy");
  const externalSha256 = externalState === "file"
    ? sha256File(state.externalPath)
    : null;
  const copySha256 = copyState === "file"
    ? sha256File(destination.absolutePath)
    : null;
  if (
    externalSha256 !== conflict.externalSha256 ||
    copySha256 !== conflict.copySha256
  ) {
    return {
      status: "stale",
      state,
      externalSha256,
      copySha256,
    };
  }

  const copyResult = choice === "external"
    ? replaceWithVerifiedCopy(state.externalPath, destination.absolutePath, {
        sourceRole: "external",
        destinationRole: "copy",
        expectedSourceSha256: externalSha256,
        expectedDestinationSha256: copySha256,
      })
    : replaceWithVerifiedCopy(destination.absolutePath, state.externalPath, {
        sourceRole: "copy",
        destinationRole: "external",
        expectedSourceSha256: copySha256,
        expectedDestinationSha256: externalSha256,
      });
  if (copyResult.status === "stale") {
    return {
      status: "stale",
      state,
      externalSha256: choice === "external"
        ? copyResult.sourceSha256
        : copyResult.destinationSha256,
      copySha256: choice === "external"
        ? copyResult.destinationSha256
        : copyResult.sourceSha256,
    };
  }
  const synchronizedHash = copyResult.sha256;
  const nextState = {
    ...state,
    baselineSha256: synchronizedHash,
    synchronizedAt: (options.now ?? Date.now)(),
  };
  return {
    status: choice === "external" ? "resolved-external" : "resolved-copy",
    state: nextState,
    externalSha256: synchronizedHash,
    copySha256: synchronizedHash,
  };
}

type ManagedCopyWatchSide = "external" | "copy";

interface ManagedCopyWatchTarget {
  side: ManagedCopyWatchSide;
  directoryPath: string;
  filename: string;
  absolutePath: string;
}

interface SelfWriteSuppression {
  sha256: string;
  expiresAt: number;
}

const defaultManagedCopyWatchFactory: ManagedCopyWatchFactory = (
  directoryPath,
  listener,
) => fs.watch(
  directoryPath,
  { persistent: false },
  (eventType, filename) => listener(eventType, filename),
);

function sameWatchedFilename(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function managedCopyChecksumFingerprint(
  hashes: Pick<ManagedCopySyncResult, "externalSha256" | "copySha256">,
): string {
  return [
    `external:${hashes.externalSha256 ?? "missing"}`,
    `copy:${hashes.copySha256 ?? "missing"}`,
  ].join("\0");
}

/**
 * Directory-level watcher for a single managed mapping. Watching parent
 * directories (instead of file handles) keeps atomic-save editors working.
 */
export class ManagedCopyWatchController {
  private state: ManagedCopyState;
  private readonly scopeInput: ManagedCopyScopeInput;
  private readonly targets: ManagedCopyWatchTarget[];
  private readonly watchers: ManagedCopyDirectoryWatcher[] = [];
  private readonly debounceMs: number;
  private readonly selfWriteSuppressionMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly suppressions = new Map<ManagedCopyWatchSide, SelfWriteSuppression>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollFingerprint: string | null = null;
  private running: Promise<ManagedCopySyncResult | null> | null = null;
  private rerunRequested = false;
  private consecutiveStaleResults = 0;
  private disposed = false;
  private lastConflictKey: string | null = null;

  constructor(private readonly options: ManagedCopyWatchOptions) {
    const scope = resolveManagedCopyScope(options.scope);
    if (!isManagedCopyOwnedByScope(options.state, scope)) {
      throw new ManagedCopyFallbackError(
        "foreign-state",
        "拒绝监听其他主机或其他 vault 创建的临时副本。",
      );
    }
    const copy = resolveManagedCopyPath(scope, options.state.vaultPath, true);
    this.state = options.state;
    this.scopeInput = { hostId: scope.hostId, vaultRoot: scope.vaultRoot };
    if (options.initialSynchronization) {
      this.pollFingerprint = managedCopyChecksumFingerprint(
        options.initialSynchronization,
      );
    }
    this.debounceMs = Math.max(0, options.debounceMs ?? 150);
    this.selfWriteSuppressionMs = Math.max(
      this.debounceMs * 4,
      options.selfWriteSuppressionMs ?? 1_000,
    );
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 2_000);
    this.heartbeatIntervalMs = Math.max(
      25,
      options.heartbeatIntervalMs ?? 30_000,
    );
    this.targets = [
      {
        side: "external",
        directoryPath: path.dirname(options.state.externalPath),
        filename: path.basename(options.state.externalPath),
        absolutePath: options.state.externalPath,
      },
      {
        side: "copy",
        directoryPath: path.dirname(copy.absolutePath),
        filename: path.basename(copy.absolutePath),
        absolutePath: copy.absolutePath,
      },
    ];

    const groups = new Map<string, ManagedCopyWatchTarget[]>();
    for (const target of this.targets) {
      const key = normalizedScopePath(target.directoryPath);
      groups.set(key, [...(groups.get(key) ?? []), target]);
    }
    try {
      const watchFactory = options.watchFactory ?? defaultManagedCopyWatchFactory;
      for (const group of groups.values()) {
        const directoryPath = group[0]!.directoryPath;
        const watcher = watchFactory(
          directoryPath,
          (_eventType, filename) => this.handleDirectoryEvent(group, filename),
        );
        this.watchers.push(watcher);
        watcher.on?.("error", (error) => this.handleWatcherError(error));
      }
    } catch (error) {
      this.closeWatchers();
      this.reportError(error);
      this.startChecksumPolling();
    }

    if (!this.pollTimer) this.startChecksumHeartbeat();

    if (options.synchronizeImmediately) this.scheduleSynchronization(0);
  }

  get currentState(): ManagedCopyState {
    return this.state;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get monitoringMode(): "watch" | "poll" {
    return this.pollTimer ? "poll" : "watch";
  }

  /** Force the currently debounced synchronization to run now. */
  async flush(): Promise<ManagedCopySyncResult | null> {
    if (this.disposed) return null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }

    const run = this.runSynchronization();
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = null;
      if (this.rerunRequested && !this.disposed) {
        this.rerunRequested = false;
        // Yield before retrying a stale snapshot so continuously changing files
        // cannot create an unbounded microtask loop.
        this.scheduleSynchronization();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.closeWatchers();
    this.pollFingerprint = null;
    this.suppressions.clear();
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // Disposal is best effort and must remain idempotent.
      }
    }
  }

  private handleWatcherError(error: Error): void {
    if (this.disposed || this.pollTimer) return;
    this.reportError(error);
    this.closeWatchers();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.startChecksumPolling();
  }

  private startChecksumHeartbeat(): void {
    if (this.disposed || this.heartbeatTimer || this.pollTimer) return;
    if (this.pollFingerprint === null) {
      try {
        this.pollFingerprint = this.readChecksumFingerprint();
      } catch (error) {
        this.pollFingerprint = null;
        this.reportError(error);
      }
    }
    this.heartbeatTimer = setInterval(
      () => this.pollChecksums(),
      this.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref?.();
  }

  private startChecksumPolling(): void {
    if (this.disposed || this.pollTimer) return;
    if (this.pollFingerprint === null) {
      try {
        this.pollFingerprint = this.readChecksumFingerprint();
      } catch (error) {
        this.pollFingerprint = null;
        this.reportError(error);
      }
    }
    this.pollTimer = setInterval(() => this.pollChecksums(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private readChecksumFingerprint(): string {
    return this.targets.map((target) => {
      const sha256 = regularFileSha256OrNull(target.absolutePath, target.side);
      return `${target.side}:${sha256 ?? "missing"}`;
    }).join("\0");
  }

  private pollChecksums(): void {
    if (this.disposed) return;
    let fingerprint: string;
    try {
      fingerprint = this.readChecksumFingerprint();
    } catch (error) {
      this.reportError(error);
      this.scheduleSynchronization(0);
      return;
    }
    if (fingerprint === this.pollFingerprint) return;
    this.scheduleSynchronization(0);
  }

  private refreshPollingFingerprint(
    synchronization: Pick<
      ManagedCopySyncResult,
      "externalSha256" | "copySha256"
    >,
  ): void {
    if ((!this.pollTimer && !this.heartbeatTimer) || this.disposed) return;
    this.pollFingerprint = managedCopyChecksumFingerprint(synchronization);
  }

  private handleDirectoryEvent(
    group: ManagedCopyWatchTarget[],
    filename: string | Buffer | null,
  ): void {
    if (this.disposed) return;
    if (filename === null) {
      this.scheduleSynchronization();
      return;
    }
    const changedName = path.basename(
      Buffer.isBuffer(filename) ? filename.toString() : filename,
    );
    const matching = group.filter((target) =>
      sameWatchedFilename(target.filename, changedName));
    if (matching.length === 0) return;
    if (matching.every((target) => this.isSuppressedSelfWrite(target))) return;
    this.scheduleSynchronization();
  }

  private isSuppressedSelfWrite(target: ManagedCopyWatchTarget): boolean {
    const suppression = this.suppressions.get(target.side);
    if (!suppression) return false;
    if (Date.now() > suppression.expiresAt) {
      this.suppressions.delete(target.side);
      return false;
    }
    try {
      return (
        assertRegularFileOrMissing(target.absolutePath, target.side) === "file" &&
        sha256File(target.absolutePath) === suppression.sha256
      );
    } catch {
      this.suppressions.delete(target.side);
      return false;
    }
  }

  private scheduleSynchronization(delay = this.debounceMs): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, delay);
  }

  private rememberSelfWrite(result: ManagedCopySyncResult): void {
    const expiresAt = Date.now() + this.selfWriteSuppressionMs;
    if (
      (result.status === "external-to-copy" || result.status === "copy-recreated") &&
      result.copySha256
    ) {
      this.suppressions.set("copy", { sha256: result.copySha256, expiresAt });
    }
    if (result.status === "copy-to-external" && result.externalSha256) {
      this.suppressions.set("external", {
        sha256: result.externalSha256,
        expiresAt,
      });
    }
  }

  private async publishState(nextState: ManagedCopyState): Promise<void> {
    if (nextState === this.state) return;
    this.state = nextState;
    try {
      await this.options.onStateChange?.(nextState);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting must not start another failure loop.
    }
  }

  private async runSynchronization(): Promise<ManagedCopySyncResult | null> {
    let result: ManagedCopySyncResult;
    try {
      result = synchronizeManagedCopy(this.state, this.scopeInput, {
        now: this.options.now,
      });
    } catch (error) {
      this.reportError(error);
      return null;
    }

    this.rememberSelfWrite(result);
    await this.publishState(result.state);
    if (result.status === "stale") {
      this.consecutiveStaleResults++;
      if (this.consecutiveStaleResults <= MAX_IMMEDIATE_STALE_RETRIES) {
        this.rerunRequested = true;
      }
      // Do not acknowledge the checksum fingerprint. A later heartbeat may
      // retry after this bounded immediate burst once the files stabilize.
    } else {
      this.consecutiveStaleResults = 0;
      this.refreshPollingFingerprint(result);
    }
    if (!isManagedCopyConflict(result)) {
      this.lastConflictKey = null;
      return result;
    }

    const conflictKey = `${result.externalSha256}\0${result.copySha256}`;
    if (this.lastConflictKey === conflictKey) return result;
    this.lastConflictKey = conflictKey;
    try {
      await this.options.onConflict?.(
        result,
        (choice) => this.resolveObservedConflict(result, choice),
      );
    } catch (error) {
      this.reportError(error);
    }
    return result;
  }

  private async resolveObservedConflict(
    conflict: ManagedCopyConflict,
    choice: ManagedCopyConflictChoice,
  ): Promise<ManagedCopyConflictResolutionResult> {
    if (this.disposed) {
      throw new ManagedCopyFallbackError(
        "controller-disposed",
        "受管临时副本监听器已停止。",
      );
    }
    const result = resolveManagedCopyConflict(
      conflict,
      this.scopeInput,
      choice,
      { now: this.options.now },
    );
    if (result.status === "resolved-external" && result.copySha256) {
      this.suppressions.set("copy", {
        sha256: result.copySha256,
        expiresAt: Date.now() + this.selfWriteSuppressionMs,
      });
    } else if (result.status === "resolved-copy" && result.externalSha256) {
      this.suppressions.set("external", {
        sha256: result.externalSha256,
        expiresAt: Date.now() + this.selfWriteSuppressionMs,
      });
    }
    if (result.status === "resolved-external" || result.status === "resolved-copy") {
      this.lastConflictKey = null;
      await this.publishState(result.state);
    } else if (result.status === "stale") {
      this.lastConflictKey = null;
      this.scheduleSynchronization(0);
    }
    return result;
  }
}

export function watchManagedCopy(
  options: ManagedCopyWatchOptions,
): ManagedCopyWatchController {
  return new ManagedCopyWatchController(options);
}
