import { Modal, type App } from "obsidian";
import type { RunTask } from "./model";
import { specifiedPlan, taskSignature } from "./planner";
import { completeReferences, type RunCompletion } from "./completion";
import { errorMessage, message } from "./messages";

export interface Confirmation { tasks?: RunTask[]; run?: () => void; notice?: string }
export class MvRunModal extends Modal {
  private specified = false;
  private selectedMode = 0;
  private opened = false;
  private busy = false;
  private input: HTMLInputElement | null = null;
  private preview: HTMLElement | null = null;
  private feedback: HTMLElement | null = null;
  private suggestions: HTMLElement | null = null;
  private candidates: RunCompletion[] = [];
  private candidateIndex = 0;
  private modeButtons: HTMLButtonElement[] = [];
  private readonly lifetime = new AbortController();

  constructor(app: App, private tasks: RunTask[], private readonly confirm: (input: string | null, signature: string, signal: AbortSignal) => Promise<Confirmation>, private readonly closed: () => void) {
    super(app);
    this.scope.register([], "Enter", () => {
      if (!this.specified) this.chooseMode(this.selectedMode);
      else void this.submit(this.input?.value ?? "");
      return false;
    });
    for (const [key, direction] of [["ArrowDown", 1], ["ArrowUp", -1]] as const) {
      this.scope.register([], key, () => {
        if (this.specified) {
          if (this.candidates.length) this.candidateIndex = (this.candidateIndex + direction + this.candidates.length) % this.candidates.length;
          this.renderCandidates();
        } else {
          this.selectedMode = this.selectedMode === 0 ? 1 : 0;
          this.highlightMode();
          // 同步 DOM 焦点：焦点框留在原按钮时，Enter 会原生 click 原按钮，
          // 覆盖键盘选择（表现为高亮在第二行却执行了第一行）。
          this.modeButtons[this.selectedMode]?.focus();
        }
        return false;
      });
    }
    this.scope.register([], "Tab", () => {
      if (!this.specified || !this.candidates.length) return;
      this.accept(this.candidates[this.candidateIndex]);
      return false;
    });
  }

  onOpen(): void {
    this.opened = true;
    this.titleEl.setText(message("title"));
    this.contentEl.addClass("mv-run-dialog");
    this.renderModes();
  }

  onClose(): void {
    this.opened = false;
    this.lifetime.abort();
    this.contentEl.empty();
    this.closed();
  }

  private renderModes(): void {
    this.contentEl.empty();
    this.modeButtons = [];
    for (const [index, key] of (["default", "specified"] as const).entries()) {
      const button = this.contentEl.createEl("button", { cls: "mv-run-mode" });
      button.type = "button";
      button.createEl("strong", { text: message(key) });
      button.createSpan({ text: message(index ? "specifiedHint" : "defaultHint") });
      button.addEventListener("click", () => this.chooseMode(index));
      button.addEventListener("focus", () => { this.selectedMode = index; this.highlightMode(); });
      this.modeButtons.push(button);
    }
    this.feedback = this.contentEl.createDiv({ cls: "mv-run-feedback", attr: { "aria-live": "polite" } });
    this.highlightMode();
    this.modeButtons[0].focus();
  }

  private highlightMode(): void {
    this.modeButtons.forEach((button, index) => button.toggleClass("is-selected", index === this.selectedMode));
  }

  private chooseMode(index: number): void {
    if (this.busy) return;
    if (index === 0) { void this.submit(null); return; }
    this.specified = true;
    this.contentEl.empty();
    const label = this.contentEl.createEl("label", { text: message("order") });
    this.input = label.createEl("input", { type: "text", cls: "mv-run-order", attr: { "aria-label": message("order"), autocomplete: "off", spellcheck: "false" } });
    this.contentEl.createEl("p", { text: message("help"), cls: "setting-item-description" });
    this.suggestions = this.contentEl.createDiv({ cls: "mv-run-completions" });
    this.feedback = this.contentEl.createDiv({ cls: "mv-run-feedback", attr: { "aria-live": "polite" } });
    this.preview = this.contentEl.createDiv({ cls: "mv-run-preview" });
    const button = this.contentEl.createEl("button", { text: message("specified"), cls: "mod-cta" });
    button.type = "button";
    button.addEventListener("click", () => { void this.submit(this.input?.value ?? ""); });
    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("click", () => this.refresh());
    this.input.addEventListener("keyup", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) this.refresh(); });
    this.refresh();
    this.input.focus();
  }

  private refresh(): void {
    if (!this.input || !this.preview) return;
    this.candidates = completeReferences(this.tasks, this.input.value, this.input.selectionStart ?? this.input.value.length);
    this.candidateIndex = 0;
    this.renderCandidates();
    this.preview.empty();
    this.feedback?.empty();
    try {
      const plan = specifiedPlan(this.tasks, this.input.value);
      this.preview.createEl("h4", { text: message("preview") });
      const list = this.preview.createEl("ol");
      for (const task of plan.steps) list.createEl("li", { text: `${task.name ?? message("unnamed")}${task.protected ? " 🔒" : ""}${task.newTerminal ? " [-n]" : ""} — ${task.command}` });
      if (!plan.steps.length) this.preview.createEl("p", { text: message("empty") });
      if (plan.filtered.length) {
        this.preview.createEl("h4", { text: message("filtered") });
        const filtered = this.preview.createEl("ul");
        for (const task of plan.filtered) filtered.createEl("li", { text: `${task.name ?? message("unnamed")} — ${task.command}` });
      }
    } catch (error) {
      if (this.input.value.trim()) this.feedback?.setText(errorMessage(error));
    }
  }

  private renderCandidates(): void {
    if (!this.suggestions) return;
    this.suggestions.empty();
    for (const [index, item] of this.candidates.entries()) {
      const button = this.suggestions.createEl("button", { cls: "mv-run-completion" });
      button.type = "button";
      button.toggleClass("is-selected", index === this.candidateIndex);
      button.createEl("strong", { text: item.label });
      button.createSpan({ text: item.detail });
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => this.accept(item));
    }
    // 重建子节点会重置滚动位置；每次重渲染都把选中项滚动回可视区，
    // nearest 保证只在越界时滚动。jsdom 无 scrollIntoView 实现，需防御。
    const selected = this.suggestions.querySelector(".mv-run-completion.is-selected");
    if (selected instanceof HTMLElement && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }

  private accept(item: RunCompletion): void {
    if (!this.input || this.busy) return;
    this.input.value = this.input.value.slice(0, item.from) + item.insert + this.input.value.slice(item.to);
    const cursor = item.from + item.insert.length;
    this.input.setSelectionRange(cursor, cursor);
    this.refresh();
    this.input.focus();
  }

  private async submit(input: string | null): Promise<void> {
    if (this.busy || !this.opened) return;
    this.busy = true;
    if (this.input) this.input.disabled = true;
    this.feedback?.setText(message("waiting"));
    try {
      const result = await this.confirm(input, taskSignature(this.tasks), this.lifetime.signal);
      if (!this.opened) return;
      if (result.tasks) {
        this.tasks = result.tasks;
        this.refresh();
        this.feedback?.setText(result.notice ?? message("changed"));
      } else {
        this.close();
        result.run?.();
      }
    } catch (error) {
      if (this.opened) this.feedback?.setText(errorMessage(error));
    } finally {
      this.busy = false;
      if (this.input) this.input.disabled = false;
    }
  }
}
