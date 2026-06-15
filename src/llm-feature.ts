import {
  App,
  Menu,
  MarkdownView,
  Notice,
  type Editor,
  type EditorPosition,
  type View,
  type WorkspaceLeaf,
} from "obsidian";
import type MvObccIdePlugin from "../main";
import { callLlmStream, resolveProvider } from "./llm-client";
import { getCommandHotkeys } from "./llm-hotkey-reader";
import { LlmResultSurface } from "./llm-result-surface";
import { registerTempIgnoreFilter } from "./llm-temp-file";
import {
  llmWebHotkeyCleanupScript,
  llmWebHotkeyInstallScript,
  llmWebHotkeyPollScript,
  type LlmWebHotkeyPending,
} from "./llm-web-menu-script";
import {
  llmWebMenuCleanupScript,
  llmWebMenuInstallScript,
  llmWebMenuPollScript,
  type LlmWebPendingInvoke,
} from "./llm-web-menu-script";
import { activeWorkspaceLeaf, currentWorkspaceContext } from "./workspace-context";
import type { LlmPromptTemplate } from "./types";

/** Minimum shape we need from an Obsidian Web Viewer view. */
interface WebViewerLike extends View {
  webview?: {
    executeJavaScript(script: string): Promise<unknown>;
    addEventListener?(type: string, listener: (event: unknown) => void): void;
    removeEventListener?(type: string, listener: (event: unknown) => void): void;
    readonly isConnected?: boolean;
    getWebContentsId?(): number;
    isLoading?(): boolean;
  };
}

type WebviewElement = NonNullable<WebViewerLike["webview"]>;

interface WebviewLifecycleListeners {
  domReady: (event: unknown) => void;
  didStartLoading: (event: unknown) => void;
}

interface MarkdownEditTarget {
  editor: Editor;
  document: Document;
  cursor: EditorPosition;
  from: EditorPosition;
  to: EditorPosition;
  hadSelection: boolean;
}

/** Throttle for re-injecting the web context-menu script. */
const WEB_INSTALL_INTERVAL_MS = 1000;
/** Polling interval for picking up web menu clicks. */
const WEB_POLL_INTERVAL_MS = 300;
/** Throttle for re-injecting the web hotkey-sync script. */
const HOTKEY_INSTALL_INTERVAL_MS = 2000;
/** Polling interval for picking up web hotkey presses. */
const HOTKEY_POLL_INTERVAL_MS = 300;
const WEBVIEW_EXECUTION_FAILED = Symbol("webview-execution-failed");

