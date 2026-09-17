import { isolateHistory, redo, undo } from "@codemirror/commands";
import { CodeMirrorVimDocument } from "./document";
import {
  Annotation,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { foldCode, unfoldAll, unfoldCode, toggleFold, indentRange, foldable, foldedRanges, foldEffect, unfoldEffect, codeFolding, foldState } from "@codemirror/language";
import type {
  VimBuffer,
  VimEdit,
  VimLine,
  VimSelection,
  VimVisualSnapshot,
  VimOptions,
} from "../core/types";

export const vimTransaction = Annotation.define<boolean>();
export const setVimSearch = StateEffect.define<readonly { from: number; to: number }[]>();
export const vimSearchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setVimSearch)) {
      next = Decoration.set(effect.value.filter((range) => range.from < range.to && range.to <= transaction.state.doc.length)
        .map((range) => Decoration.mark({ class: "cm-searchMatch" }).range(range.from, range.to)), true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const setVimVisualSnapshot = StateEffect.define<VimVisualSnapshot | null>({
  map(value, changes) {
    return value ? mapVisualSnapshot(value, (position) =>
      changes.mapPos(position, 1)) : null;
  },
});

export const vimVisualSnapshotField = StateField.define<VimVisualSnapshot | null>({
  create: () => null,
  update(value, transaction) {
    let next = value;
    if (next && transaction.docChanged) {
      next = mapVisualSnapshot(next, (position) =>
        transaction.changes.mapPos(position, 1));
    }
    for (const effect of transaction.effects) {
      if (effect.is(setVimVisualSnapshot)) next = effect.value;
    }
    if (
      transaction.selection !== undefined &&
      transaction.annotation(vimTransaction) !== true
    ) return null;
    return next;
  },
});

export class CodeMirrorVimBuffer implements VimBuffer {
  private historyDepth = 0;
  private scrolloff = 0;

  updateOptions(options: Readonly<VimOptions>): void { this.scrolloff = options.scrolloff; }
  constructor(
    private readonly view: EditorView,
    private readonly resolveId: () => string,
  ) {}

  get id(): string {
    return this.resolveId();
  }

  get length(): number {
    return this.view.state.doc.length;
  }

  get readOnly(): boolean { return this.view.state.facet(EditorState.readOnly); }

  displayLineMotion(position: number, direction: -1 | 1, count: number): number {
    let selection = EditorSelection.cursor(position);
    for (let index = 0; index < count; index += 1) {
      const next = this.view.moveVertically(selection, direction > 0);
      if (next.head === selection.head) break;
      selection = next;
    }
    return selection.head;
  }

  viewportMotion(position: number, command: string, count: number): number {
    const view = this.view;
    const top = Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop);
    const height = view.scrollDOM.clientHeight;
    const lineHeight = view.defaultLineHeight;
    if (["zt", "zz", "zb"].includes(command)) {
      view.dispatch({ effects: EditorView.scrollIntoView(position, { y: command === "zt" ? "start" : command === "zb" ? "end" : "center", yMargin: 0 }) });
      return position;
    }
    if (["H", "M", "L"].includes(command)) {
      const margin = Math.min(this.scrolloff * lineHeight, height / 2);
      const y = command === "H" ? top + Math.max((count - 1) * lineHeight, margin) : command === "M" ? top + height / 2 : top + height - Math.max(count * lineHeight, margin);
      return view.lineBlockAtHeight(Math.max(0, y)).from;
    }
    const forward = ["<C-d>", "<C-f>", "<C-e>", "<PageDown>"].includes(command);
    const rows = command === "<C-e>" || command === "<C-y>";
    const half = command === "<C-d>" || command === "<C-u>";
    const distance = (rows ? lineHeight : half ? height / 2 : Math.max(lineHeight, height - 2 * lineHeight)) * count;
    const target = rows ? position : view.moveVertically(EditorSelection.cursor(position), forward, distance).head;
    view.scrollDOM.scrollTop += (forward ? 1 : -1) * distance;
    return target;
  }

  reindent(from: number, to: number): readonly VimEdit[] {
    const edits: VimEdit[] = [];
    indentRange(this.view.state, from, to).iterChanges((start, end, _from, _to, inserted) => edits.push({ from: start, to: end, insert: inserted.toString() }));
    return edits;
  }

  fold(position: number, command: string): void {
    if (command === "zM" || command === "zC" || command === "zO") {
      const state = this.view.state;
      let region = { from: 0, to: state.doc.length };
      if (command !== "zM") {
        let found = false;
        for (let number = state.doc.lineAt(position).number; number >= 1; number -= 1) {
          const line = state.doc.line(number);
          const range = foldable(state, line.from, line.to);
          if (range && range.to >= position) { region = range; found = true; break; }
        }
        if (!found) return;
      }
      const effects: StateEffect<unknown>[] = [];
      if (command === "zO") {
        foldedRanges(state).between(region.from, region.to, (from, to) => {
          if (from >= region.from && to <= region.to) effects.push(unfoldEffect.of({ from, to }));
        });
      } else {
        for (let number = state.doc.lineAt(region.from).number; number <= state.doc.lineAt(region.to).number; number += 1) {
          const line = state.doc.line(number);
          const range = foldable(state, line.from, line.to);
          if (range && range.from >= region.from && range.to <= region.to) effects.push(foldEffect.of(range));
        }
        if (effects.length && !state.field(foldState, false)) effects.push(StateEffect.appendConfig.of(codeFolding()));
      }
      if (effects.length) this.view.dispatch({ effects });
      return;
    }
    const operation = command === "zR" ? unfoldAll : command === "za" ? toggleFold
      : command === "zo" ? unfoldCode : foldCode;
    operation(this.view);
  }

  highlightSearch(ranges: readonly { from: number; to: number }[]): void {
    if (this.view.state.field(vimSearchField, false)) this.view.dispatch({ effects: setVimSearch.of(ranges) });
  }

  get lineCount(): number {
    return this.view.state.doc.lines;
  }

  text(from = 0, to = this.length): string {
    return this.view.state.doc.sliceString(from, to);
  }

  documentSnapshot(): CodeMirrorVimDocument { return new CodeMirrorVimDocument(this.view.state.doc); }

  line(number: number): VimLine {
    const line = this.view.state.doc.line(Math.min(Math.max(1, number), this.lineCount));
    return { number: line.number, from: line.from, to: line.to, text: line.text };
  }

  lineAt(position: number): VimLine {
    const line = this.view.state.doc.lineAt(Math.min(Math.max(0, position), this.length));
    return { number: line.number, from: line.from, to: line.to, text: line.text };
  }

  selections(): readonly VimSelection[] {
    return this.view.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head }));
  }

  setSelections(
    selections: readonly VimSelection[],
    primaryIndex = 0,
  ): void {
    const normalized = normalizeSelections(selections, this.length);
    this.view.dispatch({
      selection: EditorSelection.create(
        normalized.map(({ anchor, head }) => EditorSelection.range(anchor, head)),
        Math.min(Math.max(0, primaryIndex), normalized.length - 1),
      ),
      effects: [setVimVisualSnapshot.of(null), ...(this.scrolloff > 0 ? [EditorView.scrollIntoView(normalized[primaryIndex]?.head ?? 0, { yMargin: this.scrolloff * this.view.defaultLineHeight })] : [])],
      annotations: vimTransaction.of(true),
      scrollIntoView: true,
    });
  }

  presentVisual(snapshot: VimVisualSnapshot): void {
    const normalized = normalizeVisualSnapshot(snapshot, this.length);
    const cursor = normalized.activePosition;
    this.view.dispatch({
      selection: EditorSelection.cursor(cursor),
      effects: setVimVisualSnapshot.of(normalized),
      annotations: vimTransaction.of(true),
      scrollIntoView: true,
    });
  }

  clearVisual(): void {
    const snapshot = this.view.state.field(vimVisualSnapshotField, false);
    if (snapshot === null || snapshot === undefined) return;
    this.view.dispatch({
      effects: setVimVisualSnapshot.of(null),
      annotations: vimTransaction.of(true),
    });
  }

  visualSnapshot(): VimVisualSnapshot | null {
    const snapshot = this.view.state.field(vimVisualSnapshotField, false);
    return snapshot ? cloneVisualSnapshot(snapshot) : null;
  }

  apply(edits: readonly VimEdit[], selections?: readonly VimSelection[]): void {
    if (this.readOnly) throw new Error("E21: Cannot make changes, buffer is read-only");
    const changes = [...edits]
      .map((edit) => ({
        from: Math.min(Math.max(0, edit.from), this.length),
        to: Math.min(Math.max(edit.from, edit.to), this.length),
        insert: edit.insert,
      }))
      .sort((left, right) => left.from - right.from);
    const specification: Parameters<EditorView["dispatch"]>[0] = {
      changes,
      effects: setVimVisualSnapshot.of(null),
      annotations: vimTransaction.of(true),
      scrollIntoView: true,
    };
    if (selections) {
      const resultingLength = this.length + changes.reduce(
        (delta, change) => delta + change.insert.length - (change.to - change.from),
        0,
      );
      const normalized = normalizeSelections(selections, resultingLength);
      specification.selection = EditorSelection.create(
        normalized.map(({ anchor, head }) => EditorSelection.range(anchor, head)),
      );
    }
    this.view.dispatch(specification as Transaction);
  }

  beginHistoryGroup(): void {
    if (this.historyDepth++ > 0) return;
    this.view.dispatch({
      annotations: [vimTransaction.of(true), isolateHistory.of("before")],
    });
  }

  endHistoryGroup(): void {
    if (this.historyDepth > 0) this.historyDepth -= 1;
    if (this.historyDepth > 0) return;
    this.view.dispatch({
      annotations: [vimTransaction.of(true), isolateHistory.of("after")],
    });
  }

  undo(): boolean {
    return undo(this.view);
  }

  redo(): boolean {
    return redo(this.view);
  }
}

