/**
 * sages-todo-tool.ts — GC-2026-060 auto-todowrite LLM-callable tool.
 *
 * `sages_todo` gives the orchestrator LLM a durable, observable todo list
 * (the pi built-in `todowrite` keeps its list only in LLM context). Three
 * actions:
 *
 *   - sync      — whole-list replacement (deepseek-harness `todo_write`
 *                 semantics): validate every item, replace the list via
 *                 TodoStateManager.apply, persist to
 *                 <repo>/.pi/orchestrator/todo-state.json, return counts
 *                 + diff summary.
 *   - get       — return the current list + counts.
 *   - auto-plan — derive batch-level todos from the active DAG
 *                 (goal-<dag_id>.yaml + dag-<dag_id>.yaml + optional
 *                 audit-state-<dag_id>.yaml) and apply them. With no
 *                 dag_id it is a no-op returning the current list, so
 *                 ad-hoc root workflows without a DAG still work.
 *
 * Root-agent-only constraint: this tool is registered on the root
 * extension only (see registerSagesTodoTool / extension wiring). The
 * module exposes no path for a subagent to write non-root state — the
 * store's deserialize rejects any owner !== 'root' as defense-in-depth.
 */

import { Type, type Static } from "typebox";
import { loadGoalContract, loadPlan } from "../orchestrator/dag-synthesizer.js";
import { loadYamlOrchestratorFile } from "../orchestrator/state-persistence.js";
import type { TaskNode } from "../orchestrator/types.js";
import { buildChangeHighlight } from "./todo-reminder.js";
import {
  TodoStateManager,
  loadTodoState,
  resolveRepoRoot,
  saveTodoState,
  todoStateDir,
  type TodoDiff,
  type TodoItem,
} from "./todo-state.js";

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

/** One todo as submitted by the LLM (mirrors TodoItem; TypeBox-constrained). */
const TodoItemParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Optional stable identity (e.g. a DAG task id)" })),
  content: Type.String({ minLength: 1, description: "Human-readable description" }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
  priority: Type.Optional(
    Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  ),
  // GC-2026-061: structured todo fields — task-level entries (kind
  // 'task', depends_on, or batch) compile into a DAG via
  // dag-compile.ts. Declared here so the pi validation boundary never
  // strips them from a sages_todo sync payload.
  kind: Type.Optional(
    Type.Union([Type.Literal("plan"), Type.Literal("task")], {
      description: "'task' marks a dispatchable DAG task; 'plan' a plain action",
    }),
  ),
  depends_on: Type.Optional(
    Type.Array(Type.String(), { description: "DAG dependency edges — task ids this task depends on" }),
  ),
  batch: Type.Optional(
    Type.Integer({ minimum: 1, description: "Explicit concurrency group (1-based)" }),
  ),
  dag_id: Type.Optional(
    Type.String({
      pattern: "^[A-Za-z0-9_-]+$",
      description: "DAG id for the compiled plan (else session default / 'DAG-todos')",
    }),
  ),
  goal_id: Type.Optional(
    Type.String({ description: "Goal contract id for the compiled plan" }),
  ),
  prompt: Type.Optional(
    Type.String({ description: "Detailed prompt for the subagent; defaults to content" }),
  ),
  files: Type.Optional(Type.Array(Type.String(), { description: "Files this task touches" })),
});

export const SagesTodoParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("sync"),
      Type.Literal("get"),
      Type.Literal("auto-plan"),
    ],
    {
      description:
        "sync: replace the whole todo list (task-level entries — kind 'task', " +
        "depends_on, batch — compile into a DAG via .pi/orchestrator/dag-<id>.yaml). " +
        "get: return the current list. auto-plan: derive batch-level todos from the " +
        "active DAG (dag_id) or no-op.",
    },
  ),
  todos: Type.Optional(
    Type.Array(TodoItemParams, {
      description:
        "The FULL new todo list (whole-list replacement) — required for action 'sync'.",
    }),
  ),
  dag_id: Type.Optional(
    Type.String({
      description:
        "Goal/DAG id (e.g. 'GC-2026-060') used by action 'auto-plan' to derive " +
        "batch-level todos from .pi/orchestrator/goal-<id>.yaml + dag-<id>.yaml " +
        "+ audit-state-<id>.yaml.",
      pattern: "^[A-Za-z0-9_-]+$",
    }),
  ),
});

export type SagesTodoInput = Static<typeof SagesTodoParams>;

export interface SagesTodoResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

// ─── auto-plan derivation (pure helper, exported for extension wiring) ────

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

/**
 * Derive batch-level todos from a DAG + optional audit-state. Pure: reads
 * files only, never mutates a TodoStateManager and never writes state.
 *
 * Batch classification:
 *   - current batch = the lowest-numbered batch containing an in_progress
 *     task (audit-state statuses win over the plan's), falling back to
 *     the lowest batch that is not fully completed;
 *   - tasks in the current batch → in_progress;
 *   - fully-completed batches → completed;
 *   - everything else → pending.
 *
 * Returns [] when the DAG file does not exist or is malformed.
 */
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
    inProgressBatches.length > 0 ? inProgressBatches[0] : batches.find((b) => !isCompleted(b)) ?? null;

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

// ─── Validation ───────────────────────────────────────────────────────────

type ValidationResult = { ok: true; todos: TodoItem[] } | { ok: false; code: string; error: string };

