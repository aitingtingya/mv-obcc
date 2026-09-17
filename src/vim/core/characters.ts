/** UTF-16 is a storage coordinate; editing addresses complete characters. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
let cachedText = "";
let cachedBoundaries = [0];

function boundaries(text: string): readonly number[] {
  if (text !== cachedText) {
    cachedText = text;
    cachedBoundaries = [];
    for (const part of segmenter.segment(text)) cachedBoundaries.push(part.index);
    cachedBoundaries.push(text.length);
  }
  return cachedBoundaries;
}

function boundaryIndex(text: string, position: number): number {
  const points = boundaries(text);
  let left = 0;
  let right = points.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (points[middle] <= position) left = middle + 1;
    else right = middle;
  }
  return Math.max(0, left - 1);
}

export function characterStart(text: string, position: number): number {
  return boundaries(text)[boundaryIndex(text, position)] ?? 0;
}

export function moveCharacters(text: string, position: number, count: number): number {
  const points = boundaries(text);
  const index = boundaryIndex(text, position);
  return points[Math.max(0, Math.min(points.length - 1, index + count))];
}

export function nextCharacter(text: string, position: number): number { return moveCharacters(text, position, 1); }
export function previousCharacter(text: string, position: number): number { return moveCharacters(text, position, -1); }
export function characterAt(text: string, position: number): string { return text.slice(position, nextCharacter(text, position)); }
export function* iterateCharacters(text: string): IterableIterator<string> {
  for (const entry of segmenter.segment(text)) yield entry.segment;
}
export function countCharacters(text: string): number {
  let count = 0;
  const iterator = segmenter.segment(text)[Symbol.iterator]();
  while (!iterator.next().done) count++;
  return count;
}
export function characters(text: string): string[] { return Array.from(iterateCharacters(text)); }

export function displayWidth(text: string, tabstop = 4, initialColumn = 0): number {
  let column = initialColumn;
  for (const character of characters(text)) column += characterWidth(character, column, tabstop);
  return column - initialColumn;
}

export function offsetAtColumn(text: string, column: number, tabstop = 4): number {
  let width = 0;
  let offset = 0;
  for (const character of characters(text)) {
    const next = width + characterWidth(character, width, tabstop);
    if (next > column) break;
    width = next;
    offset += character.length;
  }
  return offset;
}

function characterWidth(character: string, column: number, tabstop: number): number {
  if (character === "\t") return tabstop - column % tabstop;
  if (/^\p{Mark}+$/u.test(character)) return 0;
  if (/\p{Extended_Pictographic}/u.test(character)) return 2;
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf
    || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff
    || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60
    || code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
}
