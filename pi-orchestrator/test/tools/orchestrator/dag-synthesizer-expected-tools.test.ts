/**
 * Tests for the `expected_tools` TaskNode field (GC-2026-066).
 *
 * GC-2026-066 adds an optional `expected_tools?: string[]` field to
 * TaskNodeSchema. ToolCorrectness (deferred from GC-2026-063) reads it
 * to compute precision/recall/F1 of actual tool invocations. The field
 * is additive: existing DAGs without it validate unchanged.
 *
 * Unknown tool names emit a NON-FATAL warning (not an error) so legacy
 * DAGs that reference tools removed or renamed in older releases keep
 * working.
 */

import { describe, it, expect } from "bun:test";
import { Value } from "typebox/value";
import {
	validateDAG,
	buildPlan,
	validateExpectedTools,
	TaskNodeSchema,
} from "@/dag-synthesizer.js";
import type { GoalContract } from "@/types.js";

const baseContract: GoalContract = {
	id: "GC-2025-test",
	title: "Test goal",
	rationale: "for tests",
	success_criteria: [
		{ id: "SC1", criterion: "typecheck passes", verification_cmd: "npm run typecheck" },
		{ id: "SC2", criterion: "tests pass", verification_cmd: "npm test" },
	],
	anti_goals: [],
	scope: { include: ["src/"], exclude: [] },
	constraints: {},
	done_definition: "tests pass",
	created_at: "2025-01-01T00:00:00Z",
};

function baseTask(extra: Record<string, unknown> = {}): import("@/types.js").TaskNode {
	return {
		id: "P1",
		description: "task P1",
		plane: "Business",
		priority: "medium",
		depends_on: [],
		files: [],
		subagent_type: "developer",
		batch: 1,
		isolation: "none",
		tdd: "strict",
		prompt: "a sufficiently long prompt for the task that satisfies minLength",
		output_schema: { kind: "code_changes" },
		acceptance: { covers: ["SC1", "SC2"] },
		status: "pending",
		retry_count: 0,
		max_retries: 2,
		...extra,
	};
}

describe("TaskNodeSchema — expected_tools (GC-2026-066)", () => {
	it("accepts a task with expected_tools: [read, grep]", () => {
		const node = baseTask({ expected_tools: ["read", "grep"] });
		expect(Value.Check(TaskNodeSchema, node)).toBe(true);
	});

	it("accepts a task with no expected_tools field (backward compat — additive)", () => {
		const node = baseTask();
		expect(Value.Check(TaskNodeSchema, node)).toBe(true);
	});

	it("accepts a task with empty expected_tools array (boundary)", () => {
		const node = baseTask({ expected_tools: [] });
		expect(Value.Check(TaskNodeSchema, node)).toBe(true);
	});

	it("rejects an empty-string tool name (minLength: 1)", () => {
		const node = baseTask({ expected_tools: ["read", ""] });
		expect(Value.Check(TaskNodeSchema, node)).toBe(false);
	});

	it("rejects a non-string entry", () => {
		const node = baseTask({ expected_tools: ["read", 123] });
		expect(Value.Check(TaskNodeSchema, node)).toBe(false);
	});
});

