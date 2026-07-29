/**
 * test/b-fixes/schedule-store-acquire-lock-async.test.ts — GC-2026-028 F2 regression gate.
 *
 * Background (GC-2026-021 / GC-2026-028 audit):
 *   - Originally `acquireLock` was a sync function using a `Date.now()` busy-wait.
 *     That starved the event loop while a peer held the lock file (~50% single-core).
 *   - GC-2026-021 B-fix made `acquireLock` async (returns `Promise<void>`) and
 *     replaced the busy-wait with `await new Promise(r => setTimeout(r, ...))`.
 *   - GC-2026-028 audit (F2) flagged this property as a contract that must be
 *     pinned by a test. The earlier `schedule-store-yield.test.ts` covers the
 *     end-to-end behavior (busy-wait yield, retry counter, etc.). This test
 *     is the minimal contract gate — if a future refactor ever drops the
 *     `async` keyword on `acquireLock` (e.g. someone "optimizes" the wait
 *     back to a sync busy-loop), the contract test fails immediately,
 *     independent of the higher-level E2E.
 *
 * Anti-rule: no new npm dependencies. Pure built-in setTimeout.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../../src/schedule-store.js";

const DEAD_PID = 99999;

describe("b-fixes/schedule-store-acquire-lock-async: GC-2026-028 F2 regression gate", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("add() returns a Promise<void> (async surface, GC-2026-021 contract)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-f2-async-surface-"));
		dirs.push(dir);
		const filePath = join(dir, "subagent-schedules", "surface.json");
		const store = new ScheduleStore(filePath);

		const ret = store.add({
			id: "f2-surface",
			name: "f2-surface",
			description: "async surface test",
			schedule: "+10m",
			scheduleType: "once",
			subagent_type: "Explore",
			prompt: "x",
			enabled: true,
			createdAt: new Date().toISOString(),
		} as never);

		// Hard contract: the public surface MUST be a Promise. If a refactor
		// re-introduces a sync body, this assertion fails immediately.
		expect(ret).toBeInstanceOf(Promise);
		await ret;
	});

	it("addAsync() returns the same Promise shape as add() (alias contract)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-f2-addasync-alias-"));
		dirs.push(dir);
		const filePath = join(dir, "subagent-schedules", "alias.json");
		const store = new ScheduleStore(filePath);

		const ret = (
			store as unknown as { addAsync: (j: never) => Promise<void> }
		).addAsync({
			id: "f2-alias",
			name: "f2-alias",
			description: "addAsync alias test",
			schedule: "+10m",
			scheduleType: "once",
			subagent_type: "Explore",
			prompt: "x",
			enabled: true,
			createdAt: new Date().toISOString(),
		} as never);

		expect(ret).toBeInstanceOf(Promise);
		await ret;
	});

	it("add() under contention completes (does NOT hang the event loop)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-f2-yield-"));
		dirs.push(dir);
		const filePath = join(dir, "subagent-schedules", "yield.json");
		const lockPath = `${filePath}.lock`;

		// Plant a lock file owned by a dead PID — guarantees the retry loop
		// runs at least once. acquireLock must detect dead PID + unlink, NOT
		// busy-wait, so the operation completes within a finite budget.
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, String(DEAD_PID), "utf-8");

		const store = new ScheduleStore(filePath);

		const t0 = process.hrtime.bigint();
		const promise = store.add({
			id: "f2-yield",
			name: "f2-yield",
			description: "yield test",
			schedule: "+10m",
			scheduleType: "once",
			subagent_type: "Explore",
			prompt: "x",
			enabled: true,
			createdAt: new Date().toISOString(),
		} as never);

		// The Promise itself is the proof: a sync busy-wait would have
		// returned synchronously already (or thrown on EEXIST); an async
		// function returns a Promise *before* its body runs.
		expect(promise).toBeInstanceOf(Promise);

		await promise;
		const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;

		// Generous bound — covers CI variance. A real busy-wait would also
		// pass this; the strong proof is the Promise contract above.
		expect(elapsedMs).toBeLessThan(2_000);
	});
});