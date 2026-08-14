import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { t } from "../i18n";
import {
  normalizeProcessEnvironment,
  powerShellLiteral,
  processOutput,
  runProcess,
  type ProcessOptions,
  type ProcessResult,
  windowsPowerShellEncodingLines,
} from "../process-runner";
import { findSystemExecutable } from "../universal-mcp-stdio-command";
import type { DshInstallTarget } from "./dsh-settings";
import {
  createDshInstallWorkspace,
  isDshInstallWorkspacePath,
  removeDshInstallWorkspace,
} from "./dsh-install-workspace";

export const DSH_NODE_RUNTIME_VERSION = "v24.18.1";
const NODE_DIST_BASE = `https://nodejs.org/dist/${DSH_NODE_RUNTIME_VERSION}`;
const NODE_FOLDER = `node-${DSH_NODE_RUNTIME_VERSION}`;

export const DSH_NODE_RELATIVE_PATH = "mv-aide/dsh/node";

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
  file: string;
  sha256: string;
  kind: "archive" | "pkg" | "msi";
  compression?: "gz" | "xz" | "zip";
}

const NODE_ARTIFACTS: Record<string, NodeArtifact> = {
  "darwin-arm64-vault": {
    file: `${NODE_FOLDER}-darwin-arm64.tar.gz`,
    sha256: "eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941",
    kind: "archive",
    compression: "gz",
  },
  "darwin-x64-vault": {
    file: `${NODE_FOLDER}-darwin-x64.tar.gz`,
    sha256: "6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec",
    kind: "archive",
    compression: "gz",
  },
  "darwin-arm64-global": {
    file: `${NODE_FOLDER}.pkg`,
    sha256: "c2e424f198dab39b5c68e8b06e0cdba9761dca9b5b432941fce6399d6460dabb",
    kind: "pkg",
  },
  "darwin-x64-global": {
    file: `${NODE_FOLDER}.pkg`,
    sha256: "c2e424f198dab39b5c68e8b06e0cdba9761dca9b5b432941fce6399d6460dabb",
    kind: "pkg",
  },
  "linux-arm64-vault": {
    file: `${NODE_FOLDER}-linux-arm64.tar.xz`,
    sha256: "7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c",
    kind: "archive",
    compression: "xz",
  },
  "linux-x64-vault": {
    file: `${NODE_FOLDER}-linux-x64.tar.xz`,
    sha256: "d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0",
    kind: "archive",
    compression: "xz",
  },
  "linux-arm64-global": {
    file: `${NODE_FOLDER}-linux-arm64.tar.xz`,
    sha256: "7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c",
    kind: "archive",
    compression: "xz",
  },
  "linux-x64-global": {
    file: `${NODE_FOLDER}-linux-x64.tar.xz`,
    sha256: "d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0",
    kind: "archive",
    compression: "xz",
  },
  "win32-arm64-vault": {
    file: `${NODE_FOLDER}-win-arm64.zip`,
    sha256: "ffbc7d3e1baf6804f7431ff94f19b9a885a650568c93ea4ccb1bb0038f6af825",
    kind: "archive",
    compression: "zip",
  },
  "win32-x64-vault": {
    file: `${NODE_FOLDER}-win-x64.zip`,
    sha256: "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765",
    kind: "archive",
    compression: "zip",
  },
  "win32-arm64-global": {
    file: `${NODE_FOLDER}-arm64.msi`,
    sha256: "c3897213475a089b526c8ffb5a84b0151d03eb2206d3e38aac44b2c053719b81",
    kind: "msi",
  },
  "win32-x64-global": {
    file: `${NODE_FOLDER}-x64.msi`,
    sha256: "af4a0651a26f04ac240f00fec872f305547ca2aa56301c41dfd63a29eb2ab836",
    kind: "msi",
  },
};

export interface DshNodeRuntimeInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  runner?: typeof runProcess;
  downloader?: typeof downloadAndVerify;
}

const MANAGED_NODE_ORIGINS = new Set<DshNodeOrigin>([
  "homebrew",
  "nvm",
  "fnm",
  "volta",
  "mise",
  "asdf",
]);

