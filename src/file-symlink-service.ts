import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type FileSymlinkMethod =
  | "none"
  | "existing"
  | "node"
  | "windows-native";

export type FileSymlinkStage =
  | "validate-input"
  | "validate-target"
  | "prepare-parent"
  | "inspect-destination"
  | "create"
  | "windows-helper"
  | "verify-lstat"
  | "verify-readlink"
  | "verify-target"
  | "cleanup"
  | "complete";

export type FileSymlinkFailureReason =
  | "invalid-path"
  | "target-unavailable"
  | "target-not-file"
  | "parent-unavailable"
  | "destination-occupied"
  | "permission-denied"
  | "filesystem-unsupported"
  | "remote-unavailable"
  | "helper-unavailable"
  | "helper-failed"
  | "verification-failed"
  | "unknown";

export interface FileSymlinkRequest {
  targetPath: string;
  linkPath: string;
}

export interface FileSymlinkAttempt {
  method: FileSymlinkMethod;
  stage: FileSymlinkStage;
  ok: boolean;
  errorCode?: string;
  win32Error?: number;
  flags?: number;
  retryReason?: string;
  message?: string;
}

export interface WindowsSymlinkDiagnostics {
  helperExitCode?: number | null;
  privilegeStatus?: string;
}

interface FileSymlinkResultBase extends FileSymlinkRequest {
  method: FileSymlinkMethod;
  stage: FileSymlinkStage;
  attempts: FileSymlinkAttempt[];
  windowsDiagnostics?: WindowsSymlinkDiagnostics;
}

export interface FileSymlinkSuccess extends FileSymlinkResultBase {
  ok: true;
  verified: true;
  stage: "complete";
}

export interface FileSymlinkFailure extends FileSymlinkResultBase {
  ok: false;
  verified: false;
  reason: FileSymlinkFailureReason;
  message: string;
  errorCode?: string;
  win32Error?: number;
}

export type FileSymlinkResult = FileSymlinkSuccess | FileSymlinkFailure;

export interface FileSymlinkVerificationSuccess {
  ok: true;
  resolvedTargetPath: string;
}

export interface FileSymlinkVerificationFailure {
  ok: false;
  stage: Extract<
    FileSymlinkStage,
    "verify-lstat" | "verify-readlink" | "verify-target"
  >;
  message: string;
  errorCode?: string;
}

export type FileSymlinkVerificationResult =
  | FileSymlinkVerificationSuccess
  | FileSymlinkVerificationFailure;

