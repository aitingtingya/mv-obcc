import fs from "node:fs";
import { t } from "./i18n";
import path from "node:path";
import { mvAideTempDirectory } from "./storage/temp-paths";
import {
  createVerifiedFileSymlink,
  type FileSymlinkFailure,
  type FileSymlinkServiceOptions,
} from "./file-symlink-service";
import {
  normalizeExternalFileMirrorFolder,
  resolveExternalFileVaultPath,
} from "./external-file-mirror-path";

export interface ExternalFileSymlinkPreflightResult {
  ok: boolean;
  message: string;
  failure?: FileSymlinkFailure;
  fallbackEligible?: boolean;
}

export interface ExternalFileSymlinkPreflightOptions {
  platform?: NodeJS.Platform;
  temporaryDirectory?: () => string;
  randomId?: () => string;
  symlinkOptions?: Omit<FileSymlinkServiceOptions, "platform">;
}

export function isManagedCopyEligibleSymlinkFailure(
  failure: FileSymlinkFailure,
): boolean {
  if (
    failure.reason === "invalid-path" ||
    failure.reason === "target-unavailable" ||
    failure.reason === "target-not-file" ||
    failure.reason === "parent-unavailable" ||
    failure.reason === "destination-occupied"
  ) {
    return false;
  }
  return (
    failure.stage === "create" ||
    failure.stage === "windows-helper" ||
    failure.stage.startsWith("verify-")
  );
}

function failureDetails(failure: FileSymlinkFailure): string {
  const details: string[] = [];
  if (failure.win32Error !== undefined) {
    details.push(`Win32 ${failure.win32Error}`);
  } else if (failure.errorCode) {
    details.push(failure.errorCode);
  }
  details.push(t("阶段：{v0}", { v0: failure.stage }));
  return details.join("，");
}

export function describeFileSymlinkFailure(
  failure: FileSymlinkFailure,
  platform: NodeJS.Platform = process.platform,
): string {
  const details = failureDetails(failure);
  if (platform === "win32") {
    if (failure.win32Error === 1314) {
      return t("Windows 拒绝创建符号链接（{v0}）：当前 Obsidian 进程没有有效的符号链接权限。开发者模式可能未真正生效，或权限被系统策略限制。", { v0: details });
    }
    if (failure.win32Error === 5 || failure.reason === "permission-denied") {
      return t("Windows 拒绝创建符号链接（{v0}）：请检查 vault 目录权限、开发者模式和组织策略。", { v0: details });
    }
    if (failure.reason === "remote-unavailable") {
      return t("Windows 无法在当前本地/网络路径组合上建立符号链接（{v0}），请检查网络提供程序及远程符号链接策略。", { v0: details });
    }
    if (failure.reason === "filesystem-unsupported") {
      return t("当前 Windows 文件系统或存储提供程序不支持该符号链接（{v0}）。", { v0: details });
    }
  }
  return t("无法创建并验证文件符号链接（{v0}）：{v1}", { v0: details, v1: failure.message });
}

function writeThroughFailure(
  targetPath: string,
  linkPath: string,
  error: unknown,
): FileSymlinkFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    ok: false,
    verified: false,
    targetPath,
    linkPath,
    method: "existing",
    stage: "verify-target",
    reason: "verification-failed",
    message: error instanceof Error ? error.message : String(error),
    errorCode: code,
    attempts: [{
      method: "existing",
      stage: "verify-target",
      ok: false,
      errorCode: code,
      message: error instanceof Error ? error.message : String(error),
    }],
  };
}

/**
 * Uses the exact same verified symlink service as the runtime mapping path.
 * The probe is intentionally cross-platform; successful macOS/Linux behavior
 * remains the direct Node symlink path and never touches managed-copy code.
 */
export async function preflightExternalFileSymlink(
  vaultRoot: string,
  mirrorFolder: string,
  options: ExternalFileSymlinkPreflightOptions = {},
): Promise<ExternalFileSymlinkPreflightResult> {
  const platform = options.platform ?? process.platform;
  const randomId = options.randomId?.() ??
    `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryDirectory =
    options.temporaryDirectory?.() ?? mvAideTempDirectory("file-opener/symlink-probe");
  const sourceDir = path.join(
    temporaryDirectory,
    `operation-${randomId}`,
  );
  const sourcePath = path.join(sourceDir, "probe.md");
  let normalizedMirror: string;
  try {
    normalizedMirror = normalizeExternalFileMirrorFolder(mirrorFolder);
  } catch (error) {
    const failure = writeThroughFailure(sourcePath, mirrorFolder, error);
    failure.reason = "invalid-path";
    failure.stage = "validate-input";
    return {
      ok: false,
      message: t("镜像目录无效：{v0}", { v0: failure.message }),
      failure,
      fallbackEligible: false,
    };
  }
  const probeVaultPath = `${normalizedMirror}/.mv-aide-probe-${randomId}/probe.md`;
  const canonicalVaultRoot = fs.realpathSync.native(vaultRoot);
  const prospectiveLinkPath = path.join(
    canonicalVaultRoot,
    ...probeVaultPath.split("/"),
  );
  const linkDir = path.dirname(prospectiveLinkPath);
  const createdMirrorParents: string[] = [];
  let parentToCheck = path.dirname(linkDir);
  while (parentToCheck !== canonicalVaultRoot && !fs.existsSync(parentToCheck)) {
    createdMirrorParents.push(parentToCheck);
    parentToCheck = path.dirname(parentToCheck);
  }
  const linkPath = resolveExternalFileVaultPath(vaultRoot, probeVaultPath, {
    createParent: true,
  }).absolutePath;

  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, "source", "utf8");
    const result = await createVerifiedFileSymlink(
      { targetPath: sourcePath, linkPath },
      { platform, ...options.symlinkOptions },
    );
    if (!result.ok) {
      const fallbackEligible = isManagedCopyEligibleSymlinkFailure(result);
      const description = describeFileSymlinkFailure(result, platform);
      return {
        ok: false,
        message: fallbackEligible
          ? t("{v0} 可选择使用受管临时副本继续；后续仍会优先使用真实符号链接。", { v0: description })
          : description,
        failure: result,
        fallbackEligible,
      };
    }

    try {
      fs.writeFileSync(linkPath, "written-through-link", "utf8");
      if (fs.readFileSync(sourcePath, "utf8") !== "written-through-link") {
        throw Object.assign(
          new Error(t("符号链接没有保持双向写穿行为。")),
          { code: "EVERIFY" },
        );
      }
    } catch (error) {
      const failure = writeThroughFailure(sourcePath, linkPath, error);
      return {
        ok: false,
        message: t("{v0} 可选择使用受管临时副本继续；后续仍会优先使用真实符号链接。", { v0: describeFileSymlinkFailure(failure, platform) }),
        failure,
        fallbackEligible: true,
      };
    }
    return {
      ok: true,
      message: t("{v0}符号链接预检通过。", { v0: platform === "win32" ? "Windows " : "" }),
    };
  } finally {
    fs.rmSync(linkPath, { force: true });
    try {
      fs.rmdirSync(linkDir);
    } catch {
      // A concurrent unexpected file is never removed recursively.
    }
    for (const createdParent of createdMirrorParents) {
      try {
        fs.rmdirSync(createdParent);
      } catch {
        break;
      }
    }
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
}
