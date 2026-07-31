export interface StartupPerformanceEntry {
  name: string;
  startedAt: number;
  durationMs: number;
}

export interface StartupPerformanceAggregate {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface StartupPerformanceSnapshot {
  startedAt: number;
  capturedAt: number;
  totalElapsedMs: number;
  entries: StartupPerformanceEntry[];
  aggregates: StartupPerformanceAggregate[];
}

export interface StartupPerformanceRecorderOptions {
  clock?: () => number;
  maxEntries?: number;
}

function defaultStartupClock(): number {
  const measured = globalThis.performance?.now?.();
  return typeof measured === "number" && Number.isFinite(measured)
    ? measured
    : Date.now();
}

function finiteDuration(startedAt: number, endedAt: number): number {
  const duration = endedAt - startedAt;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

/**
 * Small in-memory startup recorder. It never logs and stores only caller-owned
 * phase names plus numeric timings, so paths, content, and credentials cannot
 * be captured accidentally by this module.
 */
export class StartupPerformanceRecorder {
  private readonly clock: () => number;
  private readonly maxEntries: number;
  private readonly entries: StartupPerformanceEntry[] = [];
  private readonly startedAt: number;

  constructor(options: StartupPerformanceRecorderOptions = {}) {
    this.clock = options.clock ?? defaultStartupClock;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 64));
    this.startedAt = this.clock();
  }

  begin(name: string): () => StartupPerformanceEntry {
    const startedAt = this.clock();
    let result: StartupPerformanceEntry | null = null;
    return () => {
      if (result) return { ...result };
      result = this.record(name, startedAt, this.clock());
      return { ...result };
    };
  }

  recordSpan(
    name: string,
    startedAt: number,
    endedAt: number,
  ): StartupPerformanceEntry {
    return { ...this.record(name, startedAt, endedAt) };
  }

  measureSync<T>(name: string, operation: () => T): T {
    const end = this.begin(name);
    try {
      return operation();
    } finally {
      end();
    }
  }

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const end = this.begin(name);
    try {
      return await operation();
    } finally {
      end();
    }
  }

  snapshot(): StartupPerformanceSnapshot {
    const capturedAt = this.clock();
    const aggregates = new Map<string, StartupPerformanceAggregate>();
    for (const entry of this.entries) {
      const aggregate = aggregates.get(entry.name) ?? {
        name: entry.name,
        count: 0,
        totalMs: 0,
        maxMs: 0,
      };
      aggregate.count++;
      aggregate.totalMs += entry.durationMs;
      aggregate.maxMs = Math.max(aggregate.maxMs, entry.durationMs);
      aggregates.set(entry.name, aggregate);
    }
    return {
      startedAt: this.startedAt,
      capturedAt,
      totalElapsedMs: finiteDuration(this.startedAt, capturedAt),
      entries: this.entries.map((entry) => ({ ...entry })),
      aggregates: Array.from(aggregates.values(), (aggregate) => ({
        ...aggregate,
      })),
    };
  }

  private record(
    name: string,
    startedAt: number,
    endedAt: number,
  ): StartupPerformanceEntry {
    const entry = {
      name,
      startedAt,
      durationMs: finiteDuration(startedAt, endedAt),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    return entry;
  }
}

export function createStartupPerformanceRecorder(
  options: StartupPerformanceRecorderOptions = {},
): StartupPerformanceRecorder {
  return new StartupPerformanceRecorder(options);
}
