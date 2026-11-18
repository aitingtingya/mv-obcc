import type {
  VimBuffer,
  VimEdit,
  VimMode,
  VimOptions,
  VimRegister,
  VimRuntimeConfig,
} from "../core/types";
import { characterStart } from "../core/characters";
import type { ScriptEditor } from "./contracts";
import { integer, numberValue, type VimValue } from "./value";
export interface ScriptEditorAccess {
  buffer: VimBuffer;
  mode(): VimMode;
  options(): VimOptions;
  apply(edits: VimEdit[]): void;
  cursor(): number;
  setCursor(position: number): void;
  marks: Map<string, number>;
  readRegister(name: string): VimRegister | Promise<VimRegister>;
  writeRegister(name: string, value: VimRegister): void;
  normal(keys: string, remap: boolean): Promise<void>;
  ex(command: string): Promise<void>;
  configure(config: VimRuntimeConfig): void;
  message(text: string, error: boolean): void;
  beginEdit(): void;
  endEdit(): void;
}
let nextViewId = 0;
/** All byte-coordinate conversion and line mutation is centralized at this boundary. */
export function createScriptEditor(access: ScriptEditorAccess): ScriptEditor {
  const buffer = access.buffer,
    id = buffer.id,
    viewId = `vim-script-view-${++nextViewId}`;
  const current = () => {
    if (buffer.id !== id)
      throw new Error("Script editor has switched to another document");
  };
  const position = (lineNumber: number, column: number): number => {
    const line = buffer.line(
      Math.max(1, Math.min(buffer.lineCount, lineNumber)),
    );
    const prefix = new TextEncoder()
      .encode(line.text)
      .slice(0, Math.max(0, column - 1));
    let at = new TextDecoder().decode(prefix).replace(/\uFFFD$/u, "").length;
    at = characterStart(line.text, Math.min(at, line.text.length));
    return line.from + at;
  };
  const location = (offset: number): [number, number] => {
    const line = buffer.lineAt(offset);
    return [
      line.number,
      new TextEncoder().encode(buffer.text(line.from, offset)).length + 1,
    ];
  };
  return {
    id,
    viewId,
    path: id,
    lines: () => {
      current();
      return buffer.text().split("\n");
    },
    lineCount: () => { current(); return buffer.lineCount; },
    line: (number) => { current(); return number < 1 || number > buffer.lineCount ? "" : buffer.line(number).text; },
    cursor: () => {
      current();
      return location(access.cursor());
    },
    setCursor: (line, column) => {
      current();
      access.setCursor(position(line, column));
    },
    replaceLines: (start, remove, lines) => {
      current();
      if (buffer.readOnly)
        throw new Error("E21: Cannot make changes, buffer is read-only");
      const savedCursor = location(access.cursor());
      let from =
        start < buffer.lineCount ? buffer.line(start + 1).from : buffer.length;
      const endLine = Math.min(buffer.lineCount, start + remove);
      let to =
        endLine < buffer.lineCount
          ? buffer.line(endLine + 1).from
          : buffer.length;
      let insert = lines.join("\n");
      if (!remove) {
        to = from;
        if (lines.length)
          insert = start < buffer.lineCount ? insert + "\n" : "\n" + insert;
      } else if (endLine < buffer.lineCount) {
        if (lines.length) insert += "\n";
      } else if (start > 0 && !lines.length) from = buffer.line(start).to;
      const before = buffer.text(from, to);
      if (before === insert) return;
      let prefix = 0;
      while (
        prefix < before.length &&
        prefix < insert.length &&
        before[prefix] === insert[prefix]
      )
        prefix++;
      prefix = Math.min(
        characterStart(before, prefix),
        characterStart(insert, prefix),
      );
      let end = before.length,
        tail = insert.length;
      while (
        end > prefix &&
        tail > prefix &&
        before[end - 1] === insert[tail - 1]
      ) {
        end--;
        tail--;
      }
      while (end < before.length && characterStart(before, end) !== end) {
        end++;
        tail++;
      }
      access.apply([
        {
          from: from + prefix,
          to: from + end,
          insert: insert.slice(prefix, tail),
        },
      ]);
      if (remove === lines.length) access.setCursor(position(...savedCursor));
    },
    mark: (name) => {
      const at = access.marks.get(name);
      return at === undefined ? [0, 0] : location(at);
    },
    setMark: (name, line, col) => access.marks.set(name, position(line, col)),
    mode: access.mode.bind(access),
    options: access.options.bind(access),
    readRegister: access.readRegister.bind(access),
    writeRegister: access.writeRegister.bind(access),
    normal: (keys, remap) => {
      current();
      return access.normal(keys, remap);
    },
    ex: (command) => {
      current();
      return access.ex(command);
    },
    configure: access.configure.bind(access),
    message: access.message.bind(access),
    saveView: () => {
      const [line, col] = location(access.cursor()),
        viewport = buffer.saveScriptView?.() ?? { topline: 1, leftcol: 0 };
      return new Map<string, VimValue>([
        ["lnum", integer(line)],
        ["col", integer(col - 1)],
        ["curswant", integer(col - 1)],
        ["topline", integer(viewport.topline)],
        ["leftcol", integer(viewport.leftcol)],
        ["topfill", 0n],
        ["skipcol", 0n],
      ]);
    },
    restoreView: (value) => {
      const current = location(access.cursor());
      access.setCursor(
        position(
          numberValue(value.get("lnum") ?? integer(current[0])),
          numberValue(value.get("col") ?? integer(current[1] - 1)) + 1,
        ),
      );
      if (value.has("topline"))
        buffer.restoreScriptView?.({
          topline: numberValue(value.get("topline")!),
          leftcol: numberValue(value.get("leftcol") ?? 0n),
        });
    },
    beginEdit: access.beginEdit.bind(access),
    endEdit: access.endEdit.bind(access),
  };
}
