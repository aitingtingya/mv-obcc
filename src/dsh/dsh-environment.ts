import { promises as fs } from "node:fs";
import path from "node:path";
import { t } from "../i18n";
import { processOutput, runProcess, type ProcessResult } from "../process-runner";
import { findSystemExecutable } from "../universal-mcp-stdio-command";
import { DSH_PACKAGE, type DshCommand } from "./dsh-process";
import type { DshInstallTarget } from "./dsh-settings";
import {
  classifyNodeOrigin,
  dshNodeDir,
  managedNodeExecutable,
  managedNpmExecutable,
  runElevatedCommand,
  type DshNodeOrigin,
} from "./dsh-node-runtime";
import {
  createDshInstallWorkspace,
  removeDshInstallWorkspace,
} from "./dsh-install-workspace";

export type DshLayerState =
  | "unknown"
  | "ready"
  | "missing"
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

export interface DshEnvironmentStatus {
  node: DshNodeLocations;
  dsh: DshToolLocations;
  pnpm: DshToolLocations;
  plugin: DshLayerStatus;
  checkedAt: number | null;
}

function unknownToolLocations(): DshToolLocations {
  return { vault: { state: "unknown" }, global: { state: "unknown" } };
}

export const UNKNOWN_DSH_ENVIRONMENT: DshEnvironmentStatus = {
  node: { vault: { state: "unknown" }, global: { state: "unknown" } },
  dsh: unknownToolLocations(),
  pnpm: unknownToolLocations(),
  plugin: { state: "unknown" },
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
  if (status.plugin.state !== "ready") return "plugin";
  return null;
}

export const DSH_RUNTIME_RELATIVE_PATH = "mv-aide/dsh/runtime";

