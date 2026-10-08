/**
 * orchestrator-task.ts — Single policy entry point for orchestrator-created tasks.
 *
 * GC-2026-task-feeding-and-decomposition (D1, D3, R2): every task the orchestrator
 * creates goes through `createOrchestratorTaskWithReview`, which stamps
 * `metadata.created_by = "orchestrator"` and auto-attaches a Reviewer sibling
 * iff the new task is top-level (no orchestrator-created predecessors).
 *
 * The Reviewer attachment is universal: any orchestrator-created task whose
 * blockedBy contains no orchestrator-created predecessors gets one Reviewer
 * sibling. This unifies:
 *   - workflow-graph.ts static-graph Implement (top-level)
 *   - workflow-handler.ts Fix dispatch (not top-level: blocked by Review)
 *   - workflow-handler.ts Redesign dispatch (top-level: new Implement)
 *   - decompose_task.ts T1 (top-level: blockedBy contains only user_task or empty)
 *   - decompose_task.ts T_i (i>0, not top-level: blockedBy = [T_{i-1}])
 *
 * Merge is the single exception: it always goes through `createMergeTask`,
 * not this one. Merge is not top-level in any graph (it's downstream of every
 * Review in workflow mode).
 *
 * `traceUserTaskChain` walks the `user_task_ref` chain back to the originating
 * user task. Used by postmortem + audit.
 *
 * `spawnFirstTopLevelTask` is the RPC bridge for the first spawn after a
 * workflow:start event (workflow-handler) or after decompose_task materializes
 * its chain. Shared by both call sites so the spawn contract stays consistent.
 */

import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";
import {
  buildReviewerDescription,
  type ReviewerContext,
} from "./reviewer-prompt.js";

// ── Public types ─────────────────────────────────────────────────────────

export type CreatedBy = "orchestrator" | "user";

export interface OrchestratorTaskSpec {
  subject: string;
  description: string;
  activeForm?: string;
  /** Real task ids. Caller resolves placeholders before calling. */
  blockedBy?: string[];
  /** agentType for subagent dispatch. Required. */
  agentType: string;
  metadata?: Record<string, unknown>;
}

export interface CreateOrchestratorTaskResult {
  task: Task;
  /** Set iff the task was top-level. Reviewer auto-attached. */
  reviewer: Task | undefined;
}

export interface SpawnFirstTopLevelTaskContext {
  /** Worktree path. Optional. When absent, the spawn runs in cwd. */
  worktreePath?: string;
  /** Goal id (for Developer isolation worktree provisioning). */
  goalId?: string;
  /** Caller-supplied spawn RPC. workflow-handler passes pi-tasks's spawnSubagent;
   *  decompose-task may pass a simpler RPC. */
  spawn: (task: Task, opts: Record<string, unknown>) => Promise<string>;
  /** Caller-supplied side-effect hook (e.g. widget.setActiveTask). */
  onSpawned?: (task: Task, agentId: string) => void;
}

// ── Top-level detection ─────────────────────────────────────────────────

/**
 * A task is "top-level" iff it was created by the orchestrator and has no
 * orchestrator-created predecessors. R3 policy — only top-level orchestrator
 * tasks get a Reviewer sibling.
 *
 * `created_by === "orchestrator"` is the source provenance stamp.
 * `blockedBy.every(...)` walks the immediate predecessors and disqualifies
 * the task if at least one is itself orchestrator-created.
 */
export function isTopLevelOrchestratorTask(task: Task, store: TaskStore): boolean {
  if (task.metadata.created_by !== "orchestrator") return false;
  return task.blockedBy.every((id) => {
    const blocker = store.get(id);
    return !blocker || blocker.metadata.created_by !== "orchestrator";
  });
}

// ── Universal creator with Reviewer attachment ──────────────────────────

/**
 * Low-level orchestrator task creator. Stamps `created_by = "orchestrator"`,
 * wires `blockedBy` edges, and returns the new task. Does NOT auto-attach
 * a Reviewer sibling — callers that need a Reviewer pair should use
 * `createOrchestratorTaskWithReview` (below) instead.
 *
 * Used by the workflow static-graph builder, which plans its own Reviewer
 * tasks (one per Implement) and would conflict with auto-attachment.
 *
 * Caller MUST have already validated that the task should be orchestrator-
 * created. The function unconditionally stamps `created_by = "orchestrator"`.
 */
