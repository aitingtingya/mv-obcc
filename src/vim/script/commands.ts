import { tokenizeVimKeys } from "../core/keys";
import { parseExCommand } from "../core/ex";
import type { VimMode } from "../core/types";
import {
  binary,
  evaluate,
  parseExpression,
  parseExpressionSequence,
} from "./expression";
import { parseScript } from "./syntax";
import { ScriptControl, requireEditor, type VimScriptRuntime } from "./runtime";
import { displayValue, integer, stringValue, type VimValue } from "./value";
import type { ScriptFrame, ScriptMapping } from "./contracts";
const mapModes: Record<string, VimMode[]> = {
  "": [
    "normal",
    "visual",
    "visual-line",
    "visual-block",
    "select",
    "select-line",
    "select-block",
    "operator-pending",
  ],
  n: ["normal"],
  v: [
    "visual",
    "visual-line",
    "visual-block",
    "select",
    "select-line",
    "select-block",
  ],
  x: ["visual", "visual-line", "visual-block"],
  s: ["select", "select-line", "select-block"],
  i: ["insert"],
  c: ["command-line"],
  o: ["operator-pending"],
};
export function registerScriptCommands(runtime: VimScriptRuntime): void {
  const names = new Set([...runtime.registry.commands, 'norm', 'setf', 'delf', 'echon',
    'write','w','quit','q','wq','x','edit','e','split','sp','vsp','vsplit','buffer','b','bnext','bn','bprevious','bp','bdelete','bd','registers','marks','jumps','sort','substitute','s','delete','d','yank','y','put','copy','move','normal','global','vglobal','print','nohlsearch','obcommand']);
  for (const prefix of Object.keys(mapModes)) for (const suffix of ['map','noremap','unmap','mapclear']) names.add(prefix + suffix);
  for (const name of ['abbrev','iabbrev','inoreabbrev','unabbrev','iunabbrev']) names.add(name);
  for (const name of names) runtime.registry.addCommand(name, {
    syntax: ':' + name + ' [arguments]', description: 'Traditional Ex command; arguments are validated by its implementation',
    run: (text, frame) => executeBuiltinCommand(runtime, text, frame),
  });
}
export async function executeScriptCommand(runtime: VimScriptRuntime, text: string, frame: ScriptFrame): Promise<void> {
  const name = /^\s*:?(\w+)/u.exec(text)?.[1] ?? '';
  const capability = runtime.registry.commandHandlers.get(name);
  if (capability) await capability.run(text, frame);
  else await executeBuiltinCommand(runtime, text, frame);
}