function canExecuteWebviewScript(webview: WebviewElement): boolean {
  if (webview.isConnected === false) return false;
  try {
    const id = webview.getWebContentsId?.();
    if (typeof id === "number" && id <= 0) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Electron's executeJavaScript can throw synchronously before returning a
 * promise when a webview is detached or has not reached dom-ready.
 */
function executeWebviewScript(
  webview: WebviewElement,
  script: string,
): Promise<unknown | typeof WEBVIEW_EXECUTION_FAILED> {
  if (!canExecuteWebviewScript(webview)) {
    return Promise.resolve(WEBVIEW_EXECUTION_FAILED);
  }
  try {
    return Promise.resolve(webview.executeJavaScript(script)).catch(
      () => WEBVIEW_EXECUTION_FAILED,
    );
  } catch {
    return Promise.resolve(WEBVIEW_EXECUTION_FAILED);
  }
}

/**
 * Independent "selection → LLM" feature.
 *
 * It reuses the read-only `currentWorkspaceContext()` helper to read the current
 * selection (works across Markdown / PDF / webviewer / generic views) but does
 * NOT touch the bridge server, JSON-RPC, MCP, broadcast, or any other feature.
 *
 * Right-click integration differs by view type:
 *  - Markdown: Obsidian's `editor-menu` event.
 *  - PDF: a DOM `contextmenu` listener on `containerEl` (events bubble from the
 *    same-document PDF.js viewer), gated by a cached selection captured on
 *    `selectionchange` (PDF.js finalises its DOM selection only on mouseup, so a
 *    synchronous read at contextmenu time would be empty).
 *  - webviewer: the Electron `<webview>` is isolated, so we inject a script into
 *    the page that draws its own floating menu and stashes the click; we poll
 *    that stash. Gated by `settings.webContextMenu`.
 */
export class LlmFeature {
  private readonly boundContainers = new WeakSet<HTMLElement>();
  private readonly watchedDocuments = new WeakSet<Document>();
  private readonly lastSelectionByDoc = new WeakMap<Document, string>();
  private readonly webInstallLeaves = new Set<WorkspaceLeaf>();
  private readonly lastWebInstall = new WeakMap<WorkspaceLeaf, number>();
  private readonly webLifecycleLeaves = new Set<WorkspaceLeaf>();
  private readonly webReadyLeaves = new WeakSet<WorkspaceLeaf>();
  private readonly webLifecycleListeners = new WeakMap<
    WorkspaceLeaf,
    WebviewLifecycleListeners
  >();
  private webPollTimer: number | null = null;

  // ---- Independent hotkey-sync chain (parallel to the context-menu chain).
  // Does not share state with the web-menu fields above.
  private readonly hotkeyInstallLeaves = new Set<WorkspaceLeaf>();
  private readonly lastHotkeyInstall = new WeakMap<WorkspaceLeaf, number>();
  /** Prevent concurrent executeJavaScript polls for the same webview. */
  private readonly hotkeyPollInFlight = new WeakSet<WorkspaceLeaf>();
  private hotkeyPollTimer: number | null = null;
  private currentSurface: LlmResultSurface | null = null;
  private currentAbortController: AbortController | null = null;
  private invocationGeneration = 0;

  constructor(private readonly plugin: MvObccIdePlugin) {}

  private get settings() {
    return this.plugin.settings.llm;
  }

  private get app(): App {
    return this.plugin.app;
  }

  /**
   * Register one command per prompt template. Uses `callback` (not
   * `editorCallback`) so the command also fires inside PDF and webviewer leaves.
   */
  registerCommands(): void {
    for (const template of this.settings.templates) {
      if (!template.enabled) continue; // disabled templates expose no command
      this.plugin.addCommand({
        id: `llm-${template.id}`,
        name: `LLM: ${template.label}`,
        callback: () => this.runTemplate(template),
      });
    }
  }

  /**
   * Register context-menu entries.
   *
   * Markdown gets Obsidian's `editor-menu` event. PDF needs a DOM-level
   * `contextmenu` listener (PDF.js doesn't fire editor-menu) plus a cached
   * selection. Webviewer optionally injects a script into the page.
   */
  registerMenus(): void {
    this.plugin.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        if (!this.settings.enabled) return;
        if (!this.hasSelectionNow()) return;
        this.appendTemplates(menu);
      }),
    );

    // Re-scan for new PDF/webviewer leaves on layout changes.
    this.plugin.registerEvent(
      this.app.workspace.on("layout-change", () => this.sync()),
    );
    this.plugin.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.sync()),
    );
    this.sync();
  }

  /** Called periodically from main.ts's 500ms interval to catch late leaves. */
  tick(): void {
    this.sync();
    this.pollWebMenus();
  }

  /** Re-scan all leaves: attach PDF menus, install/cleanup web menus. */
  private sync(): void {
    // When the feature is disabled, tear down any hotkey sync we may have
    // installed (the web-menu chain is handled by its own toggle below).
    if (!this.settings.enabled) {
      this.cleanupAllWebMenus();
      this.cleanupAllWebHotkeys();
      this.cleanupAllWebviewLifecycles();
      this.stopPolling();
      return;
    }

    const seenWebLeaves = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const viewType = leaf.view.getViewType();
      if (viewType === "pdf") {
        this.installPdfMenu(leaf);
      } else if (viewType === "webviewer") {
        seenWebLeaves.add(leaf);
        this.attachWebviewLifecycle(leaf);
        if (this.isWebviewReady(leaf)) {
          this.installWebMenu(leaf);
          this.installWebHotkeys(leaf);
        }
      }
    });

    // Cleanup scripts and lifecycle listeners for leaves that disappeared.
    for (const leaf of Array.from(this.webLifecycleLeaves)) {
      if (!seenWebLeaves.has(leaf)) {
        void this.uninstallWebMenu(leaf);
        void this.uninstallWebHotkeys(leaf);
        this.detachWebviewLifecycle(leaf);
      }
    }

    for (const leaf of Array.from(this.hotkeyInstallLeaves)) {
      if (!seenWebLeaves.has(leaf)) {
        void this.uninstallWebHotkeys(leaf);
      }
    }

    // Cleanup web menus for leaves that disappeared or when the toggle is off.
    if (!this.settings.webContextMenu) {
      this.cleanupAllWebMenus();
    } else {
      for (const leaf of this.webInstallLeaves) {
        if (!seenWebLeaves.has(leaf)) {
          void this.uninstallWebMenu(leaf);
        }
      }
    }

    // Start or stop the polling timer based on the toggle.
    if (this.settings.webContextMenu) {
      this.ensurePolling();
    } else {
      this.stopPolling();
    }

    // Hotkey polling runs whenever the feature is enabled.
    this.ensureHotkeyPolling();
  }

  // ---- Markdown ------------------------------------------------------------

  private appendTemplates(menu: Menu): void {
    const templates = this.settings.templates.filter((t) => t.enabled);
    if (templates.length === 0) return;
    menu.addItem((item) => {
      item.setTitle("LLM").setDisabled(true);
    });
    for (const template of templates) {
      menu.addItem((item) => {
        item.setTitle(template.label).onClick(() => {
          void this.runTemplate(template);
        });
      });
    }
  }

  private hasSelectionNow(): boolean {
    const sel =
      this.app.workspace.activeLeaf?.view?.containerEl?.ownerDocument?.getSelection();
    return !!sel && sel.toString().trim().length > 0;
  }

  // ---- PDF -----------------------------------------------------------------

  private installPdfMenu(leaf: WorkspaceLeaf): void {
    const el = leaf.view.containerEl;
    const doc = el.ownerDocument;

    // Cache the latest non-empty selection so the contextmenu handler (which
    // fires before PDF.js commits the DOM selection) has something to consult.
    if (!this.watchedDocuments.has(doc)) {
      this.watchedDocuments.add(doc);
      const listener = () => {
        const text = doc.getSelection()?.toString() ?? "";
        if (text.trim()) this.lastSelectionByDoc.set(doc, text);
      };
      doc.addEventListener("selectionchange", listener);
      // Best-effort cleanup is handled implicitly by plugin unload; PDF leaves
      // are long-lived, mirroring selection-highlights.ts's pattern.
    }

    if (this.boundContainers.has(el)) return;
    this.boundContainers.add(el);
    this.plugin.registerDomEvent(el, "contextmenu", (evt: MouseEvent) => {
      // Prefer the synchronously-cached selection; PDF.js sets it on mouseup.
      const cached = this.lastSelectionByDoc.get(doc);
      const live = doc.getSelection()?.toString() ?? "";
      if (!cached && !live.trim()) return;
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new Menu();
      this.appendTemplates(menu);
      menu.showAtMouseEvent(evt);
    });
  }

  // ---- Webviewer -----------------------------------------------------------

  private attachWebviewLifecycle(leaf: WorkspaceLeaf): void {
    if (this.webLifecycleLeaves.has(leaf)) return;
    const webview = (leaf.view as WebViewerLike).webview;
    if (!webview || typeof webview.addEventListener !== "function") return;

    const domReady = () => {
      this.webReadyLeaves.add(leaf);
      this.lastWebInstall.set(leaf, 0);
      this.lastHotkeyInstall.set(leaf, 0);
      this.installWebMenu(leaf);
      this.installWebHotkeys(leaf);
    };
    const didStartLoading = () => {
      this.webReadyLeaves.delete(leaf);
      this.webInstallLeaves.delete(leaf);
      this.hotkeyInstallLeaves.delete(leaf);
    };
    try {
      webview.addEventListener("dom-ready", domReady);
      webview.addEventListener("did-start-loading", didStartLoading);
      this.webLifecycleLeaves.add(leaf);
      this.webLifecycleListeners.set(leaf, { domReady, didStartLoading });
    } catch {
      // The webview is in the middle of being replaced; the next sync retries.
    }
  }

  private detachWebviewLifecycle(leaf: WorkspaceLeaf): void {
    const webview = (leaf.view as WebViewerLike).webview;
    const listeners = this.webLifecycleListeners.get(leaf);
    if (
      webview &&
      listeners &&
      typeof webview.removeEventListener === "function"
    ) {
      try {
        webview.removeEventListener("dom-ready", listeners.domReady);
        webview.removeEventListener(
          "did-start-loading",
          listeners.didStartLoading,
        );
      } catch {
        // The webview may already be detached.
      }
    }
    this.webLifecycleListeners.delete(leaf);
    this.webLifecycleLeaves.delete(leaf);
    this.webReadyLeaves.delete(leaf);
  }

  private cleanupAllWebviewLifecycles(): void {
    for (const leaf of Array.from(this.webLifecycleLeaves)) {
      this.detachWebviewLifecycle(leaf);
    }
  }

  private isWebviewReady(leaf: WorkspaceLeaf): boolean {
    if (this.webReadyLeaves.has(leaf)) return true;
    const webview = (leaf.view as WebViewerLike).webview;
    if (!webview || !canExecuteWebviewScript(webview)) return false;
    try {
      const id = webview.getWebContentsId?.();
      const loading = webview.isLoading?.();
      if (typeof id === "number" && id > 0 && loading !== true) {
        this.webReadyLeaves.add(leaf);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private installWebMenu(leaf: WorkspaceLeaf): void {
    if (!this.settings.webContextMenu) return;
    if (!this.isWebviewReady(leaf)) return;
    const now = Date.now();
    const last = this.lastWebInstall.get(leaf) ?? 0;
    if (now - last < WEB_INSTALL_INTERVAL_MS) return;
    this.lastWebInstall.set(leaf, now);

    const view = leaf.view as WebViewerLike;
    const webview = view.webview;
    if (!webview) return;
    // Only enabled templates participate in the in-page menu; their indices
    // must line up with the lookup in pollWebMenus().
    const activeTemplates = this.settings.templates.filter((t) => t.enabled);
    const templatesJson = JSON.stringify(
      activeTemplates.map((t) => ({ label: t.label })),
    );
    void executeWebviewScript(
      webview,
      llmWebMenuInstallScript(templatesJson),
    )
      .then((result) => {
        if (
          result === WEBVIEW_EXECUTION_FAILED ||
          !this.isWebviewReady(leaf)
        ) {
          return;
        }
        this.webInstallLeaves.add(leaf);
      });
  }

  private async uninstallWebMenu(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view as WebViewerLike;
    const webview = view.webview;
    this.webInstallLeaves.delete(leaf);
    if (!webview || !this.isWebviewReady(leaf)) return;
    await executeWebviewScript(webview, llmWebMenuCleanupScript());
  }

  private cleanupAllWebMenus(): void {
    for (const leaf of Array.from(this.webInstallLeaves)) {
      void this.uninstallWebMenu(leaf);
    }
  }

  private ensurePolling(): void {
    if (this.webPollTimer !== null) return;
    this.webPollTimer = activeWindow.setInterval(
      () => this.pollWebMenus(),
      WEB_POLL_INTERVAL_MS,
    );
    // registerInterval enables cleanup on plugin unload.
    this.webPollTimer = this.plugin.registerInterval(this.webPollTimer);
  }

  private stopPolling(): void {
    if (this.webPollTimer !== null) {
      activeWindow.clearInterval(this.webPollTimer);
      this.webPollTimer = null;
    }
  }

  private pollWebMenus(): void {
    if (!this.settings.enabled || !this.settings.webContextMenu) return;
    const active = this.app.workspace.activeLeaf;
    if (!active || active.view.getViewType() !== "webviewer") return;
    const view = active.view as WebViewerLike;
    const webview = view.webview;
    if (!webview || !this.isWebviewReady(active)) return;
    void executeWebviewScript(webview, llmWebMenuPollScript())
      .then((result) => {
        if (result === WEBVIEW_EXECUTION_FAILED) return;
        const pending = result as LlmWebPendingInvoke | null;
        if (!pending || !pending.selection || !pending.selection.trim()) return;
        // Page-side indices are relative to enabled templates only.
        const activeTemplates = this.settings.templates.filter((t) => t.enabled);
        const template =
          activeTemplates[pending.index] ??
          this.settings.templates.find((t) => t.label === pending.label);
        if (!template) return;
        void this.invokeWithText(template, pending.selection, "web");
      })
      .catch(() => {
        // ignore transient webview errors
      });
  }

  // ---- Independent hotkey-sync chain (parallel to the context-menu chain).
  // Reads the Obsidian-bound hotkeys for each LLM command and re-injects them
  // into the page so they fire while focus is trapped inside the <webview>.
  // Gated only by `enabled`; independent of the `webContextMenu` toggle.

  private installWebHotkeys(leaf: WorkspaceLeaf): void {
    if (!this.isWebviewReady(leaf)) return;
    const now = Date.now();
    const last = this.lastHotkeyInstall.get(leaf) ?? 0;
    if (now - last < HOTKEY_INSTALL_INTERVAL_MS) return;
    this.lastHotkeyInstall.set(leaf, now);

    const view = leaf.view as WebViewerLike;
    const webview = view.webview;
    if (!webview) return;

    // For each ENABLED template, read ALL its currently-bound hotkeys (a
    // command can have multiple bindings). null means the template has no
    // hotkey and is skipped in-page. Disabled templates are excluded so their
    // indices never reach the page-side matcher. Obsidian stores command ids
    // with the plugin id prefixed.
    const pluginId = this.plugin.manifest?.id;
    const activeTemplates = this.settings.templates.filter((t) => t.enabled);
    const bindings = activeTemplates.map((t) => {
      const all = getCommandHotkeys(this.app, `llm-${t.id}`, pluginId);
      return all.length > 0 ? all : null;
    });
    const hasAny = bindings.some((b) => b !== null);
    if (!hasAny) {
      // Nothing bound yet; clean up any prior install so the page is left alone.
      void this.uninstallWebHotkeys(leaf);
      return;
    }
    const bindingsJson = JSON.stringify(bindings);
    const labelsJson = JSON.stringify(activeTemplates.map((t) => t.label));
    void executeWebviewScript(
      webview,
      llmWebHotkeyInstallScript(
        bindingsJson,
        labelsJson,
        process.platform === "darwin",
      ),
    ).then((result) => {
      if (
        result !== WEBVIEW_EXECUTION_FAILED &&
        this.isWebviewReady(leaf)
      ) {
        this.hotkeyInstallLeaves.add(leaf);
      }
    });
  }

  private async uninstallWebHotkeys(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view as WebViewerLike;
    const webview = view.webview;
    this.hotkeyInstallLeaves.delete(leaf);
    if (!webview || !this.isWebviewReady(leaf)) return;
    await executeWebviewScript(webview, llmWebHotkeyCleanupScript());
  }

  private ensureHotkeyPolling(): void {
    if (this.hotkeyPollTimer !== null) return;
    const id = activeWindow.setInterval(
      () => this.pollWebHotkeys(),
      HOTKEY_POLL_INTERVAL_MS,
    );
    this.hotkeyPollTimer = this.plugin.registerInterval(id);
  }

  private stopHotkeyPolling(): void {
    if (this.hotkeyPollTimer !== null) {
      activeWindow.clearInterval(this.hotkeyPollTimer);
      this.hotkeyPollTimer = null;
    }
  }

  private cleanupAllWebHotkeys(): void {
    this.stopHotkeyPolling();
    for (const leaf of Array.from(this.hotkeyInstallLeaves)) {
      void this.uninstallWebHotkeys(leaf);
    }
  }

  private pollWebHotkeys(): void {
    if (!this.settings.enabled) return;
    const active = this.app.workspace.activeLeaf;
    if (!active || active.view.getViewType() !== "webviewer") return;
    if (this.hotkeyPollInFlight.has(active)) return;
    const view = active.view as WebViewerLike;
    const webview = view.webview;
    if (!webview || !this.isWebviewReady(active)) return;
    this.hotkeyPollInFlight.add(active);
    void executeWebviewScript(webview, llmWebHotkeyPollScript())
      .then((result) => {
        if (result === WEBVIEW_EXECUTION_FAILED) return;
        const pending = result as LlmWebHotkeyPending | null;
        if (!pending || !pending.selection || !pending.selection.trim()) return;
        // Page-side indices are relative to enabled templates only.
        const activeTemplates = this.settings.templates.filter((t) => t.enabled);
        const template =
          activeTemplates[pending.index] ??
          this.settings.templates.find((t) => t.label === pending.label);
        if (!template) return;
        void this.invokeWithText(template, pending.selection, "web");
      })
      .catch(() => {
        // ignore transient webview errors
      })
      .finally(() => {
        this.hotkeyPollInFlight.delete(active);
      });
  }

  /** Tear down all hotkey-sync state (called on plugin unload / feature off). */
  dispose(): void {
    this.cancelCurrentInvocation(true);
    this.cleanupAllWebMenus();
    this.cleanupAllWebHotkeys();
    this.cleanupAllWebviewLifecycles();
    this.stopPolling();
  }

  // ---- LLM invocation ------------------------------------------------------

  private buildUserMessage(
    template: LlmPromptTemplate,
    selectionText: string,
  ): string {
    return template.prompt.includes("{selection}")
      ? template.prompt.replaceAll("{selection}", selectionText)
      : `${template.prompt}\n\n${selectionText}`;
  }

  async runTemplate(
    template: LlmPromptTemplate,
    requestedLeaf?: WorkspaceLeaf | null,
  ): Promise<void> {
    if (!this.settings.enabled) {
      new Notice("LLM 功能未启用，请在设置中开启。");
      return;
    }
    const leaf =
      requestedLeaf === undefined ? activeWorkspaceLeaf(this.app) : requestedLeaf;
    const editTarget = this.captureMarkdownTarget(leaf);
    const state = await currentWorkspaceContext(this.app, leaf);
    if (!state || !state.selection.text.trim()) {
      new Notice("请先选中文本再调用。");
      return;
    }
    await this.invokeWithText(
      template,
      state.selection.text,
      state.resourceType ?? "view",
      editTarget,
    );
  }

  /** Run a template in the single reusable non-modal result surface. */
  private async invokeWithText(
    template: LlmPromptTemplate,
    selectionText: string,
    resourceType: "markdown" | "web" | "pdf" | "file" | "view",
    editTarget: MarkdownEditTarget | null = null,
  ): Promise<void> {
    const userMessage = this.buildUserMessage(template, selectionText);
    const onInsert =
      resourceType === "markdown" && editTarget
        ? (text: string) =>
            this.insertIntoEditor(editTarget, text, template.label)
        : undefined;
    const onReplace =
      resourceType === "markdown" && editTarget
        ? (text: string) =>
            this.replaceInEditor(editTarget, text, template.label)
        : undefined;

    registerTempIgnoreFilter(this.app);
    this.cancelCurrentInvocation(true);
    const generation = ++this.invocationGeneration;
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    let surface: LlmResultSurface;
    surface = new LlmResultSurface(this.app, {
      document:
        editTarget?.document ??
        this.app.workspace.activeLeaf?.view.containerEl.ownerDocument,
      onInsert,
      onReplace,
      onClose: () => {
        if (this.currentSurface !== surface) return;
        this.currentSurface = null;
        this.currentAbortController?.abort();
        this.currentAbortController = null;
        this.invocationGeneration += 1;
      },
    });
    this.currentSurface = surface;
    surface.open();

    try {
      const target = resolveProvider(this.settings, template);
      await callLlmStream(
        target,
        userMessage,
        (delta) => {
          if (
            generation === this.invocationGeneration &&
            !abortController.signal.aborted
          ) {
            surface.appendDelta(delta);
          }
        },
        abortController.signal,
      );
      if (
        generation === this.invocationGeneration &&
        !abortController.signal.aborted
      ) {
        surface.setDone();
      }
    } catch (error) {
      if (
        generation !== this.invocationGeneration ||
        abortController.signal.aborted ||
        this.isAbortError(error)
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      surface.setError(message);
      new Notice(`LLM 调用失败：${message}`, 8000);
    } finally {
      if (
        generation === this.invocationGeneration &&
        this.currentAbortController === abortController
      ) {
        this.currentAbortController = null;
      }
    }
  }

  private captureMarkdownTarget(
    leaf: WorkspaceLeaf | null,
  ): MarkdownEditTarget | null {
    const view = leaf?.view;
    if (!(view instanceof MarkdownView)) return null;
    const editor = view.editor;
    return {
      editor,
      document: view.containerEl.ownerDocument,
      cursor: editor.getCursor(),
      from: editor.getCursor("from"),
      to: editor.getCursor("to"),
      hadSelection: editor.somethingSelected(),
    };
  }

  private insertIntoEditor(
    target: MarkdownEditTarget,
    text: string,
    label: string,
  ): void {
    target.editor.replaceRange(text + "\n", target.cursor);
    new Notice(`已插入：${label}`);
  }

  private replaceInEditor(
    target: MarkdownEditTarget,
    text: string,
    label: string,
  ): void {
    if (target.hadSelection) {
      target.editor.replaceRange(text, target.from, target.to);
      new Notice(`已替换：${label}`);
    } else {
      target.editor.replaceRange(text, target.cursor);
      new Notice(`已插入：${label}`);
    }
  }

  private cancelCurrentInvocation(closeSurface: boolean): void {
    this.invocationGeneration += 1;
    this.currentAbortController?.abort();
    this.currentAbortController = null;
    const surface = this.currentSurface;
    this.currentSurface = null;
    if (closeSurface) surface?.close();
  }

  private isAbortError(error: unknown): boolean {
    return (
      error instanceof DOMException
        ? error.name === "AbortError"
        : error instanceof Error && error.name === "AbortError"
    );
  }
}
