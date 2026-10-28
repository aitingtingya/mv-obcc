/** Coalesces structural events and bounded late mounts; idle workspaces do not scan. */
export class WorkspaceMaintenance<T> {
  private queued = false;
  private disposed = false;
  private force = false;
  private timers: number[] = [];
  private leaves: readonly T[] = [];

  constructor(
    private readonly owner: Window,
    private readonly read: () => readonly T[],
    private readonly apply: (leaves: readonly T[], force: boolean) => void,
  ) {}

  invalidate(force = false): void {
    if (this.disposed) return;
    this.force ||= force;
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      this.cancelRetries();
      this.leaves = this.read();
      const forced = this.force;
      this.force = false;
      this.apply(this.leaves, forced);
      // Obsidian can mount PDF/webview content after emitting layout-change.
      // Retry those same leaves, without another global inventory or idle poll.
      for (const delay of [150, 1000]) {
        this.timers.push(this.owner.setTimeout(() => {
          if (!this.disposed) this.apply(this.leaves, false);
        }, delay));
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetries();
    this.leaves = [];
  }

  private cancelRetries(): void {
    for (const timer of this.timers) this.owner.clearTimeout(timer);
    this.timers = [];
  }
}
