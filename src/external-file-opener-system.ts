import childProcess from "node:child_process";
import { t } from "./i18n";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExternalFileOpenerExtensionMode,
} from "./types";
import type { FileSymlinkFailure } from "./file-symlink-service";
import {
  isManagedCopyEligibleSymlinkFailure,
  preflightExternalFileSymlink,
  type ExternalFileSymlinkPreflightResult,
} from "./external-file-symlink-preflight";
import {
  diagnoseWindowsDeveloperMode as diagnoseWindowsDeveloperModeSupport,
  repairWindowsDeveloperMode as repairWindowsDeveloperModeSupport,
  type WindowsDeveloperModeDiagnosis,
  type WindowsDeveloperModeRepairResult,
} from "./windows-developer-mode-repair";
import {
  describeWindowsRegistryIssues,
  WindowsFileAssociationConflictError,
  WindowsFileAssociationRollbackError,
  WindowsFileAssociations,
  windowsAssociationHelperScript,
  WINDOWS_FILE_OPENER_PROG_ID,
  WINDOWS_FILE_OPENER_REGISTRATION_VERSION,
  type WindowsCurrentDefaultsResult,
  type WindowsFileAssociationInspection,
  type WindowsFileAssociationRegistrationOptions,
} from "./windows-file-associations";
import { escapeXml, labelForExtension } from "./file-type-icons";
import {
  renderFileTypeIcns,
  renderFileTypeIco,
} from "./file-type-icons-raster";
import { officialLogoPngDataUrl } from "./official-logo";
import { EXTERNAL_FILE_MIRROR_FOLDER } from "./vault-storage-paths";

const execFile = promisify(childProcess.execFile);

export const EXTERNAL_FILE_OPENER_MARKER = "mv-aide-file-opener-v1";
export const EXTERNAL_FILE_OPENER_BUNDLE_ID = "com.mv.aide.file-opener";
export const EXTERNAL_FILE_OPENER_PROG_ID = WINDOWS_FILE_OPENER_PROG_ID;
export const WINDOWS_FILE_OPENER_WRAPPER_VERSION = 4;
const LEGACY_WINDOWS_FILE_OPENER_WRAPPER_VERSION = 3;

export type DefaultOpenerStatusKind =
  | "not-default"
  | "other-vault"
  | "current-vault";

export interface ExternalFileOpenerOwner {
  marker: typeof EXTERNAL_FILE_OPENER_MARKER;
  vaultRoot: string;
  vaultName: string;
  extensionMode: ExternalFileOpenerExtensionMode;
  extensions: string[];
  installedAt: number;
  platform: NodeJS.Platform;
  appPath?: string;
  commandPath?: string;
  associationHelperPath?: string;
  wrapperVersion?: number;
  registrationVersion?: number;
  /** Device-local owner policy; old owner files with no field default to disabled. */
  managedCopyFallback?: boolean;
  /** Records whether injection itself proved that symlinks worked. */
  symlinkPreflightPassed?: boolean;
}

export interface ExternalFileOpenerRuntime {
  marker: typeof EXTERNAL_FILE_OPENER_MARKER;
  vaultRoot: string;
  vaultName: string;
  port: number;
  token: string;
  pid: number;
  updatedAt: number;
}

export interface DefaultOpenerStatus {
  kind: DefaultOpenerStatusKind;
  message: string;
  owner: ExternalFileOpenerOwner | null;
  requiresWindowsConfirmation?: boolean;
  requiresReinstall?: boolean;
  checkFailed?: boolean;
  confirmedExtensions?: string[];
  pendingExtensions?: string[];
}

export interface DefaultOpenerOperationResult {
  ok: boolean;
  status: DefaultOpenerStatus;
  message: string;
  failureKind?: DefaultOpenerFailureKind;
  warnings?: string[];
  offerWindowsDefaultAppsSettings?: boolean;
  symlinkFailure?: FileSymlinkFailure;
  managedCopyFallbackEnabled?: boolean;
  managedCopyFallbackAvailable?: boolean;
}

export type ExternalFileOpenerOwnerConfirmation = Pick<
  ExternalFileOpenerOwner,
  "marker" | "vaultRoot" | "installedAt"
>;

export interface CleanupExternalFileOpenerOptions {
  confirmedOwner?: ExternalFileOpenerOwnerConfirmation;
}

export interface WindowsFileOpenerMigrationResult {
  attempted: boolean;
  migrated: boolean;
  message: string;
  error?: string;
}

export type DefaultOpenerFailureKind =
  | "existing-owner"
  | "other-vault-confirmation-required"
  | "symlink-permission"
  | "symlink-unsupported"
  | "stale-registration"
  | "platform-install-failed"
  | "platform-cleanup-failed";

export interface InstallExternalFileOpenerOptions {
  vaultRoot: string;
  vaultName: string;
  mirrorFolder: string;
  extensionMode: ExternalFileOpenerExtensionMode;
  extensions: string[];
  allowManagedCopyFallback?: boolean;
}

export interface RuntimeExternalFileOpenerOptions {
  vaultRoot: string;
  vaultName: string;
  port: number;
  token: string;
}

export interface WindowsSymlinkPreflightResult {
  ok: boolean;
  failureKind?: Extract<
    DefaultOpenerFailureKind,
    "symlink-permission" | "symlink-unsupported"
  >;
  message: string;
}

interface WindowsSymlinkPreflightRuntime {
  platform?: NodeJS.Platform;
  temporaryDirectory?: () => string;
  randomId?: () => string;
  symlinkSync?: typeof fs.symlinkSync;
}

interface WindowsLauncherPreflightRuntime {
  platform?: NodeJS.Platform;
  powerShellPath?: string;
  scriptHostPath?: string;
  temporaryDirectory?: () => string;
  runner?: (executable: string, args: string[]) => Promise<void>;
}

export function externalFileOpenerStateDirectory(): string {
  return path.join(os.homedir(), ".mv-aide");
}

export function externalFileOpenerOwnerPath(): string {
  return path.join(externalFileOpenerStateDirectory(), "file-opener-owner.json");
}

export function externalFileOpenerRuntimePath(): string {
  return path.join(externalFileOpenerStateDirectory(), "file-opener-runtime.json");
}

