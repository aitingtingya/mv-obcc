// End-to-end protocol check for the Universal MCP stdio launcher:
// starts the real dist/universal-mcp.cjs server in-process, proxies newline
// JSON-RPC through dist/universal-mcp-stdio.cjs, and exercises discovery,
// tools/list, and resources/read for every supported protocol version.
// Run after `npm run build` (wired up as `npm run test:protocol`).
import { spawn } from "node:child_process";
import esbuild from "esbuild";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let checks = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`stdio e2e assertion failed: ${message}`);
  checks += 1;
}

class StdioClient {
  constructor(runtimePath) {
    this.child = spawn(process.execPath, [
      path.join(root, "dist", "universal-mcp-stdio.cjs"),
      "--runtime",
      runtimePath,
    ], {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "MV_OBCC_MCP_RUNTIME"),
      ),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.pending = new Map();
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message && typeof message === "object" && message.id != null) {
        const entry = this.pending.get(String(message.id));
        if (entry) {
          this.pending.delete(String(message.id));
          clearTimeout(entry.timer);
          entry.resolve(message);
        }
      }
    });
  }

  request(method, params, id, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`stdio e2e: timeout waiting for ${method} (${id})`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async close() {
    this.child.stdin.end();
    const exit = await Promise.race([
      this.exitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    if (exit === null) this.child.kill("SIGKILL");
  }
}

function assertFullToolSet(tools, context) {
  assert(Array.isArray(tools), `${context}: tools/list did not return an array`);
  const expected = [...IDE_TOOL_DEFINITIONS.map((definition) => definition.name)].sort();
  const actual = [...tools.map((tool) => tool.name)].sort();
  assert(
    actual.length === expected.length && actual.every((name, index) => name === expected[index]),
    `${context}: tools/list mismatch, got ${JSON.stringify(actual)}`,
  );
}

async function assertAllResources(client, meta, idPrefix) {
  const uris = Object.values(UNIVERSAL_MCP_RESOURCE_URIS);
  assert(uris.length === 4, "expected exactly four workspace resources");
  for (const [index, uri] of uris.entries()) {
    const response = await client.request(
      "resources/read",
      meta ? { uri, _meta: meta } : { uri },
      `${idPrefix}-read-${index}`,
    );
    assert(!response.error, `resources/read ${uri} returned ${JSON.stringify(response.error)}`);
    const contents = response.result?.contents;
    assert(
      Array.isArray(contents) && contents.length >= 1,
      `resources/read ${uri} returned no contents`,
    );
  }
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "stdio-e2e", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

let IDE_TOOL_DEFINITIONS;
let UNIVERSAL_MCP_RESOURCE_URIS;
let server;
let temporaryDirectory;
let toolsBundle;
let universalBundlePath;
try {
  const stdioLauncherPath = path.join(root, "dist", "universal-mcp-stdio.cjs");
  if (!fs.existsSync(stdioLauncherPath)) {
    throw new Error(`Missing ${stdioLauncherPath}. Run npm run build first.`);
  }
  // universal-mcp 不再单独构建（已静态打进 main.js），按需临时打包。
  universalBundlePath = path.join(os.tmpdir(), `mv-obcc-universal-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, "src", "universal-mcp.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: universalBundlePath,
    logLevel: "silent",
  });
  const universalBundle = require(universalBundlePath);
  const { UniversalMcpServer } = universalBundle;
  UNIVERSAL_MCP_RESOURCE_URIS = universalBundle.UNIVERSAL_MCP_RESOURCE_URIS;

  toolsBundle = path.join(os.tmpdir(), `mv-obcc-ide-tools-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, "src", "tool-definitions.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: toolsBundle,
    logLevel: "silent",
  });
  IDE_TOOL_DEFINITIONS = require(toolsBundle).IDE_TOOL_DEFINITIONS;

  const capabilities = {
    getContextSnapshot: async () => ({
      vaultRoot: "/vault",
      current: { relativePath: "notes/current.md", selection: { text: "selected" } },
      openEditors: [{ uri: "file:///vault/notes/current.md", label: "current.md" }],
    }),
    listIdeTools: () => IDE_TOOL_DEFINITIONS.map((definition) => ({ ...definition })),
    callIdeTool: async (name, args) => ({
      content: [{ type: "text", text: JSON.stringify({ name, args }) }],
    }),
  };

  temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "mv-obcc-stdio-e2e-"));
  const runtimePath = path.join(temporaryDirectory, "runtime.json");
  server = new UniversalMcpServer({
    authToken: `stdio-e2e-token-${process.pid}`,
    capabilities,
    runtimeDescriptorPath: runtimePath,
    serverVersion: "0.8.1-stdio-e2e",
  });
  const descriptor = await server.start();
  assert(fs.existsSync(runtimePath), "server did not publish the runtime descriptor");

  // Modern protocol: 2026-07-28, stateless with _meta version markers.
  {
    const client = new StdioClient(runtimePath);
    try {
      const discover = await client.request("server/discover", { _meta: MODERN_META }, "m-discover");
      assert(!discover.error, `server/discover returned ${JSON.stringify(discover.error)}`);
      assert(
        Array.isArray(discover.result?.supportedVersions)
          && discover.result.supportedVersions.includes("2026-07-28")
          && discover.result.supportedVersions.includes("2025-11-25")
          && discover.result.supportedVersions.includes("2025-03-26"),
        "server/discover did not advertise all three protocol versions",
      );
      const tools = await client.request("tools/list", { _meta: MODERN_META }, "m-tools");
      assert(!tools.error, `modern tools/list returned ${JSON.stringify(tools.error)}`);
      assertFullToolSet(tools.result?.tools, "2026-07-28");
      await assertAllResources(client, MODERN_META, "m");
    } finally {
      await client.close();
    }
  }

  // Legacy protocols: initialize handshake, then plain session requests.
  for (const protocolVersion of ["2025-11-25", "2025-03-26"]) {
    const client = new StdioClient(runtimePath);
    try {
      const init = await client.request("initialize", {
        protocolVersion,
        clientInfo: { name: "stdio-e2e", version: "0" },
        capabilities: {},
      }, `l-init-${protocolVersion}`);
      assert(!init.error, `${protocolVersion} initialize returned ${JSON.stringify(init.error)}`);
      assert(
        init.result?.protocolVersion === protocolVersion,
        `${protocolVersion} initialize negotiated ${JSON.stringify(init.result?.protocolVersion)}`,
      );
      const tools = await client.request("tools/list", {}, `l-tools-${protocolVersion}`);
      assert(!tools.error, `${protocolVersion} tools/list returned ${JSON.stringify(tools.error)}`);
      assertFullToolSet(tools.result?.tools, protocolVersion);
      await assertAllResources(client, null, `l-${protocolVersion}`);
    } finally {
      await client.close();
    }
  }

  // Stale descriptors must fail loudly on stderr and exit nonzero.
  {
    const stalePath = path.join(temporaryDirectory, "runtime-stale.json");
    await fsp.writeFile(stalePath, JSON.stringify({
      ...descriptor,
      instanceId: "bogus-instance-id",
      pid: 999_999,
    }));
    const client = new StdioClient(stalePath);
    const exit = await Promise.race([
      client.exitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    assert(exit !== null && exit.code === 1, `stale descriptor exit was ${JSON.stringify(exit)}`);
    assert(/stale/i.test(client.stderr), `stale descriptor stderr was: ${client.stderr}`);
  }

  console.log(`stdio protocol e2e ok: ${checks} checks across three protocol versions.`);
} finally {
  if (server) await server.stop();
  if (temporaryDirectory) await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  if (toolsBundle) fs.rmSync(toolsBundle, { force: true });
  if (universalBundlePath) fs.rmSync(universalBundlePath, { force: true });
}
