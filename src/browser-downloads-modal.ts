// 系统下载文件夹弹窗：列出系统 Downloads 最近文件。行点击经插件路由
// （Obsidian 可打开则在本仓库打开，否则系统默认应用）；行右侧另有
// 「默认打开器打开」（恒系统默认应用）与「在文件夹中显示」按钮。
// Obsidian 插件运行在渲染进程，挂不到 Electron 主进程的 session.will-download，
// 也没有 remote，因此不做真正的浏览器下载记录，只做系统目录视图。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Modal, Notice, setIcon, type App } from "obsidian";
import { t } from "./i18n";
import { downloadsDir, formatBytes, sortByMtimeDesc } from "./downloads-list";
import {
  electronDownloadsPath,
  openFileWithDefaultApp,
  runFileManager,
  type DefaultFileOpenResult,
} from "./reveal-in-folder";

const MAX_ENTRIES = 100;

export interface DownloadEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface BrowserDownloadsModalDependencies {
  getDownloadsDir(): string;
  listEntries(dir: string): Promise<DownloadEntry[]>;
  openFile(absolutePath: string): Promise<DefaultFileOpenResult>;
  /** 恒用系统默认应用打开（行右侧「默认打开器打开」按钮）；缺省为系统默认打开。 */
  openFileWithSystemApp?(absolutePath: string): Promise<DefaultFileOpenResult>;
  revealFile(absolutePath: string): Promise<boolean>;
  openFolder(absolutePath: string): Promise<boolean>;
  /** 文件名是否可被 Obsidian 打开（过滤用）；缺省视为全部可打开。 */
  canOpenFile?(name: string): boolean;
  /** 「全量显示」开关状态；缺省恒 true（保持旧的全量行为）。 */
  getShowAll?(): boolean;
  setShowAll?(value: boolean): void;
}

async function listDownloadEntries(dir: string): Promise<DownloadEntry[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries: DownloadEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || dirent.name.startsWith(".")) continue;
    try {
      const stat = await fs.promises.stat(path.join(dir, dirent.name));
      entries.push({
        name: dirent.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // 文件可能在列举过程中被移动/删除，跳过
    }
  }
  return sortByMtimeDesc(entries).slice(0, MAX_ENTRIES);
}

export class BrowserDownloadsModal extends Modal {
  private readonly dependencies: Required<BrowserDownloadsModalDependencies>;
  private readonly openingFiles = new Set<string>();

  constructor(
    app: App,
    dependencies: Partial<BrowserDownloadsModalDependencies> = {},
  ) {
    super(app);
    this.dependencies = {
      getDownloadsDir: () => downloadsDir(os.homedir(), electronDownloadsPath()),
      listEntries: listDownloadEntries,
      openFile: openFileWithDefaultApp,
      openFileWithSystemApp: openFileWithDefaultApp,
      revealFile: (absolutePath) => runFileManager(absolutePath, "select"),
      openFolder: (absolutePath) => runFileManager(absolutePath, "open"),
      canOpenFile: () => true,
      getShowAll: () => true,
      setShowAll: () => undefined,
      ...dependencies,
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.classList.add("mv-senceai-downloads-modal");
    contentEl.empty();
    contentEl.createEl("h3", { text: t("下载") });
    const listEl = contentEl.createDiv({ cls: "mv-senceai-downloads-list" });
    listEl.setAttribute("aria-busy", "true");

    const buttonRow = contentEl.createDiv({ cls: "mv-senceai-modal-button-row" });
    const filterButton = buttonRow.createEl("button", {
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
      this.onOpen();
    });

    const openFolderButton = buttonRow.createEl("button", {
      text: t("打开下载文件夹"),
    });
    openFolderButton.addClass("mod-cta");
    openFolderButton.addEventListener("click", () => {
      void this.openDownloadsFolder();
    });

    const dir = this.dependencies.getDownloadsDir();
    void this.dependencies.listEntries(dir)
      .then((entries) => {
        listEl.setAttribute("aria-busy", "false");
        const visible = this.dependencies.getShowAll()
          ? entries
          : entries.filter((entry) =>
              this.dependencies.canOpenFile(entry.name),
            );
        if (visible.length === 0) {
          listEl.createEl("p", {
            text: t("下载文件夹为空或不存在。"),
            cls: "setting-item-description",
          });
          return;
        }
        for (const entry of visible) {
          const row = listEl.createDiv({ cls: "mv-senceai-downloads-row" });
          const openTarget = row.createDiv({
            cls: "mv-senceai-downloads-open-target",
          });
          openTarget.setAttribute("role", "button");
          openTarget.tabIndex = 0;
          openTarget.createSpan({
            text: entry.name,
            cls: "mv-senceai-downloads-name",
          });
          openTarget.createSpan({
            text: `${formatBytes(entry.size)} · ${new Date(entry.mtimeMs).toLocaleString()}`,
            cls: "setting-item-description mv-senceai-downloads-meta",
          });
          const open = () => {
            void this.openEntry(dir, entry.name);
          };
          openTarget.addEventListener("click", open);
          openTarget.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          });
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
            void this.openEntryWithSystemApp(dir, entry.name);
          });
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
            void this.revealEntry(dir, entry.name);
          });
        }
      })
      .catch(() => {
        listEl.setAttribute("aria-busy", "false");
        listEl.createEl("p", {
          text: t("下载文件夹为空或不存在。"),
          cls: "setting-item-description",
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async openEntry(dir: string, name: string): Promise<void> {
    const absolutePath = path.join(dir, name);
    if (this.openingFiles.has(absolutePath)) return;
    this.openingFiles.add(absolutePath);
    try {
      const result = await this.dependencies.openFile(absolutePath);
      if (result.ok) {
        this.close();
        return;
      }
      new Notice(
        t("无法打开下载文件“{name}”：{message}", {
          name,
          message: result.error || t("未知错误"),
        }),
        8000,
      );
    } catch (error) {
      new Notice(
        t("无法打开下载文件“{name}”：{message}", {
          name,
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    } finally {
      this.openingFiles.delete(absolutePath);
    }
  }

  private async openEntryWithSystemApp(
    dir: string,
    name: string,
  ): Promise<void> {
    try {
      const result = await this.dependencies.openFileWithSystemApp(
        path.join(dir, name),
      );
      if (!result.ok) {
        new Notice(
          t("无法打开下载文件“{name}”：{message}", {
            name,
            message: result.error || t("未知错误"),
          }),
          8000,
        );
      }
    } catch (error) {
      new Notice(
        t("无法打开下载文件“{name}”：{message}", {
          name,
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }

  private async revealEntry(dir: string, name: string): Promise<void> {
    try {
      const ok = await this.dependencies.revealFile(path.join(dir, name));
      if (!ok) {
        new Notice(t("无法在文件夹中显示下载文件“{name}”。", { name }));
      }
    } catch {
      new Notice(t("无法在文件夹中显示下载文件“{name}”。", { name }));
    }
  }

  private async openDownloadsFolder(): Promise<void> {
    try {
      const ok = await this.dependencies.openFolder(
        this.dependencies.getDownloadsDir(),
      );
      if (!ok) new Notice(t("无法打开系统下载文件夹。"));
    } catch {
      new Notice(t("无法打开系统下载文件夹。"));
    }
  }
}
