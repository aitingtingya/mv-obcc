import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { setTimeout as waitFor } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { processOutput, runProcess } from "../../../process-runner";
import {
  MV_AGENT_PLUGIN_FILES,
  MV_DSH_COMPAT_FILES,
  MV_DSH_MANAGER_PLUGIN_FILES,
  MV_DSH_SUBWORKSPACE_PLUGIN_FILES,
} from "./plugin-bundle";
import {
  dshPluginBundleFingerprint,
  installedDshPluginBundleMatches,
  readDshPluginBundleMarker,
  writeDshPluginBundleMarker,
} from "./plugin-integrity";
import { compareRuntimeVersions } from "../runtime/package-update";
import type { DshCommand } from "../runtime/process";
import {
  dshAgentPackageDirectory,
  dshCompatPackageDirectory,
  dshManagerPackageDirectory,
  dshSubworkspacePackageDirectory,
  dshVaultDirectory,
  dshWebProfileDirectory,
  dshWebProfilePatchPath,
  resolveDshHomeDirectory,
} from "../paths";

export const DSH_AGENT_BUNDLE_FINGERPRINT = dshPluginBundleFingerprint(MV_AGENT_PLUGIN_FILES);
export const DSH_COMPAT_BUNDLE_FINGERPRINT = dshPluginBundleFingerprint(MV_DSH_COMPAT_FILES);
export const DSH_MANAGER_BUNDLE_FINGERPRINT = dshPluginBundleFingerprint(MV_DSH_MANAGER_PLUGIN_FILES);
export const DSH_SUBWORKSPACE_BUNDLE_FINGERPRINT = dshPluginBundleFingerprint(MV_DSH_SUBWORKSPACE_PLUGIN_FILES);

export const DSH_AGENT_PLUGIN_NAME = "@mv-aide/mv-agent";
export const DSH_PM_PLUGIN_NAME = "@mv-aide/mv-dsh-manager";
export const DSH_SUBWORKSPACE_PLUGIN_NAME = "@mv-aide/mv-dsh-subworkspace";
export const DSH_PLUGIN_NAME = DSH_AGENT_PLUGIN_NAME;

