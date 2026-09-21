import { ItemView, Menu, type WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type { GitFeature } from "./feature";
import type { GitActionContext } from "./actions";
import type { GitCommit, GitFile, GitSnapshot, GitTarget } from "./model";
import { graphRows } from "./graph";

export const GIT_VIEW_TYPE = "mv-aide-git";
/** Commit-form actions: the main button sticks to the last dropdown choice. */
const COMMIT_ACTIONS = ["commit", "commit-all", "commit-all-push", "commit-push", "commit-sync", "amend", "undo-commit"];
export class GitWorkspaceView extends ItemView {
  private release: (() => void) | null = null;
  private message = "";
  private messageInput: HTMLTextAreaElement | null = null;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private commits: GitCommit[] = [];
  private historyFile: string | undefined;
  private historyRef = "";
  private commitAction = "commit";
  private historyEl: HTMLElement | null = null;
  private filter = "";
  private historyGeneration = 0;
  private head = "";
  private selected = new Set<string>();
  private selectedCommits = new Set<string>();
  private batchMode = false;
  private compare: string | undefined;
  private historyHeight = 0;
  private expanded = new Set(["staged", "conflicts"]);
  constructor(leaf: WorkspaceLeaf, readonly feature: GitFeature) { super(leaf); }
  getViewType(): string { return GIT_VIEW_TYPE; }
  getDisplayText(): string { return "Git"; }
  getIcon(): string { return "git-branch"; }
  getState(): Record<string, unknown> { return { message: this.message, historyRef: this.historyRef, commitAction: this.commitAction, historyHeight: this.historyHeight }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    if (typeof state.message === "string") this.message = state.message;
    if (typeof state.historyHeight === "number") this.historyHeight = state.historyHeight;
    this.historyRef = typeof state.historyRef === "string" ? state.historyRef : state.allBranches === true ? "--all" : "";
    if (typeof state.commitAction === "string" && COMMIT_ACTIONS.includes(state.commitAction)) this.commitAction = state.commitAction;
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.contentEl.empty(); this.contentEl.addClass("mv-git-workspace");
    const toolbar = this.contentEl.createDiv({ cls: "mv-git-actions" });
    for (const id of ["push", "fetch-all", "pull", "fetch"]) this.button(toolbar, id);
    const more = toolbar.createEl("button", { text: "…", attr: { "aria-label": this.feature.label("全部 Git 操作", "All Git actions") } });
    more.onclick = event => this.feature.menu(event, undefined, this);
    this.status = this.contentEl.createDiv({ cls: "mv-git-status" });
    const form = this.contentEl.createDiv({ cls: "mv-git-commit-form" });
    const input = form.createEl("textarea", { attr: { placeholder: this.feature.label("提交消息", "Commit message"), "aria-label": this.feature.label("提交消息", "Commit message"), rows: "3" } });
    input.value = this.message || this.feature.settings.messageTemplate;
    this.message = input.value;
    this.messageInput = input;
    input.oninput = () => { this.message = input.value; this.app.workspace.requestSaveLayout(); };
    input.onkeydown = event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.run(this.commitAction); } };
    const actions = form.createDiv({ cls: "mv-git-actions" });
    const commitButton = actions.createEl("button", { text: this.feature.actionLabel(this.commitAction) });
    commitButton.onclick = () => this.run(this.commitAction);
    const dropdown = actions.createEl("button", { text: "▾", attr: { "aria-label": this.feature.label("更多提交动作", "More commit actions") } });
    dropdown.onclick = event => {
      const menu = new Menu();
      for (const id of COMMIT_ACTIONS)
        menu.addItem(item => item.setTitle(this.feature.actionLabel(id)).onClick(() => {
          this.commitAction = id; commitButton.setText(this.feature.actionLabel(id));
          this.app.workspace.requestSaveLayout(); this.run(id);
        }));
      menu.showAtMouseEvent(event);
    };
    this.body = this.contentEl.createDiv({ cls: "mv-git-body" });
    this.release = this.feature.subscribe(() => this.render()); this.render();
    this.feature.refresh();
  }
  async onClose(): Promise<void> { this.historyGeneration++; this.release?.(); this.release = null; }
  get hostWindow(): Window { return this.containerEl.ownerDocument.defaultView!; }
  private button(parent: HTMLElement, id: string, context: GitActionContext = {}): HTMLButtonElement {
    const button = parent.createEl("button", { text: this.feature.actionLabel(id) }); button.onclick = () => this.run(id, context); return button;
  }
  private run(id: string, context: GitActionContext = {}): void {
    void this.feature.run(id, { ...context, message: this.message }, this).then(result => {
      // A completed commit consumes the draft; failures and cancellations keep it.
      if (result?.mutated && ["commit", "commit-all", "commit-all-push", "commit-push", "commit-sync", "amend"].includes(id)) {
        this.message = "";
        if (this.messageInput) this.messageInput.value = this.feature.settings.messageTemplate;
        this.app.workspace.requestSaveLayout();
      }
    });
  }
  /** Arrow keys move between object rows; Enter activates; ContextMenu/Shift+F10 opens the object menu. */
  /** Absolute local time for history rows (yyyy-MM-dd HH:mm); empty when unparseable. */
  private formatTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  private keys(row: HTMLElement, primary: HTMLElement, menu?: () => void): void {
    row.tabIndex = 0;
    row.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const rows = Array.from(this.body.querySelectorAll<HTMLElement>(".mv-git-file-row, .mv-git-commit-row, .mv-git-ref"));
        const index = rows.indexOf(row);
        rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      } else if (event.key === "Enter") { event.preventDefault(); primary.click(); }
      else if (menu && (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey)) { event.preventDefault(); menu(); }
    });
  }
  private section(id: string, title: string, parent = this.body): HTMLElement {
    const section = parent.createEl("details", { cls: "mv-git-section" }); section.open = this.expanded.has(id);
    section.createEl("summary", { text: title });
    section.ontoggle = () => { if (section.open) this.expanded.add(id); else this.expanded.delete(id); };
    return section.createDiv();
  }
  render(): void {
    if (!this.body) return;
    const snapshot = this.feature.repository.snapshot, previousScroll = this.body.scrollTop;
    this.status.setText(this.feature.repository.error || (snapshot ? `${snapshot.branch || "HEAD"}  ↑${snapshot.ahead} ↓${snapshot.behind}${snapshot.operation ? ` · ${snapshot.operation}` : ""}${this.feature.repository.busy ? " · …" : ""}\n${snapshot.root}` : this.feature.label("尚未初始化 Git", "No Git repository")));
    this.body.empty();
    if (!this.feature.settings.enabled) { this.body.createEl("p", { text: this.feature.label("Git 已关闭", "Git disabled") }); return; }
    if (!snapshot) { this.button(this.body, "init"); return; }
    if (snapshot.operation) {
      const progress = this.body.createDiv({ cls: "mv-git-actions" });
      for (const id of ["conflicts", "continue", "skip", "abort"]) this.button(progress, id);
    }
    const groups: [string, string, GitFile[], boolean][] = [
      ["conflicts", this.feature.label("冲突", "Conflicts"), snapshot.files.filter(f => f.conflict), false],
      ["staged", this.feature.label("已暂存", "Staged changes"), snapshot.files.filter(f => !f.conflict && !f.untracked && ![".", "?"].includes(f.index)), true],
      ["changes", this.feature.label("未暂存", "Changes"), snapshot.files.filter(f => !f.conflict && !f.untracked && f.worktree !== "."), false],
      ["untracked", this.feature.label("未跟踪", "Untracked"), snapshot.files.filter(f => f.untracked), false],
    ];
    for (const [id, label, files, staged] of groups) {
      if (!files.length) continue;
      const area = this.section(id, `${label} (${files.length})`);
      const groupActions = area.createDiv({ cls: "mv-git-actions" });
      this.button(groupActions, staged ? "unstage" : "stage", { target: { kind: "file", paths: files.map(f => f.path), staged } });
      if (id === "changes") this.button(groupActions, "stage-all");
      if (!staged) this.button(groupActions, "discard", { target: { kind: "file", paths: files.map(f => f.path) } });
      this.files(area, files, staged);
    }
    this.refSection("branch", snapshot);
    this.historySection(snapshot);
    for (const kind of ["tag", "stash", "remote"] as const) this.refSection(kind, snapshot);
    this.body.scrollTop = previousScroll;
    const key = `${snapshot.head}:${snapshot.refs.map(ref => ref.oid).join()}`;
    if (key !== this.head) { this.head = key; void this.loadHistory(); }
  }
  private refSection(kind: "branch" | "remote" | "tag" | "stash", snapshot: GitSnapshot): void {
    const area = this.section(kind, this.feature.label({ branch: "分支", remote: "远程", tag: "标签", stash: "工作进度" }[kind], { branch: "Branches", remote: "Remotes", tag: "Tags", stash: "Stashes" }[kind]));
    this.button(area, { branch: "branch-new", remote: "remote-add", tag: "tag-new", stash: "stash-new" }[kind]);
    const entries: { text: string; target: GitTarget; refName?: string }[] = kind === "stash" ? snapshot.stashes.map(s => ({ text: `${s.name} ${s.message}`, target: { kind: "stash", ...s } }))
      : kind === "remote" ? snapshot.remotes.map(name => ({ text: name, target: { kind: "remote", name } }))
      : snapshot.refs.filter(ref => kind === "branch" ? ref.kind !== "tag" : ref.kind === "tag").map(ref => ({ text: ref.name.replace(/^refs\/(heads|remotes|tags)\//, ""), target: { kind, name: ref.name }, refName: ref.name }));
    for (const entry of entries) {
      const row = area.createEl("button", { text: entry.text, cls: "mv-git-ref" });
      const buildMenu = () => {
        const menu = new Menu();
        if (kind === "branch" && entry.refName) {
          menu.addItem(item => item.setTitle(this.feature.label("查看提交历史", "Show branch history")).onClick(() => this.jumpToHistory(entry.refName!)));
          menu.addSeparator();
        }
        return this.feature.makeMenu(entry.target, this, menu);
      };
      const menu = () => { const rect = row.getBoundingClientRect(); buildMenu().showAtPosition({ x: rect.left, y: rect.bottom }); };
      row.onclick = event => { event.preventDefault(); buildMenu().showAtMouseEvent(event); };
      row.oncontextmenu = event => { event.preventDefault(); buildMenu().showAtMouseEvent(event); };
      row.addEventListener("keydown", event => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); menu(); } });
    }
  }
  private jumpToHistory(ref: string): void {
    this.historyRef = ref; this.historyFile = undefined; this.expanded.add("history");
    this.app.workspace.requestSaveLayout();
    void this.loadHistory().then(() => this.historyEl?.scrollIntoView({ block: "start" }));
  }
  private historySection(snapshot: GitSnapshot): void {
    const history = this.section("history", this.feature.label("提交历史", "History"));
    this.historyEl = history;
    const controls = history.createDiv({ cls: "mv-git-actions" });
    const filter = controls.createEl("input", { type: "search", attr: { placeholder: this.feature.label("筛选已加载历史", "Filter loaded history"), "aria-label": "History filter" } }); filter.value = this.filter;
    filter.oninput = () => { this.filter = filter.value; this.renderGraph(graph); };
    const selectorLabel = this.historyRef === "" ? this.feature.label("当前分支", "Current branch")
      : this.historyRef === "--all" ? this.feature.label("全部分支", "All branches")
      : this.historyRef.replace(/^refs\/(heads|remotes)\//, "");
    const selector = controls.createEl("button", { text: `${this.feature.label("选择分支", "Select branch")}: ${selectorLabel}`, attr: { "aria-label": this.feature.label("选择历史分支", "Select history branch") } });
    selector.onclick = event => {
      const menu = new Menu();
      const add = (value: string, label: string) => menu.addItem(item => item.setTitle(`${this.historyRef === value ? "✓ " : ""}${label}`).onClick(() => { this.historyRef = value; this.historyFile = undefined; this.app.workspace.requestSaveLayout(); void this.loadHistory(); }));
      add("", this.feature.label("当前分支", "Current branch"));
      add("--all", this.feature.label("全部分支", "All branches"));
      menu.addSeparator();
      for (const ref of snapshot.refs.filter(ref => ref.kind !== "tag")) add(ref.name, ref.name.replace(/^refs\/(heads|remotes)\//, ""));
      menu.showAtMouseEvent(event);
    };
    const batch = controls.createEl("button", { text: this.feature.label("节点批量操作", "Batch operations"), cls: "mv-git-batch-toggle", attr: { "aria-pressed": String(this.batchMode), title: this.feature.label("显示提交复选框以批量 cherry-pick／revert", "Show commit checkboxes for batch cherry-pick/revert") } });
    if (this.batchMode) batch.addClass("is-active");
    batch.onclick = () => { this.batchMode = !this.batchMode; if (!this.batchMode) this.selectedCommits.clear(); this.render(); };
    const graph = history.createDiv({ cls: "mv-git-graph" });
    if (this.historyHeight) graph.setCssProps({ maxHeight: `${this.historyHeight}px`, overflowY: "auto" });
    this.renderGraph(graph);
    const handle = history.createDiv({ cls: "mv-git-history-resize", attr: { role: "separator", "aria-label": this.feature.label("调整历史区高度", "Resize history area"), tabindex: "-1" } });
    handle.addEventListener("pointerdown", event => {
      event.preventDefault();
      const doc = handle.ownerDocument, startY = event.clientY, startHeight = graph.getBoundingClientRect().height;
      handle.addClass("is-dragging");
      const move = (e: PointerEvent) => {
        this.historyHeight = Math.max(80, Math.min(2000, Math.round(startHeight + e.clientY - startY)));
        graph.setCssProps({ maxHeight: `${this.historyHeight}px`, overflowY: "auto" });
      };
      const up = () => {
        handle.removeClass("is-dragging");
        doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up);
        this.app.workspace.requestSaveLayout();
      };
      doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", up);
    });
    const more = history.createEl("button", { text: this.feature.label("加载更多", "Load more") }); more.onclick = () => { void this.loadHistory(true); };
  }
  private files(parent: HTMLElement, files: GitFile[], staged: boolean): void {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    // Directory groups use the same file action context, never a shell wildcard.
    const folders = new Map<string, HTMLElement>();
    for (const file of sorted) {
      const directory = this.feature.settings.tree && file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      let area = parent;
      if (directory) {
        if (!folders.has(directory)) {
          const details = parent.createEl("details"); details.open = true; const summary = details.createEl("summary", { text: directory });
          summary.oncontextmenu = event => { event.preventDefault(); this.feature.menu(event, { kind: "file", paths: files.filter(f => f.path.startsWith(`${directory}/`)).map(f => f.path), staged }, this); };
          folders.set(directory, details.createDiv());
        }
        area = folders.get(directory)!;
      }
      const row = area.createDiv({ cls: "mv-git-file-row" });
      const check = row.createEl("input", { type: "checkbox", attr: { "aria-label": file.path } }); check.checked = this.selected.has(file.path);
      check.onchange = () => { if (check.checked) this.selected.add(file.path); else this.selected.delete(file.path); };
      const title = row.createEl("button", { text: `${file.conflict ? "!" : staged ? file.index : file.worktree} ${directory ? file.path.slice(directory.length + 1) : file.path}`, cls: "mv-git-file-name", attr: { title: file.original ? `${file.original} → ${file.path}` : file.path } });
      const target: GitTarget = { kind: "file", paths: [file.path], staged };
      title.onclick = () => { if (file.conflict) this.feature.openConflict(file.path, this); else this.run("diff", { target }); };
      const menu = () => { const rect = row.getBoundingClientRect(); this.feature.makeMenu(this.selected.has(file.path) ? { ...target, paths: [...this.selected] } : target, this).showAtPosition({ x: rect.left, y: rect.bottom }); };
      row.oncontextmenu = event => { event.preventDefault(); this.feature.menu(event, this.selected.has(file.path) ? { ...target, paths: [...this.selected] } : target, this); };
      this.keys(row, title, menu);
      this.button(row, staged ? "unstage" : "stage", { target });
    }
  }
  private renderGraph(parent: HTMLElement): void {
    parent.empty(); const query = this.filter.toLocaleLowerCase();
    for (const row of graphRows(this.commits)) {
      const commit = row.commit; if (query && !`${commit.message} ${commit.author} ${commit.oid} ${commit.refs}`.toLocaleLowerCase().includes(query)) continue;
      const entry = parent.createDiv({ cls: "mv-git-commit-row" });
      if (this.batchMode) {
        const check = entry.createEl("input", { type: "checkbox", attr: { "aria-label": commit.oid } }); check.checked = this.selectedCommits.has(commit.oid);
        check.onchange = () => { if (check.checked) this.selectedCommits.add(commit.oid); else this.selectedCommits.delete(commit.oid); };
      }
      const svg = entry.createSvg("svg", { attr: { viewBox: `0 0 ${Math.max(36, row.lanes * 14 + 10)} 30`, width: String(Math.max(36, row.lanes * 14 + 10)), height: "30", "aria-hidden": "true" } });
      for (const edge of row.edges) svg.createSvg("path", { attr: { d: `M ${edge.from * 14 + 10} 0 L ${edge.from * 14 + 10} 15 L ${edge.to * 14 + 10} 30`, class: "mv-git-graph-edge" } });
      svg.createSvg("circle", { attr: { cx: String(row.column * 14 + 10), cy: "15", r: "4", class: "mv-git-graph-node" } });
      const button = entry.createEl("button", { cls: "mv-git-history-label", attr: { title: `${commit.author} · ${commit.date}\n${commit.refs}\n${commit.message}` } });
      button.createSpan({ cls: "mv-git-commit-title", text: `${commit.oid.slice(0, 7)} ${commit.message.split("\n")[0]}` });
      for (const raw of commit.refs ? commit.refs.split(", ").filter(Boolean) : []) {
        const isTag = raw.startsWith("tag: "), isHead = raw.startsWith("HEAD -> ") || raw === "HEAD";
        const name = isTag ? raw.slice(5) : raw.replace(/^HEAD -> /, "");
        button.createSpan({ cls: `mv-git-ref-badge${isTag ? " is-tag" : ""}${isHead ? " is-head" : ""}`, text: name });
      }
      const time = this.formatTime(commit.date);
      if (time) button.createSpan({ cls: "mv-git-commit-time", text: time });
      button.onclick = () => this.run("commit-diff", { target: { kind: "commit", oid: commit.oid } });
      entry.oncontextmenu = event => { event.preventDefault(); this.commitMenu(commit, event); };
      this.keys(entry, button, () => this.commitMenu(commit, undefined, entry));
    }
  }
  private commitMenu(commit: GitCommit, event?: MouseEvent, row?: HTMLElement): void {
    const selected = this.batchMode ? [...this.selectedCommits].filter(oid => this.commits.some(c => c.oid === oid)) : [];
    const target = selected.length >= 2 ? { kind: "commit" as const, oid: commit.oid, oids: selected } : { kind: "commit" as const, oid: commit.oid };
    const menu = this.feature.makeMenu(target, this);
    if (selected.length >= 2) {
      menu.addSeparator();
      menu.addItem(item => item.setTitle(this.feature.label("清除提交选择", "Clear commit selection")).onClick(() => { this.selectedCommits.clear(); this.render(); }));
    }
    menu.addSeparator();
    menu.addItem(item => item.setTitle(this.feature.label("选为比较起点", "Select for comparison")).onClick(() => { this.compare = commit.oid; }));
    if (this.compare) menu.addItem(item => item.setTitle(this.feature.label("与所选提交比较", "Compare with selected")).onClick(() => { void this.feature.host(this).changes(this.compare!, commit.oid); }));
    if (event) menu.showAtMouseEvent(event);
    else { const rect = row!.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom }); }
  }
  async showHistory(commits?: GitCommit[], file?: string): Promise<void> {
    this.historyFile = file; this.expanded.add("history");
    if (commits) { this.historyGeneration++; this.commits = commits; this.render(); }
    else await this.loadHistory();
  }
  private async loadHistory(append = false): Promise<void> {
    const generation = ++this.historyGeneration;
    try {
      const commits = await this.feature.repository.history(append ? this.commits.length : 0, this.historyRef, this.historyFile);
      if (generation !== this.historyGeneration || !this.release) return;
      this.commits = append ? [...this.commits, ...commits] : commits; this.render();
    } catch (error) {
      // Only a branch that genuinely no longer resolves resets the selection; transient failures keep it.
      if (this.historyRef && this.historyRef !== "--all" && !this.historyFile) {
        const gone = await this.feature.repository.resolveCommit(this.historyRef).then(() => false, () => true);
        if (gone) {
          this.historyRef = ""; this.app.workspace.requestSaveLayout();
          await this.loadHistory(append); return;
        }
      }
      this.feature.report(error);
    }
  }
}