export function sameVaultRoot(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function defaultOpenerStatusFromOwner(
  owner: ExternalFileOpenerOwner | null,
  currentVaultRoot: string,
): DefaultOpenerStatus {
  if (!owner) {
    return {
      kind: "not-default",
      message: t("AIDE 不是系统默认打开器。"),
      owner: null,
    };
  }
  if (
    owner.platform === "win32" &&
    (owner.wrapperVersion !== WINDOWS_FILE_OPENER_WRAPPER_VERSION ||
      owner.registrationVersion !== WINDOWS_FILE_OPENER_REGISTRATION_VERSION)
  ) {
    return {
      kind: "not-default",
      message: sameVaultRoot(owner.vaultRoot, currentVaultRoot)
        ? t("AIDE 的本仓库存在旧版 Windows 注册；请先清理再重新注入。")
        : t("AIDE 存在其它仓库的旧版 Windows 注册：{v0}；请先清理再重新注入。", { v0: owner.vaultRoot }),
      owner,
      requiresReinstall: true,
    };
  }
  if (sameVaultRoot(owner.vaultRoot, currentVaultRoot)) {
    return {
      kind: "current-vault",
      message: t("AIDE 的本仓库是系统默认打开器。"),
      owner,
    };
  }
  return {
    kind: "other-vault",
    message: t("AIDE 是系统默认打开器，但 owner 是：{v0}", { v0: owner.vaultRoot }),
    owner,
  };
}

function normalizedExtensionSet(extensions: string[]): string[] {
  return [...new Set(
    extensions.map((extension) => extension.trim().replace(/^\.+/, "").toLowerCase()),
  )].filter(Boolean).sort();
}

function formatExtensions(extensions: string[]): string {
  return extensions.map((extension) => `.${extension}`).join("、") || t("无");
}

function windowsInspectionSummary(
  inspection: WindowsFileAssociationInspection,
): string {
  const visibleIssues = inspection.issues.slice(0, 3);
  const details = describeWindowsRegistryIssues(visibleIssues);
  const remaining = inspection.issues.length - visibleIssues.length;
  return details + (remaining > 0 ? t("；另有 {n} 项", { n: remaining }) : "");
}

export function windowsDefaultOpenerStatus(
  owner: ExternalFileOpenerOwner,
  currentVaultRoot: string,
  configuredExtensions: string[],
  inspection: WindowsFileAssociationInspection,
  currentDefaults: WindowsCurrentDefaultsResult,
): DefaultOpenerStatus {
  const legacy = defaultOpenerStatusFromOwner(owner, currentVaultRoot);
  if (legacy.requiresReinstall) return legacy;

  const registered = normalizedExtensionSet(owner.extensions);
  const configured = normalizedExtensionSet(configuredExtensions);
  if (
    registered.length !== configured.length ||
    registered.some((extension, index) => extension !== configured[index])
  ) {
    return {
      kind: "not-default",
      message:
        t("当前设置后缀（{v0}）与已注入后缀", { v0: formatExtensions(configured) }) +
        t("（{v0}）不一致；请先清理再重新注入。", { v0: formatExtensions(registered) }),
      owner,
      requiresReinstall: true,
    };
  }

  if (inspection.state !== "complete") {
    return {
      kind: "not-default",
      message:
        inspection.state === "absent"
          ? t("AIDE owner 记录存在，但 Windows 候选打开器注册已丢失；请先清理再重新注入。")
          : t("AIDE Windows 候选打开器注册不完整：{v0}。请先清理再重新注入。", { v0: windowsInspectionSummary(inspection) }),
      owner,
      requiresReinstall: true,
    };
  }

  const queryErrors = Object.entries(currentDefaults.errors);
  if (queryErrors.length > 0) {
    return {
      kind: "not-default",
      message: t("Windows 默认打开方式检查失败：{v0}", {
        v0: queryErrors
          .map(([extension, message]) => `.${extension}：${message}`)
          .join("；"),
      }),
      owner,
      checkFailed: true,
      requiresWindowsConfirmation: true,
    };
  }

  const baseProgId = WINDOWS_FILE_OPENER_PROG_ID.toLowerCase();
  const effectiveProgId = (extension: string) =>
    currentDefaults.defaults[extension]?.toLowerCase();
  // v5+ registrations point each extension at a dedicated `ProgId.<ext>`
  // carrying the per-type icon. The shared base ProgId still opens files
  // fine but shows the generic icon (legacy UserChoice entries), so it
  // counts as confirmed-but-worth-reselecting.
  const genericIcon = registered.filter(
    (extension) => effectiveProgId(extension) === baseProgId,
  );
  const confirmed = registered.filter(
    (extension) =>
      effectiveProgId(extension) === baseProgId ||
      effectiveProgId(extension) === `${baseProgId}.${extension}`,
  );
  const pending = registered.filter((extension) => !confirmed.includes(extension));
  const genericIconAdvice = genericIcon.length > 0
    ? t(" {v0} 仍关联旧版通用图标；在系统默认应用中重新选择一次 ", { v0: formatExtensions(genericIcon) }) +
      t("MV AIDE File Opener（认准它，不要选 Windows Based Script Host）即可按类型显示专属图标。")
    : "";
  if (pending.length > 0) {
    const ownerDescription = sameVaultRoot(owner.vaultRoot, currentVaultRoot)
      ? t("本仓库")
      : t("其它仓库 {v0}", { v0: owner.vaultRoot });
    return {
      kind: "not-default",
      message:
        t("AIDE 已注册给{v0}，但 Windows 尚未确认全部默认后缀。", { v0: ownerDescription }) +
        t("已确认：{v0}；待确认：{v1}。", { v0: formatExtensions(confirmed), v1: formatExtensions(pending) }) +
        t("在系统默认应用设置中请认准 MV AIDE File Opener，不要选 Windows Based Script Host。") +
        genericIconAdvice,
      owner,
      requiresWindowsConfirmation: true,
      confirmedExtensions: confirmed,
      pendingExtensions: pending,
    };
  }

  return {
    kind: sameVaultRoot(owner.vaultRoot, currentVaultRoot)
      ? "current-vault"
      : "other-vault",
    message: (sameVaultRoot(owner.vaultRoot, currentVaultRoot)
      ? t("AIDE 的本仓库是系统默认打开器（{v0}）。", { v0: formatExtensions(confirmed) })
      : t("AIDE 是系统默认打开器，但 owner 是：{v0}", { v0: owner.vaultRoot })) +
      genericIconAdvice,
    owner,
    requiresWindowsConfirmation: genericIcon.length > 0,
    confirmedExtensions: confirmed,
    pendingExtensions: [],
  };
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

async function removeTemporaryPathBestEffort(
  targetPath: string,
  recursive: boolean,
): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.rmSync(targetPath, { recursive, force: true });
      return null;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  console.warn(
    `[mv-aide] Failed to remove temporary path: ${targetPath}`,
    lastError,
  );
  return lastError instanceof Error ? lastError.message : String(lastError);
}

function writeManagedFileAtomically(
  filePath: string,
  contents: Buffer,
): { created: boolean } {
  if (!windowsStateOwnedPath(filePath)) {
    throw new Error(t("Windows 打开器文件路径越界或包含符号链接：{v0}", { v0: filePath }));
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(t("拒绝覆盖非普通文件：{v0}", { v0: filePath }));
    }
    if (!fs.readFileSync(filePath).equals(contents)) {
      throw new Error(t("拒绝覆盖内容未知的 Windows 打开器文件：{v0}", { v0: filePath }));
    }
    return { created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!windowsStateOwnedPath(filePath)) {
    throw new Error(t("Windows 打开器目录包含符号链接：{v0}", { v0: filePath }));
  }
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filePath);
    return { created: true };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function classifyWindowsSymlinkError(
  error: unknown,
): Extract<
  DefaultOpenerFailureKind,
  "symlink-permission" | "symlink-unsupported"
> {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EPERM" || code === "EACCES") {
    return "symlink-permission";
  }
  return "symlink-unsupported";
}

export function preflightWindowsSymlink(
  vaultRoot: string,
  mirrorFolder: string,
  runtime: WindowsSymlinkPreflightRuntime = {},
): WindowsSymlinkPreflightResult {
  const platform = runtime.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: true, message: t("当前系统不需要 Windows 符号链接预检。") };
  }

  const randomId = runtime.randomId?.() ??
    `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryDirectory = runtime.temporaryDirectory?.() ?? os.tmpdir();
  const sourceDir = path.join(temporaryDirectory, `mv-aide-symlink-probe-${randomId}`);
  const sourcePath = path.join(sourceDir, "probe.md");
  const normalizedMirrorFolder = mirrorFolder.trim().replace(/^[/\\]+/, "") ||
    EXTERNAL_FILE_MIRROR_FOLDER;
  const linkDir = path.join(vaultRoot, normalizedMirrorFolder, `.mv-aide-probe-${randomId}`);
  const linkPath = path.join(linkDir, "probe.md");
  const createSymlink = runtime.symlinkSync ?? fs.symlinkSync;
  const createdMirrorParents: string[] = [];
  let parentToCheck = path.dirname(linkDir);
  const resolvedVaultRoot = path.resolve(vaultRoot);
  while (
    path.resolve(parentToCheck) !== resolvedVaultRoot &&
    !fs.existsSync(parentToCheck)
  ) {
    createdMirrorParents.push(parentToCheck);
    parentToCheck = path.dirname(parentToCheck);
  }

  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, "source", "utf8");
    fs.mkdirSync(linkDir, { recursive: true });
    createSymlink(sourcePath, linkPath, "file");
    fs.writeFileSync(linkPath, "written-through-link", "utf8");
    if (fs.readFileSync(sourcePath, "utf8") !== "written-through-link") {
      throw Object.assign(new Error("Symbolic link did not preserve write-through behavior."), {
        code: "ENOTSUP",
      });
    }
    return { ok: true, message: t("Windows 符号链接预检通过。") };
  } catch (error) {
    const failureKind = classifyWindowsSymlinkError(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      ok: false,
      failureKind,
      message:
        failureKind === "symlink-permission"
          ? t("无法在当前 vault 创建符号链接。请开启 Windows 开发者模式后重新检测；网络盘仍可能不支持。")
          : t("当前 vault 文件系统不支持外部文件符号链接{code}。请改用支持符号链接的本地文件系统。", { code: code ? `（${code}）` : "" }),
    };
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
    for (const createdParent of createdMirrorParents) {
      try {
        fs.rmdirSync(createdParent);
      } catch {
        break;
      }
    }
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
}

export async function preflightWindowsLauncher(
  runtime: WindowsLauncherPreflightRuntime = {},
): Promise<WindowsSymlinkPreflightResult> {
  const platform = runtime.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: true, message: t("当前系统不需要 Windows 启动器预检。") };
  }

  const powerShellPath = runtime.powerShellPath ?? windowsPowerShellExecutable();
  const scriptHostPath = runtime.scriptHostPath ?? windowsScriptHostExecutable();
  try {
    fs.accessSync(powerShellPath, fs.constants.R_OK);
    fs.accessSync(scriptHostPath, fs.constants.R_OK);
  } catch (error) {
    return {
      ok: false,
      message:
        t("Windows 启动器依赖不可用：{v0}", { v0: error instanceof Error ? error.message : String(error) }),
    };
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(
      runtime.temporaryDirectory?.() ?? os.tmpdir(),
      "mv-aide-wsh-probe-",
    ),
  );
  const scriptPath = path.join(temporaryDirectory, "probe.ps1");
  const launcherPath = path.join(temporaryDirectory, "probe.vbs");
  const runner = runtime.runner ?? (async (executable, args) => {
    await execFile(executable, args, { windowsHide: true });
  });
  try {
    const probeScript = String.raw`$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using Microsoft.Win32;
