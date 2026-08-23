// Pure line-collection strategies for integrated-terminal reads.
//
// Extracted from TerminalView so the semantics are unit-testable without an
// Obsidian ItemView. Two modes exist on purpose:
//
//  - collectTailLines: literal mode. Reads the LAST `maxLines` physical rows
//    of the buffer and strips trailing blank lines. Byte-for-byte identical to
//    the historical readTailLines implementation — explicit `lastN` callers
//    keep exactly the old behavior, including its honest quirk that an idle
//    shell (prompt at the buffer origin, blank rows below) reads as [].
//
//  - collectUsedLines: smart mode (default when lastN is omitted). Reads the
//    USED region — everything up to the cursor / last non-blank row — capped
//    at `maxLines`. A fresh terminal therefore reports its prompt instead of
//    fifty blank viewport rows.

export interface BufferLineLike {
  translateToString(trimRight: boolean): string | undefined;
}

export interface BufferLike {
  length: number;
  getLine(y: number): BufferLineLike | undefined;
  /** Viewport-relative cursor row (xterm.js). Optional for test doubles. */
  cursorY?: number;
  /** Absolute buffer row of the viewport top (xterm.js). Optional for test doubles. */
  baseY?: number;
}

function lineAt(buffer: BufferLike, y: number): string {
  return buffer.getLine(y)?.translateToString(true) ?? "";
}

/** Strip trailing blank lines in place. */
function popTrailingBlanks(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** Literal mode: the trailing `maxLines` physical rows, trailing blanks stripped. */
export function collectTailLines(buffer: BufferLike, maxLines: number): string[] {
  const total = buffer.length;
  if (!(total > 0)) return [];
  const start = Math.max(0, total - Math.max(1, Math.floor(maxLines)));
  const lines: string[] = [];
  for (let y = start; y < total; y++) lines.push(lineAt(buffer, y));
  return popTrailingBlanks(lines);
}

/**
 * Smart mode: collect up to `maxLines` rows ending at the used region — the
 * cursor position or the last non-blank row, whichever is lower in the
 * buffer. Blank viewport padding below an idle prompt is skipped, so a fresh
 * shell reports its prompt and short command output is always visible.
 */
export function collectUsedLines(buffer: BufferLike, maxLines: number): string[] {
  const total = buffer.length;
  if (!(total > 0)) return [];

  let lastContentRow = -1;
  for (let y = total - 1; y >= 0; y--) {
    if (lineAt(buffer, y).trim() !== "") {
      lastContentRow = y;
      break;
    }
  }

  const cursorRow =
    typeof buffer.baseY === "number" && typeof buffer.cursorY === "number"
      ? buffer.baseY + buffer.cursorY
      : total - 1;

  const end = Math.min(total, Math.max(lastContentRow + 1, Math.min(cursorRow + 1, total)));
  const start = Math.max(0, end - Math.max(1, Math.floor(maxLines)));
  const lines: string[] = [];
  for (let y = start; y < end; y++) lines.push(lineAt(buffer, y));
  return popTrailingBlanks(lines);
}

/** Diagnostics describing why a buffer reads the way it does. */
export interface ReadDiagnostics {
  bufLen: number;
  cursorRow: number | null;
  lastContentRow: number | null;
}

export function describeBuffer(buffer: BufferLike): ReadDiagnostics {
  let lastContentRow: number | null = null;
  for (let y = buffer.length - 1; y >= 0; y--) {
    if (lineAt(buffer, y).trim() !== "") {
      lastContentRow = y;
      break;
    }
  }
  return {
    bufLen: buffer.length,
    cursorRow:
      typeof buffer.baseY === "number" && typeof buffer.cursorY === "number"
        ? buffer.baseY + buffer.cursorY
        : null,
    lastContentRow,
  };
}
