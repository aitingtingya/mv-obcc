// Live check of every IDE tool exposed by the Universal MCP endpoint against
// the real Obsidian runtime. Reads the runtime descriptor published by the
// plugin, exercises all eight tools, the four workspace resources, and the
// stdio launcher, then prints a per-tool PASS/FAIL report.
//
// Usage:
//   node scripts/live-ide-tools-check.mjs [--runtime <path>] [--only <check>]
// Checks for --only: readCurrentWebPage | open-diff-accept | resources-watch
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = path.resolve(root, "..");
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
// 与 src/path-utils.ts 的 stablePortSeed 保持一致（独立脚本无法 import TS）。
const stablePortSeed = (value) => {
  const normalized = process.platform === "win32"
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
  let hash = 2166136261;
  for (const char of normalized) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
const runtimePath = argValue("--runtime")
  ?? path.join(os.tmpdir(), `mv-aide-universal-mcp-${stablePortSeed(vaultRoot)}`, "runtime.json");
const only = argValue("--only");

const SCRATCH_NAME = "mv-obcc-live-check-scratch.md";
const scratchPath = path.join(vaultRoot, SCRATCH_NAME);
const DIFF_TAB_NAME = "mv-obcc-live-check";
const DIFF_VIEW_TYPE = "mv-senceai-ide-diff";
const EXPECTED_TOOLS = [
  "getLatestSelection",
  "getOpenEditors",
  "openFile",
  "readCurrentWebPage",
  "openDiff",
  "closeAllDiffTabs",
  "getDiagnostics",
  "close_tab",
];
const RESOURCE_URIS = {
  context: "obsidian://mv-aide/workspace/context",
  "open-editors": "obsidian://mv-aide/workspace/open-editors",
  "latest-selection": "obsidian://mv-aide/workspace/latest-selection",
  "latest-mention": "obsidian://mv-aide/workspace/latest-mention",
};

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "live-ide-tools-check", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};

const results = [];
function report(ok, name, detail = "") {
  results.push({ ok, name, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function check(ok, name, detail = "") {
  report(Boolean(ok), name, detail);
  return Boolean(ok);
}

async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return null;
}

function tabKey(tab) {
  // Synthetic obsidian://view/<type>/<index> uris shift when tabs are added;
  // normalize them so the baseline comparison is stable.
  const uri = String(tab.uri ?? tab.label);
  return `${tab.viewType}:${uri.replace(/^(obsidian:\/\/view\/[^/]+)\/\d+$/, "$1")}`;
}

function fileUriToVaultPath(uri) {
  const decoded = decodeURIComponent(String(uri));
  const prefix = "file:///";
  if (!decoded.startsWith(prefix)) return null;
  const absolute = decoded.slice(prefix.length).replace(/\//g, "/");
  const rootForward = vaultRoot.replace(/\\/g, "/");
  return absolute.startsWith(`${rootForward}/`) ? absolute.slice(rootForward.length + 1) : null;
}

let descriptor;
let requestCounter = 0;
async function modernRequest(method, params = {}, timeoutMs = 10_000) {
  const id = `live-${++requestCounter}`;
  const name = method === "tools/call" ? params.name : method === "resources/read" ? params.uri : undefined;
  const headers = {
    authorization: `Bearer ${descriptor.auth.token}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(typeof name === "string" ? { "mcp-name": name } : {}),
  };
  const response = await fetch(descriptor.httpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: { ...MODERN_META, ...(params._meta ?? {}) } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function toolText(body) {
  const content = body?.result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? "").join("\n");
}

async function callTool(name, toolArgs = {}, timeoutMs = 10_000) {
  const { status, body } = await modernRequest("tools/call", { name, arguments: toolArgs }, timeoutMs);
  if (status !== 200 || !body || body.error) {
    return { ok: false, error: body?.error ? JSON.stringify(body.error) : `HTTP ${status}` };
  }
  return { ok: true, body, text: toolText(body), isError: Boolean(body.result?.isError) };
}

async function getOpenTabs() {
  const call = await callTool("getOpenEditors");
  if (!call.ok) return { call, tabs: [] };
  try {
    const parsed = JSON.parse(call.text);
    return { call, tabs: Array.isArray(parsed?.tabs) ? parsed.tabs : [] };
  } catch {
    return { call, tabs: [] };
  }
}

async function openDiffTask(newContents) {
  const { status, body } = await modernRequest("tools/call", {
    name: "openDiff",
    arguments: {
      new_file_path: SCRATCH_NAME,
      new_file_contents: newContents,
      tab_name: DIFF_TAB_NAME,
    },
  });
  const task = body?.result;
  if (status !== 200 || task?.resultType !== "task" || typeof task?.taskId !== "string") {
    return { ok: false, error: `unexpected openDiff response: HTTP ${status} ${JSON.stringify(body)}` };
  }
  return { ok: true, taskId: task.taskId };
}

async function getTask(taskId) {
  const { body } = await modernRequest("tasks/get", { taskId });
  return body?.result ?? {};
}

async function settleDiffSweep() {
  await callTool("closeAllDiffTabs").catch(() => {});
}

async function stdioSpotCheck() {
  const pluginDir = path.resolve(path.dirname(runtimePath), "..", "..");
  const launcher = path.join(pluginDir, "universal-mcp-stdio.cjs");
  if (!fs.existsSync(launcher)) {
    return check(false, "stdio 通道", `启动器不存在: ${launcher}`);
  }
  const child = spawn(process.execPath, [launcher, "--runtime", runtimePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const response = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("stdio tools/list 超时")), 10_000);
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message?.id === "stdio-tools") {
          clearTimeout(timer);
          resolvePromise(message);
        }
      });
      child.stderr.on("data", () => {});
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "stdio-tools",
        method: "tools/list",
        params: { _meta: MODERN_META },
      })}\n`);
    });
    const tools = response?.result?.tools;
    const names = Array.isArray(tools) ? tools.map((tool) => tool.name).sort() : [];
    check(
      names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((name) => names.includes(name)),
      "stdio 通道 tools/list",
      `${names.length} 个工具`,
    );
  } catch (error) {
    check(false, "stdio 通道", String(error));
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }
}

