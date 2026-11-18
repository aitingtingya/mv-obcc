import { parseExpression, type Expression } from "./expression";
export interface ScriptLocation {
  source: string;
  line: number;
  column: number;
}
interface Located {
  location: ScriptLocation;
}
export type Statement = Located &
  (
    | {
        kind: "command";
        text: string;
      }
    | {
        kind: "if";
        branches: {
          condition: Expression | null;
          body: Statement[];
        }[];
      }
    | {
        kind: "while";
        condition: Expression;
        body: Statement[];
      }
    | {
        kind: "for";
        target: Expression;
        iterable: Expression;
        body: Statement[];
      }
    | {
        kind: "function";
        name: string;
        parameters: string[];
        variadic: boolean;
        replace: boolean;
        flags: string[];
        body: Statement[];
      }
    | {
        kind: "try";
        body: Statement[];
        catches: {
          pattern: string;
          body: Statement[];
        }[];
        finally: Statement[];
      }
  );
export interface ScriptProgram {
  source: string;
  statements: Statement[];
}
interface SourceLine {
  text: string;
  location: ScriptLocation;
}
export class VimScriptError extends Error {
  readonly frames: ScriptLocation[];
  constructor(message: string, frames: ScriptLocation[] = []) {
    super(message);
    this.name = "VimScriptError";
    this.frames = frames;
  }
  at(location: ScriptLocation): VimScriptError {
    return new VimScriptError(this.message, [...this.frames, location]);
  }
  diagnostic(): string {
    return `${this.message}${this.frames.map((frame) => `\n  ${frame.source}:${frame.line}:${frame.column}`).join("")}`;
  }
}
export function parseScript(text: string, source: string): ScriptProgram {
  const lines = logicalLines(text, source);
  let index = 0;
  const commandOf = (line: SourceLine) =>
    line.text.match(/^\s*:?(\w+)!?/u)?.[1] ?? "";
  function body(until: string[] = []): Statement[] {
    const result: Statement[] = [];
    while (index < lines.length && !until.includes(commandOf(lines[index]))) {
      const line = lines[index++];
      const raw = line.text.trimStart().replace(/^:/u, "");
      const location = line.location;
      if (!raw || raw.startsWith('"')) continue;
      const command = commandOf(line);
      try {
        if (
          [
            "else",
            "elseif",
            "endif",
            "endwhile",
            "endfor",
            "endfunction",
            "catch",
            "finally",
            "endtry",
          ].includes(command)
        )
          throw new Error(`E580: Unexpected ${command}`);
        if (command === "if") {
          const branches: {
            condition: Expression | null;
            body: Statement[];
          }[] = [
            {
              condition: parseExpression(raw.slice(2)),
              body: body(["elseif", "else", "endif"]),
            },
          ];
          while (index < lines.length && commandOf(lines[index]) === "elseif") {
            const alternative = lines[index++];
            branches.push({
              condition: parseExpression(alternative.text.trim().slice(6)),
              body: body(["elseif", "else", "endif"]),
            });
          }
          if (index < lines.length && commandOf(lines[index]) === "else") {
            index++;
            branches.push({ condition: null, body: body(["endif"]) });
          }
          end("endif");
          result.push({ kind: "if", branches, location });
        } else if (command === "while") {
          const condition = parseExpression(raw.slice(5));
          const statements = body(["endwhile"]);
          end("endwhile");
          result.push({ kind: "while", condition, body: statements, location });
        } else if (command === "for") {
          const match = raw.match(/^for\s+(.+?)\s+in\s+(.+)$/u);
          if (!match) throw new Error("E690: Missing 'in' after :for");
          const target = parseExpression(match[1]),
            iterable = parseExpression(match[2]);
          const statements = body(["endfor"]);
          end("endfor");
          result.push({
            kind: "for",
            target,
            iterable,
            body: statements,
            location,
          });
        } else if (
          command === "function" ||
          command === "fu" ||
          command === "func"
        ) {
          const match = raw.match(
            /^(?:function|func|fu)(!?)\s+([\w:#.<>]+)\s*\((.*?)\)\s*(.*)$/u,
          );
          if (!match) throw new Error("E124: Missing or invalid function name");
          const parameters = match[3]
            .split(",")
            .map((parameter) => parameter.trim())
            .filter(Boolean);
          const variadic = parameters.at(-1) === "...";
          if (variadic) parameters.pop();
          if (
            parameters.some((parameter) => !/^[A-Za-z_]\w*$/u.test(parameter))
          )
            throw new Error("E125: Illegal argument");
          const statements = body(["endfunction", "endfunc", "endfu"]);
          end(
            commandOf(lines[index] ?? { text: "", location }) || "endfunction",
          );
          result.push({
            kind: "function",
            name: match[2],
            parameters,
            variadic,
            replace: match[1] === "!",
            flags: match[4].split(/\s+/u).filter(Boolean),
            body: statements,
            location,
          });
        } else if (command === "try") {
          const statements = body(["catch", "finally", "endtry"]);
          const catches: {
            pattern: string;
            body: Statement[];
          }[] = [];
          while (index < lines.length && commandOf(lines[index]) === "catch") {
            const pattern = lines[index++].text
              .trim()
              .slice(5)
              .trim()
              .replace(/^\/(.*)\/$/u, "$1");
            catches.push({
              pattern,
              body: body(["catch", "finally", "endtry"]),
            });
          }
          let final: Statement[] = [];
          if (index < lines.length && commandOf(lines[index]) === "finally") {
            index++;
            final = body(["endtry"]);
          }
          end("endtry");
          result.push({
            kind: "try",
            body: statements,
            catches,
            finally: final,
            location,
          });
        } else result.push({ kind: "command", text: raw, location });
      } catch (error) {
        throw error instanceof VimScriptError
          ? error
          : new VimScriptError(
              error instanceof Error ? error.message : String(error),
              [location],
            );
      }
    }
    return result;
  }
  function end(command: string): void {
    if (index >= lines.length || commandOf(lines[index]) !== command)
      throw new Error(`E171: Missing ${command}`);
    index++;
  }
  return { source, statements: body() };
}
function logicalLines(text: string, source: string): SourceLine[] {
  const joined: SourceLine[] = [];
  for (const [index, raw] of text
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .entries()) {
    if (/^\s*\\/u.test(raw) && joined.length)
      joined[joined.length - 1].text += ` ${raw.replace(/^\s*\\/u, "")}`;
    else
      joined.push({
        text: raw,
        location: { source, line: index + 1, column: 1 },
      });
  }
  return joined.flatMap((line) =>
    splitCommands(line.text).map((part) => ({
      text: part.text,
      location: { ...line.location, column: part.column },
    })),
  );
}
/** Definitions retain their Ex bodies; separators in expressions/strings are not Ex bars. */
export function splitCommands(text: string): {
  text: string;
  column: number;
}[] {
  if (
    /^\s*:?(?:(?:[nvxsoic]?(?:noremap|map)|i?(?:noreabbrev|abbrev))\b|(?:command|com)!?\s|(?:autocmd|au)!?\s)/u.test(
      text,
    )
  )
    return [{ text, column: 1 }];
  let quote = "",
    nesting = 0,
    start = 0;
  const result: {
    text: string;
    column: number;
  }[] = [];
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    if (quote) {
      if (quote === '"' && c === "\\") index++;
      else if (c === quote) {
        if (quote === "'" && text[index + 1] === "'") index++;
        else quote = "";
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if ("([{".includes(c)) nesting++;
    if (")]}".includes(c)) nesting--;
    if (c === "\\") {
      index++;
      continue;
    }
    if (
      c === "|" &&
      text[index + 1] !== "|" &&
      text[index - 1] !== "|" &&
      nesting === 0
    ) {
      result.push({ text: text.slice(start, index), column: start + 1 });
      start = index + 1;
    }
  }
  result.push({ text: text.slice(start), column: start + 1 });
  return result;
}
