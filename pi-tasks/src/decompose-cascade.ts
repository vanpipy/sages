/**
 * decompose-cascade.ts — Dedicated cascade listener for decomposed tasks.
 *
 * GC-2026-task-feeding-and-decomposition (D10, R6, AC14): decomposed chains
 * do not flow through workflow-handler's cascade (it tracks workflow_run's
 * graph) or pi-tasks/src/index.ts's auto-cascade (gated by cfg.autoCascade
 * + cascadeConfig, both fragile). This module owns its own:
 *
 *   1. `decomposeAgentMap: Map<string, string>` — agentId -> taskId,
 *      populated when `decompose_task` (in pi-orchestrator) emits
 *      `decompose:spawn` after its first spawn.
 *   2. `subagents:completed` listener — marks the task completed and
 *      cascades by spawning any pending decomposed task whose blockedBy
 *      is fully satisfied.
 *   3. `subagents:failed` listener — reverts task to pending with
 *      `lastError` metadata so the orchestrator can retry.
 *
 * Cascade guard (D10): only tasks matching
 *   metadata.created_by === "orchestrator" &&
 *   metadata.phase === "decomposition_chain"
 * are eligible for cascade. Workflow tasks (phase: implement/review/fix/
 * merge) are unaffected — they continue to use workflow-handler's cascade.
 */

import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

// ── Event channel constants ─────────────────────────────────────────────

/**
 * decompose_task (pi-orchestrator) emits this after the first spawn so
 * this listener can register the agentId for cascade tracking. Channel
 * name is namespaced under `decompose:` to avoid colliding with workflow
 * events.
 */
export const DECOMPOSE_SPAWN_CHANNEL = "decompose:spawn";

// ── Types ───────────────────────────────────────────────────────────────

export interface DecomposeCascadeOptions {
  /**
   * Minimal event-bus contract — `on(channel, handler)` returns unsub.
   * Matches `pi.events` shape (pi-tasks + pi-orchestrator share the bus).
   */
  events: {
    on: (
      channel: string,
      handler: (data: unknown) => void | Promise<void>,
    ) => () => void;
  };
  store: TaskStore;
  /**
   * Spawn a pending decomposed task as a subagent. Returns the agentId.
   * Implementations typically call `subagents:rpc:spawn` via the
   * pi-subagents bridge, mirroring workflow-handler's spawnAgent.
   */
  spawn: (task: Task) => Promise<string>;
  /**
   * Optional callback after a decomposed task completes (for UI / widget
   * mirrors).
   */
  onTaskChange?: (taskId: string, status: "completed" | "failed") => void;
}

// ── Cascade gate predicate ─────────────────────────────────────────────

/**
 * Predicate: is `t` eligible for decompose cascade?
 *   - created_by="orchestrator" (top-level or downstream decomposed task)
 *   - phase="decomposition_chain" (D5: linear chain materialization)
 *
 * Workflow tasks (phase: implement/review/fix/merge) are NOT eligible —
 * they have their own cascade in workflow-handler.
 */
function isDecomposeTask(t: Task): boolean {
  return (
    t.metadata.created_by === "orchestrator" &&
    t.metadata.phase === "decomposition_chain"
  );
}

/**
 * Predicate: can `t` run now? (all blockers completed)
 */
function blockersSatisfied(t: Task, store: TaskStore): boolean {
  return t.blockedBy.every((id) => {
    const blocker = store.get(id);
    return blocker !== undefined && blocker.status === "completed";
  });
}

// ── Registration ───────────────────────────────────────────────────────

/**
 * Register the dedicated `subagents:completed` + `subagents:failed` +
 * `decompose:spawn` listeners for decompose chains. Returns an unsubscribe
 * function that detaches all three.
 *
 * Lifecycle:
 *   1. decompose_task (pi-orchestrator) materializes the chain in pi-tasks
 *      store. T1, T2, ..., TN all carry `created_by="orchestrator"` +
 *      `phase="decomposition_chain"`.
 *   2. decompose_task spawns T1 directly (via subagents:rpc:spawn), then
 *      emits `decompose:spawn` with `{ agentId, taskId: T1.id }`. This
 *      listener populates `decomposeAgentMap`.
 *   3. When T1's subagent emits `subagents:completed`, this listener marks
 *      T1 completed and cascades: T2 (whose blockedBy is now satisfied)
 *      gets spawned by calling `options.decompose.task`. T2's spawn
 *      triggers another `decompose:spawn` → T2 enters the map.
 *   4. The chain proceeds serially until all tasks complete.
 */
export function registerDecomposeCascade(
  options: DecomposeCascadeOptions,
): () => void {
  const { events, store, spawn, onTaskChange } = options;
  const decomposeAgentMap = new Map<string, string>();

  // ── spawn cascade: walk pending decomposed tasks and spawn the runnable ones
  async function cascadeSpawn(): Promise<void> {
    const all = store.list();
    for (const t of all) {
      if (t.status !== "pending") continue;
      if (!isDecomposeTask(t)) continue;
      if (!blockersSatisfied(t, store)) continue;

      const agentId = await spawn(t);
      decomposeAgentMap.set(agentId, t.id);
      store.update(t.id, { status: "in_progress", owner: agentId });
    }
  }

  // ── decompose:spawn listener — register agentId -> taskId mapping
  const unsubSpawnRegister = events.on(
    DECOMPOSE_SPAWN_CHANNEL,
    (raw: unknown) => {
      const data = raw as { agentId?: unknown; taskId?: unknown };
      if (
        typeof data.agentId === "string" &&
        typeof data.taskId === "string"
      ) {
        decomposeAgentMap.set(data.agentId, data.taskId);
      }
    },
  );

  // ── subagents:completed listener — mark task done, cascade
  const unsubComplete = events.on(
    "subagents:completed",
    async (raw: unknown) => {
      const data = raw as { id?: string; result?: string };
      if (!data || typeof data.id !== "string") return;
      const taskId = decomposeAgentMap.get(data.id);
      if (!taskId) return;
      const task = store.get(taskId);
      if (!task) return;

      decomposeAgentMap.delete(data.id);
      store.update(taskId, {
        status: "completed",
        metadata: { ...task.metadata, result: data.result },
      });
      onTaskChange?.(taskId, "completed");
      await cascadeSpawn();
    },
  );

  // ── subagents:failed listener — revert to pending, no cascade
  const unsubFailed = events.on(
    "subagents:failed",
    async (raw: unknown) => {
      const data = raw as { id?: string; error?: string; status?: string };
      if (!data || typeof data.id !== "string") return;
      const taskId = decomposeAgentMap.get(data.id);
      if (!taskId) return;
      const task = store.get(taskId);
      if (!task) return;

      decomposeAgentMap.delete(data.id);
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
    },
  );

  return () => {
    unsubSpawnRegister();
    unsubComplete();
    unsubFailed();
  };
}