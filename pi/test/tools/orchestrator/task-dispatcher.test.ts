/**
 * Tests for task-dispatcher's buildDispatchPlan.
 *
 * Pins the per-stage `run_in_background` policy documented in
 * `pi/templates/SUBAGENTS.md`:
 *   - Explore, Plan       → foreground
 *   - developer           → background
 *   - auditor             → background
 *   - general-purpose     → foreground (ad-hoc / planning)
 *
 * GC-2026-014: the `software-auditor` legacy alias was removed. The
 * dispatcher now keys off the canonical name `auditor` only.
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

	it("developer tasks default to background (canonical)", () => {
		const plan = makePlan([makeTask("P1", "developer", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(true);
	});

	it("auditor tasks default to background (canonical)", () => {
		const plan = makePlan([makeTask("P1", "auditor", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(true);
	});

	it("unknown / legacy `software-auditor` spelling falls through to the default-background branch", () => {
		// GC-2026-014: the alias was removed, so this spelling isn't in the
		// switch — it falls through to the default branch (background).
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
			makeTask("P1", "developer", 1, { run_in_background: false }),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].run_in_background).toBe(false);
	});

	it("mixed batch respects per-task rules", () => {
		const plan = makePlan([
			makeTask("P1", "Explore", 1),
			makeTask("P2", "developer", 1),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		const flags = d.batches[0].tasks.map((t) => [t.task_id, t.run_in_background]).sort();
		expect(flags).toEqual([["P1", false], ["P2", true]]);
	});
});

describe("buildDispatchPlan — isolation resolution (GC-2026-017)", () => {
	// GC-2026-017: main-agent dispatches `developer` in three explicit modes:
	//   - worktree (default, mode: "create")
	//   - worktree reuse (mode: "reuse")
	//   - current-workspace (NEW — agent runs in parent's cwd, no worktree)
	//
	// The dispatcher MUST honor the task's declared isolation. Missing
	// isolation falls back to the worktree create default. The
	// "current-workspace" string MUST pass through verbatim — never coerced
	// to the worktree object — so the Agent tool can apply the right policy.

	it("developer task with isolation: undefined falls back to { dag_id: plan.id, task_id: task.id, mode: 'create' }", () => {
		// Reproduces the pre-GC-2026-017 default: missing isolation yields
		// the explicit worktree-create object so the Agent tool provisions
		// a managed worktree.
		const plan = makePlan([makeTask("P1", "developer", 1)]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].isolation).toEqual({
			dag_id: "DAG-test",
			task_id: "P1",
			mode: "create",
		});
	});

	it("developer task with isolation: { ... mode: 'reuse' } passes the object through unchanged", () => {
		// Regression guard for the reuse pass-through — the dispatcher
		// MUST NOT silently rewrite `mode: 'reuse'` to `mode: 'create'`.
		const plan = makePlan([
			makeTask("P1", "developer", 1, {
				isolation: { dag_id: "DAG-x", task_id: "P1", mode: "reuse" },
			}),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].isolation).toEqual({
			dag_id: "DAG-x",
			task_id: "P1",
			mode: "reuse",
		});
	});

	it("developer task with isolation: 'current-workspace' passes the string through unchanged (not coerced)", () => {
		// The whole point of GC-2026-017: the dispatcher MUST pass the
		// "current-workspace" literal to the Agent tool so the Agent tool
		// runs the subagent in the parent's cwd. Coercing to the worktree
		// object would silently defeat the new mode.
		const plan = makePlan([
			makeTask("P1", "developer", 1, { isolation: "current-workspace" }),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].isolation).toBe("current-workspace");
	});

	it("non-developer task with isolation: 'current-workspace' yields undefined (caller's policy only applies to developer)", () => {
		// The dispatcher's developer-special-case only fires for
		// `subagent_type === "developer"`. Explore / Plan / auditor tasks
		// ignore their isolation field — the Agent tool sees undefined.
		const plan = makePlan([
			makeTask("P1", "Explore", 1, { isolation: "current-workspace" }),
		]);
		const d = buildDispatchPlan(plan, "auto", 4);
		expect(d.batches[0].tasks[0].isolation).toBeUndefined();
	});
});

describe("buildDispatchPlan — batch metadata", () => {
	it("audit_after is true on every batch under auto strategy", () => {
		const plan = makePlan([
			makeTask("P1", "Explore", 1),
			makeTask("P2", "developer", 2, { depends_on: ["P1"] }),
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
