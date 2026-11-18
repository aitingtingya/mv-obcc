import type { App, WorkspaceLeaf } from "obsidian";

/** One read-only workspace inventory per maintenance turn, never a live cache. */
export function snapshotWorkspaceLeaves(app: App): readonly WorkspaceLeaf[] {
  const leaves: WorkspaceLeaf[] = [];
  app.workspace.iterateAllLeaves((leaf) => {
    // A truthy callback result stops traversal of the current split.
    leaves.push(leaf);
  });
  return leaves;
}
