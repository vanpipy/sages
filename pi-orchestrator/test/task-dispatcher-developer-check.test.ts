/**
 * task-dispatcher-developer-check.test.ts — GC-2026-091 T3.
 *
 * Pins the case-insensitive behavior of the developer's two
 * `subagent_type === "developer"` checks in `buildDispatchPlan`:
 *
 *   1. The `handoff_template:` line appended to the dispatched prompt.
 *   2. The default `isolation: { dag_id, task_id, mode: "create" }`
 *      object the dispatcher injects for developer tasks when the task
 *      omits isolation.
 *
 * Both must fire for `"Developer"` (PascalCase — the canonical name
 * post-GC-2026-091 T1) AND for the legacy `"developer"` (lowercase),
 * and must NOT fire for other roles (e.g. `"Auditor"`).
 *
 * Pure function tests — no fs, no pi session. Constructs an
 * `OrchestrationPlan` in memory and calls `buildDispatchPlan` directly.
 */

import { describe, expect, it } from "bun:test";

import { buildDispatchPlan, type DispatchPlan } from "../src/task-dispatcher.js";
import type { OrchestrationPlan, TaskNode } from "../src/types.js";

function makeTask(overrides: Partial<TaskNode> & Pick<TaskNode, "id" | "subagent_type">): TaskNode {
	return {
		description: overrides.id,
		plane: "structure",
		priority: "P2",
		depends_on: [],
		files: [],
		expected_tools: [],
		batch: 1,
		isolation: "none",
		tdd: "strict",
		prompt: `prompt for ${overrides.id}`,
		...overrides,
	};
}

function makePlan(tasks: TaskNode[]): OrchestrationPlan {
	return {
		id: "DAG-TEST-CASE",
		goal_id: "GC-TEST",
		title: "Case-insensitive developer check",
		tasks,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		state: "approved",
		prompts: {},
	};
}

function findDispatchTask(plan: DispatchPlan, taskId: string) {
	for (const batch of plan.batches) {
		const hit = batch.tasks.find((t) => t.task_id === taskId);
		if (hit) return hit;
	}
	throw new Error(`task ${taskId} not found in dispatch plan`);
}

describe("buildDispatchPlan — developer special-case is case-insensitive", () => {
	const plan = makePlan([
		makeTask({ id: "P1.dev-pascal", subagent_type: "Developer" }),
		makeTask({ id: "P2.dev-lower", subagent_type: "developer" }),
		makeTask({ id: "P3.auditor-pascal", subagent_type: "Auditor" }),
	]);

	const dispatch = buildDispatchPlan(plan, "auto");

	it('appends "handoff_template:" line for PascalCase "Developer"', () => {
		const dispatched = findDispatchTask(dispatch, "P1.dev-pascal");
		expect(dispatched.prompt).toContain("handoff_template:");
		expect(dispatched.prompt).toContain("handoff_template: standard");
	});

	it('appends "handoff_template:" line for legacy lowercase "developer"', () => {
		const dispatched = findDispatchTask(dispatch, "P2.dev-lower");
		expect(dispatched.prompt).toContain("handoff_template:");
		expect(dispatched.prompt).toContain("handoff_template: standard");
	});

	it('does NOT append "handoff_template:" for non-developer roles ("Auditor")', () => {
		const dispatched = findDispatchTask(dispatch, "P3.auditor-pascal");
		expect(dispatched.prompt).not.toContain("handoff_template:");
	});

	it("injects the worktree-create isolation object for PascalCase Developer", () => {
		const dispatched = findDispatchTask(dispatch, "P1.dev-pascal");
		expect(typeof dispatched.isolation).toBe("object");
		expect(dispatched.isolation).not.toBeNull();
		expect(dispatched.isolation).toEqual({
			dag_id: "DAG-TEST-CASE",
			task_id: "P1.dev-pascal",
			mode: "create",
		});
	});

	it("injects the worktree-create isolation object for lowercase developer", () => {
		const dispatched = findDispatchTask(dispatch, "P2.dev-lower");
		expect(typeof dispatched.isolation).toBe("object");
		expect(dispatched.isolation).not.toBeNull();
		expect(dispatched.isolation).toEqual({
			dag_id: "DAG-TEST-CASE",
			task_id: "P2.dev-lower",
			mode: "create",
		});
	});

	it("leaves isolation undefined for non-developer roles (Auditor)", () => {
		const dispatched = findDispatchTask(dispatch, "P3.auditor-pascal");
		expect(dispatched.isolation).toBeUndefined();
	});

	it("preserves the explicit isolation object for PascalCase Developer", () => {
		const explicitPlan = makePlan([
			makeTask({
				id: "P4.dev-explicit",
				subagent_type: "Developer",
				isolation: {
					dag_id: "DAG-TEST-CASE",
					task_id: "P4.dev-explicit",
					mode: "reuse",
					worktree_id: "wt-existing",
				},
			}),
		]);
		const dispatch = buildDispatchPlan(explicitPlan, "auto");
		const dispatched = findDispatchTask(dispatch, "P4.dev-explicit");
		expect(dispatched.isolation).toEqual({
			dag_id: "DAG-TEST-CASE",
			task_id: "P4.dev-explicit",
			mode: "reuse",
			worktree_id: "wt-existing",
		});
	});

	it("preserves 'current-workspace' literal for lowercase developer", () => {
		const cwPlan = makePlan([
			makeTask({
				id: "P5.dev-cw",
				subagent_type: "developer",
				isolation: "current-workspace",
			}),
		]);
		const dispatch = buildDispatchPlan(cwPlan, "auto");
		const dispatched = findDispatchTask(dispatch, "P5.dev-cw");
		expect(dispatched.isolation).toBe("current-workspace");
	});

	it("honors a non-default handoff_template for PascalCase Developer", () => {
		const htPlan = makePlan([
			makeTask({
				id: "P6.dev-phase-gate",
				subagent_type: "Developer",
				handoff_template: "phase-gate",
			}),
		]);
		const dispatch = buildDispatchPlan(htPlan, "auto");
		const dispatched = findDispatchTask(dispatch, "P6.dev-phase-gate");
		expect(dispatched.prompt).toContain("handoff_template: phase-gate");
	});
});