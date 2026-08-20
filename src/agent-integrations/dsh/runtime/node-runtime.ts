import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import https from "node:https";
import path from "node:path";
import { t } from "../../../i18n";
import { prependExecutableDirectory } from "../../../process-environment";
import { mvAideTempDirectory } from "../../../storage/temp-paths";
import {
  normalizeProcessEnvironment,
  powerShellLiteral,
  processOutput,
  runProcess,
  type ProcessOptions,
  type ProcessResult,
  windowsPowerShellEncodingLines,
} from "../../../process-runner";
import { findSystemExecutable } from "../../../universal-mcp-stdio-command";
import type { DshInstallTarget } from "../settings";
import { dshVaultNodeDirectory } from "../paths";
import {
  createDshInstallWorkspace,
  isDshInstallWorkspacePath,
  removeDshInstallWorkspace,
} from "./install-workspace";
import { fetchText, normalizeRuntimeVersion, type TextFetcher } from "./package-update";

export type DshNodeOrigin =
  | "vault-managed"
  | "system-standard"
  | "homebrew"
  | "nvm"
  | "fnm"
  | "volta"
  | "mise"
  | "asdf"
  | "unknown";

export interface NodeArtifact {
  version: string;
  file: string;
  sha256: string;
  kind: "archive" | "pkg" | "msi";
  compression?: "gz" | "xz" | "zip";
}

export interface DshNodeRuntimeInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  runner?: typeof runProcess;
  downloader?: typeof downloadAndVerify;
  checksumFetcher?: TextFetcher;
  environment?: NodeJS.ProcessEnv;
}

const MANAGED_NODE_ORIGINS = new Set<DshNodeOrigin>([
  "homebrew",
  "nvm",
  "fnm",
  "volta",
  "mise",
  "asdf",
]);

export function dshNodeDir(vaultRoot: string): string {
  return dshVaultNodeDirectory(vaultRoot);
}

function nodeExecutableAt(directory: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.join(directory, "node.exe")
    : path.join(directory, "bin", "node");
}

function npmExecutableAt(directory: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.join(directory, "npm.cmd")
    : path.join(directory, "bin", "npm");
}

export function managedNodeExecutable(vaultRoot: string, platform = process.platform): string {
  return nodeExecutableAt(dshNodeDir(vaultRoot), platform);
}

export function managedNpmExecutable(vaultRoot: string, platform = process.platform): string {
  return npmExecutableAt(dshNodeDir(vaultRoot), platform);
}

function normalizedArch(arch: string): "arm64" | "x64" | null {
  if (arch === "arm64" || arch === "x64") return arch;
  return null;
}

export async function fetchNodeChecksums(
  version: string,
  fetcher: TextFetcher = fetchText,
): Promise<Map<string, string>> {
  const body = await fetcher(`https://nodejs.org/dist/${version}/SHASUMS256.txt`);
  const checksums = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(line.trim());
    if (match) checksums.set(match[2], match[1].toLowerCase());
  }
  if (checksums.size === 0) {
    throw new Error(t("Node.js {version} 官方校验清单为空或格式无效。", { version }));
  }
  return checksums;
}

export function nodeArtifactFor(
  version: string,
  target: DshInstallTarget,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  checksums: ReadonlyMap<string, string> = new Map(),
): NodeArtifact | null {
  const supportedArch = normalizedArch(arch);
  if (!supportedArch) return null;
  const folder = `node-${version}`;
  let file: string;
  let kind: NodeArtifact["kind"];
  let compression: NodeArtifact["compression"];
  if (platform === "darwin") {
    if (target === "global") {
      file = `${folder}.pkg`;
      kind = "pkg";
    } else {
      file = `${folder}-darwin-${supportedArch}.tar.gz`;
      kind = "archive";
      compression = "gz";
    }
  } else if (platform === "linux") {
    file = `${folder}-linux-${supportedArch}.tar.xz`;
    kind = "archive";
    compression = "xz";
  } else if (platform === "win32") {
    if (target === "global") {
      file = `${folder}-${supportedArch}.msi`;
      kind = "msi";
    } else {
      file = `${folder}-win-${supportedArch}.zip`;
      kind = "archive";
      compression = "zip";
    }
  } else {
    return null;
  }
  const sha256 = checksums.get(file);
  if (!sha256) return null;
  return { version, file, sha256, kind, compression };
}

