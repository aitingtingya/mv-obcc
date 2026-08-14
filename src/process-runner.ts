import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import path from "node:path";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failureKind?: "launch" | "timeout";
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface SpawnProcessOptions extends Pick<ProcessOptions, "cwd" | "env"> {
  stdio?: StdioOptions;
  windowsHide?: boolean;
}

export interface PreparedProcessInvocation {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  wrappedWindowsCommand: boolean;
}

function assertPowerShellValue(value: string): void {
  if (value.includes("\0")) throw new Error("Process values cannot contain NUL bytes.");
}

/** Encode one value as a PowerShell single-quoted literal. */
export function powerShellLiteral(value: string): string {
  assertPowerShellValue(value);
  return `'${value.replace(/'/gu, "''")}'`;
}

export function windowsPowerShellEncodingLines(): string[] {
  return [
    "$mvAideUtf8 = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $mvAideUtf8",
    "[Console]::OutputEncoding = $mvAideUtf8",
    "$OutputEncoding = $mvAideUtf8",
  ];
}

/** Build the script used to execute a Windows command shim without a raw shell string. */
export function buildWindowsCommandScript(executable: string, args: readonly string[]): string {
  const invocation = [powerShellLiteral(executable), ...args.map(powerShellLiteral)].join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    ...windowsPowerShellEncodingLines(),
    "$global:LASTEXITCODE = 0",
    "try {",
    `& ${invocation}`,
    "$mvAideExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }",
    "} catch {",
    "[Console]::Error.WriteLine($_.Exception.Message)",
    "$mvAideExitCode = 1",
    "}",
    "exit $mvAideExitCode",
  ].join("\n");
}

/** Windows treats environment names case-insensitively; keep the final value only. */
export function normalizeProcessEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv | undefined {
  if (platform !== "win32" || !environment) return environment;
  const normalized: NodeJS.ProcessEnv = {};
  const keys = new Map<string, string>();
  for (const [key, value] of Object.entries(environment)) {
    const folded = key.toLocaleLowerCase("en-US");
    const previous = keys.get(folded);
    if (previous) delete normalized[previous];
    keys.set(folded, key);
    normalized[key] = value;
  }
  return normalized;
}

function windowsPowerShellExecutable(environment: NodeJS.ProcessEnv): string {
  const systemRoot = Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase("en-US") === "systemroot",
  )?.[1];
  return systemRoot
    ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/** Convert a structured command into a platform-safe child-process invocation. */
export function prepareProcessInvocation(
  executable: string,
  args: readonly string[],
  options: Pick<ProcessOptions, "env"> = {},
  platform: NodeJS.Platform = process.platform,
): PreparedProcessInvocation {
  assertPowerShellValue(executable);
  for (const arg of args) assertPowerShellValue(arg);
  const sourceEnvironment = options.env ?? (platform === "win32" ? process.env : undefined);
  const env = normalizeProcessEnvironment(sourceEnvironment, platform);
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(executable)) {
    return { executable, args: [...args], env, wrappedWindowsCommand: false };
  }
  const script = buildWindowsCommandScript(executable, args);
  return {
    executable: windowsPowerShellExecutable(env ?? process.env),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    env,
    wrappedWindowsCommand: true,
  };
}

/** Spawn a structured command; Windows command shims use the same safe adapter as runProcess. */
export function spawnProcess(
  executable: string,
  args: readonly string[],
  options: SpawnProcessOptions = {},
): ChildProcess {
  const invocation = prepareProcessInvocation(executable, args, options);
  return spawn(invocation.executable, invocation.args, {
    cwd: options.cwd,
    env: invocation.env,
    windowsHide: options.windowsHide ?? true,
    shell: false,
    stdio: options.stdio,
  });
}

/**
 * Run an external process without blocking Electron's renderer thread.
 * All settings actions and runtime probes must use this helper rather than
 * child_process synchronous APIs.
 */
export function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        failureKind: "launch",
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const finish = (
      code: number | null,
      failureKind?: ProcessResult["failureKind"],
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ code, stdout, stderr, timedOut, failureKind });
    };

    child.once("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
      finish(null, "launch");
    });
    child.once("close", (code) => finish(code, timedOut ? "timeout" : undefined));

    const timeoutMs = options.timeoutMs ?? 120_000;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stderr += `${stderr ? "\n" : ""}Process timed out after ${timeoutMs}ms.`;
        try {
          if (process.platform === "win32" && child.pid) {
            const killer = spawn(
              "taskkill",
              ["/pid", String(child.pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore" },
            );
            killer.once("close", () => finish(null, "timeout"));
            killer.once("error", () => finish(null, "timeout"));
          } else {
            child.kill("SIGTERM");
          }
          forceTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already exited */
            }
            finish(null, "timeout");
          }, 2_000);
        } catch {
          finish(null, "timeout");
        }
      }, timeoutMs);
    }
  });
}

export function processOutput(result: ProcessResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}
