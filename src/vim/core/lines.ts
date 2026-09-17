import type { VimBuffer, VimEdit } from "./types";

/** Line identities preserve marks when :move reorders, rather than deletes, text. */
export function planLineTransfer(buffer: VimBuffer, first: number, last: number, destination: number, moving: boolean): {
  edits: VimEdit[]; cursorLine: number; map: (position: number) => number;
} {
  const old = Array.from({ length: buffer.lineCount }, (_, index) => buffer.line(index + 1));
  const entries = old.map((line, index) => ({ text: line.text, id: index }));
  const copied = entries.slice(first - 1, last).map((entry) => ({ ...entry, id: moving ? entry.id : -1 }));
  if (moving) entries.splice(first - 1, copied.length);
  const at = moving && destination > last ? destination - copied.length : destination;
  entries.splice(at, 0, ...copied);
  let prefix = 0;
  while (prefix < old.length && prefix < entries.length && entries[prefix].id === prefix) prefix += 1;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < entries.length - prefix && entries[entries.length - 1 - suffix].id === old.length - 1 - suffix) suffix += 1;
  const from = prefix < old.length ? old[prefix].from : buffer.length;
  const to = suffix ? old[old.length - suffix].from : buffer.length;
  const changed = entries.slice(prefix, entries.length - suffix);
  const middle = changed.map(({ text }) => text).join("\n");
  const insert = `${prefix === old.length && changed.length ? "\n" : ""}${middle}${suffix && changed.length ? "\n" : ""}`;
  const positions = new Map<number, number>();
  let position = 0;
  for (const entry of entries) {
    if (entry.id >= 0) positions.set(entry.id, position);
    position += entry.text.length + 1;
  }
  return { edits: from === to && !insert ? [] : [{ from, to, insert }], cursorLine: at + copied.length,
    map: (offset) => {
      // Use the pre-edit line table; buffer.lineAt now refers to the new document.
      let low = 0; let high = old.length;
      while (low + 1 < high) { const mid = (low + high) >>> 1; if (old[mid].from <= offset) low = mid; else high = mid; }
      return positions.get(low)! + Math.min(offset - old[low].from, old[low].text.length);
    } };
}
