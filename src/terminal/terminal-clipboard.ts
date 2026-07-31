// Clipboard key handling for the terminal view. Kept free of xterm/Obsidian
// imports so the decision logic can be unit tested in isolation.

export type TerminalKeyAction = "copy" | "paste" | "passthrough";

export interface TerminalKeyEventLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Decides what a keyboard event should do in the terminal.
 *
 * Rules:
 * - mod+C (Cmd on macOS, Ctrl elsewhere) copies only when there is a
 *   selection; without a selection it passes through so xterm still sends
 *   ^C (SIGINT) to the PTY.
 * - mod+V pastes.
 * - Ctrl+Shift+C/V are extra copy/paste aliases on non-mac platforms,
 *   matching Windows/Linux terminal conventions.
 * - Everything else passes through to xterm's default handling.
 */
export function resolveTerminalKeyAction(
  event: TerminalKeyEventLike,
  options: { isMac: boolean; hasSelection: boolean },
): TerminalKeyAction {
  if (event.type !== "keydown") return "passthrough";
  const key = event.key.toLowerCase();
  const modChord = (options.isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey;
  const ctrlShiftChord = !options.isMac && event.ctrlKey && event.shiftKey;
  if (key === "c" && (modChord || ctrlShiftChord)) {
    return options.hasSelection ? "copy" : "passthrough";
  }
  if (key === "v" && (modChord || ctrlShiftChord)) {
    return "paste";
  }
  return "passthrough";
}
