import { promises as fs } from "node:fs";
import path from "node:path";
import { mvAideTempDirectory } from "../../../storage/temp-paths";

const INSTALL_WORKSPACE_PREFIX = "operation-";
const LEGACY_DSH_RELATIVE_PATH = "mv-aide/dsh";

function installWorkspaceRoot(): string {
  return mvAideTempDirectory("dsh/install");
}
const STALE_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1_000;

export interface DshInstallWorkspace {
  root: string;
  npmCache: string;
  downloads: string;
}

export interface DshCleanupFailure {
  path: string;
  error: string;
}

export interface DshCleanupResult {
  removed: string[];
  failures: DshCleanupFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isDshInstallWorkspacePath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return isInside(installWorkspaceRoot(), resolved)
    && path.basename(resolved).startsWith(INSTALL_WORKSPACE_PREFIX);
}

export async function createDshInstallWorkspace(): Promise<DshInstallWorkspace> {
  const base = installWorkspaceRoot();
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(base, INSTALL_WORKSPACE_PREFIX));
  try {
    await fs.chmod(root, 0o700).catch(() => undefined);
    const npmCache = path.join(root, "npm-cache");
    const downloads = path.join(root, "downloads");
    await Promise.all([
      fs.mkdir(npmCache, { recursive: true, mode: 0o700 }),
      fs.mkdir(downloads, { recursive: true, mode: 0o700 }),
    ]);
    return { root, npmCache, downloads };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeDshInstallWorkspace(root: string): Promise<DshCleanupFailure | null> {
  if (!isDshInstallWorkspacePath(root)) {
    return { path: root, error: "Refused to remove a path outside a DSH install workspace." };
  }
  try {
    await fs.rm(root, { recursive: true, force: true });
    return null;
  } catch (error) {
    return { path: root, error: errorMessage(error) };
  }
}

async function removeKnownPath(target: string, result: DshCleanupResult): Promise<void> {
  try {
    const exists = await fs.access(target).then(() => true, () => false);
    if (!exists) return;
    await fs.rm(target, { recursive: true, force: true });
    result.removed.push(target);
  } catch (error) {
    result.failures.push({ path: target, error: errorMessage(error) });
  }
}

/** Remove only obsolete installer artifacts; persistent runtimes are never touched. */
export async function cleanupLegacyDshInstallArtifacts(
  vaultRoot: string,
): Promise<DshCleanupResult> {
  const result: DshCleanupResult = { removed: [], failures: [] };
  const base = path.join(vaultRoot, ...LEGACY_DSH_RELATIVE_PATH.split("/"));
  await removeKnownPath(path.join(base, "npm-cache"), result);
  await removeKnownPath(path.join(base, "downloads"), result);
  await removeKnownPath(path.join(base, ".tmp"), result);

  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!/^node\.(?:staging|backup)-[A-Za-z0-9-]+$/u.test(entry.name)) continue;
    await removeKnownPath(path.join(base, entry.name), result);
  }
  return result;
}

/** Best-effort cleanup for abandoned operation workspaces after a process crash. */
export async function cleanupStaleDshInstallWorkspaces(
  now = Date.now(),
): Promise<DshCleanupResult> {
  const result: DshCleanupResult = { removed: [], failures: [] };
  const base = installWorkspaceRoot();
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(INSTALL_WORKSPACE_PREFIX)) continue;
    const target = path.join(base, entry.name);
    try {
      const stat = await fs.stat(target);
      if (now - stat.mtimeMs < STALE_WORKSPACE_AGE_MS) continue;
      await fs.rm(target, { recursive: true, force: true });
      result.removed.push(target);
    } catch (error) {
      result.failures.push({ path: target, error: errorMessage(error) });
    }
  }
  return result;
}
