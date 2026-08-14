import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { processOutput, runProcess } from "../process-runner";
import { DSH_PLUGIN_FILES } from "./dsh-plugin-bundle";
import type { DshCommand } from "./dsh-process";

export const DSH_PLUGIN_NAME = "@mv-aide/dsh-plugin";
const ROW_ID = "mv-aide";

const DEFAULT_PATCH_FILE =
  "# Your patch layer for this dsh profile, applied after every bundle layer:\n" +
  "# a top-level YAML array of loader patch entries (id-targeted config\n" +
  "# overrides, disables, and insert lists; `!!js` expressions allowed).\n" +
  "[]\n";

const PATCH_INSERT_BLOCK = [
  "- insert:",
  "    - id: mv-aide",
  "      name: '@mv-aide/dsh-plugin'",
  "",
].join("\n");

export function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function webProfileDir(): string {
  return path.join(dshHome(), "profiles", "web");
}

/** mv-AIDE-owned DSH files stay inside the current vault. */
export function stablePluginDir(vaultRoot: string): string {
  return path.join(vaultRoot, "mv-aide", "dsh", "plugin");
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
  return manifest.dsh?.profile?.bundles?.includes(DSH_PLUGIN_NAME) === true;
}

function hasMvAideRow(content: string): boolean {
  return /id:\s*['"]?mv-aide['"]?/u.test(content);
}

function hasEmptyListToken(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => line.trim() === "[]");
}

export function isHealthyPatchFile(content: string): boolean {
  return hasMvAideRow(content) && !hasEmptyListToken(content);
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
      if (hasMvAideRow(block) || block.includes(DSH_PLUGIN_NAME)) {
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
  if (!bundles.includes(DSH_PLUGIN_NAME)) return;
  manifest.dsh = {
    ...manifest.dsh,
    profile: {
      ...(manifest.dsh?.profile ?? {}),
      bundles: bundles.filter((name) => name !== DSH_PLUGIN_NAME),
    },
  };
  await writeProfileManifest(profileDir, manifest);
}

async function materializePlugin(vaultRoot: string): Promise<string> {
  const target = stablePluginDir(vaultRoot);
  await fs.rm(target, { recursive: true, force: true });
  for (const [relativePath, content] of Object.entries(DSH_PLUGIN_FILES)) {
    const output = path.join(target, relativePath);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, content, "utf8");
  }
  return target;
}

/** Inspect actual files. Persisted settings are deliberately ignored. */
export async function inspectDshInjection(vaultRoot: string): Promise<DshInjectionStatus> {
  const profileDir = webProfileDir();
  const manifest = await readProfileManifest(profileDir);
  const patch = await fs
    .readFile(path.join(profileDir, "cordis.patch.yml"), "utf8")
    .catch(() => "");
  const packageInstalled = await pathExists(
    path.join(profileDir, "node_modules", "@mv-aide", "dsh-plugin", "package.json"),
  );
  const sourceReady = await pathExists(path.join(stablePluginDir(vaultRoot), "package.json"));
  const dependencyRegistered = Boolean(manifest?.dependencies?.[DSH_PLUGIN_NAME]);
  const legacyBundle = bundlesContainPlugin(manifest ?? {});
  const patchReady = isHealthyPatchFile(patch);

  if (packageInstalled && patchReady && !legacyBundle) {
    return { state: "ready", detail: "DSH web profile 中的插件包与热加载配置均有效。" };
  }
  if (sourceReady || packageInstalled || dependencyRegistered || hasMvAideRow(patch) || legacyBundle) {
    return { state: "partial", detail: "检测到不完整或旧版注入，需要修复。" };
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
  return { ok: result.code === 0 && detail.includes(ROW_ID), detail };
}

/** Install and verify the bridge package without blocking the renderer. */
export async function injectDshPlugin(
  vaultRoot: string,
  command: DshCommand,
): Promise<InjectResult> {
  let target: string;
  try {
    target = await materializePlugin(vaultRoot);
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
      return { ok: true, message: "mv-AIDE 插件已注入并通过实际配置校验。" };
    }
  }

  const installed = await runProcess(
    command.executable,
    [
      ...command.argsPrefix,
      "plugin",
      "--profile",
      "web",
      "add",
      fileSpec(target),
    ],
    {
      timeoutMs: 300_000,
      env: command.env,
    },
  );
  if (installed.code !== 0) {
    return {
      ok: false,
      message: `DSH 插件安装失败：${processOutput(installed) || "无输出"}`,
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
    return { ok: true, message: "DSH 与 mv-AIDE 插件均已安装并通过校验。" };
  }
  return {
    ok: false,
    message: `插件文件已写入，但实际配置校验失败：${verified.detail.slice(-600) || disk.detail}`,
  };
}
