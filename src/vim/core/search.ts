import type { VimOptions } from "./types";
import { keywordSource } from "./keywords";

export interface VimMatch { from: number; to: number; text: string; groups: readonly (string | undefined)[] }

/** Compile the Vim pattern vocabulary explicitly; unsupported atoms fail loudly. */
export function compileVimPattern(pattern: string, options: VimOptions, flags = "g"): RegExp {
  let magic: "magic" | "nomagic" | "verymagic" | "literal" = options.magic ? "magic" : "nomagic";
  let ignorecase = options.ignorecase && !(options.smartcase && /[A-Z]/u.test(pattern));
  let output = "";
  let start = -1;
  let end = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[++index];
      if (next === undefined) { output += "\\\\"; break; }
      if (next === "c" || next === "C") { ignorecase = next === "c"; continue; }
      if (["m", "M", "v", "V"].includes(next)) {
        magic = next === "m" ? "magic" : next === "M" ? "nomagic" : next === "v" ? "verymagic" : "literal";
        continue;
      }
      if (next === "z" && (pattern[index + 1] === "s" || pattern[index + 1] === "e")) {
        if (pattern[++index] === "s") start = output.length; else end = output.length;
        continue;
      }
      if (next === "<" || next === ">") {
        const word = keywordSource(options.iskeyword);
        output += next === "<" ? `(?<!${word})(?=${word})` : `(?<=${word})(?!${word})`;
      } else if (next === "_") {
        const atom = pattern[++index];
        if (atom === ".") output += "[\\s\\S]";
        else if (atom && /[swd]/iu.test(atom)) output += `(?:\\${atom}|\\n)`;
        else throw new Error(`Unsupported Vim pattern atom: \\_${atom ?? ""}`);
      } else if (next === "n") output += "\\n";
      else if (next === "t") output += "\\t";
      else if (next === "r") output += "\\r";
      else if (/[1-9sSdDwW]/u.test(next)) output += `\\${next}`;
      else if (next === "k") output += keywordSource(options.iskeyword);
      else if (next === "a") output += "[A-Za-z]";
      else if (next === "x") output += "[0-9A-Fa-f]";
      else if (next === "o") output += "[0-7]";
      else if (next === "{" && magic !== "verymagic") {
        const quantifier = /^(-?)(\d*)(,\d*)?\}/u.exec(pattern.slice(index + 1));
        if (!quantifier) throw new Error("E554: Syntax error in Vim repetition");
        const body = `${quantifier[2]}${quantifier[3] ?? ""}`;
        output += body ? `{${body.startsWith(",") ? "0" : ""}${body}}` : "*";
        if (quantifier[1]) output += "?";
        index += quantifier[0].length;
      }
      else if ("()|+?={}".includes(next) && magic !== "verymagic") output += next === "=" ? "?" : next;
      else if (next === "[" && magic === "nomagic") {
        const collection = compileCollection(pattern, index);
        output += collection.source; index = collection.end;
      }
      else if (".*".includes(next) && magic === "nomagic") output += next;
      else if (/[A-Za-z%@]/u.test(next)) throw new Error(`Unsupported Vim pattern atom: \\${next}`);
      else output += escapeRegex(next);
    } else if (char === "[" && (magic === "magic" || magic === "verymagic")) {
      const collection = compileCollection(pattern, index);
      output += collection.source; index = collection.end;
    } else {
      const active = magic === "verymagic" ? ".*+?(){}|^$" : magic === "magic" ? ".*^$" : magic === "nomagic" ? "^$" : "";
      output += active.includes(char) ? char : escapeRegex(char);
    }
  }
  if (end >= 0) output = `${output.slice(0, end)}(?=${output.slice(end)})`;
  if (start >= 0) output = `(?<=${output.slice(0, start)})${output.slice(start)}`;
  return new RegExp(output, `${flags.replace(/[iu]/gu, "")}${ignorecase ? "i" : ""}mu`);
}

const COLLECTION_CLASSES: Readonly<Record<string, string>> = {
  alnum: "A-Za-z0-9", alpha: "A-Za-z", blank: " \\t", cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9", graph: "\\x21-\\x7e", lower: "\\p{Ll}", upper: "\\p{Lu}",
  print: "\\x20-\\x7e", punct: "\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e",
  space: " \\t\\r\\n\\v\\f", xdigit: "0-9A-Fa-f", return: "\\r", tab: "\\t",
  escape: "\\x1b", backspace: "\\x08",
};

/** A Vim collection is not a JavaScript class (notably [:digit:] and initial ]). */
function compileCollection(pattern: string, opening: number): { source: string; end: number } {
  let index = opening + 1;
  let body = "";
  if (pattern[index] === "^") { body = "^"; index += 1; }
  if (pattern[index] === "]") { body += "\\]"; index += 1; }
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]") return { source: `[${body}]`, end: index };
    if (char === "[" && pattern[index + 1] === ":") {
      const close = pattern.indexOf(":]", index + 2);
      if (close < 0) throw new Error("E769: Missing ] after character class");
      const name = pattern.slice(index + 2, close);
      const source = COLLECTION_CLASSES[name];
      if (!source) throw new Error(`Unsupported Vim character class: [:${name}:]`);
      body += source; index = close + 1;
    } else if (char === "[" && (pattern[index + 1] === "=" || pattern[index + 1] === ".")) {
      throw new Error("Unsupported Vim equivalence/collation class");
    } else if (char === "\\") {
      const next = pattern[++index];
      if (next === undefined) break;
      const escaped: Readonly<Record<string, string>> = { n: "\\n", r: "\\r", t: "\\t", b: "\\x08", e: "\\x1b" };
      if (escaped[next]) body += escaped[next];
      else if ("\\^-]".includes(next)) body += `\\${next}`;
      else if ("doxuU".includes(next)) throw new Error(`Unsupported numeric Vim collection escape: \\${next}`);
      else body += `\\\\${next === "[" ? "\\[" : next}`;
    } else body += char === "[" ? "\\[" : char;
  }
  throw new Error("E769: Missing ] after [");
}

export function findVimMatches(text: string, pattern: string, options: VimOptions): VimMatch[] {
  return [...text.matchAll(compileVimPattern(pattern, options))].map((match) => ({
    from: match.index, to: match.index + match[0].length, text: match[0], groups: match.slice(1),
  }));
}

export function vimReplacement(template: string, match: VimMatch): string {
  let output = "";
  let casing: "upper" | "lower" | "" = "";
  let once: "upper" | "lower" | "" = "";
  const append = (text: string) => {
    if (casing) text = casing === "upper" ? text.toLocaleUpperCase() : text.toLocaleLowerCase();
    if (once && text) {
      const first = [...text][0];
      text = (once === "upper" ? first.toLocaleUpperCase() : first.toLocaleLowerCase()) + text.slice(first.length);
      once = "";
    }
    output += text;
  };
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    if (char === "&") append(match.text);
    else if (char !== "\\") append(char);
    else {
      const next = template[++index] ?? "\\";
      if (next === "u" || next === "l") once = next === "u" ? "upper" : "lower";
      else if (next === "U" || next === "L") casing = next === "U" ? "upper" : "lower";
      else if (next === "e" || next === "E") { once = ""; casing = ""; }
      else if (/^[0-9]$/u.test(next)) append(next === "0" ? match.text : match.groups[Number(next) - 1] ?? "");
      else append(next === "r" ? "\n" : next === "n" ? "\0" : next === "t" ? "\t" : next);
    }
  }
  return output;
}

export function escapeVimLiteral(text: string): string { return `\\V${text.replace(/\\/gu, "\\\\")}`; }
function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
