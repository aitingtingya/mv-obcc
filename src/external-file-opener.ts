import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TFile, type App, type WorkspaceLeaf } from "obsidian";
import {
  normalizeSourceAssistExtension,
} from "./source-assist/source-assist-settings";
import type {
  BridgeSettings,
  ExternalFileMapping,
  ExternalFileOpenerExtensionMode,
} from "./types";

export interface ExternalFileOpenResult {
  success: boolean;
  externalPath: string;
  vaultPath: string | null;
  message?: string;
}

interface ExternalFileOpenerOptions {
  app: App;
  getSettings: () => BridgeSettings;
  getVaultRoot: () => string;
  saveSettings: () => Promise<void>;
  focusObsidianApp?: () => Promise<void>;
}

export const MARKDOWN_EXTERNAL_EXTENSIONS = ["md", "markdown"] as const;
const execFile = promisify(childProcess.execFile);

export function normalizeExternalFileOpenerExtensionMode(
  value: unknown,
): ExternalFileOpenerExtensionMode {
  return value === "markdown-and-source-assist"
    ? "markdown-and-source-assist"
    : "markdown-only";
}

export function externalFileAllowedExtensions(
  settings: Pick<BridgeSettings, "externalFileOpener" | "sourceAssist">,
): string[] {
  const extensions = new Set<string>(MARKDOWN_EXTERNAL_EXTENSIONS);
  if (settings.externalFileOpener.extensionMode === "markdown-and-source-assist") {
    for (const profile of settings.sourceAssist.profiles) {
      if (!profile.enabled) continue;
      const extension = normalizeSourceAssistExtension(profile.extension);
      if (extension && extension !== "md" && extension !== "markdown") {
        extensions.add(extension);
      }
    }
  }
  return Array.from(extensions);
}

export function normalizeExternalFileExtension(filePath: string): string {
  return path
    .extname(filePath.replace(/\\/g, "/"))
    .replace(/^\./, "")
    .toLowerCase();
}

export function isExternalFileExtensionAllowed(
  settings: Pick<BridgeSettings, "externalFileOpener" | "sourceAssist">,
  filePath: string,
): boolean {
  const extension = normalizeExternalFileExtension(filePath);
  return extension !== "" && externalFileAllowedExtensions(settings).includes(extension);
}

export function isAbsoluteExternalPath(filePath: string): boolean {
  return (
    path.isAbsolute(filePath) ||
    /^[a-zA-Z]:[\\/]/.test(filePath) ||
    /^\\\\[^\\]+\\[^\\]+/.test(filePath)
  );
}

export function normalizeExternalFilePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error("外部文件路径为空。");
  const resolved = trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed;
  if (!isAbsoluteExternalPath(resolved)) {
    throw new Error("外部文件路径必须是绝对路径。");
  }
  return process.platform === "win32"
    ? path.win32.normalize(resolved)
    : path.normalize(resolved);
}

