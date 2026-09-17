import type { VimBuffer } from "./types";

export interface ExRange { first: number; last: number; explicit: boolean }
export interface ExCommand { range: ExRange; name: string; bang: boolean; argument: string }

export function parseExCommand(
  source: string, buffer: VimBuffer, current: number,
  mark: (name: string) => number | undefined,
  search: (pattern: string, direction: -1 | 1, from: number) => number,
): ExCommand {
  let index = 0;
  let dot = current;
  const skip = () => { while (/\s/u.test(source[index] ?? "") && index < source.length) index += 1; };
  const address = (): number | null => {
    skip();
    let value: number | null = null;
    const char = source[index];
    if (char === ".") { value = dot; index += 1; }
    else if (char === "$") { value = buffer.lineCount; index += 1; }
    else if (char === "'") {
      const name = source[++index]; index += 1;
      const position = mark(name);
      if (position === undefined) throw new Error(`E20: Mark not set: ${name}`);
      value = buffer.lineAt(position).number;
    } else if (char === "/" || char === "?") {
      const parsed = delimited(source, index + 1, char);
      value = search(parsed.value, char === "/" ? 1 : -1, dot);
      index = parsed.end;
    } else {
      const number = /^\d+/u.exec(source.slice(index));
      if (number) { value = Number(number[0]); index += number[0].length; }
      else if (char === "+" || char === "-") value = dot;
    }
    if (value === null) return null;
    while (source[index] === "+" || source[index] === "-") {
      const direction = source[index++] === "+" ? 1 : -1;
      const number = /^\d+/u.exec(source.slice(index));
      value += direction * Number(number?.[0] ?? 1);
      index += number?.[0].length ?? 0;
    }
    if (value < 0 || value > buffer.lineCount) throw new Error("E16: Invalid range");
    return value;
  };
  skip();
  let range: ExRange;
  if (source[index] === "%") { index += 1; range = { first: 1, last: buffer.lineCount, explicit: true }; }
  else {
    const first = address();
    skip();
    const separator = source[index];
    if (separator === "," || separator === ";") {
      index += 1;
      if (separator === ";") dot = first ?? current;
      range = { first: first ?? current, last: address() ?? buffer.lineCount, explicit: true };
    } else range = { first: first ?? current, last: first ?? current, explicit: first !== null };
  }
  if (range.first > range.last) throw new Error("E16: Invalid range");
  skip();
  const command = /^[A-Za-z]+|[!&~<>]/u.exec(source.slice(index));
  const name = command?.[0] ?? "";
  index += name.length;
  const bang = source[index] === "!" && name !== "!";
  if (bang) index += 1;
  return { range, name, bang, argument: source.slice(index).trimStart() };
}

export function delimited(source: string, start: number, delimiter: string): { value: string; end: number } {
  let value = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length) {
      const next = source[++index];
      value += next === delimiter ? next : `\\${next}`;
    } else if (char === delimiter) return { value, end: index + 1 };
    else value += char;
  }
  return { value, end: source.length };
}

export interface SubstituteSpec { pattern: string; replacement: string; flags: string; count?: number }
export function parseVimSubstitute(argument: string): SubstituteSpec {
  const delimiter = argument[0];
  if (!delimiter || /[\w\s\\]/u.test(delimiter)) throw new Error("E146: Invalid substitute delimiter");
  const pattern = delimited(argument, 1, delimiter);
  const replacement = delimited(argument, pattern.end, delimiter);
  const tail = argument.slice(replacement.end).trim();
  const parsed = /^([gciIne]*)(?:\s*(\d+))?$/u.exec(tail);
  if (!parsed) throw new Error(`Unsupported substitute flags: ${tail}`);
  const count = parsed[2] === undefined ? undefined : Number(parsed[2]);
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) throw new Error("E939: Positive count required");
  return { pattern: pattern.value, replacement: replacement.value, flags: parsed[1], ...(count === undefined ? {} : { count }) };
}
