/**
 * task-feeder.ts — Unified task feeder (GC-2026-108 + GC-2026-113 + GC-2026-117).
 *
 * Replaces the three parallel cascade listeners that previously split
 * dispatch responsibility across `workflow-handler.ts` (now deleted in
 * GC-2026-remove-workflow-run-prod), the now-deleted `decompose-cascade.ts`
 * (deleted in GC-2026-117), and `pi-tasks/src/index.ts:227` (TaskExecute).
 * Every task dispatch path now flows through this single module:
 *
 *   - Every producer (decompose_task, /tasks create, TaskCreate LLM,
 *     TaskUpdate, TaskExecute) calls the feeder's `maybeAutoSpawn(task)`
 *     after `store.create` / `store.update`.
 *   - A single `agentTaskMap` covers every dispatch path.
 *   - A single `subagents:completed` / `subagents:failed` listener pair
 *     handles completion + cascade.
 *
 * Design doc: `.pi/orchestrator/designs/2026-10-08-user-task-feeder.md`
 * Postmortem: `pi/docs/postmortem/GC-2026-task-feeding-and-decomposition.md`
 *             (D4: source-agnostic dispatch; finally realized)
 * Postmortem: `pi/docs/postmortem/GC-2026-remove-workflow-run-prod.md`
 *             (workflow_run removed; feeder is now the single dispatch path)
 */

import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

// Local debug logger. Kept minimal to avoid pulling in a separate
// debug module — production wiring can hook into pi.events if needed.
function debugLog(...args: unknown[]): void {
  // `process` is a Node global; access it via globalThis to keep this
  // module type-clean without an `@types/node` import (the host project
  // already pulls those in transitively).
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const env = g.process?.env?.PI_TASKS_DEBUG;
  if (env) {
    // eslint-disable-next-line no-console
    console.error("[task-feeder]", ...args);
  }
}

// ── Predicate ─────────────────────────────────────────────────────────

/**
 * A task is "feedable" iff:
 *   1. It has an explicit `agentType` (actionable / step / orchestrator
 *      tasks, plus pre-GC intent tasks that still carry the Planner
 *      stamp from disk), OR
 *   2. Its `kind` is `"intent"` — the main-agent proactive intent pump
 *      (GC-2026-main-agent-proactive-intent-pump) is the dispatcher.
 *
 * The predicate deliberately ignores `phase` and `created_by`. With
 * unification, those become pure metadata (routing keys used by the
 * previous split architecture are no longer needed).
 *
 * GC-2026-main-agent-proactive-intent-pump: kind=intent is now feedable
 * to the IntentPump (NOT to a subagent spawn). The `feeder.maybeAutoSpawn`
 * router inspects `kind` and dispatches kind=intent to
 * `IntentPump.enqueue(task)` while keeping the existing subagent spawn
 * path for agentType-bearing tasks.
 *
 * Note: tasks persisted to disk before this GC landed may still carry
 * `agentType: "Planner"` from the GC-2026-121 auto-stamp. Those remain
 * feedable via the agentType branch — a pre-existing task with an
 * explicit dispatcher should still run.
 */
export function isFeedableTask(t: Task): boolean {
  const meta = t.metadata ?? {};
  // Branch 1: explicit agentType wins (actionable / step / orchestrator /
  // pre-GC-122 intent tasks stamped "Planner" by the old auto-stamp).
  const at = meta.agentType;
  if (typeof at === "string" && at.length > 0) return true;
  // Branch 2: kind=intent is feedable — main-agent IntentPump dispatches
  // it. (The router inside `maybeAutoSpawn` picks pump vs subagent.)
  if (meta.kind === "intent") return true;
  return false;
}

// ── Public handle returned by registerTaskFeeder ──────────────────────

export interface TaskFeederHandle {
  /** Detach the subagents:completed / subagents:failed listeners. */
  unsubscribe: () => void;
  /**
   * Direct-call entry point used by every producer. If the task is
   * feedable, its own status is `pending`, and its blockers (if any) are
   * all `completed`, spawn a subagent via the configured `spawn` callback.
   * On spawn failure, revert the task to `pending` with `lastError` so
   * it remains visible and retryable.
   *
   * Caller contract: invoke after `store.create` (or `store.update` that
   * changes a task back to `pending`). The function self-gates on
   * `status === "pending"` as defense-in-depth — GC-2026-fix-decompose-task-ctx-events
   * captured the re-dispatch loop where a previous version of the
   * contract pushed status-gating onto producers and a missed gate
   * caused the same intent task to be re-spawned repeatedly when
   * `subagents:failed` reverted status to `pending`. The self-gate here
   * prevents that class of bug regardless of caller behavior.
   */
  maybeAutoSpawn: (task: Task) => Promise<void>;
}