export interface FileStatLike {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface PowerShellExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export interface FileSymlinkRuntime {
  statSync(filePath: string): FileStatLike;
  lstatSync(filePath: string): FileStatLike;
  readlinkSync(filePath: string): string;
  mkdirSync(directoryPath: string): void;
  symlinkSync(targetPath: string, linkPath: string): void;
  unlinkSync(filePath: string): void;
  runPowerShell(
    executable: string,
    args: string[],
    stdin: string,
    timeoutMs: number,
  ): Promise<PowerShellExecutionResult>;
}

export interface FileSymlinkServiceOptions {
  platform?: NodeJS.Platform;
  createParentDirectories?: boolean;
  windowsNativeRetry?: boolean;
  powerShellExecutable?: string;
  powerShellTimeoutMs?: number;
  runtime?: Partial<FileSymlinkRuntime>;
}

interface NativeHelperAttempt {
  success: boolean;
  flags: number;
  win32Error: number;
  retryReason?: string;
}

interface NativeHelperResult {
  success: boolean;
  win32Error?: number;
  privilegeStatus?: string;
  helperError?: string;
  attempts: NativeHelperAttempt[];
}

const DEFAULT_POWERSHELL_TIMEOUT_MS = 15_000;
const MAX_POWERSHELL_OUTPUT_LENGTH = 64 * 1024;

/*
 * The helper receives both paths only as Base64-wrapped UTF-8 JSON on standard
 * input. Base64 avoids Windows PowerShell 5.1's redirected-stdin code page,
 * while the constant encoded command keeps path text out of PowerShell source.
 */
const WINDOWS_NATIVE_SYMLINK_HELPER = String.raw`
$ErrorActionPreference = "Stop"

try {
    $payloadBase64 = [Console]::In.ReadToEnd().Trim()
    if ([String]::IsNullOrWhiteSpace($payloadBase64)) {
        throw "Missing symlink request payload."
    }
    $payloadBytes = [Convert]::FromBase64String($payloadBase64)
    $payloadText = [Text.Encoding]::UTF8.GetString($payloadBytes)

    $payload = $payloadText | ConvertFrom-Json
    $targetPath = [string]$payload.targetPath
    $linkPath = [string]$payload.linkPath
    if ([String]::IsNullOrWhiteSpace($targetPath) -or [String]::IsNullOrWhiteSpace($linkPath)) {
        throw "The symlink request payload is incomplete."
    }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MvSenceAi
{
    public sealed class NativeSymlinkAttempt
    {
        public bool Success { get; set; }
        public int Flags { get; set; }
        public int Win32Error { get; set; }
        public string RetryReason { get; set; }
    }

    public sealed class NativeSymlinkResult
    {
        public bool Success { get; set; }
        public int Win32Error { get; set; }
        public string PrivilegeStatus { get; set; }
        public List<NativeSymlinkAttempt> Attempts { get; set; }
    }

    public static class NativeSymlinkBridge
    {
        private const int SYMBOLIC_LINK_FLAG_FILE = 0x0;
        private const int SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE = 0x2;
        private const int ERROR_INVALID_PARAMETER = 87;
        private const int ERROR_NOT_ALL_ASSIGNED = 1300;
        private const int ERROR_PRIVILEGE_NOT_HELD = 1314;
        private const uint TOKEN_QUERY = 0x0008;
        private const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
        private const uint SE_PRIVILEGE_ENABLED = 0x00000002;

        [StructLayout(LayoutKind.Sequential)]
        private struct Luid
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TokenPrivileges
        {
            public uint PrivilegeCount;
            public Luid Luid;
            public uint Attributes;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.I1)]
        private static extern bool CreateSymbolicLinkW(
            string lpSymlinkFileName,
            string lpTargetFileName,
            int dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern void SetLastError(uint errorCode);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(
            IntPtr processHandle,
            uint desiredAccess,
            out IntPtr tokenHandle);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool LookupPrivilegeValueW(
            string systemName,
            string name,
            out Luid luid);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool AdjustTokenPrivileges(
            IntPtr tokenHandle,
            bool disableAllPrivileges,
            ref TokenPrivileges newState,
            uint bufferLength,
            IntPtr previousState,
            IntPtr returnLength);

        public static NativeSymlinkResult Create(string targetPath, string linkPath)
        {
            var result = new NativeSymlinkResult
            {
                Success = false,
                Win32Error = 0,
                PrivilegeStatus = "not-attempted",
                Attempts = new List<NativeSymlinkAttempt>()
            };

            int error = TryCreate(
                targetPath,
                linkPath,
                SYMBOLIC_LINK_FLAG_FILE | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE,
                "allow-unprivileged",
                result.Attempts);
            if (error == 0)
            {
                result.Success = true;
                return result;
            }

            if (error == ERROR_INVALID_PARAMETER)
            {
                error = TryCreate(
                    targetPath,
                    linkPath,
                    SYMBOLIC_LINK_FLAG_FILE,
                    "legacy-without-unprivileged-flag",
                    result.Attempts);
                if (error == 0)
                {
                    result.Success = true;
                    return result;
                }
            }

            if (error == ERROR_PRIVILEGE_NOT_HELD)
            {
                result.PrivilegeStatus = EnableCreateSymlinkPrivilege();
                if (result.PrivilegeStatus == "enabled")
                {
                    error = TryCreate(
                        targetPath,
                        linkPath,
                        SYMBOLIC_LINK_FLAG_FILE,
                        "enabled-token-privilege",
                        result.Attempts);
                    if (error == 0)
                    {
                        result.Success = true;
                        return result;
                    }
                }
            }

            result.Win32Error = error;
            return result;
        }

        private static int TryCreate(
            string targetPath,
            string linkPath,
            int flags,
            string retryReason,
            List<NativeSymlinkAttempt> attempts)
        {
            bool success = CreateSymbolicLinkW(linkPath, targetPath, flags);
            int error = success ? 0 : Marshal.GetLastWin32Error();
            attempts.Add(new NativeSymlinkAttempt
            {
                Success = success,
                Flags = flags,
                Win32Error = error,
                RetryReason = retryReason
            });
            return error;
        }

        private static string EnableCreateSymlinkPrivilege()
        {
            IntPtr tokenHandle;
            if (!OpenProcessToken(
                Process.GetCurrentProcess().Handle,
                TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES,
                out tokenHandle))
            {
                return "open-token-failed:" + Marshal.GetLastWin32Error();
            }

            try
            {
                Luid luid;
                if (!LookupPrivilegeValueW(null, "SeCreateSymbolicLinkPrivilege", out luid))
                {
                    return "lookup-failed:" + Marshal.GetLastWin32Error();
                }

                var privileges = new TokenPrivileges
                {
                    PrivilegeCount = 1,
                    Luid = luid,
                    Attributes = SE_PRIVILEGE_ENABLED
                };
                SetLastError(0);
                if (!AdjustTokenPrivileges(
                    tokenHandle,
                    false,
                    ref privileges,
                    0,
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    return "adjust-failed:" + Marshal.GetLastWin32Error();
                }

                int adjustError = Marshal.GetLastWin32Error();
                if (adjustError == ERROR_NOT_ALL_ASSIGNED)
                {
                    return "not-held";
                }
                if (adjustError != 0)
                {
                    return "adjust-failed:" + adjustError;
                }
                return "enabled";
            }
            finally
            {
                CloseHandle(tokenHandle);
            }
        }
    }
}
'@

    $native = [MvSenceAi.NativeSymlinkBridge]::Create($targetPath, $linkPath)
    $attempts = @($native.Attempts | ForEach-Object {
        @{
            success = [bool]$_.Success
            flags = [int]$_.Flags
            win32Error = [int]$_.Win32Error
            retryReason = [string]$_.RetryReason
        }
    })
    @{
        success = [bool]$native.Success
        win32Error = [int]$native.Win32Error
        privilegeStatus = [string]$native.PrivilegeStatus
        attempts = $attempts
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}
catch {
    @{
        success = $false
        helperError = [string]$_.Exception.Message
        attempts = @()
    } | ConvertTo-Json -Compress -Depth 4
    exit 2
}
`;

const defaultRuntime: FileSymlinkRuntime = {
  statSync(filePath) {
    return fs.statSync(filePath);
  },
  lstatSync(filePath) {
    return fs.lstatSync(filePath);
  },
  readlinkSync(filePath) {
    return fs.readlinkSync(filePath, "utf8");
  },
  mkdirSync(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
  },
  symlinkSync(targetPath, linkPath) {
    fs.symlinkSync(targetPath, linkPath, "file");
  },
  unlinkSync(filePath) {
    fs.unlinkSync(filePath);
  },
  runPowerShell(executable, args, stdin, timeoutMs) {
    return runPowerShell(executable, args, stdin, timeoutMs);
  },
};

function runtimeFromOptions(options: FileSymlinkServiceOptions): FileSymlinkRuntime {
  return { ...defaultRuntime, ...options.runtime };
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparableAbsolutePath(filePath: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  let comparable = api.normalize(api.resolve(filePath));
  if (platform === "win32") {
    if (comparable.startsWith("\\\\?\\UNC\\")) {
      comparable = `\\\\${comparable.slice(8)}`;
    } else if (comparable.startsWith("\\\\?\\")) {
      comparable = comparable.slice(4);
    }
    comparable = comparable.toLocaleLowerCase("en-US");
  }
  return comparable;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function reasonFromError(
  code: string | undefined,
  stage: FileSymlinkStage,
): FileSymlinkFailureReason {
  if (stage === "prepare-parent") return "parent-unavailable";
  if (stage === "validate-target") return "target-unavailable";
  if (code === "EEXIST") return "destination-occupied";
  if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
    return "permission-denied";
  }
  if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
    return "filesystem-unsupported";
  }
  return "unknown";
}

function reasonFromWin32Error(win32Error: number | undefined): FileSymlinkFailureReason {
  if (win32Error === 5 || win32Error === 1314) return "permission-denied";
  if (win32Error === 50 || win32Error === 282) return "filesystem-unsupported";
  if (
    win32Error === 53 ||
    win32Error === 64 ||
    win32Error === 67 ||
    win32Error === 1219 ||
    win32Error === 1231
  ) {
    return "remote-unavailable";
  }
  if (win32Error === 80 || win32Error === 183) return "destination-occupied";
  if (win32Error === 2 || win32Error === 3) return "target-unavailable";
  if (win32Error === 87 || win32Error === 123) return "invalid-path";
  return "unknown";
}

function makeFailure(
  request: FileSymlinkRequest,
  method: FileSymlinkMethod,
  stage: FileSymlinkStage,
  reason: FileSymlinkFailureReason,
  message: string,
  attempts: FileSymlinkAttempt[],
  details: {
    errorCode?: string;
    win32Error?: number;
    windowsDiagnostics?: WindowsSymlinkDiagnostics;
  } = {},
): FileSymlinkFailure {
  return {
    ...request,
    ok: false,
    verified: false,
    method,
    stage,
    reason,
    message,
    attempts,
    ...details,
  };
}

export function verifyFileSymlink(
  request: FileSymlinkRequest,
  options: FileSymlinkServiceOptions = {},
): FileSymlinkVerificationResult {
  const platform = options.platform ?? process.platform;
  const runtime = runtimeFromOptions(options);
  let stat: FileStatLike;
  try {
    stat = runtime.lstatSync(request.linkPath);
  } catch (error) {
    return {
      ok: false,
      stage: "verify-lstat",
      errorCode: errorCode(error),
      message: `Unable to inspect the symbolic link: ${errorMessage(error)}`,
    };
  }
  if (!stat.isSymbolicLink()) {
    return {
      ok: false,
      stage: "verify-lstat",
      message: "The created path is not a real symbolic link.",
    };
  }

  let rawTarget: string;
  try {
    rawTarget = runtime.readlinkSync(request.linkPath);
  } catch (error) {
    return {
      ok: false,
      stage: "verify-readlink",
      errorCode: errorCode(error),
      message: `Unable to read the symbolic-link target: ${errorMessage(error)}`,
    };
  }

  const api = pathApi(platform);
  const resolvedTarget = api.isAbsolute(rawTarget)
    ? api.normalize(rawTarget)
    : api.resolve(api.dirname(request.linkPath), rawTarget);
  if (
    comparableAbsolutePath(resolvedTarget, platform) !==
    comparableAbsolutePath(request.targetPath, platform)
  ) {
    return {
      ok: false,
      stage: "verify-target",
      message: "The symbolic link does not point to the requested target.",
    };
  }

  try {
    const targetStat = runtime.statSync(request.linkPath);
    if (!targetStat.isFile()) {
      return {
        ok: false,
        stage: "verify-target",
        message: "The symbolic-link target cannot be traversed as a file.",
      };
    }
  } catch (error) {
    return {
      ok: false,
      stage: "verify-target",
      errorCode: errorCode(error),
      message:
        `Unable to traverse the symbolic-link target: ${errorMessage(error)}`,
    };
  }

  return { ok: true, resolvedTargetPath: resolvedTarget };
}

function appendVerificationAttempts(
  attempts: FileSymlinkAttempt[],
  method: FileSymlinkMethod,
  verification: FileSymlinkVerificationResult,
): void {
  if (verification.ok) {
    attempts.push(
      { method, stage: "verify-lstat", ok: true },
      { method, stage: "verify-readlink", ok: true },
      { method, stage: "verify-target", ok: true },
    );
    return;
  }

  const stages: Array<Extract<
    FileSymlinkStage,
    "verify-lstat" | "verify-readlink" | "verify-target"
  >> = ["verify-lstat", "verify-readlink", "verify-target"];
  for (const stage of stages) {
    if (stage === verification.stage) {
      attempts.push({
        method,
        stage,
        ok: false,
        errorCode: verification.errorCode,
        message: verification.message,
      });
      break;
    }
    attempts.push({ method, stage, ok: true });
  }
}

function cleanupCreatedSymlink(
  linkPath: string,
  method: FileSymlinkMethod,
  runtime: FileSymlinkRuntime,
  attempts: FileSymlinkAttempt[],
): boolean {
  try {
    const stat = runtime.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      attempts.push({
        method,
        stage: "cleanup",
        ok: false,
        errorCode: "EUNSAFE",
        message: "Refused to remove a path that is not a symbolic link.",
      });
      return false;
    }
    runtime.unlinkSync(linkPath);
    attempts.push({ method, stage: "cleanup", ok: true });
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      attempts.push({ method, stage: "cleanup", ok: true });
      return true;
    }
    attempts.push({
      method,
      stage: "cleanup",
      ok: false,
      errorCode: errorCode(error),
      message: errorMessage(error),
    });
    return false;
  }
}

function defaultPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot?.trim();
  return systemRoot
    ? path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

function helperArguments(): string[] {
  const encoded = Buffer.from(WINDOWS_NATIVE_SYMLINK_HELPER, "utf16le").toString(
    "base64",
  );
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
}

function appendLimited(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_POWERSHELL_OUTPUT_LENGTH
    ? combined
    : combined.slice(-MAX_POWERSHELL_OUTPUT_LENGTH);
}

function runPowerShell(
  executable: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<PowerShellExecutionResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result: PowerShellExecutionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout,
        stderr: appendLimited(stderr, error.message),
        errorCode: error.code,
      });
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout,
        stderr,
        errorCode: timedOut ? "ETIMEDOUT" : undefined,
      });
    });
    child.stdin.on("error", () => {
      // Spawn/close handlers return the useful process failure.
    });
    child.stdin.end(stdin, "utf8");
  });
}

function parseNativeHelperResult(stdout: string): NativeHelperResult | null {
  const lines = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.success !== "boolean") continue;
      const rawAttempts = Array.isArray(parsed.attempts)
        ? parsed.attempts
        : parsed.attempts && typeof parsed.attempts === "object"
          ? [parsed.attempts]
          : [];
      const attempts: NativeHelperAttempt[] = rawAttempts.flatMap((attempt) => {
        if (!attempt || typeof attempt !== "object") return [];
        const value = attempt as Record<string, unknown>;
        if (
          typeof value.success !== "boolean" ||
          typeof value.flags !== "number" ||
          typeof value.win32Error !== "number"
        ) {
          return [];
        }
        return [
          {
            success: value.success,
            flags: value.flags,
            win32Error: value.win32Error,
            retryReason:
              typeof value.retryReason === "string"
                ? value.retryReason
                : undefined,
          },
        ];
      });
      return {
        success: parsed.success,
        win32Error:
          typeof parsed.win32Error === "number" ? parsed.win32Error : undefined,
        privilegeStatus:
          typeof parsed.privilegeStatus === "string"
            ? parsed.privilegeStatus
            : undefined,
        helperError:
          typeof parsed.helperError === "string" ? parsed.helperError : undefined,
        attempts,
      };
    } catch {
      // PowerShell can emit a host preamble; the final JSON line is authoritative.
    }
  }
  return null;
}

