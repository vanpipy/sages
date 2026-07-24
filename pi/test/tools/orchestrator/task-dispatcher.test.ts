/**
 * Tests for task-dispatcher's buildDispatchPlan.
 *
 * Round-3 audit (2026-XX) found that `run_in_background` was hard-coded
 * to `true` for every task in `buildDispatchPlan`, ignoring the
 * per-stage rule documented in `pi/templates/SUBAGENTS.md`:
 *   - Explore, Plan       → foreground
 *   - software-developer  → background
 *   - software-auditor    → background
 *   - general-purpose     → foreground (ad-hoc / planning)
 *
 * Per-task override via `TaskNode.run_in_background` is also supported.
 */

import { describe, it, expect } from "bun:test";
import { buildDispatchPlan } from "@/tools/orchestrator/task-dispatcher.js";
import type { OrchestrationPlan, TaskNode } from "@/tools/orchestrator/types.js";

function makeTask(id: string, subagent_type: string, batch = 1, opts: any = {}): TaskNode {
	return {
		id,
		description: `task ${id}`,
		plane: "Business",
		priority: "medium",
		depends_on: [],
		files: [],
		subagent_type,
		batch,
		isolation: "none",
		tdd: "none",
		prompt: `prompt ${id}`,
		acceptance: { covers: [] },
		output_schema: { kind: "code_changes" },
		status: "pending",
		retry_count: 0,
		max_retries: 2,
		...opts,
	} as TaskNode;
}

function makePlan(tasks: TaskNode[]): OrchestrationPlan {
	return {
		id: "DAG-test",
		goal_id: "GC-test",
		title: "test",
		tasks,
		created_at: "2025-01-01T00:00:00Z",
		updated_at: "2025-01-01T00:00:00Z",
		state: "approved",
		prompts: {},
	};
}

describe("buildDispatchPlan — run_in_background policy", () => {
	it("Explore tasks default to foreground", () => {
		const plan = makePlan([makeTask("P1", "Explore", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(false);
	});

	it("Plan tasks default to foreground", () => {
		const plan = makePlan([makeTask("P1", "Plan", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(false);
	});

	it("software-developer tasks default to background", () => {
		const plan = makePlan([makeTask("P1", "software-developer", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(true);
	});

	it("software-auditor tasks default to background", () => {
		const plan = makePlan([makeTask("P1", "software-auditor", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(true);
	});

	it("general-purpose tasks default to foreground", () => {
		const plan = makePlan([makeTask("P1", "general-purpose", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(false);
	});

	it("per-task run_in_background override beats default", () => {
		const plan = makePlan([
			makeTask("P1", "Explore", 1, { run_in_background: true }),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(true);
	});

	it("per-task run_in_background=false override beats background default", () => {
		const plan = makePlan([
			makeTask("P1", "software-developer", 1, { run_in_background: false }),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(false);
	});

	it("mixed batch respects per-task rules", () => {
		const plan = makePlan([
			makeTask("P1", "Explore", 1),
			makeTask("P2", "software-developer", 1),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		const flags = d.batches[0].tasks.map((t) => [t.task_id, t.run_in_background]).sort();
		expect(flags).toEqual([["P1", false], ["P2", true]]);
	});
});

describe("buildDispatchPlan — batch metadata", () => {
	it("audit_after is true on every batch under auto strategy", () => {
		const plan = makePlan([
			makeTask("P1", "Explore", 1),
			makeTask("P2", "software-developer", 2, { depends_on: ["P1"] }),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches.every((b) => b.audit_after)).toBe(true);
	});

	it("parallel_safe is true when batch size <= max_concurrent", () => {
		const plan = makePlan([
			makeTask("P1", "Explore", 1),
			makeTask("P2", "Explore", 1),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].parallel_safe).toBe(true);
	});

	it("parallel_safe is false when batch size > max_concurrent", () => {
		const plan = makePlan([
			makeTask("P1", "Explore", 1),
			makeTask("P2", "Explore", 1),
			makeTask("P3", "Explore", 1),
		]);
		const d = buildDispatchPlan(plan, "auto", 2);
		expect(d.batches[0].parallel_safe).toBe(false);
	});
});