public static class MvAideLauncherProbe {
  public static void ReadCurrentUserSoftware() {
    using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software", false)) { }
  }
}
'@
[MvAideLauncherProbe]::ReadCurrentUserSoftware()
exit 0
`;
    const probeLauncher = [
      "Option Explicit",
      "If WScript.Arguments.Count <> 1 Then WScript.Quit 64",
      "Dim shell, fso, scriptPath, command, exitCode",
      'Set shell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "probe.ps1")',
      'command = Quote(WScript.Arguments(0)) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Quote(scriptPath)',
      "exitCode = shell.Run(command, 0, True)",
      "WScript.Quit exitCode",
      "Function Quote(value)",
      '  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)',
      "End Function",
      "",
    ].join("\r\n");
    fs.writeFileSync(scriptPath, Buffer.from(`\uFEFF${probeScript}`, "utf8"), {
      flag: "wx",
    });
    fs.writeFileSync(launcherPath, probeLauncher, {
      encoding: "ascii",
      flag: "wx",
    });
    await runner(scriptHostPath, [
      "//B",
      "//NoLogo",
      launcherPath,
      powerShellPath,
    ]);
    return { ok: true, message: t("Windows 启动器预检通过。") };
  } catch (error) {
    return {
      ok: false,
      message:
        t("Windows Script Host 无法运行：{v0}", { v0: error instanceof Error ? error.message : String(error) }),
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function ownerAppBundleIsUsable(owner: ExternalFileOpenerOwner): boolean {
  if (owner.platform !== "darwin") return true;
  const appPath = owner.appPath || macAppPath();
  const executablePath = path.join(appPath, "Contents", "MacOS", "droplet");
  try {
    fs.accessSync(executablePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type ExternalFileOpenerOwnerRecord =
  | { state: "missing"; owner: null }
  | { state: "invalid"; owner: null }
  | { state: "valid"; owner: ExternalFileOpenerOwner };

function isValidExternalFileOpenerOwner(
  owner: Partial<ExternalFileOpenerOwner> | null,
): owner is ExternalFileOpenerOwner {
  return (
    owner?.marker === EXTERNAL_FILE_OPENER_MARKER &&
    typeof owner.vaultRoot === "string" &&
    typeof owner.vaultName === "string" &&
    typeof owner.installedAt === "number"
  );
}

function isConcreteManagedCopyEligibleSymlinkFailure(
  failure: FileSymlinkFailure | null | undefined,
): failure is FileSymlinkFailure {
  return Boolean(
    failure &&
    failure.ok === false &&
    failure.verified === false &&
    typeof failure.targetPath === "string" &&
    failure.targetPath.length > 0 &&
    typeof failure.linkPath === "string" &&
    failure.linkPath.length > 0 &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0 &&
    isManagedCopyEligibleSymlinkFailure(failure),
  );
}

function readExternalFileOpenerOwnerRecord(): ExternalFileOpenerOwnerRecord {
  const ownerPath = externalFileOpenerOwnerPath();
  if (!fs.existsSync(ownerPath)) return { state: "missing", owner: null };
  const owner = readJson<Partial<ExternalFileOpenerOwner>>(ownerPath);
  if (!isValidExternalFileOpenerOwner(owner)) {
    return { state: "invalid", owner: null };
  }
  return { state: "valid", owner };
}

/**
 * Persist device-local managed-copy consent only after a concrete symlink
 * operation failed in a way the isolated fallback module can safely handle.
 */
export function authorizeManagedCopyFallbackAfterFailure(
  vaultRoot: string,
  failure: FileSymlinkFailure,
): boolean {
  if (!isConcreteManagedCopyEligibleSymlinkFailure(failure)) {
    return false;
  }

  const ownerPath = externalFileOpenerOwnerPath();
  if (!windowsStateOwnedPath(ownerPath)) return false;

  let originalText: string;
  try {
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    originalText = fs.readFileSync(ownerPath, "utf8");
  } catch {
    return false;
  }

  let owner: Partial<ExternalFileOpenerOwner> | null;
  try {
    owner = JSON.parse(originalText) as Partial<ExternalFileOpenerOwner>;
  } catch {
    return false;
  }
  if (
    !isValidExternalFileOpenerOwner(owner) ||
    !sameVaultRoot(owner.vaultRoot, vaultRoot)
  ) {
    return false;
  }
  if (owner.managedCopyFallback === true) return true;

  // Do not overwrite an owner replaced by cleanup/reinstall while the user was
  // deciding whether to authorize fallback.
  try {
    if (fs.readFileSync(ownerPath, "utf8") !== originalText) return false;
    writeJson(ownerPath, { ...owner, managedCopyFallback: true });
    return true;
  } catch {
    return false;
  }
}

function ownerMatchesConfirmation(
  owner: ExternalFileOpenerOwner,
  confirmation: ExternalFileOpenerOwnerConfirmation,
): boolean {
  return confirmation.marker === owner.marker &&
    confirmation.installedAt === owner.installedAt &&
    sameVaultRoot(confirmation.vaultRoot, owner.vaultRoot);
}

function isManagedRuntime(
  runtime: Partial<ExternalFileOpenerRuntime> | null,
): runtime is ExternalFileOpenerRuntime {
  return runtime?.marker === EXTERNAL_FILE_OPENER_MARKER &&
    typeof runtime.vaultRoot === "string" &&
    typeof runtime.vaultName === "string" &&
    typeof runtime.port === "number" &&
    typeof runtime.token === "string";
}

function removeManagedRuntime(vaultRoot?: string): boolean {
  const runtime = readJson<Partial<ExternalFileOpenerRuntime>>(
    externalFileOpenerRuntimePath(),
  );
  if (!isManagedRuntime(runtime)) return false;
  if (vaultRoot && !sameVaultRoot(runtime.vaultRoot, vaultRoot)) return false;
  fs.rmSync(externalFileOpenerRuntimePath(), { force: true });
  return true;
}

export function readExternalFileOpenerOwner(): ExternalFileOpenerOwner | null {
  return readExternalFileOpenerOwnerRecord().owner;
}

function macAppPath(): string {
  return path.join(
    externalFileOpenerStateDirectory(),
    "MV AIDE File Opener.app",
  );
}

function legacyWindowsPowerShellPath(): string {
  return path.join(externalFileOpenerStateDirectory(), "mv-aide-file-opener.ps1");
}

function windowsV4PowerShellPath(): string {
  return path.join(
    externalFileOpenerStateDirectory(),
    "mv-aide-file-opener-v4.ps1",
  );
}

function windowsV4LauncherPath(): string {
  return path.join(
    externalFileOpenerStateDirectory(),
    "mv-aide-file-opener-v4.vbs",
  );
}

function windowsAssociationHelperPath(): string {
  return path.join(
    externalFileOpenerStateDirectory(),
    "mv-aide-file-association.ps1",
  );
}

function legacyWindowsCommandPath(): string {
  return path.join(externalFileOpenerStateDirectory(), "mv-aide-file-opener.cmd");
}

function windowsLastErrorPath(): string {
  return path.join(externalFileOpenerStateDirectory(), "file-opener-last-error.json");
}

function windowsPowerShellExecutable(): string {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsScriptHostExecutable(): string {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "wscript.exe",
  );
}

function legacyWindowsOpenCommand(commandPath: string): string {
  return `"${windowsPowerShellExecutable()}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${commandPath}" "%1"`;
}

function windowsOpenCommand(commandPath: string): string {
  return `"${windowsScriptHostExecutable()}" //B //NoLogo "${commandPath}" "%1"`;
}

function windowsFileAssociations(): WindowsFileAssociations {
  return new WindowsFileAssociations(windowsPowerShellExecutable());
}

async function withTemporaryWindowsAssociationHelper<T>(
  operation: (helperPath: string) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mv-aide-association-"),
  );
  const helperPath = path.join(temporaryDirectory, "association.ps1");
  fs.writeFileSync(
    helperPath,
    `\uFEFF${windowsAssociationHelperScript()}`,
    "utf8",
  );
  try {
    return await operation(helperPath);
  } finally {
    await removeTemporaryPathBestEffort(temporaryDirectory, true);
  }
}

