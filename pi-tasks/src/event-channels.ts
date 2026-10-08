/**
 * event-channels.ts — Central event channel constants for the
 * pi-orchestrator ↔ pi-tasks boundary (GC-2026-118 F4).
 *
 * Why centralize (was: string literals duplicated across packages):
 *   - Type-safe channel names: misspellings are caught at the import
 *     site rather than silently misrouting events.
 *   - One place to update when renaming a channel.
 *   - Eliminates the "did I spell this right?" friction that has
 *     historically led to drift between producers and consumers
 *     (cf. `decompose:spawn` — emitted in one GC, never listened,
 *     removed in the next).
 *
 * Convention: kebab-case `namespace:action` for channel names;
 * SCREAMING_SNAKE_CASE for the constants.
 *
 * Out of scope:
 *   - Pi-subagents-owned channels (`subagents:completed`,
 *     `subagents:failed`, `subagents:rpc:*`). Those are emitted by the
 *     pi-subagents runtime; pi-tasks just listens. Centralizing them
 *     here would invert the ownership (pi-tasks would own channel
 *     names that pi-subagents emits). Defer.
 *   - Pi-tasks-internal channels (intra-extension only). Centralizing
 *     them is unnecessary; the producer and consumer are in the same
 *     file.
 */

/** Planning layer emits (workflow_run tool); pi-tasks's subscribeWorkflow listens. */
export const WORKFLOW_START = "workflow:start";

/** Pi-tasks's subscribeWorkflow emits on each phase; planning layer listens. */
export const WORKFLOW_PHASE_COMPLETE = "workflow:phase-complete";

/** Orchestrator-side decompose_task emits an RPC request; pi-tasks listens + replies on `${TASKS_RPC_DECOMPOSE_MATERIALIZE}:reply:${requestId}`. */
export const TASKS_RPC_DECOMPOSE_MATERIALIZE = "tasks:rpc:decompose-materialize";