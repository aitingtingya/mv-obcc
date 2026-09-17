import { delimited } from "./ex";
import { compileVimPattern } from "./search";
import type { VimOptions } from "./types";

export function sortVimLines(lines: string[], argument: string, reverse: boolean, options: VimOptions, previousPattern: string): string[] {
  let flags = "";
  let pattern: RegExp | null = null;
  let tail = argument.trim();
  const leading = /^[a-z\s]*/u.exec(tail)![0];
  flags += leading.replace(/\s/gu, ""); tail = tail.slice(leading.length);
  if (tail) {
    const separator = tail[0];
    if (/[\w\\]/u.test(separator)) throw new Error("E488: Invalid sort argument");
    const parsed = delimited(tail, 1, separator);
    const source = parsed.value || previousPattern;
    if (!source) throw new Error("E35: No previous regular expression");
    pattern = compileVimPattern(source, { ...options, smartcase: false }, "");
    flags += tail.slice(parsed.end).replace(/\s/gu, "");
  }
  if (/[^bfinorux]/u.test(flags)) throw new Error(`Unsupported sort flags: ${flags}`);
  const numeric = [...new Set(flags)].filter((flag) => "nfxob".includes(flag));
  if (numeric.length > 1) throw new Error("E474: Sort numeric modes are mutually exclusive");
  const kind = numeric[0];
  const fold = (text: string) => flags.includes("i") ? text.toLowerCase() : text;
  const ranked = lines.map((text) => {
    const match = pattern?.exec(text);
    const key = fold(pattern ? match ? flags.includes("r") ? match[0] : text.slice(match.index + match[0].length) : "" : text);
    const token = kind === "n" ? /-?\d+/u.exec(key)?.[0] : kind === "x" ? /-?(?:0[xX])?[\da-fA-F]+/u.exec(key)?.[0]
      : kind === "o" ? /-?[0-7]+/u.exec(key)?.[0] : kind === "b" ? /-?[01]+/u.exec(key)?.[0]
        : kind === "f" ? /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/u.exec(key)?.[0] : undefined;
    const value = token === undefined ? Number.NEGATIVE_INFINITY : kind === "f" ? Number(token) : Number.parseInt(token, kind === "x" ? 16 : kind === "o" ? 8 : kind === "b" ? 2 : 10);
    return { text, key, value, missing: pattern !== null && !match };
  }).sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? -1 : 1;
    if (kind) return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
    return compareCodePoints(a.key, b.key);
  });
  if (reverse) ranked.reverse();
  return ranked.filter((entry, index) => !flags.includes("u") || index === 0 || fold(entry.text) !== fold(ranked[index - 1].text)).map(({ text }) => text);
}

function compareCodePoints(left: string, right: string): number {
  const a = [...left]; const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
