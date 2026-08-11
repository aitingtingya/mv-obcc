import { isolateHistory, redo, undo } from "@codemirror/commands";
import {
  Annotation,
  EditorSelection,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type {
  VimBuffer,
  VimEdit,
  VimLine,
  VimSelection,
  VimVisualSnapshot,
} from "../core/types";

export const vimTransaction = Annotation.define<boolean>();

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

  get lineCount(): number {
    return this.view.state.doc.lines;
  }

  text(from = 0, to = this.length): string {
    return this.view.state.doc.sliceString(from, to);
  }

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
      effects: setVimVisualSnapshot.of(null),
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
    this.view.dispatch({
      annotations: [vimTransaction.of(true), isolateHistory.of("before")],
    });
  }

  endHistoryGroup(): void {
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
