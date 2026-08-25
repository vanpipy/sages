/**
 * orchestrator-audit-failure-mode-stats.test.ts — GC-2026-070 mechanism.
 *
 * Pins the augmented `gatherFailureModeStats`:
 *   - Each bucket carries `handlerKind` ("spec" / "error") from the shipped catalog.
 *   - Each bucket carries `minRetryBudgetLeft` (floor across the bucket).
 *   - `retryable` lists spec-classified buckets whose budget has NOT reached
 *     zero, so the orchestrator can see at a glance which failures still have
 *     re-dispatch headroom.
 *
 * Integration-style: writes real diagnostic JSON files into a temp
 * `.pi/diagnostics/` directory and verifies the readback shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gatherFailureModeStats } from "@/orchestrator-audit.js";

interface DiagnosticRecord {
	schemaVersion: "v1";
	emittedAt: string;
	dispatchId: string;
	context: { dagId?: string; taskId?: string };
	subagentType: string;
	outcome: string;
	cause: string;
	detail: string;
	evidence?: { stderrDigest?: string };
	retryBudgetLeft?: number;
}

function writeDiagnostic(cwd: string, record: DiagnosticRecord): void {
	const dir = join(cwd, ".pi", "diagnostics");
	mkdirSync(dir, { recursive: true });
	const fileName = `${record.dispatchId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
	writeFileSync(join(dir, fileName), JSON.stringify(record, null, "\t"));
}

let cwd: string;
beforeEach(() => {
 cwd = mkdtempSync(join(tmpdir(), "sages-fms-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("gatherFailureModeStats (GC-2026-070)", () => {
	it("returns empty stats for an absent diagnostics directory", () => {
		const stats = gatherFailureModeStats(cwd);
		expect(stats.total).toBe(0);
		expect(stats.byCause).toEqual([]);
		expect(stats.byOutcome).toEqual({});
		expect(stats.retryable).toEqual([]);
	});

	it("tags spec-classified causes with handlerKind='spec' from the shipped catalog", () => {
		// verification-failed is in the shipped catalog as kind: "spec",
		// handler: retry-subagent (budget 2).
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "FAIL: foo",
			retryBudgetLeft: 1,
		});

		const stats = gatherFailureModeStats(cwd, "DAG-test");
		expect(stats.total).toBe(1);
		expect(stats.byCause.length).toBe(1);
		expect(stats.byCause[0]!.id).toBe("verification-failed");
		expect(stats.byCause[0]!.count).toBe(1);
		expect(stats.byCause[0]!.handlerKind).toBe("spec");
		expect(stats.byCause[0]!.minRetryBudgetLeft).toBe(1);
	});

	it("minRetryBudgetLeft is the floor across multiple diagnostics in the same bucket", () => {
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "first failure",
			retryBudgetLeft: 2,
		});
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:01:00.000Z",
			dispatchId: "dev-002",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "second failure",
			retryBudgetLeft: 0,
		});

		const stats = gatherFailureModeStats(cwd, "DAG-test");
		expect(stats.byCause[0]!.count).toBe(2);
		expect(stats.byCause[0]!.minRetryBudgetLeft).toBe(0);
	});

	it("includes retryable buckets in the top-level retryable array when budget > 0", () => {
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "still red",
			retryBudgetLeft: 1,
		});
		const stats = gatherFailureModeStats(cwd, "DAG-test");
		expect(stats.retryable.length).toBe(1);
		expect(stats.retryable[0]!.id).toBe("verification-failed");
		expect(stats.retryable[0]!.count).toBe(1);
		expect(stats.retryable[0]!.minRetryBudgetLeft).toBe(1);
	});

	it("excludes exhausted (budget=0) spec buckets from retryable", () => {
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "still red",
			retryBudgetLeft: 0,
		});
		const stats = gatherFailureModeStats(cwd, "DAG-test");
		// Cause is spec-classified and bucket exists, but the budget hit zero.
		// The orchestrator should escalate (buildReDispatchSuggestion returns
		// noop), not blindly retry.
		expect(stats.byCause[0]!.handlerKind).toBe("spec");
		expect(stats.retryable.length).toBe(0);
	});

	it("tags error-classified causes with handlerKind='error' from the shipped catalog", () => {
		// subagent-timeout is in the shipped catalog as kind: "error" (NOT spec).
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "aborted",
			cause: "subagent-timeout",
			detail: "exceeded max_turns",
		});
		const stats = gatherFailureModeStats(cwd, "DAG-test");
		expect(stats.byCause[0]!.handlerKind).toBe("error");
		expect(stats.retryable.length).toBe(0);
	});

	it("leaves handlerKind undefined when the cause is not in the shipped catalog", () => {
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "error",
			cause: "an-unknown-cause-not-in-the-catalog",
			detail: "anything",
		});
		const stats = gatherFailureModeStats(cwd, "DAG-test");
		expect(stats.byCause[0]!.handlerKind).toBeUndefined();
		expect(stats.retryable.length).toBe(0);
	});

	it("leaves minRetryBudgetLeft undefined when no diagnostic in the bucket carries it", () => {
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-test", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "no budget field on this one",
		});
		const stats = gatherFailureModeStats(cwd, "DAG-test");
		expect(stats.byCause[0]!.handlerKind).toBe("spec");
		expect(stats.byCause[0]!.minRetryBudgetLeft).toBeUndefined();
	});

	it("scopes the rollup to the given dagId when provided", () => {
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-001",
			context: { dagId: "DAG-included", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "yes",
		});
		writeDiagnostic(cwd, {
			schemaVersion: "v1",
			emittedAt: "2026-08-25T22:00:00.000Z",
			dispatchId: "dev-002",
			context: { dagId: "DAG-excluded", taskId: "P1" },
			subagentType: "developer",
			outcome: "needs-work",
			cause: "verification-failed",
			detail: "no",
		});
		const scoped = gatherFailureModeStats(cwd, "DAG-included");
		expect(scoped.total).toBe(1);
		const unscoped = gatherFailureModeStats(cwd);
		expect(unscoped.total).toBe(2);
	});
});