describe("validateExpectedTools — pure helper (GC-2026-066)", () => {
	it("returns an empty map when no task declares expected_tools", () => {
		const result = validateExpectedTools({
			goal_id: "GC-2025-test",
			tasks: [baseTask({ id: "P1" })],
		});
		expect(result).toEqual({});
	});

	it("returns an empty map when all expected_tools entries are known", () => {
		const result = validateExpectedTools({
			goal_id: "GC-2025-test",
			tasks: [
				baseTask({ id: "P1", expected_tools: ["read", "grep", "bash"] }),
			],
		});
		expect(result).toEqual({});
	});

	it("returns one warning entry per task with unknown tool names", () => {
		const result = validateExpectedTools({
			goal_id: "GC-2025-test",
			tasks: [
				baseTask({ id: "P1", expected_tools: ["NotARealTool"] }),
			],
		});
		expect(result["P1"]).toBeDefined();
		expect(result["P1"].some(w => w.includes("NotARealTool"))).toBe(true);
	});

	it("collapses multiple unknown names into a single warning per task", () => {
		const result = validateExpectedTools({
			goal_id: "GC-2025-test",
			tasks: [
				baseTask({ id: "P1", expected_tools: ["read", "NotARealTool", "AlsoFake"] }),
			],
		});
		expect(result["P1"]).toHaveLength(1);
		expect(result["P1"][0]).toContain("NotARealTool");
		expect(result["P1"][0]).toContain("AlsoFake");
	});

	it("treats known Sages orchestrator tools as known", () => {
		const result = validateExpectedTools({
			goal_id: "GC-2025-test",
			tasks: [
				baseTask({
					id: "P1",
					expected_tools: [
						"bash",
						"read",
						"edit",
						"write",
						"grep",
						"find",
						"ls",
						"webfetch",
						"goal_contract_create",
						"dag_synthesize",
						"task_dispatch",
						"orchestrator_audit",
					],
				}),
			],
		});
		expect(result).toEqual({});
	});

	it("only flags the bad tasks in a multi-task input", () => {
		const result = validateExpectedTools({
			goal_id: "GC-2025-test",
			tasks: [
				baseTask({ id: "P1", expected_tools: ["read"] }),
				baseTask({ id: "P2", batch: 2, depends_on: ["P1"], expected_tools: ["NotARealTool"] }),
				baseTask({ id: "P3", batch: 3, depends_on: ["P2"], expected_tools: ["grep"] }),
			],
		});
		expect(result["P1"]).toBeUndefined();
		expect(result["P2"]).toBeDefined();
		expect(result["P3"]).toBeUndefined();
	});
});

describe("validateDAG — expected_tools integration (GC-2026-066)", () => {
	it("emits no warnings for a DAG with known expected_tools", () => {
		const result = validateDAG(
			{
				goal_id: "GC-2025-test",
				tasks: [baseTask({ id: "P1", expected_tools: ["read", "grep"] })],
			},
			baseContract,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings.some(w => w.includes("expected_tools"))).toBe(false);
	});

	it("warns on a DAG with an unknown expected_tools name but does not fail", () => {
		const result = validateDAG(
			{
				goal_id: "GC-2025-test",
				tasks: [baseTask({ id: "P1", expected_tools: ["NotARealTool"] })],
			},
			baseContract,
		);
		// additive change — unknown names MUST NOT be fatal
		expect(result.valid).toBe(true);
		expect(result.warnings.some(w => w.includes("P1") && w.includes("NotARealTool"))).toBe(true);
	});

	it("produces exactly one warning per task even with multiple unknowns", () => {
		const result = validateDAG(
			{
				goal_id: "GC-2025-test",
				tasks: [
					baseTask({ id: "P1", expected_tools: ["read", "NotARealTool", "AlsoFake"] }),
				],
			},
			baseContract,
		);
		const p1Warnings = result.warnings.filter(w => w.includes("P1") && w.includes("expected_tools"));
		expect(p1Warnings).toHaveLength(1);
	});

	it("accepts a DAG without expected_tools (backward compat)", () => {
		const result = validateDAG(
			{
				goal_id: "GC-2025-test",
				tasks: [
					baseTask({ id: "P1" }),
					baseTask({ id: "P2", batch: 2, depends_on: ["P1"] }),
				],
			},
			baseContract,
		);
		expect(result.valid).toBe(true);
		expect(result.warnings.some(w => w.includes("expected_tools"))).toBe(false);
	});

	it("accepts expected_tools with empty array (boundary)", () => {
		const result = validateDAG(
			{
				goal_id: "GC-2025-test",
				tasks: [baseTask({ id: "P1", expected_tools: [] })],
			},
			baseContract,
		);
		expect(result.valid).toBe(true);
		expect(result.warnings.some(w => w.includes("expected_tools"))).toBe(false);
	});
});

