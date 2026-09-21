import fs from "node:fs/promises";
import path from "node:path";
import { Menu, Notice, setIcon, TFile, TextFileView, type WorkspaceLeaf } from "obsidian";
import type MvAideIdePlugin from "../../main";
import { getVaultRoot } from "../selection";
import { GitRepository } from "./repository";
import { GIT_ACTIONS, GitActions, type GitActionContext, type GitActionHost, type GitActionResult } from "./actions";
import { GitDialogs } from "./dialogs";
import { GitWorkspaceView, GIT_VIEW_TYPE } from "./view";
import { GitDiffView, GIT_DIFF_VIEW_TYPE } from "./diff-view";
import { GitConflictView, GIT_CONFLICT_VIEW_TYPE } from "./conflict-view";
import { gitEditorExtensions } from "./editor";
import type { GitDiffSpec, GitTarget } from "./model";

export type GitOrigin = { containerEl: HTMLElement; leaf: WorkspaceLeaf };
export class GitFeature {
  readonly repository: GitRepository;
  readonly actions: GitActions;
  private observers = new Set<() => void>();
  private dialogInstances = new Map<Window, GitDialogs>();
  private timer: number | null = null;
  private debounce: number | null = null;
  private closed = false;
  private ready = false;
  private parentConsent = false;
  private statusBarItem: HTMLElement | null = null;
  constructor(readonly plugin: MvAideIdePlugin) {
    this.repository = new GitRepository(getVaultRoot(plugin.app), () => this.settings);
    this.actions = new GitActions(this.repository);
    plugin.registerView(GIT_VIEW_TYPE, leaf => new GitWorkspaceView(leaf, this));
    plugin.registerView(GIT_DIFF_VIEW_TYPE, leaf => new GitDiffView(leaf, this));
    plugin.registerView(GIT_CONFLICT_VIEW_TYPE, leaf => new GitConflictView(leaf, this));
    plugin.registerEditorExtension(gitEditorExtensions(this));
    plugin.register(this.repository.subscribe(() => { this.updateStatusBar(); for (const listener of this.observers) listener(); }));
    plugin.app.workspace.onLayoutReady(() => { if (!this.closed) { this.ready = true; this.syncPresentation(); if (this.observers.size) this.refresh(); } });
    plugin.registerEvent(plugin.app.vault.on("modify", () => this.invalidate()));
    plugin.registerEvent(plugin.app.vault.on("create", () => this.invalidate()));
    plugin.registerEvent(plugin.app.vault.on("delete", () => this.invalidate()));
    plugin.registerEvent(plugin.app.vault.on("rename", () => this.invalidate()));
    plugin.registerEvent(plugin.app.workspace.on("layout-change", () => this.invalidate()));
    plugin.registerEvent(plugin.app.workspace.on("file-menu", (menu, file) => {
      if (!this.settings.enabled || !(file instanceof TFile) || !this.repository.snapshot) return;
      const relative = path.relative(this.repository.snapshot.root, path.join(this.repository.vaultRoot, file.path));
      const origin = this.origin();
      menu.addItem(item => item.setTitle("Git…").setIcon("git-branch").onClick(() => { void this.chooseAction({ kind: "file", paths: [relative] }, origin); }));
    }));
    this.registerCommands();
  }
  get settings() { return this.plugin.settings.git; }
  get english(): boolean { return this.plugin.settings.language === "en"; }
  label(zh: string, en: string): string { return this.english ? en : zh; }
  actionLabel(id: string): string { const action = GIT_ACTIONS.find(a => a.id === id); return action ? this.english ? action.en : action.zh : id; }
  origin(): GitOrigin | undefined { const leaf = this.plugin.app.workspace.getMostRecentLeaf(); return leaf ? { leaf, containerEl: leaf.view.containerEl } : undefined; }
  dialogs(origin?: GitOrigin): GitDialogs {
    const win = origin?.containerEl.ownerDocument.defaultView ?? this.plugin.app.workspace.containerEl.ownerDocument.defaultView!;
    let dialogs = this.dialogInstances.get(win);
    if (!dialogs) { dialogs = new GitDialogs(this.plugin.app, win, this.english); this.dialogInstances.set(win, dialogs); }
    return dialogs;
  }
  registerCommands(): void {
    for (const action of GIT_ACTIONS) {
      this.plugin.removeCommand(`git-${action.id}`);
      this.plugin.addCommand({ id: `git-${action.id}`, name: `Git: ${this.actionLabel(action.id)}`, callback: () => {
        const origin = this.origin(); let target: GitTarget | undefined;
        const view = origin?.leaf.view;
        if (action.group === "file" && view instanceof TextFileView && view.file && this.repository.snapshot) {
          target = { kind: "file", paths: [path.relative(this.repository.snapshot.root, path.join(this.repository.vaultRoot, view.file.path))] };
        }
        void this.run(action.id, { target }, origin, true);
      } });
    }
  }
  run(id: string, context: GitActionContext = {}, origin?: GitOrigin, palette = false): Promise<GitActionResult | void> {
    if (!this.settings.enabled || this.closed) { this.report(new Error(this.label("Git 已关闭", "Git is disabled"))); return Promise.resolve(); }
    return this.execute(id, context, origin, palette).catch(error => this.report(error));
  }
  private async execute(id: string, context: GitActionContext, origin?: GitOrigin, palette = false): Promise<GitActionResult | void> {
    if (!this.ready) throw new Error(this.label("请等待工作区加载完成", "Wait until the workspace is ready"));
    await this.repository.refresh();
    const root = this.repository.snapshot?.root;
    if (root && !this.parentConsent && root !== await fs.realpath(this.repository.vaultRoot)) {
      if (!await this.dialogs(origin).confirm(this.label("此 Vault 属于上层 Git 仓库", "This vault belongs to a parent repository"), `${root}\n${this.label("Git 操作作用于整个仓库，而不只是 Vault 子目录。", "Git operations apply to the entire repository, not just this vault subfolder.")}`, palette)) return;
      this.parentConsent = true;
    }
    const result = await this.actions.execute(id, this.host(origin, palette), context);
    if (result?.mutated && !this.closed && this.settings.notices) {
      const label = this.actionLabel(id);
      new Notice(this.label(`Git：${label}成功`, `Git: ${label} succeeded`) + (result.detail ? ` · ${result.detail}` : ""), 4000);
    }
    return result;
  }
  report(error: unknown): void { if (!this.closed) new Notice(`Git: ${error instanceof Error ? error.message : String(error)}`, 8000); }
  /** Settings changed: re-sync presentation surfaces; the repository re-reads settings lazily per call. */
  syncPresentation(): void {
    const want = this.ready && !this.closed && this.settings.enabled && this.settings.statusBar;
    if (want && !this.statusBarItem) {
      const item = this.plugin.addStatusBarItem();
      item.addClass("mv-git-statusbar");
      item.setAttribute("aria-label", this.label("打开 Git 工作区", "Open Git workspace"));
      item.addEventListener("click", () => void this.run("open"));
      this.statusBarItem = item;
      this.updateStatusBar();
    } else if (!want && this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }
    this.refresh();
  }
  private updateStatusBar(): void {
    const item = this.statusBarItem;
    if (!item) return;
    const snapshot = this.repository.snapshot;
    item.empty();
    setIcon(item.createSpan(), "git-branch");
    item.createSpan({ text: snapshot
      ? ` ${snapshot.branch || "HEAD"} ↑${snapshot.ahead} ↓${snapshot.behind}${snapshot.operation ? ` · ${snapshot.operation}` : ""}${this.repository.busy ? " …" : ""}`
      : ` ${this.label("未初始化", "no repo")}` });
    item.toggleClass("is-busy", this.repository.busy > 0);
  }
  refresh(): void {
    if (!this.ready || this.closed || !this.settings.enabled || this.repository.busy) return;
    void this.repository.refresh().catch(() => { /* error is displayed by the subscribed view */ });
  }
  private invalidate(): void {
    if (this.debounce || !this.observers.size || !this.settings.autoRefresh) return;
    this.debounce = window.setTimeout(() => { this.debounce = null; this.refresh(); }, 500);
  }
  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    if (!this.timer) this.timer = window.setInterval(() => {
      const visible = this.plugin.app.workspace.getLeavesOfType(GIT_VIEW_TYPE).some(leaf => leaf.view.containerEl.getClientRects().length && !leaf.view.containerEl.ownerDocument.hidden);
      if (visible && this.settings.autoRefresh) this.refresh();
    }, 3000);
    return () => { this.observers.delete(listener); if (!this.observers.size && this.timer) { window.clearInterval(this.timer); this.timer = null; } };
  }
  private async leaf(type: string, origin?: GitOrigin): Promise<WorkspaceLeaf> {
    const workspace = this.plugin.app.workspace, doc = origin?.containerEl.ownerDocument ?? workspace.containerEl.ownerDocument;
    const existing = workspace.getLeavesOfType(type).find(leaf => leaf.view.containerEl.ownerDocument === doc);
    if (existing && type === GIT_VIEW_TYPE) return existing;
    if (type !== GIT_VIEW_TYPE) {
      // Diff/conflict views follow the configured placement instead of always splitting off the workspace.
      const placement = this.settings.diffPlacement;
      if (placement === "split" && origin) return workspace.createLeafBySplit(origin.leaf, "vertical");
      if (placement === "right") return workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      if (placement === "left") return workspace.getLeftLeaf(false) ?? workspace.getLeaf("tab");
      return workspace.getLeaf("tab");
    }
    if (origin) {
      if (doc === workspace.containerEl.ownerDocument && ["left", "right"].includes(this.settings.position)) {
        return (this.settings.position === "left" ? workspace.getLeftLeaf(false) : workspace.getRightLeaf(false)) ?? workspace.createLeafBySplit(origin.leaf, "vertical");
      }
      return workspace.createLeafBySplit(origin.leaf, "vertical");
    }
    return this.settings.position === "left" ? workspace.getLeftLeaf(false) ?? workspace.getLeaf(true)
      : this.settings.position === "right" ? workspace.getRightLeaf(false) ?? workspace.getLeaf(true) : workspace.getLeaf(true);
  }
  async open(origin?: GitOrigin): Promise<GitWorkspaceView> {
    const leaf = await this.leaf(GIT_VIEW_TYPE, origin);
    if (leaf.view.getViewType() !== GIT_VIEW_TYPE) await leaf.setViewState({ type: GIT_VIEW_TYPE, active: true });
    if (!origin || origin.containerEl.ownerDocument.hasFocus()) await this.plugin.app.workspace.revealLeaf(leaf);
    return leaf.view as GitWorkspaceView;
  }
  async openDiff(spec: GitDiffSpec, origin?: GitOrigin): Promise<void> {
    const leaf = await this.leaf(GIT_DIFF_VIEW_TYPE, origin);
    await leaf.setViewState({ type: GIT_DIFF_VIEW_TYPE, state: { spec }, active: false });
    if (!origin || origin.containerEl.ownerDocument.hasFocus()) await this.plugin.app.workspace.revealLeaf(leaf);
  }
  openConflict(file: string, origin?: GitOrigin): void { void this.conflict(file, origin).catch(error => this.report(error)); }
  private async conflict(file: string, origin?: GitOrigin): Promise<void> {
    const leaf = await this.leaf(GIT_CONFLICT_VIEW_TYPE, origin);
    await leaf.setViewState({ type: GIT_CONFLICT_VIEW_TYPE, state: { path: file }, active: false });
    if (!origin || origin.containerEl.ownerDocument.hasFocus()) await this.plugin.app.workspace.revealLeaf(leaf);
  }
  async writeFile(file: string, expected: Uint8Array, text: string): Promise<void> {
    const repo = this.repository;
    await repo.mutate("Save file", async () => {
      const current = await repo.worktreeBytes(file);
      if (!current.equals(Buffer.from(expected))) throw new Error(this.label("文件已变化，未覆盖。请刷新并保留你的编辑。", "File changed; edits were not overwritten. Refresh and keep your draft."));
      const absolute = repo.absolute(file);
      const stat = await fs.lstat(absolute).catch(() => null);
      if (stat && !stat.isFile()) throw new Error("Only regular text files can be edited");
      const relative = path.relative(repo.vaultRoot, absolute);
      const entry = this.plugin.app.vault.getAbstractFileByPath(relative.split(path.sep).join("/"));
      if (entry instanceof TFile) await this.plugin.app.vault.modify(entry, text);
      else await fs.writeFile(absolute, text, { mode: stat?.mode ?? 0o600 });
    });
  }
  async flush(paths?: string[]): Promise<void> {
    const views: TextFileView[] = [];
    this.plugin.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof TextFileView && leaf.view.file) {
        const relative = path.relative(this.repository.snapshot!.root, path.join(this.repository.vaultRoot, leaf.view.file.path));
        if (!paths || paths.includes(relative)) views.push(leaf.view);
      }
    });
    const versions = new Map<string, string>();
    for (const view of views) {
      const key = view.file!.path, value = view.getViewData(), previous = versions.get(key);
      if (previous !== undefined && previous !== value) throw new Error(`Conflicting open editors: ${key}`);
      versions.set(key, value);
    }
    for (const view of views) {
      const key = view.file!.path;
      if (view.getViewData() !== versions.get(key)) throw new Error(`Editor changed: ${key}`);
      await view.save();
      if (view.getViewData() !== versions.get(key)) throw new Error(`Editor changed while saving: ${key}`);
    }
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(GIT_DIFF_VIEW_TYPE)) if (leaf.view instanceof GitDiffView) await leaf.view.save();
  }
  host(origin?: GitOrigin, palette = false): GitActionHost {
    const d = this.dialogs(origin), repo = this.repository;
    return {
      english: this.english, prompt: (title, initial, multiline) => d.prompt(title, initial, multiline, palette), choose: (title, items) => d.choose(title, items), confirm: (title, detail) => d.confirm(title, detail, palette),
      flush: paths => this.flush(paths), open: async () => { await this.open(origin); },
      file: async file => {
        const absolute = repo.absolute(file), relative = path.relative(repo.vaultRoot, absolute).split(path.sep).join("/");
        const entry = this.plugin.app.vault.getAbstractFileByPath(relative);
        if (entry instanceof TFile) { const leaf = origin ? this.plugin.app.workspace.createLeafBySplit(origin.leaf, "vertical") : this.plugin.app.workspace.getLeaf(true); await leaf.openFile(entry); }
        else { const expected = await repo.worktreeBytes(file); const text = await d.prompt(file, expected.toString(), true); if (text !== null) await this.writeFile(file, expected, text); }
      },
      reveal: async file => { const electron = window.require?.("electron") as { shell?: { showItemInFolder(path: string): void } } | undefined; if (!electron?.shell) throw new Error("System file manager unavailable"); electron.shell.showItemInFolder(repo.absolute(file)); },
      copy: async text => {
        const electron = window.require?.("electron") as { clipboard?: { writeText(text: string): void } } | undefined;
        if (electron?.clipboard) electron.clipboard.writeText(text); else await d.host.navigator.clipboard.writeText(text);
      },
      editIgnore: async add => {
        const before = await repo.worktreeBytes(".gitignore");
        const rules = add?.map(file => { if (/[\r\n]/.test(file)) throw new Error("This filename cannot be represented by one ignore rule"); return `/${file.replace(/[\\*?[\]#! ]/g, "\\$&")}`; }).join("\n");
        const text = await d.prompt(".gitignore", `${before.toString()}${rules ? `\n${rules}\n` : ""}`, true);
        if (text !== null) await this.writeFile(".gitignore", before, text);
      },
      trash: async file => {
        const relative = path.relative(repo.vaultRoot, repo.absolute(file)).split(path.sep).join("/");
        if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Cannot trash a file outside the vault");
        if (!await this.plugin.app.vault.adapter.trashSystem(relative)) throw new Error("System trash failed; file was not deleted");
      },
      history: async (commits, file) => { await (await this.open(origin)).showHistory(commits, file); },
      changes: async (from, to) => {
        const files = await repo.changedFiles(from, to);
        const file = await d.choose(this.label("提交变更文件", "Changed files"), files.map(value => ({ value, label: value })));
        if (file) await this.openDiff({ kind: "history", path: file, from, to }, origin);
      },
      diff: spec => this.openDiff(spec, origin), conflict: file => this.conflict(file, origin), show: (title, body) => d.show(title, body),
      reloadApp: async () => {
        const commands = Reflect.get(this.plugin.app, "commands") as { executeCommandById?: (id: string) => boolean } | undefined;
        if (commands?.executeCommandById?.("app:reload") === true) return;
        const win = this.plugin.app.workspace.containerEl?.ownerDocument?.defaultView;
        if (!win) throw new Error(this.label("无法重载 Obsidian", "Cannot reload Obsidian"));
        win.location.reload();
      },
    };
  }
  makeMenu(target: GitTarget | undefined, origin: GitOrigin | undefined, menu: Menu = new Menu()): Menu {
    const allowed = target?.kind === "file" ? ["file"] : target?.kind === "commit" ? ["commit"] : target?.kind === "branch" || target?.kind === "tag" ? [target.kind, "commit"] : target ? [target.kind] : null;
    for (const action of GIT_ACTIONS) {
      if (allowed && !allowed.includes(action.group)) continue;
      if ((action.id === "cherry-pick-batch" || action.id === "revert-batch") && (target?.kind !== "commit" || (target.oids?.length ?? 0) < 2)) continue;
      menu.addItem(item => item.setTitle(this.actionLabel(action.id)).onClick(() => void this.run(action.id, { target }, origin)));
    }
    return menu;
  }
  menu(event: MouseEvent, target?: GitTarget, origin?: GitOrigin): void { this.makeMenu(target, origin).showAtMouseEvent(event); }
  private async chooseAction(target?: GitTarget, origin?: GitOrigin): Promise<void> {
    const id = await this.dialogs(origin).choose("Git", GIT_ACTIONS.filter(a => !target || a.group === target.kind).map(a => ({ value: a.id, label: this.actionLabel(a.id) })));
    if (id) void this.run(id, { target }, origin);
  }
  dispose(): void {
    this.closed = true; this.repository.dispose(); if (this.timer) window.clearInterval(this.timer); if (this.debounce) window.clearTimeout(this.debounce);
    this.statusBarItem?.remove(); this.statusBarItem = null;
    for (const dialogs of this.dialogInstances.values()) dialogs.dispose(); this.dialogInstances.clear(); this.observers.clear();
  }
}
