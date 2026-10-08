/**
 * task-feeder.ts — Unified task feeder (GC-2026-108).
 *
 * Replaces the three parallel cascade listeners that previously split
 * dispatch responsibility across `workflow-handler.ts`, `decompose-cascade.ts`,
 * and `pi-tasks/src/index.ts:227` (TaskExecute). Every task dispatch path
 * now flows through this single module:
 *
 *   - Every producer (workflow_run, decompose_task, /tasks create,
 *     TaskCreate LLM, TaskUpdate, TaskExecute) calls the feeder's
 *     `maybeAutoSpawn(task)` after `store.create` / `store.update`.
 *   - A single `agentTaskMap` covers every dispatch path.
 *   - A single `subagents:completed` / `subagents:failed` listener pair
 *     handles completion + cascade.
 *
 * Design doc: `.pi/orchestrator/designs/2026-10-08-user-task-feeder.md`
 * Postmortem: `pi/docs/postmortem/GC-2026-task-feeding-and-decomposition.md`
 *             (D4: source-agnostic dispatch; finally realized)
 */

import type { Task } from "./types.js";
import type { TaskStore } from "./task-store.js";

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
 * A task is "feedable" iff it has an `agentType` set. The feeder only
 * dispatches feedable tasks; everything else sits in the store as data.
 *
 * The predicate deliberately ignores `phase` and `created_by`. With
 * unification, those become pure metadata (routing keys used by the
 * previous split architecture are no longer needed).
 */
export function isFeedableTask(t: Task): boolean {
  const at = t.metadata?.agentType;
  return typeof at === "string" && at.length > 0;
}

// ── Public handle returned by registerTaskFeeder ──────────────────────

export interface TaskFeederHandle {
  /** Detach the subagents:completed / subagents:failed listeners. */
  unsubscribe: () => void;
  /**
   * Direct-call entry point used by every producer. If the task is
   * feedable and its blockers (if any) are all `completed`, spawn a
   * subagent via the configured `spawn` callback. On spawn failure,
   * revert the task to `pending` with `lastError` so it remains visible
   * and retryable.
   *
   * Caller contract: invoke after `store.create` (or `store.update` that
   * changes a task back to `pending`). Calling on a task already
   * `in_progress` will spawn again — producers are responsible for
   * gating on `status === "pending"`.
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
    const agentId = await spawn(task);
    agentTaskMap.set(agentId, task.id);
    return agentId;
  };

  async function maybeAutoSpawn(task: Task): Promise<void> {
    if (!isFeedableTask(task)) return;

    // Cascade gate: only spawn if all blockers are completed.
    const blockers = task.blockedBy ?? [];
    if (blockers.length > 0) {
      const allCompleted = blockers.every((id) => {
        const b = store.get(id);
        return b !== undefined && b.status === "completed";
      });
      if (!allCompleted) return;
    }

    await spawnAndTrack(task, store, wrappedSpawn);
  }

  async function cascadeSpawn(): Promise<void> {
    const all = store.list();
    for (const t of all) {
      if (t.status !== "pending") continue;
      if (!isFeedableTask(t)) continue;
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
    await cascadeSpawn();
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
      await cascadeSpawn();
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
