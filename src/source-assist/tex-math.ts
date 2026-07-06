import type { EditorState } from "@codemirror/state";

export interface SourceAssistMathBound {
  inner_start: number;
  inner_end: number;
  outer_start: number;
  outer_end: number;
  display: boolean;
  kind:
    | "paren-inline"
    | "bracket-display"
    | "dollar-display"
    | "environment-display";
}

const TEX_DISPLAY_ENVIRONMENTS = new Set([
  "align",
  "alignat",
  "displaymath",
  "equation",
  "eqnarray",
  "flalign",
  "gather",
  "math",
  "multline",
  "split",
]);

export function texMathBounds(state: EditorState): SourceAssistMathBound[] {
  const source = state.doc.toString();
  const bounds = [
    ...scanPairedDelimiter(source, "\\(", "\\)", false, "paren-inline"),
    ...scanPairedDelimiter(source, "\\[", "\\]", true, "bracket-display"),
    ...scanPairedDelimiter(source, "$$", "$$", true, "dollar-display"),
    ...scanDisplayEnvironments(source),
  ].sort((a, b) => a.outer_start - b.outer_start || a.outer_end - b.outer_end);

  const deduped: SourceAssistMathBound[] = [];
  for (const bound of bounds) {
    const previous = deduped.at(-1);
    if (previous && bound.outer_start < previous.outer_end) continue;
    if (bound.inner_start >= bound.inner_end) continue;
    deduped.push(bound);
  }
  return deduped;
}

export function texMathBoundAt(
  state: EditorState,
  pos: number,
): SourceAssistMathBound | null {
  return (
    texMathBounds(state).find(
      (bound) => pos > bound.inner_start && pos < bound.inner_end,
    ) ?? null
  );
}

function scanPairedDelimiter(
  source: string,
  open: string,
  close: string,
  display: boolean,
  kind: SourceAssistMathBound["kind"],
): SourceAssistMathBound[] {
  const bounds: SourceAssistMathBound[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const openAt = source.indexOf(open, searchFrom);
    if (openAt === -1) break;
    const innerStart = openAt + open.length;
    const closeAt = source.indexOf(close, innerStart);
    if (closeAt === -1) break;
    bounds.push({
      inner_start: innerStart,
      inner_end: closeAt,
      outer_start: openAt,
      outer_end: closeAt + close.length,
      display,
      kind,
    });
    searchFrom = closeAt + close.length;
  }
  return bounds;
}

function scanDisplayEnvironments(source: string): SourceAssistMathBound[] {
  const bounds: SourceAssistMathBound[] = [];
  const beginPattern = /\\begin\{([A-Za-z]+)(\*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = beginPattern.exec(source)) !== null) {
    const baseName = match[1]?.toLowerCase() ?? "";
    if (!TEX_DISPLAY_ENVIRONMENTS.has(baseName)) continue;
    const envName = `${match[1]}${match[2] ?? ""}`;
    const close = `\\end{${envName}}`;
    const innerStart = match.index + match[0].length;
    const closeAt = source.indexOf(close, innerStart);
    if (closeAt === -1) continue;
    bounds.push({
      inner_start: innerStart,
      inner_end: closeAt,
      outer_start: match.index,
      outer_end: closeAt + close.length,
      display: true,
      kind: "environment-display",
    });
    beginPattern.lastIndex = closeAt + close.length;
  }
  return bounds;
}
