/**
 * test/metrics/plan-quality.test.ts
 *
 * Pure-LLM metric. Tests cover:
 *   - no workflowPath → data_missing
 *   - empty DAG → data_missing
 *   - non-empty DAG → judge() called with criteria + dag summary
 *     (verified via setJudgeFn mock)
 *   - judge returning score → metric returns that score
 *   - judge returning data_missing → metric propagates
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanQuality } from "../../src/metrics/plan-quality.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-plan-q-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	setJudgeFn(null);
});

function writeDag(yaml: string): void {
	writeFileSync(join(tmp, "dag-T1.yaml"), yaml);
}

const sampleDag = `
id: DAG-T1
goal_id: GC-T1
title: test
tasks:
  - id: T1
    description: first
    plane: Foundation
    batch: 1
    depends_on: []
    files: []
    subagent_type: developer
    tdd: strict
    prompt: ""
    output_schema: {kind: code_changes}
    acceptance:
      covers:
        - SC1
        - SC2
      self_check_cmd: ""
      auditor_check_cmd: ""
  - id: T2
    description: second
    plane: Observation
    batch: 2
    depends_on:
      - T1
    files: []
    subagent_type: developer
    tdd: strict
    prompt: ""
    output_schema: {kind: code_changes}
    acceptance:
      covers:
        - SC3
      self_check_cmd: ""
      auditor_check_cmd: ""
`;

describe("PlanQuality", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new PlanQuality();
		const r = await m.compute(undefined, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("missing dag file → data_missing", async () => {
		const m = new PlanQuality();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});

	test("non-empty DAG → calls judge() with summary", async () => {
		writeDag(sampleDag);
		let captured: { criteria: string; evidence: string } | undefined;
		setJudgeFn(async (input) => {
			captured = { criteria: input.criteria, evidence: input.evidence };
			return { score: 0.85, rationale: "good plan" };
		});
		const m = new PlanQuality();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(0.85);
		expect(captured).toBeDefined();
		expect(captured?.criteria).toContain("DAG");
		expect(captured?.evidence).toContain("2 tasks");
		expect(captured?.evidence).toContain("Plane");
	});

	test("judge returns score 0 → metric returns 0", async () => {
		writeDag(sampleDag);
		setJudgeFn(async () => ({ score: 0, rationale: "bad plan" }));
		const m = new PlanQuality();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.value).toBe(0);
		expect(r.evidence[0]?.note).toContain("bad plan");
	});

	test("judge data_missing → metric propagates data_missing", async () => {
		writeDag(sampleDag);
		// No judge set → judge() returns data_missing
		const m = new PlanQuality();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});
});
