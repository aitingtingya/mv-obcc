import {
  Compartment,
  EditorSelection,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  editorInfoField,
  editorLivePreviewField,
  finishRenderMath,
  renderMath,
} from "obsidian";
import { texMathBounds, type SourceAssistMathBound } from "./tex-math";

export interface TexMathPreviewOptions {
  positionIsAbove: boolean;
  cursor: string;
}

type TexPreviewRuntimeFactory = (options: TexMathPreviewOptions) => Extension;

const TEX_PREVIEW_RETRY_INTERVAL_MS = 100;
const TEX_PREVIEW_MAX_RETRIES = 30;

type TexInlineTooltipState = {
  equation: string;
  bounds: SourceAssistMathBound;
  tooltip: Tooltip;
};

const updateTexInlineTooltipsEffect =
  StateEffect.define<readonly TexInlineTooltipState[]>();
const updateTexDisplayDecorationsEffect = StateEffect.define<DecorationSet>();

export interface TexDisplayMathPreviewResult {
  decorations: DecorationSet;
  signature: string;
}

export interface TexInlineMathTooltipsResult {
  tooltips: readonly TexInlineTooltipState[];
  signature: string;
}

const texInlineTooltipField = StateField.define<readonly TexInlineTooltipState[]>({
  create: () => [],
  update(tooltips, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(updateTexInlineTooltipsEffect)) return effect.value;
    }
    return tooltips;
  },
  provide: (field) =>
    showTooltip.computeN([field], (state) =>
      state.field(field).map((value) => value.tooltip),
    ),
});

const texDisplayDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = transaction.docChanged ? decorations.map(transaction.changes) : decorations;
    for (const effect of transaction.effects) {
      if (effect.is(updateTexDisplayDecorationsEffect)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function texDisplayMathPreviewExtension(
  options: TexMathPreviewOptions,
  createRuntimeExtension: TexPreviewRuntimeFactory = texDisplayMathPreviewRuntimeExtension,
): Extension {
  const previewCompartment = new Compartment();
  return [
    previewCompartment.of([]),
    ViewPlugin.fromClass(
      class {
        private active = false;
        private disabled = false;
        private updateQueued = false;
        private timeout: ReturnType<typeof setTimeout> | null = null;
        private animationFrame: number | null = null;
        private destroyed = false;
        private retryCount = 0;
        private lastObservedExtension = "";

        constructor(private readonly view: EditorView) {
          this.queuePreviewSync(true);
        }

        update(update: ViewUpdate): void {
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.selectionSet ||
            editorExtension(update.startState) !== editorExtension(update.state)
          ) {
            this.queuePreviewSync(true);
          }
        }

        destroy(): void {
          this.destroyed = true;
          if (this.timeout !== null) {
            clearTimeout(this.timeout);
            this.timeout = null;
          }
          if (
            this.animationFrame !== null &&
            typeof globalThis.cancelAnimationFrame === "function"
          ) {
            globalThis.cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
          }
        }

        private queuePreviewSync(afterFrame: boolean): void {
          if (this.updateQueued || this.disabled || this.timeout !== null) return;
          this.updateQueued = true;
          const sync = () => {
            this.timeout = setTimeout(() => {
              this.timeout = null;
              this.updateQueued = false;
              if (!this.destroyed) this.syncPreviewRuntime();
            }, 0);
          };
          if (afterFrame && typeof globalThis.requestAnimationFrame === "function") {
            this.animationFrame = globalThis.requestAnimationFrame(() => {
              this.animationFrame = null;
              sync();
            });
          } else {
            sync();
          }
        }

        private syncPreviewRuntime(): void {
          const extension = editorExtension(this.view.state);
          this.lastObservedExtension = extension;
          if (extension === "tex") {
            this.retryCount = 0;
            if (this.active) return;
            try {
              this.view.dispatch({
                effects: previewCompartment.reconfigure(
                  createRuntimeExtension(options),
                ),
              });
              this.active = true;
            } catch (error) {
              this.disabled = true;
              this.active = false;
              console.warn(
                `[mv-senceai-ide] Disabled TeX math preview for this editor because it failed to initialize. Current extension: "${this.lastObservedExtension}".`,
                error,
              );
              try {
                this.reconfigurePreview([]);
              } catch (disableError) {
                console.warn(
                  "[mv-senceai-ide] Failed to clear disabled TeX math preview.",
                  disableError,
                );
              }
            }
            return;
          }

          if (extension) {
            if (this.active) this.reconfigurePreview([]);
            this.active = false;
            return;
          }

          if (this.retryCount >= TEX_PREVIEW_MAX_RETRIES) {
            this.disabled = true;
            console.warn(
              `[mv-senceai-ide] Disabled TeX math preview for this editor because the file extension was not available after ${TEX_PREVIEW_MAX_RETRIES} retries. Current extension: "${this.lastObservedExtension}".`,
            );
            return;
          }
          this.retryCount += 1;
          this.timeout = setTimeout(() => {
            this.timeout = null;
            this.queuePreviewSync(false);
          }, TEX_PREVIEW_RETRY_INTERVAL_MS);
        }

        private reconfigurePreview(extension: Extension): void {
          this.view.dispatch({
            effects: previewCompartment.reconfigure(extension),
          });
        }
      },
    ),
  ];
}

function texDisplayMathPreviewRuntimeExtension(
  options: TexMathPreviewOptions,
): Extension {
  return [
    texInlineTooltipField,
    texDisplayDecorationField,
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          return handleTexPreviewNavigationKey(event, view);
        },
      }),
    ),
    ViewPlugin.fromClass(
      class {
        private previewUpdateQueued = false;
        private lastDisplaySignature = "";
        private lastTooltipSignature = "";

        constructor(private readonly view: EditorView) {
          this.queuePreviewUpdate();
        }

        update(update: ViewUpdate): void {
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.selectionSet ||
            editorExtension(update.startState) !== editorExtension(update.state)
          ) {
            this.queuePreviewUpdate();
          }
        }

        private queuePreviewUpdate(): void {
          if (this.previewUpdateQueued) return;
          this.previewUpdateQueued = true;
          queueMicrotask(() => {
            this.previewUpdateQueued = false;
            try {
              const display = buildTexDisplayMathPreview(this.view);
              const inlineTooltips = buildTexInlineMathTooltips(this.view, options);
              if (
                display.signature === this.lastDisplaySignature &&
                inlineTooltips.signature === this.lastTooltipSignature
              ) {
                return;
              }
              this.lastDisplaySignature = display.signature;
              this.lastTooltipSignature = inlineTooltips.signature;
              this.view.dispatch({
                effects: [
                  updateTexDisplayDecorationsEffect.of(display.decorations),
                  updateTexInlineTooltipsEffect.of(inlineTooltips.tooltips),
                  this.view.scrollSnapshot(),
                ],
              });
            } catch (error) {
              console.error(
                "[mv-senceai-ide] Failed to update TeX math preview.",
                error,
              );
            }
          });
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

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!(dom instanceof HTMLElement)) return false;
    dom.replaceChildren();
    dom.className = this.className();
    dom.dataset.cursorTarget = String(this.cursorTarget);
    renderMathInto(dom, this.source, this.display);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
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

  private className(): string {
    return this.display
      ? "mv-senceai-tex-math-preview mv-senceai-tex-math-preview-display"
      : "mv-senceai-tex-math-preview mv-senceai-tex-math-preview-inline";
  }
}

export function buildTexDisplayMathDecorations(view: EditorView): DecorationSet {
  return buildTexDisplayMathPreview(view).decorations;
}

export function buildTexDisplayMathPreview(
  view: EditorView,
): TexDisplayMathPreviewResult {
  try {
    return buildTexDisplayMathPreviewUnsafe(view);
  } catch (error) {
    console.error("[mv-senceai-ide] Failed to build TeX math preview.", error);
    return { decorations: Decoration.none, signature: "error" };
  }
}

