import { promises as fs } from "node:fs";
import path from "node:path";
import { t } from "../../../i18n";
import { processOutput, runProcess, type ProcessResult } from "../../../process-runner";
import {
  prependExecutableDirectory,
  resolveUserCommandEnvironment,
} from "../../../process-environment";
import {
  findSystemExecutable,
  systemExecutableCandidates,
} from "../../../universal-mcp-stdio-command";
import { DSH_PACKAGE, type DshCommand } from "./process";
import type { DshInstallTarget } from "../settings";
import { dshVaultRuntimeDirectory } from "../paths";
import {
  classifyNodeOrigin,
  dshNodeDir,
  managedNodeExecutable,
  managedNpmExecutable,
  runElevatedCommand,
  type DshNodeOrigin,
} from "./node-runtime";
import {
  createDshInstallWorkspace,
  removeDshInstallWorkspace,
} from "./install-workspace";
import {
  classifyBrokenCorepackShim,
  inspectBinaryPath,
  installBinCandidates,
  isKnownWindowsNpmShim,
  isLiveNpmPackageSymlink,
  packageDirectory,
  sameBrokenSymlink,
  type BinaryOccupancy,
} from "./binary-occupancy";

export type DshLayerState =
  | "unknown"
  | "ready"
  | "missing"
  | "broken-link"
  | "occupied"
  | "incompatible"
  | "blocked"
  | "partial"
  | "error";

export interface DshLayerStatus {
  state: DshLayerState;
  version?: string;
  detail?: string;
  /** The package/command exists even if its version probe failed. */
  installed?: boolean;
  /** Filesystem occupancy that prevents or qualifies package installation. */
  binaryIssue?: BinaryOccupancy;
}

export interface DshNodeStatus extends DshLayerStatus {
  /** Exact executable whose version was validated. Present only when ready. */
  executable?: string;
  npmExecutable?: string;
  location?: DshInstallTarget;
  origin?: DshNodeOrigin;
}

export interface DshNodeLocations {
  vault: DshNodeStatus;
  global: DshNodeStatus;
}

export interface DshToolLocations {
  vault: DshLayerStatus;
  global: DshLayerStatus;
}

export interface RuntimeUpdateStatus {
  checked: boolean;
  targetVersion?: string;
  updateAvailable?: boolean;
  relation?: "older" | "current" | "newer";
  error?: string;
}

export interface DshEnvironmentUpdates {
  node: RuntimeUpdateStatus;
  dsh: RuntimeUpdateStatus;
  pnpm: RuntimeUpdateStatus;
}

export interface DshEnvironmentStatus {
  node: DshNodeLocations;
  dsh: DshToolLocations;
  pnpm: DshToolLocations;
  plugins: {
    agent: DshLayerStatus;
    manager: DshLayerStatus;
    full: DshLayerStatus;
  };
  updates: DshEnvironmentUpdates;
  checkedAt: number | null;
}

function unknownToolLocations(): DshToolLocations {
  return { vault: { state: "unknown" }, global: { state: "unknown" } };
}

export const UNKNOWN_DSH_ENVIRONMENT: DshEnvironmentStatus = {
  node: { vault: { state: "unknown" }, global: { state: "unknown" } },
  dsh: unknownToolLocations(),
  pnpm: unknownToolLocations(),
  plugins: {
    agent: { state: "unknown" },
    manager: { state: "unknown" },
    full: { state: "unknown" },
  },
  updates: {
    node: { checked: false },
    dsh: { checked: false },
    pnpm: { checked: false },
  },
  checkedAt: null,
};

export type DshInstallLayer = "node" | "dsh" | "pnpm" | "plugin";
export type DshPackageName = "dsh" | "pnpm";

/** Node support range declared by the official DeepSeek Harness repository. */
export const DSH_NODE_VERSION_RANGE = ">=22.19.0 <23.0.0 || >=24.0.0";

export interface DshNodeVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

/** Parse the stable version emitted by `node --version`; prereleases are rejected. */
export function parseDshNodeVersion(output: string): DshNodeVersion | null {
  const firstLine = output.split(/\r?\n/u)[0]?.trim() ?? "";
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(firstLine);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, text: `v${major}.${minor}.${patch}` };
}

export function isSupportedDshNodeVersion(version: DshNodeVersion): boolean {
  return (version.major === 22 && version.minor >= 19) || version.major >= 24;
}

function nodeRequirementText(): string {
  return t("Node.js 22.19+（仅 22.x）或 24+");
}

export function nodeDependencyDetail(node: DshNodeStatus): string {
  return node.state === "incompatible"
    ? t("等待兼容的 Node.js。")
    : t("等待 Node.js。");
}

