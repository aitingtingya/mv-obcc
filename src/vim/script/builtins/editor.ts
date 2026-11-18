import { configurationEditor } from "../configuration-editor";
import { requireEditor, type VimScriptRuntime } from "../runtime";
import type { ScriptRegistry } from "../registry";
import {
  dictValue,
  integer,
  listValue,
  numberValue,
  stringValue,
  truth,
  type VimValue,
} from "../value";
import type { ScriptEditor, ScriptFrame } from "../contracts";
function lineNumber(value: VimValue, editor: ScriptEditor): number {
  if (value === ".") return editor.cursor()[0];
  if (value === "$") return editor.lineCount();
  if (typeof value === "string" && value.startsWith("'"))
    return editor.mark(value.slice(1))[0];
  return numberValue(value);
}
function targetEditor(
  runtime: VimScriptRuntime,
  value: VimValue,
  frame: ScriptFrame,
): ScriptEditor {
  const editors = [...runtime.editors.values()];
  const found =
    value === "%" || value === 0n
      ? frame.editor
      : typeof value === "bigint"
        ? runtime.bufferEditor(Number(value))
        : editors.find(
            (editor) => editor.path === value || editor.id === value,
          );
  if (!found)
    throw new Error(`E86: Buffer does not exist: ${stringValue(value)}`);
  return frame.execution.configurationOnly ? configurationEditor(found) : found;
}
export function registerEditorFunctions(
  registry: ScriptRegistry,
  runtime: VimScriptRuntime,
): void {
  const add = registry.add.bind(registry);
  add("getline", 1, 2, "Read current buffer lines", ([start, end], ctx) => {
    const editor = requireEditor(ctx.frame),
      first = lineNumber(start, editor);
    return end === undefined
      ? editor.line(first)
      : editorLines(editor, first, lineNumber(end, editor));
  });
  add(
    "getbufline",
    2,
    3,
    "Read an open buffer",
    ([buffer, start, end], ctx) => {
      const editor = targetEditor(runtime, buffer, ctx.frame);
      return editorLines(editor, lineNumber(start, editor), lineNumber(end ?? start, editor));
    },
  );
  for (const name of [
    "setline",
    "append",
    "setbufline",
    "appendbufline",
  ] as const)
    add(
      name,
      name.includes("buf") ? 3 : 2,
      name.includes("buf") ? 3 : 2,
      "Edit through the owning editor",
      (args, ctx) => {
        const args_ = [...args],
          editor = name.includes("buf")
            ? targetEditor(runtime, args_.shift()!, ctx.frame)
            : requireEditor(ctx.frame);
        const [at, content] = args_;
        const lines = Array.isArray(content)
            ? content.map(stringValue)
            : [stringValue(content)],
          first = lineNumber(at, editor),
          append = name.startsWith("append"),
          count = editor.lineCount();
        if (first < (append ? 0 : 1) || first > count + (append ? 0 : 1))
          return 1n;
        editor.replaceLines(
          append ? first : first - 1,
          append ? 0 : Math.min(lines.length, count - first + 1),
          lines,
        );
        return 0n;
      },
    );
  add(
    "deletebufline",
    2,
    3,
    "Delete lines through the owning editor",
    ([buffer, first, last], ctx) => {
      const editor = targetEditor(runtime, buffer, ctx.frame),
        start = lineNumber(first, editor),
        end = lineNumber(last ?? first, editor);
      if (start < 1 || start > editor.lineCount()) return 1n;
      editor.replaceLines(start - 1, end - start + 1, []);
      return 0n;
    },
  );
  add("line", 1, 2, "Resolve a line address", ([v], ctx) =>
    integer(lineNumber(v, requireEditor(ctx.frame))),
  );
  add("col", 1, 2, "UTF-8 cursor/mark column", ([v], ctx) => {
    const editor = requireEditor(ctx.frame);
    if (v === ".") return integer(editor.cursor()[1]);
    if (v === "$")
      return integer(
        new TextEncoder().encode(editor.line(editor.cursor()[0]))
          .length + 1,
      );
    if (typeof v === "string" && v.startsWith("'"))
      return integer(editor.mark(v.slice(1))[1]);
    if (Array.isArray(v)) return v[1];
    return 0n;
  });
  add("cursor", 1, 3, "Move the current cursor", (args, ctx) => {
    const position = Array.isArray(args[0]) ? args[0] : args;
    requireEditor(ctx.frame).setCursor(
      numberValue(position[0]),
      numberValue(position[1]),
    );
    return 0n;
  });
  add("getpos", 1, 1, "Get a cursor or mark position", ([v], ctx) => {
    const editor = requireEditor(ctx.frame),
      [line, col] =
        v === "."
          ? editor.cursor()
          : editor.mark(stringValue(v).replace(/^'/u, ""));
    return [0n, integer(line), integer(col), 0n];
  });
  add("getcurpos", 0, 1, "Get current position", (_args, ctx) => {
    const [line, col] = requireEditor(ctx.frame).cursor();
    return [0n, integer(line), integer(col), 0n, integer(col)];
  });
  add(
    "setpos",
    2,
    2,
    "Restore cursor or mark position",
    ([name, position], ctx) => {
      const editor = requireEditor(ctx.frame),
        values = listValue(position);
      if (name === ".")
        editor.setCursor(numberValue(values[1]), numberValue(values[2]));
      else
        editor.setMark(
          stringValue(name).replace(/^'/u, ""),
          numberValue(values[1]),
          numberValue(values[2]),
        );
      return 0n;
    },
  );
  add(
    "getreg",
    0,
    3,
    "Read a register",
    async ([name = '"', _expr = 0n, asList = 0n], ctx) => {
      const value = await requireEditor(ctx.frame).readRegister(
        stringValue(name),
      );
      return truth(asList)
        ? value.text.replace(/\n$/u, "").split("\n")
        : value.text;
    },
  );
  add("getregtype", 0, 1, "Read register type", async ([name = '"'], ctx) => {
    const value = await requireEditor(ctx.frame).readRegister(
      stringValue(name),
    );
    return value.kind === "line"
      ? "V"
      : value.kind === "block"
        ? `\x16${value.blockWidth ?? 0}`
        : "v";
  });
  add(
    "setreg",
    2,
    3,
    "Write a register",
    ([name, value, rawType = ""], ctx) => {
      const type = stringValue(rawType),
        lines = Array.isArray(value),
        text = lines ? value.map(stringValue).join("\n") : stringValue(value),
        kind =
          type.startsWith("V") ||
          type === "l" ||
          (!type && (lines || text.endsWith("\n")))
            ? "line"
            : type.startsWith(String.fromCharCode(22)) || type.startsWith("b")
              ? "block"
              : "character";
      requireEditor(ctx.frame).writeRegister(stringValue(name), {
        text: kind === "line" && !text.endsWith("\n") ? text + "\n" : text,
        kind,
        ...(kind === "block"
          ? {
              blockWidth:
                Number(type.slice(1)) ||
                Math.max(...text.split("\n").map((line) => [...line].length)),
            }
          : {}),
      });
      return 0n;
    },
  );
  add("mode", 0, 1, "Current editor mode", (_args, ctx) => {
    const mode = requireEditor(ctx.frame).mode();
    return (
      (
        {
          normal: "n",
          insert: "i",
          replace: "R",
          "visual-line": "V",
          "visual-block": "\x16",
          visual: "v",
          "operator-pending": "no",
          "command-line": "c",
        } as Record<string, string>
      )[mode] ?? "s"
    );
  });
  add("bufnr", 0, 1, "Number of an open buffer", ([name = "%"], ctx) => {
    try {
      const editor = targetEditor(runtime, name, ctx.frame);
      return integer(runtime.bufferNumber(editor));
    } catch {
      return -1n;
    }
  });
  add("bufname", 0, 1, "Name of an open buffer", ([name = "%"], ctx) => {
    try {
      return targetEditor(runtime, name, ctx.frame).path;
    } catch {
      return "";
    }
  });
  add("bufexists", 1, 1, "Open buffer availability", ([name], ctx) => {
    try {
      targetEditor(runtime, name, ctx.frame);
      return 1n;
    } catch {
      return 0n;
    }
  });
  add("winsaveview", 0, 0, "Save editor view", (_args, ctx) =>
    requireEditor(ctx.frame).saveView(),
  );
  add("winrestview", 1, 1, "Restore editor view", ([view], ctx) => {
    requireEditor(ctx.frame).restoreView(dictValue(view));
    return 0n;
  });
  add(
    "maparg",
    1,
    4,
    "Query an effective mapping",
    ([lhs, mode = "n", _abbr = 0n, asDict = 0n], ctx) => {
      const mapping = runtime
        .effectiveMappings(ctx.frame.editor)
        .find(
          (m) =>
            m.lhs.join("") === lhs &&
            m.modes.some((v) => v.startsWith(stringValue(mode))),
        );
      if (!mapping) return truth(asDict) ? new Map() : "";
      return truth(asDict)
        ? new Map<string, VimValue>([
            ["lhs", mapping.lhs.join("")],
            ["rhs", mapping.rhsText],
            ["noremap", BigInt(!mapping.recursive)],
            ["expr", BigInt(!!mapping.expression)],
            ["buffer", BigInt(!!mapping.bufferId)],
            ["silent", BigInt(mapping.silent)],
            ["sid", integer(mapping.scriptId)],
          ])
        : mapping.rhsText;
    },
  );
  add(
    "mapcheck",
    1,
    3,
    "Query a mapping prefix",
    ([lhs, mode = "n"], ctx) =>
      runtime
        .effectiveMappings(ctx.frame.editor)
        .find(
          (m) =>
            (m.lhs.join("").startsWith(stringValue(lhs)) ||
              stringValue(lhs).startsWith(m.lhs.join(""))) &&
            m.modes.some((v) => v.startsWith(stringValue(mode))),
        )
        ?.rhs.join("") ?? "",
  );
  add("hasmapto", 1, 3, "Find mappings to an RHS", ([rhs, mode = "n"], ctx) =>
    BigInt(
      runtime
        .effectiveMappings(ctx.frame.editor)
        .some(
          (m) =>
            m.rhs.join("").includes(stringValue(rhs)) &&
            m.modes.some((v) => stringValue(mode).includes(v[0])),
        ),
    ),
  );
  add(
    "expand",
    1,
    3,
    "Expand script/editor names",
    ([value, _nosuf = 0n, asList = 0n], ctx) => {
      const raw = stringValue(value);
      let expanded: VimValue;
      if (raw === "<sfile>")
        expanded = ctx.frame.specials.get("sfile") ?? ctx.frame.source;
      else if (raw === "<SID>") expanded = `<SNR>${ctx.frame.scriptId}_`;
      else if (raw === "<amatch>" || raw === "<afile>")
        expanded = ctx.frame.specials.get(raw.slice(1, -1)) ?? "";
      else if (runtime.host)
        expanded = runtime.host.pathFunction(
          "expand",
          [value],
          ctx.frame.source,
          ctx.frame.editor,
        );
      else if (raw === "%") expanded = ctx.frame.editor?.path ?? "";
      else throw new Error(`Unsupported path expansion: ${raw}`);
      return truth(asList) ? [expanded] : expanded;
    },
  );
  add("fnamemodify", 2, 2, "Modify a file name", (args, ctx) => {
    if (!runtime.host) throw new Error("Path functions require a script host");
    return runtime.host.pathFunction(
      "fnamemodify",
      args,
      ctx.frame.source,
      ctx.frame.editor,
    );
  });
  add("fnameescape", 1, 1, "Escape an Ex file argument", ([value]) =>
    stringValue(value).replace(/[\s*?[\]{}'"`$\\%#|!<>]/gu, "\\$&"),
  );
}

function editorLines(editor: ScriptEditor, first: number, last: number): string[] { const values: string[] = []; for (let number = Math.max(1, first); number <= Math.min(editor.lineCount(), last); number++) values.push(editor.line(number)); return values; }
