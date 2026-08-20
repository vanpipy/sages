/**
 * dag-compile.ts — GC-2026-061 todo→DAG compile bridge.
 *
 * The todo list is the single operation surface for the root agent
 * (todowrite / sages_todo). Structured todo entries — those carrying
 * `kind: "task"`, a `depends_on` array, or a `batch` number — are the
 * plan definition: this module compiles them into a TaskNode DAG and
 * serializes it in the exact shape `planToYaml` produces, so the
 * compiled plan drops into `.pi/orchestrator/dag-<id>.yaml` and the
 * existing orchestrator tooling (loadPlan / task_dispatch / audit)
 * consumes it unchanged.
 *
 * Storage discipline (single source, single responsibility):
 *   - `dag-<id>.yaml` is the DAG structure source of truth.
 *   - `todo-state.json` stays the runtime status view only — no DAG
 *     structure is ever written into it.
 *
 * Plain plan-level todos (no kind 'task', no depends_on, no batch) are
 * deliberately EXCLUDED from the compiled DAG — they are root-agent
 * actions, not dispatchable tasks.
 */

import * as yaml from "js-yaml";
import { join } from "node:path";
import { planToYaml } from "../orchestrator/dag-synthesizer.js";
import {
  atomicWriteOrchestratorFile,
  isOrchestrationPlanState,
} from "../orchestrator/state-persistence.js";
import {
  DAG_PREFIX,
  ORCHESTRATOR_DIR,
  type OrchestrationPlan,
  type TaskNode,
} from "../orchestrator/types.js";
import type { TodoItem } from "./todo-state.js";

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Todo item extended with the DAG-structure fields the compile bridge
 * understands. A superset of TodoItem: plain TodoItem[] call sites keep
 * working (structural subtyping), and structured entries only exist when
 * the root agent opts in.
 */
export interface DagTodoItem extends TodoItem {
  /** "task" marks a dispatchable task; "plan" marks a plain action. */
  kind?: "plan" | "task";
  /** DAG dependency edges — task ids this task depends on. */
  depends_on?: string[];
  /** Explicit concurrency group (1-based). Omitted → auto-assigned by topology. */
  batch?: number;
  /** Detailed prompt for the subagent; defaults to content. */
  prompt?: string;
  /** Files this task touches. */
  files?: string[];
}

/** Options for compileDagFromTodos. */
export interface CompileDagOptions {
  /** Explicit DAG id; defaults to 'DAG-<goalId>' (GC- stripped) or a deterministic hash id. */
  dagId?: string;
  /** Goal contract id this DAG serves. */
  goalId?: string;
}

/** The compiled DAG — TaskNodes plus the stable identity. */
export interface CompiledDag {
  tasks: TaskNode[];
  dagId: string;
  goalId?: string;
}

// ─── Constants + helpers ──────────────────────────────────────────────────

/** TaskNode id pattern (mirrors TaskNodeSchema): 'P1', 'P2.a'. */
const TASK_ID_RE = /^[A-Z0-9]+(\.[a-z])?$/;

/** Case-insensitive variant of the same pattern, for normalization. */
const TASK_ID_ANY_CASE_RE = /^([A-Za-z0-9]+)\.([a-z])$/;

/**
 * Whether a todo carries DAG structure. Per the GC-2026-061 contract a
 * todo is task-level when ANY of kind==='task', a depends_on array, or a
 * batch number is present — regardless of the kind marker.
 */
function isStructured(todo: DagTodoItem): boolean {
  return todo.kind === "task" || Array.isArray(todo.depends_on) || typeof todo.batch === "number";
}

/**
 * Normalize a caller-supplied task id into the /^[A-Z0-9]+(\.[a-z])?$/
 * pattern: valid ids pass through untouched; otherwise uppercase + strip
 * non-alphanumerics (preserving a lowercase sub-part like 'P2.a').
 */