export function preferredNodeLocation(node: DshNodeLocations): DshInstallTarget | null {
  if (node.vault.state === "ready") return "vault";
  if (node.global.state === "ready") return "global";
  if (node.vault.installed) return "vault";
  if (node.global.installed) return "global";
  return null;
}

export function selectedNodeStatus(node: DshNodeLocations): DshNodeStatus {
  const location = preferredNodeLocation(node);
  return location ? node[location] : { state: "missing", detail: t("未检测到 Node.js。") };
}

export function combinedNodeStatus(node: DshNodeLocations): DshLayerStatus {
  const installed = (["vault", "global"] as const)
    .filter((location) => node[location].installed === true || node[location].state === "ready")
    .map((location) => {
      const status = node[location];
      const label = location === "vault" ? t("仓库") : t("全局");
      return `${label}${status.version ? ` ${status.version}` : ""}`;
    });
  const selected = selectedNodeStatus(node);
  if (selected.state === "ready") {
    return {
      state: "ready",
      version: installed.join("，"),
      detail: installed.length > 1
        ? t("仓库与全局均已安装；当前优先使用仓库版。")
        : selected.detail,
    };
  }
  if (installed.length > 0) {
    return { ...selected, version: installed.join("，") };
  }
  if (node.vault.state === "unknown" && node.global.state === "unknown") return { state: "unknown" };
  const error = node.vault.state === "error" ? node.vault : node.global;
  if (error.state === "error") return error;
  return { state: "missing", detail: t("仓库与全局均未安装。") };
}

export function toolIsReady(tool: DshToolLocations): boolean {
  return tool.vault.state === "ready" || tool.global.state === "ready";
}

export function toolIsInstalled(tool: DshToolLocations): boolean {
  return tool.vault.state === "ready"
    || tool.global.state === "ready"
    || tool.vault.installed === true
    || tool.global.installed === true;
}

export function preferredToolLocation(tool: DshToolLocations): DshInstallTarget | null {
  if (tool.vault.state === "ready") return "vault";
  if (tool.global.state === "ready") return "global";
  if (tool.vault.installed) return "vault";
  if (tool.global.installed) return "global";
  return null;
}

/** A narrowly repairable path may retain its install location without being treated as installed. */
export function preferredRepairTarget(tool: DshToolLocations): DshInstallTarget | null {
  if (tool.vault.binaryIssue?.repairable) return "vault";
  if (tool.global.binaryIssue?.repairable) return "global";
  return null;
}

export function combinedToolStatus(tool: DshToolLocations): DshLayerStatus {
  const ready = (["vault", "global"] as const)
    .filter((location) => tool[location].state === "ready")
    .map((location) => {
      const label = location === "vault" ? t("仓库") : t("全局");
      const version = tool[location].version;
      return version ? `${label} ${version}` : label;
    });
  if (ready.length > 0) {
    return {
      state: "ready",
      version: ready.join("，"),
      detail: ready.length === 2
        ? t("仓库与全局均已安装；当前优先使用仓库版。")
        : t("已检测到{location}安装。", { location: ready[0] }),
    };
  }
  if (tool.vault.state === "unknown" && tool.global.state === "unknown") {
    return { state: "unknown" };
  }
  const error = tool.vault.state === "error" ? tool.vault : tool.global;
  if (error.state === "error") return error;
  const occupied = tool.vault.state === "occupied" ? tool.vault : tool.global;
  if (occupied.state === "occupied") return occupied;
  const broken = tool.vault.state === "broken-link" ? tool.vault : tool.global;
  if (broken.state === "broken-link") return broken;
  if (tool.vault.state === "blocked" && tool.global.state === "blocked") {
    return { state: "blocked", detail: tool.vault.detail || tool.global.detail };
  }
  return { state: "missing", detail: t("仓库与全局均未安装。") };
}

/** The lowest dependency that must be satisfied before plugin injection. */
export function nextDshInstallLayer(
  status: DshEnvironmentStatus,
): DshInstallLayer | null {
  if (selectedNodeStatus(status.node).state !== "ready") return "node";
  if (!toolIsReady(status.dsh)) return "dsh";
  if (!toolIsReady(status.pnpm)) return "pnpm";
  if (status.plugins.full.state !== "ready") return "plugin";
  return null;
}

export function dshRuntimeDir(vaultRoot: string): string {
  return dshVaultRuntimeDirectory(vaultRoot);
}

