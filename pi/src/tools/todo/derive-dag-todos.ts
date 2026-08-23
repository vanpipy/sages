/**
 * derive-dag-todos.ts — derive batch-level todos from a DAG plan.
 *
 * Used by `extension.ts` to populate the root todo store from an
 * orchestrator DAG: when `dag_synthesize` or `orchestrator_audit` fires,
 * the resulting todos are applied to `todo-state.json` so the LLM and
 * the terminal pane both see the live plan status.
 *
 * Pure: reads files only, never mutates a TodoStateManager.
 *
 * Batch classification:
 *   - current batch = the lowest-numbered batch containing an
 *     in_progress task (audit-state statuses win over the plan's),
 *     falling back to the lowest batch that is not fully completed;
 *   - tasks in the current batch → in_progress;
 *   - fully-completed batches → completed;
 *   - everything else → pending.
 *
 * Returns [] when the DAG file does not exist or is malformed.
 */

import { loadPlan } from "../orchestrator/dag-synthesizer.js";
import { loadYamlOrchestratorFile } from "../orchestrator/state-persistence.js";
import type { TaskNode } from "../orchestrator/types.js";
import type { TodoItem } from "./todo-state.js";

type TaskStatus = TaskNode["status"];

/** Minimal audit-state shape: per-task id + runtime status. */
interface AuditTasksFile {
	tasks: Array<{ id: string; status: TaskStatus }>;
}

function isAuditTasksFile(value: unknown): value is AuditTasksFile {
	const v = value as { tasks?: unknown };
	return (
		!!v &&
		typeof v === "object" &&
		Array.isArray(v.tasks) &&
		v.tasks.every(
			(t) =>
				!!t &&
				typeof t === "object" &&
				typeof (t as { id?: unknown }).id === "string" &&
				typeof (t as { status?: unknown }).status === "string",
		)
	);
}

function loadAuditTasks(cwd: string, dagId: string): AuditTasksFile | null {
	try {
		return loadYamlOrchestratorFile(cwd, `audit-state-${dagId}.yaml`, {
			owner: "l3",
			validate: isAuditTasksFile,
		});
	} catch {
		return null;
	}
}

export function deriveDagTodos(dagId: string, cwd?: string): TodoItem[] {
	const base = cwd ?? process.cwd();
	const plan = loadPlan(base, dagId);
	if (!plan) return [];

	const audit = loadAuditTasks(base, dagId);
	const statusOf = new Map<string, TaskStatus>();
	for (const task of audit?.tasks ?? []) statusOf.set(task.id, task.status);

	const tasks = plan.tasks.map((task) => ({
		...task,
		status: statusOf.get(task.id) ?? task.status,
	}));

	const byBatch = new Map<number, TaskNode[]>();
	for (const task of tasks) {
		const list = byBatch.get(task.batch) ?? [];
		list.push(task);
		byBatch.set(task.batch, list);
	}
	const batches = [...byBatch.keys()].sort((a, b) => a - b);
	const isCompleted = (batch: number): boolean =>
		byBatch.get(batch)!.every((t) => t.status === "completed");

	const inProgressBatches = batches.filter((batch) =>
		byBatch.get(batch)!.some((t) => t.status === "in_progress"),
	);
	const current: number | null =
		inProgressBatches.length > 0
			? inProgressBatches[0]
			: batches.find((b) => !isCompleted(b)) ?? null;

	const todos: TodoItem[] = [];
	for (const batch of batches) {
		let status: TodoItem["status"];
		if (current !== null && batch === current) status = "in_progress";
		else if (isCompleted(batch)) status = "completed";
		else status = "pending";
		for (const task of byBatch.get(batch)!) {
			todos.push({ id: task.id, content: task.description, status });
		}
	}
	return todos;
}