export function isDshNodeRuntimeTarget(version: string | undefined): boolean {
  const parse = (value: string | undefined): readonly number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value ?? "");
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const actual = parse(version);
  const target = parse(DSH_NODE_RUNTIME_VERSION);
  if (!actual || !target) return false;
  for (let index = 0; index < target.length; index += 1) {
    if (actual[index] !== target[index]) return actual[index] > target[index];
  }
  return true;
}

export function dshNodeDir(vaultRoot: string): string {
  return path.join(vaultRoot, ...DSH_NODE_RELATIVE_PATH.split("/"));
}

export function managedNodeExecutable(vaultRoot: string, platform = process.platform): string {
  return platform === "win32"
    ? path.join(dshNodeDir(vaultRoot), "node.exe")
    : path.join(dshNodeDir(vaultRoot), "bin", "node");
}

export function managedNpmExecutable(vaultRoot: string, platform = process.platform): string {
  return platform === "win32"
    ? path.join(dshNodeDir(vaultRoot), "npm.cmd")
    : path.join(dshNodeDir(vaultRoot), "bin", "npm");
}

function normalizedArch(arch: string): "arm64" | "x64" | null {
  if (arch === "arm64" || arch === "x64") return arch;
  return null;
}

export function nodeArtifactFor(
  target: DshInstallTarget,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): NodeArtifact | null {
  const supportedArch = normalizedArch(arch);
  if (!supportedArch) return null;
  return NODE_ARTIFACTS[`${platform}-${supportedArch}-${target}`] ?? null;
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
    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mv-aide-elevated-"));
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
    const powershell = findSystemExecutable("powershell.exe") ?? "powershell.exe";
    const script = [
      "$ErrorActionPreference = 'Stop'",
      ...windowsPowerShellEncodingLines(),
      "try {",
      `$p = Start-Process -FilePath ${powerShellLiteral(powershell)}`,
      `-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${powerShellLiteral(encoded)})`,
      "-Verb RunAs -Wait -PassThru",
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
  const pkexec = findSystemExecutable("pkexec") ?? "/usr/bin/pkexec";
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
  await downloadFile(`${NODE_DIST_BASE}/${artifact.file}`, destination);
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
): Promise<ProcessResult> {
  if (artifact.compression === "zip" || platform === "win32") {
    const powershell = findSystemExecutable("powershell.exe") ?? "powershell.exe";
    return runner(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${powerShellLiteral(archive)} -DestinationPath ${powerShellLiteral(staging)} -Force`,
      ],
      { timeoutMs: 300_000 },
    );
  }
  const compressionFlag = artifact.compression === "gz" ? "-xzf" : "-xJf";
  return runner("/usr/bin/tar", [compressionFlag, archive, "-C", staging], {
    timeoutMs: 300_000,
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
  runner: typeof runProcess,
  platform: NodeJS.Platform,
): Promise<ProcessResult> {
  const target = dshNodeDir(vaultRoot);
  const staging = `${target}.staging-${Date.now()}`;
  const backup = `${target}.backup-${Date.now()}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  const extracted = await extractArchive(artifact, archive, staging, runner, platform);
  if (extracted.code !== 0) {
    await fs.rm(staging, { recursive: true, force: true });
    return extracted;
  }
  const root = await firstDirectory(staging);
  if (!root) {
    await fs.rm(staging, { recursive: true, force: true });
    return { code: null, stdout: "", stderr: t("Node.js 压缩包没有有效的运行时目录。"), timedOut: false };
  }
  const hadTarget = await fs.access(target).then(() => true, () => false);
  try {
    if (hadTarget) await fs.rename(target, backup);
    await fs.rename(root, target);
    const verified = await runner(managedNodeExecutable(vaultRoot, platform), ["--version"], {
      timeoutMs: 30_000,
    });
    if (verified.code !== 0 || !processOutput(verified).includes(DSH_NODE_RUNTIME_VERSION)) {
      throw new Error(processOutput(verified) || t("Node.js 安装后校验失败。"));
    }
    await fs.rm(backup, { recursive: true, force: true });
    return verified;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    if (hadTarget) await fs.rename(backup, target).catch(() => undefined);
    return {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function installGlobalNode(
  workspaceRoot: string,
  artifact: NodeArtifact,
  archive: string,
  runner: typeof runProcess,
  platform: NodeJS.Platform,
): Promise<ProcessResult> {
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
        { timeoutMs: 900_000 },
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
      { timeoutMs: 900_000 },
      runner,
      platform,
    );
  }
  const staging = path.join(workspaceRoot, `node-global-${randomUUID()}`);
  const script = path.join(workspaceRoot, `install-node-${randomUUID()}.sh`);
  try {
    await fs.mkdir(staging, { recursive: true });
    const extracted = await extractArchive(artifact, archive, staging, runner, platform);
    if (extracted.code !== 0) return extracted;
    const root = await firstDirectory(staging);
    if (!root) return { code: null, stdout: "", stderr: t("Node.js 压缩包没有有效的运行时目录。"), timedOut: false };
    await fs.writeFile(
      script,
      `#!/bin/sh\nset -eu\ncp -a ${shellQuote(`${root}/.`)} /usr/local/\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    return runElevatedCommand("/bin/sh", [script], { timeoutMs: 900_000 }, runner, platform);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(script, { force: true });
  }
}

async function upgradeManagedNode(
  origin: DshNodeOrigin,
  runner: typeof runProcess,
): Promise<ProcessResult | null> {
  const target = DSH_NODE_RUNTIME_VERSION.slice(1);
  const command = (executable: string | null, args: string[]): Promise<ProcessResult> | null =>
    executable ? runner(executable, args, { timeoutMs: 900_000 }) : null;
  if (origin === "homebrew") {
    const brew = findSystemExecutable("brew");
    if (!brew) return null;
    const installed = await runner(brew, ["install", "node@24"], { timeoutMs: 900_000 });
    if (installed.code !== 0 && !/already installed/iu.test(processOutput(installed))) return installed;
    return runner(brew, ["link", "--overwrite", "--force", "node@24"], { timeoutMs: 300_000 });
  }
  if (origin === "fnm") return command(findSystemExecutable("fnm"), ["install", target]);
  if (origin === "volta") return command(findSystemExecutable("volta"), ["install", `node@${target}`]);
  if (origin === "mise") return command(findSystemExecutable("mise"), ["use", "--global", `node@${target}`]);
  if (origin === "asdf") {
    const asdf = findSystemExecutable("asdf");
    if (!asdf) return null;
    const installed = await runner(asdf, ["install", "nodejs", target], {
      timeoutMs: 900_000,
    });
    if (installed.code !== 0) return installed;
    return runner(asdf, ["global", "nodejs", target], { timeoutMs: 300_000 });
  }
  if (origin === "nvm") {
    const shell = process.env.SHELL || "/bin/sh";
    const script = `[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && nvm install ${shellQuote(target)} && nvm alias default ${shellQuote(target)}`;
    return runner(shell, ["-lc", script], { timeoutMs: 900_000 });
  }
  return null;
}

export async function installOrUpgradeNodeRuntime(
  vaultRoot: string,
  target: DshInstallTarget,
  existingOrigin: DshNodeOrigin | null = null,
  options: DshNodeRuntimeInstallOptions = {},
): Promise<ProcessResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runner = options.runner ?? runProcess;
  if (target === "global" && existingOrigin && MANAGED_NODE_ORIGINS.has(existingOrigin)) {
    const managed = await upgradeManagedNode(existingOrigin, runner);
    return managed ?? {
      code: null,
      stdout: "",
      stderr: t("检测到 Node.js 由版本管理器维护，但当前无法调用该管理器；为避免覆盖其目录，已停止升级。"),
      timedOut: false,
    };
  }
  const artifact = nodeArtifactFor(target, platform, arch);
  if (!artifact) {
    return {
      code: null,
      stdout: "",
      stderr: t("当前平台或架构没有受支持的 Node.js 安装包。"),
      timedOut: false,
    };
  }
  const workspace = await createDshInstallWorkspace();
  const archive = path.join(workspace.downloads, artifact.file);
  let result: ProcessResult = { code: null, stdout: "", stderr: "", timedOut: false };
  try {
    await (options.downloader ?? downloadAndVerify)(artifact, archive);
    result = await (target === "vault"
      ? installVaultNode(vaultRoot, artifact, archive, runner, platform)
      : installGlobalNode(workspace.root, artifact, archive, runner, platform));
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