async function executeBuiltinCommand(
  runtime: VimScriptRuntime,
  raw: string,
  frame: ScriptFrame,
): Promise<void> {
  let text = raw.trimStart().replace(/^:/u, "");
  const silent = text.match(/^silent(!?)\s+(.*)$/u);
  if (silent) {
    try {
      await executeScriptCommand(runtime, silent[2], frame);
    } catch (error) {
      if (!silent[1] || error instanceof ScriptControl) throw error;
    }
    return;
  }
  text = text.replace(
    /^(?:keepjumps|keeppatterns|keepmarks|noautocmd)\s+/u,
    "",
  );
  const head = /^(\w+)(!?)(?:\s+|$)([\s\S]*)$/u.exec(text);
  const name = head?.[1] ?? "",
    bang = head?.[2] === "!",
    rest = head?.[3] ?? "";
  const context = runtime.context(frame);
  if (name === "let") {
    const assignment = findAssignment(rest);
    if (!assignment) {
      requireEditor(frame).message(
        displayValue(context.variable(rest.trim())),
        false,
      );
      return;
    }
    const target = parseExpression(assignment.target);
    const value = await evaluate(parseExpression(assignment.value), context);
    if (assignment.operator === "+=") {
      const previous = await evaluate(target, context);
      if (Array.isArray(previous) && Array.isArray(value)) {
        for (const entry of [...value]) previous.push(entry);
        return;
      }
    }
    await runtime.assignTarget(
      target,
      assignment.operator === "="
        ? value
        : binary(
            assignment.operator.slice(0, -1),
            await evaluate(target, context),
            value,
            context,
          ),
      frame,
    );
    return;
  }
  if (name === "unlet") {
    for (const target of parseExpressionSequence(rest))
      await runtime.removeTarget(target, frame, bang);
    return;
  }
  if (["return", "finish", "break", "continue"].includes(name))
    throw new ScriptControl(
      name as "return" | "finish" | "break" | "continue",
      rest ? await evaluate(parseExpression(rest), context) : 0n,
    );
  if (name === "throw")
    throw new Error(
      stringValue(await evaluate(parseExpression(rest), context)),
    );
  if (name === "call") {
    await evaluate(parseExpression(rest), context);
    runtime.refreshEditors();
    return;
  }
  if (name === "execute") {
    const expressions = parseExpressionSequence(rest);
    const parts: string[] = [];
    for (const expression of expressions)
      parts.push(stringValue(await evaluate(expression, context)));
    await runtime.execute(
      parseScript(parts.join(" "), frame.source).statements,
      frame,
    );
    return;
  }
  if (["echo", "echomsg", "echoerr", "echon"].includes(name)) {
    const values: VimValue[] = [];
    for (const expression of parseExpressionSequence(rest))
      values.push(await evaluate(expression, context));
    const message = values
      .map((v) => displayValue(v))
      .join(name === "echon" ? "" : " ");
    if (name === "echoerr") throw new Error(message);
    frame.editor?.message(message, false);
    return;
  }
  if (["set", "setlocal", "setglobal"].includes(name)) {
    for (const arg of rest.match(/(?:\\.|[^\s])+/gu) ?? []) {
      if (arg === "all") {
        frame.editor?.message(
          [...runtime.globalOptions]
            .map(([key, v]) => `${key}=${displayValue(v)}`)
            .join("\n"),
          false,
        );
        continue;
      }
      const match =
        /^(inv|no)?([a-z]+)(\+=|-=|\^=|=|:|\?|!|<|&(?:vim|vi)?)?(.*)$/u.exec(
          arg,
        );
      if (!match) throw new Error(`E474: Invalid argument: ${arg}`);
      const whole = `${match[1] ?? ""}${match[2]}`,
        exact = runtime.hasOption(whole);
      const option = exact ? whole : match[2],
        prefix = exact ? "" : (match[1] ?? ""),
        op = match[3] ?? "";
      const target = `${name === "setglobal" ? "g:" : name === "setlocal" ? "l:" : ""}${option}`;
      const previous = runtime.getOption(target, frame);
      if (op === "<") {
        runtime.inheritOption(option, frame);
        continue;
      }
      if (op === "?" || (!op && !prefix && typeof previous !== "boolean")) {
        frame.editor?.message(`${option}=${displayValue(previous)}`, false);
        continue;
      }
      let value: VimValue;
      if (op.startsWith("&")) {
        value = runtime.defaultOption(option);
      } else if (typeof previous === "boolean")
        value =
          prefix === "no"
            ? false
            : prefix === "inv" || op === "!"
              ? !previous
              : true;
      else {
        const incoming = match[4].replace(/\\([\s|\\])/gu, "$1");
        value =
          typeof previous === "bigint" ? integer(Number(incoming)) : incoming;
        if (op === "+=")
          value =
            typeof previous === "string"
              ? previous + stringValue(value)
              : binary("+", previous, value, context);
        if (op === "-=")
          value =
            typeof previous === "string"
              ? previous.replace(stringValue(value), "")
              : binary("-", previous, value, context);
        if (op === "^=")
          value =
            typeof previous === "string"
              ? stringValue(value) + previous
              : binary("*", previous, value, context);
      }
      if (
        ["ft", "filetype"].includes(option) &&
        frame.editor &&
        name !== "setglobal"
      )
        await runtime.setFiletype(stringValue(value), frame);
      else runtime.setOption(target, value, frame, name === "setlocal");
    }
    return;
  }
  if (name === "setfiletype" || name === "setf") {
    await runtime.setFiletype(rest.trim(), frame, true);
    return;
  }
  if (name === "filetype") {
    if (!/^(?:plugin\s+)?(?:on|off)\s*$/u.test(rest))
      throw new Error(`E474: Unsupported filetype command: ${rest}`);
    const enabled = rest.trim().endsWith("on");
    if (rest.startsWith("plugin")) runtime.filetypePlugins = enabled;
    else {
      runtime.filetypeDetection = enabled;
      runtime.globals.set("did_load_filetypes", enabled ? 1n : 0n);
    }
    return;
  }
  if (name === "source" || name === "so") {
    if (!runtime.host) throw new Error("Script source I/O is unavailable");
    const source = await runtime.host.source(unquote(rest), frame.source);
    await runtime.load(source.text, source.path, frame.editor, frame);
    return;
  }
  if (name === "runtime") {
    if (!runtime.host) throw new Error("Script runtime I/O is unavailable");
    for (const pattern of rest.trim().split(/\s+/u))
      for (const source of await runtime.host.runtime(pattern, bang))
        await runtime.load(source.text, source.path, frame.editor, frame);
    return;
  }
  if (name === "packadd" || name === "packloadall") {
    if (!runtime.host) throw new Error("Script package I/O is unavailable");
    for (const source of await runtime.host.package(
      name === "packadd" ? rest.trim() : null,
      name === "packadd" && bang,
    ))
      await runtime.load(source.text, source.path, frame.editor, frame);
    return;
  }
  if (name === "scriptnames") {
    frame.editor?.message(
      runtime.loadedFiles.map((file, i) => `${i + 1}: ${file}`).join("\n"),
      false,
    );
    return;
  }
  const mapping = /^([nvxsoci]?)(noremap|map|unmap|mapclear)$/u.exec(name);
  if (mapping) {
    defineMapping(runtime, mapping[1], mapping[2], rest, frame);
    return;
  }
  if (/^i?(?:noreabbrev|abbrev(?:iate)?|unabbrev(?:iate)?)$/u.test(name)) {
    const flags = parseFlags(rest);
    const [lhs, ...rhs] = flags.text.split(/\s+/u);
    const bufferId =
      flags.flags.has("buffer") || runtime.isVirtual(frame)
        ? requireEditor(frame).id
        : undefined;
    const key = `${bufferId ?? ""}\0${lhs}`;
    if (name.includes("unab")) runtime.abbreviations.delete(key);
    else {
      if (!rhs.length) throw new Error("E471: Argument required");
      runtime.abbreviations.set(key, {
        lhs,
        bufferId,
        rhs: rhs.join(" "),
        expression: flags.flags.has("expr"),
        source: frame.source,
        scriptId: frame.scriptId,
      });
    }
    runtime.refreshEditors();
    return;
  }
  if (name === "command" || name === "com") {
    let value = rest;
    const options = new Map<string, string>();
    let flag: RegExpExecArray | null;
    while ((flag = /^-([A-Za-z]+)(?:=(\S+))?\s+/u.exec(value))) {
      options.set(flag[1], flag[2] ?? "");
      value = value.slice(flag[0].length);
    }
    const match = /^(\w+)\s+([\s\S]+)$/u.exec(value);
    if (!match || !/^[A-Z]/u.test(match[1]))
      throw new Error(
        "E183: User defined commands must start with an uppercase letter",
      );
    for (const option of options.keys())
      if (
        ![
          "nargs",
          "range",
          "count",
          "bang",
          "buffer",
          "bar",
          "register",
        ].includes(option)
      )
        throw new Error(`E181: Unsupported command attribute: -${option}`);
    const bufferId =
      options.has("buffer") || runtime.isVirtual(frame)
        ? requireEditor(frame).id
        : undefined;
    const at = runtime.commands.findIndex(
      (c) => c.name === match[1] && c.bufferId === bufferId,
    );
    if (at >= 0 && !bang)
      throw new Error(`E174: Command already exists: ${match[1]}`);
    if (at >= 0) runtime.commands.splice(at, 1);
    const nargs = options.get("nargs") ?? "0";
    if (!["0", "1", "*", "?", "+"].includes(nargs))
      throw new Error("E176: Invalid number of arguments");
    runtime.commands.push({
      name: match[1],
      replacement: match[2],
      body: { source: frame.source, statements: [] },
      source: frame.source,
      scriptId: frame.scriptId,
      bufferId,
      nargs,
      range: options.has("range") ? options.get("range")! : null,
      count: options.has("count") ? Number(options.get("count") || 0) : null,
      bang: options.has("bang"),
      bar: options.has("bar"),
      register: options.has("register"),
    });
    return;
  }
  if (name === "delcommand" || name === "delc") {
    const at = runtime.commands.findIndex(
      (c) =>
        c.name === rest.trim() &&
        (!c.bufferId || c.bufferId === frame.editor?.id),
    );
    if (at < 0) throw new Error(`E184: No such user-defined command: ${rest}`);
    runtime.commands.splice(at, 1);
    return;
  }
  if (name === "delfunction" || name === "delf") {
    if (
      !runtime.functions.delete(runtime.qualify(rest.trim(), frame.scriptId)) &&
      !bang
    )
      throw new Error(`E130: Unknown function: ${rest}`);
    return;
  }
  if (name === "augroup") {
    if (bang) {
      runtime.groups.delete(rest.trim());
      for (let i = runtime.autocmds.length - 1; i >= 0; i--)
        if (runtime.autocmds[i].group === rest.trim())
          runtime.autocmds.splice(i, 1);
    } else runtime.setGroup(rest.trim());
    return;
  }
  if (name === "autocmd" || name === "au") {
    defineAutocmd(runtime, rest, frame, bang);
    return;
  }
  if (name === "doautocmd" || name === "doautoall") {
    const args = rest
      .replace(/^<nomodeline>\s*/u, "")
      .trim()
      .split(/\s+/u);
    const group = runtime.groups.has(args[0]) ? args.shift() : undefined;
    const event = args.shift()!;
    if (!runtime.registry.events.has(event))
      throw new Error(`E216: No such event: ${event}`);
    const targets =
      name === "doautoall"
        ? [...new Map([...runtime.editors.values()].map((editor) => [editor.id, editor])).values()]
        : [requireEditor(frame)];
    for (const editor of targets)
      await runtime.emit(event, editor, args.join(" ") || editor.path, frame, group);
    return;
  }
  if (name === "normal" || name === "norm") {
    await requireEditor(frame).normal(rest, !bang);
    return;
  }
  if (await invokeUserCommand(runtime, text, frame)) return;
  await requireEditor(frame).ex(text);
}
function findAssignment(text: string): {
  target: string;
  operator: string;
  value: string;
} | null {
  let quote = "",
    depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = "";
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (
      depth === 0 &&
      c === "=" &&
      !["=", "~"].includes(text[i + 1]) &&
      !/[=!<>]/u.test(text[i - 1] ?? "")
    ) {
      const start = /[+\-.*/%]/u.test(text[i - 1] ?? "") ? i - 1 : i;
      return {
        target: text.slice(0, start).trim(),
        operator: text.slice(start, i + 1),
        value: text.slice(i + 1),
      };
    }
  }
  return null;
}
function unquote(value: string): string {
  return /^(['"])[\s\S]*\1$/u.test(value)
    ? value.slice(1, -1)
    : value.replace(/\\ /gu, " ");
}
function parseFlags(value: string): {
  flags: Set<string>;
  text: string;
} {
  const flags = new Set<string>();
  let text = value;
  let match: RegExpExecArray | null;
  while ((match = /^<([a-z]+)>\s*/iu.exec(text))) {
    if (
      ![
        "expr",
        "buffer",
        "silent",
        "nowait",
        "unique",
        "script",
        "special",
      ].includes(match[1].toLowerCase())
    )
      break;
    flags.add(match[1].toLowerCase());
    text = text.slice(match[0].length);
  }
  return { flags, text };
}
function expandKeys(
  text: string,
  runtime: VimScriptRuntime,
  frame: ScriptFrame,
): string {
  return text
    .replace(/<SID>/giu, `<SNR>${frame.scriptId}_`)
    .replace(
      /<Leader>/giu,
      stringValue(runtime.globals.get("mapleader") ?? "\\"),
    )
    .replace(
      /<LocalLeader>/giu,
      stringValue(runtime.globals.get("maplocalleader") ?? "\\"),
    );
}
function defineMapping(
  runtime: VimScriptRuntime,
  prefix: string,
  command: string,
  rest: string,
  frame: ScriptFrame,
): void {
  const { flags, text } = parseFlags(rest);
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
  const bufferId =
    flags.has("buffer") || runtime.isVirtual(frame)
      ? requireEditor(frame).id
      : undefined;
  const modes = mapModes[prefix];
  if (command === "mapclear") {
    for (let i = runtime.mappings.length - 1; i >= 0; i--) {
      const m = runtime.mappings[i];
      if (m.bufferId === bufferId) {
        m.modes = m.modes.filter((mode) => !modes.includes(mode));
        if (!m.modes.length) runtime.mappings.splice(i, 1);
      }
    }
    runtime.refreshEditors();
    return;
  }
  if (!match) throw new Error("E471: Argument required");
  const lhs = tokenizeVimKeys(expandKeys(match[1], runtime, frame));
  const conflict = runtime.mappings.some(
    (m) =>
      m.bufferId === bufferId &&
      m.lhs.join("") === lhs.join("") &&
      m.modes.some((mode) => modes.includes(mode)),
  );
  if (flags.has("unique") && conflict)
    throw new Error(`E227: Mapping already exists: ${match[1]}`);
  for (let i = runtime.mappings.length - 1; i >= 0; i--) {
    const m = runtime.mappings[i];
    if (m.bufferId === bufferId && m.lhs.join("") === lhs.join("")) {
      m.modes = m.modes.filter((mode) => !modes.includes(mode));
      if (!m.modes.length) runtime.mappings.splice(i, 1);
    }
  }
  if (command === "unmap") {
    if (!conflict) throw new Error(`E31: No such mapping: ${match[1]}`);
    runtime.refreshEditors();
    return;
  }
  if (match[2] === undefined) throw new Error("E471: Argument required");
  const rhs = expandKeys(match[2].replace(/<Bar>/giu, "|"), runtime, frame);
  const mapping: ScriptMapping = {
    lhs,
    rhs: flags.has("expr") ? [] : tokenizeVimKeys(rhs),
    modes,
    recursive: command !== "noremap",
    source: frame.source,
    scriptId: frame.scriptId,
    rhsText: rhs,
    bufferId,
    expression: flags.has("expr"),
    silent: flags.has("silent"),
    nowait: flags.has("nowait"),
    ...(flags.has("expr") ? { expressionSource: parseExpression(rhs) } : {}),
  };
  runtime.mappings.push(mapping);
  runtime.refreshEditors();
}
function defineAutocmd(
  runtime: VimScriptRuntime,
  rest: string,
  frame: ScriptFrame,
  clear: boolean,
): void {
  const tokens = rest.trim().split(/\s+/u).filter(Boolean);
  let group = runtime.currentGroup();
  if (
    tokens[0] &&
    !tokens[0]
      .split(",")
      .every((event) => runtime.registry.events.has(event) || event === "*")
  ) {
    if (!runtime.groups.has(tokens[0])) throw new Error(`E216: No such event or group: ${tokens[0]}`);
    group = tokens.shift()!;
  }
  const events = (tokens.shift() ?? "*").split(","),
    patterns = (tokens.shift() ?? "*").split(",");
  if (
    events.some((event) => event !== "*" && !runtime.registry.events.has(event))
  )
    throw new Error(`E216: No such event: ${events.join(",")}`);
  if (clear)
    for (let i = runtime.autocmds.length - 1; i >= 0; i--) {
      const a = runtime.autocmds[i];
      if (
        a.group === group &&
        (events.includes("*") ||
          a.events.some((event) => events.includes(event))) &&
        (patterns.includes("*") ||
          a.patterns.some((pattern) => patterns.includes(pattern)))
      )
        runtime.autocmds.splice(i, 1);
    }
  if (!tokens.length) return;
  let once = false,
    nested = false;
  while (["++once", "++nested", "nested"].includes(tokens[0])) {
    const flag = tokens.shift();
    once ||= flag === "++once";
    nested ||= flag === "++nested" || flag === "nested";
  }
  runtime.addAutocmd({
    group,
    events: events.includes("*") ? [...runtime.registry.events] : events,
    patterns,
    command: parseScript(tokens.join(" "), frame.source),
    source: frame.source,
    scriptId: frame.scriptId,
    once,
    nested,
    ...(patterns.includes("<buffer>")
      ? { bufferId: requireEditor(frame).id }
      : {}),
  });
}
async function invokeUserCommand(
  runtime: VimScriptRuntime,
  text: string,
  frame: ScriptFrame,
): Promise<boolean> {
  // The original Ex range parser is reused through a read-only view of the editor.
  const editor = frame.editor;
  let first = editor?.cursor()[0] ?? 1,
    last = first,
    explicit = false;
  let body = text;
  if (editor && /^[\d.$%'<>+-]/u.test(text)) {
    const lines = editor.lines(),
      joined = lines.join("\n");
    const offsets = [0];
    for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
    const buffer = {
      lineCount: lines.length,
      length: joined.length,
      text: () => joined,
      line: (n: number) => ({
        number: n,
        from: offsets[n - 1],
        to: offsets[n - 1] + lines[n - 1].length,
        text: lines[n - 1],
      }),
      lineAt: (position: number) => {
        const n = Math.max(0, offsets.findIndex((p) => p > position) - 1);
        return {
          number: n + 1,
          from: offsets[n],
          to: offsets[n] + lines[n].length,
          text: lines[n],
        };
      },
    };
    const parsed = parseExCommand(
      text,
      buffer as Parameters<typeof parseExCommand>[1],
      first,
      (name) => {
        const [line] = editor.mark(name);
        return line ? offsets[line - 1] : undefined;
      },
      () => {
        throw new Error("Search ranges use the editor Ex interface");
      },
    );
    first = parsed.range.first;
    last = parsed.range.last;
    explicit = parsed.range.explicit;
    body = `${parsed.name}${parsed.bang ? "!" : ""} ${parsed.argument}`.trim();
  }
  const match = /^(\w+)(!?)(?:\s+([\s\S]*))?$/u.exec(body);
  if (!match) return false;
  const command = [...runtime.commands]
    .reverse()
    .find(
      (c) => c.name === match[1] && (!c.bufferId || c.bufferId === editor?.id),
    );
  if (!command) return false;
  let args = match[3] ?? "";
  const register =
    command.register && /^[\w"*+_-](?:\s|$)/u.test(args) ? args[0] : '"';
  if (command.register && register !== '"') args = args.slice(1).trimStart();
  let count = command.count;
  if (count !== null && /^\d+(?:\s|$)/u.test(args)) {
    count = Number.parseInt(args, 10);
    args = args.replace(/^\d+\s*/u, "");
  }
  const words = args.match(/(?:\\.|[^\s])+/gu) ?? [];
  if (match[2] && !command.bang) throw new Error("E477: No ! allowed");
  if (
    (command.nargs === "0" && words.length) ||
    (command.nargs === "1" && !args) ||
    (command.nargs === "?" && words.length > 1) ||
    (command.nargs === "+" && !words.length)
  )
    throw new Error("E471: Invalid number of command arguments");
  if (explicit && command.range === null && command.count === null)
    throw new Error("E481: No range allowed");
  if (!explicit && command.range === "%" && editor) {
    first = 1;
    last = editor.lineCount();
  }
  if (!explicit && command.range && /^\d+$/u.test(command.range))
    first = last = Number(command.range);
  const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
  const replacement = command.replacement.replace(
    /<(args|q-args|f-args|line1|line2|range|count|bang|reg|register)>/gu,
    (_whole, key: string) =>
      ({
        args,
        "q-args": quote(args),
        "f-args": words
          .map((word) => quote(word.replace(/\\(.)/gu, "$1")))
          .join(","),
        line1: String(first),
        line2: String(last),
        range: explicit ? "2" : "0",
        count: String(explicit ? last : (count ?? last)),
        bang: match[2],
        reg: register,
        register,
      })[key]!,
  );
  const invoked = runtime.frame(command.source, editor, frame.execution);
  invoked.specials = new Map(frame.specials);
  invoked.specials.set("firstline", integer(first));
  invoked.specials.set("lastline", integer(last));
  await runtime.execute(
    parseScript(replacement, command.source).statements,
    invoked,
  );
  return true;
}
