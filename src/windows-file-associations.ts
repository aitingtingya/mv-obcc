import childProcess from "node:child_process";
import { t } from "./i18n";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(childProcess.execFile);

export const WINDOWS_FILE_OPENER_APPLICATION_NAME =
  "MV AIDE File Opener";
export const WINDOWS_FILE_OPENER_PROG_ID = "MV.AIDE.FileOpener";
export const WINDOWS_FILE_OPENER_REGISTRATION_VERSION = 6;
export const WINDOWS_FILE_OPENER_CAPABILITIES_PATH =
  "Software\\MV\\AIDE\\FileOpener\\Capabilities";

export interface WindowsFileAssociationIdentity {
  applicationName: string;
  progId: string;
  capabilitiesPath: string;
}

const DEFAULT_WINDOWS_FILE_ASSOCIATION_IDENTITY: WindowsFileAssociationIdentity = {
  applicationName: WINDOWS_FILE_OPENER_APPLICATION_NAME,
  progId: WINDOWS_FILE_OPENER_PROG_ID,
  capabilitiesPath: WINDOWS_FILE_OPENER_CAPABILITIES_PATH,
};

const WINDOWS_FILE_OPENER_DESCRIPTION =
  "Open Markdown and configured source files in a selected Obsidian vault.";
const REGISTERED_APPLICATIONS_KEY =
  "HKCU\\Software\\RegisteredApplications";

export interface WindowsCommandResult {
  stdout: string;
  stderr: string;
}

export type WindowsCommandRunner = (
  executable: string,
  args: string[],
) => Promise<WindowsCommandResult>;

type WindowsUriLauncher = (uri: string) => Promise<void>;

interface ElectronShellLike {
  shell?: {
    openExternal?: (uri: string) => Promise<void>;
  };
}

async function defaultWindowsUriLauncher(uri: string): Promise<void> {
  const globals = globalThis as unknown as {
    activeWindow?: { require?: (moduleName: string) => unknown };
    window?: { require?: (moduleName: string) => unknown };
    require?: (moduleName: string) => unknown;
  };
  const requireModule = globals.activeWindow?.require ??
    globals.window?.require ??
    globals.require;
  if (!requireModule) {
    throw new Error(t("当前 Electron 环境不支持加载系统 shell。"));
  }

  const electron = requireModule("electron") as ElectronShellLike;
  if (typeof electron.shell?.openExternal !== "function") {
    throw new Error(t("当前 Electron 环境不支持打开系统设置 URI。"));
  }
  await electron.shell.openExternal(uri);
}

export interface WindowsRegistryValue {
  key: string;
  name: string | null;
  type: "REG_SZ" | "REG_NONE";
  data: string;
}

export interface WindowsFileAssociationRegistrationOptions {
  extensions: string[];
  openCommand: string;
  iconPath: string;
  /**
   * Per-extension ICO paths. When an extension has an entry, its association
   * points to a dedicated `ProgId.<ext>` carrying that icon instead of the
   * shared base ProgId (VSCode-style per-format file icons).
   */
  extensionIcons?: Record<string, string>;
  /** Fallback icon for the base ProgId (legacy UserChoice entries). */
  genericIconPath?: string;
}

export type WindowsRegistryInspectionIssueKind =
  | "missing"
  | "type-mismatch"
  | "length-mismatch"
  | "data-mismatch"
  | "read-error"
  | "unexpected";

export interface WindowsRegistryInspectionIssue {
  kind: WindowsRegistryInspectionIssueKind;
  key: string;
  name: string | null;
  label: string;
  expectedType?: WindowsRegistryValue["type"];
  actualType?: string | null;
  expectedData?: string;
  actualData?: string | null;
  expectedByteLength?: number;
  actualByteLength?: number | null;
  errorCode?: number;
  errorMessage?: string;
}

export interface WindowsFileAssociationInspection {
  state: "absent" | "complete" | "incomplete";
  missing: string[];
  issues: WindowsRegistryInspectionIssue[];
}

export interface WindowsCurrentDefaultsResult {
  defaults: Record<string, string | null>;
  errors: Record<string, string>;
}

export class WindowsFileAssociationConflictError extends Error {
  constructor() {
    super(t("检测到已有或残缺的 AIDE Windows 注册；请先清理再重新注入。"));
    this.name = "WindowsFileAssociationConflictError";
  }
}

export class WindowsFileAssociationRollbackError extends AggregateError {
  constructor(
    public readonly installError: unknown,
    public readonly rollbackError: unknown,
  ) {
    const rollbackMessage = rollbackError instanceof Error
      ? rollbackError.message
      : String(rollbackError);
    super(
      [installError, rollbackError],
      t("Windows 文件关联安装失败，且注册表回滚失败：{v0}", { v0: rollbackMessage }),
    );
    this.name = "WindowsFileAssociationRollbackError";
  }
}

interface NativeRegistryValueProbe {
  key: string;
  name: string | null;
  exists: boolean;
  type: string | null;
  byteLength: number | null;
  data: string | null;
  errorCode: number;
  errorMessage: string | null;
}

interface NativeRegistryInspectionReport {
  ok: boolean;
  values?: NativeRegistryValueProbe[];
  ownedReferences?: string[];
  error?: string;
}

export interface WindowsFileAssociationCleanupResult {
  removed: number;
  warnings: string[];
}

interface NativeRegistryCleanupReport {
  ok: boolean;
  removed?: number;
  remainingReferences?: string[];
  error?: string;
}

interface NativeOpenCommandCompareExchangeReport {
  ok: boolean;
  changed: boolean;
  currentCommand: string;
  error?: string;
}

interface RegistryValuesOperationPayload {
  values: WindowsRegistryValue[];
}

interface OpenCommandCompareExchangePayload {
  expectedCommand: string;
  nextCommand: string;
}

type RegistryOperationPayload =
  | RegistryValuesOperationPayload
  | OpenCommandCompareExchangePayload;

async function defaultCommandRunner(
  executable: string,
  args: string[],
): Promise<WindowsCommandResult> {
  try {
    const result = await execFile(executable, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const commandError = error as Error & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    const details = [
      commandError.message,
      commandError.stderr?.trim(),
      commandError.stdout?.trim(),
    ].filter((value): value is string => Boolean(value));
    throw new Error(
      t("{v0} 执行失败{v1}：{v2}", {
        v0: executable,
        v1: commandError.code === undefined ? "" : `（${commandError.code}）`,
        v2: details.join("；"),
      }),
    );
  }
}

function normalizeExtension(extension: string): string {
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9+_-]*$/.test(normalized)) {
    throw new Error(t("非法文件后缀：{v0}", { v0: extension }));
  }
  return normalized;
}

