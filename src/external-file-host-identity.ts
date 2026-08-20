import { createHash, randomUUID } from "node:crypto";
import { t } from "./i18n";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExternalFileVaultPath } from "./external-file-mirror-path";
import { EXTERNAL_FILE_HOST_IDS_FOLDER } from "./storage/vault-paths";

const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function defaultHostFingerprint(): string {
  return [process.platform, os.hostname(), os.homedir()].join("\0");
}

export function externalFileHostIdPath(
  vaultRoot: string,
  hostFingerprint = defaultHostFingerprint(),
): string {
  const hostKey = createHash("sha256")
    .update(hostFingerprint)
    .digest("hex")
    .slice(0, 24);
  return path.join(
    vaultRoot,
    ...EXTERNAL_FILE_HOST_IDS_FOLDER.split("/"),
    `${hostKey}.id`,
  );
}

function readExistingHostId(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(t("本机标识路径不是安全的普通文件：{v0}", { v0: filePath }));
    }
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (!HOST_ID_PATTERN.test(value)) {
      throw new Error(t("本机标识文件内容无效：{v0}", { v0: filePath }));
    }
    return value.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Created lazily: a symlink-only installation never needs this fallback ID. */
export function readOrCreateExternalFileHostId(
  vaultRoot: string,
  legacyFilePath?: string,
  hostFingerprint = defaultHostFingerprint(),
): string {
  const relativePath = path.relative(
    vaultRoot,
    externalFileHostIdPath(vaultRoot, hostFingerprint),
  ).split(path.sep).join("/");
  const filePath = resolveExternalFileVaultPath(
    vaultRoot,
    relativePath,
    { createParent: true },
  ).absolutePath;
  const existing = readExistingHostId(filePath);
  if (existing) return existing;

  const legacy = legacyFilePath ? readExistingHostId(legacyFilePath) : null;
  const id = legacy ?? randomUUID().toLowerCase();
  let created = false;
  let result: string;
  try {
    fs.writeFileSync(filePath, `${id}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    result = id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = readExistingHostId(filePath);
    if (concurrent) result = concurrent;
    else {
      throw new Error(t("并发创建本机标识后无法读取：{v0}", { v0: filePath }));
    }
  }
  if (legacy && legacyFilePath) {
    try {
      fs.unlinkSync(legacyFilePath);
    } catch (error) {
      if (created) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Keep the original migration error; rollback is best effort.
        }
      }
      throw error;
    }
  }
  return result;
}