async function createWithWindowsNativeHelper(
  request: FileSymlinkRequest,
  options: FileSymlinkServiceOptions,
  runtime: FileSymlinkRuntime,
  attempts: FileSymlinkAttempt[],
): Promise<FileSymlinkResult> {
  const executable = options.powerShellExecutable ?? defaultPowerShellExecutable();
  const timeoutMs = options.powerShellTimeoutMs ?? DEFAULT_POWERSHELL_TIMEOUT_MS;
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString(
    "base64",
  );
  let execution: PowerShellExecutionResult;
  try {
    execution = await runtime.runPowerShell(
      executable,
      helperArguments(),
      payload,
      timeoutMs,
    );
  } catch (error) {
    const code = errorCode(error);
    attempts.push({
      method: "windows-native",
      stage: "windows-helper",
      ok: false,
      errorCode: code,
      message: errorMessage(error),
    });
    return makeFailure(
      request,
      "windows-native",
      "windows-helper",
      "helper-unavailable",
      "The Windows symbolic-link helper could not be started.",
      attempts,
      { errorCode: code },
    );
  }

  const native = parseNativeHelperResult(execution.stdout);
  const diagnostics: WindowsSymlinkDiagnostics = {
    helperExitCode: execution.exitCode,
    privilegeStatus: native?.privilegeStatus,
  };
  if (!native || execution.errorCode) {
    attempts.push({
      method: "windows-native",
      stage: "windows-helper",
      ok: false,
      errorCode: execution.errorCode,
      message: execution.stderr || "The helper returned no structured result.",
    });
    return makeFailure(
      request,
      "windows-native",
      "windows-helper",
      execution.errorCode === "ENOENT" ? "helper-unavailable" : "helper-failed",
      "The Windows symbolic-link helper did not return a usable result.",
      attempts,
      {
        errorCode: execution.errorCode,
        windowsDiagnostics: diagnostics,
      },
    );
  }

  for (const attempt of native.attempts) {
    attempts.push({
      method: "windows-native",
      stage: "create",
      ok: attempt.success,
      flags: attempt.flags,
      win32Error: attempt.win32Error || undefined,
      retryReason: attempt.retryReason,
    });
  }

  if (execution.exitCode !== 0 || native.helperError) {
    if (native.attempts.length === 0) {
      attempts.push({
        method: "windows-native",
        stage: "windows-helper",
        ok: false,
        message: native.helperError ?? execution.stderr,
      });
    }
    return makeFailure(
      request,
      "windows-native",
      "windows-helper",
      "helper-failed",
      native.helperError ?? "The Windows symbolic-link helper failed.",
      attempts,
      { windowsDiagnostics: diagnostics },
    );
  }

  if (!native.success) {
    const win32Error = native.win32Error;
    if (native.attempts.length === 0) {
      attempts.push({
        method: "windows-native",
        stage: "create",
        ok: false,
        win32Error,
      });
    }
    return makeFailure(
      request,
      "windows-native",
      "create",
      reasonFromWin32Error(win32Error),
      `Windows rejected symbolic-link creation${
        win32Error === undefined ? "" : ` (Win32 ${win32Error})`
      }.`,
      attempts,
      { win32Error, windowsDiagnostics: diagnostics },
    );
  }

  const verification = verifyFileSymlink(request, options);
  appendVerificationAttempts(attempts, "windows-native", verification);
  if (!verification.ok) {
    cleanupCreatedSymlink(request.linkPath, "windows-native", runtime, attempts);
    return makeFailure(
      request,
      "windows-native",
      verification.stage,
      reasonFromError(verification.errorCode, verification.stage) === "unknown"
        ? "verification-failed"
        : reasonFromError(verification.errorCode, verification.stage),
      verification.message,
      attempts,
      {
        errorCode: verification.errorCode,
        windowsDiagnostics: diagnostics,
      },
    );
  }

  return {
    ...request,
    ok: true,
    verified: true,
    method: "windows-native",
    stage: "complete",
    attempts,
    windowsDiagnostics: diagnostics,
  };
}