function normalizeVisualSnapshot(
  snapshot: VimVisualSnapshot,
  length: number,
): VimVisualSnapshot {
  const normalize = (position: number) => clamp(position, 0, length);
  return {
    mode: snapshot.mode,
    anchor: normalize(snapshot.anchor),
    head: normalize(snapshot.head),
    activePosition: normalize(snapshot.activePosition),
    ranges: snapshot.ranges.map((range) => {
      const anchor = normalize(range.anchor);
      const head = normalize(range.head);
      return { anchor: Math.min(anchor, head), head: Math.max(anchor, head) };
    }),
  };
}

function cloneVisualSnapshot(snapshot: VimVisualSnapshot): VimVisualSnapshot {
  return { ...snapshot, ranges: snapshot.ranges.map((range) => ({ ...range })) };
}

function mapVisualSnapshot(
  snapshot: VimVisualSnapshot,
  map: (position: number) => number,
): VimVisualSnapshot {
  return {
    mode: snapshot.mode,
    anchor: map(snapshot.anchor),
    head: map(snapshot.head),
    activePosition: map(snapshot.activePosition),
    ranges: snapshot.ranges.map((range) => ({
      anchor: map(range.anchor),
      head: map(range.head),
    })),
  };
}

function normalizeSelections(
  selections: readonly VimSelection[],
  length: number,
): VimSelection[] {
  const normalized = selections.map(({ anchor, head }) => ({
    anchor: clamp(anchor, 0, length),
    head: clamp(head, 0, length),
  }));
  return normalized.length > 0 ? normalized : [{ anchor: 0, head: 0 }];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