function normalizeTaskId(id: string): string {
  if (TASK_ID_RE.test(id)) return id;
  const subpart = TASK_ID_ANY_CASE_RE.exec(id);
  if (subpart !== null) return `${subpart[1].toUpperCase()}.${subpart[2]}`;
  return id.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Derive a slug from the first whitespace token of content (may be ''). */
function deriveFromContent(content: string): string {
  const token = content.split(/\s+/)[0] ?? "";
  return token.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Assign stable, unique, pattern-valid ids. Explicit ids are
 * authoritative (a duplicate explicit id throws); synthetic ids derived
 * from content (or the T<n> fallback) are deduplicated by suffixing.
 */
function assignTaskIds(todos: DagTodoItem[]): string[] {
  const used = new Set<string>();
  const ids: string[] = new Array(todos.length).fill("");

  // Pass 1 — explicit ids win and must be unique.
  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    if (todo.id === undefined || todo.id === "") continue;
    const normalized = normalizeTaskId(todo.id) || deriveFromContent(todo.content) || `T${i + 1}`;
    if (used.has(normalized)) {
      throw new Error(`duplicate task id '${todo.id}' (normalized '${normalized}') in todos`);
    }
    used.add(normalized);
    ids[i] = normalized;
  }

  // Pass 2 — synthetic ids fill the gaps, deduplicated deterministically.
  for (let i = 0; i < todos.length; i++) {
    if (ids[i] !== "") continue;
    const todo = todos[i];
    let candidate = deriveFromContent(todo.content) || `T${i + 1}`;
    const base = candidate;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}${suffix++}`;
    used.add(candidate);
    ids[i] = candidate;
  }
  return ids;
}

/**
 * DFS cycle detection over depends_on. Returns the offending path
 * (e.g. ['A1', 'B1', 'A1']) or null when the graph is acyclic. Unknown
 * dependency refs (plan-level todos, dangling ids) are treated as leaves.
 */
function findCycle(adjacency: Map<string, string[]>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  for (const node of adjacency.keys()) color.set(node, WHITE);

  const dfs = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of adjacency.get(node) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(dep);
        return stack.slice(start).concat(dep);
      }
      if (c === WHITE && adjacency.has(dep)) {
        const cycle = dfs(dep);
        if (cycle !== null) return cycle;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    return null;
  };

  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE) {
      const cycle = dfs(node);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

/**
 * Longest-path batch layering over the (acyclic) dependency graph:
 * tasks with no deps → batch 1; a task whose deps are all in batches
 * ≤ k → batch k+1. Explicit batches are honored as fixed points.
 */
function computeBatches(
  ids: string[],
  adjacency: Map<string, string[]>,
  explicit: Map<string, number>,
): Map<string, number> {
  const batch = new Map<string, number>();

  const batchOf = (id: string): number => {
    const known = batch.get(id);
    if (known !== undefined) return known;
    const fixed = explicit.get(id);
    if (fixed !== undefined) {
      batch.set(id, fixed);
      return fixed;
    }
    let maxDep = 0;
    for (const dep of adjacency.get(id) ?? []) maxDep = Math.max(maxDep, batchOf(dep));
    const value = maxDep + 1;
    batch.set(id, value);
    return value;
  };

  for (const id of ids) batchOf(id);
  return batch;
}

/**
 * Deterministic, order-independent DAG id for todo-only compiles: an
 * FNV-1a 32-bit hash over the sorted task ids (hex, zero-padded).
 */
function dagIdFromTaskIds(taskIds: string[]): string {
  const material = [...taskIds].sort().join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `DAG-${hex}`;
}

// ─── Compile ──────────────────────────────────────────────────────────────

/**
 * Compile structured todos into a TaskNode DAG.
 *
 * Structured = kind 'task', a depends_on array, or a batch number (see
 * isStructured). Plain plan-level todos are excluded. Validation order:
 * ids → cycle detection → batch assignment → batch/topology conflicts.
 */
export function compileDagFromTodos(
  todos: DagTodoItem[],
  opts: CompileDagOptions = {},
): CompiledDag {
  const structured = todos.filter(isStructured);

  const ids = assignTaskIds(structured);
  const idSet = new Set(ids);

  // Dependency topology over structured tasks only — plan-level and
  // unknown refs are leaves (kept verbatim on the TaskNode below).
  const adjacency = new Map<string, string[]>();
  for (let i = 0; i < structured.length; i++) {
    const deps = (structured[i].depends_on ?? []).filter((dep) => idSet.has(dep));
    adjacency.set(ids[i], deps);
  }

  const cycle = findCycle(adjacency);
  if (cycle !== null) {
    throw new Error(`cycle detected in depends_on: ${cycle.join(" -> ")}`);
  }

  const explicitBatch = new Map<string, number>();
  for (let i = 0; i < structured.length; i++) {
    const todo = structured[i];
    if (typeof todo.batch === "number") {
      if (!Number.isInteger(todo.batch) || todo.batch < 1) {
        throw new Error(
          `task '${ids[i]}' has invalid batch ${todo.batch}; batch must be a positive integer`,
        );
      }
      explicitBatch.set(ids[i], todo.batch);
    }
  }
  const batch = computeBatches(ids, adjacency, explicitBatch);

  for (let i = 0; i < structured.length; i++) {
    const id = ids[i];
    const myBatch = batch.get(id)!;
    for (const dep of adjacency.get(id)!) {
      const depBatch = batch.get(dep)!;
      if (depBatch >= myBatch) {
        throw new Error(
          `batch conflict: task '${id}' (batch ${myBatch}) depends on '${dep}' (batch ${depBatch}); ` +
            "dependencies must be in an earlier batch",
        );
      }
    }
  }

  const dagId =
    opts.dagId ??
    (opts.goalId !== undefined ? `DAG-${opts.goalId.replace(/^GC-/, "")}` : dagIdFromTaskIds(ids));

  const tasks: TaskNode[] = structured.map((todo, i) => {
    const id = ids[i];
    return {
      id,
      description: todo.content,
      plane: "Foundation",
      priority: todo.priority ?? "medium",
      depends_on: todo.depends_on ?? [],
      files: todo.files ?? [],
      subagent_type: "developer",
      batch: batch.get(id)!,
      isolation: { dag_id: dagId, task_id: id, mode: "create" },
      tdd: "none",
      prompt: todo.prompt ?? todo.content,
      output_schema: { kind: "code_changes" },
      acceptance: { covers: [], self_check_cmd: "", auditor_check_cmd: "" },
      status: "pending",
      retry_count: 0,
      max_retries: 2,
    };
  });

  return { tasks, dagId, goalId: opts.goalId };
}

// ─── Serialization ────────────────────────────────────────────────────────

/**
 * Serialize a compiled DAG to YAML in the exact shape `planToYaml`
 * produces, by building a hand-assembled OrchestrationPlan and reusing
 * the canonical serializer. Round-trip safe: loadPlan parses it back.
 */
export function dagToPlanYaml(dag: CompiledDag): string {
  const now = new Date().toISOString();
  const prompts: Record<string, string> = {};
  for (const task of dag.tasks) prompts[task.id] = task.prompt;

  const plan: OrchestrationPlan = {
    id: dag.dagId,
    goal_id: dag.goalId ?? dag.dagId,
    title: dag.goalId ?? dag.dagId,
    tasks: dag.tasks,
    created_at: now,
    updated_at: now,
    state: "approved",
    prompts,
  };
  return planToYaml(plan);
}

/** `<cwd>/.pi/orchestrator/dag-<dagId>.yaml` — the file writeCompiledDag writes. */
export function compiledDagPath(cwd: string, dagId: string): string {
  return join(cwd, ORCHESTRATOR_DIR, `${DAG_PREFIX}${dagId}.yaml`);
}

/**
 * Atomically write a compiled DAG YAML to `<cwd>/.pi/orchestrator/
 * dag-<dagId>.yaml` (tmp + rename, via the orchestrator's canonical
 * atomic writer — the same path dag_synthesize uses). The dagId is read
 * from the YAML itself, so the serialized plan and the file name can
 * never diverge. Returns the target path.
 */
export function writeCompiledDag(dagYaml: string, cwd: string): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(dagYaml);
  } catch (error) {
    throw new Error(
      `writeCompiledDag: compiled DAG YAML is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isOrchestrationPlanState(parsed)) {
    throw new Error(
      "writeCompiledDag: compiled DAG YAML is not a valid OrchestrationPlan " +
        "(needs id, goal_id, state, and a tasks array)",
    );
  }
  const dagId = (parsed as { id: string }).id;
  return atomicWriteOrchestratorFile(cwd, `${DAG_PREFIX}${dagId}.yaml`, dagYaml, {
    owner: "l3",
    validate: isOrchestrationPlanState,
  });
}
