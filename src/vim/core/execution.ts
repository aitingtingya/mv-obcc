/** Cooperative key playback. Nested macros prepend work without recursive JS calls. */
export interface VimPlaybackKey { key: string; remap: boolean; mappingDepth: number }
export type VimPlaybackTask = VimPlaybackKey | { run: () => void | Promise<void> };
type PlaybackSource = Iterable<string | VimPlaybackTask> & { readonly length: number };
interface PlaybackFrame { source: PlaybackSource; iterator: Iterator<string | VimPlaybackTask>; remaining: number }

export class VimExecutionQueue {
  private frames: PlaybackFrame[] = [];
  private running = false;
  private continuation: MessageChannel | null = null;
  private generation = 0;
  private waiters: Array<() => void> = [];
  private steps = 0;

  constructor(private readonly execute: (key: VimPlaybackKey) => void | Promise<void>, private readonly error: (message: string) => void) {}
  get busy(): boolean { return this.running; }

  enqueue(keys: PlaybackSource, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1 || count * keys.length > 1_000_000) {
      this.error("Vim playback count exceeds the execution limit."); return;
    }
    if (keys.length === 0) return;
    const source = Array.isArray(keys) ? keys.slice() : keys;
    this.frames.push({ source, iterator: source[Symbol.iterator](), remaining: count });
    if (this.running) return;
    this.running = true; this.steps = 0;
    this.drain(this.generation);
  }

  cancel(): void {
    this.generation += 1;
    this.continuation?.port1.close(); this.continuation?.port2.close();
    this.continuation = null; this.frames = []; this.running = false;
    this.resolveWaiters();
  }

  idle(): Promise<void> { return this.running ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve(); }

  onIdle(cleanup: () => void): void { if (this.running) this.waiters.push(cleanup); else cleanup(); }

  private drain(generation: number): void {
    this.continuation = null;
    const start = Date.now();
    try {
      while (this.frames.length && generation === this.generation) {
        const frame = this.frames[this.frames.length - 1];
        const next = frame.iterator.next();
        if (next.done) {
          if (--frame.remaining > 0) frame.iterator = frame.source[Symbol.iterator]();
          else this.frames.pop();
          continue;
        }
        if (++this.steps > 1_000_000) throw new Error("Vim playback exceeded the execution limit.");
        const task = typeof next.value === "string" ? { key: next.value, remap: true, mappingDepth: 0 } : next.value;
        const result = "run" in task ? task.run() : this.execute(task);
        if (result instanceof Promise) {
          void result.then(() => this.schedule(generation), (error: unknown) => { this.error(String(error)); this.cancel(); });
          return;
        }
        if (this.frames.length && Date.now() - start >= 8) { this.schedule(generation); return; }
      }
      if (generation === this.generation) { this.running = false; this.resolveWaiters(); }
    } catch (error) { this.error(error instanceof Error ? error.message : String(error)); this.cancel(); }
  }

  private schedule(generation: number): void {
    if (generation !== this.generation) return;
    const channel = new MessageChannel();
    this.continuation = channel;
    channel.port1.onmessage = () => {
      channel.port1.close(); channel.port2.close();
      if (generation === this.generation) this.drain(generation);
    };
    channel.port2.postMessage(null);
  }

  private resolveWaiters(): void { for (const resolve of this.waiters.splice(0)) resolve(); }
}
