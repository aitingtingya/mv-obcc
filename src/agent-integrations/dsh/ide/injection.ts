import { promises as fs } from "node:fs";
import path from "node:path";
import { processOutput, runProcess } from "../../../process-runner";
import { MV_AGENT_PLUGIN_FILES, MV_DSH_MANAGER_PLUGIN_FILES } from "./plugin-bundle";
import {
  dshPluginBundleFingerprint,
  installedDshPluginBundleMatches,
  writeDshPluginBundleMarker,
} from "./plugin-integrity";
import type { DshCommand } from "../runtime/process";
import {
  dshAgentPackageDirectory,
  dshManagerPackageDirectory,
  dshVaultDirectory,
  dshWebProfileDirectory,
  dshWebProfilePatchPath,
} from "../paths";

export const DSH_AGENT_BUNDLE_FINGERPRINT = dshPluginBundleFingerprint(MV_AGENT_PLUGIN_FILES);
export const DSH_MANAGER_BUNDLE_FINGERPRINT = dshPluginBundleFingerprint(MV_DSH_MANAGER_PLUGIN_FILES);

export const DSH_AGENT_PLUGIN_NAME = "@mv-aide/mv-agent";
export const DSH_PM_PLUGIN_NAME = "@mv-aide/mv-dsh-manager";
export const DSH_PLUGIN_NAME = DSH_AGENT_PLUGIN_NAME;

const DSH_MANAGED_PLUGINS = {
  agent: { id: "mv-agent", name: DSH_AGENT_PLUGIN_NAME, legacyIds: ["mv-aide"] },
  manager: { id: "mv-dsh-manager", name: DSH_PM_PLUGIN_NAME, legacyIds: ["mv-plugin-manager"] },
} as const;

const DEFAULT_PATCH_FILE =
  "# Your patch layer for this dsh profile, applied after every bundle layer:\n" +
  "# a top-level YAML array of loader patch entries (id-targeted config\n" +
  "# overrides, disables, and insert lists; `!!js` expressions allowed).\n" +
  "[]\n";

export interface InjectResult {
  ok: boolean;
  message: string;
  changed?: boolean;
}

export type DshInjectionState = "ready" | "missing" | "partial";

export interface DshInjectionStatus {
  state: DshInjectionState;
  detail: string;
}

export interface DshInjectionStatuses {
  agent: DshInjectionStatus;
  manager: DshInjectionStatus;
  full: DshInjectionStatus;
}

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

type ManagedPluginKind = keyof typeof DSH_MANAGED_PLUGINS;
type InjectionTarget = "ide" | "full";

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
    return JSON.parse(await fs.readFile(path.join(profileDir, "package.json"), "utf8")) as ProfileManifest;
  } catch {
    return null;
  }
}

async function writeProfileManifest(profileDir: string, manifest: ProfileManifest): Promise<void> {
  await fs.writeFile(path.join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function rowAliases(kind: ManagedPluginKind): readonly string[] {
  const descriptor = DSH_MANAGED_PLUGINS[kind];
  return [descriptor.id, ...descriptor.legacyIds];
}

function rowId(line: string): string | null {
  const match = /^\s*-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line);
  return match?.[1] ?? null;
}

function indentation(line: string): number {
  return /^\s*/u.exec(line)?.[0].length ?? 0;
}

function removeManagedPatchRows(content: string, kinds: readonly ManagedPluginKind[]): string {
  const aliases = new Set(kinds.flatMap((kind) => [...rowAliases(kind)]));
  const lines = content.split(/\r?\n/u);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "[]") continue;
    const id = rowId(line);
    if (!id || !aliases.has(id)) {
      kept.push(line);
      continue;
    }
    const baseIndent = indentation(line);
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next.trim() === "") {
        index += 1;
        continue;
      }
      if (indentation(next) <= baseIndent) break;
      index += 1;
    }
  }

  const compacted: string[] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const line = kept[index];
    if (!/^\s*-?\s*insert:\s*$/u.test(line)) {
      compacted.push(line);
      continue;
    }
    let cursor = index + 1;
    while (cursor < kept.length && kept[cursor].trim() === "") cursor += 1;
    if (cursor >= kept.length || indentation(kept[cursor]) <= indentation(line)) continue;
    compacted.push(line);
  }
  return compacted.join("\n").replace(/\s+$/u, "");
}

function patchRowsBlock(kinds: readonly ManagedPluginKind[]): string {
  return [
    "- insert:",
    ...kinds.flatMap((kind) => {
      const descriptor = DSH_MANAGED_PLUGINS[kind];
      return [
        `    - id: ${descriptor.id}`,
        `      name: '${descriptor.name}'`,
      ];
    }),
  ].join("\n");
}

