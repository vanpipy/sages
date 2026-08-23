/**
 * test/metrics/task-completion.test.ts
 *
 * Tests for the hybrid Task Completion metric. Heuristic branch reads
 * dag-{id}.yaml + audit-{id}.md and scores per-covers-PASS evidence.
 * LLM branch is opt-in via with.from === 'llm'.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskCompletion } from "../../src/metrics/task-completion.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-task-comp-"));
	setJudgeFn(null);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	setJudgeFn(null);
});

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

const passingAudit = `# Audit

## Final Verdict

CERTIFIED

## Findings

- SC1 PASS
- SC2 PASS
- SC3 PASS
`;

const partialAudit = `# Audit

## Final Verdict

NEEDS WORK

## Findings

- SC1 PASS
- SC3 PASS
`;

describe("TaskCompletion heuristic branch", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new TaskCompletion();
		const r = await m.compute({}, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("all covers PASS in audit → score 1.0", async () => {
		writeFileSync(join(tmp, "dag-T1.yaml"), sampleDag);
		writeFileSync(join(tmp, "audit-T1.md"), passingAudit);
		const m = new TaskCompletion();
		const r = await m.compute({}, { ...ctx, workflowPath: tmp });
		expect(r.value).toBe(1.0);
	});

	test("partial PASS → proportional score", async () => {
		writeFileSync(join(tmp, "dag-T1.yaml"), sampleDag);
		writeFileSync(join(tmp, "audit-T1.md"), partialAudit);
		const m = new TaskCompletion();
		const r = await m.compute({}, { ...ctx, workflowPath: tmp });
		// T1: 2 of 2 PASS (SC1, SC2) → 1.0
		// T2: 1 of 1 PASS (SC3) → 1.0
		// Average: 1.0
		// Wait — partialAudit has SC1 PASS + SC3 PASS, no SC2 PASS.
		// T1: SC1 ✓, SC2 ✗ → 0.5; T2: SC3 ✓ → 1.0; avg = 0.75
		expect(r.value).toBeCloseTo(0.75, 5);
		expect(r.evidence.some((e) => e.location === "SC2")).toBe(true);
	});

	test("no covers in DAG → data_missing", async () => {
		const noCovers = sampleDag
			.replace(/- SC1\n        - SC2/, "")
			.replace(/- SC3\n/, "")
			.replace(/covers:\n(\s+- .*\n)*\s+self_check_cmd:/, "covers: []\n      self_check_cmd:");
		writeFileSync(join(tmp, "dag-T1.yaml"), noCovers);
		const m = new TaskCompletion();
		const r = await m.compute({}, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});
});

describe("TaskCompletion LLM branch (with.from === 'llm')", () => {
	test("default no-op judge → data_missing", async () => {
		writeFileSync(join(tmp, "dag-T1.yaml"), sampleDag);
		writeFileSync(join(tmp, "task-T1-report.md"), "T1 report");
		const m = new TaskCompletion();
		const r = await m.compute({ from: "llm" }, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});

	test("installed judge returns a score", async () => {
		writeFileSync(join(tmp, "dag-T1.yaml"), sampleDag);
		writeFileSync(join(tmp, "task-T1-report.md"), "T1 report");
		setJudgeFn(async (_input) => ({ score: 0.92, rationale: "report confirms SC1+SC2" }));
		const m = new TaskCompletion();
		const r = await m.compute({ from: "llm" }, { ...ctx, workflowPath: tmp });
		expect(r.value).toBe(0.92);
	});
});
