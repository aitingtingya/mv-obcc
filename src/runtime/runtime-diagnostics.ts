export interface RuntimeDiagnosticReport {
  durationMs: number;
  eventLoopDelayMs: { p95: number; p99: number; max: number };
  longTasks: { count: number; maxMs: number };
  counters: Record<string, number>;
}

/** Opt-in, time-bounded diagnostics. Never captures document text or paths. */
export class RuntimeDiagnostics {
  private counters: Map<string, number> | null = null;
  private stop: (() => void) | null = null;

  count(name: string, amount = 1): void {
    if (this.counters) this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  start(owner: Window, complete: (report: RuntimeDiagnosticReport) => void, durationMs = 30_000): void {
    this.cancel();
    this.counters = new Map();
    const started = owner.performance.now();
    let previous = started;
    const delays: number[] = [];
    let longCount = 0, longMax = 0;
    const interval = owner.setInterval(() => {
      const now = owner.performance.now();
      delays.push(Math.max(0, now - previous - 100));
      previous = now;
    }, 100);
    const Observer = (owner as Window & typeof globalThis).PerformanceObserver;
    const observer = Observer?.supportedEntryTypes.includes("longtask") ? new Observer((list) => {
      for (const entry of list.getEntries()) {
        longCount++;
        longMax = Math.max(longMax, entry.duration);
      }
    }) : null;
    observer?.observe({ entryTypes: ["longtask"] });
    const timeout = owner.setTimeout(() => {
      delays.sort((a, b) => a - b);
      const percentile = (q: number) => delays[Math.max(0, Math.ceil(delays.length * q) - 1)] ?? 0;
      const report = {
        durationMs: owner.performance.now() - started,
        eventLoopDelayMs: { p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) },
        longTasks: { count: longCount, maxMs: longMax },
        counters: Object.fromEntries(this.counters ?? []),
      };
      this.cancel();
      complete(report);
    }, durationMs);
    this.stop = () => {
      owner.clearInterval(interval);
      owner.clearTimeout(timeout);
      observer?.disconnect();
    };
  }

  cancel(): void {
    this.stop?.();
    this.stop = null;
    this.counters = null;
  }
}
