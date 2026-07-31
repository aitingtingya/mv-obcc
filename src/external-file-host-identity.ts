import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST_ID_FILE = "external-file-host-id";
const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function externalFileHostIdPath(): string {
  return path.join(os.homedir(), ".mv-aide", HOST_ID_FILE);
}

function readExistingHostId(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`本机标识路径不是安全的普通文件：${filePath}`);
    }
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (!HOST_ID_PATTERN.test(value)) {
      throw new Error(`本机标识文件内容无效：${filePath}`);
    }
    return value.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Created lazily: a symlink-only installation never needs this fallback ID. */
export function readOrCreateExternalFileHostId(): string {
  const filePath = externalFileHostIdPath();
  const existing = readExistingHostId(filePath);
  if (existing) return existing;

  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const id = randomUUID().toLowerCase();
  try {
    fs.writeFileSync(filePath, `${id}\n`, { flag: "wx", mode: 0o600 });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = readExistingHostId(filePath);
    if (concurrent) return concurrent;
    throw new Error(`并发创建本机标识后无法读取：${filePath}`);
  }
}
