/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

/**
 * The two task types on the board. Lives as a first-class `type` field on
 * Task, not under `metadata.kind`.
 *
 *   - `intent` — raw material from `/tasks` (or any user-facing custom-task
 *     path). Never matched to a subagent; never dispatched; never consumed
 *     directly. The orchestrator reads the board, decides how to shape each
 *     intent, and converts it into a plan task via its unique
 *     `task_convert_intent` operator.
 *
 *   - `plan`   — created by the orchestrator or via `task_convert_intent`.
 *     Has an `agentType`, is matched to a subagent, dispatched via
 *     `TaskExecute`, and consumed by the orchestrator after the executor
 *     reports back.
 */
export type TaskType = "intent" | "plan";

export interface Task {
  id: string;
  type: TaskType;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: Record<string, any>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  tasks: Task[];
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  output: string[];
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
