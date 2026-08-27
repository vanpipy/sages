/**
 * todowrite.ts — GC-2026-074: LLM-facing todowrite tools that link the
 * orchestrator's DAG to the model's private task tracker.
 *
 * The DAG is the source of truth. These tools provide a VIEW (compiled
 * todowrite items persisted under `.pi/orchestrator/todo-{dag_id}.yaml`)
 * and a RECONCILIATION view (which items disagree with the DAG).
 *
 * Auto-sync direction is one-way (DAG -> todo). See `todo-sync.ts`.
 */
import { Type, type Static } from "typebox";
import * as yaml from "js-yaml";
import { loadPlan } from "./dag-synthesizer.js";
import { saveTodoFile, loadTodoFile, computeTodoDrift } from "./todo-sync.js";
import type {
	OrchestrationPlan,
	TaskNode,
	TodoFile,
	TodoItem,
	TodoStatus,
	TodoDrift,
} from "./types.js";

// ───────────────────────────────────────────────────────────────────────
// ULID-style local id for todo items (deterministic, no external dep)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

function newTodoId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.floor(Math.random() * 0x1_000_000).toString(36).padStart(5, "0");
	return `todo-${ts}-${rand}`;
}

// ───────────────────────────────────────────────────────────────────────
// TypeBox schemas
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

const TodoStatusSchema = Type.Union(
	[
		Type.Literal("pending"),
		Type.Literal("in_progress"),
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("skipped"),
	],
	{ description: "Todowrite item status." },
);

export const TodowriteCompileParams = Type.Object({
	dag_id: Type.String({ description: "The id of an existing OrchestrationPlan.", minLength: 1 }),
	force: Type.Optional(
		Type.Boolean({
			description: "If true, regenerate the todo file even when one already exists.",
		}),
	),
}, { additionalProperties: false });

export type TodowriteCompileInput = Static<typeof TodowriteCompileParams>;

export const TodowriteProgressParams = Type.Object({
	dag_id: Type.Optional(
		Type.String({
			description:
				"The DAG id to reconcile. Omit when only one active plan exists on disk.",
			minLength: 1,
		}),
	),
	verbose: Type.Optional(
		Type.Boolean({
			description: "Include raw todo + DAG YAML alongside the reconciliation view.",
		}),
	),
}, { additionalProperties: false });

export type TodowriteProgressInput = Static<typeof TodowriteProgressParams>;

// ───────────────────────────────────────────────────────────────────────
// Tool implementations
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface CompileResult {
	ok: boolean;
	dag_id: string;
	items: TodoItem[];
	total: number;
	by_status: Record<string, number>;
	persisted_to: string;
	force_required?: boolean;
}

/**
 * Compile a todowrite list from a DAG plan. Each TaskNode maps to one
 * item with `[serial]` / `[parallel]` marker and `task_id` for
 * cross-reference. Persists to `.pi/orchestrator/todo-{dag_id}.yaml`.
 *
 * If a todo file already exists and `force` is not set, returns a
 * structured "force_required" response without overwriting. This guards
 * against LLM calls that would clobber an in-progress todo view.
 */
export function executeTodowriteCompile(params: TodowriteCompileInput, ctx: { cwd: string }): CompileResult {
	const cwd = ctx.cwd;
	const plan = loadPlan(cwd, params.dag_id);
	if (!plan) {
		return {
			ok: false,
			dag_id: params.dag_id,
			items: [],
			total: 0,
			by_status: {},
			persisted_to: "",
		};
	}

	const existing = loadTodoFile(cwd, params.dag_id);
	if (existing && !params.force) {
		return {
			ok: false,
			dag_id: params.dag_id,
			items: existing.items,
			total: existing.items.length,
			by_status: countByStatus(existing.items),
			persisted_to: `.pi/orchestrator/todo-${params.dag_id}.yaml`,
			force_required: true,
		};
	}

	const items: TodoItem[] = plan.tasks.map((task) => {
		const existingItem = existing?.items.find((i) => i.task_id === task.id);
		return {
			todo_id: existingItem?.todo_id ?? newTodoId(),
			task_id: task.id,
			content: `${batchMarker(task, plan)} ${task.id}: ${task.description}`,
			status: taskToTodoStatus(task.status),
			last_synced_at: existingItem?.last_synced_at ?? null,
		};
	});

	const file: TodoFile = {
		schemaVersion: "v1",
		dag_id: plan.id,
		compiled_at: new Date().toISOString(),
		compiled_from_todos: true,
		items,
	};

	const path = saveTodoFile(cwd, file);

	// Mirror todo_id onto TaskNode so future transitions can locate
	// their item by either task_id (preferred, faster) or todo_id.
	for (const item of items) {
		const t = plan.tasks.find((tt) => tt.id === item.task_id);
		if (t) t.todo_id = item.todo_id;
	}

	return {
		ok: true,
		dag_id: plan.id,
		items,
		total: items.length,
		by_status: countByStatus(items),
		persisted_to: path,
	};
}

interface ProgressItem {
	todo_id: string;
	task_id: string;
	content: string;
	todo_status: TodoStatus;
	dag_status: TaskNode["status"];
	synced: boolean;
	last_synced_at: string | null;
}

interface ProgressResult {
	ok: boolean;
	dag_id: string;
	items: ProgressItem[];
	drift: TodoDrift[];
	summary: { synced: number; drifted: number; pending: number };
	todo_persisted_to?: string;
	todo_yaml?: string;
	dag_yaml?: string;
}

