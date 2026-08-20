import fs from "node:fs";
import path from "node:path";
import { Modal, Notice, Setting, type TFile } from "obsidian";
import type MvAideIdePlugin from "../../main";
import { t } from "../i18n";
import { getVaultRoot } from "../selection";
import { mvAideVaultTempDirectory } from "../storage/temp-paths";
import {
  applyRegexReplace,
  buildRegex,
  regexScan,
  type RegexMatch,
  type RegexQueryOptions,
} from "./regex-scan";
import {
  resolveScanFiles,
  type ScannableFile,
} from "./regex-scope";
import type { RegexScope } from "./regex-replace-types";

/** 不参与扫描的二进制后缀。 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
  "pdf", "zip", "gz", "tar", "7z", "rar",
  "exe", "dll", "so", "dylib",
  "mp3", "mp4", "wav", "mov", "avi", "webm",
  "woff", "woff2", "ttf", "otf", "excalidraw",
]);

/** 单文件超过该大小（字节）跳过，避免大文件拖垮扫描。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** cachedRead 并发上限。 */
const SCAN_CONCURRENCY = 8;
/** 备份批次数保留上限。 */
const BACKUP_RETENTION = 5;
/** 预览中每文件展示的匹配片段数。 */
const PREVIEW_MATCHES_PER_FILE = 3;

interface FileResult {
  file: TFile;
  matches: RegexMatch[];
}

interface SkippedEntry {
  path: string;
  reason: string;
}

/** 多文件正则替换 Modal：输入 → 扫描 → 预览勾选 → 备份 + 原子写回。 */
export class RegexReplaceModal extends Modal {
  private query = "";
  private replacement = "";
  private options: RegexQueryOptions = {
    regex: true,
    caseSensitive: true,
    multiline: false,
  };
  private requestedScope: RegexScope = "folder";
  private busy = false;

  constructor(
    private readonly plugin: MvAideIdePlugin,
    private readonly anchorFile: TFile,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.renderInput();
  }

  // ---------- 输入阶段 ----------

