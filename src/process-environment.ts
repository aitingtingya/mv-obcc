import fs from "node:fs";
import path from "node:path";
import { runProcess, windowsPowerShellEncodingLines, type ProcessResult } from "./process-runner";

const PATH_MARKER = "__MV_AIDE_PATH__";

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const folded = name.toLocaleLowerCase("en-US");
  return Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase("en-US") === folded,
  )?.[1];
}

function splitPathValue(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return [];
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return value.split(pathApi.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function dedupePathEntries(entries: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const normalized = platform === "win32"
      ? path.win32.normalize(entry).toLocaleLowerCase("en-US")
      : path.posix.normalize(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(entry);
  }
  return result;
}

export function mergeCommandPath(
  platform: NodeJS.Platform,
  ...values: Array<string | undefined>
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return dedupePathEntries(values.flatMap((value) => splitPathValue(value, platform)), platform)
    .join(pathApi.delimiter);
}

export function prependExecutableDirectory(
  environment: NodeJS.ProcessEnv,
  executable: string | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!executable) return { ...environment };
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const currentPath = environmentValue(environment, "PATH", platform);
  return {
    ...environment,
    PATH: mergeCommandPath(platform, pathApi.dirname(executable), currentPath),
  };
}

function markedOutputLines(output: string): string[] | null {
  const lines = output.split(/\r?\n/u);
  const markerIndex = lines.lastIndexOf(PATH_MARKER);
  return markerIndex >= 0 ? lines.slice(markerIndex + 1) : null;
}

function unixEnvironmentPath(output: string): string | null {
  const line = output.split(/\r?\n/u).reverse().find((entry) => entry.startsWith("PATH="));
  return line?.slice("PATH=".length).trim() || null;
}

function unixDefaultShell(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/bin/zsh";
  if (fs.existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

async function resolveUnixLoginPath(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  runner: typeof runProcess,
): Promise<string | null> {
  const shell = environment.SHELL || unixDefaultShell(platform);
  const result = await runner(
    shell,
    ["-lic", "/usr/bin/env"],
    { timeoutMs: 15_000, env: environment },
  );
  return result.code === 0 ? unixEnvironmentPath(result.stdout) : null;
}

function windowsPowerShell(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environmentValue(environment, "SystemRoot", "win32") || "C:\\Windows";
  const candidate = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

async function resolveWindowsRegisteredPath(
  environment: NodeJS.ProcessEnv,
  runner: typeof runProcess,
): Promise<string | null> {
  const script = [
    // UTF-8 output first: registry PATH values can contain non-ASCII user
    // directories, and the runner decodes child stdout as UTF-8 while WinPS
    // defaults to the OEM codepage. Under the default Continue preference a
    // failed encoding switch is non-fatal.
    ...windowsPowerShellEncodingLines(),
    "$machine = [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine'))",
    "$user = [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'User'))",
    `[Console]::Out.WriteLine('${PATH_MARKER}')`,
    "[Console]::Out.WriteLine([string]$machine)",
    "[Console]::Out.WriteLine([string]$user)",
  ].join("; ");
  const result = await runner(
    windowsPowerShell(environment),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 15_000, env: environment },
  );
  if (result.code !== 0) return null;
  const lines = markedOutputLines(result.stdout);
  return lines ? mergeCommandPath("win32", lines[0], lines[1]) : null;
}

function standardFallbackPath(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") {
    const systemRoot = environmentValue(environment, "SystemRoot", "win32") || "C:\\Windows";
    return [
      path.win32.join(systemRoot, "System32"),
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.win32.delimiter);
  }
  if (platform === "darwin") {
    return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin";
}

/**
 * Resolve the command environment a user expects from an interactive terminal.
 *
 * macOS/Linux read the login-shell PATH because GUI applications commonly
 * inherit a smaller PATH. Windows merges the process PATH with current User and
 * Machine PATH values so newly installed user tools are discoverable without a
 * plugin-specific hardcoded install directory.
 *
 * The read is a subprocess (PowerShell on Windows), so the result is memoized
 * per (platform, base environment) for the session. A failed discovery is
 * never pinned — the next call retries. Flows that can rewrite the
 * user-visible PATH (Node.js installers write the registry on Windows) call
 * {@link invalidateUserCommandEnvironmentCache} before re-resolving, and the
 * settings "检测" action does the same for manual re-checks.
 */
let userCommandEnvironmentCache: {
  platform: NodeJS.Platform;
  base: NodeJS.ProcessEnv;
  promise: Promise<NodeJS.ProcessEnv>;
} | null = null;

/** Drop the memoized command environment so the next resolve re-reads the OS. */
export function invalidateUserCommandEnvironmentCache(): void {
  userCommandEnvironmentCache = null;
}

async function discoverUserCommandPath(
  platform: NodeJS.Platform,
  baseEnvironment: NodeJS.ProcessEnv,
  runner: typeof runProcess,
): Promise<string | null> {
  try {
    return platform === "win32"
      ? await resolveWindowsRegisteredPath(baseEnvironment, runner)
      : await resolveUnixLoginPath(platform, baseEnvironment, runner);
  } catch {
    return null;
  }
}

function withCommandPath(
  platform: NodeJS.Platform,
  baseEnvironment: NodeJS.ProcessEnv,
  discoveredPath: string | null,
): NodeJS.ProcessEnv {
  const basePath = environmentValue(baseEnvironment, "PATH", platform);
  const PATH = platform === "win32"
    ? mergeCommandPath(platform, basePath, discoveredPath ?? undefined, standardFallbackPath(platform, baseEnvironment))
    : mergeCommandPath(platform, discoveredPath ?? undefined, basePath, standardFallbackPath(platform, baseEnvironment));
  return { ...baseEnvironment, PATH };
}

export function resolveUserCommandEnvironment(
  platform: NodeJS.Platform = process.platform,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  runner: typeof runProcess = runProcess,
): Promise<NodeJS.ProcessEnv> {
  const cached = userCommandEnvironmentCache;
  if (cached && cached.platform === platform && cached.base === baseEnvironment) {
    return cached.promise;
  }
  const promise = discoverUserCommandPath(platform, baseEnvironment, runner)
    .then((discoveredPath) => {
      if (discoveredPath === null && userCommandEnvironmentCache?.promise === promise) {
        userCommandEnvironmentCache = null;
      }
      return withCommandPath(platform, baseEnvironment, discoveredPath);
    });
  userCommandEnvironmentCache = { platform, base: baseEnvironment, promise };
  return promise;
}

export type ProcessRunner = (
  executable: string,
  args: string[],
  options?: Parameters<typeof runProcess>[2],
) => Promise<ProcessResult>;
