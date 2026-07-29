/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model lifted from pi-chonky-tasks/src/task-store.ts: every
 * mutation acquires a PID-based exclusion lock, re-reads the latest state
 * from disk, applies the change, atomic-writes via temp+rename, releases.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inc as profileInc } from "./profile.js";
import type { ScheduledSubagent, ScheduleStoreData } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire the file-based exclusion lock. GC-2026-021 B-fix: this is now
 * `async` and yields the event loop with `setTimeout` under contention
 * instead of burning a CPU core on a 50 ms `Date.now()` busy-wait.
 *
 * Under contention, the loop:
 *   1. increments `schedule_store_busy_wait_retries` (per-iter counter)
 *   2. reads the lock file; if the holder is dead, unlink + retry
 *   3. yields with `setTimeout(LOCK_RETRY_MS)` so the event loop
 *      services UI / IPC / timers in the same process while the peer
 *      holds the lock — burns ~0% CPU vs the original ~50% single-core
 *
 * `add` / `update` / `remove` expose the same lock by awaiting this
 * Promise under the hood (see `withLock` below).
 */
async function acquireLock(lockPath: string): Promise<void> {
	for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
		try {
			writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
			profileInc("schedule_store_lock_acquired");
			return;
		} catch (e: any) {
			if (e.code === "EEXIST") {
				// GC-2026-028 F4 fix: the contention counter now increments
				// ONLY when we are actually about to yield — i.e. a live
				// peer holds the lock. Stale-lock recovery (dead-pid →
				// unlink + continue) is NOT contention; counting it here
				// would inflate dashboards with false events. The
				// "max_retries_exceeded" counter still fires when the cap
				// trips so we don't lose visibility into retry-storms.
				try {
					const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
					if (pid && !isProcessRunning(pid)) {
						unlinkSync(lockPath);
						continue;
					}
				} catch {
					/* ignore — try again */
				}
				profileInc("schedule_store_busy_wait_retries");
				// GC-2026-021 B-fix: yield the event loop instead of busy-waiting
				// for LOCK_RETRY_MS. setTimeout lets the event loop process other
				// I/O (UI timers, IPC) while we wait for the peer to release the
				// lock — burns ~0% CPU on the waiting process vs. ~50% single-core
				// under contention.
				await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
				continue;
			}
			throw e;
		}
	}
	// GC-2026-020: separate counter for "cap tripped" — distinguishable
	// from per-iter retries so dashboards can attribute the 5-second
	// busy-wait to a stalled peer vs. a transient retry storm.
	profileInc("schedule_store_max_retries_exceeded");
	throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		/* ignore */
	}
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
	return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
	private filePath: string;
	private lockPath: string;
	private jobs = new Map<string, ScheduledSubagent>();

	constructor(filePath: string) {
		this.filePath = filePath;
		this.lockPath = `${filePath}.lock`;
		this.load();
	}

	/** Create the backing directory lazily — only when we're about to persist. */
	private ensureDir(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
	}

	/** Load from disk into the in-memory cache. Silent on parse errors. */
	private load(): void {
		if (!existsSync(this.filePath)) return;
		try {
			const data: ScheduleStoreData = JSON.parse(
				readFileSync(this.filePath, "utf-8"),
			);
			this.jobs.clear();
			for (const j of data.jobs ?? []) this.jobs.set(j.id, j);
		} catch {
			/* corrupt — start fresh, next save rewrites */
		}
	}

	/** Atomic write via temp file + rename (POSIX-atomic). */
	private save(): void {
		const data: ScheduleStoreData = {
			version: 1,
			jobs: [...this.jobs.values()],
		};
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, this.filePath);
	}

	/**
	 * Acquire lock → reload → mutate → save → release.
	 *
	 * GC-2026-021 B-fix: this is now fully async. The lock acquisition
	 * yields the event loop with `setTimeout(LOCK_RETRY_MS)` under
	 * contention — no busy-wait — so the calling process burns ~0% CPU
	 * on a peer-held lock vs. the original ~50% single-core.
	 *
	 * The public methods (`add` / `update` / `remove`) return
	 * `Promise<void>` / `Promise<T | undefined>` / `Promise<boolean>`.
	 * Existing `SubagentScheduler` call sites in `src/schedule.ts` were
	 * updated to await them; the call sites are all in event-handler
	 * context (cron tick, request handler) where `await` is idiomatic.
	 * No new dependencies are introduced.
	 */
	private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		this.ensureDir();
		await acquireLock(this.lockPath);
		try {
			this.load();
			const result = await fn();
			this.save();
			return result;
		} finally {
			releaseLock(this.lockPath);
		}
	}

	/** Read-only — returns a snapshot of the in-memory cache. */
	list(): ScheduledSubagent[] {
		return [...this.jobs.values()];
	}

	/** Read-only check — uses the cache. */
	hasName(name: string, exceptId?: string): boolean {
		for (const j of this.jobs.values()) {
			if (j.id !== exceptId && j.name === name) return true;
		}
		return false;
	}

	get(id: string): ScheduledSubagent | undefined {
		return this.jobs.get(id);
	}

	/**
	 * Persist a job. GC-2026-021 B-fix: now returns a `Promise<void>`.
	 * `await store.add(job)` to wait for the lock + write. Fire-and-forget
	 * (no await) is also safe — the work happens in a microtask after
	 * the lock is acquired — but the persistence is no longer observable
	 * in the same tick as the call.
	 */
	add(job: ScheduledSubagent): Promise<void> {
		return this.withLock(() => {
			this.jobs.set(job.id, job);
		});
	}

	/**
	 * GC-2026-021 B-fix: legacy `addAsync` alias. Now that `add` itself
	 * returns a Promise, this method is a thin shim for callers that
	 * want the explicit-async intent at the call site. Functionally
	 * identical to `add(job)`.
	 */
	addAsync(job: ScheduledSubagent): Promise<void> {
		return this.add(job);
	}

	/**
	 * Patch a job. GC-2026-021 B-fix: now returns a `Promise<...>`. The
	 * no-op fast path for an unknown id is preserved and returns
	 * `Promise.resolve(undefined)` synchronously.
	 */
	update(
		id: string,
		patch: Partial<ScheduledSubagent>,
	): Promise<ScheduledSubagent | undefined> {
		// No-op fast path — an unknown id changes nothing, so don't lock or touch
		// disk (which would otherwise lazily create the backing directory).
		if (!this.jobs.has(id)) return Promise.resolve(undefined);
		return this.withLock(() => {
			const existing = this.jobs.get(id);
			if (!existing) return undefined;
			const updated = { ...existing, ...patch };
			this.jobs.set(id, updated);
			return updated;
		});
	}

	/** GC-2026-021 B-fix: `updateAsync` is now an alias for `update`. */
	updateAsync(
		id: string,
		patch: Partial<ScheduledSubagent>,
	): Promise<ScheduledSubagent | undefined> {
		return this.update(id, patch);
	}

	/**
	 * Remove a job. GC-2026-021 B-fix: now returns a `Promise<boolean>`.
	 * The no-op fast path for an unknown id is preserved and returns
	 * `Promise.resolve(false)` synchronously.
	 */
	remove(id: string): Promise<boolean> {
		// No-op fast path — see update().
		if (!this.jobs.has(id)) return Promise.resolve(false);
		return this.withLock(() => this.jobs.delete(id));
	}

	/** GC-2026-021 B-fix: `removeAsync` is now an alias for `remove`. */
	removeAsync(id: string): Promise<boolean> {
		return this.remove(id);
	}

	/** Delete the backing file (used when no jobs remain, optional cleanup). */
	deleteFileIfEmpty(): void {
		if (this.jobs.size === 0 && existsSync(this.filePath)) {
			try {
				unlinkSync(this.filePath);
			} catch {
				/* ignore */
			}
		}
	}
}