export function dshCliPath(vaultRoot: string): string {
  return path.join(
    dshRuntimeDir(vaultRoot),
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
}

function runtimeBinDir(vaultRoot: string): string {
  return path.join(dshRuntimeDir(vaultRoot), "node_modules", ".bin");
}

function runtimeBinCandidates(vaultRoot: string, name: string): string[] {
  const base = path.join(runtimeBinDir(vaultRoot), name);
  return process.platform === "win32" ? [`${base}.cmd`, `${base}.exe`, base] : [base];
}

function globalBinDirectory(prefix: string): string {
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function globalBinCandidates(prefix: string, name: string): string[] {
  const base = path.join(globalBinDirectory(prefix), name);
  return process.platform === "win32" ? [`${base}.cmd`, `${base}.exe`, base] : [base];
}

async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* inspect the next candidate */
    }
  }
  return null;
}

async function npmExecutableForNode(
  nodeExecutable: string | null,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!nodeExecutable) return null;
  const directory = path.dirname(nodeExecutable);
  const siblingCandidates = process.platform === "win32"
    ? [path.join(directory, "npm.cmd"), path.join(directory, "npm.exe"), path.join(directory, "npm")]
    : [path.join(directory, "npm")];
  return await firstExisting(siblingCandidates)
    ?? findSystemExecutable("npm", process.platform, environment);
}

async function usableNpmExecutable(
  nodeExecutable: string | null,
  npmExecutable: string | null,
  environment: NodeJS.ProcessEnv,
  runner: typeof runProcess,
): Promise<string | null> {
  if (!nodeExecutable || !npmExecutable) return null;
  const result = await runner(npmExecutable, ["--version"], {
    timeoutMs: 15_000,
    env: prependExecutableDirectory(environment, nodeExecutable),
  });
  return result.code === 0 ? npmExecutable : null;
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function npmGlobalPrefix(
  npmExecutable: string | undefined,
  runner: typeof runProcess,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!npmExecutable) return null;
  const result = await runner(npmExecutable, ["prefix", "--global"], {
    timeoutMs: 15_000,
    env: environment,
  });
  if (result.code !== 0) return null;
  return result.stdout.split(/\r?\n/u)[0]?.trim() || null;
}

async function npmGlobalRoot(
  npmExecutable: string | undefined,
  runner: typeof runProcess,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!npmExecutable) return null;
  const result = await runner(npmExecutable, ["root", "--global"], {
    timeoutMs: 15_000,
    env: environment,
  });
  if (result.code !== 0) return null;
  return result.stdout.split(/\r?\n/u)[0]?.trim() || null;
}

function occupancyDetail(issue: BinaryOccupancy): string {
  if (issue.state === "broken-link") {
    const target = issue.linkTarget ? ` → ${issue.linkTarget}` : "";
    if (issue.owner === "corepack" && issue.repairable) {
      return t("检测到失效的旧 Corepack 链接：{path}{target}。点击“修复”时只会移除这个失效链接，然后重新安装 pnpm；不会使用 npm --force。", {
        path: issue.path,
        target,
      });
    }
    return t("检测到失效的命令链接：{path}{target}。无法确认其所有者；为避免覆盖现有工具，mv-AIDE 未修改该路径。", {
      path: issue.path,
      target,
    });
  }
  if (issue.state === "occupied") {
    return t("检测到 {path} 已存在，但无法确认它属于当前 npm 包；为避免覆盖现有工具，mv-AIDE 未修改该路径。", {
      path: issue.path,
    });
  }
  if (issue.state === "error") {
    return t("无法检查命令路径 {path}：{detail}", {
      path: issue.path,
      detail: issue.detail || t("未知错误"),
    });
  }
  return t("未检测到命令路径。")
}

async function firstBinaryIssue(
  candidates: readonly string[],
  binaryName: string,
): Promise<BinaryOccupancy | null> {
  for (const candidate of [...new Set(candidates)]) {
    const inspected = classifyBrokenCorepackShim(
      await inspectBinaryPath(candidate),
      binaryName,
    );
    if (inspected.state !== "missing") return inspected;
  }
  return null;
}

function statusFromBinaryIssue(issue: BinaryOccupancy | null): DshLayerStatus {
  if (!issue) return { state: "missing", installed: false };
  if (issue.state === "broken-link") {
    return {
      state: "broken-link",
      installed: false,
      detail: occupancyDetail(issue),
      binaryIssue: issue,
    };
  }
  if (issue.state === "occupied") {
    return {
      state: "occupied",
      installed: false,
      detail: occupancyDetail(issue),
      binaryIssue: issue,
    };
  }
  if (issue.state === "error") {
    return {
      state: "error",
      installed: false,
      detail: occupancyDetail(issue),
      binaryIssue: issue,
    };
  }
  return { state: "missing", installed: false };
}

