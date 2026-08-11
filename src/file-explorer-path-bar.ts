// 文件资源管理器浏览增强：在核心文件列表（file-explorer）的原生工具行注入一个
// 文件夹按钮，点击弹出任意目录浏览弹窗（FolderBrowseModal，仿系统下载弹窗）：
// 顶部为位置下拉 + 可编辑路径输入框 + 「全量显示」开关 + 「在文件夹中显示」，
// 下方为目录内容列表，文件夹可下钻；文件行点击经插件路由（Obsidian 可打开则
// 在本仓库打开，否则系统默认应用），行右侧另有「默认打开器打开」（恒系统默认
// 应用）与「在文件夹中显示」按钮。
// 原生文件列表本体不做任何改动，始终停留在仓库目录。
// 过滤、排序、路径展开等纯函数集中在文件顶部导出，
// 便于单测（测试通过 vi.mock 提供 Modal/Notice/setIcon）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Modal,
  Notice,
  setIcon,
  type App,
  type ItemView,
  type View,
} from "obsidian";
import type MvSenceAiIdePlugin from "../main";
import { downloadsDir, formatBytes, sortByMtimeDesc } from "./downloads-list";
import { t } from "./i18n";
import {
  electronDownloadsPath,
  openFileWithDefaultApp,
  runFileManager,
  type DefaultFileOpenResult,
} from "./reveal-in-folder";
import { getVaultRoot } from "./selection";

const FILE_EXPLORER_VIEW_TYPE = "file-explorer";
const MAX_RECENT_PATHS = 10;
const MAX_BROWSE_ENTRIES = 200;

/** viewRegistry 不可用时判定「Obsidian 可打开」的内置扩展名清单。 */
export const FALLBACK_OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "canvas",
  "base",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "mp4",
  "webm",
  "mov",
  "mkv",
]);

/** 文件名取小写扩展名；无扩展名或以 . 开头的隐藏文件返回 ""。 */
export function extensionOfFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 展开 ~ 与 ~/，其他输入原样。 */
export function expandHomePath(input: string, homedir: string): string {
  if (input === "~") return homedir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homedir, input.slice(2));
  }
  return input;
}

/** 最近访问列表：去重、最新在前、限量。 */
export function pushRecentPath(
  list: readonly string[],
  entry: string,
  max = MAX_RECENT_PATHS,
): string[] {
  return [entry, ...list.filter((item) => item !== entry)].slice(0, max);
}

/**
 * 解析注入按钮的宿主元素。
 * contentEl 是社区 ItemView 的 API；Obsidian 核心视图（如文件列表）只暴露
 * containerEl，因此这里按 contentEl → containerEl 回退。两者都没有返回 null。
 */
export function resolveViewHostEl(view: ItemView): HTMLElement | null {
  return view.contentEl ?? view.containerEl ?? null;
}

export interface BrowseEntry {
  name: string;
  isFolder: boolean;
  size: number;
  mtimeMs: number;
}

/** 位置下拉中的一项。 */
export interface BrowseLocation {
  label: string;
  path: string;
}

/** 文件夹始终保留；文件按 showAll 或 canOpen 过滤。 */
export function filterBrowsableEntries<T extends BrowseEntry>(
  entries: readonly T[],
  showAll: boolean,
  canOpen: (name: string) => boolean,
): T[] {
  return entries.filter(
    (entry) => entry.isFolder || showAll || canOpen(entry.name),
  );
}

/** 文件夹按名称在前，文件按修改时间倒序在后。 */
export function sortBrowseEntries(
  entries: readonly BrowseEntry[],
): BrowseEntry[] {
  const folders = entries
    .filter((entry) => entry.isFolder)
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = sortByMtimeDesc(entries.filter((entry) => !entry.isFolder));
  return [...folders, ...files];
}

