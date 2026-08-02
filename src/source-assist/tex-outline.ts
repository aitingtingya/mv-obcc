import type { HeadingCache } from "obsidian";

/**
 * Pure LaTeX section parser used by both the Outline injection and the
 * editor fold service. No side effects; safe to unit test standalone.
 */

export interface TexSection {
  /** Cleaned human-readable title text (commands/comments stripped). */
  heading: string;
  /** Native LaTeX level: part=0, chapter=1, section=2, ..., subparagraph=6. */
  latexLevel: number;
  /** 0-based line of the heading text start. */
  line: number;
  /** 0-based column of the heading text start (after the opening `{`). */
  col: number;
  /** Character offset (UTF-16) of the heading text start. */
  offset: number;
  /** Character offset of the `\command` start. */
  commandOffset: number;
}

const LATEX_LEVEL: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

// Word-boundary anchor keeps `\sectionfoo` from matching while allowing
// `\section*`, `\section[..]`, `\section{..}` and trailing whitespace.
const TEX_SECTION_COMMAND_RE =
  /\\\s*(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\b/;

const SPECIAL_ESCAPES: Record<string, string> = {
  "{": "{",
  "}": "}",
  "\\": "\\",
  "%": "%",
  "&": "&",
  "#": "#",
  "$": "$",
  "_": "_",
  " ": " ",
  "~": " ",
  "^": "^",
};

function skipSpaces(line: string, index: number): number {
  let i = index;
  while (i < line.length && /\s/.test(line[i])) i++;
  return i;
}

/** Index of the matching `]` for a `[` at openIndex, or -1. */
function findClosingBracket(line: string, openIndex: number): number {
  for (let i = openIndex + 1; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "]") return i;
    if (line[i] === "\n") break;
  }
  return -1;
}

/**
 * Index of the matching `}` (nesting-aware) for a `{` at openIndex, or -1.
 * A `%` starts a trailing comment: braces inside the comment are ignored,
 * but the first unpaired `}` after it still closes the title (so
 * `\subsection{Title % hidden}` yields title "Title").
 */
function findClosingBrace(line: string, openIndex: number): number {
  let depth = 0;
  let inComment = false;
  for (let i = openIndex; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inComment) {
      if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
      continue;
    }
    if (ch === "%") {
      inComment = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when `index` lies inside an unescaped `%` comment. */
function indexInComment(line: string, index: number): boolean {
  for (let i = 0; i < index; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "%") return true;
  }
  return false;
}

function cleanTexTitle(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break;
      if (SPECIAL_ESCAPES[next] !== undefined) {
        out += SPECIAL_ESCAPES[next];
        i += 2;
        continue;
      }
      // Command name: drop the name, keep a braced argument's content.
      const nameMatch = /^[a-zA-Z@]+/.exec(raw.slice(i + 1));
      if (nameMatch) {
        let j = i + 1 + nameMatch[0].length;
        if (raw[j] === "*") j++;
        if (raw[j] === "[") {
          const close = findClosingBracket(raw, j);
          if (close >= 0) j = close + 1;
        }
        if (raw[j] === "{") {
          const close = findClosingBrace(raw, j);
          if (close >= 0) {
            out += cleanTexTitle(raw.slice(j + 1, close));
            j = close + 1;
          }
        }
        i = j;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "%") break; // trailing comment
    if (ch === "$" || ch === "~") {
      if (ch === "~") out += " ";
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function parseTexSections(content: string): TexSection[] {
  const lines = content.split("\n");
  const sections: TexSection[] = [];
  let lineOffset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const match = TEX_SECTION_COMMAND_RE.exec(line);
    if (!match) {
      lineOffset += line.length + 1;
      continue;
    }
    if (indexInComment(line, match.index)) {
      lineOffset += line.length + 1;
      continue;
    }
    const command = match[1];
    let cursor = skipSpaces(line, match.index + match[0].length);
    if (line[cursor] === "*") cursor = skipSpaces(line, cursor + 1);
    if (line[cursor] === "[") {
      const close = findClosingBracket(line, cursor);
      if (close < 0) {
        lineOffset += line.length + 1;
        continue;
      }
      cursor = skipSpaces(line, close + 1);
    }
    if (line[cursor] !== "{") {
      lineOffset += line.length + 1;
      continue;
    }
    const close = findClosingBrace(line, cursor);
    if (close < 0) {
      lineOffset += line.length + 1;
      continue;
    }
    const heading = cleanTexTitle(line.slice(cursor + 1, close));
    if (!heading) {
      lineOffset += line.length + 1;
      continue;
    }
    let titleStart = cursor + 1;
    while (titleStart < close && /\s/.test(line[titleStart])) titleStart++;
    sections.push({
      heading,
      latexLevel: LATEX_LEVEL[command],
      line: lineIndex,
      col: titleStart,
      offset: lineOffset + titleStart,
      commandOffset: lineOffset + match.index,
    });
    lineOffset += line.length + 1;
  }
  return sections;
}

/**
 * Map LaTeX levels onto Obsidian heading levels (1-6) using relative-top
 * normalization: the highest LaTeX level present in the document becomes
 * level 1, keeping the relative nesting intact (article: section=1,
 * book: chapter=1).
 */
export function texSectionsToHeadings(sections: TexSection[]): HeadingCache[] {
  if (sections.length === 0) return [];
  const minLevel = Math.min(...sections.map((section) => section.latexLevel));
  return sections.map((section) => {
    const level = Math.max(
      1,
      Math.min(6, section.latexLevel - minLevel + 1),
    );
    const end = {
      line: section.line,
      col: section.col + section.heading.length,
      offset: section.offset + section.heading.length,
    };
    return {
      heading: section.heading,
      level,
      position: {
        start: { line: section.line, col: section.col, offset: section.offset },
        end,
      },
    };
  });
}

export interface TexSectionLineSpans {
  /** Native LaTeX level: part=0, chapter=1, section=2, ..., subparagraph=6. */
  latexLevel: number;
  /** Index of the `\` starting the command. */
  commandStart: number;
  /** Index of the `{` opening the title. */
  titleBraceOpen: number;
  /** Index of the `}` closing the title. */
  titleBraceClose: number;
}

/**
 * Single-line section match with raw source spans, for editor decorations.
 * The brace indices bracket the raw title so callers can hide the
 * `\command{...}` shell while leaving the title text in place.
 */
export function matchTexSectionLineSpans(
  line: string,
): TexSectionLineSpans | null {
  if (/^\s*%/.test(line)) return null; // whole-line comment
  const match = TEX_SECTION_COMMAND_RE.exec(line);
  if (!match) return null;
  if (indexInComment(line, match.index)) return null;
  let cursor = skipSpaces(line, match.index + match[0].length);
  if (line[cursor] === "*") cursor = skipSpaces(line, cursor + 1);
  if (line[cursor] === "[") {
    const close = findClosingBracket(line, cursor);
    if (close < 0) return null;
    cursor = skipSpaces(line, close + 1);
  }
  if (line[cursor] !== "{") return null;
  const braceClose = findClosingBrace(line, cursor);
  if (braceClose < 0) return null;
  return {
    latexLevel: LATEX_LEVEL[match[1]],
    commandStart: match.index,
    titleBraceOpen: cursor,
    titleBraceClose: braceClose,
  };
}

/** Lightweight single-line match used by the editor fold service. */
export function matchTexSectionLine(
  line: string,
): { latexLevel: number } | null {
  const spans = matchTexSectionLineSpans(line);
  return spans ? { latexLevel: spans.latexLevel } : null;
}

export function isTexExtension(extension: string): boolean {
  return extension.toLowerCase() === "tex";
}