function buildTexDisplayMathPreviewUnsafe(
  view: EditorView,
): TexDisplayMathPreviewResult {
  if (editorExtension(view.state) !== "tex") {
    return { decorations: Decoration.none, signature: "not-tex" };
  }
  if (view.visibleRanges.length === 0) {
    return { decorations: Decoration.none, signature: "no-visible-ranges" };
  }

  const builder = new RangeSetBuilder<Decoration>();
  const signatureParts: string[] = [];
  const visibleFrom = Math.min(...view.visibleRanges.map((range) => range.from));
  const visibleTo = Math.max(...view.visibleRanges.map((range) => range.to));
  const bounds = texMathBounds(view.state);
  for (const bound of bounds) {
    if (!isValidBound(view, bound)) {
      continue;
    }
    if (bound.kind === "dollar-display") {
      continue;
    }
    if (bound.outer_end < visibleFrom || bound.outer_start > visibleTo) {
      continue;
    }
    const source = view.state.sliceDoc(bound.inner_start, bound.inner_end);
    if (!source.trim()) {
      continue;
    }
    const widget = new TexMathWidget(source, bound.display, bound.inner_start);
    if (isLivePreview(view) && !selectionTouchesBound(view, bound)) {
      signatureParts.push(displaySignaturePart("replace", bound, source));
      builder.add(
        bound.outer_start,
        bound.outer_end,
        Decoration.replace({
          widget,
          block: bound.display && isBlockDisplayRange(view, bound),
        }),
      );
      continue;
    }
    if (!bound.display) {
      continue;
    }
    signatureParts.push(displaySignaturePart("widget", bound, source));
    builder.add(
      bound.outer_end,
      bound.outer_end,
      Decoration.widget({
        widget,
        block: true,
        side: 1,
      }),
    );
  }
  return {
    decorations: builder.finish(),
    signature: signatureParts.join("|"),
  };
}

export function buildTexInlineMathTooltips(
  view: EditorView,
  options: TexMathPreviewOptions,
): TexInlineMathTooltipsResult {
  try {
    if (editorExtension(view.state) !== "tex") {
      return { tooltips: [], signature: "not-tex" };
    }
    const bound = texInlineMathBoundAt(view);
    if (!bound) {
      return { tooltips: [], signature: "none" };
    }
    const equation = view.state.sliceDoc(bound.inner_start, bound.inner_end);
    if (!equation.trim()) {
      return { tooltips: [], signature: "empty" };
    }
    const equationWithCursor = insertPreviewCursor(
      equation,
      view.state.selection.main.head - bound.inner_start,
      options.cursor,
    );
    const tooltip = texInlineMathTooltip(view, bound, equationWithCursor, options);
    return {
      tooltips: [{ equation: equationWithCursor, bounds: bound, tooltip }],
      signature: [
        bound.outer_start,
        bound.outer_end,
        bound.inner_start,
        bound.inner_end,
        options.positionIsAbove ? "above" : "below",
        equationWithCursor,
      ].join(":"),
    };
  } catch (error) {
    console.error(
      "[mv-senceai-ide] Failed to build TeX inline math preview.",
      error,
    );
    return { tooltips: [], signature: "error" };
  }
}

function texInlineMathBoundAt(view: EditorView): SourceAssistMathBound | null {
  const pos = view.state.selection.main.head;
  return (
    texMathBounds(view.state).find(
      (bound) =>
        bound.kind === "paren-inline" &&
        pos > bound.inner_start &&
        pos < bound.inner_end,
    ) ?? null
  );
}

function displaySignaturePart(
  action: "replace" | "widget",
  bound: SourceAssistMathBound,
  source: string,
): string {
  return [
    action,
    bound.kind,
    bound.display ? "display" : "inline",
    bound.outer_start,
    bound.outer_end,
    bound.inner_start,
    bound.inner_end,
    source,
  ].join(":");
}

