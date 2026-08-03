import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  lintGutter,
  setDiagnostics,
  type Diagnostic,
} from "@codemirror/lint";
import { editorInfoField, MarkdownView, Notice } from "obsidian";
import * as child_process from "child_process";
import * as path from "path";
import type MvSenceAiIdePlugin from "../../main";
import { t } from "../i18n";
import { lintCommandFor, lintPersistentFor } from "./lint-types";
import { buildLintCommand, diagnosticRangeFor, parseLintOutput } from "./lint-parse";

const AUTO_LINT_DELAY_MS = 600;

export class LintFeature {
  readonly extensions: Extension[];
  private readonly compartment = new Compartment();
  private autoLintTimer: number | null = null;
  private pendingAutoView: MarkdownView | null = null;

  constructor(private readonly plugin: MvSenceAiIdePlugin) {
    this.extensions = [
      this.compartment.of([]),
      lintProfileRouter(this.plugin, this.compartment),
      // lint 常驻：文档变化后防抖自动重新 lint（编辑器事件，非保存事件）。
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.maybeAutoLintFor(update.view);
      }),
    ];
  }

  registerCommand(): void {
    // Idempotent: remove first so re-registering after a language switch
    // never duplicates the commands.
    this.plugin.removeCommand("lint-current-file");
    this.plugin.addCommand({
      id: "lint-current-file",
      name: t("Lint 当前文件"),
      editorCallback: () => this.runLintForActiveEditor(),
    });
    this.plugin.removeCommand("clear-lint-diagnostics");
    this.plugin.addCommand({
      id: "clear-lint-diagnostics",
      name: t("清除当前文件的 Lint 诊断"),
      editorCallback: () => this.clearDiagnosticsForActiveEditor(),
    });
    this.plugin.removeCommand("enable-lint-persistent");
    this.plugin.addCommand({
      id: "enable-lint-persistent",
      name: t("开启 lint 常驻"),
      editorCallback: () => void this.setPersistentForActive(true),
    });
    this.plugin.removeCommand("disable-lint-persistent");
    this.plugin.addCommand({
      id: "disable-lint-persistent",
      name: t("关闭 lint 常驻"),
      editorCallback: () => void this.setPersistentForActive(false),
    });
  }

  /** 常驻自动触发：文件切换/打开时自动 lint。在 main.ts onload 调用一次。 */
  registerHooks(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        this.maybeAutoLintFor(
          (view.editor as unknown as { cm: EditorView }).cm,
        );
      }),
    );
  }

  /** 开启/关闭当前文件的 lint 常驻（持久化到设置）。 */
  async setPersistentForActive(persistent: boolean): Promise<void> {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice(t("当前没有打开的 Markdown 视图"));
      return;
    }
    this.plugin.settings.sourceLint.fileOverrides[view.file.path] = persistent;
    await this.plugin.saveData(this.plugin.settings);
    if (persistent) {
      await this.runLint(view);
    } else {
      this.clearDiagnostics(view);
    }
  }

  runLintForActiveEditor(): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice(t("当前没有可 Lint 的 Markdown 视图"));
      return;
    }
    if (
      lintPersistentFor(
        this.plugin.settings.sourceLint,
        view.file.extension,
        view.file.path,
      )
    ) {
      new Notice(t("当前 lint 已常驻，无法执行命令"));
      return;
    }
    void this.runLint(view);
  }

  clearDiagnosticsForActiveEditor(): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice(t("当前没有可 Lint 的 Markdown 视图"));
      return;
    }
    if (
      lintPersistentFor(
        this.plugin.settings.sourceLint,
        view.file.extension,
        view.file.path,
      )
    ) {
      new Notice(t("当前 lint 已常驻，无法执行命令"));
      return;
    }
    this.clearDiagnostics(view);
  }

  private clearDiagnostics(view: MarkdownView): void {
    const cm = (view.editor as unknown as { cm: EditorView }).cm;
    if (isDestroyed(cm)) return;
    cm.dispatch(setDiagnostics(cm.state, []));
  }

  private async runLint(view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file) return;
    const extension = file.extension.toLowerCase();
    const command = lintCommandFor(this.plugin.settings.sourceLint, extension);
    if (!command.trim()) {
      new Notice(t("未配置该文件类型的 Lint 命令"));
      return;
    }
    const cm = (view.editor as unknown as { cm: EditorView }).cm;
    if (isDestroyed(cm)) return;
    const vaultRoot =
      (this.plugin.app.vault.adapter as any).getBasePath?.() ?? "";
    const fullPath = path.join(vaultRoot, file.path);

    const { stdout, stderr, error } = await execCapture(
      buildLintCommand(command, fullPath),
      { cwd: path.dirname(fullPath), maxBuffer: 8 * 1024 * 1024 },
    );
    if (error && !stdout && !stderr) {
      new Notice(
        t("Lint 命令执行失败：{message}", {
          message: String(error.message ?? error).split("\n")[0],
        }),
      );
      return;
    }
    if (isDestroyed(cm)) return;

    const doc = cm.state.doc;
    const diagnostics: Diagnostic[] = parseLintOutput(
      `${stdout}\n${stderr}`,
    ).map((d) => {
      const line = doc.line(Math.min(Math.max(d.line, 1), doc.lines));
      const { from, to } = diagnosticRangeFor(line, d.col);
      return {
        from,
        to,
        severity: d.severity,
        message: d.message,
        source: "lint",
      };
    });
    cm.dispatch(setDiagnostics(cm.state, diagnostics));
  }

  /** 常驻触发入口：文件常驻则防抖自动 lint。 */
  private maybeAutoLintFor(cm: EditorView): void {
    const view = this.mdViewForCm(cm);
    if (!view?.file) return;
    if (
      !lintPersistentFor(
        this.plugin.settings.sourceLint,
        view.file.extension,
        view.file.path,
      )
    ) {
      return;
    }
    if (this.autoLintTimer !== null) {
      activeWindow.clearTimeout(this.autoLintTimer);
    }
    this.pendingAutoView = view;
    this.autoLintTimer = activeWindow.setTimeout(() => {
      this.autoLintTimer = null;
      const pending = this.pendingAutoView;
      this.pendingAutoView = null;
      if (!pending?.file) return;
      const cm = (pending.editor as unknown as { cm: EditorView }).cm;
      if (isDestroyed(cm)) return;
      void this.runLint(pending);
    }, AUTO_LINT_DELAY_MS);
  }

  private mdViewForCm(cm: EditorView): MarkdownView | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (
        view instanceof MarkdownView &&
        (view.editor as unknown as { cm: EditorView }).cm === cm
      ) {
        return view;
      }
    }
    return null;
  }
}