const DSH_MANAGED_PLUGINS = {
  agent: { id: "mv-agent", name: DSH_AGENT_PLUGIN_NAME, legacyIds: ["mv-aide"] },
  manager: { id: "mv-dsh-manager", name: DSH_PM_PLUGIN_NAME, legacyIds: ["mv-plugin-manager"] },
  subworkspace: { id: "mv-dsh-subworkspace", name: DSH_SUBWORKSPACE_PLUGIN_NAME, legacyIds: [] },
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

export type DshInjectionState =
  | "ready"
  | "missing"
  | "partial"
  | "outdated"
  | "newer"
  | "unknown"
  | "conflict";

export interface DshInjectionStatus {
  state: DshInjectionState;
  detail: string;
  version?: string;
  relation?: "older" | "current" | "newer" | "unknown";
  usable?: boolean;
  fingerprint?: string;
  runtimeVersion?: string;
  restartRequired?: boolean;
}

export interface DshInjectionStatuses {
  agent: DshInjectionStatus;
  manager: DshInjectionStatus;
  subworkspace: DshInjectionStatus;
  full: DshInjectionStatus;
}

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

type ManagedPluginKind = keyof typeof DSH_MANAGED_PLUGINS;
type InjectionTarget = "ide" | "full";

function commandHomeDirectory(command?: DshCommand): string {
  return resolveDshHomeDirectory(command?.homeDirectory, command?.env);
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
    return JSON.parse(await fs.readFile(path.join(profileDir, "package.json"), "utf8")) as ProfileManifest;
  } catch {
    return null;
  }
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeProfileManifest(profileDir: string, manifest: ProfileManifest): Promise<void> {
  await atomicWriteText(path.join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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
  // The subworkspace around-dispatch listener must wrap mv-agent's optional
  // diff listener. Its nested native calls then flow through mv-agent normally.
  return ensurePatchRows(content, ["subworkspace", "agent", "manager"]);
}

export function isHealthyPatchFile(content: string): boolean {
  return patchRowReady(content, "agent")
    && patchRowReady(content, "manager")
    && patchRowReady(content, "subworkspace")
    && !content.split(/\r?\n/u).some((line) => line.trim() === "[]");
}

export function healPatchFile(content: string): string {
  return isHealthyPatchFile(content) ? content : ensureFullPatchRows(content);
}

async function writePatchRows(target: InjectionTarget, homeDirectory: string): Promise<void> {
  const patchPath = dshWebProfilePatchPath(homeDirectory);
  const existing = await fs.readFile(patchPath, "utf8").catch(() => DEFAULT_PATCH_FILE);
  const next = target === "ide" ? ensureAgentPatchRow(existing) : ensureFullPatchRows(existing);
  if (next !== existing) await atomicWriteText(patchPath, next);
}

function bundleNamesFor(kind: ManagedPluginKind): readonly string[] {
  if (kind === "agent") return [DSH_AGENT_PLUGIN_NAME, "@mv-aide/dsh-plugin"];
  if (kind === "manager") return [DSH_PM_PLUGIN_NAME, "@mv-aide/mv-plugin-manager"];
  return [DSH_SUBWORKSPACE_PLUGIN_NAME];
}

function bundlesContainPlugin(manifest: ProfileManifest, kind: ManagedPluginKind): boolean {
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  return bundleNamesFor(kind).some((name) => bundles.includes(name));
}

async function cleanupBundles(target: InjectionTarget, homeDirectory: string): Promise<void> {
  const profileDir = dshWebProfileDirectory(homeDirectory);
  const manifest = await readProfileManifest(profileDir);
  if (!manifest) return;
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const remove = new Set(
    (target === "ide" ? (["agent"] as const) : (["agent", "manager", "subworkspace"] as const))
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
  mvAideVersion: string,
): Promise<void> {
  const parent = path.dirname(installedDir);
  const nonce = `${process.pid}-${randomUUID()}`;
  const staging = path.join(parent, `.${path.basename(installedDir)}.staging-${nonce}`);
  const backup = path.join(parent, `.${path.basename(installedDir)}.backup-${nonce}`);
  let backupMayContainOnlyCopy = false;
  await fs.mkdir(parent, { recursive: true });
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const output = path.join(staging, relativePath);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, content, "utf8");
    }
    await writeDshPluginBundleMarker(staging, fingerprint, mvAideVersion);
    if (!await installedDshPluginBundleMatches(
      staging,
      files,
      fingerprint,
      mvAideVersion,
    )) {
      throw new Error(`staged ${path.basename(installedDir)} bundle failed integrity verification`);
    }
    let hadInstalled = false;
    try {
      await fs.rename(installedDir, backup);
      hadInstalled = true;
      backupMayContainOnlyCopy = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      await fs.rename(staging, installedDir);
      backupMayContainOnlyCopy = false;
    } catch (error) {
      if (hadInstalled) {
        await fs.rename(backup, installedDir);
        backupMayContainOnlyCopy = false;
      }
      throw error;
    }
    if (hadInstalled) await fs.rm(backup, { recursive: true, force: true });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (!backupMayContainOnlyCopy) {
      await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function recoverInterruptedPackageTransaction(installedDir: string): Promise<void> {
  const parent = path.dirname(installedDir);
  const base = path.basename(installedDir);
  const backupPrefix = `.${base}.backup-`;
  const stagingPrefix = `.${base}.staging-`;
  const entries: Dirent[] = await fs.readdir(parent, { withFileTypes: true })
    .catch((): Dirent[] => []);
  const backups = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(backupPrefix))
    .map((entry) => path.join(parent, entry.name));
  const stagings = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(stagingPrefix))
    .map((entry) => path.join(parent, entry.name));
  if (backups.length === 0 && stagings.length === 0) return;

  if (!await pathExists(installedDir) && backups.length > 0) {
    const ranked = await Promise.all(backups.map(async (candidate) => ({
      candidate,
      mtime: (await fs.stat(candidate)).mtimeMs,
    })));
    ranked.sort((left, right) => right.mtime - left.mtime);
    await fs.rename(ranked[0].candidate, installedDir);
    backups.splice(backups.indexOf(ranked[0].candidate), 1);
  }
  // A remaining backup is older than a successfully published/restored target;
  // a staging directory never became authoritative. Both are safe to retire.
  await Promise.all([...backups, ...stagings].map((candidate) =>
    fs.rm(candidate, { recursive: true, force: true }),
  ));
}

async function recoverInterruptedInjectionTransactions(homeDirectory: string): Promise<void> {
  await recoverInterruptedPackageTransaction(dshCompatPackageDirectory(homeDirectory));
  await recoverInterruptedPackageTransaction(dshAgentPackageDirectory(homeDirectory));
  await recoverInterruptedPackageTransaction(dshManagerPackageDirectory(homeDirectory));
  await recoverInterruptedPackageTransaction(dshSubworkspacePackageDirectory(homeDirectory));
}

// Lock holders run the full verify path (`--profile web --dump-config`, up to
// 120s) even when the bundle is already ready, so a waiter must outlast that
// ceiling instead of failing concurrent open/restart operations early.
const INJECTION_LOCK_TIMEOUT_MS = 130_000;
const INJECTION_LOCK_STALE_MS = 120_000;

function injectionLockPath(homeDirectory: string): string {
  return path.join(dshWebProfileDirectory(homeDirectory), ".mv-aide-injection.lock");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitBriefly(delayMs: number): Promise<void> {
  await waitFor(delayMs);
}

export async function withDshInjectionLock<T>(
  operation: () => Promise<T>,
  homeDirectory = commandHomeDirectory(),
): Promise<T> {
  const lock = injectionLockPath(homeDirectory);
  const ownerFile = path.join(lock, "owner.json");
  const started = Date.now();
  const owner = `${JSON.stringify({ pid: process.pid, id: randomUUID(), createdAt: started })}\n`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lock);
      try {
        await fs.writeFile(ownerFile, owner, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      let stale = false;
      try {
        const before = await fs.readFile(ownerFile, "utf8");
        const parsed = JSON.parse(before) as { pid?: unknown; createdAt?: unknown };
        const age = Date.now() - Number(parsed.createdAt ?? 0);
        stale = age > INJECTION_LOCK_STALE_MS && !processIsAlive(Number(parsed.pid));
        if (stale && await fs.readFile(ownerFile, "utf8") === before) {
          const quarantine = `${lock}.stale-${process.pid}-${randomUUID()}`;
          await fs.rename(lock, quarantine);
          await fs.rm(quarantine, { recursive: true, force: true });
          continue;
        }
      } catch {
        // A just-created lock may not have published owner.json yet; wait.
      }
      if (Date.now() - started >= INJECTION_LOCK_TIMEOUT_MS) {
        throw new Error("等待其它 mv-AIDE 完成 DSH 插件注入超时。");
      }
      await waitBriefly(stale ? 20 : 75);
    }
  }
  try {
    return await operation();
  } finally {
    try {
      if (await fs.readFile(ownerFile, "utf8") === owner) {
        await fs.rm(lock, { recursive: true, force: true });
      }
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  }
}

/**
 * Options controlling same-version content-conflict handling.
 *
 * `allowSameVersionOverwrite` authorizes replacing an installed bundle whose
 * marker version equals the current mv-AIDE version but whose fingerprint
 * differs (a same-version content drift, typically a rebuilt plugin). The
 * never-downgrade rule for higher versions is not affected by this flag.
 */
export interface SameVersionOverwriteOptions {
  allowSameVersionOverwrite?: boolean;
}

export async function materializeCompatLibrary(
  mvAideVersion: string,
  homeDirectory = commandHomeDirectory(),
  options: SameVersionOverwriteOptions = {},
): Promise<void> {
  await fs.mkdir(dshWebProfileDirectory(homeDirectory), { recursive: true });
  const installedDir = dshCompatPackageDirectory(homeDirectory);
  const marker = await readDshPluginBundleMarker(installedDir);
  if (marker?.mvAideVersion) {
    const relation = markerRelation(marker.mvAideVersion, mvAideVersion);
    if (relation === "newer") {
      if (await compatPackageReadable(homeDirectory)) return;
      throw new Error(`更高版本共享兼容库 ${marker.mvAideVersion} 已损坏，当前版本拒绝降级覆盖。`);
    }
    if (relation === "current" && marker.fingerprint !== DSH_COMPAT_BUNDLE_FINGERPRINT) {
      if (options.allowSameVersionOverwrite !== true) {
        throw new Error(`共享兼容库 ${mvAideVersion} 存在同版本内容冲突，拒绝静默覆盖。`);
      }
    }
  }
  await writePackage(
    installedDir,
    MV_DSH_COMPAT_FILES,
    DSH_COMPAT_BUNDLE_FINGERPRINT,
    mvAideVersion,
  );
}

async function writeAgentPlugin(mvAideVersion: string, homeDirectory: string): Promise<void> {
  await writePackage(
    dshAgentPackageDirectory(homeDirectory),
    MV_AGENT_PLUGIN_FILES,
    DSH_AGENT_BUNDLE_FINGERPRINT,
    mvAideVersion,
  );
}

async function writeManagerPlugin(mvAideVersion: string, homeDirectory: string): Promise<void> {
  await writePackage(
    dshManagerPackageDirectory(homeDirectory),
    MV_DSH_MANAGER_PLUGIN_FILES,
    DSH_MANAGER_BUNDLE_FINGERPRINT,
    mvAideVersion,
  );
}

async function writeSubworkspacePlugin(mvAideVersion: string, homeDirectory: string): Promise<void> {
  await writePackage(
    dshSubworkspacePackageDirectory(homeDirectory),
    MV_DSH_SUBWORKSPACE_PLUGIN_FILES,
    DSH_SUBWORKSPACE_BUNDLE_FINGERPRINT,
    mvAideVersion,
  );
}

export async function materializeAgentPlugin(
  mvAideVersion: string,
  homeDirectory = commandHomeDirectory(),
  options: SameVersionOverwriteOptions = {},
): Promise<void> {
  await materializeCompatLibrary(mvAideVersion, homeDirectory, options);
  await writeAgentPlugin(mvAideVersion, homeDirectory);
}

export async function materializeManagerPlugin(
  mvAideVersion: string,
  homeDirectory = commandHomeDirectory(),
  options: SameVersionOverwriteOptions = {},
): Promise<void> {
  await materializeCompatLibrary(mvAideVersion, homeDirectory, options);
  await writeManagerPlugin(mvAideVersion, homeDirectory);
}

export async function materializeSubworkspacePlugin(
  mvAideVersion: string,
  homeDirectory = commandHomeDirectory(),
  options: SameVersionOverwriteOptions = {},
): Promise<void> {
  await materializeCompatLibrary(mvAideVersion, homeDirectory, options);
  await writeSubworkspacePlugin(mvAideVersion, homeDirectory);
}

export async function materializeFullPluginSet(
  mvAideVersion: string,
  homeDirectory = commandHomeDirectory(),
  options: SameVersionOverwriteOptions = {},
): Promise<void> {
  await materializeCompatLibrary(mvAideVersion, homeDirectory, options);
  await Promise.all([
    writeAgentPlugin(mvAideVersion, homeDirectory),
    writeManagerPlugin(mvAideVersion, homeDirectory),
    writeSubworkspacePlugin(mvAideVersion, homeDirectory),
  ]);
}

async function legacyVaultPluginExists(vaultRoot: string, kind: ManagedPluginKind): Promise<boolean> {
  const subdirs = kind === "agent"
    ? ["mv-agent"]
    : kind === "manager"
      ? ["mv-dsh-manager", "mv-plugin-manager"]
      : ["mv-dsh-subworkspace"];
  for (const subdir of subdirs) {
    if (await pathExists(path.join(dshVaultDirectory(vaultRoot), "plugin", subdir, "package.json"))) return true;
  }
  return false;
}

async function managedPackageReadable(kind: ManagedPluginKind, homeDirectory: string): Promise<boolean> {
  const installedDir = kind === "agent"
    ? dshAgentPackageDirectory(homeDirectory)
    : kind === "manager"
      ? dshManagerPackageDirectory(homeDirectory)
      : dshSubworkspacePackageDirectory(homeDirectory);
  const expectedName = DSH_MANAGED_PLUGINS[kind].name;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(installedDir, "package.json"), "utf8")) as {
      name?: unknown;
      main?: unknown;
    };
    if (manifest.name !== expectedName || typeof manifest.main !== "string" || manifest.main.length === 0) {
      return false;
    }
    const entry = path.resolve(installedDir, manifest.main);
    const relative = path.relative(installedDir, entry);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    await fs.access(entry);
    return true;
  } catch {
    return false;
  }
}

