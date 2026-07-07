import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExternalFileOpenerExtensionMode,
} from "./types";

const execFile = promisify(childProcess.execFile);

export const EXTERNAL_FILE_OPENER_MARKER = "mv-senceai-file-opener-v1";
export const EXTERNAL_FILE_OPENER_BUNDLE_ID = "com.mv.senceai.file-opener";
export const EXTERNAL_FILE_OPENER_PROG_ID = "MV.SenceAI.FileOpener";

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
}

export interface DefaultOpenerOperationResult {
  ok: boolean;
  status: DefaultOpenerStatus;
  message: string;
}

export interface InstallExternalFileOpenerOptions {
  vaultRoot: string;
  vaultName: string;
  extensionMode: ExternalFileOpenerExtensionMode;
  extensions: string[];
}

export interface RuntimeExternalFileOpenerOptions {
  vaultRoot: string;
  vaultName: string;
  port: number;
  token: string;
}

export function externalFileOpenerStateDirectory(): string {
  return path.join(os.homedir(), ".mv-senceai");
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
      message: "SenceAI 不是系统默认打开器。",
      owner: null,
    };
  }
  if (sameVaultRoot(owner.vaultRoot, currentVaultRoot)) {
    return {
      kind: "current-vault",
      message: "SenceAI 的本仓库是系统默认打开器。",
      owner,
    };
  }
  return {
    kind: "other-vault",
    message: `SenceAI 是系统默认打开器，但 owner 是：${owner.vaultRoot}`,
    owner,
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

export function readExternalFileOpenerOwner(): ExternalFileOpenerOwner | null {
  const owner = readJson<Partial<ExternalFileOpenerOwner>>(
    externalFileOpenerOwnerPath(),
  );
  return owner?.marker === EXTERNAL_FILE_OPENER_MARKER &&
    typeof owner.vaultRoot === "string" &&
    typeof owner.vaultName === "string"
    ? (owner as ExternalFileOpenerOwner)
    : null;
}

function macAppPath(): string {
  return path.join(
    externalFileOpenerStateDirectory(),
    "MV SenceAI File Opener.app",
  );
}

function windowsCommandPath(): string {
  return path.join(externalFileOpenerStateDirectory(), "mv-senceai-file-opener.cmd");
}

function linuxCommandPath(): string {
  return path.join(externalFileOpenerStateDirectory(), "mv-senceai-file-opener");
}

function linuxDesktopPath(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "applications",
    "mv-senceai-file-opener.desktop",
  );
}

function macShellWrapper(): string {
  return `#!/bin/zsh
DIR="$(cd "$(dirname "$0")" && pwd)"
/usr/bin/osascript -l JavaScript "$DIR/mv-senceai-file-opener.jxa" "$@"
`;
}

