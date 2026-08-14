import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  editorInfoField,
  MarkdownView,
  normalizePath,
  TextFileView,
  type EventRef,
} from "obsidian";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { VimSession } from "../vim/core/session";
import type { VimRuntimeConfig, VimStatus } from "../vim/core/types";
import {
  createVimEditorExtension,
  type VimEditorControllerSet,
} from "../vim/codemirror/extension";
import { anyVimSourceEnabled, vimSourceSettings } from "../vim/settings";
import { resolveVimCursorColorCss } from "../vim/cursor-color";
import { t } from "../i18n";
import { ensureContainedVaultDirectory } from "../external-file-mirror-path";
import { loadVimrc } from "./vimrc-loader";
import { compileVimRuntime } from "../vim/vimrc/runtime";
import { isObsidianWorkspaceDragEvent } from "./workspace-drag";
import type {
  VimFeatureHandle,
  VimFeatureHost,
  VimLegacyConfigSource,
  VimFeatureStatus,
} from "./public";

const exec = promisify(childProcess.exec);
const EMPTY_RUNTIME = compileVimRuntime([]);

export function createVimFeature(host: VimFeatureHost): VimFeatureHandle {
  return new IndependentVimFeature(host);
}

class IndependentVimFeature implements VimFeatureHandle {
  private state: VimFeatureStatus = {
    state: "disabled",
    message: t("Vim 已关闭。"),
    editorCount: 0,
    loadedFiles: [],
  };
  private readonly extensionRoot: Extension[] = [];
  private extensionRegistered = false;
  private editorControllers: VimEditorControllerSet | null = null;
  private readonly runtimes = new Map<string, VimRuntimeConfig>();
  private readonly session = new VimSession();
  private watchers: fs.FSWatcher[] = [];
  private activeLeafEvent: EventRef | null = null;
  private rebuildTimer: number | null = null;
  private generation = 0;
  private diagnosticSignature = "";
  private statusBarItem: HTMLElement | null = null;
  private activeStatusView: EditorView | null = null;
  private readonly viewStatuses = new Map<EditorView, VimStatus>();
  private workspaceFocusRegistered = false;

  constructor(private readonly host: VimFeatureHost) {}

