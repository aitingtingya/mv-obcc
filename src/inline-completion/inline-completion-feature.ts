import { type App, MarkdownView, Notice } from "obsidian";
import type { Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type MvSenceAiIdePlugin from "../../main";
import {
  callLlmStreamMessages,
  resolveInlineProvider,
  type LlmMessage,
} from "../llm-client";
import type { InlineCompletionKeymap, InlineCompletionSettings } from "../types";
import {
  DEFAULT_INLINE_SYSTEM_PROMPT_BODY,
  DEFAULT_INLINE_NO_COMPLETION_PROMPT,
} from "../constants";
import { InlineCompletionController } from "./inline-completion-controller";
import {
  buildInlineCompletionUserMessage,
  type InlineCursorContext,
} from "./inline-context";
import {
  displayableCompletionStreamText,
  finalCompletionText,
} from "./inline-completion-protocol";
import { buildRejectUserMessage } from "./inline-reject-prompt";
import { readSuggestion } from "./inline-suggestion-state";
import { classifyInlineCompletionUpdate } from "./inline-trigger";

/**
 * Inline completion (ghost text) feature.
 *
 * Independent of the {@link LlmFeature} (划词调用) module. It reuses the shared
 * LLM client + providers + settings plumbing but implements its own trigger
 * logic, ghost-text rendering, keymap, and reject→regenerate multi-turn flow.
 *
 * Lifecycle:
 *  - Master switch: `settings.inlineCompletion.enabled`. When on, a ribbon
 *    button appears; the button must be lit for auto-completion to actually
 *    fire.
 *  - Trigger: a debounced listener fires after the user stops typing in a
 *    Markdown editor; it requests a completion from the configured model.
 *  - Accept/Reject/Cancel: handled by the per-view keymap (see
 *    {@link ./inline-suggestion-keymap.ts}). Reject feeds the prior completion
 *    + a rejection note back to the model as multi-turn context.
 */

interface RequestSnapshot {
  id: number;
  view: EditorView;
  doc: Text;
  head: number;
  requireArmed: boolean;
}

function editorViewFromMarkdown(view: MarkdownView): EditorView | null {
  const editor = view.editor as unknown as { cm?: unknown };
  return editor.cm instanceof EditorView ? editor.cm : null;
}

export class InlineCompletionFeature {
  private readonly plugin: MvSenceAiIdePlugin;
  private readonly app: App;
  private readonly controller: InlineCompletionController;

  private armed = false;
  private ribbonIconEl: HTMLElement | null = null;

  /** One in-flight request per view. Keyed by the view object identity. */
  private readonly abortControllers = new Map<EditorView, AbortController>();
  /** Debounce timers per view. */
  private readonly debounceTimers = new Map<EditorView, number>();
  /** Conversation history per view, for reject→regenerate. */
  private readonly conversations = new Map<EditorView, LlmMessage[]>();
  private readonly activeRequestIds = new Map<EditorView, number>();
  private requestSeq = 0;
  private disposed = false;

  constructor(plugin: MvSenceAiIdePlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.armed = plugin.settings.inlineCompletion.armed === true;
    this.controller = new InlineCompletionController({
      getKeymap: () => this.settings.keymap,
      handlers: {
        onReject: (view, rejectedText) => this.handleReject(view, rejectedText),
        onRequest: (view) => this.handleManualRequest(view),
      },
      onViewUpdate: (update) => this.handleViewUpdate(update),
      onViewDestroy: (view) => this.handleViewDestroy(view),
    });
  }

  private get settings(): InlineCompletionSettings {
    return this.plugin.settings.inlineCompletion;
  }

  /** Effective system prompt: user-configured body + no-completion, or built-in default. */
  private get systemPrompt(): string {
    const body = this.settings.systemPromptBody?.trim()
      ? this.settings.systemPromptBody
      : DEFAULT_INLINE_SYSTEM_PROMPT_BODY;
    const noComp = this.settings.noCompletionPrompt?.trim()
      ? this.settings.noCompletionPrompt
      : DEFAULT_INLINE_NO_COMPLETION_PROMPT;
    return body + "\n" + noComp;
  }

  /** The extension array for `registerEditorExtension`. */
  markdownExtension() {
    return this.controller.markdownExtension();
  }

  // ---- Lifecycle hooks (called from main.ts) ----

  /** Called from main.ts's 500ms interval. Keeps the ribbon in sync. */
  tick(): void {
    this.refreshRibbon();
  }

  /** Called when inline-completion settings change. */
  settingsChanged(): void {
    this.armed = this.settings.enabled && this.settings.armed;
    this.refreshRibbon();
    this.controller.reconfigureKeymaps();
    // If disabled, cancel everything and hide suggestions.
    if (!this.settings.enabled) {
      this.cancelAll();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.removeRibbon();
    this.controller.dispose();
  }

  // ---- Ribbon button (mirrors LlmFeature's ribbon pattern) ----

  private refreshRibbon(): void {
    if (!this.settings.enabled) {
      this.removeRibbon();
      return;
    }
    const tooltip = `行内补全（点击${this.armed ? "关闭" : "开启"}）`;
    if (this.ribbonIconEl) {
      this.ribbonIconEl.setAttribute("aria-label", tooltip);
      this.ribbonIconEl.setAttribute("data-tooltip", tooltip);
      this.ribbonIconEl.classList.toggle("is-active", this.armed);
      return;
    }
    this.ribbonIconEl = this.plugin.addRibbonIcon(
      "sparkles",
      "行内补全",
      () => this.toggleArmed(),
    );
    this.ribbonIconEl.addClass("mv-senceai-inline-completion-ribbon");
    this.ribbonIconEl.setAttribute("aria-label", tooltip);
    this.ribbonIconEl.setAttribute("data-tooltip", tooltip);
    this.ribbonIconEl.classList.toggle("is-active", this.armed);
  }

  private removeRibbon(): void {
    this.ribbonIconEl?.remove();
    this.ribbonIconEl = null;
    this.armed = false;
  }

  private toggleArmed(): void {
    this.armed = !this.armed;
    this.plugin.settings.inlineCompletion.armed = this.armed;
    void this.plugin.saveData(this.plugin.settings);
    this.ribbonIconEl?.classList.toggle("is-active", this.armed);
    if (!this.armed) {
      this.cancelAll();
    }
    new Notice(this.armed ? "已开启行内补全" : "已关闭行内补全", 2000);
    const tooltip = `行内补全（点击${this.armed ? "关闭" : "开启"}）`;
    this.ribbonIconEl?.setAttribute("aria-label", tooltip);
    this.ribbonIconEl?.setAttribute("data-tooltip", tooltip);
  }

  // ---- Triggering ----

  /**
   * Classify CodeMirror updates so navigation does not look like typing. Text
   * edits and mouse cursor placement may schedule; navigation/selection cancels.
   */
  private handleViewUpdate(update: ViewUpdate): void {
    const action = classifyInlineCompletionUpdate(update);
    if (action === "ignore") return;
    if (action === "cancel") {
      this.cancelView(update.view, true);
      return;
    }
    if (this.armed) {
      this.scheduleRequest(update.view);
    } else {
      // Manual-mode users may still have an in-flight request; stale it when
      // the document/cursor changes even though automatic triggering is off.
      this.cancelView(update.view, false);
    }
  }

  private scheduleRequest(view: EditorView): void {
    if (!this.shouldRespond(view, { requireArmed: true })) return;
    // Clear any existing suggestion on edit (the field clears automatically,
    // but also drop a stale in-flight request for this view).
    this.cancelView(view, false);
    const cfg = this.settings;
    const timer = activeWindow.setTimeout(() => {
      this.debounceTimers.delete(view);
      void this.requestCompletion(view, { requireArmed: true });
    }, cfg.debounceMs);
    this.debounceTimers.set(view, timer);
  }

  private handleManualRequest(view: EditorView): boolean {
    if (!this.shouldRespond(view, { requireArmed: false })) return false;
    this.cancelView(view, false);
    void this.requestCompletion(view, { requireArmed: false });
    return true;
  }

  private shouldRespond(
    view?: EditorView,
    options: { requireArmed?: boolean } = {},
  ): boolean {
    if (this.disposed) return false;
    const requireArmed = options.requireArmed ?? true;
    if (!this.settings.enabled) return false;
    if (requireArmed && !this.armed) return false;
    // Only the active Markdown editor participates.
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || !(leaf.view instanceof MarkdownView)) return false;
    if (!view) return true;
    const activeEditorView = editorViewFromMarkdown(leaf.view);
    return activeEditorView === view;
  }

  /**
   * Request a fresh completion for the given view. Builds a single-turn
   * message from the text before the cursor, streams the response, and shows
   * ghost text incrementally. Truncates to maxChars/maxLines.
   */
  private async requestCompletion(
    view: EditorView,
    options: { requireArmed: boolean },
  ): Promise<void> {
    if (this.disposed || !this.shouldRespond(view, options)) return;
    const active = this.app.workspace.activeLeaf?.view;
    if (!(active instanceof MarkdownView)) return;
    // Only proceed if this view is the active editor's CodeMirror view.
    if (editorViewFromMarkdown(active) !== view) return;

    const cfg = this.settings;
    let target;
    try {
      target = resolveInlineProvider(this.plugin.settings.llm, cfg);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 4000);
      return;
    }

    const context = this.cursorContext(
      view,
      cfg.contextBeforeChars,
      cfg.contextAfterChars,
    );
    if (!(context.before + context.after).trim()) {
      // Nothing meaningful to complete; reset conversation.
      this.conversations.delete(view);
      return;
    }
    const snapshot = this.createRequestSnapshot(view, options.requireArmed);
    if (!snapshot) return;

    const messages: LlmMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: buildInlineCompletionUserMessage(context) },
    ];
    this.conversations.set(view, messages);

    let accumulated = "";
    const abort = new AbortController();
    this.abortControllers.set(view, abort);

    try {
      await callLlmStreamMessages(
        target,
        messages,
        (delta) => {
          if (!this.isRequestCurrent(snapshot, abort.signal)) {
            abort.abort();
            return;
          }
          accumulated += delta;
          const displayText = displayableCompletionStreamText(accumulated, cfg);
          if (displayText) this.controller.setSuggestion(view, displayText);
        },
        abort.signal,
      );
      if (!this.isRequestCurrent(snapshot, abort.signal)) return;
      // Final truncation pass in case last delta crossed a boundary.
      const finalText = finalCompletionText(accumulated, cfg);
      if (!finalText) {
        this.controller.clearSuggestion(view);
        this.conversations.delete(view);
      } else {
        this.controller.setSuggestion(view, finalText);
        // Record the assistant turn so reject can continue the conversation.
        this.conversations.get(view)?.push({ role: "assistant", content: finalText });
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // normal cancel
      this.controller.clearSuggestion(view);
      new Notice(`行内补全失败：${e instanceof Error ? e.message : String(e)}`, 4000);
    } finally {
      if (this.abortControllers.get(view) === abort) {
        this.abortControllers.delete(view);
      }
      if (this.activeRequestIds.get(view) === snapshot.id) {
        this.activeRequestIds.delete(view);
      }
    }
  }

  // ---- Reject → regenerate (multi-turn) ----

  /**
   * Handle the reject key. Reads the visible suggestion as the assistant's
   * last turn, appends a "give a different completion" user turn, and streams
   * a new suggestion for the same editor view.
   */
  private handleReject(view: EditorView, rejectedText: string): void {
    if (!this.shouldRespond(view, { requireArmed: false })) return;
    void this.regenerate(view, rejectedText);
  }

  /** Regenerate after rejecting the currently visible suggestion. */
  async regenerate(view: EditorView, rejectedText = readSuggestion(view)): Promise<void> {
    if (this.disposed || !this.shouldRespond(view, { requireArmed: false })) return;
    const cfg = this.settings;
    let target;
    try {
      target = resolveInlineProvider(this.plugin.settings.llm, cfg);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 4000);
      return;
    }

    let history = this.conversations.get(view)?.slice();
    // If the last recorded turn isn't the currently-displayed suggestion,
    // reset and seed from the visible text.
    const visible = rejectedText || readSuggestion(view);
    if (!history) {
      const context = this.cursorContext(
        view,
        cfg.contextBeforeChars,
        cfg.contextAfterChars,
      );
      history = [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: buildInlineCompletionUserMessage(context) },
      ];
    }
    if (history[history.length - 1]?.role !== "assistant") {
      history.push({ role: "assistant", content: visible });
    } else {
      // Replace the last assistant turn with what's actually on screen.
      history[history.length - 1] = { role: "assistant", content: visible };
    }
    const retryMessage = buildRejectUserMessage(cfg.rejectPrompt, visible);
    history.push({ role: "user", content: retryMessage });
    this.conversations.set(view, history);

    this.cancelView(view, false);
    const snapshot = this.createRequestSnapshot(view, false);
    if (!snapshot) return;
    let accumulated = "";
    const abort = new AbortController();
    this.abortControllers.set(view, abort);

    try {
      await callLlmStreamMessages(
        target,
        history,
        (delta) => {
          if (!this.isRequestCurrent(snapshot, abort.signal)) {
            abort.abort();
            return;
          }
          accumulated += delta;
          const displayText = displayableCompletionStreamText(accumulated, cfg);
          if (displayText) this.controller.setSuggestion(view, displayText);
        },
        abort.signal,
      );
      if (!this.isRequestCurrent(snapshot, abort.signal)) return;
      const finalText = finalCompletionText(accumulated, cfg);
      if (!finalText) {
        this.controller.clearSuggestion(view);
        this.conversations.delete(view);
      } else {
        this.controller.setSuggestion(view, finalText);
        history.push({ role: "assistant", content: finalText });
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      this.controller.clearSuggestion(view);
      new Notice(`行内补全重新生成失败：${e instanceof Error ? e.message : String(e)}`, 4000);
    } finally {
      if (this.abortControllers.get(view) === abort) {
        this.abortControllers.delete(view);
      }
      if (this.activeRequestIds.get(view) === snapshot.id) {
        this.activeRequestIds.delete(view);
      }
    }
  }

  // ---- Helpers ----

  private cursorContext(
    view: EditorView,
    beforeChars: number,
    afterChars: number,
  ): InlineCursorContext {
    const head = view.state.selection.main.head;
    const beforeLimit = Math.max(0, Math.floor(beforeChars));
    const afterLimit = Math.max(0, Math.floor(afterChars));
    const from = Math.max(0, head - beforeLimit);
    const to = Math.min(view.state.doc.length, head + afterLimit);
    return {
      before: view.state.doc.sliceString(from, head),
      after: view.state.doc.sliceString(head, to),
    };
  }

  private createRequestSnapshot(
    view: EditorView,
    requireArmed: boolean,
  ): RequestSnapshot | null {
    if (!this.shouldRespond(view, { requireArmed })) return null;
    const selection = view.state.selection.main;
    if (!selection.empty) return null;
    const id = ++this.requestSeq;
    this.activeRequestIds.set(view, id);
    return {
      id,
      view,
      doc: view.state.doc,
      head: selection.head,
      requireArmed,
    };
  }

  private isRequestCurrent(
    snapshot: RequestSnapshot,
    signal?: AbortSignal,
  ): boolean {
    if (signal?.aborted) return false;
    if (this.activeRequestIds.get(snapshot.view) !== snapshot.id) return false;
    if (!this.shouldRespond(snapshot.view, { requireArmed: snapshot.requireArmed })) {
      return false;
    }
    const selection = snapshot.view.state.selection.main;
    return (
      snapshot.view.state.doc === snapshot.doc &&
      selection.empty &&
      selection.head === snapshot.head
    );
  }

  private cancelView(view: EditorView, clearVisible: boolean): void {
    const timer = this.debounceTimers.get(view);
    if (timer !== undefined) {
      activeWindow.clearTimeout(timer);
      this.debounceTimers.delete(view);
    }
    const existing = this.abortControllers.get(view);
    if (existing) {
      existing.abort();
      this.abortControllers.delete(view);
    }
    this.activeRequestIds.delete(view);
    if (clearVisible) this.controller.clearSuggestion(view);
  }

  private handleViewDestroy(view: EditorView): void {
    this.cancelView(view, false);
    this.conversations.delete(view);
    this.activeRequestIds.delete(view);
  }

  /** Cancel all timers/requests and clear all visible suggestions. */
  private cancelAll(): void {
    for (const timer of this.debounceTimers.values()) {
      activeWindow.clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const ac of this.abortControllers.values()) ac.abort();
    this.abortControllers.clear();
    this.conversations.clear();
    this.activeRequestIds.clear();
    this.controller.clearAll();
  }
}

/** Re-exported so settings UI can reference the keymap type. */
export type { InlineCompletionKeymap };
