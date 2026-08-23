/**
 * task-dispatch compat tests — GC-2026-061 compiled todo DAGs are
 * drop-in OrchestrationPlans.
 *
 * Proves the T1 compile bridge output (compileDagFromTodos →
 * dagToPlanYaml → writeCompiledDag) is consumed unchanged by the
 * existing orchestrator tooling:
 *  - loadPlan round-trips task ids / batches / descriptions and the
 *    compiled-from-todos marker;
 *  - validateDAG accepts the compiled plan against a matching goal
 *    contract fixture (structural rules: deps exist, acyclic, batches
 *    contiguous, cross-batch direction, no same-batch deps);
 *  - executeTaskDispatch builds a dispatch plan from the compiled dag;
 *  - the dag yaml and todo-state.json coexist — the runtime status
 *    view (TodoStateManager) is fully independent of DAG structure.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { loadGoalContract, loadPlan, validateDAG } from "@/tools/orchestrator/dag-synthesizer.js";
import { executeTaskDispatch } from "@/tools/orchestrator/task-dispatcher.js";
import { compileDagFromTodos, dagToPlanYaml, writeCompiledDag } from "@/tools/todo/dag-compile.js";
import {
	TodoStateManager,
	loadTodoState,
	saveTodoState,
	todoStateDir,
	type TodoItem,
} from "@/tools/todo/todo-state.js";

const GOAL_ID = "GC-2026-061";
const DAG_ID = "DAG-2026-061";

/** Minimal goal contract fixture — empty SC list makes SC coverage vacuous. */
const GOAL_FIXTURE = {
	id: GOAL_ID,
	title: "Todo-as-DAG fixture",
	success_criteria: [],
	anti_goals: [],
	scope: { include: ["pi/src/tools/todo/"], exclude: [] },
	constraints: {},
	done_definition: "All fixture tests pass",
	created_at: "2026-08-21T00:00:00.000Z",
};

/**
 * Structured todos — serial P1 → P2 → P3 chain plus one plan-level item
 * that must be excluded from the compiled DAG.
 */
const STRUCTURED_TODOS: TodoItem[] = [
	{ id: "P1", content: "Implement the todo state manager", status: "pending", kind: "task" },
	{
		id: "P2",
		content: "Implement the todo reminder",
		status: "pending",
		kind: "task",
		depends_on: ["P1"],
	},
	{
		id: "P3",
		content: "Wire the todo reminder into the extension",
		status: "pending",
		kind: "task",
		depends_on: ["P2"],
	},
	{ content: "Remind me to update the README", status: "pending" },
];

/** Temp repo with the orchestrator state dir pre-created. */
function makeTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "td-compat-"));
	mkdirSync(join(dir, ".pi", "orchestrator"), { recursive: true });
	return dir;
}

