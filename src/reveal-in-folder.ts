// 系统文件动作分为两条互不混用的链：
// - 下载条目使用 Electron shell.openPath，交给系统默认应用打开；
// - “打开下载文件夹”/“在文件夹中显示”使用文件管理器命令，确保窗口前台显示。
// 所有平台命令都通过 execFile 的独立参数传递，不经过命令字符串。

import { execFile } from "node:child_process";

export type FileManagerKind = "select" | "open";

/** 构造各平台拉起文件管理器的命令。win32 的 /select, 与路径必须合成单参数。 */
export function revealCommand(
  platform: NodeJS.Platform,
  target: string,
  kind: FileManagerKind,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return kind === "select"
      ? { command: "explorer.exe", args: [`/select,${target}`] }
      : { command: "explorer.exe", args: [target] };
  }
  if (platform === "darwin") {
    return kind === "select"
      ? { command: "open", args: ["-R", target] }
      : { command: "open", args: [target] };
  }
  return { command: "xdg-open", args: [target] };
}

interface ElectronShellLike {
  app?: {
    getPath?(name: "downloads"): string;
  };
  shell?: {
    openPath?(path: string): Promise<string>;
    showItemInFolder?(fullPath: string): void;
  };
  remote?: {
    app?: {
      getPath?(name: "downloads"): string;
    };
    shell?: {
      openPath?(path: string): Promise<string>;
      showItemInFolder?(fullPath: string): void;
    };
  };
}

type ElectronShell = NonNullable<ElectronShellLike["shell"]>;

function electronIntegration(): ElectronShellLike | null {
  try {
    const globals = globalThis as {
      activeWindow?: { require?: (name: string) => unknown };
      window?: { require?: (name: string) => unknown };
      require?: (name: string) => unknown;
    };
    const requireModule =
      globals.activeWindow?.require ?? globals.window?.require ?? globals.require;
    return (requireModule?.("electron") as ElectronShellLike | undefined) ?? null;
  } catch {
    return null;
  }
}

function electronShell(): ElectronShell | null {
  const electron = electronIntegration();
  return electron?.remote?.shell ?? electron?.shell ?? null;
}

export type DefaultFileLauncher = (absolutePath: string) => Promise<string>;

export interface DefaultFileOpenResult {
  ok: boolean;
  error?: string;
}

/**
 * 按桌面默认方式打开文件。Electron 的空字符串表示成功，非空字符串是系统错误。
 * 不回退 explorer.exe：它对文件参数的语义因 Windows 版本而异，可能再次打开目录。
 */
export async function openFileWithDefaultApp(
  absolutePath: string,
  launcher?: DefaultFileLauncher,
): Promise<DefaultFileOpenResult> {
  const resolvedLauncher = launcher ?? (() => {
    const shell = electronShell();
    return typeof shell?.openPath === "function"
      ? shell.openPath.bind(shell)
      : null;
  })();
  if (!resolvedLauncher) {
    return { ok: false, error: "Electron shell.openPath is unavailable." };
  }
  try {
    const failure = await resolvedLauncher(absolutePath);
    return failure ? { ok: false, error: failure } : { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 获取 Electron 识别的系统下载目录；不可用时交给调用方回退。 */
export function electronDownloadsPath(): string | null {
  try {
    const electron = electronIntegration();
    const app = electron?.remote?.app ?? electron?.app;
    if (typeof app?.getPath !== "function") return null;
    const resolved = app.getPath("downloads");
    return typeof resolved === "string" && resolved.trim() ? resolved : null;
  } catch {
    return null;
  }
}

function spawnFileManager(
  platform: NodeJS.Platform,
  target: string,
  kind: FileManagerKind,
): Promise<boolean> {
  const { command, args } = revealCommand(platform, target, kind);
  return new Promise((resolve) => {
    try {
      // explorer.exe 即使成功打开窗口也常返回非 0 退出码，所以不看退出码：
      // 进程成功 spawn（'spawn' 事件）即算成功，'error' 才算失败。
      const child = execFile(command, args, () => {});
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function fallbackShell(target: string, kind: FileManagerKind): Promise<boolean> {
  try {
    const shell = electronShell();
    if (kind === "select" && typeof shell?.showItemInFolder === "function") {
      shell.showItemInFolder(target);
      return true;
    }
    if (kind === "open" && typeof shell?.openPath === "function") {
      const failure = await shell.openPath(target);
      return !failure;
    }
  } catch {
    // 落入 false
  }
  return false;
}

/** 前台拉起系统文件管理器；select=定位并选中文件，open=打开目录。 */
export async function runFileManager(
  target: string,
  kind: FileManagerKind,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  // linux 的 xdg-open <文件> 语义是「用默认应用打开文件」而非「在文件管理器
  // 中定位」，所以 select 在非 win32/darwin 下直接走 Electron
  // shell.showItemInFolder（桌面端必有）；xdg-open 只用于打开目录。
  const spawnOk =
    kind === "select" && platform !== "win32" && platform !== "darwin"
      ? false
      : await spawnFileManager(platform, target, kind);
  if (spawnOk) return true;
  return fallbackShell(target, kind);
}