function normalizeVaultPath(vaultPath: string): string {
  return vaultPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function safeBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.split("/").filter(Boolean).pop() || "external.md";
  return name.replace(/[<>:"|?*\x00-\x1F]/g, "_");
}

export function externalFileMirrorPath(
  mirrorFolder: string,
  externalPath: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(externalPath)
    .digest("hex")
    .slice(0, 16);
  return normalizeVaultPath(`${mirrorFolder}/${hash}/${safeBasename(externalPath)}`);
}

function comparePaths(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

interface ElectronWindowLike {
  focus?: () => void;
  show?: () => void;
  restore?: () => void;
  isMinimized?: () => boolean;
}

interface ElectronLike {
  remote?: {
    app?: { focus?: (options?: { steal?: boolean }) => void };
    getCurrentWindow?: () => ElectronWindowLike;
  };
}

function rendererWindow(): (Window & { require?: (moduleName: string) => unknown }) | null {
  const globals = globalThis as unknown as {
    activeWindow?: Window & { require?: (moduleName: string) => unknown };
    window?: Window & { require?: (moduleName: string) => unknown };
  };
  return globals.activeWindow ?? globals.window ?? null;
}

function focusElectronWindow(): boolean {
  let focused = false;
  try {
    const electron = rendererWindow()?.require?.("electron") as ElectronLike | undefined;
    const currentWindow = electron?.remote?.getCurrentWindow?.();
    if (currentWindow?.isMinimized?.()) {
      currentWindow.restore?.();
      focused = true;
    }
    currentWindow?.show?.();
    currentWindow?.focus?.();
    if (currentWindow?.show || currentWindow?.focus) focused = true;
    electron?.remote?.app?.focus?.({ steal: true });
    if (electron?.remote?.app?.focus) focused = true;
  } catch {
    // Electron focus is best effort; platform fallback may still work.
  }

  try {
    rendererWindow()?.focus?.();
    focused = true;
  } catch {
    // Browser window focus is also best effort.
  }
  return focused;
}

export async function focusObsidianApp(): Promise<void> {
  let focused = focusElectronWindow();
  if (process.platform === "darwin") {
    try {
      await execFile("/usr/bin/open", ["-b", "md.obsidian"]);
      focused = true;
    } catch {
      try {
        await execFile("/usr/bin/open", ["-a", "Obsidian"]);
        focused = true;
      } catch (error) {
        if (!focused) throw error;
      }
    }
  }
  if (!focused) {
    throw new Error("No available Obsidian focus mechanism.");
  }
}

export class ExternalFileOpenerFeature {
  constructor(private readonly options: ExternalFileOpenerOptions) {}

  allowedExtensions(): string[] {
    return externalFileAllowedExtensions(this.options.getSettings());
  }

  async openExternalFile(
    rawExternalPath: string,
    options: { makeFrontmost?: boolean } = {},
  ): Promise<ExternalFileOpenResult> {
    let externalPath = "";
    try {
      const settings = this.options.getSettings();
      if (!settings.externalFileOpener.enabled) {
        throw new Error("默认文件打开器已关闭。");
      }

      externalPath = normalizeExternalFilePath(rawExternalPath);
      if (!isExternalFileExtensionAllowed(settings, externalPath)) {
        throw new Error(
          `不支持该后缀：.${normalizeExternalFileExtension(externalPath) || "unknown"}`,
        );
      }

      const stat = fs.statSync(externalPath);
      if (!stat.isFile()) throw new Error("只能打开文件，不能打开文件夹。");

      const mapping = await this.linkExternalFile(externalPath);
      await this.options.saveSettings();

      const file = await this.waitForIndexedFile(mapping.vaultPath);
      if (!file) {
        throw new Error(`Obsidian 尚未索引镜像文件：${mapping.vaultPath}`);
      }

      const makeFrontmost = options.makeFrontmost !== false;
      const leaf = this.options.app.workspace.getLeaf(false);
      await leaf.openFile(file, { active: makeFrontmost });
      if (makeFrontmost) {
        await this.revealLeaf(leaf);
        await this.focusObsidianAppBestEffort();
      }
      return {
        success: true,
        externalPath,
        vaultPath: mapping.vaultPath,
      };
    } catch (error) {
      return {
        success: false,
        externalPath: externalPath || rawExternalPath,
        vaultPath: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async focusObsidianAppBestEffort(): Promise<void> {
    try {
      await (this.options.focusObsidianApp ?? focusObsidianApp)();
    } catch (error) {
      console.warn("[mv-senceai-ide] Failed to focus Obsidian.", error);
    }
  }

  async pruneBrokenMappings(): Promise<number> {
    const settings = this.options.getSettings().externalFileOpener;
    let removed = 0;
    for (const [externalPath, mapping] of Object.entries(settings.mappings)) {
      if (
        !fs.existsSync(externalPath) ||
        !this.isSymlinkValid(mapping.vaultPath, externalPath)
      ) {
        this.removeMirrorSymlink(mapping.vaultPath);
        delete settings.mappings[externalPath];
        removed++;
      }
    }
    if (removed > 0) await this.options.saveSettings();
    return removed;
  }

  private async linkExternalFile(externalPath: string): Promise<ExternalFileMapping> {
    const settings = this.options.getSettings().externalFileOpener;
    const existing = settings.mappings[externalPath];
    if (existing && this.isSymlinkValid(existing.vaultPath, externalPath)) {
      return existing;
    }
    if (existing) this.removeMirrorSymlink(existing.vaultPath);

    const extension = normalizeExternalFileExtension(externalPath);
    const preferred = externalFileMirrorPath(settings.mirrorFolder, externalPath);
    const vaultPath = this.availableMirrorPath(preferred, externalPath);
    this.createMirrorSymlink(externalPath, vaultPath);

    const mapping: ExternalFileMapping = {
      externalPath,
      vaultPath,
      createdAt: Date.now(),
      extension,
    };
    settings.mappings[externalPath] = mapping;
    return mapping;
  }

  private availableMirrorPath(preferred: string, externalPath: string): string {
    const vaultRoot = this.options.getVaultRoot();
    const parsed = path.posix.parse(preferred);
    for (let index = 0; index < 100; index++) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = normalizeVaultPath(
        path.posix.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`),
      );
      const absolute = path.join(vaultRoot, candidate);
      try {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(absolute);
          if (comparePaths(target, externalPath)) return candidate;
        }
      } catch {
        return candidate;
      }
    }
    throw new Error("无法为外部文件分配镜像路径。");
  }

  private createMirrorSymlink(externalPath: string, vaultPath: string): void {
    const absolute = path.join(this.options.getVaultRoot(), vaultPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fs.unlinkSync(absolute);
    } catch {
      // Missing path is expected.
    }
    fs.symlinkSync(externalPath, absolute, "file");
  }

  private removeMirrorSymlink(vaultPath: string): void {
    const absolute = path.join(this.options.getVaultRoot(), vaultPath);
    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) fs.unlinkSync(absolute);
    } catch {
      // Already gone.
    }
  }

  private isSymlinkValid(vaultPath: string, externalPath: string): boolean {
    try {
      const absolute = path.join(this.options.getVaultRoot(), vaultPath);
      const stat = fs.lstatSync(absolute);
      return stat.isSymbolicLink() && comparePaths(fs.readlinkSync(absolute), externalPath);
    } catch {
      return false;
    }
  }

  private async waitForIndexedFile(vaultPath: string): Promise<TFile | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const file = this.options.app.vault.getAbstractFileByPath(vaultPath);
      if (file instanceof TFile) return file;
      await new Promise((resolve) => activeWindow.setTimeout(resolve, 250));
    }
    return null;
  }

  private async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const workspace = this.options.app.workspace as unknown as {
      revealLeaf?: (target: WorkspaceLeaf) => Promise<void>;
    };
    await workspace.revealLeaf?.(leaf);
  }
}
