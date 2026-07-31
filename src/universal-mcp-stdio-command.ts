import { spawnSync } from "node:child_process";
import fs from "node:fs";

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
  try {
    const probe = spawnSync("node", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) return null;
    const lookup = spawnSync(platform === "win32" ? "where" : "which", ["node"], {
      encoding: "utf8",
    });
    if (lookup.error || lookup.status !== 0 || typeof lookup.stdout !== "string") {
      return null;
    }
    for (const line of lookup.stdout.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