function patchRowReady(content: string, kind: ManagedPluginKind): boolean {
  const descriptor = DSH_MANAGED_PLUGINS[kind];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (rowId(lines[index]) !== descriptor.id) continue;
    const baseIndent = indentation(lines[index]);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === "") continue;
      if (indentation(line) <= baseIndent) break;
      const nameMatch = /^\s*name:\s*['"]?([^'"]+)['"]?\s*$/u.exec(line);
      if (nameMatch?.[1] === descriptor.name) return true;
    }
  }
  return false;
}

function ensurePatchRows(content: string, kinds: readonly ManagedPluginKind[]): string {
  const base = removeManagedPatchRows(content, kinds);
  const block = patchRowsBlock(kinds);
  return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function ensureAgentPatchRow(content: string): string {
  return ensurePatchRows(content, ["agent"]);
}

export function ensureFullPatchRows(content: string): string {
  return ensurePatchRows(content, ["agent", "manager"]);
}

export function isHealthyPatchFile(content: string): boolean {
  return patchRowReady(content, "agent") && patchRowReady(content, "manager") && !content.split(/\r?\n/u).some((line) => line.trim() === "[]");
}

export function healPatchFile(content: string): string {
  return isHealthyPatchFile(content) ? content : ensureFullPatchRows(content);
}

async function writePatchRows(target: InjectionTarget): Promise<void> {
  const existing = await fs.readFile(dshWebProfilePatchPath(), "utf8").catch(() => DEFAULT_PATCH_FILE);
  const next = target === "ide" ? ensureAgentPatchRow(existing) : ensureFullPatchRows(existing);
  if (next !== existing) await fs.writeFile(dshWebProfilePatchPath(), next, "utf8");
}

function bundleNamesFor(kind: ManagedPluginKind): readonly string[] {
  return kind === "agent"
    ? [DSH_AGENT_PLUGIN_NAME, "@mv-aide/dsh-plugin"]
    : [DSH_PM_PLUGIN_NAME, "@mv-aide/mv-plugin-manager"];
}

function bundlesContainPlugin(manifest: ProfileManifest, kind: ManagedPluginKind): boolean {
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  return bundleNamesFor(kind).some((name) => bundles.includes(name));
}

async function cleanupBundles(target: InjectionTarget): Promise<void> {
  const profileDir = dshWebProfileDirectory();
  const manifest = await readProfileManifest(profileDir);
  if (!manifest) return;
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const remove = new Set(
    (target === "ide" ? (["agent"] as const) : (["agent", "manager"] as const))
      .flatMap((kind) => [...bundleNamesFor(kind)]),
  );
  const filtered = bundles.filter((name) => !remove.has(name));
  if (filtered.length === bundles.length) return;
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...(manifest.dsh?.profile ?? {}), bundles: filtered },
  };
  await writeProfileManifest(profileDir, manifest);
}

async function writePackage(
  installedDir: string,
  files: Readonly<Record<string, string>>,
  fingerprint: string,
): Promise<void> {
  await fs.rm(installedDir, { recursive: true, force: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const output = path.join(installedDir, relativePath);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, content, "utf8");
  }
  await writeDshPluginBundleMarker(installedDir, fingerprint);
}

export async function materializeAgentPlugin(): Promise<void> {
  await fs.mkdir(dshWebProfileDirectory(), { recursive: true });
  await writePackage(dshAgentPackageDirectory(), MV_AGENT_PLUGIN_FILES, DSH_AGENT_BUNDLE_FINGERPRINT);
}

export async function materializeManagerPlugin(): Promise<void> {
  await fs.mkdir(dshWebProfileDirectory(), { recursive: true });
  await writePackage(dshManagerPackageDirectory(), MV_DSH_MANAGER_PLUGIN_FILES, DSH_MANAGER_BUNDLE_FINGERPRINT);
}

export async function materializeFullPluginSet(): Promise<void> {
  await materializeAgentPlugin();
  await materializeManagerPlugin();
}

async function legacyVaultPluginExists(vaultRoot: string, kind: ManagedPluginKind): Promise<boolean> {
  const subdirs = kind === "agent" ? ["mv-agent"] : ["mv-dsh-manager", "mv-plugin-manager"];
  for (const subdir of subdirs) {
    if (await pathExists(path.join(dshVaultDirectory(vaultRoot), "plugin", subdir, "package.json"))) return true;
  }
  return false;
}

