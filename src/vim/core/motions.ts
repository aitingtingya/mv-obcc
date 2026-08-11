import type { VimBuffer } from "./types";

export interface VimMotion {
  target: number;
  inclusive: boolean;
  linewise: boolean;
  jump?: boolean;
}

export function horizontalMotion(
  buffer: VimBuffer,
  cursor: number,
  direction: -1 | 1,
  count: number,
): VimMotion {
  const line = buffer.lineAt(cursor);
  const maximum = Math.max(line.from, line.to - 1);
  return {
    target: clamp(cursor + direction * count, line.from, maximum),
    inclusive: direction > 0,
    linewise: false,
  };
}

export function verticalMotion(
  buffer: VimBuffer,
  cursor: number,
  direction: -1 | 1,
  count: number,
  desiredColumn?: number,
): VimMotion & { desiredColumn: number } {
  const source = buffer.lineAt(cursor);
  const column = desiredColumn ?? Math.max(0, cursor - source.from);
  const targetLine = buffer.line(source.number + direction * count);
  const target = Math.min(targetLine.from + column, Math.max(targetLine.from, targetLine.to - 1));
  return {
    target,
    desiredColumn: column,
    inclusive: false,
    linewise: true,
  };
}

export function lineBoundaryMotion(
  buffer: VimBuffer,
  cursor: number,
  boundary: "start" | "first-nonblank" | "end" | "last-nonblank",
): VimMotion {
  const line = buffer.lineAt(cursor);
  let target = line.from;
  if (boundary === "first-nonblank") {
    const offset = line.text.search(/\S/);
    target = offset < 0 ? line.from : line.from + offset;
  } else if (boundary === "end") {
    target = Math.max(line.from, line.to - 1);
  } else if (boundary === "last-nonblank") {
    const match = line.text.match(/\S(?=\s*$)/);
    target = match?.index === undefined ? line.from : line.from + match.index;
  }
  return {
    target,
    inclusive: boundary === "end" || boundary === "last-nonblank",
    linewise: false,
  };
}

export function lineNumberMotion(
  buffer: VimBuffer,
  lineNumber: number,
): VimMotion {
  const line = buffer.line(lineNumber);
  const offset = line.text.search(/\S/);
  return {
    target: offset < 0 ? line.from : line.from + offset,
    inclusive: false,
    linewise: true,
    jump: true,
  };
}

export function wordMotion(
  buffer: VimBuffer,
  cursor: number,
  direction: "forward" | "backward" | "end",
  count: number,
  bigWord: boolean,
): VimMotion {
  const text = buffer.text();
  let target = cursor;
  for (let iteration = 0; iteration < count; iteration += 1) {
    target = direction === "forward"
      ? nextWordStart(text, target, bigWord)
      : direction === "backward"
        ? previousWordStart(text, target, bigWord)
        : nextWordEnd(text, target, bigWord);
  }
  return {
    target,
    inclusive: direction === "end",
    linewise: false,
  };
}

export function paragraphMotion(
  buffer: VimBuffer,
  cursor: number,
  direction: -1 | 1,
  count: number,
): VimMotion {
  let lineNumber = buffer.lineAt(cursor).number;
  for (let iteration = 0; iteration < count; iteration += 1) {
    lineNumber = findParagraphBoundary(buffer, lineNumber, direction);
  }
  return {
    target: buffer.line(lineNumber).from,
    inclusive: false,
    linewise: true,
    jump: true,
  };
}

export function sentenceMotion(
  buffer: VimBuffer,
  cursor: number,
  direction: -1 | 1,
  count: number,
): VimMotion {
  const text = buffer.text();
  let target = cursor;
  for (let iteration = 0; iteration < count; iteration += 1) {
    target = direction > 0
      ? nextSentenceStart(text, target)
      : previousSentenceStart(text, target);
  }
  return { target, inclusive: false, linewise: false, jump: true };
}

export function matchingBracketMotion(
  buffer: VimBuffer,
  cursor: number,
): VimMotion | null {
  const text = buffer.text();
  const line = buffer.lineAt(cursor);
  let bracketPosition = -1;
  for (let position = cursor; position < line.to; position += 1) {
    if ("()[]{}".includes(text[position] ?? "")) {
      bracketPosition = position;
      break;
    }
  }
  if (bracketPosition < 0) return null;
  const bracket = text[bracketPosition];
  const pairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    ")": "(",
    "]": "[",
    "}": "{",
  };
  const partner = pairs[bracket];
  const direction = "([{".includes(bracket) ? 1 : -1;
  let depth = 0;
  for (
    let position = bracketPosition;
    position >= 0 && position < text.length;
    position += direction
  ) {
    const char = text[position];
    if (char === bracket) depth += 1;
    if (char === partner) depth -= 1;
    if (depth === 0) {
      return {
        target: position,
        inclusive: true,
        linewise: false,
        jump: true,
      };
    }
  }
  return null;
}

