import fs from "node:fs";
import path from "node:path";

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  if (/\.[a-z0-9]+$/iu.test(name)) return [name];
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return extensions.map((extension) => `${name}${extension.toLowerCase()}`);
}

/** Resolve an executable from PATH without spawning a blocking probe. */
export function findSystemExecutable(
  name: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathEntries = (environment.PATH || "").split(pathApi.delimiter).filter(Boolean);
  if (platform !== "win32") {
    pathEntries.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
  }
  for (const directory of [...new Set(pathEntries)]) {
    for (const executable of executableNames(name, platform)) {
      const candidate = pathApi.join(directory, executable);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* inaccessible PATH entry */
      }
    }
  }
  return null;
}

/**
 * Resolve the command used to run the universal MCP stdio launcher.
 *
 * The launcher is a plain Node script. Historically the copied config used
 * Obsidian's Electron binary with ELECTRON_RUN_AS_NODE=1, but newer Obsidian
 * installers (1.13.x) intercept CLI arguments before Electron sees them, so
 * that no longer enters Node mode. Prefer a system Node.js when available;
 * callers fall back to the Electron binary when this returns null.
 */
export function detectSystemNodeCommand(
  platform: NodeJS.Platform = process.platform,
): string | null {
  return findSystemExecutable("node", platform);
}
