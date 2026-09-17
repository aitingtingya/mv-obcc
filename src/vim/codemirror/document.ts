import type { Text } from "@codemirror/state";
import type { VimDocumentSnapshot } from "../core/document";

export class CodeMirrorVimDocument implements VimDocumentSnapshot {
  constructor(private readonly document: Text) {}
  get length(): number { return this.document.length; }
  text(from = 0, to = this.length): string { return this.document.sliceString(from, to); }
  equals(other: VimDocumentSnapshot): boolean {
    if (other instanceof CodeMirrorVimDocument) return this.document.eq(other.document);
    return this.length === other.length && this.text() === other.text();
  }
}
