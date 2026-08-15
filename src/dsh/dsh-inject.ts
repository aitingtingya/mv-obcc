import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { processOutput, runProcess } from "../process-runner";
import { MV_AGENT_PLUGIN_FILES, MV_DSH_MANAGER_PLUGIN_FILES } from "./dsh-plugin-bundle";
import type { DshCommand } from "./dsh-process";

export const DSH_AGENT_PLUGIN_NAME = "@mv-aide/mv-agent";
export const DSH_PM_PLUGIN_NAME = "@mv-aide/mv-dsh-manager";
export const DSH_PLUGIN_NAME = DSH_AGENT_PLUGIN_NAME;
const AGENT_ROW_ID = "mv-agent";
const PM_ROW_ID = "mv-dsh-manager";

const DEFAULT_PATCH_FILE =
  "# Your patch layer for this dsh profile, applied after every bundle layer:\n" +
  "# a top-level YAML array of loader patch entries (id-targeted config\n" +
  "# overrides, disables, and insert lists; `!!js` expressions allowed).\n" +
  "[]\n";

const PATCH_INSERT_BLOCK = [
  "- insert:",
  "    - id: mv-agent",
  "      name: '@mv-aide/mv-agent'",
  "    - id: mv-dsh-manager",
  "      name: '@mv-aide/mv-dsh-manager'",
  "",
].join("\n");

export function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function webProfileDir(): string {
  return path.join(dshHome(), "profiles", "web");
}

/** mv-AIDE-owned DSH files stay inside the current vault. */
export function stablePluginDir(vaultRoot: string, subName?: string): string {
  return subName
    ? path.join(vaultRoot, "mv-aide", "dsh", "plugin", subName)
    : path.join(vaultRoot, "mv-aide", "dsh", "plugin");
}

export interface InjectResult {
  ok: boolean;
  message: string;
}

export type DshInjectionState = "ready" | "missing" | "partial";

export interface DshInjectionStatus {
  state: DshInjectionState;
  detail: string;
}

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readProfileManifest(profileDir: string): Promise<ProfileManifest | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(profileDir, "package.json"), "utf8"),
    ) as ProfileManifest;
  } catch {
    return null;
  }
}