export function createOrchestratorTask(
  store: TaskStore,
  spec: OrchestratorTaskSpec,
): Task {
  const meta: Record<string, unknown> = {
    ...(spec.metadata ?? {}),
    created_by: "orchestrator" as const,
    kind: "step" as const,
    agentType: spec.agentType,
  };

  const task = store.create(spec.subject, spec.description, spec.activeForm, meta);

  // Wire blockedBy edges. Best-effort: dangling ids are tolerated (the caller
  // may have referenced a global task that hasn't been created yet — the edge
  // simply won't trigger cascade).
  for (const blockerId of spec.blockedBy ?? []) {
    if (!store.get(blockerId)) continue;
    store.update(task.id, { addBlockedBy: [blockerId] });
  }

  return task;
}

/**
 * High-level orchestrator task creator. Wraps `createOrchestratorTask`
 * and, iff the new task is top-level (no orchestrator-created predecessors),
 * auto-attaches a Reviewer sibling built from `reviewerContext`.
 *
 * Used by `decompose_task` for T1 (the chain head). Subsequent T_i use
 * `createOrchestratorTask` directly — they're not top-level because they're
 * blockedBy T1, so no Reviewer sibling is attached.
 *
 * Returns the new task + an optional reviewer (set iff top-level).
 */
export function createOrchestratorTaskWithReview(
  store: TaskStore,
  spec: OrchestratorTaskSpec,
  reviewerContext: ReviewerContext,
): CreateOrchestratorTaskResult {
  const task = createOrchestratorTask(store, spec);

  if (!isTopLevelOrchestratorTask(task, store)) {
    return { task, reviewer: undefined };
  }

  const reviewerDesc = buildReviewerDescription(reviewerContext);
  // R1 of a decompose chain shares `phase` with the chain so the
  // unified task-feeder's cascade picks it up. Otherwise R1 would sit
  // pending forever (no other listener would spawn it). For
  // workflow-context R1 callers, `phase` stays "review" so
  // workflow-handler and downstream consumers continue to treat it
  // as a workflow Reviewer.
  const reviewerPhase: "review" | "decomposition_chain" =
    reviewerContext.kind === "decompose" ? "decomposition_chain" : "review";
  const reviewer = store.create(
    `Review ${task.id} (${spec.subject})`,
    reviewerDesc,
    `Reviewing ${spec.subject}`,
    {
      created_by: "orchestrator" as const,
      agentType: "Reviewer",
      phase: reviewerPhase,
      iteration: Number(spec.metadata?.iteration ?? 1),
      ...(reviewerContext.kind === "decompose" && reviewerContext.userTaskRef
        ? { user_task_ref: reviewerContext.userTaskRef }
        : {}),
      ...(typeof spec.metadata?.workflow_run_goal_id === "string"
        ? { workflow_run_goal_id: spec.metadata.workflow_run_goal_id }
        : {}),
    },
  );
  store.update(reviewer.id, { addBlockedBy: [task.id] });

  return { task, reviewer };
}

// ── Merge exception ─────────────────────────────────────────────────────

/**
 * Merge task creator. Used by workflow-graph's static builder and by the
 * dispatch handlers that materialize Merge on a fresh branch. Merge is not
 * top-level (it sits downstream of every Review); it never gets a Reviewer
 * sibling.
 */
export function createMergeTask(
  store: TaskStore,
  spec: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  },
): Task {
  return store.create(spec.subject, spec.description, spec.activeForm, {
    ...(spec.metadata ?? {}),
    created_by: "orchestrator" as const,
    kind: "step" as const,
    agentType: "MergerAdvisor",
    phase: "merge" as const,
  });
}

// ── Chain trace (audit) ─────────────────────────────────────────────────

/**
 * Walk the chain backwards via `blockedBy[0]` (each chain task has exactly
 * one predecessor in the linear serial chain). Returns the chain in
 * source order `[user_task, T1, ..., TN]`.
 *
 * Used by postmortem + audit to reconstruct "which user input drove this
 * orchestrator chain". Stops at the user task (which has no blockedBy).
 */
export function traceUserTaskChain(store: TaskStore, taskId: string): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>();
  let cur: Task | undefined = store.get(taskId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    // Linear chain serial: each Ti has exactly one predecessor (T_{i-1}).
    // The walk follows blockedBy[0] back through the chain.
    const next = cur.blockedBy[0];
    if (typeof next !== "string" || !next) break;
    cur = store.get(next);
  }
  return out;
}

