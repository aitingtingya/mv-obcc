import type { BridgeClientContext, SelectionState } from "./types";

const GLOBAL_CONTEXT_KEY = "global";

export function rememberLatestSelection(
  selections: Map<string, SelectionState>,
  key: string,
  state: SelectionState,
): void {
  if (state.selection.isEmpty) return;
  selections.set(key, state);
  selections.set(GLOBAL_CONTEXT_KEY, state);
}

export function latestSelectionForContext(
  selections: ReadonlyMap<string, SelectionState>,
  context?: BridgeClientContext,
): SelectionState | null {
  if (context?.sessionId) {
    return selections.get(context.sessionId) ?? null;
  }
  return selections.get(GLOBAL_CONTEXT_KEY) ?? null;
}
