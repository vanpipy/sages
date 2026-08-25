/**
 * retry-helper.test.ts — GC-2026-070 mechanism: orchestrator-side re-dispatch helper.
 *
 * Verifies the four shapes the helper returns:
 *   - retry-subagent → renders feedbackTemplate + reports decremented budget
 *   - escalate-to-l3 → surfaces the handler note + budget = 0
 *   - mark-stalled   → surfaces the stall note
 *   - noop           → unknown cause or closed-loop guard
 *
 * Pure function tests — no fs, no pi session. Uses the shipped
 * `pi-subagents/src/data/failure-modes.v1.yaml` via `getFailureCatalog()`.
 */

import { describe, expect, it } from "bun:test";

import {
	buildReDispatchSuggestion,
	type PriorDiagnosticLike,
} from "../src/retry-helper.js";

describe("buildReDispatchSuggestion", () => {
	describe("retry-subagent shape", () => {
		it("renders feedbackTemplate with prior stderr digest for verification-failed", () => {
			const prior: PriorDiagnosticLike = {
				cause: "verification-failed",
				outcome: "needs-work",
				detail: "TypeError: undefined is not a function",
				evidence: { stderrDigest: "FAIL: TypeError at line 42" },
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("retry-subagent");
			if (result.kind !== "retry-subagent") throw new Error("kind mismatch");
			expect(result.cause).toBe("verification-failed");
			expect(result.causeName).toBe("Verify step returned non-zero");
			// feedbackTemplate references {stderr_digest}; it must be substituted.
			expect(result.promptPrefix).toContain("Verification failed");
			expect(result.promptPrefix).toContain("FAIL: TypeError at line 42");
			// verification-failed ships with retryBudget: 2; first retry leaves 1.
			expect(result.retryBudgetLeft).toBe(1);
			expect(result.suggestedIsolation).toBe("reuse");
		});

		it("uses diagnostic.detail as fallback when stderrDigest absent", () => {
			const prior: PriorDiagnosticLike = {
				cause: "verification-failed",
				outcome: "needs-work",
				detail: "fallback digest text",
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("retry-subagent");
			if (result.kind !== "retry-subagent") throw new Error("kind mismatch");
			expect(result.promptPrefix).toContain("fallback digest text");
		});

		it("decrements retryBudgetLeft when prior already reports remaining budget", () => {
			const prior: PriorDiagnosticLike = {
				cause: "verification-failed",
				outcome: "needs-work",
				detail: "second failure",
				evidence: { stderrDigest: "still red" },
				retryBudgetLeft: 1,
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("retry-subagent");
			if (result.kind !== "retry-subagent") throw new Error("kind mismatch");
			expect(result.retryBudgetLeft).toBe(0);
		});

		it("returns noop when prior already shows budget exhausted (closed-loop guard)", () => {
			const prior: PriorDiagnosticLike = {
				cause: "verification-failed",
				outcome: "needs-work",
				detail: "still red",
				retryBudgetLeft: 0,
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("noop");
			if (result.kind !== "noop") throw new Error("kind mismatch");
			expect(result.reason).toBe("handler-not-actionable");
			expect(result.cause).toBe("verification-failed");
		});
	});

	describe("escalate-to-l3 shape", () => {
		it("surfaces the catalog note for author-fabricated", () => {
			const prior: PriorDiagnosticLike = {
				cause: "author-fabricated",
				outcome: "error",
				detail: "git commit --author=... detected",
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("escalate-to-l3");
			if (result.kind !== "escalate-to-l3") throw new Error("kind mismatch");
			expect(result.escalationNote).toContain("git config user");
			expect(result.retryBudgetLeft).toBe(0);
		});

		it("surfaces the catalog note for pi-orchestrator-leak", () => {
			const prior: PriorDiagnosticLike = {
				cause: "pi-orchestrator-leak",
				outcome: "error",
				detail: "sub-agent wrote .pi/orchestrator/foo.yaml",
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("escalate-to-l3");
			if (result.kind !== "escalate-to-l3") throw new Error("kind mismatch");
			expect(result.escalationNote).toContain("sub-agents must not write");
		});
	});

	describe("mark-stalled shape", () => {
		it("surfaces the catalog note for subagent-timeout", () => {
			const prior: PriorDiagnosticLike = {
				cause: "subagent-timeout",
				outcome: "aborted",
				detail: "exceeded max_turns",
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("mark-stalled");
			if (result.kind !== "mark-stalled") throw new Error("kind mismatch");
			expect(result.stallNote).toContain("Re-dispatch with a narrower brief");
		});

		it("surfaces the catalog note for worktree-concurrency-cap-reached", () => {
			const prior: PriorDiagnosticLike = {
				cause: "worktree-concurrency-cap-reached",
				outcome: "stalled",
				detail: "concurrency cap hit",
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("mark-stalled");
			if (result.kind !== "mark-stalled") throw new Error("kind mismatch");
			expect(result.stallNote).toContain("bypass=true");
		});
	});

	describe("noop shape", () => {
		it("returns noop for unknown cause", () => {
			const prior: PriorDiagnosticLike = {
				cause: "this-cause-does-not-exist",
				outcome: "error",
				detail: "anything",
			};
			const result = buildReDispatchSuggestion(prior);
			expect(result.kind).toBe("noop");
			if (result.kind !== "noop") throw new Error("kind mismatch");
			expect(result.reason).toBe("unknown-cause");
		});
	});

	describe("isolation contract", () => {
		it("always suggests reuse for retry-subagent (catalog never retries fresh)", () => {
			const prior: PriorDiagnosticLike = {
				cause: "verification-failed",
				outcome: "needs-work",
				detail: "red",
			};
			const result = buildReDispatchSuggestion(prior);
			if (result.kind !== "retry-subagent") throw new Error("kind mismatch");
			// The "reuse" recommendation is what makes the prior worktree's
			// partial commits visible to the retry — fresh worktree would
			// discard them.
			expect(result.suggestedIsolation).toBe("reuse");
		});
	});
});