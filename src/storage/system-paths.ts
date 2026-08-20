import os from "node:os";
import path from "node:path";

export function mvAideSystemRoot(): string {
  return path.join(os.homedir(), ".mv-aide");
}

export function mvAideIdeDirectory(): string {
  return path.join(mvAideSystemRoot(), "ide");
}

export function mvAideRuntimeRoot(): string {
  return path.join(mvAideSystemRoot(), "runtime");
}

export function mvAideTempRoot(): string {
  return path.join(mvAideSystemRoot(), "tmp");
}

export function fileOpenerDirectory(): string {
  return path.join(mvAideSystemRoot(), "file-opener");
}

export function legacyVimConfigPath(): string {
  return path.join(mvAideSystemRoot(), "vim", ".vimrc");
}

export function legacyExternalFileHostIdPath(): string {
  return path.join(mvAideSystemRoot(), "external-file-host-id");
}

export function legacyFileOpenerRoot(): string {
  return mvAideSystemRoot();
}
