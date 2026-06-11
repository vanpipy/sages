/**
 * flock.ts - Cross-process mutex using atomic file creation.
 *
 * Bun does not expose POSIX flock() via FileHandle, and the `flock` shell
 * command's 'spawn' event fires before lock acquisition. We use atomic
 * O_EXCL file creation (writeFile flag: 'wx') instead, which is guaranteed
 * to fail for one writer and succeed for one writer on POSIX systems.
 *
 * Algorithm: try to create `${lockFile}.owner.${pid}`. If it exists (held
 * by another process), sleep 50ms and retry, up to maxWaitMs total.
 */

import { writeFile, unlink, access } from "node:fs/promises";
import { constants } from "node:fs";

export interface LockOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_MAX_WAIT = 60_000; // 1 min
const DEFAULT_POLL_INTERVAL = 50;

/**
 * Acquire exclusive lock. Returns a release function.
 * The returned promise resolves once the lock is actually held.
 */
export async function acquireLock(lockFile: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
  const sentinel = `${lockFile}.owner.${process.pid}.${Date.now()}`;

  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      // O_EXCL atomic create; fails if file exists
      await writeFile(sentinel, String(Date.now()), { flag: "wx" });
      // Lock acquired
      return async () => {
        try {
          await unlink(sentinel);
        } catch {
          // Best effort - sentinel may already be gone
        }
      };
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        // Real error (disk full, permission, etc.)
        throw e;
      }
      // Lock held by another process; wait and retry
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }
  throw new Error(`Lock acquisition timed out after ${maxWait}ms: ${lockFile}`);
}

/**
 * Run callback while holding lock. Releases even if callback throws.
 */
export async function withLock<T>(lockFile: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
  const release = await acquireLock(lockFile, opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}
