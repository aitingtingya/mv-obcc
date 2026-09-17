import { foldService } from "@codemirror/language";
import {
  RangeSetBuilder,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
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

interface ParsedHeading {
  from: number;
  to: number;
  level: number;
  shellFrom: number;
  titleFrom: number;
  titleTo: number;
}

// Immutable document identity invalidates this cache on edits; closed documents
// are not retained. Selection-only updates reuse the exact same parsed headings.
const headingCache = new WeakMap<Text, readonly ParsedHeading[]>();

function parsedHeadings(doc: Text): readonly ParsedHeading[] {
  const cached = headingCache.get(doc);
  if (cached) return cached;
  const hits: { lineNumber: number; latexLevel: number }[] = [];
  let minLevel = Infinity;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const match = matchTexSectionLine(doc.line(lineNumber).text);
    if (!match) continue;
    hits.push({ lineNumber, latexLevel: match.latexLevel });
    minLevel = Math.min(minLevel, match.latexLevel);
  }
  const headings: ParsedHeading[] = [];
  for (const hit of hits) {
    const line = doc.line(hit.lineNumber);
    const spans = matchTexSectionLineSpans(line.text);
    if (!spans || !line.text.slice(spans.titleBraceOpen + 1, spans.titleBraceClose).trim()) continue;
    headings.push({
      from: line.from, to: line.to,
      level: Math.max(1, Math.min(6, hit.latexLevel - minLevel + 1)),
      shellFrom: line.from + spans.commandStart,
      titleFrom: line.from + spans.titleBraceOpen + 1,
      titleTo: line.from + spans.titleBraceClose,
    });
  }
  headingCache.set(doc, headings);
  return headings;
}

function headingsApplicable(state: EditorState, isEnabled: () => boolean): boolean {
  return isEnabled() && isTexExtension(state.field(editorInfoField, false)?.file?.extension ?? "");
}

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
  if (!headingsApplicable(state, isEnabled)) return EMPTY_TEX_OUTLINE_HEADINGS;
  const hits = parsedHeadings(state.doc);
  if (hits.length === 0) return EMPTY_TEX_OUTLINE_HEADINGS;

  const livePreview = state.field(editorLivePreviewField, false) ?? false;
  const lineBuilder = new RangeSetBuilder<Decoration>();
  const inlineBuilder = new RangeSetBuilder<Decoration>();
  for (const hit of hits) {
    const { level, shellFrom, titleFrom, titleTo } = hit;
    lineBuilder.add(
      hit.from,
      hit.from,
      Decoration.line({ class: `HyperMD-header HyperMD-header-${level}` }),
    );
    const hideShell =
      livePreview && !selectionTouchesLine(state, hit.from, hit.to);
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
        private applicable = false;

        constructor(private readonly view: EditorView) {
          this.queueRebuild();
        }

        update(update: ViewUpdate): void {
          const applicable = headingsApplicable(update.state, isEnabled);
          const eligibilityChanged = applicable !== this.applicable;
          this.applicable = applicable;
          const previewChanged = update.startState.field(editorLivePreviewField, false) !==
            update.state.field(editorLivePreviewField, false);
          if (eligibilityChanged || (applicable && (update.docChanged || update.selectionSet || previewChanged))) {
            this.queueRebuild();
          }
        }

        destroy(): void {
          this.destroyed = true;
        }

        private queueRebuild(): void {
          if (this.queued || this.destroyed) return;
          this.applicable = headingsApplicable(this.view.state, isEnabled);
          if (!this.applicable && this.view.state.field(texOutlineHeadingLineField).size === 0 &&
            this.view.state.field(texOutlineHeadingInlineField).size === 0) return;
          this.queued = true;
          queueMicrotask(() => {
            this.queued = false;
            if (this.destroyed) return;
            const next = buildTexOutlineHeadingDecorations(this.view.state, isEnabled);
            if (RangeSet.eq([this.view.state.field(texOutlineHeadingLineField)], [next.lineDecorations]) &&
              RangeSet.eq([this.view.state.field(texOutlineHeadingInlineField)], [next.inlineDecorations])) return;
            this.view.dispatch({
              effects: updateTexOutlineHeadingsEffect.of(next),
            });
          });
        }
      },
    ),
  ];
}
