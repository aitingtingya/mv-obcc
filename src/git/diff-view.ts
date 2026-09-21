import { ItemView, type WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import type { GitFeature } from "./feature";
import type { GitDiffData, GitDiffSpec } from "./model";
import { patchHunks } from "./parse";

export const GIT_DIFF_VIEW_TYPE = "mv-aide-git-diff";
export class GitDiffView extends ItemView {
  private spec: GitDiffSpec | null = null;
  private data: GitDiffData | null = null;
  private merge: MergeView | null = null;
  private editor: EditorView | null = null;
  private generation = 0;
  private dirty = false;
  private reverse = false;
  private selected = new Set<number>();
  constructor(leaf: WorkspaceLeaf, readonly feature: GitFeature) { super(leaf); }
  getViewType(): string { return GIT_DIFF_VIEW_TYPE; }
  getDisplayText(): string { return `Git: ${this.spec?.path ?? "Diff"}`; }
  getIcon(): string { return "file-diff"; }
  get hostWindow(): Window { return this.containerEl.ownerDocument.defaultView!; }
  getState(): Record<string, unknown> { return { spec: this.spec }; }
  async setState(state: { spec?: GitDiffSpec }, result: ViewStateResult): Promise<void> {
    if (state.spec && ["working", "staged", "history"].includes(state.spec.kind) && typeof state.spec.path === "string") this.spec = state.spec;
    await super.setState(state, result); await this.reload();
  }
  async onOpen(): Promise<void> { await this.reload(); }
  async onClose(): Promise<void> { this.generation++; this.destroy(); }
  private destroy(): void { this.merge?.destroy(); this.editor?.destroy(); this.merge = null; this.editor = null; }
  private afterEditor(): EditorView | null { return this.merge?.b ?? this.editor; }
  async save(): Promise<void> {
    if (!this.dirty || !this.data) return;
    const editor = this.afterEditor(); if (!editor) return;
    await this.feature.writeFile(this.data.spec.path, this.data.afterBytes, editor.state.doc.toString());
    this.dirty = false; await this.reload();
  }
  async reload(reverse = false): Promise<void> {
    if (!this.spec || !this.containerEl.isConnected && !this.contentEl) return;
    if (this.dirty && !await this.feature.dialogs(this).confirm(this.feature.label("放弃尚未保存的 diff 编辑？", "Discard unsaved diff edits?"), this.spec.path)) return;
    const generation = ++this.generation;
    try {
      await this.feature.repository.refresh();
      const data = await this.feature.repository.diff(this.spec, reverse);
      if (generation !== this.generation) return;
      this.data = data; this.reverse = reverse; this.dirty = false; this.selected.clear(); this.render();
    } catch (error) { this.feature.report(error); }
  }
  private render(): void {
    if (!this.data) return;
    const data = this.data; this.destroy(); this.contentEl.empty(); this.contentEl.addClass("mv-git-diff");
    const controls = this.contentEl.createDiv({ cls: "mv-git-actions" });
    const labels = data.spec.kind === "working" ? "Index → Working tree" : data.spec.kind === "staged" ? this.reverse ? "Index → HEAD (unstage preview)" : "HEAD → Index" : `${data.spec.from?.slice(0, 8) ?? "∅"} → ${data.spec.to?.slice(0, 8)}`;
    this.contentEl.createDiv({ text: `${data.spec.path} · ${labels}`, cls: "mv-git-diff-labels" });
    const refresh = controls.createEl("button", { text: this.feature.label("刷新", "Refresh") }); refresh.onclick = () => { void this.reload(this.reverse); };
    const open = controls.createEl("button", { text: this.feature.label("打开文件", "Open file") }); open.onclick = () => this.feature.run("file-open", { target: { kind: "file", paths: [data.spec.path] } }, this);
    if (data.binary) { this.contentEl.createEl("p", { text: this.feature.label("二进制或非 UTF-8 内容；请使用整文件操作。", "Binary or non-UTF-8 content; use whole-file actions.") }); return; }
    const editable = data.spec.kind === "working" && !this.reverse;
    if (editable) {
      const save = controls.createEl("button", { text: this.feature.label("保存编辑", "Save edits") });
      save.onclick = () => { void this.save().catch(error => this.feature.report(error)); };
    }
    const host = this.contentEl.createDiv({ cls: "mv-git-merge-host" });
    const base = [lineNumbers(), EditorView.lineWrapping];
    const extensions = [...base, history(), keymap.of([...defaultKeymap, ...historyKeymap, { key: "Mod-s", run: () => { void this.save().catch(error => this.feature.report(error)); return true; } }]),
      EditorState.readOnly.of(!editable), EditorView.editable.of(editable),
      EditorView.updateListener.of(update => { if (update.docChanged) this.dirty = true; })];
    const layout = this.feature.settings.layout;
    if (layout === "inline" || layout === "auto" && this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < 700) {
      this.editor = new EditorView({ parent: host, doc: data.after, extensions: [...extensions, unifiedMergeView({ original: data.before, mergeControls: false, gutter: true })] });
    } else {
      this.merge = new MergeView({ parent: host, a: { doc: data.before, extensions: [...base, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
        b: { doc: data.after, extensions }, collapseUnchanged: { margin: 3, minSize: 8 } });
    }
    if (data.spec.kind === "history") return;
    if (data.spec.kind === "staged" && !this.reverse) {
      const select = controls.createEl("button", { text: this.feature.label("选择取消暂存的行／块", "Select lines / hunks to unstage") }); select.onclick = () => { void this.reload(true); }; return;
    }
    const partial = this.contentEl.createEl("details", { cls: "mv-git-patch" });
    partial.createEl("summary", { text: this.feature.label("选择行／差异块", "Select lines / hunks") });
    const patchHost = partial.createDiv();
    const apply = controls.createEl("button", { text: this.reverse ? this.feature.label("取消暂存选中部分", "Unstage selected changes") : this.feature.label("暂存选中部分", "Stage selected changes") });
    apply.onclick = () => {
      if (this.dirty) { this.feature.report(new Error(this.feature.label("请先保存编辑并刷新差异", "Save edits and refresh the diff first"))); return; }
      void this.feature.repository.applySelection(data, this.selected, this.reverse).then(() => this.reload(this.reverse)).catch(error => this.feature.report(error));
    };
    for (const hunk of patchHunks(data.patch)) {
      const hunkRow = patchHost.createEl("label", { cls: "mv-git-patch-hunk" });
      const all = hunkRow.createEl("input", { type: "checkbox" }); hunkRow.createSpan({ text: hunk.header });
      const checks: { input: HTMLInputElement; index: number }[] = [];
      all.onchange = () => { for (const check of checks) { check.input.checked = all.checked; if (all.checked) this.selected.add(check.index); else this.selected.delete(check.index); } };
      for (const line of hunk.lines) {
        const row = patchHost.createEl("label", { cls: "mv-git-patch-line" }); row.toggleClass("is-addition", line.text[0] === "+"); row.toggleClass("is-deletion", line.text[0] === "-");
        if (line.change) {
          const check = row.createEl("input", { type: "checkbox", attr: { "aria-label": line.text } }); checks.push({ input: check, index: line.index });
          check.onchange = () => { if (check.checked) this.selected.add(line.index); else this.selected.delete(line.index); };
        }
        row.createEl("code", { text: line.text });
      }
    }
  }
}