function normalizedExtensions(extensions: string[]): string[] {
  return [...new Set(extensions.map(normalizeExtension))].sort();
}

function extensionOpenWithKey(extension: string): string {
  return `HKCU\\Software\\Classes\\.${extension}\\OpenWithProgids`;
}

function extensionExplorerOpenWithKey(extension: string): string {
  return `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${extension}\\OpenWithProgids`;
}

function registryValueLabel(
  value: Pick<WindowsRegistryValue, "key" | "name">,
): string {
  return `${value.key}\\${value.name ?? "(Default)"}`;
}

function normalizedRegistryLabel(label: string): string {
  return label.toLowerCase();
}

function extensionProgId(progId: string, extension: string): string {
  return `${progId}.${extension}`;
}

export function windowsFileAssociationRegistrationValues(
  options: WindowsFileAssociationRegistrationOptions,
  identity: WindowsFileAssociationIdentity = DEFAULT_WINDOWS_FILE_ASSOCIATION_IDENTITY,
): WindowsRegistryValue[] {
  const icon = `"${options.iconPath}",0`;
  const genericIcon = options.genericIconPath
    ? `"${options.genericIconPath}",0`
    : icon;
  const progIdKey = `HKCU\\Software\\Classes\\${identity.progId}`;
  const capabilitiesKey = `HKCU\\${identity.capabilitiesPath}`;
  const values: WindowsRegistryValue[] = [
    {
      key: progIdKey,
      name: null,
      type: "REG_SZ",
      data: "MV AIDE File",
    },
    {
      key: `${progIdKey}\\Application`,
      name: "ApplicationName",
      type: "REG_SZ",
      data: identity.applicationName,
    },
    {
      key: `${progIdKey}\\Application`,
      name: "ApplicationDescription",
      type: "REG_SZ",
      data: WINDOWS_FILE_OPENER_DESCRIPTION,
    },
    {
      key: `${progIdKey}\\Application`,
      name: "ApplicationCompany",
      type: "REG_SZ",
      data: "MV",
    },
    {
      key: `${progIdKey}\\Application`,
      name: "ApplicationIcon",
      type: "REG_SZ",
      data: icon,
    },
    {
      key: `${progIdKey}\\Application`,
      name: "AppUserModelId",
      type: "REG_SZ",
      data: "",
    },
    {
      key: `${progIdKey}\\DefaultIcon`,
      name: null,
      type: "REG_SZ",
      data: genericIcon,
    },
    {
      key: `${progIdKey}\\shell\\open\\command`,
      name: null,
      type: "REG_SZ",
      data: options.openCommand,
    },
    {
      key: capabilitiesKey,
      name: "ApplicationName",
      type: "REG_SZ",
      data: identity.applicationName,
    },
    {
      key: capabilitiesKey,
      name: "ApplicationDescription",
      type: "REG_SZ",
      data: WINDOWS_FILE_OPENER_DESCRIPTION,
    },
    {
      key: capabilitiesKey,
      name: "ApplicationIcon",
      type: "REG_SZ",
      data: icon,
    },
    {
      key: REGISTERED_APPLICATIONS_KEY,
      name: identity.applicationName,
      type: "REG_SZ",
      data: identity.capabilitiesPath,
    },
  ];

  for (const extension of normalizedExtensions(options.extensions)) {
    const extensionIcon = options.extensionIcons?.[extension];
    const effectiveProgId = extensionIcon
      ? extensionProgId(identity.progId, extension)
      : identity.progId;
    if (extensionIcon) {
      const extensionProgIdKey =
        `HKCU\\Software\\Classes\\${effectiveProgId}`;
      values.push(
        {
          key: extensionProgIdKey,
          name: null,
          type: "REG_SZ",
          data: "MV AIDE File",
        },
        // Application identity must live on the ProgId that FileAssociations
        // points at; without it the Settings default-apps picker falls back
        // to the open-command executable identity ("Windows Based Script
        // Host") instead of showing "MV AIDE File Opener".
        {
          key: `${extensionProgIdKey}\\Application`,
          name: "ApplicationName",
          type: "REG_SZ",
          data: identity.applicationName,
        },
        {
          key: `${extensionProgIdKey}\\Application`,
          name: "ApplicationDescription",
          type: "REG_SZ",
          data: WINDOWS_FILE_OPENER_DESCRIPTION,
        },
        {
          key: `${extensionProgIdKey}\\Application`,
          name: "ApplicationCompany",
          type: "REG_SZ",
          data: "MV",
        },
        {
          key: `${extensionProgIdKey}\\Application`,
          name: "ApplicationIcon",
          type: "REG_SZ",
          data: `"${extensionIcon}",0`,
        },
        {
          key: `${extensionProgIdKey}\\Application`,
          name: "AppUserModelId",
          type: "REG_SZ",
          data: "",
        },
        {
          key: `${extensionProgIdKey}\\DefaultIcon`,
          name: null,
          type: "REG_SZ",
          data: `"${extensionIcon}",0`,
        },
        {
          key: `${extensionProgIdKey}\\shell\\open\\command`,
          name: null,
          type: "REG_SZ",
          data: options.openCommand,
        },
      );
    }
    values.push(
      {
        key: `${capabilitiesKey}\\FileAssociations`,
        name: `.${extension}`,
        type: "REG_SZ",
        data: effectiveProgId,
      },
      {
        key: extensionOpenWithKey(extension),
        name: effectiveProgId,
        type: "REG_SZ",
        data: "",
      },
      {
        key: extensionExplorerOpenWithKey(extension),
        name: effectiveProgId,
        type: "REG_NONE",
        data: "",
      },
    );
  }

  return values;
}

function issueForProbe(
  expected: WindowsRegistryValue,
  actual: NativeRegistryValueProbe | undefined,
): WindowsRegistryInspectionIssue | null {
  const label = registryValueLabel(expected);
  if (!actual) {
    return {
      kind: "read-error",
      key: expected.key,
      name: expected.name,
      label,
      expectedType: expected.type,
      errorMessage: t("原生注册表检查没有返回该值。"),
    };
  }
  if (actual.errorCode !== 0) {
    return {
      kind: "read-error",
      key: expected.key,
      name: expected.name,
      label,
      expectedType: expected.type,
      actualType: actual.type,
      actualByteLength: actual.byteLength,
      errorCode: actual.errorCode,
      errorMessage: actual.errorMessage ?? undefined,
    };
  }
  if (!actual.exists) {
    return {
      kind: "missing",
      key: expected.key,
      name: expected.name,
      label,
      expectedType: expected.type,
    };
  }
  if (actual.type !== expected.type) {
    return {
      kind: "type-mismatch",
      key: expected.key,
      name: expected.name,
      label,
      expectedType: expected.type,
      actualType: actual.type,
      actualByteLength: actual.byteLength,
    };
  }
  if (expected.type === "REG_NONE" && actual.byteLength !== 0) {
    return {
      kind: "length-mismatch",
      key: expected.key,
      name: expected.name,
      label,
      expectedType: expected.type,
      actualType: actual.type,
      expectedByteLength: 0,
      actualByteLength: actual.byteLength,
    };
  }
  if (expected.type === "REG_SZ" && actual.data !== expected.data) {
    return {
      kind: "data-mismatch",
      key: expected.key,
      name: expected.name,
      label,
      expectedType: expected.type,
      actualType: actual.type,
      expectedData: expected.data,
      actualData: actual.data,
    };
  }
  return null;
}

