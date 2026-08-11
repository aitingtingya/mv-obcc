import type { VimRegister, VimRegisterKind } from "./types";

const EMPTY_REGISTER: VimRegister = { text: "", kind: "character" };

export class VimSession {
  private readonly registers = new Map<string, VimRegister>();
  private readonly macros = new Map<string, string[]>();

  readRegister(name = '"'): VimRegister {
    const normalized = normalizeRegisterName(name);
    return { ...(this.registers.get(normalized) ?? EMPTY_REGISTER) };
  }

  writeYank(name: string, text: string, kind: VimRegisterKind): void {
    if (normalizeRegisterName(name) === "_") return;
    const value = { text, kind };
    this.registers.set('"', value);
    this.registers.set("0", value);
    this.writeExplicit(name, value);
  }

  writeDelete(
    name: string,
    text: string,
    kind: VimRegisterKind,
    small: boolean,
  ): void {
    if (normalizeRegisterName(name) === "_") return;
    const value = { text, kind };
    this.registers.set('"', value);
    if (small && kind === "character" && !text.includes("\n")) {
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

  writeRegister(name: string, text: string, kind: VimRegisterKind): void {
    if (normalizeRegisterName(name) === "_") return;
    const value = { text, kind };
    this.registers.set('"', value);
    this.writeExplicit(name, value);
  }

  registerEntries(): readonly [string, VimRegister][] {
    return [...this.registers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, { ...value }]);
  }

  setMacro(name: string, keys: readonly string[]): void {
    this.macros.set(normalizeRegisterName(name), [...keys]);
  }

  readMacro(name: string): readonly string[] {
    return [...(this.macros.get(normalizeRegisterName(name)) ?? [])];
  }

  private writeExplicit(name: string, value: VimRegister): void {
    const normalized = normalizeRegisterName(name);
    if (normalized === "_") return;
    if (/^[A-Z]$/.test(name)) {
      const lower = name.toLowerCase();
      const previous = this.registers.get(lower) ?? EMPTY_REGISTER;
      this.registers.set(lower, {
        text: previous.text + value.text,
        kind: previous.kind === "line" || value.kind === "line"
          ? "line"
          : value.kind,
      });
      return;
    }
    if (normalized !== '"') this.registers.set(normalized, value);
  }
}

function normalizeRegisterName(name: string): string {
  return name.length > 0 ? name[0].toLowerCase() : '"';
}