function lintProfileRouter(
  plugin: MvSenceAiIdePlugin,
  compartment: Compartment,
): Extension {
  return ViewPlugin.fromClass(
    class {
      private currentExtension = "";
      private updateQueued = false;

      constructor(private readonly view: EditorView) {
        this.queueProfileUpdate();
      }

      update(update: ViewUpdate): void {
        const next = currentFileExtension(update.view);
        if (next !== this.currentExtension || fileChanged(update)) {
          this.queueProfileUpdate();
        }
      }

      private queueProfileUpdate(): void {
        if (this.updateQueued) return;
        this.updateQueued = true;
        queueMicrotask(() => {
          this.updateQueued = false;
          const next = currentFileExtension(this.view);
          if (next === this.currentExtension) return;
          this.currentExtension = next;
          this.view.dispatch({
            effects: compartment.reconfigure(
              lintGutterExtensionsFor(plugin, next),
            ),
          });
        });
      }
    },
  );
}

function lintGutterExtensionsFor(
  plugin: MvSenceAiIdePlugin,
  extension: string,
): Extension[] {
  return lintCommandFor(plugin.settings.sourceLint, extension).trim()
    ? [lintGutter()]
    : [];
}

function currentFileExtension(view: EditorView): string {
  return (
    view.state.field(editorInfoField, false)?.file?.extension?.toLowerCase() ??
    "md"
  );
}

function fileChanged(update: ViewUpdate): boolean {
  return (
    update.startState.field(editorInfoField, false)?.file !==
    update.state.field(editorInfoField, false)?.file
  );
}

function isDestroyed(view: EditorView): boolean {
  return (view as unknown as { destroyed?: boolean }).destroyed === true;
}

function execCapture(
  command: string,
  options: child_process.ExecOptions,
): Promise<{ stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    child_process.exec(command, options, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: error ?? undefined,
      });
    });
  });
}