function windowsStateOwnedPath(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const stateDirectory = path.resolve(externalFileOpenerStateDirectory());
  const resolved = path.resolve(filePath);
  const relative = path.relative(stateDirectory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  let current = stateDirectory;
  for (const segment of relative.split(path.sep)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return null;
    }
    current = path.join(current, segment);
  }
  try {
    if (fs.lstatSync(current).isSymbolicLink()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  return resolved;
}

function linuxCommandPath(): string {
  return path.join(externalFileOpenerStateDirectory(), "mv-aide-file-opener");
}

function linuxDesktopPath(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "applications",
    "mv-aide-file-opener.desktop",
  );
}

function macShellWrapper(): string {
  return `#!/bin/zsh
DIR="$(cd "$(dirname "$0")" && pwd)"
/usr/bin/osascript -l JavaScript "$DIR/mv-aide-file-opener.jxa" "$@"
`;
}

export function macJxaWrapper(): string {
  return String.raw`ObjC.import("Foundation");

function readJson(filePath) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(
    filePath,
    $.NSUTF8StringEncoding,
    null
  );
  if (!text) return null;
  return JSON.parse(ObjC.unwrap(text));
}

function runTask(launchPath, args) {
  const task = $.NSTask.alloc.init;
  const pipe = $.NSPipe.pipe;
  task.launchPath = launchPath;
  task.arguments = args;
  task.standardOutput = pipe;
  task.standardError = $.NSPipe.pipe;
  task.launch;
  task.waitUntilExit;
  const data = pipe.fileHandleForReading.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return { status: task.terminationStatus, stdout: text ? ObjC.unwrap(text) : "" };
}

function postFile(filePath, runtime) {
  const payload = JSON.stringify({ path: filePath, makeFrontmost: true });
  const result = runTask("/usr/bin/curl", [
    "-sS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-X",
    "POST",
    "http://127.0.0.1:" + runtime.port + "/external-file/open",
    "-H",
    "Authorization: Bearer " + runtime.token,
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    payload,
  ]);
  return result.stdout.trim() === "200";
}

function run(argv) {
  const stateDir = ObjC.unwrap($.NSHomeDirectory()) + "/.mv-aide";
  const owner = readJson(stateDir + "/file-opener-owner.json");
  if (!owner) return 2;
  for (const filePath of argv) {
    let opened = false;
    for (let attempt = 0; attempt < 30 && !opened; attempt++) {
      const runtime = readJson(stateDir + "/file-opener-runtime.json");
      if (runtime && runtime.vaultRoot === owner.vaultRoot && postFile(filePath, runtime)) {
        opened = true;
        break;
      }
      runTask("/usr/bin/open", [
        "obsidian://open?vault=" + encodeURIComponent(owner.vaultName),
      ]);
      delay(0.5);
    }
  }
  return 0;
}
`;
}

export function macInfoPlist(extensions: string[]): string {
  const documentTypes = [...new Set(extensions)].sort().map((extension) => {
    const safeExtension = escapeXml(extension);
    return `    <dict>
      <key>CFBundleTypeName</key>
      <string>MV AIDE ${escapeXml(extension.toUpperCase())} File</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>${safeExtension}</string>
      </array>
      <key>CFBundleTypeIconFile</key>
      <string>doc-${safeExtension}</string>
      <key>LSHandlerRank</key>
      <string>Owner</string>
    </dict>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${EXTERNAL_FILE_OPENER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>MV AIDE File Opener</string>
  <key>CFBundleExecutable</key>
  <string>droplet</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>aplt</string>
  <key>CFBundleDocumentTypes</key>
  <array>
${documentTypes}
  </array>
</dict>
</plist>
`;
}

export function macAppletScript(): string {
  return String.raw`ObjC.import("Foundation");

function readJson(filePath) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(
    filePath,
    $.NSUTF8StringEncoding,
    null
  );
  if (!text) return null;
  return JSON.parse(ObjC.unwrap(text));
}

function runTask(launchPath, args) {
  const task = $.NSTask.alloc.init;
  const pipe = $.NSPipe.pipe;
  task.launchPath = launchPath;
  task.arguments = args;
  task.standardOutput = pipe;
  task.standardError = $.NSPipe.pipe;
  task.launch;
  task.waitUntilExit;
  const data = pipe.fileHandleForReading.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return { status: task.terminationStatus, stdout: text ? ObjC.unwrap(text) : "" };
}

function postFile(filePath, runtime) {
  const payload = JSON.stringify({ path: filePath, makeFrontmost: true });
  const result = runTask("/usr/bin/curl", [
    "-sS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-X",
    "POST",
    "http://127.0.0.1:" + runtime.port + "/external-file/open",
    "-H",
    "Authorization: Bearer " + runtime.token,
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    payload,
  ]);
  return result.stdout.trim() === "200";
}

function handlePaths(paths) {
  const stateDir = ObjC.unwrap($.NSHomeDirectory()) + "/.mv-aide";
  const owner = readJson(stateDir + "/file-opener-owner.json");
  if (!owner) return 2;
  for (const filePath of paths) {
    let opened = false;
    for (let attempt = 0; attempt < 30 && !opened; attempt++) {
      const runtime = readJson(stateDir + "/file-opener-runtime.json");
      if (runtime && runtime.vaultRoot === owner.vaultRoot && postFile(filePath, runtime)) {
        opened = true;
        break;
      }
      runTask("/usr/bin/open", [
        "obsidian://open?vault=" + encodeURIComponent(owner.vaultName),
      ]);
      $.NSThread.sleepForTimeInterval(0.5);
    }
  }
  return 0;
}

function run(argv) {
  return handlePaths(argv || []);
}

function openDocuments(docs) {
  const paths = [];
  for (let i = 0; i < docs.length; i++) {
    paths.push(String(docs[i]));
  }
  return handlePaths(paths);
}
`;
}

async function installMacOpener(owner: ExternalFileOpenerOwner): Promise<void> {
  const appPath = macAppPath();
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(externalFileOpenerStateDirectory(), { recursive: true });
  const sourcePath = path.join(
    externalFileOpenerStateDirectory(),
    "mv-aide-file-opener.jxa",
  );
  fs.writeFileSync(sourcePath, macAppletScript(), "utf8");
  await execFile("/usr/bin/osacompile", ["-l", "JavaScript", "-o", appPath, sourcePath]);
  fs.rmSync(sourcePath, { force: true });

  const macOsPath = path.join(appPath, "Contents", "MacOS");
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  fs.mkdirSync(macOsPath, { recursive: true });
  fs.writeFileSync(infoPath, macInfoPlist(owner.extensions), "utf8");
  // 每格式一个 icns 资源，供 Info.plist 的 CFBundleTypeIconFile 引用；
  // Finder 按文档类型显示对应图标。
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  fs.mkdirSync(resourcesPath, { recursive: true });
  const logoDataUrl = officialLogoPngDataUrl();
  for (const extension of [...new Set(owner.extensions)].sort()) {
    fs.writeFileSync(
      path.join(resourcesPath, `doc-${extension}.icns`),
      await renderFileTypeIcns(labelForExtension(extension), logoDataUrl),
    );
  }
  const executablePath = path.join(macOsPath, "mv-aide-file-opener");
  fs.writeFileSync(executablePath, macShellWrapper(), { mode: 0o755 });
  fs.writeFileSync(
    path.join(macOsPath, "mv-aide-file-opener.jxa"),
    macJxaWrapper(),
    "utf8",
  );
  owner.appPath = appPath;

  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  await execFile(lsregister, ["-f", appPath]);
  const script = `ObjC.import("CoreServices");
const bundle = $("${EXTERNAL_FILE_OPENER_BUNDLE_ID}");
const extensions = ${JSON.stringify(owner.extensions)};
for (const ext of extensions) {
  const uti = $.UTTypeCreatePreferredIdentifierForTag($.kUTTagClassFilenameExtension, $(ext), null);
  if (uti) $.LSSetDefaultRoleHandlerForContentType(uti, $.kLSRolesAll, bundle);
}`;
  await execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
}

async function cleanupMacOpener(owner: ExternalFileOpenerOwner | null): Promise<void> {
  const appPath = owner?.appPath || macAppPath();
  fs.rmSync(appPath, { recursive: true, force: true });
}

export function windowsVbsLauncher(): string {
  return String.raw`Option Explicit

If WScript.Arguments.Count <> 1 Then
  WScript.Quit 64
End If

Dim filePath
filePath = CStr(WScript.Arguments.Item(0))
If Len(filePath) = 0 Or InStr(filePath, Chr(34)) > 0 Or _
    InStr(filePath, vbCr) > 0 Or InStr(filePath, vbLf) > 0 Then
  WScript.Quit 65
End If

Function QuotePath(value)
  QuotePath = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Function EncodeUtf16Hex(value)
  Dim encoded, index, codeUnit
  encoded = ""
  For index = 1 To Len(value)
    codeUnit = AscW(Mid(value, index, 1))
    If codeUnit < 0 Then codeUnit = codeUnit + 65536
    encoded = encoded & Right("0000" & Hex(codeUnit), 4)
  Next
  EncodeUtf16Hex = encoded
End Function

Dim shell, fso, scriptDirectory, powerShellPath, wrapperPath
Dim encodedFilePath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
wrapperPath = fso.BuildPath(scriptDirectory, "mv-aide-file-opener-v4.ps1")
powerShellPath = shell.ExpandEnvironmentStrings( _
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

If Not fso.FileExists(powerShellPath) Or Not fso.FileExists(wrapperPath) Then
  WScript.Quit 66
End If

encodedFilePath = EncodeUtf16Hex(filePath)
command = QuotePath(powerShellPath) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
  QuotePath(wrapperPath) & " -EncodedFilePath " & QuotePath(encodedFilePath)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
`;
}

export function windowsPowerShellWrapper(): string {
  return String.raw`param([Parameter(Mandatory = $true)][string]$EncodedFilePath)
$ErrorActionPreference = "Stop"
$StateDir = if ([string]::IsNullOrWhiteSpace($env:MV_AIDE_FILE_OPENER_STATE_DIR)) {
  $PSScriptRoot
} else {
  $env:MV_AIDE_FILE_OPENER_STATE_DIR
}
$OwnerPath = Join-Path $StateDir "file-opener-owner.json"
$RuntimePath = Join-Path $StateDir "file-opener-runtime.json"
$ErrorPath = Join-Path $StateDir "file-opener-last-error.json"
$FilePath = ""

function Read-JsonResult([string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    return @{ kind = "missing"; value = $null; message = "" }
  }
  try {
    $Value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $Value) { throw "JSON value is null." }
    return @{ kind = "valid"; value = $Value; message = "" }
  } catch {
    return @{ kind = "invalid"; value = $null; message = $_.Exception.Message }
  }
}

function Write-Failure([string]$Stage, [string]$Message, [int]$ExitCode) {
  try {
    @{
      timestamp = [DateTime]::UtcNow.ToString("o")
      stage = $Stage
      message = $Message
      path = $FilePath
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ErrorPath -Encoding UTF8
  } catch {}
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      "MV AIDE Default File Opener",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {}
  exit $ExitCode
}

function Error-Message([string]$Body, [string]$Fallback) {
  try {
    $Parsed = $Body | ConvertFrom-Json
    if ($null -ne $Parsed.message) { return [string]$Parsed.message }
    if ($Parsed.error -is [string]) { return [string]$Parsed.error }
    if ($null -ne $Parsed.error.message) { return [string]$Parsed.error.message }
  } catch {}
  return $Fallback
}

function Test-Bridge($Runtime) {
  try {
    $Response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri ("http://127.0.0.1:{0}/health" -f $Runtime.port) -TimeoutSec 1
    return $Response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Open-ExternalFile($Runtime) {
  $Payload = @{ path = $FilePath; makeFrontmost = $true } | ConvertTo-Json -Compress
  $PayloadBytes = [System.Text.Encoding]::UTF8.GetBytes($Payload)
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri ("http://127.0.0.1:{0}/external-file/open" -f $Runtime.port) -Headers @{ Authorization = ("Bearer " + $Runtime.token) } -ContentType "application/json; charset=utf-8" -Body $PayloadBytes -TimeoutSec 10 | Out-Null
    return @{ kind = "success"; status = 200; message = "" }
  } catch {
    $Response = $_.Exception.Response
    if ($null -eq $Response) {
      return @{ kind = "transport"; status = 0; message = $_.Exception.Message }
    }
    $Body = ""
    try {
      $Stream = $Response.GetResponseStream()
      if ($null -ne $Stream) {
        $Reader = New-Object System.IO.StreamReader($Stream)
        $Body = $Reader.ReadToEnd()
        $Reader.Dispose()
      }
    } catch {}
    return @{
      kind = "http"
      status = [int]$Response.StatusCode
      message = Error-Message $Body $_.Exception.Message
    }
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($EncodedFilePath) -or
      ($EncodedFilePath.Length % 4) -ne 0) {
    throw "Encoded file path has an invalid length."
  }
  $Builder = New-Object System.Text.StringBuilder
  for ($Offset = 0; $Offset -lt $EncodedFilePath.Length; $Offset += 4) {
    $Chunk = $EncodedFilePath.Substring($Offset, 4)
    if ($Chunk -notmatch "^[0-9A-Fa-f]{4}$") {
      throw "Encoded file path contains invalid characters."
    }
    [void]$Builder.Append([char][Convert]::ToUInt16($Chunk, 16))
  }
  $FilePath = $Builder.ToString()
  if ([string]::IsNullOrWhiteSpace($FilePath) -or
      $FilePath.Contains([string][char]34) -or
      $FilePath.Contains([string][char]13) -or
      $FilePath.Contains([string][char]10)) {
    throw "Decoded file path is invalid."
  }
} catch {
  Write-Failure "input" ("MV AIDE received an invalid file path: " + $_.Exception.Message) 64
}

$OwnerResult = Read-JsonResult $OwnerPath
if ($OwnerResult.kind -eq "missing") {
  Write-Failure "owner-missing" "MV AIDE default opener is not configured." 2
}
if ($OwnerResult.kind -ne "valid") {
  Write-Failure "owner-invalid" ("MV AIDE owner data is invalid: " + $OwnerResult.message) 2
}
$Owner = $OwnerResult.value
if ($Owner.marker -ne "mv-aide-file-opener-v1" -or
    [string]::IsNullOrWhiteSpace([string]$Owner.vaultRoot) -or
    [string]::IsNullOrWhiteSpace([string]$Owner.vaultName)) {
  Write-Failure "owner-invalid" "MV AIDE owner data is incomplete." 2
}

$WokeObsidian = $false
for ($i = 0; $i -lt 30; $i++) {
  $RuntimeResult = Read-JsonResult $RuntimePath
  $Runtime = if ($RuntimeResult.kind -eq "valid") { $RuntimeResult.value } else { $null }
  if (
    $null -ne $Runtime -and
    $Runtime.vaultRoot -eq $Owner.vaultRoot -and
    $null -ne $Runtime.port -and
    $null -ne $Runtime.token -and
    (Test-Bridge $Runtime)
  ) {
    $Result = Open-ExternalFile $Runtime
    if ($Result.kind -eq "success") { exit 0 }
    if ($Result.kind -eq "http") {
      Write-Failure "open" ("MV AIDE could not open this file: " + $Result.message) 4
    }
  }

  if (!$WokeObsidian) {
    try {
      Start-Process ("obsidian://open?vault=" + [uri]::EscapeDataString($Owner.vaultName))
      $WokeObsidian = $true
    } catch {
      Write-Failure "wake" ("Could not start Obsidian: " + $_.Exception.Message) 3
    }
  }
  Start-Sleep -Milliseconds 500
}

Write-Failure "startup" "MV AIDE timed out waiting for the selected Obsidian vault to start." 3
`;
}

function fileTypeIconsDirectory(): string {
  return path.join(externalFileOpenerStateDirectory(), "icons");
}

interface PreparedFileTypeIcons {
  extensionIcons: Record<string, string>;
  genericIconPath: string;
}

/**
 * Renders per-extension ICO files into the state directory. The registry
 * references them by absolute path, so paths must stay stable; `overwrite`
 * is used by (re)install to pick up template changes, while status checks
 * only fill in missing files.
 */
async function prepareWindowsFileTypeIcons(
  extensions: string[],
  overwrite: boolean,
): Promise<PreparedFileTypeIcons> {
  const iconsDirectory = windowsStateOwnedPath(fileTypeIconsDirectory());
  if (!iconsDirectory) {
    throw new Error(t("Windows 文件类型图标目录越界或包含符号链接。"));
  }
  fs.mkdirSync(iconsDirectory, { recursive: true });

  const logoDataUrl = officialLogoPngDataUrl();
  const extensionIcons: Record<string, string> = {};
  for (const extension of [...new Set(extensions)].sort()) {
    const ownedIconPath = windowsStateOwnedPath(
      path.join(iconsDirectory, `${extension}.ico`),
    );
    if (!ownedIconPath) {
      throw new Error(t("Windows 文件类型图标路径越界：{v0}", { v0: extension }));
    }
    if (overwrite || !fs.existsSync(ownedIconPath)) {
      fs.writeFileSync(
        ownedIconPath,
        await renderFileTypeIco(labelForExtension(extension), logoDataUrl),
      );
    }
    extensionIcons[extension] = ownedIconPath;
  }
  const genericIconPath = windowsStateOwnedPath(
    path.join(iconsDirectory, "generic.ico"),
  );
  if (!genericIconPath) {
    throw new Error(t("Windows 通用文件类型图标路径越界。"));
  }
  if (overwrite || !fs.existsSync(genericIconPath)) {
    fs.writeFileSync(genericIconPath, await renderFileTypeIco(null, logoDataUrl));
  }
  return { extensionIcons, genericIconPath };
}

async function windowsRegistrationOptions(
  extensions: string[],
  openCommand: string,
  overwriteIcons: boolean,
): Promise<WindowsFileAssociationRegistrationOptions> {
  const base: WindowsFileAssociationRegistrationOptions = {
    extensions,
    openCommand,
    iconPath: process.execPath,
  };
  try {
    const icons = await prepareWindowsFileTypeIcons(extensions, overwriteIcons);
    return {
      ...base,
      extensionIcons: icons.extensionIcons,
      genericIconPath: icons.genericIconPath,
    };
  } catch (error) {
    // Icon cosmetics must never block opener installation: without a DOM
    // (or a failed canvas) fall back to the shared exe-icon registration.
    console.warn(
      t("[mv-aide] 文件类型图标渲染失败，退回共享图标注册。"),
      error,
    );
    return base;
  }
}

async function installWindowsOpener(owner: ExternalFileOpenerOwner): Promise<void> {
  const stateDir = externalFileOpenerStateDirectory();
  fs.mkdirSync(stateDir, { recursive: true });
  const ps1Path = windowsV4PowerShellPath();
  const launcherPath = windowsV4LauncherPath();
  const createdPaths: string[] = [];
  let ownerWritten = false;
  try {
    if (writeManagedFileAtomically(
      ps1Path,
      Buffer.from(`\uFEFF${windowsPowerShellWrapper()}`, "utf8"),
    ).created) {
      createdPaths.push(ps1Path);
    }
    if (writeManagedFileAtomically(
      launcherPath,
      Buffer.from(windowsVbsLauncher(), "ascii"),
    ).created) {
      createdPaths.push(launcherPath);
    }
    owner.commandPath = launcherPath;
    owner.wrapperVersion = WINDOWS_FILE_OPENER_WRAPPER_VERSION;
    owner.registrationVersion = WINDOWS_FILE_OPENER_REGISTRATION_VERSION;
    const ownerPath = externalFileOpenerOwnerPath();
    if (!windowsStateOwnedPath(ownerPath)) {
      throw new Error(t("Windows 打开器 owner 路径越界或包含符号链接。"));
    }
    writeJson(ownerPath, owner);
    ownerWritten = true;
    const registrationOptions = await windowsRegistrationOptions(
      owner.extensions,
      windowsOpenCommand(launcherPath),
      true,
    );
    await withTemporaryWindowsAssociationHelper((helperPath) =>
      windowsFileAssociations().install(registrationOptions, helperPath),
    );
  } catch (error) {
    if (!(error instanceof WindowsFileAssociationRollbackError)) {
      if (ownerWritten) {
        const persisted = readExternalFileOpenerOwner();
        if (persisted?.installedAt === owner.installedAt) {
          fs.rmSync(externalFileOpenerOwnerPath(), { force: true });
        }
      }
      for (const filePath of createdPaths) fs.rmSync(filePath, { force: true });
    }
    throw error;
  }
}

async function cleanupWindowsOpener(): Promise<{
  removed: number;
  warnings: string[];
}> {
  const knownLauncherPath = windowsStateOwnedPath(windowsV4LauncherPath());
  if (!knownLauncherPath) {
    throw new Error(t("Windows 打开器状态目录越界或包含符号链接，拒绝清理。"));
  }
  const registryCleanup = await withTemporaryWindowsAssociationHelper((helperPath) =>
    windowsFileAssociations().cleanup(helperPath),
  );
  for (const filePath of new Set([
    windowsStateOwnedPath(legacyWindowsPowerShellPath()),
    windowsStateOwnedPath(windowsV4PowerShellPath()),
    knownLauncherPath,
    windowsStateOwnedPath(windowsAssociationHelperPath()),
    windowsStateOwnedPath(legacyWindowsCommandPath()),
    windowsStateOwnedPath(windowsLastErrorPath()),
  ])) {
    if (!filePath) continue;
    const removalError = await removeTemporaryPathBestEffort(filePath, false);
    if (removalError) {
      registryCleanup.warnings.push(
        t("Windows 打开器文件将在下次清理时重试：{v0}（{v1}）", { v0: filePath, v1: removalError }),
      );
    }
  }
  const iconsDirectory = windowsStateOwnedPath(fileTypeIconsDirectory());
  if (iconsDirectory) {
    const iconRemovalError = await removeTemporaryPathBestEffort(
      iconsDirectory,
      true,
    );
    if (iconRemovalError) {
      registryCleanup.warnings.push(
        t("Windows 文件类型图标将在下次清理时重试：{v0}（{v1}）", { v0: iconsDirectory, v1: iconRemovalError }),
      );
    }
  }
  return registryCleanup;
}

function linuxShellWrapper(): string {
  return `#!/bin/sh
python3 - "$1" <<'PY'
import json, os, subprocess, sys, time, urllib.parse, urllib.request
state_dir = os.path.join(os.path.expanduser("~"), ".mv-aide")
owner_path = os.path.join(state_dir, "file-opener-owner.json")
runtime_path = os.path.join(state_dir, "file-opener-runtime.json")
with open(owner_path, "r", encoding="utf-8") as fh:
    owner = json.load(fh)
file_path = sys.argv[1]
for _ in range(30):
    try:
        with open(runtime_path, "r", encoding="utf-8") as fh:
            runtime = json.load(fh)
        if runtime.get("vaultRoot") == owner.get("vaultRoot"):
            payload = json.dumps({"path": file_path, "makeFrontmost": True}).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{runtime['port']}/external-file/open",
                data=payload,
                headers={"Authorization": "Bearer " + runtime["token"], "Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=1).read()
            sys.exit(0)
    except Exception:
        pass
    subprocess.run(["xdg-open", "obsidian://open?vault=" + urllib.parse.quote(owner["vaultName"])], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
sys.exit(1)
PY
`;
}

async function installLinuxOpener(owner: ExternalFileOpenerOwner): Promise<void> {
  const commandPath = linuxCommandPath();
  fs.writeFileSync(commandPath, linuxShellWrapper(), { mode: 0o755 });
  owner.commandPath = commandPath;
  const desktopPath = linuxDesktopPath();
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.writeFileSync(
    desktopPath,
    `[Desktop Entry]
Name=MV AIDE File Opener
Exec=${commandPath} %f
Type=Application
Terminal=false
MimeType=text/markdown;text/x-markdown;
NoDisplay=true
`,
    "utf8",
  );
  await execFile("xdg-mime", [
    "default",
    path.basename(desktopPath),
    "text/markdown",
  ]).catch(() => undefined);
  await execFile("xdg-mime", [
    "default",
    path.basename(desktopPath),
    "text/x-markdown",
  ]).catch(() => undefined);
}

async function cleanupLinuxOpener(owner: ExternalFileOpenerOwner | null): Promise<void> {
  fs.rmSync(owner?.commandPath || linuxCommandPath(), { force: true });
  fs.rmSync(linuxDesktopPath(), { force: true });
}

async function installPlatformOpener(owner: ExternalFileOpenerOwner): Promise<void> {
  if (process.platform === "darwin") {
    await installMacOpener(owner);
  } else if (process.platform === "win32") {
    await installWindowsOpener(owner);
  } else if (process.platform === "linux") {
    await installLinuxOpener(owner);
  } else {
    throw new Error(t("暂不支持当前平台：{v0}", { v0: process.platform }));
  }
}

async function cleanupPlatformOpener(
  owner: ExternalFileOpenerOwner | null,
): Promise<{ removed: number; warnings: string[] }> {
  if (process.platform === "darwin") {
    await cleanupMacOpener(owner);
    return { removed: 0, warnings: [] };
  } else if (process.platform === "win32") {
    return await cleanupWindowsOpener();
  } else if (process.platform === "linux") {
    await cleanupLinuxOpener(owner);
    return { removed: 0, warnings: [] };
  }
  return { removed: 0, warnings: [] };
}

function sameNormalizedExtensions(left: string[], right: string[]): boolean {
  const normalizedLeft = normalizedExtensionSet(left);
  const normalizedRight = normalizedExtensionSet(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((extension, index) => extension === normalizedRight[index]);
}

function sameWindowsCommandPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function windowsOwnerLauncherIsUsable(owner: ExternalFileOpenerOwner): boolean {
  if (owner.platform !== "win32" ||
      owner.wrapperVersion !== WINDOWS_FILE_OPENER_WRAPPER_VERSION) {
    return true;
  }
  const launcherPath = windowsStateOwnedPath(owner.commandPath);
  if (!launcherPath ||
      !sameWindowsCommandPath(launcherPath, windowsV4LauncherPath())) {
    return false;
  }
  try {
    const launcher = fs.lstatSync(launcherPath);
    const wrapper = fs.lstatSync(windowsV4PowerShellPath());
    return launcher.isFile() && !launcher.isSymbolicLink() &&
      wrapper.isFile() && !wrapper.isSymbolicLink();
  } catch {
    return false;
  }
}

function windowsDefaultsAreEqual(
  extensions: string[],
  before: WindowsCurrentDefaultsResult,
  after: WindowsCurrentDefaultsResult,
): boolean {
  return normalizedExtensionSet(extensions).every((extension) => {
    if (!Object.hasOwn(before.defaults, extension) ||
        !Object.hasOwn(after.defaults, extension)) {
      return false;
    }
    const left = before.defaults[extension];
    const right = after.defaults[extension];
    if (left === null || left === undefined || right === null || right === undefined) {
      return (left ?? null) === (right ?? null);
    }
    return left.toLowerCase() === right.toLowerCase();
  });
}

function windowsQueryErrorMessage(result: WindowsCurrentDefaultsResult): string | null {
  const errors = Object.entries(result.errors);
  return errors.length === 0
    ? null
    : errors.map(([extension, message]) => `.${extension}：${message}`).join("；");
}

async function performWindowsFileOpenerMigration(
  currentVaultRoot: string,
  configuredExtensions: string[],
  launcherPreflight: () => Promise<WindowsSymlinkPreflightResult>,
): Promise<WindowsFileOpenerMigrationResult> {
  const skipped = (message: string): WindowsFileOpenerMigrationResult => ({
    attempted: false,
    migrated: false,
    message,
  });
  if (process.platform !== "win32") return skipped(t("当前系统不需要 Windows 打开器迁移。"));

  const owner = readExternalFileOpenerOwner();
  if (!owner || owner.platform !== "win32") {
    return skipped(t("没有需要迁移的 Windows 打开器 owner。"));
  }
  if (!sameVaultRoot(owner.vaultRoot, currentVaultRoot)) {
    return skipped(t("Windows 打开器属于其它 vault，不自动迁移。"));
  }
  if (owner.wrapperVersion !== LEGACY_WINDOWS_FILE_OPENER_WRAPPER_VERSION ||
      owner.registrationVersion !== WINDOWS_FILE_OPENER_REGISTRATION_VERSION) {
    return skipped(t("Windows 打开器版本不属于可原地迁移范围。"));
  }
  if (!sameNormalizedExtensions(owner.extensions, configuredExtensions)) {
    return skipped(t("Windows 打开器后缀设置已漂移，不自动迁移。"));
  }

  const legacyCommandPath = windowsStateOwnedPath(
    owner.commandPath || legacyWindowsPowerShellPath(),
  );
  if (!legacyCommandPath ||
      !sameWindowsCommandPath(legacyCommandPath, legacyWindowsPowerShellPath())) {
    return skipped(t("Windows v3 打开器路径不是受管默认路径，不自动迁移。"));
  }
  try {
    const stat = fs.lstatSync(legacyCommandPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return skipped(t("Windows v3 打开器不是受管普通文件，不自动迁移。"));
    }
  } catch {
    return skipped(t("Windows v3 打开器文件缺失，不自动迁移。"));
  }

  const ownerPath = externalFileOpenerOwnerPath();
  let originalOwnerText: string;
  try {
    const ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
      return skipped(t("Windows 打开器 owner 不是受管普通文件，不自动迁移。"));
    }
    originalOwnerText = fs.readFileSync(ownerPath, "utf8");
  } catch (error) {
    return {
      attempted: true,
      migrated: false,
      message: t("无法读取 Windows 打开器 owner，未执行迁移。"),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return await withTemporaryWindowsAssociationHelper(async (helperPath) => {
    const associations = windowsFileAssociations();
    const legacyCommand = legacyWindowsOpenCommand(legacyCommandPath);
    const launcherPath = windowsV4LauncherPath();
    const nextCommand = windowsOpenCommand(launcherPath);
    const registrationBase = {
      extensions: owner.extensions,
      iconPath: process.execPath,
    };
    const inspectCommandState = async (): Promise<"legacy" | "v4" | "unknown"> => {
      try {
        const legacy = await associations.inspect({
          ...registrationBase,
          openCommand: legacyCommand,
        }, helperPath);
        if (legacy.state === "complete") return "legacy";
      } catch {
        // A failed read cannot prove that removing either launcher is safe.
      }
      try {
        const v4 = await associations.inspect({
          ...registrationBase,
          openCommand: nextCommand,
        }, helperPath);
        if (v4.state === "complete") return "v4";
      } catch {
        // Preserve the v4 assets when the current command cannot be established.
      }
      return "unknown";
    };
    const legacyInspection = await associations.inspect({
      ...registrationBase,
      openCommand: legacyCommand,
    }, helperPath);
    let recovering = false;
    if (legacyInspection.state !== "complete") {
      const recoveryInspection = await associations.inspect({
        ...registrationBase,
        openCommand: nextCommand,
      }, helperPath);
      if (recoveryInspection.state !== "complete") {
        return skipped(t("Windows v3 注册存在漂移，不自动迁移。"));
      }
      recovering = true;
    }

    const before = await associations.queryCurrentDefaults(
      helperPath,
      owner.extensions,
    );
    const beforeError = windowsQueryErrorMessage(before);
    if (beforeError) {
      return {
        attempted: true,
        migrated: false,
        message: t("Windows 默认值无法验证，未执行迁移。"),
        error: beforeError,
      };
    }
    const preflight = await launcherPreflight();
    if (!preflight.ok) {
      return {
        attempted: true,
        migrated: false,
        message: t("Windows 启动器环境预检失败，未执行迁移。"),
        error: preflight.message,
      };
    }

    const createdPaths: string[] = [];
    let commandPointsToNew = recovering;
    let ownerCommitted = false;
    try {
      const wrapperPath = windowsV4PowerShellPath();
      if (writeManagedFileAtomically(
        wrapperPath,
        Buffer.from(`\uFEFF${windowsPowerShellWrapper()}`, "utf8"),
      ).created) {
        createdPaths.push(wrapperPath);
      }
      if (writeManagedFileAtomically(
        launcherPath,
        Buffer.from(windowsVbsLauncher(), "ascii"),
      ).created) {
        createdPaths.push(launcherPath);
      }

      const exchange = await associations.compareExchangeOpenCommand(
        helperPath,
        legacyCommand,
        nextCommand,
      );
      commandPointsToNew = exchange.currentCommand === nextCommand;
      if (exchange.currentCommand !== nextCommand) {
        throw new Error(t("Windows 打开命令在迁移期间被其它进程修改。"));
      }

      const verified = await associations.inspect({
        ...registrationBase,
        openCommand: nextCommand,
      }, helperPath);
      if (verified.state !== "complete") {
        throw new Error(
          t("Windows v4 注册验证失败：{v0}", { v0: windowsInspectionSummary(verified) }),
        );
      }
      const after = await associations.queryCurrentDefaults(
        helperPath,
        owner.extensions,
      );
      const afterError = windowsQueryErrorMessage(after);
      if (afterError) {
        throw new Error(t("Windows 默认值迁移后无法验证：{v0}", { v0: afterError }));
      }
      if (!windowsDefaultsAreEqual(owner.extensions, before, after)) {
        throw new Error(t("Windows 有效默认打开方式在迁移期间发生变化。"));
      }
      if (fs.readFileSync(ownerPath, "utf8") !== originalOwnerText) {
        throw new Error(t("Windows 打开器 owner 在迁移期间被其它进程修改。"));
      }

      const migratedOwner: ExternalFileOpenerOwner = {
        ...owner,
        commandPath: launcherPath,
        wrapperVersion: WINDOWS_FILE_OPENER_WRAPPER_VERSION,
        registrationVersion: WINDOWS_FILE_OPENER_REGISTRATION_VERSION,
      };
      delete migratedOwner.associationHelperPath;
      writeJson(ownerPath, migratedOwner);
      ownerCommitted = true;

      let notifyWarning = "";
      try {
        await associations.notifyAssociationChanged(helperPath);
      } catch (error) {
        notifyWarning = t("；Shell 刷新将在下次检查时重试：{v0}", { v0: error instanceof Error ? error.message : String(error) });
      }

      let cleanupWarning = "";
      for (const filePath of new Set([
        windowsStateOwnedPath(legacyWindowsPowerShellPath()),
        windowsStateOwnedPath(windowsAssociationHelperPath()),
      ])) {
        if (!filePath) continue;
        try {
          fs.rmSync(filePath, { force: true });
        } catch (error) {
          cleanupWarning = t("；旧文件将在清理时重试：{v0}", { v0: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        attempted: true,
        migrated: true,
        message:
          t(recovering ? "已恢复并完成" : "已完成") +
          t(" Windows v4 隐藏启动器迁移") +
          notifyWarning +
          cleanupWarning,
      };
    } catch (error) {
      let rollbackError = "";
      let commandState = await inspectCommandState();
      const shouldRestoreLegacy = !ownerCommitted && !recovering &&
        (commandState === "v4" ||
          (commandState === "unknown" && commandPointsToNew));
      if (shouldRestoreLegacy) {
        try {
          const rollback = await associations.compareExchangeOpenCommand(
            helperPath,
            nextCommand,
            legacyCommand,
          );
          if (rollback.currentCommand === legacyCommand) {
            commandState = "legacy";
          } else if (rollback.currentCommand === nextCommand) {
            commandState = "v4";
            rollbackError = t("；旧打开命令未能恢复");
          } else {
            commandState = "unknown";
            rollbackError = t("；当前打开命令无法确认");
          }
        } catch (rollbackFailure) {
          commandState = await inspectCommandState();
          if (commandState !== "legacy") {
            rollbackError = t("；恢复旧打开命令失败：{v0}", { v0: rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure) });
          }
        }
      }
      if (!ownerCommitted && commandState === "legacy") {
        if (shouldRestoreLegacy) {
          await associations.notifyAssociationChanged(helperPath).catch(() => undefined);
        }
        for (const filePath of createdPaths) fs.rmSync(filePath, { force: true });
      } else if (!ownerCommitted && createdPaths.length > 0) {
        rollbackError += t("；为避免注册指向缺失入口，已保留 v4 启动文件");
      }
      const details = error instanceof Error ? error.message : String(error);
      return {
        attempted: true,
        migrated: false,
        message: t("Windows 打开器自动迁移失败，未修改默认应用选择{v0}。", { v0: rollbackError }),
        error: details,
      };
    }
  });
}

export class ExternalFileOpenerSystem {
  private windowsMigrationInFlight:
    Promise<WindowsFileOpenerMigrationResult> | null = null;

  constructor(
    private readonly windowsLauncherPreflight = preflightWindowsLauncher,
    private readonly fileSymlinkPreflight: (
      vaultRoot: string,
      mirrorFolder: string,
    ) => Promise<ExternalFileSymlinkPreflightResult> = preflightExternalFileSymlink,
  ) {}

  async migrateWindowsFileOpener(
    currentVaultRoot: string,
    configuredExtensions: string[],
  ): Promise<WindowsFileOpenerMigrationResult> {
    if (this.windowsMigrationInFlight) return await this.windowsMigrationInFlight;
    const migration = performWindowsFileOpenerMigration(
      currentVaultRoot,
      configuredExtensions,
      this.windowsLauncherPreflight,
    ).catch((error): WindowsFileOpenerMigrationResult => ({
      attempted: true,
      migrated: false,
      message: t("Windows 打开器自动迁移失败，现有注册保持不变。"),
      error: error instanceof Error ? error.message : String(error),
    }));
    this.windowsMigrationInFlight = migration;
    try {
      return await migration;
    } finally {
      if (this.windowsMigrationInFlight === migration) {
        this.windowsMigrationInFlight = null;
      }
    }
  }

  async check(
    currentVaultRoot: string,
    configuredExtensions: string[],
  ): Promise<DefaultOpenerStatus> {
    const migration = await this.migrateWindowsFileOpener(
      currentVaultRoot,
      configuredExtensions,
    );
    const owner = readExternalFileOpenerOwner();
    if (migration.error) {
      return {
        kind: "not-default",
        message: `${migration.message} ${migration.error}`,
        owner,
        checkFailed: true,
      };
    }
    if (owner && !ownerAppBundleIsUsable(owner)) {
      return {
        kind: "not-default",
        message: t("AIDE 默认打开器记录存在，但 app 不可启动；请先清理再重新注入。"),
        owner,
      };
    }
    if (owner && !windowsOwnerLauncherIsUsable(owner)) {
      return {
        kind: "not-default",
        message: t("AIDE Windows 打开器记录存在，但 v4 启动文件缺失或不安全；请先清理再重新注入。"),
        owner,
        requiresReinstall: true,
      };
    }
    if (process.platform === "win32") {
      try {
        if (!owner) {
          const inspection = await withTemporaryWindowsAssociationHelper(
            (helperPath) => windowsFileAssociations().inspect({
              extensions: configuredExtensions,
              openCommand: windowsOpenCommand(windowsV4LauncherPath()),
              iconPath: process.execPath,
            }, helperPath),
          );
          return inspection.state === "absent"
            ? defaultOpenerStatusFromOwner(null, currentVaultRoot)
            : {
                kind: "not-default",
                message:
                  t("检测到没有 owner 的 AIDE Windows 残留注册：{v0}。请先清理再重新注入。", { v0: windowsInspectionSummary(inspection) }),
                owner: null,
                requiresReinstall: true,
              };
        }

        const legacyStatus = defaultOpenerStatusFromOwner(owner, currentVaultRoot);
        if (legacyStatus.requiresReinstall) return legacyStatus;

        const launcherPreflight = await this.windowsLauncherPreflight();
        if (!launcherPreflight.ok) {
          return {
            kind: "not-default",
            message: t("Windows 启动器环境不可用：{v0}", { v0: launcherPreflight.message }),
            owner,
            checkFailed: true,
          };
        }

        const commandPath = owner.commandPath || windowsV4LauncherPath();
        const inspectionOptions = await windowsRegistrationOptions(
          owner.extensions,
          windowsOpenCommand(commandPath),
          false,
        );
        return await withTemporaryWindowsAssociationHelper(async (helperPath) => {
          const associations = windowsFileAssociations();
          const inspection = await associations.inspect(
            inspectionOptions,
            helperPath,
          );
          const currentDefaults = await associations.queryCurrentDefaults(
            helperPath,
            owner.extensions,
          );
          return windowsDefaultOpenerStatus(
            owner,
            currentVaultRoot,
            configuredExtensions,
            inspection,
            currentDefaults,
          );
        });
      } catch (error) {
        return {
          kind: "not-default",
          message: t("Windows 默认打开方式检查失败：{v0}", { v0: error instanceof Error ? error.message : String(error) }),
          owner,
          checkFailed: true,
          requiresWindowsConfirmation: Boolean(owner),
        };
      }
    }
    return defaultOpenerStatusFromOwner(owner, currentVaultRoot);
  }

  async install(
    options: InstallExternalFileOpenerOptions,
  ): Promise<DefaultOpenerOperationResult> {
    const existing = readExternalFileOpenerOwner();
    if (existing) {
      const status = await this.check(options.vaultRoot, options.extensions);
      return {
        ok: false,
        status,
        message: t("{v0} 如需更换 owner，请先清理默认打开方式。", { v0: status.message }),
        failureKind: "existing-owner",
      };
    }
    if (process.platform === "win32") {
      let registration: WindowsFileAssociationInspection;
      try {
        registration = await withTemporaryWindowsAssociationHelper(
          (helperPath) => windowsFileAssociations().inspect({
            extensions: options.extensions,
            openCommand: windowsOpenCommand(windowsV4LauncherPath()),
            iconPath: process.execPath,
          }, helperPath),
        );
      } catch (error) {
        const status = defaultOpenerStatusFromOwner(null, options.vaultRoot);
        return {
          ok: false,
          status,
          message: t("Windows 注册预检失败：{v0}", { v0: error instanceof Error ? error.message : String(error) }),
          failureKind: "platform-install-failed",
        };
      }
      if (registration.state !== "absent") {
        const status: DefaultOpenerStatus = {
          kind: "not-default",
          message:
            t("检测到已有或残缺的 AIDE Windows 注册：{v0}。注入不会覆盖它，请先清理。", { v0: windowsInspectionSummary(registration) }),
          owner: null,
          requiresReinstall: true,
        };
        return {
          ok: false,
          status,
          message: status.message,
          failureKind: "stale-registration",
        };
      }
      const launcherPreflight = await this.windowsLauncherPreflight();
      if (!launcherPreflight.ok) {
        const status = defaultOpenerStatusFromOwner(null, options.vaultRoot);
        return {
          ok: false,
          status,
          message: launcherPreflight.message,
          failureKind: "platform-install-failed",
        };
      }
    }

    const symlinkPreflight = await this.fileSymlinkPreflight(
      options.vaultRoot,
      options.mirrorFolder,
    );
    const managedCopyFallbackAvailable = Boolean(
      !symlinkPreflight.ok &&
      isConcreteManagedCopyEligibleSymlinkFailure(symlinkPreflight.failure),
    );
    const symlinkFallbackActive =
      managedCopyFallbackAvailable &&
      options.allowManagedCopyFallback === true;
    if (
      !symlinkPreflight.ok &&
      !symlinkFallbackActive
    ) {
      const status = defaultOpenerStatusFromOwner(null, options.vaultRoot);
      return {
        ok: false,
        status,
        message: symlinkPreflight.message,
        failureKind:
          symlinkPreflight.failure?.reason === "permission-denied"
            ? "symlink-permission"
            : "symlink-unsupported",
        symlinkFailure: symlinkPreflight.failure,
        managedCopyFallbackEnabled: false,
        managedCopyFallbackAvailable,
      };
    }

    const owner: ExternalFileOpenerOwner = {
      marker: EXTERNAL_FILE_OPENER_MARKER,
      vaultRoot: options.vaultRoot,
      vaultName: options.vaultName,
      extensionMode: options.extensionMode,
      extensions: options.extensions,
      installedAt: Date.now(),
      platform: process.platform,
      managedCopyFallback: symlinkFallbackActive,
      symlinkPreflightPassed: symlinkPreflight.ok,
    };
    try {
      if (process.platform === "win32") {
        await installWindowsOpener(owner);
      } else {
        await installPlatformOpener(owner);
        writeJson(externalFileOpenerOwnerPath(), owner);
      }
    } catch (error) {
      if (error instanceof WindowsFileAssociationConflictError) {
        const status: DefaultOpenerStatus = {
          kind: "not-default",
          message: error.message,
          owner: null,
          requiresReinstall: true,
        };
        return {
          ok: false,
          status,
          message: status.message,
          failureKind: "stale-registration",
        };
      }
      if (error instanceof WindowsFileAssociationRollbackError) {
        const status = await this.check(options.vaultRoot, options.extensions);
        return {
          ok: false,
          status,
          message:
            t("Windows 注册写入失败且未能完整回滚；已保留 v4 启动文件，避免残留注册指向缺失入口。{v0} {v1}", { v0: status.message, v1: error.message }),
          failureKind: "platform-install-failed",
        };
      }
      if (process.platform !== "win32") {
        await cleanupPlatformOpener(owner).catch(() => undefined);
        fs.rmSync(externalFileOpenerOwnerPath(), { force: true });
      }
      const status = defaultOpenerStatusFromOwner(null, options.vaultRoot);
      return {
        ok: false,
        status,
        message: t("默认打开器注入失败：{v0}", { v0: error instanceof Error ? error.message : String(error) }),
        failureKind: "platform-install-failed",
      };
    }
    const status = await this.check(options.vaultRoot, options.extensions);
    const baseMessage =
      process.platform === "win32"
        ? status.message
        : t("已注入 AIDE 默认打开器。");
    const message = symlinkFallbackActive
      ? t("{v0} 符号链接预检未通过，已按本机授权启用受管临时副本兜底；后续新文件仍会先尝试真实符号链接。", { v0: baseMessage })
      : baseMessage;
    return {
      ok: true,
      status,
      message,
      warnings: symlinkFallbackActive ? [symlinkPreflight.message] : undefined,
      symlinkFailure: symlinkPreflight.failure,
      managedCopyFallbackEnabled: symlinkFallbackActive,
      managedCopyFallbackAvailable,
    };
  }

  async cleanup(
    currentVaultRoot: string,
    options: CleanupExternalFileOpenerOptions = {},
  ): Promise<DefaultOpenerOperationResult> {
    const ownerRecord = readExternalFileOpenerOwnerRecord();
    const owner = ownerRecord.owner;
    if (process.platform === "win32" && ownerRecord.state === "invalid") {
      const status = defaultOpenerStatusFromOwner(null, currentVaultRoot);
      return {
        ok: false,
        status,
        message:
          t("Windows 默认打开器 owner 文件存在但内容无效；为避免误删其它配置，本次未做任何修改。"),
        failureKind: "platform-cleanup-failed",
      };
    }
    if (
      process.platform === "win32" &&
      owner &&
      !sameVaultRoot(owner.vaultRoot, currentVaultRoot)
    ) {
      if (!options.confirmedOwner) {
        const status = defaultOpenerStatusFromOwner(owner, currentVaultRoot);
        return {
          ok: false,
          status,
          message: t("默认打开器属于其它仓库：{v0}。确认后才能清理。", { v0: owner.vaultRoot }),
          failureKind: "other-vault-confirmation-required",
        };
      }
      if (!ownerMatchesConfirmation(owner, options.confirmedOwner)) {
        const status = defaultOpenerStatusFromOwner(owner, currentVaultRoot);
        return {
          ok: false,
          status,
          message: t("默认打开器 owner 已发生变化；本次未做任何修改，请重新检查后确认。"),
          failureKind: "other-vault-confirmation-required",
        };
      }
    }

    try {
      const platformCleanup = await cleanupPlatformOpener(owner);
      if (owner) {
        removeManagedRuntime(owner.vaultRoot);
      } else if (process.platform === "win32") {
        removeManagedRuntime();
      } else {
        removeManagedRuntime(currentVaultRoot);
      }
      fs.rmSync(externalFileOpenerOwnerPath(), { force: true });
      const status = defaultOpenerStatusFromOwner(null, currentVaultRoot);
      const warnings = platformCleanup.warnings;
      const cleaned = Boolean(owner) || platformCleanup.removed > 0;
      return {
        ok: true,
        status,
        message: `${cleaned
          ? t("已清理 AIDE 默认打开器。")
          : t("没有发现需要清理的 AIDE 默认打开器。")}${
          warnings.length > 0 ? ` ${warnings.join("；")}` : ""
        }`,
        warnings,
        offerWindowsDefaultAppsSettings:
          process.platform === "win32" && cleaned,
      };
    } catch (error) {
      const status = defaultOpenerStatusFromOwner(owner, currentVaultRoot);
      return {
        ok: false,
        status,
        message: t("默认打开器清理失败；已保留 owner/runtime 以便重试：{v0}", {
          v0: error instanceof Error ? error.message : String(error),
        }),
        failureKind: "platform-cleanup-failed",
      };
    }
  }

  authorizeManagedCopyFallbackAfterFailure(
    vaultRoot: string,
    failure: FileSymlinkFailure,
  ): boolean {
    return authorizeManagedCopyFallbackAfterFailure(vaultRoot, failure);
  }

  managedCopyFallbackEnabled(vaultRoot: string): boolean {
    const owner = readExternalFileOpenerOwner();
    return Boolean(
      owner &&
      sameVaultRoot(owner.vaultRoot, vaultRoot) &&
      owner.managedCopyFallback === true,
    );
  }

  async diagnoseWindowsDeveloperMode(): Promise<WindowsDeveloperModeDiagnosis> {
    return await diagnoseWindowsDeveloperModeSupport();
  }

  async repairWindowsDeveloperMode(): Promise<WindowsDeveloperModeRepairResult> {
    return await repairWindowsDeveloperModeSupport();
  }

  async openWindowsDeveloperSettings(): Promise<void> {
    if (process.platform !== "win32") return;
    await windowsFileAssociations().openDeveloperSettings();
  }

  async openWindowsDefaultAppsSettings(): Promise<void> {
    if (process.platform !== "win32") return;
    await windowsFileAssociations().openDefaultAppsSettings();
  }

  async openWindowsGenericDefaultAppsSettings(): Promise<void> {
    if (process.platform !== "win32") return;
    await windowsFileAssociations().openGenericDefaultAppsSettings();
  }

  writeRuntime(options: RuntimeExternalFileOpenerOptions): void {
    const runtime: ExternalFileOpenerRuntime = {
      marker: EXTERNAL_FILE_OPENER_MARKER,
      vaultRoot: options.vaultRoot,
      vaultName: options.vaultName,
      port: options.port,
      token: options.token,
      pid: process.pid,
      updatedAt: Date.now(),
    };
    writeJson(externalFileOpenerRuntimePath(), runtime);
  }

  removeRuntime(vaultRoot: string): void {
    removeManagedRuntime(vaultRoot);
  }
}