function macJxaWrapper(): string {
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
  const stateDir = ObjC.unwrap($.NSHomeDirectory()) + "/.mv-senceai";
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

function macInfoPlist(extensions: string[]): string {
  const extensionItems = extensions.map((extension) => `        <string>${extension}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${EXTERNAL_FILE_OPENER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>MV SenceAI File Opener</string>
  <key>CFBundleExecutable</key>
  <string>droplet</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>aplt</string>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key>
      <string>Markdown and SenceAI source files</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>CFBundleTypeExtensions</key>
      <array>
${extensionItems}
      </array>
      <key>LSHandlerRank</key>
      <string>Owner</string>
    </dict>
  </array>
</dict>
</plist>
`;
}

function macAppletScript(): string {
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
  const stateDir = ObjC.unwrap($.NSHomeDirectory()) + "/.mv-senceai";
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
    "mv-senceai-file-opener.jxa",
  );
  fs.writeFileSync(sourcePath, macAppletScript(), "utf8");
  await execFile("/usr/bin/osacompile", ["-l", "JavaScript", "-o", appPath, sourcePath]);
  fs.rmSync(sourcePath, { force: true });

  const macOsPath = path.join(appPath, "Contents", "MacOS");
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  fs.mkdirSync(macOsPath, { recursive: true });
  fs.writeFileSync(infoPath, macInfoPlist(owner.extensions), "utf8");
  const executablePath = path.join(macOsPath, "mv-senceai-file-opener");
  fs.writeFileSync(executablePath, macShellWrapper(), { mode: 0o755 });
  fs.writeFileSync(
    path.join(macOsPath, "mv-senceai-file-opener.jxa"),
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

function windowsPowerShellWrapper(): string {
  return String.raw`param([string]$FilePath)
$StateDir = Join-Path $HOME ".mv-senceai"
$OwnerPath = Join-Path $StateDir "file-opener-owner.json"
$RuntimePath = Join-Path $StateDir "file-opener-runtime.json"
if (!(Test-Path $OwnerPath)) { exit 2 }
$Owner = Get-Content $OwnerPath -Raw | ConvertFrom-Json
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path $RuntimePath) {
    $Runtime = Get-Content $RuntimePath -Raw | ConvertFrom-Json
    if ($Runtime.vaultRoot -eq $Owner.vaultRoot) {
      try {
        Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:{0}/external-file/open" -f $Runtime.port) -Headers @{ Authorization = ("Bearer " + $Runtime.token) } -ContentType "application/json" -Body (@{ path = $FilePath; makeFrontmost = $true } | ConvertTo-Json -Compress) | Out-Null
        exit 0
      } catch {}
    }
  }
  Start-Process ("obsidian://open?vault=" + [uri]::EscapeDataString($Owner.vaultName))
  Start-Sleep -Milliseconds 500
}
exit 1
`;
}

async function installWindowsOpener(owner: ExternalFileOpenerOwner): Promise<void> {
  const stateDir = externalFileOpenerStateDirectory();
  fs.mkdirSync(stateDir, { recursive: true });
  const ps1Path = path.join(stateDir, "mv-senceai-file-opener.ps1");
  const cmdPath = windowsCommandPath();
  fs.writeFileSync(ps1Path, windowsPowerShellWrapper(), "utf8");
  fs.writeFileSync(
    cmdPath,
    `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}" "%~1"\r\n`,
    "utf8",
  );
  owner.commandPath = cmdPath;
  await execFile("reg", [
    "add",
    `HKCU\\Software\\Classes\\${EXTERNAL_FILE_OPENER_PROG_ID}\\shell\\open\\command`,
    "/ve",
    "/d",
    `"${cmdPath}" "%1"`,
    "/f",
  ]);
  for (const extension of owner.extensions) {
    await execFile("reg", [
      "add",
      `HKCU\\Software\\Classes\\.${extension}`,
      "/ve",
      "/d",
      EXTERNAL_FILE_OPENER_PROG_ID,
      "/f",
    ]);
  }
}

async function cleanupWindowsOpener(owner: ExternalFileOpenerOwner | null): Promise<void> {
  for (const extension of owner?.extensions ?? ["md", "markdown"]) {
    await execFile("reg", [
      "delete",
      `HKCU\\Software\\Classes\\.${extension}`,
      "/ve",
      "/f",
    ]).catch(() => undefined);
  }
  await execFile("reg", [
    "delete",
    `HKCU\\Software\\Classes\\${EXTERNAL_FILE_OPENER_PROG_ID}`,
    "/f",
  ]).catch(() => undefined);
}

function linuxShellWrapper(): string {
  return `#!/bin/sh
python3 - "$1" <<'PY'
import json, os, subprocess, sys, time, urllib.parse, urllib.request
state_dir = os.path.join(os.path.expanduser("~"), ".mv-senceai")
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
Name=MV SenceAI File Opener
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
    throw new Error(`暂不支持当前平台：${process.platform}`);
  }
}

async function cleanupPlatformOpener(owner: ExternalFileOpenerOwner | null): Promise<void> {
  if (process.platform === "darwin") {
    await cleanupMacOpener(owner);
  } else if (process.platform === "win32") {
    await cleanupWindowsOpener(owner);
  } else if (process.platform === "linux") {
    await cleanupLinuxOpener(owner);
  }
}

export class ExternalFileOpenerSystem {
  check(currentVaultRoot: string): DefaultOpenerStatus {
    const owner = readExternalFileOpenerOwner();
    if (owner && !ownerAppBundleIsUsable(owner)) {
      return {
        kind: "not-default",
        message: "SenceAI 默认打开器记录存在，但 app 不可启动；请先清理再重新注入。",
        owner,
      };
    }
    return defaultOpenerStatusFromOwner(owner, currentVaultRoot);
  }

  async install(
    options: InstallExternalFileOpenerOptions,
  ): Promise<DefaultOpenerOperationResult> {
    const existing = readExternalFileOpenerOwner();
    if (existing) {
      const status = defaultOpenerStatusFromOwner(existing, options.vaultRoot);
      return {
        ok: false,
        status,
        message: `${status.message} 如需更换 owner，请先清理默认打开方式。`,
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
    };
    await installPlatformOpener(owner);
    writeJson(externalFileOpenerOwnerPath(), owner);
    const status = defaultOpenerStatusFromOwner(owner, options.vaultRoot);
    return {
      ok: true,
      status,
      message: "已注入 SenceAI 默认打开器。",
    };
  }

  async cleanup(currentVaultRoot: string): Promise<DefaultOpenerOperationResult> {
    const owner = readExternalFileOpenerOwner();
    await cleanupPlatformOpener(owner);
    fs.rmSync(externalFileOpenerOwnerPath(), { force: true });
    const status = defaultOpenerStatusFromOwner(null, currentVaultRoot);
    return {
      ok: true,
      status,
      message: owner
        ? "已清理 SenceAI 默认打开器。"
        : "没有发现 SenceAI 默认打开器记录。",
    };
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
    const runtime = readJson<Partial<ExternalFileOpenerRuntime>>(
      externalFileOpenerRuntimePath(),
    );
    if (!runtime?.vaultRoot || !sameVaultRoot(runtime.vaultRoot, vaultRoot)) return;
    fs.rmSync(externalFileOpenerRuntimePath(), { force: true });
  }
}