export async function createVerifiedFileSymlink(
  request: FileSymlinkRequest,
  options: FileSymlinkServiceOptions = {},
): Promise<FileSymlinkResult> {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const runtime = runtimeFromOptions(options);
  const attempts: FileSymlinkAttempt[] = [];

  if (
    typeof request.targetPath !== "string" ||
    typeof request.linkPath !== "string" ||
    request.targetPath.length === 0 ||
    request.linkPath.length === 0 ||
    request.targetPath.includes("\0") ||
    request.linkPath.includes("\0") ||
    !api.isAbsolute(request.targetPath) ||
    !api.isAbsolute(request.linkPath) ||
    comparableAbsolutePath(request.targetPath, platform) ===
      comparableAbsolutePath(request.linkPath, platform)
  ) {
    attempts.push({ method: "none", stage: "validate-input", ok: false });
    return makeFailure(
      request,
      "none",
      "validate-input",
      "invalid-path",
      "The target and link must be different absolute paths without null bytes.",
      attempts,
    );
  }
  attempts.push({ method: "none", stage: "validate-input", ok: true });

  try {
    const targetStat = runtime.statSync(request.targetPath);
    if (!targetStat.isFile()) {
      attempts.push({ method: "none", stage: "validate-target", ok: false });
      return makeFailure(
        request,
        "none",
        "validate-target",
        "target-not-file",
        "The symbolic-link target is not a file.",
        attempts,
      );
    }
    attempts.push({ method: "none", stage: "validate-target", ok: true });
  } catch (error) {
    const code = errorCode(error);
    attempts.push({
      method: "none",
      stage: "validate-target",
      ok: false,
      errorCode: code,
      message: errorMessage(error),
    });
    return makeFailure(
      request,
      "none",
      "validate-target",
      reasonFromError(code, "validate-target"),
      `The symbolic-link target is unavailable: ${errorMessage(error)}`,
      attempts,
      { errorCode: code },
    );
  }

  if (options.createParentDirectories !== false) {
    try {
      runtime.mkdirSync(api.dirname(request.linkPath));
      attempts.push({ method: "none", stage: "prepare-parent", ok: true });
    } catch (error) {
      const code = errorCode(error);
      attempts.push({
        method: "none",
        stage: "prepare-parent",
        ok: false,
        errorCode: code,
        message: errorMessage(error),
      });
      return makeFailure(
        request,
        "none",
        "prepare-parent",
        reasonFromError(code, "prepare-parent"),
        `Unable to prepare the symbolic-link directory: ${errorMessage(error)}`,
        attempts,
        { errorCode: code },
      );
    }
  }

  try {
    runtime.lstatSync(request.linkPath);
    const verification = verifyFileSymlink(request, options);
    appendVerificationAttempts(attempts, "existing", verification);
    if (verification.ok) {
      return {
        ...request,
        ok: true,
        verified: true,
        method: "existing",
        stage: "complete",
        attempts,
      };
    }
    attempts.push({
      method: "existing",
      stage: "inspect-destination",
      ok: false,
      message: "The destination is occupied by another path.",
    });
    return makeFailure(
      request,
      "existing",
      "inspect-destination",
      "destination-occupied",
      "The destination already exists and is not the requested symbolic link.",
      attempts,
    );
  } catch (error) {
    if (!isMissingPathError(error)) {
      const code = errorCode(error);
      attempts.push({
        method: "none",
        stage: "inspect-destination",
        ok: false,
        errorCode: code,
        message: errorMessage(error),
      });
      return makeFailure(
        request,
        "none",
        "inspect-destination",
        reasonFromError(code, "inspect-destination"),
        `Unable to inspect the symbolic-link destination: ${errorMessage(error)}`,
        attempts,
        { errorCode: code },
      );
    }
    attempts.push({ method: "none", stage: "inspect-destination", ok: true });
  }

  try {
    runtime.symlinkSync(request.targetPath, request.linkPath);
    attempts.push({ method: "node", stage: "create", ok: true });
  } catch (error) {
    const code = errorCode(error);
    attempts.push({
      method: "node",
      stage: "create",
      ok: false,
      errorCode: code,
      message: errorMessage(error),
    });
    if (
      platform === "win32" &&
      options.windowsNativeRetry !== false &&
      code !== "EEXIST"
    ) {
      return await createWithWindowsNativeHelper(request, options, runtime, attempts);
    }
    return makeFailure(
      request,
      "node",
      "create",
      reasonFromError(code, "create"),
      `Node could not create the symbolic link: ${errorMessage(error)}`,
      attempts,
      { errorCode: code },
    );
  }

  const verification = verifyFileSymlink(request, options);
  appendVerificationAttempts(attempts, "node", verification);
  if (verification.ok) {
    return {
      ...request,
      ok: true,
      verified: true,
      method: "node",
      stage: "complete",
      attempts,
    };
  }

  const cleaned = cleanupCreatedSymlink(
    request.linkPath,
    "node",
    runtime,
    attempts,
  );
  if (
    platform === "win32" &&
    options.windowsNativeRetry !== false &&
    cleaned
  ) {
    return await createWithWindowsNativeHelper(request, options, runtime, attempts);
  }
  return makeFailure(
    request,
    "node",
    verification.stage,
    reasonFromError(verification.errorCode, verification.stage) === "unknown"
      ? "verification-failed"
      : reasonFromError(verification.errorCode, verification.stage),
    verification.message,
    attempts,
    { errorCode: verification.errorCode },
  );
}
