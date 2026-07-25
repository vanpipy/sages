/**
 * pi-evaluator/test/lib/artifact-reader.test.ts
 *
 * Tests for src/lib/artifact-reader.ts (P1.b).
 *
 * Strategy: every reader is exercised against fixtures/workflow-good/ (positive
 * path) and against a non-existent path (negative path → ArtifactReadError).
 * At least 6 test cases covering: readGoal success, readGoal missing file,
 * readDag structure, readTaskReports count + RED→GREEN marker, readAuditReports
 * verdict + workflowReady, readGoal with malformed YAML.
 */

import { describe, expect, test } from "bun:test";
import {
	readGoal,
	readDag,
	readTaskReports,
	readAuditReports,
	parseYaml,
	ArtifactReadError,
} from "../../src/lib/artifact-reader.ts";
import type {
	GoalArtifact,
	DagArtifact,
	TaskReportArtifact,
	AuditReportArtifact,
} from "../../src/types.ts";

const WORKFLOW_GOOD = `${import.meta.dir}/../../fixtures/workflow-good/.pi/orchestrator`;

describe("artifact-reader", () => {
	test("readGoal parses workflow-good/goal-GC-good.yaml with 3 SCs", async () => {
		const goal: GoalArtifact = await readGoal(WORKFLOW_GOOD);
		expect(goal.id).toBe("GC-good");
		expect(goal.title).toContain("Workflow good fixture");
		expect(goal.success_criteria).toHaveLength(3);
		expect(goal.success_criteria[0]?.id).toBe("SC1");
		expect(goal.success_criteria[0]?.verification_cmd).toContain("SC1");
		expect(goal.success_criteria[1]?.id).toBe("SC2");
		expect(goal.success_criteria[2]?.id).toBe("SC3");
	});

	test("readGoal returns anti_goals and scope populated", async () => {
		const goal = await readGoal(WORKFLOW_GOOD);
		expect(goal.anti_goals.length).toBeGreaterThan(0);
		expect(goal.scope.include.length).toBeGreaterThan(0);
		expect(goal.scope.exclude.length).toBeGreaterThan(0);
		expect(goal.constraints.max_dependency_additions).toBe(0);
		expect(goal.done_definition).toBeDefined();
		expect((goal.done_definition ?? "").length).toBeGreaterThanOrEqual(10);
	});

	test("readGoal throws ArtifactReadError when no goal-*.yaml is present", async () => {
		// /tmp dir is guaranteed not to contain a .pi/orchestrator/goal-*.yaml
		const missingPath = "/tmp/no-such-workflow-dir";
		await expect(readGoal(missingPath)).rejects.toBeInstanceOf(ArtifactReadError);
	});

	test("readDag parses workflow-good/dag-DAG-good.yaml with 4 tasks", async () => {
		const dag: DagArtifact = await readDag(WORKFLOW_GOOD);
		expect(dag.id).toBe("DAG-good");
		expect(dag.goal_id).toBe("GC-good");
		expect(dag.tasks).toHaveLength(4);
		const taskIds = dag.tasks.map((t) => t.id);
		expect(taskIds).toContain("P1.impl");
		expect(taskIds).toContain("P1.audit");
	});

	test("readDag flags correct isolation + run_in_background on implement task", async () => {
		// Phase A P3 (DAG-2026-011): canonical developer isolation is the
		// explicit managed-worktree object, NOT the legacy `worktree` literal.
		const dag = await readDag(WORKFLOW_GOOD);
		const impl = dag.tasks.find((t) => t.id === "P1.impl");
		expect(impl?.subagent_type).toBe("developer");
		expect(impl?.isolation).toEqual({
			dag_id: "DAG-good",
			task_id: "P1.impl",
			mode: "create",
		});
		expect(impl?.run_in_background).toBe(true);
		const audit = dag.tasks.find((t) => t.id === "P1.audit");
		expect(audit?.subagent_type).toBe("software-auditor");
		expect(audit?.isolation).toBe("none");
		expect(audit?.run_in_background).toBe(true);
	});

	test("readTaskReports returns 1 task report from workflow-good", async () => {
		const reports: TaskReportArtifact[] = await readTaskReports(WORKFLOW_GOOD);
		expect(reports).toHaveLength(1);
		expect(reports[0]?.task_id).toBe("P1.a");
		expect(reports[0]?.file_path).toContain("task-P1.a-report.md");
		expect(reports[0]?.raw_markdown).toContain("RED → GREEN");
	});

	test("readAuditReports parses verdict: CERTIFIED + workflowReady: true", async () => {
		const audits: AuditReportArtifact[] = await readAuditReports(WORKFLOW_GOOD);
		expect(audits.length).toBeGreaterThanOrEqual(1);
		const p1a = audits.find((a) => a.audit_id === "P1.a");
		expect(p1a).toBeDefined();
		expect(p1a?.verdict).toBe("CERTIFIED");
		expect(p1a?.workflowReady).toBe(true);
		// Per prompt: findings.length >= 3 — but our extractor must find at least 3
		// numeric bullets under "## Findings" or sub-`###` sections.
		expect((p1a?.findings.length ?? 0)).toBeGreaterThanOrEqual(3);
	});

	test("readGoal throws ArtifactReadError on malformed YAML (sentinel)", async () => {
		// Create a temp dir with a malformed goal yaml, then assert the reader rejects it.
		const tmpRoot = await import("node:fs/promises");
		const dir = `/tmp/pi-eval-test-bad-yaml-${Date.now()}`;
		await tmpRoot.mkdir(`${dir}/.pi/orchestrator`, { recursive: true });
		await tmpRoot.writeFile(
			`${dir}/.pi/orchestrator/goal-GC-bad.yaml`,
			"id: [unclosed bracket\nthis is: : : not valid yaml",
			"utf-8",
		);
		await expect(readGoal(dir)).rejects.toBeInstanceOf(ArtifactReadError);
	});
});