async function globalExecutable(
  name: string,
  vaultRoot: string,
  prefix: string | null,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  const fromPrefix = prefix ? await firstExisting(globalBinCandidates(prefix, name)) : null;
  if (fromPrefix) return fromPrefix;
  const fromPath = findSystemExecutable(name, process.platform, environment);
  return fromPath && !isInside(runtimeBinDir(vaultRoot), fromPath) ? fromPath : null;
}

interface LocatedCommand {
  location: DshInstallTarget;
  command: DshCommand;
}

export interface DshRuntimeInspection {
  dsh: DshToolLocations;
  pnpm: DshToolLocations;
  command: DshCommand | null;
}

async function probeCommand(
  command: DshCommand | null,
  runner: typeof runProcess,
): Promise<DshLayerStatus> {
  if (!command) return { state: "missing", installed: false };
  const result = await runner(
    command.executable,
    [...command.argsPrefix, "--version"],
    {
      timeoutMs: 30_000,
      env: command.env,
    },
  );
  const output = processOutput(result);
  const version = output.split(/\r?\n/u)[0]?.trim();
  return result.code === 0
    ? { state: "ready", version: version || t("可用"), installed: true }
    : { state: "error", detail: output || t("版本检测失败。"), installed: true };
}

function commandEnvironment(
  vaultRoot: string,
  includeVaultPnpm: boolean,
  node: DshNodeStatus | undefined,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let environment = { ...baseEnvironment };
  if (node?.executable) environment = prependExecutableDirectory(environment, node.executable);
  if (includeVaultPnpm) {
    environment = prependExecutableDirectory(
      environment,
      path.join(runtimeBinDir(vaultRoot), process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
    );
  }
  return environment;
}

export function selectPreferredDshCommand(
  vaultRoot: string,
  vault: DshCommand | null,
  global: DshCommand | null,
  vaultPnpmReady: boolean,
  node?: DshNodeStatus,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): DshCommand | null {
  const selected = vault ?? global;
  if (!selected) return null;
  return {
    ...selected,
    env: commandEnvironment(vaultRoot, vaultPnpmReady, node, baseEnvironment),
  };
}

async function probeNodeExecutable(
  executable: string | null,
  npmExecutable: string | null,
  location: DshInstallTarget,
  vaultRoot: string,
  runner: typeof runProcess = runProcess,
): Promise<DshNodeStatus> {
  if (!executable) return { state: "missing", installed: false, location };
  const origin = classifyNodeOrigin(executable, vaultRoot);
  const result = await runner(executable, ["--version"], { timeoutMs: 15_000 });
  const output = processOutput(result);
  if (result.code !== 0) {
    return {
      state: "error",
      detail: output || t("Node.js 版本检测失败。"),
      installed: true,
      executable,
      npmExecutable: npmExecutable ?? undefined,
      location,
      origin,
    };
  }
  const version = parseDshNodeVersion(output);
  if (!version) {
    return {
      state: "error",
      detail: t("无法解析 Node.js 版本“{version}”；DSH 需要 {requirement}。", {
        version: output.split(/\r?\n/u)[0]?.trim() || t("空输出"),
        requirement: nodeRequirementText(),
      }),
      installed: true,
      executable,
      npmExecutable: npmExecutable ?? undefined,
      location,
      origin,
    };
  }
  if (!isSupportedDshNodeVersion(version)) {
    return {
      state: "incompatible",
      version: version.text,
      detail: t("Node.js {version} 不兼容；DSH 需要 {requirement}。", {
        version: version.text,
        requirement: nodeRequirementText(),
      }),
      installed: true,
      executable,
      npmExecutable: npmExecutable ?? undefined,
      location,
      origin,
    };
  }
  return {
    state: "ready",
    version: version.text,
    detail: executable,
    installed: true,
    executable,
    npmExecutable: npmExecutable ?? undefined,
    location,
    origin,
  };
}

/** Compatibility wrapper retained for focused version tests and callers. */
export async function detectNodeStatus(
  runner: typeof runProcess = runProcess,
): Promise<DshNodeStatus> {
  const environment = await resolveUserCommandEnvironment(process.platform, process.env, runner);
  const nodeExecutable = findSystemExecutable("node", process.platform, environment);
  const npmCandidate = await npmExecutableForNode(nodeExecutable, environment);
  const npmExecutable = await usableNpmExecutable(nodeExecutable, npmCandidate, environment, runner);
  return probeNodeExecutable(
    nodeExecutable,
    npmExecutable,
    "global",
    process.cwd(),
    runner,
  );
}

export async function inspectNodeRuntimes(
  vaultRoot: string,
  runner: typeof runProcess = runProcess,
  environment?: NodeJS.ProcessEnv,
): Promise<DshNodeLocations> {
  const commandEnv = environment ?? await resolveUserCommandEnvironment(process.platform, process.env, runner);
  const vaultNode = managedNodeExecutable(vaultRoot);
  const vaultNpm = managedNpmExecutable(vaultRoot);
  const [vaultExists, vaultNpmExists] = await Promise.all([
    fs.access(vaultNode).then(() => true, () => false),
    fs.access(vaultNpm).then(() => true, () => false),
  ]);
  const globalNode = findSystemExecutable("node", process.platform, commandEnv);
  const globalNpmCandidate = await npmExecutableForNode(globalNode, commandEnv);
  const [vaultNpmExecutable, globalNpmExecutable] = await Promise.all([
    usableNpmExecutable(
      vaultExists ? vaultNode : null,
      vaultNpmExists ? vaultNpm : null,
      commandEnv,
      runner,
    ),
    usableNpmExecutable(globalNode, globalNpmCandidate, commandEnv, runner),
  ]);
  const [vault, global] = await Promise.all([
    probeNodeExecutable(
      vaultExists ? vaultNode : null,
      vaultNpmExecutable,
      "vault",
      vaultRoot,
      runner,
    ),
    probeNodeExecutable(
      globalNode,
      globalNpmExecutable,
      "global",
      vaultRoot,
      runner,
    ),
  ]);
  return { vault, global };
}

export async function inspectDshRuntime(
  vaultRoot: string,
  nodes: DshNodeLocations,
  runner: typeof runProcess = runProcess,
  environment?: NodeJS.ProcessEnv,
): Promise<DshRuntimeInspection> {
  const commandEnv = environment ?? await resolveUserCommandEnvironment(process.platform, process.env, runner);
  const node = selectedNodeStatus(nodes);
  const globalNode = nodes.global.state === "ready" ? nodes.global : undefined;
  const globalCommandEnv = prependExecutableDirectory(commandEnv, globalNode?.executable);
  const globalNpmExecutable = globalNode?.npmExecutable;
  const prefix = await npmGlobalPrefix(globalNpmExecutable, runner, globalCommandEnv);
  const [vaultPnpmExecutable, globalDshExecutable, globalPnpmExecutable, vaultDshExists] =
    await Promise.all([
      firstExisting(runtimeBinCandidates(vaultRoot, "pnpm")),
      globalExecutable("dsh", vaultRoot, prefix, globalCommandEnv),
      globalExecutable("pnpm", vaultRoot, prefix, globalCommandEnv),
      fs.access(dshCliPath(vaultRoot)).then(() => true, () => false),
    ]);
  const globalPrefixOccupancyCandidates = (name: string): string[] =>
    prefix ? installBinCandidates(globalBinDirectory(prefix), name) : [];
  const globalOccupancyCandidates = (name: string): string[] => [
    ...globalPrefixOccupancyCandidates(name),
    ...systemExecutableCandidates(name, process.platform, globalCommandEnv)
      .filter((candidate) => !isInside(runtimeBinDir(vaultRoot), candidate)),
  ];
  const [vaultPnpmIssue, globalDshIssue, discoveredGlobalPnpmIssue] = await Promise.all([
    vaultPnpmExecutable
      ? Promise.resolve(null)
      : firstBinaryIssue(installBinCandidates(runtimeBinDir(vaultRoot), "pnpm"), "pnpm"),
    globalDshExecutable ? Promise.resolve(null) : firstBinaryIssue(globalOccupancyCandidates("dsh"), "dsh"),
    globalPnpmExecutable ? Promise.resolve(null) : firstBinaryIssue(globalOccupancyCandidates("pnpm"), "pnpm"),
  ]);
  const globalPnpmIssue = discoveredGlobalPnpmIssue?.repairable
    && !globalPrefixOccupancyCandidates("pnpm").includes(discoveredGlobalPnpmIssue.path)
    ? { ...discoveredGlobalPnpmIssue, repairable: false }
    : discoveredGlobalPnpmIssue;

  if (node.state !== "ready" || !node.executable) {
    const blocked = (vaultInstalled: boolean, globalInstalled: boolean): DshToolLocations => ({
      vault: {
        state: "blocked",
        detail: nodeDependencyDetail(node),
        installed: vaultInstalled,
      },
      global: {
        state: "blocked",
        detail: nodeDependencyDetail(node),
        installed: globalInstalled,
      },
    });
    return {
      dsh: blocked(vaultDshExists, globalDshExecutable !== null),
      pnpm: blocked(vaultPnpmExecutable !== null, globalPnpmExecutable !== null),
      command: null,
    };
  }

  const vaultDsh: LocatedCommand | null = vaultDshExists
    ? {
        location: "vault",
        command: {
          executable: node.executable,
          argsPrefix: [dshCliPath(vaultRoot)],
          env: commandEnvironment(vaultRoot, false, node, commandEnv),
        },
      }
    : null;
  const globalDsh: LocatedCommand | null = globalDshExecutable
    ? {
        location: "global",
        command: {
          executable: globalDshExecutable,
          argsPrefix: [],
          env: commandEnvironment(vaultRoot, false, globalNode ?? node, commandEnv),
        },
      }
    : null;
  const vaultPnpm: DshCommand | null = vaultPnpmExecutable
    ? {
        executable: vaultPnpmExecutable,
        argsPrefix: [],
        env: commandEnvironment(vaultRoot, false, node, commandEnv),
      }
    : null;
  const globalPnpm: DshCommand | null = globalPnpmExecutable
    ? {
        executable: globalPnpmExecutable,
        argsPrefix: [],
        env: commandEnvironment(vaultRoot, false, globalNode ?? node, commandEnv),
      }
    : null;

  const [vaultDshStatus, globalDshStatus, vaultPnpmStatus, globalPnpmStatus] =
    await Promise.all([
      probeCommand(vaultDsh?.command ?? null, runner),
      globalDsh?.command
        ? probeCommand(globalDsh.command, runner)
        : Promise.resolve(statusFromBinaryIssue(globalDshIssue)),
      vaultPnpm
        ? probeCommand(vaultPnpm, runner)
        : Promise.resolve(statusFromBinaryIssue(vaultPnpmIssue)),
      globalPnpm
        ? probeCommand(globalPnpm, runner)
        : Promise.resolve(statusFromBinaryIssue(globalPnpmIssue)),
    ]);
  const dsh = { vault: vaultDshStatus, global: globalDshStatus };
  const pnpm = { vault: vaultPnpmStatus, global: globalPnpmStatus };
  return {
    dsh,
    pnpm,
    command: selectPreferredDshCommand(
      vaultRoot,
      vaultDshStatus.state === "ready" ? vaultDsh?.command ?? null : null,
      globalDshStatus.state === "ready" ? globalDsh?.command ?? null : null,
      pnpm.vault.state === "ready",
      node,
      commandEnv,
    ),
  };
}

export function missingDshPackages(
  inspection: Pick<DshRuntimeInspection, "dsh" | "pnpm">,
): DshPackageName[] {
  const missing: DshPackageName[] = [];
  if (!toolIsInstalled(inspection.dsh)) missing.push("dsh");
  if (!toolIsInstalled(inspection.pnpm)) missing.push("pnpm");
  return missing;
}

export interface DshPackageInstallSpec {
  name: DshPackageName;
  version: string;
}

export interface DshPackageInstallLifecycle {
  /** Runs immediately before each npm attempt that may mutate installed files. */
  beforeMutation?: () => Promise<void>;
}

export function dshInstallArgs(
  target: DshInstallTarget,
  runtime: string,
  packages: readonly DshPackageInstallSpec[],
): string[] {
  const targetArgs = target === "vault" ? ["--prefix", runtime] : ["--global"];
  const specs = packages.map(({ name, version }) =>
    name === "dsh" ? `${DSH_PACKAGE}@${version}` : `pnpm@${version}`);
  return [
    "install",
    ...targetArgs,
    "--no-audit",
    "--no-fund",
    "--save-exact",
    ...specs,
  ];
}

const PACKAGE_BIN_NAMES: Record<DshPackageName, readonly string[]> = {
  dsh: ["dsh"],
  pnpm: ["pnpm", "pnpx"],
};

interface DshPackageInstallLayout {
  binDirectory: string;
  modulesRoot: string;
}

interface DshInstallPreflight {
  repairs: BinaryOccupancy[];
  blockers: BinaryOccupancy[];
}

function installFailure(detail: string): ProcessResult {
  return { code: null, stdout: "", stderr: detail, timedOut: false };
}

async function packageInstallLayout(
  target: DshInstallTarget,
  runtime: string,
  npmExecutable: string,
  runner: typeof runProcess,
  environment: NodeJS.ProcessEnv,
): Promise<DshPackageInstallLayout | null> {
  if (target === "vault") {
    const modulesRoot = path.join(runtime, "node_modules");
    return { modulesRoot, binDirectory: path.join(modulesRoot, ".bin") };
  }
  const [prefix, modulesRoot] = await Promise.all([
    npmGlobalPrefix(npmExecutable, runner, environment),
    npmGlobalRoot(npmExecutable, runner, environment),
  ]);
  if (!prefix || !modulesRoot) return null;
  return { modulesRoot, binDirectory: globalBinDirectory(prefix) };
}

async function inspectPackageInstallTargets(
  layout: DshPackageInstallLayout,
  packages: readonly DshPackageInstallSpec[],
  collectRepairs: boolean,
): Promise<DshInstallPreflight> {
  const repairs: BinaryOccupancy[] = [];
  const blockers: BinaryOccupancy[] = [];
  for (const spec of packages) {
    const expectedPackageDirectory = packageDirectory(layout.modulesRoot, spec.name);
    for (const binaryName of PACKAGE_BIN_NAMES[spec.name]) {
      for (const candidate of installBinCandidates(layout.binDirectory, binaryName)) {
        let occupancy = await inspectBinaryPath(candidate);
        if (spec.name === "pnpm") occupancy = classifyBrokenCorepackShim(occupancy, binaryName);
        if (occupancy.state === "missing") continue;
        if (isLiveNpmPackageSymlink(occupancy, expectedPackageDirectory)) continue;
        if (await isKnownWindowsNpmShim(occupancy, spec.name)) continue;
        if (occupancy.state === "broken-link" && occupancy.repairable && collectRepairs) {
          repairs.push(occupancy);
          continue;
        }
        blockers.push(occupancy);
      }
    }
  }
  return {
    repairs: [...new Map(repairs.map((issue) => [issue.path, issue])).values()],
    blockers: [...new Map(blockers.map((issue) => [issue.path, issue])).values()],
  };
}

function permissionError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
  return code === "EACCES" || code === "EPERM";
}

