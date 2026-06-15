import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MCP_SERVER_NAME } from "./constants";

const execFileAsync = promisify(execFile);

interface ExecOptions {
  encoding: "utf8";
  timeout: number;
  windowsHide: boolean;
  shell: false;
  cwd?: string;
  windowsVerbatimArguments?: boolean;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFileRunner = (
  executable: string,
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export interface ClaudeCommandRuntime {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  existsSync: (filePath: string) => boolean;
  execFile: ExecFileRunner;
}

export interface ClaudeCommandInvocation {
  executable: string;
  args: string[];
  displayCommand: string;
}

export interface McpRegistrationResult {
  ok: boolean;
  message: string;
  executable?: string;
}

const DEFAULT_RUNTIME: ClaudeCommandRuntime = {
  platform: process.platform,
  env: process.env,
  homeDirectory: os.homedir(),
  existsSync: fs.existsSync,
  execFile: async (executable, args, options) => {
    const result = await execFileAsync(executable, args, options);
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

function platformPath(platform: NodeJS.Platform): typeof path {
  return platform === "win32" ? (path.win32 as typeof path) : path;
}

function executableCandidates(
  configured: string,
  runtime: ClaudeCommandRuntime,
): string[] {
  const pathApi = platformPath(runtime.platform);
  const candidates = [
    configured.trim(),
    runtime.env.CLAUDE_CODE_EXECUTABLE ?? "",
    runtime.platform === "darwin" ? "/usr/local/bin/claude" : "",
    runtime.platform === "darwin" ? "/opt/homebrew/bin/claude" : "",
    pathApi.join(runtime.homeDirectory, ".local", "bin", "claude"),
    runtime.platform === "win32" && runtime.env.APPDATA
      ? pathApi.join(runtime.env.APPDATA, "npm", "claude.cmd")
      : "",
    runtime.platform === "win32" && runtime.env.LOCALAPPDATA
      ? pathApi.join(
          runtime.env.LOCALAPPDATA,
          "Programs",
          "claude",
          "claude.exe",
        )
      : "",
    "claude",
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function quoteWindowsCmdArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Claude CLI 参数包含不支持的控制字符。");
  }
  // cmd.exe expands percent variables even inside quotes. Doubling percent
  // preserves the literal value; quotes are escaped with a caret.
  return `"${value.replace(/%/g, "%%").replace(/"/g, '^"')}"`;
}

export function buildClaudeCommandInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCommandInvocation {
  if (platform !== "win32" || /\.exe$/i.test(executable)) {
    return {
      executable,
      args: [...args],
      displayCommand: [executable, ...args].join(" "),
    };
  }

  const commandLine = [
    quoteWindowsCmdArgument(executable),
    ...args.map(quoteWindowsCmdArgument),
  ].join(" ");
  return {
    executable: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    displayCommand: `cmd.exe /d /s /c "${commandLine}"`,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function isExpectedMcpRegistration(
  output: string,
  url: string,
  authToken: string,
): boolean {
  const normalized = stripAnsi(output).replace(/\r\n/g, "\n");
  return (
    normalized.includes(url) &&
    normalized.includes(`Authorization: Bearer ${authToken}`) &&
    /Status:\s*(?:[^\w\r\n]*\s*)?Connected\b/i.test(normalized)
  );
}

function registrationMatches(
  output: string,
  url: string,
  authToken: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") {
    return isExpectedMcpRegistration(output, url, authToken);
  }
  // Preserve the pre-0.2.3 macOS/Linux registration check exactly.
  return (
    output.includes(url) &&
    output.includes(authToken) &&
    output.includes("Connected")
  );
}

function redactSensitive(value: string): string {
  return value.replace(
    /(Authorization:\s*Bearer\s+)[^\s"']+/gi,
    "$1<redacted>",
  );
}

function executionError(
  error: unknown,
  invocation: ClaudeCommandInvocation,
): string {
  const details: string[] = [
    `Command failed: ${redactSensitive(invocation.displayCommand)}`,
  ];
  if (error instanceof Error && error.message) details.push(error.message);
  if (error && typeof error === "object") {
    const value = error as { stdout?: unknown; stderr?: unknown };
    if (typeof value.stdout === "string" && value.stdout.trim()) {
      details.push(`stdout: ${value.stdout.trim()}`);
    }
    if (typeof value.stderr === "string" && value.stderr.trim()) {
      details.push(`stderr: ${value.stderr.trim()}`);
    }
  }
  return redactSensitive(details.join("\n"));
}

async function runClaude(
  configured: string,
  args: string[],
  workingDirectory: string | undefined,
  runtime: ClaudeCommandRuntime,
): Promise<{ executable: string; stdout: string; stderr: string }> {
  const errors: string[] = [];
  const pathApi = platformPath(runtime.platform);
  for (const executable of executableCandidates(configured, runtime)) {
    if (pathApi.isAbsolute(executable) && !runtime.existsSync(executable)) continue;
    const invocation = buildClaudeCommandInvocation(
      executable,
      args,
      runtime.platform,
      runtime.env,
    );
    try {
      const usesWindowsCommandProcessor =
        runtime.platform === "win32" && !/\.exe$/i.test(executable);
      const result = await runtime.execFile(
        invocation.executable,
        invocation.args,
        {
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
          shell: false,
          cwd: workingDirectory,
          ...(usesWindowsCommandProcessor
            ? { windowsVerbatimArguments: true }
            : {}),
        },
      );
      return {
        executable,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      errors.push(executionError(error, invocation));
    }
  }
  throw new Error(
    errors.length > 0
      ? errors.join("\n\n")
      : "找不到 Claude Code 可执行文件。",
  );
}

function verificationFailure(
  verification: { stdout: string; stderr: string },
  url: string,
): McpRegistrationResult {
  const output = [verification.stdout.trim(), verification.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  return {
    ok: false,
    message: [
      "MCP 注册命令已执行，但复验失败。",
      `预期 URL: ${url}`,
      output ? `claude mcp get 输出:\n${redactSensitive(output)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export async function ensureMcpRegistration(
  configuredExecutable: string,
  url: string,
  authToken: string,
  vaultRoot: string,
  runtime: ClaudeCommandRuntime = DEFAULT_RUNTIME,
): Promise<McpRegistrationResult> {
  try {
    const current = await runClaude(
      configuredExecutable,
      ["mcp", "get", MCP_SERVER_NAME],
      vaultRoot,
      runtime,
    ).catch(() => null);
    if (
      current &&
      registrationMatches(
        current.stdout,
        url,
        authToken,
        runtime.platform,
      )
    ) {
      return {
        ok: true,
        message: "MCP 已连接",
        executable: current.executable,
      };
    }

    await runClaude(
      configuredExecutable,
      ["mcp", "remove", "--scope", "local", MCP_SERVER_NAME],
      vaultRoot,
      runtime,
    ).catch(() => undefined);
    const added = await runClaude(
      configuredExecutable,
      [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "local",
        MCP_SERVER_NAME,
        url,
        "--header",
        `Authorization: Bearer ${authToken}`,
      ],
      vaultRoot,
      runtime,
    );
    if (runtime.platform !== "win32") {
      return {
        ok: true,
        message: "MCP 已注册；重新启动 Claude Code 后生效",
        executable: added.executable,
      };
    }
    const verification = await runClaude(
      added.executable,
      ["mcp", "get", MCP_SERVER_NAME],
      vaultRoot,
      runtime,
    );
    if (!isExpectedMcpRegistration(verification.stdout, url, authToken)) {
      return verificationFailure(verification, url);
    }
    return {
      ok: true,
      message: "MCP 已注册并验证；重新启动 Claude Code 后生效",
      executable: verification.executable,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function removeMcpRegistration(
  configuredExecutable: string,
  vaultRoot: string,
  runtime: ClaudeCommandRuntime = DEFAULT_RUNTIME,
): Promise<McpRegistrationResult> {
  try {
    const result = await runClaude(
      configuredExecutable,
      ["mcp", "remove", "--scope", "local", MCP_SERVER_NAME],
      vaultRoot,
      runtime,
    );
    return {
      ok: true,
      message: "已移除 MCP 注册",
      executable: result.executable,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
