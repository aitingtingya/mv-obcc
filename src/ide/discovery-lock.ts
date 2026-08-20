import fs from "node:fs";
import path from "node:path";
import { IDE_NAME } from "../constants";
import { mvAideIdeDirectory } from "../storage/system-paths";

export interface LockFileData {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: "ws";
  authToken: string;
}

export interface DiscoveredIdeLock extends LockFileData {
  port: number;
  filePath: string;
}

export function discoveryLockDirectory(): string {
  return mvAideIdeDirectory();
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // Best effort on filesystems that do not expose POSIX permissions.
    }
  }
}

export function writeLockFile(
  port: number,
  workspaceFolder: string,
  authToken: string,
  directory = discoveryLockDirectory(),
): string {
  ensureDirectory(directory);
  const target = path.join(directory, `${port}.lock`);
  const temporary = `${target}.tmp`;
  const data: LockFileData = {
    pid: process.pid,
    workspaceFolders: [workspaceFolder],
    ideName: IDE_NAME,
    transport: "ws",
    authToken,
  };
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

export function removeLockFile(port: number, directory = discoveryLockDirectory()): void {
  try {
    fs.unlinkSync(path.join(directory, `${port}.lock`));
  } catch {
    // Already gone.
  }
}

function validLockData(value: unknown): value is LockFileData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<LockFileData>;
  return (
    Number.isInteger(candidate.pid) &&
    (candidate.pid as number) > 0 &&
    candidate.ideName === IDE_NAME &&
    candidate.transport === "ws" &&
    typeof candidate.authToken === "string" &&
    candidate.authToken.length > 0 &&
    Array.isArray(candidate.workspaceFolders) &&
    candidate.workspaceFolders.every((folder) => typeof folder === "string" && folder.length > 0)
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listLiveIdeLocks(
  directory = discoveryLockDirectory(),
): DiscoveredIdeLock[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory).filter((entry) => entry.endsWith(".lock"));
  } catch {
    return [];
  }

  const locks: DiscoveredIdeLock[] = [];
  for (const entry of entries) {
    const match = /^(\d+)\.lock$/u.exec(entry);
    if (!match) continue;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const filePath = path.join(directory, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!validLockData(parsed) || !processIsAlive(parsed.pid)) continue;
      locks.push({ ...parsed, port, filePath });
    } catch {
      // Unknown or malformed files are not owned strongly enough to remove here.
    }
  }
  return locks.sort((a, b) => a.port - b.port);
}

export function cleanStaleObsidianLocks(directory = discoveryLockDirectory()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory).filter((entry) => entry.endsWith(".lock"));
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LockFileData>;
      if (
        parsed.ideName !== IDE_NAME ||
        typeof parsed.pid !== "number"
      ) {
        continue;
      }
      if (processIsAlive(parsed.pid)) continue;
      fs.unlinkSync(filePath);
    } catch {
      // Leave malformed/foreign files untouched.
    }
  }
}
