// 内置浏览器登录兼容只做运行时诊断，不修改 WebView 身份。
// Obsidian core 已负责从浏览器 session UA 中清除 Obsidian/Electron token；
// 插件再次伪装 Safari、篡改 WebAuthn 或覆盖 webRequest 会制造矛盾指纹并干扰认证。

export const OBSIDIAN_DOWNLOAD_URL = "https://obsidian.md/download";
export const WINDOWS_LOGIN_BASELINE = {
  electronMajor: 39,
  chromiumMajor: 142,
} as const;

export interface BrowserRuntimeVersions {
  electron?: string;
  chrome?: string;
}

export type BrowserLoginRuntimeState =
  | "supported"
  | "outdated"
  | "unknown"
  | "not-windows";

export interface BrowserLoginRuntimeStatus {
  state: BrowserLoginRuntimeState;
  electronVersion: string | null;
  chromiumVersion: string | null;
  electronMajor: number | null;
  chromiumMajor: number | null;
}

function versionMajor(version: string | undefined): number | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)(?:\.|$)/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

/**
 * 判断当前 Windows Electron/Chromium 是否达到本插件完成真实 Apple 登录验收的
 * 基线。该基线不是 Apple 官方最低版本，也不会阻止用户继续使用 Web Viewer。
 */
export function browserLoginRuntimeStatus(
  platform: NodeJS.Platform,
  versions: BrowserRuntimeVersions,
): BrowserLoginRuntimeStatus {
  const electronVersion = versions.electron?.trim() || null;
  const chromiumVersion = versions.chrome?.trim() || null;
  const electronMajor = versionMajor(electronVersion ?? undefined);
  const chromiumMajor = versionMajor(chromiumVersion ?? undefined);
  if (platform !== "win32") {
    return {
      state: "not-windows",
      electronVersion,
      chromiumVersion,
      electronMajor,
      chromiumMajor,
    };
  }
  if (electronMajor === null || chromiumMajor === null) {
    return {
      state: "unknown",
      electronVersion,
      chromiumVersion,
      electronMajor,
      chromiumMajor,
    };
  }
  return {
    state:
      electronMajor >= WINDOWS_LOGIN_BASELINE.electronMajor &&
      chromiumMajor >= WINDOWS_LOGIN_BASELINE.chromiumMajor
        ? "supported"
        : "outdated",
    electronVersion,
    chromiumVersion,
    electronMajor,
    chromiumMajor,
  };
}

interface ElectronShellLike {
  shell?: {
    openExternal?(url: string): Promise<void>;
  };
  remote?: {
    shell?: {
      openExternal?(url: string): Promise<void>;
    };
  };
}

export type ExternalUrlLauncher = (url: string) => Promise<void>;

/** 通过 Electron 的系统浏览器打开官方 installer 下载页。 */
export async function openObsidianDownloadPage(
  launcher?: ExternalUrlLauncher,
): Promise<void> {
  if (launcher) {
    await launcher(OBSIDIAN_DOWNLOAD_URL);
    return;
  }
  const globals = globalThis as {
    activeWindow?: { require?: (name: string) => unknown };
    window?: { require?: (name: string) => unknown };
    require?: (name: string) => unknown;
  };
  const requireModule =
    globals.activeWindow?.require ?? globals.window?.require ?? globals.require;
  if (typeof requireModule !== "function") {
    throw new Error("Electron require is unavailable.");
  }
  let electron: ElectronShellLike;
  try {
    electron = requireModule("electron") as ElectronShellLike;
  } catch {
    throw new Error("Electron require is unavailable.");
  }
  const shell = electron.remote?.shell ?? electron.shell;
  if (typeof shell?.openExternal !== "function") {
    throw new Error("Electron shell.openExternal is unavailable.");
  }
  await shell.openExternal(OBSIDIAN_DOWNLOAD_URL);
}
