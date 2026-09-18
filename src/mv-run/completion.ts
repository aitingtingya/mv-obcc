import { quoteName } from "./lexer";
import { parseReferences } from "./parser";
import type { RunTask } from "./model";

export interface RunCompletion {
  label: string;
  detail: string;
  from: number;
  to: number;
  insert: string;
}

export function completeReferences(tasks: readonly RunTask[], input: string, cursor: number): RunCompletion[] {
  let quote = "";
  let start = 0;
  for (let i = 0; i < cursor; i++) {
    const char = input[i];
    if (quote) {
      if (char === "\\" && (input[i + 1] === quote || input[i + 1] === "\\")) i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ",") start = i + 1;
  }
  while (/\s/u.test(input[start] ?? "") && start < cursor) start++;
  const fragment = input.slice(start, cursor);
  let end = cursor;
  for (; end < input.length; end++) {
    const char = input[end];
    if (quote) {
      if (char === "\\" && (input[end + 1] === quote || input[end + 1] === "\\")) end++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ",") break;
  }
  const candidates: RunCompletion[] = [];
  const add = (label: string, members: RunTask[], insert = label): void => {
    candidates.push({ label, insert, from: start, to: end, detail: members.map(task => `${task.protected ? "🔒 " : ""}${task.command}`).join(" → ") });
  };
  const names = [...new Set(tasks.flatMap(task => task.name === undefined ? [] : [task.name]))];
  const groups = [...new Set(tasks.flatMap(task => task.groups))];
  const query = fragment.replace(/^@/u, "").replace(/^["']/u, "").toLocaleLowerCase();
  if (!fragment.startsWith("@")) {
    for (const name of names) if (name.toLocaleLowerCase().includes(query)) add(quoteName(name), tasks.filter(task => task.name === name));
  }
  for (const group of groups) if (group.toLocaleLowerCase().includes(query)) add(`@${quoteName(group)}`, tasks.filter(task => task.groups.includes(group)));
  try {
    const refs = parseReferences(fragment.replace(/\s+-p?$/u, ""));
    if (refs.length === 1 && refs[0].kind === "group" && !refs[0].respectProtection && groups.includes(refs[0].name) && !fragment.endsWith(" -p")) {
      const label = `@${quoteName(refs[0].name)} -p`;
      add(label, tasks.filter(task => task.groups.includes(refs[0].name) && !task.protected));
    }
  } catch { /* Incomplete input is expected while completing. */ }
  return candidates;
}