function texInlineMathTooltip(
  view: EditorView,
  bound: SourceAssistMathBound,
  equationWithCursor: string,
  options: TexMathPreviewOptions,
): Tooltip {
  const above = options.positionIsAbove;
  const pos = above
    ? bound.inner_start
    : Math.max(
        bound.inner_start,
        view.moveToLineBoundary(
          EditorSelection.range(bound.inner_end, bound.inner_end),
          false,
        ).anchor,
      );

  return {
    pos,
    above,
    strictSide: true,
    arrow: true,
    create: () => {
      const dom = document.createElement("div");
      dom.classList.add("cm-tooltip-cursor");
      dom.classList.add(above ? "cm-tooltip-above" : "cm-tooltip-below");
      renderMathInto(dom, equationWithCursor, false);
      return { dom };
    },
  };
}

function renderMathInto(container: HTMLElement, source: string, display: boolean): void {
  try {
    container.appendChild(renderMath(source.trim(), display));
    Promise.resolve(finishRenderMath()).catch((error: unknown) => {
      console.error("[mv-senceai-ide] Failed to finish TeX math preview.", error);
    });
  } catch (error) {
    console.error("[mv-senceai-ide] Failed to render TeX math preview.", error);
    container.textContent = source;
  }
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
    !isLivePreview(view)
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

function navigableTexPreviewBounds(view: EditorView): SourceAssistMathBound[] {
  return texMathBounds(view.state).filter((bound) => {
    if (!isValidBound(view, bound)) return false;
    if (bound.kind === "dollar-display") return false;
    return view.state.sliceDoc(bound.inner_start, bound.inner_end).trim() !== "";
  });
}

function lineIntersectsBound(
  line: { from: number; to: number },
  bound: SourceAssistMathBound,
): boolean {
  return line.from < bound.outer_end && line.to > bound.outer_start;
}

function movementTouchesBound(
  from: number,
  to: number,
  bound: SourceAssistMathBound,
): boolean {
  return (
    positionInsideBound(from, bound) ||
    positionInsideBound(to, bound) ||
    (from === bound.outer_start && to > from) ||
    (from === bound.outer_end && to < from)
  );
}

function positionInsideBound(pos: number, bound: SourceAssistMathBound): boolean {
  return pos > bound.outer_start && pos < bound.outer_end;
}

function positionActivatesBound(pos: number, bound: SourceAssistMathBound): boolean {
  return pos >= bound.outer_start && pos < bound.outer_end;
}

function nudgeEndBoundaryInsideBound(
  pos: number,
  bounds: readonly SourceAssistMathBound[],
): number {
  for (const bound of bounds) {
    if (pos === bound.outer_end && bound.outer_start < bound.outer_end) {
      return pos - 1;
    }
  }
  return pos;
}

function insertPreviewCursor(
  equation: string,
  rawPosition: number,
  cursor: string,
): string {
  const position = Math.max(0, Math.min(equation.length, rawPosition));
  return `${equation.slice(0, position)}${cursor}${equation.slice(position)}`;
}

function isValidBound(view: EditorView, bound: SourceAssistMathBound): boolean {
  return (
    bound.inner_start >= 0 &&
    bound.inner_end >= bound.inner_start &&
    bound.outer_start >= 0 &&
    bound.outer_end >= bound.outer_start &&
    bound.outer_end <= view.state.doc.length
  );
}

function selectionTouchesBound(view: EditorView, bound: SourceAssistMathBound): boolean {
  return view.state.selection.ranges.some((range) => {
    if (range.empty) return positionActivatesBound(range.head, bound);
    return range.from < bound.outer_end && range.to > bound.outer_start;
  });
}

function isBlockDisplayRange(view: EditorView, bound: SourceAssistMathBound): boolean {
  const startLine = view.state.doc.lineAt(bound.outer_start);
  const endLine = view.state.doc.lineAt(bound.outer_end);
  const before = view.state.sliceDoc(startLine.from, bound.outer_start);
  const after = view.state.sliceDoc(bound.outer_end, endLine.to);
  return before.trim() === "" && after.trim() === "";
}

function isLivePreview(view: EditorView): boolean {
  try {
    return view.state.field(editorLivePreviewField, false) ?? false;
  } catch {
    return false;
  }
}

function editorExtension(state: EditorView["state"]): string {
  try {
    return (
      state.field(editorInfoField, false)?.file?.extension?.toLowerCase() ?? ""
    );
  } catch {
    return "";
  }
}
