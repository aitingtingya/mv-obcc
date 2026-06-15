import type { App, View, WorkspaceLeaf } from "obsidian";
import { isTerminalViewType, parseTerminalMarker } from "./activity-tracking";

interface TerminalLikeView extends View {
  rawTitle?: unknown;
  title?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function markerCandidates(leaf: WorkspaceLeaf): string[] {
  const view = leaf.view as TerminalLikeView;
  const state = leaf.getViewState() as unknown as {
    state?: { title?: unknown; userTitle?: unknown };
  };
  return [
    leaf.getDisplayText(),
    view.getDisplayText(),
    text(view.rawTitle),
    text(view.title),
    text(state.state?.title),
    text(state.state?.userTitle),
  ];
}

export class TerminalSessionTracker {
  private readonly leavesBySession = new Map<string, WorkspaceLeaf>();

  constructor(private readonly app: App) {}

  scan(): void {
    const liveLeaves = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      liveLeaves.add(leaf);
      const sessionId = parseTerminalMarker(markerCandidates(leaf));
      if (sessionId) this.leavesBySession.set(sessionId, leaf);
    });
    for (const [sessionId, leaf] of this.leavesBySession) {
      if (!liveLeaves.has(leaf)) this.leavesBySession.delete(sessionId);
    }
  }

  leafForSession(sessionId: string | undefined): WorkspaceLeaf | null {
    if (!sessionId) return null;
    return this.leavesBySession.get(sessionId.toLowerCase()) ?? null;
  }

  isTerminalLeaf(leaf: WorkspaceLeaf | null): boolean {
    if (!leaf) return false;
    if (isTerminalViewType(leaf.view.getViewType())) return true;
    return parseTerminalMarker(markerCandidates(leaf)) !== null;
  }
}
