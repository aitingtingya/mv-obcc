import {
  cleanStaleObsidianLocks,
  removeLockFile,
  writeLockFile,
} from "../../ide/discovery-lock";
import { claudeIdeDirectory } from "./paths";

export function writeClaudeIdeLock(
  port: number,
  workspaceFolder: string,
  authToken: string,
): string {
  return writeLockFile(port, workspaceFolder, authToken, claudeIdeDirectory());
}

export function removeClaudeIdeLock(port: number): void {
  removeLockFile(port, claudeIdeDirectory());
}

export function cleanStaleClaudeIdeLocks(): void {
  cleanStaleObsidianLocks(claudeIdeDirectory());
}
