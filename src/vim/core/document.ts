import type { VimBuffer } from "./types";

/** Opaque immutable content; core never depends on a host's document classes. */
export interface VimDocumentSnapshot {
  readonly length: number;
  text(from?: number, to?: number): string;
  equals(other: VimDocumentSnapshot): boolean;
}

export class StringVimDocument implements VimDocumentSnapshot {
  constructor(private readonly value: string) {}
  get length(): number { return this.value.length; }
  text(from = 0, to = this.length): string { return this.value.slice(from, to); }
  equals(other: VimDocumentSnapshot): boolean {
    return this === other || this.length === other.length && this.value === other.text();
  }
}

export function snapshotVimDocument(buffer: VimBuffer): VimDocumentSnapshot {
  return buffer.documentSnapshot?.() ?? new StringVimDocument(buffer.text());
}
