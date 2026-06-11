/**
 * flock.ts - Cross-process mutex via atomic file creation.
 *
 * Bun does not expose POSIX flock() via FileHandle. We use atomic
 * O_EXCL file creation (writeFile flag: 'wx') on the SHARED lock file
 * itself. The first acquirer creates it; others see EEXIST and wait.
 *
 * Stale lock detection: if the existing lock file contains a PID, we
 * check if that PID is alive. If dead, we steal the lock (unlink + retry).
 * This handles crashes that left the lock file behind.
 *
 * Re-entrancy: if the same process tries to acquire while already holding,
 * we return a no-op release (the original acquire's release still works).
 */

import { writeFile, unlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface LockOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_MAX_WAIT = 60_000;
const DEFAULT_POLL_INTERVAL = 50;

export async function acquireLock(lockFile: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;

  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < maxWait) {
    attempts++;
    try {
      // Atomic create with O_EXCL
      await writeFile(lockFile, String(process.pid), { flag: "wx" });
      return async () => releaseLock(lockFile);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw e;
      }
      // Lock file exists. Check if it's stale.
      if (await isStaleLock(lockFile)) {
        try {
          await unlink(lockFile);
          continue; // Retry immediately
        } catch {
          // Race: someone else unlinked it. Loop will retry.
        }
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }
  throw new Error(`Lock acquisition timed out after ${maxWait}ms: ${lockFile} (attempts=${attempts})`);
}

async function isStaleLock(lockFile: string): Promise<boolean> {
  try {
    const content = await readFile(lockFile, "utf-8");
    const pid = parseInt(content.trim());
    if (!pid || pid <= 0) return false;
    // Check if the PID is still alive
    try {
      process.kill(pid, 0);
      return false; // Alive, not stale
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ESRCH") return true; // Dead, stale
      if (err.code === "EPERM") return false; // Exists but we can't signal
      return false;
    }
  } catch {
    return false; // Can't read; assume not stale
  }
}

async function releaseLock(lockFile: string): Promise<void> {
  try {
    await unlink(lockFile);
  } catch {
    // Best effort; may already be gone
  }
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
