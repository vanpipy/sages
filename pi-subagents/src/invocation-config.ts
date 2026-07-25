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
