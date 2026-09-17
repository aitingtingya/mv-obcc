import { countCharacters, iterateCharacters } from "./characters";

/** A replayable key sequence, not a new command or editing semantics. */
export interface VimKeySequence extends Iterable<string> { readonly length: number }
type Chunk = Readonly<{ kind: "key"; key: string; count: number }> |
  Readonly<{ kind: "text"; text: string; count: number; codePoints: boolean }>;

/** Immutable chunks make snapshots cheap; replay still visits every original key. */
export class VimKeyTape implements VimKeySequence {
  private chunks: Chunk[] = [];
  private keyCount = 0;
  get length(): number { return this.keyCount; }
  get chunkCount(): number { return this.chunks.length; }

  static from(keys: Iterable<string>): VimKeyTape {
    const tape = new VimKeyTape(); tape.append(keys); return tape;
  }

  push(...keys: string[]): void { for (const key of keys) this.repeat(key, 1); }

  repeat(key: string, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid Vim key repetition count");
    if (count === 0) return;
    const last = this.chunks.at(-1);
    if (last?.kind === "key" && last.key === key) this.chunks[this.chunks.length - 1] = { kind: "key", key, count: last.count + count };
    else this.chunks.push({ kind: "key", key, count });
    this.keyCount += count;
  }

  appendText(text: string, codePoints = false): void {
    if (!text) return;
    let count = 0;
    if (codePoints) { const iterator = text[Symbol.iterator](); while (!iterator.next().done) count++; }
    else count = countCharacters(text);
    // Do not join separately typed text: e + combining mark were two input
    // events and must remain two replay keys, even though their display joins.
    this.chunks.push({ kind: "text", text, count, codePoints });
    this.keyCount += count;
  }

  append(keys: Iterable<string>): void {
    if (keys instanceof VimKeyTape) {
      for (const chunk of keys.chunks.slice()) this.chunks.push(chunk);
      this.keyCount += keys.keyCount;
    } else for (const key of keys) this.push(key);
  }

  clone(): VimKeyTape {
    const copy = new VimKeyTape(); copy.chunks = this.chunks.slice(); copy.keyCount = this.keyCount; return copy;
  }

  *[Symbol.iterator](): IterableIterator<string> {
    for (const chunk of this.chunks) {
      if (chunk.kind === "key") { for (let index = 0; index < chunk.count; index++) yield chunk.key; }
      else if (chunk.codePoints) yield* chunk.text;
      else yield* iterateCharacters(chunk.text);
    }
  }
}

/** Same prefix override as the array implementation, without copying the tape. */
export function* overrideRecordedCount(original: Iterable<string>, count: number): IterableIterator<string> {
  const iterator = original[Symbol.iterator]();
  let current = iterator.next();
  if (current.value === '"') {
    yield current.value; current = iterator.next();
    if (!current.done) yield current.value;
    current = iterator.next();
  }
  while (!current.done && /^\d$/u.test(current.value)) current = iterator.next();
  yield* String(count);
  if (!current.done && ["d", "c", "y", ">", "<", "="].includes(current.value)) {
    yield current.value; current = iterator.next();
    while (!current.done && /^\d$/u.test(current.value)) current = iterator.next();
  }
  while (!current.done) { yield current.value; current = iterator.next(); }
}
