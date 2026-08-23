/**
 * todo-dag extension tests — GC-2026-061 todo→DAG compile trigger wiring.
 *
 * Covers the extension wiring that turns structured todos (kind 'task',
 * depends_on, batch) into a compiled DAG yaml:
 *  - todowrite mirror with task-level todos → compiles + writes
 *    <repo>/.pi/orchestrator/dag-<dagId>.yaml;
 *  - recompiling the same todos is idempotent (identical file, no rewrite);
 *  - plan-level todos only → no dag yaml is ever written or wiped;
 *  - an existing dag from dag_synthesize (no compiled marker) is
 *    authoritative and is NOT overwritten;
 *  - todowrite mirror with task-level todos triggers the same compile;
 *  - dag_id / goal_id derivation: todo items' dag_id field → session
 *    default (most recent orchestrator call) → 'DAG-todos';
 *  - direct maybeCompileDagFromTodos policy tests (overwrite rules,
 *    skip-on-unchanged).
 *
 * Uses the MockPi pattern from todo-extension.test.ts — handlers are
 * recorded by event name; todo state + compiled dag yaml live on the
 * temp repo and are observed through loadTodoState / loadPlan / the
 * file system.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import registerSagesExtension from "@/extension.js";
import { loadPlan } from "@/tools/orchestrator/dag-synthesizer.js";
import {
	compiledDagPath,
	maybeCompileDagFromTodos,
} from "@/tools/todo/dag-compile.js";
import {
	loadTodoState,
	saveTodoState,
	todoStateDir,
	type TodoItem,
} from "@/tools/todo/todo-state.js";


/** Minimal mock of the ExtensionAPI surface used by registerSagesExtension. */
class MockPi {
	handlers: Record<string, Array<(...args: any[]) => any>> = {};
	registeredTools: Array<{ name: string }> = [];
	appendedEntries: Array<{ channel: string; text: string }> = [];

	on(event: string, handler: (...args: any[]) => any): void {
		(this.handlers[event] ||= []).push(handler);
	}
	registerTool(def: { name: string }): void {
		this.registeredTools.push({ name: def.name });
	}
	appendEntry(channel: string, text: string): void {
		this.appendedEntries.push({ channel, text });
	}
	getActiveTools(): string[] {
		return [];
	}
	setActiveTools(_tools: string[]): void {}
	registerCommand(_name: string, _opts: any): void {}
	registerShortcut(_s: any, _opts: any): void {}
	registerFlag(_name: string, _opts: any): void {}
}

/**
 * Task-level todos with explicit dag_id/goal_id. P1 → P2 serial chain
 * (batches 1, 2) plus one plain plan-level item that must NOT compile.
 */
const TASK_TODOS: TodoItem[] = [
	{
		id: "P1",
		content: "Implement the todo state manager",
		status: "pending",
		kind: "task",
		dag_id: "GC-2026-061",
		goal_id: "GC-2026-061",
	},
	{
		id: "P2",
		content: "Implement the todo state manager",
		status: "pending",
		kind: "task",
		depends_on: ["P1"],
		dag_id: "GC-2026-061",
		goal_id: "GC-2026-061",
	},
	{ content: "Remind me to update the README", status: "pending" },
];

/** Task-level todos WITHOUT dag_id / goal_id (derivation fallback path). */
const TASK_TODOS_NO_DAG_ID: TodoItem[] = [
	{ id: "P1", content: "Implement the todo state manager", status: "pending", kind: "task" },
	{
		id: "P2",
		content: "Implement the todo state manager",
		status: "pending",
		kind: "task",
		depends_on: ["P1"],
	},
];

/** Plan-level todos only — must never produce a dag yaml. */
const PLAN_TODOS: TodoItem[] = [
	{ content: "Remind me to update the README", status: "pending" },
	{ content: "Follow up with the team", status: "pending" },
];

let mock: MockPi;
let tmp: string;

