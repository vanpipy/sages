/**
 * task-kind.ts — the intent/plan type system for tasks on the board.
 *
 * Two kinds of tasks live on the board:
 *
 *   - `intent` — raw material from `/tasks` (or any user-facing
 *     custom-task path). Never matched to a subagent; never dispatched;
 *     never consumed directly. The orchestrator reads the board, decides
 *     how to shape each intent, and converts it into a plan task via
 *     `board.convertIntent()`.
 *
 *   - `plan`   — created by the orchestrator (`board.create()`,
 *     `board.materializePlan()`, or `board.convertIntent()`). Has an
 *     `agentType`, is matched to a subagent, dispatched via
 *     `TaskExecute`, and consumed by the orchestrator after the
 *     executor reports back.
 *
 * Only `plan` tasks appear in the consumer loop. Intent tasks are
 * "raw material" the orchestrator decides what to do with.
 *
 * The kind lives in `metadata.kind`. Missing/undefined kind defaults
 * to `"plan"` for backward compatibility with tasks created directly
 * via `store.create()` before the kind distinction existed.
 */

import type { Task } from "./task-store.js";

/** The two task kinds. Use these constants, not string literals. */
export type TaskKind = "intent" | "plan";

export const TASK_KINDS: readonly TaskKind[] = ["intent", "plan"] as const;

/** The default kind when no kind is set on metadata. */
export const DEFAULT_TASK_KIND: TaskKind = "plan";

/**
 * Predicate for "is this a plan task?". Returns true for `kind === "plan"`
 * AND for missing/undefined kind (backward compat).
 */
export function isPlanKind(kind: unknown): boolean {
	return kind === undefined || kind === "plan";
}

/**
 * Predicate for "is this an intent task?". Requires explicit kind.
 */
export function isIntentKind(kind: unknown): boolean {
	return kind === "intent";
}

/**
 * Task-level predicate: is this task an intent?
 */
export function isIntentTask(task: Task): boolean {
	return isIntentKind(task.metadata?.kind);
}

/**
 * Task-level predicate: is this task a plan (or legacy default)?
 */
export function isPlanTask(task: Task): boolean {
	return isPlanKind(task.metadata?.kind);
}

/**
 * Read the kind from a task, defaulting to `"plan"` for legacy tasks
 * that have no kind set.
 */
export function taskKindOf(task: Task): TaskKind {
	const k = task.metadata?.kind;
	return k === "intent" ? "intent" : "plan";
}