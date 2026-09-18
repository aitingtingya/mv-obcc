import { MarkdownView, Notice } from "obsidian";
import type MvAideIdePlugin from "../../main";
import type { TerminalRegistry } from "../terminal-control/terminal-registry";
import { mvRunPrefixesFor } from "../terminal/mv-run-types";
import { RunExecutor, RunExecutionError } from "./executor";
import { terminalHost } from "./terminal-port";
import { bindEditor, boundText, flushEditorTurn, persistBoundSnapshot } from "./editor-snapshot";
import { parseTasks } from "./parser";
import { defaultPlan, specifiedPlan, taskSignature } from "./planner";
import { MvRunModal } from "./modal";
import { message, errorMessage } from "./messages";

export class MvRunFeature {
  private readonly executor: RunExecutor;
  private readonly modals = new Set<MvRunModal>();
  private disposed = false;
  constructor(private readonly plugin: MvAideIdePlugin, private readonly registry: TerminalRegistry) {
    this.executor = new RunExecutor(terminalHost(registry));
  }

  open(view?: MarkdownView): void {
    if (this.disposed) return;
    const target = view ?? this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    // 命令现在是纯 callback，任何视图下都会在命令面板出现；没有可编辑的
    // Markdown 视图时明确提示（?.editor 同时防御阅读模式下 editor 缺失）。
    if (!target?.editor) { new Notice(message("noView")); return; }
    try {
      const bound = bindEditor(target);
      const prefixes = mvRunPrefixesFor(this.plugin.settings.mvRun, bound.file.extension);
      if (!prefixes.length) throw new Error(message("noPrefix"));
      const tasks = parseTasks(boundText(bound), prefixes);
      if (!tasks.length) throw new Error(message("noTasks"));
      const modal = new MvRunModal(this.plugin.app, tasks, async (input, signature, signal) => {
        if (this.disposed) throw new Error(message("fileChanged"));
        const text = await flushEditorTurn(bound, signal);
        const currentPrefixes = mvRunPrefixesFor(this.plugin.settings.mvRun, bound.file.extension);
        const current = parseTasks(text, currentPrefixes);
        if (input !== null && taskSignature(current) !== signature) return { tasks: current, notice: message("changed") };
        const plan = input === null ? defaultPlan(current) : specifiedPlan(current, input);
        if (!plan.steps.length) return { run: () => { new Notice(message("empty")); } };
        // Capture routing before persistence or terminal focus can yield to another window.
        const terminalId = this.registry.list().find(terminal => terminal.recent)?.id;
        try { await persistBoundSnapshot(this.plugin.app, bound, text, signal); }
        catch (error) { throw new Error(`${message("saveFailed")} ${errorMessage(error)}`); }
        return { run: () => {
          if (this.disposed) return;
          new Notice(`${message("running")} · ${bound.path} · ${plan.steps.length}`);
          void this.executor.run(plan.steps, terminalId).then(() => {
            if (!this.disposed) new Notice(`${message("done")} · ${bound.path}`);
          }).catch((error: unknown) => {
            if (this.disposed) return;
            const detail = error instanceof RunExecutionError && error.task ? ` · ${error.task.name ?? message("unnamed")} · ${error.task.line}\n${error.task.command}` : "";
            new Notice(`${message("failed")} · ${bound.path}${detail}\n${errorMessage(error)}`, 8000);
          });
        } };
      }, () => this.modals.delete(modal));
      this.modals.add(modal);
      modal.open();
    } catch (error) { new Notice(`mv-run: ${errorMessage(error)}`, 8000); }
  }

  dispose(): void {
    this.disposed = true;
    for (const modal of this.modals) modal.close();
    this.modals.clear();
    this.executor.dispose();
  }
}
