/**
 * test/bash-mid-call-kill.test.ts — GC-2026-043 T3 (Phase 5 integration)
 *
 * Proves the bash wrapper actually kills a long-running child at the
 * per-bucket timeout via `spawn({ signal })` in real Node. Complements
 * `test/bash-signal-kill.test.ts` (which tests via bucket timeout of the
 * default 5s `read` bucket): these tests use `sleep` + a short explicit
 * `other` bucket timeout so we exercise the same kill path with a
 * deterministic child process.
 *
 * Pinned invariants (goal-GC-2026-043.yaml SC9):
 *   - A long-running `sleep` is killed at the configured bucket limit
 *     with BashError.kind === "timeout" and details.bucket === "<bucket>".
 *   - Elapsed time stays well under the run deadline (proves the bucket
 *     timer, not the deadline, fired).
 *   - SIGTERM-ignoring children still die within the 2s grace + 1s
 *     margin via SIGKILL escalation (C5 from design-timeout-architecture).
 *
 * Anti-rule: no new npm dependencies (Node built-ins + vitest only).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	type BucketTimeouts,
	DEFAULT_BUCKET_TIMEOUTS_MS,
	type RunConfig,
	RunController,
} from "../src/run-controller.js";
import { BashError, bashTool } from "../src/tools/bash.js";

function makeConfig(bucketOverrides: Partial<BucketTimeouts>): RunConfig {
	return {
		type: "developer",
		deadlineMs: 5 * 60_000,
		maxTurns: 60,
		bucketTimeoutsMs: {
			...DEFAULT_BUCKET_TIMEOUTS_MS,
			...bucketOverrides,
		},
	};
}

const created: RunController[] = [];
function makeController(
	bucketOverrides: Partial<BucketTimeouts>,
): RunController {
	const cfg = makeConfig(bucketOverrides);
	const rc = new RunController(undefined, cfg);
	created.push(rc);
	return rc;
}

afterEach(() => {
	for (const rc of created) rc.cleanup();
	created.length = 0;
});

describe("bash mid-tool-call kill (Phase 5 / SC9)", () => {
	it("kills sleep 100 at the bucket timeout with BashError.timeout", async () => {
		// Force the `other` bucket to 1s so the test stays fast.
		const rc = makeController({ other: 1000 });

		const start = Date.now();
		// `sleep 100` lands in the `other` bucket (no prefix match for
		// read/search/test/network/fullTest) → 1s timeout fires here.
		const result = await bashTool("sleep 100", {
			runController: rc,
			cwd: "/tmp",
		});
		const elapsed = Date.now() - start;

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected timeout, got ok:true");

		const err = result.error;
		expect(err).toBeInstanceOf(BashError);
		expect(err.kind).toBe("timeout");
		expect(err.details.bucket).toBe("other");
		expect(err.details.timeoutMs).toBe(1000);

		// 1s bucket + ~1s margin for spawn + SIGTERM propagation + exit
		// detection. Strictly less than the run deadline (5 min) so we
		// know the bucket timer fired, not the deadline.
		expect(elapsed).toBeGreaterThanOrEqual(1000);
		expect(elapsed).toBeLessThan(5000);
	});

	it("SIGTERM-ignoring sleep still dies within 2s grace + SIGKILL escalation", async () => {
		// 1.5s bucket → bucket timer fires before the run deadline.
		const rc = makeController({ other: 1500 });

		const start = Date.now();
		// `trap '' TERM` makes the child ignore SIGTERM; only SIGKILL
		// can stop the `sleep`. Exercises C5 (SIGTERM-with-grace) from
		// design-timeout-architecture.md.
		const result = await bashTool("trap '' TERM; sleep 100", {
			runController: rc,
			cwd: "/tmp",
		});
		const elapsed = Date.now() - start;

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected escalation-killed, got ok:true");

		const err = result.error;
		// Bash classifies as "timeout" because the abort caused the exit
		// (signal-after-exit discrimination — see bash.ts C3).
		expect(err.kind === "timeout" || err.kind === "exit").toBe(true);
		if (err.kind === "exit") {
			// If classified as plain exit, it MUST be via SIGKILL.
			expect(err.details.signal).toBe("SIGKILL");
		}

		// 1.5s bucket + 2s SIGKILL grace + small overhead. Must exceed
		// the SIGTERM grace alone (proves we actually waited for SIGKILL,
		// not just SIGTERM) and stay well under run deadline.
		expect(elapsed).toBeGreaterThanOrEqual(3000);
		expect(elapsed).toBeLessThan(8000);
	});
});
