import type { App, WorkspaceLeaf } from "obsidian";

/** One read-only workspace inventory per maintenance turn, never a live cache. */
export function snapshotWorkspaceLeaves(app: App): readonly WorkspaceLeaf[] {
  const leaves: WorkspaceLeaf[] = [];
  app.workspace.iterateAllLeaves(leaf => leaves.push(leaf));
  return leaves;
}
