import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as waitBriefly } from "node:timers/promises";
import { t } from "../../../i18n";

export class DshStartCancelledError extends Error {
  constructor() {
    super("dsh start cancelled");
    this.name = "DshStartCancelledError";
  }
}

export type DshLifecycleOperation = "connect" | "lookup" | "restart" | "legacy-restart" | "stop";

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DshStartCancelledError();
}

/** Cancel a read without waiting for an obsolete observation to finish. */
export function awaitDshObservation<T>(signal: AbortSignal, observation: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new DshStartCancelledError());
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => { signal.removeEventListener("abort", cancel); reject(new DshStartCancelledError()); };
    signal.addEventListener("abort", cancel, { once: true });
    void observation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeEmptyLock(lock: string): Promise<void> {
  try { await fs.rmdir(lock); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

// Never move or recursively delete the public lock. Between observing a dead
// PID and unlinking its marker a different process may already own this path.
async function removeOwner(lock: string, marker: string): Promise<void> {
  try { await fs.unlink(path.join(lock, marker)); }
  catch (error) { if (!missing(error)) throw error; }
  await removeEmptyLock(lock);
}

async function reclaimDeadOwner(lock: string): Promise<void> {
  try {
    const entries = await fs.readdir(lock);
    if (!entries.length) return await removeEmptyLock(lock);
    // owner.json was used by earlier development builds; new acquisitions
    // never reuse its name.
    const marker = entries.find(name => name === "owner.json" || /^owner-[\da-f-]+\.json$/u.test(name));
    if (!marker) return;
    const { pid } = JSON.parse(await fs.readFile(path.join(lock, marker), "utf8")) as { pid: number };
    if (!alive(pid)) await removeOwner(lock, marker);
  } catch (error) { if (!missing(error)) throw error; }
}

/** Serialize runtime management across Vault renderers, separately from injection. */
export async function withDshLifecycleLock<T>(
  home: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  assertActive(signal);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const root = path.join(await fs.realpath(home), ".mv-aide");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "runtime-lifecycle.lock");
  const id = randomUUID();
  const marker = `owner-${id}.json`;
  const owner = JSON.stringify({ pid: process.pid, id });
  // Publish a complete owner atomically: a killed writer cannot leave an
  // ownerless live lock between mkdir and writeFile.
  const staging = path.join(root, `.runtime-lifecycle-${process.pid}-${id}`);
  await fs.mkdir(staging, { mode: 0o700 });
  const deadline = Date.now() + 130_000;
  let acquired = false;
  try {
    await fs.writeFile(path.join(staging, marker), owner, { mode: 0o600 });
    while (!acquired) {
      assertActive(signal);
      try {
        await fs.rename(staging, lock);
        acquired = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw error;
        await reclaimDeadOwner(lock);
        if (Date.now() >= deadline) throw new Error(t("等待其它 mv-AIDE 完成 DSH 运行管理超时。"));
        await waitBriefly(75);
      }
    }
    assertActive(signal);
    return await operation();
  } finally {
    if (acquired) await removeOwner(lock, marker);
    else await fs.rm(staging, { recursive: true, force: true });
  }
}

/** One manager's operation queue; an explicit stop/restart supersedes old work. */
export class DshLifecycleCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private epoch = 0;
  private disposed = false;
  private active: AbortController | null = null;
  private pending = 0;
  private stops = 0;
  private readonly shared = new Map<DshLifecycleOperation, Promise<unknown>>();

  get stopping(): boolean { return this.stops > 0; }
  get restarting(): boolean { return this.shared.has("restart") || this.shared.has("legacy-restart"); }

  run<T>(kind: DshLifecycleOperation, operation: (signal: AbortSignal) => Promise<T>, cancel: () => void): Promise<T> {
    if (this.disposed) return Promise.reject(new DshStartCancelledError());
    const exclusive = kind === "stop" || kind === "restart" || kind === "legacy-restart";
    const shared = kind === "restart" || kind === "legacy-restart" ? this.shared.get(kind) : null;
    if (shared) return shared as Promise<T>;
    if (!exclusive && this.stopping) return Promise.reject(new DshStartCancelledError());
    if (exclusive) {
      this.epoch += 1;
      this.active?.abort();
      cancel();
    }
    const epoch = this.epoch;
    const controller = new AbortController();
    const execute = async (): Promise<T> => {
      if (this.disposed || epoch !== this.epoch) throw new DshStartCancelledError();
      this.active = controller;
      try { return await operation(controller.signal); }
      finally { if (this.active === controller) this.active = null; }
    };
    const idle = this.pending === 0;
    this.pending += 1;
    if (kind === "stop") this.stops += 1;
    const result = idle ? execute() : this.tail.then(execute);
    const completed = (): void => { this.pending -= 1; if (kind === "stop") this.stops -= 1; };
    void result.then(completed, completed);
    this.tail = result.then(() => undefined, () => undefined);
    if (exclusive) {
      this.shared.set(kind, result);
      const clear = (): void => { if (this.shared.get(kind) === result) this.shared.delete(kind); };
      void result.then(clear, clear);
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.active?.abort();
  }
}