describe("task_dispatch compat — loadPlan round-trip", () => {
	it("parses a compiled dag back with identical ids / batches / descriptions", () => {
		const dir = makeTmp();
		try {
			const dag = compileDagFromTodos(STRUCTURED_TODOS, { goalId: GOAL_ID });
			const written = writeCompiledDag(dagToPlanYaml(dag), dir);

			const plan = loadPlan(dir, DAG_ID);
			expect(plan).not.toBeNull();
			expect(plan!.id).toBe(DAG_ID);
			expect(plan!.goal_id).toBe(GOAL_ID);
			expect(plan!.tasks.map((t) => t.id)).toEqual(["P1", "P2", "P3"]);
			expect(plan!.tasks.map((t) => t.batch)).toEqual([1, 2, 3]);
			expect(plan!.tasks.map((t) => t.description)).toEqual([
				"Implement the todo state manager",
				"Implement the todo reminder",
				"Wire the todo reminder into the extension",
			]);
			// The plan-level todo must not leak into the compiled DAG.
			expect(plan!.tasks.some((t) => t.description === "Remind me to update the README")).toBe(false);
			// Task fields required by the dispatcher are intact.
			for (const task of plan!.tasks) {
				expect(task.subagent_type).toBe("developer");
				expect(task.prompt.length).toBeGreaterThan(0);
				expect(Array.isArray(task.depends_on)).toBe(true);
				expect(Array.isArray(task.files)).toBe(true);
				expect(task.acceptance).toBeDefined();
			}
			expect(written).toBe(join(dir, ".pi", "orchestrator", "dag-DAG-2026-061.yaml"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("carries the compiled-from-todos marker so the extension can distinguish it from dag_synthesize output", () => {
		const dir = makeTmp();
		try {
			const dag = compileDagFromTodos(STRUCTURED_TODOS, { goalId: GOAL_ID });
			writeCompiledDag(dagToPlanYaml(dag), dir);

			const plan = loadPlan(dir, DAG_ID);
			expect(plan).not.toBeNull();
			expect((plan as unknown as { compiled_from_todos?: boolean }).compiled_from_todos).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("task_dispatch compat — validateDAG against a goal contract", () => {
	it("compiled plan passes the structural DAG rules with a matching contract", () => {
		const dir = makeTmp();
		try {
			writeFileSync(
				join(dir, ".pi", "orchestrator", `goal-${GOAL_ID}.yaml`),
				yaml.dump(GOAL_FIXTURE, { noRefs: true }),
			);
			const dag = compileDagFromTodos(STRUCTURED_TODOS, { goalId: GOAL_ID });
			writeCompiledDag(dagToPlanYaml(dag), dir);

			const contract = loadGoalContract(dir, GOAL_ID);
			expect(contract).not.toBeNull();
			const plan = loadPlan(dir, DAG_ID)!;
			const result = validateDAG({ goal_id: plan.goal_id, tasks: plan.tasks }, contract!);
			expect(result.errors).toEqual([]);
			expect(result.valid).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("task_dispatch compat — executeTaskDispatch consumes the compiled dag", () => {
	it("returns a dispatch plan with batches grouped from the compiled tasks", async () => {
		const dir = makeTmp();
		try {
			const dag = compileDagFromTodos(STRUCTURED_TODOS, { goalId: GOAL_ID });
			writeCompiledDag(dagToPlanYaml(dag), dir);

			const result = await executeTaskDispatch({ dag_id: DAG_ID, strategy: "auto" }, { cwd: dir });
			expect(result.content[0].text).toContain('"status":"in_progress"');
			const dispatch = result.details.dispatch;
			expect(dispatch.dag_id).toBe(DAG_ID);
			expect(dispatch.total_tasks).toBe(3);
			expect(dispatch.batches.map((b: { batch: number }) => b.batch)).toEqual([1, 2, 3]);
			expect(
				dispatch.batches.map((b: { tasks: Array<{ task_id: string }> }) =>
					b.tasks.map((t) => t.task_id),
				),
			).toEqual([["P1"], ["P2"], ["P3"]]);

			// The dispatch transition persisted plan state back into the dag yaml.
			const plan = loadPlan(dir, DAG_ID);
			expect(plan?.state).toBe("executing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("task_dispatch compat — dag yaml and todo-state.json coexist", () => {
	it("TodoStateManager loads the runtime status view independently of the dag file", () => {
		const dir = makeTmp();
		try {
			// DAG structure and todo runtime status are separate files.
			const dag = compileDagFromTodos(STRUCTURED_TODOS, { goalId: GOAL_ID });
			writeCompiledDag(dagToPlanYaml(dag), dir);
			saveTodoState(
				todoStateDir(dir),
				new TodoStateManager([
					{ id: "P1", content: "Implement the todo state manager", status: "in_progress", kind: "task" },
					{
						id: "P2",
						content: "Implement the todo reminder",
						status: "pending",
						kind: "task",
						depends_on: ["P1"],
					},
				]),
			);

			// Runtime view loads with its own statuses...
			const state = loadTodoState(todoStateDir(dir));
			expect(state?.getCounts()).toEqual({ pending: 1, inProgress: 1, completed: 0 });
			expect(state?.getTodos()[0].status).toBe("in_progress");
			// ...while the plan keeps its own lifecycle statuses (no coupling).
			const plan = loadPlan(dir, DAG_ID)!;
			expect(plan.tasks.every((t) => t.status === "pending")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