describe("buildPlan — expected_tools + acceptance_warnings pass-through (GC-2026-066)", () => {
	it("preserves expected_tools from input to output", () => {
		const plan = buildPlan(
			{
				goal_id: "GC-2025-test",
				tasks: [baseTask({ id: "P1", expected_tools: ["read", "grep"] })],
			},
			baseContract,
		);
		expect((plan.tasks[0] as any).expected_tools).toEqual(["read", "grep"]);
	});

	it("preserves acceptance_warnings passed via the taskWarnings parameter", () => {
		const plan = buildPlan(
			{
				goal_id: "GC-2025-test",
				tasks: [baseTask({ id: "P1", expected_tools: ["NotARealTool"] })],
			},
			baseContract,
			{ P1: ["expected_tools contains unknown tool name(s): NotARealTool"] },
		);
		expect((plan.tasks[0] as any).acceptance_warnings).toEqual([
			"expected_tools contains unknown tool name(s): NotARealTool",
		]);
	});

	it("omits acceptance_warnings when no per-task warnings are passed", () => {
		const plan = buildPlan(
			{
				goal_id: "GC-2025-test",
				tasks: [baseTask({ id: "P1" })],
			},
			baseContract,
		);
		expect((plan.tasks[0] as any).acceptance_warnings).toBeUndefined();
	});

	it("only annotates the tasks that have warnings (no leakage to others)", () => {
		const plan = buildPlan(
			{
				goal_id: "GC-2025-test",
				tasks: [
					baseTask({ id: "P1", expected_tools: ["read"] }),
					baseTask({ id: "P2", batch: 2, depends_on: ["P1"], expected_tools: ["NotARealTool"] }),
				],
			},
			baseContract,
			{ P2: ["expected_tools contains unknown tool name(s): NotARealTool"] },
		);
		expect((plan.tasks[0] as any).acceptance_warnings).toBeUndefined();
		expect((plan.tasks[1] as any).acceptance_warnings).toBeDefined();
	});
});

describe("backward compat — shipped DAG templates validate as-is (GC-2026-066)", () => {
	// GC-2026-066 is purely additive. The two shipped DAG templates were
	// authored before the GC and have no `expected_tools` field. They MUST
	// continue to validate cleanly so older goal contracts can re-run.
	const fs = require("node:fs");
	const path = require("node:path");
	const yaml = require("js-yaml");

	function loadDag(rel: string) {
		const raw = fs.readFileSync(
			path.join(__dirname, "..", "..", "..", rel),
			"utf-8",
		);
		return yaml.load(raw) as any;
	}

	function goalContract(scIds: string[]) {
		return {
			id: "GC-shipped-test",
			title: "t",
			success_criteria: scIds.map(id => ({ id, criterion: "ok", verification_cmd: "true" })),
			anti_goals: [],
			scope: { include: [], exclude: [] },
			constraints: {},
			done_definition: "ok",
			created_at: "2025-01-01T00:00:00Z",
		};
	}

	it("dag-bug-fix.yaml still passes validateDAG (no expected_tools required)", () => {
		const dag = loadDag("skills/orchestrator/templates/dag/dag-bug-fix.yaml");
		const result = validateDAG(
			{ goal_id: "GC-shipped-test", tasks: dag.tasks },
			goalContract(["SC1", "SC2", "SC3", "SC4", "SC5"]),
		);
		if (!result.valid) {
			throw new Error("dag-bug-fix.yaml must validate as-shipped: " + JSON.stringify(result.errors));
		}
		expect(result.valid).toBe(true);
		expect(result.warnings.some(w => w.includes("expected_tools"))).toBe(false);
	});

	it("dag-tdd-refactor.yaml still passes validateDAG (no expected_tools required)", () => {
		const dag = loadDag("skills/orchestrator/templates/dag/dag-tdd-refactor.yaml");
		const result = validateDAG(
			{ goal_id: "GC-shipped-test", tasks: dag.tasks },
			goalContract(["SC1", "SC2", "SC3", "SC4", "SC5"]),
		);
		if (!result.valid) {
			throw new Error("dag-tdd-refactor.yaml must validate as-shipped: " + JSON.stringify(result.errors));
		}
		expect(result.valid).toBe(true);
		expect(result.warnings.some(w => w.includes("expected_tools"))).toBe(false);
	});

	it("shipped DAG templates have no task with expected_tools (documents the additive invariant)", () => {
		for (const rel of ["skills/orchestrator/templates/dag/dag-bug-fix.yaml", "skills/orchestrator/templates/dag/dag-tdd-refactor.yaml"]) {
			const dag = loadDag(rel);
			for (const t of dag.tasks) {
				expect(t.expected_tools).toBeUndefined();
			}
		}
	});
});