export function findCharacterMotion(
  buffer: VimBuffer,
  cursor: number,
  character: string,
  direction: -1 | 1,
  count: number,
  till: boolean,
): VimMotion | null {
  const line = buffer.lineAt(cursor);
  const text = buffer.text();
  let position = cursor;
  for (let iteration = 0; iteration < count; iteration += 1) {
    let found = -1;
    if (direction > 0) {
      found = text.indexOf(character, position + 1);
      if (found < 0 || found >= line.to) return null;
    } else {
      found = text.lastIndexOf(character, position - 1);
      if (found < line.from) return null;
    }
    position = found;
  }
  if (till) position -= direction;
  return {
    target: position,
    inclusive: !till,
    linewise: false,
  };
}

export function columnMotion(
  buffer: VimBuffer,
  cursor: number,
  oneBasedColumn: number,
): VimMotion {
  const line = buffer.lineAt(cursor);
  return {
    target: Math.min(line.from + Math.max(0, oneBasedColumn - 1), Math.max(line.from, line.to - 1)),
    inclusive: false,
    linewise: false,
  };
}

function nextWordStart(text: string, cursor: number, bigWord: boolean): number {
  if (cursor >= text.length) return text.length;
  let position = nextCharacter(text, cursor);
  const startClass = wordClass(text[position] ?? "", bigWord);
  if (startClass !== "space") {
    while (position < text.length && wordClass(text[position] ?? "", bigWord) === startClass) {
      position = nextCharacter(text, position);
    }
  }
  while (position < text.length && wordClass(text[position] ?? "", bigWord) === "space") {
    position = nextCharacter(text, position);
  }
  return Math.min(position, text.length);
}

function previousWordStart(text: string, cursor: number, bigWord: boolean): number {
  if (cursor <= 0) return 0;
  let position = previousCharacter(text, cursor);
  while (position > 0 && wordClass(text[position] ?? "", bigWord) === "space") {
    position = previousCharacter(text, position);
  }
  const targetClass = wordClass(text[position] ?? "", bigWord);
  while (position > 0) {
    const previous = previousCharacter(text, position);
    if (wordClass(text[previous] ?? "", bigWord) !== targetClass) break;
    position = previous;
  }
  return position;
}

function nextWordEnd(text: string, cursor: number, bigWord: boolean): number {
  if (text.length === 0) return 0;
  let position = Math.min(nextCharacter(text, cursor), text.length - 1);
  while (position < text.length - 1 && wordClass(text[position] ?? "", bigWord) === "space") {
    position = nextCharacter(text, position);
  }
  const targetClass = wordClass(text[position] ?? "", bigWord);
  while (position < text.length - 1) {
    const next = nextCharacter(text, position);
    if (wordClass(text[next] ?? "", bigWord) !== targetClass) break;
    position = next;
  }
  return position;
}

function wordClass(character: string, bigWord: boolean): "space" | "word" | "punctuation" {
  if (/\s/u.test(character)) return "space";
  if (bigWord || /[\p{L}\p{N}_]/u.test(character)) return "word";
  return "punctuation";
}

function findParagraphBoundary(
  buffer: VimBuffer,
  startingLine: number,
  direction: -1 | 1,
): number {
  let lineNumber = startingLine + direction;
  while (lineNumber >= 1 && lineNumber <= buffer.lineCount) {
    const blank = buffer.line(lineNumber).text.trim().length === 0;
    if (blank) {
      while (
        lineNumber + direction >= 1 &&
        lineNumber + direction <= buffer.lineCount &&
        buffer.line(lineNumber + direction).text.trim().length === 0
      ) {
        lineNumber += direction;
      }
      return lineNumber;
    }
    lineNumber += direction;
  }
  return direction > 0 ? buffer.lineCount : 1;
}

function nextSentenceStart(text: string, cursor: number): number {
  const match = /[.!?][\])"']*(?:\s+|$)/gu;
  match.lastIndex = Math.min(text.length, cursor + 1);
  const found = match.exec(text);
  if (!found) return text.length;
  let position = found.index + found[0].length;
  while (position < text.length && /\s/u.test(text[position] ?? "")) position += 1;
  return position;
}

function previousSentenceStart(text: string, cursor: number): number {
  const prefix = text.slice(0, Math.max(0, cursor));
  const match = /(?:^|[.!?][\])"']*\s+)(\S)/gu;
  let result = 0;
  for (const candidate of prefix.matchAll(match)) {
    if (candidate.index === undefined) continue;
    result = candidate.index + candidate[0].lastIndexOf(candidate[1]);
  }
  return result;
}

function nextCharacter(text: string, position: number): number {
  if (position >= text.length) return text.length;
  const code = text.codePointAt(position);
  return Math.min(text.length, position + (code !== undefined && code > 0xffff ? 2 : 1));
}

function previousCharacter(text: string, position: number): number {
  if (position <= 0) return 0;
  const candidate = position - 1;
  const code = text.charCodeAt(candidate);
  return code >= 0xdc00 && code <= 0xdfff ? Math.max(0, candidate - 1) : candidate;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