export interface TaskFeederOptions {
  store: TaskStore;
  events: {
    on: (channel: string, handler: (data: unknown) => void | Promise<void>) => () => void;
  };
  spawn: (task: Task) => Promise<string>;
  /**
   * Shared `agentId → taskId` map. The feeder populates it on every
   * successful spawn and removes entries on completion / failure. Other
   * extension code (widget, `TaskOutput`) reads from it.
   *
   * The extension factory creates one map and passes it here. Reloading
   * the extension clears it; the feeder continues to work on the same
   * reference.
   */
  agentTaskMap: Map<string, string>;
  /**
   * Optional side-effect hook fired on completion / failure. Used by the
   * extension factory to update the task widget (`setActiveTask` /
   * `update`).
   */
  onTaskChange?: (taskId: string, status: "completed" | "failed") => void;
  /**
   * Optional IntentPump — when provided, `kind=intent` tasks are routed
   * to the pump's `enqueue` method instead of the regular subagent
   * `spawn` callback. The pump injects a "Consume intent #N" user
   * message into the main session; the LLM then calls TaskUpdate or
   * decompose_task directly. The feeder still tracks the task in the
   * `agentTaskMap` with a synthetic `intent-pump:<id>` id so widget /
   * TaskOutput integration is uniform.
   *
   * GC-2026-main-agent-proactive-intent-pump.
   */
  intentPump?: { enqueue(task: Task): void; isOwned(taskId: string): boolean };
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register the unified task feeder. Wires `subagents:completed` and
 * `subagents:failed` listeners. Returns a handle exposing
 * `maybeAutoSpawn` (bound to the feeder's agentTaskMap) and
 * `unsubscribe`.
 */
export function registerTaskFeeder(opts: TaskFeederOptions): TaskFeederHandle {
  const { store, events, spawn, agentTaskMap, onTaskChange } = opts;

  // The wrapped spawn populates the shared agentTaskMap so the
  // completion listener can resolve agentId → taskId. Other code
  // (widget, TaskOutput) reads from the same map.
  const wrappedSpawn = async (task: Task): Promise<string> => {
    // GC-2026-main-agent-proactive-intent-pump: kind=intent → pump, not
    // subagent spawn. The pump injects a "Consume intent #N" user
    // message into the main session; the LLM updates the task directly
    // via TaskUpdate (which the pump polls) — no subagents:completed
    // event fires. The synthetic agentId is recorded in the map for
    // uniform widget / TaskOutput integration.
    if (task.metadata?.kind === "intent" && opts.intentPump) {
      const synthetic = `intent-pump:${task.id}`;
      agentTaskMap.set(synthetic, task.id);
      opts.intentPump.enqueue(task);
      return synthetic;
    }
    const agentId = await spawn(task);
    agentTaskMap.set(agentId, task.id);
    return agentId;
  };

  async function maybeAutoSpawn(task: Task): Promise<void> {
    if (!isFeedableTask(task)) return;

    // GC-2026-fix-decompose-task-ctx-events: self-gate on status. The
    // pre-fix contract pushed status-gating onto every caller, which
    // created a re-dispatch loop when `subagents:failed` reverted
    // status to `pending` — the same task would be re-spawned on the
    // next event that walked the store. The self-gate here prevents
    // that class of bug regardless of caller behavior.
    //
    // Read the LATEST status from the store, not the in-memory
    // `task` object. Direct callers (TaskCreate, TaskUpdate,
    // TaskExecute, decompose materialize) pass the object they just
    // got from `store.create` / `store.update` — that snapshot can be
    // stale after a subsequent spawn flips status to `in_progress`.
    // The store is the source of truth; the O(1) `store.get` keeps
    // the gate correct.
    const fresh = store.get(task.id) ?? task;
    if (fresh.status !== "pending") return;

    // GC-2026-main-agent-proactive-intent-pump: kind=intent bypasses
    // the blocker gate. The pump's queue is the source of truth for
    // "next" (FIFO by enqueue order), NOT blockedBy edges. The
    // blocking semantics belong to actionable / step / orchestrator
    // tasks — intent tasks are user intents and should be processed
    // in the order they were created, regardless of any blockedBy
    // edges that might have been set by callers.
    if (task.metadata?.kind !== "intent") {
      const blockers = task.blockedBy ?? [];
      if (blockers.length > 0) {
        const allCompleted = blockers.every((id) => {
          const b = store.get(id);
          return b !== undefined && b.status === "completed";
        });
        if (!allCompleted) return;
      }
    }

    await spawnAndTrack(fresh, store, wrappedSpawn);
  }

  async function cascadeSpawn(completedTaskId: string): Promise<void> {
    const all = store.list();
    for (const t of all) {
      if (t.status !== "pending") continue;
      if (!isFeedableTask(t)) continue;
      // GC-2026-main-agent-proactive-intent-pump: intent tasks have
      // NO cascade. The pump dequeues by FIFO from its own queue and
      // never walks blockedBy edges. Even if a caller happens to
      // populate blockedBy on an intent task, cascade must skip it.
      if (t.metadata?.kind === "intent") continue;
      // GC-2026-118 F5: only walk children of the just-completed task.
      // Top-level pending tasks (no blockers) are spawned directly by
      // TaskCreate / TaskUpdate / materializeDecomposeChain via
      // feeder.maybeAutoSpawn; the cascade path is for tasks that were
      // unblocked by a completion. Skipping non-children at the filter
      // (rather than at the maybeAutoSpawn blocker check) cuts the
      // per-cascade iteration from O(N) tasks-checked to O(children).
      if (!t.blockedBy.includes(completedTaskId)) continue;
      await maybeAutoSpawn(t);
    }
  }

  const unsubCompleted = events.on("subagents:completed", async (raw: unknown) => {
    const data = raw as { id?: string; result?: string };
    if (!data || typeof data.id !== "string") return;
    const taskId = agentTaskMap.get(data.id);
    if (!taskId) return;
    const task = store.get(taskId);
    if (!task) return;

    agentTaskMap.delete(data.id);
    store.update(taskId, {
      status: "completed",
      metadata: { ...task.metadata, result: data.result },
    });
    onTaskChange?.(taskId, "completed");
    await cascadeSpawn(taskId);
  });

  const unsubFailed = events.on("subagents:failed", async (raw: unknown) => {
    const data = raw as { id?: string; error?: string; result?: string; status?: string };
    if (!data || typeof data.id !== "string") return;
    const taskId = agentTaskMap.get(data.id);
    if (!taskId) return;
    const task = store.get(taskId);
    if (!task) return;

    agentTaskMap.delete(data.id);

    if (data.status === "stopped") {
      // Intentional stop — mark completed, preserve partial result.
      store.update(taskId, {
        status: "completed",
        metadata: {
          ...task.metadata,
          result: data.result ?? task.metadata?.result,
        },
      });
      onTaskChange?.(taskId, "completed");
      await cascadeSpawn(taskId);
    } else {
      // Actual error — revert to pending, drop prior result.
      const errMsg =
        typeof data.error === "string"
          ? data.error
          : typeof data.status === "string"
            ? data.status
            : "agent failed";
      store.update(taskId, {
        status: "pending",
        metadata: {
          ...task.metadata,
          result: null,
          lastError: errMsg,
        },
      });
      onTaskChange?.(taskId, "failed");
    }
  });

  return {
    unsubscribe: () => {
      unsubCompleted();
      unsubFailed();
    },
    maybeAutoSpawn,
  };
}

// ── Internal ──────────────────────────────────────────────────────────

async function spawnAndTrack(
  task: Task,
  store: TaskStore,
  spawn: (task: Task) => Promise<string>,
): Promise<void> {
  try {
    const agentId = await spawn(task);
    store.update(task.id, {
      status: "in_progress",
      owner: agentId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(`spawn failed task=#${task.id}`, err);
    store.update(task.id, {
      status: "pending",
      metadata: {
        ...task.metadata,
        result: null,
        lastError: message,
      },
    });
  }
}
