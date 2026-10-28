/** Per-domain, serialized settings effects. Persistence remains owned by the plugin. */
export class SettingsEffects {
  private readonly applied = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();

  run(domain: string, fingerprint: () => string, apply: () => void | Promise<void>): Promise<void> {
    const previous = this.pending.get(domain) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const key = fingerprint();
      if (key === this.applied.get(domain)) return;
      await apply();
      this.applied.set(domain, key);
    });
    this.pending.set(domain, task);
    void task.finally(() => {
      if (this.pending.get(domain) === task) this.pending.delete(domain);
    }).catch(() => undefined);
    return task;
  }
}
