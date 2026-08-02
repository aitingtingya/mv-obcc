import {
  EditorSelection,
  type EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  editorInfoField,
  editorLivePreviewField,
  finishRenderMath,
  loadMathJax,
  renderMath,
} from "obsidian";
import {
  type ConfiguredTexMathRegion,
  texMathRegions,
  type TexMathRegion,
} from "./tex-math";

const mathJaxRenderTokens = new WeakMap<HTMLElement, object>();

interface TexMathVisualState {
  mathJaxReady: boolean;
  decorations: DecorationSet;
}

const setTexMathJaxReadyEffect = StateEffect.define<void>();

const texMathVisualStateField = StateField.define<TexMathVisualState>({
  create: () => ({
    mathJaxReady: false,
    decorations: Decoration.none,
  }),
  update(value, transaction) {
    let mathJaxReady = value.mathJaxReady;
    for (const effect of transaction.effects) {
      if (effect.is(setTexMathJaxReadyEffect)) mathJaxReady = true;
    }
    return {
      mathJaxReady,
      decorations: mathJaxReady
        ? buildTexMathVisualDecorations(transaction.state)
        : Decoration.none,
    };
  },
  provide: (field) =>
    Prec.highest(
      EditorView.decorations.from(field, (value) => value.decorations),
    ),
});

export function texDisplayMathPreviewExtension(): Extension {
  return [
    texMathVisualStateField,
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          return handleTexPreviewNavigationKey(event, view);
        },
      }),
    ),
    ViewPlugin.fromClass(
      class {
        private destroyed = false;

        constructor(private readonly view: EditorView) {
          try {
            void Promise.resolve(loadMathJax())
              .then(() => {
                if (this.destroyed) return;
                this.view.dispatch({
                  effects: setTexMathJaxReadyEffect.of(),
                });
              })
              .catch((error: unknown) => {
                console.error(
                  "[mv-aide] Failed to load MathJax for TeX preview.",
                  error,
                );
              });
          } catch (error) {
            console.error(
              "[mv-aide] Failed to load MathJax for TeX preview.",
              error,
            );
          }
        }

        destroy(): void {
          this.destroyed = true;
        }
      },
    ),
  ];
}

class TexMathWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly display: boolean,
    private readonly cursorTarget: number,
  ) {
    super();
  }

  eq(widget: TexMathWidget): boolean {
    return (
      widget.source === this.source &&
      widget.display === this.display &&
      widget.cursorTarget === this.cursorTarget
    );
  }

  updateDOM(dom: HTMLElement): boolean {
    if (
      !(dom instanceof HTMLElement) ||
      dom.tagName !== (this.display ? "DIV" : "SPAN")
    ) {
      return false;
    }
    dom.replaceChildren();
    dom.className = this.className();
    dom.dataset.cursorTarget = String(this.cursorTarget);
    renderMathInto(dom, this.source, this.display);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = view.dom.ownerDocument.createElement(
      this.display ? "div" : "span",
    );
    wrap.className = this.className();
    wrap.dataset.cursorTarget = String(this.cursorTarget);
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const cursorTarget = Number.parseInt(wrap.dataset.cursorTarget ?? "", 10);
      view.dispatch({
        selection: EditorSelection.cursor(
          Number.isFinite(cursorTarget) ? cursorTarget : this.cursorTarget,
        ),
        scrollIntoView: true,
      });
      view.focus();
    });
    renderMathInto(wrap, this.source, this.display);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }

  get estimatedHeight(): number {
    return this.display ? 50 : -1;
  }

  private className(): string {
    return this.display
      ? "math math-block cm-embed-block mv-senceai-tex-math-preview mv-senceai-tex-math-preview-display"
      : "math mv-senceai-tex-math-preview mv-senceai-tex-math-preview-inline";
  }
}

export function buildTexMathVisualDecorations(
  state: EditorState,
): DecorationSet {
  try {
    return buildTexMathVisualDecorationsUnsafe(state);
  } catch (error) {
    console.error("[mv-aide] Failed to build TeX math preview.", error);
    return Decoration.none;
  }
}

function buildTexMathVisualDecorationsUnsafe(
  state: EditorState,
): DecorationSet {
  if (editorExtension(state) !== "tex") return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const regions = texMathRegions(state);
  for (const region of regions) {
    if (region.origin !== "configured") continue;
    if (!isValidBound(state, region)) continue;
    const source = region.renderSource;
    if (!source.trim()) continue;
    const widget = new TexMathWidget(
      source,
      region.display,
      region.inner_start,
    );
    if (isLivePreview(state) && !selectionTouchesBound(state, region)) {
      builder.add(
        region.outer_start,
        region.outer_end,
        Decoration.replace({
          widget,
          block: region.display,
        }),
      );
      continue;
    }
    if (!region.display) {
      continue;
    }
    builder.add(
      region.outer_end,
      region.outer_end,
      Decoration.widget({
        widget,
        block: true,
        side: 1,
      }),
    );
  }
  return builder.finish();
}

