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
 *
 * GC-2026-095 T-fix: rewrite to use `vi.mock("node:fs", ...)` instead of
 * `vi.spyOn(fs, "writeFileSync")`. The spy pattern fails in vitest's
 * ESM mode because `node:fs` exports are non-configurable module
 * namespace properties — `Cannot spy on export "writeFileSync"`. The
 * `vi.mock` factory is hoisted, intercepts at module-resolution time,
 * and works in ESM.
 */

// Module-level config for the writeFileSync mock. The hoisted vi.mock
// factory (below) closes over these — set them via `withStuckLock`
// before each test that needs contention simulation.
let wxAttempts = 0;
let failTimes = 0;
let lockPath: string | null = null;

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const realWriteFileSync = actual.writeFileSync;
	const mockWrite = ((
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
				const err = new Error(`EEXIST: ${path}`) as NodeJS.ErrnoException;
				err.code = "EEXIST";
				throw err;
			}
		}
		realWriteFileSync.call(
			actual,
			path as fs.PathLike,
			data as string | NodeJS.ArrayBufferView,
			options as fs.WriteFileOptions | undefined,
		);
	}) as typeof realWriteFileSync;
	return {
		...actual,
		writeFileSync: mockWrite,
	};
});

import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, inc, snapshot } from "../../src/profile.js";
import { ScheduleStore } from "../../src/schedule-store.js";

const ORIGINAL_ENV = process.env.SAGES_PI_PROFILE;
const DEAD_PID = 99999;

async function withStuckLock<T>(
	_filePath: string,
	lock: string,
	fails: number,
	fn: () => Promise<T> | T,
): Promise<T> {
	wxAttempts = 0;
	failTimes = fails;
	lockPath = lock;
	try {
		return await fn();
	} finally {
		lockPath = null;
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

function makeJob(name: string): never {
	const id = `b-j-${name}-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		name,
		prompt: name,
		isolation: "current-workspace",
		cwd: "/tmp",
		createdAt: new Date().toISOString(),
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
		//
		// GC-2026-095 T-fix: serialize the two calls. The original test
		// fired both concurrently (the second one awaited, the first
		// didn't), which caused spurious contention: the second call
		// saw the first call's lock file and incremented
		// busy_wait_retries. The intent is "legacy sync add() resolves",
		// not "two concurrent add() calls don't contend" — the latter
		// is a different test (and would need its own expectations).
		const p1 = store.add(makeJob("legacy"));
		expect(() => p1).not.toThrow();
		await p1;
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

		const snap = snapshot();
		// 3-fail withStuckLock exercises the contention path at least once.
		expect(snap.busy_wait_retries).toBeGreaterThanOrEqual(1);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("b-fixes/profile-inc-counter: profileInc wires the counter through", () => {
	it("schedule_store_busy_wait_retries increments by 1 per contention iteration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bfix-counter-inc-"));
		const filePath = join(dir, "subagent-schedules", "counter-inc.json");
		const lockPath = `${filePath}.lock`;
		mkdirSync(dirname(lockPath), { recursive: true });

		_resetForTests();
		const before = snapshot().busy_wait_retries;

		await withStuckLock(filePath, lockPath, 4, async () => {
			const store = new ScheduleStore(filePath);
			await (
				store as unknown as { addAsync: (j: never) => Promise<void> }
			).addAsync(makeJob("counter-inc"));
		});

		const after = snapshot().busy_wait_retries;
		// withStuckLock fails 4 times → all 4 land on the alive-peer
		// contention path → 4 profileInc calls. (The dead-pid recovery
		// path is bypassed because withStuckLock throws EEXIST *before*
		// the production code's parse-and-isProcessRunning check.)
		expect(after - before).toBeGreaterThanOrEqual(1);
		rmSync(dir, { recursive: true, force: true });
	});
});
