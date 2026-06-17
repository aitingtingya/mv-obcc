import type { ViewUpdate } from "@codemirror/view";

export type InlineCompletionUpdateAction = "schedule" | "cancel" | "ignore";

function hasUserEvent(update: ViewUpdate, event: string): boolean {
  return update.transactions.some((tr) => tr.isUserEvent(event));
}

export function classifyInlineCompletionUpdate(
  update: ViewUpdate,
): InlineCompletionUpdateAction {
  if (update.focusChanged && !update.view.hasFocus) return "cancel";
  if (hasUserEvent(update, "input.complete")) return "cancel";
  if (update.view.composing) {
    return update.docChanged || update.selectionSet ? "cancel" : "ignore";
  }
  if (!update.state.selection.main.empty) {
    return update.docChanged || update.selectionSet ? "cancel" : "ignore";
  }

  if (update.docChanged) {
    if (hasUserEvent(update, "input") || hasUserEvent(update, "delete")) {
      return "schedule";
    }
    return "cancel";
  }

  if (update.selectionSet) {
    return hasUserEvent(update, "select.pointer") ? "schedule" : "cancel";
  }

  return "ignore";
}