export function executeTodowriteProgress(params: TodowriteProgressInput, ctx: { cwd: string }): ProgressResult {
	const cwd = ctx.cwd;
	const dagId = params.dag_id;
	if (!dagId) {
		return {
			ok: false,
			dag_id: "",
			items: [],
			drift: [],
			summary: { synced: 0, drifted: 0, pending: 0 },
		};
	}
	const plan = loadPlan(cwd, dagId);
	if (!plan) {
		return {
			ok: false,
			dag_id: dagId,
			items: [],
			drift: [],
			summary: { synced: 0, drifted: 0, pending: 0 },
		};
	}
	const todo = loadTodoFile(cwd, dagId);
	const drift = computeTodoDrift(plan, todo);

	const todoByTaskId = new Map<string, TodoItem>();
	if (todo) for (const item of todo.items) todoByTaskId.set(item.task_id, item);

	const items: ProgressItem[] = plan.tasks.map((task) => {
		const t = todoByTaskId.get(task.id);
		return {
			todo_id: t?.todo_id ?? "",
			task_id: task.id,
			content: t?.content ?? `${batchMarker(task, plan)} ${task.id}: ${task.description}`,
			todo_status: t?.status ?? "pending",
			dag_status: task.status,
			synced: !!t && t.status === task.status,
			last_synced_at: t?.last_synced_at ?? null,
		};
	});

	const summary = {
		synced: items.filter((i) => i.synced).length,
		drifted: drift.length,
		pending: items.filter((i) => !i.synced && !drift.find((d) => d.task_id === i.task_id)).length,
	};

	const result: ProgressResult = {
		ok: true,
		dag_id: dagId,
		items,
		drift,
		summary,
	};
	if (todo) {
		result.todo_persisted_to = `.pi/orchestrator/todo-${dagId}.yaml`;
	}
	if (params.verbose === true) {
		// On-demand raw YAML echo. We do NOT auto-load on every call —
		// the YAML can be large. Caller opts in.
		result.todo_yaml = todo ? yaml.dump(todo, { indent: 2, lineWidth: 120, noRefs: true }) : "";
		result.dag_yaml = yaml.dump(plan, { indent: 2, lineWidth: 120, noRefs: true });
	}
	return result;
}

// ───────────────────────────────────────────────────────────────────────
// Tool registration
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function registerTodowriteTools(pi: unknown): void {
	const api = pi as {
		registerTool: (tool: {
			name: string;
			label: string;
			description: string;
			parameters: unknown;
			execute: (
				_toolCallId: string,
				params: unknown,
				_signal: unknown,
				_onUpdate: unknown,
				_ctx: unknown,
			) => unknown;
		}) => void;
	};

	api.registerTool({
		name: "todowrite_compile",
		label: "Compile Todowrite",
		description:
			"Generate a todowrite view from a DAG plan. Each TaskNode becomes one item whose " +
			"content encodes [serial]/[parallel] marker, task_id, and description. Persists to " +
			".pi/orchestrator/todo-{dag_id}.yaml. After compile, every DAG transition auto-syncs " +
			"the corresponding todo item (DAG is source of truth, todo is view).",
		parameters: TodowriteCompileParams,
		// GC-2026-085: wrap the execute result in the canonical ToolResult
		// shape ({ content: [{ type: "text", text: JSON.stringify(...) }] })
		// so pi-coding-agent's render-utils.js#getTextOutput can find the
		// `.content` array. Prior to this fix, the registered execute
		// returned the plain CompileResult object directly, which crashed
		// pi with `TypeError: Cannot read properties of undefined (reading
		// 'filter')` whenever the tool was called. The underlying
		// executeTodowriteCompile function is unchanged.
		execute: (_id, params, _signal, _onUpdate, ctx) => {
			const result = executeTodowriteCompile(
				params as TodowriteCompileInput,
				{ cwd: (ctx as { cwd: string }).cwd },
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});

	api.registerTool({
		name: "todowrite_progress",
		label: "Todowrite Progress",
		description:
			"Read the persisted todo view + current DAG state, return a reconciliation. Drift " +
			"(todo_ahead / dag_ahead / *_orphaned) is surfaced as `drift[]` so the orchestrator's " +
			"audit can flag desync. verbose:true echoes the raw YAMLs for debugging.",
		parameters: TodowriteProgressParams,
		// GC-2026-085: same ToolResult-shape wrapper as todowrite_compile
		// above. The underlying executeTodowriteProgress function is
		// unchanged; only the registered-tool boundary is wrapped so the
		// renderer's getTextOutput can read result.content.
		execute: (_id, params, _signal, _onUpdate, ctx) => {
			const result = executeTodowriteProgress(
				params as TodowriteProgressInput,
				{ cwd: (ctx as { cwd: string }).cwd },
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

function taskToTodoStatus(status: TaskNode["status"]): TodoStatus {
	return status;
}

function batchMarker(task: TaskNode, plan: OrchestrationPlan): string {
	// A task is "parallel" when there is at least one sibling in the
	// same batch that does not depend on it. Otherwise it's serial.
	const siblings = plan.tasks.filter(
		(t) => t.batch === task.batch && t.id !== task.id,
	);
	const isParallel = siblings.some(
		(s) => !task.depends_on.includes(s.id) && !s.depends_on.includes(task.id),
	);
	return isParallel ? "[parallel]" : "[serial]";
}

function countByStatus(items: TodoItem[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) out[item.status] = (out[item.status] ?? 0) + 1;
	return out;
}