  private renderInput(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mv-regex-modal");
    contentEl.createEl("h3", { text: t("正则查找替换（多文件）") });

    new Setting(contentEl).setName(t("查找")).addText((text) => {
      text.setValue(this.query).onChange((v) => (this.query = v));
      text.inputEl.addClass("mv-regex-query");
      text.inputEl.focus();
    });
    new Setting(contentEl).setName(t("替换为")).addText((text) =>
      text.setValue(this.replacement).onChange((v) => (this.replacement = v)),
    );

    new Setting(contentEl).setName(t("使用正则表达式")).addToggle((tg) =>
      tg.setValue(this.options.regex).onChange((v) => (this.options.regex = v)),
    );
    new Setting(contentEl).setName(t("区分大小写")).addToggle((tg) =>
      tg
        .setValue(this.options.caseSensitive)
        .onChange((v) => (this.options.caseSensitive = v)),
    );
    new Setting(contentEl).setName(t("多行模式（^/$ 匹配行首行尾）")).addToggle(
      (tg) =>
        tg
          .setValue(this.options.multiline)
          .onChange((v) => (this.options.multiline = v)),
    );

    new Setting(contentEl).setName(t("范围")).addDropdown((dd) =>
      dd
        .addOption("folder", t("当前文件夹"))
        .addOption("vault", t("整个仓库"))
        .setValue(this.requestedScope)
        .onChange((v) => (this.requestedScope = v as RegexScope)),
    );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText(t("扫描预览"))
        .setCta()
        .onClick(() => void this.scan()),
    );
  }

  // ---------- 扫描阶段 ----------

  private async scan(): Promise<void> {
    if (this.busy) return;
    if (!this.query) {
      new Notice(t("查找内容不能为空"));
      return;
    }
    let re: RegExp;
    try {
      re = buildRegex(this.query, this.options);
    } catch (error) {
      new Notice(
        t("正则表达式无效：{message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    this.busy = true;
    try {
      const anchor: ScannableFile = {
        path: this.anchorFile.path,
        extension: this.anchorFile.extension,
      };
      const candidates: ScannableFile[] = [];
      const skipped: SkippedEntry[] = [];
      const allFiles = this.app.vault.getFiles();
      for (const file of allFiles) {
        const ext = file.extension.toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          skipped.push({ path: file.path, reason: t("二进制文件") });
          continue;
        }
        if (file.stat.size > MAX_FILE_BYTES) {
          skipped.push({ path: file.path, reason: t("文件过大（>2MB）") });
          continue;
        }
        candidates.push({ path: file.path, extension: ext });
      }

      const resolved = resolveScanFiles(
        this.plugin.settings.regexReplace,
        this.requestedScope,
        anchor,
        candidates,
      );
      for (const entry of resolved.skipped) {
        skipped.push({
          path: entry.path,
          reason:
            entry.reason === "type-off"
              ? t("该类型已关闭")
              : t("超出该类型允许范围"),
        });
      }

      const byPath = new Map(allFiles.map((file) => [file.path, file]));
      const results: FileResult[] = [];
      const included = resolved.included;
      for (let i = 0; i < included.length; i += SCAN_CONCURRENCY) {
        const batch = included.slice(i, i + SCAN_CONCURRENCY);
        await Promise.all(
          batch.map(async (entry) => {
            const file = byPath.get(entry.path);
            if (!file) return;
            try {
              const text = await this.app.vault.cachedRead(file);
              const matches = regexScan(text, re);
              if (matches.length > 0) results.push({ file, matches });
            } catch {
              skipped.push({ path: entry.path, reason: t("读取失败") });
            }
          }),
        );
      }
      results.sort((a, b) => a.file.path.localeCompare(b.file.path));
      this.renderPreview(results, skipped);
    } finally {
      this.busy = false;
    }
  }

  // ---------- 预览阶段 ----------

  private renderPreview(results: FileResult[], skipped: SkippedEntry[]): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mv-regex-modal");

    const total = results.reduce((sum, r) => sum + r.matches.length, 0);
    contentEl.createEl("h3", {
      text: t("扫描结果：{files} 个文件，{matches} 处匹配", {
        files: results.length,
        matches: total,
      }),
    });

    if (results.length === 0) {
      contentEl.createEl("p", { text: t("没有可替换的匹配。") });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText(t("返回")).onClick(() => this.renderInput()),
      );
      return;
    }

    const selected = new Set(results.map((r) => r.file.path));
    const listEl = contentEl.createDiv({ cls: "mv-regex-file-list" });
    for (const result of results) {
      const rowEl = listEl.createDiv({ cls: "mv-regex-file-row" });
      const headEl = rowEl.createDiv({ cls: "mv-regex-file-head" });
      const checkbox = headEl.createEl("input", {
        attr: { type: "checkbox" },
      });
      checkbox.checked = true;
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(result.file.path);
        else selected.delete(result.file.path);
      };
      headEl.createEl("span", {
        cls: "mv-regex-file-path",
        text: result.file.path,
      });
      headEl.createEl("span", {
        cls: "mv-regex-file-count",
        text: t("{count} 处", { count: result.matches.length }),
      });
      const snippetEl = rowEl.createDiv({ cls: "mv-regex-snippets" });
      for (const m of result.matches.slice(0, PREVIEW_MATCHES_PER_FILE)) {
        snippetEl.createDiv({
          cls: "mv-regex-snippet",
          text: `${m.line}: ${truncate(m.lineText, 160)}`,
        });
      }
      if (result.matches.length > PREVIEW_MATCHES_PER_FILE) {
        snippetEl.createDiv({
          cls: "mv-regex-snippet mv-regex-more",
          text: t("…另有 {count} 处", {
            count: result.matches.length - PREVIEW_MATCHES_PER_FILE,
          }),
        });
      }
    }

    if (skipped.length > 0) {
      const skipEl = contentEl.createEl("details", {
        cls: "mv-regex-skipped",
      });
      skipEl.createEl("summary", {
        text: t("已跳过 {count} 个文件", { count: skipped.length }),
      });
      for (const entry of skipped.slice(0, 50)) {
        skipEl.createDiv({
          cls: "mv-regex-snippet",
          text: `${entry.path} — ${entry.reason}`,
        });
      }
      if (skipped.length > 50) {
        skipEl.createDiv({
          cls: "mv-regex-snippet",
          text: t("…另有 {count} 个", { count: skipped.length - 50 }),
        });
      }
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("返回")).onClick(() => this.renderInput()),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("替换所选（先备份）"))
          .setCta()
          .onClick(() => {
            const targets = results.filter((r) => selected.has(r.file.path));
            if (targets.length === 0) {
              new Notice(t("未选择任何文件"));
              return;
            }
            void this.execute(targets);
          }),
      );
  }

  // ---------- 执行阶段 ----------

  private async execute(targets: FileResult[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const re = buildRegex(this.query, this.options);
      const backupDir = await this.createBackupDir();
      let filesDone = 0;
      let replacements = 0;
      const failures: string[] = [];
      for (const target of targets) {
        try {
          await this.backupFile(backupDir, target.file);
          await this.app.vault.process(target.file, (data) =>
            applyRegexReplace(data, re, this.replacement),
          );
          replacements += target.matches.length;
          filesDone++;
        } catch (error) {
          failures.push(target.file.path);
          console.error("[mv-aide] regex replace failed", target.file.path, error);
        }
      }
      await this.pruneBackups();
      new Notice(
        t("已替换 {files} 个文件的 {count} 处匹配{failures}", {
          files: filesDone,
          count: replacements,
          failures:
            failures.length > 0
              ? t("；{count} 个文件失败（详见控制台）", {
                  count: failures.length,
                })
              : "",
        }),
      );
      this.close();
    } finally {
      this.busy = false;
    }
  }

  // ---------- 备份 ----------

  private backupRoot(): string {
    return mvAideVaultTempDirectory(
      getVaultRoot(this.app),
      "regex-replace/backups",
    );
  }

  private async createBackupDir(): Promise<string> {
    const dir = path.join(
      this.backupRoot(),
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }

  private async backupFile(backupDir: string, file: TFile): Promise<void> {
    // 到达这里的都是扫描过的文本文件（二进制在扫描阶段已排除），按 utf8 读写。
    const target = path.join(backupDir, file.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, await this.app.vault.read(file), "utf8");
  }

  private async pruneBackups(): Promise<void> {
    try {
      const root = this.backupRoot();
      const dirents =
        (await fs.promises
          .readdir(root, { withFileTypes: true })
          .catch(() => null)) ?? [];
      const batches = dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .sort();
      while (batches.length > BACKUP_RETENTION) {
        const oldest = batches.shift();
        if (oldest) {
          await fs.promises.rm(path.join(root, oldest), {
            recursive: true,
            force: true,
          });
        }
      }
    } catch (error) {
      console.error("[mv-aide] regex backup prune failed", error);
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
