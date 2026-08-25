/**
 * task-dispatcher-retry-budget.test.ts — GC-2026-070 mechanism: retry budget enforcement.
 *
 * Pins that the dispatcher surfaces a `retry_budget_exhausted` warning when a
 * task's `retry_count` reaches its `max_retries` cap. The warning goes in
 * `validation.warnings` (NOT `errors` — the transition itself is valid) and
 * a `retry_budget_exhausted` field on the response carries the count + cap.
 *
 * Reachability note: the dispatcher's current state machine forbids
 * `failed -> in_progress` transitions (only `force:true` can reset a task,
 * and `force` zeros `retry_count`). Within a single force-cycle, a task
 * therefore experiences AT MOST ONE failed transition. The warning
 * therefore fires only when:
 *   - `max_retries === 0` (strict policy — any failure is over-budget), OR
 *   - `max_retries === 1` (the single allowed failure is over-budget).
 * These are the cases the tests cover. When the state machine is later
 * relaxed to allow within-cycle retries, the warning will automatically
 * fire at the right place without further code changes — the comparison
 * `task.retry_count >= task.max_retries` is threshold-based.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

import { executeTaskDispatch } from "@/task-dispatcher.js";
import type { OrchestrationPlan, TaskNode } from "@/types.js";

function taskWithRetryBudget(maxRetries: number): TaskNode {
	return {
		id: "P1",
		description: "task P1",
		plane: "Business",
		priority: "high",
		depends_on: [],
		files: [],
		subagent_type: "developer",
		batch: 1,
		isolation: "current-workspace",
		tdd: "strict",
		prompt: "implement P1 with tests",
		output_schema: { kind: "code_changes" },
		acceptance: { covers: ["SC1"] },
		status: "pending",
		retry_count: 0,
		max_retries: maxRetries,
	};
}

function planWith(task: TaskNode): OrchestrationPlan {
	return {
		id: "DAG-test",
		goal_id: "GC-test",
		title: "test",
		tasks: [task],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		state: "approved",
		prompts: {},
	};
}

let cwd: string;
beforeEach(() => {
 cwd = mkdtempSync(join(tmpdir(), "sages-retry-budget-"));
	mkdirSync(join(cwd, ".pi/orchestrator"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const parse = (r: any) => JSON.parse(r.content[0].text);

/** Drive a task from pending to failed, returning the failed transition's response. */
async function driveToFailed(task: TaskNode): Promise<any> {
	const plan = planWith(task);
	writeFileSync(join(cwd, ".pi/orchestrator/dag-DAG-test.yaml"), yaml.dump(plan), "utf8");
	await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd });
	await executeTaskDispatch(
		{ dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "in_progress", agent_id: "agent-1" } },
		{ cwd },
	);
	return parse(await executeTaskDispatch(
		{ dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "failed", error: "test failed" } },
		{ cwd },
	));
}

describe("task_dispatch retry budget enforcement (GC-2026-070)", () => {
	it("emits no warning when max_retries=2 (default — within single-cycle budget)", async () => {
		const failed = await driveToFailed(taskWithRetryBudget(2));
		// retry_count=1, max_retries=2. 1 < 2 → not over budget.
		expect(failed.validation.warnings ?? []).toEqual([]);
		expect(failed.retry_budget_exhausted).toBeUndefined();
	});

	it("emits warning when max_retries=1 (single allowed failure — first failure exhausts it)", async () => {
		const failed = await driveToFailed(taskWithRetryBudget(1));
		expect(failed.validation.warnings).toBeDefined();
		expect(failed.validation.warnings.length).toBe(1);
		expect(failed.validation.warnings[0]).toContain("retry budget exhausted");
		expect(failed.validation.warnings[0]).toContain("1/1 attempts");
		expect(failed.retry_budget_exhausted).toEqual({ retryCount: 1, maxRetries: 1 });
	});

	it("emits warning when max_retries=0 (zero-tolerance policy)", async () => {
		const failed = await driveToFailed(taskWithRetryBudget(0));
		expect(failed.validation.warnings.length).toBe(1);
		expect(failed.validation.warnings[0]).toContain("retry budget exhausted");
		expect(failed.validation.warnings[0]).toContain("1/0 attempts");
		expect(failed.retry_budget_exhausted).toEqual({ retryCount: 1, maxRetries: 0 });
	});

	it("does not BLOCK the transition — the failure record still lands", async () => {
		const failed = await driveToFailed(taskWithRetryBudget(0));
		expect(failed.status).toBe("failed"); // transition accepted
		expect(failed.validation.errors).toEqual([]);
		expect(failed.task.status).toBe("failed");
		expect(failed.task.retry_count).toBe(1);
	});

	it("warning includes escalation hint (re-dispatching won't recover)", async () => {
		const failed = await driveToFailed(taskWithRetryBudget(1));
		expect(failed.validation.warnings[0]).toContain("amending the goal");
		expect(failed.validation.warnings[0]).toContain("splitting the task");
		expect(failed.validation.warnings[0]).toContain("escalating");
	});

	it("retry_budget_exhausted field carries retryCount + maxRetries for downstream automation", async () => {
		const failed = await driveToFailed(taskWithRetryBudget(1));
		expect(failed.retry_budget_exhausted).toBeDefined();
		expect(typeof failed.retry_budget_exhausted.retryCount).toBe("number");
		expect(typeof failed.retry_budget_exhausted.maxRetries).toBe("number");
	});
});