async function managedPackageRequiresCompat(kind: ManagedPluginKind, homeDirectory: string): Promise<boolean> {
  const installedDir = kind === "agent"
    ? dshAgentPackageDirectory(homeDirectory)
    : kind === "manager"
      ? dshManagerPackageDirectory(homeDirectory)
      : dshSubworkspacePackageDirectory(homeDirectory);
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(installedDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    return Object.hasOwn(manifest.dependencies ?? {}, "@mv-aide/mv-dsh-compat")
      || Object.hasOwn(manifest.peerDependencies ?? {}, "@mv-aide/mv-dsh-compat");
  } catch {
    return false;
  }
}

async function compatPackageReadable(homeDirectory: string): Promise<boolean> {
  const installedDir = dshCompatPackageDirectory(homeDirectory);
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(installedDir, "package.json"), "utf8")) as {
      name?: unknown;
      exports?: Record<string, unknown>;
      dsh?: unknown;
    };
    if (manifest.name !== "@mv-aide/mv-dsh-compat" || manifest.dsh !== undefined) return false;
    for (const entry of ["contracts.js", "obsidian.js", "host.js", "client.js"]) {
      await fs.access(path.join(installedDir, "lib", entry));
    }
    return manifest.exports !== undefined;
  } catch {
    return false;
  }
}

