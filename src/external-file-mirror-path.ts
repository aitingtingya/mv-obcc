import fs from "node:fs";
import { t } from "./i18n";
import path from "node:path";

export interface ResolvedExternalFileVaultPath {
  vaultRoot: string;
  vaultPath: string;
  absolutePath: string;
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Validate the nearest existing ancestor before creating any missing child.
 * This prevents a vault junction from making recursive mkdir write outside the
 * canonical vault before containment is checked.
 */
export function ensureContainedVaultDirectory(
  realVaultRoot: string,
  directoryPath: string,
  create: boolean,
): string {
  if (!isContainedPath(realVaultRoot, directoryPath)) {
    throw new Error(t("外部文件镜像目录解析到了 vault 外部。"));
  }
  if (!create) {
    const realDirectory = fs.realpathSync.native(directoryPath);
    if (!isContainedPath(realVaultRoot, realDirectory)) {
      throw new Error(t("外部文件镜像父目录通过链接离开了 vault。"));
    }
    return realDirectory;
  }

  const missingSegments: string[] = [];
  let existingAncestor = directoryPath;
  for (;;) {
    try {
      const stat = fs.statSync(existingAncestor);
      if (!stat.isDirectory()) {
        throw new Error(t("外部文件镜像父路径不是目录。"));
      }
      break;
    } catch (error) {
      if (!missingPath(error)) throw error;
      if (existingAncestor === realVaultRoot) throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  const realExistingAncestor = fs.realpathSync.native(existingAncestor);
  if (!isContainedPath(realVaultRoot, realExistingAncestor)) {
    throw new Error(t("外部文件镜像父目录通过链接离开了 vault。"));
  }

  let current = existingAncestor;
  for (const segment of missingSegments) {
    // Revalidate immediately before each individual mkdir. Never use recursive
    // mkdir here: it can traverse an unchecked junction and create outside.
    const realCurrent = fs.realpathSync.native(current);
    if (!isContainedPath(realVaultRoot, realCurrent)) {
      throw new Error(t("外部文件镜像父目录通过链接离开了 vault。"));
    }
    const next = path.join(current, segment);
    try {
      fs.mkdirSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        throw error;
      }
    }
    const nextStat = fs.statSync(next);
    if (!nextStat.isDirectory()) {
      throw new Error(t("外部文件镜像父路径不是目录。"));
    }
    const realNext = fs.realpathSync.native(next);
    if (!isContainedPath(realVaultRoot, realNext)) {
      throw new Error(t("外部文件镜像父目录通过链接离开了 vault。"));
    }
    current = next;
  }
  return fs.realpathSync.native(directoryPath);
}

/** Strictly normalize a path that must remain relative to the current vault. */
export function normalizeExternalFileVaultPath(value: string): string {
  const replaced = value.trim().replace(/\\/g, "/");
  if (
    !replaced ||
    replaced.includes("\0") ||
    replaced.startsWith("/") ||
    replaced.startsWith("//") ||
    /^[a-zA-Z]:\//u.test(replaced) ||
    replaced.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(t("外部文件镜像路径必须是 vault 内、不含 .. 的相对路径。"));
  }

  const normalized = path.posix.normalize(replaced);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(t("外部文件镜像路径不能离开 vault。"));
  }
  return normalized;
}

export function normalizeExternalFileMirrorFolder(value: string): string {
  return normalizeExternalFileVaultPath(value).replace(/\/+$/u, "");
}

/**
 * Resolve a vault-relative mirror file and verify that its real parent remains
 * inside the real vault root. This blocks configured traversal and symlinked
 * parent directories before either the symlink or copy strategy can write.
 */
export function resolveExternalFileVaultPath(
  vaultRoot: string,
  vaultPath: string,
  options: { createParent?: boolean } = {},
): ResolvedExternalFileVaultPath {
  if (!path.isAbsolute(vaultRoot)) {
    throw new Error(t("vault 根目录必须是绝对路径。"));
  }
  const normalized = normalizeExternalFileVaultPath(vaultPath);
  const realVaultRoot = fs.realpathSync.native(vaultRoot);
  const absolutePath = path.join(realVaultRoot, ...normalized.split("/"));
  if (!isContainedPath(realVaultRoot, absolutePath)) {
    throw new Error(t("外部文件镜像路径解析到了 vault 外部。"));
  }

  const parent = path.dirname(absolutePath);
  ensureContainedVaultDirectory(
    realVaultRoot,
    parent,
    options.createParent === true,
  );
  return {
    vaultRoot: realVaultRoot,
    vaultPath: normalized,
    absolutePath,
  };
}
