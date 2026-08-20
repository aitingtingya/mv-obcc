import { promises as fs } from "node:fs";
import path from "node:path";

export type BinaryOccupancyState = "missing" | "broken-link" | "occupied" | "error";
export type BinaryEntryType = "file" | "symlink" | "directory" | "other";
export type BinaryOwner = "corepack" | "npm-package" | "unknown";

export interface BinaryOccupancy {
  state: BinaryOccupancyState;
  path: string;
  entryType?: BinaryEntryType;
  linkTarget?: string;
  resolvedTarget?: string;
  owner?: BinaryOwner;
  repairable?: boolean;
  detail?: string;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : undefined;
}

function entryType(stat: Awaited<ReturnType<typeof fs.lstat>>): BinaryEntryType {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

/**
 * Inspect the directory entry itself instead of following it first. This is the
 * key distinction needed to expose dangling package-manager shims that `stat()`
 * and `existsSync()` intentionally collapse into "not found".
 */
export async function inspectBinaryPath(candidate: string): Promise<BinaryOccupancy> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing", path: candidate };
    return {
      state: "error",
      path: candidate,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const kind = entryType(stat);
  if (kind !== "symlink") {
    return { state: "occupied", path: candidate, entryType: kind, owner: "unknown", repairable: false };
  }

  let linkTarget: string;
  try {
    linkTarget = await fs.readlink(candidate);
  } catch (error) {
    return {
      state: "error",
      path: candidate,
      entryType: "symlink",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const resolvedTarget = path.isAbsolute(linkTarget)
    ? path.normalize(linkTarget)
    : path.resolve(path.dirname(candidate), linkTarget);
  try {
    const target = await fs.stat(candidate);
    return {
      state: "occupied",
      path: candidate,
      entryType: "symlink",
      linkTarget,
      resolvedTarget: await fs.realpath(candidate).catch(() => resolvedTarget),
      owner: "unknown",
      repairable: false,
      detail: target.isFile() ? undefined : "Symlink target is not a file.",
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        state: "broken-link",
        path: candidate,
        entryType: "symlink",
        linkTarget,
        resolvedTarget,
        owner: "unknown",
        repairable: false,
      };
    }
    return {
      state: "error",
      path: candidate,
      entryType: "symlink",
      linkTarget,
      resolvedTarget,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function installBinCandidates(
  binDirectory: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const base = path.join(binDirectory, name);
  if (platform !== "win32") return [base];
  // `.ps1` participates in npm/Corepack collisions even though it is not used
  // as a direct child-process executable by the runtime resolver.
  return [base, `${base}.cmd`, `${base}.ps1`, `${base}.exe`];
}

export function packageDirectory(
  modulesRoot: string,
  packageName: "dsh" | "pnpm",
): string {
  return packageName === "dsh"
    ? path.join(modulesRoot, "@deepseek-ai", "dsh")
    : path.join(modulesRoot, "pnpm");
}

function portable(candidate: string): string {
  return candidate.replace(/\\/gu, "/").toLocaleLowerCase("en-US");
}

export function classifyBrokenCorepackShim(
  occupancy: BinaryOccupancy,
  binaryName: string,
  platform: NodeJS.Platform = process.platform,
): BinaryOccupancy {
  if (
    occupancy.state !== "broken-link"
    || occupancy.entryType !== "symlink"
    || !occupancy.resolvedTarget
    || !["pnpm", "pnpx"].includes(binaryName.toLocaleLowerCase("en-US"))
  ) return occupancy;
  const target = portable(occupancy.resolvedTarget);
  if (!target.includes("/node_modules/corepack/")) return occupancy;
  // Corepack on Windows normally creates script shims rather than symlinks. We
  // can report a symlink as Corepack-owned there, but do not auto-delete it
  // until an equally strict Windows-specific repair primitive exists.
  return { ...occupancy, owner: "corepack", repairable: platform !== "win32" };
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** True only for a live POSIX npm symlink whose resolved target belongs to the expected package. */
export function isLiveNpmPackageSymlink(
  occupancy: BinaryOccupancy,
  expectedPackageDirectory: string,
): boolean {
  return occupancy.state === "occupied"
    && occupancy.entryType === "symlink"
    && Boolean(occupancy.resolvedTarget)
    && isInside(expectedPackageDirectory, occupancy.resolvedTarget!);
}

/**
 * npm on Windows writes small cmd/PowerShell shims next to the prefix. Read a
 * bounded prefix only and require an explicit reference to the expected package
 * path before treating an occupied file as npm-owned.
 */
export async function isKnownWindowsNpmShim(
  occupancy: BinaryOccupancy,
  packageName: "dsh" | "pnpm",
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "win32" || occupancy.state !== "occupied" || occupancy.entryType !== "file") return false;
  if (/\.exe$/iu.test(occupancy.path)) return false;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(occupancy.path, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = portable(buffer.subarray(0, bytesRead).toString("utf8"));
    const marker = packageName === "dsh"
      ? "/node_modules/@deepseek-ai/dsh/"
      : "/node_modules/pnpm/";
    return text.includes(marker);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function sameBrokenSymlink(
  snapshot: BinaryOccupancy,
): Promise<boolean> {
  if (snapshot.state !== "broken-link" || snapshot.entryType !== "symlink" || !snapshot.linkTarget) return false;
  const current = await inspectBinaryPath(snapshot.path);
  return current.state === "broken-link"
    && current.entryType === "symlink"
    && current.linkTarget === snapshot.linkTarget
    && current.resolvedTarget === snapshot.resolvedTarget;
}
