/**
 * Types for the shared cross-process profile lock. The implementation is plain
 * JS (`lib/lock.js`) because it runs both in this repository's Obsidian-side
 * TypeScript and inside the injected DSH plugins.
 */

/** A lock older than this whose owner is gone is reclaimed. */
export declare const PROFILE_LOCK_STALE_MS: number;

/** How long a waiter keeps trying before giving up. */
export declare const PROFILE_LOCK_TIMEOUT_MS: number;

/** The canonical lock path for one profile directory. */
export declare function profileLockPath(profileDirectory: string): string;

export interface ProfileLockOptions {
  /** Override for tests. */
  timeoutMs?: number;
  /** Override for tests. */
  staleMs?: number;
  /** The error thrown once the wait runs out. */
  timeoutMessage?: string;
}

/**
 * Run `operation` while holding the profile lock, releasing it only when this
 * process's ownership can still be proven.
 */
export declare function withProfileLock<T>(
  operation: () => Promise<T>,
  profileDirectory: string,
  options?: ProfileLockOptions,
): Promise<T>;
