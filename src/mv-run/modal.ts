import { SuggestModal, type App } from "obsidian";
import type { RunTask } from "./model";
import { specifiedPlan } from "./planner";
import { completeReferences } from "./completion";
import { errorMessage, message } from "./messages";

/**
 * Palette-style mv-run flow: the palette input IS the order expression field.
 * Empty input offers the default order; typing shows reference completions, a run row,
 * and a live execution preview below — everything keyboard-driven, Escape cancels.
 */

export interface RunOrderHooks {
  /** User confirmed an execution (null = default order). Runs headless after the palette closes. */
  submit: (input: string | null) => void;
  /** Reopen the palette with new state (completion accepted, tasks changed, or a no-action row chosen). */
  reopen: (tasks: RunTask[], text: string, cursor: number) => void;
  closed: () => void;
}

export type RunOrderRow =
  | { kind: "run"; input: string | null; steps: number }
  | { kind: "completion"; label: string; detail: string; from: number; to: number; insert: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

const PREVIEW_LIMIT = 8;

export class RunOrderModal extends SuggestModal<RunOrderRow> {
  constructor(app: App, private readonly tasks: RunTask[], private readonly initial: string, private readonly initialCursor: number, private readonly hooks: RunOrderHooks) {
    super(app);
    this.setPlaceholder(message("title"));
    this.setInstructions([
      { command: "Enter", purpose: message("instEnter") },
      { command: "Esc", purpose: message("instEsc") },
    ]);
  }

  onOpen(): void {
    if (this.initial) {
      this.inputEl.value = this.initial;
      this.inputEl.setSelectionRange(this.initialCursor, this.initialCursor);
    }
    // The chooser only refreshes on input events; dispatch once so the rows render immediately on open.
    this.inputEl.dispatchEvent(new Event("input"));
    // SuggestModal only re-queries on input events; cursor moves change completion targets.
    for (const event of ["click", "keyup"] as const) {
      this.inputEl.addEventListener(event, e => {
        if (e instanceof KeyboardEvent && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        this.inputEl.dispatchEvent(new Event("input"));
      });
    }
  }

  getSuggestions(query: string): RunOrderRow[] {
    const rows: RunOrderRow[] = [];
    const cursor = this.inputEl.selectionStart ?? query.length;
    if (!query.trim()) {
      // The run row always leads: empty input = default execution, so Enter runs immediately.
      rows.push({ kind: "run", input: null, steps: this.tasks.filter(task => !task.protected).length });
      for (const candidate of completeReferences(this.tasks, query, cursor)) rows.push({ kind: "completion", ...candidate });
      rows.push({ kind: "info", text: message("help") });
      return rows;
    }
    try {
      const plan = specifiedPlan(this.tasks, query);
      if (plan.steps.length) rows.push({ kind: "run", input: query, steps: plan.steps.length });
      for (const candidate of completeReferences(this.tasks, query, cursor)) rows.push({ kind: "completion", ...candidate });
      if (!plan.steps.length) { rows.push({ kind: "info", text: message("empty") }); return rows; }
      plan.steps.slice(0, PREVIEW_LIMIT).forEach((task, index) => rows.push({
        kind: "info",
        text: `${index + 1}. ${task.name ?? message("unnamed")}${task.protected ? " 🔒" : ""}${task.newTerminal ? " [-n]" : ""} — ${task.command}`,
      }));
      if (plan.steps.length > PREVIEW_LIMIT) rows.push({ kind: "info", text: `… +${plan.steps.length - PREVIEW_LIMIT}` });
      for (const task of plan.filtered) rows.push({ kind: "info", text: `${message("filtered")}: ${task.name ?? message("unnamed")} — ${task.command}` });
    } catch (error) {
      for (const candidate of completeReferences(this.tasks, query, cursor)) rows.push({ kind: "completion", ...candidate });
      rows.push({ kind: "error", text: errorMessage(error) });
    }
    return rows;
  }

  renderSuggestion(row: RunOrderRow, el: HTMLElement): void {
    if (row.kind === "run") {
      el.createEl("strong", { text: row.input === null ? message("default") : `▶ ${row.input}` });
      el.createEl("small", { text: `${row.input === null ? message("defaultHint") : message("preview")} · ${row.steps}`, cls: "mv-run-picker-note" });
      return;
    }
    if (row.kind === "completion") {
      el.createEl("strong", { text: row.label });
      el.createEl("small", { text: row.detail, cls: "mv-run-picker-note" });
      return;
    }
    el.addClass(row.kind === "error" ? "mv-run-picker-error" : "mv-run-picker-info");
    el.setText(row.text);
  }

  onChooseSuggestion(row: RunOrderRow): void {
    // Choosing closes the palette; reopen to keep flows (completion accept, no-action rows) continuous.
    if (row.kind === "completion") {
      const value = this.inputEl.value;
      const next = value.slice(0, row.from) + row.insert + value.slice(row.to);
      this.hooks.reopen(this.tasks, next, row.from + row.insert.length);
      return;
    }
    if (row.kind !== "run") { this.hooks.reopen(this.tasks, this.inputEl.value, this.inputEl.selectionStart ?? this.inputEl.value.length); return; }
    this.hooks.submit(row.input);
  }

  onClose(): void { this.hooks.closed(); }
}
