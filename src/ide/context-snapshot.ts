import type { OpenEditorTab, SelectionState } from "../types";

export interface IdeContextSnapshot {
  vaultRoot: string;
  current: SelectionState | null;
  openEditors: OpenEditorTab[];
}