async function legacyProfileArtifactsExist(profileDir: string, kind: ManagedPluginKind): Promise<boolean> {
  const manifest = await readProfileManifest(profileDir);
  const dependencies = manifest?.dependencies ?? {};
  for (const name of bundleNamesFor(kind)) {
    if (dependencies[name]) return true;
  }
  const legacyPackages = kind === "agent" ? ["@mv-aide/dsh-plugin"] : ["@mv-aide/mv-plugin-manager"];
  for (const name of legacyPackages) {
    const packageName = name.slice("@mv-aide/".length);
    if (await pathExists(path.join(profileDir, "node_modules", "@mv-aide", packageName, "package.json"))) return true;
  }
  return false;
}

async function cleanupLegacyInjection(vaultRoot: string, target: InjectionTarget): Promise<void> {
  const profileDir = dshWebProfileDirectory();
  const kinds: readonly ManagedPluginKind[] = target === "ide" ? ["agent"] : ["agent", "manager"];
  for (const kind of kinds) {
    const legacyPackages = kind === "agent" ? ["dsh-plugin"] : ["mv-plugin-manager"];
    for (const packageName of legacyPackages) {
      await fs.rm(path.join(profileDir, "node_modules", "@mv-aide", packageName), { recursive: true, force: true });
    }
    const legacyVaultDirs = kind === "agent" ? ["mv-agent"] : ["mv-dsh-manager", "mv-plugin-manager"];
    for (const subdir of legacyVaultDirs) {
      await fs.rm(path.join(dshVaultDirectory(vaultRoot), "plugin", subdir), { recursive: true, force: true });
    }
  }

  const manifest = await readProfileManifest(profileDir);
  if (manifest?.dependencies) {
    for (const kind of kinds) {
      for (const name of bundleNamesFor(kind)) delete manifest.dependencies[name];
    }
    if (Object.keys(manifest.dependencies).length === 0) delete manifest.dependencies;
    await writeProfileManifest(profileDir, manifest);
  }

  const pluginDir = path.join(dshVaultDirectory(vaultRoot), "plugin");
  try {
    await fs.rmdir(pluginDir);
  } catch {
    // Keep non-empty legacy staging when it belongs to the other injection layer.
  }
}

function layerStatus(options: {
  kind: ManagedPluginKind;
  installed: boolean;
  current: boolean;
  patchReady: boolean;
  legacyBundle: boolean;
  legacyVaultPlugin: boolean;
  legacyProfileArtifact: boolean;
}): DshInjectionStatus {
  const { kind, installed, current, patchReady, legacyBundle, legacyVaultPlugin, legacyProfileArtifact } = options;
  const label = kind === "agent" ? "mv-agent" : "mv-dsh-manager";
  if (installed && current && patchReady && !legacyBundle && !legacyVaultPlugin && !legacyProfileArtifact) {
    return { state: "ready", detail: `${label} 插件包与热加载配置均与当前 mv-AIDE 一致。` };
  }
  if (installed || patchReady || legacyBundle || legacyVaultPlugin || legacyProfileArtifact) {
    return {
      state: "partial",
      detail: installed && !current ? `检测到过期的 ${label} 插件包，需要更新修复。` : `${label} 注入不完整或存在旧版配置，需要更新修复。`,
    };
  }
  return { state: "missing", detail: `${label} 尚未注入 DSH web profile。` };
}

