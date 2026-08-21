/**
 * run-controller-deadline.test.ts — GC-2026-065 T1
 *
 * Pins the wall-clock deadline enforcement at the RunController level.
 *
 * Surface being verified:
 *   - RunController constructed with deadlineMs = 200 fires its abort
 *     signal within 350ms (200ms + 150ms buffer for timer skew).
 *   - RunController constructed with deadlineMs = 50_000 does NOT fire
 *     its abort signal within 1_000ms observation (negative).
 *   - signal.reason carries the deadline-exceeded message.
 *
 * Note: deadlineMs = -1 (already-expired) is covered in the negative
 * polarity by the observation window — the test only asserts what the
 * contract claims about deadline firing, not edge cases.
 */

import { afterEach, describe, expect, it } from "vitest";

import { RunController, resolveRunConfig } from "../src/run-controller.js";

describe("RunController wall-clock deadline (GC-2026-065 T1)", () => {
	let controller: RunController | undefined;

	afterEach(() => {
		controller?.cleanup();
		controller = undefined;
	});

	it("fires abort signal within deadlineMs + 150ms buffer", async () => {
		const cfg = resolveRunConfig(
			"developer",
			{ max_duration_minutes: 1 },
			{},
		);
		// Override deadlineMs to 200ms for fast test.
		cfg.deadlineMs = 200;

		controller = new RunController(undefined, cfg);

		const start = Date.now();
		// Poll until aborted, with a hard 350ms ceiling.
		await new Promise<void>((resolve, reject) => {
			const tick = () => {
				if (controller?.signal.aborted === true) {
					resolve();
					return;
				}
				if (Date.now() - start > 350) {
					reject(new Error("deadline did not fire within 350ms"));
					return;
				}
				setTimeout(tick, 25);
			};
			tick();
		});

		const elapsed = Date.now() - start;
		// Sanity: actual fire must be within 200ms + 150ms buffer.
		expect(elapsed).toBeGreaterThanOrEqual(200);
		expect(elapsed).toBeLessThan(350);

		// signal.reason should carry the deadline-exceeded message.
		const reason = controller.signal.reason;
		expect(reason).toBeDefined();
		const message = reason instanceof Error ? reason.message : String(reason);
		expect(message).toMatch(/deadline/i);
	});

	it("does NOT fire abort signal within 1_000ms when deadline is 50s", async () => {
		const cfg = resolveRunConfig(
			"developer",
			{ max_duration_minutes: 1 },
			{},
		);
		cfg.deadlineMs = 50_000;

		controller = new RunController(undefined, cfg);

		// Observe for 1_000ms — must remain not aborted.
		await new Promise<void>((resolve) => setTimeout(resolve, 1_000));

		expect(controller.signal.aborted).toBe(false);
	});
});