  async enable(): Promise<void> {
    if (this.state.state === "enabled" || this.state.state === "enabling") return;
    this.state = { ...this.state, state: "enabling", message: t("正在加载独立 Vim 引擎…") };
    try {
      await this.rebuildRuntimes();
      if (!this.hasEnabledSources()) {
        this.state = { ...this.state, state: "disabled", message: t("Vim 在加载过程中被关闭。") };
        return;
      }
      this.ensureStatusBarItem();
      this.registerWorkspaceFocus();
      this.activeLeafEvent = this.host.app.workspace.on(
        "active-leaf-change",
        () => this.syncActiveStatusView(),
      );
      this.editorControllers = createVimEditorExtension({
        session: this.session,
        documentForState: vimDocumentForState,
        sourceEnabled: (extension) => vimSourceSettings(
          this.host.getSettings(),
          extension,
        ).enabled,
        runtimeForExtension: (extension) => this.runtimes.get(extension) ?? EMPTY_RUNTIME,
        insertMappingsAllowed: (extension) => {
          if (!this.host.latexSuiteRuntimeEnabled(extension)) return true;
          return vimSourceSettings(
            this.host.getSettings(),
            extension,
          ).allowInsertMappingsWithLatexSuite;
        },
        externalCommandsAllowed: () => this.host.getSettings().allowExternalCommands,
        cursorColor: () => resolveVimCursorColorCss(this.host.getSettings()),
        shouldYieldKey: (view, event) => this.host.shouldYieldKey(view, event),
        isHostWorkspaceDragEvent: isObsidianWorkspaceDragEvent,
        onEnterVisual: (view) => this.host.onEnterVisual?.(view),
        onStatusChange: (view, status) => this.onViewStatus(view, status),
        onViewFocused: (view) => this.onViewFocused(view),
        hooksForView: (view) => this.hooksForView(view),
      });
      this.extensionRoot.splice(0, this.extensionRoot.length, this.editorControllers.extension);
      if (!this.extensionRegistered) {
        this.host.registerEditorExtension(this.extensionRoot);
        this.extensionRegistered = true;
      }
      this.host.refreshEditorExtensions();
      this.startWatching();
      this.state = {
        ...this.state,
        state: "enabled",
        message: t("独立 Vim 引擎已激活。"),
        editorCount: this.editorControllers.size,
      };
    } catch (error) {
      this.disable();
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, state: "error", message };
      this.host.notify(t("Vim 启动失败：{message}", { message }), 8000);
    }
  }

  disable(): void {
    this.generation += 1;
    this.clearRebuildTimer();
    this.stopWatching();
    if (this.activeLeafEvent) this.host.app.workspace.offref(this.activeLeafEvent);
    this.activeLeafEvent = null;
    this.editorControllers?.prepareForRemoval();
    this.extensionRoot.splice(0, this.extensionRoot.length);
    if (this.extensionRegistered) this.host.refreshEditorExtensions();
    this.editorControllers?.destroy();
    this.editorControllers = null;
    this.viewStatuses.clear();
    this.activeStatusView = null;
    this.unregisterWorkspaceFocus();
    this.statusBarItem?.remove();
    this.statusBarItem = null;
    this.runtimes.clear();
    this.state = {
      state: "disabled",
      message: t("Vim 已关闭；未注册任何编辑器处理器。"),
      editorCount: 0,
      loadedFiles: [],
    };
  }

  async settingsChanged(): Promise<void> {
    if (!this.hasEnabledSources()) {
      this.disable();
      return;
    }
    if (this.state.state !== "enabled") {
      await this.enable();
      return;
    }
    await this.rebuildRuntimes();
    this.editorControllers?.refreshRuntimes();
    this.startWatching();
    this.syncActiveStatusView();
  }

  async reload(): Promise<void> {
    if (this.state.state !== "enabled") return;
    await this.rebuildRuntimes();
    this.editorControllers?.refreshRuntimes();
    this.startWatching();
    this.host.notify(t("Vim 配置已重新加载。"), 3000);
  }

  status(): VimFeatureStatus {
    return {
      ...this.state,
      editorCount: this.editorControllers?.size ?? 0,
      loadedFiles: [...this.state.loadedFiles],
    };
  }

  effectiveSelection(view: EditorView) {
    return this.editorControllers?.effectiveSelection(view) ?? null;
  }

  async ensureVimrcFile(): Promise<void> {
    const directory = path.dirname(this.host.globalVimrcPath);
    await ensurePrivateVimrcDirectory(this.host.vaultRoot, directory);
    try {
      await fs.promises.writeFile(
        this.host.globalVimrcPath,
        '" mv-AIDE independent Vim configuration\n" Example: nnoremap H ^\n',
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  }

  async openVimrcFile(): Promise<void> {
    if (!await fileExists(this.host.globalVimrcPath)) await this.ensureVimrcFile();
    const error = await electronRuntime().shell.openPath(this.host.globalVimrcPath);
    if (error) throw new Error(error);
  }

  async hasLegacyVimrcFile(): Promise<boolean> {
    return !await fileExists(this.host.globalVimrcPath) &&
      await this.firstLegacyVimrcSource() !== null;
  }

  async migrateLegacyVimrcFile(): Promise<boolean> {
    if (await fileExists(this.host.globalVimrcPath)) return false;
    const legacy = await this.firstLegacyVimrcSource();
    if (!legacy) return false;
    const source = await fs.promises.readFile(legacy.filePath, "utf8");
    const directory = path.dirname(this.host.globalVimrcPath);
    await ensurePrivateVimrcDirectory(this.host.vaultRoot, directory);
    await fs.promises.writeFile(this.host.globalVimrcPath, source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (legacy.removeAfterMigration) {
      try {
        await fs.promises.unlink(legacy.filePath);
      } catch (error) {
        await fs.promises.unlink(this.host.globalVimrcPath).catch(() => undefined);
        throw error;
      }
      await fs.promises.rmdir(path.dirname(legacy.filePath)).catch(() => undefined);
    }
    await this.reload();
    return true;
  }

  private async rebuildRuntimes(): Promise<void> {
    const generation = ++this.generation;
    const extensions = new Set(this.host.sourceExtensions().filter((extension) =>
      vimSourceSettings(this.host.getSettings(), extension).enabled,
    ));
    const next = new Map<string, VimRuntimeConfig>();
    const loadedFiles = new Set<string>();
    const diagnostics: string[] = [];
    for (const extension of extensions) {
      const source = vimSourceSettings(this.host.getSettings(), extension);
      const loaded = await loadVimrc({
        globalPath: this.host.globalVimrcPath,
        virtualSource: source.virtualVimrc,
        virtualName: `${extension} virtual vimrc`,
        readFile: readOptionalUtf8,
      });
      if (generation !== this.generation) return;
      next.set(extension, loaded.runtime);
      for (const file of loaded.loadedFiles) loadedFiles.add(file);
      for (const diagnostic of loaded.diagnostics) {
        diagnostics.push(`${path.basename(diagnostic.source)}:${diagnostic.line} ${diagnostic.message}`);
      }
    }
    this.runtimes.clear();
    for (const [extension, runtime] of next) this.runtimes.set(extension, runtime);
    this.state = { ...this.state, loadedFiles: [...loadedFiles] };
    this.reportDiagnostics(diagnostics);
  }

  private hasEnabledSources(): boolean {
    return anyVimSourceEnabled(this.host.getSettings(), this.host.sourceExtensions());
  }

  private async firstLegacyVimrcSource(): Promise<VimLegacyConfigSource | null> {
    for (const source of this.host.legacyVimrcSources) {
      if (source.filePath === this.host.globalVimrcPath) continue;
      if (await fileExists(source.filePath)) return source;
    }
    return null;
  }

  private async saveCurrentView(view: EditorView): Promise<void> {
    const info = view.state.field(editorInfoField, false);
    if (info instanceof TextFileView) {
      await info.save();
      return;
    }
    const active = this.host.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path && active.file.path === info?.file?.path) {
      await active.save();
      return;
    }
    throw new Error(t("无法保存当前 Vim 编辑器视图。"));
  }

  private hooksForView(view: EditorView) {
    return {
      saveCurrentView: async () => this.saveCurrentView(view),
      onQuit: async () => {
        this.host.app.workspace.getMostRecentLeaf()?.detach();
      },
      onOpen: async (filePath: string) => {
        await this.host.app.workspace.openLinkText(normalizePath(filePath), currentFilePath(view), false);
      },
      onSplit: async (vertical: boolean, filePath?: string) => {
        executeObsidianCommand(this.host.app, vertical ? "workspace:split-vertical" : "workspace:split-horizontal");
        if (filePath) await this.host.app.workspace.openLinkText(normalizePath(filePath), currentFilePath(view), false);
      },
      onObsidianCommand: (id: string) => executeObsidianCommand(this.host.app, id),
      onExternalCommand: async (command: string) => {
        const result = await exec(command, { cwd: this.host.vaultRoot, timeout: 120_000 });
        const output = `${result.stdout}${result.stderr}`.trim();
        if (output) this.host.notify(output.slice(0, 4000), 8000);
      },
      readClipboard: () => electronRuntime().clipboard.readText(),
      writeClipboard: (text: string) => electronRuntime().clipboard.writeText(text),
      onError: (message: string) => this.host.notify(message, 6000),
    };
  }

  private ensureStatusBarItem(): void {
    if (this.statusBarItem) return;
    this.statusBarItem = this.host.createStatusBarItem();
    this.statusBarItem.classList.add("mv-aide-vim-statusbar");
    this.statusBarItem.hidden = true;
  }

  private onViewStatus(view: EditorView, status: VimStatus | null): void {
    if (status) this.viewStatuses.set(view, status);
    else this.viewStatuses.delete(view);
    if (view.hasFocus) this.activeStatusView = status ? view : null;
    if (this.activeStatusView === view && !status) this.activeStatusView = null;
    this.renderStatusBar();
  }

  private onViewFocused(view: EditorView): void {
    if (!this.viewStatuses.has(view)) return;
    this.activeStatusView = view;
    this.renderStatusBar();
  }

  private syncActiveStatusView(): void {
    const leaf = this.host.app.workspace.getMostRecentLeaf();
    const editorValue: unknown = leaf?.view ? Reflect.get(leaf.view, "editor") : undefined;
    const candidateValue: unknown = editorValue && typeof editorValue === "object"
      ? Reflect.get(editorValue, "cm")
      : undefined;
    const candidate = isEditorView(candidateValue) ? candidateValue : undefined;
    this.activeStatusView = candidate && this.viewStatuses.has(candidate)
      ? candidate
      : null;
    this.renderStatusBar();
  }

  private registerWorkspaceFocus(): void {
    if (this.workspaceFocusRegistered) return;
    this.host.app.workspace.containerEl.addEventListener(
      "focusin",
      this.onWorkspaceFocusIn,
      true,
    );
    this.workspaceFocusRegistered = true;
  }

  private unregisterWorkspaceFocus(): void {
    if (!this.workspaceFocusRegistered) return;
    this.host.app.workspace.containerEl.removeEventListener(
      "focusin",
      this.onWorkspaceFocusIn,
      true,
    );
    this.workspaceFocusRegistered = false;
  }

  private readonly onWorkspaceFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    const hostWindow = this.host.app.workspace.containerEl.ownerDocument.defaultView;
    if (!hostWindow || !(target instanceof hostWindow.Node)) return;
    for (const view of this.viewStatuses.keys()) {
      if (!view.dom.contains(target)) continue;
      this.activeStatusView = view;
      this.renderStatusBar();
      return;
    }
    if (target.instanceOf(hostWindow.Element) && target.closest(".cm-editor")) {
      this.activeStatusView = null;
      this.renderStatusBar();
    }
  };

  private renderStatusBar(): void {
    const item = this.statusBarItem;
    if (!item) return;
    const activeView = this.activeStatusView;
    const activeElement = activeView?.dom.ownerDocument.activeElement;
    const ownsFocus = Boolean(
      activeView &&
      (activeView.hasFocus || (activeElement && activeView.dom.contains(activeElement))),
    );
    const status = activeView && ownsFocus
      ? this.viewStatuses.get(activeView)
      : undefined;
    item.replaceChildren();
    item.classList.remove(
      "mv-aide-vim-statusbar-text",
      "mv-aide-vim-statusbar-color",
      ...VIM_STATUS_MODE_CLASSES,
    );
    if (!status) {
      item.hidden = true;
      item.removeAttribute("aria-label");
      item.removeAttribute("title");
      return;
    }

    item.hidden = false;
    const label = vimModeLabel(status);
    const display = this.host.getSettings().statusDisplay;
    item.classList.add(display === "color"
      ? "mv-aide-vim-statusbar-color"
      : "mv-aide-vim-statusbar-text");
    item.classList.add(`mv-aide-vim-statusbar-mode-${vimModeClass(status)}`);
    item.setAttribute("aria-label", t("Vim 模式：{label}", { label }));
    item.setAttribute("title", t("Vim 模式：{label}", { label }));
    if (display === "color") {
      const swatch = item.ownerDocument.createElement("span");
      swatch.className = "mv-aide-vim-statusbar-mode-color";
      swatch.setAttribute("aria-hidden", "true");
      item.appendChild(swatch);
    } else {
      const mode = item.ownerDocument.createElement("span");
      mode.className = "mv-aide-vim-statusbar-mode-text";
      mode.textContent = label;
      item.appendChild(mode);
    }

    const detail = vimStatusDetail(status);
    if (detail) {
      const detailElement = item.ownerDocument.createElement("span");
      detailElement.className = "mv-aide-vim-statusbar-detail";
      detailElement.textContent = detail;
      item.appendChild(detailElement);
    }
  }

  private startWatching(): void {
    this.stopWatching();
    const directories = new Set([
      path.dirname(this.host.globalVimrcPath),
      ...this.state.loadedFiles
        .map((file) => path.dirname(file)),
    ]);
    for (const directory of directories) {
      try {
        const watcher = fs.watch(directory, (_event, fileName) => {
          if (!fileName || fileName.toString().endsWith(".vimrc") || fileName.toString().endsWith(".vim")) {
            this.scheduleReload();
          }
        });
        this.watchers.push(watcher);
      } catch {
        // The external configuration directory is absent until the user creates it.
      }
    }
  }

  private stopWatching(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private scheduleReload(): void {
    this.clearRebuildTimer();
    const hostWindow = this.host.app.workspace.containerEl.ownerDocument.defaultView;
    if (!hostWindow) return;
    this.rebuildTimer = hostWindow.setTimeout(() => {
      this.rebuildTimer = null;
      void this.reload();
    }, 150);
  }

  private clearRebuildTimer(): void {
    if (this.rebuildTimer === null) return;
    this.host.app.workspace.containerEl.ownerDocument.defaultView?.clearTimeout(
      this.rebuildTimer,
    );
    this.rebuildTimer = null;
  }

  private reportDiagnostics(diagnostics: readonly string[]): void {
    const signature = diagnostics.join("\n");
    if (signature === this.diagnosticSignature) return;
    this.diagnosticSignature = signature;
    if (diagnostics.length === 0) return;
    const shown = diagnostics.slice(0, 5);
    const suffix = diagnostics.length > shown.length
      ? t("\n…还有 {count} 条", { count: diagnostics.length - shown.length })
      : "";
    this.host.notify(
      t("Vim 配置错误：\n{errors}", { errors: `${shown.join("\n")}${suffix}` }),
      10_000,
    );
  }
}

function currentFilePath(view: EditorView): string {
  const info = view.state.field(editorInfoField, false);
  return info?.file?.path ?? "";
}

function vimDocumentForState(state: EditorState): { filePath: string; extension: string } {
  const file = state.field(editorInfoField, false)?.file;
  return {
    filePath: file?.path ?? "untitled",
    extension: file?.extension?.toLowerCase() ?? "md",
  };
}

function isEditorView(value: unknown): value is EditorView {
  return typeof value === "object" && value !== null &&
    typeof Reflect.get(value, "dispatch") === "function" &&
    typeof Reflect.get(value, "hasFocus") === "boolean";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function ensurePrivateVimrcDirectory(
  vaultRoot: string,
  directory: string,
): Promise<void> {
  const realVaultRoot = await fs.promises.realpath(vaultRoot);
  const relativeDirectory = path.relative(
    path.resolve(vaultRoot),
    path.resolve(directory),
  );
  if (
    relativeDirectory === "" ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    throw new Error(t("Vim 配置目录必须位于当前 vault 内。"));
  }
  const canonicalDirectory = path.join(realVaultRoot, relativeDirectory);
  const realDirectory = ensureContainedVaultDirectory(
    realVaultRoot,
    canonicalDirectory,
    true,
  );
  if (process.platform === "win32") return;
  await fs.promises.chmod(realDirectory, 0o700);
  const storageRoot = path.dirname(realDirectory);
  if (path.basename(storageRoot) === "mv-aide") {
    await fs.promises.chmod(storageRoot, 0o700);
  }
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}


function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

interface ElectronRuntime {
  clipboard: {
    readText(): string;
    writeText(text: string): void;
  };
  shell: {
    openPath(filePath: string): Promise<string>;
  };
}

function electronRuntime(): ElectronRuntime {
  const runtimeRequire = Reflect.get(activeWindow, "require") as
    | ((moduleId: string) => unknown)
    | undefined;
  const runtime = runtimeRequire?.("electron") as Partial<ElectronRuntime> | undefined;
  if (!runtime?.clipboard || !runtime.shell) {
    throw new Error("Electron clipboard/shell runtime is unavailable.");
  }
  return runtime as ElectronRuntime;
}

function executeObsidianCommand(app: VimFeatureHost["app"], id: string): boolean {
  const commands = Reflect.get(app, "commands") as
    | { executeCommandById(commandId: string): boolean }
    | undefined;
  return commands?.executeCommandById(id) ?? false;
}

const VIM_STATUS_MODE_CLASSES = [
  "mv-aide-vim-statusbar-mode-normal",
  "mv-aide-vim-statusbar-mode-insert",
  "mv-aide-vim-statusbar-mode-replace",
  "mv-aide-vim-statusbar-mode-visual",
  "mv-aide-vim-statusbar-mode-operator",
  "mv-aide-vim-statusbar-mode-command",
] as const;

function vimModeClass(status: VimStatus): string {
  if (status.mode === "insert") return "insert";
  if (status.mode === "replace") return "replace";
  if (status.mode === "operator-pending") return "operator";
  if (status.mode === "command-line") return "command";
  if (status.mode.startsWith("visual")) return "visual";
  return "normal";
}

function vimModeLabel(status: VimStatus): string {
  if (status.mode === "visual-line") return "VISUAL LINE";
  if (status.mode === "visual-block") return "VISUAL BLOCK";
  if (status.mode === "operator-pending") return "OPERATOR";
  if (status.mode === "command-line") return "COMMAND";
  return status.mode.toUpperCase();
}

function vimStatusDetail(status: VimStatus): string {
  return [
    status.recordingRegister ? `recording @${status.recordingRegister}` : "",
    // 命令行输入内容已由编辑器底部的命令行面板回显，状态栏不再重复显示。
    status.mode === "command-line" ? "" : status.command,
    status.message,
  ].filter(Boolean).join("  ");
}