export function classifyNodeOrigin(
  executable: string,
  vaultRoot: string,
): DshNodeOrigin {
  const resolved = path.resolve(executable);
  const managed = path.resolve(dshNodeDir(vaultRoot));
  if (resolved === managed || resolved.startsWith(`${managed}${path.sep}`)) return "vault-managed";
  const portable = resolved.replace(/\\/gu, "/").toLowerCase();
  if (portable.includes("/.nvm/versions/node/")) return "nvm";
  if (portable.includes("/.fnm/") || portable.includes("/fnm_multishells/")) return "fnm";
  if (portable.includes("/.volta/")) return "volta";
  if (portable.includes("/.local/share/mise/") || portable.includes("/.mise/")) return "mise";
  if (portable.includes("/.asdf/")) return "asdf";
  if (portable.includes("/homebrew/") || portable.includes("/cellar/node")) return "homebrew";
  if (
    portable === "/usr/local/bin/node"
    || portable.includes("/program files/nodejs/node.exe")
    || portable === "/usr/bin/node"
    || portable === "/usr/local/bin/node"
  ) return "system-standard";
  return "unknown";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export async function runElevatedCommand(
  executable: string,
  args: string[],
  options: ProcessOptions & { cleanupPaths?: readonly string[] } = {},
  runner: typeof runProcess = runProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessResult> {
  const cleanupPaths = (options.cleanupPaths ?? []).map((candidate) => {
    if (!isDshInstallWorkspacePath(candidate)) {
      throw new Error(`Unsafe elevated cleanup path: ${candidate}`);
    }
    return path.resolve(candidate);
  });
  if (platform === "darwin") {
    const env = Object.entries(options.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const cwd = options.cwd ? `cd ${shellQuote(options.cwd)} && ` : "";
    const invocation = `${cwd}${env ? `env ${env} ` : ""}${shellQuote(executable)} ${args.map(shellQuote).join(" ")}`;
    const cleanup = cleanupPaths.map((target) => `/bin/rm -rf -- ${shellQuote(target)}`).join("; ");
    const command = cleanup
      ? `set +e; ${invocation}; status=$?; ${cleanup}; exit $status`
      : invocation;
    return runner(
      "/usr/bin/osascript",
      ["-e", `do shell script ${appleScriptQuote(command)} with administrator privileges`],
      { timeoutMs: options.timeoutMs ?? 600_000 },
    );
  }
  if (platform === "win32") {
    const elevatedRoot = mvAideTempDirectory("dsh/elevated");
    await fs.mkdir(elevatedRoot, { recursive: true, mode: 0o700 });
    const outputDirectory = await fs.mkdtemp(path.join(elevatedRoot, "operation-"));
    await fs.chmod(outputDirectory, 0o700).catch(() => undefined);
    const outputPath = path.join(outputDirectory, "output.log");
    const normalizedEnvironment = normalizeProcessEnvironment(options.env, "win32") ?? {};
    const environment = Object.entries(normalizedEnvironment)
      .filter((entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry[0]) && typeof entry[1] === "string")
      .map(([key, value]) => `$env:${key} = ${powerShellLiteral(value)}`);
    const cleanup = cleanupPaths.map(
      (target) => `Remove-Item -LiteralPath ${powerShellLiteral(target)} -Recurse -Force -ErrorAction SilentlyContinue`,
    );
    const command = [powerShellLiteral(executable), ...args.map(powerShellLiteral)].join(" ");
    const innerScript = [
      "$ErrorActionPreference = 'Stop'",
      ...windowsPowerShellEncodingLines(),
      ...environment,
      ...(options.cwd ? [`Set-Location -LiteralPath ${powerShellLiteral(options.cwd)}`] : []),
      "$mvAideExitCode = 1",
      "$mvAideCapturedOutput = ''",
      "try {",
      "$global:LASTEXITCODE = 0",
      `$mvAideCapturedOutput = (& ${command} 2>&1 | Out-String)`,
      "$mvAideExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }",
      "} catch { $mvAideCapturedOutput = ($_ | Out-String); $mvAideExitCode = 1 } finally {",
      `[IO.File]::WriteAllText(${powerShellLiteral(outputPath)}, [string]$mvAideCapturedOutput, [Text.Encoding]::UTF8)`,
      ...cleanup,
      "}",
      "exit $mvAideExitCode",
    ].join("; ");
    const encoded = Buffer.from(innerScript, "utf16le").toString("base64");
    const powershell = findSystemExecutable("powershell.exe", "win32", normalizedEnvironment) ?? "powershell.exe";
    const script = [
      "$ErrorActionPreference = 'Stop'",
      ...windowsPowerShellEncodingLines(),
      "try {",
      [
        `$p = Start-Process -FilePath ${powerShellLiteral(powershell)}`,
        `-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${powerShellLiteral(encoded)})`,
        "-Verb RunAs -Wait -PassThru -WindowStyle Hidden",
      ].join(" "),
      "$mvAideExitCode = $p.ExitCode",
      `if (Test-Path -LiteralPath ${powerShellLiteral(outputPath)}) { $mvAideOutput = [IO.File]::ReadAllText(${powerShellLiteral(outputPath)}, [Text.Encoding]::UTF8); if ($mvAideExitCode -eq 0) { [Console]::Out.Write($mvAideOutput) } else { [Console]::Error.Write($mvAideOutput) } }`,
      "} catch {",
      "[Console]::Error.WriteLine($_.Exception.Message)",
      "$mvAideExitCode = 1",
      "} finally {",
      `Remove-Item -LiteralPath ${powerShellLiteral(outputDirectory)} -Recurse -Force -ErrorAction SilentlyContinue`,
      "}",
      "exit $mvAideExitCode",
    ].join("; ");
    try {
      return await runner(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeoutMs: options.timeoutMs ?? 600_000 },
      );
    } finally {
      await fs.rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const pkexec = findSystemExecutable("pkexec", platform, options.env ?? process.env) ?? "/usr/bin/pkexec";
  const envArgs = Object.entries(options.env ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${value}`);
  if (cleanupPaths.length === 0) {
    return runner(
      pkexec,
      ["/usr/bin/env", ...envArgs, executable, ...args],
      { timeoutMs: options.timeoutMs ?? 600_000 },
    );
  }
  const cwd = options.cwd ? `cd ${shellQuote(options.cwd)} && ` : "";
  const env = envArgs.length > 0 ? `/usr/bin/env ${envArgs.map(shellQuote).join(" ")} ` : "";
  const invocation = `${cwd}${env}${shellQuote(executable)} ${args.map(shellQuote).join(" ")}`;
  const cleanup = cleanupPaths.map((target) => `/bin/rm -rf -- ${shellQuote(target)}`).join("; ");
  const command = `set +e; ${invocation}; status=$?; ${cleanup}; exit $status`;
  return runner(pkexec, ["/bin/sh", "-c", command], {
    timeoutMs: options.timeoutMs ?? 600_000,
  });
}

function downloadFile(url: string, destination: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const location = response.headers.location;
      if (location && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        if (redirects <= 0) {
          reject(new Error("Too many redirects while downloading Node.js."));
          return;
        }
        const redirected = new URL(location, url).toString();
        downloadFile(redirected, destination, redirects - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Node.js download failed with HTTP ${response.statusCode ?? "unknown"}.`));
        return;
      }
      const output = createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      output.once("finish", () => output.close(() => resolve()));
      output.once("error", reject);
      response.once("error", reject);
    });
    request.setTimeout(120_000, () => request.destroy(new Error("Node.js download timed out.")));
    request.once("error", reject);
  });
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function downloadAndVerify(
  artifact: NodeArtifact,
  destination: string,
): Promise<void> {
  await downloadFile(`https://nodejs.org/dist/${artifact.version}/${artifact.file}`, destination);
  const actual = await sha256(destination);
  if (actual !== artifact.sha256) {
    throw new Error(t("Node.js 下载校验失败；文件已丢弃。"));
  }
}