async function legacyProfileArtifactsExist(profileDir: string, kind: ManagedPluginKind): Promise<boolean> {
  const manifest = await readProfileManifest(profileDir);
  const dependencies = manifest?.dependencies ?? {};
  for (const name of bundleNamesFor(kind)) {
    if (dependencies[name]) return true;
  }
  const legacyPackages = kind === "agent"
    ? ["@mv-aide/dsh-plugin"]
    : kind === "manager"
      ? ["@mv-aide/mv-plugin-manager"]
      : [];
  for (const name of legacyPackages) {
    const packageName = name.slice("@mv-aide/".length);
    if (await pathExists(path.join(profileDir, "node_modules", "@mv-aide", packageName, "package.json"))) return true;
  }
  return false;
}

async function cleanupLegacyInjection(
  vaultRoot: string,
  target: InjectionTarget,
  homeDirectory: string,
): Promise<void> {
  const profileDir = dshWebProfileDirectory(homeDirectory);
  const kinds: readonly ManagedPluginKind[] = target === "ide" ? ["agent"] : ["agent", "manager", "subworkspace"];
  for (const kind of kinds) {
    const legacyPackages = kind === "agent" ? ["dsh-plugin"] : kind === "manager" ? ["mv-plugin-manager"] : [];
    for (const packageName of legacyPackages) {
      await fs.rm(path.join(profileDir, "node_modules", "@mv-aide", packageName), { recursive: true, force: true });
    }
    const legacyVaultDirs = kind === "agent"
      ? ["mv-agent"]
      : kind === "manager"
        ? ["mv-dsh-manager", "mv-plugin-manager"]
        : ["mv-dsh-subworkspace"];
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

function markerRelation(
  installedVersion: string | undefined,
  currentVersion: string | undefined,
): "older" | "current" | "newer" | "unknown" {
  if (!installedVersion || !currentVersion) return "unknown";
  try {
    const compared = compareRuntimeVersions(installedVersion, currentVersion);
    return compared < 0 ? "older" : compared > 0 ? "newer" : "current";
  } catch {
    return "unknown";
  }
}

export function injectionStateIsUsable(status: { state: string; usable?: boolean }): boolean {
  return status.usable === true || status.state === "ready" || status.state === "newer";
}

interface LoadedPluginInspection {
  ok: boolean;
  hasAgent: boolean;
  hasManager: boolean;
  hasSubworkspace: boolean;
  detail: string;
}

async function inspectLoadedPlugins(command: DshCommand): Promise<LoadedPluginInspection> {
  const result = await runProcess(
    command.executable,
    [...command.argsPrefix, "--profile", "web", "--dump-config"],
    { timeoutMs: 120_000, env: command.env, cwd: command.cwd },
  );
  const detail = processOutput(result);
  return {
    ok: result.code === 0,
    hasAgent: detail.includes(DSH_MANAGED_PLUGINS.agent.id) || detail.includes(DSH_AGENT_PLUGIN_NAME),
    hasManager: detail.includes(DSH_MANAGED_PLUGINS.manager.id) || detail.includes(DSH_PM_PLUGIN_NAME),
    hasSubworkspace: detail.includes(DSH_MANAGED_PLUGINS.subworkspace.id)
      || detail.includes(DSH_SUBWORKSPACE_PLUGIN_NAME),
    detail,
  };
}

function requireActuallyLoaded(
  status: DshInjectionStatus,
  loaded: boolean,
  dumpSucceeded: boolean,
  label: string,
  dumpDetail: string,
): DshInjectionStatus {
  if (status.state === "missing" || loaded) return status;
  const suffix = dumpSucceeded
    ? "dsh --profile web --dump-config 未实际加载该插件。"
    : `dsh --profile web --dump-config 校验失败：${dumpDetail.slice(-300) || "无输出"}`;
  return {
    ...status,
    state: "partial",
    usable: false,
    detail: status.relation === "newer"
      ? `检测到更高版本 ${label}（${status.version ?? "未知"}），但${suffix}请使用对应高版本 mv-AIDE 处理。`
      : `${label} 磁盘注入存在，但${suffix}`,
  };
}

function requireCompatDependency(
  status: DshInjectionStatus,
  required: boolean,
  compatible: boolean,
): DshInjectionStatus {
  if (!required || compatible || status.state === "missing") return status;
  return {
    ...status,
    state: "partial",
    usable: false,
    detail: `${status.detail} 共享兼容库缺失、损坏或版本不匹配。`,
  };
}

function layerStatus(options: {
  kind: ManagedPluginKind;
  installed: boolean;
  current: boolean;
  patchReady: boolean;
  legacyBundle: boolean;
  legacyVaultPlugin: boolean;
  legacyProfileArtifact: boolean;
  installedVersion?: string;
  currentVersion?: string;
  markerPresent: boolean;
}): DshInjectionStatus {
  const {
    kind,
    installed,
    current,
    patchReady,
    legacyBundle,
    legacyVaultPlugin,
    legacyProfileArtifact,
    installedVersion,
    currentVersion,
    markerPresent,
  } = options;
  const label = kind === "agent"
    ? "mv-agent"
    : kind === "manager"
      ? "mv-dsh-manager"
      : "mv-dsh-subworkspace";
  if (!installed && !patchReady && !legacyBundle && !legacyVaultPlugin && !legacyProfileArtifact) {
    return { state: "missing", detail: `${label} 尚未注入 DSH web profile。`, usable: false };
  }
  const relation = markerRelation(installedVersion, currentVersion);
  const cleanLayout = patchReady && !legacyBundle && !legacyVaultPlugin && !legacyProfileArtifact;
  if (!cleanLayout || !installed) {
    return {
      state: "partial",
      detail: relation === "newer"
        ? `检测到更高版本 ${label}（${installedVersion}），但它未被 DSH 完整加载；请使用对应高版本 mv-AIDE 修复。`
        : `${label} 注入不完整或存在旧版配置，需要修复。`,
      ...(installedVersion ? { version: installedVersion } : {}),
      relation,
      usable: false,
    };
  }
  if (currentVersion === undefined) {
    return current
      ? { state: "ready", detail: `${label} 插件包与热加载配置完整。`, usable: true }
      : { state: "partial", detail: `${label} 插件包内容不完整。`, usable: false };
  }
  if (!markerPresent || relation === "unknown") {
    return {
      state: "unknown",
      detail: `${label} 已加载，但注入版本未知；建议使用当前 mv-AIDE 升级。`,
      ...(installedVersion ? { version: installedVersion } : {}),
      relation: "unknown",
      usable: true,
    };
  }
  if (relation === "older") {
    return {
      state: "outdated",
      detail: `${label} ${installedVersion} 低于当前 mv-AIDE ${currentVersion}，建议升级。`,
      version: installedVersion,
      relation,
      usable: true,
    };
  }
  if (relation === "newer") {
    return {
      state: "newer",
      detail: `${label} ${installedVersion} 高于当前 mv-AIDE ${currentVersion}；已跳过当前版本的内容校验和覆盖。`,
      version: installedVersion,
      relation,
      usable: true,
    };
  }
  if (current) {
    return {
      state: "ready",
      detail: `${label} ${currentVersion} 插件包与热加载配置均完整。`,
      version: installedVersion,
      relation,
      usable: true,
    };
  }
  return {
    state: "conflict",
    detail: `${label} 与当前 mv-AIDE 版本相同但内容指纹不同；可通过显式“更新”或自动更新替换。`,
    version: installedVersion,
    relation,
    usable: true,
  };
}

export async function inspectDshInjection(
  vaultRoot: string,
  currentMvAideVersion?: string,
  command?: DshCommand,
): Promise<DshInjectionStatuses> {
  const homeDirectory = commandHomeDirectory(command);
  const profileDir = dshWebProfileDirectory(homeDirectory);
  const manifest = await readProfileManifest(profileDir);
  const patch = await fs.readFile(dshWebProfilePatchPath(homeDirectory), "utf8").catch(() => "");
  const [agentInstalled, managerInstalled, subworkspaceInstalled, compatInstalled] = await Promise.all([
    managedPackageReadable("agent", homeDirectory),
    managedPackageReadable("manager", homeDirectory),
    managedPackageReadable("subworkspace", homeDirectory),
    compatPackageReadable(homeDirectory),
  ]);
  const [agentMarker, managerMarker, subworkspaceMarker, compatMarker] = await Promise.all([
    readDshPluginBundleMarker(dshAgentPackageDirectory(homeDirectory)),
    readDshPluginBundleMarker(dshManagerPackageDirectory(homeDirectory)),
    readDshPluginBundleMarker(dshSubworkspacePackageDirectory(homeDirectory)),
    readDshPluginBundleMarker(dshCompatPackageDirectory(homeDirectory)),
  ]);
  const verifyAgentContent = currentMvAideVersion === undefined
    || markerRelation(agentMarker?.mvAideVersion, currentMvAideVersion) === "current";
  const verifyManagerContent = currentMvAideVersion === undefined
    || markerRelation(managerMarker?.mvAideVersion, currentMvAideVersion) === "current";
  const verifySubworkspaceContent = currentMvAideVersion === undefined
    || markerRelation(subworkspaceMarker?.mvAideVersion, currentMvAideVersion) === "current";
  const verifyCompatContent = currentMvAideVersion === undefined
    || markerRelation(compatMarker?.mvAideVersion, currentMvAideVersion) === "current";
  const [
    agentCurrent,
    managerCurrent,
    subworkspaceCurrent,
    compatCurrent,
    agentRequiresCompat,
    managerRequiresCompat,
    subworkspaceRequiresCompat,
  ] = await Promise.all([
    agentInstalled && verifyAgentContent
      ? installedDshPluginBundleMatches(
          dshAgentPackageDirectory(homeDirectory),
          MV_AGENT_PLUGIN_FILES,
          DSH_AGENT_BUNDLE_FINGERPRINT,
          currentMvAideVersion,
        )
      : Promise.resolve(false),
    managerInstalled && verifyManagerContent
      ? installedDshPluginBundleMatches(
          dshManagerPackageDirectory(homeDirectory),
          MV_DSH_MANAGER_PLUGIN_FILES,
          DSH_MANAGER_BUNDLE_FINGERPRINT,
          currentMvAideVersion,
        )
      : Promise.resolve(false),
    subworkspaceInstalled && verifySubworkspaceContent
      ? installedDshPluginBundleMatches(
          dshSubworkspacePackageDirectory(homeDirectory),
          MV_DSH_SUBWORKSPACE_PLUGIN_FILES,
          DSH_SUBWORKSPACE_BUNDLE_FINGERPRINT,
          currentMvAideVersion,
        )
      : Promise.resolve(false),
    compatInstalled && verifyCompatContent
      ? installedDshPluginBundleMatches(
          dshCompatPackageDirectory(homeDirectory),
          MV_DSH_COMPAT_FILES,
          DSH_COMPAT_BUNDLE_FINGERPRINT,
          currentMvAideVersion,
        )
      : Promise.resolve(false),
    managedPackageRequiresCompat("agent", homeDirectory),
    managedPackageRequiresCompat("manager", homeDirectory),
    managedPackageRequiresCompat("subworkspace", homeDirectory),
  ]);
  const compatRelation = markerRelation(compatMarker?.mvAideVersion, currentMvAideVersion);
  const compatUsable = compatInstalled && (compatCurrent || compatRelation === "newer");
  const [
    agentLegacyVault,
    managerLegacyVault,
    subworkspaceLegacyVault,
    agentLegacyProfile,
    managerLegacyProfile,
    subworkspaceLegacyProfile,
  ] = await Promise.all([
    legacyVaultPluginExists(vaultRoot, "agent"),
    legacyVaultPluginExists(vaultRoot, "manager"),
    legacyVaultPluginExists(vaultRoot, "subworkspace"),
    legacyProfileArtifactsExist(profileDir, "agent"),
    legacyProfileArtifactsExist(profileDir, "manager"),
    legacyProfileArtifactsExist(profileDir, "subworkspace"),
  ]);
  let agent: DshInjectionStatus = {
    ...layerStatus({
      kind: "agent",
      installed: agentInstalled,
      current: agentCurrent,
      patchReady: patchRowReady(patch, "agent"),
      legacyBundle: bundlesContainPlugin(manifest ?? {}, "agent"),
      legacyVaultPlugin: agentLegacyVault,
      legacyProfileArtifact: agentLegacyProfile,
      installedVersion: agentMarker?.mvAideVersion,
      currentVersion: currentMvAideVersion,
      markerPresent: agentMarker !== null,
    }),
    ...(agentMarker ? { fingerprint: agentMarker.fingerprint } : {}),
  };
  let manager: DshInjectionStatus = {
    ...layerStatus({
      kind: "manager",
      installed: managerInstalled,
      current: managerCurrent,
      patchReady: patchRowReady(patch, "manager"),
      legacyBundle: bundlesContainPlugin(manifest ?? {}, "manager"),
      legacyVaultPlugin: managerLegacyVault,
      legacyProfileArtifact: managerLegacyProfile,
      installedVersion: managerMarker?.mvAideVersion,
      currentVersion: currentMvAideVersion,
      markerPresent: managerMarker !== null,
    }),
    ...(managerMarker ? { fingerprint: managerMarker.fingerprint } : {}),
  };
  let subworkspace: DshInjectionStatus = {
    ...layerStatus({
      kind: "subworkspace",
      installed: subworkspaceInstalled,
      current: subworkspaceCurrent,
      patchReady: patchRowReady(patch, "subworkspace"),
      legacyBundle: bundlesContainPlugin(manifest ?? {}, "subworkspace"),
      legacyVaultPlugin: subworkspaceLegacyVault,
      legacyProfileArtifact: subworkspaceLegacyProfile,
      installedVersion: subworkspaceMarker?.mvAideVersion,
      currentVersion: currentMvAideVersion,
      markerPresent: subworkspaceMarker !== null,
    }),
    ...(subworkspaceMarker ? { fingerprint: subworkspaceMarker.fingerprint } : {}),
  };
  agent = requireCompatDependency(agent, agentRequiresCompat, compatUsable);
  manager = requireCompatDependency(manager, managerRequiresCompat, compatUsable);
  subworkspace = requireCompatDependency(subworkspace, subworkspaceRequiresCompat, compatUsable);
  if (command && (agent.state !== "missing" || manager.state !== "missing" || subworkspace.state !== "missing")) {
    const loaded = await inspectLoadedPlugins(command);
    agent = requireActuallyLoaded(agent, loaded.hasAgent, loaded.ok, "mv-agent", loaded.detail);
    manager = requireActuallyLoaded(manager, loaded.hasManager, loaded.ok, "mv-dsh-manager", loaded.detail);
    subworkspace = requireActuallyLoaded(
      subworkspace,
      loaded.hasSubworkspace,
      loaded.ok,
      "mv-dsh-subworkspace",
      loaded.detail,
    );
  }
  const statuses = [agent, manager, subworkspace];
  const full: DshInjectionStatus = statuses.every(injectionStateIsUsable)
    ? statuses.some((status) => status.state === "newer")
      ? { state: "newer", detail: "DSH web profile 中至少一个受管插件高于当前 mv-AIDE；已保留高版本。", usable: true }
      : statuses.some((status) => status.state === "outdated")
        ? { state: "outdated", detail: "DSH web profile 中存在低于当前 mv-AIDE 的受管插件，建议升级。", usable: true }
        : statuses.some((status) => status.state === "unknown")
          ? { state: "unknown", detail: "DSH web profile 中存在版本未知的旧注入，建议升级。", usable: true }
          : statuses.some((status) => status.state === "conflict")
            ? { state: "conflict", detail: "DSH web profile 中存在同版本不同指纹的受管插件。", usable: true }
            : { state: "ready", detail: "DSH web profile 中的三个 mv-AIDE 插件均已就绪。", usable: true }
    : statuses.every((status) => status.state === "missing")
      ? { state: "missing", detail: "尚未向 DSH web profile 注入插件。", usable: false }
      : {
          state: "partial",
          detail: "检测到不完整的三插件注入，需要修复。",
          relation: statuses.some((status) => status.relation === "newer")
            ? "newer"
            : statuses.some((status) => status.relation === "older")
              ? "older"
              : statuses.some((status) => status.relation === "unknown")
                ? "unknown"
                : "current",
          usable: false,
        };
  return { agent, manager, subworkspace, full };
}

async function verifyInjection(command: DshCommand, target: InjectionTarget): Promise<{ ok: boolean; detail: string }> {
  const loaded = await inspectLoadedPlugins(command);
  return {
    ok: loaded.ok
      && loaded.hasAgent
      && (target === "ide" || (loaded.hasManager && loaded.hasSubworkspace)),
    detail: loaded.detail,
  };
}

async function ensureInjection(
  vaultRoot: string,
  command: DshCommand,
  target: InjectionTarget,
  currentMvAideVersion: string,
  options: { explicit?: boolean } & SameVersionOverwriteOptions = {},
): Promise<InjectResult> {
  const homeDirectory = commandHomeDirectory(command);
  return withDshInjectionLock(async () => {
    await recoverInterruptedInjectionTransactions(homeDirectory);
    const before = await inspectDshInjection(vaultRoot, currentMvAideVersion, command);
    const beforeTarget = target === "ide" ? before.agent : before.full;
    if (beforeTarget.state === "newer" || (beforeTarget.state === "partial" && beforeTarget.relation === "newer")) {
      return { ok: beforeTarget.usable === true, changed: false, message: beforeTarget.detail };
    }
    if (
      options.explicit !== true
      && ["outdated", "unknown", "conflict"].includes(beforeTarget.state)
    ) {
      return { ok: beforeTarget.usable === true, changed: false, message: beforeTarget.detail };
    }
    if (beforeTarget.state === "ready") {
      const verified = await verifyInjection(command, target);
      if (verified.ok) {
        return {
          ok: true,
          changed: false,
          message: target === "ide"
            ? "mv-agent IDE 插件已注入并通过实际配置校验。"
            : "mv-agent、mv-dsh-manager 与 mv-dsh-subworkspace 已注入并通过实际配置校验。",
        };
      }
    }

    try {
      const materializeOptions: SameVersionOverwriteOptions = {
        allowSameVersionOverwrite: options.explicit === true || options.allowSameVersionOverwrite === true,
      };
      if (target === "ide") {
        await materializeAgentPlugin(currentMvAideVersion, homeDirectory, materializeOptions);
      } else {
        await materializeFullPluginSet(currentMvAideVersion, homeDirectory, materializeOptions);
      }
      await fs.mkdir(dshWebProfileDirectory(homeDirectory), { recursive: true });
      await writePatchRows(target, homeDirectory);
      await cleanupBundles(target, homeDirectory);
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
      await cleanupLegacyInjection(vaultRoot, target, homeDirectory);
    } catch (error) {
      return {
        ok: false,
        changed: true,
        message: `插件已写入并通过校验，但旧物清理失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const disk = await inspectDshInjection(vaultRoot, currentMvAideVersion, command);
    const reverified = await verifyInjection(command, target);
    const finalTarget = target === "ide" ? disk.agent : disk.full;
    if (finalTarget.state === "ready" && reverified.ok) {
      return {
        ok: true,
        changed: true,
        message: target === "ide"
          ? "mv-agent IDE 插件已注入、清理旧物并通过校验。"
          : "DSH 的三个 mv-AIDE 插件均已注入、清理旧物并通过校验。",
      };
    }
    return {
      ok: false,
      changed: true,
      message: `插件已写入，但清理后校验失败：${reverified.detail.slice(-600) || finalTarget.detail}`,
    };
  }, homeDirectory);
}

export async function ensureDshAgentInjection(
  vaultRoot: string,
  command: DshCommand,
  currentMvAideVersion = "0.0.0",
  options: { explicit?: boolean } & SameVersionOverwriteOptions = {},
): Promise<InjectResult> {
  return ensureInjection(vaultRoot, command, "ide", currentMvAideVersion, options);
}

export async function ensureDshFullInjection(
  vaultRoot: string,
  command: DshCommand,
  currentMvAideVersion = "0.0.0",
  options: { explicit?: boolean } & SameVersionOverwriteOptions = {},
): Promise<InjectResult> {
  return ensureInjection(vaultRoot, command, "full", currentMvAideVersion, options);
}
