import crypto from "node:crypto";
import { t } from "./i18n";
import fs from "node:fs";
import path from "node:path";
import {
  createVerifiedFileSymlink,
  type FileSymlinkFailure,
  type FileSymlinkRequest,
  type FileSymlinkResult,
} from "./file-symlink-service";
import { resolveExternalFileVaultPath } from "./external-file-mirror-path";
import {
  resumeManagedCopyFallback,
  sha256File,
  type ManagedCopyScopeInput,
  type ManagedCopyState,
  type ManagedCopySyncResult,
} from "./managed-copy-fallback";

export interface ManagedCopySymlinkMigrationOptions {
  state: ManagedCopyState;
  scope: ManagedCopyScopeInput;
  createFileSymlink?: (
    request: FileSymlinkRequest,
  ) => Promise<FileSymlinkResult>;
}

export type ManagedCopySymlinkMigrationResult =
  | {
      status: "migrated";
      state: ManagedCopyState;
      synchronization: ManagedCopySyncResult;
      warning?: string;
    }
  | {
      status: "not-ready";
      state: ManagedCopyState;
      synchronization: ManagedCopySyncResult;
      reason: string;
    }
  | {
      status: "symlink-failed";
      state: ManagedCopyState;
      synchronization: ManagedCopySyncResult;
      failure: FileSymlinkFailure;
      restored: boolean;
      backupPath?: string;
    };

function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function restoreBackup(backupPath: string, copyPath: string): boolean {
  if (!lstatOrNull(backupPath) || lstatOrNull(copyPath)) return false;
  fs.renameSync(backupPath, copyPath);
  return true;
}

/**
 * Explicitly upgrade one local managed copy back to the primary symlink
 * strategy. Normal file opens never call this function.
 */
export async function migrateManagedCopyToSymlink(
  options: ManagedCopySymlinkMigrationOptions,
): Promise<ManagedCopySymlinkMigrationResult> {
  const resumed = resumeManagedCopyFallback({
    scope: options.scope,
    externalPath: options.state.externalPath,
    vaultPath: options.state.vaultPath,
    existing: options.state,
  });
  const state = resumed.state;
  const synchronization = resumed.synchronization;
  if (
    synchronization.status === "conflict" ||
    synchronization.status === "stale" ||
    synchronization.status === "external-missing" ||
    synchronization.status === "both-missing"
  ) {
    return {
      status: "not-ready",
      state,
      synchronization,
      reason: t("副本尚未安全收敛，未尝试替换为符号链接。"),
    };
  }

  const copyPath = resolveExternalFileVaultPath(
    options.scope.vaultRoot,
    state.vaultPath,
  ).absolutePath;
  const externalStat = lstatOrNull(state.externalPath);
  const copyStat = lstatOrNull(copyPath);
  if (
    !externalStat?.isFile() ||
    externalStat.isSymbolicLink() ||
    !copyStat?.isFile() ||
    copyStat.isSymbolicLink()
  ) {
    return {
      status: "not-ready",
      state,
      synchronization,
      reason: t("外部文件或受管副本不是可安全迁移的普通文件。"),
    };
  }

  const expectedSha256 = sha256File(state.externalPath);
  if (
    sha256File(copyPath) !== expectedSha256 ||
    expectedSha256 !== state.baselineSha256
  ) {
    return {
      status: "not-ready",
      state,
      synchronization,
      reason: t("迁移提交前文件又发生变化，未替换任何路径。"),
    };
  }

  const backupPath = path.join(
    path.dirname(copyPath),
    `.${path.basename(copyPath)}.mv-obcc-migrate-${process.pid}-${crypto
      .randomBytes(8)
      .toString("hex")}.bak`,
  );
  fs.renameSync(copyPath, backupPath);
  let commitStillStable = false;
  try {
    commitStillStable =
      sha256File(backupPath) === expectedSha256 &&
      sha256File(state.externalPath) === expectedSha256;
  } catch {
    commitStillStable = false;
  }
  if (!commitStillStable) {
    const restored = restoreBackup(backupPath, copyPath);
    return {
      status: "not-ready",
      state,
      synchronization,
      reason: restored
        ? t("迁移提交时文件发生变化，已恢复受管副本。")
        : t("迁移提交时文件发生变化；安全备份保留在 {v0}。", { v0: backupPath }),
    };
  }

  const createFileSymlink = options.createFileSymlink ??
    createVerifiedFileSymlink;
  const request = {
    targetPath: state.externalPath,
    linkPath: copyPath,
  };
  let symlink: FileSymlinkResult;
  try {
    symlink = await createFileSymlink(request);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
    symlink = {
      ...request,
      ok: false,
      verified: false,
      method: "none",
      stage: "create",
      reason: "unknown",
      message: error instanceof Error ? error.message : String(error),
      errorCode,
      attempts: [{
        method: "none",
        stage: "create",
        ok: false,
        errorCode,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  if (!symlink.ok) {
    const restored = restoreBackup(backupPath, copyPath);
    return {
      status: "symlink-failed",
      state,
      synchronization,
      failure: symlink,
      restored,
      backupPath: restored ? undefined : backupPath,
    };
  }

  let warning: string | undefined;
  try {
    fs.unlinkSync(backupPath);
  } catch {
    warning = t("符号链接已生效，但旧副本备份未能删除：{v0}", { v0: backupPath });
  }
  return { status: "migrated", state, synchronization, warning };
}
