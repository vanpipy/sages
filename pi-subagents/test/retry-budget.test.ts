/**
 * retry-budget.test.ts — GC-2026-070 mechanism: retryBudgetLeftFor helper.
 *
 * The helper computes the budget REMAINING after a given attempt for a
 * failure mode with a retry-subagent handler. Pure function — no I/O,
 * no pi session — uses the shipped catalog via getFailureCatalog().
 *
 * The unit tests pin:
 *   - retry-subagent causes produce budget = handler.retryBudget - 1
 *     on the first attempt (priorAttemptCount = 0).
 *   - prior attempts decrement correctly.
 *   - non-retry handlers (escalate-to-l3, mark-stalled) return undefined.
 *   - unknown causes return undefined.
 *   - the floor is 0 (never negative, even when prior attempts exceed budget).
 *
 * Wired into emitRunDiagnostic in agent-runner.ts:1288 — that integration
 * is exercised end-to-end by emit-run-diagnostic.test.ts (existing) plus
 * these targeted unit tests.
 */

import { describe, expect, it } from "bun:test";

import { retryBudgetLeftFor } from "../src/diagnostic.js";

describe("retryBudgetLeftFor", () => {
	describe("retry-subagent causes", () => {
		it("returns budget - 1 on first attempt for verification-failed (budget=2)", () => {
			const result = retryBudgetLeftFor("verification-failed");
			expect(result).toBe(1);
		});

		it("returns budget - 1 on first attempt for commit-message-non-conformant (budget=1)", () => {
			const result = retryBudgetLeftFor("commit-message-non-conformant");
			expect(result).toBe(0);
		});

		it("decrements by priorAttemptCount", () => {
			// verification-failed has retryBudget=2. After 1 prior attempt, 0 remain.
			const result = retryBudgetLeftFor("verification-failed", undefined, 1);
			expect(result).toBe(0);
		});

		it("clamps at 0 (never negative) when priorAttemptCount exceeds budget", () => {
			// verification-failed has retryBudget=2. Prior count of 5 — clearly over.
			const result = retryBudgetLeftFor("verification-failed", undefined, 5);
			expect(result).toBe(0);
		});
	});

	describe("non-retry causes", () => {
		it("returns undefined for escalate-to-l3 (author-fabricated)", () => {
			const result = retryBudgetLeftFor("author-fabricated");
			expect(result).toBeUndefined();
		});

		it("returns undefined for escalate-to-l3 (pi-orchestrator-leak)", () => {
			const result = retryBudgetLeftFor("pi-orchestrator-leak");
			expect(result).toBeUndefined();
		});

		it("returns undefined for mark-stalled (subagent-timeout)", () => {
			const result = retryBudgetLeftFor("subagent-timeout");
			expect(result).toBeUndefined();
		});

		it("returns undefined for mark-stalled (worktree-concurrency-cap-reached)", () => {
			const result = retryBudgetLeftFor("worktree-concurrency-cap-reached");
			expect(result).toBeUndefined();
		});

		it("returns undefined for the catch-all infra-unhandled", () => {
			const result = retryBudgetLeftFor("infra-unhandled");
			expect(result).toBeUndefined();
		});
	});

	describe("unknown causes", () => {
		it("returns undefined for a cause not in the catalog", () => {
			const result = retryBudgetLeftFor("this-cause-does-not-exist");
			expect(result).toBeUndefined();
		});

		it("returns undefined for empty-string cause", () => {
			const result = retryBudgetLeftFor("");
			expect(result).toBeUndefined();
		});
	});

	describe("catalogCwd parameter", () => {
		it("accepts a catalogCwd (override resolution path); behavior unchanged for shipped-only setup", () => {
			// No project override at this cwd; shipped catalog still resolves.
			const result = retryBudgetLeftFor(
				"verification-failed",
				process.cwd(),
			);
			expect(result).toBe(1);
		});
	});
});