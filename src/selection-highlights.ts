import {
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
} from "@codemirror/view";
import type { App, View, WorkspaceLeaf } from "obsidian";

const HIGHLIGHT_NAME = "mv-obcc-persistent-selection";
const WEB_STATE_KEY = "__mvObccPersistentSelection";
const WEB_SYNC_INTERVAL_MS = 1_000;

interface StoredEditorRange {
  from: number;
  to: number;
}

export interface PersistentEditorSelectionState {
  enabled: boolean;
  range: StoredEditorRange | null;
}

interface WebViewElement extends HTMLElement {
  executeJavaScript(script: string): Promise<unknown>;
}

interface WebViewerView extends View {
  webview?: WebViewElement;
}

interface PdfHighlight {
  document: Document;
  range: Range;
}

interface HighlightWindow extends Window {
  CSS?: {
    highlights?: {
      delete(name: string): boolean;
      set(name: string, highlight: Highlight): unknown;
    };
  };
  Highlight?: new (...ranges: AbstractRange[]) => Highlight;
}

export type EditorSelectionHighlightAction =
  | { kind: "set"; from: number; to: number }
  | { kind: "clear" }
  | { kind: "ignore" };

export interface EditorSelectionHighlightInput {
  enabled: boolean;
  selectionSet: boolean;
  isUserSelection: boolean;
  from: number;
  to: number;
}

export function editorSelectionHighlightAction(
  input: EditorSelectionHighlightInput,
): EditorSelectionHighlightAction {
  if (!input.enabled || !input.selectionSet) return { kind: "ignore" };
  if (input.from !== input.to) {
    return {
      kind: "set",
      from: Math.min(input.from, input.to),
      to: Math.max(input.from, input.to),
    };
  }
  return input.isUserSelection ? { kind: "clear" } : { kind: "ignore" };
}

export type DomSelectionHighlightAction =
  | { kind: "set"; range: Range }
  | { kind: "clear" }
  | { kind: "ignore" };

export function domSelectionHighlightAction(
  selection: Selection | null,
  sourceContainer: HTMLElement,
): DomSelectionHighlightAction {
  if (!selection || selection.rangeCount === 0) return { kind: "ignore" };
  const range = selection.getRangeAt(0);
  if (!selection.isCollapsed && selection.toString()) {
    if (
      sourceContainer.contains(range.startContainer) &&
      sourceContainer.contains(range.endContainer)
    ) {
      return { kind: "set", range: range.cloneRange() };
    }
    return { kind: "ignore" };
  }
  return selection.anchorNode && sourceContainer.contains(selection.anchorNode)
    ? { kind: "clear" }
    : { kind: "ignore" };
}

export const setPersistentEditorSelectionEnabled =
  StateEffect.define<boolean>();

export const persistentEditorSelectionField =
  StateField.define<PersistentEditorSelectionState>({
    create: () => ({ enabled: true, range: null }),
    update(value, transaction) {
      let enabled = value.enabled;
      let range = mapStoredRange(value.range, transaction);
      for (const effect of transaction.effects) {
        if (!effect.is(setPersistentEditorSelectionEnabled)) continue;
        enabled = effect.value;
        range = enabled
          ? storedRangeFromSelection(transaction.newSelection.main)
          : null;
      }
      if (enabled && transaction.selection) {
        const main = transaction.newSelection.main;
        const action = editorSelectionHighlightAction({
          enabled,
          selectionSet: true,
          isUserSelection: isUserSelectionTransaction(transaction),
          from: main.from,
          to: main.to,
        });
        if (action.kind === "set") {
          range = { from: action.from, to: action.to };
        } else if (action.kind === "clear") {
          range = null;
        }
      }
      return { enabled, range };
    },
    compare: (left, right) =>
      left.enabled === right.enabled &&
      left.range?.from === right.range?.from &&
      left.range?.to === right.range?.to,
    provide: (field) =>
      EditorView.outerDecorations.from(field, (value) => {
        const stored = value.range;
        if (!stored) return Decoration.none;
        return Decoration.set([
          Decoration.mark({
            class: "mv-obcc-persistent-selection",
          }).range(stored.from, stored.to),
        ]);
      }),
  });

function storedRangeFromSelection(
  selection: { from: number; to: number },
): StoredEditorRange | null {
  return selection.from < selection.to
    ? { from: selection.from, to: selection.to }
    : null;
}

function mapStoredRange(
  value: StoredEditorRange | null,
  transaction: Transaction,
): StoredEditorRange | null {
  if (!value || !transaction.docChanged) return value;
  const from = transaction.changes.mapPos(value.from, 1);
  const to = transaction.changes.mapPos(value.to, -1);
  return from < to ? { from, to } : null;
}

