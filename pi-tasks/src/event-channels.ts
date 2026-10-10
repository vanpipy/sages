/**
 * event-channels.ts — Central event channel constants for the
 * pi-orchestrator ↔ pi-tasks boundary (GC-2026-118 F4 + GC-2026-119).
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
 * Out of scope (intentionally peer/event-bus architecture):
 *   - Pi-subagents-owned channels (`subagents:completed`,
 *     `subagents:failed`, `subagents:rpc:*`, …). The canonical
 *     constants live in `@sages/pi-subagents/src/event-channels.ts`
 *     (GC-2026-119). Pi-tasks is a peer of pi-subagents (both extend
 *     pi, communicate only via the event bus) and does NOT depend on
 *     it. The `subagents:*` strings below in `pi-tasks/src/*.ts`
 *     mirror those constants verbatim; if they ever drift, the
 *     pi-subagents test suite catches the source-of-truth change.
 *     Adding a cross-package dep just to share string literals would
 *     invert the boundary architecture (event-bus peers should not
 *     import each other).
 *   - Pi-tasks-internal channels (intra-extension only). Centralizing
 *     them is unnecessary; the producer and consumer are in the same
 *     file.
 */

/** Orchestrator-side decompose_task emits an RPC request; pi-tasks listens + replies on `${TASKS_RPC_DECOMPOSE_MATERIALIZE}:reply:${requestId}`. */
export const TASKS_RPC_DECOMPOSE_MATERIALIZE = "tasks:rpc:decompose-materialize";