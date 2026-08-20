import fs from "node:fs";
import path from "node:path";
import { mvAideRuntimeDirectory } from "../../storage/temp-paths";

function unixShellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function assertSafeExecutable(value: string): string {
  const executable = value.trim();
  if (/[\r\n\0]/u.test(executable)) {
    throw new Error("Codex executable contains unsupported control characters.");
  }
  return executable;
}

export async function ensureCodexExecutablePath(
  configuredExecutable: string,
  platform: NodeJS.Platform = process.platform,
  binDirectory = mvAideRuntimeDirectory("codex/bin"),
): Promise<string | null> {
  const executable = assertSafeExecutable(configuredExecutable);
  const unixWrapper = path.join(binDirectory, "codex");
  const windowsWrapper = path.join(binDirectory, "codex.cmd");

  if (!executable || executable === "codex") {
    await Promise.all([
      fs.promises.rm(unixWrapper, { force: true }),
      fs.promises.rm(windowsWrapper, { force: true }),
    ]);
    return null;
  }

  await fs.promises.mkdir(binDirectory, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    const content = `@echo off\r\n"${executable.replace(/"/gu, '""')}" %*\r\n`;
    await fs.promises.writeFile(windowsWrapper, content, "utf8");
    await fs.promises.rm(unixWrapper, { force: true });
  } else {
    const content = `#!/bin/sh\nexec ${unixShellQuote(executable)} "$@"\n`;
    await fs.promises.writeFile(unixWrapper, content, { encoding: "utf8", mode: 0o755 });
    await fs.promises.chmod(unixWrapper, 0o755).catch(() => undefined);
    await fs.promises.rm(windowsWrapper, { force: true });
  }
  return binDirectory;
}
