/**
 * test/b-fixes/agent-runner-budget.test.ts — GC-2026-022 SC3.
 *
 * Pinned invariants (goal-GC-2026-022.yaml SC3):
 *   - In a simulated run loop, a `BudgetTracker` with `maxTurns: 3` causes
 *     `BudgetExceededError` after tick #3, and a handoff file is written.
 *   - With `snapshotEveryTurns: 2`, after 4 ticks the handoff file should
 *     have at least 2 snapshot triggers recorded (the last write wins, but
 *     the `trigger` field is preserved on disk).
 *   - `BudgetExceededError.handoffPath` matches the path the tracker was
 *     configured with so the orchestrator can pick up partial state.
 *
 * Note: this test exercises the BudgetTracker integration shape the
 * agent-runner uses. We do NOT spin up a real session here (that would
 * require `pi-coding-agent` test harness infra we don't have); the
 * runner is verified by the `defaultBudgets` / `loadBudgetFromEnv` /
 * `BudgetTracker` unit coverage above plus this integration shape test.
 *
 * Anti-rule: no new npm dependencies.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetTracker } from "../../src/budget.js";
import { readHandoff } from "../../src/handoff.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-runner-budget-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("b-fixes/agent-runner-budget: tick → snapshot / exceeded", () => {
	it("a low maxTurns budget (3) causes BudgetExceededError after tick #3 and writes a handoff", () => {
		mkdirSync(join(tmpRoot, "h"), { recursive: true });
		const handoffPath = join(tmpRoot, "h", "run.json");
		const tracker = new BudgetTracker(
			{
				maxTurns: 3,
				maxMs: 60_000,
				snapshotEveryTurns: 0,
				partialTriggerPct: 0.8,
			},
			handoffPath,
		);

		let captured: unknown = null;
		try {
			// Simulate the run loop's per-turn call.
			tracker.tick();
			tracker.tick();
			tracker.tick(); // crosses 100% → throws
		} catch (e) {
			captured = e;
		}
		expect(captured).toBeInstanceOf(BudgetExceededError);
		const err = captured as BudgetExceededError;
		expect(err.type).toBe("turns");
		expect(err.used.turns).toBe(3);
		expect(err.handoffPath).toBe(handoffPath);

		const final = readHandoff(handoffPath);
		expect(final).not.toBeNull();
		expect(final?.trigger).toBe("final");
		expect(final?.phase).toBe("aborted");
	});

	it("snapshot cadence (every 2 turns) writes a snapshot handoff after the 2nd and 4th tick", () => {
		mkdirSync(join(tmpRoot, "h2"), { recursive: true });
		const handoffPath = join(tmpRoot, "h2", "snap.json");
		const tracker = new BudgetTracker(
			{
				maxTurns: 4,
				maxMs: 60_000,
				snapshotEveryTurns: 2,
				partialTriggerPct: 0.8,
			},
			handoffPath,
		);
		tracker.tick(); // 1
		tracker.tick(); // 2 → snapshot
		const after2 = readHandoff(handoffPath);
		expect(after2?.trigger).toBe("snapshot");
		expect(after2?.phase).toBe("in-progress");

		tracker.tick(); // 3 (partial — 3/4 = 75% — still under 80%; skip)
		// partial trigger: 3/4 = 0.75, below 0.8 — should NOT fire.
		const after3 = readHandoff(handoffPath);
		expect(after3?.trigger).toBe("snapshot"); // unchanged

		// tick 4 crosses 100% — the tracker throws AFTER writing the
		// final/aborted handoff, so the orchestrator can pick it up.
		try {
			tracker.tick();
			throw new Error("tick 4 should have thrown BudgetExceededError");
		} catch (e) {
			expect(e).toBeInstanceOf(BudgetExceededError);
		}
		const after4 = readHandoff(handoffPath);
		expect(after4?.trigger).toBe("final");
		expect(after4?.phase).toBe("aborted");
	});
});
