/**
 * todo-state.ts — GC-2026-060 auto-todowrite foundation.
 *
 * A Sages-owned todo state store for the orchestrator's auto-todowrite
 * feature. The pi built-in `todowrite` agent tool keeps its list only in
 * LLM context; this module gives the extension a durable, observable
 * snapshot so it can diff, persist, and remind.
 *
 * Semantics mirror deepseek-harness's `todo_write` tool:
 *   - Whole-list replacement (`apply`): the caller submits the full new
 *     list; the manager diffs it against the current list
 *     (last-write-wins snapshot — no incremental edit language).
 *   - Single owner: the store belongs to the ROOT agent session only.
 *     `deserialize` refuses any file whose `owner !== 'root'`, so
 *     subagent todo lists can never enter the store (root-agent-only
 *     constraint).
 *   - Identity: items match by `id` when present, else by `content`.
 *
 * Path convention: <repo>/.pi/orchestrator/todo-state.json, using the
 * canonical ORCHESTRATOR_DIR constant from ../orchestrator/types.js.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ORCHESTRATOR_DIR } from "../orchestrator/types.js";
import { findSagesRoot } from "../orchestrator/template-loader.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";
/** GC-2026-061: kind "task" marks a dispatchable DAG task; "plan" a plain action. */
export type TodoKind = "plan" | "task";

/**
 * One todo. `id`/`priority` are optional so the shape stays compatible
 * with the pi built-in `todowrite` tool's items.
 *
 * GC-2026-061 (additive): structured todos — those carrying `kind`,
 * `depends_on`, or `batch` — are the plan definition: the extension
 * compiles them into a DAG (see dag-compile.ts). `dag_id`/`goal_id`
 * name the compiled DAG (todo field → session default → 'DAG-todos').
 */
export interface TodoItem {
  /** Stable identity — when present, matching is by id, not content. */
  id?: string;
  /** Human-readable description. */
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
  /** "task" = dispatchable DAG task; "plan" = plain action. */
  kind?: TodoKind;
  /** DAG dependency edges — task ids this task depends on. */
  depends_on?: string[];
  /** Explicit concurrency group (1-based). Omitted → auto-assigned by topology. */
  batch?: number;
  /** DAG id for the compiled plan (else session default / 'DAG-todos'). */
  dag_id?: string;
  /** Goal contract id for the compiled plan. */
  goal_id?: string;
  /** Detailed prompt for the subagent; defaults to content. */
  prompt?: string;
  /** Files this task touches. */
  files?: string[];
}

/** Result of one whole-list replacement (or programmatic update). */
export interface TodoDiff {
  /** Items that appear in the new snapshot but were not in the old one. */
  added: TodoItem[];
  /** Items that were in the old list but are gone from the new one. */
  removed: TodoItem[];
  /** Items that transitioned into `completed`. */
  completed: TodoItem[];
  /** Items that left `completed` (back to pending/in_progress). */
  reopened: TodoItem[];
}

export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

/** Persisted file shape. `owner` is locked to "root" by design. */
export interface TodoStateFile {
  owner: "root";
  /** ISO timestamp of the last mutation (or file write). */
  updatedAt: string;
  todos: TodoItem[];
}

/** Identity ref for complete/remove — a plain string (content or id) or
 *  a partial item carrying just the identity fields. */
export type TodoRef = string | Pick<TodoItem, "id" | "content">;

/** Programmatic update surface for `applyDiff`. */
export interface TodoUpdate {
  /** Items to append (status defaults to "pending"). */
  add?: TodoItem[];
  /** Items to mark completed — matched by content or id (string or identity ref). */
  complete?: TodoRef[];
  /** Items to remove — matched by content or id (string or identity ref). */
  remove?: TodoRef[];
}

/** File name inside the orchestrator state dir. */
export const TODO_STATE_FILE = "todo-state.json";

// ─── Identity + validation helpers ────────────────────────────────────────

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const TODO_PRIORITIES: readonly TodoPriority[] = ["high", "medium", "low"];

/**
 * Canonical identity key. Items WITH an id match by id; items WITHOUT an
 * id match by content. The prefix keeps the two namespaces disjoint so an
 * item with `id: "foo"` never collides with an id-less item whose content
 * is "foo".
 */
function todoKey(item: Pick<TodoItem, "id" | "content">): string {
  const id = item.id;
  if (id !== undefined && id !== "") return `id:${id}`;
  return `content:${item.content}`;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && (TODO_PRIORITIES as readonly string[]).includes(value);
}

