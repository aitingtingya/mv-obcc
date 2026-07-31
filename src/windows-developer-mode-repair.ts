import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type WindowsDeveloperModePolicyState =
  | "not-configured"
  | "allowed"
  | "denied"
  | "invalid"
  | "unknown";

export type WindowsDeveloperModeEffectiveState =
  | "enabled"
  | "disabled"
  | "blocked-by-policy"
  | "unknown"
  | "unsupported-platform";

export interface WindowsDeveloperModeRegistryValue {
  readable: boolean;
  present: boolean;
  value?: number;
  kind?: string;
  error?: string;
}

export interface WindowsDeveloperModeDiagnosis {
  ok: boolean;
  supported: boolean;
  platform: NodeJS.Platform;
  effectiveState: WindowsDeveloperModeEffectiveState;
  enabled: boolean;
  policyState: WindowsDeveloperModePolicyState;
  canRepair: boolean;
  machineValue: WindowsDeveloperModeRegistryValue;
  policyValue: WindowsDeveloperModeRegistryValue;
  message: string;
  command?: {
    exitCode: number | null;
    errorCode?: string;
    stderr?: string;
  };
}

export type WindowsDeveloperModeRepairStatus =
  | "repaired"
  | "already-enabled"
  | "unsupported-platform"
  | "blocked-by-policy"
  | "diagnosis-failed"
  | "temporary-files-failed"
  | "cancelled"
  | "elevation-failed"
  | "repair-failed"
  | "verification-failed";

export interface WindowsDeveloperModeCleanupResult {
  attempted: boolean;
  succeeded: boolean;
  error?: string;
}

export interface WindowsDeveloperModeElevationResult {
  started: boolean;
  exitCode: number | null;
  nativeErrorCode?: number;
  error?: string;
  writeCompleted: boolean;
}

export interface WindowsDeveloperModeRepairResult {
  ok: boolean;
  status: WindowsDeveloperModeRepairStatus;
  changed: boolean;
  message: string;
  diagnosisBefore: WindowsDeveloperModeDiagnosis;
  diagnosisAfter?: WindowsDeveloperModeDiagnosis;
  elevation?: WindowsDeveloperModeElevationResult;
  cleanup: WindowsDeveloperModeCleanupResult;
}

export interface WindowsDeveloperModeCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export interface WindowsDeveloperModeRuntime {
  runPowerShell(
    executable: string,
    args: string[],
    stdin: string,
    timeoutMs: number,
  ): Promise<WindowsDeveloperModeCommandResult>;
  createTempDirectory(prefix: string): Promise<string>;
  writeTextFile(filePath: string, contents: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
}

export interface WindowsDeveloperModeOptions {
  platform?: NodeJS.Platform;
  powerShellExecutable?: string;
  diagnosisTimeoutMs?: number;
  repairTimeoutMs?: number;
  tempDirectory?: string;
  runtime?: Partial<WindowsDeveloperModeRuntime>;
}

interface RawRegistryValue {
  readable: boolean;
  present: boolean;
  value?: number | null;
  kind?: string | null;
  error?: string | null;
}

interface ElevationLauncherOutput {
  started: boolean;
  exitCode: number | null;
  nativeErrorCode?: number;
  errorMessage?: string;
}

interface RepairResultWithoutCleanup {
  ok: boolean;
  status: WindowsDeveloperModeRepairStatus;
  changed: boolean;
  message: string;
  diagnosisBefore: WindowsDeveloperModeDiagnosis;
  diagnosisAfter?: WindowsDeveloperModeDiagnosis;
  elevation?: WindowsDeveloperModeElevationResult;
}

const DEFAULT_DIAGNOSIS_TIMEOUT_MS = 15_000;
const DEFAULT_REPAIR_TIMEOUT_MS = 120_000;
const MAX_POWERSHELL_OUTPUT_LENGTH = 64 * 1024;
const UAC_CANCELLED_WIN32_ERROR = 1223;

const WINDOWS_DEVELOPER_MODE_DIAGNOSIS_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"

function Read-RegistryDword {
    param(
        [Parameter(Mandatory = $true)][string]$SubKeyPath,
        [Parameter(Mandatory = $true)][string]$ValueName
    )

    $baseKey = $null
    $key = $null
    try {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::LocalMachine,
            [Microsoft.Win32.RegistryView]::Default
        )
        $key = $baseKey.OpenSubKey($SubKeyPath, $false)
        if ($null -eq $key) {
            return [pscustomobject]@{
                readable = $true
                present = $false
                value = $null
                kind = $null
                error = $null
            }
        }

        if ($key.GetValueNames() -notcontains $ValueName) {
            return [pscustomobject]@{
                readable = $true
                present = $false
                value = $null
                kind = $null
                error = $null
            }
        }

        $rawValue = $key.GetValue(
            $ValueName,
            $null,
            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
        )
        $kind = $key.GetValueKind($ValueName).ToString()
        $numericValue = $null
        if (
            $rawValue -is [System.Byte] -or
            $rawValue -is [System.Int16] -or
            $rawValue -is [System.Int32] -or
            $rawValue -is [System.Int64] -or
            $rawValue -is [System.UInt16] -or
            $rawValue -is [System.UInt32] -or
            $rawValue -is [System.UInt64]
        ) {
            $numericValue = [System.Convert]::ToInt64($rawValue)
        }

        return [pscustomobject]@{
            readable = $true
            present = $true
            value = $numericValue
            kind = $kind
            error = $null
        }
    }
    catch {
        return [pscustomobject]@{
            readable = $false
            present = $false
            value = $null
            kind = $null
            error = $_.Exception.Message
        }
    }
    finally {
        if ($null -ne $key) { $key.Dispose() }
        if ($null -ne $baseKey) { $baseKey.Dispose() }
    }
}