export async function inspectDshInjection(vaultRoot: string): Promise<DshInjectionStatuses> {
  const profileDir = dshWebProfileDirectory();
  const manifest = await readProfileManifest(profileDir);
  const patch = await fs.readFile(dshWebProfilePatchPath(), "utf8").catch(() => "");
  const agentInstalled = await pathExists(path.join(dshAgentPackageDirectory(), "package.json"));
  const managerInstalled = await pathExists(path.join(dshManagerPackageDirectory(), "package.json"));
  const [agentCurrent, managerCurrent] = await Promise.all([
    agentInstalled
      ? installedDshPluginBundleMatches(dshAgentPackageDirectory(), MV_AGENT_PLUGIN_FILES, DSH_AGENT_BUNDLE_FINGERPRINT)
      : Promise.resolve(false),
    managerInstalled
      ? installedDshPluginBundleMatches(dshManagerPackageDirectory(), MV_DSH_MANAGER_PLUGIN_FILES, DSH_MANAGER_BUNDLE_FINGERPRINT)
      : Promise.resolve(false),
  ]);
  const [agentLegacyVault, managerLegacyVault, agentLegacyProfile, managerLegacyProfile] = await Promise.all([
    legacyVaultPluginExists(vaultRoot, "agent"),
    legacyVaultPluginExists(vaultRoot, "manager"),
    legacyProfileArtifactsExist(profileDir, "agent"),
    legacyProfileArtifactsExist(profileDir, "manager"),
  ]);
  const agent = layerStatus({
    kind: "agent",
    installed: agentInstalled,
    current: agentCurrent,
    patchReady: patchRowReady(patch, "agent"),
    legacyBundle: bundlesContainPlugin(manifest ?? {}, "agent"),
    legacyVaultPlugin: agentLegacyVault,
    legacyProfileArtifact: agentLegacyProfile,
  });
  const manager = layerStatus({
    kind: "manager",
    installed: managerInstalled,
    current: managerCurrent,
    patchReady: patchRowReady(patch, "manager"),
    legacyBundle: bundlesContainPlugin(manifest ?? {}, "manager"),
    legacyVaultPlugin: managerLegacyVault,
    legacyProfileArtifact: managerLegacyProfile,
  });
  const full: DshInjectionStatus = agent.state === "ready" && manager.state === "ready"
    ? { state: "ready", detail: "DSH web profile 中的 mv-agent 与 mv-dsh-manager 均已就绪。" }
    : agent.state === "missing" && manager.state === "missing"
      ? { state: "missing", detail: "尚未向 DSH web profile 注入插件。" }
      : {
        state: "partial",
        detail: agent.state === "ready" && manager.state !== "ready"
          ? "IDE 插件已就绪；DSH 管理插件尚未注入或需要修复。"
          : "检测到不完整或旧版注入，需要更新修复。",
      };
  return { agent, manager, full };
}

async function verifyInjection(command: DshCommand, target: InjectionTarget): Promise<{ ok: boolean; detail: string }> {
  const result = await runProcess(
    command.executable,
    [...command.argsPrefix, "--profile", "web", "--dump-config"],
    { timeoutMs: 120_000, env: command.env },
  );
  const detail = processOutput(result);
  const hasAgent = detail.includes(DSH_MANAGED_PLUGINS.agent.id) || detail.includes(DSH_AGENT_PLUGIN_NAME);
  const hasManager = detail.includes(DSH_MANAGED_PLUGINS.manager.id) || detail.includes(DSH_PM_PLUGIN_NAME);
  return { ok: result.code === 0 && hasAgent && (target === "ide" || hasManager), detail };
}

async function ensureInjection(
  vaultRoot: string,
  command: DshCommand,
  target: InjectionTarget,
): Promise<InjectResult> {
  const before = await inspectDshInjection(vaultRoot);
  const beforeTarget = target === "ide" ? before.agent : before.full;
  if (beforeTarget.state === "ready") {
    const verified = await verifyInjection(command, target);
    if (verified.ok) {
      return {
        ok: true,
        changed: false,
        message: target === "ide"
          ? "mv-agent IDE 插件已注入并通过实际配置校验。"
          : "mv-agent 与 mv-dsh-manager 插件已注入并通过实际配置校验。",
      };
    }
  }

  try {
    if (target === "ide") await materializeAgentPlugin();
    else await materializeFullPluginSet();
    await fs.mkdir(dshWebProfileDirectory(), { recursive: true });
    await writePatchRows(target);
    await cleanupBundles(target);
  } catch (error) {
    return {
      ok: false,
      changed: true,
      message: `DSH 注入写入失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const verified = await verifyInjection(command, target);
  if (!verified.ok) {
    return {
      ok: false,
      changed: true,
      message: `插件文件已写入，但实际配置校验失败：${verified.detail.slice(-600)}`,
    };
  }

  try {
    await cleanupLegacyInjection(vaultRoot, target);
  } catch (error) {
    return {
      ok: false,
      changed: true,
      message: `插件已写入并通过校验，但旧物清理失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const disk = await inspectDshInjection(vaultRoot);
  const reverified = await verifyInjection(command, target);
  const finalTarget = target === "ide" ? disk.agent : disk.full;
  if (finalTarget.state === "ready" && reverified.ok) {
    return {
      ok: true,
      changed: true,
      message: target === "ide"
        ? "mv-agent IDE 插件已注入、清理旧物并通过校验。"
        : "DSH、mv-agent 与 mv-dsh-manager 插件均已注入、清理旧物并通过校验。",
    };
  }
  return {
    ok: false,
    changed: true,
    message: `插件已写入，但清理后校验失败：${reverified.detail.slice(-600) || finalTarget.detail}`,
  };
}

export async function ensureDshAgentInjection(vaultRoot: string, command: DshCommand): Promise<InjectResult> {
  return ensureInjection(vaultRoot, command, "ide");
}

export async function ensureDshFullInjection(vaultRoot: string, command: DshCommand): Promise<InjectResult> {
  return ensureInjection(vaultRoot, command, "full");
}