describe("artifact-reader — YAML subset parser", () => {
	test("parseYaml handles mappings, sequences, booleans, numbers, null", () => {
		const out = parseYaml(`
# comment
name: sample
port: 8080
enabled: true
ratio: 1.5
nothing: ~
tags:
  - alpha
  - beta
`);
		expect(out).toEqual({
			name: "sample",
			port: 8080,
			enabled: true,
			ratio: 1.5,
			nothing: null,
			tags: ["alpha", "beta"],
		});
	});

	test("parseYaml handles block scalars (folded and literal)", () => {
		const out = parseYaml(`
folded: >-
  hello
  world
literal: |-
  line one
  line two
`);
		expect(out).toEqual({
			folded: "hello world",
			literal: "line one\nline two",
		});
	});

	test("parseYaml handles single- and double-quoted strings with escapes", () => {
		const out = parseYaml(`
single: 'it''s quoted'
double: "say \\"hi\\" please"
`);
		expect(out).toEqual({
			single: "it's quoted",
			double: 'say "hi" please',
		});
	});

	test("parseYaml handles sequence of mappings with continuation lines", () => {
		const out = parseYaml(`
items:
  - id: a
    name: alpha
    tags:
      - x
      - y
  - id: b
    name: beta
`);
		const items = (out as { items: Array<Record<string, unknown>> }).items;
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({ id: "a", name: "alpha", tags: ["x", "y"] });
		expect(items[1]).toEqual({ id: "b", name: "beta" });
	});

	test("parseYaml handles interleaved comments and blank lines", () => {
		const out = parseYaml(`
a: 1
# mid comment
b: 2

c: 3
`);
		expect(out).toEqual({ a: 1, b: 2, c: 3 });
	});

	test("parseYaml returns null for empty / comment-only input", () => {
		expect(parseYaml("")).toBeNull();
		expect(parseYaml("# only a comment\n")).toBeNull();
	});
});