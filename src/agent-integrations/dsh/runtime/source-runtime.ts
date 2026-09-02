import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { t } from "../../../i18n";
import { processOutput, runProcess, type ProcessResult } from "../../../process-runner";
import { prependExecutableDirectory } from "../../../process-environment";
import { mvAideSystemRoot } from "../../../storage/system-paths";
import {
  dshWebUrl,
  probeDshWeb,
  type DshCommand,
  type DshWebProbeFn,
} from "./process";
import {
  createDefaultDshProcessDiscoveryAdapter,
  type DshProcessDiscoveryAdapter,
} from "./process-discovery";
import { resolveDshHomeDirectory, withDshHomeEnvironment } from "../paths";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
  scripts?: unknown;
  packageManager?: unknown;
}

export interface DshSourceRuntime {
  rootDirectory: string;
  cliDirectory: string;
  entryPath: string;
  version: string;
  pnpmExecutable?: string;
  pnpmVersion?: string;
  command: DshCommand;
}

export interface RunningDshSourceInspection {
  url: string | null;
  runtime: DshSourceRuntime | null;
  detail?: string;
}

export interface DshSourceUpdateInspection {
  currentCommit: string;
  targetCommit: string;
  targetVersion: string;
  updateAvailable: boolean;
}

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

async function readManifest(directory: string): Promise<PackageManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function binPath(manifest: PackageManifest): string | null {
  if (typeof manifest.bin === "string") return manifest.bin;
  if (manifest.bin && typeof manifest.bin === "object") {
    const value = (manifest.bin as Record<string, unknown>).dsh;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalDirectory(value: string): Promise<string> {
  const absolute = path.resolve(expandHome(value));
  const real = await fs.realpath(absolute);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error(t("自定义 DSH 路径不是目录：{path}", { path: value }));
  return real;
}

async function sourceLayout(input: string): Promise<{
  rootDirectory: string;
  cliDirectory: string;
  manifest: PackageManifest;
}> {
  const selected = await canonicalDirectory(input);
  const selectedManifest = await readManifest(selected);
  if (selectedManifest?.name === "@deepseek-ai/dsh") {
    const possibleRoot = path.resolve(selected, "..", "..");
    const rootManifest = await readManifest(possibleRoot);
    return {
      rootDirectory: rootManifest?.name === "@deepseek-ai/dsh-root" ? possibleRoot : selected,
      cliDirectory: selected,
      manifest: selectedManifest,
    };
  }
  if (selectedManifest?.name !== "@deepseek-ai/dsh-root") {
    throw new Error(t("所选目录不是 DeepSeek Harness 源码仓库或 @deepseek-ai/dsh CLI 目录。"));
  }
  const cliDirectory = path.join(selected, "apps", "cli");
  const cliManifest = await readManifest(cliDirectory);
  if (cliManifest?.name !== "@deepseek-ai/dsh") {
    throw new Error(t("DeepSeek Harness 仓库中缺少有效的 apps/cli/package.json。"));
  }
  return { rootDirectory: selected, cliDirectory, manifest: cliManifest };
}

function parseVersion(output: string): string | null {
  const line = output.split(/\r?\n/u)[0]?.trim() ?? "";
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(line) ? line.replace(/^v/u, "") : null;
}

async function resolveSourcePnpm(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv,
  runner: typeof runProcess,
): Promise<{ executable: string; version: string } | null> {
  const rootManifest = await readManifest(rootDirectory);
  const declared = typeof rootManifest?.packageManager === "string"
    ? /^pnpm@(\d+\.\d+\.\d+)$/u.exec(rootManifest.packageManager)?.[1]
    : undefined;
  if (!declared) return null;
  const base = path.join(rootDirectory, "node_modules", ".bin", "pnpm");
  const candidates = process.platform === "win32" ? [`${base}.cmd`, `${base}.exe`, base] : [base];
  for (const executable of candidates) {
    try {
      if (!(await fs.stat(executable)).isFile()) continue;
      const result = await runner(executable, ["--version"], { env: environment, timeoutMs: 15_000 });
      const version = result.code === 0 ? result.stdout.split(/\r?\n/u)[0]?.trim() : "";
      if (version === declared) return { executable, version };
    } catch {
      // A source-local package manager is optional; keep checking fallbacks.
    }
  }
  return null;
}

export async function resolveDshSourceRuntime(
  input: string,
  options: {
    nodeExecutable: string;
    environment: NodeJS.ProcessEnv;
    homeDirectory?: string;
    requireRuntimeOwner?: boolean;
    origin: "custom-manual" | "custom-discovered";
    runner?: typeof runProcess;
  },
): Promise<DshSourceRuntime> {
  const runner = options.runner ?? runProcess;
  const layout = await sourceLayout(input);
  const homeDirectory = resolveDshHomeDirectory(options.homeDirectory, options.environment);
  const sourcePnpm = await resolveSourcePnpm(layout.rootDirectory, options.environment, runner);
  const homeEnvironment = withDshHomeEnvironment(options.environment, homeDirectory);
  const commandEnvironment = sourcePnpm
    ? prependExecutableDirectory(homeEnvironment, sourcePnpm.executable)
    : homeEnvironment;
  const declaredBin = binPath(layout.manifest);
  if (!declaredBin) throw new Error(t("@deepseek-ai/dsh 没有声明 dsh CLI 入口。"));
  const declaredEntry = path.resolve(layout.cliDirectory, declaredBin);
  if (!isInside(layout.cliDirectory, declaredEntry)) {
    throw new Error(t("DSH CLI manifest 入口越出所选源码目录。"));
  }
  let entryPath: string;
  try {
    entryPath = await fs.realpath(declaredEntry);
    const stat = await fs.stat(entryPath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(t("DSH CLI 尚未构建：缺少 {entry}。请先安装依赖并运行 pnpm run build。", {
      entry: declaredBin,
    }));
  }
  if (!isInside(layout.cliDirectory, entryPath)) {
    throw new Error(t("DSH CLI 真实入口越出所选源码目录。"));
  }
  const command: DshCommand = {
    executable: options.nodeExecutable,
    argsPrefix: [entryPath],
    env: commandEnvironment,
    cwd: layout.rootDirectory,
    homeDirectory,
    requireRuntimeOwner: options.requireRuntimeOwner === true,
    origin: options.origin,
    sourceRoot: layout.rootDirectory,
  };
  const result = await runner(command.executable, [...command.argsPrefix, "--version"], {
    cwd: command.cwd,
    env: command.env,
    timeoutMs: 30_000,
  });
  const output = processOutput(result);
  if (result.code !== 0) throw new Error(output || t("DSH 源码 CLI 版本检测失败。"));
  const version = parseVersion(output);
  if (!version) {
    throw new Error(t("DSH 源码 CLI 版本检测失败：{detail}", {
      detail: output || t("空输出"),
    }));
  }
  return {
    rootDirectory: layout.rootDirectory,
    cliDirectory: layout.cliDirectory,
    entryPath,
    version,
    ...(sourcePnpm ? {
      pnpmExecutable: sourcePnpm.executable,
      pnpmVersion: sourcePnpm.version,
    } : {}),
    command,
  };
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) current += command[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (/\s/u.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function sourceRootsFromCommand(command: string, cwd: string | null): string[] {
  const roots: string[] = [];
  const add = (candidate: string): void => {
    const resolved = path.resolve(candidate);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  const tokens = commandTokens(command);
  for (const token of tokens) {
    const normalized = token.replace(/\\/gu, "/");
    const match = /^(.*)\/apps\/cli\/(?:lib\/bin\.js|src\/bin\.ts)$/u.exec(normalized);
    if (match?.[1]) add(match[1]);
    if (cwd && /(?:^|\/)apps\/cli\/(?:lib\/bin\.js|src\/bin\.ts)$/u.test(normalized)) {
      const absolute = path.resolve(cwd, token);
      const portable = absolute.replace(/\\/gu, "/");
      const absoluteMatch = /^(.*)\/apps\/cli\/(?:lib\/bin\.js|src\/bin\.ts)$/u.exec(portable);
      if (absoluteMatch?.[1]) add(absoluteMatch[1]);
    }
  }
  // `ps` does not consistently quote argv values containing spaces. Recover
  // absolute Unix candidates from the raw command and let full manifest,
  // realpath, and CLI validation reject false positives.
  const portableCommand = command.replace(/\\/gu, "/");
  const marker = /\/apps\/cli\/(?:lib\/bin\.js|src\/bin\.ts)/gu.exec(portableCommand);
  if (marker) {
    const prefix = portableCommand.slice(0, marker.index);
    for (let index = prefix.length - 1; index >= 0; index -= 1) {
      if (prefix[index] === " " && prefix[index + 1] === "/") add(prefix.slice(index + 1));
    }
  }
  if (cwd) {
    const invokesDshWeb = tokens.some((token, index) => {
      const base = token.replace(/\\/gu, "/").split("/").at(-1)?.toLowerCase();
      return ["dsh", "dsh.cmd", "dsh.exe"].includes(base ?? "")
        && tokens.slice(index + 1).includes("web");
    });
    if (invokesDshWeb) add(cwd);
  }
  return roots;
}

export async function discoverRunningDshSource(
  preferredPort: number,
  options: {
    nodeExecutable: string;
    environment: NodeJS.ProcessEnv;
    homeDirectory?: string;
    requireRuntimeOwner?: boolean;
    runner?: typeof runProcess;
    discovery?: DshProcessDiscoveryAdapter;
    probe?: DshWebProbeFn;
  },
): Promise<RunningDshSourceInspection> {
  const runner = options.runner ?? runProcess;
  const discovery = options.discovery ?? createDefaultDshProcessDiscoveryAdapter(process.platform, runner);
  const probe = options.probe ?? probeDshWeb;
  const candidates = Array.from({ length: 21 }, (_, offset) => preferredPort + offset)
    .filter((port) => port > 0 && port < 65536);
  const probes = await Promise.all(candidates.map(async (port) => ({
    port,
    url: dshWebUrl(port),
    inspected: await probe(dshWebUrl(port), 1500).catch(() => ({ reachable: false, isDsh: false })),
  })));
  const running = probes.find(({ inspected }) => inspected.reachable && inspected.isDsh);
  if (running) {
    const { port, url } = running;
    const pid = await discovery.listenerPid(port).catch(() => null);
    if (!pid) return { url, runtime: null, detail: t("已检测到运行中的 DSH，但无法读取监听进程。") };
    const [info, cwd] = await Promise.all([
      discovery.processInfo(pid).catch(() => null),
      discovery.processCwd?.(pid).catch(() => null) ?? Promise.resolve(null),
    ]);
    if (!info) return { url, runtime: null, detail: t("已检测到运行中的 DSH，但无法读取它的命令行。") };
    const roots = sourceRootsFromCommand(info.command, cwd);
    if (roots.length === 0) {
      return { url, runtime: null, detail: t("已检测到运行中的 DSH，但无法安全还原源码目录。") };
    }
    let lastError: unknown;
    for (const root of roots) {
      try {
        const runtime = await resolveDshSourceRuntime(root, {
          nodeExecutable: options.nodeExecutable,
          environment: options.environment,
          homeDirectory: options.homeDirectory,
          requireRuntimeOwner: options.requireRuntimeOwner,
          origin: "custom-discovered",
          runner,
        });
        return { url, runtime };
      } catch (error) {
        lastError = error;
      }
    }
    return {
      url,
      runtime: null,
      detail: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }
  return { url: null, runtime: null };
}

function successful(result: ProcessResult, fallback: string): void {
  if (result.code !== 0) throw new Error(processOutput(result) || fallback);
}

/**
 * Read one source checkout's configured Git upstream without changing its
 * working tree. A fetch may update remote refs, but upgrade eligibility is
 * derived from commits rather than the npm release channel.
 */
export async function inspectDshSourceUpdate(
  runtime: DshSourceRuntime,
  options: {
    runner?: typeof runProcess;
    fetch?: boolean;
  } = {},
): Promise<DshSourceUpdateInspection> {
  const runner = options.runner ?? runProcess;
  const root = runtime.rootDirectory;
  const run = (args: string[], timeoutMs = 120_000) =>
    runner("git", args, { cwd: root, env: runtime.command.env, timeoutMs });
  const status = await run(["status", "--porcelain"]);
  successful(status, t("无法检查 DSH 源码工作树。"));
  if (status.stdout.trim()) {
    throw new Error(t("DSH 源码工作树存在未提交改动，已拒绝检查升级。"));
  }
  const branch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  successful(branch, t("DSH 源码仓库处于 detached HEAD，无法安全升级。"));
  const upstream = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  successful(upstream, t("DSH 源码分支没有配置上游，无法安全升级。"));
  if (options.fetch !== false) {
    successful(await run(["fetch", "--quiet"], 300_000), t("DSH 源码上游更新检查失败。"));
  }
  const current = await run(["rev-parse", "HEAD"]);
  successful(current, t("无法读取 DSH 源码提交。"));
  const target = await run(["rev-parse", "@{u}"]);
  successful(target, t("无法读取 DSH 源码上游提交。"));
  const currentCommit = current.stdout.trim();
  const targetCommit = target.stdout.trim();
  const updateAvailable = currentCommit !== targetCommit;
  if (updateAvailable) {
    const ancestor = await run(["merge-base", "--is-ancestor", "HEAD", "@{u}"]);
    if (ancestor.code !== 0) {
      throw new Error(t("DSH 源码分支无法快进到上游，已拒绝自动合并。"));
    }
  }
  const relativeCli = path.relative(root, runtime.cliDirectory).split(path.sep).join("/");
  if (!relativeCli || relativeCli.startsWith("../")) {
    throw new Error(t("DSH CLI 目录不属于已验证的源码仓库。"));
  }
  const upstreamManifest = await run(["show", `@{u}:${relativeCli}/package.json`]);
  successful(upstreamManifest, t("无法读取 DSH 上游 CLI manifest。"));
  let targetVersion: string | null = null;
  try {
    const manifest = JSON.parse(upstreamManifest.stdout) as PackageManifest;
    targetVersion = typeof manifest.version === "string" ? parseVersion(manifest.version) : null;
  } catch {
    targetVersion = null;
  }
  if (!targetVersion) throw new Error(t("DSH 上游 CLI 版本无效。"));
  return { currentCommit, targetCommit, targetVersion, updateAvailable };
}

const SOURCE_LOCK_MIN_AGE_MS = 10_000;

function lockBusyError(): Error {
  return new Error(t("该 DSH 源码目录正在被另一个 mv-AIDE 实例操作，请稍后重试。"));
}

/** Classify one published owner record. `unknown` covers missing/unreadable. */
async function readLockOwnerState(
  owner: string,
): Promise<"busy" | "stale" | "unknown"> {
  let before: string;
  try {
    before = await fs.readFile(owner, "utf8");
  } catch {
    return "unknown";
  }
  let parsed: { pid?: unknown; createdAt?: unknown };
  try {
    parsed = JSON.parse(before) as { pid?: unknown; createdAt?: unknown };
  } catch {
    return "unknown";
  }
  const age = Date.now() - Number(parsed.createdAt ?? 0);
  const pid = Number(parsed.pid);
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  return age > SOURCE_LOCK_MIN_AGE_MS && !alive ? "stale" : "busy";
}

async function withSourceLock<T>(
  root: string,
  operation: () => Promise<T>,
  lockRoot = path.join(mvAideSystemRoot(), "dsh", "source-locks"),
): Promise<T> {
  const key = createHash("sha256").update(root).digest("hex");
  const lock = path.join(lockRoot, `${key}.lock`);
  const owner = path.join(lock, "owner.json");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  // Publish ownership atomically so a competing process never observes a
  // half-written owner record for an otherwise healthy lock.
  const writeOwner = async (): Promise<void> => {
    const staging = path.join(
      lockRoot,
      `${key}.owner-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(
      staging,
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), root }),
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      await fs.rename(staging, owner);
    } catch (error) {
      await fs.rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  };
  while (true) {
    try {
      await fs.mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const state = await readLockOwnerState(owner);
      let stale = state === "stale";
      if (state === "unknown") {
        // Missing or unreadable owner record: only reclaim once the lock
        // directory itself is old enough that a concurrent creator cannot be
        // between mkdir and its atomic owner publish.
        try {
          const stats = await fs.stat(lock);
          stale = Date.now() - Number(stats.mtimeMs) > SOURCE_LOCK_MIN_AGE_MS;
        } catch {
          stale = false;
        }
      }
      if (!stale) throw lockBusyError();
      const quarantine = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        await fs.rename(lock, quarantine);
      } catch {
        continue;
      }
      await fs.rm(quarantine, { recursive: true, force: true });
      continue;
    }
    break;
  }
  try {
    try {
      await writeOwner();
    } catch (error) {
      await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(t("无法写入 DSH 源码操作锁：{detail}", {
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
    return await operation();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

export async function rebuildOrUpgradeDshSource(
  runtime: DshSourceRuntime,
  options: {
    upgrade: boolean;
    pnpmExecutable: string;
    runner?: typeof runProcess;
    lockRoot?: string;
  },
): Promise<DshSourceRuntime> {
  const runner = options.runner ?? runProcess;
  const root = runtime.rootDirectory;
  return withSourceLock(root, async () => {
    const run = (executable: string, args: string[], timeoutMs = 120_000) =>
      runner(executable, args, { cwd: root, env: runtime.command.env, timeoutMs });
    const status = await run("git", ["status", "--porcelain"]);
    successful(status, t("无法检查 DSH 源码工作树。"));
    if (status.stdout.trim()) throw new Error(t("DSH 源码工作树存在未提交改动，已拒绝升级或重装。"));
    const oldHeadResult = await run("git", ["rev-parse", "HEAD"]);
    successful(oldHeadResult, t("无法读取 DSH 源码提交。"));
    const oldHead = oldHeadResult.stdout.trim();
    let moved = false;
    try {
      if (options.upgrade) {
        const branch = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        successful(branch, t("DSH 源码仓库处于 detached HEAD，无法安全升级。"));
        const upstream = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        successful(upstream, t("DSH 源码分支没有配置上游，无法安全升级。"));
        successful(await run("git", ["fetch", "--quiet"]), t("DSH 源码上游更新检查失败。"));
        const ancestor = await run("git", ["merge-base", "--is-ancestor", "HEAD", "@{u}"]);
        if (ancestor.code !== 0) throw new Error(t("DSH 源码分支无法快进到上游，已拒绝自动合并。"));
        successful(await run("git", ["merge", "--ff-only", "@{u}"]), t("DSH 源码快进升级失败。"));
        const nextHead = await run("git", ["rev-parse", "HEAD"]);
        successful(nextHead, t("DSH 源码升级后提交校验失败。"));
        moved = nextHead.stdout.trim() !== oldHead;
      }
      successful(
        await run(options.pnpmExecutable, ["install", "--frozen-lockfile"], 600_000),
        t("DSH 源码依赖安装失败。"),
      );
      successful(
        await run(options.pnpmExecutable, ["run", "build"], 900_000),
        t("DSH 源码构建失败。"),
      );
      return await resolveDshSourceRuntime(root, {
        nodeExecutable: runtime.command.executable,
        environment: runtime.command.env ?? process.env,
        homeDirectory: runtime.command.homeDirectory,
        requireRuntimeOwner: runtime.command.requireRuntimeOwner,
        origin: runtime.command.origin === "custom-discovered" ? "custom-discovered" : "custom-manual",
        runner,
      });
    } catch (error) {
      if (moved) {
        // The clean-tree check ran before the upgrade; minutes of install and
        // build work followed. Re-verify before resetting so a rollback can
        // never discard edits the user made while the operation was running.
        const rollbackStatus = await run("git", ["status", "--porcelain"]);
        if (rollbackStatus.code !== 0 || rollbackStatus.stdout.trim()) {
          throw new Error(t("{failure}\n源码工作树在升级过程中出现改动，已拒绝自动回滚到 {commit}；请手动处理该工作树后重试。", {
            failure: error instanceof Error ? error.message : String(error),
            commit: oldHead,
          }));
        }
        const rollback = await run("git", ["reset", "--hard", oldHead]);
        if (rollback.code !== 0) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\n回滚到 ${oldHead} 失败：${processOutput(rollback)}`);
        }
        const restoreInstall = await run(options.pnpmExecutable, ["install", "--frozen-lockfile"], 600_000)
          .catch((restoreError: unknown) => ({
            code: 1,
            stdout: "",
            stderr: restoreError instanceof Error ? restoreError.message : String(restoreError),
            timedOut: false,
          }));
        const restoreBuild = restoreInstall.code === 0
          ? await run(options.pnpmExecutable, ["run", "build"], 900_000).catch((restoreError: unknown) => ({
              code: 1,
              stdout: "",
              stderr: restoreError instanceof Error ? restoreError.message : String(restoreError),
              timedOut: false,
            }))
          : null;
        if (restoreInstall.code !== 0 || !restoreBuild || restoreBuild.code !== 0) {
          const restoreDetail = restoreInstall.code !== 0
            ? processOutput(restoreInstall)
            : processOutput(restoreBuild!);
          throw new Error(t("{failure}\n已回滚源码提交，但恢复原构建失败：{detail}", {
            failure: error instanceof Error ? error.message : String(error),
            detail: restoreDetail || t("未知错误"),
          }));
        }
      }
      throw error;
    }
  }, options.lockRoot);
}
