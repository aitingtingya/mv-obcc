import { ItemView, type WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { defaultKeymap } from "@codemirror/commands";
import type { GitFeature } from "./feature";

export const GIT_CONFLICT_VIEW_TYPE = "mv-aide-git-conflict";
interface ConflictState { path: string }

/** Three-way conflict editor: base and both sources stay visible; saving and marking resolved are separate steps. */
export class GitConflictView extends ItemView {
  private file = "";
  private merge: MergeView | null = null;
  private generation = 0;
  private expected: Uint8Array | null = null;
  private oursLabel = "ours";
  private theirsLabel = "theirs";
  constructor(leaf: WorkspaceLeaf, readonly feature: GitFeature) { super(leaf); }
  getViewType(): string { return GIT_CONFLICT_VIEW_TYPE; }
  getDisplayText(): string { return `Git: ${this.file || "Conflict"}`; }
  getIcon(): string { return "git-merge"; }
  getState(): Record<string, unknown> { return { path: this.file }; }
  async setState(state: Partial<ConflictState>, result: ViewStateResult): Promise<void> {
    if (typeof state.path === "string") this.file = state.path;
    await super.setState(state, result);
    await this.reload();
  }
  async onOpen(): Promise<void> { await this.reload(); }
  async onClose(): Promise<void> { this.generation++; this.merge?.destroy(); this.merge = null; }
  private async reload(): Promise<void> {
    if (!this.file) return;
    const generation = ++this.generation;
    try {
      await this.feature.repository.refresh();
      const data = await this.feature.repository.conflictData(this.file);
      if (generation !== this.generation) return;
      this.expected = data.worktree;
      this.oursLabel = data.oursLabel; this.theirsLabel = data.theirsLabel;
      this.render(data);
    } catch (error) { this.feature.report(error); }
  }
  private render(data: { base: string; ours: string; theirs: string; worktree: Uint8Array; oursLabel: string; theirsLabel: string }): void {
    this.merge?.destroy(); this.merge = null;
    this.contentEl.empty(); this.contentEl.addClass("mv-git-diff");
    this.contentEl.createDiv({ text: `${this.file} · ${this.feature.label("冲突解决", "Conflict resolution")}`, cls: "mv-git-diff-labels" });
    const labels = this.contentEl.createDiv({ cls: "mv-git-conflict-labels" });
    labels.createSpan({ text: `${this.feature.label("左侧：当前侧", "Left: ours")} · ${data.oursLabel}` });
    labels.createSpan({ text: this.feature.label("右侧：合并结果（可编辑）", "Right: merge result (editable)") });
    const controls = this.contentEl.createDiv({ cls: "mv-git-actions" });
    const save = controls.createEl("button", { text: this.feature.label("保存结果到工作区", "Save result to worktree") });
    save.onclick = () => { void this.save().catch(error => this.feature.report(error)); };
    const resolved = controls.createEl("button", { text: this.feature.label("标记已解决（暂存）", "Mark resolved (stage)") });
    resolved.onclick = () => this.feature.run("resolved", { target: { kind: "file", paths: [this.file] } }, this);
    const refresh = controls.createEl("button", { text: this.feature.label("刷新", "Refresh") });
    refresh.onclick = () => { void this.reload(); };
    const host = this.contentEl.createDiv({ cls: "mv-git-merge-host" });
    const baseExtensions = [lineNumbers(), EditorView.lineWrapping, keymap.of(defaultKeymap)];
    this.merge = new MergeView({
      parent: host,
      a: { doc: data.ours, extensions: [...baseExtensions, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: { doc: data.worktree.toString(), extensions: [...baseExtensions, keymap.of([{ key: "Mod-s", run: () => { void this.save().catch(error => this.feature.report(error)); return true; } }])] },
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    const extra = this.contentEl.createEl("details", { cls: "mv-git-patch" });
    extra.createEl("summary", { text: this.feature.label("查看基线与对方来源", "Show base and incoming source") });
    const panes = extra.createDiv({ cls: "mv-git-actions" });
    for (const [title, text] of [[this.feature.label("基线", "Base"), data.base], [`${this.feature.label("对方", "Theirs")} · ${data.theirsLabel}`, data.theirs]] as const) {
      const pane = panes.createDiv();
      pane.createDiv({ text: title, cls: "mv-git-diff-labels" });
      pane.createEl("pre", { text, cls: "mv-git-confirm-detail" });
    }
  }
  async save(): Promise<void> {
    if (!this.merge || !this.expected) return;
    await this.feature.writeFile(this.file, this.expected, this.merge.b.state.doc.toString());
    await this.reload();
  }
}