async function extractArchive(
  artifact: NodeArtifact,
  archive: string,
  staging: string,
  runner: typeof runProcess,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  if (artifact.compression === "zip" || platform === "win32") {
    const powershell = findSystemExecutable("powershell.exe", platform, environment) ?? "powershell.exe";
    return runner(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${powerShellLiteral(archive)} -DestinationPath ${powerShellLiteral(staging)} -Force`,
      ],
      { timeoutMs: 300_000, env: environment },
    );
  }
  const compressionFlag = artifact.compression === "gz" ? "-xzf" : "-xJf";
  return runner("/usr/bin/tar", [compressionFlag, archive, "-C", staging], {
    timeoutMs: 300_000,
    env: environment,
  });
}

async function firstDirectory(directory: string): Promise<string | null> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const entry = entries.find((candidate) => candidate.isDirectory());
  return entry ? path.join(directory, entry.name) : null;
}

async function installVaultNode(
  vaultRoot: string,
  artifact: NodeArtifact,
  archive: string,
  workspaceRoot: string,
  runner: typeof runProcess,
  platform: NodeJS.Platform,
  targetVersion: string,
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  const target = dshNodeDir(vaultRoot);

  // Extract and preflight the runtime inside the 0700 tmp install workspace
  // (规范三). Only the validated runtime is copied into the vault for the
  // final same-directory atomic swap below.
  const tmpStaging = path.join(workspaceRoot, "vault-node-staging");
  await fs.rm(tmpStaging, { recursive: true, force: true });
  await fs.mkdir(tmpStaging, { recursive: true });
  const extracted = await extractArchive(artifact, archive, tmpStaging, runner, platform, environment);
  if (extracted.code !== 0) {
    await fs.rm(tmpStaging, { recursive: true, force: true });
    return extracted;
  }
  const extractedRoot = await firstDirectory(tmpStaging);
  if (!extractedRoot) {
    await fs.rm(tmpStaging, { recursive: true, force: true });
    return { code: null, stdout: "", stderr: t("Node.js 压缩包没有有效的运行时目录。"), timedOut: false };
  }
  const preflight = await runner(nodeExecutableAt(extractedRoot, platform), ["--version"], {
    timeoutMs: 30_000,
    env: environment,
  });
  if (
    preflight.code !== 0
    || normalizeRuntimeVersion(processOutput(preflight).split(/\r?\n/u)[0] ?? "")
      !== normalizeRuntimeVersion(targetVersion)
  ) {
    await fs.rm(tmpStaging, { recursive: true, force: true });
    return {
      code: null,
      stdout: "",
      stderr: processOutput(preflight) || t("Node.js 安装后校验失败。"),
      timedOut: false,
    };
  }

  const staging = `${target}.staging-${Date.now()}`;
  const backup = `${target}.backup-${Date.now()}`;
  const stagedRoot = path.join(staging, path.basename(extractedRoot));
  let hadTarget = false;
  let targetMoved = false;
  try {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    await fs.cp(extractedRoot, stagedRoot, { recursive: true });
    hadTarget = await fs.access(target).then(() => true, () => false);
    if (hadTarget) {
      await fs.rename(target, backup);
      targetMoved = true;
    }
    await fs.rename(stagedRoot, target);
    const verified = await runner(managedNodeExecutable(vaultRoot, platform), ["--version"], {
      timeoutMs: 30_000,
      env: environment,
    });
    if (
      verified.code !== 0
      || normalizeRuntimeVersion(processOutput(verified).split(/\r?\n/u)[0] ?? "")
        !== normalizeRuntimeVersion(targetVersion)
    ) {
      throw new Error(processOutput(verified) || t("Node.js 安装后校验失败。"));
    }
    await fs.rm(backup, { recursive: true, force: true });
    return verified;
  } catch (error) {
    if (targetMoved) {
      await fs.rm(target, { recursive: true, force: true });
      if (hadTarget) await fs.rename(backup, target).catch(() => undefined);
    }
    return {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(tmpStaging, { recursive: true, force: true });
  }
}

async function installGlobalNode(
  workspaceRoot: string,
  artifact: NodeArtifact,
  archive: string,
  runner: typeof runProcess,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  const privilegedEnvironment: NodeJS.ProcessEnv = { PATH: environment.PATH };
  if (artifact.kind === "pkg") {
    // macOS Installer delegates package parsing to a system service that
    // cannot traverse a vault-owned 0700 directory. Stage only the already
    // verified public package in /private/tmp, then remove it unconditionally.
    const stagedPackage = path.join(
      "/private/tmp",
      `mv-aide-node-${randomUUID()}.pkg`,
    );
    try {
      await fs.copyFile(archive, stagedPackage);
      await fs.chmod(stagedPackage, 0o644);
      return await runElevatedCommand(
        "/usr/sbin/installer",
        ["-pkg", stagedPackage, "-target", "/"],
        { timeoutMs: 900_000, env: privilegedEnvironment },
        runner,
        platform,
      );
    } finally {
      await fs.rm(stagedPackage, { force: true });
    }
  }
  if (artifact.kind === "msi") {
    return runElevatedCommand(
      "msiexec.exe",
      ["/i", archive, "/passive", "/norestart"],
      { timeoutMs: 900_000, env: privilegedEnvironment },
      runner,
      platform,
    );
  }
  const staging = path.join(workspaceRoot, `node-global-${randomUUID()}`);
  const script = path.join(workspaceRoot, `install-node-${randomUUID()}.sh`);
  try {
    await fs.mkdir(staging, { recursive: true });
    const extracted = await extractArchive(artifact, archive, staging, runner, platform, environment);
    if (extracted.code !== 0) return extracted;
    const root = await firstDirectory(staging);
    if (!root) return { code: null, stdout: "", stderr: t("Node.js 压缩包没有有效的运行时目录。"), timedOut: false };
    await fs.writeFile(
      script,
      `#!/bin/sh\nset -eu\ncp -a ${shellQuote(`${root}/.`)} /usr/local/\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    return runElevatedCommand("/bin/sh", [script], { timeoutMs: 900_000, env: privilegedEnvironment }, runner, platform);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(script, { force: true });
  }
}

async function upgradeManagedNode(
  origin: DshNodeOrigin,
  targetVersion: string,
  runner: typeof runProcess,
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult | null> {
  const target = normalizeRuntimeVersion(targetVersion);
  const command = (executable: string | null, args: string[]): Promise<ProcessResult> | null =>
    executable ? runner(executable, args, { timeoutMs: 900_000, env: environment }) : null;
  if (origin === "homebrew") {
    const brew = findSystemExecutable("brew", process.platform, environment);
    if (!brew) return null;
    const brewEnvironment = prependExecutableDirectory(environment, brew);
    const updated = await runner(brew, ["update"], { timeoutMs: 900_000, env: brewEnvironment });
    if (updated.code !== 0) return updated;
    const upgraded = await runner(brew, ["upgrade", "node"], { timeoutMs: 900_000, env: brewEnvironment });
    if (upgraded.code === 0 || /already (?:up-to-date|installed)|up to date/iu.test(processOutput(upgraded))) {
      return upgraded;
    }
    if (/not installed|no available formula/iu.test(processOutput(upgraded))) {
      return runner(brew, ["install", "node"], { timeoutMs: 900_000, env: brewEnvironment });
    }
    return upgraded;
  }
  if (origin === "fnm") return command(findSystemExecutable("fnm", process.platform, environment), ["install", target]);
  if (origin === "volta") return command(findSystemExecutable("volta", process.platform, environment), ["install", `node@${target}`]);
  if (origin === "mise") return command(findSystemExecutable("mise", process.platform, environment), ["use", "--global", `node@${target}`]);
  if (origin === "asdf") {
    const asdf = findSystemExecutable("asdf", process.platform, environment);
    if (!asdf) return null;
    const asdfEnvironment = prependExecutableDirectory(environment, asdf);
    const installed = await runner(asdf, ["install", "nodejs", target], {
      timeoutMs: 900_000,
      env: asdfEnvironment,
    });
    if (installed.code !== 0) return installed;
    return runner(asdf, ["global", "nodejs", target], { timeoutMs: 300_000, env: asdfEnvironment });
  }
  if (origin === "nvm") {
    const shell = environment.SHELL || process.env.SHELL || "/bin/sh";
    const script = `[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && nvm install ${shellQuote(target)} && nvm alias default ${shellQuote(target)}`;
    return runner(shell, ["-lc", script], { timeoutMs: 900_000, env: environment });
  }
  return null;
}

export async function installOrUpgradeNodeRuntime(
  vaultRoot: string,
  target: DshInstallTarget,
  targetVersion: string,
  existingOrigin: DshNodeOrigin | null = null,
  options: DshNodeRuntimeInstallOptions = {},
): Promise<ProcessResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runner = options.runner ?? runProcess;
  const environment = options.environment ?? process.env;
  if (target === "global" && existingOrigin && MANAGED_NODE_ORIGINS.has(existingOrigin)) {
    const managed = await upgradeManagedNode(existingOrigin, targetVersion, runner, environment);
    return managed ?? {
      code: null,
      stdout: "",
      stderr: t("检测到 Node.js 由版本管理器维护，但当前无法调用该管理器；为避免覆盖其目录，已停止升级。"),
      timedOut: false,
    };
  }
  let artifact: NodeArtifact | null = null;
  try {
    const checksums = await fetchNodeChecksums(targetVersion, options.checksumFetcher ?? fetchText);
    artifact = nodeArtifactFor(targetVersion, target, platform, arch, checksums);
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
  if (!artifact) {
    return {
      code: null,
      stdout: "",
      stderr: t("当前平台或架构没有受支持的 Node.js 安装包，或官方校验清单中缺少该安装包。"),
      timedOut: false,
    };
  }
  const workspace = await createDshInstallWorkspace();
  const archive = path.join(workspace.downloads, artifact.file);
  let result: ProcessResult = { code: null, stdout: "", stderr: "", timedOut: false };
  try {
    await (options.downloader ?? downloadAndVerify)(artifact, archive);
    result = await (target === "vault"
      ? installVaultNode(vaultRoot, artifact, archive, workspace.root, runner, platform, targetVersion, environment)
      : installGlobalNode(workspace.root, artifact, archive, runner, platform, environment));
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
      const detail = `DSH install workspace cleanup failed: ${cleanupFailure.path}: ${cleanupFailure.error}`;
      result = {
        code: null,
        stdout: result.stdout,
        stderr: `${result.stderr ? `${result.stderr}\n` : ""}${detail}`,
        timedOut: result.timedOut,
      };
    }
  }
  return result;
}