async function repairBrokenCorepackShim(
  issue: BinaryOccupancy,
  target: DshInstallTarget,
  runner: typeof runProcess,
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  if (
    issue.state !== "broken-link"
    || issue.entryType !== "symlink"
    || issue.owner !== "corepack"
    || issue.repairable !== true
    || !issue.linkTarget
  ) {
    return installFailure(t("拒绝清理未经确认的命令路径：{path}", { path: issue.path }));
  }
  if (!await sameBrokenSymlink(issue)) {
    return installFailure(t("安装目标在预检后发生变化；为避免删除新的文件，本次操作已停止：{path}", {
      path: issue.path,
    }));
  }
  try {
    await fs.unlink(issue.path);
  } catch (error) {
    if (!permissionError(error) || target !== "global" || process.platform === "win32") {
      return installFailure(error instanceof Error ? error.message : String(error));
    }
    const verifyAndRemove = [
      "p=$1",
      "expected=$2",
      "[ -L \"$p\" ] || exit 73",
      "actual=$(/usr/bin/readlink \"$p\") || exit 74",
      "[ \"$actual\" = \"$expected\" ] || exit 75",
      "[ ! -e \"$p\" ] || exit 76",
      "/bin/rm -f \"$p\"",
    ].join("; ");
    const elevated = await runElevatedCommand(
      "/bin/sh",
      ["-c", verifyAndRemove, "mv-aide", issue.path, issue.linkTarget],
      { timeoutMs: 120_000, env: { PATH: environment.PATH } },
      runner,
    );
    if (elevated.code !== 0) return elevated;
  }
  const verified = await inspectBinaryPath(issue.path);
  return verified.state === "missing"
    ? { code: 0, stdout: "", stderr: "", timedOut: false }
    : installFailure(t("失效链接清理后目标仍被占用；本次安装已停止：{path}", { path: issue.path }));
}

