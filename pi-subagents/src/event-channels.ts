/**
 * event-channels.ts — Canonical event channel constants owned by
 * `@sages/pi-subagents` (GC-2026-119 follow-up to GC-2026-118 F4).
 *
 * Pi-subagents owns every channel under the `subagents:*` namespace:
 * it both emits and (where applicable) listens on them. Other Sages
 * packages (`pi-tasks`, `pi-orchestrator`, `pi-evaluator`) consume
 * these events but do NOT depend on this module — the peer/event-bus
 * architecture keeps the package boundary clean. The constants below
 * are the source of truth for spelling; consumers must mirror the
 * strings verbatim (or, if the project later introduces a
 * cross-package dep, import from here).
 *
 * Convention: kebab-case `subagents:<verb>` for channel names;
 * SCREAMING_SNAKE_CASE for the constants.
 *
 * Out of scope:
 *   - `subagents:rpc:ping:reply:${requestId}` (and other `:reply:`
 *     RPC reply channels) — these are templated by request id and
 *     built at call site. The `rpcReply(...)` helper below composes
 *     them from a request channel + id.
 *   - `subagents:record` — this is a `pi.appendEntry` channel
 *     (host log), not an event channel. Not centralized here.
 *
 * Naming rationale:
 *   - `subagents:started` — emitted when an agent process begins
 *     (after spawn RPC resolves).
 *   - `subagents:completed` — emitted on successful terminal state.
 *     Consumers (e.g. task-feeder in pi-tasks) mark the task done.
 *   - `subagents:failed` — emitted on agent failure (error path).
 *   - `subagents:parent_aborted` — emitted when the orchestrator
 *     aborts the session; distinct from `failed` (intentional stop
 *     vs genuine error).
 *   - `subagents:compacted` — emitted after a context-compaction
 *     pass within the agent loop.
 *   - `subagents:created` — emitted when a subagent record is
 *     created (before spawn).
 *   - `subagents:steered` — emitted when a steer message is
 *     injected into a running agent.
 *   - `subagents:scheduled` — emitted when a subagent is scheduled
 *     for future execution.
 *   - `subagents:ready` — broadcast on session_start once the
 *     runtime is initialized; other packages use this to begin
 *     interacting (e.g. pi-tasks calls subagents:rpc:ping).
 *   - `subagents:scheduler_ready` — emitted when the scheduler
 *     sub-component is ready (subset of `subagents:ready`).
 *   - `subagents:settings_loaded` — emitted when persisted settings
 *     are loaded (e.g. default model overrides, network policy).
 *   - `subagents:settings_changed` — emitted when settings change
 *     mid-session.
 *
 * RPC channels (request/reply):
 *   - `subagents:rpc:ping` — version-protocol ping (sub-packages
 *     query pi-subagents's protocol version).
 *   - `subagents:rpc:spawn` — agent spawn RPC (returns agentId).
 *   - `subagents:rpc:stop` — agent stop RPC (returns success bool).
 *   - `subagents:rpc:consume` — internal — caller asks the runtime
 *     to consume + drop a subagent's result.
 */

// ── Lifecycle events ─────────────────────────────────────────────────────

/** Emitted when an agent process begins (after spawn RPC resolves). */
export const SUBAGENTS_STARTED = "subagents:started";

/** Emitted on successful agent terminal state. */
export const SUBAGENTS_COMPLETED = "subagents:completed";

/** Emitted on agent failure (genuine error path, distinct from `parent_aborted`). */
export const SUBAGENTS_FAILED = "subagents:failed";

/** Emitted when the orchestrator session aborts; intentional stop, not a failure. */
export const SUBAGENTS_PARENT_ABORTED = "subagents:parent_aborted";

/** Emitted after a context-compaction pass within the agent loop. */
export const SUBAGENTS_COMPACTED = "subagents:compacted";

/** Emitted when a subagent record is created (before spawn). */
export const SUBAGENTS_CREATED = "subagents:created";

/** Emitted when a steer message is injected into a running agent. */
export const SUBAGENTS_STEERED = "subagents:steered";

/** Emitted when a subagent is scheduled for future execution. */
export const SUBAGENTS_SCHEDULED = "subagents:scheduled";

/** Broadcast on session_start once the runtime is initialized. */
export const SUBAGENTS_READY = "subagents:ready";

/** Emitted when the scheduler sub-component is ready (subset of `subagents:ready`). */
export const SUBAGENTS_SCHEDULER_READY = "subagents:scheduler_ready";

/** Emitted when persisted settings are loaded. */
export const SUBAGENTS_SETTINGS_LOADED = "subagents:settings_loaded";

/** Emitted when settings change mid-session. */
export const SUBAGENTS_SETTINGS_CHANGED = "subagents:settings_changed";

// ── RPC channels ─────────────────────────────────────────────────────────

/** Version-protocol ping (sub-packages query pi-subagents's protocol version). */
export const SUBAGENTS_RPC_PING = "subagents:rpc:ping";

/** Agent spawn RPC (returns agentId). */
export const SUBAGENTS_RPC_SPAWN = "subagents:rpc:spawn";

/** Agent stop RPC (returns success bool). */
export const SUBAGENTS_RPC_STOP = "subagents:rpc:stop";

/** Internal — caller asks the runtime to consume + drop a subagent's result. */
export const SUBAGENTS_RPC_CONSUME = "subagents:rpc:consume";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Compose the reply-channel name for an RPC. Usage:
 *   `const reply = rpcReply(SUBAGENTS_RPC_PING, requestId);`
 *   `events.on(reply, handler);`
 */
export function rpcReply(channel: string, requestId: string): string {
  return `${channel}:reply:${requestId}`;
}