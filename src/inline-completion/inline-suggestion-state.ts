import { EditorSelection, StateEffect, StateField, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * CodeMirror state for a single inline (ghost-text) completion.
 *
 * One completion at a time — simpler than the multi-suggestion LSP model.
 * The field holds the completion text plus the document offset it was
 * generated for. Decorations are produced from it in {@link ./inline-suggestion-view.ts}.
 */

export interface InlineSuggestionValue {
  /** The completion text to render as ghost text. */
  text: string;
  /** Document offset the suggestion was generated for (the cursor at request time). */
  from: number;
}

/** Effect used to set/clear the current suggestion imperatively. */
export const InlineSuggestionEffect = StateEffect.define<InlineSuggestionValue | null>();

/**
 * StateField holding the current ghost-text suggestion, or null.
 *
 * Clearing rules:
 *  - An explicit {@link InlineSuggestionEffect} always wins (set or clear).
 *  - If the cursor moved, the suggestion becomes stale → clear it. We compare
 *    against the suggestion's own `from`, so the accept path (which dispatches
 *    a text change followed by a clear effect) is unaffected because the clear
 *    effect arrives in the same transaction.
 *  - Any document change clears it too — the completion is no longer valid
 *    once the user types.
 */
export const inlineSuggestionField = StateField.define<InlineSuggestionValue | null>({
  create() {
    return null;
  },
  update(value, tr) {
    const effect = tr.effects.find((e) => e.is(InlineSuggestionEffect));
    if (effect) {
      return effect.value;
    }
    if (!value) return null;

    // Accept dispatches the text insertion as a doc change in the same
    // transaction; guard against self-clearing by checking the effect presence
    // above (already handled). For genuine user edits, clear.
    if (tr.docChanged) return null;

    // Cursor moved away from the suggestion origin → stale.
    if (tr.selection) {
      const head = tr.selection.main.head;
      if (head !== value.from) return null;
    }
    return value;
  },
});

/** Imperatively clear the current suggestion on a view. */
export function clearSuggestion(view: EditorView): void {
  view.dispatch({
    effects: InlineSuggestionEffect.of(null),
  });
}

/**
 * Accept the current suggestion: insert its text at the suggestion origin and
 * move the cursor to the end of the inserted text, then clear the field.
 */
export function acceptSuggestion(view: EditorView): void {
  const current = view.state.field(inlineSuggestionField, false);
  if (!current) return;
  const from = Math.min(current.from, view.state.doc.length);
  const to = from;
  view.dispatch({
    changes: { from, to, insert: current.text },
    selection: EditorSelection.cursor(from + current.text.length),
    userEvent: "input.complete",
    effects: InlineSuggestionEffect.of(null),
  });
}

/** True when a non-empty suggestion is currently displayed on this view. */
export function hasSuggestion(view: EditorView): boolean {
  const v = view.state.field(inlineSuggestionField, false);
  return !!v && v.text.length > 0;
}

/** Read the current suggestion text, or "" when none. */
export function readSuggestion(view: EditorView): string {
  const v = view.state.field(inlineSuggestionField, false);
  return v?.text ?? "";
}

/** Whether a transaction was caused by accepting a suggestion (best-effort). */
export function isAcceptTransaction(tr: Transaction): boolean {
  return tr.isUserEvent("input.complete");
}
