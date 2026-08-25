/**
 * Sages event domain taxonomy (GC-2026-050).
 *
 * Sages emits one flavor of event during an orchestration run. Each
 * flavor has a different durability profile, a different consumer, and
 * a different storage path. Centralizing the taxonomy here keeps the
 * producer / consumer contract honest and lets tooling route events
 * by their domain prefix without parsing free-form strings.
 *
 * The domain:
 *
 *   - run/*  — durable workflow milestones. Written to
 *     `.pi/orchestrator/audit-state-{dag_id}.yaml`. Survive process
 *     restarts. Consumers: orchestrator_audit, postmortem tooling, and
 *     integrate-time verification.
 *
 * Conventions:
 *   - Event names are lower-snake_case after the domain prefix.
 *   - The domain prefix (`run/`) is part of the value, not a separate
 *     field. This makes events round-trippable through string-only
 *     channels (logs, JSON wire formats).
 *   - New event members MUST be appended; existing members MUST NOT
 *     be renamed without a deprecation cycle. See GC-2026-050.
 */

/**
 * A run/* event names a durable workflow milestone. Producers are
 * goal_contract_create, dag_synthesize, and task_dispatch. Consumers
 * are postmortem tooling (analysis) and integrate-time hooks.
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
}

/** The literal union of valid domain prefixes. */
export type EventDomain = "run";

/**
 * Map a fully-qualified event name back to its domain.
 *
 * Returns `null` for events whose prefix does not match the run
 * domain. Use this for routing decisions: `domainOf()` →
 * `emitRunEvent` (the emitter already asserts the domain internally;
 * this helper exists for upstream callers that want to route before
 * dispatch).
 */
export function domainOf(event: string): EventDomain | null {
	if (event.startsWith("run/")) return "run";
	return null;
}