import { characterAt, displayWidth } from "./characters";
import type { VimBuffer } from "./types";

/** Display columns, not UTF-16 offsets, define a rectangular selection. */
export function blockGeometry(buffer: VimBuffer, anchor: number, head: number, tabstop: number) {
  const first = buffer.lineAt(anchor); const last = buffer.lineAt(head);
  const anchorColumn = displayWidth(buffer.text(first.from, anchor), tabstop);
  const headColumn = displayWidth(buffer.text(last.from, head), tabstop);
  const left = Math.min(anchorColumn, headColumn);
  const right = Math.max(
    anchorColumn + Math.max(1, displayWidth(characterAt(buffer.text(), anchor), tabstop, anchorColumn)),
    headColumn + Math.max(1, displayWidth(characterAt(buffer.text(), head), tabstop, headColumn)),
  );
  return { firstLine: Math.min(first.number, last.number), lastLine: Math.max(first.number, last.number), left, right, reversed: headColumn < anchorColumn };
}
