import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const vaultRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, ".."));
const pluginsRoot = path.join(vaultRoot, ".obsidian", "plugins");
const destination = path.join(pluginsRoot, "mv-obcc");
const duplicate = path.join(pluginsRoot, "mv-obcc-ide");
const enabledPluginsPath = path.join(
  vaultRoot,
  ".obsidian",
  "community-plugins.json",
);

if (fs.existsSync(duplicate)) {
  throw new Error(
    `Duplicate plugin directory still exists: ${duplicate}\n` +
      "Migrate its data.json and remove the directory before deploying.",
  );
}

const enabledPlugins = JSON.parse(
  fs.readFileSync(enabledPluginsPath, "utf8"),
);
if (
  !Array.isArray(enabledPlugins) ||
  enabledPlugins.includes("mv-obcc-ide") ||
  !enabledPlugins.includes("mv-obcc")
) {
  throw new Error(
    "community-plugins.json must enable only mv-obcc (not mv-obcc-ide).",
  );
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"),
);
if (manifest.id !== "mv-obcc") {
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
  const temporary = `${target}.mv-obcc-deploy-${process.pid}`;
  if (!fs.existsSync(source)) {
    throw new Error(`Build artifact missing: ${source}`);
  }
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, target);
  console.log(`${destinationName}  ${sha256(target)}`);
}

console.log(`Deployed mv-obcc to ${destination}`);
