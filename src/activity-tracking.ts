import type { ActivityTrackingSettings, SelectionState } from "./types";

export function isSelectedPageType(
  state: SelectionState,
  settings: ActivityTrackingSettings,
): boolean {
  switch (state.resourceType) {
    case "markdown":
      return settings.trackMarkdown;
    case "pdf":
      return settings.trackPdf;
    case "web":
      return settings.trackWebview;
    default:
      return false;
  }
}

export function isTerminalViewType(viewType: string): boolean {
  const normalized = viewType.toLowerCase();
  return (
    normalized.includes("terminal") ||
    normalized.includes("console") ||
    normalized === "shell" ||
    normalized.endsWith(":shell")
  );
}

/** All-pages passive tracking keeps every non-terminal Obsidian view. */
export function isAllPagesPassiveViewType(viewType: string): boolean {
  return !isTerminalViewType(viewType);
}