async function checkReadCurrentWebPage() {
  const call = await callTool("readCurrentWebPage");
  if (!check(call.ok, "readCurrentWebPage 可达", call.ok ? "" : call.error)) return;
  const looksLikePage = call.text.length > 200 && !call.isError;
  report(true, "readCurrentWebPage 结果", looksLikePage
    ? `返回网页正文 ${call.text.length} 字符`
    : `无前台网页时的响应：${call.text.slice(0, 120) || "(空)"}`);
  if (looksLikePage) console.log(call.text.slice(0, 500));
}

async function checkOpenDiffAccept() {
  const accepted = "# live check accept\n这行内容由 openDiff 接受路径写入。\n";
  await fsp.writeFile(scratchPath, "# live check\n原始内容。\n", "utf8");
  try {
    console.log(`已创建 ${SCRATCH_NAME} 并打开 diff，请在 Obsidian 中点击「接受」…（最长等待 5 分钟）`);
    const created = await openDiffTask(accepted);
    if (!check(created.ok, "openDiff 创建任务", created.ok ? "" : created.error)) return;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const task = await getTask(created.taskId);
      if (task.status === "completed") {
        // 契约：接受后插件回执 FILE_SAVED + 最终内容，由调用方负责写盘。
        const parts = (task.result?.content ?? []).map((part) => part?.text ?? "");
        check(parts[0] === "FILE_SAVED", "openDiff 接受回执", parts[0] ?? "(空)");
        check(
          parts[1] === accepted,
          "openDiff 返回最终内容",
          parts[1] === accepted ? "与提交内容一致" : `收到 ${(parts[1] ?? "").length} 字符（用户可能在 diff 中编辑过）`,
        );
        return;
      }
      if (task.status && task.status !== "working") {
        check(false, "openDiff 接受路径", `任务意外终结: ${task.status}`);
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    check(false, "openDiff 接受路径", "等待用户接受超时");
  } finally {
    await settleDiffSweep();
    await fsp.rm(scratchPath, { force: true });
  }
}

async function checkResourcesWatch() {
  console.log("轮询 latest-selection / latest-mention 资源 60 秒；请在 Obsidian 中选中文字并执行「发送当前选区」命令…");
  const seen = new Map();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const [label, uri] of Object.entries(RESOURCE_URIS)) {
      if (label === "context" || label === "open-editors") continue;
      const { body } = await modernRequest("resources/read", { uri });
      const text = (body?.result?.contents ?? []).map((part) => part?.text ?? "").join("\n");
      if (seen.get(label) !== text) {
        seen.set(label, text);
        console.log(`[${label}] ${text.slice(0, 160).replace(/\n/g, " ")}`);
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  report(seen.has("latest-selection"), "latest-selection 资源联动", "见上方输出");
  report(seen.has("latest-mention"), "latest-mention 资源联动", "见上方输出");
}

async function main() {
  if (!fs.existsSync(runtimePath)) {
    console.error(`找不到运行描述: ${runtimePath}\n请在 Obsidian 设置中开启「暴露 mv-AIDE 协议」。`);
    process.exitCode = 1;
    return;
  }
  descriptor = JSON.parse(await fsp.readFile(runtimePath, "utf8"));
  const health = await fetch(new URL("/healthz", descriptor.httpUrl), {
    headers: { authorization: `Bearer ${descriptor.auth.token}` },
    signal: AbortSignal.timeout(3_000),
  }).then((response) => response.json()).catch(() => null);
  if (!health?.ok || health.instanceId !== descriptor.instanceId || health.pid !== descriptor.pid) {
    console.error("运行描述已失效或服务未就绪，请在 Obsidian 中重载插件后重试。");
    process.exitCode = 1;
    return;
  }
  console.log(`服务存活：${descriptor.httpUrl}（pid ${descriptor.pid}）`);

  if (only === "readCurrentWebPage") return await checkReadCurrentWebPage();
  if (only === "open-diff-accept") return await checkOpenDiffAccept();
  if (only === "resources-watch") return await checkResourcesWatch();
  if (only) {
    console.error(`未知 --only 检查项: ${only}`);
    process.exitCode = 1;
    return;
  }

  // Baseline of the user's open tabs; the scratch file is the only thing we add.
  const baseline = await getOpenTabs();
  const baselineKeys = new Set(baseline.tabs.map(tabKey));
  // openFile reuses the current leaf, so it may navigate the active markdown
  // tab away; remember it and put it back before comparing baselines.
  const displacedTab = baseline.tabs.find(
    (tab) => tab.isActive && tab.viewType === "markdown" && String(tab.uri ?? "").startsWith("file://"),
  );
  const displacedPath = displacedTab ? fileUriToVaultPath(displacedTab.uri) : null;

  try {
    // 0. Discovery and the full tool surface.
    const discover = await modernRequest("server/discover");
    check(
      discover.status === 200
        && ["2026-07-28", "2025-11-25", "2025-03-26"].every((version) =>
          discover.body?.result?.supportedVersions?.includes(version)),
      "server/discover 三版本",
    );
    const list = await modernRequest("tools/list");
    const names = (list.body?.result?.tools ?? []).map((tool) => tool.name).sort();
    check(
      names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((name) => names.includes(name)),
      "tools/list 完整 8 工具",
      names.join(", "),
    );

    // 1. getLatestSelection
    const selection = await callTool("getLatestSelection");
    check(selection.ok, "getLatestSelection", selection.ok
      ? (selection.isError ? "尚未跟踪选区（设计内响应）" : selection.text.slice(0, 100).replace(/\n/g, " "))
      : selection.error);

    // 2. getOpenEditors
    check(
      baseline.call.ok && baseline.tabs.length > 0,
      "getOpenEditors",
      `${baseline.tabs.length} 个标签`,
    );

    // 3. getDiagnostics
    const diagnostics = await callTool("getDiagnostics");
    check(diagnostics.ok && diagnostics.text.trim() === "[]", "getDiagnostics", diagnostics.text.trim());

    // 4. openFile on the scratch note. The vault needs a moment to index the
    // freshly written file, so retry until Obsidian sees it.
    await fsp.writeFile(scratchPath, "# live check\n第一行\n第二行\n", "utf8");
    const open = await waitFor(async () => {
      const attempt = await callTool("openFile", { filePath: SCRATCH_NAME, line: 1 });
      return attempt.ok && /"success"\s*:\s*true/.test(attempt.text) ? attempt : null;
    }, 15_000);
    check(open !== null, "openFile", open ? "success:true" : "vault 索引超时");
    const afterOpen = await waitFor(async () => {
      const snapshot = await getOpenTabs();
      return snapshot.tabs.some((tab) => String(tab.uri ?? tab.label).includes("mv-obcc-live-check-scratch"))
        ? snapshot
        : null;
    }, 10_000);
    check(afterOpen !== null, "openFile 标签可见");

    // 5. readCurrentWebPage (graceful path; full path is a manual step).
    await checkReadCurrentWebPage();

    // 6. openDiff (task) + 7. close_tab settling it. Diff view construction in
    // Obsidian is asynchronous, so wait for the tab to materialize first.
    const isOurDiffTab = (tab) =>
      tab.viewType === DIFF_VIEW_TYPE && String(tab.label ?? "").includes(DIFF_TAB_NAME);
    const created = await openDiffTask("# live check\n第一行被修改\n第二行\n");
    check(created.ok, "openDiff 任务创建", created.ok ? `taskId ${created.taskId}` : created.error);
    if (created.ok) {
      const diffVisible = await waitFor(async () => {
        const snapshot = await getOpenTabs();
        return snapshot.tabs.some(isOurDiffTab);
      });
      check(diffVisible !== null, "openDiff 标签可见");
      const closed = await callTool("close_tab", { tab_name: DIFF_TAB_NAME });
      check(closed.ok && /"closed"\s*:\s*[1-9]/.test(closed.text), "close_tab", closed.text.slice(0, 80));
      const settled = await waitFor(async () => {
        const task = await getTask(created.taskId);
        return task.status === "completed" ? task : null;
      });
      const settledText = (settled?.result?.content ?? []).map((part) => part?.text ?? "").join("\n");
      check(
        settled !== null && settledText.includes("DIFF_REJECTED"),
        "close_tab 了结 openDiff 任务",
        settled ? "completed/DIFF_REJECTED" : "任务未了结",
      );
    }

    // 8. closeAllDiffTabs on a fresh diff.
    const second = await openDiffTask("# live check\n又一次修改\n第二行\n");
    if (check(second.ok, "openDiff 再次创建", second.ok ? "" : second.error)) {
      await waitFor(async () => {
        const snapshot = await getOpenTabs();
        return snapshot.tabs.some(isOurDiffTab);
      });
      const sweep = await callTool("closeAllDiffTabs");
      check(sweep.ok && /"closed"\s*:\s*[1-9]/.test(sweep.text), "closeAllDiffTabs", sweep.text.slice(0, 80));
      const settled = await waitFor(async () => {
        const task = await getTask(second.taskId);
        return task.status === "completed" ? task : null;
      });
      check(settled !== null, "closeAllDiffTabs 了结任务", settled ? "completed" : "任务未了结");
    }
    const sweptClean = await waitFor(async () => {
      const snapshot = await getOpenTabs();
      return !snapshot.tabs.some(isOurDiffTab) ? snapshot : null;
    }, 10_000);
    check(sweptClean !== null, "diff 标签无残留");

    // 9. The four workspace resources.
    for (const [label, uri] of Object.entries(RESOURCE_URIS)) {
      const { status, body } = await modernRequest("resources/read", { uri });
      const text = (body?.result?.contents ?? []).map((part) => part?.text ?? "").join("\n");
      check(status === 200 && !body?.error && text.length > 0, `资源 ${label}`, `${text.length} 字符`);
    }

    // 10. stdio launcher against the live descriptor.
    await stdioSpotCheck();

    // 11. Restore the tab our openFile navigated away, then verify the user's
    // own tabs are untouched.
    if (displacedPath) {
      await callTool("openFile", { filePath: displacedPath });
      await waitFor(async () => {
        const snapshot = await getOpenTabs();
        return snapshot.tabs.some((tab) => String(tab.uri ?? "") === String(displacedTab.uri)) ? snapshot : null;
      }, 10_000);
    }
    const final = await getOpenTabs();
    const finalKeys = new Set(final.tabs.map(tabKey));
    const missing = [...baselineKeys].filter((key) => !finalKeys.has(key));
    check(missing.length === 0, "用户标签页零变化", missing.join(", ") || "基线一致");
  } finally {
    await settleDiffSweep();
    await fsp.rm(scratchPath, { force: true });
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 项通过 ===`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
