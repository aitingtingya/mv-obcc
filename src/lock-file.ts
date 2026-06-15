import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IDE_NAME } from "./constants";

export interface LockFileData {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: "ws";
  authToken: string;
}

export function lockDirectory(): string {
  return path.join(os.homedir(), ".claude", "ide");
}

export function writeLockFile(
  port: number,
  workspaceFolder: string,
  authToken: string,
  directory = lockDirectory(),
): string {
  fs.mkdirSync(directory, { recursive: true });
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

export function removeLockFile(port: number, directory = lockDirectory()): void {
  try {
    fs.unlinkSync(path.join(directory, `${port}.lock`));
  } catch {
    // Already gone.
  }
}

export function cleanStaleObsidianLocks(directory = lockDirectory()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory).filter((entry) => entry.endsWith(".lock"));
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as Partial<LockFileData>;
      if (parsed.ideName !== IDE_NAME || typeof parsed.pid !== "number") continue;
      process.kill(parsed.pid, 0);
    } catch {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Best effort cleanup.
      }
    }
  }
}