function inspectionFromReport(
  expected: WindowsRegistryValue[],
  report: NativeRegistryInspectionReport,
): WindowsFileAssociationInspection {
  if (!report.ok) {
    throw new Error(t("Windows 原生注册表检查失败：{v0}", { v0: report.error ?? t("未知错误") }));
  }

  const actualByLabel = new Map(
    (report.values ?? []).map((value) => [
      normalizedRegistryLabel(registryValueLabel(value)),
      value,
    ]),
  );
  const expectedLabels = new Set(
    expected.map((value) => normalizedRegistryLabel(registryValueLabel(value))),
  );
  const issues = expected
    .map((value) =>
      issueForProbe(
        value,
        actualByLabel.get(normalizedRegistryLabel(registryValueLabel(value))),
      ),
    )
    .filter((issue): issue is WindowsRegistryInspectionIssue => issue !== null);

  for (const reference of report.ownedReferences ?? []) {
    if (!expectedLabels.has(normalizedRegistryLabel(reference))) {
      issues.push({
        kind: "unexpected",
        key: reference,
        name: null,
        label: reference,
      });
    }
  }

  const present = (report.values ?? []).some((value) => value.exists) ||
    (report.ownedReferences?.length ?? 0) > 0;
  const hasReadError = issues.some((issue) => issue.kind === "read-error");
  const state = !present && !hasReadError
    ? "absent"
    : issues.length === 0
      ? "complete"
      : "incomplete";
  return {
    state,
    missing: issues.map((issue) => issue.label),
    issues,
  };
}

function issueDescription(issue: WindowsRegistryInspectionIssue): string {
  switch (issue.kind) {
    case "missing":
      return t("{v0}：缺失（预期 {v1}）", { v0: issue.label, v1: issue.expectedType ?? t("未知") });
    case "type-mismatch":
      return t("{v0}：预期 {v1}，实际 {v2}", { v0: issue.label, v1: issue.expectedType ?? t("未知"), v2: issue.actualType ?? t("未知类型") });
    case "length-mismatch":
      return t("{v0}：预期 {v1}/0 字节，实际 {v2}/{v3} 字节", { v0: issue.label, v1: issue.expectedType ?? t("未知"), v2: issue.actualType ?? t("未知类型"), v3: issue.actualByteLength ?? t("未知") });
    case "data-mismatch":
      return t("{v0}：REG_SZ 内容与当前注入配置不一致", { v0: issue.label });
    case "read-error":
      return t("{v0}：读取失败{v1}{v2}", {
        v0: issue.label,
        v1: issue.errorCode === undefined ? "" : `（Win32 ${issue.errorCode}）`,
        v2: issue.errorMessage ? ` ${issue.errorMessage}` : "",
      });
    case "unexpected":
      return t("{v0}：发现当前配置之外的 AIDE 残留", { v0: issue.label });
  }
}

export function describeWindowsRegistryIssues(
  issues: WindowsRegistryInspectionIssue[],
): string {
  return issues.map(issueDescription).join("；");
}

