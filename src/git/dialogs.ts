import { FuzzySuggestModal, Modal, SuggestModal, type App } from "obsidian";
import type { GitChoice } from "./actions";

/**
 * Palette-style dialogs: every prompt rides Obsidian's Modal machinery, so the input is focused on open,
 * arrows/Enter/Escape behave exactly like the command palette, and focus is restored on close.
 * (Same approach as the Obsidian Git plugin's SuggestModal/FuzzySuggestModal prompts.)
 */

/** Fuzzy picker identical to the command palette: focused input, arrows, Enter, Escape → null. */
class ChoiceModal extends FuzzySuggestModal<GitChoice> {
  private done = false;
  constructor(app: App, title: string, private items: GitChoice[], private finish: (value: string | null) => void) {
    super(app);
    this.setPlaceholder(title);
  }
  getItems(): GitChoice[] { return this.items; }
  getItemText(item: GitChoice): string { return `${item.label} ${item.description ?? ""}`; }
  renderSuggestion(match: { item: GitChoice }, el: HTMLElement): void {
    el.createSpan({ text: match.item.label });
    if (match.item.description) el.createEl("small", { text: match.item.description, cls: "mv-git-picker-note" });
  }
  onChooseItem(item: GitChoice): void { if (!this.done) { this.done = true; this.finish(item.value); } }
  onClose(): void { window.setTimeout(() => { if (!this.done) { this.done = true; this.finish(null); } }, 10); }
}

const EMPTY = " ";
/** Single-line input as a suggestion row: the typed text is always the first suggestion (Enter submits it). */
class TextModal extends SuggestModal<string> {
  private done = false;
  constructor(app: App, title: string, private initial: string, private emptyLabel: string, private finish: (value: string | null) => void) {
    super(app);
    this.setPlaceholder(title);
  }
  onOpen(): void { this.inputEl.value = this.initial; this.inputEl.dispatchEvent(new Event("input")); }
  getSuggestions(query: string): string[] { return [query !== "" ? query : EMPTY]; }
  renderSuggestion(value: string, el: HTMLElement): void { el.setText(value === EMPTY ? this.emptyLabel : value); }
  onChooseSuggestion(value: string): void { if (!this.done) { this.done = true; this.finish(value === EMPTY ? "" : value); } }
  onClose(): void { window.setTimeout(() => { if (!this.done) { this.done = true; this.finish(null); } }, 10); }
}

/** Multiline text (commit messages, tag annotations): Ctrl/Cmd+Enter submits, Escape cancels. */
class MultilineModal extends Modal {
  private done = false;
  constructor(app: App, private title: string, private initial: string, private english: boolean, private finish: (value: string | null) => void) { super(app); }
  onOpen(): void {
    this.scope.register([], "Escape", () => { this.close(); return false; });
    this.titleEl.setText(this.title);
    const input = this.contentEl.createEl("textarea", { cls: "mv-git-input", attr: { "aria-label": this.title, rows: "4" } });
    input.value = this.initial;
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.submit(input.value); }
    });
    const buttons = this.contentEl.createDiv({ cls: "mv-git-actions" });
    buttons.createEl("button", { text: this.english ? "Cancel" : "取消" }).onclick = () => this.close();
    buttons.createEl("button", { text: this.english ? "Confirm" : "确认", cls: "mod-cta" }).onclick = () => this.submit(input.value);
    input.focus();
  }
  private submit(value: string): void { if (!this.done) { this.done = true; this.finish(value); } this.close(); }
  onClose(): void { window.setTimeout(() => { if (!this.done) { this.done = true; this.finish(null); } }, 10); }
}

class ConfirmModal extends Modal {
  private done = false;
  constructor(app: App, private title: string, private detail: string, private english: boolean, private finish: (value: boolean) => void) { super(app); }
  onOpen(): void {
    this.scope.register([], "Escape", () => { this.close(); return false; });
    this.titleEl.setText(this.title);
    this.contentEl.createEl("pre", { text: this.detail, cls: "mv-git-confirm-detail" });
    const buttons = this.contentEl.createDiv({ cls: "mv-git-actions" });
    buttons.createEl("button", { text: this.english ? "Cancel" : "取消" }).onclick = () => this.close();
    const ok = buttons.createEl("button", { text: this.english ? "Confirm" : "确认", cls: "mod-warning" });
    ok.onclick = () => { if (!this.done) { this.done = true; this.finish(true); } this.close(); };
    ok.focus();
  }
  onClose(): void { window.setTimeout(() => { if (!this.done) { this.done = true; this.finish(false); } }, 10); }
}

class ShowModal extends Modal {
  constructor(app: App, private title: string, private text: string, private english: boolean, private finish: () => void) { super(app); }
  onOpen(): void {
    this.scope.register([], "Escape", () => { this.close(); return false; });
    this.titleEl.setText(this.title);
    this.contentEl.createEl("pre", { text: this.text, cls: "mv-git-confirm-detail" });
    const close = this.contentEl.createEl("button", { text: this.english ? "Close" : "关闭" });
    close.onclick = () => this.close();
    close.focus();
  }
  onClose(): void { window.setTimeout(() => this.finish(), 10); }
}

export class GitDialogs {
  private open = new Set<Modal>();
  dispose(): void { for (const modal of [...this.open]) modal.close(); }
  constructor(readonly app: App, readonly host: NonNullable<Document["defaultView"]>, readonly english: boolean) {}

  private track<T extends Modal>(modal: T): T {
    this.open.add(modal);
    const original = modal.onClose.bind(modal);
    modal.onClose = () => { original(); this.open.delete(modal); };
    return modal;
  }

  choose(title: string, items: GitChoice[]): Promise<string | null> {
    if (this.host.closed) return Promise.resolve(null);
    return new Promise(resolve => this.track(new ChoiceModal(this.app, title, items, resolve)).open());
  }

  prompt(title: string, initial = "", multiline = false, palette = false): Promise<string | null> {
    if (this.host.closed) return Promise.resolve(null);
    // Palette invocations keep everything in the palette row: single-line suggestion input, no window.
    return new Promise(resolve => this.track(!palette && multiline
      ? new MultilineModal(this.app, title, initial, this.english, resolve)
      : new TextModal(this.app, title, initial, this.english ? "(empty)" : "（留空）", resolve)).open());
  }

  async confirm(title: string, detail: string, palette = false): Promise<boolean> {
    if (this.host.closed) return false;
    if (palette) {
      const value = await this.choose(title, [
        { value: "yes", label: this.english ? "Confirm" : "确认", description: detail },
        { value: "no", label: this.english ? "Cancel" : "取消" },
      ]);
      return value === "yes";
    }
    return await new Promise<boolean>(resolve => this.track(new ConfirmModal(this.app, title, detail, this.english, resolve)).open());
  }

  async show(title: string, text: string): Promise<void> {
    if (this.host.closed) return;
    await new Promise<void>(resolve => this.track(new ShowModal(this.app, title, text, this.english, resolve)).open());
  }
}
