/**
 * test/b-fixes/schedule-store-stale-lock-counter.test.ts — GC-2026-028 F4 regression gate.
 *
 * Audit (GC-2026-028 F4):
 *   The pre-fix `acquireLock` called `profileInc("schedule_store_busy_wait_retries")`
 *   unconditionally on every EEXIST iteration — including the dead-pid recovery
 *   path. A dead-pid lock recovery is NOT a contention event: we simply
 *   `unlink` the stale lock file and `continue` (next iteration succeeds in
 *   `wx`-mode). Counting it as a "busy wait retry" inflates dashboards with
 *   false contention events and obscures real peer-held contention.
 *
 * Contract under test:
 *   - The retry counter MUST NOT increment on the dead-pid recovery path.
 *
 * Counter-positive coverage for the alive-peer path is already provided by
 * `test/b-fixes/schedule-store-yield.test.ts` ("counter increments under
 * contention") — we only need to add the negative-case gate here.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTests, snapshot } from "../../src/profile.js";
import { ScheduleStore } from "../../src/schedule-store.js";

const ORIGINAL_ENV = process.env.SAGES_PI_PROFILE;
const DEAD_PID = 99999; // unlikely to be a live PID in the test runner

let dir: string;

beforeEach(() => {
	_resetForTests();
	process.env.SAGES_PI_PROFILE = "1";
});

afterEach(() => {
	_resetForTests();
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
	if (ORIGINAL_ENV === undefined) {
		delete process.env.SAGES_PI_PROFILE;
	} else {
		process.env.SAGES_PI_PROFILE = ORIGINAL_ENV;
	}
});

describe("b-fixes/schedule-store-stale-lock-counter: GC-2026-028 F4", () => {
	it("dead-pid recovery does NOT increment busy_wait_retries", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-f4-stale-"));
		const filePath = join(dir, "subagent-schedules", "stale.json");
		const lockPath = `${filePath}.lock`;

		// Plant a lock file owned by a DEAD PID. The first acquireLock
		// iteration hits EEXIST, reads the lock, detects the dead PID,
		// unlinks, and `continue`s to the next loop iteration — at which
		// point the wx write succeeds. None of those iterations are
		// genuine contention; the counter must remain at zero.
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, String(DEAD_PID), "utf-8");

		const store = new ScheduleStore(filePath);
		await store.add({
			id: "f4-stale",
			name: "f4-stale",
			description: "stale-lock recovery test",
			schedule: "+10m",
			scheduleType: "once",
			subagent_type: "Explore",
			prompt: "x",
			enabled: true,
			createdAt: new Date().toISOString(),
		} as never);

		// Pre-fix bug: counter would be >= 1 because the dead-pid iteration
		// incremented before checking pid-liveness.
		// Post-fix: counter stays at 0 — recovery is not contention.
		expect(snapshot().busy_wait_retries).toBe(0);
	});

	it("dead-pid recovery succeeds when contention counter is at zero", async () => {
		// Second assertion gate: even though no contention was recorded,
		// the lock WAS acquired and the job WAS persisted. A regression
		// that suppresses the counter but also breaks the recovery path
		// would still fail this.
		dir = mkdtempSync(join(tmpdir(), "pi-f4-stale-persist-"));
		const filePath = join(dir, "subagent-schedules", "stale-persist.json");
		const lockPath = `${filePath}.lock`;
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, String(DEAD_PID), "utf-8");

		const store = new ScheduleStore(filePath);
		await store.add({
			id: "f4-stale-persist",
			name: "f4-stale-persist",
			description: "stale-lock persist test",
			schedule: "+10m",
			scheduleType: "once",
			subagent_type: "Explore",
			prompt: "x",
			enabled: true,
			createdAt: new Date().toISOString(),
		} as never);

		expect(store.get("f4-stale-persist")?.id).toBe("f4-stale-persist");
	});
});