beforeEach(() => {
	mock = new MockPi();
	tmp = mkdtempSync(join(tmpdir(), "sages-todo-dag-ext-"));
	mkdirSync(join(tmp, ".pi", "orchestrator"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Fire every registered tool_call handler (pi fires all listeners serially). */
async function fireToolCall(event: any, ctx: any = { cwd: tmp }): Promise<void> {
	for (const handler of mock.handlers.tool_call ?? []) {
		await handler(event, ctx);
	}
}

/** dag-*.yaml files currently present in the temp orchestrator dir. */
function dagFiles(): string[] {
	const dir = join(tmp, ".pi", "orchestrator");
	return readdirSync(dir).filter((f) => f.startsWith("dag-") && f.endsWith(".yaml"));
}

// ─── todowrite mirror → compile trigger ─────────────────────────────────────

describe("todo-dag extension — todowrite mirror compiles structured todos", () => {
	it("writes a compiled dag yaml (dag_id from the todo items' dag_id field)", async () => {
		registerSagesExtension(mock as any);
		await fireToolCall({ toolName: "todowrite", input: { todos: TASK_TODOS } });

		// dag-GC-2026-061.yaml (the todos' dag_id) must exist and load as a plan.
		const path = join(tmp, ".pi", "orchestrator", "dag-GC-2026-061.yaml");
		expect(dagFiles()).toContain("dag-GC-2026-061.yaml");

		const plan = loadPlan(tmp, "GC-2026-061");
		expect(plan).not.toBeNull();
		expect(plan!.tasks.map((t) => t.id)).toEqual(["P1", "P2"]);
		expect(plan!.tasks.map((t) => t.batch)).toEqual([1, 2]);
		// plan-level todo excluded
		expect(plan!.tasks.some((t) => t.description === "Remind me to update the README")).toBe(false);
		// compiled marker present → the extension can recognize its own output
		expect((plan as unknown as { compiled_from_todos?: boolean }).compiled_from_todos).toBe(true);
	});

	it("recompiling the same todos is idempotent (identical bytes, no rewrite)", async () => {
		registerSagesExtension(mock as any);
		await fireToolCall({ toolName: "todowrite", input: { todos: TASK_TODOS } });
		const path = join(tmp, ".pi", "orchestrator", "dag-GC-2026-061.yaml");
		const firstBytes = readFileSync(path, "utf8");
		const firstMtime = statSync(path).mtimeMs;

		// Same list again (e.g. the agent flips a status): no structural change.
		await fireToolCall({ toolName: "todowrite", input: { todos: TASK_TODOS } });
		const secondBytes = readFileSync(path, "utf8");
		expect(secondBytes).toBe(firstBytes);
		// The skip-rewrite path leaves the mtime untouched.
		expect(statSync(path).mtimeMs).toBe(firstMtime);
	});

	it("plan-level todos only → no dag yaml is written (and none is wiped)", async () => {
		registerSagesExtension(mock as any);
		await fireToolCall({ toolName: "todowrite", input: { todos: PLAN_TODOS } });
		expect(dagFiles()).toEqual([]);
	});

	it("an existing dag from dag_synthesize (no compiled marker) is NOT overwritten", async () => {
		// Pre-write an authoritative plan in dag_synthesize shape (no marker).
		const authoritative = {
			id: "GC-2026-061",
			goal_id: "GC-2026-061",
			title: "Authoritative dag_synthesize plan",
			state: "approved",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			tasks: [
				{
					id: "A1",
					description: "Authoritative task from dag_synthesize",
					status: "pending",
					batch: 1,
					retry_count: 0,
					max_retries: 2,
				},
			],
			prompts: {},
		};
		writeFileSync(
			join(tmp, ".pi", "orchestrator", "dag-GC-2026-061.yaml"),
			yaml.dump(authoritative, { noRefs: true }),
		);

		registerSagesExtension(mock as any);
		await fireToolCall({ toolName: "todowrite", input: { todos: TASK_TODOS } });

		// dag_synthesize's plan is authoritative — the todo compile must not
		// overwrite it even though the todos carry the same dag_id.
		const raw = readFileSync(join(tmp, ".pi", "orchestrator", "dag-GC-2026-061.yaml"), "utf8");
		expect(raw).toContain("Authoritative dag_synthesize plan");
		expect(raw).not.toContain("compiled_from_todos");
		expect(raw).not.toContain("Implement the todo state manager");
	});
});



// ─── dag_id / goal_id derivation ────────────────────────────────────────────

describe("todo-dag extension — dag_id / goal_id derivation", () => {
	it("session default dag_id (most recent orchestrator call) is used when todos carry none", async () => {
		registerSagesExtension(mock as any);
		// dag_synthesize with goal_id GC-9999: no dag file exists → auto-plan
		// no-ops, but the session default dag_id is recorded.
		await fireToolCall({ toolName: "dag_synthesize", input: { goal_id: "GC-9999" } });

		await fireToolCall({ toolName: "todowrite", input: { todos: TASK_TODOS_NO_DAG_ID } });
		expect(dagFiles()).toContain("dag-GC-9999.yaml");
		const plan = loadPlan(tmp, "GC-9999");
		expect(plan?.goal_id).toBe("GC-9999");
		expect(plan?.tasks.map((t) => t.id)).toEqual(["P1", "P2"]);
	});

	it("falls back to 'DAG-todos' when no dag_id is available", async () => {
		registerSagesExtension(mock as any);
		await fireToolCall({ toolName: "todowrite", input: { todos: TASK_TODOS_NO_DAG_ID } });
		expect(dagFiles()).toContain("dag-DAG-todos.yaml");
	});

	it("todo items' dag_id wins over the session default", async () => {
		registerSagesExtension(mock as any);
		// Record a session default first...
		await fireToolCall({ toolName: "dag_synthesize", input: { goal_id: "GC-9999" } });
		// ...then todos that carry their own dag_id.
		await fireToolCall({ toolName: "todowrite", input: { todos: TASK_TODOS } });
		expect(dagFiles()).toContain("dag-GC-2026-061.yaml");
		expect(dagFiles()).not.toContain("dag-GC-9999.yaml");
		const plan = loadPlan(tmp, "GC-2026-061");
		expect(plan?.id).toBe("GC-2026-061");
		expect(plan?.goal_id).toBe("GC-2026-061");
	});
});

// ─── maybeCompileDagFromTodos — direct policy tests ─────────────────────────

describe("todo-dag extension — maybeCompileDagFromTodos policy", () => {
	it("returns null for plan-level todos (never writes a dag)", () => {
		const written = maybeCompileDagFromTodos(PLAN_TODOS, tmp);
		expect(written).toBeNull();
		expect(dagFiles()).toEqual([]);
	});

	it("returns null and leaves a non-compiled dag untouched", () => {
		writeFileSync(
			join(tmp, ".pi", "orchestrator", "dag-GC-2026-061.yaml"),
			yaml.dump({ id: "GC-2026-061", goal_id: "GC-2026-061", state: "approved", tasks: [] }, { noRefs: true }),
		);
		const written = maybeCompileDagFromTodos(TASK_TODOS, tmp);
		expect(written).toBeNull();
		const raw = readFileSync(join(tmp, ".pi", "orchestrator", "dag-GC-2026-061.yaml"), "utf8");
		expect(raw).not.toContain("compiled_from_todos");
	});

	it("skips the rewrite when an existing compiled dag is structurally unchanged", () => {
		const path = compiledDagPath(tmp, "GC-2026-061");
		maybeCompileDagFromTodos(TASK_TODOS, tmp);
		const firstBytes = readFileSync(path, "utf8");
		const firstMtime = statSync(path).mtimeMs;

		const again = maybeCompileDagFromTodos(TASK_TODOS, tmp);
		expect(again).toBe(path);
		expect(readFileSync(path, "utf8")).toBe(firstBytes);
		expect(statSync(path).mtimeMs).toBe(firstMtime);
	});

	it("rewrites an existing compiled dag when the structure changes", () => {
		const path = compiledDagPath(tmp, "GC-2026-061");
		maybeCompileDagFromTodos(TASK_TODOS, tmp);
		expect(readFileSync(path, "utf8")).toContain("P2");

		// Structure changes: drop P2, add a new dependent task P3.
		const changed: TodoItem[] = [
			{ id: "P1", content: "Implement the todo state manager", status: "pending", kind: "task", dag_id: "GC-2026-061", goal_id: "GC-2026-061" },
			{ id: "P3", content: "Wire the todo reminder into the extension", status: "pending", kind: "task", depends_on: ["P1"], dag_id: "GC-2026-061", goal_id: "GC-2026-061" },
		];
		const written = maybeCompileDagFromTodos(changed, tmp);
		expect(written).toBe(path);
		const raw = readFileSync(path, "utf8");
		expect(raw).toContain("P3");
		expect(raw).not.toContain("P2");
	});

	it("persisted structured todos survive a store round-trip (validateTodoItem keeps them)", () => {
		saveTodoState(todoStateDir(tmp), {
			owner: "root",
			updatedAt: "2026-08-21T00:00:00.000Z",
			todos: TASK_TODOS,
		});
		const state = loadTodoState(todoStateDir(tmp));
		expect(state?.getTodos()[0].kind).toBe("task");
		expect(state?.getTodos()[0].dag_id).toBe("GC-2026-061");
		expect(state?.getTodos()[1].depends_on).toEqual(["P1"]);
	});
});