function isUserSelectionTransaction(transaction: Transaction): boolean {
  return (
    transaction.isUserEvent("select") ||
    transaction.isUserEvent("input")
  );
}

export function webSelectionHighlightInstallScript(color: string): string {
  return `(() => {
    try {
      const key = ${JSON.stringify(WEB_STATE_KEY)};
      const name = ${JSON.stringify(HIGHLIGHT_NAME)};
      const color = ${JSON.stringify(color)};
      const existing = window[key];
      if (existing && existing.version === 1) {
        existing.capture();
        return { success: true, installed: false };
      }
      if (!window.CSS || !CSS.highlights || typeof Highlight !== "function") {
        return { success: false, reason: "CSS Custom Highlight is unavailable" };
      }
      const style = document.createElement("style");
      style.dataset.mvObccPersistentSelection = "true";
      style.textContent = "::highlight(" + name + ") { background-color: " + color + "; }";
      (document.head || document.documentElement).appendChild(style);
      const capture = () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0).cloneRange();
        CSS.highlights.set(name, new Highlight(range));
      };
      const syncAfterInteraction = () => {
        setTimeout(() => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            CSS.highlights.delete(name);
          } else {
            capture();
          }
        }, 0);
      };
      document.addEventListener("selectionchange", capture);
      document.addEventListener("pointerup", syncAfterInteraction, true);
      document.addEventListener("keyup", syncAfterInteraction, true);
      window[key] = {
        version: 1,
        capture,
        cleanup() {
          document.removeEventListener("selectionchange", capture);
          document.removeEventListener("pointerup", syncAfterInteraction, true);
          document.removeEventListener("keyup", syncAfterInteraction, true);
          CSS.highlights.delete(name);
          style.remove();
          delete window[key];
        }
      };
      capture();
      return { success: true, installed: true };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  })()`;
}

export function webSelectionHighlightCleanupScript(): string {
  return `(() => {
    try {
      const state = window[${JSON.stringify(WEB_STATE_KEY)}];
      if (state && typeof state.cleanup === "function") state.cleanup();
      return true;
    } catch {
      return false;
    }
  })()`;
}

function resolvedSelectionColor(document: Document): string {
  const parent = document.body ?? document.documentElement;
  const probe = document.createElement("span");
  probe.style.backgroundColor = "var(--text-selection)";
  probe.style.position = "fixed";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  parent.appendChild(probe);
  const color =
    document.defaultView?.getComputedStyle(probe).backgroundColor ?? "";
  probe.remove();
  return color && color !== "rgba(0, 0, 0, 0)"
    ? color
    : "rgba(126, 87, 194, 0.32)";
}

function liveLeaves(app: App): Set<WorkspaceLeaf> {
  const leaves = new Set<WorkspaceLeaf>();
  app.workspace.iterateAllLeaves((leaf) => leaves.add(leaf));
  return leaves;
}

export class SelectionHighlightController {
  private enabled: boolean;
  private readonly editorViews = new Set<EditorView>();
  private readonly pdfHighlights = new Map<WorkspaceLeaf, PdfHighlight>();
  private readonly watchedDocuments = new Map<Document, () => void>();
  private readonly webLeaves = new Set<WorkspaceLeaf>();
  private readonly lastWebSync = new WeakMap<WorkspaceLeaf, number>();

  constructor(
    private readonly app: App,
    enabled: boolean,
  ) {
    this.enabled = enabled;
  }