async function preflightPackageInstall(
  target: DshInstallTarget,
  runtime: string,
  npmExecutable: string,
  packages: readonly DshPackageInstallSpec[],
  runner: typeof runProcess,
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult | null> {
  const layout = await packageInstallLayout(target, runtime, npmExecutable, runner, environment);
  if (!layout) {
    return installFailure(t("无法确定当前 npm 的安装目录；为避免写入未知位置，本次安装未执行。"));
  }
  const initial = await inspectPackageInstallTargets(layout, packages, true);
  if (initial.blockers.length > 0) return installFailure(occupancyDetail(initial.blockers[0]!));
  for (const issue of initial.repairs) {
    const repaired = await repairBrokenCorepackShim(issue, target, runner, environment);
    if (repaired.code !== 0) return repaired;
  }
  const verified = await inspectPackageInstallTargets(layout, packages, false);
  if (verified.blockers.length > 0 || verified.repairs.length > 0) {
    const issue = verified.blockers[0] ?? verified.repairs[0]!;
    return installFailure(occupancyDetail(issue));
  }
  return null;
}

export function describeDshInstallFailure(
  target: DshInstallTarget,
  result: ProcessResult,
): string {
  const output = processOutput(result) || t("无输出");
  if (result.failureKind === "launch") {
    return t("无法启动 npm 安装命令：{detail}", { detail: output });
  }
  if (result.failureKind === "timeout" || result.timedOut) {
    return t("npm 安装超时：{detail}", { detail: output });
  }
  if (target === "global" && isElevationCancelled(output)) {
    return t("已取消管理员授权；未改用仓库安装。");
  }
  if (/(?:\bEEXIST\b|file already exists|already exists)/iu.test(output)) {
    return t("安装目标在预检后再次被占用；mv-AIDE 未强制覆盖。请重新检测后重试。\n{detail}", {
      detail: output,
    });
  }
  if (target === "global" && isGlobalPermissionOutput(output)) {
    return t("npm 全局安装目录不可写；请修复当前 Node/npm 的全局目录权限后重试。不会自动降级为仓库安装。\n{detail}", {
      detail: output,
    });
  }
  return output;
}

function isElevationCancelled(output: string): boolean {
  return /(?:operation (?:was )?cancelled|operation (?:was )?canceled|cancelled by (?:the )?user|canceled by (?:the )?user|error\s*1223|0x4c7|用户取消|操作已取消)/iu.test(output);
}

function isGlobalPermissionOutput(output: string): boolean {
  return /(?:EACCES|EPERM|permission denied|access (?:is )?denied|requires elevation|拒绝访问|需要提升权限)/iu.test(output);
}

function isGlobalPermissionFailure(result: ProcessResult): boolean {
  return isGlobalPermissionOutput(processOutput(result));
}

export async function installDshPackages(
  vaultRoot: string,
  target: DshInstallTarget | null,
  node: DshNodeStatus,
  packages: readonly DshPackageInstallSpec[],
  runner: typeof runProcess = runProcess,
  environment?: NodeJS.ProcessEnv,
  lifecycle: DshPackageInstallLifecycle = {},
): Promise<ProcessResult> {
  if (node.state !== "ready" || !node.executable) {
    return { code: null, stdout: "", stderr: node.detail || t("未检测到兼容的 Node.js。"), timedOut: false };
  }
  if (packages.length === 0) return { code: 0, stdout: "", stderr: "", timedOut: false };
  if (!target) {
    return { code: null, stdout: "", stderr: t("请先选择缺失依赖的安装位置。"), timedOut: false };
  }
  const npm = node.npmExecutable;
  if (!npm) {
    return { code: null, stdout: "", stderr: t("已找到 Node.js，但没有与该 Node.js 配对且可用的 npm。"), timedOut: false };
  }
  const runtime = dshRuntimeDir(vaultRoot);
  const baseEnvironment = environment ?? process.env;
  const commandEnvironment = prependExecutableDirectory(baseEnvironment, node.executable);
  try {
    const preflight = await preflightPackageInstall(
      target,
      runtime,
      npm,
      packages,
      runner,
      commandEnvironment,
    );
    if (preflight) return preflight;
  } catch (error) {
    return installFailure(error instanceof Error ? error.message : String(error));
  }
  try {
    await lifecycle.beforeMutation?.();
  } catch (error) {
    return installFailure(error instanceof Error ? error.message : String(error));
  }
  const workspace = await createDshInstallWorkspace();
  const args = dshInstallArgs(target, runtime, packages);
  let result: ProcessResult = { code: null, stdout: "", stderr: "", timedOut: false };
  try {
    if (target === "vault") await fs.mkdir(runtime, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...commandEnvironment,
      npm_config_cache: workspace.npmCache,
    };
    result = await runner(
      npm,
      args,
      {
        cwd: vaultRoot,
        timeoutMs: 300_000,
        env,
      },
    );
    if (target === "global" && isGlobalPermissionFailure(result)) {
      await lifecycle.beforeMutation?.();
      result = await runElevatedCommand(
        npm,
        args,
        {
          cwd: vaultRoot,
          timeoutMs: 600_000,
          env: {
            PATH: env.PATH,
            npm_config_cache: workspace.npmCache,
          },
          cleanupPaths: [workspace.root],
        },
        runner,
      );
    }
  } catch (error) {
    result = {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  } finally {
    const cleanupFailure = await removeDshInstallWorkspace(workspace.root);
    if (cleanupFailure) {
      result = {
        code: null,
        stdout: result.stdout,
        stderr: `${result.stderr ? `${result.stderr}\n` : ""}${t("安装临时文件清理失败：{path}：{detail}", {
          path: cleanupFailure.path,
          detail: cleanupFailure.error,
        })}`,
        timedOut: result.timedOut,
      };
    }
  }
  return result;
}
