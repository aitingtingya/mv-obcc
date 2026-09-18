import { RunSyntaxError } from "./model";

export interface Token {
  value: string;
  kind: "word" | "," | ":";
  start: number;
  end: number;
  leadingQuoted: boolean;
}

/** Only metadata is lexed. The shell command after the first bare colon is opaque. */
export function tokenize(text: string, header = false, line?: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/u.test(text[index])) { index++; continue; }
    const start = index;
    const first = text[index];
    if (first === "," || (header && first === ":")) {
      tokens.push({ value: first, kind: first, start, end: ++index, leadingQuoted: false });
      if (first === ":") break;
      continue;
    }
    let value = "";
    while (index < text.length && !/\s/u.test(text[index]) && text[index] !== "," && !(header && text[index] === ":")) {
      const char = text[index++];
      if (char !== '"' && char !== "'") { value += char; continue; }
      let closed = false;
      while (index < text.length) {
        const next = text[index++];
        if (next === char) { closed = true; break; }
        if (next === "\\" && (text[index] === char || text[index] === "\\")) value += text[index++];
        else value += next;
      }
      if (!closed) throw new RunSyntaxError("Unclosed quote", start + 1, line);
    }
    tokens.push({ value, kind: "word", start, end: index, leadingQuoted: first === '"' || first === "'" });
  }
  return tokens;
}

export function quoteName(value: string): string {
  return /^[^\s,:'"@\\-][^\s,:'"\\]*$/u.test(value)
    ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
