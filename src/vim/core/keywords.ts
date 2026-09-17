import { DEFAULT_VIM_OPTIONS } from "./types";

const cache = new Map<string, { source: string; test: RegExp }>();

/** The same iskeyword contract drives motions, text objects and pattern atoms. */
export function keywordSource(option = DEFAULT_VIM_OPTIONS.iskeyword): string {
  const previous = cache.get(option);
  if (previous) return previous.source;
  let source = "(?!)";
  for (const item of option.split(",")) {
    if (!item) continue;
    const exclude = item.startsWith("^") && item.length > 1;
    const part = exclude ? item.slice(1) : item;
    let atom: string;
    if (part === "@") atom = "\\p{L}";
    else {
      const range = /^(\d+|.)(?:-(\d+|.))?$/u.exec(part);
      if (!range) throw new Error(`E474: Invalid iskeyword item: ${item}`);
      const code = (value: string) => /^\d+$/u.test(value) ? Number(value) : value.codePointAt(0)!;
      const from = code(range[1]); const to = range[2] ? code(range[2]) : from;
      if (from < 0 || to > 0x10ffff || from > to) throw new Error(`E474: Invalid iskeyword range: ${item}`);
      atom = `[\\u{${from.toString(16)}}${to === from ? "" : `-\\u{${to.toString(16)}}`}]`;
    }
    source = exclude ? `(?:(?!${atom})${source})` : `(?:${source}|${atom})`;
  }
  if (cache.size >= 32) cache.clear();
  cache.set(option, { source, test: new RegExp(`^(?:${source})`, "u") });
  return source;
}

export function wordClass(character: string, bigWord = false, option = DEFAULT_VIM_OPTIONS.iskeyword): "space" | "word" | "punctuation" {
  if (!character || /\s/u.test(character)) return "space";
  keywordSource(option);
  return bigWord || cache.get(option)!.test.test(character) ? "word" : "punctuation";
}
