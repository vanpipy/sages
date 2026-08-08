/**
 * test/bash-signal-kill.test.ts — GC-2026-040 Phase 2 (bash wrapper)
 *
 * Verifies the bash tool wrapper enforces per-bucket timeouts and
 * propagates abort signals correctly. Pinned invariants (goal-GC-2026-040
 * SC4-SC11):
 *
 *   - C1 single kill path: `spawn({ signal })` + a single escalation
 *     listener; no belt-and-suspenders duplicate paths.
 *   - C2 no hung promise: try/catch around `spawn()` + `child.on('error')`
 *     so spawn failures reject the promise instead of hanging.
 *   - C3 signal-after-exit race: 100ms grace — if the child exits within
 *     100ms after signal-fire, we do NOT mark as timeout.
 *   - C4 abort-reason: most-restrictive wins (documented in code).
 *   - C5 SIGTERM with 2s grace, then SIGKILL — so SIGTERM-ignoring children
 *     still die within ~2s of abort.
 *
 * Anti-rule: no new npm dependencies (Node built-ins + vitest only).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_BUCKET_TIMEOUTS_MS,
	RunController,
	type BucketTimeouts,
	type RunConfig,
} from "../src/run-controller.js";
import {
	BashError,
	bashTool,
} from "../src/tools/bash.js";

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
	return {
		type: "developer",
		deadlineMs: 5 * 60_000,
		maxTurns: 60,
		bucketTimeoutsMs: DEFAULT_BUCKET_TIMEOUTS_MS,
		...overrides,
	};
}

const created: RunController[] = [];
function makeController(overrides: Partial<RunConfig> = {}): RunController {
	const cfg = makeConfig(overrides);
	const rc = new RunController(undefined, cfg);
	created.push(rc);
	return rc;
}

afterEach(() => {
	for (const rc of created) rc.cleanup();
	created.length = 0;
});

describe("bashTool: completion", () => {
	it("T1: sleep 0.1 with read bucket completes normally", async () => {
		const rc = makeController();
		const result = await bashTool("sleep 0.1", {
			runController: rc,
			cwd: "/tmp",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.elapsedMs).toBeGreaterThanOrEqual(80);
		}
	});

	it("T4: echo hello returns ok:true with stdout 'hello'", async () => {
		const rc = makeController();
		const result = await bashTool("echo hello", {
			runController: rc,
			cwd: "/tmp",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.stdout.trim()).toBe("hello");
		}
	});

	it("T6: `false` returns ok:false with kind:exit code:1", async () => {
		const rc = makeController();
		const result = await bashTool("false", {
			runController: rc,
			cwd: "/tmp",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(BashError);
			expect(result.error.kind).toBe("exit");
			expect(result.error.details.code).toBe(1);
		}
	});
});

describe("bashTool: bucket timeout (C5 + signal propagation)", () => {
	it("T2: long-running command in read bucket (5s) returns timeout within 6s", { timeout: 10_000 }, async () => {
		const rc = makeController();
		const start = Date.now();
		// `tail -f /dev/null` detects as 'read' bucket (5s) and never
		// exits naturally — exercises the per-bucket timeout path.
		const result = await bashTool("tail -f /dev/null", {
			runController: rc,
			cwd: "/tmp",
		});
		const elapsed = Date.now() - start;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(BashError);
			expect(result.error.kind).toBe("timeout");
			expect(result.error.details.bucket).toBe("read");
			expect(result.error.details.timeoutMs).toBe(5_000);
			expect(result.error.details.elapsedMs).toBeGreaterThanOrEqual(5_000);
		}
		// 5s bucket + ~1s cleanup margin
		expect(elapsed).toBeLessThan(7_000);
	});
});

describe("bashTool: external abort (C1 single path)", () => {
	it("T3: external abort via runController.abortController.abort() kills child promptly", async () => {
		const rc = makeController({
			// Use a long bucket so we test run-deadline, not bucket timeout.
			bucketTimeoutsMs: {
				...DEFAULT_BUCKET_TIMEOUTS_MS,
				read: 60_000,
			} as BucketTimeouts,
		});
		const start = Date.now();
		// Spawn a long-running child, abort externally ~50ms in.
		const promise = bashTool("sleep 100", {
			runController: rc,
			cwd: "/tmp",
		});
		setTimeout(() => rc.abortController.abort(), 50);
		const result = await promise;
		const elapsed = Date.now() - start;
		// SIGTERM kills `sleep` immediately. Total time well under 2s grace.
		expect(elapsed).toBeLessThan(2_000);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind === "timeout" || result.error.kind === "exit").toBe(
				true,
			);
		}
	});
});

describe("bashTool: spawn failure (C2 no hung promise)", () => {
	it("T5: pre-aborted runController → spawn throws sync → rejects with spawn_failed", async () => {
		const parentAc = new AbortController();
		parentAc.abort();
		// RunController with already-aborted parent signal.
		const cfg = makeConfig();
		const rc = new RunController(parentAc.signal, cfg);
		created.push(rc);
		await expect(
			bashTool("echo hi", { runController: rc, cwd: "/tmp" }),
		).rejects.toBeInstanceOf(BashError);
		await expect(
			bashTool("echo hi", { runController: rc, cwd: "/tmp" }),
		).rejects.toMatchObject({ kind: "spawn_failed" });
	});
});

describe("bashTool: signal-after-exit race (C3 grace)", () => {
	it("T7: signal firing within 100ms of child exit is NOT marked as timeout", async () => {
		// Configure a very short bucket so the signal aborts quickly while
		// the child is exiting naturally. Signal aborts at ~0ms; child exits
		// at ~5-10ms; gap is well under 100ms grace → NOT a timeout.
		const rc = makeController({
			bucketTimeoutsMs: {
				...DEFAULT_BUCKET_TIMEOUTS_MS,
				read: 0,
			} as BucketTimeouts,
		});
		// `true` exits immediately. The 0ms bucket timer fires almost
		// immediately too, racing with the natural exit.
		const result = await bashTool("true", {
			runController: rc,
			cwd: "/tmp",
		});
		// With 100ms grace, this should NOT be kind:'timeout'.
		if (!result.ok) {
			expect(result.error.kind).not.toBe("timeout");
		}
		// Whether ok:true or kind:'exit', it's NOT a timeout.
		expect(result.ok === true || result.error.kind !== "timeout").toBe(true);
	});
});

describe("bashTool: SIGTERM-then-SIGKILL escalation (C5)", () => {
	it("T8: SIGTERM-ignoring child gets SIGKILL within 2s grace + 1s margin", async () => {
		// Long bucket so we test escalation specifically, not bucket timeout.
		const rc = makeController({
			bucketTimeoutsMs: {
				...DEFAULT_BUCKET_TIMEOUTS_MS,
				read: 60_000,
			} as BucketTimeouts,
		});
		const start = Date.now();
		// trap '' TERM makes the child ignore SIGTERM; only SIGKILL can stop it.
		const promise = bashTool("trap '' TERM; sleep 100", {
			runController: rc,
			cwd: "/tmp",
		});
		// Abort shortly after spawn.
		setTimeout(() => rc.abortController.abort(), 50);
		const result = await promise;
		const elapsed = Date.now() - start;
		// 50ms wait + 2000ms SIGKILL grace + small overhead.
		expect(elapsed).toBeGreaterThanOrEqual(2_000);
		expect(elapsed).toBeLessThan(3_000);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Either timed out (run-deadline abort) or exited via SIGKILL.
			expect(
				result.error.kind === "timeout" ||
					(result.error.kind === "exit" &&
						result.error.details.signal === "SIGKILL"),
			).toBe(true);
		}
	});
});