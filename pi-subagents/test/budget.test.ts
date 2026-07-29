/**
 * test/budget.test.ts — GC-2026-022 SC2 + SC4 (defaults / env override / threshold).
 *
 * Pinned invariants (goal-GC-2026-022.yaml SC2 + SC4):
 *   - `defaultBudgets` has the expected entries: developer=60t/20m/15,
 *     auditor=30t/10m/10, explorer=20t/5m/7, merger=20t/5m/7.
 *   - `loadBudgetFromEnv('developer')` honors `SAGES_PI_AGENT_DEVELOPER_BUDGET_TURNS`
 *     over the generic `SAGES_PI_AGENT_BUDGET_TURNS`, and falls back to
 *     `defaultBudgets.developer` when neither is set.
 *   - `BudgetTracker.tick()` triggers a partial write at 80% (writes a
 *     handoff with `trigger: 'partial'`) and a `BudgetExceededError` at
 *     100%, with the exceeded-error carrying the handoff path.
 *
 * Anti-rule: no new npm dependencies.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BudgetExceededError,
	BudgetTracker,
	defaultBudgets,
	loadBudgetFromEnv,
} from "../src/budget.js";
import { readHandoff } from "../src/handoff.js";

const ENV_KEYS = [
	"SAGES_PI_AGENT_BUDGET_TURNS",
	"SAGES_PI_AGENT_BUDGET_MS",
	"SAGES_PI_AGENT_DEVELOPER_BUDGET_TURNS",
	"SAGES_PI_AGENT_DEVELOPER_BUDGET_MS",
	"SAGES_PI_AGENT_AUDITOR_BUDGET_TURNS",
	"SAGES_PI_AGENT_EXPLORER_BUDGET_TURNS",
	"SAGES_PI_AGENT_MERGER_BUDGET_TURNS",
] as const;

let savedEnv: Record<string, string | undefined>;
let tmpRoot: string;

beforeEach(() => {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-budget-"));
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("budget: defaults + env override", () => {
	it("defaultBudgets has the expected per-type entries", () => {
		expect(defaultBudgets.developer.maxTurns).toBe(60);
		expect(defaultBudgets.developer.maxMs).toBe(20 * 60_000);
		expect(defaultBudgets.developer.snapshotEveryTurns).toBe(15);
		expect(defaultBudgets.auditor.maxTurns).toBe(30);
		expect(defaultBudgets.auditor.maxMs).toBe(10 * 60_000);
		expect(defaultBudgets.auditor.snapshotEveryTurns).toBe(10);
		expect(defaultBudgets.explorer.maxTurns).toBe(20);
		expect(defaultBudgets.explorer.maxMs).toBe(5 * 60_000);
		expect(defaultBudgets.explorer.snapshotEveryTurns).toBe(7);
		expect(defaultBudgets.merger.maxTurns).toBe(20);
		expect(defaultBudgets.merger.maxMs).toBe(5 * 60_000);
		expect(defaultBudgets.merger.snapshotEveryTurns).toBe(7);
	});

	it("loadBudgetFromEnv('developer') honors per-type env override over generic", () => {
		process.env.SAGES_PI_AGENT_BUDGET_TURNS = "42";
		process.env.SAGES_PI_AGENT_DEVELOPER_BUDGET_TURNS = "99";
		const b = loadBudgetFromEnv("developer");
		expect(b.maxTurns).toBe(99);
	});

	it("loadBudgetFromEnv('explorer') with no env returns defaultBudgets.explorer", () => {
		const b = loadBudgetFromEnv("explorer");
		expect(b.maxTurns).toBe(defaultBudgets.explorer.maxTurns);
		expect(b.maxMs).toBe(defaultBudgets.explorer.maxMs);
	});
});

describe("budget: threshold triggers", () => {
	it("BudgetTracker.tick() emits a 'partial' handoff at >=80% and throws BudgetExceededError at 100%", () => {
		mkdirSync(join(tmpRoot, "handoff"), { recursive: true });
		const handoffPath = join(tmpRoot, "handoff", "tracker.json");
		const tracker = new BudgetTracker(
			{
				maxTurns: 5,
				maxMs: 60_000,
				snapshotEveryTurns: 0,
				partialTriggerPct: 0.8,
			},
			handoffPath,
		);

		// 4 ticks of 5 (80%) — partial trigger fires on the 4th.
		tracker.tick();
		tracker.tick();
		tracker.tick();
		tracker.tick();
		expect(tracker.getStatus()).toBe("partial-triggered");
		const partial = readHandoff(handoffPath);
		expect(partial?.trigger).toBe("partial");
		expect(partial?.phase).toBe("in-progress");

		// 5th tick crosses 100% → throws.
		expect(() => tracker.tick()).toThrow(BudgetExceededError);
		try {
			tracker.tick();
		} catch (e) {
			expect(e).toBeInstanceOf(BudgetExceededError);
			const err = e as BudgetExceededError;
			expect(err.type).toBe("turns");
			expect(err.handoffPath).toBe(handoffPath);
		}
		const final = readHandoff(handoffPath);
		expect(final?.trigger).toBe("final");
		expect(final?.phase).toBe("aborted");
	});
});