async function writeProfileManifest(
  profileDir: string,
  manifest: ProfileManifest,
): Promise<void> {
  await fs.writeFile(
    path.join(profileDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function fileSpec(dir: string): string {
  return `file:${dir.replace(/\\/gu, "/")}`;
}

function bundlesContainPlugin(manifest: ProfileManifest): boolean {
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  return (
    bundles.includes(DSH_AGENT_PLUGIN_NAME) ||
    bundles.includes(DSH_PM_PLUGIN_NAME) ||
    bundles.includes("@mv-aide/mv-plugin-manager") ||
    bundles.includes("@mv-aide/dsh-plugin")
  );
}

function hasMvAideRows(content: string): boolean {
  return (
    (/id:\s*['"]?mv-agent['"]?/u.test(content) || /id:\s*['"]?mv-aide['"]?/u.test(content)) &&
    (/id:\s*['"]?mv-dsh-manager['"]?/u.test(content) || /id:\s*['"]?mv-plugin-manager['"]?/u.test(content))
  );
}

function hasEmptyListToken(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => line.trim() === "[]");
}

export function isHealthyPatchFile(content: string): boolean {
  return hasMvAideRows(content) && !hasEmptyListToken(content);
}

export function healPatchFile(content: string): string {
  if (isHealthyPatchFile(content)) return content;
  const lines = content.split(/\r?\n/u);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "[]") continue;
    if (/^\s*-?\s*insert:\s*$/u.test(line)) {
      let j = i + 1;
      while (j < lines.length && /^\s/u.test(lines[j])) j += 1;
      const block = lines.slice(i + 1, j).join("\n");
      if (
        block.includes("mv-aide") ||
        block.includes("mv-agent") ||
        block.includes("mv-dsh-manager") ||
        block.includes("mv-plugin-manager") ||
        block.includes("@mv-aide/")
      ) {
        i = j - 1;
        continue;
      }
    }
    kept.push(line);
  }
  const base = kept.join("\n").replace(/\s+$/u, "");
  return base.length > 0 ? `${base}\n\n${PATCH_INSERT_BLOCK}` : PATCH_INSERT_BLOCK;
}

async function writePatchInsert(profileDir: string): Promise<void> {
  const file = path.join(profileDir, "cordis.patch.yml");
  const existing = await fs.readFile(file, "utf8").catch(() => DEFAULT_PATCH_FILE);
  await fs.writeFile(file, healPatchFile(existing), "utf8");
}

async function cleanupBundles(profileDir: string): Promise<void> {
  const manifest = await readProfileManifest(profileDir);
  if (!manifest) return;
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const filtered = bundles.filter(
    (name) =>
      name !== DSH_AGENT_PLUGIN_NAME &&
      name !== DSH_PM_PLUGIN_NAME &&
      name !== "@mv-aide/mv-plugin-manager" &&
      name !== "@mv-aide/dsh-plugin",
  );
  if (filtered.length === bundles.length) return;
  manifest.dsh = {
    ...manifest.dsh,
    profile: {
      ...(manifest.dsh?.profile ?? {}),
      bundles: filtered,
    },
  };
  await writeProfileManifest(profileDir, manifest);
}

async function materializePackage(
  targetDir: string,
  nodeModulesTargetDirs: string[],
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const output = path.join(targetDir, relativePath);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, content, "utf8");

    for (const installedDir of nodeModulesTargetDirs) {
      try {
        const profileOutput = path.join(installedDir, relativePath);
        await fs.mkdir(path.dirname(profileOutput), { recursive: true });
        await fs.writeFile(profileOutput, content, "utf8");
      } catch {
        // Ignore if directory doesn't exist yet before first install
      }
    }
  }
}

async function materializePlugin(vaultRoot: string): Promise<{ agentDir: string; pmDir: string }> {
  const agentDir = stablePluginDir(vaultRoot, "mv-agent");
  const pmDir = stablePluginDir(vaultRoot, "mv-dsh-manager");
  const profileDir = webProfileDir();

  const agentNodeModules = [
    path.join(profileDir, "node_modules", "@mv-aide", "mv-agent"),
    path.join(profileDir, "node_modules", "@mv-aide", "dsh-plugin"),
  ];
  const pmNodeModules = [
    path.join(profileDir, "node_modules", "@mv-aide", "mv-dsh-manager"),
    path.join(profileDir, "node_modules", "@mv-aide", "mv-plugin-manager"),
  ];

  await materializePackage(agentDir, agentNodeModules, MV_AGENT_PLUGIN_FILES);
  await materializePackage(pmDir, pmNodeModules, MV_DSH_MANAGER_PLUGIN_FILES);

  return { agentDir, pmDir };
}

/** Inspect actual files. Persisted settings are deliberately ignored. */
export async function inspectDshInjection(vaultRoot: string): Promise<DshInjectionStatus> {
  const profileDir = webProfileDir();
  const manifest = await readProfileManifest(profileDir);
  const patch = await fs
    .readFile(path.join(profileDir, "cordis.patch.yml"), "utf8")
    .catch(() => "");

  const agentInstalled =
    (await pathExists(path.join(profileDir, "node_modules", "@mv-aide", "mv-agent", "package.json"))) ||
    (await pathExists(path.join(profileDir, "node_modules", "@mv-aide", "dsh-plugin", "package.json")));
  const pmInstalled =
    (await pathExists(path.join(profileDir, "node_modules", "@mv-aide", "mv-dsh-manager", "package.json"))) ||
    (await pathExists(path.join(profileDir, "node_modules", "@mv-aide", "mv-plugin-manager", "package.json")));

  const agentSource = await pathExists(path.join(stablePluginDir(vaultRoot, "mv-agent"), "package.json"));
  const pmSource = await pathExists(path.join(stablePluginDir(vaultRoot, "mv-dsh-manager"), "package.json"));

  const dependencyRegistered =
    Boolean(manifest?.dependencies?.[DSH_AGENT_PLUGIN_NAME]) ||
    Boolean(manifest?.dependencies?.["@mv-aide/dsh-plugin"]);
  const legacyBundle = bundlesContainPlugin(manifest ?? {});
  const patchReady = isHealthyPatchFile(patch);

  if (agentInstalled && pmInstalled && patchReady && !legacyBundle) {
    return { state: "ready", detail: "DSH web profile 中的 mv-agent 与 mv-dsh-manager 插件包及热加载配置均有效。" };
  }
  if (agentSource || pmSource || agentInstalled || pmInstalled || dependencyRegistered || hasMvAideRows(patch) || legacyBundle) {
    return { state: "partial", detail: "检测到不完整或旧版注入，需要更新修复。" };
  }
  return { state: "missing", detail: "尚未向 DSH web profile 注入插件。" };
}

async function verifyInjection(command: DshCommand): Promise<{ ok: boolean; detail: string }> {
  const result = await runProcess(
    command.executable,
    [...command.argsPrefix, "--profile", "web", "--dump-config"],
    { timeoutMs: 120_000, env: command.env },
  );
  const detail = processOutput(result);
  const hasAgent = detail.includes(AGENT_ROW_ID) || detail.includes("mv-aide");
  const hasPm = detail.includes(PM_ROW_ID) || detail.includes("mv-plugin-manager");
  return { ok: result.code === 0 && hasAgent && hasPm, detail };
}

/** Install and verify the bridge packages without blocking the renderer. */
export async function injectDshPlugin(
  vaultRoot: string,
  command: DshCommand,
): Promise<InjectResult> {
  let dirs: { agentDir: string; pmDir: string };
  try {
    dirs = await materializePlugin(vaultRoot);
  } catch (error) {
    return {
      ok: false,
      message: `写入仓库内 DSH 插件失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const profileDir = webProfileDir();
  await fs.mkdir(profileDir, { recursive: true });
  const before = await inspectDshInjection(vaultRoot);
  if (before.state === "ready") {
    const verified = await verifyInjection(command);
    if (verified.ok) {
      return { ok: true, message: "mv-agent 与 mv-dsh-manager 插件已注入并通过实际配置校验。" };
    }
  }

  // Install mv-agent
  const installedAgent = await runProcess(
    command.executable,
    [
      ...command.argsPrefix,
      "plugin",
      "--profile",
      "web",
      "add",
      fileSpec(dirs.agentDir),
    ],
    { timeoutMs: 300_000, env: command.env },
  );
  if (installedAgent.code !== 0) {
    return {
      ok: false,
      message: `DSH mv-agent 插件安装失败：${processOutput(installedAgent) || "无输出"}`,
    };
  }

  // Install mv-dsh-manager
  const installedPm = await runProcess(
    command.executable,
    [
      ...command.argsPrefix,
      "plugin",
      "--profile",
      "web",
      "add",
      fileSpec(dirs.pmDir),
    ],
    { timeoutMs: 300_000, env: command.env },
  );
  if (installedPm.code !== 0) {
    return {
      ok: false,
      message: `DSH mv-dsh-manager 插件安装失败：${processOutput(installedPm) || "无输出"}`,
    };
  }

  try {
    await writePatchInsert(profileDir);
    await cleanupBundles(profileDir);
  } catch (error) {
    return {
      ok: false,
      message: `DSH 注入配置写入失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const disk = await inspectDshInjection(vaultRoot);
  const verified = await verifyInjection(command);
  if (disk.state === "ready" && verified.ok) {
    return { ok: true, message: "DSH、mv-agent 与 mv-dsh-manager 插件均已安装并通过校验。" };
  }
  return {
    ok: false,
    message: `插件文件已写入，但实际配置校验失败：${verified.detail.slice(-600) || disk.detail}`,
  };
}