async function listBrowseEntries(dir: string): Promise<BrowseEntry[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const absolute = path.join(dir, dirent.name);
    try {
      const stat = await fs.promises.stat(absolute);
      entries.push({
        name: dirent.name,
        isFolder: dirent.isDirectory(),
        size: dirent.isDirectory() ? 0 : stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // 文件可能在列举过程中被移动/删除，跳过
    }
  }
  return sortBrowseEntries(entries).slice(0, MAX_BROWSE_ENTRIES);
}

export interface BrowsePathStat {
  isFolder: boolean;
  isFile: boolean;
}

function statBrowsePath(absolutePath: string): BrowsePathStat | null {
  try {
    const stat = fs.statSync(absolutePath);
    return { isFolder: stat.isDirectory(), isFile: stat.isFile() };
  } catch {
    return null;
  }
}

export interface FolderBrowseModalDependencies {
  listEntries(dir: string): Promise<BrowseEntry[]>;
  openFile(absolutePath: string): Promise<DefaultFileOpenResult>;
  /** 恒用系统默认应用打开（文件行右侧「默认打开器打开」按钮）。 */
  openFileWithSystemApp(absolutePath: string): Promise<DefaultFileOpenResult>;
  revealFile(absolutePath: string): Promise<boolean>;
  canOpenFile(name: string): boolean;
  getShowAll(): boolean;
  setShowAll(value: boolean): void;
  onEnterFolder(dir: string): void;
  statPath(absolutePath: string): BrowsePathStat | null;
  getQuickLocations(): BrowseLocation[];
  getRecentPaths(): string[];
}

/**
 * 任意目录的浏览弹窗（仿系统下载弹窗）：顶部为位置下拉 + 可编辑路径输入框 +
 * 「全量显示」开关 + 「在文件夹中显示」，下方行显示名称与大小/时间，
 * 文件夹行可下钻；文件行点击经 openFile 依赖路由（注入处决定本仓库打开或
 * 系统默认应用），行右侧另有「默认打开器打开」（恒系统默认应用）与
 * 「在文件夹中显示」按钮。
 * 「全量显示」开关关闭时只列 Obsidian 能打开的文件（文件夹始终显示）。
 */
export class FolderBrowseModal extends Modal {
  private readonly dependencies: FolderBrowseModalDependencies;
  private currentDir: string;
  private readonly openingFiles = new Set<string>();
  private dismissDropdown: (() => void) | null = null;

  constructor(
    app: App,
    initialDir: string,
    dependencies: Partial<FolderBrowseModalDependencies> = {},
  ) {
    super(app);
    this.currentDir = initialDir;
    this.dependencies = {
      listEntries: listBrowseEntries,
      openFile: openFileWithDefaultApp,
      openFileWithSystemApp: openFileWithDefaultApp,
      revealFile: (absolutePath) => runFileManager(absolutePath, "select"),
      canOpenFile: () => true,
      getShowAll: () => true,
      setShowAll: () => undefined,
      onEnterFolder: () => undefined,
      statPath: statBrowsePath,
      getQuickLocations: () => [],
      getRecentPaths: () => [],
      ...dependencies,
    };
  }

  onOpen(): void {
    this.renderList();
  }

  onClose(): void {
    this.dismissDropdown?.();
    this.dismissDropdown = null;
    this.contentEl.empty();
  }

  private renderList(): void {
    const { contentEl } = this;
    this.dismissDropdown?.();
    this.dismissDropdown = null;
    this.modalEl.classList.add(
      "mv-senceai-downloads-modal",
      "mv-aide-folder-browse-modal",
    );
    contentEl.empty();

    const headerEl = contentEl.createDiv({ cls: "mv-aide-browse-header" });

    const locationButton = headerEl.createEl("button", {
      cls: "clickable-icon mv-aide-browse-location-button",
    });
    locationButton.type = "button";
    setIcon(locationButton, "chevron-down");
    const locationLabel = t("选择位置");
    locationButton.setAttribute("aria-label", locationLabel);
    locationButton.title = locationLabel;

    const input = headerEl.createEl("input", {
      cls: "mv-aide-browse-path-input",
    });
    input.type = "text";
    input.spellcheck = false;
    input.value = this.currentDir;
    input.setAttribute("aria-label", t("输入路径"));
    // 侧栏/全局 mousedown 处理器会吞掉输入框焦点（真实鼠标点不进去），
    // 这里阻断冒泡，保证真实点击可以聚焦。
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.navigatePath(input.value, input);
      } else if (event.key === "Escape") {
        // 阻止冒泡，避免整层弹窗被 Escape 关闭
        event.stopPropagation();
        input.value = this.currentDir;
      }
    });

    const dropdown = headerEl.createDiv({
      cls: "mv-aide-browse-dropdown is-hidden",
    });
    locationButton.addEventListener("click", () =>
      this.toggleDropdown(dropdown, locationButton, input),
    );

    const filterButton = headerEl.createEl("button", {
      cls: "clickable-icon mv-aide-filter-toggle",
    });
    filterButton.type = "button";
    setIcon(filterButton, "filter");
    const filterLabel = t("切换全量显示（含 Obsidian 无法打开的文件）");
    filterButton.setAttribute("aria-label", filterLabel);
    filterButton.title = filterLabel;
    if (this.dependencies.getShowAll()) filterButton.addClass("is-active");
    filterButton.addEventListener("click", () => {
      this.dependencies.setShowAll(!this.dependencies.getShowAll());
      this.renderList();
    });

    const revealLabel = t("在文件夹中显示");
    const revealDirButton = headerEl.createEl("button", {
      text: revealLabel,
    });
    revealDirButton.addEventListener("click", () => {
      void this.dependencies.revealFile(this.currentDir);
    });

    const listEl = contentEl.createDiv({ cls: "mv-senceai-downloads-list" });
    listEl.setAttribute("aria-busy", "true");
    void this.dependencies
      .listEntries(this.currentDir)
      .then((entries) => {
        listEl.setAttribute("aria-busy", "false");
        const visible = filterBrowsableEntries(
          entries,
          this.dependencies.getShowAll(),
          this.dependencies.canOpenFile,
        );
        if (visible.length === 0) {
          listEl.createEl("p", {
            text: t("该目录为空或没有可显示的文件。"),
            cls: "setting-item-description",
          });
          return;
        }
        for (const entry of visible) this.renderRow(listEl, entry);
      })
      .catch(() => {
        listEl.setAttribute("aria-busy", "false");
        listEl.createEl("p", {
          text: t("该目录为空或没有可显示的文件。"),
          cls: "setting-item-description",
        });
      });
  }

  /** 输入框回车导航：目录进入、文件用默认应用打开、无效输入 Notice 并还原。 */
  private navigatePath(rawInput: string, input: HTMLInputElement): void {
    const expanded = expandHomePath(rawInput.trim(), os.homedir());
    const restore = () => {
      input.value = this.currentDir;
    };
    if (!expanded || !path.isAbsolute(expanded)) {
      new Notice(t("请输入绝对路径。"));
      restore();
      return;
    }
    const resolved = path.resolve(expanded);
    const stat = this.dependencies.statPath(resolved);
    if (!stat) {
      new Notice(t("路径不存在：{path}", { path: resolved }));
      restore();
      return;
    }
    if (stat.isFile) {
      void this.openAbsoluteFile(resolved);
      return;
    }
    if (!stat.isFolder) {
      restore();
      return;
    }
    this.enterDir(resolved);
  }

  private enterDir(dir: string): void {
    this.currentDir = dir;
    this.dependencies.onEnterFolder(dir);
    this.renderList();
  }

  private toggleDropdown(
    dropdown: HTMLElement,
    locationButton: HTMLElement,
    input: HTMLInputElement,
  ): void {
    if (!dropdown.classList.contains("is-hidden")) {
      this.dismissDropdown?.();
      return;
    }
    dropdown.empty();
    dropdown.createDiv({
      cls: "mv-aide-browse-dropdown-label",
      text: t("快捷位置"),
    });
    for (const item of this.dependencies.getQuickLocations()) {
      this.renderDropdownItem(dropdown, item.label, item.path, input);
    }
    const recents = this.dependencies.getRecentPaths();
    if (recents.length > 0) {
      dropdown.createDiv({
        cls: "mv-aide-browse-dropdown-label",
        text: t("最近访问"),
      });
      for (const recent of recents) {
        this.renderDropdownItem(dropdown, recent, recent, input);
      }
    }
    dropdown.classList.remove("is-hidden");
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdown.contains(target) || locationButton.contains(target)) return;
      dismiss();
    };
    const dismiss = () => {
      dropdown.classList.add("is-hidden");
      document.removeEventListener("mousedown", onPointerDown, true);
      if (this.dismissDropdown === dismiss) this.dismissDropdown = null;
    };
    this.dismissDropdown?.();
    this.dismissDropdown = dismiss;
    document.addEventListener("mousedown", onPointerDown, true);
  }

  private renderDropdownItem(
    dropdown: HTMLElement,
    label: string,
    targetPath: string,
    input: HTMLInputElement,
  ): void {
    const item = dropdown.createEl("button", {
      cls: "mv-aide-browse-dropdown-item",
      text: label,
    });
    item.type = "button";
    item.addEventListener("click", () => {
      this.dismissDropdown?.();
      this.navigatePath(targetPath, input);
    });
  }

  private renderRow(listEl: HTMLElement, entry: BrowseEntry): void {
    const row = listEl.createDiv({ cls: "mv-senceai-downloads-row" });
    const openTarget = row.createDiv({
      cls: "mv-senceai-downloads-open-target",
    });
    openTarget.setAttribute("role", "button");
    openTarget.tabIndex = 0;
    openTarget.createSpan({
      text: entry.name,
      cls: entry.isFolder
        ? "mv-senceai-downloads-name mv-aide-folder-name"
        : "mv-senceai-downloads-name",
    });
    openTarget.createSpan({
      text: entry.isFolder
        ? t("文件夹")
        : `${formatBytes(entry.size)} · ${new Date(entry.mtimeMs).toLocaleString()}`,
      cls: "setting-item-description mv-senceai-downloads-meta",
    });
    const open = () => {
      if (entry.isFolder) {
        this.enterDir(path.join(this.currentDir, entry.name));
      } else {
        void this.openEntry(entry.name);
      }
    };
    openTarget.addEventListener("click", open);
    openTarget.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    if (!entry.isFolder) {
      const systemOpenButton = row.createEl("button", {
        cls: "clickable-icon mv-senceai-downloads-system-open",
      });
      systemOpenButton.type = "button";
      const systemOpenLabel = t("默认打开器打开");
      systemOpenButton.setAttribute("aria-label", systemOpenLabel);
      systemOpenButton.setAttribute("title", systemOpenLabel);
      setIcon(systemOpenButton, "external-link");
      systemOpenButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.openEntryWithSystemApp(entry.name);
      });
    }
    const revealButton = row.createEl("button", {
      cls: "clickable-icon mv-senceai-downloads-reveal",
    });
    revealButton.type = "button";
    const revealLabel = t("在文件夹中显示");
    revealButton.setAttribute("aria-label", revealLabel);
    revealButton.setAttribute("title", revealLabel);
    setIcon(revealButton, "folder-open");
    revealButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.dependencies.revealFile(path.join(this.currentDir, entry.name));
    });
  }

  private async openEntry(name: string): Promise<void> {
    await this.openAbsoluteFile(path.join(this.currentDir, name), name);
  }

  private async openEntryWithSystemApp(name: string): Promise<void> {
    const absolutePath = path.join(this.currentDir, name);
    try {
      const result = await this.dependencies.openFileWithSystemApp(absolutePath);
      if (!result.ok) {
        new Notice(
          t("无法打开文件“{name}”：{message}", {
            name,
            message: result.error || t("未知错误"),
          }),
          8000,
        );
      }
    } catch (error) {
      new Notice(
        t("无法打开文件“{name}”：{message}", {
          name,
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }

  private async openAbsoluteFile(
    absolutePath: string,
    displayName = path.basename(absolutePath),
  ): Promise<void> {
    if (this.openingFiles.has(absolutePath)) return;
    this.openingFiles.add(absolutePath);
    try {
      const result = await this.dependencies.openFile(absolutePath);
      if (result.ok) {
        this.close();
        return;
      }
      new Notice(
        t("无法打开文件“{name}”：{message}", {
          name: displayName,
          message: result.error || t("未知错误"),
        }),
        8000,
      );
    } catch (error) {
      new Notice(
        t("无法打开文件“{name}”：{message}", {
          name: displayName,
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    } finally {
      this.openingFiles.delete(absolutePath);
    }
  }
}

/**
 * 文件浏览按钮 feature：结构对齐 BrowserHistoryButtonFeature（onLayoutReady +
 * layout-change 重扫、WeakSet 防重、register 清理）。所有文件列表视图共享
 * 同一份最近访问状态与「全量显示」状态（后者存 plugin，供下载弹窗共享）。
 * 原生文件列表本体不做任何改动。
 */
export class FileExplorerPathBarFeature {
  private installedViews = new WeakSet<View>();
  private enabled: boolean;
  private vaultRootPath: string | null;
  private recentPaths: string[] = [];
  private buttons: HTMLElement[] = [];

  constructor(private readonly plugin: MvSenceAiIdePlugin) {
    this.enabled = plugin.settings.fileExplorerPathBar;
    let vaultRoot: string | null;
    try {
      vaultRoot = getVaultRoot(plugin.app);
    } catch {
      vaultRoot = null;
    }
    this.vaultRootPath = vaultRoot;
  }

  register(): void {
    this.plugin.app.workspace.onLayoutReady(() => this.install());
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => this.install()),
    );
    this.plugin.register(() => this.removeAll());
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.install();
    } else {
      this.removeAll();
      // 禁用后这些 view 仍在 WeakSet 里，重建才能在下一次启用时重新注入。
      // 重建必须放在禁用分支：放在启用分支会把 register() 阶段已注入的标记抹掉，
      // 导致 register + setEnabled 两次 install 重复注入。
      this.installedViews = new WeakSet();
    }
  }

  install(): void {
    if (!this.enabled) return;
    // getLeavesOfType 是定位核心视图的规范 API：只取目标 viewType，
    // 不遍历无关叶子，天然免疫"别的叶子抛异常中断循环"。
    const leaves = this.plugin.app.workspace.getLeavesOfType(
      FILE_EXPLORER_VIEW_TYPE,
    );
    for (const leaf of leaves) {
      const view = leaf.view as ItemView;
      const hostEl = resolveViewHostEl(view);
      if (this.installedViews.has(view) || !hostEl) continue;
      const navButtons = hostEl.querySelector(
        ".nav-header .nav-buttons-container",
      );
      // 核心视图尚未渲染出工具行时跳过，下次 layout-change 重试
      if (!navButtons) continue;
      try {
        this.injectButton(navButtons);
        // 注入成功后才标记，失败可在下次 layout-change 自动重试
        this.installedViews.add(view);
      } catch (error) {
        console.error("[mv-aide] file explorer browse button inject failed", error);
      }
    }
  }

  private removeAll(): void {
    for (const button of this.buttons) button.remove();
    this.buttons = [];
  }

  private injectButton(navButtons: Element): void {
    // DOM 级幂等：即使 WeakSet 失效（多实例/重建时序）也不重复注入
    if (navButtons.querySelector(".mv-aide-browse-button")) return;
    const button = document.createElement("button");
    button.className = "clickable-icon mv-aide-browse-button";
    button.type = "button";
    setIcon(button, "folder");
    const label = t("浏览文件系统");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", () => this.openBrowseModal());
    navButtons.appendChild(button);
    this.buttons.push(button);
  }

  private openBrowseModal(): void {
    const initialDir = this.vaultRootPath ?? os.homedir();
    new FolderBrowseModal(this.plugin.app, initialDir, {
      openFile: (absolutePath) =>
        this.plugin.openExternalListingFile(absolutePath),
      canOpenFile: (name) => this.plugin.canOpenWithObsidian(name),
      getShowAll: () => this.plugin.getExternalListingShowAllFiles(),
      setShowAll: (value) => this.plugin.setExternalListingShowAllFiles(value),
      onEnterFolder: (dir) => {
        this.recentPaths = pushRecentPath(this.recentPaths, dir);
      },
      getQuickLocations: () => this.quickLocations(),
      getRecentPaths: () => this.recentPaths,
    }).open();
  }

  private quickLocations(): BrowseLocation[] {
    const home = os.homedir();
    const locations: BrowseLocation[] = [];
    if (this.vaultRootPath) {
      locations.push({ label: t("仓库根目录"), path: this.vaultRootPath });
    }
    locations.push({ label: t("主目录"), path: home });
    locations.push({ label: t("桌面"), path: path.join(home, "Desktop") });
    locations.push({
      label: t("下载"),
      path: downloadsDir(home, electronDownloadsPath()),
    });
    locations.push({
      label: t("根目录"),
      path: path.parse(this.vaultRootPath ?? home).root,
    });
    return locations;
  }
}
