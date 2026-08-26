/**
 * todowrite.test.ts — GC-2026-074.
 *
 * Covers the two new LLM-facing tools (`todowrite_compile`,
 * `todowrite_progress`) plus the auto-sync helper that runs inside
 * `task_dispatch.transitionTask`. Drift detection is the headline
 * behavior: the orchestrator must surface divergence between the DAG
 * and the todo view without silently correcting it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
	executeTodowriteCompile,
	executeTodowriteProgress,
	registerTodowriteTools,
} from "@/todowrite.js";
import { syncTodoForTask, loadTodoFile, computeTodoDrift } from "@/todo-sync.js";
import { loadPlan } from "@/dag-synthesizer.js";
import { atomicWriteOrchestratorFile } from "@/state-persistence.js";
import type { OrchestrationPlan, TaskNode } from "@/types.js";

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "todowrite-test-"));
});

afterEach(() => {
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

function makePlan(id: string, tasks: TaskNode[]): OrchestrationPlan {
	return {
		id,
		goal_id: `goal-${id}`,
		title: `Plan ${id}`,
		tasks,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		state: "draft",
		prompts: {},
	};
}

function makeTask(id: string, status: TaskNode["status"] = "pending"): TaskNode {
	return {
		id,
		description: `description for ${id}`,
		plane: "Business",
		priority: "medium",
		depends_on: [],
		files: [],
		subagent_type: "developer",
		isolation: { dag_id: "test", task_id: id, mode: "create" },
		tdd: "none",
		batch: 1,
		status,
		retry_count: 0,
		max_retries: 2,
		prompt: `stub prompt for ${id}`,
		output_schema: { kind: "file_list" },
		acceptance: {},
	};
}

function writePlan(plan: OrchestrationPlan): void {
	atomicWriteOrchestratorFile(cwd, `dag-${plan.id}.yaml`, JSON.stringify(plan, null, 2), {
		owner: "orchestrator",
		validate: (v): v is OrchestrationPlan => true,
	});
}

// ───────────────────────────────────────────────────────────────────────
// todowrite_compile
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("todowrite: todowrite_compile", () => {
	it("compiles a 3-task plan with serial/parallel markers", () => {
		const plan = makePlan("GC-2026-074-A", [
			makeTask("P1"),
			makeTask("P2"),
			makeTask("P3"),
		]);
		// Make P2/P3 parallel by clearing their mutual deps
		plan.tasks[1].depends_on = [];
		plan.tasks[2].depends_on = [];
		// And share the same batch
		plan.tasks[1].batch = 2;
		plan.tasks[2].batch = 2;
		writePlan(plan);

		const out = executeTodowriteCompile({ dag_id: "GC-2026-074-A" }, { cwd });
		expect(out.ok).toBe(true);
		expect(out.total).toBe(3);
		expect(out.items.map((i) => i.task_id)).toEqual(["P1", "P2", "P3"]);
		expect(out.items[0].content).toMatch(/^\[serial\] P1: /);
		expect(out.items[1].content).toMatch(/^\[parallel\] P2: /);
		expect(out.items[2].content).toMatch(/^\[parallel\] P3: /);
		// todo_id mirror persists to disk — verify via a fresh load
		const reloaded = loadTodoFile(cwd, "GC-2026-074-A");
		expect(reloaded?.items[0].todo_id).toBe(out.items[0].todo_id);
		expect(reloaded?.items[1].todo_id).toBe(out.items[1].todo_id);
		// Persisted file exists
		expect(existsSync(join(cwd, ".pi/orchestrator/todo-GC-2026-074-A.yaml"))).toBe(true);
	});

	it("returns force_required when the file already exists and force is unset", () => {
		const plan = makePlan("GC-2026-074-B", [makeTask("P1")]);
		writePlan(plan);
		executeTodowriteCompile({ dag_id: "GC-2026-074-B" }, { cwd });
		const second = executeTodowriteCompile({ dag_id: "GC-2026-074-B" }, { cwd });
		expect(second.ok).toBe(false);
		expect(second.force_required).toBe(true);
		// First call's items returned, not overwritten
		expect(second.total).toBe(1);
	});

	it("regenerates with force=true and preserves todo_id on existing items", () => {
		const plan = makePlan("GC-2026-074-C", [makeTask("P1")]);
		writePlan(plan);
		const first = executeTodowriteCompile({ dag_id: "GC-2026-074-C" }, { cwd });
		const firstTodoId = first.items[0].todo_id;
		const second = executeTodowriteCompile({ dag_id: "GC-2026-074-C", force: true }, { cwd });
		expect(second.ok).toBe(true);
		expect(second.items[0].todo_id).toBe(firstTodoId);
	});

	it("returns ok:false when the DAG does not exist", () => {
		const out = executeTodowriteCompile({ dag_id: "GC-2026-DOES-NOT-EXIST" }, { cwd });
		expect(out.ok).toBe(false);
		expect(out.total).toBe(0);
	});
});

// ───────────────────────────────────────────────────────────────────────
// syncTodoForTask (auto-sync helper, called by task_dispatch)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("todowrite: syncTodoForTask", () => {
	it("updates the matching todo item when DAG transitions", () => {
		const plan = makePlan("GC-2026-074-D", [makeTask("P1", "pending")]);
		writePlan(plan);
		executeTodowriteCompile({ dag_id: "GC-2026-074-D" }, { cwd });
		// Simulate transitionTask mutating the plan
		const task = plan.tasks[0];
		task.status = "completed";
		const result = syncTodoForTask(cwd, plan, task);
		expect(result.synced).toBe(true);
		expect(result.previous_status).toBe("pending");

		// Re-read the todo file to confirm persistence
		const reloaded = loadTodoFile(cwd, "GC-2026-074-D");
		expect(reloaded?.items[0].status).toBe("completed");
		expect(reloaded?.items[0].last_synced_at).not.toBeNull();
	});

	it("silent no-op when no todo file exists yet", () => {
		const plan = makePlan("GC-2026-074-E", [makeTask("P1", "pending")]);
		writePlan(plan);
		// No compile call — no todo file
		const result = syncTodoForTask(cwd, plan, plan.tasks[0]);
		expect(result.synced).toBe(false);
		expect(result.reason).toMatch(/no todo file/);
	});

	it("reports drift when task_id is missing from the todo file", () => {
		const plan = makePlan("GC-2026-074-F", [makeTask("P1", "pending"), makeTask("P2", "pending")]);
		writePlan(plan);
		executeTodowriteCompile({ dag_id: "GC-2026-074-F" }, { cwd });
		// Mutate the on-disk todo file to drop P2's item
		const todo = loadTodoFile(cwd, "GC-2026-074-F")!;
		todo.items = todo.items.filter((i) => i.task_id !== "P2");
		atomicWriteOrchestratorFile(cwd, "todo-GC-2026-074-F.yaml", yaml.dump(todo, { indent: 2 }), {
			owner: "orchestrator",
			validate: (v): v is typeof todo => true,
		});

		const result = syncTodoForTask(cwd, plan, plan.tasks[1]);
		expect(result.synced).toBe(false);
		expect(result.reason).toMatch(/drift: task exists in DAG but not in todo file/);
	});
});

// ───────────────────────────────────────────────────────────────────────
// computeTodoDrift
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("todowrite: computeTodoDrift", () => {
	it("reports all four drift kinds for a divergent state", () => {
		const plan = makePlan("GC-2026-074-G", [
			makeTask("P1", "completed"),
			makeTask("P2", "pending"),
			makeTask("P3", "in_progress"),
		]);
		writePlan(plan);
		// Build a todo that disagrees in every direction
		const todo: ReturnType<typeof loadTodoFile> = {
			schemaVersion: "v1",
			dag_id: "GC-2026-074-G",
			compiled_at: new Date().toISOString(),
			compiled_from_todos: true,
			items: [
				{ todo_id: "t1", task_id: "P1", content: "P1", status: "pending", last_synced_at: null }, // dag_ahead
				{ todo_id: "t2", task_id: "P2", content: "P2", status: "completed", last_synced_at: null }, // todo_ahead
				// P3 missing — task_orphaned
				{ todo_id: "t4", task_id: "P4", content: "P4", status: "pending", last_synced_at: null }, // todo_orphaned
			],
		};
		writeFileSync(
			join(cwd, ".pi/orchestrator/todo-GC-2026-074-G.yaml"),
			yaml.dump(todo, { indent: 2 }),
			"utf8",
		);

		const drift = computeTodoDrift(plan, todo);
		const kinds = new Set(drift.map((d) => d.drift_kind));
		expect(kinds.has("dag_ahead")).toBe(true);     // todo=pending, dag=completed
		expect(kinds.has("todo_ahead")).toBe(true);    // todo=completed, dag=pending
		expect(kinds.has("task_orphaned")).toBe(true); // P3 missing from todo
		expect(kinds.has("todo_orphaned")).toBe(true); // P4 in todo but not plan
	});

	it("returns empty drift when state matches", () => {
		const plan = makePlan("GC-2026-074-H", [makeTask("P1", "completed")]);
		writePlan(plan);
		executeTodowriteCompile({ dag_id: "GC-2026-074-H" }, { cwd });
		// Simulate sync
		plan.tasks[0].status = "completed";
		syncTodoForTask(cwd, plan, plan.tasks[0]);
		const drift = computeTodoDrift(plan, loadTodoFile(cwd, "GC-2026-074-H"));
		expect(drift).toHaveLength(0);
	});

	it("returns task_orphaned per task when no todo file exists", () => {
		const plan = makePlan("GC-2026-074-I", [makeTask("P1"), makeTask("P2")]);
		writePlan(plan);
		const drift = computeTodoDrift(plan, null);
		expect(drift).toHaveLength(2);
		expect(drift.every((d) => d.drift_kind === "task_orphaned")).toBe(true);
	});
});

// ───────────────────────────────────────────────────────────────────────
// todowrite_progress
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("todowrite: todowrite_progress", () => {
	it("returns reconciliation view with per-item synced flag", () => {
		const plan = makePlan("GC-2026-074-J", [
			makeTask("P1", "pending"),
			makeTask("P2", "pending"),
		]);
		writePlan(plan);
		executeTodowriteCompile({ dag_id: "GC-2026-074-J" }, { cwd });
		// P1 transitions to completed and we sync; P2 transitions to
		// in_progress in the DAG but we DO NOT sync — drift surfaces as
		// dag_ahead (DAG is further along than the todo view). The
		// mutations must be persisted to disk before todowrite_progress
		// reads the plan back.
		plan.tasks[0].status = "completed";
		syncTodoForTask(cwd, plan, plan.tasks[0]);
		plan.tasks[1].status = "in_progress";
		writePlan(plan);
		const out = executeTodowriteProgress({ dag_id: "GC-2026-074-J" }, { cwd });
		expect(out.ok).toBe(true);
		expect(out.items).toHaveLength(2);
		const p1 = out.items.find((i) => i.task_id === "P1")!;
		const p2 = out.items.find((i) => i.task_id === "P2")!;
		expect(p1.synced).toBe(true);
		expect(p2.synced).toBe(false);
		expect(out.drift).toHaveLength(1);
		expect(out.drift[0].drift_kind).toBe("dag_ahead");
		expect(out.summary.synced).toBe(1);
		expect(out.summary.drifted).toBe(1);
	});

	it("verbose mode echoes raw YAMLs", () => {
		const plan = makePlan("GC-2026-074-K", [makeTask("P1", "pending")]);
		writePlan(plan);
		executeTodowriteCompile({ dag_id: "GC-2026-074-K" }, { cwd });
		const out = executeTodowriteProgress({ dag_id: "GC-2026-074-K", verbose: true }, { cwd });
		expect(out.todo_yaml).toContain("GC-2026-074-K");
		expect(out.dag_yaml).toContain("GC-2026-074-K");
	});
});

// ───────────────────────────────────────────────────────────────────────
// registerTodowriteTools — smoke
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("todowrite: registerTodowriteTools", () => {
	it("registers both tools with name/label/description/parameters/execute", () => {
		const registered: { name: string }[] = [];
		const fakePi = {
			registerTool: (tool: { name: string }) => {
				registered.push({ name: tool.name });
			},
		};
		registerTodowriteTools(fakePi);
		const names = registered.map((r) => r.name).sort();
		expect(names).toEqual(["todowrite_compile", "todowrite_progress"]);
	});
});