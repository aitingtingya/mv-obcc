import {
  MarkdownView, WorkspaceLeaf, WorkspaceSplit, setIcon,
  type App, type TFile, type WorkspaceContainer,
} from "obsidian";
import { t } from "../i18n";
import { previewFiles } from "./storage";

interface FloatingWorkspace {
  rootSplit: WorkspaceContainer;
  floatingSplit?: WorkspaceContainer & { children?: WorkspaceContainer[] };
}

let layer = 60;

/** Owns one native Markdown leaf, its temporary file, and its floating UI. */
export class TerminalPreviewSurface {
  private readonly root: HTMLElement;
  private readonly win: Window & typeof window;
  private readonly host: HTMLElement;
  private readonly status: HTMLElement;
  private readonly pin: HTMLButtonElement;
  private readonly saveNote: HTMLButtonElement;
  private readonly cleanups: Array<() => void> = [];
  private leaf: WorkspaceLeaf | null = null;
  private split: WorkspaceSplit | null = null;
  private file: TFile | null = null;
  private pending = Promise.resolve();
  private closing: Promise<void> | null = null;
  private pinned = false;
  private dragCleanup: (() => void) | null = null;

  constructor(
    private readonly app: App,
    private readonly doc: Document,
    private readonly onClose: () => void,
  ) {
    const win = this.win = doc.win as Window & typeof window;
    const root = this.root = win.createDiv();
    root.className = "popover hover-popover mv-aide-llm-popover mv-aide-terminal-preview";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", t("Markdown 预览"));
    root.tabIndex = -1;
    const width = Math.min(600, win.innerWidth - 24);
    const height = Math.min(560, win.innerHeight - 24);
    Object.assign(root.style, {
      width: `${width}px`, height: `${height}px`,
      left: `${Math.max(0, (win.innerWidth - width) / 2)}px`,
      top: `${Math.max(0, (win.innerHeight - height) / 2)}px`,
    });
    const titlebar = win.createDiv();
    titlebar.className = "mv-aide-llm-titlebar";
    this.pin = this.button(t("固定悬浮窗"), () => {
      this.pinned = !this.pinned;
      this.updatePin();
    });
    this.pin.className = "mv-aide-llm-title-action mv-aide-llm-pin";
    this.updatePin();
    const title = win.createDiv();
    title.className = "mv-aide-llm-title";
    title.textContent = t("Markdown 预览");
    const close = this.button(t("关闭"), () => this.run(() => this.close()));
    close.className = "mv-aide-llm-title-action";
    setIcon(close, "x");
    titlebar.append(this.pin, title, close);
    this.host = win.createDiv();
    this.host.className = "mv-aide-llm-host";
    this.status = win.createDiv();
    this.status.className = "mv-aide-terminal-preview-status";
    this.status.setAttribute("role", "status");
    const toolbar = win.createDiv();
    toolbar.className = "mv-aide-llm-toolbar";
    const copy = this.button(t("复制原文"), () => this.run(async () => {
      await win.navigator.clipboard.writeText(this.currentText());
    }));
    this.saveNote = this.button(t("新建笔记"), () => this.run(() => this.createNote()));
    this.saveNote.classList.add("mod-cta");
    toolbar.append(copy, this.saveNote);
    root.append(titlebar, this.host, this.status, toolbar);
    root.addEventListener("pointerdown", () => this.activate(), { capture: true });
    this.installDrag(titlebar);
    const outside = (event: PointerEvent) => {
      if (event.button === 0 && !this.pinned && !root.contains(event.target as Node)) {
        this.run(() => this.close());
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || this.pinned || !root.contains(doc.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      this.run(() => this.close());
    };
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", escape, true);
    const observer = new win.ResizeObserver(() => this.leaf?.onResize());
    observer.observe(root);
    this.cleanups.push(
      () => doc.removeEventListener("pointerdown", outside, true),
      () => doc.removeEventListener("keydown", escape, true),
      () => observer.disconnect(),
    );
    doc.body.appendChild(root);
    this.activate();
    root.focus({ preventScroll: true });
  }

  private button(label: string, click: () => void): HTMLButtonElement {
    const button = this.win.createEl("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", click);
    return button;
  }

  private run(action: () => Promise<void>): void {
    void action().catch((error: unknown) => this.reportError(error));
  }

  private reportError(error: unknown): void {
    console.error("[mv-aide] Terminal Markdown preview failed", error);
    this.status.textContent = t("Markdown 预览操作失败：{error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  show(text: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.closing) return;
      this.status.textContent = "";
      if (!this.leaf) await this.initialize(text);
      else {
        const view = this.markdownView();
        view.setViewData(text, true);
        await view.save();
        await this.leaf.setViewState({
          type: "markdown", state: { file: this.file!.path, mode: "source", source: false },
        });
      }
      if (!this.closing) {
        this.activate();
        this.markdownView().editor.focus();
      }
    });
  }

  private async initialize(text: string): Promise<void> {
    this.file = await previewFiles(this.app).create(text);
    if (this.closing) return;
    const workspace = this.app.workspace as unknown as FloatingWorkspace;
    const container = workspace.rootSplit.doc === this.doc ? workspace.rootSplit
      : workspace.floatingSplit?.children?.find(item => item.doc === this.doc);
    if (!container) throw new Error(t("找不到预览所属的 Obsidian 窗口"));
    const Split = WorkspaceSplit as unknown as new (
      workspace: App["workspace"], direction: "vertical",
    ) => WorkspaceSplit;
    const split = this.split = new Split(this.app.workspace, "vertical");
    split.getRoot = () => container;
    split.getContainer = () => container;
    this.host.appendChild(split.containerEl);
    // Native leaf construction avoids changing the workspace's active leaf.
    const Leaf = WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf;
    const leaf = this.leaf = new Leaf(this.app);
    leaf.getContainer = () => container;
    (split as WorkspaceSplit & { insertChild(index: number, child: WorkspaceLeaf): void }).insertChild(0, leaf);
    await leaf.openFile(this.file, {
      active: false, state: { mode: "source", source: false },
    });
    if (leaf.isDeferred) await leaf.loadIfDeferred();
    this.markdownView();
    leaf.onResize();
  }

  private markdownView(): MarkdownView {
    const view = this.leaf?.view;
    if (!(view instanceof MarkdownView)) throw new Error(t("临时文件未以 Markdown 视图打开"));
    return view;
  }

  get isClosing(): boolean { return this.closing !== null; }

  get ownerDocument(): Document { return this.doc; }

  private currentText(): string {
    return this.markdownView().getViewData();
  }

  private createNote(): Promise<void> {
    this.status.textContent = "";
    this.saveNote.disabled = true;
    const task = this.enqueue(async () => {
      const file = await previewFiles(this.app).createNote(this.currentText());
      await this.app.workspace.getLeaf("tab").openFile(file);
    });
    return task.then(async () => {
      if (!this.pinned) await this.close();
    }).finally(() => { this.saveNote.disabled = false; });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.dragCleanup?.();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.root.remove();
    this.closing = this.enqueue(async () => {
      if (this.leaf) {
        await this.leaf.setViewState({ type: "empty" });
        this.leaf.detach();
        this.leaf = null;
      }
      this.split?.containerEl.remove();
      this.split = null;
      if (this.file) {
        await previewFiles(this.app).remove(this.file);
        this.file = null;
      }
    }).finally(this.onClose);
    return this.closing;
  }

  private updatePin(): void {
    setIcon(this.pin, this.pinned ? "pin" : "pin-off");
    this.pin.classList.toggle("is-pinned", this.pinned);
    const label = this.pinned ? t("取消固定悬浮窗") : t("固定悬浮窗");
    this.pin.title = label;
    this.pin.setAttribute("aria-label", label);
    this.pin.setAttribute("aria-pressed", String(this.pinned));
  }

  private activate(): void { this.root.style.zIndex = String(++layer); }

  private installDrag(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      const rect = this.root.getBoundingClientRect();
      const startX = event.clientX, startY = event.clientY;
      const move = (event: PointerEvent) => {
        const win = this.doc.defaultView!;
        this.root.style.left = `${Math.min(win.innerWidth - 40, Math.max(40 - rect.width, rect.left + event.clientX - startX))}px`;
        this.root.style.top = `${Math.min(win.innerHeight - 32, Math.max(0, rect.top + event.clientY - startY))}px`;
      };
      const finish = () => {
        this.doc.removeEventListener("pointermove", move);
        this.doc.removeEventListener("pointerup", finish);
        this.doc.removeEventListener("pointercancel", finish);
        this.dragCleanup = null;
      };
      this.dragCleanup?.();
      this.dragCleanup = finish;
      this.doc.addEventListener("pointermove", move);
      this.doc.addEventListener("pointerup", finish);
      this.doc.addEventListener("pointercancel", finish);
      event.preventDefault();
    });
  }
}
