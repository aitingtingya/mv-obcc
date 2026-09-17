import type { VimRegister, VimRegisterKind } from "./types";
import { macroKeys, macroText, macroSequence } from "./registers";
import type { VimKeySequence } from "./key-tape";
import type { VimDocumentSnapshot } from "./document";

const EMPTY_REGISTER: VimRegister = { text: "", kind: "character" };

export class VimSession {
  private readonly registers = new Map<string, VimRegister>();
  private lastMacro = "";
  readonly searchHistory: string[] = [];
  readonly commandHistory: string[] = [];
  searchPattern = "";
  searchDirection: -1 | 1 = 1;
  private readonly bufferMarks = new Map<string, Map<string, number>>();
  private readonly markDocuments = new Map<string, VimDocumentSnapshot>();
  private readonly bufferOwners = new Map<string, number>();
  readonly fileMarks = new Map<string, { bufferId: string; position: number }>();

  marksFor(bufferId: string): Map<string, number> {
    let marks = this.bufferMarks.get(bufferId);
    if (!marks) this.bufferMarks.set(bufferId, marks = new Map<string, number>());
    return marks;
  }

  retainBuffer(bufferId: string, document: VimDocumentSnapshot): void {
    this.bufferOwners.set(bufferId, (this.bufferOwners.get(bufferId) ?? 0) + 1);
    if (!this.markDocuments.has(bufferId)) this.markDocuments.set(bufferId, document);
  }

  releaseBuffer(bufferId: string): void {
    const owners = this.bufferOwners.get(bufferId) ?? 0;
    if (owners > 1) this.bufferOwners.set(bufferId, owners - 1);
    else { this.bufferOwners.delete(bufferId); this.markDocuments.delete(bufferId); }
  }

  mapBufferMarks(bufferId: string, before: VimDocumentSnapshot, after: VimDocumentSnapshot, map: (position: number) => number): void {
    // Two views receive the same edit independently; buffer-local marks move once.
    const observed = this.markDocuments.get(bufferId);
    if (observed?.equals(after)) return;
    if (observed !== undefined && !observed.equals(before)) return;
    for (const [name, position] of this.marksFor(bufferId)) this.marksFor(bufferId).set(name, map(position));
    for (const mark of this.fileMarks.values()) if (mark.bufferId === bufferId) mark.position = map(mark.position);
    this.markDocuments.set(bufferId, after);
  }

  readRegister(name = '"'): VimRegister {
    const normalized = normalizeRegisterName(name);
    return { ...(this.registers.get(normalized) ?? EMPTY_REGISTER) };
  }

  writeYank(name: string, text: string, kind: VimRegisterKind, blockWidth?: number): void {
    if (normalizeRegisterName(name) === "_") return;
    const value = { text, kind, ...(blockWidth === undefined ? {} : { blockWidth }) };
    this.registers.set('"', value);
    if (name === '"') this.registers.set("0", value);
    this.writeExplicit(name, value);
  }

  writeDelete(
    name: string,
    text: string,
    kind: VimRegisterKind,
    small: boolean,
    blockWidth?: number,
  ): void {
    if (normalizeRegisterName(name) === "_") return;
    const value = { text, kind, ...(blockWidth === undefined ? {} : { blockWidth }) };
    this.registers.set('"', value);
    if (small && kind !== "line" && !text.includes("\n") && name === '"') {
      this.registers.set("-", value);
    } else {
      for (let index = 9; index >= 2; index -= 1) {
        const previous = this.registers.get(String(index - 1));
        if (previous) this.registers.set(String(index), previous);
      }
      this.registers.set("1", value);
    }
    this.writeExplicit(name, value);
  }

  writeRegister(name: string, text: string, kind: VimRegisterKind, blockWidth?: number): void {
    if (normalizeRegisterName(name) === "_") return;
    const value = { text, kind, ...(blockWidth === undefined ? {} : { blockWidth }) };
    this.registers.set('"', value);
    this.writeExplicit(name, value);
  }

  registerEntries(): readonly [string, VimRegister][] {
    return [...this.registers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, { ...value }]);
  }

  setMacro(name: string, keys: Iterable<string>): void {
    this.writeExplicit(name, { text: macroText(keys), kind: "character" });
  }

  readMacro(name: string): readonly string[] {
    const target = name === "@" ? this.lastMacro : normalizeRegisterName(name);
    if (target) this.lastMacro = target;
    return macroKeys(this.readRegister(target).text);
  }

  readMacroSequence(name: string): VimKeySequence {
    const target = name === "@" ? this.lastMacro : normalizeRegisterName(name);
    if (target) this.lastMacro = target;
    return macroSequence(this.readRegister(target).text);
  }

  setRegister(name: string, value: VimRegister): void {
    if (name !== "_") this.registers.set(normalizeRegisterName(name), { ...value });
  }

  private writeExplicit(name: string, value: VimRegister): void {
    const normalized = normalizeRegisterName(name);
    if (normalized === "_") return;
    if (/^[A-Z]$/.test(name)) {
      const lower = name.toLowerCase();
      const previous = this.registers.get(lower) ?? EMPTY_REGISTER;
      const linewise = previous.kind === "line" || value.kind === "line";
      const blockwise = previous.kind === "block" || value.kind === "block";
      const appended: VimRegister = !previous.text ? { ...value } : linewise
        ? { text: `${previous.text.replace(/\n$/u, "")}\n${value.text.replace(/\n$/u, "")}\n`, kind: "line" }
        : blockwise
          ? { text: `${previous.text}\n${value.text}`, kind: "block", blockWidth: Math.max(previous.blockWidth ?? 0, value.blockWidth ?? 0) }
          : { text: previous.text + value.text, kind: "character" };
      this.registers.set(lower, appended);
      this.registers.set('"', appended);
      return;
    }
    if (normalized !== '"') this.registers.set(normalized, value);
  }
}

function normalizeRegisterName(name: string): string {
  return name.length > 0 ? name[0].toLowerCase() : '"';
}
