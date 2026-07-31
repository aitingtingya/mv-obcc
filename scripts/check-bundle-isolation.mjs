// Build-level guard for the startup-performance isolation requirement:
// the Universal MCP runtime ships as separate lazy bundles, so dist/main.js
// must not contain the protocol implementation. Run after `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolMarkers = ["obsidian://mv-aide", "subscriptions/listen"];

function readBundle(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing build artifact: ${relativePath}. Run npm run build first.`);
  }
  return fs.readFileSync(filePath, "utf8");
}

const mainBundle = readBundle("dist/main.js");
for (const marker of protocolMarkers) {
  if (mainBundle.includes(marker)) {
    throw new Error(
      `dist/main.js contains the Universal MCP marker "${marker}"; ` +
        "the runtime must stay in its separate lazy bundle.",
    );
  }
}

const universalBundle = readBundle("dist/universal-mcp.cjs");
for (const marker of protocolMarkers) {
  if (!universalBundle.includes(marker)) {
    throw new Error(
      `dist/universal-mcp.cjs lost the expected marker "${marker}".`,
    );
  }
}

const stdioBundle = readBundle("dist/universal-mcp-stdio.cjs");
if (!stdioBundle.includes("MV_OBCC_MCP_RUNTIME")) {
  throw new Error("dist/universal-mcp-stdio.cjs does not look like the stdio launcher.");
}

console.log("bundle isolation ok: main.js excludes the Universal MCP runtime.");
