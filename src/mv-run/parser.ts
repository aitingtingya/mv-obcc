import { RunSyntaxError, type RunTask, type RunReference } from "./model";
import { tokenize, type Token } from "./lexer";

const endings: Record<string, string> = { "<!--": "-->", "/*": "*/" };

export function parseTasks(text: string, prefixes: readonly string[]): RunTask[] {
  const tasks: RunTask[] = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const trimmed = raw.trim();
    for (const prefix of prefixes) {
      if (!prefix || !trimmed.startsWith(prefix)) continue;
      let body = trimmed.slice(prefix.length).trim();
      if (!/^mv-run(?:\s|:|$)/u.test(body)) continue;
      const ending = endings[prefix];
      if (ending && body.endsWith(ending)) body = body.slice(0, -ending.length).trimEnd();
      try {
        const task = parseHeader(body, index + 1);
        if (task) tasks.push(task);
      } catch (error) {
        if (error instanceof RunSyntaxError) throw new RunSyntaxError(error.reason, error.column + raw.indexOf("mv-run", raw.indexOf(prefix) + prefix.length), index + 1);
        throw error;
      }
      break;
    }
  }
  return tasks;
}

function parseHeader(body: string, line: number): RunTask | null {
  const tokens = tokenize(body, true, line);
  const colon = tokens.at(-1);
  if (colon?.kind !== ":") throw new RunSyntaxError("Expected ':' before the shell command", body.length + 1, line);
  const command = body.slice(colon.end).trim();
  const task: RunTask = { command, line, groups: [], protected: false, newTerminal: false };
  let cursor = 1;
  const argument = (): Token => {
    const token = tokens[cursor++];
    if (!token || token.kind !== "word" || !token.value || (!token.leadingQuoted && token.value.startsWith("-"))) {
      throw new RunSyntaxError("Expected a nonempty name (quote names beginning with '-')", token?.start === undefined ? colon.start + 1 : token.start + 1, line);
    }
    return token;
  };
  while (cursor < tokens.length - 1) {
    const token = tokens[cursor++];
    switch (token.value) {
      case "-n": task.newTerminal = true; break;
      case "--protect": task.protected = true; break;
      case "--name": {
        if (task.name !== undefined) throw new RunSyntaxError("Repeated --name", token.start + 1, line);
        task.name = argument().value;
        break;
      }
      case "--group": {
        task.groups.push(argument().value);
        while (tokens[cursor]?.kind === ",") { cursor++; task.groups.push(argument().value); }
        break;
      }
      default: throw new RunSyntaxError(`Unknown mv-run parameter: ${token.value}`, token.start + 1, line);
    }
  }
  task.groups = [...new Set(task.groups)];
  return command ? task : null; // Empty legacy commands still do not execute.
}

export function parseReferences(text: string): RunReference[] {
  const tokens = tokenize(text);
  const references: RunReference[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.kind !== "word" || !token.value) throw new RunSyntaxError("Expected a task or @group", token.start + 1);
    const group = !token.leadingQuoted && token.value.startsWith("@");
    const name = group ? token.value.slice(1) : token.value;
    if (!name || (!group && !token.leadingQuoted && name.startsWith("-"))) throw new RunSyntaxError("Expected a nonempty task or group name", token.start + 1);
    const reference: RunReference = { kind: group ? "group" : "task", name, respectProtection: false, column: token.start + 1 };
    if (tokens[index]?.kind === "word") {
      const option = tokens[index++];
      if (!group || option.leadingQuoted || option.value !== "-p") throw new RunSyntaxError("Only @group accepts -p; separate references with commas", option.start + 1);
      reference.respectProtection = true;
    }
    references.push(reference);
    if (index < tokens.length) {
      const comma = tokens[index++];
      if (comma.kind !== "," || index === tokens.length) throw new RunSyntaxError("Expected a reference after ','", comma.start + 1);
    }
  }
  if (!references.length) throw new RunSyntaxError("Enter a task or @group", 1);
  return references;
}
