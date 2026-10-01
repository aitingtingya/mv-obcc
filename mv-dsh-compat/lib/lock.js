// Cross-process lock for the DSH web profile directory.
//
// Both halves of mv-AIDE mutate `$DSH_HOME/profiles/web`: the Obsidian host
// injects and updates the managed plugin packages there, and the injected
// `mv-dsh-manager` projects preset rows into `cordis.patch.yml`. They are
// separate processes sharing one directory, and DEVELOPMENT-GUIDELINES 规范十.4
// requires every write in it to re-detect inside one cross-process lock — so
// the protocol lives here once and neither side reimplements it.
//
// This module is deliberately stateless: it holds no lock registry, no timers
// and nothing to dispose, so `@mv-aide/mv-dsh-compat` stays a pure library
// (规范十一.3). Every call takes the directory it is locking.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** A lock older than this whose owner is gone is reclaimed. */
export const PROFILE_LOCK_STALE_MS = 120_000;

/**
 * How long a waiter keeps trying before giving up.
 *
 * The holder runs the full verify path (`--profile web --dump-config`, up to
 * 120s) even when the bundle is already ready, so a waiter must outlast that
 * ceiling instead of failing concurrent open/restart operations early.
 */
export const PROFILE_LOCK_TIMEOUT_MS = 130_000;

/** Whether a pid is still running; EPERM means it exists but is not ours. */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

const waitBriefly = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

/** The canonical lock path for one profile directory. */
export function profileLockPath(profileDirectory) {
  return path.join(profileDirectory, '.mv-aide-injection.lock');
}

/**
 * Run `operation` while holding the profile lock.
 *
 * Acquisition is `mkdir`, which is atomic across processes. Ownership is proven
 * by reading `owner.json` back, so a lock whose owner cannot be re-read is never
 * removed — a stale lock is only reclaimed when its recorded owner is provably
 * dead, and only after the owner file is re-read unchanged so a live owner that
 * is merely slow cannot lose it.
 *
 * @param operation - the critical section.
 * @param profileDirectory - `<DSH_HOME>/profiles/web`.
 * @param options.timeoutMs - override for tests.
 * @param options.timeoutMessage - the error thrown once the wait runs out.
 */
export async function withProfileLock(operation, profileDirectory, options = {}) {
  const lock = profileLockPath(profileDirectory);
  const ownerFile = path.join(lock, 'owner.json');
  const timeoutMs = options.timeoutMs ?? PROFILE_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? PROFILE_LOCK_STALE_MS;
  const started = Date.now();
  const owner = `${JSON.stringify({ pid: process.pid, id: randomUUID(), createdAt: started })}\n`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(lock);
      try {
        await fs.writeFile(ownerFile, owner, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      let stale = false;
      try {
        const before = await fs.readFile(ownerFile, 'utf8');
        const parsed = JSON.parse(before);
        const age = Date.now() - Number(parsed?.createdAt ?? 0);
        stale = age > staleMs && !processIsAlive(Number(parsed?.pid));
        if (stale && await fs.readFile(ownerFile, 'utf8') === before) {
          const quarantine = `${lock}.stale-${process.pid}-${randomUUID()}`;
          await fs.rename(lock, quarantine);
          await fs.rm(quarantine, { recursive: true, force: true });
          continue;
        }
      } catch {
        // A just-created lock may not have published owner.json yet; wait.
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(options.timeoutMessage ?? '等待其它 mv-AIDE 操作释放 DSH profile 锁超时。');
      }
      await waitBriefly(stale ? 20 : 75);
    }
  }
  try {
    return await operation();
  } finally {
    try {
      if (await fs.readFile(ownerFile, 'utf8') === owner) {
        await fs.rm(lock, { recursive: true, force: true });
      }
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  }
}
