/**
 * test/b-fixes/multi-budget.test.ts — GC-2026-022 SC5.
 *
 * Pinned invariants (goal-GC-2026-022.yaml SC5):
 *   - Two `BudgetTracker` instances (one for `developer`, one for `auditor`)
 *     running in parallel have INDEPENDENT progress: ticks on one do not
 *     affect the other; either can exceed at a different time.
 *   - This mirrors the real scenario where a single dispatch loop may host
 *     multiple agent types in the same process and the budget must NOT
 *     collapse to a global counter.
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
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-multi-budget-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("b-fixes/multi-budget: independent tracker state across types", () => {
	it("two BudgetTrackers (developer, auditor) maintain independent progress and exceed independently", () => {
		mkdirSync(join(tmpRoot, "dev"), { recursive: true });
		mkdirSync(join(tmpRoot, "aud"), { recursive: true });
		const devPath = join(tmpRoot, "dev", "dev.json");
		const audPath = join(tmpRoot, "aud", "aud.json");

		const dev = new BudgetTracker(
			{
				maxTurns: 4,
				maxMs: 60_000,
				snapshotEveryTurns: 0,
				partialTriggerPct: 0.8,
			},
			devPath,
		);
		const aud = new BudgetTracker(
			{
				maxTurns: 2,
				maxMs: 60_000,
				snapshotEveryTurns: 0,
				partialTriggerPct: 0.8,
			},
			audPath,
		);

		// Interleaved ticks — one cycle each. Aud exceeds first; dev still ok.
		dev.tick(); // dev=1, aud=0
		aud.tick(); // dev=1, aud=1
		dev.tick(); // dev=2, aud=1
		let audErr: unknown = null;
		try {
			// aud=2 (100% of maxTurns=2) — throws BudgetExceededError.
			aud.tick();
		} catch (e) {
			audErr = e;
		}
		expect(audErr).toBeInstanceOf(BudgetExceededError);

		// dev is still healthy at turns=2/4.
		expect(dev.getStatus()).toBe("ok");
		const devProgress = dev.getProgress();
		expect(devProgress.turns).toBe(2);
		expect(devProgress.pctTurns).toBeCloseTo(0.5, 5);

		// dev catches up and exceeds; both error states are independent.
		dev.tick(); // dev=3
		let devErr: unknown = null;
		try {
			// dev=4 (100% of maxTurns=4) — throws BudgetExceededError.
			dev.tick();
		} catch (e) {
			devErr = e;
		}
		expect(devErr).toBeInstanceOf(BudgetExceededError);

		// Both handoff files exist and are independent on disk.
		const devState = readHandoff(devPath);
		const audState = readHandoff(audPath);
		expect(devState?.trigger).toBe("final");
		expect(audState?.trigger).toBe("final");
		// Same trigger, independent paths: the files don't clobber each
		// other — that's what we care about. (Without opts, both default
		// to task_id="_budget", which is the runner's placeholder
		// behavior; the orchestrator overwrites it later.)
		expect(devPath).not.toBe(audPath);
		expect(devState?.phase).toBe("aborted");
		expect(audState?.phase).toBe("aborted");
	});

	it("progress getters do not cross-contaminate when one tracker is partial and the other is fresh", () => {
		const dev = new BudgetTracker(
			{
				maxTurns: 5,
				maxMs: 60_000,
				snapshotEveryTurns: 0,
				partialTriggerPct: 0.8,
			},
			join(tmpRoot, "dev.json"),
		);
		const aud = new BudgetTracker(
			{
				maxTurns: 5,
				maxMs: 60_000,
				snapshotEveryTurns: 0,
				partialTriggerPct: 0.8,
			},
			join(tmpRoot, "aud.json"),
		);

		// Drive dev to 4 turns (80% → partial-triggered), leave aud at 1.
		for (let i = 0; i < 4; i++) dev.tick();
		aud.tick();

		expect(dev.getStatus()).toBe("partial-triggered");
		expect(aud.getStatus()).toBe("ok");
		expect(dev.getProgress().turns).toBe(4);
		expect(aud.getProgress().turns).toBe(1);
	});
});
