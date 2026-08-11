import type { VimBuffer } from "./types";

export interface VimTextObjectRange {
  from: number;
  to: number;
  linewise: boolean;
}

export function textObjectRange(
  buffer: VimBuffer,
  cursor: number,
  object: string,
  around: boolean,
  count = 1,
): VimTextObjectRange | null {
  if (object === "w" || object === "W") {
    return wordObject(buffer.text(), cursor, around, object === "W", count);
  }
  if (object === "p") return paragraphObject(buffer, cursor, around, count);
  if (object === "s") return sentenceObject(buffer.text(), cursor, around, count);
  const delimiter = delimiterPair(object);
  if (delimiter) {
    return pairObject(buffer.text(), cursor, delimiter[0], delimiter[1], around, count);
  }
  if ('"\'`'.includes(object)) {
    return quoteObject(buffer, cursor, object, around);
  }
  return null;
}

function wordObject(
  text: string,
  cursor: number,
  around: boolean,
  bigWord: boolean,
  count: number,
): VimTextObjectRange | null {
  if (text.length === 0) return null;
  let from = Math.min(cursor, text.length - 1);
  const classify = (character: string) => {
    if (/\s/u.test(character)) return "space";
    if (bigWord || /[\p{L}\p{N}_]/u.test(character)) return "word";
    return "punctuation";
  };
  const targetClass = classify(text[from] ?? "");
  while (from > 0 && classify(text[from - 1] ?? "") === targetClass) from -= 1;
  let to = from;
  for (let iteration = 0; iteration < count; iteration += 1) {
    const currentClass = classify(text[to] ?? "");
    while (to < text.length && classify(text[to] ?? "") === currentClass) to += 1;
    if (iteration + 1 < count) {
      while (to < text.length && classify(text[to] ?? "") === "space") to += 1;
    }
  }
  if (around) {
    let trailing = to;
    while (trailing < text.length && /[ \t]/u.test(text[trailing] ?? "")) trailing += 1;
    if (trailing > to) {
      to = trailing;
    } else {
      while (from > 0 && /[ \t]/u.test(text[from - 1] ?? "")) from -= 1;
    }
  }
  return { from, to, linewise: false };
}

function paragraphObject(
  buffer: VimBuffer,
  cursor: number,
  around: boolean,
  count: number,
): VimTextObjectRange {
  let first = buffer.lineAt(cursor).number;
  while (first > 1 && buffer.line(first - 1).text.trim().length > 0) first -= 1;
  let last = buffer.lineAt(cursor).number;
  for (let paragraph = 0; paragraph < count; paragraph += 1) {
    while (last < buffer.lineCount && buffer.line(last + 1).text.trim().length > 0) last += 1;
    if (paragraph + 1 < count) {
      while (last < buffer.lineCount && buffer.line(last + 1).text.trim().length === 0) last += 1;
      if (last < buffer.lineCount) last += 1;
    }
  }
  if (around) {
    while (last < buffer.lineCount && buffer.line(last + 1).text.trim().length === 0) last += 1;
  }
  const startLine = buffer.line(first);
  const endLine = buffer.line(last);
  return {
    from: startLine.from,
    to: last < buffer.lineCount ? endLine.to + 1 : endLine.to,
    linewise: true,
  };
}

function sentenceObject(
  text: string,
  cursor: number,
  around: boolean,
  count: number,
): VimTextObjectRange | null {
  if (text.length === 0) return null;
  let from = 0;
  const boundary = /[.!?][\])"']*\s+/gu;
  for (const match of text.matchAll(boundary)) {
    if (match.index === undefined || match.index >= cursor) break;
    from = match.index + match[0].length;
  }
  let to = text.length;
  boundary.lastIndex = Math.max(0, cursor);
  for (let iteration = 0; iteration < count; iteration += 1) {
    const match = boundary.exec(text);
    if (!match) {
      to = text.length;
      break;
    }
    to = match.index + (around ? match[0].length : match[0].trimEnd().length);
  }
  return { from, to, linewise: false };
}

function pairObject(
  text: string,
  cursor: number,
  open: string,
  close: string,
  around: boolean,
  count: number,
): VimTextObjectRange | null {
  let from = -1;
  let depth = 0;
  for (let position = Math.min(cursor, text.length - 1); position >= 0; position -= 1) {
    if (text[position] === close) depth += 1;
    if (text[position] === open) {
      if (depth === 0) {
        from = position;
        break;
      }
      depth -= 1;
    }
  }
  if (from < 0) return null;
  let to = -1;
  depth = 0;
  for (let position = from; position < text.length; position += 1) {
    if (text[position] === open) depth += 1;
    if (text[position] === close) {
      depth -= 1;
      if (depth === 0) {
        to = position + 1;
        break;
      }
    }
  }
  if (to < 0) return null;
  for (let iteration = 1; iteration < count; iteration += 1) {
    const outer = pairObject(text, Math.max(0, from - 1), open, close, true, 1);
    if (!outer || outer.from === from) break;
    from = outer.from;
    to = outer.to;
  }
  return around
    ? { from, to, linewise: false }
    : { from: from + open.length, to: to - close.length, linewise: false };
}

function quoteObject(
  buffer: VimBuffer,
  cursor: number,
  quote: string,
  around: boolean,
): VimTextObjectRange | null {
  const line = buffer.lineAt(cursor);
  const offset = cursor - line.from;
  let left = line.text.lastIndexOf(quote, offset);
  if (left === offset) left = line.text.lastIndexOf(quote, offset - 1);
  if (left < 0) return null;
  const right = line.text.indexOf(quote, Math.max(offset + 1, left + 1));
  if (right < 0) return null;
  return around
    ? { from: line.from + left, to: line.from + right + 1, linewise: false }
    : { from: line.from + left + 1, to: line.from + right, linewise: false };
}

function delimiterPair(object: string): readonly [string, string] | null {
  if (object === "(" || object === ")" || object === "b") return ["(", ")"];
  if (object === "[" || object === "]") return ["[", "]"];
  if (object === "{" || object === "}" || object === "B") return ["{", "}"];
  if (object === "<" || object === ">") return ["<", ">"];
  return null;
}