$valueName = "AllowDevelopmentWithoutDevLicense"
$machine = Read-RegistryDword -SubKeyPath "SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" -ValueName $valueName
$policy = Read-RegistryDword -SubKeyPath "SOFTWARE\Policies\Microsoft\Windows\Appx" -ValueName $valueName

[ordered]@{
    machine = $machine
    policy = $policy
} | ConvertTo-Json -Compress -Depth 4
`;

/*
 * This script is written verbatim to a private, randomly named temporary
 * directory. It has one registry mutation and deliberately contains no policy,
 * remote-link, or filesystem-behaviour changes.
 */
const WINDOWS_DEVELOPER_MODE_ELEVATED_WORKER = String.raw`
$ErrorActionPreference = "Stop"

try {
    $subKeyPath = "SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
    $key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($subKeyPath, $true)
    if ($null -eq $key) {
        throw "Windows did not open the Developer Mode registry key for writing."
    }
    try {
        $key.SetValue(
            "AllowDevelopmentWithoutDevLicense",
            1,
            [Microsoft.Win32.RegistryValueKind]::DWord
        )
    }
    finally {
        $key.Dispose()
    }
}
catch {
    exit 1
}
exit 0
`;

/*
 * All changing values arrive as Base64-wrapped UTF-8 JSON on stdin, avoiding
 * Windows PowerShell 5.1's redirected-stdin code page. The elevated command
 * embeds only Base64 paths and a validated SHA-256 digest, never raw path text.
 * It hashes the bytes it reads and executes those exact bytes, closing the
 * temporary-script replacement window at the UAC boundary.
 */
const WINDOWS_DEVELOPER_MODE_ELEVATION_LAUNCHER = String.raw`
$ErrorActionPreference = "Stop"

