/**
 * todo-sync.ts — GC-2026-074: single source of truth for auto-syncing the
 * LLM-facing todowrite view with the DAG's task lifecycle.
 *
 * Direction: one-way, DAG → todo. The DAG is ground truth; the todo file
 * is a view the LLM sees. When `task_dispatch` successfully transitions a
 * task, this helper updates the corresponding todo item's status.
 *
 * Drift (LLM mutating the todo file out-of-band, or a compile that left
 * the todo out of sync with the DAG) is detected by `todowrite_progress`
 * and surfaced through `orchestrator_audit`, not by silently correcting
 * here. Silent auto-correction would mask LLM intent errors.
 */
import { existsSync, readFileSync } from "node:fs";
import * as yaml from "js-yaml";
import type { OrchestrationPlan, TaskNode } from "./types.js";
import {
	type TodoFile,
	type TodoItem,
	type TodoStatus,
	todoPath,
} from "./types.js";
import { atomicWriteOrchestratorFile } from "./state-persistence.js";

/**
 * Map a TaskNode.status to the corresponding TodoStatus. `skipped` is the
 * same on both sides; other states pass through.
 */
function toTodoStatus(status: TaskNode["status"]): TodoStatus {
	return status as TodoStatus;
}

/**
 * Load the todowrite file for a given DAG. Returns null if the file does
 * not exist (compile never ran). Caller decides whether to skip or error.
 */
export function loadTodoFile(cwd: string, dagId: string): TodoFile | null {
	const path = todoPath(cwd, dagId);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = yaml.load(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const tf = parsed as TodoFile;
		if (tf.schemaVersion !== "v1") return null;
		if (tf.dag_id !== dagId) return null;
		if (!Array.isArray(tf.items)) return null;
		return tf;
	} catch {
		return null;
	}
}

/**
 * Save a TodoFile atomically using the existing orchestrator-owned write
 * helper. The validate hook keeps us safe against YAML desync bugs.
 */
export function saveTodoFile(cwd: string, file: TodoFile): string {
	return atomicWriteOrchestratorFile(cwd, `todo-${file.dag_id}.yaml`, yaml.dump(file, { indent: 2, lineWidth: 120, noRefs: true }), {
		owner: "orchestrator",
		validate: (value: unknown): value is TodoFile => {
			const v = value as TodoFile;
			return (
				!!v &&
				typeof v === "object" &&
				v.schemaVersion === "v1" &&
				typeof v.dag_id === "string" &&
				Array.isArray(v.items) &&
				v.items.every(
					(item) =>
						!!item &&
						typeof item.todo_id === "string" &&
						typeof item.task_id === "string" &&
						typeof item.content === "string" &&
						typeof item.status === "string",
				)
			);
		},
	});
}

/**
 * GC-2026-074: called from `task_dispatch.transitionTask` AFTER the DAG
 * mutation succeeds and BEFORE `savePlan`. Best-effort: returns
 * `{ synced: false, reason: string }` if the todo file doesn't exist
 * (compile never ran), or if the YAML is malformed. Never throws.
 *
 * DAG is the source of truth — we update the todo view to match. We do
 * NOT correct drift here; drift detection is a separate path.
 */
export interface TodoSyncResult {
	synced: boolean;
	reason?: string;
	todo_id?: string;
	previous_status?: TodoStatus;
}

export function syncTodoForTask(
	cwd: string,
	plan: OrchestrationPlan,
	task: TaskNode,
): TodoSyncResult {
	const todo = loadTodoFile(cwd, plan.id);
	if (!todo) {
		// No todo file yet — compile never ran. Silent no-op so the
		// DAG is not burdened by an early transition before the LLM
		// has had a chance to compile the todo view.
		return { synced: false, reason: "no todo file — run todowrite_compile first" };
	}

	// Find the item. If the LLM mutated the YAML out-of-band and the
	// item no longer matches this task_id, the DAG transition still
	// succeeds (DAG is ground truth) but we surface the drift via the
	// `reason` field so callers can log it.
	const item = todo.items.find((i) => i.task_id === task.id);
	if (!item) {
		return {
			synced: false,
			reason: `no todo item for task '${task.id}' — drift: task exists in DAG but not in todo file`,
		};
	}

	const newStatus = toTodoStatus(task.status);
	if (item.status === newStatus) {
		return {
			synced: true,
			todo_id: item.todo_id,
			previous_status: item.status,
		};
	}

	const previous_status = item.status;
	item.status = newStatus;
	item.last_synced_at = new Date().toISOString();
	// Mirror onto the TaskNode — keeps the DAG's view of the todo link
	// fresh in case the YAML round-trip resets it later.
	if (task.todo_id !== item.todo_id) task.todo_id = item.todo_id;

	try {
		saveTodoFile(cwd, todo);
	} catch (error) {
		// Sync is best-effort; do not turn a successful DAG transition
		// into a failure just because the todo write threw. The drift
		// will surface on the next `todowrite_progress` call.
		return {
			synced: false,
			reason: `todo write failed: ${error instanceof Error ? error.message : String(error)}`,
			todo_id: item.todo_id,
			previous_status,
		};
	}

	return { synced: true, todo_id: item.todo_id, previous_status };
}

/**
 * Compute drift between the DAG state and the persisted todo file.
 * Used by `todowrite_progress` and by the orchestrator-audit failure
 * mode stats rollup. Returns the kind of drift per row so callers can
 * bucket and surface.
 */
export function computeTodoDrift(
	plan: OrchestrationPlan,
	todo: TodoFile | null,
): Array<{
	todo_id?: string;
	task_id?: string;
	todo_status?: TodoStatus;
	dag_status?: TaskNode["status"];
	drift_kind: import("./types.js").TodoDriftKind;
}> {
	if (!todo) {
		// Every DAG task is "orphaned" from the todo side.
		return plan.tasks.map((t) => ({
			task_id: t.id,
			dag_status: t.status,
			drift_kind: "task_orphaned" as const,
		}));
	}

	const todoByTaskId = new Map<string, TodoItem>();
	for (const item of todo.items) todoByTaskId.set(item.task_id, item);

	const drift: Array<{
		todo_id?: string;
		task_id?: string;
		todo_status?: TodoStatus;
		dag_status?: TaskNode["status"];
		drift_kind: import("./types.js").TodoDriftKind;
	}> = [];

	for (const task of plan.tasks) {
		const item = todoByTaskId.get(task.id);
		if (!item) {
			drift.push({ task_id: task.id, dag_status: task.status, drift_kind: "task_orphaned" });
			continue;
		}
		if (item.status !== task.status) {
			// Direction: todo_ahead when the todo is further along than
			// the DAG (LLM finished marking it done before the actual
			// task completion propagated); dag_ahead otherwise.
			const order: Record<TodoStatus, number> = {
				pending: 0,
				in_progress: 1,
				completed: 2,
				failed: 2,
				skipped: 2,
			};
			drift.push({
				todo_id: item.todo_id,
				task_id: task.id,
				todo_status: item.status,
				dag_status: task.status,
				drift_kind: order[item.status] > order[task.status] ? "todo_ahead" : "dag_ahead",
			});
		}
	}

	for (const item of todo.items) {
		if (!plan.tasks.find((t) => t.id === item.task_id)) {
			drift.push({
				todo_id: item.todo_id,
				todo_status: item.status,
				drift_kind: "todo_orphaned",
			});
		}
	}

	return drift;
}