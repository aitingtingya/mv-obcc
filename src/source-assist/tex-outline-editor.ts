import { foldService } from "@codemirror/language";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import {
  isTexExtension,
  matchTexSectionLine,
  matchTexSectionLineSpans,
} from "./tex-outline";

/**
 * CodeMirror fold provider so `\section{...}` lines fold exactly like
 * Markdown headings. Obsidian's own foldService (the `HG` extension) only
 * recognizes `#` / Setext headings; `foldService` is a facet, so this extra
 * provider is consulted when Obsidian's returns null, and the fold gutter
 * arrow / fold commands are driven natively by Obsidian.
 */
export function texOutlineFoldService(isEnabled: () => boolean): Extension {
  return foldService.of((state, pos) => {
    if (!isEnabled()) return null;
    const file = state.field(editorInfoField, false)?.file;
    if (!file || !isTexExtension(file.extension)) return null;
    const line = state.doc.lineAt(pos);
    const match = matchTexSectionLine(line.text);
    if (!match) return null;

    const doc = state.doc;
    // Fold until the next section at the same or higher level (like Obsidian's
    // heading fold), or the end of the document.
    let endLineNumber = line.number + 1;
    while (endLineNumber <= doc.lines) {
      const candidate = doc.line(endLineNumber);
      const nextMatch = matchTexSectionLine(candidate.text);
      if (nextMatch && nextMatch.latexLevel <= match.latexLevel) break;
      endLineNumber++;
    }
    const endLine = doc.line(endLineNumber - 1);
    if (endLineNumber - 1 <= line.number) return null;
    return { from: line.to, to: endLine.to };
  });
}

const updateTexOutlineHeadingsEffect = StateEffect.define<{
  lineDecorations: DecorationSet;
  inlineDecorations: DecorationSet;
}>();

const texOutlineHeadingLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = transaction.docChanged
      ? decorations.map(transaction.changes)
      : decorations;
    for (const effect of transaction.effects) {
      if (effect.is(updateTexOutlineHeadingsEffect)) {
        next = effect.value.lineDecorations;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const texOutlineHeadingInlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = transaction.docChanged
      ? decorations.map(transaction.changes)
      : decorations;
    for (const effect of transaction.effects) {
      if (effect.is(updateTexOutlineHeadingsEffect)) {
        next = effect.value.inlineDecorations;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface TexOutlineHeadingDecorations {
  lineDecorations: DecorationSet;
  inlineDecorations: DecorationSet;
}

const EMPTY_TEX_OUTLINE_HEADINGS: TexOutlineHeadingDecorations = {
  lineDecorations: Decoration.none,
  inlineDecorations: Decoration.none,
};

/**
 * Builds heading decorations for `\section{...}` lines so they render like
 * Markdown headings: the line gets `HyperMD-header-N` and the raw title gets
 * `cm-header-N` (theme heading sizes apply per level), while in live preview
 * the `\command{` / `}` shell is hidden as long as the selection stays off
 * the line. Levels use the Outline panel's relative-top normalization: the
 * highest LaTeX level in the document becomes level 1.
 */
export function buildTexOutlineHeadingDecorations(
  state: EditorState,
  isEnabled: () => boolean,
): TexOutlineHeadingDecorations {
  if (!isEnabled()) return EMPTY_TEX_OUTLINE_HEADINGS;
  const file = state.field(editorInfoField, false)?.file;
  if (!file || !isTexExtension(file.extension ?? "")) {
    return EMPTY_TEX_OUTLINE_HEADINGS;
  }

  const doc = state.doc;
  const hits: { lineNumber: number; latexLevel: number }[] = [];
  let minLevel = Infinity;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const match = matchTexSectionLine(doc.line(lineNumber).text);
    if (!match) continue;
    hits.push({ lineNumber, latexLevel: match.latexLevel });
    if (match.latexLevel < minLevel) minLevel = match.latexLevel;
  }
  if (hits.length === 0) return EMPTY_TEX_OUTLINE_HEADINGS;

  const livePreview = state.field(editorLivePreviewField, false) ?? false;
  const lineBuilder = new RangeSetBuilder<Decoration>();
  const inlineBuilder = new RangeSetBuilder<Decoration>();
  for (const hit of hits) {
    const line = doc.line(hit.lineNumber);
    const spans = matchTexSectionLineSpans(line.text);
    if (!spans) continue;
    // Skip empty titles like `\section{}`, matching parseTexSections.
    if (
      line.text
        .slice(spans.titleBraceOpen + 1, spans.titleBraceClose)
        .trim() === ""
    ) {
      continue;
    }
    const level = Math.max(1, Math.min(6, hit.latexLevel - minLevel + 1));
    lineBuilder.add(
      line.from,
      line.from,
      Decoration.line({ class: `HyperMD-header HyperMD-header-${level}` }),
    );
    const shellFrom = line.from + spans.commandStart;
    const titleFrom = line.from + spans.titleBraceOpen + 1;
    const titleTo = line.from + spans.titleBraceClose;
    const hideShell =
      livePreview && !selectionTouchesLine(state, line.from, line.to);
    if (hideShell) {
      inlineBuilder.add(shellFrom, titleFrom, Decoration.replace({}));
    }
    inlineBuilder.add(
      titleFrom,
      titleTo,
      Decoration.mark({ class: `cm-header cm-header-${level}` }),
    );
    if (hideShell) {
      inlineBuilder.add(titleTo, titleTo + 1, Decoration.replace({}));
    }
  }
  return {
    lineDecorations: lineBuilder.finish(),
    inlineDecorations: inlineBuilder.finish(),
  };
}

function selectionTouchesLine(
  state: EditorState,
  lineFrom: number,
  lineTo: number,
): boolean {
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= lineFrom && range.head <= lineTo
      : range.from <= lineTo && range.to >= lineFrom,
  );
}

/**
 * Live-preview heading decorations for tex section lines; pairs with the
 * fold service so `\section{...}` behaves like Markdown headings in the
 * editor. Rebuilds on document and selection changes.
 */
export function texOutlineHeadingPreview(
  isEnabled: () => boolean,
): Extension {
  return [
    texOutlineHeadingLineField,
    texOutlineHeadingInlineField,
    ViewPlugin.fromClass(
      class {
        private queued = false;
        private destroyed = false;

        constructor(private readonly view: EditorView) {
          this.queueRebuild();
        }

        update(update: ViewUpdate): void {
          const before = update.startState.field(editorInfoField, false)?.file
            ?.extension;
          const after = update.state.field(editorInfoField, false)?.file
            ?.extension;
          if (update.docChanged || update.selectionSet || before !== after) {
            this.queueRebuild();
          }
        }

        destroy(): void {
          this.destroyed = true;
        }

        private queueRebuild(): void {
          if (this.queued || this.destroyed) return;
          this.queued = true;
          queueMicrotask(() => {
            this.queued = false;
            if (this.destroyed) return;
            this.view.dispatch({
              effects: updateTexOutlineHeadingsEffect.of(
                buildTexOutlineHeadingDecorations(this.view.state, isEnabled),
              ),
            });
          });
        }
      },
    ),
  ];
}
