/** Bounded, renderer-local sharing of observational work; never connection state. */
export class SharedProbe<T> {
  private readonly entries = new Map<string, { at: number; pending: boolean; result: Promise<T> }>();

  constructor(private readonly lifetimeMs: number, private readonly now = Date.now) {}

  read(key: string, probe: () => Promise<T>, fresh = false): Promise<T> {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (!entry.pending && now - entry.at >= this.lifetimeMs) this.entries.delete(id);
    }
    const existing = this.entries.get(key);
    if (existing && (existing.pending || !fresh)) return existing.result;
    const result = probe();
    const entry = { at: now, pending: true, result };
    this.entries.set(key, entry);
    void result.then(() => { entry.pending = false; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return result;
  }

  clear(): void { this.entries.clear(); }
}