  markdownExtension(): Extension {
    const controller = this;
    return [
      persistentEditorSelectionField.init(() => ({
        enabled: controller.enabled,
        range: null,
      })),
      ViewPlugin.define((view) => {
        controller.editorViews.add(view);
        return {
          destroy() {
            controller.editorViews.delete(view);
          },
        };
      }),
    ];
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.setMarkdownEnabled(true);
      this.sync(true);
    } else {
      this.clearAll();
    }
  }

  sync(forceWeb = false): void {
    const leaves = liveLeaves(this.app);
    this.prunePdfHighlights(leaves);
    for (const leaf of this.webLeaves) {
      if (!leaves.has(leaf)) this.webLeaves.delete(leaf);
    }
    if (!this.enabled) {
      this.refreshDocumentWatchers(new Set());
      return;
    }
    this.refreshDocumentWatchers(leaves);

    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf?.view.getViewType() === "webviewer") {
      void this.installWebHighlight(activeLeaf, forceWeb);
    }
  }

  destroy(): void {
    this.enabled = false;
    this.clearAll();
    for (const dispose of this.watchedDocuments.values()) dispose();
    this.watchedDocuments.clear();
  }

  private refreshDocumentWatchers(leaves: Set<WorkspaceLeaf>): void {
    const documents = new Set<Document>();
    for (const leaf of leaves) {
      if (leaf.view.getViewType() !== "pdf") continue;
      documents.add(leaf.view.containerEl.ownerDocument);
    }
    for (const document of documents) {
      if (this.watchedDocuments.has(document)) continue;
      const listener = () => this.capturePdfSelection(document);
      document.addEventListener("selectionchange", listener);
      this.watchedDocuments.set(document, () =>
        document.removeEventListener("selectionchange", listener),
      );
    }
    for (const [document, dispose] of this.watchedDocuments) {
      if (documents.has(document)) continue;
      dispose();
      this.watchedDocuments.delete(document);
      (document.defaultView as HighlightWindow | null)?.CSS?.highlights?.delete(
        HIGHLIGHT_NAME,
      );
    }
  }

  private capturePdfSelection(document: Document): void {
    if (!this.enabled) return;
    const leaf = this.app.workspace.activeLeaf;
    if (
      !leaf ||
      leaf.view.getViewType() !== "pdf" ||
      leaf.view.containerEl.ownerDocument !== document
    ) {
      return;
    }
    const action = domSelectionHighlightAction(
      document.getSelection(),
      leaf.view.containerEl,
    );
    if (action.kind === "ignore") return;
    if (action.kind === "set") {
      this.pdfHighlights.set(leaf, {
        document,
        range: action.range,
      });
    } else {
      this.pdfHighlights.delete(leaf);
    }
    this.refreshPdfHighlights(document);
  }

  private prunePdfHighlights(leaves: Set<WorkspaceLeaf>): void {
    const changedDocuments = new Set<Document>();
    for (const [leaf, highlight] of this.pdfHighlights) {
      if (
        !leaves.has(leaf) ||
        !highlight.range.startContainer.isConnected ||
        !highlight.range.endContainer.isConnected
      ) {
        this.pdfHighlights.delete(leaf);
        changedDocuments.add(highlight.document);
      }
    }
    for (const document of changedDocuments) {
      this.refreshPdfHighlights(document);
    }
  }

  private refreshPdfHighlights(document: Document): void {
    const window = document.defaultView as HighlightWindow | null;
    const HighlightConstructor = window?.Highlight;
    const registry = window?.CSS?.highlights;
    if (!registry || !HighlightConstructor) return;
    const ranges = [...this.pdfHighlights.values()]
      .filter(
        (highlight) =>
          highlight.document === document &&
          highlight.range.startContainer.isConnected &&
          highlight.range.endContainer.isConnected,
      )
      .map((highlight) => highlight.range);
    if (ranges.length === 0) {
      registry.delete(HIGHLIGHT_NAME);
    } else {
      registry.set(HIGHLIGHT_NAME, new HighlightConstructor(...ranges));
    }
  }

  private async installWebHighlight(
    leaf: WorkspaceLeaf,
    force: boolean,
  ): Promise<void> {
    const now = Date.now();
    const lastSync = this.lastWebSync.get(leaf) ?? 0;
    if (!force && now - lastSync < WEB_SYNC_INTERVAL_MS) return;
    this.lastWebSync.set(leaf, now);

    const view = leaf.view as WebViewerView;
    const webview = view.webview;
    if (!webview) return;
    try {
      const color = resolvedSelectionColor(view.containerEl.ownerDocument);
      await webview.executeJavaScript(
        webSelectionHighlightInstallScript(color),
      );
      this.webLeaves.add(leaf);
    } catch {
      // Web highlights are best-effort and must not affect IDE state tracking.
    }
  }

  private clearAll(): void {
    this.setMarkdownEnabled(false);
    this.clearDomHighlights();
  }

  private setMarkdownEnabled(enabled: boolean): void {
    for (const view of this.editorViews) {
      try {
        view.dispatch({
          effects: setPersistentEditorSelectionEnabled.of(enabled),
        });
      } catch {
        // The editor may already be detached.
      }
    }
  }

  private clearDomHighlights(): void {
    const documents = new Set(
      [...this.pdfHighlights.values()].map((highlight) => highlight.document),
    );
    this.pdfHighlights.clear();
    for (const document of documents) {
      (document.defaultView as HighlightWindow | null)?.CSS?.highlights?.delete(
        HIGHLIGHT_NAME,
      );
    }
    for (const leaf of this.webLeaves) {
      const view = leaf.view as WebViewerView;
      void view.webview
        ?.executeJavaScript(webSelectionHighlightCleanupScript())
        .catch(() => {});
    }
    this.webLeaves.clear();
  }
}