try {
    $payloadBase64 = [Console]::In.ReadToEnd().Trim()
    if ([String]::IsNullOrWhiteSpace($payloadBase64)) {
        throw "Missing Developer Mode repair payload."
    }

    $payloadBytes = [Convert]::FromBase64String($payloadBase64)
    $payloadText = [Text.Encoding]::UTF8.GetString($payloadBytes)
    $payload = $payloadText | ConvertFrom-Json
    $scriptPath = [string]$payload.scriptPath
    $powerShellExecutable = [string]$payload.powerShellExecutable
    $expectedHash = ([string]$payload.expectedHash).ToLowerInvariant()
    if (
        [String]::IsNullOrWhiteSpace($scriptPath) -or
        [String]::IsNullOrWhiteSpace($powerShellExecutable) -or
        $expectedHash -notmatch "^[0-9a-f]{64}$"
    ) {
        throw "The Developer Mode repair payload is invalid."
    }

    $scriptPathBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($scriptPath)
    )
    $innerCommand = @(
        '$ErrorActionPreference = "Stop"'
        '$scriptPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + $scriptPathBase64 + '"))'
        '$scriptBytes = [IO.File]::ReadAllBytes($scriptPath)'
        '$actualHash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($scriptBytes))).Replace("-", "").ToLowerInvariant()'
        'if (-not [String]::Equals($actualHash, "' + $expectedHash + '", [StringComparison]::Ordinal)) { throw "Developer Mode repair script hash mismatch." }'
        '$scriptText = [Text.Encoding]::UTF8.GetString($scriptBytes)'
        '$scriptBlock = [ScriptBlock]::Create($scriptText)'
        '& $scriptBlock'
        'if ($null -eq $LASTEXITCODE) { exit 0 }'
        'exit [int]$LASTEXITCODE'
    ) -join [Environment]::NewLine
    $encodedInnerCommand = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes($innerCommand)
    )

    $arguments = @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        $encodedInnerCommand
    )
    $startArguments = @{
        FilePath = $powerShellExecutable
        ArgumentList = $arguments
        Verb = "RunAs"
        WindowStyle = "Hidden"
        Wait = $true
        PassThru = $true
        ErrorAction = "Stop"
    }
    $process = Start-Process @startArguments

    [ordered]@{
        started = $true
        exitCode = $process.ExitCode
        nativeErrorCode = $null
        errorMessage = $null
    } | ConvertTo-Json -Compress
}
catch {
    $nativeErrorCode = $null
    $nativeErrorProperty = $_.Exception.PSObject.Properties["NativeErrorCode"]
    if ($null -ne $nativeErrorProperty) {
        $nativeErrorCode = [int]$nativeErrorProperty.Value
    }
    [ordered]@{
        started = $false
        exitCode = $null
        nativeErrorCode = $nativeErrorCode
        errorMessage = $_.Exception.Message
    } | ConvertTo-Json -Compress
}
`;

const defaultRuntime: WindowsDeveloperModeRuntime = {
  runPowerShell,
  createTempDirectory: async (prefix) => await fs.mkdtemp(prefix),
  writeTextFile: async (filePath, contents) => {
    await fs.writeFile(filePath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  },
  removeDirectory: async (directoryPath) => {
    await fs.rm(directoryPath, { recursive: true, force: true });
  },
};

function runtimeFromOptions(
  options: WindowsDeveloperModeOptions,
): WindowsDeveloperModeRuntime {
  const overrides = options.runtime;
  return {
    runPowerShell: overrides?.runPowerShell
      ? (...args) => overrides.runPowerShell!(...args)
      : defaultRuntime.runPowerShell,
    createTempDirectory: overrides?.createTempDirectory
      ? (...args) => overrides.createTempDirectory!(...args)
      : defaultRuntime.createTempDirectory,
    writeTextFile: overrides?.writeTextFile
      ? (...args) => overrides.writeTextFile!(...args)
      : defaultRuntime.writeTextFile,
    removeDirectory: overrides?.removeDirectory
      ? (...args) => overrides.removeDirectory!(...args)
      : defaultRuntime.removeDirectory,
  };
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

function encodedCommandArguments(source: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(source, "utf16le").toString("base64"),
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
): Promise<WindowsDeveloperModeCommandResult> {
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

    const finish = (result: WindowsDeveloperModeCommandResult): void => {
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
      // The process error/close event carries the useful failure details.
    });
    child.stdin.end(stdin, "utf8");
  });
}

function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Ignore PowerShell host preambles and inspect the next line.
    }
  }
  return null;
}

function parseRegistryValue(value: unknown): WindowsDeveloperModeRegistryValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.readable !== "boolean" ||
    typeof record.present !== "boolean"
  ) {
    return null;
  }
  const parsed: WindowsDeveloperModeRegistryValue = {
    readable: record.readable,
    present: record.present,
  };
  if (typeof record.value === "number" && Number.isFinite(record.value)) {
    parsed.value = record.value;
  }
  if (typeof record.kind === "string") parsed.kind = record.kind;
  if (typeof record.error === "string") parsed.error = record.error;
  return parsed;
}

function unavailableRegistryValue(error: string): WindowsDeveloperModeRegistryValue {
  return { readable: false, present: false, error };
}

function policyStateFromValue(
  value: WindowsDeveloperModeRegistryValue,
): WindowsDeveloperModePolicyState {
  if (!value.readable) return "unknown";
  if (!value.present) return "not-configured";
  if (value.kind !== "DWord" || value.value === undefined) return "invalid";
  if (value.value === 0) return "denied";
  if (value.value === 1) return "allowed";
  return "invalid";
}

function machineValueIsValid(value: WindowsDeveloperModeRegistryValue): boolean {
  return (
    value.readable &&
    (!value.present ||
      (value.kind === "DWord" && (value.value === 0 || value.value === 1)))
  );
}

function diagnosisFromValues(
  platform: NodeJS.Platform,
  machineValue: WindowsDeveloperModeRegistryValue,
  policyValue: WindowsDeveloperModeRegistryValue,
  command: WindowsDeveloperModeDiagnosis["command"],
): WindowsDeveloperModeDiagnosis {
  const policyState = policyStateFromValue(policyValue);
  const valuesValid =
    machineValueIsValid(machineValue) &&
    policyState !== "invalid" &&
    policyState !== "unknown";

  let effectiveState: WindowsDeveloperModeEffectiveState = "unknown";
  if (policyState === "denied") {
    effectiveState = "blocked-by-policy";
  } else if (valuesValid) {
    const machineEnabled = machineValue.present && machineValue.value === 1;
    effectiveState =
      policyState === "allowed" || machineEnabled ? "enabled" : "disabled";
  }

  const ok = effectiveState !== "unknown";
  const messages: Record<WindowsDeveloperModeEffectiveState, string> = {
    enabled: "Windows Developer Mode is effective.",
    disabled: "Windows Developer Mode is not enabled.",
    "blocked-by-policy":
      "Windows Developer Mode is explicitly disabled by machine policy.",
    unknown: "Windows Developer Mode state could not be determined safely.",
    "unsupported-platform": "Developer Mode repair is only available on Windows.",
  };
  return {
    ok,
    supported: true,
    platform,
    effectiveState,
    enabled: effectiveState === "enabled",
    policyState,
    canRepair: effectiveState === "disabled",
    machineValue,
    policyValue,
    message: messages[effectiveState],
    command,
  };
}

function unsupportedDiagnosis(platform: NodeJS.Platform): WindowsDeveloperModeDiagnosis {
  const unavailable = unavailableRegistryValue("Not available on this platform.");
  return {
    ok: false,
    supported: false,
    platform,
    effectiveState: "unsupported-platform",
    enabled: false,
    policyState: "unknown",
    canRepair: false,
    machineValue: { ...unavailable },
    policyValue: { ...unavailable },
    message: "Developer Mode repair is only available on Windows.",
  };
}

export async function diagnoseWindowsDeveloperMode(
  options: WindowsDeveloperModeOptions = {},
): Promise<WindowsDeveloperModeDiagnosis> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return unsupportedDiagnosis(platform);

  const runtime = runtimeFromOptions(options);
  const executable = options.powerShellExecutable ?? defaultPowerShellExecutable();
  let commandResult: WindowsDeveloperModeCommandResult;
  try {
    commandResult = await runtime.runPowerShell(
      executable,
      encodedCommandArguments(WINDOWS_DEVELOPER_MODE_DIAGNOSIS_SCRIPT),
      "",
      options.diagnosisTimeoutMs ?? DEFAULT_DIAGNOSIS_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = unavailableRegistryValue(message);
    return diagnosisFromValues(
      platform,
      { ...unavailable },
      { ...unavailable },
      { exitCode: null, stderr: message },
    );
  }

  const command = {
    exitCode: commandResult.exitCode,
    errorCode: commandResult.errorCode,
    stderr: commandResult.stderr || undefined,
  };
  const parsed = parseLastJsonObject(commandResult.stdout);
  if (commandResult.exitCode !== 0 || commandResult.errorCode || !parsed) {
    const detail =
      commandResult.errorCode ??
      commandResult.stderr.trim() ??
      "PowerShell returned no structured diagnosis.";
    const unavailable = unavailableRegistryValue(
      detail || "PowerShell returned no structured diagnosis.",
    );
    return diagnosisFromValues(
      platform,
      { ...unavailable },
      { ...unavailable },
      command,
    );
  }

  const machineValue = parseRegistryValue(parsed.machine);
  const policyValue = parseRegistryValue(parsed.policy);
  if (!machineValue || !policyValue) {
    const unavailable = unavailableRegistryValue(
      "PowerShell returned an invalid Developer Mode diagnosis.",
    );
    return diagnosisFromValues(
      platform,
      machineValue ?? { ...unavailable },
      policyValue ?? { ...unavailable },
      command,
    );
  }

  return diagnosisFromValues(
    platform,
    machineValue,
    policyValue,
    command,
  );
}

function parseElevationOutput(stdout: string): ElevationLauncherOutput | null {
  const parsed = parseLastJsonObject(stdout);
  if (!parsed || typeof parsed.started !== "boolean") return null;
  const result: ElevationLauncherOutput = {
    started: parsed.started,
    exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
  };
  if (typeof parsed.nativeErrorCode === "number") {
    result.nativeErrorCode = parsed.nativeErrorCode;
  }
  if (typeof parsed.errorMessage === "string") {
    result.errorMessage = parsed.errorMessage;
  }
  return result;
}

function noCleanup(): WindowsDeveloperModeCleanupResult {
  return { attempted: false, succeeded: true };
}

function immediateRepairResult(
  diagnosisBefore: WindowsDeveloperModeDiagnosis,
  status: WindowsDeveloperModeRepairStatus,
  ok: boolean,
  message: string,
): WindowsDeveloperModeRepairResult {
  return {
    ok,
    status,
    changed: false,
    message,
    diagnosisBefore,
    cleanup: noCleanup(),
  };
}

async function cleanTemporaryDirectory(
  runtime: WindowsDeveloperModeRuntime,
  directoryPath: string | undefined,
): Promise<WindowsDeveloperModeCleanupResult> {
  if (!directoryPath) return noCleanup();
  try {
    await runtime.removeDirectory(directoryPath);
    return { attempted: true, succeeded: true };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function repairWindowsDeveloperMode(
  options: WindowsDeveloperModeOptions = {},
): Promise<WindowsDeveloperModeRepairResult> {
  const platform = options.platform ?? process.platform;
  const runtime = runtimeFromOptions(options);
  const resolvedOptions: WindowsDeveloperModeOptions = {
    ...options,
    platform,
    runtime,
  };
  const diagnosisBefore = await diagnoseWindowsDeveloperMode(resolvedOptions);

  if (!diagnosisBefore.supported) {
    return immediateRepairResult(
      diagnosisBefore,
      "unsupported-platform",
      false,
      "Developer Mode repair is only available on Windows.",
    );
  }
  if (diagnosisBefore.policyState === "denied") {
    return immediateRepairResult(
      diagnosisBefore,
      "blocked-by-policy",
      false,
      "Machine policy explicitly disables Developer Mode; the plugin will not override policy.",
    );
  }
  if (!diagnosisBefore.ok) {
    return immediateRepairResult(
      diagnosisBefore,
      "diagnosis-failed",
      false,
      "Developer Mode repair was not started because policy state could not be determined safely.",
    );
  }
  if (diagnosisBefore.enabled) {
    return immediateRepairResult(
      diagnosisBefore,
      "already-enabled",
      true,
      "Windows Developer Mode is already effective.",
    );
  }

  const executable = options.powerShellExecutable ?? defaultPowerShellExecutable();
  const tempRoot = options.tempDirectory ?? os.tmpdir();
  const tempPrefix = path.win32.join(tempRoot, "mv-obcc-developer-mode-");
  let tempDirectory: string | undefined;
  let pending: RepairResultWithoutCleanup;

  try {
    tempDirectory = await runtime.createTempDirectory(tempPrefix);
    const scriptPath = path.win32.join(tempDirectory, "enable-developer-mode.ps1");
    await runtime.writeTextFile(
      scriptPath,
      WINDOWS_DEVELOPER_MODE_ELEVATED_WORKER,
    );
    const expectedHash = createHash("sha256")
      .update(WINDOWS_DEVELOPER_MODE_ELEVATED_WORKER, "utf8")
      .digest("hex");
    const launcherPayload = Buffer.from(
      JSON.stringify({
        scriptPath,
        powerShellExecutable: executable,
        expectedHash,
      }),
      "utf8",
    ).toString("base64");

    let commandResult: WindowsDeveloperModeCommandResult;
    try {
      commandResult = await runtime.runPowerShell(
        executable,
        encodedCommandArguments(WINDOWS_DEVELOPER_MODE_ELEVATION_LAUNCHER),
        launcherPayload,
        options.repairTimeoutMs ?? DEFAULT_REPAIR_TIMEOUT_MS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pending = {
        ok: false,
        status: "elevation-failed",
        changed: false,
        message: `The UAC repair launcher could not be started: ${message}`,
        diagnosisBefore,
        elevation: {
          started: false,
          exitCode: null,
          error: message,
          writeCompleted: false,
        },
      };
      const cleanup = await cleanTemporaryDirectory(runtime, tempDirectory);
      return { ...pending, cleanup };
    }

    const launcher = parseElevationOutput(commandResult.stdout);
    if (!launcher || commandResult.errorCode || commandResult.exitCode !== 0) {
      pending = {
        ok: false,
        status: "elevation-failed",
        changed: false,
        message:
          commandResult.stderr.trim() ||
          "The UAC repair launcher returned no usable result.",
        diagnosisBefore,
        elevation: {
          started: launcher?.started ?? false,
          exitCode: launcher?.exitCode ?? commandResult.exitCode,
          nativeErrorCode: launcher?.nativeErrorCode,
          error:
            commandResult.errorCode ??
            launcher?.errorMessage ??
            (commandResult.stderr.trim() || undefined),
          writeCompleted: false,
        },
      };
    } else if (
      !launcher.started &&
      launcher.nativeErrorCode === UAC_CANCELLED_WIN32_ERROR
    ) {
      pending = {
        ok: false,
        status: "cancelled",
        changed: false,
        message: "The Windows UAC prompt was cancelled.",
        diagnosisBefore,
        elevation: {
          started: false,
          exitCode: null,
          nativeErrorCode: launcher.nativeErrorCode,
          error: launcher.errorMessage,
          writeCompleted: false,
        },
      };
    } else if (!launcher.started) {
      pending = {
        ok: false,
        status: "elevation-failed",
        changed: false,
        message: launcher.errorMessage ?? "Windows did not start the elevated repair.",
        diagnosisBefore,
        elevation: {
          started: false,
          exitCode: launcher.exitCode,
          nativeErrorCode: launcher.nativeErrorCode,
          error: launcher.errorMessage,
          writeCompleted: false,
        },
      };
    } else if (launcher.exitCode !== 0) {
      pending = {
        ok: false,
        status: "repair-failed",
        changed: false,
        message: "The elevated Developer Mode registry write did not complete.",
        diagnosisBefore,
        elevation: {
          started: true,
          exitCode: launcher.exitCode,
          writeCompleted: false,
        },
      };
    } else {
      const diagnosisAfter = await diagnoseWindowsDeveloperMode(resolvedOptions);
      const elevation: WindowsDeveloperModeElevationResult = {
        started: true,
        exitCode: launcher.exitCode,
        writeCompleted: true,
      };
      pending = diagnosisAfter.enabled
        ? {
            ok: true,
            status: "repaired",
            changed: true,
            message: "Windows Developer Mode was enabled and verified.",
            diagnosisBefore,
            diagnosisAfter,
            elevation,
          }
        : {
            ok: false,
            status: "verification-failed",
            changed: false,
            message:
              "The registry write completed, but Developer Mode is still not effective.",
            diagnosisBefore,
            diagnosisAfter,
            elevation,
          };
    }
  } catch (error) {
    pending = {
      ok: false,
      status: "temporary-files-failed",
      changed: false,
      message: `Unable to prepare the temporary UAC repair script: ${
        error instanceof Error ? error.message : String(error)
      }`,
      diagnosisBefore,
    };
  }

  const cleanup = await cleanTemporaryDirectory(runtime, tempDirectory);
  return { ...pending, cleanup };
}
