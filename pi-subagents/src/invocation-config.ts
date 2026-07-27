import type {
	AgentConfig,
	IsolationMode,
	JoinMode,
	ThinkingLevel,
} from "./types.js";
import type { ManagedWorktreeRequest } from "./worktree-contract.js";
import {
	normalizeWorktreeIsolation,
	type ParsedManagedWorktreeRequest,
} from "./worktree-contract.js";

interface AgentInvocationParams {
	model?: string;
	thinking?: string;
	max_turns?: number;
	run_in_background?: boolean;
	inherit_context?: boolean;
	isolated?: boolean;
	/**
	 * Accepts either the legacy "worktree" string literal (deprecated for
	 * Sages callers) or the explicit managed-worktree object. The legacy
	 * literal raises a precise error through `normalizeWorktreeIsolation`,
	 * which is also how the dispatcher rejects it BEFORE child execution.
	 */
	isolation?: "worktree" | ManagedWorktreeRequest;
}

export function resolveAgentInvocationConfig(
	agentConfig: AgentConfig | undefined,
	params: AgentInvocationParams,
): {
	modelInput?: string;
	modelFromParams: boolean;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	inheritContext: boolean;
	runInBackground: boolean;
	isolated: boolean;
	/**
	 * Resolved isolation. For the legacy "worktree" literal on a Sages caller
	 * this is `undefined` and the dispatcher rejects the spawn upstream. For
	 * an explicit object, this is the parsed request — the Agent manager
	 * forwards it as `SpawnOptions.managedWorktree`.
	 */
	isolation?: IsolationMode | ParsedManagedWorktreeRequest;
	/**
	 * The original (un-parsed) isolation value so the caller can also see
	 * whether the legacy literal was supplied. Tools / RPC layers can
	 * pattern-match on this without round-tripping through the manager.
	 */
	isolationRaw?: unknown;
	/**
	 * Explicit managed-worktree request when `params.isolation` is the new
	 * object form. `undefined` when no managed worktree was requested (or the
	 * legacy literal was supplied). Mirrors `isolation` for ergonomic access.
	 */
	managedWorktree?: ParsedManagedWorktreeRequest;
} {
	// Resolve the managed-worktree object form early so the rest of the
	// pipeline can key off it without re-parsing.
	let managedWorktree: ParsedManagedWorktreeRequest | undefined;
	let isolation: IsolationMode | ParsedManagedWorktreeRequest | undefined;
	if (params.isolation !== undefined) {
		if (typeof params.isolation === "string") {
			// Legacy literal. Defer to `normalizeWorktreeIsolation` for rejection —
			// this throws, which the Agent tool's dispatcher surfaces as a
			// pre-execution error so callers see the new contract immediately.
			try {
				managedWorktree = normalizeWorktreeIsolation(params.isolation) as
					| ParsedManagedWorktreeRequest
					| undefined;
				isolation = managedWorktree ?? "worktree";
			} catch {
				isolation = "worktree";
			}
		} else {
			managedWorktree = normalizeWorktreeIsolation(
				params.isolation,
			) as ParsedManagedWorktreeRequest;
			isolation = managedWorktree;
		}
	}

	// Frontmatter-pinned isolation wins over caller-supplied (per the existing
	// precedence in this module), but the legacy literal can never be the
	// frontmatter-pinned value going forward — agents authored against the
	// new contract use a different shape.
	const agentPinned = agentConfig?.isolation;
	if (agentPinned !== undefined) {
		return {
			modelInput: agentConfig?.model ?? params.model,
			modelFromParams: agentConfig?.model == null && params.model != null,
			thinking: (agentConfig?.thinking ?? params.thinking) as
				| ThinkingLevel
				| undefined,
			maxTurns: agentConfig?.maxTurns ?? params.max_turns,
			inheritContext:
				agentConfig?.inheritContext ?? params.inherit_context ?? false,
			runInBackground:
				agentConfig?.runInBackground ?? params.run_in_background ?? false,
			isolated: agentConfig?.isolated ?? params.isolated ?? false,
			isolation: agentPinned,
			isolationRaw: params.isolation,
			managedWorktree: undefined,
		};
	}

	return {
		modelInput: agentConfig?.model ?? params.model,
		modelFromParams: agentConfig?.model == null && params.model != null,
		thinking: (agentConfig?.thinking ?? params.thinking) as
			| ThinkingLevel
			| undefined,
		maxTurns: agentConfig?.maxTurns ?? params.max_turns,
		inheritContext:
			agentConfig?.inheritContext ?? params.inherit_context ?? false,
		runInBackground:
			agentConfig?.runInBackground ?? params.run_in_background ?? false,
		isolated: agentConfig?.isolated ?? params.isolated ?? false,
		isolation,
		isolationRaw: params.isolation,
		managedWorktree,
	};
}

