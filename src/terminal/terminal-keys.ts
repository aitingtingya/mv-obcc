// Faithful VT key encoding for the terminal view. Kept free of xterm/Obsidian
// imports so the whole matrix can be unit tested in isolation.
//
// When the terminal has focus we want it to behave like a real terminal:
// every key that reaches the renderer is encoded to the bytes a PTY would
// receive, instead of letting Obsidian hotkeys or the browser swallow them.

export interface TerminalKeyEncodeEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export interface TerminalKeyEncodeModes {
  applicationCursorKeys: boolean;
}

const CTRL_SYMBOLS: Record<string, string> = {
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  _: "\x1f",
  "?": "\x7f",
};

const CURSOR_FINALS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

const FUNCTION_KEY_SS3: Record<string, string> = {
  F1: "P",
  F2: "Q",
  F3: "R",
  F4: "S",
};

const FUNCTION_KEY_TILDE: Record<string, number> = {
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/**
 * Encodes a keydown event into the bytes a real terminal would send to the
 * PTY. Returns null when the event should be left to xterm's default path
 * (printable characters, IME composition, AltGr input, macOS Cmd chords and
 * Shift+PageUp/PageDown scrollback paging).
 */
export function encodeTerminalKey(
  event: TerminalKeyEncodeEvent,
  modes: TerminalKeyEncodeModes,
): string | null {
  if (event.type !== "keydown") return null;
  // IME composition must stay on xterm's default path.
  if (event.isComposing || event.key === "Process") return null;
  // Cmd chords belong to macOS menu/app conventions; do not hijack them.
  if (event.metaKey) return null;

  const ctrl = event.ctrlKey;
  const alt = event.altKey;
  const shift = event.shiftKey;
  const key = event.key;

  // Ctrl+Alt with a printable character is AltGr input on many layouts.
  if (ctrl && alt && key.length === 1) return null;

  // Plain printable characters are handled best by xterm itself.
  if (!ctrl && !alt && key.length === 1) return null;

  if (ctrl && !alt) {
    const lower = key.toLowerCase();
    if (lower.length === 1 && lower >= "a" && lower <= "z") {
      return String.fromCharCode(lower.charCodeAt(0) - 96);
    }
    if (key === " ") return "\x00";
    const symbol = CTRL_SYMBOLS[key];
    if (symbol) return symbol;
  }

  // Alt+printable sends ESC followed by the (possibly shifted) character.
  if (alt && !ctrl && key.length === 1) return "\x1b" + key;

  const modParam = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const hasModifiers = shift || alt || ctrl;
  const tildeSuffix = hasModifiers ? `;${modParam}~` : "~";

  switch (key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return shift && !ctrl && !alt ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowRight":
    case "ArrowLeft":
    case "Home":
    case "End": {
      const final = CURSOR_FINALS[key];
      if (hasModifiers) return `\x1b[1;${modParam}${final}`;
      return modes.applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
    }
    case "Insert":
      return `\x1b[2${tildeSuffix}`;
    case "Delete":
      return `\x1b[3${tildeSuffix}`;
    case "PageUp":
    case "PageDown": {
      // Keep xterm's scrollback paging convention for plain Shift+PageUp/Down.
      if (shift && !ctrl && !alt) return null;
      const code = key === "PageUp" ? 5 : 6;
      return `\x1b[${code}${tildeSuffix}`;
    }
    case "F1":
    case "F2":
    case "F3":
    case "F4": {
      const final = FUNCTION_KEY_SS3[key];
      return hasModifiers ? `\x1b[1;${modParam}${final}` : `\x1bO${final}`;
    }
    case "F5":
    case "F6":
    case "F7":
    case "F8":
    case "F9":
    case "F10":
    case "F11":
    case "F12": {
      const code = FUNCTION_KEY_TILDE[key];
      return `\x1b[${code}${tildeSuffix}`;
    }
    default:
      return null;
  }
}

/**
 * An open Obsidian modal (command palette, settings, confirm dialogs) owns
 * the keyboard for its window: while one is open the terminal must not
 * capture keys at all — otherwise a focused-terminal focus race would route
 * e.g. the palette's Enter into the PTY and swallow the command.
 * Obsidian creates `.modal-container` when a modal opens and removes it on
 * close (same selector convention as chrome-autohide.ts), so presence means
 * open. Kept DOM-only (Document interface) so it is unit-testable in jsdom.
 */
export const OBSIDIAN_MODAL_OPEN_SELECTOR = ".modal-container";

export function hasOpenObsidianModal(doc: Pick<Document, "querySelector">): boolean {
  return doc.querySelector(OBSIDIAN_MODAL_OPEN_SELECTOR) !== null;
}

/**
 * Whether xterm-originated input may be written to the PTY right now. An open
 * modal owns the keyboard, and xterm still emits data for keys it receives
 * while the terminal keeps DOM focus — delivering that would replay the key
 * the modal already consumed (an Enter executing a command and reaching the
 * shell). Programmatic input from this plugin does not go through here.
 */
export function shouldDeliverXtermInput(doc: Pick<Document, "querySelector">): boolean {
  return !hasOpenObsidianModal(doc);
}

/**
 * Whether a keydown was already consumed by an Obsidian overlay.
 *
 * Obsidian's keymap registers on window capture ahead of the terminal view, so
 * it runs first; when a scope matches it calls `preventDefault` and the modal
 * closes synchronously. The command palette's Enter binding is exactly that
 * case: the command executes, the palette disappears, and the terminal's own
 * window-capture listener still runs afterwards — when the container is
 * already gone, so asking the DOM would say "no modal". The close stamp taken
 * during this same event task is the evidence that the key belonged to the
 * overlay.
 *
 * A prevented default without a modal close is an ordinary Obsidian hotkey
 * (Ctrl+W and friends) and deliberately still reaches the terminal.
 */
export function overlayConsumedKey(
  event: Pick<KeyboardEvent, "defaultPrevented">,
  overlayClosedThisTick: boolean,
): boolean {
  return event.defaultPrevented && overlayClosedThisTick;
}

/**
 * Records that an Obsidian overlay container closed during the current event
 * task. The flag is cleared on the next task, so only the keystroke that
 * closed the overlay is affected; later typing is never swallowed.
 */
export class ObsidianOverlayTracker {
  private observer: MutationObserver | null = null;
  private ownerDocument: Document | null = null;
  private closed = false;
  private clearTimer: number | null = null;

  /** Begin watching overlay containers in one window document. */
  attach(doc: Document): void {
    if (this.ownerDocument === doc && this.observer) return;
    this.detach();
    const win = doc.defaultView;
    if (!win || typeof MutationObserver === "undefined") return;
    this.ownerDocument = doc;
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if ((node as Element | null)?.classList?.contains(MODAL_CONTAINER_CLASS) === true) {
            this.markClosed();
          }
        }
      }
    });
    const target = doc.body;
    if (target) this.observer.observe(target, { childList: true });
  }

  /** Stop watching and clear the pending stamp. */
  detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    const win = this.ownerDocument?.defaultView ?? null;
    if (this.clearTimer !== null) {
      win?.clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
    this.ownerDocument = null;
    this.closed = false;
  }

  /** Whether an overlay closed during the current event task. */
  get overlayClosedThisTick(): boolean {
    return this.closed;
  }

  private markClosed(): void {
    this.closed = true;
    const win = this.ownerDocument?.defaultView;
    if (!win) return;
    if (this.clearTimer !== null) win.clearTimeout(this.clearTimer);
    this.clearTimer = win.setTimeout(() => {
      this.clearTimer = null;
      this.closed = false;
    }, 0);
  }
}

/** Class Obsidian puts on the container of every modal, prompts included. */
const MODAL_CONTAINER_CLASS = OBSIDIAN_MODAL_OPEN_SELECTOR.slice(1);
