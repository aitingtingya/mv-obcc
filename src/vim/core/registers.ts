import type { VimClipboard, VimEngineHooks, VimOptions, VimRegister } from "./types";
import type { VimSession } from "./session";
import type { VimKeySequence } from "./key-tape";

export function clipboardTarget(options: VimOptions): "+" | "*" | null {
  const flags = options.clipboard.split(",");
  return flags.includes("unnamedplus") ? "+" : flags.includes("unnamed") ? "*" : null;
}

/** One resolver for puts, Insert registers, Visual replacement and future APIs. */
export function readVimRegister(
  name: string, session: VimSession, options: VimOptions, clipboard: VimClipboard | undefined,
): VimRegister | Promise<VimRegister> {
  const target = name === '"' ? clipboardTarget(options) ?? name : name;
  if (target !== "+" && target !== "*") return session.readRegister(target);
  if (!clipboard) throw new Error("System clipboard is unavailable.");
  return clipboard.read(target);
}

/** Keep older synchronous host hooks usable while supporting typed providers. */
export function clipboardFromHooks(hooks: VimEngineHooks): VimClipboard | undefined {
  if (hooks.clipboard) return hooks.clipboard;
  if (!hooks.readClipboard && !hooks.writeClipboard) return undefined;
  const own = new Map<string, VimRegister>();
  return {
    read(register) {
      if (!hooks.readClipboard) throw new Error("System clipboard reading is unavailable.");
      const text = hooks.readClipboard(register);
      const previous = own.get(register);
      return previous?.text === text ? { ...previous } : { text, kind: text.endsWith("\n") ? "line" : "character" };
    },
    write(register, value) {
      if (!hooks.writeClipboard) throw new Error("System clipboard writing is unavailable.");
      hooks.writeClipboard(value.text, register);
      own.set(register, { ...value });
    },
  };
}

export function clipboardWriteTargets(name: string, options: VimOptions, yank: boolean): Array<"+" | "*"> {
  if (name === "+" || name === "*") return [name];
  if (name !== '"') return [];
  const target = clipboardTarget(options);
  if (!target) return [];
  return yank && target === "+" && options.clipboard.split(",").includes("unnamed") ? ["+", "*"] : [target];
}

const keyCodes: Record<string, string> = {
  "<Esc>": "\x1b", "<CR>": "\r", "<Tab>": "\t", "<BS>": "\b", "<Del>": "\x7f",
  "<Right>": "\x80kr", "<Left>": "\x80kl", "<Up>": "\x80ku", "<Down>": "\x80kd",
  "<Home>": "\x80kh", "<End>": "\x80@7", "<PageUp>": "\x80kP", "<PageDown>": "\x80kN",
};

export function macroText(keys: Iterable<string>): string {
  const chunks: string[] = [];
  let chunk = "";
  for (const key of keys) {
    chunk += keyCodes[key] ?? (/^<C-[a-z[\]\\^_]>$/iu.test(key) ? String.fromCharCode(key.charCodeAt(3) & 31) : key);
    if (chunk.length >= 8192) { chunks.push(chunk); chunk = ""; }
  }
  chunks.push(chunk);
  return chunks.join("");
}

export function macroKeys(text: string): string[] {
  return Array.from(iterateMacroKeys(text));
}

export function macroSequence(text: string): VimKeySequence {
  let length = 0;
  const iterator = iterateMacroKeys(text);
  while (!iterator.next().done) length++;
  return { length, [Symbol.iterator]: () => iterateMacroKeys(text) };
}

function* iterateMacroKeys(text: string): IterableIterator<string> {
  for (let index = 0; index < text.length;) {
    const special = text[index] === "\x80" ? Object.entries(keyCodes).find(([, code]) => code.length === 3 && text.startsWith(code, index)) : undefined;
    if (special) { yield special[0]; index += 3; continue; }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    index += character.length;
    const named = Object.entries(keyCodes).find(([, code]) => code === character)?.[0];
    if (named) { yield named; continue; }
    const code = character.charCodeAt(0);
    yield code > 0 && code < 27 ? `<C-${String.fromCharCode(code + 96)}>` : character;
  }
}
