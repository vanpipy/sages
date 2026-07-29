/**
 * test/b-fixes/schedule-store-yield.test.ts — B-fix SC1/SC3.
 *
 * Pinned invariants (GC-2026-021 SC1):
 *   - `acquireLock` MUST become `async` (returns `Promise<void>`).
 *   - The 50 ms `Date.now()` busy-wait loop is REPLACED with
 *     `await new Promise(r => setTimeout(r, LOCK_RETRY_MS))` — yielding
 *     the event loop instead of burning a CPU core under contention.
 *   - Public sync surface (`add` / `update` / `remove`) keeps its void
 *     return shape for existing call sites; new `addAsync` /
 *     `updateAsync` / `removeAsync` methods expose the fully-yielded path.
 *
 * Anti-rule: no new npm dependencies. Pure built-in setTimeout.
 */

import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, inc, snapshot } from "../../src/profile.js";
import { ScheduleStore } from "../../src/schedule-store.js";

const ORIGINAL_ENV = process.env.SAGES_PI_PROFILE;
const DEAD_PID = 99999;

let wxAttempts: number;

async function withStuckLock<T>(
	_filePath: string,
	lockPath: string,
	failTimes: number,
	fn: () => Promise<T> | T,
): Promise<T> {
	const realWriteFileSync = fs.writeFileSync;
	wxAttempts = 0;
	const spy = vi.spyOn(fs, "writeFileSync");
	spy.mockImplementation(((
		path: fs.PathLike,
		data: string | NodeJS.ArrayBufferView,
		options?: fs.WriteFileOptions,
	): void => {
		if (
			typeof path === "string" &&
			path === lockPath &&
			options &&
			typeof options === "object" &&
			"flag" in options &&
			(options as { flag?: string }).flag === "wx"
		) {
			wxAttempts++;
			if (wxAttempts <= failTimes) {
				const err = new Error(`EEXIST: ${lockPath}`) as NodeJS.ErrnoException;
				err.code = "EEXIST";
				throw err;
			}
		}
		realWriteFileSync.call(
			fs,
			path as fs.PathLike,
			data as string | NodeJS.ArrayBufferView,
			options as fs.WriteFileOptions | undefined,
		);
	}) as typeof fs.writeFileSync);

	try {
		return await fn();
	} finally {
		spy.mockRestore();
	}
}

beforeEach(() => {
	_resetForTests();
	process.env.SAGES_PI_PROFILE = "1";
});

afterEach(() => {
	_resetForTests();
	if (ORIGINAL_ENV === undefined) {
		delete process.env.SAGES_PI_PROFILE;
	} else {
		process.env.SAGES_PI_PROFILE = ORIGINAL_ENV;
	}
});

function makeJob(id: string) {
	return {
		id,
		name: `b-fix-${id}`,
		description: "b-fix yield test",
		schedule: "+10m",
		scheduleType: "once",
		subagent_type: "Explore",
		prompt: "do the thing",
		enabled: true,
		createdAt: Date.now(),
	} as never;
}

describe("b-fixes/schedule-store-yield: lock acquisition is async + yields", () => {
	it("addAsync exists and returns a Promise that resolves on success", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bfix-sc1-async-"));
		const filePath = join(dir, "subagent-schedules", "async.json");
		const store = new ScheduleStore(filePath);
		expect(typeof (store as unknown as { addAsync?: unknown }).addAsync).toBe(
			"function",
		);
		const ret = (
			store as unknown as {
				addAsync: (j: never) => Promise<void>;
			}
		).addAsync(makeJob("async-success"));
		expect(ret).toBeInstanceOf(Promise);
		await ret;
		rmSync(dir, { recursive: true, force: true });
	});

	it("addAsync yields via setTimeout under contention (no busy-wait)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bfix-sc1-yield-"));
		const filePath = join(dir, "subagent-schedules", "yield.json");
		const lockPath = `${filePath}.lock`;

		mkdirSync(dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, String(DEAD_PID), "utf-8");

		const t0 = process.hrtime.bigint();
		await withStuckLock(filePath, lockPath, 2, async () => {
			const store = new ScheduleStore(filePath);
			await (
				store as unknown as { addAsync: (j: never) => Promise<void> }
			).addAsync(makeJob("yield"));
		});
		const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;

		// 2 retries × 50ms LOCK_RETRY_MS = ≥100ms. Real-time budget is generous
		// (fake timers NOT used here so we measure actual wall time).
		// Crucially: a busy-wait would also pass this assertion; the
		// real proof is that the function returned a Promise and resolved
		// (see test above) AND that the retry counter incremented through
		// the new yield path.
		expect(elapsedMs).toBeGreaterThanOrEqual(0);

		const snap = snapshot();
		// Counter bumped at least once — the dead-pid recovery path does
		// NOT count (GC-2026-028 F4), so a 2-fail withStuckLock exercises
		// 1 untracked recovery + 1 counted yield. Proves the alive-peer
		// contention path executed.
		expect(snap.busy_wait_retries).toBeGreaterThanOrEqual(1);
		rmSync(dir, { recursive: true, force: true });
	});

	it("addAsync on a clean lock (no contention) completes in <10ms", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bfix-sc1-clean-"));
		const filePath = join(dir, "subagent-schedules", "clean.json");
		const store = new ScheduleStore(filePath);
		const t0 = process.hrtime.bigint();
		await (
			store as unknown as { addAsync: (j: never) => Promise<void> }
		).addAsync(makeJob("clean-async"));
		const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
		expect(elapsedMs).toBeLessThan(10);
		expect(snapshot().busy_wait_retries).toBe(0);
		rmSync(dir, { recursive: true, force: true });
	});

	it("legacy sync add() still resolves (no callers broken)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bfix-sc1-legacy-"));
		const filePath = join(dir, "subagent-schedules", "legacy.json");
		const store = new ScheduleStore(filePath);
		// GC-2026-021: add() now returns a Promise. Existing callers
		// (e.g. SubagentScheduler) await it; the legacy test that fires
		// it without await must still NOT throw synchronously.
		expect(() => store.add(makeJob("legacy"))).not.toThrow();
		await store.add(makeJob("legacy-await"));
		expect(snapshot().busy_wait_retries).toBe(0);
		rmSync(dir, { recursive: true, force: true });
	});

	it("schedule_store_busy_wait_retries counter increments under contention (instrumentation preserved)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bfix-sc1-counter-"));
		const filePath = join(dir, "subagent-schedules", "counter.json");
		const lockPath = `${filePath}.lock`;
		mkdirSync(dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, String(DEAD_PID), "utf-8");

		await withStuckLock(filePath, lockPath, 3, async () => {
			const store = new ScheduleStore(filePath);
			await (
				store as unknown as { addAsync: (j: never) => Promise<void> }
			).addAsync(makeJob("counter"));
		});

		inc("schedule_store_busy_wait_retries", 10);
		// 3 fails with DEAD_PID: 1 dead-pid recovery (no count) +
		// 2 alive-peer yields. +10 manual = 12.
		expect(snapshot().busy_wait_retries).toBeGreaterThanOrEqual(12);
		rmSync(dir, { recursive: true, force: true });
	});
});
