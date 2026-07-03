import { Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import type { InlineCompletionKeymap } from "../types";
import { inlineSuggestionField, InlineSuggestionEffect } from "./inline-suggestion-state";
import { inlineSuggestionPlugin } from "./inline-suggestion-view";
import {
  buildKeymapExtension,
  type KeymapHandlers,
  keymapCompartment,
} from "./inline-suggestion-keymap";

/**
 * Owns the CodeMirror extensions for inline completion and tracks every open
 * Markdown editor view, so the feature class can (a) dispatch suggestions to
 * a specific view, (b) reconfigure keymaps across all views when settings
 * change, and (c) clear all suggestions on disable.
 *
 * Pattern mirrors `SelectionHighlightController` (a static extension array
 * registered once via `registerEditorExtension`), with a weak set of live
 * views maintained through an updateListener.
 */

export interface InlineCompletionControllerDeps {
  /** Current keymap settings, read fresh each time we build/reconfigure. */
  getKeymap: () => InlineCompletionKeymap;
  /** Handlers for the reject key (triggers a regeneration). */
  handlers: KeymapHandlers;
  /** Called on every view update; feature code classifies trigger/cancel/ignore. */
  onViewUpdate?: (update: ViewUpdate) => void;
  /** Called when a CodeMirror editor view is destroyed. */
  onViewDestroy?: (view: EditorView) => void;
}

export class InlineCompletionController {
  private readonly deps: InlineCompletionControllerDeps;
  /** WeakSet would lose entries we need to iterate, so a Set keyed by view. */
  private readonly views = new Set<EditorView>();
  private disposed = false;

  constructor(deps: InlineCompletionControllerDeps) {
    this.deps = deps;
  }

  /**
   * The static extension array. The keymap lives behind a Compartment so it
   * can be reconfigured per-view after construction. A ViewPlugin tracks each
   * live view (added on construction, removed on destroy) — the same pattern
   * `SelectionHighlightController` uses.
   */
  markdownExtension(): Extension[] {
    const controller = this;
    return [
      inlineSuggestionField,
      Prec.highest(inlineSuggestionPlugin),
      keymapCompartment.of(this.currentKeymapExtension()),
      ViewPlugin.define((view) => {
        controller.views.add(view);
        return {
          destroy() {
            controller.views.delete(view);
            controller.deps.onViewDestroy?.(view);
          },
        };
      }),
      EditorView.updateListener.of((update) => {
        controller.deps.onViewUpdate?.(update);
      }),
    ];
  }

  private currentKeymapExtension(): Extension {
    return buildKeymapExtension(this.deps.getKeymap(), this.deps.handlers);
  }

  /** Iterate every tracked live view (snapshot copy to allow mutation). */
  forEachView(fn: (view: EditorView) => void): void {
    for (const view of [...this.views]) {
      fn(view);
    }
  }

  /** Reconfigure the keymap on every live view. Call after settings change. */
  reconfigureKeymaps(): void {
    const ext = this.currentKeymapExtension();
    this.forEachView((view) => {
      view.dispatch({ effects: keymapCompartment.reconfigure(ext) });
    });
  }

  /** Set (or replace) the suggestion shown on a specific view. */
  setSuggestion(view: EditorView, text: string): void {
    const from = view.state.selection.main.head;
    view.dispatch({ effects: InlineSuggestionEffect.of({ text, from }) });
  }

  /** Clear the suggestion on a specific view. */
  clearSuggestion(view: EditorView): void {
    view.dispatch({ effects: InlineSuggestionEffect.of(null) });
  }

  /** Clear suggestions across all live views. */
  clearAll(): void {
    this.forEachView((view) => this.clearSuggestion(view));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.views.clear();
  }
}
