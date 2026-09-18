import { RunSyntaxError, type RunPlan, type RunTask } from "./model";
import { parseReferences } from "./parser";

export function defaultPlan(tasks: readonly RunTask[]): RunPlan {
  return { steps: tasks.filter(task => !task.protected), filtered: tasks.filter(task => task.protected) };
}

export function specifiedPlan(tasks: readonly RunTask[], input: string): RunPlan {
  const result: RunPlan = { steps: [], filtered: [] };
  for (const ref of parseReferences(input)) {
    const matching = tasks.filter(task => ref.kind === "task" ? task.name === ref.name : task.groups.includes(ref.name));
    if (!matching.length) throw new RunSyntaxError(`Unknown ${ref.kind}: ${ref.name}`, ref.column);
    if (ref.kind === "task" && matching.length !== 1) throw new RunSyntaxError(`Ambiguous task: ${ref.name} (lines ${matching.map(task => task.line).join(", ")})`, ref.column);
    for (const task of matching) {
      (ref.respectProtection && task.protected ? result.filtered : result.steps).push(task);
    }
  }
  return result;
}

/** Ignore edits outside task definitions, but include location/order and all metadata. */
export function taskSignature(tasks: readonly RunTask[]): string {
  return JSON.stringify(tasks);
}
