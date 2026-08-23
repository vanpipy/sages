/**
 * test/metrics/plan-adherence.test.ts
 *
 * Reads dag-{id}.yaml + task-{id}-report.md; for each task, checks whether
 * the task report mentions each `acceptance.covers[]` entry (case-insensitive
 * substring). Returns average coverage across tasks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanAdherence } from "../../src/metrics/plan-adherence.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-plan-adh-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeDag(yaml: string): void {
	writeFileSync(join(tmp, "dag-T1.yaml"), yaml);
}
function writeTaskReport(taskId: string, content: string): void {
	writeFileSync(join(tmp, `task-${taskId}-report.md`), content);
}

const sampleDag = `
id: DAG-T1
goal_id: GC-T1
title: test
tasks:
  - id: T1
    description: first
    depends_on: []
    files: []
    subagent_type: developer
    batch: 1
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
    depends_on: [T1]
    files: []
    subagent_type: developer
    batch: 2
    tdd: strict
    prompt: ""
    output_schema: {kind: code_changes}
    acceptance:
      covers:
        - SC3
      self_check_cmd: ""
      auditor_check_cmd: ""
`;

describe("PlanAdherence", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new PlanAdherence();
		const r = await m.compute(undefined, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("no covers anywhere → data_missing (nothing to evaluate)", async () => {
		const dagNoCovers = sampleDag
			.replace(/- SC1\n        - SC2/, "")
			.replace(/- SC3\n/, "")
			.replace(/covers:\n(\s+- .*\n)*\s+self_check_cmd:/, "covers: []\n      self_check_cmd:");
		writeDag(dagNoCovers);
		const m = new PlanAdherence();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});

	test("all covers mentioned in reports → score 1.0", async () => {
		writeDag(sampleDag);
		writeTaskReport("T1", "# T1 done\nSC1 ✓\nSC2 ✓");
		writeTaskReport("T2", "# T2 done\nSC3 verified");
		const m = new PlanAdherence();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(1.0);
		expect(r.evidence).toHaveLength(0);
	});

	test("partial coverage → proportional score", async () => {
		writeDag(sampleDag);
		// T1 has covers [SC1, SC2]; T2 has covers [SC3].
		// T1 report mentions only SC1 → 0.5 ratio for T1.
		// T2 report mentions nothing → 0 ratio for T2.
		// Average = (0.5 + 0) / 2 = 0.25.
		writeTaskReport("T1", "I covered SC1");
		writeTaskReport("T2", "no SC refs here");
		const m = new PlanAdherence();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.value).toBeCloseTo(0.25, 5);
	});

	test("missing references surface in evidence", async () => {
		writeDag(sampleDag);
		// Both tasks miss all covers.
		writeTaskReport("T1", "T1 done");
		writeTaskReport("T2", "T2 done");
		const m = new PlanAdherence();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.value).toBe(0);
		expect(r.evidence.length).toBeGreaterThan(0);
		expect(r.evidence.some((e) => /SC\d+/.test(e.note) && /missing/.test(e.note))).toBe(true);
	});
});