export function dshRuntimeDir(vaultRoot: string): string {
  return path.join(vaultRoot, ...DSH_RUNTIME_RELATIVE_PATH.split("/"));
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

function globalBinCandidates(prefix: string, name: string): string[] {
  const directory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const base = path.join(directory, name);
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

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function npmGlobalPrefix(runner: typeof runProcess): Promise<string | null> {
  const npm = findSystemExecutable("npm");
  if (!npm) return null;
  const result = await runner(npm, ["prefix", "--global"], {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) return null;
  return processOutput(result).split(/\r?\n/u)[0]?.trim() || null;
}

async function globalExecutable(
  name: string,
  vaultRoot: string,
  prefix: string | null,
): Promise<string | null> {
  const fromPath = findSystemExecutable(name);
  if (fromPath && !isInside(runtimeBinDir(vaultRoot), fromPath)) return fromPath;
  return prefix ? firstExisting(globalBinCandidates(prefix, name)) : null;
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
  node?: DshNodeStatus,
): NodeJS.ProcessEnv {
  const paths: string[] = [];
  if (includeVaultPnpm) paths.push(runtimeBinDir(vaultRoot));
  if (node?.executable) paths.push(path.dirname(node.executable));
  if (paths.length === 0) return process.env;
  return {
    ...process.env,
    PATH: `${paths.join(path.delimiter)}${path.delimiter}${process.env.PATH || ""}`,
  };
}

export function selectPreferredDshCommand(
  vaultRoot: string,
  vault: DshCommand | null,
  global: DshCommand | null,
  vaultPnpmReady: boolean,
  node?: DshNodeStatus,
): DshCommand | null {
  const selected = vault ?? global;
  if (!selected) return null;
  return {
    ...selected,
    env: commandEnvironment(vaultRoot, vaultPnpmReady, node),
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
  return probeNodeExecutable(
    findSystemExecutable("node"),
    findSystemExecutable("npm"),
    "global",
    process.cwd(),
    runner,
  );
}

export async function inspectNodeRuntimes(
  vaultRoot: string,
  runner: typeof runProcess = runProcess,
): Promise<DshNodeLocations> {
  const vaultNode = managedNodeExecutable(vaultRoot);
  const vaultNpm = managedNpmExecutable(vaultRoot);
  const [vaultExists, vaultNpmExists] = await Promise.all([
    fs.access(vaultNode).then(() => true, () => false),
    fs.access(vaultNpm).then(() => true, () => false),
  ]);
  const [vault, global] = await Promise.all([
    probeNodeExecutable(
      vaultExists ? vaultNode : null,
      vaultNpmExists ? vaultNpm : null,
      "vault",
      vaultRoot,
      runner,
    ),
    probeNodeExecutable(
      findSystemExecutable("node"),
      findSystemExecutable("npm"),
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
): Promise<DshRuntimeInspection> {
  const node = selectedNodeStatus(nodes);
  const prefix = await npmGlobalPrefix(runner);
  const [vaultPnpmExecutable, globalDshExecutable, globalPnpmExecutable, vaultDshExists] =
    await Promise.all([
      firstExisting(runtimeBinCandidates(vaultRoot, "pnpm")),
      globalExecutable("dsh", vaultRoot, prefix),
      globalExecutable("pnpm", vaultRoot, prefix),
      fs.access(dshCliPath(vaultRoot)).then(() => true, () => false),
    ]);

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
          env: commandEnvironment(vaultRoot, false, node),
        },
      }
    : null;
  const globalDsh: LocatedCommand | null = globalDshExecutable
    ? {
        location: "global",
        command: {
          executable: globalDshExecutable,
          argsPrefix: [],
          env: commandEnvironment(vaultRoot, false, node),
        },
      }
    : null;
  const vaultPnpm: DshCommand | null = vaultPnpmExecutable
    ? {
        executable: vaultPnpmExecutable,
        argsPrefix: [],
        env: commandEnvironment(vaultRoot, false, node),
      }
    : null;
  const globalPnpm: DshCommand | null = globalPnpmExecutable
    ? {
        executable: globalPnpmExecutable,
        argsPrefix: [],
        env: commandEnvironment(vaultRoot, false, node),
      }
    : null;

  const [vaultDshStatus, globalDshStatus, vaultPnpmStatus, globalPnpmStatus] =
    await Promise.all([
      probeCommand(vaultDsh?.command ?? null, runner),
      probeCommand(globalDsh?.command ?? null, runner),
      probeCommand(vaultPnpm, runner),
      probeCommand(globalPnpm, runner),
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

export function dshInstallArgs(
  target: DshInstallTarget,
  runtime: string,
  packages: readonly DshPackageName[],
): string[] {
  const targetArgs = target === "vault" ? ["--prefix", runtime] : ["--global"];
  const specs = packages.map((name) => name === "dsh" ? `${DSH_PACKAGE}@latest` : "pnpm@latest");
  return [
    "install",
    ...targetArgs,
    "--no-audit",
    "--no-fund",
    "--save-exact",
    ...specs,
  ];
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
  packages: readonly DshPackageName[],
  runner: typeof runProcess = runProcess,
): Promise<ProcessResult> {
  if (node.state !== "ready" || !node.executable) {
    return { code: null, stdout: "", stderr: node.detail || t("未检测到兼容的 Node.js。"), timedOut: false };
  }
  if (packages.length === 0) return { code: 0, stdout: "", stderr: "", timedOut: false };
  if (!target) {
    return { code: null, stdout: "", stderr: t("请先选择缺失依赖的安装位置。"), timedOut: false };
  }
  const npm = node.npmExecutable ?? findSystemExecutable("npm");
  if (!npm) {
    return { code: null, stdout: "", stderr: t("已找到 Node.js，但未在系统 PATH 中找到 npm。"), timedOut: false };
  }
  const runtime = dshRuntimeDir(vaultRoot);
  const workspace = await createDshInstallWorkspace();
  const args = dshInstallArgs(target, runtime, packages);
  let result: ProcessResult = { code: null, stdout: "", stderr: "", timedOut: false };
  try {
    if (target === "vault") await fs.mkdir(runtime, { recursive: true });
    const env = {
      ...process.env,
      PATH: node.executable
        ? `${path.dirname(node.executable)}${path.delimiter}${process.env.PATH || ""}`
        : process.env.PATH,
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
