import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const vaultRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, ".."));
const pluginsRoot = path.join(vaultRoot, ".obsidian", "plugins");
const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"),
);
const destination = path.join(pluginsRoot, manifest.id);
const duplicateIds = ["mv-obcc-ide", "mv-senceai"].filter((id) => id !== manifest.id);
const enabledPluginsPath = path.join(
  vaultRoot,
  ".obsidian",
  "community-plugins.json",
);

function runningObsidianProcesses() {
  try {
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        "Get-Process -Name Obsidian | ForEach-Object {",
        "  [Console]::WriteLine(('{0}|{1}' -f $_.Id, $_.StartTime.ToString('o')))",
        "}",
      ].join("; ");
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true },
      );
      if (result.status !== 0) return [];
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    const result = spawnSync("pgrep", ["-x", process.platform === "darwin" ? "Obsidian" : "obsidian"], {
      encoding: "utf8",
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((pid) => `${pid}|start-time-unavailable`);
  } catch {
    return [];
  }
}

for (const duplicateId of duplicateIds) {
  const duplicate = path.join(pluginsRoot, duplicateId);
  if (fs.existsSync(duplicate)) {
    throw new Error(
      `Duplicate plugin directory still exists: ${duplicate}\n` +
        `Migrate its data.json into ${destination} and remove the directory before deploying.`,
    );
  }
}

const enabledPlugins = JSON.parse(
  fs.readFileSync(enabledPluginsPath, "utf8"),
);
if (
  !Array.isArray(enabledPlugins) ||
  duplicateIds.some((id) => enabledPlugins.includes(id)) ||
  !enabledPlugins.includes(manifest.id)
) {
  throw new Error(
    `community-plugins.json must enable ${manifest.id} and must not enable duplicate plugin ids.`,
  );
}

if (typeof manifest.id !== "string" || !manifest.id) {
  throw new Error(`Unexpected plugin id: ${String(manifest.id)}`);
}

fs.mkdirSync(destination, { recursive: true });

const files = [
  ["dist/main.js", "main.js"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"],
];

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

for (const [sourceName, destinationName] of files) {
  const source = path.join(projectRoot, sourceName);
  const target = path.join(destination, destinationName);
  const temporary = `${target}.${manifest.id}-deploy-${process.pid}`;
  if (!fs.existsSync(source)) {
    throw new Error(`Build artifact missing: ${source}`);
  }
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, target);
  console.log(`${destinationName}  ${sha256(target)}`);
}

fs.rmSync(path.join(destination, "latex-suite-blackbox.cjs"), { force: true });

console.log(`Deployed ${manifest.id} to ${destination}`);
const running = runningObsidianProcesses();
if (running.length > 0) {
  console.warn(
    "WARNING: Obsidian is still running; copied plugin files are not hot-reloaded.",
  );
  for (const processInfo of running) {
    console.warn(`  Obsidian ${processInfo}`);
  }
  console.warn("Fully exit and restart Obsidian before manual validation.");
}
