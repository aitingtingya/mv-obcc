import crypto from "node:crypto";
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
