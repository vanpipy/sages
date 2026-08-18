/**
 * Sages event domain taxonomy (GC-2026-050).
 *
 * Sages emits three flavors of events during an orchestration run. Each
 * flavor has a different durability profile, a different consumer, and
 * a different storage path. Centralizing the taxonomy here keeps the
 * producer / consumer contract honest and lets tooling route events by
 * their domain prefix without parsing free-form strings.
 *
 * The three domains:
 *
 *   - run/*  — durable workflow milestones. Written to
 *     `.pi/orchestrator/audit-state-{dag_id}.yaml`. Survive process
 *     restarts. Consumers: orchestrator_audit, postmortem tooling, and
 *     integrate-time verification.
 *
 *   - step/* — live pipeline steps, in-memory + console only. Never
 *     persisted to disk. Consumers: the developer reading stdout /
 *     pino. Survives only as long as the process.
 *
 *   - seam/* — extension hook events. Fired at tool-fence boundaries
 *     (preflight, pre-merge, notify). Consumers: registered callbacks
 *     set via `onSeam()`. The dispatcher awaits all callbacks in
 *     registration order.
 *
 * Conventions:
 *   - Event names are lower-snake_case after the domain prefix.
 *   - The domain prefix (`run/` / `step/` / `seam/`) is part of the
 *     value, not a separate field. This makes events round-trippable
 *     through string-only channels (logs, JSON wire formats).
 *   - New event members MUST be appended; existing members MUST NOT
 *     be renamed without a deprecation cycle. See GC-2026-050.
 */

// ── run/* — durable workflow milestones ──────────────────────────────

/**
 * A run/* event names a durable workflow milestone. Producers are
 * goal_contract_create, dag_synthesize, task_dispatch, and
 * orchestrator_audit. Consumers are orchestrator_audit (verification
 * phase), postmortem tooling (analysis), and integrate-time hooks.
 *
 * Records are written to `.pi/orchestrator/audit-state-{dag_id}.yaml`
 * under the `events:` array. The file format is preserved by
 * extension; this enum adds new members but does not change the
 * shape of the storage record.
 */
export enum RunEvent {
  /** Fired after `goal_contract_create` writes the goal-*.yaml. */
  GoalCreated = "run/goal_created",

  /** Fired after `dag_synthesize` writes the dag-*.yaml. */
  DagSynthesized = "run/dag_synthesized",

  /** Fired after `task_dispatch` starts executing the dispatched tasks. */
  DispatchStarted = "run/dispatch_started",

  /** Fired after `orchestrator_audit` certifies PASS / surfaces blockers. */
  AuditCompleted = "run/audit_completed",

  /** Fired after the integration merge lands on the integration base. */
  Merged = "run/merged",
}

// ── step/* — live pipeline steps ─────────────────────────────────────

/**
 * A step/* event names an in-the-loop progress signal. Producers are
 * per-task handoff points: preflight, spawn, artifact receipt, merge
 * start / complete, retry, cancel. Consumers are dev-visible streams
 * (stdout / pino).
 *
 * step/* events are NEVER written to audit-state. They are ephemeral
 * by design — the audit trail captures the run/* milestones, not
 * every step. Recording every step would bloat the audit file and
 * double-write the same information that step-event consumers
 * already see live.
 */
export enum StepEvent {
  /** Fired before the first write-intent bash on a session. */
  Preflight = "step/preflight",

  /** Fired when a subagent slot is spawned. */
  Spawn = "step/spawn",

  /** Fired when the root session receives a worker typed artifact. */
  ArtifactReceived = "step/artifact_received",

  /** Fired when root begins merging a worker branch into the base. */
  MergeStart = "step/merge_start",

  /** Fired when root's merge step completes (success or failure). */
  MergeComplete = "step/merge_complete",

  /** Fired when a worker emits a retry-required artifact / `partial` rerun begins. */
  Retry = "step/retry",

  /** Fired when a worker or step is cancelled. */
  Cancel = "step/cancel",
}

// ── seam/* — extension hook events ───────────────────────────────────

/**
 * A seam/* event names an extension-hook boundary. Producers are the
 * 3 fence points called out in pi's extension API:
 *
 *   - preflight — runs before the orchestrator tools execute.
 *   - pre_merge — runs before root merges a worker branch.
 *   - notify    — runs after a worker completion artifact is received.
 *
 * Consumers register callbacks via `onSeam(event, callback)`. The
 * dispatcher awaits all callbacks in registration order; if any
 * throws, the seam is treated as failed.
 */
export enum SeamEvent {
  /** Before the orchestrator tool set is invoked (workspace preflight). */
  Preflight = "seam/preflight",

  /** Before root merges a worker branch into the integration base. */
  PreMerge = "seam/pre_merge",

  /** After a worker completion artifact arrives at root. */
  Notify = "seam/notify",
}

// ── Domain helpers ───────────────────────────────────────────────────

/** The literal union of valid domain prefixes. */
export type EventDomain = "run" | "step" | "seam";

/**
 * Map a fully-qualified event name back to its domain.
 *
 * Returns `null` for events whose prefix does not match any of the
 * three domains. Use this for routing decisions: `domainOf()` →
 * `emitRunEvent` / `emitStepEvent` / `emitSeamEvent` (each emitter
 * already asserts the domain internally; this helper exists for
 * upstream callers that want to route before dispatch).
 */
export function domainOf(event: string): EventDomain | null {
  if (event.startsWith("run/")) return "run";
  if (event.startsWith("step/")) return "step";
  if (event.startsWith("seam/")) return "seam";
  return null;
}