/** Validate one parsed todo item; returns a clean copy. */
function validateTodoItem(value: unknown): TodoItem {
  if (value === null || typeof value !== "object") {
    throw new Error("Todo state item must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.content !== "string" || raw.content.length === 0) {
    throw new Error("Todo state item 'content' must be a non-empty string");
  }
  if (!isTodoStatus(raw.status)) {
    throw new Error(`Todo state item has invalid status: ${String(raw.status)}`);
  }
  if (raw.id !== undefined && (typeof raw.id !== "string" || raw.id.length === 0)) {
    throw new Error("Todo state item 'id' must be a non-empty string");
  }
  if (raw.priority !== undefined && !isTodoPriority(raw.priority)) {
    throw new Error(`Todo state item has invalid priority: ${String(raw.priority)}`);
  }
  const item: TodoItem = { content: raw.content, status: raw.status };
  if (typeof raw.id === "string" && raw.id.length > 0) item.id = raw.id;
  if (isTodoPriority(raw.priority)) item.priority = raw.priority;
  // GC-2026-061: preserve structured (DAG-compile) fields so a persisted
  // task-level todo survives a store round-trip with its structure.
  // Invalid values are silently dropped, mirroring id/priority handling.
  if (raw.kind === "plan" || raw.kind === "task") item.kind = raw.kind;
  if (Array.isArray(raw.depends_on) && raw.depends_on.every((d) => typeof d === "string")) {
    item.depends_on = raw.depends_on as string[];
  }
  if (typeof raw.batch === "number" && Number.isInteger(raw.batch) && raw.batch >= 1) {
    item.batch = raw.batch;
  }
  if (typeof raw.dag_id === "string" && raw.dag_id.length > 0) item.dag_id = raw.dag_id;
  if (typeof raw.goal_id === "string" && raw.goal_id.length > 0) item.goal_id = raw.goal_id;
  if (typeof raw.prompt === "string" && raw.prompt.length > 0) item.prompt = raw.prompt;
  if (Array.isArray(raw.files) && raw.files.every((f) => typeof f === "string")) {
    item.files = raw.files as string[];
  }
  return item;
}

function cloneItem(item: TodoItem): TodoItem {
  return { ...item };
}

function describeRef(ref: TodoRef): string {
  if (typeof ref === "string") return `"${ref}"`;
  const id = ref.id !== undefined ? `id "${ref.id}"` : null;
  return id !== null ? `item ${id}` : `item with content "${ref.content}"`;
}

// ─── TodoStateManager ─────────────────────────────────────────────────────

/**
 * Owns the root agent's todo snapshot. Thread-safe by convention: the pi
 * extension process is single-session, and every mutation goes through
 * `apply` (whole-list) or `applyDiff` (programmatic).
 */
export class TodoStateManager {
  /** Root-agent-only owner. Subagent lists are rejected by deserialize. */
  static readonly OWNER = "root" as const;

  private todos: TodoItem[];
  private updatedAt: string;

  constructor(initial?: TodoItem[]) {
    this.todos = (initial ?? []).map(cloneItem);
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Whole-list replacement (deepseek-harness `todo_write` semantics).
   * Replaces the current list with `snapshot` and returns the diff.
   */
  apply(snapshot: TodoItem[]): TodoDiff {
    const before = this.todos;
    const incoming = snapshot.map(cloneItem);

    const oldKeys = new Set(before.map(todoKey));
    const newKeys = new Set(incoming.map(todoKey));

    const diff: TodoDiff = { added: [], removed: [], completed: [], reopened: [] };

    for (const item of before) {
      if (!newKeys.has(todoKey(item))) diff.removed.push(item);
    }
    for (const item of incoming) {
      const key = todoKey(item);
      if (!oldKeys.has(key)) {
        diff.added.push(item);
        continue;
      }
      const prev = before.find((t) => todoKey(t) === key)!;
      if (prev.status !== "completed" && item.status === "completed") {
        diff.completed.push(item);
      } else if (prev.status === "completed" && item.status !== "completed") {
        diff.reopened.push(item);
      }
    }

    this.todos = incoming;
    this.touchIfChanged(diff);
    return diff;
  }

  /**
   * Programmatic updates — add / complete / remove by content or id.
   * Refs that match nothing throw (fail fast: refs come from observed
   * todowrite calls and stale refs indicate a real bug).
   */
  applyDiff(update: TodoUpdate): TodoDiff {
    const diff: TodoDiff = { added: [], removed: [], completed: [], reopened: [] };

    for (const raw of update.add ?? []) {
      const item: TodoItem = { ...raw, status: raw.status ?? "pending" };
      const key = todoKey(item);
      if (this.todos.some((t) => todoKey(t) === key)) continue; // idempotent add
      this.todos.push(cloneItem(item));
      diff.added.push(cloneItem(item));
    }

    for (const ref of update.complete ?? []) {
      const idx = this.findIndex(ref);
      if (idx === -1) {
        throw new Error(`Cannot complete unknown todo: ${describeRef(ref)}`);
      }
      const current = this.todos[idx];
      if (current.status === "completed") continue;
      const updated: TodoItem = { ...current, status: "completed" };
      this.todos[idx] = updated;
      diff.completed.push(cloneItem(updated));
    }

    for (const ref of update.remove ?? []) {
      const idx = this.findIndex(ref);
      if (idx === -1) {
        throw new Error(`Cannot remove unknown todo: ${describeRef(ref)}`);
      }
      const [removed] = this.todos.splice(idx, 1);
      diff.removed.push(cloneItem(removed));
    }

    this.touchIfChanged(diff);
    return diff;
  }

  /** All todos, in list order (copy — mutating it cannot corrupt state). */
  getTodos(): TodoItem[] {
    return this.todos.map(cloneItem);
  }

  getPending(): TodoItem[] {
    return this.todos.filter((t) => t.status === "pending").map(cloneItem);
  }

  getInProgress(): TodoItem[] {
    return this.todos.filter((t) => t.status === "in_progress").map(cloneItem);
  }

  getCompleted(): TodoItem[] {
    return this.todos.filter((t) => t.status === "completed").map(cloneItem);
  }

  getCounts(): TodoCounts {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    for (const t of this.todos) {
      if (t.status === "pending") pending++;
      else if (t.status === "in_progress") inProgress++;
      else completed++;
    }
    return { pending, inProgress, completed };
  }

  /** Persisted shape: owner locked to "root", current timestamp, todos. */
  serialize(): TodoStateFile {
    return {
      owner: TodoStateManager.OWNER,
      updatedAt: this.updatedAt,
      todos: this.todos.map(cloneItem),
    };
  }

  /**
   * Rebuild a manager from a parsed state file (or JSON string).
   * Throws on any non-root owner — subagent todo lists must never enter
   * this store — and on malformed shapes.
   */
  static deserialize(json: unknown): TodoStateManager {
    const parsed: unknown = typeof json === "string" ? JSON.parse(json) : json;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Todo state must be an object");
    }
    const raw = parsed as Record<string, unknown>;
    if (raw.owner !== TodoStateManager.OWNER) {
      throw new Error(
        `Todo state owner must be '${TodoStateManager.OWNER}' (got '${String(raw.owner)}') — subagent todo lists are not tracked`,
      );
    }
    if (!Array.isArray(raw.todos)) {
      throw new Error("Todo state 'todos' must be an array");
    }
    const manager = new TodoStateManager(raw.todos.map(validateTodoItem));
    if (typeof raw.updatedAt === "string" && raw.updatedAt.length > 0) {
      manager.updatedAt = raw.updatedAt;
    }
    return manager;
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Locate an item by identity ref (id when present, else content) or by
   *  plain string (content first, then id). */
  private findIndex(ref: TodoRef): number {
    if (typeof ref === "object" && ref !== null) {
      const key = todoKey(ref);
      return this.todos.findIndex((t) => todoKey(t) === key);
    }
    return this.todos.findIndex((t) => t.content === ref || t.id === ref);
  }

  private touchIfChanged(diff: TodoDiff): void {
    if (
      diff.added.length > 0 ||
      diff.removed.length > 0 ||
      diff.completed.length > 0 ||
      diff.reopened.length > 0
    ) {
      this.updatedAt = new Date().toISOString();
    }
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────

/**
 * Atomically write `<dir>/todo-state.json` (tmp + rename, mirroring the
 * sages-routines-install store pattern). Returns the target path.
 */
export function saveTodoState(dir: string, state: TodoStateManager | TodoStateFile): string {
  const target = join(dir, TODO_STATE_FILE);
  const payload = state instanceof TodoStateManager ? state.serialize() : state;
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, target);
  return target;
}

/**
 * Load `<dir>/todo-state.json`. Returns null when the file is missing,
 * corrupt, or owned by anyone other than the root agent.
 */
export function loadTodoState(dir: string): TodoStateManager | null {
  const target = join(dir, TODO_STATE_FILE);
  if (!existsSync(target)) return null;
  try {
    const raw = readFileSync(target, "utf-8");
    return TodoStateManager.deserialize(raw);
  } catch {
    return null;
  }
}

// ─── Path convention ──────────────────────────────────────────────────────

/** `<repo>/.pi/orchestrator` — the orchestrator state dir. */
export function todoStateDir(repoRoot: string): string {
  return join(repoRoot, ORCHESTRATOR_DIR);
}

/** `<repo>/.pi/orchestrator/todo-state.json` — the todo state file. */
export function todoStatePath(repoRoot: string): string {
  return join(todoStateDir(repoRoot), TODO_STATE_FILE);
}

/**
 * Resolve the repo root that owns `.pi/orchestrator` state.
 *
 * Priority:
 *   1. The nearest ancestor of `cwd` (or process.cwd()) that contains
 *      `.pi/orchestrator` or `.git` — the extension's session cwd is the
 *      authoritative repo root.
 *   2. findSagesRoot() when it resolves to a self-hosted sages repo
 *      (a package root that carries its own `.pi` dir). This is the
 *      "if available" fallback: an installed package copy has no `.pi`
 *      directory, so it can never be mistaken for the repo.
 *   3. `cwd` itself (last resort).
 */
export function resolveRepoRoot(cwd?: string): string {
  const start = resolve(cwd ?? process.cwd());
  let cursor = start;
  for (;;) {
    if (existsSync(join(cursor, ORCHESTRATOR_DIR)) || existsSync(join(cursor, ".git"))) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const sagesRoot = findSagesRoot();
  if (sagesRoot !== null && existsSync(join(sagesRoot, ".pi"))) {
    return sagesRoot;
  }
  return start;
}
