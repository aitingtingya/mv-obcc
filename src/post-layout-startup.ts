export interface PostLayoutStartupHandle {
  cancel(): void;
}

interface PostLayoutStartupOptions {
  onLayoutReady(callback: () => void): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
  delayMs: number;
  isUnloaded(): boolean;
  run(): Promise<void> | void;
  onError(error: unknown): void;
}

export function schedulePostLayoutStartup(
  options: PostLayoutStartupOptions,
): PostLayoutStartupHandle {
  let cancelled = false;
  let timerId: number | null = null;

  const cancel = () => {
    cancelled = true;
    if (timerId !== null) {
      options.clearTimeout(timerId);
      timerId = null;
    }
  };

  options.onLayoutReady(() => {
    if (cancelled || options.isUnloaded()) return;
    timerId = options.setTimeout(() => {
      timerId = null;
      if (cancelled || options.isUnloaded()) return;
      void Promise.resolve(options.run()).catch(options.onError);
    }, options.delayMs);
  });

  return { cancel };
}