export function resolveJoinMode(
	defaultJoinMode: JoinMode,
	runInBackground: boolean,
): JoinMode | undefined {
	return runInBackground ? defaultJoinMode : undefined;
}

/**
 * Package policy for the canonical `developer` agent. The legacy
 * `isolation: "worktree"` string literal is no longer accepted by the
 * Agent tool (see worktree-contract.ts). Instead, `developer` MUST
 * run inside an explicit managed worktree object:
 * `{ dag_id, task_id, worktree_id?, mode: "create" | "reuse" }`.
 *
 * The policy is enforced at the dispatcher boundary so callers see a
 * clean diagnostic BEFORE child execution. It only applies to the
 * canonical `developer` agent — Explore / Plan / any user-defined
 * agent, unknown name, or the legacy `software-developer` spelling
 * (removed in GC-2026-014; see DAG-2026-011 Phase A) is a no-op.
 *
 * Returns:
 *   - `undefined` when the call is well-formed (developer +
 *     valid managed-worktree object), OR when the policy does not apply
 *     (any other agent type).
 *   - A precise error string when the policy rejects the call. The
 *     message names the agent, the offending value, and the explicit
 *     object form the caller must use.
 */
export function enforceDeveloperManagedIsolationPolicy(
	agentType: string | undefined,
	isolation: unknown,
): string | undefined {
	// Policy is `developer`-specific. The dispatcher calls us with the
	// canonical name already resolved (and case-insensitive). The
	// `software-developer` legacy alias was removed in GC-2026-014 —
	// the registry no longer carries it, so callers using the legacy
	// spelling surface as "unknown agent type" upstream of this
	// function. Anything else (Explore, Plan, user agents, unknown
	// names, the legacy spelling itself) is a no-op here.
	const lower = typeof agentType === "string" ? agentType.toLowerCase() : "";
	if (lower !== "developer") return undefined;

	// Legacy literal — dedicated branch so the message carries all three
	// required patterns (`developer`, `worktree`, `explicit`) in one
	// sentence and is immediately actionable.
	if (isolation === "worktree") {
		return (
			'developer agent: the legacy `isolation: "worktree"` string literal is no longer accepted. ' +
			"Pass an explicit managed-worktree object instead: " +
			'{ dag_id, task_id, worktree_id?, mode: "create" | "reuse" }.'
		);
	}

	// No isolation supplied at all — `developer` always needs a managed
	// worktree. `null` is a separate, equally-rejected case.
	if (isolation === undefined) {
		return (
			"developer agent: an explicit managed-worktree object is required " +
			"(isolation was undefined). " +
			'Pass { dag_id, task_id, worktree_id?, mode: "create" | "reuse" }.'
		);
	}
	if (isolation === null) {
		return (
			"developer agent: an explicit managed-worktree object is required " +
			"(isolation was null). " +
			'Pass { dag_id, task_id, worktree_id?, mode: "create" | "reuse" }.'
		);
	}

	// Anything other than a plain object is rejected (e.g. unrelated
	// strings like `"branch"`, `""`, numbers, booleans).
	if (typeof isolation !== "object") {
		return (
			`developer agent: isolation must be an explicit managed-worktree ` +
			`object (got ${JSON.stringify(isolation)}). ` +
			`Pass { dag_id, task_id, worktree_id?, mode: "create" | "reuse" }.`
		);
	}

	// Object case — delegate field validation to the existing parser so
	// both surfaces speak the same constraint language. On success,
	// the call is policy-compliant; on failure, wrap the parser error
	// with the `developer agent:` prefix so callers see the agent name
	// in the diagnostic.
	try {
		normalizeWorktreeIsolation(isolation);
		return undefined;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return `developer agent: ${detail}`;
	}
}