function renderMathInto(
  container: HTMLElement,
  source: string,
  display: boolean,
): void {
  const token = {};
  mathJaxRenderTokens.set(container, token);
  try {
    container.appendChild(renderMath(source, display));
  } catch (error) {
    console.error("[mv-aide] Failed to render TeX math preview.", error);
    container.textContent = source;
    return;
  }
  try {
    void Promise.resolve(finishRenderMath()).catch((error: unknown) => {
      finishMathRenderWithFallback(container, source, token, error);
    });
  } catch (error) {
    finishMathRenderWithFallback(container, source, token, error);
  }
}

function finishMathRenderWithFallback(
  container: HTMLElement,
  source: string,
  token: object,
  error: unknown,
): void {
  console.error("[mv-aide] Failed to finish TeX math preview.", error);
  if (mathJaxRenderTokens.get(container) !== token) return;
  container.textContent = source;
}

export function handleTexPreviewNavigationKey(
  event: KeyboardEvent,
  view: EditorView,
): boolean {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    editorExtension(view.state) !== "tex" ||
    !isLivePreview(view.state)
  ) {
    return false;
  }

  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const target =
    event.key === "ArrowUp"
      ? texPreviewVerticalTarget(view, false)
      : event.key === "ArrowDown"
        ? texPreviewVerticalTarget(view, true)
        : event.key === "ArrowLeft"
          ? texPreviewHorizontalTarget(view, false)
          : event.key === "ArrowRight"
            ? texPreviewHorizontalTarget(view, true)
            : null;
  if (target === null || target === selection.main.head) return false;

  event.preventDefault();
  view.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
  });
  return true;
}

function texPreviewVerticalTarget(
  view: EditorView,
  forward: boolean,
): number | null {
  const bounds = navigableTexPreviewBounds(view);
  if (bounds.length === 0) return null;

  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const currentLine = doc.lineAt(head);
  const targetLineNumber = currentLine.number + (forward ? 1 : -1);
  if (targetLineNumber < 1 || targetLineNumber > doc.lines) return null;

  const targetLine = doc.line(targetLineNumber);
  if (
    !bounds.some(
      (bound) =>
        lineIntersectsBound(currentLine, bound) ||
        lineIntersectsBound(targetLine, bound),
    )
  ) {
    return null;
  }

  const column = Math.max(0, head - currentLine.from);
  return nudgeEndBoundaryInsideBound(
    Math.min(targetLine.from + column, targetLine.to),
    bounds,
  );
}

function texPreviewHorizontalTarget(
  view: EditorView,
  forward: boolean,
): number | null {
  const bounds = navigableTexPreviewBounds(view);
  if (bounds.length === 0) return null;

  const head = view.state.selection.main.head;
  const target = forward
    ? Math.min(view.state.doc.length, head + 1)
    : Math.max(0, head - 1);
  if (target === head) return null;

  return bounds.some((bound) => movementTouchesBound(head, target, bound))
    ? target
    : null;
}

function navigableTexPreviewBounds(view: EditorView): ConfiguredTexMathRegion[] {
  return texMathRegions(view.state).filter(
    (bound): bound is ConfiguredTexMathRegion => {
      if (bound.origin !== "configured") return false;
      if (!isValidBound(view.state, bound)) return false;
      return view.state.sliceDoc(bound.inner_start, bound.inner_end).trim() !== "";
    },
  );
}

function lineIntersectsBound(
  line: { from: number; to: number },
  bound: TexMathRegion,
): boolean {
  return line.from < bound.outer_end && line.to > bound.outer_start;
}

function movementTouchesBound(
  from: number,
  to: number,
  bound: TexMathRegion,
): boolean {
  return (
    positionInsideBound(from, bound) ||
    positionInsideBound(to, bound) ||
    (from === bound.outer_start && to > from) ||
    (from === bound.outer_end && to < from)
  );
}

function positionInsideBound(pos: number, bound: TexMathRegion): boolean {
  return pos > bound.outer_start && pos < bound.outer_end;
}

function positionActivatesBound(pos: number, bound: TexMathRegion): boolean {
  return pos >= bound.outer_start && pos <= bound.outer_end;
}

function nudgeEndBoundaryInsideBound(
  pos: number,
  bounds: readonly TexMathRegion[],
): number {
  for (const bound of bounds) {
    if (pos === bound.outer_end && bound.outer_start < bound.outer_end) {
      return pos - 1;
    }
  }
  return pos;
}

function isValidBound(state: EditorState, bound: TexMathRegion): boolean {
  return (
    bound.inner_start >= 0 &&
    bound.inner_end >= bound.inner_start &&
    bound.outer_start >= 0 &&
    bound.outer_end >= bound.outer_start &&
    bound.outer_end <= state.doc.length
  );
}

function selectionTouchesBound(state: EditorState, bound: TexMathRegion): boolean {
  return state.selection.ranges.some((range) => {
    if (range.empty) return positionActivatesBound(range.head, bound);
    return range.from < bound.outer_end && range.to > bound.outer_start;
  });
}

function isLivePreview(state: EditorState): boolean {
  try {
    return state.field(editorLivePreviewField, false) ?? false;
  } catch {
    return false;
  }
}

function editorExtension(state: EditorState): string {
  try {
    return (
      state.field(editorInfoField, false)?.file?.extension?.toLowerCase() ?? ""
    );
  } catch {
    return "";
  }
}
