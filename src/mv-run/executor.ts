import { randomBytes } from "node:crypto";
import type { RunTask } from "./model";
import type { RunTerminal, RunTerminalHost } from "./terminal-port";
import { prepareStep, RUN_OSC } from "./shell";

export interface RunProgress { task: RunTask; index: number; total: number; phase: "running" | "finished"; exitCode?: number }
export class RunExecutionError extends Error {
  constructor(message: string, readonly task?: RunTask, readonly exitCode?: number) { super(message); }
}

export class RunExecutor {
  private readonly controllers = new Set<AbortController>();
  private readonly locks = new Map<string, AbortController>();
  private disposed = false;
  constructor(private readonly host: RunTerminalHost) {}

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort(new Error("mv-run closed"));
  }

  async run(steps: readonly RunTask[], initialTerminalId?: string, progress: (event: RunProgress) => void = () => {}): Promise<void> {
    if (this.disposed) throw new Error("mv-run closed");
    if (!steps.length) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    const subscriptions = new Map<string, () => void>();
    let currentId = initialTerminalId;
    let currentTask: RunTask | undefined;
    try {
      for (const [index, task] of steps.entries()) {
        currentTask = task;
        controller.signal.throwIfAborted();
        const terminal = await this.host.acquire({ terminalId: currentId, newTerminal: task.newTerminal || !currentId });
        controller.signal.throwIfAborted();
        currentId = terminal.id;
        const owner = this.locks.get(currentId);
        if (owner && owner !== controller) throw new RunExecutionError("This terminal already has an mv-run sequence", task);
        this.locks.set(currentId, controller);
        if (!subscriptions.has(currentId)) {
          subscriptions.set(currentId, terminal.onSession(event => {
            if (currentId !== terminal.id) return;
            if (event.type !== "input" || event.data.includes("\x03")) controller.abort(new Error("Terminal interrupted or closed"));
          }));
        }
        progress({ task, index, total: steps.length, phase: "running" });
        const code = await executeStep(terminal, task.command, controller.signal);
        controller.signal.throwIfAborted();
        progress({ task, index, total: steps.length, phase: "finished", exitCode: code });
        if (code !== 0) throw new RunExecutionError(`Command failed (exit ${code})`, task, code);
      }
    } catch (error) {
      if (error instanceof RunExecutionError) throw error;
      throw new RunExecutionError(error instanceof Error ? error.message : String(error), currentTask);
    } finally {
      for (const dispose of subscriptions.values()) dispose();
      for (const [id, owner] of this.locks) if (owner === controller) this.locks.delete(id);
      this.controllers.delete(controller);
    }
  }
}

export async function executeStep(terminal: RunTerminal, body: string, signal: AbortSignal): Promise<number> {
  const token = randomBytes(16).toString("hex");
  const prepared = await prepareStep(body, terminal.kind, token);
  try {
    signal.throwIfAborted();
    if (!terminal.alive() || terminal.currentGeneration() !== terminal.generation) throw new Error("Terminal session changed");
    return await new Promise<number>((resolve, reject) => {
      let started = false;
      let settled = false;
      let timer: number | undefined;
      let unhook: (() => void) | undefined;
      const finish = (code?: number, error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) terminal.clearTimeout(timer);
        unhook?.();
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error instanceof Error ? error : new Error(typeof error === "string" ? error : "Terminal operation failed")); else resolve(code ?? 0);
      };
      const abort = (): void => finish(undefined, signal.reason || new Error("Cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      try {
        unhook = terminal.onControl(RUN_OSC, data => {
          const prefix = `mv-run;${token};`;
          if (!data.startsWith(prefix)) return false;
          if (signal.aborted || terminal.currentGeneration() !== terminal.generation) { abort(); return true; }
          const receipt = data.slice(prefix.length);
          if (receipt === "start") {
            started = true;
            if (timer !== undefined) terminal.clearTimeout(timer);
          } else if (started && /^end;-?\d+$/u.test(receipt)) finish(Number(receipt.slice(4)));
          return true;
        });
        if (signal.aborted) { abort(); return; }
        // This bounds missing acknowledgement only. A started command has no
        // duration limit, and no quiet-output/prompt heuristic is involved.
        timer = terminal.setTimeout(() => finish(undefined, new Error("Terminal did not acknowledge execution; check its foreground program or use -n")), 10_000);
        void terminal.send(prepared.command).catch(error => finish(undefined, error));
      } catch (error) { finish(undefined, error); }
    });
  } finally {
    await prepared.dispose();
  }
}
