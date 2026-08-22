/**
 * test/metrics/goal-accuracy.test.ts
 *
 * Tests for the hybrid Goal Accuracy metric. Heuristic branch reads
 * audit-DAG-{id}.md and scores on workflowReady + CERTIFIED verdict.
 * LLM branch is opt-in via with.from === 'llm' and uses the seam.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalAccuracy } from "../../src/metrics/goal-accuracy.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-goal-acc-"));
	setJudgeFn(null); // reset to default no-op
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	setJudgeFn(null);
});

const passingAudit = `# Audit for DAG-T1

## Final Verdict

**CERTIFIED**

workflowReady: true

## Findings

- SC1 PASS
- SC2 PASS
`;

const failingAudit = `# Audit for DAG-T1

## Final Verdict

**NEEDS_WORK**

workflowReady: false

## Findings

- SC1 FAIL
`;

describe("GoalAccuracy heuristic branch", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new GoalAccuracy();
		const r = await m.compute({}, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("single passing audit → score 1.0", async () => {
		writeFileSync(join(tmp, "audit-T1.md"), passingAudit);
		const m = new GoalAccuracy();
		const r = await m.compute({}, { ...ctx, workflowPath: tmp });
		expect(r.value).toBe(1.0);
		expect(r.evidence).toHaveLength(0);
	});

	test("single failing audit → score 0 + evidence", async () => {
		writeFileSync(join(tmp, "audit-T1.md"), failingAudit);
		const m = new GoalAccuracy();
		const r = await m.compute({}, { ...ctx, workflowPath: tmp });
		expect(r.value).toBe(0);
		expect(r.evidence.length).toBeGreaterThan(0);
		expect(r.evidence[0]?.note).toContain("did not pass");
	});

	test("no audits → data_missing", async () => {
		const m = new GoalAccuracy();
		const r = await m.compute({}, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});
});

describe("GoalAccuracy LLM branch (with.from === 'llm')", () => {
	test("uses default no-op judge → returns data_missing true (so metric falls back to heuristic value 0)", async () => {
		writeFileSync(join(tmp, "audit-T1.md"), passingAudit);
		const m = new GoalAccuracy();
		const r = await m.compute({ from: "llm", criteria: "is the goal achieved?" }, { ...ctx, workflowPath: tmp });
		// Default no-op judge returns score 0 — which is treated as data_missing by the seam.
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});

	test("installed judge returns a score → metric returns that score", async () => {
		writeFileSync(join(tmp, "audit-T1.md"), passingAudit);
		setJudgeFn(async (_input) => ({
			score: 0.85,
			rationale: "audit shows workflowReady + CERTIFIED with all SCs passed",
		}));
		const m = new GoalAccuracy();
		const r = await m.compute({ from: "llm", criteria: "is the goal achieved?" }, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(0.85);
		expect(r.evidence[0]?.note).toContain("workflowReady");
	});

	test("judge throws → data_missing true (graceful fallback)", async () => {
		writeFileSync(join(tmp, "audit-T1.md"), passingAudit);
		setJudgeFn(async () => {
			throw new Error("rate limited");
		});
		const m = new GoalAccuracy();
		const r = await m.compute({ from: "llm" }, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
		expect(r.evidence[0]?.note).toContain("rate limited");
	});
});
