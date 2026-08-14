import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { DIFF_VIEW_TYPE } from "./constants";
import { t } from "./i18n";
import type { DiffPayload } from "./types";

export class ObsidianDiffView extends ItemView {
  private payload: DiffPayload | null = null;
  private mergeView: MergeView | null = null;
  private resolved = false;
  private acceptButton: HTMLButtonElement | null = null;
  private rejectButton: HTMLButtonElement | null = null;
  private conflictElement: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DIFF_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.payload?.tabName ?? t("Claude Code 差异审核");
  }

  /** Re-render action button / conflict copy after a language switch. */
  refreshI18n(): void {
    if (this.payload) this.render();
  }

  getIcon(): string {
    return "file-diff";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    if (!this.resolved && this.payload) {
      await this.finish("reject", false);
    }
    this.mergeView?.destroy();
    this.mergeView = null;
  }

  setPayload(payload: DiffPayload): void {
    this.payload = payload;
    this.resolved = false;
    this.render();
  }

  async forceReject(): Promise<void> {
    await this.finish("reject", false);
  }

  matchesTabName(tabName: string): boolean {
    return this.payload?.tabName === tabName;
  }

  private render(): void {
    if (!this.payload || !this.contentEl) return;
    this.mergeView?.destroy();
    this.mergeView = null;
    this.contentEl.empty();
    this.contentEl.addClass("mv-aide-diff-view");

    const header = this.contentEl.createDiv({ cls: "mv-aide-diff-header" });
    header.createSpan({ cls: "mv-aide-diff-title", text: this.payload.tabName });
    const actions = header.createDiv({ cls: "mv-aide-diff-actions" });
    this.rejectButton = actions.createEl("button", {
      text: t("拒绝"),
      cls: "mod-warning",
    });
    this.acceptButton = actions.createEl("button", {
      text: t("接受"),
      cls: "mod-cta",
    });
    this.conflictElement = this.contentEl.createDiv({
      cls: "mv-aide-diff-conflict",
      text: t("打开差异后源文件发生了变化。请重新执行编辑后再接受。"),
    });
    const host = this.contentEl.createDiv({ cls: "mv-aide-merge-host" });

    this.rejectButton.addEventListener("click", () => void this.finish("reject"));
    this.acceptButton.addEventListener("click", () => void this.finish("accept"));

    const commonExtensions = [
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.theme({
        "&": { fontSize: "var(--editor-font-size, 14px)" },
      }),
    ];

    this.mergeView = new MergeView({
      a: {
        doc: this.payload.oldContents,
        extensions: [
          ...commonExtensions,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: this.payload.newContents,
        extensions: commonExtensions,
      },
      parent: host,
      revertControls: "a-to-b",
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
  }

  private async finish(
    decision: "accept" | "reject",
    detach = true,
  ): Promise<void> {
    if (this.resolved || !this.payload) return;

    if (decision === "accept" && !(await this.payload.validateOriginal())) {
      this.conflictElement?.addClass("is-visible");
      new Notice(t("mv-AIDE IDE：源文件已变化，本次差异未被接受。"));
      return;
    }

    this.resolved = true;
    if (this.acceptButton) this.acceptButton.disabled = true;
    if (this.rejectButton) this.rejectButton.disabled = true;
    const contents =
      this.mergeView?.b.state.doc.toString() ?? this.payload.newContents;
    await this.payload.onResolve(decision, contents);
    if (detach) this.leaf.detach();
  }
}