/** Defense-in-depth validation (TypeBox already rejects at schema level). */
function validateSyncTodos(raw: unknown): ValidationResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: "MISSING_TODOS",
      error: "action 'sync' requires a 'todos' array (the full new list)",
    };
  }
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown> | null;
    if (t === null || typeof t !== "object") {
      return { ok: false, code: "INVALID_TODO", error: `todos[${i}] must be an object` };
    }
    if (typeof t.content !== "string" || t.content.trim().length === 0) {
      return {
        ok: false,
        code: "INVALID_TODO",
        error: `todos[${i}].content must be a non-empty string`,
      };
    }
    if (typeof t.status !== "string" || !(TODO_STATUSES as readonly string[]).includes(t.status)) {
      return {
        ok: false,
        code: "INVALID_TODO",
        error: `todos[${i}].status must be one of: ${TODO_STATUSES.join(", ")} (got ${JSON.stringify(t.status)})`,
      };
    }
  }
  return { ok: true, todos: raw as TodoItem[] };
}

// ─── Actions ──────────────────────────────────────────────────────────────

function countsText(counts: { pending: number; inProgress: number; completed: number }): string {
  return `${counts.pending + counts.inProgress + counts.completed} todos (${counts.pending} pending | ${counts.inProgress} in_progress | ${counts.completed} completed)`;
}

function syncAction(params: SagesTodoInput, stateDir: string): SagesTodoResult {
  const validated = validateSyncTodos(params.todos);
  if (!validated.ok) {
    return {
      content: [{ type: "text", text: `sages_todo error: ${validated.error}` }],
      details: { status: "error", code: validated.code, error: validated.error },
    };
  }
  const manager = loadTodoState(stateDir) ?? new TodoStateManager();
  const diff = manager.apply(validated.todos);
  const saved = saveTodoState(stateDir, manager);
  const counts = manager.getCounts();
  const highlight = buildChangeHighlight(diff);
  const text = `sages_todo sync: ${countsText(counts)}${highlight ? `; changes: ${highlight}` : ""}`;
  return {
    content: [{ type: "text", text }],
    details: { status: "ok", action: "sync", todos: manager.getTodos(), counts, diff, saved },
  };
}

function getAction(stateDir: string): SagesTodoResult {
  const manager = loadTodoState(stateDir) ?? new TodoStateManager();
  const counts = manager.getCounts();
  return {
    content: [{ type: "text", text: `sages_todo get: ${countsText(counts)}` }],
    details: { status: "ok", action: "get", todos: manager.getTodos(), counts },
  };
}

function autoPlanAction(params: SagesTodoInput, stateDir: string, repoRoot: string): SagesTodoResult {
  const manager = loadTodoState(stateDir) ?? new TodoStateManager();
  const dagId = params.dag_id;

  if (dagId === undefined) {
    const counts = manager.getCounts();
    return {
      content: [
        { type: "text", text: `sages_todo auto-plan: no dag_id — no-op (ad-hoc workflow); ${countsText(counts)}` },
      ],
      details: {
        status: "ok",
        action: "auto-plan",
        dag_id: null,
        note: "no dag_id — no-op for ad-hoc root workflows",
        todos: manager.getTodos(),
        counts,
      },
    };
  }

  if (!loadPlan(repoRoot, dagId)) {
    return {
      content: [
        {
          type: "text",
          text:
            `sages_todo error: DAG ${dagId} not found in .pi/orchestrator — ` +
            "run dag_synthesize first, or omit dag_id for ad-hoc todos.",
        },
      ],
      details: { status: "error", code: "DAG_NOT_FOUND", dag_id: dagId },
    };
  }

  // Load the goal contract too (validates the DAG is registered; its
  // title is surfaced in the response details).
  const contract = loadGoalContract(repoRoot, dagId);
  const derived = deriveDagTodos(dagId, repoRoot);
  const diff: TodoDiff = manager.apply(derived);
  saveTodoState(stateDir, manager);
  const counts = manager.getCounts();
  const highlight = buildChangeHighlight(diff);
  const text =
    `sages_todo auto-plan: derived ${derived.length} todos from ${dagId}` +
    (highlight ? `; changes: ${highlight}` : "");
  return {
    content: [{ type: "text", text }],
    details: {
      status: "ok",
      action: "auto-plan",
      dag_id: dagId,
      goal: contract?.title ?? null,
      derived,
      todos: manager.getTodos(),
      counts,
      diff,
    },
  };
}

// ─── Entry point + registration ───────────────────────────────────────────

/**
 * Pure(ish) tool entry: validates + mutates the root todo store under
 * <repo>/.pi/orchestrator. Extracted from the registered tool so tests
 * can drive it directly with a temp cwd.
 */
export async function executeSagesTodo(params: SagesTodoInput, ctx: { cwd?: string }): Promise<SagesTodoResult> {
  const repoRoot = resolveRepoRoot(ctx.cwd ?? process.cwd());
  const stateDir = todoStateDir(repoRoot);

  switch (params.action) {
    case "sync":
      return syncAction(params, stateDir);
    case "auto-plan":
      return autoPlanAction(params, stateDir, repoRoot);
    case "get":
      return getAction(stateDir);
  }
}

/**
 * Register the `sages_todo` tool on the root extension.
 *
 * Root-agent-only: this must only be called from the root extension
 * registration (registerOrchestratorTools in index.ts / extension.ts).
 * Developer/auditor subagent toolsets never include it, and the store
 * itself rejects non-root owners — no subagent path exists.
 */
export function registerSagesTodoTool(pi: any): void {
  pi.registerTool({
    name: "sages_todo",
    label: "Sages Todo",
    description:
      "Root-agent todo state for auto-todowrite. action 'sync' replaces the " +
      "whole list (validate + persist to .pi/orchestrator/todo-state.json); " +
      "'get' returns the current list + counts; 'auto-plan' derives batch-level " +
      "todos from the active DAG (pass dag_id; omit for ad-hoc workflows). " +
      "Root-agent only — subagents have no path into this store.",
    parameters: SagesTodoParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return await executeSagesTodo(params as SagesTodoInput, { cwd: ctx?.cwd });
    },
  });
}
