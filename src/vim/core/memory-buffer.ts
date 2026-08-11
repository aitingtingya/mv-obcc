import type {
  VimBuffer,
  VimEdit,
  VimLine,
  VimSelection,
  VimVisualSnapshot,
} from "./types";

interface Snapshot {
  text: string;
  selections: VimSelection[];
}

export class MemoryVimBuffer implements VimBuffer {
  private value: string;
  private selected: VimSelection[];
  private visual: VimVisualSnapshot | null = null;
  private primarySelectionIndex = 0;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private historyGroupSnapshot: Snapshot | null = null;
  private historyGroupRecorded = false;

  constructor(value = "", cursor = 0, readonly id = "memory") {
    this.value = value;
    const safeCursor = clamp(cursor, 0, value.length);
    this.selected = [{ anchor: safeCursor, head: safeCursor }];
  }

  get length(): number {
    return this.value.length;
  }

  get lineCount(): number {
    return this.value.length === 0 ? 1 : this.value.split("\n").length;
  }

  text(from = 0, to = this.length): string {
    return this.value.slice(from, to);
  }

  line(number: number): VimLine {
    const target = clamp(Math.trunc(number), 1, this.lineCount);
    let from = 0;
    for (let current = 1; current < target; current += 1) {
      const newline = this.value.indexOf("\n", from);
      from = newline < 0 ? this.value.length : newline + 1;
    }
    const newline = this.value.indexOf("\n", from);
    const to = newline < 0 ? this.value.length : newline;
    return { number: target, from, to, text: this.value.slice(from, to) };
  }

  lineAt(position: number): VimLine {
    const safe = clamp(position, 0, this.length);
    let number = 1;
    let from = 0;
    for (let index = 0; index < safe; index += 1) {
      if (this.value[index] === "\n") {
        number += 1;
        from = index + 1;
      }
    }
    const newline = this.value.indexOf("\n", from);
    const to = newline < 0 ? this.value.length : newline;
    return { number, from, to, text: this.value.slice(from, to) };
  }

  selections(): readonly VimSelection[] {
    return this.selected.map((selection) => ({ ...selection }));
  }

  setSelections(
    selections: readonly VimSelection[],
    primaryIndex = 0,
  ): void {
    this.selected = normalizeSelections(selections, this.length);
    this.primarySelectionIndex = clamp(primaryIndex, 0, this.selected.length - 1);
    this.visual = null;
  }

  get activePosition(): number | null {
    return this.visual?.activePosition ?? null;
  }

  get primaryIndex(): number {
    return this.primarySelectionIndex;
  }

  presentVisual(snapshot: VimVisualSnapshot): void {
    this.visual = normalizeVisualSnapshot(snapshot, this.length);
    const cursor = this.visual.activePosition;
    this.selected = [{ anchor: cursor, head: cursor }];
    this.primarySelectionIndex = 0;
  }

  clearVisual(): void {
    this.visual = null;
  }

  visualSnapshot(): VimVisualSnapshot | null {
    return this.visual ? cloneVisualSnapshot(this.visual) : null;
  }

  apply(edits: readonly VimEdit[], selections?: readonly VimSelection[]): void {
    if (edits.length === 0) {
      if (selections) this.setSelections(selections);
      return;
    }
    if (this.historyGroupSnapshot) {
      if (!this.historyGroupRecorded) {
        this.undoStack.push(this.historyGroupSnapshot);
        this.redoStack.length = 0;
        this.historyGroupRecorded = true;
      }
    } else {
      this.undoStack.push(this.snapshot());
      this.redoStack.length = 0;
    }
    const ordered = [...edits].sort((left, right) => right.from - left.from);
    for (const edit of ordered) {
      const from = clamp(edit.from, 0, this.value.length);
      const to = clamp(edit.to, from, this.value.length);
      this.value = `${this.value.slice(0, from)}${edit.insert}${this.value.slice(to)}`;
    }
    if (selections) {
      this.setSelections(selections);
    } else {
      const last = ordered[ordered.length - 1];
      const cursor = last ? last.from + last.insert.length : 0;
      this.selected = [{ anchor: cursor, head: cursor }];
      this.visual = null;
      this.primarySelectionIndex = 0;
    }
  }

  beginHistoryGroup(): void {
    if (this.historyGroupSnapshot) return;
    this.historyGroupSnapshot = this.snapshot();
    this.historyGroupRecorded = false;
  }

  endHistoryGroup(): void {
    this.historyGroupSnapshot = null;
    this.historyGroupRecorded = false;
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    return true;
  }

  private snapshot(): Snapshot {
    return {
      text: this.value,
      selections: this.selected.map((selection) => ({ ...selection })),
    };
  }

  private restore(snapshot: Snapshot): void {
    this.value = snapshot.text;
    this.selected = snapshot.selections.map((selection) => ({ ...selection }));
    this.visual = null;
    this.primarySelectionIndex = 0;
  }
}

function normalizeVisualSnapshot(
  snapshot: VimVisualSnapshot,
  length: number,
): VimVisualSnapshot {
  return {
    mode: snapshot.mode,
    anchor: clamp(snapshot.anchor, 0, length),
    head: clamp(snapshot.head, 0, length),
    activePosition: clamp(snapshot.activePosition, 0, length),
    ranges: normalizeSelections(snapshot.ranges, length).map(({ anchor, head }) => ({
      anchor: Math.min(anchor, head),
      head: Math.max(anchor, head),
    })),
  };
}

function cloneVisualSnapshot(snapshot: VimVisualSnapshot): VimVisualSnapshot {
  return {
    ...snapshot,
    ranges: snapshot.ranges.map((range) => ({ ...range })),
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