function csharpStringLiteral(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) {
    throw new Error(t("Windows 文件关联身份不能包含控制字符。"));
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function windowsAssociationHelperScript(
  identity: WindowsFileAssociationIdentity = DEFAULT_WINDOWS_FILE_ASSOCIATION_IDENTITY,
): string {
  return String.raw`param(
  [Parameter(Mandatory = $true)][ValidateSet("ApplyRegistration", "InspectRegistration", "CleanupRegistration", "CompareExchangeOpenCommand", "QueryDefault", "Notify")][string]$Action,
  [string]$PayloadPath = "",
  [string]$Extension = ""
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

public enum MvAssociationType {
    FileExtension = 0,
    UrlProtocol = 1,
    StartMenuClient = 2,
    MimeType = 3
}

public enum MvAssociationLevel {
    Machine = 0,
    Effective = 1,
    User = 2
}

[ComImport]
[Guid("4e530b0a-e611-4c77-a3ac-9031d022281b")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMvApplicationAssociationRegistration {
    [PreserveSig]
    int QueryCurrentDefault(
        [MarshalAs(UnmanagedType.LPWStr)] string query,
        MvAssociationType queryType,
        MvAssociationLevel queryLevel,
        [MarshalAs(UnmanagedType.LPWStr)] out string association);
}

public sealed class MvRegistryProbe {
    public bool Exists { get; set; }
    public uint Type { get; set; }
    public int ByteLength { get; set; }
    public string StringData { get; set; }
    public int ErrorCode { get; set; }
    public string ErrorMessage { get; set; }
}

public sealed class MvOpenCommandCompareExchangeResult {
    public bool Changed { get; set; }
    public string CurrentCommand { get; set; }
}

public sealed class MvRegistryCleanupResult {
    public int Removed { get; set; }
    public string[] RemainingReferences { get; set; }
}

public static class MvAideAssociationNative {
    private const int ERROR_SUCCESS = 0;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const int ERROR_PATH_NOT_FOUND = 3;
    private const int ERROR_NO_ASSOCIATION_HRESULT = unchecked((int)0x80070483);
    private const int KEY_QUERY_VALUE = 0x0001;
    private const int KEY_SET_VALUE = 0x0002;
    private const int KEY_CREATE_SUB_KEY = 0x0004;
    private const uint REG_NONE = 0;
    private const uint REG_SZ = 1;
    private const string ProgId = "${csharpStringLiteral(identity.progId)}";
    private const string ApplicationName = "${csharpStringLiteral(identity.applicationName)}";
    private const string RegisteredApplicationsSubKey =
        "Software\\RegisteredApplications";
    private const string ClassesRoot = "Software\\Classes";
    private const string ExplorerFileExtsRoot =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts";
    private const string CapabilitiesSubKey =
        "${csharpStringLiteral(identity.capabilitiesPath)}";
    private const string CapabilitiesFileAssociationsSubKey =
        CapabilitiesSubKey + "\\FileAssociations";
    private const string ProgIdSubKey = "Software\\Classes\\${csharpStringLiteral(identity.progId)}";
    private const string OpenCommandSubKey =
        ProgIdSubKey + "\\shell\\open\\command";
    private static readonly IntPtr HKeyCurrentUser =
        new IntPtr(unchecked((int)0x80000001));
    private static readonly Guid AssociationRegistrationIid =
        new Guid("4e530b0a-e611-4c77-a3ac-9031d022281b");

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegCreateKeyExW(
        IntPtr hKey,
        string lpSubKey,
        uint reserved,
        string lpClass,
        uint options,
        int samDesired,
        IntPtr securityAttributes,
        out IntPtr result,
        out uint disposition);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegOpenKeyExW(
        IntPtr hKey,
        string lpSubKey,
        uint options,
        int samDesired,
        out IntPtr result);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegSetValueExW(
        IntPtr hKey,
        string valueName,
        uint reserved,
        uint type,
        IntPtr data,
        uint dataSize);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegQueryValueExW(
        IntPtr hKey,
        string valueName,
        IntPtr reserved,
        out uint type,
        IntPtr data,
        ref uint dataSize);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegQueryValueExW")]
    private static extern int RegQueryValueBytes(
        IntPtr hKey,
        string valueName,
        IntPtr reserved,
        out uint type,
        byte[] data,
        ref uint dataSize);

    [DllImport("advapi32.dll")]
    private static extern int RegCloseKey(IntPtr hKey);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHCreateAssociationRegistration(
        ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IMvApplicationAssociationRegistration registration);

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(
        uint eventId,
        uint flags,
        IntPtr item1,
        IntPtr item2);

    private static string NormalizeSubKey(string key) {
        const string prefix = "HKCU\\";
        if (String.IsNullOrEmpty(key) ||
            !key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) {
            throw new ArgumentException("Only HKCU registry paths are allowed.");
        }
        string subKey = key.Substring(prefix.Length);
        if (!subKey.StartsWith("Software\\Classes\\", StringComparison.OrdinalIgnoreCase) &&
            !subKey.Equals("Software\\RegisteredApplications", StringComparison.OrdinalIgnoreCase) &&
            !subKey.Equals(CapabilitiesSubKey, StringComparison.OrdinalIgnoreCase) &&
            !subKey.StartsWith(CapabilitiesSubKey + "\\", StringComparison.OrdinalIgnoreCase) &&
            !subKey.StartsWith(ExplorerFileExtsRoot + "\\", StringComparison.OrdinalIgnoreCase)) {
            throw new ArgumentException("Registry path is outside the AIDE association allowlist: " + key);
        }
        return subKey;
    }

    private static bool IsMissing(int result) {
        return result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND;
    }

    private static string ErrorText(int result) {
        return new System.ComponentModel.Win32Exception(result).Message;
    }

    public static void SetString(string key, string name, string data) {
        string subKey = NormalizeSubKey(key);
        using (RegistryKey registryKey = Registry.CurrentUser.CreateSubKey(subKey, true)) {
            if (registryKey == null) {
                throw new InvalidOperationException("Could not create registry key: " + key);
            }
            registryKey.SetValue(name ?? String.Empty, data ?? String.Empty, RegistryValueKind.String);
        }
    }

    public static void SetEmptyNone(string key, string name) {
        string subKey = NormalizeSubKey(key);
        IntPtr registryKey;
        uint disposition;
        int result = RegCreateKeyExW(
            HKeyCurrentUser,
            subKey,
            0,
            null,
            0,
            KEY_SET_VALUE | KEY_CREATE_SUB_KEY,
            IntPtr.Zero,
            out registryKey,
            out disposition);
        if (result != ERROR_SUCCESS) {
            throw new InvalidOperationException("RegCreateKeyExW failed (" + result + "): " + ErrorText(result));
        }
        try {
            result = RegSetValueExW(registryKey, name, 0, REG_NONE, IntPtr.Zero, 0);
            if (result != ERROR_SUCCESS) {
                throw new InvalidOperationException("RegSetValueExW failed (" + result + "): " + ErrorText(result));
            }
        } finally {
            RegCloseKey(registryKey);
        }
    }

    public static MvRegistryProbe Probe(string key, string name) {
        string subKey;
        try {
            subKey = NormalizeSubKey(key);
        } catch (Exception error) {
            return new MvRegistryProbe {
                Exists = false,
                Type = UInt32.MaxValue,
                ByteLength = -1,
                StringData = null,
                ErrorCode = -1,
                ErrorMessage = error.Message
            };
        }

        IntPtr registryKey;
        int result = RegOpenKeyExW(HKeyCurrentUser, subKey, 0, KEY_QUERY_VALUE, out registryKey);
        if (IsMissing(result)) {
            return new MvRegistryProbe { Exists = false, ErrorCode = 0, ByteLength = 0 };
        }
        if (result != ERROR_SUCCESS) {
            return new MvRegistryProbe {
                Exists = false,
                ErrorCode = result,
                ErrorMessage = ErrorText(result),
                ByteLength = -1
            };
        }

        try {
            uint type;
            uint dataSize = 0;
            result = RegQueryValueExW(
                registryKey,
                name,
                IntPtr.Zero,
                out type,
                IntPtr.Zero,
                ref dataSize);
            if (IsMissing(result)) {
                return new MvRegistryProbe { Exists = false, ErrorCode = 0, ByteLength = 0 };
            }
            if (result != ERROR_SUCCESS) {
                return new MvRegistryProbe {
                    Exists = false,
                    ErrorCode = result,
                    ErrorMessage = ErrorText(result),
                    ByteLength = -1
                };
            }

            string stringData = null;
            if (type == REG_SZ) {
                byte[] bytes = new byte[dataSize];
                uint actualSize = dataSize;
                uint actualType;
                result = RegQueryValueBytes(
                    registryKey,
                    name,
                    IntPtr.Zero,
                    out actualType,
                    bytes,
                    ref actualSize);
                if (result != ERROR_SUCCESS) {
                    return new MvRegistryProbe {
                        Exists = true,
                        Type = type,
                        ByteLength = (int)dataSize,
                        ErrorCode = result,
                        ErrorMessage = ErrorText(result)
                    };
                }
                stringData = Encoding.Unicode.GetString(bytes, 0, (int)actualSize).TrimEnd('\0');
            }
            return new MvRegistryProbe {
                Exists = true,
                Type = type,
                ByteLength = (int)dataSize,
                StringData = stringData,
                ErrorCode = 0,
                ErrorMessage = null
            };
        } finally {
            RegCloseKey(registryKey);
        }
    }

    private static bool HasNamedValue(RegistryKey key, string valueName) {
        if (key == null) return false;
        foreach (string name in key.GetValueNames()) {
            if (name.Equals(valueName, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static bool ProgIdMatches(string candidate) {
        return candidate.Equals(ProgId, StringComparison.OrdinalIgnoreCase) ||
            candidate.StartsWith(ProgId + ".", StringComparison.OrdinalIgnoreCase);
    }

    private static List<string> FindOwnedProgIdValueNames(RegistryKey key) {
        List<string> names = new List<string>();
        if (key == null) return names;
        foreach (string name in key.GetValueNames()) {
            if (ProgIdMatches(name)) names.Add(name);
        }
        return names;
    }

    private static List<string> FindExtensionProgIdTrees() {
        List<string> trees = new List<string>();
        using (RegistryKey classes = Registry.CurrentUser.OpenSubKey(ClassesRoot, false)) {
            if (classes == null) return trees;
            foreach (string subKeyName in classes.GetSubKeyNames()) {
                if (subKeyName.StartsWith(ProgId + ".", StringComparison.OrdinalIgnoreCase)) {
                    trees.Add(ClassesRoot + "\\" + subKeyName);
                }
            }
        }
        return trees;
    }

    public static MvOpenCommandCompareExchangeResult CompareExchangeOpenCommand(
        string expectedCommand,
        string nextCommand) {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(OpenCommandSubKey, true)) {
            if (key == null || !HasNamedValue(key, String.Empty)) {
                throw new InvalidOperationException(
                    "The AIDE open command default value is missing.");
            }
            if (key.GetValueKind(String.Empty) != RegistryValueKind.String) {
                throw new InvalidOperationException(
                    "The AIDE open command default value is not REG_SZ.");
            }

            string currentCommand = key.GetValue(
                String.Empty,
                null,
                RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            if (currentCommand == null) {
                throw new InvalidOperationException(
                    "The AIDE open command REG_SZ value could not be read.");
            }
            if (String.Equals(currentCommand, nextCommand, StringComparison.Ordinal)) {
                return new MvOpenCommandCompareExchangeResult {
                    Changed = false,
                    CurrentCommand = currentCommand
                };
            }
            if (!String.Equals(currentCommand, expectedCommand, StringComparison.Ordinal)) {
                throw new InvalidOperationException(
                    "The AIDE open command changed before migration.");
            }

            key.SetValue(String.Empty, nextCommand, RegistryValueKind.String);
            if (!HasNamedValue(key, String.Empty) ||
                key.GetValueKind(String.Empty) != RegistryValueKind.String) {
                throw new InvalidOperationException(
                    "The AIDE open command write verification failed.");
            }
            string verifiedCommand = key.GetValue(
                String.Empty,
                null,
                RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            if (!String.Equals(verifiedCommand, nextCommand, StringComparison.Ordinal)) {
                throw new InvalidOperationException(
                    "The AIDE open command write verification failed.");
            }
            return new MvOpenCommandCompareExchangeResult {
                Changed = true,
                CurrentCommand = verifiedCommand
            };
        }
    }

    public static string[] FindOwnedExtensionReferences() {
        List<string> references = new List<string>();
        using (RegistryKey associations = Registry.CurrentUser.OpenSubKey(CapabilitiesFileAssociationsSubKey, false)) {
            if (associations != null) {
                foreach (string extension in associations.GetValueNames()) {
                    object value = associations.GetValue(
                        extension,
                        null,
                        RegistryValueOptions.DoNotExpandEnvironmentNames);
                    if (value is string && ProgIdMatches((string)value)) {
                        references.Add("HKCU\\" + CapabilitiesFileAssociationsSubKey + "\\" + extension);
                    }
                }
            }
        }
        using (RegistryKey classes = Registry.CurrentUser.OpenSubKey(ClassesRoot, false)) {
            if (classes != null) {
                foreach (string extension in classes.GetSubKeyNames()) {
                    if (!extension.StartsWith(".", StringComparison.Ordinal)) continue;
                    try {
                        using (RegistryKey openWith = classes.OpenSubKey(extension + "\\OpenWithProgids", false)) {
                            foreach (string ownedName in FindOwnedProgIdValueNames(openWith)) {
                                references.Add("HKCU\\" + ClassesRoot + "\\" + extension + "\\OpenWithProgids\\" + ownedName);
                            }
                        }
                        using (RegistryKey extensionKey = classes.OpenSubKey(extension, false)) {
                            object value = extensionKey == null
                                ? null
                                : extensionKey.GetValue(null, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                            if (value is string && ProgIdMatches((string)value)) {
                                references.Add("HKCU\\" + ClassesRoot + "\\" + extension + "\\(Default)");
                            }
                        }
                    } catch (UnauthorizedAccessException) {
                        // An unreadable unrelated extension must not block owned cleanup.
                    } catch (System.Security.SecurityException) {
                        // An unreadable unrelated extension must not block owned cleanup.
                    }
                }
            }
        }
        using (RegistryKey fileExts = Registry.CurrentUser.OpenSubKey(ExplorerFileExtsRoot, false)) {
            if (fileExts != null) {
                foreach (string extension in fileExts.GetSubKeyNames()) {
                    if (!extension.StartsWith(".", StringComparison.Ordinal)) continue;
                    try {
                        using (RegistryKey openWith = fileExts.OpenSubKey(extension + "\\OpenWithProgids", false)) {
                            foreach (string ownedName in FindOwnedProgIdValueNames(openWith)) {
                                references.Add("HKCU\\" + ExplorerFileExtsRoot + "\\" + extension + "\\OpenWithProgids\\" + ownedName);
                            }
                        }
                    } catch (UnauthorizedAccessException) {
                        // An unreadable unrelated extension must not block owned cleanup.
                    } catch (System.Security.SecurityException) {
                        // An unreadable unrelated extension must not block owned cleanup.
                    }
                }
            }
        }
        return references.ToArray();
    }

    private static bool DeleteNamedValueIfPresent(string subKey, string valueName) {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(subKey, true)) {
            if (key == null || !HasNamedValue(key, valueName)) return false;
            key.DeleteValue(valueName, false);
            return true;
        }
    }

    private static bool DeleteDefaultValueIfOwned(string subKey) {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(subKey, true)) {
            if (key == null || !HasNamedValue(key, String.Empty)) return false;
            object value = key.GetValue(
                null,
                null,
                RegistryValueOptions.DoNotExpandEnvironmentNames);
            if (!(value is string) || !ProgIdMatches((string)value)) {
                return false;
            }
            key.DeleteValue(String.Empty, false);
            return true;
        }
    }

    private static HashSet<string> FindClaimedExtensions() {
        HashSet<string> extensions = new HashSet<string>(
            StringComparer.OrdinalIgnoreCase);
        using (RegistryKey associations = Registry.CurrentUser.OpenSubKey(
            CapabilitiesFileAssociationsSubKey,
            false)) {
            if (associations == null) return extensions;
            foreach (string extension in associations.GetValueNames()) {
                object value = associations.GetValue(
                    extension,
                    null,
                    RegistryValueOptions.DoNotExpandEnvironmentNames);
                if (value is string &&
                    ProgIdMatches((string)value)) {
                    extensions.Add(extension);
                }
            }
        }
        return extensions;
    }

    public static int RemoveOwnedExtensionReferences() {
        int removed = 0;
        HashSet<string> claimedExtensions = FindClaimedExtensions();
        using (RegistryKey classes = Registry.CurrentUser.OpenSubKey(ClassesRoot, false)) {
            if (classes != null) {
                foreach (string extension in classes.GetSubKeyNames()) {
                    if (!extension.StartsWith(".", StringComparison.Ordinal)) continue;
                    string extensionSubKey = ClassesRoot + "\\" + extension;
                    string openWithSubKey = extensionSubKey + "\\OpenWithProgids";
                    List<string> ownedOpenWithNames = new List<string>();
                    bool ownsDefault = false;
                    try {
                        using (RegistryKey openWith = Registry.CurrentUser.OpenSubKey(openWithSubKey, false)) {
                            ownedOpenWithNames = FindOwnedProgIdValueNames(openWith);
                        }
                        using (RegistryKey extensionKey = Registry.CurrentUser.OpenSubKey(extensionSubKey, false)) {
                            object value = extensionKey == null
                                ? null
                                : extensionKey.GetValue(null, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                            ownsDefault = value is string &&
                                ProgIdMatches((string)value);
                        }
                    } catch (UnauthorizedAccessException) {
                        if (claimedExtensions.Contains(extension)) throw;
                        // An unreadable unrelated extension must not block owned cleanup.
                        continue;
                    } catch (System.Security.SecurityException) {
                        if (claimedExtensions.Contains(extension)) throw;
                        // An unreadable unrelated extension must not block owned cleanup.
                        continue;
                    }
                    foreach (string ownedName in ownedOpenWithNames) {
                        if (DeleteNamedValueIfPresent(openWithSubKey, ownedName)) {
                            removed++;
                        }
                    }
                    if (ownsDefault && DeleteDefaultValueIfOwned(extensionSubKey)) {
                        removed++;
                    }
                }
            }
        }
        using (RegistryKey fileExts = Registry.CurrentUser.OpenSubKey(ExplorerFileExtsRoot, false)) {
            if (fileExts != null) {
                foreach (string extension in fileExts.GetSubKeyNames()) {
                    if (!extension.StartsWith(".", StringComparison.Ordinal)) continue;
                    string openWithSubKey = ExplorerFileExtsRoot + "\\" + extension +
                        "\\OpenWithProgids";
                    List<string> ownedOpenWithNames = new List<string>();
                    try {
                        using (RegistryKey openWith = Registry.CurrentUser.OpenSubKey(openWithSubKey, false)) {
                            ownedOpenWithNames = FindOwnedProgIdValueNames(openWith);
                        }
                    } catch (UnauthorizedAccessException) {
                        if (claimedExtensions.Contains(extension)) throw;
                        // An unreadable unrelated extension must not block owned cleanup.
                        continue;
                    } catch (System.Security.SecurityException) {
                        if (claimedExtensions.Contains(extension)) throw;
                        // An unreadable unrelated extension must not block owned cleanup.
                        continue;
                    }
                    foreach (string ownedName in ownedOpenWithNames) {
                        if (DeleteNamedValueIfPresent(openWithSubKey, ownedName)) {
                            removed++;
                        }
                    }
                }
            }
        }
        return removed;
    }

    private static bool DeleteOwnedTreeBySubKey(string subKey) {
        if (!subKey.Equals(CapabilitiesSubKey, StringComparison.OrdinalIgnoreCase) &&
            !subKey.Equals(ProgIdSubKey, StringComparison.OrdinalIgnoreCase) &&
            !subKey.StartsWith(ProgIdSubKey + ".", StringComparison.OrdinalIgnoreCase)) {
            throw new ArgumentException(
                "Refusing to delete a non-owned registry tree: " + subKey);
        }
        using (RegistryKey existing = Registry.CurrentUser.OpenSubKey(subKey, false)) {
            if (existing == null) return false;
        }
        Registry.CurrentUser.DeleteSubKeyTree(subKey, false);
        return true;
    }

    public static string[] FindOwnedRegistrationReferences() {
        List<string> references = new List<string>(FindOwnedExtensionReferences());
        using (RegistryKey registeredApplications = Registry.CurrentUser.OpenSubKey(
            RegisteredApplicationsSubKey,
            false)) {
            if (HasNamedValue(registeredApplications, ApplicationName)) {
                references.Add("HKCU\\" + RegisteredApplicationsSubKey + "\\" + ApplicationName);
            }
        }
        using (RegistryKey capabilities = Registry.CurrentUser.OpenSubKey(
            CapabilitiesSubKey,
            false)) {
            if (capabilities != null) {
                references.Add("HKCU\\" + CapabilitiesSubKey);
            }
        }
        using (RegistryKey progId = Registry.CurrentUser.OpenSubKey(ProgIdSubKey, false)) {
            if (progId != null) {
                references.Add("HKCU\\" + ProgIdSubKey);
            }
        }
        foreach (string extensionTree in FindExtensionProgIdTrees()) {
            references.Add("HKCU\\" + extensionTree);
        }
        return references.ToArray();
    }

    public static MvRegistryCleanupResult CleanupRegistration() {
        int removed = RemoveOwnedExtensionReferences();
        if (DeleteNamedValueIfPresent(RegisteredApplicationsSubKey, ApplicationName)) {
            removed++;
        }
        if (DeleteOwnedTreeBySubKey(CapabilitiesSubKey)) removed++;
        foreach (string extensionTree in FindExtensionProgIdTrees()) {
            if (DeleteOwnedTreeBySubKey(extensionTree)) removed++;
        }
        if (DeleteOwnedTreeBySubKey(ProgIdSubKey)) removed++;
        return new MvRegistryCleanupResult {
            Removed = removed,
            RemainingReferences = FindOwnedRegistrationReferences()
        };
    }

    public static string QueryCurrentDefault(string extension) {
        Guid iid = AssociationRegistrationIid;
        IMvApplicationAssociationRegistration registration;
        int result = SHCreateAssociationRegistration(ref iid, out registration);
        Marshal.ThrowExceptionForHR(result);
        try {
            string association;
            result = registration.QueryCurrentDefault(
                extension,
                MvAssociationType.FileExtension,
                MvAssociationLevel.Effective,
                out association);
            if (result == ERROR_NO_ASSOCIATION_HRESULT) {
                return null;
            }
            Marshal.ThrowExceptionForHR(result);
            return association;
        } finally {
            if (registration != null && Marshal.IsComObject(registration)) {
                Marshal.FinalReleaseComObject(registration);
            }
        }
    }

    public static void NotifyAssociationChanged() {
        const uint SHCNE_ASSOCCHANGED = 0x08000000;
        const uint SHCNF_IDLIST = 0x0000;
        const uint SHCNF_FLUSH = 0x1000;
        SHChangeNotify(
            SHCNE_ASSOCCHANGED,
            SHCNF_IDLIST | SHCNF_FLUSH,
            IntPtr.Zero,
            IntPtr.Zero);
    }
}
"@

function Write-Json($Value) {
  $Value | ConvertTo-Json -Compress -Depth 8
}

function Read-Payload {
  if ([string]::IsNullOrWhiteSpace($PayloadPath)) {
    throw "Registry operation payload path is missing."
  }
  return Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Registry-TypeName([uint32]$Type) {
  if ($Type -eq 0) { return "REG_NONE" }
  if ($Type -eq 1) { return "REG_SZ" }
  return "REG_$Type"
}

function Probe-Value($Value) {
  $Probe = [MvAideAssociationNative]::Probe([string]$Value.key, $Value.name)
  return [ordered]@{
    key = [string]$Value.key
    name = $Value.name
    exists = [bool]$Probe.Exists
    type = if ($Probe.Exists) { Registry-TypeName $Probe.Type } else { $null }
    byteLength = if ($Probe.ByteLength -ge 0) { [int]$Probe.ByteLength } else { $null }
    data = $Probe.StringData
    errorCode = [int]$Probe.ErrorCode
    errorMessage = $Probe.ErrorMessage
  }
}

function Inspect-Payload($Payload) {
  $Values = @()
  foreach ($Value in @($Payload.values)) {
    $Values += Probe-Value $Value
  }
  return [ordered]@{
    ok = $true
    values = $Values
    ownedReferences = @([MvAideAssociationNative]::FindOwnedExtensionReferences())
  }
}

if ($Action -eq "Notify") {
  [MvAideAssociationNative]::NotifyAssociationChanged()
  exit 0
}

if ($Action -eq "QueryDefault") {
  try {
    $ProgId = [MvAideAssociationNative]::QueryCurrentDefault($Extension)
    Write-Json @{ extension = $Extension; progId = $ProgId }
  } catch {
    Write-Json @{ extension = $Extension; error = $_.Exception.Message }
    exit 2
  }
  exit 0
}

try {
  $Payload = Read-Payload
  if ($Action -eq "CompareExchangeOpenCommand") {
    if (
      $Payload.expectedCommand -isnot [string] -or
      $Payload.nextCommand -isnot [string]
    ) {
      throw "Open command compare-exchange requires string expectedCommand and nextCommand values."
    }
    $Result = [MvAideAssociationNative]::CompareExchangeOpenCommand(
      [string]$Payload.expectedCommand,
      [string]$Payload.nextCommand)
    Write-Json ([ordered]@{
      ok = $true
      changed = [bool]$Result.Changed
      currentCommand = [string]$Result.CurrentCommand
    })
    exit 0
  }

  if ($Action -eq "ApplyRegistration") {
    foreach ($Value in @($Payload.values)) {
      if ([string]$Value.type -eq "REG_SZ") {
        [MvAideAssociationNative]::SetString(
          [string]$Value.key,
          $Value.name,
          [string]$Value.data)
      } elseif ([string]$Value.type -eq "REG_NONE") {
        [MvAideAssociationNative]::SetEmptyNone(
          [string]$Value.key,
          [string]$Value.name)
      } else {
        throw "Unsupported registry value type: $($Value.type)"
      }
    }
    Write-Json (Inspect-Payload $Payload)
    exit 0
  }

  if ($Action -eq "InspectRegistration") {
    Write-Json (Inspect-Payload $Payload)
    exit 0
  }

  if ($Action -eq "CleanupRegistration") {
    $Result = [MvAideAssociationNative]::CleanupRegistration()
    Write-Json ([ordered]@{
      ok = $true
      removed = [int]$Result.Removed
      remainingReferences = @($Result.RemainingReferences)
    })
    exit 0
  }

  throw "Unsupported registry operation: $Action"
} catch {
  Write-Json ([ordered]@{ ok = $false; error = $_.Exception.Message })
  exit 0
}
`;
}

export class WindowsFileAssociations {
  constructor(
    private readonly powerShellExecutable: string,
    private readonly runner: WindowsCommandRunner = defaultCommandRunner,
    private readonly launchUri: WindowsUriLauncher = defaultWindowsUriLauncher,
    private readonly identity: WindowsFileAssociationIdentity =
      DEFAULT_WINDOWS_FILE_ASSOCIATION_IDENTITY,
  ) {}

  async inspect(
    options: WindowsFileAssociationRegistrationOptions,
    helperPath: string,
  ): Promise<WindowsFileAssociationInspection> {
    const expected = windowsFileAssociationRegistrationValues(options, this.identity);
    const report = await this.runRegistryAction<NativeRegistryInspectionReport>(
      "InspectRegistration",
      helperPath,
      { values: expected },
    );
    return inspectionFromReport(expected, report);
  }

  async install(
    options: WindowsFileAssociationRegistrationOptions,
    helperPath: string,
  ): Promise<void> {
    const inspection = await this.inspect(options, helperPath);
    if (inspection.state !== "absent") {
      throw new WindowsFileAssociationConflictError();
    }

    const values = windowsFileAssociationRegistrationValues(options, this.identity);
    try {
      const report = await this.runRegistryAction<NativeRegistryInspectionReport>(
        "ApplyRegistration",
        helperPath,
        { values },
      );
      const verified = inspectionFromReport(values, report);
      if (verified.state !== "complete") {
        throw new Error(
          t("Windows 注册写入后校验失败：{v0}", { v0: describeWindowsRegistryIssues(verified.issues) }),
        );
      }
      await this.notifyAssociationChanged(helperPath);
    } catch (installError) {
      try {
        await this.rollbackRegistration(helperPath);
      } catch (rollbackError) {
        throw new WindowsFileAssociationRollbackError(
          installError,
          rollbackError,
        );
      }
      throw installError;
    }
  }

  /**
   * Rewrites an already-owned registration only when it still exactly matches
   * the caller's observed definition. This is used for path-authority
   * migrations where ProgIds and effective user choices must remain intact.
   */
  async replaceOwnedRegistration(
    current: WindowsFileAssociationRegistrationOptions,
    next: WindowsFileAssociationRegistrationOptions,
    helperPath: string,
  ): Promise<void> {
    const currentInspection = await this.inspect(current, helperPath);
    if (currentInspection.state !== "complete") {
      throw new Error(
        t("Windows 打开器注册在路径迁移前已发生变化：{v0}", {
          v0: describeWindowsRegistryIssues(currentInspection.issues),
        }),
      );
    }

    const currentValues = windowsFileAssociationRegistrationValues(
      current,
      this.identity,
    );
    const nextValues = windowsFileAssociationRegistrationValues(next, this.identity);
    try {
      const report = await this.runRegistryAction<NativeRegistryInspectionReport>(
        "ApplyRegistration",
        helperPath,
        { values: nextValues },
      );
      const verified = inspectionFromReport(nextValues, report);
      if (verified.state !== "complete") {
        throw new Error(
          t("Windows 打开器路径迁移写入后校验失败：{v0}", {
            v0: describeWindowsRegistryIssues(verified.issues),
          }),
        );
      }
      await this.notifyAssociationChanged(helperPath);
    } catch (migrationError) {
      try {
        const rollbackReport =
          await this.runRegistryAction<NativeRegistryInspectionReport>(
            "ApplyRegistration",
            helperPath,
            { values: currentValues },
          );
        const rolledBack = inspectionFromReport(currentValues, rollbackReport);
        if (rolledBack.state !== "complete") {
          throw new Error(
            t("Windows 打开器路径迁移回滚校验失败：{v0}", {
              v0: describeWindowsRegistryIssues(rolledBack.issues),
            }),
          );
        }
        await this.notifyAssociationChanged(helperPath).catch(() => undefined);
      } catch (rollbackError) {
        throw new AggregateError(
          [migrationError, rollbackError],
          t("Windows 打开器路径迁移失败，且未能验证旧注册已恢复。"),
        );
      }
      throw migrationError;
    }
  }

  async queryCurrentDefaults(
    helperPath: string,
    extensions: string[],
  ): Promise<WindowsCurrentDefaultsResult> {
    const defaults: Record<string, string | null> = {};
    const errors: Record<string, string> = {};
    for (const extension of normalizedExtensions(extensions)) {
      try {
        const result = await this.runner(this.powerShellExecutable, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helperPath,
          "-Action",
          "QueryDefault",
          "-Extension",
          `.${extension}`,
        ]);
        const parsed = JSON.parse(result.stdout.trim()) as {
          progId?: string | null;
          error?: string;
        };
        if (parsed.error) {
          errors[extension] = parsed.error;
        } else {
          defaults[extension] = parsed.progId ?? null;
        }
      } catch (error) {
        errors[extension] = error instanceof Error ? error.message : String(error);
      }
    }
    return { defaults, errors };
  }

  async cleanup(helperPath: string): Promise<WindowsFileAssociationCleanupResult> {
    const report = await this.runRegistryAction<NativeRegistryCleanupReport>(
      "CleanupRegistration",
      helperPath,
      { values: [] },
    );
    if (!report.ok) {
      throw new Error(t("Windows 注册清理失败：{v0}", { v0: report.error ?? t("未知错误") }));
    }
    if ((report.remainingReferences?.length ?? 0) > 0) {
      throw new Error(
        t("Windows 注册清理后仍有 AIDE 残留：{v0}", { v0: report.remainingReferences?.join("、") ?? "" }),
      );
    }
    const warnings: string[] = [];
    try {
      await this.notifyAssociationChanged(helperPath);
    } catch (error) {
      warnings.push(
        t("Windows Shell 刷新失败：{v0}", { v0: error instanceof Error ? error.message : String(error) }),
      );
    }
    return {
      removed: report.removed ?? 0,
      warnings,
    };
  }

  async compareExchangeOpenCommand(
    helperPath: string,
    expectedCommand: string,
    nextCommand: string,
  ): Promise<{ changed: boolean; currentCommand: string }> {
    const report = await this.runRegistryAction<NativeOpenCommandCompareExchangeReport>(
      "CompareExchangeOpenCommand",
      helperPath,
      { expectedCommand, nextCommand },
    );
    return {
      changed: report.changed,
      currentCommand: report.currentCommand,
    };
  }

  async openDefaultAppsSettings(): Promise<void> {
    const app = encodeURIComponent(this.identity.applicationName);
    const registeredAppUri =
      `ms-settings:defaultapps?registeredAppUser=${app}`;
    try {
      await this.launchUri(registeredAppUri);
      return;
    } catch (registeredAppError) {
      try {
        await this.launchUri("ms-settings:defaultapps");
        return;
      } catch (genericSettingsError) {
        throw new AggregateError(
          [registeredAppError, genericSettingsError],
          t("无法打开 Windows 默认应用设置。"),
        );
      }
    }
  }

  async openGenericDefaultAppsSettings(): Promise<void> {
    await this.launchUri("ms-settings:defaultapps");
  }

  async openDeveloperSettings(): Promise<void> {
    await this.launchUri("ms-settings:developers");
  }

  private async rollbackRegistration(helperPath: string): Promise<void> {
    let rollbackFailed = false;
    let rollbackError: unknown;
    try {
      const report = await this.runRegistryAction<NativeRegistryCleanupReport>(
        "CleanupRegistration",
        helperPath,
        { values: [] },
      );
      if ((report.remainingReferences?.length ?? 0) > 0) {
        throw new Error(
          t("Windows 注册回滚后仍有 AIDE 残留：{v0}", { v0: report.remainingReferences?.join("、") ?? "" }),
        );
      }
    } catch (error) {
      rollbackFailed = true;
      rollbackError = error;
    }
    await this.notifyAssociationChanged(helperPath).catch(() => undefined);
    if (rollbackFailed) throw rollbackError;
  }

  private async runRegistryAction<T extends { ok: boolean; error?: string }>(
    action:
      | "ApplyRegistration"
      | "InspectRegistration"
      | "CleanupRegistration"
      | "CompareExchangeOpenCommand",
    helperPath: string,
    payload: RegistryOperationPayload,
  ): Promise<T> {
    const payloadPath = path.join(
      path.dirname(helperPath),
      `.mv-aide-registry-${process.pid}-${crypto.randomUUID()}.json`,
    );
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, JSON.stringify(payload), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      const result = await this.runner(this.powerShellExecutable, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperPath,
        "-Action",
        action,
        "-PayloadPath",
        payloadPath,
      ]);
      const parsed = JSON.parse(result.stdout.trim()) as T;
      if (!parsed.ok) {
        throw new Error(parsed.error ?? t("Windows 原生注册表操作失败。"));
      }
      return parsed;
    } finally {
      try {
        fs.rmSync(payloadPath, { force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) {
        console.warn(
          "[mv-aide] Failed to remove temporary registry payload.",
          error,
        );
      }
    }
  }

  async notifyAssociationChanged(helperPath: string): Promise<void> {
    await this.runner(this.powerShellExecutable, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-Action",
      "Notify",
    ]);
  }
}
