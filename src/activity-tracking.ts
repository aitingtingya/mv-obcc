import type { ActivityTrackingSettings, SelectionState } from "./types";
import { TERMINAL_MARKER_PREFIX } from "./constants";

const SESSION_ID_PATTERN =
  /mv-obcc-ide:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

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

export function terminalMarker(sessionId: string): string {
  return `${TERMINAL_MARKER_PREFIX}${sessionId}`;
}

export function parseTerminalMarker(values: readonly string[]): string | null {
  for (const value of values) {
    const match = SESSION_ID_PATTERN.exec(value);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}
